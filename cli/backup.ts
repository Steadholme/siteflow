import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultCommandRunner, type SiteFlowCommandRunner } from "./doctor.js";

export interface BackupRuntimeDependencies {
  runner?: SiteFlowCommandRunner;
  now?: () => Date;
}

export interface BackupOffloadEncryptionEvidence {
  mode: "kms";
  kmsKeyRef: string;
  evidenceSource: "operator_provided" | "aws_s3api";
  verification?: {
    checkedAt: string;
    bucket: string;
    key: string;
    serverSideEncryption: string;
    kmsKeyRef: string;
  };
}

export interface BackupOffloadProviderRetentionEvidence {
  status: "enabled";
  mode: string;
  retentionDays: number;
  contractId: string;
  evidenceSource: "operator_provided" | "aws_s3api";
  verification?: {
    checkedAt: string;
    bucket: string;
    key: string;
    objectLockMode: string;
    retainUntil: string;
  };
}

export interface BackupOffloadProviderProof {
  status: "verified";
  checkedAt: string;
  provider: "aws_s3";
  bucket: string;
  prefix: string;
  sampleObjectKey: string;
  object: {
    serverSideEncryption: string;
    sseKmsKeyId: string;
    objectLockMode: string;
    objectLockRetainUntilDate: string;
    retentionDaysRemaining: number;
  };
  bucketObjectLock: {
    objectLockEnabled: true;
    defaultRetentionMode: string;
    defaultRetentionDays: number;
  };
  checks: Array<{
    name: "s3_head_object" | "s3_object_kms" | "s3_object_lock_retention" | "s3_bucket_object_lock";
    status: "pass";
  }>;
  evidenceSource: "provider_api";
}

export interface CreateBackupOptions {
  output: string;
  databaseUrl: string;
  artifactRoot: string;
  version: string;
}

export interface RestoreBackupOptions {
  backup: string;
  databaseUrl: string;
  artifactRoot: string;
}

export interface RestoreDrillOptions extends RestoreBackupOptions {
  sourceDatabaseUrl?: string;
  currentArtifactRoot?: string;
}

export interface VerifyBackupOptions {
  backup: string;
}

export interface OffloadBackupOptions {
  backup: string;
  target: string;
  kmsKeyRef?: string;
  providerRetentionMode?: string;
  providerRetentionDays?: number;
  providerRetentionContract?: string;
  verifyProviderConfig?: boolean;
}

export interface FetchBackupOptions {
  source: string;
  output: string;
  expectedTreeSha256: string;
  expectedObjectCount: number;
  expectedTotalBytes: number;
}

export interface PruneBackupsOptions {
  backupRoot: string;
  retentionDays: number;
  minimumBackups: number;
  dryRun?: boolean;
  yes?: boolean;
}

export interface BackupManifest {
  version: string;
  createdAt: string;
  database: {
    dumpFile: string;
    format: "plain";
    sha256?: string;
    sizeBytes?: number;
  };
  artifacts: {
    sourcePath: string;
    path: string | null;
    copied: boolean;
    treeSha256?: string;
    fileCount?: number;
    totalBytes?: number;
  };
}

export interface BackupResult {
  status: "backed_up";
  backupPath: string;
  manifestPath: string;
  createdAt: string;
  version: string;
  database: {
    dumpFile: string;
    sha256: string;
    sizeBytes: number;
  };
  artifacts: {
    sourcePath: string;
    path: string | null;
    copied: boolean;
    treeSha256: string | null;
    fileCount: number;
    totalBytes: number;
  };
}

export interface RestoreResult {
  status: "restored";
  backupPath: string;
  version: string;
  database: {
    dumpFile: string;
    restoredWith: "psql";
  };
  artifacts: {
    targetPath: string;
    path: string | null;
    copied: boolean;
    treeSha256: string | null;
    fileCount: number | null;
    totalBytes: number | null;
    checksumVerified: boolean;
  };
}

export interface RestoreDrillResult {
  status: "restore_drilled";
  restoreDrill: true;
  backupPath: string;
  version: string;
  completedAt: string;
  durationMs: number;
  note: string;
  database: {
    dumpFile: string;
    restoredWith: "psql";
    target: "disposable_database";
    databaseUrl: string;
  };
  artifacts: {
    target: "temporary_artifact_root";
    targetPath: string;
    path: string | null;
    copied: boolean;
    restoreMode: "replace_non_atomic" | "not_copied";
    treeSha256: string | null;
    fileCount: number | null;
    totalBytes: number | null;
    checksumVerified: boolean;
  };
}

export interface BackupVerifyResult {
  status: "verified";
  backupPath: string;
  manifestPath: string;
  version: string;
  createdAt: string;
  verificationType: "static";
  restoreDrill: false;
  note: string;
  checks: Array<{
    name: string;
    status: "pass";
    summary: string;
  }>;
  database: {
    dumpFile: string;
    sizeBytes: number;
    format: "plain";
    sha256: string | null;
    checksumVerified: boolean;
  };
  artifacts: {
    sourcePath: string;
    path: string | null;
    copied: boolean;
    present: boolean;
    treeSha256: string | null;
    checksumVerified: boolean;
    fileCount: number | null;
    totalBytes: number | null;
  };
}

export interface BackupOffloadResult {
  status: "offloaded";
  backupPath: string;
  offloadedAt: string;
  manifestPath: string;
  version: string;
  target: {
    provider: "file" | "s3";
    location: string;
    path?: string;
    objectCount: number;
    totalBytes: number;
    treeSha256: string;
    checksumVerified: boolean;
    encryption?: BackupOffloadEncryptionEvidence;
    providerRetention?: BackupOffloadProviderRetentionEvidence;
    providerProof?: BackupOffloadProviderProof;
  };
  source: {
    objectCount: number;
    totalBytes: number;
    treeSha256: string;
  };
  manifest: {
    sha256: string;
  };
  database: {
    sha256: string | null;
    sizeBytes: number;
  };
  artifacts: {
    treeSha256: string | null;
    fileCount: number | null;
    totalBytes: number | null;
    checksumVerified: boolean;
  };
}

export interface BackupFetchResult {
  status: "fetched";
  source: {
    provider: "s3";
    location: string;
    objectCount: number;
    totalBytes: number;
    treeSha256: string;
  };
  backupPath: string;
  fetchedAt: string;
  objectCount: number;
  totalBytes: number;
  treeSha256: string;
  checksumVerified: boolean;
  verifyResult: {
    status: "verified";
    manifestPath: string;
    version: string;
    database: {
      sha256: string | null;
      sizeBytes: number;
      checksumVerified: boolean;
    };
    artifacts: {
      treeSha256: string | null;
      fileCount: number | null;
      totalBytes: number | null;
      checksumVerified: boolean;
    };
  };
}

export interface BackupPruneEntry {
  backupPath: string;
  createdAt: string;
  ageHours: number;
}

export interface BackupPruneResult {
  status: "planned" | "pruned";
  backupRoot: string;
  checkedAt: string;
  retentionDays: number;
  minimumBackups: number;
  dryRun: boolean;
  evaluatedBackups: number;
  retained: BackupPruneEntry[];
  candidates: BackupPruneEntry[];
  deleted: BackupPruneEntry[];
  skipped: Array<{
    backupPath: string;
    reason: string;
  }>;
}

const databaseDumpFile = "database/siteflow.sql";
const artifactManifestPath = "artifacts";
const manifestFileName = "manifest.json";
const staticVerificationNote = "Static verification only; no database restore was performed.";
const restoreDrillNote = "Restore drill completed against caller-confirmed disposable targets. Do not use production database or artifact roots for drills.";

function requiredValue(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function normalizeBackupPath(filePath: string) {
  return path.resolve(filePath);
}

function isPathInsideOrEqual(rootPath: string, targetPath: string) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));

  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(leftPath: string, rightPath: string) {
  return isPathInsideOrEqual(leftPath, rightPath) || isPathInsideOrEqual(rightPath, leftPath);
}

function decodeUrlPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function canonicalDatabaseKey(databaseUrl: string, label: string) {
  const value = requiredValue(databaseUrl, label);
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`);
  }

  const protocol = parsed.protocol.toLowerCase();

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(`${label} must be a PostgreSQL URL.`);
  }

  if (!parsed.hostname) {
    throw new Error(`${label} must include a host for restore-drill isolation checks.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";
  const database = decodeUrlPart(parsed.pathname.replace(/^\/+/, ""));
  const user = decodeUrlPart(parsed.username);

  return `${hostname}:${port}/${database}?user=${user}`;
}

function assertRestoreDrillDatabaseIsolation(sourceDatabaseUrl: string | undefined, targetDatabaseUrl: string) {
  if (!sourceDatabaseUrl?.trim()) {
    return;
  }

  if (
    canonicalDatabaseKey(sourceDatabaseUrl, "--source-database-url") ===
    canonicalDatabaseKey(targetDatabaseUrl, "--database-url")
  ) {
    throw new Error("Restore drill database URL must be isolated from the current source database.");
  }
}

function assertRestoreDrillArtifactIsolation(
  sourceArtifactRoot: string | null | undefined,
  targetArtifactRoot: string,
  sourceLabel = "backup source artifact root"
) {
  if (!sourceArtifactRoot?.trim()) {
    return;
  }

  if (pathsOverlap(sourceArtifactRoot, targetArtifactRoot)) {
    throw new Error(`Restore drill artifact root must be isolated from the ${sourceLabel}.`);
  }
}

function assertChildPath(rootPath: string, targetPath: string, label: string) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget === resolvedRoot || !isPathInsideOrEqual(resolvedRoot, resolvedTarget)) {
    throw new Error(`${label} must be inside the backup root and must not be the backup root itself.`);
  }

  return resolvedTarget;
}

function isEnoent(error: unknown) {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(filePath: string) {
  return stat(filePath).then(
    (value) => value,
    (error: unknown) => {
      if (isEnoent(error)) {
        return undefined;
      }

      throw error;
    }
  );
}

function validateRelativePath(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Backup manifest ${label} must be a non-empty string.`);
  }

  const segments = value.split(/[\\/]+/);
  const normalized = path.normalize(value);

  if (path.isAbsolute(value) || segments.includes("..") || normalized === ".") {
    throw new Error(`Backup manifest ${label} must be a relative path inside the backup.`);
  }

  return value;
}

function pathInsideBackup(backupPath: string, manifestPath: string) {
  const resolvedBackup = normalizeBackupPath(backupPath);
  const resolved = path.resolve(resolvedBackup, manifestPath);
  const rootPrefix = resolvedBackup.endsWith(path.sep) ? resolvedBackup : `${resolvedBackup}${path.sep}`;

  if (resolved !== resolvedBackup && !resolved.startsWith(rootPrefix)) {
    throw new Error("Backup manifest contains an unsafe path.");
  }

  return resolved;
}

function optionalSha256(value: unknown, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`Backup manifest ${label} must be a SHA-256 hex digest.`);
  }

  return value.toLowerCase();
}

function optionalNonNegativeInteger(value: unknown, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Backup manifest ${label} must be a non-negative integer.`);
  }

  return value;
}

function parseManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Backup manifest must be a JSON object.");
  }

  const candidate = raw as Partial<BackupManifest>;

  if (typeof candidate.version !== "string" || candidate.version.trim() === "") {
    throw new Error("Backup manifest version must be a non-empty string.");
  }

  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
    throw new Error("Backup manifest createdAt must be an ISO timestamp.");
  }

  if (!candidate.database || typeof candidate.database !== "object") {
    throw new Error("Backup manifest database section is required.");
  }

  if (candidate.database.format !== "plain") {
    throw new Error("Backup manifest database.format must be plain.");
  }

  const dumpFile = validateRelativePath(candidate.database.dumpFile, "database.dumpFile");

  if (!candidate.artifacts || typeof candidate.artifacts !== "object") {
    throw new Error("Backup manifest artifacts section is required.");
  }

  if (typeof candidate.artifacts.sourcePath !== "string") {
    throw new Error("Backup manifest artifacts.sourcePath must be a string.");
  }

  if (typeof candidate.artifacts.copied !== "boolean") {
    throw new Error("Backup manifest artifacts.copied must be a boolean.");
  }

  const artifactPath = candidate.artifacts.path === null
    ? null
    : validateRelativePath(candidate.artifacts.path, "artifacts.path");

  if (candidate.artifacts.copied && artifactPath === null) {
    throw new Error("Backup manifest artifacts.path is required when artifacts.copied is true.");
  }

  if (!candidate.artifacts.copied && artifactPath !== null) {
    throw new Error("Backup manifest artifacts.path must be null when artifacts.copied is false.");
  }

  return {
    version: candidate.version,
    createdAt: candidate.createdAt,
    database: {
      dumpFile,
      format: "plain",
      sha256: optionalSha256(candidate.database.sha256, "database.sha256"),
      sizeBytes: optionalNonNegativeInteger(candidate.database.sizeBytes, "database.sizeBytes")
    },
    artifacts: {
      sourcePath: candidate.artifacts.sourcePath,
      path: artifactPath,
      copied: candidate.artifacts.copied,
      treeSha256: optionalSha256(candidate.artifacts.treeSha256, "artifacts.treeSha256"),
      fileCount: optionalNonNegativeInteger(candidate.artifacts.fileCount, "artifacts.fileCount"),
      totalBytes: optionalNonNegativeInteger(candidate.artifacts.totalBytes, "artifacts.totalBytes")
    }
  };
}

async function verifyDumpFile(dumpPath: string) {
  const dumpStat = await pathExists(dumpPath);

  if (!dumpStat) {
    throw new Error("Backup database dump file is missing.");
  }

  if (!dumpStat.isFile()) {
    throw new Error("Backup database dump path must be a file.");
  }

  if (dumpStat.size === 0) {
    throw new Error("Backup database dump file is empty.");
  }

  return dumpStat;
}

async function fileIntegrity(filePath: string) {
  const bytes = await readFile(filePath);

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength
  };
}

async function artifactTreeIntegrity(rootPath: string) {
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];

  async function collect(directory: string, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        throw new Error(`Backup artifact tree contains unsupported symbolic link: ${relativePath}`);
      }

      if (entry.isDirectory()) {
        await collect(entryPath, relativePath);
        continue;
      }

      if (entry.isFile()) {
        files.push({
          relativePath,
          bytes: await readFile(entryPath)
        });
      }
    }
  }

  await collect(rootPath);

  const checksum = createHash("sha256");
  let totalBytes = 0;

  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    checksum.update(file.relativePath);
    checksum.update("\0");
    checksum.update(file.bytes);
    totalBytes += file.bytes.byteLength;
  }

  return {
    treeSha256: checksum.digest("hex"),
    fileCount: files.length,
    totalBytes
  };
}

async function readManifest(backupPath: string) {
  const manifestPath = path.join(backupPath, manifestFileName);
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const manifest = parseManifest(raw);

  pathInsideBackup(backupPath, manifest.database.dumpFile);

  if (manifest.artifacts.path) {
    pathInsideBackup(backupPath, manifest.artifacts.path);
  }

  return { manifest, manifestPath };
}

type ParsedOffloadTarget =
  | {
      kind: "file";
      rootPath: string;
    }
  | {
      kind: "s3";
      rootUri: string;
      bucket: string;
      prefix: string;
    };

function normalizeS3Prefix(pathname: string) {
  return decodeURIComponent(pathname).replace(/^\/+|\/+$/g, "");
}

function s3RootUri(bucket: string, prefix: string) {
  return prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
}

function appendS3Uri(rootUri: string, child: string) {
  return `${rootUri.replace(/\/+$/g, "")}/${child.replace(/^\/+/g, "")}`;
}

function s3ObjectKey(prefix: string, ...parts: string[]) {
  return [prefix, ...parts]
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function parseOffloadTarget(target: string): ParsedOffloadTarget {
  const rawTarget = requiredValue(target, "--target");
  let parsed: URL;

  try {
    parsed = new URL(rawTarget);
  } catch {
    throw new Error("Backup offload target must be a file:// or s3:// URL.");
  }

  if (parsed.protocol === "file:") {
    return {
      kind: "file",
      rootPath: path.resolve(fileURLToPath(parsed))
    };
  }

  if (parsed.protocol === "s3:") {
    if (!parsed.hostname) {
      throw new Error("Backup offload s3:// target must include a bucket.");
    }

    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Backup offload s3:// target must not include credentials, query, or fragment.");
    }

    const prefix = normalizeS3Prefix(parsed.pathname);

    return {
      kind: "s3",
      rootUri: s3RootUri(parsed.hostname, prefix),
      bucket: parsed.hostname,
      prefix
    };
  }

  throw new Error("Backup offload currently supports only file:// and s3:// targets.");
}

function parseBackupSource(source: string) {
  const rawSource = requiredValue(source, "--source");
  let parsed: URL;

  try {
    parsed = new URL(rawSource);
  } catch {
    throw new Error("Backup fetch source must be an s3:// URL.");
  }

  if (parsed.protocol !== "s3:") {
    throw new Error("Backup fetch currently supports only s3:// sources.");
  }

  if (!parsed.hostname) {
    throw new Error("Backup fetch s3:// source must include a bucket.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Backup fetch s3:// source must not include credentials, query, or fragment.");
  }

  const prefix = normalizeS3Prefix(parsed.pathname);

  if (!prefix) {
    throw new Error("Backup fetch s3:// source must include a backup prefix.");
  }

  return {
    rootUri: s3RootUri(parsed.hostname, prefix),
    bucket: parsed.hostname,
    prefix
  };
}

function offloadEncryptionEvidence(options: OffloadBackupOptions): BackupOffloadEncryptionEvidence | undefined {
  const kmsKeyRef = options.kmsKeyRef?.trim();

  if (!kmsKeyRef) {
    return undefined;
  }

  return {
    mode: "kms",
    kmsKeyRef,
    evidenceSource: "operator_provided"
  } satisfies BackupOffloadEncryptionEvidence;
}

function offloadProviderRetentionEvidence(options: OffloadBackupOptions): BackupOffloadProviderRetentionEvidence | undefined {
  const mode = options.providerRetentionMode?.trim();
  const contractId = options.providerRetentionContract?.trim();
  const retentionDays = options.providerRetentionDays;
  const provided = Boolean(mode || contractId || retentionDays !== undefined);

  if (!provided) {
    return undefined;
  }

  if (!mode || !contractId || retentionDays === undefined) {
    throw new Error("Backup offload provider retention evidence requires --provider-retention-mode, --provider-retention-days, and --provider-retention-contract.");
  }

  return {
    status: "enabled",
    mode,
    retentionDays: requiredPositiveInteger(retentionDays, "--provider-retention-days"),
    contractId,
    evidenceSource: "operator_provided"
  } satisfies BackupOffloadProviderRetentionEvidence;
}

function rejectObjectStorageEvidenceForFileTarget(options: OffloadBackupOptions) {
  if (
    options.kmsKeyRef?.trim() ||
    options.providerRetentionMode?.trim() ||
    options.providerRetentionContract?.trim() ||
    options.providerRetentionDays !== undefined ||
    options.verifyProviderConfig
  ) {
    throw new Error("Backup offload KMS and provider retention evidence require an object-storage target.");
  }
}

function requiredPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function requiredNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value;
}

function requiredSha256(value: string | undefined, label: string) {
  const digest = requiredValue(value, label).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a SHA-256 hex digest.`);
  }

  return digest;
}

function ageHours(nowMs: number, createdAt: string) {
  return Math.max(0, Math.round(((nowMs - Date.parse(createdAt)) / 36_000)) / 100);
}

function uniqueSensitiveValues(databaseUrl: string) {
  const values = new Set<string>();

  if (databaseUrl) {
    values.add(databaseUrl);
  }

  try {
    const parsed = new URL(databaseUrl);

    if (parsed.password) {
      values.add(parsed.password);
      values.add(decodeURIComponent(parsed.password));
    }
  } catch {
    return [...values];
  }

  return [...values].filter((value) => value.length > 0);
}

export function redactDatabaseUrl(message: string, databaseUrl: string) {
  return uniqueSensitiveValues(databaseUrl).reduce(
    (current, value) => current.replaceAll(value, value === databaseUrl ? "[redacted database url]" : "[redacted]"),
    message
  );
}

function commandFailureMessage(result: Awaited<ReturnType<SiteFlowCommandRunner>>, fallback: string, databaseUrl: string) {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const message = output ? `${fallback}: ${output}` : fallback;

  return redactDatabaseUrl(message, databaseUrl);
}

async function runChecked(
  runner: SiteFlowCommandRunner,
  command: string,
  args: string[],
  databaseUrl: string,
  failureMessage: string
) {
  try {
    const result = await runner(command, args);

    if (result.exitCode !== 0) {
      throw new Error(commandFailureMessage(result, failureMessage, databaseUrl));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : failureMessage;

    throw new Error(redactDatabaseUrl(message, databaseUrl));
  }
}

function objectStorageCommandFailureMessage(result: Awaited<ReturnType<SiteFlowCommandRunner>>, fallback: string) {
  const output = `${result.stdout}\n${result.stderr}`.trim();

  return output ? `${fallback}: ${output}` : fallback;
}

async function runObjectStorageCommand(
  runner: SiteFlowCommandRunner,
  command: string,
  args: string[],
  failureMessage: string
) {
  try {
    const result = await runner(command, args);

    if (result.exitCode !== 0) {
      throw new Error(objectStorageCommandFailureMessage(result, failureMessage));
    }

    return result;
  } catch (error) {
    throw new Error(error instanceof Error && error.message ? error.message : failureMessage);
  }
}

function parseAwsS3RecursiveList(stdout: string) {
  let objectCount = 0;
  let totalBytes = 0;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)\s+(.+)$/.exec(trimmed);

    if (!match) {
      continue;
    }

    objectCount += 1;
    totalBytes += Number(match[3]);
  }

  return { objectCount, totalBytes };
}

function parseJsonObject(stdout: string, label: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned invalid JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedJsonObject(value: Record<string, unknown>, key: string) {
  const candidate = value[key];

  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function verifiedS3ProviderEvidence(
  options: OffloadBackupOptions,
  bucket: string,
  prefix: string,
  manifestObjectKey: string,
  headObjectStdout: string,
  objectLockConfigurationStdout: string,
  checkedAt: string
) {
  const metadata = parseJsonObject(headObjectStdout, "Backup S3 provider verification");
  const objectLockConfiguration = parseJsonObject(
    objectLockConfigurationStdout,
    "Backup S3 object lock configuration verification"
  );
  const serverSideEncryption = optionalString(metadata.ServerSideEncryption);
  const observedKmsKeyRef = optionalString(metadata.SSEKMSKeyId);

  if (serverSideEncryption !== "aws:kms" || !observedKmsKeyRef) {
    throw new Error("Backup S3 provider verification requires the uploaded manifest object to use SSE-KMS.");
  }

  const encryption: BackupOffloadEncryptionEvidence = {
    mode: "kms",
    kmsKeyRef: observedKmsKeyRef,
    evidenceSource: "aws_s3api",
    verification: {
      checkedAt,
      bucket,
      key: manifestObjectKey,
      serverSideEncryption,
      kmsKeyRef: observedKmsKeyRef
    }
  };
  const providerRetention = offloadProviderRetentionEvidence(options);

  if (!providerRetention) {
    throw new Error("Backup S3 provider verification requires provider retention evidence options.");
  }

  const objectLockMode = optionalString(metadata.ObjectLockMode);
  const retainUntil = optionalString(metadata.ObjectLockRetainUntilDate);

  if (!objectLockMode || !retainUntil) {
    throw new Error("Backup S3 provider verification requires object lock retention metadata on the uploaded manifest object.");
  }

  const retainUntilMs = Date.parse(retainUntil);
  const minimumRetainUntilMs = Date.parse(checkedAt) + providerRetention.retentionDays * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(retainUntilMs) || retainUntilMs < minimumRetainUntilMs) {
    throw new Error("Backup S3 provider verification found object lock retention shorter than the requested provider retention window.");
  }
  const checkedAtMs = Date.parse(checkedAt);
  const retentionDaysRemaining = Math.floor((retainUntilMs - checkedAtMs) / (24 * 60 * 60 * 1000));
  const configuration = nestedJsonObject(objectLockConfiguration, "ObjectLockConfiguration");
  const rule = configuration ? nestedJsonObject(configuration, "Rule") : undefined;
  const defaultRetention = rule ? nestedJsonObject(rule, "DefaultRetention") : undefined;
  const objectLockEnabled = optionalString(configuration?.ObjectLockEnabled);
  const defaultRetentionMode = optionalString(defaultRetention?.Mode);
  const defaultRetentionDays = optionalNumber(defaultRetention?.Days);

  if (objectLockEnabled !== "Enabled" || !defaultRetentionMode || defaultRetentionDays === undefined) {
    throw new Error("Backup S3 provider verification requires bucket Object Lock default retention configuration.");
  }

  if (defaultRetentionMode.toLowerCase() !== providerRetention.mode.toLowerCase()) {
    throw new Error("Backup S3 provider verification found bucket retention mode different from the requested provider retention mode.");
  }

  if (defaultRetentionDays < providerRetention.retentionDays) {
    throw new Error("Backup S3 provider verification found bucket default retention shorter than the requested provider retention window.");
  }
  const verifiedProviderRetention: BackupOffloadProviderRetentionEvidence = {
    ...providerRetention,
    mode: objectLockMode.toLowerCase(),
    evidenceSource: "aws_s3api",
    verification: {
      checkedAt,
      bucket,
      key: manifestObjectKey,
      objectLockMode,
      retainUntil
    }
  };
  const providerProof: BackupOffloadProviderProof = {
    status: "verified",
    checkedAt,
    provider: "aws_s3",
    bucket,
    prefix,
    sampleObjectKey: manifestObjectKey,
    object: {
      serverSideEncryption,
      sseKmsKeyId: observedKmsKeyRef,
      objectLockMode,
      objectLockRetainUntilDate: retainUntil,
      retentionDaysRemaining
    },
    bucketObjectLock: {
      objectLockEnabled: true,
      defaultRetentionMode,
      defaultRetentionDays
    },
    checks: [
      { name: "s3_head_object", status: "pass" },
      { name: "s3_object_kms", status: "pass" },
      { name: "s3_object_lock_retention", status: "pass" },
      { name: "s3_bucket_object_lock", status: "pass" }
    ],
    evidenceSource: "provider_api"
  };

  return {
    encryption,
    providerRetention: verifiedProviderRetention,
    providerProof
  };
}

async function ensureDirectoryArtifactRoot(artifactRoot: string) {
  const artifactStat = await pathExists(artifactRoot);

  if (!artifactStat) {
    return false;
  }

  if (!artifactStat.isDirectory()) {
    throw new Error("Artifact root must be a directory when it exists.");
  }

  return true;
}

export async function createSiteFlowBackup(
  options: CreateBackupOptions,
  dependencies: BackupRuntimeDependencies = {}
): Promise<BackupResult> {
  const output = normalizeBackupPath(requiredValue(options.output, "--output"));
  const databaseUrl = requiredValue(options.databaseUrl, "--database-url");
  const artifactRoot = path.resolve(requiredValue(options.artifactRoot, "--artifact-root"));
  const version = requiredValue(options.version, "version");
  const runner = dependencies.runner ?? defaultCommandRunner;
  const createdAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const databaseDir = path.join(output, "database");
  const dumpPath = path.join(output, databaseDumpFile);
  const artifactTarget = path.join(output, artifactManifestPath);
  const manifestPath = path.join(output, manifestFileName);

  await mkdir(databaseDir, { recursive: true });
  await runChecked(
    runner,
    "pg_dump",
    ["--dbname", databaseUrl, "--file", dumpPath],
    databaseUrl,
    "Database backup failed"
  );

  if (!await pathExists(dumpPath)) {
    throw new Error("Database dump was not created.");
  }

  await verifyDumpFile(dumpPath);
  const databaseIntegrity = await fileIntegrity(dumpPath);
  const artifactRootExists = await ensureDirectoryArtifactRoot(artifactRoot);
  let artifactIntegrity: Awaited<ReturnType<typeof artifactTreeIntegrity>> | undefined;

  if (artifactRootExists) {
    await rm(artifactTarget, { recursive: true, force: true });
    await cp(artifactRoot, artifactTarget, { recursive: true });
    artifactIntegrity = await artifactTreeIntegrity(artifactTarget);
  }

  const manifest: BackupManifest = {
    version,
    createdAt,
    database: {
      dumpFile: databaseDumpFile,
      format: "plain",
      sha256: databaseIntegrity.sha256,
      sizeBytes: databaseIntegrity.sizeBytes
    },
    artifacts: {
      sourcePath: artifactRoot,
      path: artifactRootExists ? artifactManifestPath : null,
      copied: artifactRootExists,
      ...(artifactIntegrity
        ? {
          treeSha256: artifactIntegrity.treeSha256,
          fileCount: artifactIntegrity.fileCount,
          totalBytes: artifactIntegrity.totalBytes
        }
        : {})
    }
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    status: "backed_up",
    backupPath: output,
    manifestPath,
    createdAt,
    version,
    database: {
      dumpFile: dumpPath,
      sha256: databaseIntegrity.sha256,
      sizeBytes: databaseIntegrity.sizeBytes
    },
    artifacts: {
      sourcePath: artifactRoot,
      path: artifactRootExists ? artifactTarget : null,
      copied: artifactRootExists,
      treeSha256: artifactIntegrity?.treeSha256 ?? null,
      fileCount: artifactIntegrity?.fileCount ?? 0,
      totalBytes: artifactIntegrity?.totalBytes ?? 0
    }
  };
}

export async function restoreSiteFlowBackup(
  options: RestoreBackupOptions,
  dependencies: BackupRuntimeDependencies = {}
): Promise<RestoreResult> {
  const backupPath = normalizeBackupPath(requiredValue(options.backup, "--backup"));
  const databaseUrl = requiredValue(options.databaseUrl, "--database-url");
  const artifactRoot = path.resolve(requiredValue(options.artifactRoot, "--artifact-root"));
  const runner = dependencies.runner ?? defaultCommandRunner;
  const verified = await verifySiteFlowBackup({ backup: backupPath });
  const dumpPath = verified.database.dumpFile;

  await runChecked(
    runner,
    "psql",
    ["--dbname", databaseUrl, "--set", "ON_ERROR_STOP=1", "--single-transaction", "--file", dumpPath],
    databaseUrl,
    "Database restore failed"
  );

  const sourceArtifacts = verified.artifacts.path ?? undefined;
  let artifactsCopied = false;
  let restoredArtifactIntegrity: Awaited<ReturnType<typeof artifactTreeIntegrity>> | undefined;

  if (sourceArtifacts) {
    await rm(artifactRoot, { recursive: true, force: true });
    await mkdir(path.dirname(artifactRoot), { recursive: true });
    await cp(sourceArtifacts, artifactRoot, { recursive: true });
    restoredArtifactIntegrity = await artifactTreeIntegrity(artifactRoot);
    artifactsCopied = true;
  }

  return {
    status: "restored",
    backupPath,
    version: verified.version,
    database: {
      dumpFile: dumpPath,
      restoredWith: "psql"
    },
    artifacts: {
      targetPath: artifactRoot,
      path: sourceArtifacts ?? null,
      copied: artifactsCopied,
      treeSha256: restoredArtifactIntegrity?.treeSha256 ?? null,
      fileCount: restoredArtifactIntegrity?.fileCount ?? null,
      totalBytes: restoredArtifactIntegrity?.totalBytes ?? null,
      checksumVerified: artifactsCopied
        ? Boolean(
          verified.artifacts.treeSha256 &&
            restoredArtifactIntegrity?.treeSha256 === verified.artifacts.treeSha256 &&
            restoredArtifactIntegrity.fileCount === verified.artifacts.fileCount &&
            restoredArtifactIntegrity.totalBytes === verified.artifacts.totalBytes
        )
        : verified.artifacts.copied === false
    }
  };
}

export async function restoreDrillSiteFlowBackup(
  options: RestoreDrillOptions,
  dependencies: BackupRuntimeDependencies = {}
): Promise<RestoreDrillResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  assertRestoreDrillDatabaseIsolation(options.sourceDatabaseUrl, options.databaseUrl);
  const verified = await verifySiteFlowBackup({ backup: options.backup });
  const artifactRoot = path.resolve(requiredValue(options.artifactRoot, "--artifact-root"));

  assertRestoreDrillArtifactIsolation(verified.artifacts.sourcePath, artifactRoot);
  assertRestoreDrillArtifactIsolation(options.currentArtifactRoot, artifactRoot, "current artifact root");

  const restored = await restoreSiteFlowBackup(options, dependencies);
  const completedAt = now();
  const durationMs = Math.max(0, completedAt.getTime() - startedAtMs);

  return {
    status: "restore_drilled",
    restoreDrill: true,
    backupPath: restored.backupPath,
    version: restored.version,
    completedAt: completedAt.toISOString(),
    durationMs,
    note: restoreDrillNote,
    database: {
      dumpFile: restored.database.dumpFile,
      restoredWith: restored.database.restoredWith,
      target: "disposable_database",
      databaseUrl: redactDatabaseUrl(options.databaseUrl, options.databaseUrl)
    },
    artifacts: {
      target: "temporary_artifact_root",
      targetPath: restored.artifacts.targetPath,
      path: restored.artifacts.path,
      copied: restored.artifacts.copied,
      restoreMode: restored.artifacts.copied ? "replace_non_atomic" : "not_copied",
      treeSha256: restored.artifacts.treeSha256,
      fileCount: restored.artifacts.fileCount,
      totalBytes: restored.artifacts.totalBytes,
      checksumVerified: restored.artifacts.checksumVerified
    }
  };
}

export async function verifySiteFlowBackup(options: VerifyBackupOptions): Promise<BackupVerifyResult> {
  const backupPath = normalizeBackupPath(requiredValue(options.backup, "--backup"));
  const { manifest, manifestPath } = await readManifest(backupPath);
  const dumpPath = pathInsideBackup(backupPath, manifest.database.dumpFile);
  const dumpStat = await verifyDumpFile(dumpPath);
  const databaseIntegrity = await fileIntegrity(dumpPath);
  const databaseChecksumProvided = Boolean(manifest.database.sha256);

  if (manifest.database.sizeBytes !== undefined && manifest.database.sizeBytes !== dumpStat.size) {
    throw new Error("Backup database dump size does not match the manifest.");
  }

  if (manifest.database.sha256 && manifest.database.sha256 !== databaseIntegrity.sha256) {
    throw new Error("Backup database dump checksum does not match the manifest.");
  }

  const sourceArtifacts = manifest.artifacts.path ? pathInsideBackup(backupPath, manifest.artifacts.path) : null;
  let artifactsPresent = false;
  let artifactIntegrity: Awaited<ReturnType<typeof artifactTreeIntegrity>> | undefined;
  const artifactChecksumProvided = Boolean(manifest.artifacts.treeSha256);

  if (sourceArtifacts) {
    const artifactStat = await pathExists(sourceArtifacts);

    if (!artifactStat) {
      throw new Error("Backup artifact directory is missing.");
    }

    if (!artifactStat.isDirectory()) {
      throw new Error("Backup artifact path must be a directory.");
    }

    artifactsPresent = true;
    artifactIntegrity = await artifactTreeIntegrity(sourceArtifacts);

    if (manifest.artifacts.fileCount !== undefined && manifest.artifacts.fileCount !== artifactIntegrity.fileCount) {
      throw new Error("Backup artifact file count does not match the manifest.");
    }

    if (manifest.artifacts.totalBytes !== undefined && manifest.artifacts.totalBytes !== artifactIntegrity.totalBytes) {
      throw new Error("Backup artifact byte count does not match the manifest.");
    }

    if (manifest.artifacts.treeSha256 && manifest.artifacts.treeSha256 !== artifactIntegrity.treeSha256) {
      throw new Error("Backup artifact tree checksum does not match the manifest.");
    }
  }

  const artifactSummary = artifactsPresent
    ? artifactChecksumProvided
      ? `artifact directory exists and checksum ${artifactIntegrity?.treeSha256} matches the manifest`
      : "artifact directory exists; legacy manifest has no artifact checksum"
    : "manifest records no copied artifact directory";
  const databaseSummary = databaseChecksumProvided
    ? `plain SQL dump exists, is ${dumpStat.size} bytes, and checksum ${databaseIntegrity.sha256} matches the manifest`
    : `plain SQL dump exists and is ${dumpStat.size} bytes; legacy manifest has no checksum`;

  return {
    status: "verified",
    backupPath,
    manifestPath,
    version: manifest.version,
    createdAt: manifest.createdAt,
    verificationType: "static",
    restoreDrill: false,
    note: staticVerificationNote,
    checks: [
      {
        name: "manifest",
        status: "pass",
        summary: "manifest schema and relative paths are valid"
      },
      {
        name: "database_dump",
        status: "pass",
        summary: databaseSummary
      },
      {
        name: "artifacts",
        status: "pass",
        summary: artifactSummary
      },
      {
        name: "restore_scope",
        status: "pass",
        summary: staticVerificationNote
      }
    ],
    database: {
      dumpFile: dumpPath,
      sizeBytes: dumpStat.size,
      format: manifest.database.format,
      sha256: manifest.database.sha256 ?? null,
      checksumVerified: databaseChecksumProvided
    },
    artifacts: {
      sourcePath: manifest.artifacts.sourcePath,
      path: sourceArtifacts,
      copied: manifest.artifacts.copied,
      present: artifactsPresent,
      treeSha256: manifest.artifacts.treeSha256 ?? null,
      checksumVerified: artifactChecksumProvided,
      fileCount: artifactIntegrity?.fileCount ?? manifest.artifacts.fileCount ?? null,
      totalBytes: artifactIntegrity?.totalBytes ?? manifest.artifacts.totalBytes ?? null
    }
  };
}

export async function offloadSiteFlowBackup(
  options: OffloadBackupOptions,
  dependencies: BackupRuntimeDependencies = {}
): Promise<BackupOffloadResult> {
  const backupPath = normalizeBackupPath(requiredValue(options.backup, "--backup"));
  const target = parseOffloadTarget(options.target);
  const offloadedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const verified = await verifySiteFlowBackup({ backup: backupPath });
  const sourceIntegrity = await artifactTreeIntegrity(backupPath);
  const manifestIntegrity = await fileIntegrity(verified.manifestPath);

  const baseResult: Omit<BackupOffloadResult, "target"> = {
    status: "offloaded",
    backupPath,
    offloadedAt,
    manifestPath: verified.manifestPath,
    version: verified.version,
    source: {
      objectCount: sourceIntegrity.fileCount,
      totalBytes: sourceIntegrity.totalBytes,
      treeSha256: sourceIntegrity.treeSha256
    },
    manifest: {
      sha256: manifestIntegrity.sha256
    },
    database: {
      sha256: verified.database.sha256,
      sizeBytes: verified.database.sizeBytes
    },
    artifacts: {
      treeSha256: verified.artifacts.treeSha256,
      fileCount: verified.artifacts.fileCount,
      totalBytes: verified.artifacts.totalBytes,
      checksumVerified: verified.artifacts.checksumVerified
    }
  };

  if (target.kind === "file") {
    rejectObjectStorageEvidenceForFileTarget(options);

    const targetPath = path.resolve(target.rootPath, path.basename(backupPath));

    if (isPathInsideOrEqual(backupPath, targetPath)) {
      throw new Error("Backup offload target must not be inside the source backup directory.");
    }

    const destinationStat = await pathExists(targetPath);

    if (destinationStat) {
      throw new Error("Backup offload destination already exists.");
    }

    await mkdir(target.rootPath, { recursive: true });
    await cp(backupPath, targetPath, { recursive: true });

    const targetIntegrity = await artifactTreeIntegrity(targetPath);
    const checksumVerified =
      targetIntegrity.treeSha256 === sourceIntegrity.treeSha256 &&
      targetIntegrity.fileCount === sourceIntegrity.fileCount &&
      targetIntegrity.totalBytes === sourceIntegrity.totalBytes;

    if (!checksumVerified) {
      throw new Error("Backup offload checksum verification failed.");
    }

    return {
      ...baseResult,
      target: {
        provider: "file",
        location: pathToFileURL(targetPath).href,
        path: targetPath,
        objectCount: targetIntegrity.fileCount,
        totalBytes: targetIntegrity.totalBytes,
        treeSha256: targetIntegrity.treeSha256,
        checksumVerified
      }
    };
  }

  const runner = dependencies.runner ?? defaultCommandRunner;
  const targetLocation = appendS3Uri(target.rootUri, path.basename(backupPath));
  const uploadLocation = `${targetLocation}/`;
  let encryption = offloadEncryptionEvidence(options);
  let providerRetention = offloadProviderRetentionEvidence(options);
  let providerProof: BackupOffloadProviderProof | undefined;
  const uploadArgs = ["s3", "cp", backupPath, uploadLocation, "--recursive", "--only-show-errors"];

  if (encryption) {
    uploadArgs.push("--sse", "aws:kms", "--sse-kms-key-id", encryption.kmsKeyRef);
  }

  const existingListing = await runObjectStorageCommand(
    runner,
    "aws",
    ["s3", "ls", uploadLocation, "--recursive"],
    "Backup S3 offload destination check failed."
  );
  const existingIntegrity = parseAwsS3RecursiveList(existingListing.stdout);

  if (existingIntegrity.objectCount > 0) {
    throw new Error("Backup S3 offload destination already contains objects.");
  }

  await runObjectStorageCommand(runner, "aws", uploadArgs, "Backup S3 offload upload failed.");
  const listing = await runObjectStorageCommand(
    runner,
    "aws",
    ["s3", "ls", uploadLocation, "--recursive"],
    "Backup S3 offload remote listing failed."
  );
  const remoteIntegrity = parseAwsS3RecursiveList(listing.stdout);
  const checksumVerified =
    remoteIntegrity.objectCount === sourceIntegrity.fileCount &&
    remoteIntegrity.totalBytes === sourceIntegrity.totalBytes;

  if (!checksumVerified) {
    throw new Error("Backup S3 offload remote object verification failed.");
  }

  if (options.verifyProviderConfig) {
    const manifestObjectKey = s3ObjectKey(target.prefix, path.basename(backupPath), manifestFileName);
    const headObject = await runObjectStorageCommand(
      runner,
      "aws",
      ["s3api", "head-object", "--bucket", target.bucket, "--key", manifestObjectKey, "--output", "json"],
      "Backup S3 provider verification failed."
    );
    const objectLockConfiguration = await runObjectStorageCommand(
      runner,
      "aws",
      ["s3api", "get-object-lock-configuration", "--bucket", target.bucket, "--output", "json"],
      "Backup S3 object lock configuration verification failed."
    );
    const verifiedProviderEvidence = verifiedS3ProviderEvidence(
      options,
      target.bucket,
      s3ObjectKey(target.prefix, path.basename(backupPath)),
      manifestObjectKey,
      headObject.stdout,
      objectLockConfiguration.stdout,
      offloadedAt
    );

    encryption = verifiedProviderEvidence.encryption;
    providerRetention = verifiedProviderEvidence.providerRetention;
    providerProof = verifiedProviderEvidence.providerProof;
  }

  return {
    ...baseResult,
    target: {
      provider: "s3",
      location: targetLocation,
      objectCount: remoteIntegrity.objectCount,
      totalBytes: remoteIntegrity.totalBytes,
      treeSha256: sourceIntegrity.treeSha256,
      checksumVerified,
      ...(encryption ? { encryption } : {}),
      ...(providerRetention ? { providerRetention } : {}),
      ...(providerProof ? { providerProof } : {})
    }
  };
}

export async function fetchSiteFlowBackup(
  options: FetchBackupOptions,
  dependencies: BackupRuntimeDependencies = {}
): Promise<BackupFetchResult> {
  const source = parseBackupSource(options.source);
  const outputRoot = normalizeBackupPath(requiredValue(options.output, "--output"));
  const expectedTreeSha256 = requiredSha256(options.expectedTreeSha256, "--expected-tree-sha256");
  const expectedObjectCount = requiredNonNegativeInteger(options.expectedObjectCount, "--expected-object-count");
  const expectedTotalBytes = requiredNonNegativeInteger(options.expectedTotalBytes, "--expected-total-bytes");
  const backupName = source.prefix.split("/").filter(Boolean).at(-1);

  if (!backupName) {
    throw new Error("Backup fetch s3:// source must include a backup prefix.");
  }

  const runner = dependencies.runner ?? defaultCommandRunner;
  const fetchedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const sourceLocation = source.rootUri;
  const sourceLocationWithSlash = `${sourceLocation.replace(/\/+$/g, "")}/`;
  const backupPath = path.join(outputRoot, backupName);

  if (await pathExists(backupPath)) {
    throw new Error("Backup fetch destination already exists.");
  }

  const listing = await runObjectStorageCommand(
    runner,
    "aws",
    ["s3", "ls", sourceLocationWithSlash, "--recursive"],
    "Backup S3 fetch remote listing failed."
  );
  const remoteIntegrity = parseAwsS3RecursiveList(listing.stdout);

  if (remoteIntegrity.objectCount !== expectedObjectCount || remoteIntegrity.totalBytes !== expectedTotalBytes) {
    throw new Error("Backup S3 fetch remote object verification failed.");
  }

  await mkdir(outputRoot, { recursive: true });
  await runObjectStorageCommand(
    runner,
    "aws",
    ["s3", "cp", sourceLocationWithSlash, backupPath, "--recursive", "--only-show-errors"],
    "Backup S3 fetch download failed."
  );

  const fetchedIntegrity = await artifactTreeIntegrity(backupPath);
  const checksumVerified =
    fetchedIntegrity.treeSha256 === expectedTreeSha256 &&
    fetchedIntegrity.fileCount === expectedObjectCount &&
    fetchedIntegrity.totalBytes === expectedTotalBytes &&
    fetchedIntegrity.fileCount === remoteIntegrity.objectCount &&
    fetchedIntegrity.totalBytes === remoteIntegrity.totalBytes;

  if (!checksumVerified) {
    throw new Error("Backup fetch checksum verification failed.");
  }

  const verified = await verifySiteFlowBackup({ backup: backupPath });

  return {
    status: "fetched",
    source: {
      provider: "s3",
      location: sourceLocation,
      objectCount: remoteIntegrity.objectCount,
      totalBytes: remoteIntegrity.totalBytes,
      treeSha256: expectedTreeSha256
    },
    backupPath,
    fetchedAt,
    objectCount: fetchedIntegrity.fileCount,
    totalBytes: fetchedIntegrity.totalBytes,
    treeSha256: fetchedIntegrity.treeSha256,
    checksumVerified,
    verifyResult: {
      status: verified.status,
      manifestPath: verified.manifestPath,
      version: verified.version,
      database: {
        sha256: verified.database.sha256,
        sizeBytes: verified.database.sizeBytes,
        checksumVerified: verified.database.checksumVerified
      },
      artifacts: {
        treeSha256: verified.artifacts.treeSha256,
        fileCount: verified.artifacts.fileCount,
        totalBytes: verified.artifacts.totalBytes,
        checksumVerified: verified.artifacts.checksumVerified
      }
    }
  };
}

export async function pruneSiteFlowBackups(
  options: PruneBackupsOptions,
  dependencies: BackupRuntimeDependencies = {}
): Promise<BackupPruneResult> {
  const backupRoot = normalizeBackupPath(requiredValue(options.backupRoot, "--backup-root"));
  const retentionDays = requiredPositiveInteger(options.retentionDays, "--retention-days");
  const minimumBackups = requiredPositiveInteger(options.minimumBackups, "--minimum-backups");
  const dryRun = options.dryRun ?? false;
  const checkedAt = (dependencies.now ?? (() => new Date()))();

  if (!dryRun && !options.yes) {
    throw new Error("Backup prune requires --yes unless --dry-run is set.");
  }

  const rootStat = await pathExists(backupRoot);

  if (!rootStat) {
    throw new Error("Backup root does not exist.");
  }

  if (!rootStat.isDirectory()) {
    throw new Error("Backup root must be a directory.");
  }

  const entries = await readdir(backupRoot, { withFileTypes: true });
  const backups: BackupPruneEntry[] = [];
  const skipped: BackupPruneResult["skipped"] = [];
  const nowMs = checkedAt.getTime();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const backupPath = assertChildPath(backupRoot, path.join(backupRoot, entry.name), "Backup prune candidate");

    try {
      const { manifest } = await readManifest(backupPath);

      backups.push({
        backupPath,
        createdAt: manifest.createdAt,
        ageHours: ageHours(nowMs, manifest.createdAt)
      });
    } catch (error) {
      skipped.push({
        backupPath,
        reason: error instanceof Error ? error.message : "Unable to read backup manifest."
      });
    }
  }

  const newestFirst = [...backups].sort((left, right) => {
    const byCreatedAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);

    return byCreatedAt === 0 ? left.backupPath.localeCompare(right.backupPath) : byCreatedAt;
  });
  const retainedMinimum = new Set(newestFirst.slice(0, minimumBackups).map((backup) => backup.backupPath));
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const candidates = newestFirst.filter((backup) => {
    if (retainedMinimum.has(backup.backupPath)) {
      return false;
    }

    return Date.parse(backup.createdAt) < cutoffMs;
  });
  const deleted: BackupPruneEntry[] = [];

  if (!dryRun) {
    for (const candidate of candidates) {
      assertChildPath(backupRoot, candidate.backupPath, "Backup prune candidate");
      await rm(candidate.backupPath, { recursive: true, force: false });
      deleted.push(candidate);
    }
  }

  const candidatePaths = new Set(candidates.map((backup) => backup.backupPath));
  const retained = newestFirst.filter((backup) => dryRun || !candidatePaths.has(backup.backupPath));

  return {
    status: dryRun ? "planned" : "pruned",
    backupRoot,
    checkedAt: checkedAt.toISOString(),
    retentionDays,
    minimumBackups,
    dryRun,
    evaluatedBackups: backups.length,
    retained,
    candidates,
    deleted,
    skipped
  };
}

export function formatBackupResult(result: BackupResult) {
  return [
    "SiteFlow backup created",
    `Backup:   ${result.backupPath}`,
    `Manifest: ${result.manifestPath}`,
    `Database: ${result.database.dumpFile} (${result.database.sizeBytes} bytes, sha256:${result.database.sha256})`,
    `Artifacts: ${result.artifacts.copied ? `${result.artifacts.path} (${result.artifacts.fileCount} files, sha256:${result.artifacts.treeSha256})` : "not present"}`
  ].join("\n");
}

export function formatRestoreResult(result: RestoreResult) {
  return [
    "SiteFlow restore completed",
    `Backup:   ${result.backupPath}`,
    `Database: ${result.database.dumpFile}`,
    `Artifacts: ${result.artifacts.copied ? result.artifacts.targetPath : "not present"}`
  ].join("\n");
}

export function formatRestoreDrillResult(result: RestoreDrillResult) {
  return [
    "SiteFlow restore drill completed",
    `Backup:   ${result.backupPath}`,
    `Duration: ${result.durationMs}ms`,
    `Database target: ${result.database.target} (${result.database.databaseUrl})`,
    `Database dump:   ${result.database.dumpFile}`,
    `Artifacts target: ${result.artifacts.copied ? `${result.artifacts.targetPath} (${result.artifacts.restoreMode})` : "not copied"}`,
    `Scope: ${result.note}`
  ].join("\n");
}

export function formatBackupVerifyResult(result: BackupVerifyResult) {
  return [
    "SiteFlow backup verified",
    `Backup:   ${result.backupPath}`,
    `Manifest: ${result.manifestPath}`,
    `Database: ${result.database.dumpFile} (${result.database.sizeBytes} bytes${result.database.sha256 ? `, sha256:${result.database.sha256}` : ""})`,
    `Artifacts: ${result.artifacts.present ? `${result.artifacts.path} (${result.artifacts.fileCount ?? 0} files${result.artifacts.treeSha256 ? `, sha256:${result.artifacts.treeSha256}` : ""})` : "not present"}`,
    `Scope: ${result.note}`
  ].join("\n");
}

export function formatBackupOffloadResult(result: BackupOffloadResult) {
  return [
    "SiteFlow backup offloaded",
    `Backup:   ${result.backupPath}`,
    `Target:   ${result.target.location}`,
    `Objects:  ${result.target.objectCount} files / ${result.target.totalBytes} bytes`,
    `Checksum: sha256:${result.target.treeSha256}`
  ].join("\n");
}

export function formatBackupFetchResult(result: BackupFetchResult) {
  return [
    "SiteFlow backup fetched",
    `Source:   ${result.source.location}`,
    `Backup:   ${result.backupPath}`,
    `Objects:  ${result.objectCount} files / ${result.totalBytes} bytes`,
    `Checksum: sha256:${result.treeSha256}`
  ].join("\n");
}

export function formatBackupPruneResult(result: BackupPruneResult) {
  return [
    result.dryRun ? "SiteFlow backup prune planned" : "SiteFlow backup prune completed",
    `Root:      ${result.backupRoot}`,
    `Policy:    ${result.retentionDays} days, minimum ${result.minimumBackups} backups`,
    `Candidates: ${result.candidates.length}`,
    `Deleted:    ${result.deleted.length}`,
    `Retained:   ${result.retained.length}`,
    `Skipped:    ${result.skipped.length}`
  ].join("\n");
}
