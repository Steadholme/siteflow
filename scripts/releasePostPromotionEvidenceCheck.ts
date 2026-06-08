import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  evaluateReleaseEvidenceBundle,
  type ReleaseEvidenceBundleResult
} from "./releaseEvidenceBundleCheck.js";
import { strictIsoTimestampValue } from "./isoTimestamp.js";

type PostPromotionStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface ReleasePostPromotionEvidenceCheckOptions {
  releaseEvidencePath: string;
  deploymentDetailPath?: string;
  deploymentDetail?: unknown;
  serverUrl?: string;
  apiToken?: string;
  deploymentId?: string;
  projectId?: string;
  channel?: string;
  expectedEvidencePath?: string;
  readinessProbe?: unknown;
  metricsProbe?: unknown;
  evaluateBundle?: typeof evaluateReleaseEvidenceBundle;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ReleasePostPromotionEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReleasePostPromotionEvidenceCheckResult {
  name: "siteflow-release-post-promotion-evidence-check";
  status: PostPromotionStatus;
  checkedAt: string;
  releaseEvidencePath: string;
  selectedEvidence: {
    deploymentId: string | null;
    projectId: string | null;
    channel: string | null;
    releaseCommitRef: string | null;
    repository: string | null;
    branch: string | null;
    targetEnvironment: string | null;
    routeRevisionId: string | null;
    routeEvidenceStatus: string | null;
    routeEvidenceCheckedAt: string | null;
  };
  checks: ReleasePostPromotionEvidenceCheck[];
  exitCode: number;
}

interface ParsedArgs {
  releaseEvidencePath?: string;
  deploymentDetailPath?: string;
  serverUrl?: string;
  apiToken?: string;
  deploymentId?: string;
  projectId?: string;
  channel?: string;
  expectedEvidencePath?: string;
  readinessPath?: string;
  metricsPath?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface ReleaseIdentity {
  commitRef?: string;
  repository?: string;
  branch?: string;
  targetEnvironment?: string;
}

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

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function checksumValue(value: unknown) {
  const raw = stringValue(value);

  return raw && sha256DigestPattern.test(raw) ? raw : undefined;
}

function timestampValue(value: unknown) {
  return strictIsoTimestampValue(value);
}

function timestampNotAfter(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && new Date(left).getTime() <= new Date(right).getTime());
}

function nestedObject(candidate: unknown, path: string[]) {
  let current = candidate;

  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return isObject(current) ? current : undefined;
}

function nestedValue(candidate: unknown, path: string[]) {
  let current = candidate;

  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function objectValues(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter(isObject);
  }

  if (isObject(value)) {
    return Object.values(value).filter(isObject);
  }

  return [];
}

function runtimeIsolationValue(candidate: Record<string, unknown> | undefined) {
  const raw = stringValue(candidate?.runtimeIsolation) ??
    stringValue(candidate?.functionRuntimeIsolation) ??
    stringValue(nestedValue(candidate, ["runtime", "isolation"])) ??
    stringValue(nestedValue(candidate, ["runtime", "isolationMode"])) ??
    stringValue(nestedValue(candidate, ["functionRuntime", "isolation"])) ??
    stringValue(nestedValue(candidate, ["functionRuntime", "runtimeIsolation"]));

  return raw?.toLowerCase().replace(/-/g, "_");
}

const allowedFunctionRuntimeIsolationValues = new Set([
  "isolated_process",
  "separate_process",
  "dedicated_process",
  "external",
  "container",
  "sandboxed",
  "worker",
  "edge",
  "v8_isolate",
  "isolate"
]);
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;

function runtimeIsolationIsAllowed(value: string | undefined) {
  return Boolean(value && allowedFunctionRuntimeIsolationValues.has(value));
}

async function readJsonFile(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

function check(
  name: string,
  passed: boolean,
  passMessage: string,
  failMessage: string,
  details?: Record<string, unknown>
): ReleasePostPromotionEvidenceCheck {
  return {
    name,
    status: passed ? "pass" : "fail",
    message: passed ? passMessage : failMessage,
    ...(details ? { details } : {})
  };
}

function releaseIdentity(rawEvidence: unknown, bundleCheck: ReleaseEvidenceBundleResult): ReleaseIdentity {
  const release = nestedObject(rawEvidence, ["release"]);

  return {
    commitRef: stringValue(bundleCheck.selectedEvidence.releaseCommitRef),
    repository: stringValue(bundleCheck.selectedEvidence.repository),
    branch: stringValue(bundleCheck.selectedEvidence.branch),
    targetEnvironment:
      stringValue(nestedValue(rawEvidence, ["targetEnvironment"])) ??
      stringValue(release?.targetEnvironment)
  };
}

function artifactEvidence(rawEvidence: unknown) {
  return nestedObject(rawEvidence, ["artifactEvidence", "evidence"]) ??
    nestedObject(rawEvidence, ["releaseArtifactEvidence", "evidence"]) ??
    nestedObject(rawEvidence, ["artifact", "evidence"]);
}

function deploymentArtifactManifest(deploymentDetail: unknown) {
  return nestedObject(deploymentDetail, ["lineage", "artifact", "manifest"]);
}

function deploymentFunctionRuntimeIsolationSummary(deploymentDetail: unknown) {
  const manifest = deploymentArtifactManifest(deploymentDetail);
  const functionEntries = objectValues(manifest?.functions);
  const manifestRuntimeIsolationValues = [
    manifest,
    nestedObject(manifest, ["runtime"]),
    nestedObject(manifest, ["functionRuntime"])
  ].map(runtimeIsolationValue);
  const manifestRuntimeIsolation = manifestRuntimeIsolationValues.find(Boolean);
  const manifestBlocked = manifestRuntimeIsolationValues.includes("same_process");
  const blockedFunctions = functionEntries.flatMap((entry) => {
    const functionPath = stringValue(entry.path) ?? "unknown";
    const runtimeIsolation = runtimeIsolationValue(entry) ?? manifestRuntimeIsolation;

    if (runtimeIsolationIsAllowed(runtimeIsolation)) {
      return [];
    }

    return [{
      path: functionPath,
      runtimeIsolation: runtimeIsolation ?? null,
      reason: runtimeIsolation === undefined ? "missing runtime isolation" : "unsupported runtime isolation"
    }];
  });

  return {
    functionCount: functionEntries.length,
    manifestRuntimeIsolation: manifestRuntimeIsolation ?? null,
    manifestBlocked,
    blockedFunctions,
    passed: !manifestBlocked && blockedFunctions.length === 0
  };
}

function releaseArtifactSelectedEvidence(rawEvidence: unknown) {
  return nestedObject(artifactEvidence(rawEvidence), ["selectedEvidence"]);
}

function deploymentRouteRevision(deploymentDetail: unknown) {
  return nestedObject(deploymentDetail, ["lineage", "routeRevision"]);
}

function deploymentReleaseEvidence(deploymentDetail: unknown) {
  return nestedObject(deploymentRouteRevision(deploymentDetail), ["releaseEvidence"]);
}

function expectedDeploymentDetailUrl(serverUrl: string, deploymentId: string) {
  const base = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;

  return `${base}/api/deployments/${encodeURIComponent(deploymentId)}`;
}

async function fetchDeploymentDetail(options: ReleasePostPromotionEvidenceCheckOptions) {
  if (options.deploymentDetail) {
    return options.deploymentDetail;
  }

  if (options.deploymentDetailPath) {
    return readJsonFile(options.deploymentDetailPath);
  }

  if (!options.serverUrl || !options.deploymentId) {
    throw new Error("Pass --deployment-detail, or pass --server and --deployment to fetch deployment detail.");
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(expectedDeploymentDetailUrl(options.serverUrl, options.deploymentId), {
    headers: {
      accept: "application/json",
      ...(options.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {})
    }
  });

  if (!response.ok) {
    throw new Error(`Deployment detail request failed with HTTP ${response.status}.`);
  }

  const parsed = await response.json() as unknown;

  if (!isObject(parsed)) {
    throw new Error("Deployment detail response must be a JSON object.");
  }

  return parsed;
}

function probeStatus(probe: unknown) {
  const status = stringValue(nestedValue(probe, ["status"])) ?? stringValue(nestedValue(probe, ["state"]));
  const httpStatus = numberValue(nestedValue(probe, ["statusCode"])) ?? numberValue(nestedValue(probe, ["httpStatus"]));

  return {
    status,
    httpStatus,
    passed:
      status === "passed" ||
      status === "ok" ||
      status === "healthy" ||
      (typeof httpStatus === "number" && httpStatus >= 200 && httpStatus < 400)
  };
}

function artifactManifestMatches(rawEvidence: unknown, deploymentDetail: unknown) {
  const selected = releaseArtifactSelectedEvidence(rawEvidence);
  const manifest = deploymentArtifactManifest(deploymentDetail);
  const expectedFileCount = numberValue(selected?.fileCount);
  const expectedTotalBytes = numberValue(selected?.totalBytes);
  const expectedChecksum = checksumValue(selected?.checksum);
  const actualFileCount = numberValue(manifest?.fileCount);
  const actualTotalBytes = numberValue(manifest?.totalBytes);
  const actualChecksum = checksumValue(manifest?.checksum);

  return {
    expectedFileCount,
    expectedTotalBytes,
    expectedChecksum: expectedChecksum ?? null,
    actualFileCount,
    actualTotalBytes,
    actualChecksum: actualChecksum ?? null,
    passed:
      typeof expectedFileCount === "number" &&
      typeof expectedTotalBytes === "number" &&
      Boolean(expectedChecksum) &&
      actualFileCount === expectedFileCount &&
      actualTotalBytes === expectedTotalBytes &&
      actualChecksum === expectedChecksum
  };
}

export async function runReleasePostPromotionEvidenceCheck(
  options: ReleasePostPromotionEvidenceCheckOptions
): Promise<ReleasePostPromotionEvidenceCheckResult> {
  const channel = options.channel ?? "production";
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const rawEvidence = await readJsonFile(options.releaseEvidencePath);
  const bundleCheck = (options.evaluateBundle ?? evaluateReleaseEvidenceBundle)(rawEvidence, {
    evidencePath: options.releaseEvidencePath,
    targetEnvironment: channel,
    now: options.now
  });
  const deploymentDetail = await fetchDeploymentDetail(options);
  const routeRevision = deploymentRouteRevision(deploymentDetail);
  const releaseEvidence = deploymentReleaseEvidence(deploymentDetail);
  const release = releaseIdentity(rawEvidence, bundleCheck);
  const deploymentId = stringValue(nestedValue(deploymentDetail, ["deployment", "id"]));
  const projectId = stringValue(nestedValue(deploymentDetail, ["project", "id"]));
  const deploymentStatus = stringValue(nestedValue(deploymentDetail, ["deployment", "status"]));
  const deploymentEnvironment = stringValue(nestedValue(deploymentDetail, ["deployment", "environment"]));
  const routeDeploymentId = stringValue(routeRevision?.deploymentId);
  const routeChannel = stringValue(routeRevision?.channel);
  const routeStatus = stringValue(routeRevision?.status);
  const releaseEvidenceCheckedAt = timestampValue(nestedValue(rawEvidence, ["checkedAt"]));
  const routeReleaseEvidenceCheckedAt = timestampValue(releaseEvidence?.checkedAt);
  const readiness = options.readinessProbe ? probeStatus(options.readinessProbe) : undefined;
  const metrics = options.metricsProbe ? probeStatus(options.metricsProbe) : undefined;
  const artifactManifest = artifactManifestMatches(rawEvidence, deploymentDetail);
  const functionRuntimeIsolation = deploymentFunctionRuntimeIsolationSummary(deploymentDetail);
  const checks: ReleasePostPromotionEvidenceCheck[] = [
    check(
      "release_evidence_bundle_passed",
      bundleCheck.status === "passed",
      "Release evidence bundle still passes the final release:evidence checker.",
      "Release evidence bundle no longer passes the final release:evidence checker.",
      { failedChecks: bundleCheck.checks.filter((entry) => entry.status !== "pass").map((entry) => entry.name) }
    ),
    check(
      "deployment_identity",
      Boolean(deploymentId && (!options.deploymentId || deploymentId === options.deploymentId)),
      "Deployment detail identifies the expected deployment.",
      "Deployment detail is missing or does not match the expected deployment id.",
      { expectedDeploymentId: options.deploymentId ?? null, actualDeploymentId: deploymentId ?? null }
    ),
    check(
      "project_identity",
      Boolean(projectId && (!options.projectId || projectId === options.projectId)),
      "Deployment detail identifies the expected project.",
      "Deployment detail is missing or does not match the expected project id.",
      { expectedProjectId: options.projectId ?? null, actualProjectId: projectId ?? null }
    ),
    check(
      "deployment_ready",
      deploymentStatus === "ready",
      "Deployment is ready.",
      "Deployment is not ready.",
      { deploymentStatus: deploymentStatus ?? null }
    ),
    check(
      "deployment_channel",
      deploymentEnvironment === channel,
      "Deployment environment matches the promoted channel.",
      "Deployment environment does not match the promoted channel.",
      { expectedChannel: channel, actualEnvironment: deploymentEnvironment ?? null }
    ),
    check(
      "route_revision_present",
      Boolean(routeRevision),
      "Deployment detail includes the route revision that served the promotion.",
      "Deployment detail does not include a route revision."
    ),
    check(
      "route_revision_applied",
      routeStatus === "applied",
      "Route revision is applied.",
      "Route revision is not applied.",
      { routeStatus: routeStatus ?? null }
    ),
    check(
      "route_targets_deployment",
      Boolean(routeDeploymentId && deploymentId && routeDeploymentId === deploymentId),
      "Route revision targets the inspected deployment.",
      "Route revision does not target the inspected deployment.",
      { routeDeploymentId: routeDeploymentId ?? null, deploymentId: deploymentId ?? null }
    ),
    check(
      "route_channel",
      routeChannel === channel,
      "Route revision channel matches the promoted channel.",
      "Route revision channel does not match the promoted channel.",
      { expectedChannel: channel, actualChannel: routeChannel ?? null }
    ),
    check(
      "route_release_evidence_present",
      Boolean(releaseEvidence),
      "Route revision stores release evidence metadata.",
      "Route revision does not store release evidence metadata."
    ),
    check(
      "route_release_evidence_status",
      stringValue(releaseEvidence?.status) === "passed",
      "Route release evidence metadata records a passed bundle.",
      "Route release evidence metadata does not record a passed bundle.",
      { status: stringValue(releaseEvidence?.status) ?? null }
    ),
    check(
      "route_release_evidence_timestamp",
      Boolean(
        routeReleaseEvidenceCheckedAt &&
          timestampNotAfter(releaseEvidenceCheckedAt, routeReleaseEvidenceCheckedAt) &&
          timestampNotAfter(routeReleaseEvidenceCheckedAt, checkedAt)
      ),
      "Route release evidence metadata records a bounded checkedAt timestamp.",
      "Route release evidence metadata must include an ISO checkedAt timestamp after the release bundle check and not in the future.",
      {
        releaseEvidenceCheckedAt: releaseEvidenceCheckedAt ?? null,
        routeReleaseEvidenceCheckedAt: routeReleaseEvidenceCheckedAt ?? null,
        checkedAt
      }
    ),
    check(
      "route_release_evidence_identity",
      Boolean(
        releaseEvidence &&
          stringValue(releaseEvidence.commitRef) === release.commitRef &&
          stringValue(releaseEvidence.repository) === release.repository &&
          stringValue(releaseEvidence.branch) === release.branch &&
          stringValue(releaseEvidence.targetEnvironment) === release.targetEnvironment
      ),
      "Route release evidence identity matches the release bundle.",
      "Route release evidence identity does not match the release bundle.",
      {
        expected: release,
        actual: {
          commitRef: stringValue(releaseEvidence?.commitRef) ?? null,
          repository: stringValue(releaseEvidence?.repository) ?? null,
          branch: stringValue(releaseEvidence?.branch) ?? null,
          targetEnvironment: stringValue(releaseEvidence?.targetEnvironment) ?? null
        }
      }
    ),
    check(
      "route_release_evidence_path",
      Boolean(stringValue(releaseEvidence?.evidencePath) && (!options.expectedEvidencePath || stringValue(releaseEvidence?.evidencePath) === options.expectedEvidencePath)),
      "Route release evidence metadata records the expected evidence path.",
      "Route release evidence metadata is missing or has the wrong evidence path.",
      {
        expectedEvidencePath: options.expectedEvidencePath ?? null,
        actualEvidencePath: stringValue(releaseEvidence?.evidencePath) ?? null
      }
    ),
    check(
      "artifact_manifest_matches_release_evidence",
      artifactManifest.passed,
      "Deployment artifact manifest file count, byte count, and checksum match release artifact evidence.",
      "Deployment artifact manifest does not match release artifact evidence file count, byte count, and checksum.",
      artifactManifest
    ),
    check(
      "artifact_function_runtime_isolation",
      functionRuntimeIsolation.passed,
      "Deployment artifact functions do not require same-process runtime isolation.",
      "Deployment artifact functions must declare isolated runtime isolation; missing, unknown, or same_process runtime isolation is blocked.",
      functionRuntimeIsolation
    )
  ];

  if (readiness) {
    checks.push(check(
      "readiness_probe_passed",
      readiness.passed,
      "Readiness probe evidence is passing.",
      "Readiness probe evidence is not passing.",
      readiness
    ));
  }

  if (metrics) {
    checks.push(check(
      "metrics_probe_passed",
      metrics.passed,
      "Metrics probe evidence is passing.",
      "Metrics probe evidence is not passing.",
      metrics
    ));
  }

  const passed = checks.every((entry) => entry.status === "pass");

  return {
    name: "siteflow-release-post-promotion-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt,
    releaseEvidencePath: options.releaseEvidencePath,
    selectedEvidence: {
      deploymentId: deploymentId ?? null,
      projectId: projectId ?? null,
      channel,
      releaseCommitRef: release.commitRef ?? null,
      repository: release.repository ?? null,
      branch: release.branch ?? null,
      targetEnvironment: release.targetEnvironment ?? null,
      routeRevisionId: stringValue(routeRevision?.id) ?? null,
      routeEvidenceStatus: stringValue(releaseEvidence?.status) ?? null,
      routeEvidenceCheckedAt: routeReleaseEvidenceCheckedAt ?? null
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseReleasePostPromotionEvidenceCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--release-evidence") {
      parsed.releaseEvidencePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deployment-detail") {
      parsed.deploymentDetailPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--server") {
      parsed.serverUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--token") {
      parsed.apiToken = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deployment") {
      parsed.deploymentId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--project" || arg === "--project-id") {
      parsed.projectId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--channel") {
      parsed.channel = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--expected-evidence-path") {
      parsed.expectedEvidencePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--readiness") {
      parsed.readinessPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--metrics") {
      parsed.metricsPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function releasePostPromotionEvidenceCheckUsage() {
  return [
    "Usage: npm run --silent release:evidence:post-promote -- --release-evidence <release-evidence.json> (--deployment-detail <deployment-detail.json> | --server <url> --deployment <id>) [options]",
    "",
    "Options:",
    "  --release-evidence <file>       Final release evidence bundle JSON.",
    "  --deployment-detail <file>      Deployment detail JSON from siteflow deployments inspect --json.",
    "  --server <url>                  SiteFlow API base URL used to fetch deployment detail.",
    "  --token <token>                 API token for --server.",
    "  --deployment <id>               Deployment id to fetch or verify.",
    "  --project, --project-id <id>    Expected project id.",
    "  --channel <name>                Expected channel. Default: production.",
    "  --expected-evidence-path <path> Expected release evidence path recorded on the route.",
    "  --readiness <file>              Optional readiness probe JSON with status or statusCode.",
    "  --metrics <file>                Optional metrics probe JSON with status or statusCode.",
    "  --json                         Emit a single JSON result.",
    "  --help                         Show this help."
  ].join("\n");
}

function writeHumanResult(result: ReleasePostPromotionEvidenceCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow post-promotion evidence status: ${result.status}\n`);
  output.write(`Deployment: ${result.selectedEvidence.deploymentId ?? "unknown"}\n`);
  output.write(`Release: ${result.selectedEvidence.repository ?? "unknown"}@${result.selectedEvidence.branch ?? "unknown"}@${result.selectedEvidence.releaseCommitRef ?? "unknown"}\n`);
  output.write("Checks:\n");

  for (const entry of result.checks) {
    output.write(`- ${entry.name}: ${entry.status} - ${entry.message}\n`);
  }
}

export async function runReleasePostPromotionEvidenceCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleasePostPromotionEvidenceCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleasePostPromotionEvidenceCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releasePostPromotionEvidenceCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releasePostPromotionEvidenceCheckUsage()}\n`);
    return 0;
  }

  if (!parsed.releaseEvidencePath) {
    io.stderr.write(`--release-evidence is required.\n\n${releasePostPromotionEvidenceCheckUsage()}\n`);
    return 2;
  }

  try {
    const result = await runReleasePostPromotionEvidenceCheck({
      ...baseOptions,
      releaseEvidencePath: parsed.releaseEvidencePath,
      deploymentDetailPath: parsed.deploymentDetailPath,
      serverUrl: parsed.serverUrl,
      apiToken: parsed.apiToken,
      deploymentId: parsed.deploymentId,
      projectId: parsed.projectId,
      channel: parsed.channel,
      expectedEvidencePath: parsed.expectedEvidencePath,
      readinessProbe: parsed.readinessPath ? await readJsonFile(parsed.readinessPath) : baseOptions.readinessProbe,
      metricsProbe: parsed.metricsPath ? await readJsonFile(parsed.metricsPath) : baseOptions.metricsProbe
    });

    if (parsed.json) {
      const output = result.status === "passed" ? io.stdout : io.stderr;
      output.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: ReleasePostPromotionEvidenceCheckResult = {
      name: "siteflow-release-post-promotion-evidence-check",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      releaseEvidencePath: parsed.releaseEvidencePath,
      selectedEvidence: {
        deploymentId: parsed.deploymentId ?? null,
        projectId: parsed.projectId ?? null,
        channel: parsed.channel ?? "production",
        releaseCommitRef: null,
        repository: null,
        branch: null,
        targetEnvironment: null,
        routeRevisionId: null,
        routeEvidenceStatus: null,
        routeEvidenceCheckedAt: null
      },
      checks: [
        {
          name: "post_promotion_inputs",
          status: "fail",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      exitCode: 1
    };

    if (parsed.json) {
      io.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runReleasePostPromotionEvidenceCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
