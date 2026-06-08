import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface ReleaseTargetRuntimeEvidenceCheckOptions {
  evidencePath: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours?: number;
  now?: () => Date;
}

export interface ReleaseTargetRuntimeEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface ReleaseTargetRuntimeEvidenceCheckResult {
  name: "siteflow-target-runtime-evidence-check";
  status: EvidenceStatus;
  checkedAt: string;
  evidencePath: string;
  thresholds: {
    maxAgeHours: number;
  };
  selectedEvidence: {
    targetEnvironment: string | null;
    publicBaseUrl: string | null;
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    composeConfig: RuntimeEvidenceSummary | null;
    startup: RuntimeEvidenceSummary | null;
    serviceHealth: RuntimeEvidenceSummary | null;
    readiness: RuntimeEvidenceSummary | null;
    imageBinding: RuntimeEvidenceSummary | null;
    restartSmoke: RuntimeEvidenceSummary | null;
    logSanity: RuntimeEvidenceSummary | null;
  };
  checks: ReleaseTargetRuntimeEvidenceCheck[];
  exitCode: number;
}

interface RuntimeEvidenceSummary {
  status?: string;
  timestamp?: string;
  expectedDigest?: string;
  apiImageDigest?: string;
  workerImageDigest?: string;
}

interface ParsedArgs {
  evidencePath?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours: number;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMaxAgeHours = 168;
const expectedSchemaVersion = "siteflow.targetRuntimeEvidence.v1";
const expectedName = "siteflow-target-runtime-evidence";
const passStatuses = new Set(["pass", "passed", "ok", "healthy", "running", "verified", "active", "enabled"]);
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;
const sha256HexPattern = /^[a-f0-9]{64}$/i;
const imageDigestPinPattern = /@sha256:[a-f0-9]{64}$/i;

export const requiredTargetRuntimeEvidenceCheckNames = [
  "schema_version",
  "evidence_name",
  "non_dry_run",
  "not_template",
  "evidence_status",
  "status_final",
  "release_identity",
  "environment",
  "public_base_url",
  "evidence_age",
  "compose_config_present",
  "compose_config_status",
  "compose_config_services",
  "compose_config_secrets",
  "compose_config_sanitized",
  "compose_config_images",
  "compose_config_no_build_fallback",
  "startup_present",
  "startup_status",
  "service_health_present",
  "service_health_status",
  "service_health_services",
  "readiness_present",
  "readiness_status",
  "readiness_loopback",
  "readiness_public",
  "image_binding_present",
  "image_binding_status",
  "image_binding_digests",
  "restart_smoke_present",
  "restart_smoke_status",
  "log_sanity_present",
  "log_sanity_status",
  "negative_evidence",
  "no_sensitive_evidence_values",
  "operator",
  "ticket"
];

function isEntrypoint() {
  const entryPath = process.argv[1];

  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function timestampValue(value: unknown) {
  const raw = stringValue(value);

  if (!raw || Number.isNaN(Date.parse(raw))) {
    return undefined;
  }

  return raw;
}

function nestedObject(candidate: Record<string, unknown> | undefined, key: string) {
  return candidate && isObject(candidate[key]) ? candidate[key] : undefined;
}

function nestedValue(candidate: Record<string, unknown> | undefined, path: string[]) {
  let current: unknown = candidate;

  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function positiveNumber(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

function ageHours(timestamp: string, now: Date) {
  return (now.getTime() - Date.parse(timestamp)) / (60 * 60 * 1000);
}

function freshTimestamp(timestamp: string | undefined, now: Date, maxAgeHours: number) {
  return Boolean(timestamp && ageHours(timestamp, now) >= 0 && ageHours(timestamp, now) <= maxAgeHours);
}

function isPassingStatus(value: unknown) {
  const normalized = statusValue(value);

  return Boolean(normalized && passStatuses.has(normalized));
}

function addCheck(checks: ReleaseTargetRuntimeEvidenceCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function releaseObject(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "release") ?? root;
}

function releaseCommit(root: Record<string, unknown> | undefined) {
  const release = releaseObject(root);

  return stringValue(release?.commitRef) ?? stringValue(release?.commitSha);
}

function releaseRepository(root: Record<string, unknown> | undefined) {
  return stringValue(releaseObject(root)?.repository);
}

function releaseBranch(root: Record<string, unknown> | undefined) {
  return stringValue(releaseObject(root)?.branch);
}

function targetEnvironment(root: Record<string, unknown> | undefined) {
  return stringValue(root?.targetEnvironment) ??
    stringValue(root?.environment) ??
    stringValue(nestedValue(root, ["target", "environment"]));
}

function publicBaseUrl(root: Record<string, unknown> | undefined) {
  return stringValue(root?.publicBaseUrl) ?? stringValue(nestedValue(root, ["target", "publicBaseUrl"]));
}

function operatorName(root: Record<string, unknown> | undefined) {
  return stringValue(root?.operatorName) ?? stringValue(root?.operator) ?? stringValue(nestedValue(root, ["operator", "name"]));
}

function ticketId(root: Record<string, unknown> | undefined) {
  return stringValue(root?.ticketId) ?? stringValue(root?.ticket) ?? stringValue(root?.releaseTicket) ?? stringValue(nestedValue(root, ["ticket", "id"]));
}

function evidenceTimestamp(root: Record<string, unknown> | undefined) {
  return timestampValue(root?.checkedAt) ?? timestampValue(root?.completedAt) ?? timestampValue(root?.timestamp);
}

function sectionTimestamp(candidate: Record<string, unknown> | undefined) {
  return timestampValue(candidate?.checkedAt) ??
    timestampValue(candidate?.completedAt) ??
    timestampValue(candidate?.timestamp) ??
    timestampValue(candidate?.verifiedAt);
}

function summarize(candidate: Record<string, unknown> | undefined): RuntimeEvidenceSummary | null {
  if (!candidate) {
    return null;
  }

  return {
    status: stringValue(candidate.status),
    timestamp: sectionTimestamp(candidate)
  };
}

function summarizeImageBinding(candidate: Record<string, unknown> | undefined): RuntimeEvidenceSummary | null {
  const summary = summarize(candidate);

  if (!summary) {
    return null;
  }

  return {
    ...summary,
    ...(stringValue(candidate?.expectedDigest) ? { expectedDigest: stringValue(candidate?.expectedDigest) } : {}),
    ...(stringValue(candidate?.apiImageDigest) ? { apiImageDigest: stringValue(candidate?.apiImageDigest) } : {}),
    ...(stringValue(candidate?.workerImageDigest) ? { workerImageDigest: stringValue(candidate?.workerImageDigest) } : {})
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function arrayIncludesAllStrings(value: unknown, expected: string[]) {
  const values = stringArray(value);

  return expected.every((entry) => values.includes(entry));
}

function serviceImageFromComposeConfig(composeConfig: Record<string, unknown> | undefined, serviceName: string) {
  const images = composeConfig?.images;

  if (isObject(images)) {
    return stringValue(images[serviceName]);
  }

  if (Array.isArray(images)) {
    for (const entry of images) {
      if (!isObject(entry)) {
        continue;
      }

      const service = stringValue(entry.service) ?? stringValue(entry.name);

      if (service === serviceName) {
        return stringValue(entry.image);
      }
    }
  }

  return undefined;
}

function digestPinnedImage(value: unknown) {
  const raw = stringValue(value);

  return Boolean(raw && imageDigestPinPattern.test(raw));
}

function composeImagesDigestPinned(composeConfig: Record<string, unknown> | undefined) {
  return ["postgres", "api", "worker"].every((service) =>
    digestPinnedImage(serviceImageFromComposeConfig(composeConfig, service))
  );
}

function emptyArrayField(value: unknown) {
  return Array.isArray(value) && value.length === 0;
}

function composeNoBuildFallback(composeConfig: Record<string, unknown> | undefined) {
  const imagePolicy = nestedObject(composeConfig, "imagePolicy");

  return composeConfig?.noBuildFallback === true &&
    imagePolicy?.noBuildFallback === true &&
    emptyArrayField(composeConfig?.buildServices) &&
    emptyArrayField(composeConfig?.buildFallbacks);
}

function statusCodeOk(value: unknown) {
  return typeof value === "number" && value >= 200 && value < 300;
}

function publicBaseUrlPassed(value: unknown) {
  const raw = stringValue(value);
  let parsed: URL;

  if (!raw) {
    return false;
  }

  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  return parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash;
}

function sectionFresh(candidate: Record<string, unknown> | undefined, now: Date, maxAgeHours: number) {
  return freshTimestamp(sectionTimestamp(candidate), now, maxAgeHours);
}

function sectionPassed(candidate: Record<string, unknown> | undefined, now: Date, maxAgeHours: number) {
  return Boolean(candidate && isPassingStatus(candidate.status) && sectionFresh(candidate, now, maxAgeHours));
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

async function readEvidenceJson(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

export function evaluateReleaseTargetRuntimeEvidence(
  rawEvidence: unknown,
  options: ReleaseTargetRuntimeEvidenceCheckOptions
): ReleaseTargetRuntimeEvidenceCheckResult {
  const now = options.now?.() ?? new Date();
  const maxAgeHours = positiveNumber(options.maxAgeHours, defaultMaxAgeHours, "maxAgeHours");
  const evidence = isObject(rawEvidence) ? rawEvidence : undefined;
  const composeConfig = nestedObject(evidence, "composeConfig");
  const startup = nestedObject(evidence, "startup");
  const serviceHealth = nestedObject(evidence, "serviceHealth");
  const readiness = nestedObject(evidence, "readiness");
  const imageBinding = nestedObject(evidence, "imageBinding");
  const restartSmoke = nestedObject(evidence, "restartSmoke");
  const logSanity = nestedObject(evidence, "logSanity");
  const negativeEvidence = nestedObject(evidence, "negativeEvidence");
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const checks: ReleaseTargetRuntimeEvidenceCheck[] = [];
  const expectedEnvironment = stringValue(options.targetEnvironment);
  const expectedCommitRef = stringValue(options.commitRef);
  const expectedRepository = stringValue(options.repo);
  const expectedBranch = stringValue(options.branch);
  const actualCommitRef = releaseCommit(evidence);
  const actualRepository = releaseRepository(evidence);
  const actualBranch = releaseBranch(evidence);
  const actualEnvironment = targetEnvironment(evidence);

  addCheck(checks, "schema_version", evidence?.schemaVersion === expectedSchemaVersion, `Target runtime evidence schemaVersion must be ${expectedSchemaVersion}.`);
  addCheck(checks, "evidence_name", evidence?.name === expectedName, `Target runtime evidence name must be ${expectedName}.`);
  addCheck(checks, "non_dry_run", evidence?.dryRun === false, "Target runtime evidence must come from a non-dry-run target host observation.");
  addCheck(checks, "not_template", evidence?.template !== true, "Target runtime evidence template output must be replaced with real observations.");
  addCheck(checks, "evidence_status", statusValue(evidence?.status) === "passed", "Target runtime evidence status must be passed.");
  addCheck(checks, "status_final", statusValue(evidence?.status) !== "todo" && statusValue(evidence?.status) !== "blocked", "Target runtime evidence status must be final.");
  addCheck(
    checks,
    "release_identity",
    Boolean(
      actualCommitRef &&
        actualRepository &&
        actualBranch &&
        (!expectedCommitRef || actualCommitRef === expectedCommitRef) &&
        (!expectedRepository || actualRepository === expectedRepository) &&
        (!expectedBranch || actualBranch === expectedBranch)
    ),
    "Target runtime evidence must be bound to the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "environment",
    Boolean(actualEnvironment && (!expectedEnvironment || actualEnvironment === expectedEnvironment)),
    "Target runtime evidence targetEnvironment must match the release target environment."
  );
  addCheck(checks, "public_base_url", publicBaseUrlPassed(publicBaseUrl(evidence)), "Target runtime evidence publicBaseUrl must be an HTTPS URL without credentials, query strings, or fragments.");
  addCheck(checks, "evidence_age", freshTimestamp(evidenceTimestamp(evidence), now, maxAgeHours), `Target runtime evidence checkedAt must be no older than ${maxAgeHours} hours.`);

  addCheck(checks, "compose_config_present", Boolean(composeConfig), "Target runtime evidence must include docker compose config evidence.");
  addCheck(checks, "compose_config_status", sectionPassed(composeConfig, now, maxAgeHours), "Compose config evidence must have passing status and fresh timestamp.");
  addCheck(checks, "compose_config_services", arrayIncludesAllStrings(composeConfig?.services, ["postgres", "api", "worker"]), "Compose config evidence must summarize postgres, api, and worker services.");
  addCheck(checks, "compose_config_secrets", arrayIncludesAllStrings(composeConfig?.secrets, ["siteflow_app_secret", "siteflow_api_token", "siteflow_metrics_token", "siteflow_postgres_password"]), "Compose config evidence must summarize required Docker secrets.");
  addCheck(checks, "compose_config_sanitized", composeConfig?.sanitized === true && composeConfig?.rawConfigArchived === false && sha256HexPattern.test(stringValue(composeConfig?.configSha256) ?? ""), "Compose config evidence must be sanitized and include only a SHA-256 config hash, not raw config.");
  addCheck(checks, "compose_config_images", composeImagesDigestPinned(composeConfig), "Compose config evidence must prove postgres, API, and worker services use digest-pinned images.");
  addCheck(checks, "compose_config_no_build_fallback", composeNoBuildFallback(composeConfig), "Compose config evidence must prove the target Compose config has no build services or build fallback.");

  addCheck(checks, "startup_present", Boolean(startup), "Target runtime evidence must include startup evidence.");
  addCheck(checks, "startup_status", sectionPassed(startup, now, maxAgeHours) && (startup?.systemdActive === true || startup?.composeUpExitCode === 0), "Startup evidence must show systemd active or docker compose up succeeded.");

  addCheck(checks, "service_health_present", Boolean(serviceHealth), "Target runtime evidence must include service health evidence.");
  addCheck(checks, "service_health_status", sectionPassed(serviceHealth, now, maxAgeHours) && serviceHealth?.restartLoopDetected === false, "Service health evidence must pass without restart loop detection.");
  addCheck(checks, "service_health_services", serviceHealth?.postgresHealthy === true && serviceHealth?.apiHealthy === true && serviceHealth?.workerRunning === true, "Service health evidence must show Postgres healthy, API healthy, and worker running.");

  addCheck(checks, "readiness_present", Boolean(readiness), "Target runtime evidence must include readiness evidence.");
  addCheck(checks, "readiness_status", sectionPassed(readiness, now, maxAgeHours), "Readiness evidence must have passing status and fresh timestamp.");
  addCheck(checks, "readiness_loopback", statusCodeOk(readiness?.loopbackStatusCode) && statusValue(readiness?.loopbackBodyStatus) === "ok", "Loopback /readyz evidence must return a 2xx status and ok body.");
  addCheck(checks, "readiness_public", statusCodeOk(readiness?.publicStatusCode) && statusValue(readiness?.publicBodyStatus) === "ok", "Public /readyz evidence must return a 2xx status and ok body.");

  addCheck(checks, "image_binding_present", Boolean(imageBinding), "Target runtime evidence must include running image binding evidence.");
  addCheck(checks, "image_binding_status", sectionPassed(imageBinding, now, maxAgeHours) && imageBinding?.apiMatchesReleaseImage === true && imageBinding?.workerMatchesReleaseImage === true, "Image binding evidence must show API and worker run the release image digest.");
  addCheck(checks, "image_binding_digests", sha256DigestPattern.test(stringValue(imageBinding?.expectedDigest) ?? "") && imageBinding?.apiImageDigest === imageBinding?.expectedDigest && imageBinding?.workerImageDigest === imageBinding?.expectedDigest, "Image binding evidence must include matching sha256 digests for expected, API, and worker images.");

  addCheck(checks, "restart_smoke_present", Boolean(restartSmoke), "Target runtime evidence must include restart smoke evidence.");
  addCheck(checks, "restart_smoke_status", sectionPassed(restartSmoke, now, maxAgeHours) && restartSmoke?.restarted === true && restartSmoke?.serviceHealthAfterRestart === true && restartSmoke?.readinessAfterRestart === true, "Restart smoke evidence must pass service health and readiness after restart.");

  addCheck(checks, "log_sanity_present", Boolean(logSanity), "Target runtime evidence must include startup log sanity evidence.");
  addCheck(checks, "log_sanity_status", sectionPassed(logSanity, now, maxAgeHours) && logSanity?.fatalErrors === 0 && logSanity?.workerPreflightFailures === 0 && logSanity?.secretLeakFindings === 0 && logSanity?.rawLogsArchived === false, "Log sanity evidence must show no fatal startup errors, worker preflight failures, secret leaks, or raw log archival.");
  addCheck(checks, "negative_evidence", negativeEvidence?.noRawComposeConfigArchived === true && negativeEvidence?.noRawEnvArchived === true && negativeEvidence?.noRawSecretsArchived === true && negativeEvidence?.noUnredactedLogsArchived === true, "Target runtime evidence must explicitly reject raw config, env, secret, and unredacted log archival.");
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Target runtime evidence must not include raw secret-like values."
      : `Target runtime evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );
  addCheck(checks, "operator", Boolean(operatorName(evidence)), "Target runtime evidence must include the operator name.");
  addCheck(checks, "ticket", Boolean(ticketId(evidence)), "Target runtime evidence must include a release or incident ticket id.");

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-target-runtime-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxAgeHours
    },
    selectedEvidence: {
      targetEnvironment: actualEnvironment ?? null,
      publicBaseUrl: publicBaseUrl(evidence) ?? null,
      commitRef: actualCommitRef ?? null,
      repository: actualRepository ?? null,
      branch: actualBranch ?? null,
      composeConfig: summarize(composeConfig),
      startup: summarize(startup),
      serviceHealth: summarize(serviceHealth),
      readiness: summarize(readiness),
      imageBinding: summarizeImageBinding(imageBinding),
      restartSmoke: summarize(restartSmoke),
      logSanity: summarize(logSanity)
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function checkReleaseTargetRuntimeEvidence(
  options: ReleaseTargetRuntimeEvidenceCheckOptions
): Promise<ReleaseTargetRuntimeEvidenceCheckResult> {
  return evaluateReleaseTargetRuntimeEvidence(await readEvidenceJson(options.evidencePath), options);
}

export function parseReleaseTargetRuntimeEvidenceCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    maxAgeHours: defaultMaxAgeHours,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--evidence") {
      parsed.evidencePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--commit-ref") {
      parsed.commitRef = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.evidencePath) {
    throw new Error("--evidence is required.");
  }

  positiveNumber(parsed.maxAgeHours, defaultMaxAgeHours, "--max-age-hours");

  return parsed;
}

export function releaseTargetRuntimeEvidenceCheckUsage() {
  return [
    "Usage: npm run --silent release:target-runtime:evidence -- --evidence <target-runtime-evidence.json> [--commit-ref <sha>] [--repo <owner/name>] [--branch <branch>] [--target-environment <env>] [--json]",
    "",
    "Validates target-host Compose config, startup, service health, readiness, release image binding, restart smoke, and log sanity evidence."
  ].join("\n");
}

function writeHumanResult(result: ReleaseTargetRuntimeEvidenceCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow target runtime evidence: ${result.status}\n`);
  output.write(`Evidence: ${result.evidencePath}\n`);

  for (const check of result.checks.filter((entry) => entry.status !== "pass")) {
    output.write(`- ${check.name}: ${check.message}\n`);
  }
}

export async function runReleaseTargetRuntimeEvidenceCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseTargetRuntimeEvidenceCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseTargetRuntimeEvidenceCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${releaseTargetRuntimeEvidenceCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseTargetRuntimeEvidenceCheckUsage()}\n`);
    return 0;
  }

  try {
    const result = await checkReleaseTargetRuntimeEvidence({
      ...baseOptions,
      evidencePath: parsed.evidencePath!,
      commitRef: parsed.commitRef,
      repo: parsed.repo,
      branch: parsed.branch,
      targetEnvironment: parsed.targetEnvironment,
      maxAgeHours: parsed.maxAgeHours
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runReleaseTargetRuntimeEvidenceCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
