import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface NonSessionCredentialEvidenceCheckOptions {
  evidencePath: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours?: number;
  now?: () => Date;
}

export interface NonSessionCredentialEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface NonSessionCredentialEvidenceCheckResult {
  name: "siteflow-non-session-credential-evidence-check";
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
    credentialTypes: string[];
    credentialCount: number;
    breakGlass: {
      status?: string;
      ticket?: string;
    } | null;
  };
  checks: NonSessionCredentialEvidenceCheck[];
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
const expectedSchemaVersion = "siteflow.nonSessionCredentialEvidence.v1";
const expectedName = "siteflow-non-session-credential-evidence";
const passStatuses = new Set(["pass", "passed", "ok", "verified", "rotated"]);
const providerManagedCredentialTypes = new Set([
  "database",
  "webhook_secret",
  "ssh_deploy_key",
  "log_drain_signing_secret",
  "deploy_hook_token"
]);
const supportedCredentialTypes = new Set([
  "scoped_api_token",
  "root_api_token",
  "metrics_token",
  "app_sealing_secret",
  ...providerManagedCredentialTypes
]);

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

function addCheck(checks: NonSessionCredentialEvidenceCheck[], name: string, condition: boolean, message: string) {
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

function selectedTimestamp(candidate: Record<string, unknown> | undefined) {
  return timestampValue(candidate?.checkedAt) ??
    timestampValue(candidate?.completedAt) ??
    timestampValue(candidate?.verifiedAt) ??
    timestampValue(candidate?.timestamp) ??
    timestampValue(candidate?.createdAt);
}

function freshSection(candidate: Record<string, unknown> | undefined, now: Date, maxAgeHours: number) {
  return freshTimestamp(selectedTimestamp(candidate), now, maxAgeHours);
}

function redactedCredentialId(value: Record<string, unknown> | undefined) {
  return stringValue(value?.id) ?? stringValue(value?.prefix) ?? stringValue(value?.redactedIdentifier);
}

function credentialEntries(root: Record<string, unknown> | undefined) {
  return Array.isArray(root?.credentials)
    ? root.credentials.filter(isObject)
    : [];
}

function credentialType(entry: Record<string, unknown>) {
  return statusValue(entry.type);
}

const noRawArchiveFlagKeys = [
  "rawSecretArchived",
  "rawCredentialArchived",
  "authorizationHeaderArchived",
  "databaseUrlPasswordArchived"
];

function hasNoRawCredentialArchive(entry: Record<string, unknown>) {
  return noRawArchiveFlagKeys.every((key) => entry[key] === false);
}

function allCredentialsHaveTickets(root: Record<string, unknown> | undefined, credentials: Record<string, unknown>[]) {
  const fallbackTicket = rootTicket(root);

  return credentials.every((entry) => Boolean(stringValue(entry.ticketId) ?? stringValue(entry.ticket) ?? fallbackTicket));
}

function oldCredentialRejected(entry: Record<string, unknown>) {
  return nestedValue(entry, ["oldCredential", "oldCredentialRejected"]) === true ||
    nestedValue(entry, ["oldCredential", "rejected"]) === true;
}

function newCredentialAccepted(entry: Record<string, unknown>) {
  return nestedValue(entry, ["newCredential", "newCredentialAccepted"]) === true ||
    nestedValue(entry, ["newCredential", "accepted"]) === true;
}

function oldNewCredentialIdsPresent(entry: Record<string, unknown>) {
  return Boolean(
    redactedCredentialId(nestedObject(entry, "oldCredential")) &&
      redactedCredentialId(nestedObject(entry, "newCredential"))
  );
}

function scopedApiTokenCredentialPassed(entry: Record<string, unknown>) {
  return entry.createEvidencePresent === true &&
    entry.revokeEvidencePresent === true &&
    entry.auditEventsPresent === true &&
    entry.consumerCutoverVerified === true &&
    entry.leastPrivilegeReviewed === true &&
    Array.isArray(nestedValue(entry, ["newCredential", "scopes"])) &&
    (nestedValue(entry, ["newCredential", "scopes"]) as unknown[]).length > 0 &&
    oldCredentialRejected(entry) &&
    newCredentialAccepted(entry);
}

function runtimeTokenCredentialPassed(entry: Record<string, unknown>) {
  return statusValue(entry.strengthStatus) === "pass" &&
    entry.secretStoreUpdated === true &&
    (entry.serviceReloaded === true || entry.scraperReloaded === true) &&
    oldCredentialRejected(entry) &&
    newCredentialAccepted(entry);
}

function appSealingCredentialPassed(entry: Record<string, unknown>) {
  return entry.backupCompleted === true &&
    entry.reSealPlanPresent === true &&
    entry.rollbackPlanPresent === true &&
    entry.spotCheckPassed === true &&
    entry.riskAccepted === true &&
    entry.automaticRotationClaimed !== true;
}

function providerManagedCredentialPassed(entry: Record<string, unknown>) {
  return entry.providerRotationProofPresent === true &&
    entry.dependentServiceVerified === true &&
    oldCredentialRejected(entry) &&
    newCredentialAccepted(entry);
}

function credentialSpecificPassed(entry: Record<string, unknown>) {
  const type = credentialType(entry);

  if (type === "scoped_api_token") {
    return scopedApiTokenCredentialPassed(entry);
  }

  if (type === "root_api_token" || type === "metrics_token") {
    return runtimeTokenCredentialPassed(entry);
  }

  if (type === "app_sealing_secret") {
    return appSealingCredentialPassed(entry);
  }

  if (type && providerManagedCredentialTypes.has(type)) {
    return providerManagedCredentialPassed(entry);
  }

  return false;
}

function breakGlassEvidence(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "breakGlass") ?? nestedObject(root, "breakglass");
}

function breakGlassPassed(root: Record<string, unknown> | undefined) {
  const evidence = breakGlassEvidence(root);

  return Boolean(
    evidence &&
      isPassingStatus(evidence.status) &&
      (stringValue(evidence.incidentTicket) ?? stringValue(evidence.ticket) ?? rootTicket(root)) &&
      (evidence.approverCount === undefined || Number(evidence.approverCount) >= 2 || evidence.approvalExceptionAccepted === true) &&
      stringValue(evidence.emergencyCredentialSource) &&
      evidence.leastPrivilegeReviewed === true &&
      evidence.timeBoundedAccess === true &&
      evidence.postIncidentRevocationPlanned === true &&
      hasNoRawCredentialArchive(evidence)
  );
}

export function evaluateNonSessionCredentialEvidence(
  rawEvidence: unknown,
  options: NonSessionCredentialEvidenceCheckOptions
): NonSessionCredentialEvidenceCheckResult {
  const now = options.now?.() ?? new Date();
  const maxAgeHours = positiveNumber(options.maxAgeHours, defaultMaxAgeHours, "maxAgeHours");
  const root = isObject(rawEvidence) ? rawEvidence : undefined;
  const credentials = credentialEntries(root);
  const credentialTypes = [...new Set(credentials.map(credentialType).filter(Boolean) as string[])];
  const limitations = nestedObject(root, "limitations");
  const commitRef = releaseCommit(root);
  const repository = releaseRepository(root);
  const branch = releaseBranch(root);
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const checks: NonSessionCredentialEvidenceCheck[] = [];

  addCheck(checks, "evidence_shape", Boolean(root), "Non-session credential evidence must be a JSON object.");
  addCheck(
    checks,
    "schema_version",
    root?.schemaVersion === expectedSchemaVersion,
    `Non-session credential evidence schemaVersion must be ${expectedSchemaVersion}.`
  );
  addCheck(
    checks,
    "evidence_name",
    root?.name === expectedName,
    `Non-session credential evidence name must be ${expectedName}.`
  );
  addCheck(checks, "evidence_status", statusValue(root?.status) === "passed", "Non-session credential evidence status must be passed.");
  addCheck(checks, "status_final", statusValue(root?.status) === "passed", "Non-session credential evidence status must be exactly passed for final production evidence.");
  addCheck(checks, "non_dry_run", root?.dryRun === false, "Non-session credential evidence must be non-dry-run.");
  addCheck(checks, "not_template", root?.template !== true, "Non-session credential evidence must be final target evidence, not a template skeleton.");
  addCheck(
    checks,
    "evidence_age",
    freshTimestamp(evidenceTimestamp(root), now, maxAgeHours),
    `Non-session credential evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "release_identity",
    Boolean(
      commitRef &&
        repository &&
        branch &&
        (!options.commitRef || options.commitRef === commitRef) &&
        (!options.repo || options.repo === repository) &&
        (!options.branch || options.branch === branch)
    ),
    "Non-session credential evidence must include release commit, repository, and branch matching requested values."
  );
  addCheck(
    checks,
    "environment",
    Boolean(environmentName(root) && (!options.targetEnvironment || environmentName(root) === options.targetEnvironment)),
    "Non-session credential evidence must include target environment and match the requested target environment when provided."
  );
  addCheck(checks, "operator", Boolean(operatorName(root)), "Non-session credential evidence must include operator name.");
  addCheck(checks, "ticket", Boolean(rootTicket(root)), "Non-session credential evidence must include release, change, or incident ticket.");

  addCheck(checks, "credentials_present", credentials.length > 0, "At least one non-session credential rotation or break-glass credential entry is required.");
  addCheck(
    checks,
    "credential_types_supported",
    credentials.length > 0 && credentials.every((entry) => {
      const type = credentialType(entry);

      return Boolean(type && supportedCredentialTypes.has(type));
    }),
    "Credential entries must use a supported non-session credential type."
  );
  addCheck(
    checks,
    "credential_owners_and_tickets",
    credentials.length > 0 &&
      credentials.every((entry) => Boolean(stringValue(entry.owner) ?? operatorName(root))) &&
      allCredentialsHaveTickets(root, credentials),
    "Every credential entry must have an owner and ticket metadata."
  );
  addCheck(
    checks,
    "credential_status",
    credentials.length > 0 && credentials.every((entry) => isPassingStatus(entry.status)),
    "Every credential entry must include a passing status."
  );
  addCheck(
    checks,
    "credential_age",
    credentials.length > 0 && credentials.every((entry) => freshSection(entry, now, maxAgeHours)),
    `Every credential entry must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "credential_redacted_identifiers",
    credentials.length > 0 && credentials.every(oldNewCredentialIdsPresent),
    "Every credential entry must include old and new redacted identifiers or prefixes."
  );
  addCheck(
    checks,
    "no_raw_credentials_archived",
    credentials.length > 0 && credentials.every(hasNoRawCredentialArchive),
    "Credential evidence must not archive raw secrets, authorization headers, or database URL passwords."
  );
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Credential evidence must not include raw secret-like values."
      : `Credential evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );
  addCheck(
    checks,
    "old_credentials_rejected",
    credentials.length > 0 && credentials.every((entry) => credentialType(entry) === "app_sealing_secret" || oldCredentialRejected(entry)),
    "Every replaceable credential must prove the old credential is rejected."
  );
  addCheck(
    checks,
    "new_credentials_accepted",
    credentials.length > 0 && credentials.every((entry) => credentialType(entry) === "app_sealing_secret" || newCredentialAccepted(entry)),
    "Every replaceable credential must prove the new credential works."
  );
  addCheck(
    checks,
    "credential_specific_evidence",
    credentials.length > 0 && credentials.every(credentialSpecificPassed),
    "Credential entries must include type-specific rotation, consumer cutover, provider proof, or app-secret risk evidence."
  );

  addCheck(checks, "break_glass_present", Boolean(breakGlassEvidence(root)), "Break-glass evidence must be present.");
  addCheck(
    checks,
    "break_glass_status",
    isPassingStatus(breakGlassEvidence(root)?.status),
    "Break-glass evidence must include a passing status."
  );
  addCheck(
    checks,
    "break_glass_age",
    freshSection(breakGlassEvidence(root), now, maxAgeHours),
    `Break-glass evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "break_glass_controls",
    breakGlassPassed(root),
    "Break-glass evidence must include ticket, emergency source, review, time bounds, post-incident revocation, and no raw credential archival."
  );
  addCheck(
    checks,
    "automation_not_claimed",
    limitations?.automaticRotationClaimed === false &&
      limitations?.siteflowRotatedExternalSecrets === false,
    "Evidence must not claim SiteFlow automatically rotated non-session or external credentials."
  );

  const passed = checks.every((check) => check.status === "pass");
  const breakGlass = breakGlassEvidence(root);

  return {
    name: "siteflow-non-session-credential-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxAgeHours
    },
    selectedEvidence: {
      environment: environmentName(root) ?? null,
      commitRef: commitRef ?? null,
      repository: repository ?? null,
      branch: branch ?? null,
      credentialTypes,
      credentialCount: credentials.length,
      breakGlass: breakGlass
        ? {
            status: stringValue(breakGlass.status),
            ticket: stringValue(breakGlass.incidentTicket) ?? stringValue(breakGlass.ticket) ?? rootTicket(root)
          }
        : null
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runNonSessionCredentialEvidenceCheck(
  options: NonSessionCredentialEvidenceCheckOptions
): Promise<NonSessionCredentialEvidenceCheckResult> {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateNonSessionCredentialEvidence(raw, options);
}

export function parseNonSessionCredentialEvidenceArgs(args: string[]): ParsedArgs {
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
    throw new Error("Missing required option: --evidence.");
  }

  return parsed;
}

export function nonSessionCredentialEvidenceUsage() {
  return [
    "Usage: npm run --silent non-session-credential:evidence -- --evidence <non-session-credential-evidence.json> [options]",
    "",
    "Options:",
    "  --commit-ref <sha>       Expected release commit.",
    "  --repo <owner/repo>      Expected repository.",
    "  --branch <branch>        Expected branch.",
    "  --target-environment <name> Expected target environment.",
    `  --max-age-hours <hours>  Maximum evidence age. Default: ${defaultMaxAgeHours}.`,
    "  --json                   Print JSON result.",
    "  --help                   Show this help."
  ].join("\n");
}

function writeHumanResult(result: NonSessionCredentialEvidenceCheckResult, io: CliIo) {
  io.stdout.write(`SiteFlow non-session credential evidence check: ${result.status}\n`);

  for (const check of result.checks) {
    io.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}\n`);
  }
}

export async function runNonSessionCredentialEvidenceCheckCli(args: string[], io: CliIo = process): Promise<number> {
  try {
    const parsed = parseNonSessionCredentialEvidenceArgs(args);

    if (parsed.help) {
      io.stdout.write(`${nonSessionCredentialEvidenceUsage()}\n`);
      return 0;
    }

    const result = await runNonSessionCredentialEvidenceCheck({
      evidencePath: parsed.evidencePath as string,
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
    const message = error instanceof Error ? error.message : "Unknown non-session credential evidence check failure.";
    io.stderr.write(`non-session-credential:evidence failed: ${message}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  const exitCode = await runNonSessionCredentialEvidenceCheckCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
