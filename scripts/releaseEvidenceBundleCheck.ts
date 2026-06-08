import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck.js";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts.js";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck.js";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface ReleaseEvidenceBundleCheckOptions {
  evidencePath: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxEvidenceAgeHours?: number;
  allowHostBuildException?: boolean;
  now?: () => Date;
}

export interface ReleaseEvidenceBundleCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface ReleaseEvidenceBundleResult {
  name: "siteflow-release-evidence-bundle-check";
  status: EvidenceStatus;
  checkedAt: string;
  evidencePath: string;
  thresholds: {
    maxEvidenceAgeHours: number;
    allowHostBuildException: boolean;
  };
  selectedEvidence: {
    releaseCommitRef: string | null;
    repository: string | null;
    branch: string | null;
    releaseGateStatus: string | null;
    dockerBuildRehearsalStatus: string | null;
    postgresRehearsalStatus: string | null;
    artifactEvidenceStatus: string | null;
    releaseImageDigest: string | null;
    targetRuntimeEvidenceStatus: string | null;
    sourceProviderEvidenceStatus: string | null;
    backupEvidenceStatus: string | null;
    observabilityEvidenceStatus: string | null;
    operatorAccessEvidenceStatus: string | null;
    nonSessionCredentialEvidenceStatus: string | null;
    ingressEvidenceStatus: string | null;
    upgradeRollbackDrillStatus: string | null;
  };
  checks: ReleaseEvidenceBundleCheck[];
  exitCode: number;
}

interface ParsedArgs {
  evidencePath?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  json: boolean;
  help: boolean;
  maxEvidenceAgeHours: number;
  allowHostBuildException: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMaxEvidenceAgeHours = 168;
const expectedSchemaVersion = "siteflow.releaseEvidence.v1";
const expectedBundleName = "siteflow-release-evidence-bundle";
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;
const sha256HexPattern = /^[a-f0-9]{64}$/i;
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
const requiredSourceProviderEvidenceChecks = [...requiredSourceProviderEvidenceCheckNames];
const requiredBackupEvidenceChecks = [...requiredOffHostBackupEvidenceCheckNames];
const apiInstanceCountKeys = ["apiInstanceCount", "apiInstances", "instanceCount", "instances", "replicas"];
const apiProcessCountKeys = ["apiProcessCount", "apiProcesses", "processCount", "processes"];
const ingressCountKeys = ["ingressCount", "ingresses"];
const topologyMultiFlagKeys = ["multiInstance", "multiProcess", "multiIngress"];
const requiredObservabilityEvidenceChecks = [
  "release_identity",
  "target_environment",
  "readiness_present",
  "readiness_status",
  "readiness_age",
  "readiness_status_codes",
  "readiness_traffic_removed",
  "metrics_present",
  "metrics_status",
  "metrics_age",
  "metrics_access_control",
  "metrics_expected_names",
  "backup_automation_run_present",
  "backup_automation_run_identity",
  "backup_automation_run_status",
  "backup_automation_run_age",
  "backup_automation_run_steps",
  "backup_automation_checker_output",
  "backup_automation_history_present",
  "backup_automation_history_identity",
  "backup_automation_history_latest_run",
  "backup_automation_history_latest_status",
  "backup_restore_drill_cadence_count",
  "backup_restore_drill_cadence_gap",
  "backup_history_checker_output",
  "backup_scheduler_ownership_present",
  "backup_scheduler_ownership_status",
  "backup_scheduler_ownership_age",
  "backup_scheduler_ownership_schema",
  "backup_scheduler_ownership_source",
  "backup_scheduler_ownership_target_environment",
  "backup_scheduler_ownership_enabled",
  "backup_scheduler_ownership_schedule",
  "backup_scheduler_ownership_command",
  "backup_scheduler_ownership_run_links",
  "backup_scheduler_ownership_owner",
  "observability_apply_proof_present",
  "observability_apply_proof_status",
  "observability_apply_proof_age",
  "observability_apply_proof_schema",
  "observability_apply_proof_source",
  "observability_apply_proof_plan_schema",
  "observability_apply_proof_assets",
  "observability_target_stack_proof_present",
  "observability_target_stack_proof_status",
  "observability_target_stack_proof_age",
  "observability_target_stack_proof_schema",
  "observability_target_stack_proof_source",
  "observability_target_stack_proof_release_identity",
  "observability_target_stack_proof_target_environment",
  "observability_target_stack_prometheus_rules",
  "observability_target_stack_grafana_dashboard",
  "observability_target_stack_alertmanager_receiver",
  "alert_present",
  "alert_status",
  "alert_age",
  "alert_delivered",
  "dashboard_present",
  "dashboard_status",
  "dashboard_age",
  "dashboard_reference",
  "dashboard_owner",
  "log_pipeline_present",
  "log_pipeline_status",
  "log_pipeline_age",
  "log_retention",
  "log_redaction_spot_check",
  "no_sensitive_evidence_values"
];
const requiredOperatorAccessEvidenceChecks = [
  "non_dry_run",
  "not_template",
  "status_final",
  "release_identity",
  "environment",
  "public_base_url",
  "session_create_present",
  "session_create_status",
  "session_cookie_flags",
  "session_secret_not_returned",
  "session_policy_present",
  "session_policy_enforced",
  "project_scope_present",
  "project_scope_enforced",
  "session_rotation_present",
  "session_rotation_status",
  "session_rotation_cookie_flags",
  "session_rotation_secret_not_returned",
  "session_rotation_csrf_enforced",
  "session_rotation_old_cookie_rejected",
  "session_revoke_present",
  "session_revoke_status",
  "csrf_present",
  "csrf_enforced",
  "bearer_precedence_present",
  "bearer_precedence_enforced",
  "actor_attribution_present",
  "actor_attribution_enforced",
  "browser_token_fallback_present",
  "browser_token_fallback_posture",
  "browser_token_fallback_exception_documented",
  "browser_token_fallback_local_storage_disabled",
  "browser_token_fallback_age",
  "emergency_cutoff_present",
  "emergency_cutoff_global",
  "emergency_cutoff_project",
  "emergency_cutoff_cookie_only_rejected",
  "emergency_cutoff_low_scope_bearer",
  "emergency_cutoff_old_cookie_rejected",
  "negative_evidence_present",
  "no_raw_secrets_stored",
  "no_sensitive_evidence_values",
  "operator",
  "ticket"
];
const requiredNonSessionCredentialEvidenceChecks = [
  "non_dry_run",
  "not_template",
  "status_final",
  "release_identity",
  "environment",
  "operator",
  "ticket",
  "credentials_present",
  "credential_types_supported",
  "credential_owners_and_tickets",
  "credential_status",
  "credential_age",
  "credential_redacted_identifiers",
  "no_raw_credentials_archived",
  "no_sensitive_evidence_values",
  "old_credentials_rejected",
  "new_credentials_accepted",
  "credential_specific_evidence",
  "break_glass_present",
  "break_glass_status",
  "break_glass_age",
  "break_glass_controls",
  "automation_not_claimed"
];
const requiredIngressEvidenceChecks = [...requiredIngressEvidenceCheckNames];
const requiredUpgradeRollbackEvidenceChecks = [
  "non_dry_run",
  "not_template",
  "status_final",
  "no_sensitive_evidence_values",
  "drill_time_order",
  "target_environment",
  "release_identity",
  "version_pair",
  "rollback_version",
  "api_image_digests",
  "worker_image_digests",
  "service_rollback_digest",
  "migration_versions",
  "schema_rollback_compatibility",
  "backup_evidence_passed",
  "release_operations",
  "route_upgrade",
  "route_rollback_restores_previous_artifact",
  "http_rollback_verification",
  "readiness_evidence",
  "metrics_evidence",
  "logs_evidence",
  "alert_evidence",
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

function selectedEvidenceSummaryPassed(selectedEvidence: Record<string, unknown> | undefined, key: string) {
  const summary = nestedObject(selectedEvidence, key);

  return Boolean(
    summary &&
      stringValue(summary.status) &&
      timestampValue(summary.timestamp)
  );
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

function addCheck(checks: ReleaseEvidenceBundleCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function evidenceRootObject(rawEvidence: unknown) {
  if (!isObject(rawEvidence)) {
    return undefined;
  }

  return rawEvidence;
}

interface EvidenceAttachment {
  wrapper?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  sourcePath?: string;
  collectedAt?: string;
  releaseCommit?: string;
}

function releaseCommitFromMetadata(metadata: Record<string, unknown> | undefined) {
  return stringValue(metadata?.commitRef) ?? stringValue(metadata?.commitSha);
}

function attachmentEvidence(candidate: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!candidate) {
    return undefined;
  }

  if (isObject(candidate.evidence)) {
    return candidate.evidence;
  }

  return candidate;
}

function evidenceAttachment(root: Record<string, unknown> | undefined, keys: string[]): EvidenceAttachment {
  if (!root) {
    return {};
  }

  const attachments = nestedObject(root, "attachments");
  const wrapper = keys
    .map((key) => nestedObject(root, key) ?? nestedObject(attachments, key))
    .find(Boolean);
  const metadata = nestedObject(wrapper, "metadata");

  return {
    wrapper,
    evidence: attachmentEvidence(wrapper),
    sourcePath: stringValue(wrapper?.sourcePath) ?? stringValue(metadata?.sourcePath),
    collectedAt: timestampValue(wrapper?.collectedAt) ?? timestampValue(metadata?.collectedAt),
    releaseCommit: stringValue(wrapper?.releaseCommit) ??
      stringValue(wrapper?.commitRef) ??
      stringValue(wrapper?.commitSha) ??
      releaseCommitFromMetadata(metadata)
  };
}

function releaseGateAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["releaseGate", "promotion"]);
}

function promotionEvidence(releaseGate: Record<string, unknown> | undefined) {
  const direct = nestedObject(releaseGate, "promotionEvidence");

  if (direct) {
    return direct;
  }

  return releaseGate && stringValue(releaseGate.gateStatus) ? releaseGate : undefined;
}

function postgresRehearsalAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["postgresRehearsal", "postgres"]);
}

function sourceProviderAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["sourceProviderEvidence", "sourceProvider", "sourceProvenanceEvidence"]);
}

function dockerBuildRehearsalAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["dockerBuildRehearsal", "dockerBuild"]);
}

function artifactAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["artifactEvidence", "releaseArtifactEvidence", "artifact"]);
}

function releaseImageAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["releaseImageEvidence", "releaseImage", "imageEvidence"]);
}

function targetRuntimeAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["targetRuntimeEvidence", "targetRuntime"]);
}

function backupAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["backupEvidence", "backup"]);
}

function observabilityAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["observabilityEvidence", "observability"]);
}

function operatorAccessAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["operatorAccessEvidence", "operatorAccess"]);
}

function nonSessionCredentialAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["nonSessionCredentialEvidence", "credentialEvidence", "nonSessionCredential"]);
}

function ingressAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["ingressEvidence", "ingress"]);
}

function upgradeRollbackAttachment(root: Record<string, unknown> | undefined) {
  return evidenceAttachment(root, ["upgradeRollbackEvidence", "upgradeRollback", "upgradeRollbackDrill"]);
}

function releaseMetadata(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "release") ?? root;
}

function releaseCommitValue(root: Record<string, unknown> | undefined) {
  const release = releaseMetadata(root);

  return stringValue(release?.commitRef) ?? stringValue(release?.commitSha);
}

function releaseRepositoryValue(root: Record<string, unknown> | undefined) {
  const release = releaseMetadata(root);

  return stringValue(release?.repository);
}

function releaseBranchValue(root: Record<string, unknown> | undefined) {
  const release = releaseMetadata(root);

  return stringValue(release?.branch);
}

function evidenceCommitValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(evidence?.releaseCommit) ??
    stringValue(evidence?.commitRef) ??
    stringValue(evidence?.commitSha) ??
    stringValue(nestedValue(evidence, ["release", "commitRef"])) ??
    stringValue(nestedValue(evidence, ["release", "commitSha"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "commitRef"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "releaseCommitRef"]));
}

function evidenceRepositoryValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(evidence?.repository) ??
    stringValue(nestedValue(evidence, ["release", "repository"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "repository"]));
}

function evidenceBranchValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(evidence?.branch) ??
    stringValue(nestedValue(evidence, ["release", "branch"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "branch"]));
}

function evidenceTargetEnvironmentValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(evidence?.targetEnvironment) ??
    stringValue(nestedValue(evidence, ["release", "targetEnvironment"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "targetEnvironment"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "environment"]));
}

function releaseImageSourceCommitValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(evidence, ["source", "commitRef"]));
}

function releaseImageSourceRepositoryValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(evidence, ["source", "repository"]));
}

function releaseImageDigestValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(evidence, ["image", "digest"]));
}

function releaseImageNameValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(evidence, ["image", "name"]));
}

function releaseImageVersionTagValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(evidence, ["image", "versionTag"]));
}

function releaseImageCommitTagValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(evidence, ["image", "commitTag"]));
}

function releaseImageDigestPassed(evidence: Record<string, unknown> | undefined) {
  return sha256DigestPattern.test(releaseImageDigestValue(evidence) ?? "");
}

function targetRuntimeImageBindingEvidence(evidence: Record<string, unknown> | undefined) {
  const selectedEvidenceImageBinding = nestedObject(nestedObject(evidence, "selectedEvidence"), "imageBinding");
  const targetRuntimeSummary = nestedObject(evidence, "targetRuntimeSummary");
  const targetRuntimeSummaryImageBinding = nestedObject(targetRuntimeSummary, "imageBinding");
  const candidates = [selectedEvidenceImageBinding, targetRuntimeSummaryImageBinding, targetRuntimeSummary];

  return candidates.find((candidate) =>
    stringValue(candidate?.expectedDigest) &&
      stringValue(candidate?.apiImageDigest) &&
      stringValue(candidate?.workerImageDigest)
  ) ?? selectedEvidenceImageBinding ?? targetRuntimeSummaryImageBinding ?? targetRuntimeSummary;
}

function targetRuntimeReleaseImageDigestPassed(
  targetRuntime: Record<string, unknown> | undefined,
  releaseImage: Record<string, unknown> | undefined
) {
  const releaseDigest = releaseImageDigestValue(releaseImage);
  const imageBinding = targetRuntimeImageBindingEvidence(targetRuntime);
  const expectedDigest = stringValue(imageBinding?.expectedDigest);
  const apiImageDigest = stringValue(imageBinding?.apiImageDigest);
  const workerImageDigest = stringValue(imageBinding?.workerImageDigest);

  return Boolean(
    releaseDigest &&
      sha256DigestPattern.test(releaseDigest) &&
      expectedDigest === releaseDigest &&
      apiImageDigest === releaseDigest &&
      workerImageDigest === releaseDigest
  );
}

function releaseImageTagsPassed(evidence: Record<string, unknown> | undefined) {
  const imageName = releaseImageNameValue(evidence);
  const versionTag = releaseImageVersionTagValue(evidence);
  const commitTag = releaseImageCommitTagValue(evidence);

  return Boolean(
    imageName &&
      versionTag &&
      commitTag &&
      versionTag.startsWith(`${imageName}:`) &&
      commitTag.startsWith(`${imageName}:`)
  );
}

function releaseImageCommitTagPassed(evidence: Record<string, unknown> | undefined, releaseCommitRef: string | undefined) {
  const commitTag = releaseImageCommitTagValue(evidence);

  return Boolean(releaseCommitRef && commitTag && commitTag.endsWith(`:sha-${releaseCommitRef}`));
}

function releaseImageGithubRunPassed(evidence: Record<string, unknown> | undefined) {
  return Boolean(
    stringValue(nestedValue(evidence, ["github", "runId"])) &&
      stringValue(nestedValue(evidence, ["github", "runAttempt"]))
  );
}

function releaseImageAttestations(evidence: Record<string, unknown> | undefined) {
  return nestedObject(evidence, "attestations");
}

function releaseImageAttestationPredicate(evidence: Record<string, unknown> | undefined, name: "provenance" | "sbom") {
  return nestedObject(releaseImageAttestations(evidence), name);
}

function releaseImageAttestationSubjectPassed(evidence: Record<string, unknown> | undefined) {
  return Boolean(
    releaseImageDigestPassed(evidence) &&
      releaseImageDigestValue(evidence) === stringValue(nestedValue(evidence, ["attestations", "subjectDigest"]))
  );
}

function releaseImageProvenanceAttestationPassed(evidence: Record<string, unknown> | undefined) {
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

function releaseImageSbomAttestationPassed(evidence: Record<string, unknown> | undefined) {
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
  evidence: Record<string, unknown> | undefined,
  now: Date,
  maxEvidenceAgeHours: number
) {
  const attestations = releaseImageAttestations(evidence);

  return Boolean(
    stringValue(attestations?.mode) === "registry" &&
      stringValue(attestations?.inspector) &&
      freshTimestamp(timestampValue(attestations?.inspectedAt), now, maxEvidenceAgeHours)
  );
}

function checkArrayAllPassed(candidate: Record<string, unknown> | undefined) {
  const checks = candidate?.checks;

  if (!Array.isArray(checks)) {
    return false;
  }

  return checks.length > 0 && checks.every((check) => isObject(check) && statusValue(check.status) === "pass");
}

function checkArrayIncludesPassedNames(candidate: Record<string, unknown> | undefined, requiredNames: string[]) {
  const checks = candidate?.checks;

  if (!Array.isArray(checks)) {
    return false;
  }

  const passedNames = new Set(
    checks
      .filter((check) => isObject(check) && statusValue(check.status) === "pass")
      .map((check) => stringValue((check as Record<string, unknown>).name))
      .filter(Boolean)
  );

  return requiredNames.every((name) => passedNames.has(name));
}

function requiredPrerequisitesPassed(candidate: Record<string, unknown> | undefined) {
  const prerequisites = candidate?.prerequisites;

  if (!Array.isArray(prerequisites)) {
    return false;
  }

  return prerequisites.every((check) => {
    if (!isObject(check) || check.required !== true) {
      return true;
    }

    return statusValue(check.status) === "passed";
  });
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter(Boolean) as string[])];
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

function normalizedToken(value: unknown) {
  return stringValue(value)?.toLowerCase().replace(/[\s-]+/g, "_");
}

function numberValue(value: unknown) {
  const candidate = typeof value === "number" ? value : Number(value);

  return Number.isFinite(candidate) ? candidate : undefined;
}

function positiveIntegerEvidenceValue(value: unknown) {
  const candidate = numberValue(value);

  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
}

function runtimeControlStatusPass(runtimeEnv: Record<string, unknown> | undefined, statusKey: string, valueKey: string) {
  return statusValue(runtimeEnv?.[statusKey]) === "pass" && positiveIntegerEvidenceValue(runtimeEnv?.[valueKey]);
}

function runtimeResourceControlsPass(runtimeEnv: Record<string, unknown> | undefined) {
  return runtimeControlStatusPass(runtimeEnv, "buildMaxArtifactBytesStatus", "buildMaxArtifactBytes") &&
    runtimeControlStatusPass(runtimeEnv, "buildMaxArtifactFilesStatus", "buildMaxArtifactFiles") &&
    runtimeControlStatusPass(runtimeEnv, "buildMinFreeBytesStatus", "buildMinFreeBytes") &&
    runtimeControlStatusPass(runtimeEnv, "prebuiltMaxUploadBytesStatus", "prebuiltMaxUploadBytes") &&
    runtimeControlStatusPass(runtimeEnv, "prebuiltMaxFilesStatus", "prebuiltMaxFiles") &&
    runtimeControlStatusPass(runtimeEnv, "buildStepTimeoutStatus", "buildStepTimeoutMs") &&
    runtimeControlStatusPass(runtimeEnv, "gitTimeoutStatus", "gitTimeoutMs") &&
    statusValue(runtimeEnv?.buildNetworkStatus) === "pass" &&
    stringValue(runtimeEnv?.buildNetwork)?.toLowerCase() === "none";
}

function firstNestedObject(candidate: Record<string, unknown> | undefined, paths: string[][]) {
  for (const path of paths) {
    const value = nestedValue(candidate, path);

    if (isObject(value)) {
      return value;
    }
  }

  return undefined;
}

function ingressDeploymentTopology(ingress: Record<string, unknown> | undefined) {
  return firstNestedObject(ingress, [
    ["selectedEvidence", "deploymentTopology"],
    ["selectedEvidence", "topology"],
    ["deploymentTopology"],
    ["topology"]
  ]);
}

function ingressApiRateLimitEvidence(ingress: Record<string, unknown> | undefined) {
  return firstNestedObject(ingress, [
    ["selectedEvidence", "apiRateLimit"],
    ["apiRateLimit"],
    ["selectedEvidence", "rateLimit"],
    ["rateLimit"]
  ]);
}

function topologyPositiveIntegerCount(topology: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = numberValue(topology[key]);

    if (value !== undefined && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

function topologyHasCompleteCounts(topology: Record<string, unknown>) {
  return Boolean(
    topologyPositiveIntegerCount(topology, apiInstanceCountKeys) &&
      topologyPositiveIntegerCount(topology, apiProcessCountKeys) &&
      topologyPositiveIntegerCount(topology, ingressCountKeys)
  );
}

function topologyHasCompleteMultiFlags(topology: Record<string, unknown>) {
  return topologyMultiFlagKeys.every((key) => typeof topology[key] === "boolean");
}

function topologyHasDeclaredShape(topology: Record<string, unknown> | undefined) {
  return Boolean(topology && (topologyHasCompleteCounts(topology) || topologyHasCompleteMultiFlags(topology)));
}

function topologyClaimsMultipleExecutionContexts(topology: Record<string, unknown> | undefined) {
  if (!topology) {
    return false;
  }

  return (
    topologyHasCompleteMultiFlags(topology) &&
      (topology.multiInstance === true || topology.multiProcess === true || topology.multiIngress === true)
  ) ||
    (
      topologyHasCompleteCounts(topology) &&
        (
          Number(topologyPositiveIntegerCount(topology, apiInstanceCountKeys)) > 1 ||
            Number(topologyPositiveIntegerCount(topology, apiProcessCountKeys)) > 1 ||
            Number(topologyPositiveIntegerCount(topology, ingressCountKeys)) > 1
        )
    );
}

function rateLimitSharedOrEdgeEnforced(rateLimit: Record<string, unknown> | undefined) {
  if (!rateLimit) {
    return false;
  }

  const limiterScope = normalizedToken(rateLimit.limiterScope) ?? normalizedToken(rateLimit.scope);
  const limiterType = normalizedToken(rateLimit.limiterType) ?? normalizedToken(rateLimit.type);
  const enforcementPoint = normalizedToken(rateLimit.enforcementPoint) ?? normalizedToken(rateLimit.enforcedAt);

  return rateLimit.edgeEnforced === true ||
    rateLimit.sharedAcrossInstances === true ||
    ["edge", "shared", "global", "distributed"].includes(limiterScope ?? "") ||
    ["edge", "shared", "global", "distributed"].includes(limiterType ?? "") ||
    ["edge", "proxy", "load_balancer", "gateway", "ingress", "cdn"].includes(enforcementPoint ?? "");
}

function rateLimitProcessLocalOnly(rateLimit: Record<string, unknown> | undefined) {
  if (!rateLimit) {
    return false;
  }

  const limiterScope = normalizedToken(rateLimit.limiterScope) ?? normalizedToken(rateLimit.scope);
  const limiterType = normalizedToken(rateLimit.limiterType) ?? normalizedToken(rateLimit.type);

  return !rateLimitSharedOrEdgeEnforced(rateLimit) &&
    (
      rateLimit.processLocalOnly === true ||
      rateLimit.processLocal === true ||
      rateLimit.processLocalLimiter === true ||
      ["process_local", "process", "local", "memory", "in_memory"].includes(limiterScope ?? "") ||
      ["process_local", "process", "local", "memory", "in_memory"].includes(limiterType ?? "")
    );
}

export function ingressTopologyRateLimitEvidencePassed(ingress: Record<string, unknown> | undefined) {
  const topology = ingressDeploymentTopology(ingress);
  const rateLimit = ingressApiRateLimitEvidence(ingress);
  const topologyDeclared = topologyHasDeclaredShape(topology);
  const multipleExecutionContexts = topologyClaimsMultipleExecutionContexts(topology);
  const sharedOrEdgeLimiter = rateLimitSharedOrEdgeEnforced(rateLimit);
  const processLocalOnlyLimiter = rateLimitProcessLocalOnly(rateLimit);

  return {
    topologyDeclared,
    multipleExecutionContexts,
    sharedOrEdgeLimiter,
    processLocalOnlyLimiter,
    passed: topologyDeclared && (!multipleExecutionContexts || sharedOrEdgeLimiter) && !(multipleExecutionContexts && processLocalOnlyLimiter)
  };
}

function artifactManifestCandidates(artifact: Record<string, unknown> | undefined) {
  const selectedEvidence = nestedObject(artifact, "selectedEvidence");

  return [
    nestedObject(artifact, "artifactManifest"),
    nestedObject(artifact, "deploymentArtifactManifest"),
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
  artifacts: unknown,
  selectedEvidence: Record<string, unknown> | undefined
) {
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
    Number(selectedEvidence?.totalBytes) === totalBytes;
}

function bundleTargetEnvironment(root: Record<string, unknown> | undefined) {
  return stringValue(root?.targetEnvironment) ??
    stringValue(nestedValue(root, ["release", "targetEnvironment"])) ??
    stringValue(nestedValue(root, ["selectedEvidence", "targetEnvironment"]));
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

function artifactFunctionRuntimeIsolationPassed(
  artifact: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined
) {
  if (bundleTargetEnvironment(root) !== "production") {
    return true;
  }

  const manifests = artifactManifestCandidates(artifact);

  return manifests.length > 0 && manifests.every(manifestDeclaresIsolatedFunctionRuntime);
}

function postgresScenarioResultsPassed(candidate: Record<string, unknown> | undefined) {
  const results = candidate?.scenarioResults;

  if (!Array.isArray(results)) {
    return false;
  }

  const passedScopes = new Set(
    results
      .filter((result) => isObject(result) && statusValue(result.status) === "passed")
      .map((result) => stringValue((result as Record<string, unknown>).scope))
      .filter(Boolean)
  );
  const failedRequiredScope = results.some((result) => (
    isObject(result) &&
      statusValue(result.status) === "failed" &&
      requiredPostgresRehearsalScopes.includes(stringValue(result.scope) ?? "")
  ));

  return !failedRequiredScope && requiredPostgresRehearsalScopes.every((scope) => passedScopes.has(scope));
}

function arrayMatchesStrings(candidate: unknown, expected: string[]) {
  return Array.isArray(candidate) &&
    candidate.length === expected.length &&
    expected.every((value, index) => candidate[index] === value);
}

function dockerBuildProfilePassed(candidate: Record<string, unknown> | undefined) {
  const docker = nestedObject(candidate, "docker");
  const artifactLimits = nestedObject(candidate, "artifactLimits");

  return Boolean(
    candidate?.name === "siteflow-docker-build-rehearsal" &&
      candidate?.buildRunner === "docker" &&
      requiredPrerequisitesPassed(candidate) &&
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
  );
}

function dockerBuildArtifactPassed(candidate: Record<string, unknown> | undefined) {
  const artifactFileCount = nestedValue(candidate, ["artifact", "fileCount"]);
  const artifactTotalBytes = nestedValue(candidate, ["artifact", "totalBytes"]);
  const maxArtifactFiles = nestedValue(candidate, ["artifactLimits", "maxArtifactFiles"]);
  const maxArtifactBytes = nestedValue(candidate, ["artifactLimits", "maxArtifactBytes"]);

  return Boolean(
    stringValue(nestedValue(candidate, ["artifact", "entrypoint"])) &&
      typeof artifactFileCount === "number" &&
      Number(artifactFileCount) > 0 &&
      typeof artifactTotalBytes === "number" &&
      Number(artifactTotalBytes) > 0 &&
      typeof maxArtifactFiles === "number" &&
      Number(maxArtifactFiles) > 0 &&
      Number(artifactFileCount) <= Number(maxArtifactFiles) &&
      typeof maxArtifactBytes === "number" &&
      Number(maxArtifactBytes) > 0 &&
      Number(artifactTotalBytes) <= Number(maxArtifactBytes) &&
      stringValue(nestedValue(candidate, ["artifact", "checksum"])) &&
      candidate?.redactionVerified === true
  );
}

function selectedCommitRef(
  root: Record<string, unknown> | undefined,
  promotion: Record<string, unknown> | undefined,
  options: ReleaseEvidenceBundleCheckOptions
) {
  return (
    options.commitRef ??
    releaseCommitValue(root) ??
    stringValue(root?.commitRef) ??
    stringValue(root?.commitSha) ??
    stringValue(promotion?.commitRef) ??
    stringValue(nestedValue(promotion, ["commitStatus", "commitRef"]))
  );
}

function selectedRepository(
  root: Record<string, unknown> | undefined,
  promotion: Record<string, unknown> | undefined,
  options: ReleaseEvidenceBundleCheckOptions
) {
  const release = releaseMetadata(root);

  return (
    options.repo ??
    stringValue(release?.repository) ??
    stringValue(root?.repository) ??
    stringValue(promotion?.repository) ??
    stringValue(nestedValue(promotion, ["commitStatus", "repository"])) ??
    stringValue(nestedValue(promotion, ["branchProtection", "repository"]))
  );
}

function selectedBranch(
  root: Record<string, unknown> | undefined,
  promotion: Record<string, unknown> | undefined,
  options: ReleaseEvidenceBundleCheckOptions
) {
  const release = releaseMetadata(root);

  return (
    options.branch ??
    stringValue(release?.branch) ??
    stringValue(root?.branch) ??
    stringValue(promotion?.branch) ??
    stringValue(nestedValue(promotion, ["branchProtection", "branch"]))
  );
}

function hostBuildExceptionAccepted(root: Record<string, unknown> | undefined, options: ReleaseEvidenceBundleCheckOptions) {
  return Boolean(
    options.allowHostBuildException ||
      root?.hostBuildExceptionAccepted === true ||
      nestedValue(root, ["release", "hostBuildExceptionAccepted"]) === true
  );
}

function dockerSocketProfileAccepted(root: Record<string, unknown> | undefined) {
  return Boolean(
    root?.dockerSocketProfileAccepted === true ||
      nestedValue(root, ["release", "dockerSocketProfileAccepted"]) === true
  );
}

function attachmentMetadataPassed(attachment: EvidenceAttachment, releaseCommitRef: string | undefined) {
  return Boolean(
    attachment.wrapper &&
      attachment.sourcePath &&
      attachment.collectedAt &&
      attachment.releaseCommit &&
      releaseCommitRef &&
      attachment.releaseCommit === releaseCommitRef
  );
}

function attachmentFresh(attachment: EvidenceAttachment, now: Date, maxAgeHours: number) {
  return freshTimestamp(attachment.collectedAt, now, maxAgeHours);
}

function timestampNotAfter(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && Date.parse(left) <= Date.parse(right));
}

function evidenceBeforeAttachment(evidenceTimestamp: string | undefined, attachment: EvidenceAttachment) {
  return timestampNotAfter(evidenceTimestamp, attachment.collectedAt);
}

function attachmentBeforeBundle(attachment: EvidenceAttachment, bundleCheckedAt: string | undefined) {
  return timestampNotAfter(attachment.collectedAt, bundleCheckedAt);
}

export function evaluateReleaseEvidenceBundle(
  rawEvidence: unknown,
  options: ReleaseEvidenceBundleCheckOptions
): ReleaseEvidenceBundleResult {
  const now = options.now?.() ?? new Date();
  const maxEvidenceAgeHours = positiveNumber(
    options.maxEvidenceAgeHours,
    defaultMaxEvidenceAgeHours,
    "maxEvidenceAgeHours"
  );
  const root = evidenceRootObject(rawEvidence);
  const bundleCheckedAt = timestampValue(root?.checkedAt);
  const releaseGateAttachmentEvidence = releaseGateAttachment(root);
  const dockerBuildAttachmentEvidence = dockerBuildRehearsalAttachment(root);
  const postgresAttachmentEvidence = postgresRehearsalAttachment(root);
  const artifactAttachmentEvidence = artifactAttachment(root);
  const releaseImageAttachmentEvidence = releaseImageAttachment(root);
  const targetRuntimeAttachmentEvidence = targetRuntimeAttachment(root);
  const sourceProviderAttachmentEvidence = sourceProviderAttachment(root);
  const backupAttachmentEvidence = backupAttachment(root);
  const observabilityAttachmentEvidence = observabilityAttachment(root);
  const operatorAccessAttachmentEvidence = operatorAccessAttachment(root);
  const nonSessionCredentialAttachmentEvidence = nonSessionCredentialAttachment(root);
  const ingressAttachmentEvidence = ingressAttachment(root);
  const upgradeRollbackAttachmentEvidence = upgradeRollbackAttachment(root);
  const releaseGate = releaseGateAttachmentEvidence.evidence;
  const promotion = promotionEvidence(releaseGate);
  const dockerBuild = dockerBuildAttachmentEvidence.evidence;
  const postgres = postgresAttachmentEvidence.evidence;
  const artifact = artifactAttachmentEvidence.evidence;
  const releaseImage = releaseImageAttachmentEvidence.evidence;
  const targetRuntime = targetRuntimeAttachmentEvidence.evidence;
  const targetRuntimeSelectedEvidence = nestedObject(targetRuntime, "selectedEvidence");
  const sourceProvider = sourceProviderAttachmentEvidence.evidence;
  const backup = backupAttachmentEvidence.evidence;
  const observability = observabilityAttachmentEvidence.evidence;
  const operatorAccess = operatorAccessAttachmentEvidence.evidence;
  const nonSessionCredential = nonSessionCredentialAttachmentEvidence.evidence;
  const ingress = ingressAttachmentEvidence.evidence;
  const upgradeRollback = upgradeRollbackAttachmentEvidence.evidence;
  const ingressTopologyRateLimit = ingressTopologyRateLimitEvidencePassed(ingress);
  const releaseCommitRef = selectedCommitRef(root, promotion, options);
  const repository = selectedRepository(root, promotion, options);
  const branch = selectedBranch(root, promotion, options);
  const rootTargetEnvironment = stringValue(root?.targetEnvironment);
  const releaseTargetEnvironment = stringValue(nestedValue(root, ["release", "targetEnvironment"]));
  const expectedTargetEnvironment = stringValue(options.targetEnvironment);
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const commitRefs = uniqueStrings([
    releaseCommitRef,
    releaseCommitValue(root),
    stringValue(root?.commitRef),
    stringValue(root?.commitSha),
    stringValue(promotion?.commitRef),
    stringValue(nestedValue(promotion, ["commitStatus", "commitRef"])),
    releaseGateAttachmentEvidence.releaseCommit,
    dockerBuildAttachmentEvidence.releaseCommit,
    postgresAttachmentEvidence.releaseCommit,
    artifactAttachmentEvidence.releaseCommit,
    releaseImageAttachmentEvidence.releaseCommit,
    targetRuntimeAttachmentEvidence.releaseCommit,
    sourceProviderAttachmentEvidence.releaseCommit,
    backupAttachmentEvidence.releaseCommit,
    observabilityAttachmentEvidence.releaseCommit,
    operatorAccessAttachmentEvidence.releaseCommit,
    nonSessionCredentialAttachmentEvidence.releaseCommit,
    ingressAttachmentEvidence.releaseCommit,
    upgradeRollbackAttachmentEvidence.releaseCommit,
    evidenceCommitValue(dockerBuild),
    evidenceCommitValue(postgres),
    releaseImageSourceCommitValue(releaseImage),
    evidenceCommitValue(targetRuntime),
    evidenceCommitValue(sourceProvider),
    evidenceCommitValue(backup),
    evidenceCommitValue(observability),
    evidenceCommitValue(operatorAccess),
    evidenceCommitValue(nonSessionCredential),
    evidenceCommitValue(ingress),
    evidenceCommitValue(upgradeRollback)
  ]);
  const repositories = uniqueStrings([
    repository,
    releaseRepositoryValue(root),
    stringValue(root?.repository),
    stringValue(promotion?.repository),
    stringValue(nestedValue(promotion, ["commitStatus", "repository"])),
    stringValue(nestedValue(promotion, ["branchProtection", "repository"])),
    releaseImageSourceRepositoryValue(releaseImage),
    evidenceRepositoryValue(targetRuntime),
    evidenceRepositoryValue(dockerBuild),
    evidenceRepositoryValue(postgres),
    evidenceRepositoryValue(sourceProvider),
    evidenceRepositoryValue(backup),
    evidenceRepositoryValue(observability),
    evidenceRepositoryValue(operatorAccess),
    evidenceRepositoryValue(nonSessionCredential),
    evidenceRepositoryValue(ingress),
    evidenceRepositoryValue(upgradeRollback)
  ]);
  const branches = uniqueStrings([
    branch,
    releaseBranchValue(root),
    stringValue(root?.branch),
    stringValue(promotion?.branch),
    stringValue(nestedValue(promotion, ["branchProtection", "branch"])),
    evidenceBranchValue(dockerBuild),
    evidenceBranchValue(postgres),
    evidenceBranchValue(targetRuntime),
    evidenceBranchValue(sourceProvider),
    evidenceBranchValue(backup),
    evidenceBranchValue(observability),
    evidenceBranchValue(operatorAccess),
    evidenceBranchValue(nonSessionCredential),
    evidenceBranchValue(ingress),
    evidenceBranchValue(upgradeRollback)
  ]);
  const requiredStatusCheck = stringValue(promotion?.requiredStatusCheck);
  const releaseRequiredStatusCheck = stringValue(releaseMetadata(root)?.requiredStatusCheck) ?? requiredStatusCheck;
  const protectedChecks = nestedValue(promotion, ["branchProtection", "requiredStatusChecks"]);
  const protectedBranchCommit = nestedObject(promotion, "protectedBranchCommit");
  const runtimeEnv = nestedObject(promotion, "runtimeEnv");
  const commitCheckRun = nestedObject(nestedObject(promotion, "commitStatus"), "checkRun");
  const dockerBuildRequired = runtimeEnv?.buildRunner === "docker";
  const releaseGateCheckedAt = timestampValue(releaseGate?.checkedAt) ?? timestampValue(promotion?.checkedAt);
  const dockerBuildCompletedAt = timestampValue(dockerBuild?.completedAt);
  const dockerBuildImage = stringValue(nestedValue(dockerBuild, ["docker", "image"]));
  const postgresCompletedAt = timestampValue(postgres?.completedAt);
  const postgresTargetDatabase = nestedObject(postgres, "targetDatabase");
  const artifactCheckedAt = timestampValue(artifact?.checkedAt);
  const artifactSelectedEvidence = nestedObject(artifact, "selectedEvidence");
  const artifactManifestArtifacts = nestedValue(artifact, ["manifest", "artifacts"]);
  const releaseImageCheckedAt = timestampValue(releaseImage?.checkedAt);
  const targetRuntimeCheckedAt = timestampValue(targetRuntime?.checkedAt);
  const sourceProviderCheckedAt = timestampValue(sourceProvider?.checkedAt);
  const backupCheckedAt = timestampValue(backup?.checkedAt);
  const observabilityCheckedAt = timestampValue(observability?.checkedAt);
  const operatorAccessCheckedAt = timestampValue(operatorAccess?.checkedAt);
  const nonSessionCredentialCheckedAt = timestampValue(nonSessionCredential?.checkedAt);
  const ingressCheckedAt = timestampValue(ingress?.checkedAt);
  const upgradeRollbackCheckedAt = timestampValue(upgradeRollback?.checkedAt);
  const dashboardTimestamp = timestampValue(nestedValue(observability, ["selectedEvidence", "dashboard", "timestamp"]));
  const checks: ReleaseEvidenceBundleCheck[] = [];

  addCheck(checks, "bundle_shape", Boolean(root), "Release evidence bundle must be a JSON object.");
  addCheck(
    checks,
    "schema_version",
    root?.schemaVersion === expectedSchemaVersion,
    `Release evidence bundle schemaVersion must be ${expectedSchemaVersion}.`
  );
  addCheck(
    checks,
    "bundle_name",
    root?.name === expectedBundleName,
    `Release evidence bundle name must be ${expectedBundleName}.`
  );
  addCheck(
    checks,
    "bundle_no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Release evidence bundle must not include raw secret-like values."
      : `Release evidence bundle includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );
  addCheck(
    checks,
    "bundle_checked_at",
    freshTimestamp(bundleCheckedAt, now, maxEvidenceAgeHours),
    `Release evidence bundle checkedAt must be valid and no older than ${maxEvidenceAgeHours} hours.`
  );
  addCheck(
    checks,
    "target_environment",
    Boolean(
      rootTargetEnvironment &&
        (!releaseTargetEnvironment || releaseTargetEnvironment === rootTargetEnvironment) &&
        (!expectedTargetEnvironment || rootTargetEnvironment === expectedTargetEnvironment)
    ),
    expectedTargetEnvironment
      ? `Release evidence bundle targetEnvironment must be ${expectedTargetEnvironment}.`
      : "Release evidence bundle must include targetEnvironment and any release targetEnvironment must match it."
  );
  addCheck(
    checks,
    "release_required_status_check",
    Boolean(releaseRequiredStatusCheck && requiredStatusCheck && releaseRequiredStatusCheck === requiredStatusCheck),
    "Release required status check must be present and match promotion evidence."
  );
  addCheck(checks, "release_gate_present", Boolean(releaseGate && promotion), "Release gate promotion evidence must be present.");
  addCheck(
    checks,
    "release_gate_attachment",
    attachmentMetadataPassed(releaseGateAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(releaseGateAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(releaseGateCheckedAt, releaseGateAttachmentEvidence) &&
      attachmentBeforeBundle(releaseGateAttachmentEvidence, bundleCheckedAt),
    "Release gate attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "release_gate_age",
    freshTimestamp(releaseGateCheckedAt, now, maxEvidenceAgeHours),
    `Release gate raw evidence checkedAt must be present and no older than ${maxEvidenceAgeHours} hours.`
  );
  addCheck(
    checks,
    "release_gate_passed",
    statusValue(releaseGate?.status) === "pass" && statusValue(promotion?.gateStatus) === "pass",
    "Release gate status and promotionEvidence.gateStatus must both be pass."
  );
  addCheck(checks, "promotion_mode", promotion?.promotion === true, "Release gate evidence must be from promotion mode.");
  addCheck(
    checks,
    "no_manual_required",
    promotion?.manualRequired === false && Array.isArray(promotion.manualRequiredCheckIds) && promotion.manualRequiredCheckIds.length === 0,
    "Promotion evidence must not contain manual_required checks."
  );
  addCheck(
    checks,
    "branch_protection",
    statusValue(nestedValue(promotion, ["branchProtection", "status"])) === "pass",
    "GitHub branch protection evidence must pass."
  );
  addCheck(
    checks,
    "protected_branch_commit",
    statusValue(protectedBranchCommit?.status) === "pass" &&
      stringValue(protectedBranchCommit?.commitRef) === releaseCommitRef &&
      stringValue(protectedBranchCommit?.branchHeadSha) === releaseCommitRef &&
      (!releaseBranchValue(root) || stringValue(protectedBranchCommit?.branch) === releaseBranchValue(root)),
    "GitHub protected branch head evidence must pass and match the exact release commit."
  );
  addCheck(
    checks,
    "commit_status",
    statusValue(nestedValue(promotion, ["commitStatus", "status"])) === "pass",
    "Exact release commit status evidence must pass."
  );
  addCheck(
    checks,
    "required_status_check",
    Boolean(
      requiredStatusCheck &&
        Array.isArray(protectedChecks) &&
        protectedChecks.some((check) => check === requiredStatusCheck)
    ),
    "Branch protection evidence must include the required status check."
  );
  addCheck(
    checks,
    "commit_check_run",
    commitCheckRun?.name === requiredStatusCheck &&
      commitCheckRun?.status === "completed" &&
      commitCheckRun?.conclusion === "success",
    "Exact commit check-run evidence must match the required status check and be completed successfully."
  );
  addCheck(
    checks,
    "runtime_env",
    statusValue(runtimeEnv?.status) === "pass",
    "Promotion runtime env evidence must pass."
  );
  addCheck(
    checks,
    "metrics_runtime",
    runtimeEnv?.metricsTokenConfigured === true || runtimeEnv?.unauthenticatedMetricsAllowed === true,
    "Runtime env evidence must configure metrics auth or an explicit private-scrape exception."
  );
  addCheck(
    checks,
    "api_token_strength",
    statusValue(runtimeEnv?.apiTokenStrengthStatus) === "pass",
    "Runtime env evidence must show SITEFLOW_API_TOKEN passed production strength checks."
  );
  addCheck(
    checks,
    "metrics_token_strength",
    statusValue(runtimeEnv?.metricsTokenStrengthStatus) === "pass" ||
      (statusValue(runtimeEnv?.metricsTokenStrengthStatus) === "skipped" && runtimeEnv?.unauthenticatedMetricsAllowed === true),
    "Runtime env evidence must show SITEFLOW_METRICS_TOKEN passed production strength checks, unless a private-scrape exception is explicit."
  );
  addCheck(
    checks,
    "app_secret_strength",
    statusValue(runtimeEnv?.appSecretStrengthStatus) === "pass" &&
      (
        runtimeEnv?.appSecretSource === "SITEFLOW_APP_SECRET" ||
        runtimeEnv?.appSecretSource === "SITEFLOW_APP_SECRET_FILE" ||
        runtimeEnv?.appSecretSource === "SITEFLOW_SEALING_KEY" ||
        runtimeEnv?.appSecretSource === "SITEFLOW_SEALING_KEY_FILE"
      ),
    "Runtime env evidence must show SITEFLOW_APP_SECRET, SITEFLOW_APP_SECRET_FILE, SITEFLOW_SEALING_KEY, or SITEFLOW_SEALING_KEY_FILE passed production strength checks."
  );
  addCheck(
    checks,
    "browser_token_fallback_runtime",
    statusValue(runtimeEnv?.browserTokenFallbackStatus) === "pass" &&
      runtimeEnv?.browserTokenFallbackEnabled === false,
    "Runtime env evidence must show production browser token storage fallback is disabled."
  );
  addCheck(
    checks,
    "source_build_posture",
    statusValue(runtimeEnv?.sourceBuildPostureStatus) === "pass",
    "Runtime env evidence must pass source build posture checks."
  );
  addCheck(
    checks,
    "build_image_policy",
    statusValue(runtimeEnv?.buildImagePolicyStatus) === "pass" ||
      (runtimeEnv?.hostBuildException === true && hostBuildExceptionAccepted(root, options)),
    "Runtime env evidence must pass Docker build image policy, unless a host build exception is explicitly accepted."
  );
  addCheck(
    checks,
    "runtime_resource_controls",
    runtimeResourceControlsPass(runtimeEnv),
    "Runtime env evidence must include passing explicit artifact budgets, build storage preflight bytes, prebuilt upload budgets, build/Git timeouts, and SITEFLOW_BUILD_NETWORK=none."
  );
  addCheck(
    checks,
    "clean_worktree",
    statusValue(nestedValue(promotion, ["dirtyWorktree", "status"])) === "pass" &&
      nestedValue(promotion, ["dirtyWorktree", "dirty"]) === false,
    "Promotion evidence must come from a clean worktree."
  );
  addCheck(
    checks,
    "clean_worktree_entries",
    Array.isArray(nestedValue(promotion, ["dirtyWorktree", "entries"])) &&
      (nestedValue(promotion, ["dirtyWorktree", "entries"]) as unknown[]).length === 0,
    "Promotion evidence must not list dirty worktree entries."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_present",
    !dockerBuildRequired || Boolean(dockerBuild),
    "Docker build rehearsal evidence must be present when promotion runtime env uses SITEFLOW_BUILD_RUNNER=docker."
  );
  addCheck(
    checks,
    "docker_socket_profile_acceptance",
    !dockerBuildRequired || dockerSocketProfileAccepted(root),
    "Release evidence must explicitly accept the trusted single-host Docker socket profile when SITEFLOW_BUILD_RUNNER=docker."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_attachment",
    !dockerBuildRequired || (
      attachmentMetadataPassed(dockerBuildAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(dockerBuildAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(dockerBuildCompletedAt, dockerBuildAttachmentEvidence) &&
      attachmentBeforeBundle(dockerBuildAttachmentEvidence, bundleCheckedAt)
    ),
    "Docker build rehearsal attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_passed",
    !dockerBuildRequired || (
      statusValue(dockerBuild?.status) === "passed" &&
      dockerBuild?.dryRun === false &&
      dockerBuild?.exitCode === 0
    ),
    "Docker build rehearsal evidence must be a non-dry-run passed rehearsal."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_age",
    !dockerBuildRequired || freshTimestamp(dockerBuildCompletedAt, now, maxEvidenceAgeHours),
    `Docker build rehearsal evidence must be no older than ${maxEvidenceAgeHours} hours.`
  );
  addCheck(
    checks,
    "docker_build_rehearsal_release_identity",
    !dockerBuildRequired || Boolean(evidenceCommitValue(dockerBuild) && evidenceRepositoryValue(dockerBuild) && evidenceBranchValue(dockerBuild)),
    "Docker build rehearsal evidence must be bound to the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_image",
    !dockerBuildRequired || Boolean(dockerBuildImage && dockerBuildImage === runtimeEnv?.buildImage),
    "Docker build rehearsal image must match promotion runtime env build image."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_profile",
    !dockerBuildRequired || dockerBuildProfilePassed(dockerBuild),
    "Docker build rehearsal evidence must prove Docker runner profile, daemon availability, image policy, network, and resource limits."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_commands",
    !dockerBuildRequired || arrayMatchesStrings(dockerBuild?.buildCommands, requiredDockerBuildCommands),
    "Docker build rehearsal evidence must run the expected npm ci and npm run build commands."
  );
  addCheck(
    checks,
    "docker_build_rehearsal_artifact",
    !dockerBuildRequired || dockerBuildArtifactPassed(dockerBuild),
    "Docker build rehearsal evidence must include a published artifact summary with checksum/bytes and verified log redaction."
  );
  addCheck(
    checks,
    "commit_present",
    Boolean(releaseCommitRef && stringValue(promotion?.commitRef) && stringValue(nestedValue(promotion, ["commitStatus", "commitRef"]))),
    "Release bundle must include a release commit and matching promotion commit refs."
  );
  addCheck(
    checks,
    "commit_consistency",
    commitRefs.length === 1,
    "Release commit refs must be consistent across the bundle, promotion evidence, attachments, raw evidence, and commit status evidence."
  );
  addCheck(
    checks,
    "repository_consistency",
    Boolean(repository) && repositories.length === 1,
    "Repository must be present and consistent across release metadata, promotion evidence, and raw evidence."
  );
  addCheck(
    checks,
    "branch_consistency",
    Boolean(branch) && branches.length === 1,
    "Branch must be present and consistent across release metadata, promotion evidence, and raw evidence."
  );

  addCheck(checks, "postgres_present", Boolean(postgres), "Postgres rehearsal evidence must be present.");
  addCheck(
    checks,
    "postgres_attachment",
    attachmentMetadataPassed(postgresAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(postgresAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(postgresCompletedAt, postgresAttachmentEvidence) &&
      attachmentBeforeBundle(postgresAttachmentEvidence, bundleCheckedAt),
    "Postgres rehearsal attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "postgres_passed",
    statusValue(postgres?.status) === "passed" && postgres?.dryRun === false && postgres?.exitCode === 0,
    "Postgres rehearsal evidence must be a non-dry-run passed rehearsal."
  );
  addCheck(
    checks,
    "postgres_prerequisites",
    requiredPrerequisitesPassed(postgres),
    "Required Postgres rehearsal prerequisites must have passed."
  );
  addCheck(
    checks,
    "postgres_release_identity",
    Boolean(evidenceCommitValue(postgres) && evidenceRepositoryValue(postgres) && evidenceBranchValue(postgres)),
    "Postgres rehearsal evidence must be bound to the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "postgres_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(postgres) === rootTargetEnvironment),
    "Postgres rehearsal evidence targetEnvironment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "postgres_target_database",
    Boolean(
      statusValue(postgresTargetDatabase?.parseStatus) === "passed" &&
        stringValue(postgresTargetDatabase?.redactedUrl) &&
        !stringValue(postgresTargetDatabase?.redactedUrl)?.includes("@") &&
        stringValue(postgresTargetDatabase?.host) &&
        stringValue(postgresTargetDatabase?.database)
    ),
    "Postgres rehearsal evidence must include redacted target database metadata without URL credentials."
  );
  addCheck(
    checks,
    "postgres_rehearsal_scope",
    arrayIncludesAllStrings(postgres?.rehearsalScope, requiredPostgresRehearsalScopes),
    "Postgres rehearsal evidence must cover migrations, checksum drift, SKIP LOCKED, concurrent worker claims, heartbeat, stale recovery, and exhausted lease failure."
  );
  addCheck(
    checks,
    "postgres_scenario_results",
    postgresScenarioResultsPassed(postgres),
    "Postgres rehearsal evidence must include passed scenarioResults for every required migration and queue scope."
  );
  addCheck(
    checks,
    "postgres_age",
    freshTimestamp(timestampValue(postgres?.completedAt), now, maxEvidenceAgeHours),
    `Postgres rehearsal evidence must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "artifact_present", Boolean(artifact), "Release artifact evidence checker output must be present.");
  addCheck(
    checks,
    "artifact_attachment",
    attachmentMetadataPassed(artifactAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(artifactAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(artifactCheckedAt, artifactAttachmentEvidence) &&
      attachmentBeforeBundle(artifactAttachmentEvidence, bundleCheckedAt),
    "Release artifact evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "artifact_passed",
    statusValue(artifact?.status) === "passed" && artifact?.exitCode === 0 && checkArrayAllPassed(artifact),
    "Release artifact evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "artifact_name",
    artifact?.name === "siteflow-release-artifact-check",
    "Release artifact evidence output must be from siteflow-release-artifact-check."
  );
  addCheck(
    checks,
    "artifact_selected_evidence",
    Boolean(
      stringValue(nestedValue(artifact, ["selectedEvidence", "commitRef"])) &&
        stringValue(nestedValue(artifact, ["selectedEvidence", "repository"])) &&
        stringValue(nestedValue(artifact, ["selectedEvidence", "branch"])) &&
        stringValue(nestedValue(artifact, ["selectedEvidence", "targetEnvironment"])) &&
        Number(nestedValue(artifact, ["selectedEvidence", "fileCount"])) > 0 &&
        Number(nestedValue(artifact, ["selectedEvidence", "totalBytes"])) > 0 &&
        stringValue(nestedValue(artifact, ["selectedEvidence", "packageBinSiteflow"])) &&
        nestedValue(artifact, ["selectedEvidence", "auditExitCode"]) === 0
    ),
    "Release artifact evidence output must include selected release identity, file/byte counts, CLI bin path, and successful production dependency audit."
  );
  addCheck(
    checks,
    "artifact_release_identity",
    Boolean(
      releaseCommitRef &&
        repository &&
        branch &&
        evidenceCommitValue(artifact) === releaseCommitRef &&
        evidenceRepositoryValue(artifact) === repository &&
        evidenceBranchValue(artifact) === branch
    ),
    "Release artifact evidence output must be bound to the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "artifact_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(artifact) === rootTargetEnvironment),
    "Release artifact evidence targetEnvironment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "artifact_required_checks",
    checkArrayIncludesPassedNames(artifact, requiredReleaseArtifactChecks),
    "Release artifact evidence output must include passed checks for release identity, artifact directories, manifest, sensitive scan, topology, CLI bin, and production dependency audit."
  );
  addCheck(
    checks,
    "artifact_manifest",
    Boolean(
      artifact?.manifest &&
      nestedValue(artifact, ["manifest", "schemaVersion"]) === "siteflow.releaseArtifactManifest.v1" &&
        nestedValue(artifact, ["manifest", "name"]) === "siteflow-release-artifact-manifest" &&
        releaseArtifactManifestEntriesPassed(artifactManifestArtifacts, artifactSelectedEvidence)
    ),
    "Release artifact evidence must include a safe SHA-256 manifest whose file count and total bytes match selected evidence."
  );
  addCheck(
    checks,
    "artifact_function_runtime_isolation",
    artifactFunctionRuntimeIsolationPassed(artifact, root),
    "Production release deployment artifact manifest must be attached, and any functions must declare isolated runtime isolation; missing, unknown, or same_process runtime isolation is blocked until isolated function runner evidence exists."
  );
  addCheck(
    checks,
    "artifact_age",
    freshTimestamp(timestampValue(artifact?.checkedAt), now, maxEvidenceAgeHours),
    `Release artifact evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "release_image_present", Boolean(releaseImage), "Release image evidence artifact must be present.");
  addCheck(
    checks,
    "release_image_attachment",
    attachmentMetadataPassed(releaseImageAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(releaseImageAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(releaseImageCheckedAt, releaseImageAttachmentEvidence) &&
      attachmentBeforeBundle(releaseImageAttachmentEvidence, bundleCheckedAt),
    "Release image evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "release_image_schema",
    releaseImage?.schemaVersion === "siteflow.releaseImageEvidence.v1" &&
      releaseImage?.name === "siteflow-release-image-evidence",
    "Release image evidence must use the siteflow.releaseImageEvidence.v1 schema and name."
  );
  addCheck(
    checks,
    "release_image_source_identity",
    Boolean(
      releaseCommitRef &&
        repository &&
        releaseImageSourceCommitValue(releaseImage) === releaseCommitRef &&
        releaseImageSourceRepositoryValue(releaseImage) === repository
    ),
    "Release image evidence source repository and commit must match the release identity."
  );
  addCheck(
    checks,
    "release_image_digest",
    releaseImageDigestPassed(releaseImage),
    "Release image evidence must include a sha256:<64 hex> image digest."
  );
  addCheck(
    checks,
    "release_image_tags",
    releaseImageTagsPassed(releaseImage),
    "Release image evidence must include image name, version tag, and commit tag for that image."
  );
  addCheck(
    checks,
    "release_image_commit_tag",
    releaseImageCommitTagPassed(releaseImage, releaseCommitRef),
    "Release image evidence commit tag must be bound to the release commit."
  );
  addCheck(
    checks,
    "release_image_github_run",
    releaseImageGithubRunPassed(releaseImage),
    "Release image evidence must include GitHub run id and attempt metadata."
  );
  addCheck(
    checks,
    "release_image_attestation_subject",
    releaseImageAttestationSubjectPassed(releaseImage),
    "Release image attestation evidence must be inspected from the registry and bound to the published image digest."
  );
  addCheck(
    checks,
    "release_image_provenance_attestation",
    releaseImageProvenanceAttestationPassed(releaseImage),
    "Release image evidence must include a present SLSA provenance attestation manifest digest."
  );
  addCheck(
    checks,
    "release_image_sbom_attestation",
    releaseImageSbomAttestationPassed(releaseImage),
    "Release image evidence must include a present SPDX or CycloneDX SBOM attestation manifest digest."
  );
  addCheck(
    checks,
    "release_image_attestation_inspection",
    releaseImageAttestationInspectionPassed(releaseImage, now, maxEvidenceAgeHours),
    `Release image attestation evidence must include fresh registry inspection metadata no older than ${maxEvidenceAgeHours} hours.`
  );
  addCheck(
    checks,
    "release_image_age",
    freshTimestamp(releaseImageCheckedAt, now, maxEvidenceAgeHours),
    `Release image evidence must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "target_runtime_present", Boolean(targetRuntime), "Target runtime evidence checker output must be present.");
  addCheck(
    checks,
    "target_runtime_attachment",
    attachmentMetadataPassed(targetRuntimeAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(targetRuntimeAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(targetRuntimeCheckedAt, targetRuntimeAttachmentEvidence) &&
      attachmentBeforeBundle(targetRuntimeAttachmentEvidence, bundleCheckedAt),
    "Target runtime evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "target_runtime_passed",
    statusValue(targetRuntime?.status) === "passed" && targetRuntime?.exitCode === 0 && checkArrayAllPassed(targetRuntime),
    "Target runtime evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "target_runtime_name",
    targetRuntime?.name === "siteflow-target-runtime-evidence-check",
    "Target runtime evidence output must be from siteflow-target-runtime-evidence-check."
  );
  addCheck(
    checks,
    "target_runtime_selected_evidence",
    Boolean(
      stringValue(nestedValue(targetRuntime, ["selectedEvidence", "targetEnvironment"])) &&
        stringValue(nestedValue(targetRuntime, ["selectedEvidence", "publicBaseUrl"])) &&
        stringValue(nestedValue(targetRuntime, ["selectedEvidence", "commitRef"])) &&
        stringValue(nestedValue(targetRuntime, ["selectedEvidence", "repository"])) &&
        stringValue(nestedValue(targetRuntime, ["selectedEvidence", "branch"])) &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "composeConfig") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "startup") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "serviceHealth") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "readiness") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "imageBinding") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "restartSmoke") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "logSanity")
    ),
    "Target runtime evidence output must include selected target, release, and timestamped summaries for Compose config, startup, health, readiness, image binding, restart, and log sanity evidence."
  );
  addCheck(
    checks,
    "target_runtime_release_identity",
    Boolean(
      releaseCommitRef &&
        repository &&
        branch &&
        evidenceCommitValue(targetRuntime) === releaseCommitRef &&
        evidenceRepositoryValue(targetRuntime) === repository &&
        evidenceBranchValue(targetRuntime) === branch
    ),
    "Target runtime evidence output must be bound to the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "target_runtime_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(targetRuntime) === rootTargetEnvironment),
    "Target runtime evidence targetEnvironment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "target_runtime_required_checks",
    checkArrayIncludesPassedNames(targetRuntime, requiredTargetRuntimeEvidenceCheckNames),
    "Target runtime evidence output must include passed checks for Compose config, startup, service health, readiness, image binding, restart smoke, log sanity, redaction, operator, and ticket evidence."
  );
  addCheck(
    checks,
    "target_runtime_release_image_digest",
    targetRuntimeReleaseImageDigestPassed(targetRuntime, releaseImage),
    "Target runtime evidence must prove API and worker containers are running the exact release image digest."
  );
  addCheck(
    checks,
    "target_runtime_age",
    freshTimestamp(targetRuntimeCheckedAt, now, maxEvidenceAgeHours),
    `Target runtime evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "source_provider_present", Boolean(sourceProvider), "Source provider evidence checker output must be present.");
  addCheck(
    checks,
    "source_provider_attachment",
    attachmentMetadataPassed(sourceProviderAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(sourceProviderAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(sourceProviderCheckedAt, sourceProviderAttachmentEvidence) &&
      attachmentBeforeBundle(sourceProviderAttachmentEvidence, bundleCheckedAt),
    "Source provider evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "source_provider_passed",
    statusValue(sourceProvider?.status) === "passed" && sourceProvider?.exitCode === 0 && checkArrayAllPassed(sourceProvider),
    "Source provider evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "source_provider_name",
    sourceProvider?.name === "siteflow-source-provider-evidence-check",
    "Source provider evidence output must be from siteflow-source-provider-evidence-check."
  );
  addCheck(
    checks,
    "source_provider_selected_evidence",
    Boolean(
      stringValue(nestedValue(sourceProvider, ["selectedEvidence", "environment"])) &&
        stringValue(nestedValue(sourceProvider, ["selectedEvidence", "commitRef"])) &&
        stringValue(nestedValue(sourceProvider, ["selectedEvidence", "repository"])) &&
        stringValue(nestedValue(sourceProvider, ["selectedEvidence", "branch"])) &&
        stringValue(nestedValue(sourceProvider, ["selectedEvidence", "provider"])) &&
        stringValue(nestedValue(sourceProvider, ["selectedEvidence", "webhookDeliveryId"]))
    ),
    "Source provider evidence output must include selected environment, release identity, provider, and signed webhook delivery evidence."
  );
  addCheck(
    checks,
    "source_provider_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(sourceProvider) === rootTargetEnvironment),
    "Source provider evidence target environment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "source_provider_required_checks",
    checkArrayIncludesPassedNames(sourceProvider, requiredSourceProviderEvidenceChecks),
    "Source provider evidence output must include passed checks for provider support, repository binding, exact checkout, signed webhook, credential hygiene, deploy key, host key, provenance, operator, and ticket evidence."
  );
  addCheck(
    checks,
    "source_provider_age",
    freshTimestamp(timestampValue(sourceProvider?.checkedAt), now, maxEvidenceAgeHours),
    `Source provider evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "backup_present", Boolean(backup), "Backup evidence checker output must be present.");
  addCheck(
    checks,
    "backup_attachment",
    attachmentMetadataPassed(backupAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(backupAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(backupCheckedAt, backupAttachmentEvidence) &&
      attachmentBeforeBundle(backupAttachmentEvidence, bundleCheckedAt),
    "Backup evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "backup_passed",
    statusValue(backup?.status) === "passed" && backup?.exitCode === 0 && checkArrayAllPassed(backup),
    "Backup evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "backup_off_host_required",
    nestedValue(backup, ["thresholds", "requireOffHost"]) === true,
    "Backup evidence must have been checked with requireOffHost: true."
  );
  addCheck(
    checks,
    "backup_selected_evidence",
    Boolean(nestedObject(nestedObject(backup, "selectedEvidence"), "backupVerify") &&
      nestedObject(nestedObject(backup, "selectedEvidence"), "restoreDrill") &&
      nestedObject(nestedObject(backup, "selectedEvidence"), "backupOffload") &&
      nestedObject(nestedObject(backup, "selectedEvidence"), "backupFetch") &&
      nestedObject(nestedObject(backup, "selectedEvidence"), "backupProviderSecurityAudit") &&
      nestedObject(nestedObject(backup, "selectedEvidence"), "backupPrune")),
    "Backup evidence output must include selected backup verify, restore-drill, offload, fetch, provider security audit, and prune evidence."
  );
  addCheck(
    checks,
    "backup_offload_prune_checks",
    checkArrayIncludesPassedNames(backup, requiredBackupEvidenceChecks),
    "Backup evidence output must include passed offload and prune checks from the backup evidence checker."
  );
  addCheck(
    checks,
    "backup_age",
    freshTimestamp(timestampValue(backup?.checkedAt), now, maxEvidenceAgeHours),
    `Backup evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "observability_present", Boolean(observability), "Observability evidence checker output must be present.");
  addCheck(
    checks,
    "observability_attachment",
    attachmentMetadataPassed(observabilityAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(observabilityAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(observabilityCheckedAt, observabilityAttachmentEvidence) &&
      attachmentBeforeBundle(observabilityAttachmentEvidence, bundleCheckedAt),
    "Observability evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "observability_passed",
    statusValue(observability?.status) === "passed" && observability?.exitCode === 0 && checkArrayAllPassed(observability),
    "Observability evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "observability_selected_evidence",
    Boolean(
      nestedObject(nestedObject(observability, "selectedEvidence"), "readinessProbe") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "metricsScrape") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "backupAutomationRun") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "backupAutomationRunHistory") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "backupSchedulerOwnership") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "observabilityApplyProof") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "observabilityTargetStackProof") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "alertDelivery") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "dashboard") &&
        nestedObject(nestedObject(observability, "selectedEvidence"), "logPipeline")
    ),
    "Observability evidence output must include selected readiness, metrics, backup automation, backup history, backup scheduler ownership, apply proof, target-stack proof, alert, dashboard, and log pipeline evidence."
  );
  addCheck(
    checks,
    "observability_release_identity",
    Boolean(
      releaseCommitRef &&
        repository &&
        branch &&
        evidenceCommitValue(observability) === releaseCommitRef &&
        evidenceRepositoryValue(observability) === repository &&
        evidenceBranchValue(observability) === branch
    ),
    "Observability evidence output must be bound to the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "observability_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(observability) === rootTargetEnvironment),
    "Observability evidence targetEnvironment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "observability_required_checks",
    checkArrayIncludesPassedNames(observability, requiredObservabilityEvidenceChecks),
    "Observability evidence output must include passed checks for readiness, metrics, backup automation history, scheduler ownership, apply proof, alert, dashboard, and log redaction evidence."
  );
  addCheck(
    checks,
    "dashboard_age",
    freshTimestamp(dashboardTimestamp, now, maxEvidenceAgeHours),
    `Dashboard evidence timestamp must be no older than ${maxEvidenceAgeHours} hours.`
  );
  addCheck(
    checks,
    "observability_age",
    freshTimestamp(timestampValue(observability?.checkedAt), now, maxEvidenceAgeHours),
    `Observability evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "operator_access_present", Boolean(operatorAccess), "Operator access evidence checker output must be present.");
  addCheck(
    checks,
    "operator_access_attachment",
    attachmentMetadataPassed(operatorAccessAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(operatorAccessAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(operatorAccessCheckedAt, operatorAccessAttachmentEvidence) &&
      attachmentBeforeBundle(operatorAccessAttachmentEvidence, bundleCheckedAt),
    "Operator access evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "operator_access_passed",
    statusValue(operatorAccess?.status) === "passed" && operatorAccess?.exitCode === 0 && checkArrayAllPassed(operatorAccess),
    "Operator access evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "operator_access_name",
    operatorAccess?.name === "siteflow-operator-access-evidence-check",
    "Operator access evidence output must be from siteflow-operator-access-evidence-check."
  );
  addCheck(
    checks,
    "operator_access_selected_evidence",
    Boolean(
      stringValue(nestedValue(operatorAccess, ["selectedEvidence", "environment"])) &&
        stringValue(nestedValue(operatorAccess, ["selectedEvidence", "publicBaseUrl"])) &&
        stringValue(nestedValue(operatorAccess, ["selectedEvidence", "commitRef"])) &&
        stringValue(nestedValue(operatorAccess, ["selectedEvidence", "repository"])) &&
        stringValue(nestedValue(operatorAccess, ["selectedEvidence", "branch"])) &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "sessionCreate") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "projectScope") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "sessionRotation") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "sessionRevoke") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "csrf") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "bearerPrecedence") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "actorAttribution") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "browserTokenFallback") &&
        nestedObject(nestedObject(operatorAccess, "selectedEvidence"), "emergencyCutoff")
    ),
    "Operator access evidence output must include selected target, release, session creation, rotation, scope, CSRF, Bearer precedence, actor, browser token fallback, and emergency cutoff evidence."
  );
  addCheck(
    checks,
    "operator_access_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(operatorAccess) === rootTargetEnvironment),
    "Operator access evidence target environment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "operator_access_required_checks",
    checkArrayIncludesPassedNames(operatorAccess, requiredOperatorAccessEvidenceChecks),
    "Operator access evidence output must include passed checks for session creation, rotation, CSRF, bearer precedence, actor attribution, emergency cutoff, negative evidence, redaction, operator, and ticket evidence."
  );
  addCheck(
    checks,
    "operator_access_age",
    freshTimestamp(timestampValue(operatorAccess?.checkedAt), now, maxEvidenceAgeHours),
    `Operator access evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "non_session_credential_present", Boolean(nonSessionCredential), "Non-session credential evidence checker output must be present.");
  addCheck(
    checks,
    "non_session_credential_attachment",
    attachmentMetadataPassed(nonSessionCredentialAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(nonSessionCredentialAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(nonSessionCredentialCheckedAt, nonSessionCredentialAttachmentEvidence) &&
      attachmentBeforeBundle(nonSessionCredentialAttachmentEvidence, bundleCheckedAt),
    "Non-session credential evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "non_session_credential_passed",
    statusValue(nonSessionCredential?.status) === "passed" && nonSessionCredential?.exitCode === 0 && checkArrayAllPassed(nonSessionCredential),
    "Non-session credential evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "non_session_credential_name",
    nonSessionCredential?.name === "siteflow-non-session-credential-evidence-check",
    "Non-session credential evidence output must be from siteflow-non-session-credential-evidence-check."
  );
  addCheck(
    checks,
    "non_session_credential_selected_evidence",
    Boolean(
      stringValue(nestedValue(nonSessionCredential, ["selectedEvidence", "environment"])) &&
        stringValue(nestedValue(nonSessionCredential, ["selectedEvidence", "commitRef"])) &&
        stringValue(nestedValue(nonSessionCredential, ["selectedEvidence", "repository"])) &&
        stringValue(nestedValue(nonSessionCredential, ["selectedEvidence", "branch"])) &&
        Array.isArray(nestedValue(nonSessionCredential, ["selectedEvidence", "credentialTypes"])) &&
        Number(nestedValue(nonSessionCredential, ["selectedEvidence", "credentialCount"])) > 0 &&
        nestedObject(nestedObject(nonSessionCredential, "selectedEvidence"), "breakGlass")
    ),
    "Non-session credential evidence output must include selected target, release, credential types/count, and break-glass evidence."
  );
  addCheck(
    checks,
    "non_session_credential_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(nonSessionCredential) === rootTargetEnvironment),
    "Non-session credential evidence target environment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "non_session_credential_required_checks",
    checkArrayIncludesPassedNames(nonSessionCredential, requiredNonSessionCredentialEvidenceChecks),
    "Non-session credential evidence output must include passed checks for credential inventory, rotation/cutover, redaction, break-glass, non-automation, operator, and ticket evidence."
  );
  addCheck(
    checks,
    "non_session_credential_age",
    freshTimestamp(timestampValue(nonSessionCredential?.checkedAt), now, maxEvidenceAgeHours),
    `Non-session credential evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "ingress_present", Boolean(ingress), "Ingress evidence checker output must be present.");
  addCheck(
    checks,
    "ingress_attachment",
    attachmentMetadataPassed(ingressAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(ingressAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(ingressCheckedAt, ingressAttachmentEvidence) &&
      attachmentBeforeBundle(ingressAttachmentEvidence, bundleCheckedAt),
    "Ingress evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "ingress_passed",
    statusValue(ingress?.status) === "passed" && ingress?.exitCode === 0 && checkArrayAllPassed(ingress),
    "Ingress evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "ingress_name",
    ingress?.name === "siteflow-ingress-evidence-check",
    "Ingress evidence output must be from siteflow-ingress-evidence-check."
  );
  addCheck(
    checks,
    "ingress_selected_evidence",
    Boolean(
      stringValue(nestedValue(ingress, ["selectedEvidence", "environment"])) &&
        stringValue(nestedValue(ingress, ["selectedEvidence", "publicBaseUrl"])) &&
        stringValue(nestedValue(ingress, ["selectedEvidence", "commitRef"])) &&
        stringValue(nestedValue(ingress, ["selectedEvidence", "repository"])) &&
        stringValue(nestedValue(ingress, ["selectedEvidence", "branch"])) &&
        stringValue(nestedValue(ingress, ["selectedEvidence", "trustProxyPolicy"])) &&
        nestedObject(nestedObject(ingress, "selectedEvidence"), "directApiPort") &&
        nestedObject(nestedObject(ingress, "selectedEvidence"), "forwardedHeaders") &&
        nestedObject(nestedObject(ingress, "selectedEvidence"), "apiRateLimit") &&
        nestedObject(nestedObject(ingress, "selectedEvidence"), "unthrottledRoutes")
    ),
    "Ingress evidence output must include selected target, release, proxy, direct-port, forwarded-header, rate-limit, and non-API route evidence."
  );
  addCheck(
    checks,
    "ingress_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(ingress) === rootTargetEnvironment),
    "Ingress evidence target environment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "ingress_required_checks",
    checkArrayIncludesPassedNames(ingress, requiredIngressEvidenceChecks),
    "Ingress evidence output must include passed checks for target binding, direct API blocking, forwarded headers, proxy source policy, rate limiting, unthrottled routes, operator, and ticket evidence."
  );
  addCheck(
    checks,
    "ingress_deployment_topology",
    ingressTopologyRateLimit.topologyDeclared,
    "Ingress evidence selectedEvidence must declare deploymentTopology/topology with API instance/process and ingress counts or explicit multi-* flags."
  );
  addCheck(
    checks,
    "ingress_rate_limit_topology",
    ingressTopologyRateLimit.passed,
    "Multi-instance, multi-process, or multi-ingress production topology must prove API rate limiting is edge-enforced or shared across instances; process-local-only limiting is not sufficient."
  );
  addCheck(
    checks,
    "ingress_age",
    freshTimestamp(timestampValue(ingress?.checkedAt), now, maxEvidenceAgeHours),
    `Ingress evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(checks, "upgrade_rollback_present", Boolean(upgradeRollback), "Upgrade/rollback drill evidence checker output must be present.");
  addCheck(
    checks,
    "upgrade_rollback_attachment",
    attachmentMetadataPassed(upgradeRollbackAttachmentEvidence, releaseCommitRef) &&
      attachmentFresh(upgradeRollbackAttachmentEvidence, now, maxEvidenceAgeHours) &&
      evidenceBeforeAttachment(upgradeRollbackCheckedAt, upgradeRollbackAttachmentEvidence) &&
      attachmentBeforeBundle(upgradeRollbackAttachmentEvidence, bundleCheckedAt),
    "Upgrade/rollback drill evidence attachment must include sourcePath, collectedAt, matching releaseCommit, and valid timestamp order."
  );
  addCheck(
    checks,
    "upgrade_rollback_passed",
    statusValue(upgradeRollback?.status) === "passed" && upgradeRollback?.exitCode === 0 && checkArrayAllPassed(upgradeRollback),
    "Upgrade/rollback drill evidence checker output must be passed with all checks passing."
  );
  addCheck(
    checks,
    "upgrade_rollback_name",
    upgradeRollback?.name === "siteflow-upgrade-rollback-drill-evidence-check",
    "Upgrade/rollback drill evidence output must be from siteflow-upgrade-rollback-drill-evidence-check."
  );
  addCheck(
    checks,
    "upgrade_rollback_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(upgradeRollback) === rootTargetEnvironment),
    "Upgrade/rollback drill evidence targetEnvironment must match the release bundle targetEnvironment."
  );
  addCheck(
    checks,
    "upgrade_rollback_selected_evidence",
    Boolean(
      stringValue(nestedValue(upgradeRollback, ["selectedEvidence", "targetEnvironment"])) &&
      stringValue(nestedValue(upgradeRollback, ["selectedEvidence", "fromVersion"])) &&
        stringValue(nestedValue(upgradeRollback, ["selectedEvidence", "toVersion"])) &&
        stringValue(nestedValue(upgradeRollback, ["selectedEvidence", "rollbackVersion"])) &&
        stringValue(nestedValue(upgradeRollback, ["selectedEvidence", "upgradeOperationId"])) &&
        stringValue(nestedValue(upgradeRollback, ["selectedEvidence", "rollbackOperationId"]))
    ),
    "Upgrade/rollback drill evidence output must include selected target environment, version pair, and operation ids."
  );
  addCheck(
    checks,
    "upgrade_rollback_required_checks",
    checkArrayIncludesPassedNames(upgradeRollback, requiredUpgradeRollbackEvidenceChecks),
    "Upgrade/rollback drill evidence output must include passed checks for target binding, operation order, backup, route, readiness, observability, operator, and ticket evidence."
  );
  addCheck(
    checks,
    "upgrade_rollback_age",
    freshTimestamp(timestampValue(upgradeRollback?.checkedAt), now, maxEvidenceAgeHours),
    `Upgrade/rollback drill evidence check output must be no older than ${maxEvidenceAgeHours} hours.`
  );

  addCheck(
    checks,
    "operator",
    Boolean(stringValue(root?.operatorName) ?? stringValue(nestedValue(root, ["release", "operatorName"]))),
    "Release evidence bundle must include the release operator name."
  );
  addCheck(
    checks,
    "ticket",
    Boolean(
      stringValue(root?.releaseTicket) ??
        stringValue(root?.ticketId) ??
        stringValue(nestedValue(root, ["release", "ticketId"])) ??
        stringValue(nestedValue(root, ["release", "releaseTicket"]))
    ),
    "Release evidence bundle must include a release or incident ticket id."
  );

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-release-evidence-bundle-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxEvidenceAgeHours,
      allowHostBuildException: Boolean(options.allowHostBuildException)
    },
    selectedEvidence: {
      releaseCommitRef: releaseCommitRef ?? null,
      repository: repository ?? null,
      branch: branch ?? null,
      releaseGateStatus: stringValue(releaseGate?.status) ?? null,
      dockerBuildRehearsalStatus: stringValue(dockerBuild?.status) ?? null,
      postgresRehearsalStatus: stringValue(postgres?.status) ?? null,
      artifactEvidenceStatus: stringValue(artifact?.status) ?? null,
      releaseImageDigest: releaseImageDigestValue(releaseImage) ?? null,
      targetRuntimeEvidenceStatus: stringValue(targetRuntime?.status) ?? null,
      sourceProviderEvidenceStatus: stringValue(sourceProvider?.status) ?? null,
      backupEvidenceStatus: stringValue(backup?.status) ?? null,
      observabilityEvidenceStatus: stringValue(observability?.status) ?? null,
      operatorAccessEvidenceStatus: stringValue(operatorAccess?.status) ?? null,
      nonSessionCredentialEvidenceStatus: stringValue(nonSessionCredential?.status) ?? null,
      ingressEvidenceStatus: stringValue(ingress?.status) ?? null,
      upgradeRollbackDrillStatus: stringValue(upgradeRollback?.status) ?? null
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runReleaseEvidenceBundleCheck(
  options: ReleaseEvidenceBundleCheckOptions
): Promise<ReleaseEvidenceBundleResult> {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateReleaseEvidenceBundle(raw, options);
}

export function parseReleaseEvidenceBundleArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false,
    maxEvidenceAgeHours: defaultMaxEvidenceAgeHours,
    allowHostBuildException: false
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
    } else if (arg === "--max-evidence-age-hours") {
      parsed.maxEvidenceAgeHours = Number(args[++index]);
    } else if (arg === "--allow-host-build-exception") {
      parsed.allowHostBuildException = true;
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

  positiveNumber(parsed.maxEvidenceAgeHours, defaultMaxEvidenceAgeHours, "--max-evidence-age-hours");

  return parsed;
}

export function releaseEvidenceBundleUsage() {
  return [
    "Usage: npm run --silent release:evidence -- --evidence <file> [--json]",
    "",
    "Options:",
    "  --evidence <file>                 Evidence JSON containing release gate, Docker build, Postgres, artifact, release image, target runtime, source provider, backup, observability, operator access, non-session credential, ingress, and upgrade/rollback drill outputs.",
    "  --commit-ref <sha>                Require the exact release commit.",
    "  --repo <owner/repo>               Require the target GitHub repository.",
    "  --branch <branch>                 Require the target branch.",
    "  --target-environment <name>       Require the target environment label.",
    `  --max-evidence-age-hours <hours>  Maximum age for rehearsal/checker outputs. Default: ${defaultMaxEvidenceAgeHours}.`,
    "  --allow-host-build-exception      Accept a recorded production host-build trust exception.",
    "  --json                           Emit a single JSON result.",
    "  --help                           Show this help."
  ].join("\n");
}

function writeHumanResult(result: ReleaseEvidenceBundleResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow release evidence bundle status: ${result.status}\n`);
  output.write(`Evidence: ${result.evidencePath}\n`);
  output.write("Checks:\n");

  for (const check of result.checks) {
    output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
  }
}

export async function runReleaseEvidenceBundleCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseEvidenceBundleCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseEvidenceBundleArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseEvidenceBundleUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseEvidenceBundleUsage()}\n`);
    return 0;
  }

  try {
    const result = await runReleaseEvidenceBundleCheck({
      ...baseOptions,
      evidencePath: parsed.evidencePath!,
      commitRef: parsed.commitRef,
      repo: parsed.repo,
      branch: parsed.branch,
      targetEnvironment: parsed.targetEnvironment,
      maxEvidenceAgeHours: parsed.maxEvidenceAgeHours,
      allowHostBuildException: parsed.allowHostBuildException
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: ReleaseEvidenceBundleResult = {
      name: "siteflow-release-evidence-bundle-check",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      evidencePath: parsed.evidencePath!,
      thresholds: {
        maxEvidenceAgeHours: parsed.maxEvidenceAgeHours,
        allowHostBuildException: parsed.allowHostBuildException
      },
      selectedEvidence: {
        releaseCommitRef: null,
        repository: null,
        branch: null,
        releaseGateStatus: null,
        dockerBuildRehearsalStatus: null,
        postgresRehearsalStatus: null,
        artifactEvidenceStatus: null,
        releaseImageDigest: null,
        targetRuntimeEvidenceStatus: null,
        sourceProviderEvidenceStatus: null,
        backupEvidenceStatus: null,
        observabilityEvidenceStatus: null,
        operatorAccessEvidenceStatus: null,
        nonSessionCredentialEvidenceStatus: null,
        ingressEvidenceStatus: null,
        upgradeRollbackDrillStatus: null
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
  runReleaseEvidenceBundleCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
