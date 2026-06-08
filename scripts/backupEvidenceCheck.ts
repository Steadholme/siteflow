import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface BackupEvidenceCheckOptions {
  evidencePath: string;
  maxBackupAgeHours?: number;
  maxRestoreDrillAgeHours?: number;
  requireOffHost?: boolean;
  now?: () => Date;
}

export interface BackupEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface BackupEvidenceSummary {
  status?: string;
  restoreDrill?: boolean;
  timestamp?: string;
  backupPath?: string;
  offHostLocation?: string;
  provider?: string;
  encrypted?: boolean;
  kmsKeyRef?: string;
  providerKmsProof?: boolean;
  providerRetentionProof?: boolean;
  providerRetentionDays?: number;
  providerRetentionMode?: string;
  retentionContract?: string;
  retentionDays?: number;
  minimumBackups?: number;
  dryRun?: boolean;
}

export interface BackupEvidenceCheckResult {
  name: "siteflow-backup-evidence-check";
  status: EvidenceStatus;
  checkedAt: string;
  evidencePath: string;
  thresholds: {
    maxBackupAgeHours: number;
    maxRestoreDrillAgeHours: number;
    requireOffHost: boolean;
  };
  selectedEvidence: {
    backupVerify: BackupEvidenceSummary | null;
    restoreDrill: BackupEvidenceSummary | null;
    backupOffload: BackupEvidenceSummary | null;
    backupFetch: BackupEvidenceSummary | null;
    backupProviderSecurityAudit: BackupEvidenceSummary | null;
    backupPrune: BackupEvidenceSummary | null;
  };
  checks: BackupEvidenceCheck[];
  exitCode: number;
}

interface ParsedArgs {
  evidencePath?: string;
  json: boolean;
  help: boolean;
  maxBackupAgeHours: number;
  maxRestoreDrillAgeHours: number;
  requireOffHost: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMaxBackupAgeHours = 24;
const defaultMaxRestoreDrillAgeHours = 168;
const passStatuses = new Set(["pass", "passed", "verified", "restore_drilled", "offloaded", "fetched", "pruned"]);
const objectStorageProviders = new Set([
  "s3",
  "gs",
  "gcs",
  "google_cloud_storage",
  "azblob",
  "azure_blob",
  "r2",
  "minio",
  "object_storage"
]);
export const requiredOffHostBackupEvidenceCheckNames = [
  "backup_offload_present",
  "backup_offload_status",
  "backup_offload_age",
  "backup_offload_identity",
  "backup_offload_location",
  "backup_offload_integrity",
  "backup_offload_object_storage_provider",
  "backup_offload_kms_encryption",
  "backup_offload_provider_retention_contract",
  "backup_offload_provider_kms_proof",
  "backup_offload_provider_retention_proof",
  "backup_fetch_present",
  "backup_fetch_status",
  "backup_fetch_age",
  "backup_fetch_source",
  "backup_fetch_integrity",
  "restore_drill_from_fetched_backup",
  "backup_provider_security_audit_present",
  "backup_provider_security_audit_status",
  "backup_provider_security_audit_age",
  "backup_provider_security_audit_schema",
  "backup_provider_security_audit_source",
  "backup_provider_security_audit_no_raw_policy_material",
  "backup_provider_kms_key_policy",
  "backup_provider_bucket_policy",
  "backup_provider_lifecycle_policy",
  "backup_provider_cross_account_restore_access",
  "backup_provider_cross_account_restore_drill",
  "backup_prune_present",
  "backup_prune_status",
  "backup_prune_age",
  "backup_prune_non_dry_run",
  "backup_prune_retention_policy",
  "backup_prune_current_backup_retained"
] as const;

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

function collectObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjects(item));
  }

  if (!isObject(value)) {
    return [];
  }

  return [
    value,
    ...Object.values(value).flatMap((item) => collectObjects(item))
  ];
}

function latestByTimestamp(candidates: Record<string, unknown>[], timestampKeys: string[]) {
  return candidates
    .map((candidate) => ({
      candidate,
      timestamp: firstTimestamp(candidate, timestampKeys)
    }))
    .sort((left, right) => Date.parse(right.timestamp ?? "") - Date.parse(left.timestamp ?? ""))[0]?.candidate;
}

function firstTimestamp(candidate: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const timestamp = timestampValue(candidate[key]);

    if (timestamp) {
      return timestamp;
    }
  }

  return undefined;
}

function looksLikeBackupVerify(candidate: Record<string, unknown>) {
  const kind = statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
  const status = statusValue(candidate.status);

  return (
    kind === "backup_verify" ||
    kind === "backup-verify" ||
    candidate.verificationType === "static" ||
    status === "verified" ||
    candidate.restoreDrill === false
  );
}

function looksLikeRestoreDrill(candidate: Record<string, unknown>) {
  const kind = statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
  const status = statusValue(candidate.status);

  return (
    kind === "restore_drill" ||
    kind === "restore-drill" ||
    candidate.restoreDrill !== undefined ||
    status === "restore_drilled"
  );
}

function looksLikeBackupOffload(candidate: Record<string, unknown>) {
  const kind = statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
  const status = statusValue(candidate.status);

  return kind === "backup_offload" || kind === "backup-offload" || status === "offloaded";
}

function looksLikeBackupFetch(candidate: Record<string, unknown>) {
  const kind = statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
  const status = statusValue(candidate.status);

  return kind === "backup_fetch" || kind === "backup-fetch" || status === "fetched";
}

function looksLikeBackupProviderSecurityAudit(candidate: Record<string, unknown>) {
  const kind = statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
  const name = statusValue(candidate.name);

  return kind === "backup_provider_security_audit" ||
    kind === "backup-provider-security-audit" ||
    name === "siteflow-backup-provider-security-audit";
}

function looksLikeBackupPrune(candidate: Record<string, unknown>) {
  const kind = statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
  const status = statusValue(candidate.status);

  return kind === "backup_prune" || kind === "backup-prune" || status === "pruned" || status === "planned";
}

function firstCandidate(root: unknown, key: string) {
  return isObject(root) && isObject(root[key]) ? root[key] : undefined;
}

function selectBackupVerifyEvidence(root: unknown) {
  const direct = firstCandidate(root, "backupVerify") ?? firstCandidate(root, "backupVerification");

  if (direct) {
    return direct;
  }

  return latestByTimestamp(collectObjects(root).filter(looksLikeBackupVerify), [
    "verifiedAt",
    "completedAt",
    "timestamp",
    "createdAt"
  ]);
}

function selectRestoreDrillEvidence(root: unknown) {
  const direct = firstCandidate(root, "restoreDrillEvidence") ?? firstCandidate(root, "restoreDrill");

  if (direct) {
    return direct;
  }

  return latestByTimestamp(collectObjects(root).filter(looksLikeRestoreDrill), [
    "drilledAt",
    "completedAt",
    "timestamp",
    "createdAt"
  ]);
}

function selectBackupOffloadEvidence(root: unknown) {
  const direct = firstCandidate(root, "backupOffload") ?? firstCandidate(root, "offloadEvidence");

  if (direct) {
    return direct;
  }

  return latestByTimestamp(collectObjects(root).filter(looksLikeBackupOffload), [
    "offloadedAt",
    "completedAt",
    "timestamp",
    "createdAt"
  ]);
}

function selectBackupFetchEvidence(root: unknown) {
  const direct = firstCandidate(root, "backupFetch") ?? firstCandidate(root, "fetchEvidence");

  if (direct) {
    return direct;
  }

  return latestByTimestamp(collectObjects(root).filter(looksLikeBackupFetch), [
    "fetchedAt",
    "completedAt",
    "timestamp",
    "createdAt"
  ]);
}

function selectBackupProviderSecurityAuditEvidence(root: unknown) {
  const direct = firstCandidate(root, "backupProviderSecurityAudit") ??
    firstCandidate(root, "providerSecurityAudit") ??
    firstCandidate(root, "providerAudit");

  if (direct) {
    return direct;
  }

  return latestByTimestamp(collectObjects(root).filter(looksLikeBackupProviderSecurityAudit), [
    "checkedAt",
    "completedAt",
    "timestamp",
    "createdAt"
  ]);
}

function selectBackupPruneEvidence(root: unknown) {
  const direct = firstCandidate(root, "backupPrune") ?? firstCandidate(root, "retentionPrune");

  if (direct) {
    return direct;
  }

  return latestByTimestamp(collectObjects(root).filter(looksLikeBackupPrune), [
    "checkedAt",
    "prunedAt",
    "completedAt",
    "timestamp",
    "createdAt"
  ]);
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

function positiveFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function booleanTrue(value: unknown) {
  return value === true;
}

function backupIdentifier(candidate: Record<string, unknown> | undefined) {
  if (!candidate) {
    return undefined;
  }

  return (
    stringValue(candidate.backupPath) ??
    stringValue(candidate.backupId) ??
    stringValue(candidate.immutableBackupId) ??
    stringValue(nestedValue(candidate, ["backup", "id"])) ??
    stringValue(nestedValue(candidate, ["backup", "objectId"]))
  );
}

function sameBackupIdentifier(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined) {
  const leftId = backupIdentifier(left);
  const rightId = backupIdentifier(right);

  return Boolean(leftId && rightId && leftId === rightId);
}

function artifactTreeSha256(candidate: Record<string, unknown> | undefined) {
  return stringValue(nestedValue(candidate, ["artifacts", "treeSha256"]));
}

function operatorName(root: unknown, backupVerify?: Record<string, unknown>, restoreDrill?: Record<string, unknown>) {
  const candidates = [
    isObject(root) ? root : undefined,
    backupVerify,
    restoreDrill,
    isObject(root) ? nestedObject(root, "operator") : undefined
  ].filter(Boolean) as Record<string, unknown>[];

  for (const candidate of candidates) {
    const value =
      stringValue(candidate.operatorName) ??
      stringValue(candidate.operator) ??
      stringValue(candidate.performedBy) ??
      stringValue(candidate.user);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function ticketId(root: unknown, backupVerify?: Record<string, unknown>, restoreDrill?: Record<string, unknown>) {
  const candidates = [
    isObject(root) ? root : undefined,
    backupVerify,
    restoreDrill,
    isObject(root) ? nestedObject(root, "ticket") : undefined,
    isObject(root) ? nestedObject(root, "release") : undefined,
    isObject(root) ? nestedObject(root, "incident") : undefined
  ].filter(Boolean) as Record<string, unknown>[];

  for (const candidate of candidates) {
    const value =
      stringValue(candidate.ticketId) ??
      stringValue(candidate.releaseTicket) ??
      stringValue(candidate.incidentTicket) ??
      stringValue(candidate.changeRequest) ??
      stringValue(candidate.id);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function findOffHostLocation(
  root: unknown,
  backupVerify?: Record<string, unknown>,
  backupOffload?: Record<string, unknown>
) {
  const candidates = [
    isObject(root) ? root : undefined,
    backupOffload,
    backupOffload ? nestedObject(backupOffload, "target") : undefined,
    backupVerify,
    backupVerify ? nestedObject(backupVerify, "storage") : undefined,
    backupVerify ? nestedObject(backupVerify, "backup") : undefined
  ].filter(Boolean) as Record<string, unknown>[];

  for (const candidate of candidates) {
    const value =
      stringValue(candidate.offHostLocation) ??
      stringValue(candidate.offHostBackupLocation) ??
      stringValue(candidate.remoteLocation) ??
      stringValue(candidate.location);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function normalizeToken(value: string | undefined) {
  return value?.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function locationScheme(location: string | undefined) {
  const match = location?.match(/^([a-z][a-z0-9+.-]*):/i);

  return normalizeToken(match?.[1]);
}

function offloadTarget(backupOffload: Record<string, unknown> | undefined) {
  return nestedObject(backupOffload, "target") ??
    nestedObject(backupOffload, "storage") ??
    nestedObject(backupOffload, "destination");
}

function offloadLocation(backupOffload: Record<string, unknown> | undefined) {
  const target = offloadTarget(backupOffload);

  return stringValue(backupOffload?.location) ?? stringValue(target?.location);
}

function fetchSourceLocation(backupFetch: Record<string, unknown> | undefined) {
  const source = nestedObject(backupFetch, "source");

  return stringValue(source?.location) ?? stringValue(backupFetch?.sourceLocation) ?? stringValue(backupFetch?.remoteLocation);
}

function offloadTreeSha256(backupOffload: Record<string, unknown> | undefined) {
  const target = offloadTarget(backupOffload);

  return stringValue(backupOffload?.treeSha256) ?? stringValue(target?.treeSha256);
}

function offloadObjectCount(backupOffload: Record<string, unknown> | undefined) {
  const target = offloadTarget(backupOffload);

  return backupOffload?.objectCount ?? target?.objectCount;
}

function offloadTotalBytes(backupOffload: Record<string, unknown> | undefined) {
  const target = offloadTarget(backupOffload);

  return backupOffload?.totalBytes ?? target?.totalBytes;
}

function offloadProvider(backupOffload: Record<string, unknown> | undefined, offHostLocation?: string) {
  const target = offloadTarget(backupOffload);
  const candidates = [backupOffload, target].filter(Boolean) as Record<string, unknown>[];

  for (const candidate of candidates) {
    const provider = normalizeToken(
      stringValue(candidate.provider) ??
        stringValue(candidate.storageProvider) ??
        stringValue(candidate.service)
    );

    if (provider) {
      return provider;
    }
  }

  return locationScheme(offHostLocation);
}

function isObjectStorageOffload(backupOffload: Record<string, unknown> | undefined, offHostLocation?: string) {
  const provider = offloadProvider(backupOffload, offHostLocation);
  const scheme = locationScheme(offHostLocation);

  return Boolean(
    provider &&
      objectStorageProviders.has(provider) &&
      scheme !== "file" &&
      provider !== "file"
  );
}

function kmsEncryptionEvidence(backupOffload: Record<string, unknown> | undefined) {
  const target = offloadTarget(backupOffload);
  const encryption = nestedObject(backupOffload, "encryption") ?? nestedObject(target, "encryption");
  const candidates = [backupOffload, target, encryption].filter(Boolean) as Record<string, unknown>[];
  const kmsKeyRef = candidates
    .map((candidate) =>
      stringValue(candidate.kmsKeyRef) ??
        stringValue(candidate.kmsKeyArn) ??
        stringValue(candidate.kmsKeyId) ??
        stringValue(candidate.kmsKey) ??
        stringValue(candidate.keyRef) ??
        stringValue(candidate.keyArn) ??
        stringValue(candidate.keyId)
    )
    .find(Boolean);
  const mode = candidates
    .map((candidate) =>
      normalizeToken(
        stringValue(candidate.mode) ??
          stringValue(candidate.type) ??
          stringValue(candidate.serverSideEncryption) ??
          stringValue(candidate.algorithm)
      )
    )
    .find(Boolean);
  const explicitlyDisabled = candidates.some((candidate) => candidate.enabled === false || candidate.encrypted === false);
  const kmsMode = mode === "kms" || mode === "aws:kms" || mode === "sse_kms" || mode === "customer_managed_kms";

  return {
    encrypted: !explicitlyDisabled && Boolean(kmsKeyRef || kmsMode),
    kmsKeyRef,
    mode
  };
}

function providerRetentionEvidence(
  backupOffload: Record<string, unknown> | undefined,
  requiredRetentionDays: number | undefined
) {
  const target = offloadTarget(backupOffload);
  const candidates = [
    nestedObject(backupOffload, "providerRetention"),
    nestedObject(target, "providerRetention"),
    nestedObject(backupOffload, "retention"),
    nestedObject(target, "retention"),
    nestedObject(backupOffload, "immutability"),
    nestedObject(target, "immutability"),
    nestedObject(backupOffload, "objectLock"),
    nestedObject(target, "objectLock")
  ].filter(Boolean) as Record<string, unknown>[];
  const status = candidates.map((candidate) => statusValue(candidate.status)).find(Boolean);
  const enabled = candidates.some((candidate) =>
    candidate.enabled === true ||
      candidate.objectLockEnabled === true ||
      statusValue(candidate.status) === "enabled" ||
      statusValue(candidate.status) === "passed" ||
      statusValue(candidate.status) === "active"
  );
  const mode = candidates
    .map((candidate) =>
      stringValue(candidate.mode) ??
        stringValue(candidate.retentionMode) ??
        stringValue(candidate.policyMode) ??
        stringValue(candidate.type)
    )
    .find(Boolean);
  const providerRetentionDays = candidates
    .map((candidate) =>
      numberValue(candidate.retentionDays) ??
        numberValue(candidate.days) ??
        numberValue(candidate.retainDays) ??
        numberValue(nestedValue(candidate, ["policy", "retentionDays"]))
    )
    .find((value): value is number => value !== undefined);
  const retentionContract = candidates
    .map((candidate) =>
      stringValue(candidate.contractId) ??
        stringValue(candidate.policyId) ??
        stringValue(candidate.lifecycleRuleId) ??
        stringValue(candidate.ruleId) ??
        stringValue(candidate.bucketPolicyId) ??
        stringValue(candidate.objectLockRuleId)
    )
    .find(Boolean);

  return {
    enabled,
    mode,
    providerRetentionDays,
    retentionContract,
    valid: Boolean(
      enabled &&
        mode &&
        retentionContract &&
        requiredRetentionDays &&
        providerRetentionDays &&
        providerRetentionDays >= requiredRetentionDays
    )
  };
}

function providerProofEvidence(
  backupOffload: Record<string, unknown> | undefined,
  requiredRetentionDays: number | undefined
) {
  const target = offloadTarget(backupOffload);
  const proof = nestedObject(backupOffload, "providerProof") ?? nestedObject(target, "providerProof");
  const object = nestedObject(proof, "object");
  const bucketObjectLock = nestedObject(proof, "bucketObjectLock") ?? nestedObject(proof, "bucket");
  const checks = Array.isArray(proof?.checks) ? proof.checks.filter(isObject) : [];
  const checkedAt = timestampValue(proof?.checkedAt);
  const retainUntil = timestampValue(object?.objectLockRetainUntilDate) ?? timestampValue(object?.retainUntil);
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  const retainUntilMs = retainUntil ? Date.parse(retainUntil) : Number.NaN;
  const minRetainUntilMs = Number.isFinite(checkedAtMs) && requiredRetentionDays
    ? checkedAtMs + requiredRetentionDays * 24 * 60 * 60 * 1000
    : Number.NaN;
  const checkPassed = (name: string) =>
    checks.some((check) => stringValue(check.name) === name && statusValue(check.status) === "pass");
  const serverSideEncryption = normalizeToken(
    stringValue(object?.serverSideEncryption) ?? stringValue(object?.algorithm)
  );
  const kmsKeyRef = stringValue(object?.sseKmsKeyId) ?? stringValue(object?.kmsKeyRef) ?? stringValue(object?.kmsKeyArn);
  const proofProvider = normalizeToken(stringValue(proof?.provider));
  const defaultRetentionDays = numberValue(bucketObjectLock?.defaultRetentionDays) ?? numberValue(bucketObjectLock?.retentionDays);

  return {
    kmsVerified: Boolean(
      proof &&
        statusValue(proof.status) === "verified" &&
        proof.evidenceSource === "provider_api" &&
        proofProvider === "aws_s3" &&
        serverSideEncryption === "aws:kms" &&
        kmsKeyRef &&
        checkPassed("s3_head_object") &&
        checkPassed("s3_object_kms")
    ),
    retentionVerified: Boolean(
      proof &&
        statusValue(proof.status) === "verified" &&
        proof.evidenceSource === "provider_api" &&
        proofProvider === "aws_s3" &&
        stringValue(object?.objectLockMode) &&
        retainUntil &&
        Number.isFinite(retainUntilMs) &&
        Number.isFinite(minRetainUntilMs) &&
        retainUntilMs >= minRetainUntilMs &&
        bucketObjectLock?.objectLockEnabled === true &&
        defaultRetentionDays &&
        requiredRetentionDays &&
        defaultRetentionDays >= requiredRetentionDays &&
        checkPassed("s3_object_lock_retention") &&
        checkPassed("s3_bucket_object_lock")
    )
  };
}

function sha256Value(value: unknown) {
  const raw = stringValue(value);

  return raw && /^[a-f0-9]{64}$/i.test(raw) ? raw.toLowerCase() : undefined;
}

function controlStatusPassed(candidate: Record<string, unknown> | undefined) {
  return Boolean(candidate && isPassingEvidenceStatus(candidate.status));
}

function providerAuditNested(candidate: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = nestedObject(candidate, key);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function providerAuditString(candidate: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = stringValue(candidate?.[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function providerAuditNumber(candidate: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = numberValue(candidate?.[key]);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function providerAuditBoolean(candidate: Record<string, unknown> | undefined, keys: string[]) {
  return keys.some((key) => candidate?.[key] === true);
}

function providerAuditSourcePassed(candidate: Record<string, unknown> | undefined) {
  return Boolean(
    candidate &&
      providerAuditString(candidate, ["evidenceSource", "proofSource", "auditSource"]) &&
      providerAuditString(candidate, ["operator", "operatorName"]) &&
      providerAuditString(candidate, ["ticket", "releaseTicket", "changeTicket"])
  );
}

function providerAuditNoRawMaterial(candidate: Record<string, unknown> | undefined) {
  if (!candidate) {
    return false;
  }

  const forbiddenKeys = new Set([
    "rawpolicy",
    "rawpolicydocument",
    "policydocument",
    "policyjson",
    "rawjson",
    "rawawsclioutput",
    "stdout",
    "stderr",
    "request",
    "response",
    "headers",
    "principal",
    "condition",
    "action",
    "resource",
    "statement",
    "statements",
    "accesskeyid",
    "secretaccesskey",
    "sessiontoken",
    "xamzsecuritytoken",
    "presignedurl",
    "databaseurl",
    "authorization",
    "cookie",
    "token",
    "password",
    "privatekey",
    "credential",
    "credentials"
  ]);
  const forbiddenStringPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /AWS_SECRET_ACCESS_KEY/i,
    /aws_secret_access_key/i,
    /Authorization:\s*Bearer/i
  ];

  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.every(visit);
    }

    if (typeof value === "string") {
      return forbiddenStringPatterns.every((pattern) => !pattern.test(value));
    }

    if (!isObject(value)) {
      return true;
    }

    return Object.entries(value).every(([key, entry]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");

      return !forbiddenKeys.has(normalizedKey) && visit(entry);
    });
  };

  return visit(candidate);
}

function providerAuditKmsKeyPolicyPassed(
  candidate: Record<string, unknown> | undefined,
  offloadEncryption: { kmsKeyRef?: string }
) {
  const kmsKeyPolicy = providerAuditNested(candidate, ["kmsKeyPolicy", "kmsPolicy"]);
  const auditedKmsKeyRef = providerAuditString(kmsKeyPolicy, ["kmsKeyRef", "kmsKeyArn", "keyArn", "keyId"]);

  return Boolean(
    controlStatusPassed(kmsKeyPolicy) &&
      sha256Value(kmsKeyPolicy?.policySha256 ?? kmsKeyPolicy?.policyHashSha256) &&
      (!offloadEncryption.kmsKeyRef || auditedKmsKeyRef === offloadEncryption.kmsKeyRef) &&
      providerAuditBoolean(kmsKeyPolicy, ["backupRoleEncryptDecryptAllowed", "backupPrincipalEncryptDecryptAllowed", "allowsBackupRoleEncryptDecrypt"]) &&
      providerAuditBoolean(kmsKeyPolicy, ["restoreRoleDecryptAllowed", "restorePrincipalDecryptAllowed", "allowsRestoreRoleDecrypt"]) &&
      providerAuditBoolean(kmsKeyPolicy, ["crossAccountRestoreRoleAllowed", "crossAccountDecryptAllowed"]) &&
      providerAuditBoolean(kmsKeyPolicy, ["publicAccessDenied", "externalUnscopedAccessDenied"])
  );
}

function providerAuditBucketPolicyPassed(candidate: Record<string, unknown> | undefined) {
  const bucketPolicy = providerAuditNested(candidate, ["bucketPolicy", "objectStorePolicy"]);

  return Boolean(
    controlStatusPassed(bucketPolicy) &&
      sha256Value(bucketPolicy?.policySha256 ?? bucketPolicy?.policyHashSha256) &&
      providerAuditBoolean(bucketPolicy, ["publicAccessBlocked", "blockPublicAccess"]) &&
      providerAuditBoolean(bucketPolicy, ["insecureTransportDenied", "deniesInsecureTransport"]) &&
      providerAuditBoolean(bucketPolicy, ["unencryptedUploadsDenied", "deniesUnencryptedObjectUploads", "requiresKmsEncryption"]) &&
      providerAuditBoolean(bucketPolicy, ["backupRoleWriteAllowed", "backupPrincipalWriteAllowed"]) &&
      providerAuditBoolean(bucketPolicy, ["restoreRoleReadAllowed", "restorePrincipalReadAllowed"])
  );
}

function providerAuditLifecyclePolicyPassed(
  candidate: Record<string, unknown> | undefined,
  requiredRetentionDays: number | undefined
) {
  const lifecyclePolicy = providerAuditNested(candidate, ["lifecyclePolicy", "bucketLifecycle", "lifecycle"]);
  const retentionDaysValue = providerAuditNumber(lifecyclePolicy, ["retentionDays", "minimumRetentionDays", "noncurrentVersionRetentionDays"]);

  return Boolean(
    controlStatusPassed(lifecyclePolicy) &&
      providerAuditString(lifecyclePolicy, ["ruleId", "lifecycleRuleId", "policyId"]) &&
      providerAuditBoolean(lifecyclePolicy, ["enabled", "ruleEnabled", "lifecycleEnabled"]) &&
      providerAuditBoolean(lifecyclePolicy, ["versioningEnabled", "bucketVersioningEnabled"]) &&
      requiredRetentionDays &&
      retentionDaysValue &&
      retentionDaysValue >= requiredRetentionDays
  );
}

function providerAuditCrossAccountRestoreAccessPassed(candidate: Record<string, unknown> | undefined) {
  const crossAccountRestore = providerAuditNested(candidate, ["crossAccountRestore", "crossAccountAccess", "restoreAccess"]);
  const sourceAccountId = providerAuditString(crossAccountRestore, ["sourceAccountId", "backupAccountId"]);
  const restoreAccountId = providerAuditString(crossAccountRestore, ["restoreAccountId", "recoveryAccountId"]);
  const s3GetObjectTest = providerAuditNested(crossAccountRestore, ["s3GetObjectTest", "objectReadTest"]);
  const kmsDecryptTest = providerAuditNested(crossAccountRestore, ["kmsDecryptTest", "decryptTest"]);

  return Boolean(
    controlStatusPassed(crossAccountRestore) &&
      sourceAccountId &&
      restoreAccountId &&
      sourceAccountId !== restoreAccountId &&
      providerAuditString(crossAccountRestore, ["restoreRoleArn", "restorePrincipalArn"]) &&
      controlStatusPassed(s3GetObjectTest) &&
      controlStatusPassed(kmsDecryptTest)
  );
}

function providerAuditCrossAccountRestoreDrillPassed(candidate: Record<string, unknown> | undefined) {
  const drill = providerAuditNested(candidate, ["crossAccountRestoreDrill", "restoreDrill"]);

  return Boolean(
    controlStatusPassed(drill) &&
      drill?.restoreDrill === true &&
      timestampValue(drill.completedAt) &&
      providerAuditString(drill, ["restoreAccountId", "recoveryAccountId"]) &&
      providerAuditString(drill, ["restoreRoleArn", "restorePrincipalArn"]) &&
      providerAuditString(drill, ["backupPath", "backupObject", "backupObjectKey"])
  );
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retentionDays(candidate: Record<string, unknown> | undefined) {
  return numberValue(candidate?.retentionDays) ?? numberValue(nestedValue(candidate, ["policy", "retentionDays"]));
}

function minimumBackups(candidate: Record<string, unknown> | undefined) {
  return numberValue(candidate?.minimumBackups) ??
    numberValue(candidate?.minBackups) ??
    numberValue(nestedValue(candidate, ["policy", "minimumBackups"])) ??
    numberValue(nestedValue(candidate, ["policy", "minBackups"]));
}

function collectionIncludesBackup(collection: unknown, backupId: string | undefined) {
  if (!backupId || !Array.isArray(collection)) {
    return false;
  }

  return collection.some((item) => {
    if (typeof item === "string") {
      return item === backupId || item === backupId.split(/[\\/]/).pop();
    }

    if (!isObject(item)) {
      return false;
    }

    const candidateId = backupIdentifier(item);

    return candidateId === backupId || candidateId === backupId.split(/[\\/]/).pop();
  });
}

function backupPolicy(root: unknown) {
  if (!isObject(root)) {
    return undefined;
  }

  return nestedObject(root, "backupPolicy") ?? nestedObject(root, "drPolicy") ?? nestedObject(root, "policy");
}

function policySchedule(policy: Record<string, unknown> | undefined) {
  return nestedObject(policy, "schedule");
}

function policyRetention(policy: Record<string, unknown> | undefined) {
  return nestedObject(policy, "retention");
}

function policyObjectives(policy: Record<string, unknown> | undefined) {
  return nestedObject(policy, "objectives") ?? nestedObject(policy, "rpoRto");
}

function policyMonitoring(policy: Record<string, unknown> | undefined) {
  return nestedObject(policy, "monitoring");
}

function summarizeEvidence(candidate: Record<string, unknown> | undefined, timestampKeys: string[], offHostLocation?: string) {
  if (!candidate) {
    return null;
  }

  const provider = offloadProvider(candidate, offHostLocation);
  const encryption = kmsEncryptionEvidence(candidate);
  const providerRetention = providerRetentionEvidence(candidate, undefined);
  const providerProof = providerProofEvidence(candidate, providerRetention.providerRetentionDays);

  return {
    status: stringValue(candidate.status),
    restoreDrill: typeof candidate.restoreDrill === "boolean" ? candidate.restoreDrill : undefined,
    timestamp: firstTimestamp(candidate, timestampKeys),
    backupPath: stringValue(candidate.backupPath) ?? stringValue(candidate.backupId),
    offHostLocation,
    provider,
    encrypted: encryption.encrypted || undefined,
    kmsKeyRef: encryption.kmsKeyRef,
    providerKmsProof: providerProof.kmsVerified || undefined,
    providerRetentionProof: providerProof.retentionVerified || undefined,
    providerRetentionDays: providerRetention.providerRetentionDays,
    providerRetentionMode: providerRetention.mode,
    retentionContract: providerRetention.retentionContract,
    retentionDays: retentionDays(candidate),
    minimumBackups: minimumBackups(candidate),
    dryRun: typeof candidate.dryRun === "boolean" ? candidate.dryRun : undefined
  };
}

function addCheck(checks: BackupEvidenceCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function ageHours(timestamp: string, now: Date) {
  return (now.getTime() - Date.parse(timestamp)) / (60 * 60 * 1000);
}

function isPassingEvidenceStatus(status: unknown) {
  const normalized = statusValue(status);

  return Boolean(normalized && passStatuses.has(normalized));
}

function positiveNumber(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

export function evaluateBackupEvidence(
  rawEvidence: unknown,
  options: BackupEvidenceCheckOptions
): BackupEvidenceCheckResult {
  const now = options.now?.() ?? new Date();
  const maxBackupAgeHours = positiveNumber(
    options.maxBackupAgeHours,
    defaultMaxBackupAgeHours,
    "maxBackupAgeHours"
  );
  const maxRestoreDrillAgeHours = positiveNumber(
    options.maxRestoreDrillAgeHours,
    defaultMaxRestoreDrillAgeHours,
    "maxRestoreDrillAgeHours"
  );
  const requireOffHost = Boolean(options.requireOffHost);
  const backupVerify = selectBackupVerifyEvidence(rawEvidence);
  const restoreDrill = selectRestoreDrillEvidence(rawEvidence);
  const backupOffload = selectBackupOffloadEvidence(rawEvidence);
  const backupFetch = selectBackupFetchEvidence(rawEvidence);
  const backupProviderSecurityAudit = selectBackupProviderSecurityAuditEvidence(rawEvidence);
  const backupPrune = selectBackupPruneEvidence(rawEvidence);
  const offHostLocation = findOffHostLocation(rawEvidence, backupVerify, backupOffload);
  const policy = backupPolicy(rawEvidence);
  const schedule = policySchedule(policy);
  const retention = policyRetention(policy);
  const requiredRetentionDays = numberValue(retention?.retentionDays);
  const objectives = policyObjectives(policy);
  const monitoring = policyMonitoring(policy);
  const offloadEncryption = kmsEncryptionEvidence(backupOffload);
  const providerRetention = providerRetentionEvidence(backupOffload, requiredRetentionDays);
  const providerProof = providerProofEvidence(backupOffload, requiredRetentionDays);
  const providerSecurityAuditTimestamp = backupProviderSecurityAudit
    ? firstTimestamp(backupProviderSecurityAudit, ["checkedAt", "completedAt", "timestamp", "createdAt"])
    : undefined;
  const backupTimestamp = backupVerify
    ? firstTimestamp(backupVerify, ["createdAt", "verifiedAt", "completedAt", "timestamp"])
    : undefined;
  const restoreDrillTimestamp = restoreDrill
    ? firstTimestamp(restoreDrill, ["drilledAt", "completedAt", "timestamp", "createdAt"])
    : undefined;
  const backupOffloadTimestamp = backupOffload
    ? firstTimestamp(backupOffload, ["offloadedAt", "completedAt", "timestamp", "createdAt"])
    : undefined;
  const backupFetchTimestamp = backupFetch
    ? firstTimestamp(backupFetch, ["fetchedAt", "completedAt", "timestamp", "createdAt"])
    : undefined;
  const backupPruneTimestamp = backupPrune
    ? firstTimestamp(backupPrune, ["checkedAt", "prunedAt", "completedAt", "timestamp", "createdAt"])
    : undefined;
  const checks: BackupEvidenceCheck[] = [];

  addCheck(checks, "backup_verify_present", Boolean(backupVerify), "Backup verify evidence must be present.");
  addCheck(
    checks,
    "backup_verify_status",
    Boolean(backupVerify && isPassingEvidenceStatus(backupVerify.status)),
    "Backup verify evidence status must be passed or verified."
  );
  addCheck(
    checks,
    "backup_age",
    Boolean(backupTimestamp && ageHours(backupTimestamp, now) >= 0 && ageHours(backupTimestamp, now) <= maxBackupAgeHours),
    `Backup manifest timestamp must be no older than ${maxBackupAgeHours} hours.`
  );
  addCheck(
    checks,
    "backup_identifier",
    Boolean(backupIdentifier(backupVerify)),
    "Backup verify evidence must include backupPath, backupId, or immutableBackupId."
  );
  addCheck(
    checks,
    "backup_database_checksum",
    nestedValue(backupVerify, ["database", "checksumVerified"]) === true,
    "Backup verify evidence must include database.checksumVerified: true."
  );
  addCheck(
    checks,
    "backup_artifact_integrity",
    nestedValue(backupVerify, ["artifacts", "checksumVerified"]) === true &&
      Boolean(artifactTreeSha256(backupVerify)) &&
      nonNegativeInteger(nestedValue(backupVerify, ["artifacts", "fileCount"])) &&
      nonNegativeInteger(nestedValue(backupVerify, ["artifacts", "totalBytes"])),
    "Backup verify evidence must include artifact checksum, tree digest, file count, and byte count verification."
  );
  addCheck(checks, "restore_drill_present", Boolean(restoreDrill), "Restore drill evidence must be present.");
  addCheck(
    checks,
    "restore_drill_flag",
    restoreDrill?.restoreDrill === true,
    "Restore drill evidence must include restoreDrill: true."
  );
  addCheck(
    checks,
    "restore_drill_status",
    Boolean(restoreDrill && isPassingEvidenceStatus(restoreDrill.status)),
    "Restore drill evidence status must be passed or restore_drilled."
  );
  addCheck(
    checks,
    "restore_drill_age",
    Boolean(
      restoreDrillTimestamp &&
        ageHours(restoreDrillTimestamp, now) >= 0 &&
        ageHours(restoreDrillTimestamp, now) <= maxRestoreDrillAgeHours
    ),
    `Restore drill timestamp must be no older than ${maxRestoreDrillAgeHours} hours.`
  );
  addCheck(
    checks,
    "restore_drill_duration",
    positiveFiniteNumber(restoreDrill?.durationMs),
    "Restore drill evidence must include a positive durationMs."
  );
  addCheck(
    checks,
    "restore_drill_database_target",
    Boolean(stringValue(nestedValue(restoreDrill, ["database", "target"]))),
    "Restore drill evidence must include a disposable database target identifier."
  );
  addCheck(
    checks,
    "restore_drill_artifact_target",
    Boolean(
      stringValue(nestedValue(restoreDrill, ["artifacts", "target"])) ??
        stringValue(nestedValue(restoreDrill, ["artifacts", "targetPath"])) ??
        stringValue(nestedValue(restoreDrill, ["artifacts", "objectPrefix"]))
    ),
    "Restore drill evidence must include a temporary artifact target path or object prefix."
  );
  addCheck(
    checks,
    "restore_drill_artifact_mode",
    Boolean(stringValue(nestedValue(restoreDrill, ["artifacts", "restoreMode"]))),
    "Restore drill evidence must include the artifact restore mode."
  );
  addCheck(
    checks,
    "restore_drill_artifact_integrity",
    nestedValue(restoreDrill, ["artifacts", "checksumVerified"]) === true &&
      Boolean(artifactTreeSha256(restoreDrill)) &&
      artifactTreeSha256(restoreDrill) === artifactTreeSha256(backupVerify) &&
      nonNegativeInteger(nestedValue(restoreDrill, ["artifacts", "fileCount"])) &&
      nestedValue(restoreDrill, ["artifacts", "fileCount"]) === nestedValue(backupVerify, ["artifacts", "fileCount"]) &&
      nonNegativeInteger(nestedValue(restoreDrill, ["artifacts", "totalBytes"])) &&
      nestedValue(restoreDrill, ["artifacts", "totalBytes"]) === nestedValue(backupVerify, ["artifacts", "totalBytes"]),
    "Restore drill evidence must verify restored artifact checksum, file count, and byte count against the backup."
  );
  addCheck(
    checks,
    "operator",
    Boolean(operatorName(rawEvidence, backupVerify, restoreDrill)),
    "Backup evidence must include the operator name."
  );
  addCheck(
    checks,
    "ticket",
    Boolean(ticketId(rawEvidence, backupVerify, restoreDrill)),
    "Backup evidence must include an incident or release ticket id."
  );

  if (requireOffHost) {
    addCheck(
      checks,
      "backup_offload_present",
      Boolean(backupOffload),
      "Backup offload evidence is required when off-host backup evidence is required."
    );
    addCheck(
      checks,
      "backup_offload_status",
      Boolean(backupOffload && isPassingEvidenceStatus(backupOffload.status)),
      "Backup offload evidence status must be offloaded or passed."
    );
    addCheck(
      checks,
      "backup_offload_age",
      Boolean(
        backupOffloadTimestamp &&
          ageHours(backupOffloadTimestamp, now) >= 0 &&
          ageHours(backupOffloadTimestamp, now) <= maxBackupAgeHours
      ),
      `Backup offload timestamp must be no older than ${maxBackupAgeHours} hours.`
    );
    addCheck(
      checks,
      "backup_offload_identity",
      sameBackupIdentifier(backupOffload, backupVerify),
      "Backup offload evidence must reference the same backup as backup verify evidence."
    );
    addCheck(
      checks,
      "backup_offload_location",
      Boolean(offHostLocation),
      "Backup offload evidence must include a non-empty off-host location."
    );
    addCheck(
      checks,
      "backup_offload_integrity",
      (backupOffload?.checksumVerified === true || nestedValue(backupOffload, ["target", "checksumVerified"]) === true) &&
        Boolean(stringValue(backupOffload?.treeSha256) ?? stringValue(nestedValue(backupOffload, ["target", "treeSha256"]))) &&
        positiveInteger(backupOffload?.objectCount ?? nestedValue(backupOffload, ["target", "objectCount"])) &&
        positiveInteger(backupOffload?.totalBytes ?? nestedValue(backupOffload, ["target", "totalBytes"])),
      "Backup offload evidence must include checksum verification, tree digest, object count, and byte count."
    );
    addCheck(
      checks,
      "backup_offload_object_storage_provider",
      isObjectStorageOffload(backupOffload, offHostLocation),
      "Backup offload evidence must identify an object storage provider and non-file location."
    );
    addCheck(
      checks,
      "backup_offload_kms_encryption",
      offloadEncryption.encrypted,
      "Backup offload evidence must include KMS encryption evidence or a KMS key reference."
    );
    addCheck(
      checks,
      "backup_offload_provider_retention_contract",
      providerRetention.valid,
      "Backup offload evidence must include enabled provider retention with mode, contract id, and retentionDays meeting policy."
    );
    addCheck(
      checks,
      "backup_offload_provider_kms_proof",
      providerProof.kmsVerified,
      "Backup offload evidence must include provider API proof that the uploaded object uses SSE-KMS."
    );
    addCheck(
      checks,
      "backup_offload_provider_retention_proof",
      providerProof.retentionVerified,
      "Backup offload evidence must include provider API proof of Object Lock retention meeting policy."
    );
    addCheck(
      checks,
      "backup_fetch_present",
      Boolean(backupFetch),
      "Backup fetch evidence is required when off-host backup evidence is required."
    );
    addCheck(
      checks,
      "backup_fetch_status",
      Boolean(backupFetch && isPassingEvidenceStatus(backupFetch.status)),
      "Backup fetch evidence status must be fetched or passed."
    );
    addCheck(
      checks,
      "backup_fetch_age",
      Boolean(
        backupFetchTimestamp &&
          ageHours(backupFetchTimestamp, now) >= 0 &&
          ageHours(backupFetchTimestamp, now) <= maxBackupAgeHours
      ),
      `Backup fetch timestamp must be no older than ${maxBackupAgeHours} hours.`
    );
    addCheck(
      checks,
      "backup_fetch_source",
      Boolean(fetchSourceLocation(backupFetch) && fetchSourceLocation(backupFetch) === offloadLocation(backupOffload)),
      "Backup fetch evidence source must match the backup offload target location."
    );
    addCheck(
      checks,
      "backup_fetch_integrity",
      backupFetch?.checksumVerified === true &&
        stringValue(backupFetch.treeSha256) === offloadTreeSha256(backupOffload) &&
        backupFetch.objectCount === offloadObjectCount(backupOffload) &&
        backupFetch.totalBytes === offloadTotalBytes(backupOffload),
      "Backup fetch evidence must verify tree digest, object count, and byte count against backup offload evidence."
    );
    addCheck(
      checks,
      "restore_drill_from_fetched_backup",
      Boolean(backupFetch && stringValue(restoreDrill?.backupPath) === stringValue(backupFetch.backupPath)),
      "Restore drill evidence must use the fetched off-host backup path."
    );
    addCheck(
      checks,
      "backup_provider_security_audit_present",
      Boolean(backupProviderSecurityAudit),
      "Provider security audit evidence is required when off-host backup evidence is required."
    );
    addCheck(
      checks,
      "backup_provider_security_audit_status",
      Boolean(backupProviderSecurityAudit && isPassingEvidenceStatus(backupProviderSecurityAudit.status)),
      "Provider security audit evidence status must be passed."
    );
    addCheck(
      checks,
      "backup_provider_security_audit_age",
      Boolean(
        providerSecurityAuditTimestamp &&
          ageHours(providerSecurityAuditTimestamp, now) >= 0 &&
          ageHours(providerSecurityAuditTimestamp, now) <= maxBackupAgeHours
      ),
      `Provider security audit timestamp must be no older than ${maxBackupAgeHours} hours.`
    );
    addCheck(
      checks,
      "backup_provider_security_audit_schema",
      backupProviderSecurityAudit?.schemaVersion === "siteflow.backupProviderSecurityAudit.v1" &&
        backupProviderSecurityAudit?.name === "siteflow-backup-provider-security-audit",
      "Provider security audit evidence must use the expected schema and name."
    );
    addCheck(
      checks,
      "backup_provider_security_audit_source",
      providerAuditSourcePassed(backupProviderSecurityAudit),
      "Provider security audit evidence must include proof source, operator, and ticket."
    );
    addCheck(
      checks,
      "backup_provider_security_audit_no_raw_policy_material",
      providerAuditNoRawMaterial(backupProviderSecurityAudit),
      "Provider security audit evidence must not archive raw policy documents or credentials."
    );
    addCheck(
      checks,
      "backup_provider_kms_key_policy",
      providerAuditKmsKeyPolicyPassed(backupProviderSecurityAudit, offloadEncryption),
      "Provider security audit evidence must prove KMS key policy permits backup and cross-account restore without public access."
    );
    addCheck(
      checks,
      "backup_provider_bucket_policy",
      providerAuditBucketPolicyPassed(backupProviderSecurityAudit),
      "Provider security audit evidence must prove bucket policy blocks public/insecure/unencrypted access and allows backup and restore roles."
    );
    addCheck(
      checks,
      "backup_provider_lifecycle_policy",
      providerAuditLifecyclePolicyPassed(backupProviderSecurityAudit, requiredRetentionDays),
      "Provider security audit evidence must prove enabled lifecycle/versioning controls meet the backup retention policy."
    );
    addCheck(
      checks,
      "backup_provider_cross_account_restore_access",
      providerAuditCrossAccountRestoreAccessPassed(backupProviderSecurityAudit),
      "Provider security audit evidence must prove an independent restore account can read the backup object and decrypt it."
    );
    addCheck(
      checks,
      "backup_provider_cross_account_restore_drill",
      providerAuditCrossAccountRestoreDrillPassed(backupProviderSecurityAudit),
      "Provider security audit evidence must include a cross-account restore drill against the audited backup."
    );
    addCheck(
      checks,
      "backup_prune_present",
      Boolean(backupPrune),
      "Backup prune evidence is required when off-host backup evidence is required."
    );
    addCheck(
      checks,
      "backup_prune_status",
      Boolean(backupPrune && statusValue(backupPrune.status) === "pruned"),
      "Backup prune evidence status must be pruned."
    );
    addCheck(
      checks,
      "backup_prune_age",
      Boolean(
        backupPruneTimestamp &&
          ageHours(backupPruneTimestamp, now) >= 0 &&
          ageHours(backupPruneTimestamp, now) <= maxBackupAgeHours
      ),
      `Backup prune timestamp must be no older than ${maxBackupAgeHours} hours.`
    );
    addCheck(
      checks,
      "backup_prune_non_dry_run",
      backupPrune?.dryRun === false,
      "Backup prune evidence must come from a non-dry-run prune."
    );
    addCheck(
      checks,
      "backup_prune_retention_policy",
      retentionDays(backupPrune) === retention?.retentionDays &&
        minimumBackups(backupPrune) === (retention?.minimumBackups ?? retention?.minBackups),
      "Backup prune evidence must match the configured retentionDays and minimumBackups policy."
    );
    addCheck(
      checks,
      "backup_prune_current_backup_retained",
      collectionIncludesBackup(backupPrune?.retained ?? backupPrune?.retainedBackupIds, backupIdentifier(backupVerify)),
      "Backup prune evidence must show the current verified backup was retained."
    );
  }

  addCheck(
    checks,
    "backup_schedule",
    Boolean(
      stringValue(schedule?.cron) ??
        stringValue(schedule?.expression) ??
        stringValue(schedule?.interval)
    ) && Boolean(stringValue(schedule?.timezone) ?? stringValue(policy?.timezone)),
    "Backup policy evidence must include a schedule and timezone."
  );
  addCheck(
    checks,
    "backup_retention",
    positiveInteger(retention?.retentionDays) &&
      positiveInteger(retention?.minimumBackups ?? retention?.minBackups),
    "Backup policy evidence must include positive retentionDays and minimumBackups."
  );
  addCheck(
    checks,
    "backup_objectives",
    positiveFiniteNumber(objectives?.rpoHours) && positiveFiniteNumber(objectives?.rtoHours),
    "Backup policy evidence must include positive RPO and RTO hour targets."
  );
  addCheck(
    checks,
    "backup_monitoring",
    booleanTrue(monitoring?.backupAgeAlertConfigured) &&
      booleanTrue(monitoring?.restoreDrillAgeAlertConfigured) &&
      Boolean(stringValue(monitoring?.alertChannel) ?? stringValue(monitoring?.alertTarget)) &&
      Boolean(stringValue(monitoring?.owner) ?? stringValue(monitoring?.team)),
    "Backup policy evidence must include backup-age and restore-drill-age alerts with owner and delivery target."
  );

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-backup-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxBackupAgeHours,
      maxRestoreDrillAgeHours,
      requireOffHost
    },
    selectedEvidence: {
      backupVerify: summarizeEvidence(
        backupVerify,
        ["createdAt", "verifiedAt", "completedAt", "timestamp"],
        offHostLocation
      ),
      restoreDrill: summarizeEvidence(restoreDrill, ["drilledAt", "completedAt", "timestamp", "createdAt"]),
      backupOffload: summarizeEvidence(
        backupOffload,
        ["offloadedAt", "completedAt", "timestamp", "createdAt"],
        offHostLocation
      ),
      backupFetch: summarizeEvidence(
        backupFetch,
        ["fetchedAt", "completedAt", "timestamp", "createdAt"],
        fetchSourceLocation(backupFetch)
      ),
      backupProviderSecurityAudit: summarizeEvidence(
        backupProviderSecurityAudit,
        ["checkedAt", "completedAt", "timestamp", "createdAt"]
      ),
      backupPrune: summarizeEvidence(backupPrune, ["checkedAt", "prunedAt", "completedAt", "timestamp", "createdAt"])
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runBackupEvidenceCheck(
  options: BackupEvidenceCheckOptions
): Promise<BackupEvidenceCheckResult> {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateBackupEvidence(raw, options);
}

export function parseBackupEvidenceCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false,
    maxBackupAgeHours: defaultMaxBackupAgeHours,
    maxRestoreDrillAgeHours: defaultMaxRestoreDrillAgeHours,
    requireOffHost: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--evidence") {
      parsed.evidencePath = args[++index];
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--max-backup-age-hours") {
      parsed.maxBackupAgeHours = Number(args[++index]);
    } else if (arg === "--max-restore-drill-age-hours") {
      parsed.maxRestoreDrillAgeHours = Number(args[++index]);
    } else if (arg === "--require-off-host") {
      parsed.requireOffHost = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.evidencePath) {
    throw new Error("--evidence <file> is required.");
  }

  positiveNumber(parsed.maxBackupAgeHours, defaultMaxBackupAgeHours, "--max-backup-age-hours");
  positiveNumber(parsed.maxRestoreDrillAgeHours, defaultMaxRestoreDrillAgeHours, "--max-restore-drill-age-hours");

  return parsed;
}

export function backupEvidenceCheckUsage() {
  return [
    "Usage: npm run --silent backup:evidence -- --evidence <file> [--json] [--require-off-host]",
    "",
    "Options:",
    "  --evidence <file>                  Evidence JSON containing backup verify, restore-drill, and DR policy records.",
    `  --max-backup-age-hours <hours>     Maximum backup manifest age. Default: ${defaultMaxBackupAgeHours}.`,
    `  --max-restore-drill-age-hours <h>  Maximum restore-drill evidence age. Default: ${defaultMaxRestoreDrillAgeHours}.`,
    "  --require-off-host                Require backupOffload and non-dry-run backupPrune evidence.",
    "  --json                            Emit a single JSON result.",
    "  --help                            Show this help.",
    "",
    "Required evidence includes schedule, retention, RPO/RTO, age-alert ownership, and restored artifact integrity."
  ].join("\n");
}

function writeHumanResult(result: BackupEvidenceCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow backup evidence status: ${result.status}\n`);
  output.write(`Evidence: ${result.evidencePath}\n`);
  output.write("Checks:\n");

  for (const check of result.checks) {
    output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
  }
}

export async function runBackupEvidenceCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<BackupEvidenceCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseBackupEvidenceCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${backupEvidenceCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${backupEvidenceCheckUsage()}\n`);
    return 0;
  }

  try {
    const result = await runBackupEvidenceCheck({
      ...baseOptions,
      evidencePath: parsed.evidencePath!,
      maxBackupAgeHours: parsed.maxBackupAgeHours,
      maxRestoreDrillAgeHours: parsed.maxRestoreDrillAgeHours,
      requireOffHost: parsed.requireOffHost
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: BackupEvidenceCheckResult = {
      name: "siteflow-backup-evidence-check",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      evidencePath: parsed.evidencePath!,
      thresholds: {
        maxBackupAgeHours: parsed.maxBackupAgeHours,
        maxRestoreDrillAgeHours: parsed.maxRestoreDrillAgeHours,
        requireOffHost: parsed.requireOffHost
      },
      selectedEvidence: {
        backupVerify: null,
        restoreDrill: null,
        backupOffload: null,
        backupFetch: null,
        backupProviderSecurityAudit: null,
        backupPrune: null
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
  runBackupEvidenceCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
