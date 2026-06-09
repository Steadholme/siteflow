import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck.js";
import { strictIsoTimestampValue } from "./isoTimestamp.js";
import { requiredNonSessionCredentialEvidenceCheckNames } from "./nonSessionCredentialEvidenceCheck.js";
import { requiredObservabilityEvidenceCheckNames } from "./observabilityEvidenceCheck.js";
import { requiredOperatorAccessEvidenceCheckNames } from "./operatorAccessEvidenceCheck.js";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts.js";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck.js";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck.js";
import { requiredUpgradeRollbackDrillEvidenceCheckNames } from "./upgradeRollbackDrillEvidenceCheck.js";

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
  allowMissingAttestation?: boolean;
  attestationSigningKey?: string;
  requiredAttestationKeyId?: string;
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
  payloadDigest: string | null;
  thresholds: {
    maxEvidenceAgeHours: number;
    allowHostBuildException: boolean;
    allowMissingAttestation?: boolean;
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
  allowMissingAttestation: boolean;
  attestationKeyEnv?: string;
  attestationKeyFile?: string;
  requiredAttestationKeyIdEnv?: string;
  requiredAttestationKeyId?: string;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMaxEvidenceAgeHours = 168;
const expectedSchemaVersion = "siteflow.releaseEvidence.v1";
const expectedBundleName = "siteflow-release-evidence-bundle";
const expectedBundleAttestationType = "siteflow.releaseEvidenceBundleAttestation.v1";
const expectedBundleAttestationIssuer = "siteflow-release-evidence-bundle-compose";
const expectedBundleAttestationCanonicalization = "siteflow.releaseEvidenceBundlePayload.v1";
const expectedBundleAttestationSignatureAlgorithm = "hmac-sha256";
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

export function releaseEvidenceRequiredAttestationKeyIdFromEnv(env: Record<string, string | undefined> = process.env) {
  return stringValue(env.SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID) ??
    stringValue(env.SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_ID);
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) ?? "null" : "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }

  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return "null";
}

function sha256Digest(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hmacSha256Signature(value: string, key: string) {
  return `sha256:${createHmac("sha256", key).update(value, "utf8").digest("hex")}`;
}

function constantTimeEqual(left: string | undefined, right: string | undefined) {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function releaseEvidenceBundlePayload(bundle: Record<string, unknown>) {
  const { attestation: _attestation, ...payload } = bundle;

  return payload;
}

export function releaseEvidenceBundlePayloadDigest(bundle: Record<string, unknown>) {
  return sha256Digest(canonicalJson(releaseEvidenceBundlePayload(bundle)));
}

export function releaseEvidenceBundleAttestationKeyId(attestationSigningKey: string) {
  return `sha256:${createHash("sha256").update(attestationSigningKey, "utf8").digest("hex").slice(0, 16)}`;
}

function releaseEvidenceBundleAttestationSigningPayload(attestation: Record<string, unknown>) {
  const { signature: _signature, ...payload } = attestation;

  return canonicalJson(payload);
}

interface ReleaseEvidenceBundleAttestationOptions {
  attestationSigningKey?: string;
  attestationSigningKeyId?: string;
}

export function releaseEvidenceBundleAttestation(
  bundle: Record<string, unknown>,
  attestedAt: string,
  options: ReleaseEvidenceBundleAttestationOptions = {}
) {
  const release = nestedObject(bundle, "release");
  const unsignedAttestation: Record<string, unknown> = {
    type: expectedBundleAttestationType,
    issuer: expectedBundleAttestationIssuer,
    attestedAt,
    payloadDigestAlgorithm: "sha256",
    payloadDigest: releaseEvidenceBundlePayloadDigest(bundle),
    canonicalization: expectedBundleAttestationCanonicalization,
    subject: {
      schemaVersion: stringValue(bundle.schemaVersion) ?? null,
      name: stringValue(bundle.name) ?? null,
      commitRef: stringValue(release?.commitRef) ?? stringValue(bundle.commitRef) ?? null,
      repository: stringValue(release?.repository) ?? stringValue(bundle.repository) ?? null,
      branch: stringValue(release?.branch) ?? stringValue(bundle.branch) ?? null,
      targetEnvironment: bundleTargetEnvironment(bundle) ?? null
    }
  };

  if (!options.attestationSigningKey) {
    return unsignedAttestation;
  }

  const signedAttestation = {
    ...unsignedAttestation,
    signatureAlgorithm: expectedBundleAttestationSignatureAlgorithm,
    signatureKeyId: options.attestationSigningKeyId ?? releaseEvidenceBundleAttestationKeyId(options.attestationSigningKey)
  };

  return {
    ...signedAttestation,
    signature: hmacSha256Signature(
      releaseEvidenceBundleAttestationSigningPayload(signedAttestation),
      options.attestationSigningKey
    )
  };
}

export function bundleWithReleaseEvidenceAttestation(
  bundle: Record<string, unknown>,
  attestedAt: string,
  options: ReleaseEvidenceBundleAttestationOptions = {}
) {
  return {
    ...bundle,
    attestation: releaseEvidenceBundleAttestation(bundle, attestedAt, options)
  };
}

export function releaseEvidenceBundleAttestationDigestVerified(bundle: Record<string, unknown>) {
  return bundleAttestationDigestMatches(bundleAttestation(bundle), bundle);
}

export function releaseEvidenceBundleAttestationSignatureVerified(
  bundle: Record<string, unknown>,
  attestationSigningKey: string | undefined,
  requiredAttestationKeyId?: string
) {
  const attestation = bundleAttestation(bundle);

  return bundleAttestationDigestMatches(attestation, bundle) &&
    bundleAttestationSignatureMatches(attestation, attestationSigningKey, requiredAttestationKeyId);
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
      backupPrune?.dryRun === false
  );
}

function sourceProviderSelectedEvidencePassed(
  selectedEvidence: Record<string, unknown> | undefined,
  releaseCommitRef: string | undefined,
  repository: string | undefined,
  branch: string | undefined
) {
  const checkout = nestedObject(selectedEvidence, "checkout");
  const signedWebhook = nestedObject(selectedEvidence, "signedWebhook");
  const deployKey = nestedObject(selectedEvidence, "deployKey");
  const hostKey = nestedObject(selectedEvidence, "hostKey");
  const releaseProvenance = nestedObject(selectedEvidence, "releaseProvenance");

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
  releaseCommitRef: string | undefined,
  repository: string | undefined,
  branch: string | undefined,
  targetEnvironment: string | undefined
) {
  const fromVersion = stringValue(selectedEvidence?.fromVersion);
  const toVersion = stringValue(selectedEvidence?.toVersion);
  const rollbackVersion = stringValue(selectedEvidence?.rollbackVersion);
  const upgradeOperationId = stringValue(selectedEvidence?.upgradeOperationId);
  const rollbackOperationId = stringValue(selectedEvidence?.rollbackOperationId);

  return Boolean(
    stringValue(selectedEvidence?.commitRef) === releaseCommitRef &&
      stringValue(selectedEvidence?.repository) === repository &&
      stringValue(selectedEvidence?.branch) === branch &&
      stringValue(selectedEvidence?.targetEnvironment) === targetEnvironment &&
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
  return nestedObject(root, "release");
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

function releaseImageSourceRefValue(evidence: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(evidence, ["source", "refName"])) ??
    stringValue(nestedValue(evidence, ["source", "ref"])) ??
    stringValue(nestedValue(evidence, ["source", "branch"]));
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

function releaseImageAttestationFailedCheckCount(candidate: Record<string, unknown> | undefined) {
  const failedChecks = candidate?.failedChecks;
  const checks = candidate?.checks;
  let count = 0;

  if (Array.isArray(failedChecks)) {
    count += failedChecks.length;
  }

  if (Array.isArray(checks)) {
    count += checks.filter((check) => !isObject(check) || statusValue(check.status) !== "pass").length;
  }

  return count;
}

function releaseImageAttestationNoFailedChecksPassed(evidence: Record<string, unknown> | undefined) {
  const attestations = releaseImageAttestations(evidence);
  const provenance = releaseImageAttestationPredicate(evidence, "provenance");
  const sbom = releaseImageAttestationPredicate(evidence, "sbom");

  return Boolean(
    attestations &&
      releaseImageAttestationFailedCheckCount(attestations) === 0 &&
      releaseImageAttestationFailedCheckCount(provenance) === 0 &&
      releaseImageAttestationFailedCheckCount(sbom) === 0
  );
}

function releaseImagePredicateSubjectDigests(predicate: Record<string, unknown> | undefined) {
  const digests = new Set<string>();
  const subjectDigest = stringValue(predicate?.subjectDigest);
  const subjects = predicate?.subjects;

  if (subjectDigest) {
    digests.add(subjectDigest);
  }

  if (Array.isArray(subjects)) {
    for (const subject of subjects) {
      if (!isObject(subject)) {
        continue;
      }

      const digest = nestedObject(subject, "digest");
      const sha256 = stringValue(digest?.sha256);

      if (sha256DigestPattern.test(sha256 ?? "")) {
        digests.add(sha256!);
      } else if (sha256HexPattern.test(sha256 ?? "")) {
        digests.add(`sha256:${sha256}`);
      }
    }
  }

  return digests;
}

function releaseImagePredicateSubjectPassed(
  evidence: Record<string, unknown> | undefined,
  name: "provenance" | "sbom"
) {
  const imageDigest = releaseImageDigestValue(evidence);
  const predicate = releaseImageAttestationPredicate(evidence, name);

  return Boolean(
    imageDigest &&
      sha256DigestPattern.test(imageDigest) &&
      releaseImagePredicateSubjectDigests(predicate).has(imageDigest)
  );
}

function releaseImageAttestationSubjectPassed(evidence: Record<string, unknown> | undefined) {
  return Boolean(
    releaseImageDigestPassed(evidence) &&
      releaseImageDigestValue(evidence) === stringValue(nestedValue(evidence, ["attestations", "subjectDigest"])) &&
      releaseImagePredicateSubjectPassed(evidence, "provenance") &&
      releaseImagePredicateSubjectPassed(evidence, "sbom")
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

function releaseImageProvenanceStatementPassed(evidence: Record<string, unknown> | undefined) {
  const provenance = releaseImageAttestationPredicate(evidence, "provenance");
  const builder = nestedObject(provenance, "builder");
  const materials = provenance?.materials;

  return Boolean(
    releaseImageProvenanceAttestationPassed(evidence) &&
      releaseImagePredicateSubjectPassed(evidence, "provenance") &&
      sha256DigestPattern.test(stringValue(provenance?.statementDigest) ?? "") &&
      stringValue(builder?.id) &&
      Array.isArray(materials) &&
      materials.length > 0
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

function releaseImageSbomStatementPassed(evidence: Record<string, unknown> | undefined) {
  const sbom = releaseImageAttestationPredicate(evidence, "sbom");

  return Boolean(
    releaseImageSbomAttestationPassed(evidence) &&
      releaseImagePredicateSubjectPassed(evidence, "sbom") &&
      sha256DigestPattern.test(stringValue(sbom?.statementDigest) ?? "")
  );
}

function normalizeReleaseImageRef(value: string | undefined) {
  return value?.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

function releaseImageProvenanceSourceIdentityPassed(
  evidence: Record<string, unknown> | undefined,
  releaseCommitRef: string | undefined,
  repository: string | undefined,
  branch: string | undefined
) {
  const provenance = releaseImageAttestationPredicate(evidence, "provenance");
  const source = nestedObject(provenance, "source");
  const sourceCommitRef = stringValue(source?.commitRef) ?? stringValue(source?.commitSha);
  const sourceRepository = stringValue(source?.repository);
  const sourceRef = normalizeReleaseImageRef(
    stringValue(source?.refName) ?? stringValue(source?.ref) ?? stringValue(source?.branch)
  );
  const releaseRef = normalizeReleaseImageRef(releaseImageSourceRefValue(evidence) ?? branch);

  return Boolean(
    releaseCommitRef &&
      repository &&
      releaseRef &&
      sourceCommitRef === releaseCommitRef &&
      sourceRepository?.toLowerCase() === repository.toLowerCase() &&
      sourceRef === releaseRef
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

function checkArrayIncludesPassedNames(candidate: Record<string, unknown> | undefined, requiredNames: readonly string[]) {
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

const nonFinalEvidenceStatuses = new Set(["blocked", "todo", "manual_required", "dry_run", "failed", "fail"]);

function nonFinalEvidenceFindings(entries: Array<{ label: string; evidence: Record<string, unknown> | undefined }>) {
  return entries.flatMap(({ label, evidence }) => {
    if (!evidence) {
      return [];
    }

    const findings: string[] = [];
    const status = statusValue(evidence.status);

    if (evidence.template === true) {
      findings.push(`${label}: template`);
    }

    if (evidence.dryRun === true) {
      findings.push(`${label}: dryRun`);
    }

    if (status && nonFinalEvidenceStatuses.has(status)) {
      findings.push(`${label}: status ${status}`);
    }

    return findings;
  });
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

const allowedMetricsPrivateScrapeProtections = new Set([
  "private_network",
  "localhost_sidecar",
  "reverse_proxy_allowlist"
]);
const requiredMetricsPrivateScrapeIngressChecks = [
  "metrics_access_control_optional",
  "metrics_access_control_age",
  "metrics_access_control_private_scrape"
];

function runtimeIsolationIsAllowed(value: string | undefined) {
  return Boolean(value && allowedFunctionRuntimeIsolationValues.has(value));
}

function normalizedToken(value: unknown) {
  return stringValue(value)?.toLowerCase().replace(/[\s-]+/g, "_");
}

function booleanEvidenceValue(candidate: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    if (typeof candidate?.[key] === "boolean") {
      return candidate[key];
    }
  }

  return undefined;
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
    stringValue(runtimeEnv?.buildNetwork)?.toLowerCase() === "none" &&
    statusValue(runtimeEnv?.workerUserStatus) === "pass" &&
    Boolean(stringValue(runtimeEnv?.workerUser)) &&
    stringValue(runtimeEnv?.workerUser)?.split(":")[0] !== "0" &&
    statusValue(runtimeEnv?.dockerSocketGidStatus) === "pass" &&
    Number.isSafeInteger(numberValue(runtimeEnv?.dockerSocketGid)) &&
    Number(numberValue(runtimeEnv?.dockerSocketGid)) >= 0;
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

function ingressMetricsAccessControlEvidence(ingress: Record<string, unknown> | undefined) {
  return firstNestedObject(ingress, [
    ["selectedEvidence", "metricsAccessControl"],
    ["selectedEvidence", "metricsPrivateScrape"],
    ["metricsAccessControl"],
    ["metricsPrivateScrape"]
  ]);
}

function observabilityMetricsScrapeEvidence(observability: Record<string, unknown> | undefined) {
  return firstNestedObject(observability, [
    ["selectedEvidence", "metricsScrape"],
    ["selectedEvidence", "metrics"],
    ["metricsScrape"],
    ["metrics"]
  ]);
}

function metricsPrivateScrapeExceptionActive(runtimeEnv: Record<string, unknown> | undefined) {
  return runtimeEnv?.unauthenticatedMetricsAllowed === true &&
    (
      runtimeEnv.metricsTokenConfigured !== true ||
        statusValue(runtimeEnv.metricsTokenStrengthStatus) === "skipped"
    );
}

function metricsPrivateScrapeProtectionAllowed(candidate: Record<string, unknown> | undefined) {
  const protection = normalizedToken(candidate?.protection) ??
    normalizedToken(candidate?.accessControl) ??
    normalizedToken(candidate?.networkProtection);

  return Boolean(protection && allowedMetricsPrivateScrapeProtections.has(protection));
}

function metricsScrapePath(candidate: Record<string, unknown> | undefined) {
  return stringValue(candidate?.scrapePath) ?? stringValue(candidate?.path) ?? stringValue(candidate?.endpoint);
}

function metricsPublicAccessBlocked(candidate: Record<string, unknown> | undefined) {
  return booleanEvidenceValue(candidate, [
    "publicAccessBlocked",
    "noPublicUnauthenticatedAccess",
    "publicUnauthenticatedAccessBlocked"
  ]) === true;
}

function metricsPrivateScrapeExceptionBound(
  runtimeEnv: Record<string, unknown> | undefined,
  observability: Record<string, unknown> | undefined,
  ingress: Record<string, unknown> | undefined
) {
  if (!metricsPrivateScrapeExceptionActive(runtimeEnv)) {
    return true;
  }

  const metricsScrape = observabilityMetricsScrapeEvidence(observability);
  const metricsAccessControl = ingressMetricsAccessControlEvidence(ingress);

  return metricsScrape?.privateScrapeException === true &&
    metricsAccessControl?.privateScrapeException === true &&
    metricsScrapePath(metricsAccessControl) === "/metrics" &&
    metricsPrivateScrapeProtectionAllowed(metricsAccessControl) &&
    metricsPublicAccessBlocked(metricsAccessControl) &&
    checkArrayIncludesPassedNames(ingress, requiredMetricsPrivateScrapeIngressChecks);
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
  return nestedValue(root, ["release", "dockerSocketProfileAccepted"]) === true;
}

function bundleAttestation(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "attestation");
}

function bundleAttestationSubjectMatches(
  attestation: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
  releaseCommitRef: string | undefined,
  repository: string | undefined,
  branch: string | undefined,
  targetEnvironment: string | undefined
) {
  const subject = nestedObject(attestation, "subject");

  return Boolean(
    subject &&
      stringValue(subject.schemaVersion) === stringValue(root?.schemaVersion) &&
      stringValue(subject.name) === stringValue(root?.name) &&
      stringValue(subject.commitRef) === releaseCommitRef &&
      stringValue(subject.repository) === repository &&
      stringValue(subject.branch) === branch &&
      stringValue(subject.targetEnvironment) === targetEnvironment
  );
}

function bundleAttestationTrusted(
  attestation: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
  releaseCommitRef: string | undefined,
  repository: string | undefined,
  branch: string | undefined,
  targetEnvironment: string | undefined
) {
  return Boolean(
    attestation &&
      stringValue(attestation.type) === expectedBundleAttestationType &&
      stringValue(attestation.issuer) === expectedBundleAttestationIssuer &&
      stringValue(attestation.payloadDigestAlgorithm) === "sha256" &&
      sha256DigestPattern.test(stringValue(attestation.payloadDigest) ?? "") &&
      stringValue(attestation.canonicalization) === expectedBundleAttestationCanonicalization &&
      timestampValue(attestation.attestedAt) &&
      bundleAttestationSubjectMatches(attestation, root, releaseCommitRef, repository, branch, targetEnvironment)
  );
}

function bundleAttestationDigestMatches(
  attestation: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined
) {
  return Boolean(
    attestation &&
      root &&
      stringValue(attestation.payloadDigest) === releaseEvidenceBundlePayloadDigest(root)
  );
}

function bundleAttestationSignatureMatches(
  attestation: Record<string, unknown> | undefined,
  attestationSigningKey: string | undefined,
  requiredAttestationKeyId: string | undefined
) {
  if (
    !attestation ||
      !attestationSigningKey ||
      stringValue(attestation.signatureAlgorithm) !== expectedBundleAttestationSignatureAlgorithm
  ) {
    return false;
  }

  const signatureKeyId = stringValue(attestation.signatureKeyId);
  const signature = stringValue(attestation.signature);

  if (!signatureKeyId || !signature || !sha256DigestPattern.test(signature)) {
    return false;
  }

  if (requiredAttestationKeyId && signatureKeyId !== requiredAttestationKeyId) {
    return false;
  }

  return constantTimeEqual(
    signature,
    hmacSha256Signature(releaseEvidenceBundleAttestationSigningPayload(attestation), attestationSigningKey)
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
  const payloadDigest = root ? releaseEvidenceBundlePayloadDigest(root) : null;
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
  const release = releaseMetadata(root);
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
  const operatorAccessSelectedEvidence = nestedObject(operatorAccess, "selectedEvidence");
  const nonSessionCredential = nonSessionCredentialAttachmentEvidence.evidence;
  const nonSessionCredentialSelectedEvidence = nestedObject(nonSessionCredential, "selectedEvidence");
  const ingress = ingressAttachmentEvidence.evidence;
  const ingressSelectedEvidence = nestedObject(ingress, "selectedEvidence");
  const upgradeRollback = upgradeRollbackAttachmentEvidence.evidence;
  const ingressTopologyRateLimit = ingressTopologyRateLimitEvidencePassed(ingress);
  const releaseCommitRef = selectedCommitRef(root, promotion, options);
  const repository = selectedRepository(root, promotion, options);
  const branch = selectedBranch(root, promotion, options);
  const rootTargetEnvironment = stringValue(root?.targetEnvironment);
  const releaseTargetEnvironment = stringValue(release?.targetEnvironment);
  const expectedTargetEnvironment = stringValue(options.targetEnvironment);
  const attestationTargetEnvironment = expectedTargetEnvironment ?? rootTargetEnvironment ?? releaseTargetEnvironment;
  const releaseBundleAttestation = bundleAttestation(root);
  const releaseBundleAttestationPresent = Boolean(releaseBundleAttestation);
  const releaseBundleAttestationRequired = attestationTargetEnvironment === "production" && !options.allowMissingAttestation;
  const releaseBundleAttestationSignatureRequired = attestationTargetEnvironment === "production" && releaseBundleAttestationPresent;
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const commitRefs = uniqueStrings([
    releaseCommitRef,
    releaseCommitValue(root),
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
  const releaseRequiredStatusCheck = stringValue(release?.requiredStatusCheck);
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
  const releaseBundleAttestationIsTrusted = bundleAttestationTrusted(
    releaseBundleAttestation,
    root,
    releaseCommitRef,
    repository,
    branch,
    rootTargetEnvironment
  );
  const releaseBundleAttestationDigestMatches = bundleAttestationDigestMatches(releaseBundleAttestation, root);
  const releaseBundleAttestationSignatureMatches = bundleAttestationSignatureMatches(
    releaseBundleAttestation,
    options.attestationSigningKey,
    options.requiredAttestationKeyId
  );
  const nonFinalAttachmentFindings = nonFinalEvidenceFindings([
    { label: "release-gate", evidence: releaseGate },
    { label: "docker build rehearsal", evidence: dockerBuild },
    { label: "postgres rehearsal", evidence: postgres },
    { label: "release artifact", evidence: artifact },
    { label: "release image", evidence: releaseImage },
    { label: "target runtime", evidence: targetRuntime },
    { label: "source provider", evidence: sourceProvider },
    { label: "backup", evidence: backup },
    { label: "observability", evidence: observability },
    { label: "operator access", evidence: operatorAccess },
    { label: "non-session credential", evidence: nonSessionCredential },
    { label: "ingress", evidence: ingress },
    { label: "upgrade/rollback drill", evidence: upgradeRollback }
  ]);
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
    "release_metadata",
    Boolean(
      release &&
        stringValue(release.commitRef) &&
        stringValue(release.repository) &&
        stringValue(release.branch) &&
        stringValue(release.requiredStatusCheck) &&
        stringValue(release.targetEnvironment) &&
        stringValue(release.operatorName) &&
        (stringValue(release.releaseTicket) || stringValue(release.ticketId))
    ),
    "Release evidence bundle must include canonical release metadata with commitRef, repository, branch, requiredStatusCheck, targetEnvironment, operatorName, and releaseTicket."
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
    "bundle_attachments_final_evidence",
    nonFinalAttachmentFindings.length === 0,
    nonFinalAttachmentFindings.length === 0
      ? "Release evidence bundle attachments must be final target evidence."
      : `Release evidence bundle attachments must not include template, dry-run, blocked, failed, or todo evidence: ${nonFinalAttachmentFindings.join(", ")}.`
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
    "bundle_attestation_required",
    !releaseBundleAttestationRequired || releaseBundleAttestationPresent,
    "Production release evidence bundle must include compose-generated attestation metadata unless --allow-missing-attestation is explicitly accepted."
  );
  addCheck(
    checks,
    "bundle_attestation_trusted",
    !releaseBundleAttestationPresent || releaseBundleAttestationIsTrusted,
    "Release evidence bundle attestation must be generated by siteflow-release-evidence-bundle-compose and bind schema, release identity, and target environment."
  );
  addCheck(
    checks,
    "bundle_attestation_digest",
    !releaseBundleAttestationPresent || releaseBundleAttestationDigestMatches,
    "Release evidence bundle attestation payloadDigest must match the current canonical bundle payload without attestation."
  );
  addCheck(
    checks,
    "bundle_attestation_signature",
    !releaseBundleAttestationSignatureRequired || releaseBundleAttestationSignatureMatches,
    "Production release evidence bundle attestation must include a valid hmac-sha256 signature verified with the configured signing key."
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
  addCheck(
    checks,
    "release_gate_checks_passed",
    checkArrayAllPassed(releaseGate),
    "Release gate evidence must include non-empty checks and all release gate check rows must pass."
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
        sha256DigestPattern.test(stringValue(nestedValue(artifact, ["selectedEvidence", "checksum"])) ?? "") &&
        stringValue(nestedValue(artifact, ["selectedEvidence", "packageBinSiteflow"])) &&
        nestedValue(artifact, ["selectedEvidence", "auditExitCode"]) === 0
    ),
    "Release artifact evidence output must include selected release identity, file/byte counts, checksum, CLI bin path, and successful production dependency audit."
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
        releaseArtifactManifestEntriesPassed(nestedObject(artifact, "manifest"), artifactSelectedEvidence)
    ),
    "Release artifact evidence must include a safe SHA-256 manifest whose file count, total bytes, and checksum match selected evidence."
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
    "Release image provenance and SBOM attestation subjects must be inspected from the registry and bound to the published image digest."
  );
  addCheck(
    checks,
    "release_image_attestation_no_failed_checks",
    releaseImageAttestationNoFailedChecksPassed(releaseImage),
    "Release image attestation evidence must not contain unresolved or failed provenance/SBOM inspection checks."
  );
  addCheck(
    checks,
    "release_image_provenance_attestation",
    releaseImageProvenanceAttestationPassed(releaseImage),
    "Release image evidence must include a present SLSA provenance attestation manifest digest."
  );
  addCheck(
    checks,
    "release_image_provenance_statement",
    releaseImageProvenanceStatementPassed(releaseImage),
    "Release image provenance evidence must include an inspected in-toto statement digest, published-image subject digest, builder identity, and materials."
  );
  addCheck(
    checks,
    "release_image_provenance_source_identity",
    releaseImageProvenanceSourceIdentityPassed(releaseImage, releaseCommitRef, repository, branch),
    "Release image provenance source repository, commit, and ref must match the release image identity."
  );
  addCheck(
    checks,
    "release_image_sbom_attestation",
    releaseImageSbomAttestationPassed(releaseImage),
    "Release image evidence must include a present SPDX or CycloneDX SBOM attestation manifest digest."
  );
  addCheck(
    checks,
    "release_image_sbom_statement",
    releaseImageSbomStatementPassed(releaseImage),
    "Release image SBOM evidence must include an inspected attestation statement digest bound to the published image digest."
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
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "targetIdentity") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "composeConfig") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "workerRuntimePosture") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "startup") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "serviceHealth") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "readiness") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "imageBinding") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "restartSmoke") &&
        selectedEvidenceSummaryPassed(targetRuntimeSelectedEvidence, "logSanity")
    ),
    "Target runtime evidence output must include selected target, release, and timestamped summaries for target identity, Compose config, worker runtime posture, startup, health, readiness, image binding, restart, and log sanity evidence."
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
    "Target runtime evidence output must include passed checks for target identity, Compose config, startup, service health, readiness, image binding, restart smoke, log sanity, redaction, operator, and ticket evidence."
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
    sourceProviderSelectedEvidencePassed(nestedObject(sourceProvider, "selectedEvidence"), releaseCommitRef, repository, branch),
    "Source provider evidence output must include selected environment, release identity, provider, and timestamped checkout, signed webhook, deploy-key, host-key, and provenance summaries."
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
    "backup_name",
    backup?.name === "siteflow-backup-evidence-check",
    "Backup evidence output must be from siteflow-backup-evidence-check."
  );
  addCheck(
    checks,
    "backup_release_identity",
    Boolean(
      releaseCommitRef &&
        repository &&
        branch &&
        evidenceCommitValue(backup) === releaseCommitRef &&
        evidenceRepositoryValue(backup) === repository &&
        evidenceBranchValue(backup) === branch
    ),
    "Backup evidence output must be bound to the release commit, repository, and branch."
  );
  addCheck(
    checks,
    "backup_target_environment",
    Boolean(rootTargetEnvironment && evidenceTargetEnvironmentValue(backup) === rootTargetEnvironment),
    "Backup evidence targetEnvironment must match the release bundle targetEnvironment."
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
    backupSelectedEvidencePassed(nestedObject(backup, "selectedEvidence")),
    "Backup evidence output must include timestamped selected backup verify, restore-drill, offload, fetch, provider security audit, and non-dry-run prune summaries."
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
    "observability_name",
    observability?.name === "siteflow-observability-evidence-check",
    "Observability evidence output must be from siteflow-observability-evidence-check."
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
    checkArrayIncludesPassedNames(observability, requiredObservabilityEvidenceCheckNames),
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
        operatorAccessSelectedEvidencePassed(operatorAccessSelectedEvidence)
    ),
    "Operator access evidence output must include selected target/release metadata and passed timestamped session, scope, CSRF, Bearer precedence, actor, browser token fallback, and emergency cutoff summaries."
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
        nonSessionCredentialSelectedEvidencePassed(nonSessionCredentialSelectedEvidence)
    ),
    "Non-session credential evidence output must include selected target/release metadata, credential types/count, and passed timestamped break-glass summary."
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
        ingressSelectedEvidencePassed(ingressSelectedEvidence)
    ),
    "Ingress evidence output must include selected target/release metadata and passed timestamped proxy, direct-port, forwarded-header, rate-limit, and non-API route summaries."
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
  addCheck(
    checks,
    "metrics_private_scrape_exception_bound",
    metricsPrivateScrapeExceptionBound(runtimeEnv, observability, ingress),
    "Runtime private-scrape metrics exceptions must be backed by observability privateScrapeException evidence and ingress metricsAccessControl proof for a non-public /metrics scrape path."
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
    upgradeRollbackSelectedEvidencePassed(nestedObject(upgradeRollback, "selectedEvidence"), releaseCommitRef, repository, branch, rootTargetEnvironment),
    "Upgrade/rollback drill evidence output must include selected target environment, version pair, distinct operation ids, and timestamped backup, route, readiness, and observability summaries."
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
    Boolean(stringValue(release?.operatorName)),
    "Release evidence bundle must include the release operator name."
  );
  addCheck(
    checks,
    "ticket",
    Boolean(stringValue(release?.ticketId) ?? stringValue(release?.releaseTicket)),
    "Release evidence bundle must include a release or incident ticket id."
  );

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-release-evidence-bundle-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    payloadDigest,
    thresholds: {
      maxEvidenceAgeHours,
      allowHostBuildException: Boolean(options.allowHostBuildException),
      ...(options.allowMissingAttestation ? { allowMissingAttestation: true } : {})
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
    allowHostBuildException: false,
    allowMissingAttestation: false
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
    } else if (arg === "--allow-missing-attestation") {
      parsed.allowMissingAttestation = true;
    } else if (arg === "--attestation-key-env") {
      parsed.attestationKeyEnv = args[++index];
    } else if (arg === "--attestation-key-file") {
      parsed.attestationKeyFile = args[++index];
    } else if (arg === "--required-attestation-key-id-env" || arg === "--attestation-key-id-env") {
      parsed.requiredAttestationKeyIdEnv = args[++index];
    } else if (arg === "--required-attestation-key-id" || arg === "--attestation-key-id") {
      parsed.requiredAttestationKeyId = args[++index];
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
    "  --allow-missing-attestation       Explicitly allow a production bundle without compose-generated attestation metadata.",
    "  --attestation-key-env <name>      Read the release evidence attestation HMAC key from an environment variable.",
    "  --attestation-key-file <file>     Read the release evidence attestation HMAC key from a file.",
    "  --attestation-key-id-env <name>   Read the required non-secret signing key id from an environment variable.",
    "  --attestation-key-id <id>         Require the signed attestation key id.",
    "  --json                           Emit a single JSON result.",
    "  --help                           Show this help."
  ].join("\n");
}

function envSecretValue(envName: string | undefined) {
  const value = envName ? process.env[envName]?.trim() : undefined;

  return value || undefined;
}

async function fileSecretValue(filePath: string | undefined) {
  if (!filePath) {
    return undefined;
  }

  const value = (await readFile(filePath, "utf8")).replace(/[\r\n]+$/g, "");

  return value.trim() ? value : undefined;
}

async function resolveAttestationSigningKey(
  parsed: ParsedArgs,
  baseOptions: Partial<ReleaseEvidenceBundleCheckOptions>
) {
  const envKey = envSecretValue(parsed.attestationKeyEnv) ??
    envSecretValue("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY");

  if (baseOptions.attestationSigningKey ?? envKey) {
    return baseOptions.attestationSigningKey ?? envKey;
  }

  return await fileSecretValue(parsed.attestationKeyFile) ??
    await fileSecretValue(process.env.SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE);
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
    const attestationSigningKey = await resolveAttestationSigningKey(parsed, baseOptions);
    const requiredAttestationKeyId = parsed.requiredAttestationKeyId ??
      envSecretValue(parsed.requiredAttestationKeyIdEnv) ??
      baseOptions.requiredAttestationKeyId ??
      releaseEvidenceRequiredAttestationKeyIdFromEnv();
    const result = await runReleaseEvidenceBundleCheck({
      ...baseOptions,
      evidencePath: parsed.evidencePath!,
      commitRef: parsed.commitRef,
      repo: parsed.repo,
      branch: parsed.branch,
      targetEnvironment: parsed.targetEnvironment,
      maxEvidenceAgeHours: parsed.maxEvidenceAgeHours,
      allowHostBuildException: parsed.allowHostBuildException,
      allowMissingAttestation: parsed.allowMissingAttestation,
      attestationSigningKey,
      requiredAttestationKeyId
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
      payloadDigest: null,
      thresholds: {
        maxEvidenceAgeHours: parsed.maxEvidenceAgeHours,
        allowHostBuildException: parsed.allowHostBuildException,
        ...(parsed.allowMissingAttestation ? { allowMissingAttestation: true } : {})
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
