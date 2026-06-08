import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface UpgradeRollbackDrillEvidenceCheckOptions {
  evidencePath: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours?: number;
  now?: () => Date;
}

export interface UpgradeRollbackDrillEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface UpgradeRollbackDrillEvidenceCheckResult {
  name: "siteflow-upgrade-rollback-drill-evidence-check";
  status: EvidenceStatus;
  checkedAt: string;
  evidencePath: string;
  thresholds: {
    maxAgeHours: number;
  };
  selectedEvidence: {
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    targetEnvironment: string | null;
    fromVersion: string | null;
    toVersion: string | null;
    rollbackVersion: string | null;
    upgradeOperationId: string | null;
    rollbackOperationId: string | null;
  };
  checks: UpgradeRollbackDrillEvidenceCheck[];
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
const expectedSchemaVersion = "siteflow.upgradeRollbackDrill.v1";
const expectedName = "siteflow-upgrade-rollback-drill";

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

function addCheck(checks: UpgradeRollbackDrillEvidenceCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function releaseMetadata(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "release") ?? root;
}

function releaseCommit(root: Record<string, unknown> | undefined) {
  const release = releaseMetadata(root);

  return stringValue(release?.commitRef) ?? stringValue(release?.commitSha);
}

function releaseRepository(root: Record<string, unknown> | undefined) {
  return stringValue(releaseMetadata(root)?.repository);
}

function releaseBranch(root: Record<string, unknown> | undefined) {
  return stringValue(releaseMetadata(root)?.branch);
}

function versionValue(root: Record<string, unknown> | undefined, key: "fromVersion" | "toVersion" | "rollbackVersion") {
  const release = releaseMetadata(root);

  return stringValue(root?.[key]) ?? stringValue(release?.[key]) ?? stringValue(nestedValue(root, ["versions", key]));
}

function operationId(operation: Record<string, unknown> | undefined) {
  return stringValue(operation?.operationId) ?? stringValue(operation?.commandId) ?? stringValue(operation?.id);
}

function eventTimestamp(candidate: Record<string, unknown> | undefined) {
  return timestampValue(candidate?.completedAt) ??
    timestampValue(candidate?.checkedAt) ??
    timestampValue(candidate?.scrapedAt) ??
    timestampValue(candidate?.queriedAt) ??
    timestampValue(candidate?.deliveredAt) ??
    timestampValue(candidate?.timestamp);
}

function timestampNotAfter(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && Date.parse(left) <= Date.parse(right));
}

function timestampBetween(timestamp: string | undefined, start: string | undefined, end: string | undefined) {
  return Boolean(
    timestamp &&
      start &&
      end &&
      Date.parse(timestamp) >= Date.parse(start) &&
      Date.parse(timestamp) <= Date.parse(end)
  );
}

function isSuccessfulOperation(operation: Record<string, unknown> | undefined) {
  const status = statusValue(operation?.status);

  return Boolean(operation && operation.dryRun === false && (status === "succeeded" || status === "passed" || status === "completed"));
}

function imageDigest(value: unknown) {
  const digest = stringValue(value);

  if (!digest) {
    return undefined;
  }

  const digestPattern = /(?:^|@)sha256:[a-f0-9]{64}$/i;
  return digestPattern.test(digest) ? digest : undefined;
}

function serviceDigest(root: Record<string, unknown> | undefined, service: "api" | "worker", phase: "before" | "after" | "rollback") {
  return imageDigest(nestedValue(root, ["services", service, phase, "imageDigest"]) ??
    nestedValue(root, ["services", service, phase, "image"]) ??
    nestedValue(root, [service, phase, "imageDigest"]));
}

function artifactChecksum(value: unknown) {
  const checksum = stringValue(value);

  if (!checksum) {
    return undefined;
  }

  return /^sha256:[a-f0-9]{16,64}$/i.test(checksum) || /^[a-f0-9]{64}$/i.test(checksum) ? checksum : undefined;
}

function routePhase(root: Record<string, unknown> | undefined, phase: "before" | "after" | "rollback") {
  return nestedObject(nestedObject(root, "route"), phase);
}

function routeDeploymentId(root: Record<string, unknown> | undefined, phase: "before" | "after" | "rollback") {
  return stringValue(routePhase(root, phase)?.deploymentId);
}

function routeArtifactChecksum(root: Record<string, unknown> | undefined, phase: "before" | "after" | "rollback") {
  return artifactChecksum(routePhase(root, phase)?.artifactChecksum ?? routePhase(root, phase)?.artifactSha256);
}

function releaseIdentityValues(root: Record<string, unknown> | undefined, options: UpgradeRollbackDrillEvidenceCheckOptions) {
  return {
    commitRef: options.commitRef ?? releaseCommit(root),
    repository: options.repo ?? releaseRepository(root),
    branch: options.branch ?? releaseBranch(root)
  };
}

function releaseIdentityMatches(root: Record<string, unknown> | undefined, options: UpgradeRollbackDrillEvidenceCheckOptions) {
  const commitRef = releaseCommit(root);
  const repository = releaseRepository(root);
  const branch = releaseBranch(root);

  return Boolean(
    commitRef &&
      repository &&
      branch &&
      (!options.commitRef || options.commitRef === commitRef) &&
      (!options.repo || options.repo === repository) &&
      (!options.branch || options.branch === branch)
  );
}

function targetEnvironment(root: Record<string, unknown> | undefined) {
  return stringValue(root?.targetEnvironment) ?? stringValue(releaseMetadata(root)?.targetEnvironment);
}

function targetEnvironmentMatches(root: Record<string, unknown> | undefined, options: UpgradeRollbackDrillEvidenceCheckOptions) {
  const rootTarget = stringValue(root?.targetEnvironment);
  const releaseTarget = stringValue(releaseMetadata(root)?.targetEnvironment);
  const selectedTarget = rootTarget ?? releaseTarget;

  return Boolean(
    selectedTarget &&
      (!rootTarget || !releaseTarget || rootTarget === releaseTarget) &&
      (!options.targetEnvironment || options.targetEnvironment === selectedTarget)
  );
}

function migrationVersion(root: Record<string, unknown> | undefined, phase: "before" | "after" | "rollback") {
  return stringValue(nestedValue(root, ["migrations", phase, "currentVersion"])) ??
    stringValue(nestedValue(root, ["migrations", phase, "schemaVersion"])) ??
    stringValue(nestedValue(root, ["migrationVersions", phase]));
}

function backupEvidencePassed(root: Record<string, unknown> | undefined) {
  const backup = nestedObject(root, "backupEvidence") ?? nestedObject(nestedObject(root, "attachments"), "backupEvidence");
  const evidence = isObject(backup?.evidence) ? backup.evidence : backup;
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const checks = evidence?.checks;
  const allChecksPassed = Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every((check) => isObject(check) && statusValue(check.status) === "pass");
  const passedCheckNames = new Set(
    Array.isArray(checks)
      ? checks
        .filter((check) => isObject(check) && statusValue(check.status) === "pass")
        .map((check) => stringValue(check.name))
        .filter((name): name is string => Boolean(name))
      : []
  );
  const requiredOffHostChecksPassed = requiredOffHostBackupEvidenceCheckNames.every((name) => passedCheckNames.has(name));

  return Boolean(
    evidence &&
      evidence.name === "siteflow-backup-evidence-check" &&
      statusValue(evidence.status) === "passed" &&
      evidence.exitCode === 0 &&
      nestedValue(evidence, ["thresholds", "requireOffHost"]) === true &&
      allChecksPassed &&
      requiredOffHostChecksPassed &&
      nestedObject(selectedEvidence, "backupVerify") &&
      nestedObject(selectedEvidence, "restoreDrill") &&
      nestedObject(selectedEvidence, "backupOffload") &&
      nestedObject(selectedEvidence, "backupFetch") &&
      nestedObject(selectedEvidence, "backupProviderSecurityAudit") &&
      nestedObject(selectedEvidence, "backupPrune")
  );
}

function readinessPhase(root: Record<string, unknown> | undefined, phase: "before" | "after" | "rollback") {
  return nestedObject(nestedObject(root, "readiness"), phase);
}

function readinessPassed(root: Record<string, unknown> | undefined, phase: "before" | "after" | "rollback") {
  const readiness = readinessPhase(root, phase);
  const status = statusValue(readiness?.status);

  return Boolean(readiness && readiness.statusCode === 200 && (status === "ready" || status === "passed" || status === "healthy"));
}

function httpRollbackVerified(root: Record<string, unknown> | undefined) {
  const rollback = nestedObject(nestedObject(root, "httpVerification"), "rollback") ??
    nestedObject(root, "rollbackHttpVerification");

  return Boolean(
    rollback &&
      statusValue(rollback.status) === "passed" &&
      rollback.statusCode === 200 &&
      stringValue(rollback.deploymentId) === routeDeploymentId(root, "rollback") &&
      artifactChecksum(rollback.artifactChecksum) === routeArtifactChecksum(root, "rollback")
  );
}

function observabilityEvidencePassed(root: Record<string, unknown> | undefined) {
  const observability = nestedObject(root, "observability");
  const metrics = nestedObject(observability, "metrics");
  const logs = nestedObject(observability, "logs");
  const alertDelivery = nestedObject(observability, "alertDelivery");
  const rollbackOperation = nestedObject(nestedObject(root, "operations"), "rollback") ?? nestedObject(root, "rollbackOperation");
  const rollbackOperationId = operationId(rollbackOperation);
  const rollbackCompletedAt = eventTimestamp(rollbackOperation);
  const completedAt = timestampValue(root?.completedAt) ?? timestampValue(root?.checkedAt);
  const rollbackDeployment = routeDeploymentId(root, "rollback");
  const rollbackArtifact = routeArtifactChecksum(root, "rollback");
  const metricsTimestamp = eventTimestamp(metrics);
  const logsTimestamp = eventTimestamp(logs);
  const alertTimestamp = eventTimestamp(alertDelivery);
  const metricsCorrelated = Boolean(
    metrics &&
      (
        stringValue(metrics.rollbackOperationId) === rollbackOperationId ||
        stringValue(metrics.operationId) === rollbackOperationId ||
        stringValue(metrics.deploymentId) === rollbackDeployment ||
        artifactChecksum(metrics.artifactChecksum) === rollbackArtifact
      )
  );

  return {
    metrics: Boolean(
      metrics &&
        (statusValue(metrics.status) === "scraped" || statusValue(metrics.status) === "passed") &&
        metrics.rollbackObserved === true &&
        metricsCorrelated &&
        timestampBetween(metricsTimestamp, rollbackCompletedAt, completedAt)
    ),
    logs: Boolean(
      logs &&
        (statusValue(logs.status) === "queried" || statusValue(logs.status) === "passed") &&
        stringValue(logs.rollbackOperationId) === rollbackOperationId &&
        timestampBetween(logsTimestamp, rollbackCompletedAt, completedAt)
    ),
    alerts: Boolean(
      alertDelivery &&
        (statusValue(alertDelivery.status) === "delivered" || statusValue(alertDelivery.status) === "passed") &&
        Boolean(stringValue(alertDelivery.channel) ?? stringValue(alertDelivery.target)) &&
        timestampBetween(alertTimestamp, rollbackCompletedAt, completedAt)
    )
  };
}

function operatorName(root: Record<string, unknown> | undefined) {
  const release = releaseMetadata(root);

  return stringValue(root?.operatorName) ?? stringValue(release?.operatorName) ?? stringValue(root?.operator);
}

function ticketId(root: Record<string, unknown> | undefined) {
  const release = releaseMetadata(root);

  return stringValue(root?.ticketId) ??
    stringValue(root?.releaseTicket) ??
    stringValue(release?.ticketId) ??
    stringValue(release?.releaseTicket) ??
    stringValue(release?.changeRequest);
}

export function evaluateUpgradeRollbackDrillEvidence(
  rawEvidence: unknown,
  options: UpgradeRollbackDrillEvidenceCheckOptions
): UpgradeRollbackDrillEvidenceCheckResult {
  const now = options.now?.() ?? new Date();
  const maxAgeHours = positiveNumber(options.maxAgeHours, defaultMaxAgeHours, "maxAgeHours");
  const root = isObject(rawEvidence) ? rawEvidence : undefined;
  const startedAt = timestampValue(root?.startedAt);
  const completedAt = timestampValue(root?.completedAt) ?? timestampValue(root?.checkedAt);
  const fromVersion = versionValue(root, "fromVersion");
  const toVersion = versionValue(root, "toVersion");
  const rollbackVersion = versionValue(root, "rollbackVersion");
  const upgradeOperation = nestedObject(nestedObject(root, "operations"), "upgrade") ?? nestedObject(root, "upgradeOperation");
  const rollbackOperation = nestedObject(nestedObject(root, "operations"), "rollback") ?? nestedObject(root, "rollbackOperation");
  const upgradeOperationId = operationId(upgradeOperation);
  const rollbackOperationId = operationId(rollbackOperation);
  const upgradeCompletedAt = eventTimestamp(upgradeOperation);
  const rollbackCompletedAt = eventTimestamp(rollbackOperation);
  const identity = releaseIdentityValues(root, options);
  const apiBefore = serviceDigest(root, "api", "before");
  const apiAfter = serviceDigest(root, "api", "after");
  const apiRollback = serviceDigest(root, "api", "rollback");
  const workerBefore = serviceDigest(root, "worker", "before");
  const workerAfter = serviceDigest(root, "worker", "after");
  const workerRollback = serviceDigest(root, "worker", "rollback");
  const migrationBefore = migrationVersion(root, "before");
  const migrationAfter = migrationVersion(root, "after");
  const migrationRollback = migrationVersion(root, "rollback");
  const beforeDeployment = routeDeploymentId(root, "before");
  const afterDeployment = routeDeploymentId(root, "after");
  const rollbackDeployment = routeDeploymentId(root, "rollback");
  const beforeArtifact = routeArtifactChecksum(root, "before");
  const afterArtifact = routeArtifactChecksum(root, "after");
  const rollbackArtifact = routeArtifactChecksum(root, "rollback");
  const observability = observabilityEvidencePassed(root);
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const checks: UpgradeRollbackDrillEvidenceCheck[] = [];

  addCheck(checks, "evidence_shape", Boolean(root), "Upgrade/rollback drill evidence must be a JSON object.");
  addCheck(checks, "schema_version", root?.schemaVersion === expectedSchemaVersion, `schemaVersion must be ${expectedSchemaVersion}.`);
  addCheck(checks, "evidence_name", root?.name === expectedName, `name must be ${expectedName}.`);
  addCheck(checks, "drill_status", statusValue(root?.status) === "passed", "Drill evidence status must be passed.");
  addCheck(checks, "status_final", statusValue(root?.status) === "passed", "Drill evidence status must be exactly passed for final production evidence.");
  addCheck(checks, "non_dry_run", root?.dryRun === false, "Drill evidence must come from a non-dry-run staging or target rehearsal.");
  addCheck(checks, "not_template", root?.template !== true, "Drill evidence must be final target evidence, not a template skeleton.");
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Upgrade/rollback drill evidence must not include raw secret-like values."
      : `Upgrade/rollback drill evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );
  addCheck(checks, "drill_age", freshTimestamp(completedAt, now, maxAgeHours), `Drill evidence must be no older than ${maxAgeHours} hours.`);
  addCheck(
    checks,
    "drill_time_order",
    timestampNotAfter(startedAt, upgradeCompletedAt) &&
      timestampNotAfter(upgradeCompletedAt, rollbackCompletedAt) &&
      timestampNotAfter(rollbackCompletedAt, completedAt),
    "Drill timestamps must show startedAt, upgrade completion, rollback completion, and completedAt in order."
  );
  addCheck(
    checks,
    "target_environment",
    targetEnvironmentMatches(root, options),
    options.targetEnvironment
      ? `Drill evidence target environment must be ${options.targetEnvironment}.`
      : "Drill evidence must include one target environment consistently at root and release metadata."
  );
  addCheck(
    checks,
    "version_pair",
    Boolean(fromVersion && toVersion && fromVersion !== toVersion),
    "Drill evidence must include distinct fromVersion and toVersion values."
  );
  addCheck(
    checks,
    "rollback_version",
    Boolean(rollbackVersion && fromVersion && rollbackVersion === fromVersion),
    "Drill evidence must show the application rollback returned to fromVersion."
  );
  addCheck(checks, "release_identity", releaseIdentityMatches(root, options), "Drill evidence must be bound to the requested release commit, repository, and branch.");
  addCheck(checks, "api_image_digests", Boolean(apiBefore && apiAfter && apiRollback), "API before/after/rollback image digests must be present and sha256-pinned.");
  addCheck(checks, "worker_image_digests", Boolean(workerBefore && workerAfter && workerRollback), "Worker before/after/rollback image digests must be present and sha256-pinned.");
  addCheck(
    checks,
    "service_rollback_digest",
    Boolean(apiBefore && apiRollback && apiBefore === apiRollback && workerBefore && workerRollback && workerBefore === workerRollback && apiAfter !== apiBefore && workerAfter !== workerBefore),
    "Rollback API/worker image digests must return to the before digests while after digests are distinct."
  );
  addCheck(
    checks,
    "migration_versions",
    Boolean(migrationBefore && migrationAfter && migrationRollback),
    "Migration evidence must include before, after, and rollback-time schema versions."
  );
  addCheck(
    checks,
    "schema_rollback_compatibility",
    nestedValue(root, ["migrations", "rollbackCompatibilityVerified"]) === true ||
      nestedValue(root, ["schemaCompatibility", "rolledBackAppCompatibleWithAfterSchema"]) === true,
    "Drill evidence must prove the rolled-back app is compatible with the post-upgrade schema."
  );
  addCheck(
    checks,
    "backup_evidence_passed",
    backupEvidencePassed(root),
    "Drill evidence must include passed backup evidence checked with requireOffHost, fetch, provider audit, and prune proof."
  );
  addCheck(
    checks,
    "release_operations",
    isSuccessfulOperation(upgradeOperation) &&
      isSuccessfulOperation(rollbackOperation) &&
      Boolean(upgradeOperationId && rollbackOperationId && upgradeOperationId !== rollbackOperationId),
    "Drill evidence must include distinct successful non-dry-run upgrade and rollback operation ids."
  );
  addCheck(
    checks,
    "route_upgrade",
    Boolean(beforeDeployment && afterDeployment && beforeDeployment !== afterDeployment && beforeArtifact && afterArtifact && beforeArtifact !== afterArtifact),
    "Route evidence must show the upgrade moved to a distinct deployment and artifact checksum."
  );
  addCheck(
    checks,
    "route_rollback_restores_previous_artifact",
    Boolean(beforeDeployment && rollbackDeployment && beforeDeployment === rollbackDeployment && beforeArtifact && rollbackArtifact && beforeArtifact === rollbackArtifact),
    "Route evidence must show rollback restored the previous deployment and artifact checksum."
  );
  addCheck(
    checks,
    "http_rollback_verification",
    httpRollbackVerified(root),
    "Drill evidence must include real HTTP verification of the rolled-back route."
  );
  addCheck(
    checks,
    "readiness_evidence",
    readinessPassed(root, "before") &&
      readinessPassed(root, "after") &&
      readinessPassed(root, "rollback") &&
      nestedValue(root, ["readiness", "trafficRemovedDuringUpgrade"]) === true,
    "Readiness evidence must show before/after/rollback ready probes and traffic removal during upgrade."
  );
  addCheck(
    checks,
    "metrics_evidence",
    observability.metrics,
    "Metrics evidence must show rollback-related metrics were scraped or observed."
  );
  addCheck(
    checks,
    "logs_evidence",
    observability.logs,
    "Log evidence must show rollback operation logs were queried."
  );
  addCheck(
    checks,
    "alert_evidence",
    observability.alerts,
    "Alert evidence must show rollback drill alert delivery or routing."
  );
  addCheck(checks, "operator", Boolean(operatorName(root)), "Drill evidence must include the operator name.");
  addCheck(checks, "ticket", Boolean(ticketId(root)), "Drill evidence must include a release, change, or incident ticket id.");

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-upgrade-rollback-drill-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxAgeHours
    },
    selectedEvidence: {
      commitRef: identity.commitRef ?? null,
      repository: identity.repository ?? null,
      branch: identity.branch ?? null,
      targetEnvironment: targetEnvironment(root) ?? null,
      fromVersion: fromVersion ?? null,
      toVersion: toVersion ?? null,
      rollbackVersion: rollbackVersion ?? null,
      upgradeOperationId: upgradeOperationId ?? null,
      rollbackOperationId: rollbackOperationId ?? null
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runUpgradeRollbackDrillEvidenceCheck(
  options: UpgradeRollbackDrillEvidenceCheckOptions
): Promise<UpgradeRollbackDrillEvidenceCheckResult> {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateUpgradeRollbackDrillEvidence(raw, options);
}

export function parseUpgradeRollbackDrillEvidenceCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    maxAgeHours: defaultMaxAgeHours,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--evidence") {
      parsed.evidencePath = args[++index];
    } else if (arg === "--commit-ref") {
      parsed.commitRef = args[++index];
    } else if (arg === "--repo") {
      parsed.repo = args[++index];
    } else if (arg === "--branch") {
      parsed.branch = args[++index];
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = args[++index];
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(args[++index]);
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.evidencePath) {
    throw new Error("--evidence <file> is required.");
  }

  positiveNumber(parsed.maxAgeHours, defaultMaxAgeHours, "--max-age-hours");

  return parsed;
}

export function upgradeRollbackDrillEvidenceCheckUsage() {
  return [
    "Usage: npm run --silent upgrade-rollback:evidence -- --evidence <file> [--json]",
    "",
    "Options:",
    "  --evidence <file>        Evidence JSON from a target or staging upgrade/rollback drill.",
    "  --commit-ref <sha>       Require the release commit SHA.",
    "  --repo <owner/repo>      Require the target repository.",
    "  --branch <branch>        Require the target branch.",
    "  --target-environment <name>  Require the target environment label.",
    `  --max-age-hours <hours>  Maximum drill evidence age. Default: ${defaultMaxAgeHours}.`,
    "  --json                  Emit a single JSON result.",
    "  --help                  Show this help."
  ].join("\n");
}

function writeHumanResult(result: UpgradeRollbackDrillEvidenceCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow upgrade/rollback drill evidence status: ${result.status}\n`);
  output.write(`Evidence: ${result.evidencePath}\n`);
  output.write("Checks:\n");

  for (const check of result.checks) {
    output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
  }
}

export async function runUpgradeRollbackDrillEvidenceCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<UpgradeRollbackDrillEvidenceCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseUpgradeRollbackDrillEvidenceCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${upgradeRollbackDrillEvidenceCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${upgradeRollbackDrillEvidenceCheckUsage()}\n`);
    return 0;
  }

  try {
    const result = await runUpgradeRollbackDrillEvidenceCheck({
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
    const result: UpgradeRollbackDrillEvidenceCheckResult = {
      name: "siteflow-upgrade-rollback-drill-evidence-check",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      evidencePath: parsed.evidencePath!,
      thresholds: {
        maxAgeHours: parsed.maxAgeHours
      },
      selectedEvidence: {
        commitRef: null,
        repository: null,
        branch: null,
        targetEnvironment: null,
        fromVersion: null,
        toVersion: null,
        rollbackVersion: null,
        upgradeOperationId: null,
        rollbackOperationId: null
      },
      checks: [
        {
          name: "evidence_file",
          status: "fail",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      exitCode: 1
    };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runUpgradeRollbackDrillEvidenceCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
