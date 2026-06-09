import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck.js";
import {
  evaluateReleaseEvidenceBundle,
  ingressTopologyRateLimitEvidencePassed,
  releaseEvidenceRequiredAttestationKeyIdFromEnv,
  type ReleaseEvidenceBundleResult
} from "./releaseEvidenceBundleCheck.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets, sensitiveOutputReasons } from "./evidenceSecretScan.js";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck.js";
import { strictIsoTimestampValue } from "./isoTimestamp.js";
import { requiredNonSessionCredentialEvidenceCheckNames } from "./nonSessionCredentialEvidenceCheck.js";
import { requiredObservabilityEvidenceCheckNames } from "./observabilityEvidenceCheck.js";
import { requiredOperatorAccessEvidenceCheckNames } from "./operatorAccessEvidenceCheck.js";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts.js";
import { validateReleaseEvidenceRehearsalPackContract } from "./releaseEvidenceRehearsalPackContract.js";
import {
  parseTargetEnvFile,
  targetEnvFilePreflightIssues,
  targetEnvFileUnreadableIssues
} from "./releaseTargetEnvFilePreflight.js";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck.js";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck.js";
import { requiredUpgradeRollbackDrillEvidenceCheckNames } from "./upgradeRollbackDrillEvidenceCheck.js";

type ReportStatus = "passed" | "blocked";
type GapItemStatus =
  "passed" |
  "missing" |
  "invalid" |
  "blocked" |
  "failed" |
  "manual_required" |
  "dry_run_only" |
  "stale" |
  "identity_mismatch";

export interface ReleaseEvidenceGapReportOptions {
  packPath: string;
  maxEvidenceAgeHours?: number;
  replacements?: Record<string, string>;
  envReplacements?: Record<string, string>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface ReleaseEvidenceGapInput {
  kind: "file" | "env" | "operator_input";
  value: string;
  status: "missing" | "mismatch" | "operator_required";
  source: "command_arg" | "command_env";
  placeholder?: string;
  message: string;
}

export interface ReleaseEvidenceGapReportItem {
  id: string;
  title: string;
  kind: "evidence" | "final_bundle" | "final_check";
  required: boolean;
  status: GapItemStatus;
  outputPath: string;
  command: string;
  nextCommand?: string;
  requiresRealEnvironment: boolean;
  message: string;
  evidenceStatus?: string;
  checkedAt?: string;
  failedChecks: Array<{
    name: string;
    status: string;
    message?: string;
  }>;
  inputGaps: ReleaseEvidenceGapInput[];
  prerequisites: string[];
  notes: string[];
}

export interface ReleaseEvidenceGapReportResult {
  name: "siteflow-release-evidence-gap-report";
  status: ReportStatus;
  checkedAt: string;
  packPath: string;
  envReplacements: Array<{
    key: string;
    envName: string;
  }>;
  release: {
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    targetEnvironment: string | null;
  };
  summary: {
    total: number;
    passed: number;
    gaps: number;
    missing: number;
    invalid: number;
    blocked: number;
    failed: number;
    manualRequired: number;
    dryRunOnly: number;
    stale: number;
    identityMismatches: number;
    inputGaps: number;
  };
  items: ReleaseEvidenceGapReportItem[];
  blockedProductionClaims: string[];
  exitCode: number;
}

interface ParsedArgs {
  packPath?: string;
  maxEvidenceAgeHours: number;
  replacements: Record<string, string>;
  envReplacements: Record<string, string>;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface PackCommand {
  args?: unknown;
  display?: unknown;
  captureStdoutTo?: unknown;
  env?: unknown;
}

interface PackStep {
  id?: unknown;
  title?: unknown;
  required?: unknown;
  outputPath?: unknown;
  command?: PackCommand;
  prerequisites?: unknown;
  notes?: unknown;
}

interface FinalReleaseEvidenceCheckContext {
  expectedEvidencePath?: string;
  expectedBundleResult?: ReleaseEvidenceBundleResult;
  expectedBundleCheckedAt?: string;
  requiredAttestationKeyIdConfigured?: boolean;
}

const defaultMaxEvidenceAgeHours = 168;
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;
const sha256HexPattern = /^[a-f0-9]{64}$/i;
const inputFileFlags = new Set([
  "--env-file",
  "--backup-verify",
  "--restore-drill",
  "--backup-offload",
  "--backup-fetch",
  "--provider-security-audit",
  "--backup-provider-security-audit",
  "--backup-prune",
  "--backup-automation-run",
  "--backup-automation-history",
  "--backup-scheduler-ownership",
  "--policy",
  "--operator-evidence",
  "--evidence",
  "--release-gate",
  "--docker-build",
  "--postgres-rehearsal",
  "--artifact-evidence",
  "--release-artifact-evidence",
  "--release-image-evidence",
  "--target-runtime-evidence",
  "--source-provider-evidence",
  "--source-provenance-evidence",
  "--backup-evidence",
  "--observability-evidence",
  "--operator-access-evidence",
  "--non-session-credential-evidence",
  "--ingress-evidence",
  "--upgrade-rollback-evidence",
  "--deployment-artifact-manifest",
  "--deployment-detail"
]);
const checkedAtRequiredEvidenceIds = new Set([
  "release_gate",
  "release_artifact_evidence",
  "release_image_evidence",
  "source_provider_evidence",
  "target_runtime_evidence",
  "backup_evidence",
  "observability_evidence",
  "operator_access_evidence",
  "non_session_credential_evidence",
  "ingress_evidence",
  "upgrade_rollback_evidence",
  "release_evidence_check"
]);
const requiredPostgresRehearsalScopes = [
  "migration_advisory_lock",
  "migration_checksum_drift",
  "concurrent_migration_startup",
  "skip_locked_claim",
  "concurrent_worker_claim",
  "lease_heartbeat",
  "stale_lease_recovery",
  "exhausted_lease_failure"
];
const requiredDockerBuildCommands = ["npm ci", "npm run build"];
const requiredReleaseArtifactChecks = [...requiredReleaseArtifactCheckNames];
const requiredBackupEvidenceChecks = [...requiredOffHostBackupEvidenceCheckNames];
const requiredSourceProviderEvidenceChecks = [...requiredSourceProviderEvidenceCheckNames];
const requiredOperatorAccessEvidenceChecks = [...requiredOperatorAccessEvidenceCheckNames];
const requiredNonSessionCredentialEvidenceChecks = [...requiredNonSessionCredentialEvidenceCheckNames];
const requiredIngressEvidenceChecks = [...requiredIngressEvidenceCheckNames];
const requiredUpgradeRollbackEvidenceChecks = [...requiredUpgradeRollbackDrillEvidenceCheckNames];

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
  return strictIsoTimestampValue(value);
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

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function uniqueInputGaps(gaps: ReleaseEvidenceGapInput[]) {
  const seen = new Set<string>();
  const unique: ReleaseEvidenceGapInput[] = [];

  for (const gap of gaps) {
    const key = `${gap.kind}:${gap.source}:${gap.value}:${gap.placeholder ?? ""}:${gap.status}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(gap);
    }
  }

  return unique;
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

function isFresh(timestamp: string | undefined, now: Date, maxEvidenceAgeHours: number) {
  return Boolean(timestamp && ageHours(timestamp, now) >= 0 && ageHours(timestamp, now) <= maxEvidenceAgeHours);
}

function failedChecks(evidence: Record<string, unknown>) {
  const checks = evidence.checks;

  if (!Array.isArray(checks)) {
    return [];
  }

  return checks
    .filter((check) => isObject(check) && statusValue(check.status) !== "pass" && statusValue(check.status) !== "passed")
    .map((check) => {
      const rawMessage = stringValue(check.message);
      const sensitiveReasons = rawMessage ? sensitiveOutputReasons(rawMessage, { maxFindings: 5 }) : [];
      const message = rawMessage && sensitiveReasons.length > 0
        ? `[redacted: sensitive check message omitted; reasons: ${sensitiveReasons.join(", ")}]`
        : rawMessage;

      return {
        name: stringValue(check.name) ?? "unnamed_check",
        status: stringValue(check.status) ?? "unknown",
        ...(message ? { message } : {})
      };
    });
}

function uniqueFailedChecks(checks: ReturnType<typeof failedChecks>) {
  const seen = new Set<string>();
  const unique: ReturnType<typeof failedChecks> = [];

  for (const check of checks) {
    const key = `${check.name}:${check.status}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(check);
    }
  }

  return unique;
}

function releaseGatePromotion(evidence: Record<string, unknown>) {
  return nestedObject(evidence, "promotionEvidence") ?? evidence;
}

function evidenceTimestamp(evidence: Record<string, unknown>) {
  return timestampValue(evidence.checkedAt) ??
    timestampValue(evidence.completedAt) ??
    timestampValue(evidence.generatedAt) ??
    timestampValue(evidence.collectedAt) ??
    timestampValue(nestedValue(evidence, ["promotionEvidence", "checkedAt"]));
}

function evidenceCommit(evidence: Record<string, unknown>) {
  return stringValue(evidence.commitRef) ??
    stringValue(evidence.commitSha) ??
    stringValue(evidence.releaseCommit) ??
    stringValue(nestedValue(evidence, ["source", "commitRef"])) ??
    stringValue(nestedValue(evidence, ["release", "commitRef"])) ??
    stringValue(nestedValue(evidence, ["release", "commitSha"])) ??
    stringValue(nestedValue(evidence, ["promotionEvidence", "commitRef"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "releaseCommitRef"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "commitRef"]));
}

function evidenceRepository(evidence: Record<string, unknown>) {
  return stringValue(evidence.repository) ??
    stringValue(evidence.repo) ??
    stringValue(nestedValue(evidence, ["source", "repository"])) ??
    stringValue(nestedValue(evidence, ["release", "repository"])) ??
    stringValue(nestedValue(evidence, ["promotionEvidence", "repository"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "repository"]));
}

function evidenceBranch(evidence: Record<string, unknown>) {
  return stringValue(evidence.branch) ??
    stringValue(nestedValue(evidence, ["release", "branch"])) ??
    stringValue(nestedValue(evidence, ["promotionEvidence", "branch"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "branch"]));
}

function evidenceTargetEnvironment(evidence: Record<string, unknown>) {
  return stringValue(evidence.targetEnvironment) ??
    stringValue(nestedValue(evidence, ["release", "targetEnvironment"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "targetEnvironment"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "environment"]));
}

function requiredPrerequisitesPassed(evidence: Record<string, unknown>) {
  const prerequisites = evidence.prerequisites;

  if (!Array.isArray(prerequisites)) {
    return false;
  }

  return prerequisites.every((entry) => {
    if (!isObject(entry) || entry.required !== true) {
      return true;
    }

    return statusValue(entry.status) === "passed";
  });
}

function arrayMatchesStrings(candidate: unknown, expected: string[]) {
  return Array.isArray(candidate) &&
    candidate.length === expected.length &&
    expected.every((value, index) => candidate[index] === value);
}

function arrayIncludesAllStrings(candidate: unknown, required: string[]) {
  return Array.isArray(candidate) && required.every((value) => candidate.includes(value));
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

function runtimeIsolationIsAllowed(value: string | undefined) {
  return Boolean(value && allowedFunctionRuntimeIsolationValues.has(value));
}

function artifactManifestCandidates(evidence: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");

  return [
    nestedObject(evidence, "artifactManifest"),
    nestedObject(evidence, "deploymentArtifactManifest"),
    nestedObject(selectedEvidence, "artifactManifest"),
    nestedObject(selectedEvidence, "deploymentArtifactManifest")
  ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));
}

function releaseArtifactPathSafe(value: unknown) {
  const raw = stringValue(value);

  if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[a-z]:/i.test(raw)) {
    return false;
  }

  const segments = raw.split("/");

  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function releaseArtifactManifestEntriesPassed(
  manifest: Record<string, unknown> | undefined,
  selectedEvidence: Record<string, unknown> | undefined
) {
  const artifacts = manifest?.artifacts;
  const manifestChecksum = stringValue(manifest?.checksum);
  const selectedChecksum = stringValue(selectedEvidence?.checksum);

  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return false;
  }

  let totalBytes = 0;

  for (const artifact of artifacts) {
    if (!isObject(artifact) || !releaseArtifactPathSafe(artifact.path)) {
      return false;
    }

    const sizeBytes = artifact.sizeBytes;

    if (!Number.isSafeInteger(sizeBytes) || typeof sizeBytes !== "number" || sizeBytes <= 0) {
      return false;
    }

    if (!sha256HexPattern.test(stringValue(artifact.sha256) ?? "")) {
      return false;
    }

    totalBytes += sizeBytes;
  }

  return Number(selectedEvidence?.fileCount) === artifacts.length &&
    Number(selectedEvidence?.totalBytes) === totalBytes &&
    sha256DigestPattern.test(manifestChecksum ?? "") &&
    selectedChecksum === manifestChecksum;
}

function manifestDeclaresIsolatedFunctionRuntime(manifest: Record<string, unknown>) {
  const functionEntries = objectValues(manifest.functions);

  if (functionEntries.length === 0) {
    return true;
  }

  const manifestRuntimeIsolationValues = [
    manifest,
    nestedObject(manifest, "runtime"),
    nestedObject(manifest, "functionRuntime")
  ].map(runtimeIsolationValue);

  if (manifestRuntimeIsolationValues.includes("same_process")) {
    return false;
  }

  const manifestRuntimeIsolation = manifestRuntimeIsolationValues.find(Boolean);

  return functionEntries.every((entry) => {
    const entryRuntimeIsolation = runtimeIsolationValue(entry);

    if (entryRuntimeIsolation === "same_process") {
      return false;
    }

    return runtimeIsolationIsAllowed(entryRuntimeIsolation ?? manifestRuntimeIsolation);
  });
}

function artifactFunctionRuntimeIsolationPassed(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  if (evidenceTargetEnvironment(release) !== "production") {
    return true;
  }

  const manifests = artifactManifestCandidates(evidence);

  return manifests.length > 0 && manifests.every(manifestDeclaresIsolatedFunctionRuntime);
}

function postgresScenarioResultSummary(evidence: Record<string, unknown>) {
  const results = Array.isArray(evidence.scenarioResults) ? evidence.scenarioResults.filter(isObject) : [];
  const passedScopes = new Set(
    results
      .filter((result) => statusValue(result.status) === "passed")
      .map((result) => stringValue(result.scope))
      .filter((scope): scope is string => Boolean(scope))
  );
  const failedScopes = [
    ...new Set(
      results
        .filter((result) => statusValue(result.status) === "failed")
        .map((result) => stringValue(result.scope))
        .filter((scope): scope is string => Boolean(scope))
    )
  ].filter((scope) => requiredPostgresRehearsalScopes.includes(scope));
  const missingScopes = requiredPostgresRehearsalScopes.filter((scope) => !passedScopes.has(scope));

  return {
    present: Array.isArray(evidence.scenarioResults),
    passed: Array.isArray(evidence.scenarioResults) && missingScopes.length === 0 && failedScopes.length === 0,
    missingScopes,
    failedScopes
  };
}

function failedCheck(name: string, passed: boolean, message: string) {
  return passed ? [] : [{ name, status: "fail", message }];
}

function noSensitiveEvidenceValuesFailedCheck(evidence: Record<string, unknown>, label: string) {
  const findings = scanEvidenceForRawSecrets(evidence);

  return failedCheck(
    "no_sensitive_evidence_values",
    findings.length === 0,
    findings.length === 0
      ? `${label} evidence output must not include raw secret-like values.`
      : `${label} evidence output includes raw secret-like values: ${evidenceSecretFindingSummary(findings)}.`
  );
}

function finalEvidenceFailedChecks(evidence: Record<string, unknown>) {
  const status = statusValue(evidence.status);

  return [
    ...failedCheck(
      "not_template",
      evidence.template !== true,
      "Evidence output must be final target evidence, not a template skeleton."
    ),
    ...failedCheck(
      "non_dry_run",
      evidence.dryRun !== true,
      "Evidence output must not be dry-run output."
    ),
    ...failedCheck(
      "status_final",
      !status || !["blocked", "todo", "manual_required", "dry_run", "failed", "fail"].includes(status),
      "Evidence output must not have a blocked, failed, todo, manual_required, or dry_run status."
    )
  ];
}

function passedCheckNames(evidence: Record<string, unknown>) {
  const checks = evidence.checks;

  if (!Array.isArray(checks)) {
    return new Set<string>();
  }

  return new Set(
    checks
      .filter((check) => isObject(check) && statusValue(check.status) === "pass")
      .map((check) => stringValue(check.name))
      .filter((name): name is string => Boolean(name))
  );
}

function backupEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredBackupEvidenceChecks.filter((name) => !passedNames.has(name));
  const expectedCommitRef = stringValue(release.commitRef);
  const expectedRepository = stringValue(release.repository);
  const expectedBranch = stringValue(release.branch);
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "backup_name",
      evidence.name === "siteflow-backup-evidence-check",
      "Backup evidence output must be from siteflow-backup-evidence-check."
    ),
    ...failedCheck(
      "backup_release_identity",
      Boolean(
        expectedCommitRef &&
          expectedRepository &&
          expectedBranch &&
          evidenceCommit(evidence) === expectedCommitRef &&
          evidenceRepository(evidence) === expectedRepository &&
          evidenceBranch(evidence) === expectedBranch
      ),
      "Backup evidence output must be bound to the release commit, repository, and branch."
    ),
    ...failedCheck(
      "backup_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Backup evidence targetEnvironment must match the release targetEnvironment."
    ),
    ...failedCheck(
      "backup_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Backup evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "backup_off_host_required",
      nestedValue(evidence, ["thresholds", "requireOffHost"]) === true,
      "Backup evidence must have been checked with requireOffHost: true."
    ),
    ...failedCheck(
      "backup_selected_evidence",
      backupSelectedEvidencePassed(selectedEvidence),
      "Backup evidence output must include timestamped selected backup verify, restore-drill, offload, fetch, provider security audit, and non-dry-run prune summaries."
    ),
    ...failedCheck(
      "backup_offload_prune_checks",
      missingChecks.length === 0,
      `Backup evidence output must include passed offload and prune checks. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function releaseArtifactEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredReleaseArtifactChecks.filter((name) => !passedNames.has(name));
  const expectedCommitRef = stringValue(release.commitRef);
  const expectedRepository = stringValue(release.repository);
  const expectedBranch = stringValue(release.branch);
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "release_artifact_name",
      evidence.name === "siteflow-release-artifact-check",
      "Release artifact evidence output must be from siteflow-release-artifact-check."
    ),
    ...failedCheck(
      "release_artifact_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Release artifact evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "release_artifact_selected_evidence",
      Boolean(
        stringValue(nestedValue(selectedEvidence, ["commitRef"])) &&
          stringValue(nestedValue(selectedEvidence, ["repository"])) &&
          stringValue(nestedValue(selectedEvidence, ["branch"])) &&
          stringValue(nestedValue(selectedEvidence, ["targetEnvironment"])) &&
          Number(nestedValue(selectedEvidence, ["fileCount"])) > 0 &&
          Number(nestedValue(selectedEvidence, ["totalBytes"])) > 0 &&
          sha256DigestPattern.test(stringValue(nestedValue(selectedEvidence, ["checksum"])) ?? "") &&
          stringValue(nestedValue(selectedEvidence, ["packageBinSiteflow"]))
      ),
      "Release artifact evidence output must include selected release identity, file/byte counts, checksum, and CLI bin path."
    ),
    ...failedCheck(
      "release_artifact_dependency_audit",
      nestedValue(selectedEvidence, ["auditExitCode"]) === 0,
      "Release artifact evidence must include a successful production dependency audit; skipped audit evidence is not release evidence."
    ),
    ...failedCheck(
      "release_artifact_release_identity",
      Boolean(
        expectedCommitRef &&
          expectedRepository &&
          expectedBranch &&
          evidenceCommit(evidence) === expectedCommitRef &&
          evidenceRepository(evidence) === expectedRepository &&
          evidenceBranch(evidence) === expectedBranch
      ),
      "Release artifact evidence output must be bound to the release commit, repository, and branch."
    ),
    ...failedCheck(
      "release_artifact_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Release artifact evidence target environment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "release_artifact_manifest",
      nestedValue(evidence, ["manifest", "schemaVersion"]) === "siteflow.releaseArtifactManifest.v1" &&
        nestedValue(evidence, ["manifest", "name"]) === "siteflow-release-artifact-manifest" &&
        releaseArtifactManifestEntriesPassed(nestedObject(evidence, "manifest"), selectedEvidence),
      "Release artifact evidence must include a safe SHA-256 manifest whose file count, total bytes, and checksum match selected evidence."
    ),
    ...failedCheck(
      "release_artifact_function_runtime_isolation",
      artifactFunctionRuntimeIsolationPassed(evidence, release),
      "Release deployment artifact manifest must be attached, and any functions must declare isolated runtime isolation; missing, unknown, or same_process runtime isolation is blocked until isolated function runner evidence exists."
    ),
    ...failedCheck(
      "release_artifact_required_checks",
      missingChecks.length === 0,
      `Release artifact evidence output must include passed artifact checks. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function releaseImageDigest(evidence: Record<string, unknown>) {
  return stringValue(nestedValue(evidence, ["image", "digest"]));
}

function releaseImageName(evidence: Record<string, unknown>) {
  return stringValue(nestedValue(evidence, ["image", "name"]));
}

function releaseImageVersionTag(evidence: Record<string, unknown>) {
  return stringValue(nestedValue(evidence, ["image", "versionTag"]));
}

function releaseImageCommitTag(evidence: Record<string, unknown>) {
  return stringValue(nestedValue(evidence, ["image", "commitTag"]));
}

function releaseImageDigestPassed(evidence: Record<string, unknown>) {
  return sha256DigestPattern.test(releaseImageDigest(evidence) ?? "");
}

function releaseImageTagsPassed(evidence: Record<string, unknown>) {
  const imageName = releaseImageName(evidence);
  const versionTag = releaseImageVersionTag(evidence);
  const commitTag = releaseImageCommitTag(evidence);

  return Boolean(
    imageName &&
      versionTag &&
      commitTag &&
      versionTag.startsWith(`${imageName}:`) &&
      commitTag.startsWith(`${imageName}:`)
  );
}

function releaseImageAttestations(evidence: Record<string, unknown>) {
  return nestedObject(evidence, "attestations");
}

function releaseImageAttestationPredicate(evidence: Record<string, unknown>, name: "provenance" | "sbom") {
  return nestedObject(releaseImageAttestations(evidence), name);
}

function releaseImageAttestationSubjectPassed(evidence: Record<string, unknown>) {
  return Boolean(
    releaseImageDigestPassed(evidence) &&
      releaseImageDigest(evidence) === stringValue(nestedValue(evidence, ["attestations", "subjectDigest"]))
  );
}

function releaseImageProvenanceAttestationPassed(evidence: Record<string, unknown>) {
  const provenance = releaseImageAttestationPredicate(evidence, "provenance");
  const predicateType = stringValue(provenance?.predicateType);

  return Boolean(
    provenance?.requested === true &&
      provenance?.present === true &&
      predicateType &&
      predicateType.startsWith("https://slsa.dev/provenance/") &&
      sha256DigestPattern.test(stringValue(provenance?.manifestDigest) ?? "")
  );
}

function releaseImageSbomAttestationPassed(evidence: Record<string, unknown>) {
  const sbom = releaseImageAttestationPredicate(evidence, "sbom");
  const predicateType = stringValue(sbom?.predicateType);

  return Boolean(
    sbom?.requested === true &&
      sbom?.present === true &&
      predicateType &&
      (predicateType.startsWith("https://spdx.dev/") || predicateType.startsWith("https://cyclonedx.org/")) &&
      sha256DigestPattern.test(stringValue(sbom?.manifestDigest) ?? "")
  );
}

function releaseImageAttestationInspectionPassed(
  evidence: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number
) {
  const attestations = releaseImageAttestations(evidence);

  return Boolean(
    stringValue(attestations?.mode) === "registry" &&
      stringValue(attestations?.inspector) &&
      isFresh(timestampValue(attestations?.inspectedAt), now, maxEvidenceAgeHours)
  );
}

function releaseImageEvidenceFailedChecks(
  evidence: Record<string, unknown>,
  release: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number
) {
  const expectedCommitRef = stringValue(release.commitRef);
  const expectedRepository = stringValue(release.repository);

  return [
    ...failedCheck(
      "release_image_schema",
      evidence.schemaVersion === "siteflow.releaseImageEvidence.v1" &&
        evidence.name === "siteflow-release-image-evidence",
      "Release image evidence must use the siteflow.releaseImageEvidence.v1 schema and name."
    ),
    ...failedCheck(
      "release_image_source_identity",
      Boolean(
        expectedCommitRef &&
          expectedRepository &&
          evidenceCommit(evidence) === expectedCommitRef &&
          evidenceRepository(evidence) === expectedRepository
      ),
      "Release image evidence source repository and commit must match the rehearsal pack release identity."
    ),
    ...failedCheck(
      "release_image_digest",
      releaseImageDigestPassed(evidence),
      "Release image evidence must include a sha256:<64 hex> image digest."
    ),
    ...failedCheck(
      "release_image_tags",
      releaseImageTagsPassed(evidence),
      "Release image evidence must include image name, version tag, and commit tag for that image."
    ),
    ...failedCheck(
      "release_image_commit_tag",
      Boolean(expectedCommitRef && releaseImageCommitTag(evidence)?.endsWith(`:sha-${expectedCommitRef}`)),
      "Release image evidence commit tag must be bound to the release commit."
    ),
    ...failedCheck(
      "release_image_github_run",
      Boolean(
        stringValue(nestedValue(evidence, ["github", "runId"])) &&
          stringValue(nestedValue(evidence, ["github", "runAttempt"]))
      ),
      "Release image evidence must include GitHub run id and attempt metadata."
    ),
    ...failedCheck(
      "release_image_attestation_subject",
      releaseImageAttestationSubjectPassed(evidence),
      "Release image attestation evidence must be inspected from the registry and bound to the published image digest."
    ),
    ...failedCheck(
      "release_image_provenance_attestation",
      releaseImageProvenanceAttestationPassed(evidence),
      "Release image evidence must include a present SLSA provenance attestation manifest digest."
    ),
    ...failedCheck(
      "release_image_sbom_attestation",
      releaseImageSbomAttestationPassed(evidence),
      "Release image evidence must include a present SPDX or CycloneDX SBOM attestation manifest digest."
    ),
    ...failedCheck(
      "release_image_attestation_inspection",
      releaseImageAttestationInspectionPassed(evidence, now, maxEvidenceAgeHours),
      `Release image attestation evidence must include fresh registry inspection metadata no older than ${maxEvidenceAgeHours} hours.`
    )
  ];
}

function releaseImageEvidencePassed(
  evidence: Record<string, unknown>,
  release: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number
) {
  return releaseImageEvidenceFailedChecks(evidence, release, now, maxEvidenceAgeHours).length === 0;
}

function sourceProviderEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredSourceProviderEvidenceChecks.filter((name) => !passedNames.has(name));
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "source_provider_name",
      evidence.name === "siteflow-source-provider-evidence-check",
      "Source provider evidence output must be from siteflow-source-provider-evidence-check."
    ),
    ...noSensitiveEvidenceValuesFailedCheck(evidence, "Source provider"),
    ...failedCheck(
      "source_provider_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Source provider evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "source_provider_selected_evidence",
      sourceProviderSelectedEvidencePassed(selectedEvidence, release),
      "Source provider evidence output must include selected environment, release identity, provider, and timestamped checkout, signed webhook, deploy-key, host-key, and provenance summaries."
    ),
    ...failedCheck(
      "source_provider_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Source provider evidence target environment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "source_provider_required_checks",
      missingChecks.length === 0,
      `Source provider evidence output must include passed checks for provider support, repository binding, exact checkout, signed webhook, credential hygiene, deploy key, host key, provenance, operator, and ticket evidence. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function targetRuntimeEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredTargetRuntimeEvidenceCheckNames.filter((name) => !passedNames.has(name));

  return [
    ...failedCheck(
      "target_runtime_name",
      evidence.name === "siteflow-target-runtime-evidence-check",
      "Target runtime evidence output must be from siteflow-target-runtime-evidence-check."
    ),
    ...failedCheck(
      "target_runtime_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Target runtime evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "target_runtime_selected_evidence",
      Boolean(
        stringValue(nestedValue(selectedEvidence, ["targetEnvironment"])) &&
          stringValue(nestedValue(selectedEvidence, ["publicBaseUrl"])) &&
          stringValue(nestedValue(selectedEvidence, ["commitRef"])) &&
          stringValue(nestedValue(selectedEvidence, ["repository"])) &&
          stringValue(nestedValue(selectedEvidence, ["branch"])) &&
          selectedEvidenceSummaryPassed(selectedEvidence, "targetIdentity") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "composeConfig") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "workerRuntimePosture") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "startup") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "serviceHealth") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "readiness") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "imageBinding") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "restartSmoke") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "logSanity")
      ),
      "Target runtime evidence output must include selected target, release, and timestamped summaries for target identity, Compose config, worker runtime posture, startup, service health, readiness, image binding, restart smoke, and log sanity evidence."
    ),
    ...failedCheck(
      "target_runtime_release_identity",
      Boolean(
        evidenceCommit(evidence) === stringValue(release.commitRef) &&
          evidenceRepository(evidence) === stringValue(release.repository) &&
          evidenceBranch(evidence) === stringValue(release.branch)
      ),
      "Target runtime evidence release identity must match the rehearsal pack release."
    ),
    ...failedCheck(
      "target_runtime_target_environment",
      Boolean(stringValue(release.targetEnvironment) && evidenceTargetEnvironment(evidence) === stringValue(release.targetEnvironment)),
      "Target runtime evidence targetEnvironment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "target_runtime_required_checks",
      missingChecks.length === 0,
      `Target runtime evidence output must include all required passed checks. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function selectedEvidenceSummaryPassed(selectedEvidence: Record<string, unknown> | undefined, key: string) {
  const summary = nestedObject(selectedEvidence, key);

  return Boolean(
    summary &&
      defaultSelectedEvidenceSummaryStatuses.has(statusValue(summary.status) ?? "") &&
      timestampValue(summary.timestamp)
  );
}

const defaultSelectedEvidenceSummaryStatuses = new Set(["pass", "passed", "completed", "ok", "healthy", "scraped", "applied", "delivered", "available"]);
const revokedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "revoked"]);
const enforcedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "enforced"]);
const blockedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "blocked"]);
const limitedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "limited"]);
const verifiedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "verified"]);
const restoredSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "restored", "restore_drilled"]);
const offloadedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "offloaded"]);
const fetchedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "fetched"]);
const prunedSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "pruned"]);
const notRequiredSelectedEvidenceSummaryStatuses = new Set([...defaultSelectedEvidenceSummaryStatuses, "not_required"]);

function selectedEvidenceSummaryMatches(
  selectedEvidence: Record<string, unknown> | undefined,
  key: string,
  allowedStatuses: ReadonlySet<string> = defaultSelectedEvidenceSummaryStatuses
) {
  const summary = nestedObject(selectedEvidence, key);

  return Boolean(
    summary &&
      allowedStatuses.has(statusValue(summary.status) ?? "") &&
      timestampValue(summary.timestamp)
  );
}

function operatorAccessSelectedEvidencePassed(selectedEvidence: Record<string, unknown> | undefined) {
  return selectedEvidenceSummaryMatches(selectedEvidence, "sessionCreate") &&
    selectedEvidenceSummaryMatches(selectedEvidence, "projectScope") &&
    selectedEvidenceSummaryMatches(selectedEvidence, "sessionRotation") &&
    selectedEvidenceSummaryMatches(selectedEvidence, "sessionRevoke", revokedSelectedEvidenceSummaryStatuses) &&
    selectedEvidenceSummaryMatches(selectedEvidence, "csrf", enforcedSelectedEvidenceSummaryStatuses) &&
    selectedEvidenceSummaryMatches(selectedEvidence, "bearerPrecedence") &&
    selectedEvidenceSummaryMatches(selectedEvidence, "actorAttribution") &&
    selectedEvidenceSummaryMatches(selectedEvidence, "browserTokenFallback") &&
    selectedEvidenceSummaryMatches(selectedEvidence, "emergencyCutoff");
}

function nonSessionCredentialSelectedEvidencePassed(selectedEvidence: Record<string, unknown> | undefined) {
  const credentialTypes = nestedValue(selectedEvidence, ["credentialTypes"]);

  return Boolean(
    Array.isArray(credentialTypes) &&
      credentialTypes.length > 0 &&
      credentialTypes.every((entry) => typeof entry === "string" && entry.trim()) &&
      Number.isInteger(Number(nestedValue(selectedEvidence, ["credentialCount"]))) &&
      Number(nestedValue(selectedEvidence, ["credentialCount"])) > 0 &&
      selectedEvidenceSummaryMatches(selectedEvidence, "breakGlass")
  );
}

function ingressSelectedEvidencePassed(selectedEvidence: Record<string, unknown> | undefined) {
  return selectedEvidenceSummaryMatches(selectedEvidence, "directApiPort", blockedSelectedEvidenceSummaryStatuses) &&
    selectedEvidenceSummaryMatches(selectedEvidence, "forwardedHeaders") &&
    selectedEvidenceSummaryMatches(selectedEvidence, "apiRateLimit", limitedSelectedEvidenceSummaryStatuses) &&
    selectedEvidenceSummaryMatches(selectedEvidence, "unthrottledRoutes");
}

function backupSelectedEvidencePassed(selectedEvidence: Record<string, unknown> | undefined) {
  const backupVerify = nestedObject(selectedEvidence, "backupVerify");
  const restoreDrill = nestedObject(selectedEvidence, "restoreDrill");
  const backupOffload = nestedObject(selectedEvidence, "backupOffload");
  const backupFetch = nestedObject(selectedEvidence, "backupFetch");
  const backupPrune = nestedObject(selectedEvidence, "backupPrune");
  const offloadLocation = stringValue(backupOffload?.offHostLocation);
  const fetchLocation = stringValue(backupFetch?.offHostLocation);
  const offloadTreeSha256 = stringValue(backupOffload?.treeSha256);
  const fetchTreeSha256 = stringValue(backupFetch?.treeSha256);
  const offloadObjectCount = Number(backupOffload?.objectCount);
  const fetchObjectCount = Number(backupFetch?.objectCount);
  const offloadTotalBytes = Number(backupOffload?.totalBytes);
  const fetchTotalBytes = Number(backupFetch?.totalBytes);

  return Boolean(
    selectedEvidenceSummaryMatches(selectedEvidence, "backupVerify", verifiedSelectedEvidenceSummaryStatuses) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "restoreDrill", restoredSelectedEvidenceSummaryStatuses) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "backupOffload", offloadedSelectedEvidenceSummaryStatuses) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "backupFetch", fetchedSelectedEvidenceSummaryStatuses) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "backupProviderSecurityAudit") &&
      selectedEvidenceSummaryMatches(selectedEvidence, "backupPrune", prunedSelectedEvidenceSummaryStatuses) &&
      stringValue(backupVerify?.backupPath) &&
      stringValue(backupVerify?.offHostLocation) &&
      stringValue(backupVerify?.provider) &&
      restoreDrill?.restoreDrill === true &&
      stringValue(restoreDrill?.backupPath) &&
      stringValue(restoreDrill?.backupPath) === stringValue(backupFetch?.backupPath) &&
      offloadLocation &&
      stringValue(backupOffload?.provider) &&
      backupOffload?.encrypted === true &&
      backupOffload?.providerKmsProof === true &&
      backupOffload?.providerRetentionProof === true &&
      Number(backupOffload?.providerRetentionDays) > 0 &&
      stringValue(backupOffload?.providerRetentionMode) &&
      stringValue(backupOffload?.retentionContract) &&
      stringValue(backupFetch?.backupPath) &&
      fetchLocation &&
      fetchLocation === offloadLocation &&
      stringValue(backupFetch?.provider) === stringValue(backupOffload?.provider) &&
      sha256HexPattern.test(offloadTreeSha256 ?? "") &&
      offloadTreeSha256 === fetchTreeSha256 &&
      Number.isInteger(offloadObjectCount) &&
      offloadObjectCount > 0 &&
      offloadObjectCount === fetchObjectCount &&
      Number.isFinite(offloadTotalBytes) &&
      offloadTotalBytes > 0 &&
      offloadTotalBytes === fetchTotalBytes &&
      backupPrune?.dryRun === false
  );
}

function sourceProviderSelectedEvidencePassed(
  selectedEvidence: Record<string, unknown> | undefined,
  release: Record<string, unknown>
) {
  const checkout = nestedObject(selectedEvidence, "checkout");
  const signedWebhook = nestedObject(selectedEvidence, "signedWebhook");
  const deployKey = nestedObject(selectedEvidence, "deployKey");
  const hostKey = nestedObject(selectedEvidence, "hostKey");
  const releaseProvenance = nestedObject(selectedEvidence, "releaseProvenance");
  const releaseCommitRef = stringValue(release.commitRef);
  const repository = stringValue(release.repository);
  const branch = stringValue(release.branch);

  return Boolean(
    stringValue(selectedEvidence?.environment) &&
      stringValue(selectedEvidence?.commitRef) === releaseCommitRef &&
      stringValue(selectedEvidence?.repository) === repository &&
      stringValue(selectedEvidence?.branch) === branch &&
      stringValue(selectedEvidence?.provider) &&
      stringValue(selectedEvidence?.webhookDeliveryId) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "checkout") &&
      (stringValue(checkout?.commitRef) === releaseCommitRef || stringValue(checkout?.headSha) === releaseCommitRef) &&
      checkout?.exactCommitVerified === true &&
      selectedEvidenceSummaryMatches(selectedEvidence, "signedWebhook") &&
      stringValue(signedWebhook?.deliveryId) === stringValue(selectedEvidence?.webhookDeliveryId) &&
      signedWebhook?.signatureVerified === true &&
      selectedEvidenceSummaryMatches(selectedEvidence, "deployKey", notRequiredSelectedEvidenceSummaryStatuses) &&
      (statusValue(deployKey?.status) === "not_required" || deployKey?.mounted === true) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "hostKey", notRequiredSelectedEvidenceSummaryStatuses) &&
      (statusValue(hostKey?.status) === "not_required" || hostKey?.pinned === true) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "releaseProvenance") &&
      stringValue(releaseProvenance?.commitRef) === releaseCommitRef &&
      stringValue(releaseProvenance?.repository) === repository &&
      stringValue(releaseProvenance?.branch) === branch
  );
}

function upgradeRollbackSelectedEvidencePassed(
  selectedEvidence: Record<string, unknown> | undefined,
  release: Record<string, unknown>
) {
  const fromVersion = stringValue(selectedEvidence?.fromVersion);
  const toVersion = stringValue(selectedEvidence?.toVersion);
  const rollbackVersion = stringValue(selectedEvidence?.rollbackVersion);
  const upgradeOperationId = stringValue(selectedEvidence?.upgradeOperationId);
  const rollbackOperationId = stringValue(selectedEvidence?.rollbackOperationId);

  return Boolean(
    stringValue(selectedEvidence?.commitRef) === stringValue(release.commitRef) &&
      stringValue(selectedEvidence?.repository) === stringValue(release.repository) &&
      stringValue(selectedEvidence?.branch) === stringValue(release.branch) &&
      stringValue(selectedEvidence?.targetEnvironment) === stringValue(release.targetEnvironment) &&
      fromVersion &&
      toVersion &&
      fromVersion !== toVersion &&
      rollbackVersion === fromVersion &&
      upgradeOperationId &&
      rollbackOperationId &&
      upgradeOperationId !== rollbackOperationId &&
      selectedEvidenceSummaryMatches(selectedEvidence, "backupEvidence") &&
      selectedEvidenceSummaryMatches(selectedEvidence, "routeUpgrade") &&
      selectedEvidenceSummaryMatches(selectedEvidence, "routeRollback") &&
      selectedEvidenceSummaryMatches(selectedEvidence, "readiness") &&
      selectedEvidenceSummaryMatches(selectedEvidence, "observability")
  );
}

function observabilityEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredObservabilityEvidenceCheckNames.filter((name) => !passedNames.has(name));
  const expectedCommitRef = stringValue(release.commitRef);
  const expectedRepository = stringValue(release.repository);
  const expectedBranch = stringValue(release.branch);
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "observability_name",
      evidence.name === "siteflow-observability-evidence-check",
      "Observability evidence output must be from siteflow-observability-evidence-check."
    ),
    ...noSensitiveEvidenceValuesFailedCheck(evidence, "Observability"),
    ...failedCheck(
      "observability_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Observability evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "observability_selected_evidence",
      Boolean(
        selectedEvidenceSummaryPassed(selectedEvidence, "readinessProbe") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "metricsScrape") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "backupAutomationRun") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "backupAutomationRunHistory") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "backupSchedulerOwnership") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "observabilityApplyProof") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "observabilityTargetStackProof") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "alertDelivery") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "dashboard") &&
          selectedEvidenceSummaryPassed(selectedEvidence, "logPipeline")
      ),
      "Observability evidence output must include selected readiness, metrics, backup automation, backup history, backup scheduler ownership, apply proof, target-stack proof, alert, dashboard, and log pipeline summaries with status and timestamp."
    ),
    ...failedCheck(
      "observability_release_identity",
      Boolean(
        expectedCommitRef &&
          expectedRepository &&
          expectedBranch &&
          evidenceCommit(evidence) === expectedCommitRef &&
          evidenceRepository(evidence) === expectedRepository &&
          evidenceBranch(evidence) === expectedBranch
      ),
      "Observability evidence output must be bound to the release commit, repository, and branch."
    ),
    ...failedCheck(
      "observability_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Observability evidence targetEnvironment must match the release targetEnvironment."
    ),
    ...failedCheck(
      "observability_required_checks",
      missingChecks.length === 0,
      `Observability evidence output must include passed release identity, target environment, readiness, metrics, backup automation history, scheduler ownership, apply proof, target-stack proof, alert, dashboard, and log redaction checks. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function operatorAccessEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredOperatorAccessEvidenceChecks.filter((name) => !passedNames.has(name));
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "operator_access_name",
      evidence.name === "siteflow-operator-access-evidence-check",
      "Operator access evidence output must be from siteflow-operator-access-evidence-check."
    ),
    ...noSensitiveEvidenceValuesFailedCheck(evidence, "Operator access"),
    ...failedCheck(
      "operator_access_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Operator access evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "operator_access_selected_evidence",
      Boolean(
        stringValue(nestedValue(selectedEvidence, ["environment"])) &&
          stringValue(nestedValue(selectedEvidence, ["publicBaseUrl"])) &&
        stringValue(nestedValue(selectedEvidence, ["commitRef"])) &&
          stringValue(nestedValue(selectedEvidence, ["repository"])) &&
          stringValue(nestedValue(selectedEvidence, ["branch"])) &&
          operatorAccessSelectedEvidencePassed(selectedEvidence)
      ),
      "Operator access evidence output must include selected environment/release identity and passed timestamped session, scope, CSRF, bearer precedence, actor, browser token fallback, and emergency cutoff summaries."
    ),
    ...failedCheck(
      "operator_access_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Operator access evidence target environment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "operator_access_required_checks",
      missingChecks.length === 0,
      `Operator access evidence output must include passed checks for session creation, rotation, CSRF, bearer precedence, actor attribution, emergency cutoff, negative evidence, redaction, operator, and ticket evidence. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function nonSessionCredentialEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredNonSessionCredentialEvidenceChecks.filter((name) => !passedNames.has(name));
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "non_session_credential_name",
      evidence.name === "siteflow-non-session-credential-evidence-check",
      "Non-session credential evidence output must be from siteflow-non-session-credential-evidence-check."
    ),
    ...noSensitiveEvidenceValuesFailedCheck(evidence, "Non-session credential"),
    ...failedCheck(
      "non_session_credential_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Non-session credential evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "non_session_credential_selected_evidence",
      Boolean(
        stringValue(nestedValue(selectedEvidence, ["environment"])) &&
          stringValue(nestedValue(selectedEvidence, ["commitRef"])) &&
          stringValue(nestedValue(selectedEvidence, ["repository"])) &&
          stringValue(nestedValue(selectedEvidence, ["branch"])) &&
          nonSessionCredentialSelectedEvidencePassed(selectedEvidence)
      ),
      "Non-session credential evidence output must include selected environment/release identity, credential inventory, and passed timestamped break-glass summary."
    ),
    ...failedCheck(
      "non_session_credential_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Non-session credential evidence target environment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "non_session_credential_required_checks",
      missingChecks.length === 0,
      `Non-session credential evidence output must include passed checks for credential inventory, rotation/cutover, redaction, break-glass, non-automation, operator, and ticket evidence. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function ingressEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredIngressEvidenceChecks.filter((name) => !passedNames.has(name));
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);
  const topologyRateLimit = ingressTopologyRateLimitEvidencePassed(evidence);

  return [
    ...failedCheck(
      "ingress_name",
      evidence.name === "siteflow-ingress-evidence-check",
      "Ingress evidence output must be from siteflow-ingress-evidence-check."
    ),
    ...noSensitiveEvidenceValuesFailedCheck(evidence, "Ingress"),
    ...failedCheck(
      "ingress_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Ingress evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "ingress_selected_evidence",
      Boolean(
        stringValue(nestedValue(selectedEvidence, ["environment"])) &&
          stringValue(nestedValue(selectedEvidence, ["publicBaseUrl"])) &&
          stringValue(nestedValue(selectedEvidence, ["commitRef"])) &&
          stringValue(nestedValue(selectedEvidence, ["repository"])) &&
          stringValue(nestedValue(selectedEvidence, ["branch"])) &&
          stringValue(nestedValue(selectedEvidence, ["trustProxyPolicy"])) &&
          ingressSelectedEvidencePassed(selectedEvidence)
      ),
      "Ingress evidence output must include selected environment/release identity and passed timestamped trust proxy, direct API, forwarded header, rate limit, and unthrottled route summaries."
    ),
    ...failedCheck(
      "ingress_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Ingress evidence target environment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "ingress_required_checks",
      missingChecks.length === 0,
      `Ingress evidence output must include passed checks for target binding, direct API blocking, forwarded headers, proxy source policy, rate limiting, unthrottled routes, operator, and ticket evidence. Missing: ${missingChecks.join(", ") || "none"}.`
    ),
    ...failedCheck(
      "ingress_deployment_topology",
      topologyRateLimit.topologyDeclared,
      "Ingress evidence selectedEvidence must declare deploymentTopology/topology with API instance/process and ingress counts or explicit multi-* flags."
    ),
    ...failedCheck(
      "ingress_rate_limit_topology",
      topologyRateLimit.passed,
      "Multi-instance, multi-process, or multi-ingress production topology must prove API rate limiting is edge-enforced or shared across instances; process-local-only limiting is not sufficient."
    )
  ];
}

function upgradeRollbackEvidenceFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const selectedEvidence = nestedObject(evidence, "selectedEvidence");
  const passedNames = passedCheckNames(evidence);
  const missingChecks = requiredUpgradeRollbackEvidenceChecks.filter((name) => !passedNames.has(name));
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "upgrade_rollback_name",
      evidence.name === "siteflow-upgrade-rollback-drill-evidence-check",
      "Upgrade/rollback drill evidence output must be from siteflow-upgrade-rollback-drill-evidence-check."
    ),
    ...noSensitiveEvidenceValuesFailedCheck(evidence, "Upgrade/rollback drill"),
    ...failedCheck(
      "upgrade_rollback_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Upgrade/rollback drill evidence checker output must be passed with all checks passing."
    ),
    ...failedCheck(
      "upgrade_rollback_selected_evidence",
      upgradeRollbackSelectedEvidencePassed(selectedEvidence, release),
      "Upgrade/rollback drill evidence output must include selected target environment, version pair, distinct operation ids, and timestamped backup, route, readiness, and observability summaries."
    ),
    ...failedCheck(
      "upgrade_rollback_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Upgrade/rollback drill evidence targetEnvironment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "upgrade_rollback_required_checks",
      missingChecks.length === 0,
      `Upgrade/rollback drill evidence output must include passed checks for target binding, operation order, backup, route, readiness, observability, operator, and ticket evidence. Missing: ${missingChecks.join(", ") || "none"}.`
    )
  ];
}

function dockerBuildFailedChecks(evidence: Record<string, unknown>) {
  const docker = nestedObject(evidence, "docker");
  const artifactLimits = nestedObject(evidence, "artifactLimits");
  const artifactFileCount = nestedValue(evidence, ["artifact", "fileCount"]);
  const artifactTotalBytes = nestedValue(evidence, ["artifact", "totalBytes"]);

  return [
    ...failedCheck(
      "docker_build_rehearsal_passed",
      statusValue(evidence.status) === "passed" && evidence.dryRun === false && evidence.exitCode === 0,
      "Docker build rehearsal evidence must be a non-dry-run passed rehearsal."
    ),
    ...failedCheck(
      "docker_build_rehearsal_prerequisites",
      requiredPrerequisitesPassed(evidence),
      "Required Docker build rehearsal prerequisites must have passed."
    ),
    ...failedCheck(
      "docker_build_rehearsal_release_identity",
      Boolean(evidenceCommit(evidence) && evidenceRepository(evidence) && evidenceBranch(evidence)),
      "Docker build rehearsal evidence must be bound to the release commit, repository, and branch."
    ),
    ...failedCheck(
      "docker_build_rehearsal_profile",
      Boolean(
        evidence.name === "siteflow-docker-build-rehearsal" &&
          evidence.buildRunner === "docker" &&
          requiredPrerequisitesPassed(evidence) &&
          stringValue(docker?.image) &&
          (
            docker?.imageDigestPinned === true ||
            (docker?.imageAllowedByAllowlist === true && docker?.imageTaggedTrustedExceptionAccepted === true)
          ) &&
          docker?.network === "none" &&
          stringValue(docker?.memory) &&
          stringValue(docker?.cpus) &&
          typeof docker?.pidsLimit === "number" &&
          Number(docker.pidsLimit) > 0 &&
          typeof artifactLimits?.maxArtifactBytes === "number" &&
          Number(artifactLimits.maxArtifactBytes) > 0 &&
          typeof artifactLimits?.maxArtifactFiles === "number" &&
          Number(artifactLimits.maxArtifactFiles) > 0 &&
          stringValue(docker?.dockerVersion) &&
          docker?.dockerInfoAvailable === true
      ),
      "Docker build rehearsal evidence must prove Docker runner profile, daemon availability, image policy, network, and resource limits."
    ),
    ...failedCheck(
      "docker_build_rehearsal_commands",
      arrayMatchesStrings(evidence.buildCommands, requiredDockerBuildCommands),
      "Docker build rehearsal evidence must run npm ci and npm run build in order."
    ),
    ...failedCheck(
      "docker_build_rehearsal_artifact",
      Boolean(
        stringValue(nestedValue(evidence, ["artifact", "entrypoint"])) &&
          typeof artifactFileCount === "number" &&
          Number(artifactFileCount) > 0 &&
          typeof artifactTotalBytes === "number" &&
          Number(artifactTotalBytes) > 0 &&
          typeof artifactLimits?.maxArtifactFiles === "number" &&
          Number(artifactLimits.maxArtifactFiles) > 0 &&
          Number(artifactFileCount) <= Number(artifactLimits.maxArtifactFiles) &&
          typeof artifactLimits?.maxArtifactBytes === "number" &&
          Number(artifactLimits.maxArtifactBytes) > 0 &&
          Number(artifactTotalBytes) <= Number(artifactLimits.maxArtifactBytes) &&
          stringValue(nestedValue(evidence, ["artifact", "checksum"])) &&
          evidence.redactionVerified === true
      ),
      "Docker build rehearsal evidence must include artifact checksum/bytes within configured limits and verified log redaction."
    )
  ];
}

function releaseGateFailedChecks(evidence: Record<string, unknown>) {
  const promotion = nestedObject(evidence, "promotionEvidence");
  const runtimeEnv = nestedObject(promotion, "runtimeEnv");
  const protectedBranchCommit = nestedObject(promotion, "protectedBranchCommit");
  const releaseCommit = stringValue(promotion?.commitRef);
  const topStatus = statusValue(evidence.status);
  const gateStatus = statusValue(promotion?.gateStatus);
  const manualRequired = statusValue(promotion?.manualRequired) === "true" ||
    promotion?.manualRequired === true ||
    Array.isArray(promotion?.manualRequiredCheckIds) && promotion.manualRequiredCheckIds.length > 0;

  return [
    ...failedCheck(
      "release_gate_passed",
      (topStatus === "pass" || topStatus === "passed") && gateStatus === "pass",
      "Release gate evidence must have top-level pass/passed status and promotionEvidence.gateStatus: pass."
    ),
    ...failedCheck(
      "release_gate_promotion_mode",
      promotion?.promotion === true,
      "Release gate evidence must be collected with promotion: true."
    ),
    ...failedCheck(
      "release_gate_no_manual_required",
      !manualRequired,
      "Release gate evidence must not contain manual_required checks."
    ),
    ...failedCheck(
      "release_gate_protected_branch_commit",
      statusValue(protectedBranchCommit?.status) === "pass" &&
        stringValue(protectedBranchCommit?.commitRef) === releaseCommit &&
        stringValue(protectedBranchCommit?.branchHeadSha) === releaseCommit,
      "Release gate evidence must prove the release commit is the current protected branch head."
    ),
    ...failedCheck(
      "release_gate_browser_token_fallback",
      statusValue(runtimeEnv?.browserTokenFallbackStatus) === "pass" &&
        runtimeEnv?.browserTokenFallbackEnabled === false,
      "Release gate promotion runtime evidence must show production browser token storage fallback is disabled."
    ),
    ...failedCheck(
      "release_gate_build_storage_preflight",
      statusValue(runtimeEnv?.buildMinFreeBytesStatus) === "pass" &&
        typeof runtimeEnv?.buildMinFreeBytes === "number" &&
        Number.isSafeInteger(runtimeEnv.buildMinFreeBytes) &&
        runtimeEnv.buildMinFreeBytes > 0,
      "Release gate promotion runtime evidence must include a positive SITEFLOW_BUILD_MIN_FREE_BYTES storage preflight threshold."
    ),
    ...failedCheck(
      "release_gate_worker_socket_posture",
      statusValue(runtimeEnv?.workerUserStatus) === "pass" &&
        Boolean(stringValue(runtimeEnv?.workerUser)) &&
        stringValue(runtimeEnv?.workerUser)?.split(":")[0] !== "0" &&
        statusValue(runtimeEnv?.dockerSocketGidStatus) === "pass" &&
        typeof runtimeEnv?.dockerSocketGid === "number" &&
        Number.isSafeInteger(runtimeEnv.dockerSocketGid) &&
        runtimeEnv.dockerSocketGid >= 0,
      "Release gate promotion runtime evidence must include non-root SITEFLOW_WORKER_USER and explicit SITEFLOW_DOCKER_SOCKET_GID posture."
    )
  ];
}

function postgresRehearsalFailedChecks(evidence: Record<string, unknown>, release: Record<string, unknown>) {
  const targetDatabase = nestedObject(evidence, "targetDatabase");
  const missingScopes = requiredPostgresRehearsalScopes.filter((scope) => !stringArray(evidence.rehearsalScope).includes(scope));
  const scenarioSummary = postgresScenarioResultSummary(evidence);
  const expectedTargetEnvironment = stringValue(release.targetEnvironment);

  return [
    ...failedCheck(
      "postgres_passed",
      statusValue(evidence.status) === "passed" && evidence.dryRun === false && evidence.exitCode === 0,
      "Postgres rehearsal evidence must be a non-dry-run passed rehearsal."
    ),
    ...failedCheck(
      "postgres_prerequisites",
      requiredPrerequisitesPassed(evidence),
      "Required Postgres rehearsal prerequisites must have passed."
    ),
    ...failedCheck(
      "postgres_release_identity",
      Boolean(evidenceCommit(evidence) && evidenceRepository(evidence) && evidenceBranch(evidence)),
      "Postgres rehearsal evidence must be bound to the release commit, repository, and branch."
    ),
    ...failedCheck(
      "postgres_target_environment",
      Boolean(expectedTargetEnvironment && evidenceTargetEnvironment(evidence) === expectedTargetEnvironment),
      "Postgres rehearsal evidence targetEnvironment must match the rehearsal pack release targetEnvironment."
    ),
    ...failedCheck(
      "postgres_target_database",
      Boolean(
        statusValue(targetDatabase?.parseStatus) === "passed" &&
          stringValue(targetDatabase?.redactedUrl) &&
          !stringValue(targetDatabase?.redactedUrl)?.includes("@") &&
          stringValue(targetDatabase?.host) &&
          stringValue(targetDatabase?.database)
      ),
      "Postgres rehearsal evidence must include redacted target database metadata without URL credentials."
    ),
    ...failedCheck(
      "postgres_rehearsal_scope",
      arrayIncludesAllStrings(evidence.rehearsalScope, requiredPostgresRehearsalScopes),
      `Postgres rehearsal evidence must include all required migration and queue scopes. Missing: ${missingScopes.join(", ") || "none"}.`
    ),
    ...failedCheck(
      "postgres_scenario_results",
      scenarioSummary.passed,
      `Postgres rehearsal evidence must include passed scenarioResults for every required scope. Missing: ${scenarioSummary.missingScopes.join(", ") || "none"}. Failed: ${scenarioSummary.failedScopes.join(", ") || "none"}.`
    )
  ];
}

function finalCheckRowsMatchBundle(checks: unknown[], expectedBundleResult: ReleaseEvidenceBundleResult | undefined) {
  if (!expectedBundleResult) {
    return false;
  }

  const actualRows = checks
    .filter(isObject)
    .map((check) => ({
      name: stringValue(check.name) ?? "",
      status: statusValue(check.status) ?? "",
      message: stringValue(check.message) ?? ""
    }));
  const expectedRows = expectedBundleResult.checks.map((check) => ({
    name: check.name,
    status: check.status,
    message: check.message
  }));

  if (actualRows.length !== expectedRows.length) {
    return false;
  }

  return expectedRows.every((expected, index) => {
    const actual = actualRows[index];

    return actual.name === expected.name &&
      actual.status === expected.status &&
      actual.message === expected.message;
  });
}

function selectedEvidenceMatchesBundle(evidence: Record<string, unknown>, expectedBundleResult: ReleaseEvidenceBundleResult | undefined) {
  if (!expectedBundleResult) {
    return false;
  }

  const expected = expectedBundleResult.selectedEvidence;

  return Boolean(
    expected.releaseCommitRef &&
      expected.repository &&
      expected.branch &&
      stringValue(nestedValue(evidence, ["selectedEvidence", "releaseCommitRef"])) === expected.releaseCommitRef &&
      stringValue(nestedValue(evidence, ["selectedEvidence", "repository"])) === expected.repository &&
      stringValue(nestedValue(evidence, ["selectedEvidence", "branch"])) === expected.branch
  );
}

function payloadDigestMatchesBundle(evidence: Record<string, unknown>, expectedBundleResult: ReleaseEvidenceBundleResult | undefined) {
  const payloadDigest = stringValue(evidence.payloadDigest);

  return Boolean(
    payloadDigest &&
      expectedBundleResult?.payloadDigest &&
      payloadDigest === expectedBundleResult.payloadDigest
  );
}

function finalCheckAfterBundle(evidence: Record<string, unknown>, expectedBundleCheckedAt: string | undefined) {
  const finalCheckCheckedAt = timestampValue(evidence.checkedAt);

  return Boolean(
    finalCheckCheckedAt &&
      expectedBundleCheckedAt &&
      Date.parse(finalCheckCheckedAt) >= Date.parse(expectedBundleCheckedAt)
  );
}

function finalReleaseEvidenceCheckFailedChecks(
  evidence: Record<string, unknown>,
  context: FinalReleaseEvidenceCheckContext = {}
) {
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const expectedBundleResult = context.expectedBundleResult;

  return [
    ...failedCheck(
      "final_release_evidence_check_name",
      evidence.name === "siteflow-release-evidence-bundle-check",
      "Final release evidence check output must be from siteflow-release-evidence-bundle-check."
    ),
    ...failedCheck(
      "final_release_evidence_check_passed",
      statusValue(evidence.status) === "passed" && evidence.exitCode === 0 && failedChecks(evidence).length === 0,
      "Final release evidence check output must be passed with all checks passing."
    ),
    ...failedCheck(
      "final_release_evidence_check_checked_at",
      Boolean(timestampValue(evidence.checkedAt)),
      "Final release evidence check output must include a checkedAt timestamp."
    ),
    ...failedCheck(
      "final_release_evidence_check_checked_at_after_bundle",
      finalCheckAfterBundle(evidence, context.expectedBundleCheckedAt),
      "Final release evidence check checkedAt must be at or after the release evidence bundle checkedAt."
    ),
    ...failedCheck(
      "final_release_evidence_check_evidence_path",
      Boolean(stringValue(evidence.evidencePath)),
      "Final release evidence check output must include the checked release evidence bundle path."
    ),
    ...failedCheck(
      "final_release_evidence_check_expected_path",
      Boolean(context.expectedEvidencePath && stringValue(evidence.evidencePath) === context.expectedEvidencePath),
      "Final release evidence check output must check the rehearsal pack release evidence bundle path."
    ),
    ...failedCheck(
      "final_release_evidence_check_selected_evidence",
      Boolean(
        stringValue(nestedValue(evidence, ["selectedEvidence", "releaseCommitRef"])) &&
          stringValue(nestedValue(evidence, ["selectedEvidence", "repository"])) &&
          stringValue(nestedValue(evidence, ["selectedEvidence", "branch"]))
      ),
      "Final release evidence check output must include selected release commit, repository, and branch."
    ),
    ...failedCheck(
      "final_release_evidence_check_bundle_result",
      Boolean(expectedBundleResult),
      "Final release evidence check output must be compared with the current release evidence bundle result."
    ),
    ...failedCheck(
      "final_release_evidence_required_attestation_key_id",
      context.requiredAttestationKeyIdConfigured === true,
      "Final release evidence check must be evaluated with SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID configured."
    ),
    ...failedCheck(
      "final_release_evidence_check_result_status",
      Boolean(
        expectedBundleResult &&
          statusValue(evidence.status) === expectedBundleResult.status &&
          evidence.exitCode === expectedBundleResult.exitCode
      ),
      "Final release evidence check status and exitCode must match the current release evidence bundle result."
    ),
    ...failedCheck(
      "final_release_evidence_check_selected_evidence_matches_bundle",
      selectedEvidenceMatchesBundle(evidence, expectedBundleResult),
      "Final release evidence check selected release identity must match the current release evidence bundle result."
    ),
    ...failedCheck(
      "final_release_evidence_check_payload_digest",
      payloadDigestMatchesBundle(evidence, expectedBundleResult),
      "Final release evidence check payloadDigest must match the current release evidence bundle payload."
    ),
    ...failedCheck(
      "final_release_evidence_check_checks",
      checks.length > 0 && checks.every((check) => isObject(check) && statusValue(check.status) === "pass"),
      "Final release evidence check output must include non-empty passing checks."
    ),
    ...failedCheck(
      "final_release_evidence_check_rows_match_bundle",
      finalCheckRowsMatchBundle(checks, expectedBundleResult),
      "Final release evidence check rows must include every current release evidence bundle check name and status."
    )
  ];
}

function failedChecksForItem(
  id: string,
  evidence: Record<string, unknown>,
  release: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number,
  finalCheckContext?: FinalReleaseEvidenceCheckContext
) {
  const baseFailedChecks = [
    ...failedChecks(evidence),
    ...finalEvidenceFailedChecks(evidence),
    ...noSensitiveEvidenceValuesFailedCheck(evidence, "Evidence output")
  ];

  if (id === "release_gate") {
    return uniqueFailedChecks([...baseFailedChecks, ...releaseGateFailedChecks(evidence)]);
  }

  if (id === "docker_build_rehearsal") {
    return uniqueFailedChecks([...baseFailedChecks, ...dockerBuildFailedChecks(evidence)]);
  }

  if (id === "backup_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...backupEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "release_artifact_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...releaseArtifactEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "release_image_evidence") {
    return uniqueFailedChecks([
      ...baseFailedChecks,
      ...releaseImageEvidenceFailedChecks(evidence, release, now, maxEvidenceAgeHours)
    ]);
  }

  if (id === "source_provider_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...sourceProviderEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "target_runtime_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...targetRuntimeEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "observability_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...observabilityEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "operator_access_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...operatorAccessEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "non_session_credential_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...nonSessionCredentialEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "ingress_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...ingressEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "upgrade_rollback_evidence") {
    return uniqueFailedChecks([...baseFailedChecks, ...upgradeRollbackEvidenceFailedChecks(evidence, release)]);
  }

  if (id === "release_evidence_check") {
    return uniqueFailedChecks([...baseFailedChecks, ...finalReleaseEvidenceCheckFailedChecks(evidence, finalCheckContext)]);
  }

  if (id !== "postgres_rehearsal") {
    return baseFailedChecks;
  }

  return uniqueFailedChecks([...baseFailedChecks, ...postgresRehearsalFailedChecks(evidence, release)]);
}

function identityMismatch(
  evidence: Record<string, unknown>,
  release: Record<string, unknown>
) {
  const expectedCommit = stringValue(release.commitRef);
  const expectedRepository = stringValue(release.repository);
  const expectedBranch = stringValue(release.branch);
  const actualCommit = evidenceCommit(evidence);
  const actualRepository = evidenceRepository(evidence);
  const actualBranch = evidenceBranch(evidence);

  return Boolean(
    actualCommit && expectedCommit && actualCommit !== expectedCommit ||
      actualRepository && expectedRepository && actualRepository !== expectedRepository ||
      actualBranch && expectedBranch && actualBranch !== expectedBranch
  );
}

function evidencePassed(evidence: Record<string, unknown>) {
  const status = statusValue(evidence.status);
  const gateStatus = statusValue(nestedValue(evidence, ["promotionEvidence", "gateStatus"]));
  const exitCode = typeof evidence.exitCode === "number" ? evidence.exitCode : undefined;

  return (status === "passed" || status === "pass" || gateStatus === "pass") &&
    (exitCode === undefined || exitCode === 0) &&
    failedChecks(evidence).length === 0;
}

function releaseGateEvidencePassed(evidence: Record<string, unknown>) {
  const status = statusValue(evidence.status);
  const promotion = releaseGatePromotion(evidence);
  const gateStatus = statusValue(promotion.gateStatus);
  const manualRequired = statusValue(promotion.manualRequired) === "true" ||
    promotion.manualRequired === true ||
    Array.isArray(promotion.manualRequiredCheckIds) && promotion.manualRequiredCheckIds.length > 0;

  return (status === "pass" || status === "passed") &&
    gateStatus === "pass" &&
    promotion.promotion === true &&
    !manualRequired &&
    failedChecks(evidence).length === 0;
}

async function readJsonObject(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandArgs(command: PackCommand | undefined) {
  return stringArray(command?.args);
}

function commandEnvSpecs(command: PackCommand | undefined) {
  return stringArray(command?.env);
}

function envNameAndExpected(spec: string) {
  const separatorIndex = spec.indexOf("=");

  if (separatorIndex === -1) {
    return {
      name: spec.trim()
    };
  }

  return {
    name: spec.slice(0, separatorIndex).trim(),
    expected: spec.slice(separatorIndex + 1).trim()
  };
}

function placeholderMatches(value: string) {
  return [...value.matchAll(/<([^<>]+)>/g)].map((match) => ({
    token: match[0],
    key: match[1]
  }));
}

function hasReplacement(replacements: Record<string, string>, key: string) {
  return Object.prototype.hasOwnProperty.call(replacements, key);
}

function replacementValueLooksUnresolved(replacements: Record<string, string>, key: string) {
  return hasReplacement(replacements, key) && /<[^<>]+>/.test(replacements[key]);
}

function inputFileFlagValueForCheck(value: string, replacements: Record<string, string>) {
  const placeholders = placeholderMatches(value);

  if (placeholders.length === 0) {
    return {
      path: value,
      reportValue: value
    };
  }

  let resolved = value;

  for (const placeholder of placeholders) {
    if (!hasReplacement(replacements, placeholder.key) || replacementValueLooksUnresolved(replacements, placeholder.key)) {
      return undefined;
    }

    resolved = resolved.replaceAll(placeholder.token, replacements[placeholder.key]);
  }

  return {
    path: resolved,
    reportValue: placeholders.map((placeholder) => placeholder.key).join(","),
    placeholder: placeholders.map((placeholder) => placeholder.token).join(", ")
  };
}

async function targetEnvFileInputGaps(
  filePath: string,
  targetEnvironment: string | null | undefined
) {
  let values: Map<string, string>;

  try {
    values = parseTargetEnvFile(await readFile(filePath, "utf8"));
  } catch {
    return targetEnvFileUnreadableIssues(targetEnvironment).map((entry): ReleaseEvidenceGapInput => ({
      kind: "env",
      value: entry.name,
      status: entry.status,
      source: "command_arg",
      message: entry.message
    }));
  }

  return targetEnvFilePreflightIssues(values, targetEnvironment)
    .map((entry): ReleaseEvidenceGapInput => ({
      kind: "env",
      value: entry.name,
      status: entry.status,
      source: "command_arg",
      message: entry.message
    }));
}

function validateReplacements(replacements: Record<string, string>) {
  for (const [key, value] of Object.entries(replacements)) {
    validateReplacementKey(key);

    if (!stringValue(value)) {
      throw new Error(`Replacement ${key} requires a non-empty value.`);
    }
  }
}

function validateReplacementKey(key: string) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(key)) {
    throw new Error(`Replacement key ${key} must contain only letters, numbers, dot, underscore, colon, or dash.`);
  }
}

function validateEnvReplacementName(envName: string, key: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(envName)) {
    throw new Error(`--set-env ${key} requires an environment variable name containing only letters, numbers, or underscore and not starting with a number.`);
  }
}

function validateEnvReplacements(envReplacements: Record<string, string>) {
  for (const [key, envName] of Object.entries(envReplacements)) {
    validateReplacementKey(key);

    if (!stringValue(envName)) {
      throw new Error(`--set-env ${key} requires an environment variable name.`);
    }

    validateEnvReplacementName(envName, key);
  }
}

function envReplacementReferences(envReplacements: Record<string, string> | undefined) {
  return Object.entries(envReplacements ?? {}).map(([key, envName]) => ({ key, envName }));
}

async function fileSecretValue(filePath: string | undefined) {
  const normalizedPath = stringValue(filePath);

  if (!normalizedPath) {
    return undefined;
  }

  const resolvedPath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(process.cwd(), normalizedPath);
  const value = (await readFile(resolvedPath, "utf8")).replace(/[\r\n]+$/g, "");

  return value.trim() ? value : undefined;
}

async function secretEnvValue(env: Record<string, string | undefined>, name: string) {
  const directValue = stringValue(env[name]);

  if (directValue) {
    return directValue;
  }

  try {
    return await fileSecretValue(env[`${name}_FILE`]);
  } catch {
    return undefined;
  }
}

function resolveReplacementsFromEnv(
  replacements: Record<string, string>,
  envReplacements: Record<string, string>,
  env: Record<string, string | undefined>
) {
  validateReplacements(replacements);
  validateEnvReplacements(envReplacements);

  const resolved = { ...replacements };

  for (const [key, envName] of Object.entries(envReplacements)) {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      throw new Error(`Replacement ${key} cannot be supplied by both --set and --set-env.`);
    }

    const value = stringValue(env[envName]);

    if (!value) {
      throw new Error(`--set-env ${key} requires environment variable ${envName} to be set to a non-empty value.`);
    }

    resolved[key] = value;
  }

  return resolved;
}

async function commandInputGaps(
  command: PackCommand | undefined,
  env: Record<string, string | undefined>,
  replacements: Record<string, string>,
  targetEnvironment: string | null | undefined
) {
  const gaps: ReleaseEvidenceGapInput[] = [];
  const args = commandArgs(command);

  for (const arg of args) {
    for (const placeholder of placeholderMatches(arg)) {
      if (replacementValueLooksUnresolved(replacements, placeholder.key)) {
        gaps.push({
          kind: "operator_input",
          value: placeholder.key,
          status: "operator_required",
          source: "command_arg",
          placeholder: placeholder.token,
          message: `${placeholder.token} replacement must be a concrete operator value before this command can run.`
        });
        continue;
      }

      if (!hasReplacement(replacements, placeholder.key)) {
        gaps.push({
          kind: "operator_input",
          value: placeholder.key,
          status: "operator_required",
          source: "command_arg",
          placeholder: placeholder.token,
          message: `${placeholder.token} must be supplied with --set or --set-env before this command can run.`
        });
      }
    }
  }

  for (let index = 0; index < args.length - 1; index += 1) {
    const arg = args[index];
    const value = args[index + 1];

    if (!inputFileFlags.has(arg) || !value || value.startsWith("--")) {
      continue;
    }

    const inputFile = inputFileFlagValueForCheck(value, replacements);

    if (!inputFile) {
      continue;
    }

    if (!await fileExists(inputFile.path)) {
      gaps.push({
        kind: "file",
        value: inputFile.reportValue,
        status: "missing",
        source: "command_arg",
        ...(inputFile.placeholder ? { placeholder: inputFile.placeholder } : {}),
        message: inputFile.placeholder
          ? `${arg} resolved input file is missing.`
          : `${arg} input file is missing.`
      });
      continue;
    }

    if (arg === "--env-file") {
      gaps.push(...await targetEnvFileInputGaps(inputFile.path, targetEnvironment));
    }
  }

  for (const spec of commandEnvSpecs(command)) {
    const { name, expected } = envNameAndExpected(spec);

    if (!name) {
      continue;
    }

    const configured = env[name];
    const fileConfigured = !configured && !expected
      ? await secretEnvValue(env, name)
      : undefined;
    const placeholder = expected?.includes("<") && expected.includes(">");

    if (!configured && !fileConfigured && placeholder) {
      gaps.push({
        kind: "operator_input",
        value: name,
        status: "operator_required",
        source: "command_env",
        message: `${name} must be supplied by the operator before this command can run.`
      });
      continue;
    }

    if (!configured && !fileConfigured) {
      gaps.push({
        kind: "env",
        value: name,
        status: "missing",
        source: "command_env",
        message: `${name} environment variable is missing.`
      });
      continue;
    }

    if (expected && !placeholder && configured !== expected) {
      gaps.push({
        kind: "operator_input",
        value: name,
        status: "operator_required",
        source: "command_env",
        message: `${name} must match the command requirement.`
      });
    }
  }

  return uniqueInputGaps(gaps);
}

function missingItem(
  id: string,
  title: string,
  kind: ReleaseEvidenceGapReportItem["kind"],
  outputPath: string,
  command: string,
  required: boolean,
  inputGaps: ReleaseEvidenceGapInput[],
  prerequisites: string[],
  notes: string[]
): ReleaseEvidenceGapReportItem {
  return {
    id,
    title,
    kind,
    required,
    status: "missing",
    outputPath,
    command,
    nextCommand: command,
    requiresRealEnvironment: true,
    message: "Expected evidence output is missing.",
    failedChecks: [],
    inputGaps,
    prerequisites,
    notes
  };
}

function invalidItem(
  id: string,
  title: string,
  kind: ReleaseEvidenceGapReportItem["kind"],
  outputPath: string,
  command: string,
  required: boolean,
  inputGaps: ReleaseEvidenceGapInput[],
  prerequisites: string[],
  notes: string[],
  error: unknown
): ReleaseEvidenceGapReportItem {
  return {
    id,
    title,
    kind,
    required,
    status: "invalid",
    outputPath,
    command,
    nextCommand: command,
    requiresRealEnvironment: true,
    message: error instanceof Error ? error.message : String(error),
    failedChecks: [],
    inputGaps,
    prerequisites,
    notes
  };
}

function evaluateReleaseEvidenceBundleForGapReport(
  evidence: Record<string, unknown>,
  outputPath: string,
  release: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number,
  attestationSigningKey?: string,
  requiredAttestationKeyId?: string
) {
  return evaluateReleaseEvidenceBundle(evidence, {
    evidencePath: outputPath,
    commitRef: stringValue(release.commitRef),
    repo: stringValue(release.repository),
    branch: stringValue(release.branch),
    targetEnvironment: stringValue(release.targetEnvironment),
    maxEvidenceAgeHours,
    attestationSigningKey,
    requiredAttestationKeyId,
    now: () => now
  });
}

async function readReleaseEvidenceBundleResult(
  outputPath: string,
  release: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number,
  attestationSigningKey?: string,
  requiredAttestationKeyId?: string
) {
  try {
    const evidence = await readJsonObject(outputPath);

    return evaluateReleaseEvidenceBundleForGapReport(evidence, outputPath, release, now, maxEvidenceAgeHours, attestationSigningKey, requiredAttestationKeyId);
  } catch {
    return undefined;
  }
}

async function readReleaseEvidenceBundleCheckedAt(outputPath: string) {
  try {
    const evidence = await readJsonObject(outputPath);

    return evidenceTimestamp(evidence);
  } catch {
    return undefined;
  }
}

function evaluateEvidenceObject(
  id: string,
  title: string,
  kind: ReleaseEvidenceGapReportItem["kind"],
  outputPath: string,
  command: string,
  required: boolean,
  inputGaps: ReleaseEvidenceGapInput[],
  prerequisites: string[],
  notes: string[],
  evidence: Record<string, unknown>,
  release: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number,
  finalCheckContext?: FinalReleaseEvidenceCheckContext
): ReleaseEvidenceGapReportItem {
  const status = statusValue(evidence.status) ?? statusValue(nestedValue(evidence, ["promotionEvidence", "gateStatus"])) ?? "unknown";
  const checkedAt = evidenceTimestamp(evidence);
  const promotion = releaseGatePromotion(evidence);
  const baseFailedChecks = failedChecks(evidence);
  const itemFailedChecks = failedChecksForItem(id, evidence, release, now, maxEvidenceAgeHours, finalCheckContext);
  const hasItemDiagnosticsFailures = itemFailedChecks.length > baseFailedChecks.length;
  const hasSensitiveEvidenceFailure = itemFailedChecks.some((check) =>
    check.name === "no_sensitive_evidence_values" && check.status === "fail"
  );
  const evidenceIsPassing = id === "release_image_evidence"
    ? releaseImageEvidencePassed(evidence, release, now, maxEvidenceAgeHours)
    : id === "release_gate"
      ? releaseGateEvidencePassed(evidence)
    : evidencePassed(evidence);
  let itemStatus: GapItemStatus = "passed";
  let message = "Evidence output exists and is currently passing.";

  if (status === "manual_required" || statusValue(promotion.manualRequired) === "true" || promotion.manualRequired === true ||
    Array.isArray(promotion.manualRequiredCheckIds) && promotion.manualRequiredCheckIds.length > 0) {
    itemStatus = "manual_required";
    message = "Release gate evidence still contains manual_required checks.";
  } else if (evidence.dryRun === true) {
    itemStatus = "dry_run_only";
    message = "Evidence output came from a dry run and is not production evidence.";
  } else if (evidence.template === true) {
    itemStatus = "blocked";
    message = "Evidence output came from a template and is not production evidence.";
  } else if (hasSensitiveEvidenceFailure) {
    itemStatus = "blocked";
    message = "Evidence output includes raw secret-like values and is not production evidence.";
  } else if (identityMismatch(evidence, release)) {
    itemStatus = "identity_mismatch";
    message = "Evidence release identity does not match the rehearsal pack release.";
  } else if (checkedAtRequiredEvidenceIds.has(id) && !checkedAt) {
    itemStatus = "blocked";
    message = "Evidence output is missing checkedAt and cannot prove raw evidence freshness.";
  } else if (checkedAt && !isFresh(checkedAt, now, maxEvidenceAgeHours)) {
    itemStatus = "stale";
    message = `Evidence timestamp is older than ${maxEvidenceAgeHours} hours or from the future.`;
  } else if (hasItemDiagnosticsFailures && (id === "release_evidence_check" || evidenceIsPassing)) {
    itemStatus = "blocked";
    message = "Evidence output is missing required production diagnostics.";
  } else if (!evidenceIsPassing) {
    itemStatus = status === "failed" || status === "fail" ? "failed" : "blocked";
    message = "Evidence output is not passing.";
  } else if (hasItemDiagnosticsFailures) {
    itemStatus = "blocked";
    message = "Evidence output is missing required production diagnostics.";
  }

  return {
    id,
    title,
    kind,
    required,
    status: itemStatus,
    outputPath,
    command,
    ...(itemStatus === "passed" ? {} : { nextCommand: command }),
    requiresRealEnvironment: true,
    message,
    evidenceStatus: status,
    ...(checkedAt ? { checkedAt } : {}),
    failedChecks: itemFailedChecks,
    inputGaps: itemStatus === "passed" ? [] : inputGaps,
    prerequisites,
    notes
  };
}

async function evaluateOutput(
  id: string,
  title: string,
  kind: ReleaseEvidenceGapReportItem["kind"],
  outputPath: string,
  command: string,
  required: boolean,
  inputGaps: ReleaseEvidenceGapInput[],
  prerequisites: string[],
  notes: string[],
  release: Record<string, unknown>,
  now: Date,
  maxEvidenceAgeHours: number,
  attestationSigningKey?: string,
  requiredAttestationKeyId?: string,
  finalCheckContext?: FinalReleaseEvidenceCheckContext
) {
  try {
    const evidence = await readJsonObject(outputPath);

    if (kind === "final_bundle") {
      const bundleResult = evaluateReleaseEvidenceBundleForGapReport(
        evidence,
        outputPath,
        release,
        now,
        maxEvidenceAgeHours,
        attestationSigningKey,
        requiredAttestationKeyId
      );
      const bundleFailedChecks = bundleResult.checks
        .filter((check) => check.status !== "pass")
        .map((check) => ({
          name: check.name,
          status: check.status,
          message: check.message
        }));
      if (attestationSigningKey && !requiredAttestationKeyId) {
        bundleFailedChecks.push({
          name: "release_evidence_required_attestation_key_id",
          status: "fail",
          message: "Release evidence bundle gap checks must be evaluated with SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID configured."
        });
      }
      const invalidBundle = bundleFailedChecks.some((check) =>
        check.name === "schema_version" || check.name === "bundle_name" || check.name === "bundle_shape"
      );
      const itemStatus: GapItemStatus = bundleFailedChecks.length === 0
        ? "passed"
        : invalidBundle
          ? "invalid"
          : "blocked";

      return {
        id,
        title,
        kind,
        required,
        status: itemStatus,
        outputPath,
        command,
        ...(itemStatus === "passed" ? {} : { nextCommand: command }),
        requiresRealEnvironment: true,
        message: itemStatus === "passed"
          ? "Release evidence bundle exists and passes final bundle checks."
          : invalidBundle
            ? "Release evidence bundle has the wrong schema or name."
            : "Release evidence bundle does not pass final bundle checks.",
        evidenceStatus: bundleResult.status,
        ...(evidenceTimestamp(evidence) ? { checkedAt: evidenceTimestamp(evidence) } : {}),
        failedChecks: bundleFailedChecks,
        inputGaps: itemStatus === "passed" ? [] : inputGaps,
        prerequisites,
        notes
      } satisfies ReleaseEvidenceGapReportItem;
    }

    return evaluateEvidenceObject(
      id,
      title,
      kind,
      outputPath,
      command,
      required,
      inputGaps,
      prerequisites,
      notes,
      evidence,
      release,
      now,
      maxEvidenceAgeHours,
      finalCheckContext
    );
  } catch (error) {
    const code = isObject(error) && error.code;

    if (code === "ENOENT") {
      return missingItem(id, title, kind, outputPath, command, required, inputGaps, prerequisites, notes);
    }

    return invalidItem(id, title, kind, outputPath, command, required, inputGaps, prerequisites, notes, error);
  }
}

function packSteps(pack: Record<string, unknown>) {
  const steps = pack.steps;

  if (!Array.isArray(steps)) {
    throw new Error("Release evidence rehearsal pack must include steps.");
  }

  return steps.filter(isObject) as PackStep[];
}

function commandDisplay(command: PackCommand | undefined) {
  return stringValue(command?.display) ?? "";
}

function packOutputPath(pack: Record<string, unknown>, key: string) {
  return stringValue(nestedValue(pack, ["evidenceFiles", key]));
}

function summary(items: ReleaseEvidenceGapReportItem[]) {
  return {
    total: items.length,
    passed: items.filter((item) => item.status === "passed").length,
    gaps: items.filter((item) => item.status !== "passed").length,
    missing: items.filter((item) => item.status === "missing").length,
    invalid: items.filter((item) => item.status === "invalid").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    failed: items.filter((item) => item.status === "failed").length,
    manualRequired: items.filter((item) => item.status === "manual_required").length,
    dryRunOnly: items.filter((item) => item.status === "dry_run_only").length,
    stale: items.filter((item) => item.status === "stale").length,
    identityMismatches: items.filter((item) => item.status === "identity_mismatch").length,
    inputGaps: items.reduce((total, item) => total + item.inputGaps.length, 0)
  };
}

export async function createReleaseEvidenceGapReport(
  options: ReleaseEvidenceGapReportOptions
): Promise<ReleaseEvidenceGapReportResult> {
  const now = options.now?.() ?? new Date();
  const maxEvidenceAgeHours = positiveNumber(options.maxEvidenceAgeHours, defaultMaxEvidenceAgeHours, "maxEvidenceAgeHours");
  const env = options.env ?? process.env;
  const attestationSigningKey = await secretEnvValue(env, "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY");
  const requiredAttestationKeyId = await secretEnvValue(env, "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID") ??
    releaseEvidenceRequiredAttestationKeyIdFromEnv(env);
  const envReplacements = options.envReplacements ?? {};
  const replacements = resolveReplacementsFromEnv(options.replacements ?? {}, envReplacements, env);
  const pack = await readJsonObject(options.packPath);

  if (pack.schemaVersion !== "siteflow.releaseEvidenceRehearsalPack.v1" ||
    pack.name !== "siteflow-release-evidence-rehearsal-pack") {
    throw new Error(`${options.packPath} must be a siteflow-release-evidence-rehearsal-pack JSON file.`);
  }

  validateReleaseEvidenceRehearsalPackContract(pack);

  const release = nestedObject(pack, "release") ?? {};
  const items: ReleaseEvidenceGapReportItem[] = [];

  for (const step of packSteps(pack)) {
    const id = stringValue(step.id) ?? "unknown_step";
    const command = commandDisplay(step.command);
    const inputGaps = await commandInputGaps(step.command, env, replacements, stringValue(release.targetEnvironment) ?? null);

    items.push(await evaluateOutput(
      id,
      stringValue(step.title) ?? id,
      "evidence",
      stringValue(step.outputPath) ?? "",
      command,
      step.required !== false,
      inputGaps,
      stringArray(step.prerequisites),
      stringArray(step.notes),
      release,
      now,
      maxEvidenceAgeHours,
      attestationSigningKey,
      requiredAttestationKeyId
    ));
  }

  const composeCommand = nestedObject(pack, "finalCommands")?.compose as PackCommand | undefined;
  const checkCommand = nestedObject(pack, "finalCommands")?.check as PackCommand | undefined;
  const releaseEvidencePath = packOutputPath(pack, "releaseEvidence");
  const releaseEvidenceCheckPath = stringValue(checkCommand?.captureStdoutTo) ?? packOutputPath(pack, "releaseEvidenceCheck");
  let releaseEvidenceBundleResult: ReleaseEvidenceBundleResult | undefined;
  let releaseEvidenceBundleCheckedAt: string | undefined;

  if (releaseEvidencePath) {
    const inputGaps = await commandInputGaps(composeCommand, env, replacements, stringValue(release.targetEnvironment) ?? null);

    items.push(await evaluateOutput(
      "release_evidence_bundle",
      "Compose final release evidence bundle",
      "final_bundle",
      releaseEvidencePath,
      commandDisplay(composeCommand),
      true,
      inputGaps,
      ["All required evidence checker outputs exist and are passing."],
      ["The final bundle is not production evidence until release:evidence passes for the exact release commit."],
      release,
      now,
      maxEvidenceAgeHours,
      attestationSigningKey,
      requiredAttestationKeyId
    ));
    releaseEvidenceBundleResult = await readReleaseEvidenceBundleResult(
      releaseEvidencePath,
      release,
      now,
      maxEvidenceAgeHours,
      attestationSigningKey,
      requiredAttestationKeyId
    );
    releaseEvidenceBundleCheckedAt = await readReleaseEvidenceBundleCheckedAt(releaseEvidencePath);
  }

  if (releaseEvidenceCheckPath) {
    const inputGaps = await commandInputGaps(checkCommand, env, replacements, stringValue(release.targetEnvironment) ?? null);

    items.push(await evaluateOutput(
      "release_evidence_check",
      "Run final release evidence bundle check",
      "final_check",
      releaseEvidenceCheckPath,
      commandDisplay(checkCommand),
      true,
      inputGaps,
      ["Final release evidence bundle exists."],
      ["A passing final check is required before promotion."],
      release,
      now,
      maxEvidenceAgeHours,
      attestationSigningKey,
      requiredAttestationKeyId,
      {
        expectedEvidencePath: releaseEvidencePath,
        expectedBundleResult: releaseEvidenceBundleResult,
        expectedBundleCheckedAt: releaseEvidenceBundleCheckedAt,
        requiredAttestationKeyIdConfigured: !attestationSigningKey || Boolean(requiredAttestationKeyId)
      }
    ));
  }

  const reportSummary = summary(items);
  const passed = reportSummary.gaps === 0;

  return {
    name: "siteflow-release-evidence-gap-report",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    packPath: options.packPath,
    envReplacements: envReplacementReferences(envReplacements),
    release: {
      commitRef: stringValue(release.commitRef) ?? null,
      repository: stringValue(release.repository) ?? null,
      branch: stringValue(release.branch) ?? null,
      targetEnvironment: stringValue(release.targetEnvironment) ?? null
    },
    summary: reportSummary,
    items,
    blockedProductionClaims: stringArray(pack.blockedProductionClaims),
    exitCode: passed ? 0 : 1
  };
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!stringValue(value) || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parseReplacement(raw: string) {
  const separator = raw.indexOf("=");

  if (separator <= 0) {
    throw new Error("--set requires KEY=value.");
  }

  return {
    key: raw.slice(0, separator),
    value: raw.slice(separator + 1)
  };
}

function parseEnvReplacement(raw: string) {
  const separator = raw.indexOf("=");

  if (separator <= 0) {
    throw new Error("--set-env requires KEY=ENV_NAME.");
  }

  return {
    key: raw.slice(0, separator),
    envName: raw.slice(separator + 1)
  };
}

export function parseReleaseEvidenceGapReportArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    maxEvidenceAgeHours: defaultMaxEvidenceAgeHours,
    replacements: {},
    envReplacements: {},
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--pack") {
      parsed.packPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-evidence-age-hours") {
      parsed.maxEvidenceAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--set") {
      const replacement = parseReplacement(readArgValue(args, index, arg));
      parsed.replacements[replacement.key] = replacement.value;
      index += 1;
    } else if (arg === "--set-env") {
      const replacement = parseEnvReplacement(readArgValue(args, index, arg));
      parsed.envReplacements[replacement.key] = replacement.envName;
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.packPath) {
    throw new Error("--pack <file> is required.");
  }

  positiveNumber(parsed.maxEvidenceAgeHours, defaultMaxEvidenceAgeHours, "--max-evidence-age-hours");
  validateReplacements(parsed.replacements);
  validateEnvReplacements(parsed.envReplacements);

  return parsed;
}

export function releaseEvidenceGapReportUsage() {
  return [
    "Usage: npm run --silent release:evidence:gaps -- --pack <release-evidence-rehearsal-pack.json> [options]",
    "",
    "Options:",
    "  --pack <file>                    Release evidence rehearsal pack JSON from release:evidence:rehearsal-pack.",
    `  --max-evidence-age-hours <hours>  Maximum age for evidence outputs. Default: ${defaultMaxEvidenceAgeHours}.`,
    "  --set <placeholder=value>        Rehearse replacement of a pack command placeholder such as <direct-api-url>. Repeatable; values are never printed.",
    "  --set-env <placeholder=ENV_NAME> Read a placeholder replacement from ENV_NAME; records only the key and env name. Repeatable.",
    "  --json                           Emit a single JSON report.",
    "  --help                           Show this help.",
    "",
    "The gap reporter reads existing files only. It also reports missing raw input files and required environment variable names referenced by the pack without printing secret values.",
    "It does not call GitHub, run Docker, run Postgres, create backups, scrape metrics, execute the generated ingress collector, create sessions, rotate credentials, or perform upgrade/rollback drills."
  ].join("\n");
}

function inputGapDisplayName(gap: ReleaseEvidenceGapInput) {
  if (gap.kind === "file") {
    return `file ${gap.value}`;
  }

  if (gap.source === "command_env") {
    return `env ${gap.value}`;
  }

  if (gap.placeholder) {
    return `placeholder ${gap.placeholder}`;
  }

  return `${gap.kind} ${gap.value}`;
}

function writeHumanResult(result: ReleaseEvidenceGapReportResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow release evidence gap report: ${result.status}\n`);
  output.write(`Pack: ${result.packPath}\n`);
  output.write(`Gaps: ${result.summary.gaps}/${result.summary.total}\n`);

  for (const item of result.items.filter((entry) => entry.status !== "passed")) {
    output.write(`- ${item.id}: ${item.status} - ${item.message}\n`);
    if (item.nextCommand) {
      output.write(`  Next: ${item.nextCommand}\n`);
    }
    for (const gap of item.inputGaps) {
      output.write(`  Input gap: ${inputGapDisplayName(gap)} (${gap.status}) - ${gap.message}\n`);
    }
  }
}

export async function runReleaseEvidenceGapReportCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseEvidenceGapReportOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseEvidenceGapReportArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseEvidenceGapReportUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseEvidenceGapReportUsage()}\n`);
    return 0;
  }

  try {
    const result = await createReleaseEvidenceGapReport({
      ...baseOptions,
      packPath: parsed.packPath!,
      maxEvidenceAgeHours: parsed.maxEvidenceAgeHours,
      replacements: parsed.replacements,
      envReplacements: parsed.envReplacements
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result = {
      name: "siteflow-release-evidence-gap-report",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      message: error instanceof Error ? error.message : String(error),
      exitCode: 1
    };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stderr.write(`${result.message}\n`);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runReleaseEvidenceGapReportCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
