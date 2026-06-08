import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface SourceProviderEvidenceCheckOptions {
  evidencePath: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours?: number;
  now?: () => Date;
}

export interface SourceProviderEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface SourceProviderEvidenceCheckResult {
  name: "siteflow-source-provider-evidence-check";
  status: EvidenceStatus;
  checkedAt: string;
  evidencePath: string;
  thresholds: {
    maxAgeHours: number;
  };
  selectedEvidence: {
    environment: string | null;
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    provider: string | null;
    webhookDeliveryId: string | null;
    deployKeyMode: string | null;
  };
  checks: SourceProviderEvidenceCheck[];
  exitCode: number;
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
const expectedSchemaVersion = "siteflow.sourceProviderEvidence.v1";
const expectedName = "siteflow-source-provider-evidence";
const supportedProviders = new Set(["github", "gitlab", "gitea", "generic"]);
const passStatuses = new Set(["pass", "passed", "ok", "verified"]);

export const requiredSourceProviderEvidenceCheckNames = [
  "schema_version",
  "evidence_name",
  "non_dry_run",
  "not_template",
  "evidence_status",
  "status_final",
  "release_identity",
  "environment",
  "evidence_age",
  "provider_supported",
  "repository_binding",
  "exact_commit_checkout",
  "remote_url_hygiene",
  "signed_webhook_present",
  "signed_webhook_verified",
  "webhook_secret_hygiene",
  "deploy_key_policy",
  "host_key_policy",
  "release_provenance_recorded",
  "no_raw_credentials_archived",
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

function addCheck(checks: SourceProviderEvidenceCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function isPassingStatus(value: unknown) {
  const normalized = statusValue(value);
  return Boolean(normalized && passStatuses.has(normalized));
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

function environmentName(root: Record<string, unknown> | undefined) {
  return stringValue(root?.environment) ??
    stringValue(root?.targetEnvironment) ??
    stringValue(nestedValue(root, ["target", "environment"]));
}

function operatorName(root: Record<string, unknown> | undefined) {
  return stringValue(root?.operatorName) ??
    stringValue(root?.operator) ??
    stringValue(nestedValue(root, ["operator", "name"]));
}

function rootTicket(root: Record<string, unknown> | undefined) {
  return stringValue(root?.ticketId) ??
    stringValue(root?.ticket) ??
    stringValue(root?.releaseTicket) ??
    stringValue(nestedValue(root, ["operator", "ticket"]));
}

function evidenceTimestamp(root: Record<string, unknown> | undefined) {
  return timestampValue(root?.checkedAt) ?? timestampValue(root?.completedAt) ?? timestampValue(root?.timestamp);
}

function providerName(root: Record<string, unknown> | undefined) {
  return statusValue(root?.provider) ??
    statusValue(nestedValue(root, ["repository", "provider"])) ??
    statusValue(nestedValue(root, ["sourceProvider", "provider"]));
}

function repositoryName(root: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(root, ["repository", "fullName"])) ??
    stringValue(nestedValue(root, ["repository", "name"])) ??
    releaseRepository(root);
}

function remoteUrl(root: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(root, ["repository", "remoteUrl"])) ??
    stringValue(nestedValue(root, ["repository", "url"])) ??
    stringValue(nestedValue(root, ["checkout", "remoteUrl"]));
}

function remoteUrlSafe(value: string | undefined) {
  if (!value) {
    return false;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch {
      return false;
    }
  }

  return /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^:]+$/.test(value);
}

function isSshRemote(value: string | undefined) {
  return Boolean(value && (/^ssh:\/\//i.test(value) || /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^:]+$/.test(value)));
}

function webhookEvidence(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "webhook") ?? nestedObject(root, "signedWebhook");
}

function deployKeyEvidence(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "deployKey") ?? nestedObject(root, "credential");
}

function hostKeyEvidence(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "hostKey") ?? nestedObject(root, "knownHosts");
}

function releaseProvenanceEvidence(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "releaseProvenance") ?? nestedObject(root, "provenance");
}

function noRawCredentialArchive(root: Record<string, unknown> | undefined) {
  const webhook = webhookEvidence(root);
  const deployKey = deployKeyEvidence(root);
  const hostKey = hostKeyEvidence(root);

  return root?.rawCredentialArchived !== true &&
    root?.rawSecretArchived !== true &&
    root?.authorizationHeaderArchived !== true &&
    webhook?.rawSecretArchived !== true &&
    webhook?.signatureHeaderArchived !== true &&
    deployKey?.privateKeyArchived !== true &&
    deployKey?.rawCredentialArchived !== true &&
    hostKey?.rawSecretArchived !== true;
}

function deployKeyPolicyPassed(root: Record<string, unknown> | undefined) {
  const deployKey = deployKeyEvidence(root);
  const repository = nestedObject(root, "repository");
  const privateRepo = repository?.private === true || repository?.visibility === "private" || deployKey?.required === true;

  if (!privateRepo && deployKey?.required !== true) {
    return true;
  }

  return Boolean(
    deployKey &&
      isPassingStatus(deployKey.status) &&
      (deployKey.mounted === true || deployKey.available === true) &&
      stringValue(deployKey.path) &&
      deployKey.privateKeyArchived !== true &&
      deployKey.rawCredentialArchived !== true
  );
}

function hostKeyPolicyPassed(root: Record<string, unknown> | undefined) {
  const remote = remoteUrl(root);
  const hostKey = hostKeyEvidence(root);

  if (!isSshRemote(remote)) {
    return true;
  }

  return Boolean(
    hostKey &&
      isPassingStatus(hostKey.status) &&
      (hostKey.pinned === true || hostKey.knownHostsConfigured === true) &&
      hostKey.acceptedBlindly !== true
  );
}

export function evaluateSourceProviderEvidence(
  rawEvidence: unknown,
  options: SourceProviderEvidenceCheckOptions
): SourceProviderEvidenceCheckResult {
  const root = isObject(rawEvidence) ? rawEvidence : undefined;
  const now = options.now?.() ?? new Date();
  const maxAgeHours = positiveNumber(options.maxAgeHours, defaultMaxAgeHours, "maxAgeHours");
  const commitRef = releaseCommit(root);
  const repository = releaseRepository(root);
  const branch = releaseBranch(root);
  const provider = providerName(root);
  const environment = environmentName(root);
  const checkedAt = evidenceTimestamp(root);
  const webhook = webhookEvidence(root);
  const checkout = nestedObject(root, "checkout");
  const provenance = releaseProvenanceEvidence(root);
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const checks: SourceProviderEvidenceCheck[] = [];

  addCheck(checks, "evidence_shape", Boolean(root), "Source provider evidence must be a JSON object.");
  addCheck(checks, "schema_version", root?.schemaVersion === expectedSchemaVersion, `Source provider evidence schemaVersion must be ${expectedSchemaVersion}.`);
  addCheck(checks, "evidence_name", root?.name === expectedName, `Source provider evidence name must be ${expectedName}.`);
  addCheck(checks, "non_dry_run", root?.dryRun === false, "Source provider evidence must come from a non-dry-run target or target-equivalent check.");
  addCheck(checks, "not_template", root?.template !== true, "Source provider evidence must be final target evidence, not a template skeleton.");
  addCheck(checks, "evidence_status", isPassingStatus(root?.status), "Source provider evidence status must be passing.");
  addCheck(checks, "status_final", statusValue(root?.status) === "passed", "Source provider evidence status must be exactly passed for final production evidence.");
  addCheck(
    checks,
    "release_identity",
    Boolean(
      commitRef &&
        repository &&
        branch &&
        (!options.commitRef || commitRef === options.commitRef) &&
        (!options.repo || repository === options.repo) &&
        (!options.branch || branch === options.branch)
    ),
    "Source provider evidence must match the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "environment",
    Boolean(environment && (!options.targetEnvironment || environment === options.targetEnvironment)),
    options.targetEnvironment
      ? `Source provider evidence target environment must be ${options.targetEnvironment}.`
      : "Source provider evidence must include a target environment."
  );
  addCheck(checks, "evidence_age", freshTimestamp(checkedAt, now, maxAgeHours), `Source provider evidence must be no older than ${maxAgeHours} hours.`);
  addCheck(checks, "provider_supported", Boolean(provider && supportedProviders.has(provider)), "Source provider evidence must name a supported provider.");
  addCheck(
    checks,
    "repository_binding",
    Boolean(repositoryName(root) && repositoryName(root) === repository && remoteUrl(root)),
    "Source provider evidence must bind the provider repository and clone remote to the release repository."
  );
  addCheck(
    checks,
    "exact_commit_checkout",
    Boolean(
      checkout &&
        isPassingStatus(checkout.status) &&
        (checkout.exactCommitVerified === true || checkout.headMatchesCommit === true) &&
        (stringValue(checkout.commitRef) === commitRef || stringValue(checkout.headSha) === commitRef)
    ),
    "Checkout evidence must prove the exact release commit was fetched and verified."
  );
  addCheck(checks, "remote_url_hygiene", remoteUrlSafe(remoteUrl(root)) && nestedValue(root, ["repository", "urlEmbeddedCredentials"]) !== true, "Repository remote URL must be present and must not embed credentials.");
  addCheck(checks, "signed_webhook_present", Boolean(webhook), "Signed webhook evidence must be present for the enabled provider.");
  addCheck(
    checks,
    "signed_webhook_verified",
    Boolean(
      webhook &&
        isPassingStatus(webhook.status) &&
        webhook.signatureVerified === true &&
        stringValue(webhook.deliveryId) &&
        stringValue(webhook.event)
    ),
    "Signed webhook evidence must prove signature verification for a real delivery."
  );
  addCheck(
    checks,
    "webhook_secret_hygiene",
    Boolean(webhook && webhook.secretConfigured === true && webhook.rawSecretArchived !== true && webhook.signatureHeaderArchived !== true),
    "Webhook evidence must prove a configured signing secret without archiving raw secret or signature headers."
  );
  addCheck(checks, "deploy_key_policy", deployKeyPolicyPassed(root), "Private repository access must use a mounted deploy key or be explicitly public.");
  addCheck(checks, "host_key_policy", hostKeyPolicyPassed(root), "SSH checkout evidence must prove pinned known-hosts policy when SSH remotes are used.");
  addCheck(
    checks,
    "release_provenance_recorded",
    Boolean(
      provenance &&
        isPassingStatus(provenance.status) &&
        stringValue(provenance.commitRef) === commitRef &&
        stringValue(provenance.repository) === repository &&
        stringValue(provenance.branch) === branch
    ),
    "Release provenance evidence must record the release repository, branch, and commit."
  );
  addCheck(checks, "no_raw_credentials_archived", noRawCredentialArchive(root), "Source provider evidence must not archive raw credentials, signatures, authorization headers, or private keys.");
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Source provider evidence must not include raw secret-like values."
      : `Source provider evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );
  addCheck(checks, "operator", Boolean(operatorName(root)), "Source provider evidence must include the operator.");
  addCheck(checks, "ticket", Boolean(rootTicket(root)), "Source provider evidence must include a release/change/incident ticket.");

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-source-provider-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxAgeHours
    },
    selectedEvidence: {
      environment: environment ?? null,
      commitRef: commitRef ?? null,
      repository: repository ?? null,
      branch: branch ?? null,
      provider: provider ?? null,
      webhookDeliveryId: stringValue(webhook?.deliveryId) ?? null,
      deployKeyMode: stringValue(deployKeyEvidence(root)?.mode) ?? (deployKeyEvidence(root)?.required === true ? "required" : "not_required")
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runSourceProviderEvidenceCheck(options: SourceProviderEvidenceCheckOptions) {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateSourceProviderEvidence(raw, options);
}

function requiredArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!stringValue(value) || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseSourceProviderEvidenceArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    maxAgeHours: defaultMaxAgeHours,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--evidence") {
      parsed.evidencePath = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--commit-ref") {
      parsed.commitRef = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(requiredArgValue(args, index, arg));
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

export function sourceProviderEvidenceUsage() {
  return [
    "Usage: npm run --silent source-provider:evidence -- --evidence <source-provider-evidence.json> [options]",
    "",
    "Options:",
    "  --commit-ref <sha>             Expected release commit SHA.",
    "  --repo <owner/repo>            Expected release repository.",
    "  --branch <branch>              Expected release branch.",
    "  --target-environment <name>    Expected target environment.",
    "  --max-age-hours <hours>        Maximum evidence age. Default: 168.",
    "  --json                         Print JSON output.",
    "  --help                         Show this help."
  ].join("\n");
}

function writeHumanResult(result: SourceProviderEvidenceCheckResult, io: CliIo) {
  io.stdout.write(`SiteFlow source provider evidence status: ${result.status}\n`);
  io.stdout.write(`Checks: ${result.checks.filter((check) => check.status === "pass").length}/${result.checks.length} passed\n`);
}

export async function runSourceProviderEvidenceCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<SourceProviderEvidenceCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseSourceProviderEvidenceArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${sourceProviderEvidenceUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${sourceProviderEvidenceUsage()}\n`);
    return 0;
  }

  try {
    const result = await runSourceProviderEvidenceCheck({
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
    return 2;
  }
}

if (isEntrypoint()) {
  process.exitCode = await runSourceProviderEvidenceCheckCli();
}
