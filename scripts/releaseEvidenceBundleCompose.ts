import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck.js";
import { strictIsoTimestampValue } from "./isoTimestamp.js";
import { requiredNonSessionCredentialEvidenceCheckNames } from "./nonSessionCredentialEvidenceCheck.js";
import { requiredObservabilityEvidenceCheckNames } from "./observabilityEvidenceCheck.js";
import { requiredOperatorAccessEvidenceCheckNames } from "./operatorAccessEvidenceCheck.js";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts.js";
import { bundleWithReleaseEvidenceAttestation } from "./releaseEvidenceBundleCheck.js";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck.js";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck.js";
import { requiredUpgradeRollbackDrillEvidenceCheckNames } from "./upgradeRollbackDrillEvidenceCheck.js";

type ComposeStatus = "composed" | "blocked";

export interface ReleaseEvidenceBundleComposeOptions {
  releaseGatePath: string;
  postgresRehearsalPath: string;
  artifactEvidencePath: string;
  releaseImageEvidencePath: string;
  targetRuntimeEvidencePath: string;
  sourceProviderEvidencePath: string;
  backupEvidencePath: string;
  observabilityEvidencePath: string;
  operatorAccessEvidencePath: string;
  nonSessionCredentialEvidencePath: string;
  ingressEvidencePath: string;
  upgradeRollbackEvidencePath: string;
  dockerBuildRehearsalPath?: string;
  outputPath?: string;
  targetEnvironment?: string;
  checkedAt?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  requiredStatusCheck?: string;
  operatorName?: string;
  releaseTicket?: string;
  dockerSocketProfileAccepted?: boolean;
  hostBuildExceptionAccepted?: boolean;
  attestationSigningKey?: string;
  attestationSigningKeyId?: string;
  now?: () => Date;
}

export interface ReleaseEvidenceBundleComposeResult {
  name: "siteflow-release-evidence-bundle-compose";
  status: ComposeStatus;
  checkedAt: string;
  outputPath?: string;
  bundle?: Record<string, unknown>;
  exitCode: number;
}

interface ParsedArgs {
  releaseGatePath?: string;
  dockerBuildRehearsalPath?: string;
  postgresRehearsalPath?: string;
  artifactEvidencePath?: string;
  releaseImageEvidencePath?: string;
  targetRuntimeEvidencePath?: string;
  sourceProviderEvidencePath?: string;
  backupEvidencePath?: string;
  observabilityEvidencePath?: string;
  operatorAccessEvidencePath?: string;
  nonSessionCredentialEvidencePath?: string;
  ingressEvidencePath?: string;
  upgradeRollbackEvidencePath?: string;
  outputPath?: string;
  targetEnvironment?: string;
  checkedAt?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  requiredStatusCheck?: string;
  operatorName?: string;
  releaseTicket?: string;
  dockerSocketProfileAccepted: boolean;
  hostBuildExceptionAccepted: boolean;
  attestationKeyEnv?: string;
  attestationKeyFile?: string;
  attestationKeyIdEnv?: string;
  attestationSigningKeyId?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const expectedSchemaVersion = "siteflow.releaseEvidence.v1";
const expectedBundleName = "siteflow-release-evidence-bundle";
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;
const requiredBackupEvidenceCheckNames = [...requiredOffHostBackupEvidenceCheckNames];

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

async function readEvidenceJson(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

function promotionEvidence(releaseGate: Record<string, unknown>) {
  const direct = nestedObject(releaseGate, "promotionEvidence");

  if (direct) {
    return direct;
  }

  if (stringValue(releaseGate.gateStatus)) {
    return releaseGate;
  }

  throw new Error("Release gate evidence must contain promotionEvidence.");
}

function resolveReleaseMetadata(
  releaseGate: Record<string, unknown>,
  options: ReleaseEvidenceBundleComposeOptions
) {
  const promotion = promotionEvidence(releaseGate);
  const commitRef =
    options.commitRef ??
    stringValue(promotion.commitRef) ??
    stringValue(nestedValue(promotion, ["commitStatus", "commitRef"]));
  const repository =
    options.repo ??
    stringValue(promotion.repository) ??
    stringValue(nestedValue(promotion, ["commitStatus", "repository"])) ??
    stringValue(nestedValue(promotion, ["branchProtection", "repository"]));
  const branch =
    options.branch ??
    stringValue(promotion.branch) ??
    stringValue(nestedValue(promotion, ["branchProtection", "branch"]));
  const requiredStatusCheck =
    options.requiredStatusCheck ??
    stringValue(promotion.requiredStatusCheck) ??
    stringValue(nestedValue(promotion, ["commitStatus", "requiredStatusCheck"])) ??
    stringValue(nestedValue(promotion, ["branchProtection", "requiredStatusCheck"]));
  const operatorName = stringValue(options.operatorName);
  const releaseTicket = stringValue(options.releaseTicket);

  if (!commitRef) {
    throw new Error("A release commit is required. Pass --commit-ref or provide it in release-gate promotion evidence.");
  }

  if (!repository) {
    throw new Error("A repository is required. Pass --repo or provide it in release-gate promotion evidence.");
  }

  if (!branch) {
    throw new Error("A branch is required. Pass --branch or provide it in release-gate promotion evidence.");
  }

  if (!requiredStatusCheck) {
    throw new Error("A required status check is required. Pass --required-status-check or provide it in release-gate promotion evidence.");
  }

  if (!operatorName) {
    throw new Error("--operator-name is required.");
  }

  if (!releaseTicket) {
    throw new Error("--release-ticket is required.");
  }

  return {
    commitRef,
    repository,
    branch,
    requiredStatusCheck,
    operatorName,
    releaseTicket
  };
}

function dockerBuildRequired(releaseGate: Record<string, unknown>) {
  const promotion = promotionEvidence(releaseGate);
  return nestedValue(promotion, ["runtimeEnv", "buildRunner"]) === "docker";
}

function hostBuildExceptionRequired(releaseGate: Record<string, unknown>) {
  const promotion = promotionEvidence(releaseGate);

  return nestedValue(promotion, ["runtimeEnv", "buildRunner"]) === "host" &&
    nestedValue(promotion, ["runtimeEnv", "hostBuildException"]) === true;
}

function attachment(sourcePath: string, releaseCommit: string, collectedAt: string, evidence: Record<string, unknown>) {
  return {
    sourcePath,
    collectedAt,
    releaseCommit,
    evidence
  };
}

function assertComposedEvidenceIsFinal(label: string, evidence: Record<string, unknown>) {
  if (evidence.template === true) {
    throw new Error(`${label} evidence is a template and must be replaced with checked target evidence before compose.`);
  }

  if (evidence.dryRun === true) {
    throw new Error(`${label} evidence is dry-run output and must be replaced with checked target evidence before compose.`);
  }

  const status = stringValue(evidence.status)?.toLowerCase();

  if (status === "blocked" || status === "todo") {
    throw new Error(`${label} evidence has status ${status} and must pass its evidence checker before compose.`);
  }

  const secretFindings = scanEvidenceForRawSecrets(evidence);

  if (secretFindings.length > 0) {
    throw new Error(`${label} evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`);
  }
}

function evidenceCheckRows(evidence: Record<string, unknown>) {
  return Array.isArray(evidence.checks)
    ? evidence.checks.filter(isObject)
    : [];
}

function evidencePassedCheckNames(evidence: Record<string, unknown>) {
  return new Set(
    evidenceCheckRows(evidence)
      .filter((check) => stringValue(check.status)?.toLowerCase() === "pass")
      .map((check) => stringValue(check.name))
      .filter((name): name is string => Boolean(name))
  );
}

function evidenceChecksAllPassed(evidence: Record<string, unknown>) {
  const checks = evidenceCheckRows(evidence);

  return checks.length > 0 && checks.every((check) => stringValue(check.status)?.toLowerCase() === "pass");
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

function evidenceSelectedEvidence(evidence: Record<string, unknown>) {
  return nestedObject(evidence, "selectedEvidence");
}

function selectedEvidenceSummaryMatches(
  selectedEvidence: Record<string, unknown> | undefined,
  key: string,
  allowedStatuses: ReadonlySet<string> = defaultSelectedEvidenceSummaryStatuses
) {
  const summary = nestedObject(selectedEvidence, key);

  return Boolean(
    summary &&
      allowedStatuses.has(stringValue(summary.status)?.toLowerCase() ?? "") &&
      timestampValue(summary.timestamp)
  );
}

function assertSelectedEvidenceSummariesFinal(
  label: string,
  evidence: Record<string, unknown>,
  requirements: Array<{ key: string; statuses?: ReadonlySet<string> }>
) {
  const selectedEvidence = evidenceSelectedEvidence(evidence);
  const missing = requirements
    .filter((requirement) => !selectedEvidenceSummaryMatches(selectedEvidence, requirement.key, requirement.statuses))
    .map((requirement) => requirement.key);

  if (missing.length > 0) {
    throw new Error(`${label} evidence selectedEvidence summaries must include allowed status and timestamp before compose: ${missing.join(", ")}.`);
  }
}

function assertNonSessionCredentialSelectedEvidenceFinal(evidence: Record<string, unknown>) {
  const selectedEvidence = evidenceSelectedEvidence(evidence);
  const credentialTypes = nestedValue(selectedEvidence, ["credentialTypes"]);
  const credentialCount = Number(nestedValue(selectedEvidence, ["credentialCount"]));

  if (
    !Array.isArray(credentialTypes) ||
    credentialTypes.length === 0 ||
    !credentialTypes.every((entry) => typeof entry === "string" && entry.trim()) ||
    !Number.isInteger(credentialCount) ||
    credentialCount <= 0
  ) {
    throw new Error("non-session credential evidence selectedEvidence must include non-empty credentialTypes and a positive credentialCount before compose.");
  }

  assertSelectedEvidenceSummariesFinal("non-session credential", evidence, [{ key: "breakGlass" }]);
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

function assertBackupSelectedEvidenceFinal(evidence: Record<string, unknown>) {
  if (!backupSelectedEvidencePassed(evidenceSelectedEvidence(evidence))) {
    throw new Error("backup evidence selectedEvidence must include timestamped backup verify, restore-drill, offload, fetch, provider security audit, and non-dry-run prune summaries before compose.");
  }
}

function sourceProviderSelectedEvidencePassed(
  selectedEvidence: Record<string, unknown> | undefined,
  release: { commitRef: string; repository: string; branch: string }
) {
  const checkout = nestedObject(selectedEvidence, "checkout");
  const signedWebhook = nestedObject(selectedEvidence, "signedWebhook");
  const deployKey = nestedObject(selectedEvidence, "deployKey");
  const hostKey = nestedObject(selectedEvidence, "hostKey");
  const releaseProvenance = nestedObject(selectedEvidence, "releaseProvenance");

  return Boolean(
    stringValue(selectedEvidence?.environment) &&
      stringValue(selectedEvidence?.commitRef) === release.commitRef &&
      stringValue(selectedEvidence?.repository) === release.repository &&
      stringValue(selectedEvidence?.branch) === release.branch &&
      stringValue(selectedEvidence?.provider) &&
      stringValue(selectedEvidence?.webhookDeliveryId) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "checkout") &&
      (stringValue(checkout?.commitRef) === release.commitRef || stringValue(checkout?.headSha) === release.commitRef) &&
      checkout?.exactCommitVerified === true &&
      selectedEvidenceSummaryMatches(selectedEvidence, "signedWebhook") &&
      stringValue(signedWebhook?.deliveryId) === stringValue(selectedEvidence?.webhookDeliveryId) &&
      signedWebhook?.signatureVerified === true &&
      selectedEvidenceSummaryMatches(selectedEvidence, "deployKey", notRequiredSelectedEvidenceSummaryStatuses) &&
      (stringValue(deployKey?.status)?.toLowerCase() === "not_required" || deployKey?.mounted === true) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "hostKey", notRequiredSelectedEvidenceSummaryStatuses) &&
      (stringValue(hostKey?.status)?.toLowerCase() === "not_required" || hostKey?.pinned === true) &&
      selectedEvidenceSummaryMatches(selectedEvidence, "releaseProvenance") &&
      stringValue(releaseProvenance?.commitRef) === release.commitRef &&
      stringValue(releaseProvenance?.repository) === release.repository &&
      stringValue(releaseProvenance?.branch) === release.branch
  );
}

function assertSourceProviderSelectedEvidenceFinal(evidence: Record<string, unknown>, release: { commitRef: string; repository: string; branch: string }) {
  if (!sourceProviderSelectedEvidencePassed(evidenceSelectedEvidence(evidence), release)) {
    throw new Error("source provider evidence selectedEvidence must include release-bound timestamped checkout, signed webhook, deploy-key, host-key, and provenance summaries before compose.");
  }
}

function upgradeRollbackSelectedEvidencePassed(
  selectedEvidence: Record<string, unknown> | undefined,
  release: { commitRef: string; repository: string; branch: string },
  targetEnvironment: string
) {
  const fromVersion = stringValue(selectedEvidence?.fromVersion);
  const toVersion = stringValue(selectedEvidence?.toVersion);
  const rollbackVersion = stringValue(selectedEvidence?.rollbackVersion);
  const upgradeOperationId = stringValue(selectedEvidence?.upgradeOperationId);
  const rollbackOperationId = stringValue(selectedEvidence?.rollbackOperationId);

  return Boolean(
    stringValue(selectedEvidence?.commitRef) === release.commitRef &&
      stringValue(selectedEvidence?.repository) === release.repository &&
      stringValue(selectedEvidence?.branch) === release.branch &&
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

function assertUpgradeRollbackSelectedEvidenceFinal(
  evidence: Record<string, unknown>,
  release: { commitRef: string; repository: string; branch: string },
  targetEnvironment: string
) {
  if (!upgradeRollbackSelectedEvidencePassed(evidenceSelectedEvidence(evidence), release, targetEnvironment)) {
    throw new Error("upgrade/rollback drill evidence selectedEvidence must include release-bound version pair, distinct operation ids, and timestamped backup, route, readiness, and observability summaries before compose.");
  }
}

function optionalEvidenceTargetEnvironment(evidence: Record<string, unknown>) {
  return stringValue(evidence.targetEnvironment) ??
    stringValue(nestedValue(evidence, ["release", "targetEnvironment"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "targetEnvironment"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "environment"]));
}

function assertCheckerOutputFinal(
  label: string,
  evidence: Record<string, unknown>,
  expectedName: string,
  options: {
    requiredChecks?: readonly string[];
    targetEnvironment?: string;
    requireTargetEnvironment?: boolean;
  } = {}
) {
  assertComposedEvidenceIsFinal(label, evidence);

  if (evidence.name !== expectedName) {
    throw new Error(`${label} evidence must be checked by ${expectedName} before compose.`);
  }

  if (stringValue(evidence.status)?.toLowerCase() !== "passed") {
    throw new Error(`${label} evidence must have status passed before compose.`);
  }

  if (evidence.exitCode !== 0) {
    throw new Error(`${label} evidence must have exitCode 0 before compose.`);
  }

  if (!timestampValue(evidence.checkedAt)) {
    throw new Error(`${label} evidence must include a checkedAt timestamp before compose.`);
  }

  if (!evidenceChecksAllPassed(evidence)) {
    throw new Error(`${label} evidence must include non-empty checks and all checks must pass before compose.`);
  }

  const requiredChecks = options.requiredChecks ?? [];
  const passedNames = evidencePassedCheckNames(evidence);
  const missingChecks = requiredChecks.filter((name) => !passedNames.has(name));

  if (missingChecks.length > 0) {
    throw new Error(`${label} evidence is missing required passed checks before compose: ${missingChecks.join(", ")}.`);
  }

  const targetEnvironment = optionalEvidenceTargetEnvironment(evidence);

  if (options.requireTargetEnvironment && !targetEnvironment) {
    throw new Error(`${label} evidence must include target environment before compose.`);
  }

  if (options.targetEnvironment && targetEnvironment && targetEnvironment !== options.targetEnvironment) {
    throw new Error(`${label} evidence target environment ${targetEnvironment} does not match ${options.targetEnvironment}.`);
  }
}

function assertReleaseGateEvidenceFinal(releaseGate: Record<string, unknown>) {
  assertComposedEvidenceIsFinal("release-gate", releaseGate);

  const promotion = promotionEvidence(releaseGate);

  if (stringValue(releaseGate.status)?.toLowerCase() !== "pass" || stringValue(promotion?.gateStatus)?.toLowerCase() !== "pass") {
    throw new Error("release-gate evidence must have status pass before compose.");
  }

  if (!evidenceChecksAllPassed(releaseGate)) {
    throw new Error("release-gate evidence must include non-empty checks and all checks must pass before compose.");
  }

  if (
    promotion?.manualRequired === true ||
    (Array.isArray(promotion?.manualRequiredCheckIds) && promotion.manualRequiredCheckIds.length > 0)
  ) {
    throw new Error("release-gate evidence must not contain manual_required checks before compose.");
  }

  if (!timestampValue(releaseGate.checkedAt) && !timestampValue(promotion?.checkedAt)) {
    throw new Error("release-gate evidence must include a checkedAt timestamp before compose.");
  }
}

function assertRehearsalEvidenceFinal(label: string, evidence: Record<string, unknown>) {
  assertComposedEvidenceIsFinal(label, evidence);

  if (stringValue(evidence.status)?.toLowerCase() !== "passed") {
    throw new Error(`${label} evidence must have status passed before compose.`);
  }

  if (evidence.dryRun !== false) {
    throw new Error(`${label} evidence must be non-dry-run output before compose.`);
  }

  if (evidence.exitCode !== 0) {
    throw new Error(`${label} evidence must have exitCode 0 before compose.`);
  }

  if (!timestampValue(evidence.completedAt)) {
    throw new Error(`${label} evidence must include a completedAt timestamp before compose.`);
  }
}

function assertReleaseImageEvidenceFinal(evidence: Record<string, unknown>) {
  assertComposedEvidenceIsFinal("release image", evidence);

  if (!timestampValue(evidence.checkedAt)) {
    throw new Error("release image evidence must include a checkedAt timestamp before compose.");
  }
}

function optionalEvidenceCommit(evidence: Record<string, unknown>) {
  return stringValue(evidence.releaseCommit) ??
    stringValue(evidence.commitRef) ??
    stringValue(evidence.commitSha) ??
    stringValue(nestedValue(evidence, ["release", "commitRef"])) ??
    stringValue(nestedValue(evidence, ["release", "commitSha"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "commitRef"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "releaseCommitRef"]));
}

function optionalEvidenceRepository(evidence: Record<string, unknown>) {
  return stringValue(evidence.repository) ??
    stringValue(nestedValue(evidence, ["release", "repository"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "repository"]));
}

function optionalEvidenceBranch(evidence: Record<string, unknown>) {
  return stringValue(evidence.branch) ??
    stringValue(nestedValue(evidence, ["release", "branch"])) ??
    stringValue(nestedValue(evidence, ["selectedEvidence", "branch"]));
}

function assertEvidenceIdentity(
  name: string,
  evidence: Record<string, unknown>,
  release: { commitRef: string; repository: string; branch: string },
  options: { requireIdentity?: boolean } = {}
) {
  const commitRef = optionalEvidenceCommit(evidence);
  const repository = optionalEvidenceRepository(evidence);
  const branch = optionalEvidenceBranch(evidence);

  if (options.requireIdentity && (!commitRef || !repository || !branch)) {
    throw new Error(`${name} evidence must include commit, repository, and branch release identity.`);
  }

  if (commitRef && commitRef !== release.commitRef) {
    throw new Error(`${name} evidence commit ${commitRef} does not match release commit ${release.commitRef}.`);
  }

  if (repository && repository !== release.repository) {
    throw new Error(`${name} evidence repository ${repository} does not match release repository ${release.repository}.`);
  }

  if (branch && branch !== release.branch) {
    throw new Error(`${name} evidence branch ${branch} does not match release branch ${release.branch}.`);
  }
}

function assertEvidenceTargetEnvironment(
  name: string,
  evidence: Record<string, unknown>,
  targetEnvironment: string,
  options: { requireIdentity?: boolean } = {}
) {
  const actualTargetEnvironment = optionalEvidenceTargetEnvironment(evidence);

  if (options.requireIdentity && !actualTargetEnvironment) {
    throw new Error(`${name} evidence must include target environment release identity.`);
  }

  if (actualTargetEnvironment && actualTargetEnvironment !== targetEnvironment) {
    throw new Error(`${name} evidence target environment ${actualTargetEnvironment} does not match release target environment ${targetEnvironment}.`);
  }
}

function releaseImageCommit(evidence: Record<string, unknown>) {
  return stringValue(nestedValue(evidence, ["source", "commitRef"]));
}

function releaseImageRepository(evidence: Record<string, unknown>) {
  return stringValue(nestedValue(evidence, ["source", "repository"]));
}

function assertReleaseImageEvidenceIdentity(
  evidence: Record<string, unknown>,
  release: { commitRef: string; repository: string }
) {
  const commitRef = releaseImageCommit(evidence);
  const repository = releaseImageRepository(evidence);

  if (!commitRef || !repository) {
    throw new Error("release image evidence must include source commit and repository release identity.");
  }

  if (commitRef !== release.commitRef) {
    throw new Error(`release image evidence commit ${commitRef} does not match release commit ${release.commitRef}.`);
  }

  if (repository !== release.repository) {
    throw new Error(`release image evidence repository ${repository} does not match release repository ${release.repository}.`);
  }
}

function assertReleaseImageEvidenceAttestations(evidence: Record<string, unknown>) {
  const imageDigest = stringValue(nestedValue(evidence, ["image", "digest"]));
  const attestations = nestedObject(evidence, "attestations");
  const subjectDigest = stringValue(attestations?.subjectDigest);
  const provenance = nestedObject(attestations, "provenance");
  const sbom = nestedObject(attestations, "sbom");
  const provenancePredicateType = stringValue(provenance?.predicateType);
  const sbomPredicateType = stringValue(sbom?.predicateType);

  if (!imageDigest || !sha256DigestPattern.test(imageDigest)) {
    throw new Error("release image evidence must include a sha256 image digest before attestation validation.");
  }

  if (!attestations || subjectDigest !== imageDigest) {
    throw new Error("release image evidence attestations must be inspected from the registry and bound to the image digest.");
  }

  if (stringValue(attestations.mode) !== "registry" || !stringValue(attestations.inspector) || !timestampValue(attestations.inspectedAt)) {
    throw new Error("release image evidence attestations must include registry inspection metadata.");
  }

  if (
    provenance?.requested !== true ||
    provenance?.present !== true ||
    !provenancePredicateType?.startsWith("https://slsa.dev/provenance/") ||
    !sha256DigestPattern.test(stringValue(provenance?.manifestDigest) ?? "")
  ) {
    throw new Error("release image evidence must include a present SLSA provenance attestation manifest digest.");
  }

  if (
    sbom?.requested !== true ||
    sbom?.present !== true ||
    !(sbomPredicateType?.startsWith("https://spdx.dev/") || sbomPredicateType?.startsWith("https://cyclonedx.org/")) ||
    !sha256DigestPattern.test(stringValue(sbom?.manifestDigest) ?? "")
  ) {
    throw new Error("release image evidence must include a present SPDX or CycloneDX SBOM attestation manifest digest.");
  }
}

export async function composeReleaseEvidenceBundle(
  options: ReleaseEvidenceBundleComposeOptions
): Promise<ReleaseEvidenceBundleComposeResult> {
  const now = options.now ?? (() => new Date());
  const checkedAt = options.checkedAt
    ? timestampValue(options.checkedAt)
    : now().toISOString();

  if (!checkedAt) {
    throw new Error("--checked-at must be a valid ISO timestamp.");
  }

  const releaseGate = await readEvidenceJson(options.releaseGatePath);
  const release = resolveReleaseMetadata(releaseGate, options);
  const targetEnvironment = options.targetEnvironment ?? "production";
  const needsDockerBuild = dockerBuildRequired(releaseGate);
  const needsHostBuildException = hostBuildExceptionRequired(releaseGate);

  if (needsDockerBuild && !options.dockerBuildRehearsalPath) {
    throw new Error("Docker build rehearsal evidence is required because release-gate promotion evidence uses SITEFLOW_BUILD_RUNNER=docker.");
  }

  if (needsDockerBuild && !options.dockerSocketProfileAccepted) {
    throw new Error("Docker socket trusted profile must be explicitly accepted with --docker-socket-profile-accepted.");
  }

  if (needsHostBuildException && !options.hostBuildExceptionAccepted) {
    throw new Error("Host build exception must be explicitly accepted with --host-build-exception-accepted.");
  }

  const dockerBuild = options.dockerBuildRehearsalPath
    ? await readEvidenceJson(options.dockerBuildRehearsalPath)
    : undefined;
  const postgres = await readEvidenceJson(options.postgresRehearsalPath);
  const artifact = await readEvidenceJson(options.artifactEvidencePath);
  const releaseImage = await readEvidenceJson(options.releaseImageEvidencePath);
  const targetRuntime = await readEvidenceJson(options.targetRuntimeEvidencePath);
  const sourceProvider = await readEvidenceJson(options.sourceProviderEvidencePath);
  const backup = await readEvidenceJson(options.backupEvidencePath);
  const observability = await readEvidenceJson(options.observabilityEvidencePath);
  const operatorAccess = await readEvidenceJson(options.operatorAccessEvidencePath);
  const nonSessionCredential = await readEvidenceJson(options.nonSessionCredentialEvidencePath);
  const ingress = await readEvidenceJson(options.ingressEvidencePath);
  const upgradeRollback = await readEvidenceJson(options.upgradeRollbackEvidencePath);

  assertReleaseGateEvidenceFinal(releaseGate);
  if (dockerBuild) {
    assertRehearsalEvidenceFinal("docker build rehearsal", dockerBuild);
  }
  assertRehearsalEvidenceFinal("postgres rehearsal", postgres);
  assertReleaseImageEvidenceFinal(releaseImage);

  assertCheckerOutputFinal("release artifact", artifact, "siteflow-release-artifact-check", {
    requiredChecks: requiredReleaseArtifactCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertCheckerOutputFinal("source provider", sourceProvider, "siteflow-source-provider-evidence-check", {
    requiredChecks: requiredSourceProviderEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertCheckerOutputFinal("target runtime", targetRuntime, "siteflow-target-runtime-evidence-check", {
    requiredChecks: requiredTargetRuntimeEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertCheckerOutputFinal("backup", backup, "siteflow-backup-evidence-check", {
    requiredChecks: requiredBackupEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertBackupSelectedEvidenceFinal(backup);
  assertCheckerOutputFinal("observability", observability, "siteflow-observability-evidence-check", {
    requiredChecks: requiredObservabilityEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertCheckerOutputFinal("operator access", operatorAccess, "siteflow-operator-access-evidence-check", {
    requiredChecks: requiredOperatorAccessEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertSelectedEvidenceSummariesFinal("operator access", operatorAccess, [
    { key: "sessionCreate" },
    { key: "projectScope" },
    { key: "sessionRotation" },
    { key: "sessionRevoke", statuses: revokedSelectedEvidenceSummaryStatuses },
    { key: "csrf", statuses: enforcedSelectedEvidenceSummaryStatuses },
    { key: "bearerPrecedence" },
    { key: "actorAttribution" },
    { key: "browserTokenFallback" },
    { key: "emergencyCutoff" }
  ]);
  assertCheckerOutputFinal("non-session credential", nonSessionCredential, "siteflow-non-session-credential-evidence-check", {
    requiredChecks: requiredNonSessionCredentialEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertNonSessionCredentialSelectedEvidenceFinal(nonSessionCredential);
  assertCheckerOutputFinal("ingress", ingress, "siteflow-ingress-evidence-check", {
    requiredChecks: requiredIngressEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });
  assertSelectedEvidenceSummariesFinal("ingress", ingress, [
    { key: "directApiPort", statuses: blockedSelectedEvidenceSummaryStatuses },
    { key: "forwardedHeaders" },
    { key: "apiRateLimit", statuses: limitedSelectedEvidenceSummaryStatuses },
    { key: "unthrottledRoutes" }
  ]);
  assertCheckerOutputFinal("upgrade/rollback drill", upgradeRollback, "siteflow-upgrade-rollback-drill-evidence-check", {
    requiredChecks: requiredUpgradeRollbackDrillEvidenceCheckNames,
    targetEnvironment,
    requireTargetEnvironment: true
  });

  assertEvidenceIdentity("release-gate", promotionEvidence(releaseGate), release);
  assertEvidenceIdentity("postgres rehearsal", postgres, release, { requireIdentity: true });
  assertEvidenceIdentity("release artifact", artifact, release, { requireIdentity: true });
  assertEvidenceTargetEnvironment("release artifact", artifact, targetEnvironment, { requireIdentity: true });
  assertReleaseImageEvidenceIdentity(releaseImage, release);
  assertReleaseImageEvidenceAttestations(releaseImage);
  assertEvidenceIdentity("target runtime", targetRuntime, release);
  assertEvidenceTargetEnvironment("target runtime", targetRuntime, targetEnvironment, { requireIdentity: true });
  assertEvidenceIdentity("source provider", sourceProvider, release);
  assertEvidenceTargetEnvironment("source provider", sourceProvider, targetEnvironment, { requireIdentity: true });
  assertSourceProviderSelectedEvidenceFinal(sourceProvider, release);
  assertEvidenceIdentity("backup", backup, release, { requireIdentity: true });
  assertEvidenceTargetEnvironment("backup", backup, targetEnvironment, { requireIdentity: true });
  assertEvidenceIdentity("observability", observability, release, { requireIdentity: true });
  assertEvidenceTargetEnvironment("observability", observability, targetEnvironment, { requireIdentity: true });
  assertEvidenceIdentity("operator access", operatorAccess, release);
  assertEvidenceTargetEnvironment("operator access", operatorAccess, targetEnvironment, { requireIdentity: true });
  assertEvidenceIdentity("non-session credential", nonSessionCredential, release);
  assertEvidenceTargetEnvironment("non-session credential", nonSessionCredential, targetEnvironment, { requireIdentity: true });
  assertEvidenceIdentity("ingress", ingress, release);
  assertEvidenceTargetEnvironment("ingress", ingress, targetEnvironment, { requireIdentity: true });
  assertEvidenceIdentity("upgrade/rollback drill", upgradeRollback, release);
  assertEvidenceTargetEnvironment("upgrade/rollback drill", upgradeRollback, targetEnvironment, { requireIdentity: true });
  assertUpgradeRollbackSelectedEvidenceFinal(upgradeRollback, release, targetEnvironment);

  if (dockerBuild) {
    assertEvidenceIdentity("Docker build rehearsal", dockerBuild, release, { requireIdentity: true });
  }

  const bundlePayload: Record<string, unknown> = {
    schemaVersion: expectedSchemaVersion,
    name: expectedBundleName,
    checkedAt,
    targetEnvironment,
    release: {
      ...release,
      targetEnvironment,
      ...(options.dockerSocketProfileAccepted ? { dockerSocketProfileAccepted: true } : {}),
      ...(options.hostBuildExceptionAccepted ? { hostBuildExceptionAccepted: true } : {})
    },
    releaseGate: attachment(options.releaseGatePath, release.commitRef, checkedAt, releaseGate),
    ...(dockerBuild && options.dockerBuildRehearsalPath
      ? { dockerBuildRehearsal: attachment(options.dockerBuildRehearsalPath, release.commitRef, checkedAt, dockerBuild) }
      : {}),
    postgresRehearsal: attachment(options.postgresRehearsalPath, release.commitRef, checkedAt, postgres),
    artifactEvidence: attachment(options.artifactEvidencePath, release.commitRef, checkedAt, artifact),
    releaseImageEvidence: attachment(options.releaseImageEvidencePath, release.commitRef, checkedAt, releaseImage),
    targetRuntimeEvidence: attachment(options.targetRuntimeEvidencePath, release.commitRef, checkedAt, targetRuntime),
    sourceProviderEvidence: attachment(options.sourceProviderEvidencePath, release.commitRef, checkedAt, sourceProvider),
    backupEvidence: attachment(options.backupEvidencePath, release.commitRef, checkedAt, backup),
    observabilityEvidence: attachment(options.observabilityEvidencePath, release.commitRef, checkedAt, observability),
    operatorAccessEvidence: attachment(options.operatorAccessEvidencePath, release.commitRef, checkedAt, operatorAccess),
    nonSessionCredentialEvidence: attachment(options.nonSessionCredentialEvidencePath, release.commitRef, checkedAt, nonSessionCredential),
    ingressEvidence: attachment(options.ingressEvidencePath, release.commitRef, checkedAt, ingress),
    upgradeRollbackEvidence: attachment(options.upgradeRollbackEvidencePath, release.commitRef, checkedAt, upgradeRollback)
  };
  const bundle = bundleWithReleaseEvidenceAttestation(bundlePayload, checkedAt, {
    attestationSigningKey: options.attestationSigningKey,
    attestationSigningKeyId: options.attestationSigningKeyId
  });
  const bundleSecretFindings = scanEvidenceForRawSecrets(bundle);

  if (bundleSecretFindings.length > 0) {
    throw new Error(`Release evidence bundle includes raw secret-like values: ${evidenceSecretFindingSummary(bundleSecretFindings)}.`);
  }

  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }

  return {
    name: "siteflow-release-evidence-bundle-compose",
    status: "composed",
    checkedAt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    bundle,
    exitCode: 0
  };
}

export function parseReleaseEvidenceBundleComposeArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dockerSocketProfileAccepted: false,
    hostBuildExceptionAccepted: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--release-gate") {
      parsed.releaseGatePath = args[++index];
    } else if (arg === "--docker-build" || arg === "--docker-build-rehearsal") {
      parsed.dockerBuildRehearsalPath = args[++index];
    } else if (arg === "--postgres" || arg === "--postgres-rehearsal") {
      parsed.postgresRehearsalPath = args[++index];
    } else if (arg === "--artifact" || arg === "--artifact-evidence" || arg === "--release-artifact-evidence") {
      parsed.artifactEvidencePath = args[++index];
    } else if (arg === "--release-image" || arg === "--release-image-evidence" || arg === "--image-evidence") {
      parsed.releaseImageEvidencePath = args[++index];
    } else if (arg === "--target-runtime" || arg === "--target-runtime-evidence") {
      parsed.targetRuntimeEvidencePath = args[++index];
    } else if (arg === "--source-provider" || arg === "--source-provider-evidence" || arg === "--source-provenance-evidence") {
      parsed.sourceProviderEvidencePath = args[++index];
    } else if (arg === "--backup" || arg === "--backup-evidence") {
      parsed.backupEvidencePath = args[++index];
    } else if (arg === "--observability" || arg === "--observability-evidence") {
      parsed.observabilityEvidencePath = args[++index];
    } else if (arg === "--operator-access" || arg === "--operator-access-evidence") {
      parsed.operatorAccessEvidencePath = args[++index];
    } else if (arg === "--non-session-credential" || arg === "--non-session-credential-evidence" || arg === "--credential-evidence") {
      parsed.nonSessionCredentialEvidencePath = args[++index];
    } else if (arg === "--ingress" || arg === "--ingress-evidence") {
      parsed.ingressEvidencePath = args[++index];
    } else if (arg === "--upgrade-rollback" || arg === "--upgrade-rollback-evidence") {
      parsed.upgradeRollbackEvidencePath = args[++index];
    } else if (arg === "--output") {
      parsed.outputPath = args[++index];
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = args[++index];
    } else if (arg === "--checked-at") {
      parsed.checkedAt = args[++index];
    } else if (arg === "--commit-ref") {
      parsed.commitRef = args[++index];
    } else if (arg === "--repo") {
      parsed.repo = args[++index];
    } else if (arg === "--branch") {
      parsed.branch = args[++index];
    } else if (arg === "--required-status-check") {
      parsed.requiredStatusCheck = args[++index];
    } else if (arg === "--operator-name") {
      parsed.operatorName = args[++index];
    } else if (arg === "--release-ticket" || arg === "--ticket-id") {
      parsed.releaseTicket = args[++index];
    } else if (arg === "--docker-socket-profile-accepted") {
      parsed.dockerSocketProfileAccepted = true;
    } else if (arg === "--host-build-exception-accepted") {
      parsed.hostBuildExceptionAccepted = true;
    } else if (arg === "--attestation-key-env") {
      parsed.attestationKeyEnv = args[++index];
    } else if (arg === "--attestation-key-file") {
      parsed.attestationKeyFile = args[++index];
    } else if (arg === "--attestation-key-id-env") {
      parsed.attestationKeyIdEnv = args[++index];
    } else if (arg === "--attestation-key-id") {
      parsed.attestationSigningKeyId = args[++index];
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help) {
    const required = [
      ["--release-gate", parsed.releaseGatePath],
      ["--postgres-rehearsal", parsed.postgresRehearsalPath],
      ["--artifact-evidence", parsed.artifactEvidencePath],
      ["--release-image-evidence", parsed.releaseImageEvidencePath],
      ["--target-runtime-evidence", parsed.targetRuntimeEvidencePath],
      ["--source-provider-evidence", parsed.sourceProviderEvidencePath],
      ["--backup-evidence", parsed.backupEvidencePath],
      ["--observability-evidence", parsed.observabilityEvidencePath],
      ["--operator-access-evidence", parsed.operatorAccessEvidencePath],
      ["--non-session-credential-evidence", parsed.nonSessionCredentialEvidencePath],
      ["--ingress-evidence", parsed.ingressEvidencePath],
      ["--upgrade-rollback-evidence", parsed.upgradeRollbackEvidencePath],
      ["--operator-name", parsed.operatorName],
      ["--release-ticket", parsed.releaseTicket]
    ];
    const missing = required.filter(([, value]) => !value).map(([flag]) => flag);

    if (missing.length > 0) {
      throw new Error(`Missing required option(s): ${missing.join(", ")}.`);
    }
  }

  return parsed;
}

export function releaseEvidenceBundleComposeUsage() {
  return [
    "Usage: npm run --silent release:evidence:compose -- --release-gate <file> --postgres-rehearsal <file> --artifact-evidence <file> --release-image-evidence <file> --target-runtime-evidence <file> --source-provider-evidence <file> --backup-evidence <file> --observability-evidence <file> --operator-access-evidence <file> --non-session-credential-evidence <file> --ingress-evidence <file> --upgrade-rollback-evidence <file> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --docker-build <file>             Docker build rehearsal evidence. Required when release-gate uses SITEFLOW_BUILD_RUNNER=docker.",
    "  --artifact-evidence <file>        Release artifact evidence checker output.",
    "  --release-image-evidence <file>   Release image workflow artifact containing the published image digest.",
    "  --target-runtime-evidence <file>  Target-host Compose startup, readiness, image binding, restart, and log evidence checker output.",
    "  --source-provider-evidence <f>    Source provider evidence checker output. Alias: --source-provenance-evidence.",
    "  --operator-access-evidence <f>    Operator access evidence checker output.",
    "  --non-session-credential-evidence <f>  Non-session credential evidence checker output. Alias: --credential-evidence.",
    "  --ingress-evidence <file>         Ingress evidence checker output.",
    "  --upgrade-rollback-evidence <f>   Upgrade/rollback drill evidence checker output.",
    "  --output <file>                   Write the composed release evidence bundle to a file.",
    "  --target-environment <name>       Target environment label. Default: production.",
    "  --checked-at <iso>                Bundle checkedAt timestamp. Default: current time.",
    "  --commit-ref <sha>                Release commit SHA, overriding release-gate evidence.",
    "  --repo <owner/repo>               Target repository, overriding release-gate evidence.",
    "  --branch <branch>                 Target branch, overriding release-gate evidence.",
    "  --required-status-check <name>    Required protected status check name.",
    "  --operator-name <name>            Release operator name.",
    "  --release-ticket <id>             Release, change, or incident ticket id. Alias: --ticket-id.",
    "  --docker-socket-profile-accepted  Record explicit acceptance of the trusted single-host Docker socket profile.",
    "  --host-build-exception-accepted   Record an explicit host-build trust exception in the bundle.",
    "  --attestation-key-env <name>      Read the release evidence attestation HMAC key from an environment variable.",
    "  --attestation-key-file <file>     Read the release evidence attestation HMAC key from a file.",
    "  --attestation-key-id-env <name>   Read the non-secret signing key id from an environment variable.",
    "  --attestation-key-id <id>         Record a non-secret signing key id in the attestation.",
    "  --json                           Print the composed bundle JSON to stdout.",
    "  --help                           Show this help."
  ].join("\n");
}

function writeHumanResult(result: ReleaseEvidenceBundleComposeResult, io: CliIo) {
  io.stdout.write(`SiteFlow release evidence bundle compose status: ${result.status}\n`);

  if (result.outputPath) {
    io.stdout.write(`Output: ${result.outputPath}\n`);
  } else {
    io.stdout.write("No --output file was provided. Pass --json to print the composed bundle.\n");
  }
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
  baseOptions: Partial<ReleaseEvidenceBundleComposeOptions>
) {
  return baseOptions.attestationSigningKey ??
    envSecretValue(parsed.attestationKeyEnv) ??
    await fileSecretValue(parsed.attestationKeyFile) ??
    envSecretValue("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY") ??
    await fileSecretValue(process.env.SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE);
}

export async function runReleaseEvidenceBundleComposeCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseEvidenceBundleComposeOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseEvidenceBundleComposeArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseEvidenceBundleComposeUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseEvidenceBundleComposeUsage()}\n`);
    return 0;
  }

  try {
    const attestationSigningKey = await resolveAttestationSigningKey(parsed, baseOptions);
    const result = await composeReleaseEvidenceBundle({
      ...baseOptions,
      releaseGatePath: parsed.releaseGatePath!,
      dockerBuildRehearsalPath: parsed.dockerBuildRehearsalPath,
      postgresRehearsalPath: parsed.postgresRehearsalPath!,
      artifactEvidencePath: parsed.artifactEvidencePath!,
      releaseImageEvidencePath: parsed.releaseImageEvidencePath!,
      targetRuntimeEvidencePath: parsed.targetRuntimeEvidencePath!,
      sourceProviderEvidencePath: parsed.sourceProviderEvidencePath!,
      backupEvidencePath: parsed.backupEvidencePath!,
      observabilityEvidencePath: parsed.observabilityEvidencePath!,
      operatorAccessEvidencePath: parsed.operatorAccessEvidencePath!,
      nonSessionCredentialEvidencePath: parsed.nonSessionCredentialEvidencePath!,
      ingressEvidencePath: parsed.ingressEvidencePath!,
      upgradeRollbackEvidencePath: parsed.upgradeRollbackEvidencePath!,
      outputPath: parsed.outputPath,
      targetEnvironment: parsed.targetEnvironment,
      checkedAt: parsed.checkedAt,
      commitRef: parsed.commitRef,
      repo: parsed.repo,
      branch: parsed.branch,
      requiredStatusCheck: parsed.requiredStatusCheck,
      operatorName: parsed.operatorName,
      releaseTicket: parsed.releaseTicket,
      dockerSocketProfileAccepted: parsed.dockerSocketProfileAccepted,
      hostBuildExceptionAccepted: parsed.hostBuildExceptionAccepted,
      attestationSigningKey,
      attestationSigningKeyId: parsed.attestationSigningKeyId ??
        envSecretValue(parsed.attestationKeyIdEnv) ??
        baseOptions.attestationSigningKeyId
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result.bundle, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: ReleaseEvidenceBundleComposeResult = {
      name: "siteflow-release-evidence-bundle-compose",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      outputPath: parsed.outputPath,
      exitCode: 1
    };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({
        ...result,
        message: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`);
    } else {
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runReleaseEvidenceBundleComposeCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
