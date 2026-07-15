#!/usr/bin/env node
import { readFile, stat, statfs } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createSiteFlowServer, type SiteFlowReadinessCheck, type SiteFlowRequestLogger, type SiteFlowRuntimeMetricsCollector, type SiteFlowTrustedProxyPolicy } from "./httpServer.js";
import { runMigrations } from "./migrations.js";
import { PostgresSiteFlowReadRepository } from "./postgresReadRepository.js";
import { assertProductionSecretStrength, isProductionRuntime, requireProductionSecret, resolveSecretEnvValue } from "../src/lib/sealedSecrets.js";
import { defaultPrebuiltMaxUploadBytes, defaultPrebuiltMaxUploadFiles } from "../src/lib/api/deployContracts.js";

const requestLogEvent = "siteflow.request";
const requestLogService = "siteflow-control-plane";

export function createStdoutRequestLogger(version: string): SiteFlowRequestLogger {
  return (entry) => {
    console.log(JSON.stringify({
      event: requestLogEvent,
      service: requestLogService,
      version,
      requestId: entry.requestId,
      method: entry.method,
      path: entry.path,
      status: entry.status,
      durationMs: entry.durationMs,
      errorClass: entry.errorClass ?? null
    }));
  };
}

export function createDefaultRequestLogger(version: string, env: NodeJS.ProcessEnv = process.env) {
  return isProductionRuntime(env) ? createStdoutRequestLogger(version) : undefined;
}

function isEnabledFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function defaultAllowSameProcessFunctionRuntime(env: NodeJS.ProcessEnv = process.env) {
  return isEnabledFlag(env.SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME);
}

export function requireProductionMetricsToken(env: NodeJS.ProcessEnv = process.env) {
  if (!isProductionRuntime(env)) {
    return;
  }

  const metricsToken = resolveSecretEnvValue("SITEFLOW_METRICS_TOKEN", env);

  if (metricsToken) {
    assertProductionSecretStrength(metricsToken, "SITEFLOW_METRICS_TOKEN");
    return;
  }

  if (isEnabledFlag(env.SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS)) {
    return;
  }

  throw new Error(
    "SITEFLOW_METRICS_TOKEN is required when NODE_ENV=production or SITEFLOW_ENV=production. " +
    "Set SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1 only when a private scrape path or proxy allowlist is documented."
  );
}

export function requireProductionApiToken(env: NodeJS.ProcessEnv = process.env) {
  if (!isProductionRuntime(env)) {
    return;
  }

  const apiToken = resolveSecretEnvValue("SITEFLOW_API_TOKEN", env);

  if (!apiToken) {
    throw new Error("SITEFLOW_API_TOKEN is required when NODE_ENV=production or SITEFLOW_ENV=production.");
  }

  assertProductionSecretStrength(apiToken, "SITEFLOW_API_TOKEN");
}

export function requireProductionGitWebhookSecrets(env: NodeJS.ProcessEnv = process.env) {
  if (!isProductionRuntime(env)) {
    return;
  }

  for (const key of [
    "SITEFLOW_GITHUB_WEBHOOK_SECRET",
    "SITEFLOW_GITLAB_WEBHOOK_SECRET",
    "SITEFLOW_GITEA_WEBHOOK_SECRET",
    "SITEFLOW_GENERIC_WEBHOOK_SECRET"
  ]) {
    const secret = resolveSecretEnvValue(key, env);

    if (secret) {
      assertProductionSecretStrength(secret, key);
    }
  }
}

export function requireProductionReleaseEvidenceSigningKey(env: NodeJS.ProcessEnv = process.env) {
  if (!isProductionRuntime(env)) {
    return;
  }

  const signingKey = resolveSecretEnvValue("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY", env);

  if (!signingKey) {
    throw new Error("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY is required when NODE_ENV=production or SITEFLOW_ENV=production.");
  }

  assertProductionSecretStrength(signingKey, "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY");
}

export function defaultReleaseEvidenceRequiredAttestationKeyId(env: NodeJS.ProcessEnv = process.env) {
  return stringValue(env.SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID) ??
    stringValue(env.SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_ID);
}

export function createProductionReadinessCheck(pool: Pool, artifactRoot: string): SiteFlowReadinessCheck {
  return async () => {
    let ready = true;
    const details: Record<string, "ok" | "unavailable"> = {};

    try {
      await pool.query("SELECT 1");
      details.database = "ok";
    } catch {
      details.database = "unavailable";
      ready = false;
    }

    try {
      const artifactRootStat = await stat(artifactRoot);
      details.artifactRoot = artifactRootStat.isDirectory() ? "ok" : "unavailable";
      ready &&= artifactRootStat.isDirectory();
    } catch {
      details.artifactRoot = "unavailable";
      ready = false;
    }

    return {
      status: ready ? "ready" : "not_ready",
      details
    };
  };
}

interface ProductionMetricsRow {
  queued_build_jobs: number | string | null;
  running_build_jobs: number | string | null;
  stale_build_jobs: number | string | null;
  oldest_queued_age_seconds: number | string | null;
  oldest_running_heartbeat_age_seconds: number | string | null;
}

export interface ProductionMetricsCollectorOptions {
  backupAutomationRunRecordPath?: string;
  artifactRoot?: string;
  evidenceRoot?: string;
  tempRoot?: string;
  now?: () => Date;
}

function metricValue(value: number | string | null | undefined) {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);

  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
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

function ageSeconds(timestamp: string | undefined, now: Date) {
  if (!timestamp) {
    return undefined;
  }

  const age = (now.getTime() - Date.parse(timestamp)) / 1000;

  return Number.isFinite(age) && age >= 0 ? Math.floor(age) : undefined;
}

function nestedObject(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];

  return isObject(candidate) ? candidate : undefined;
}

function hasCompletedStep(record: Record<string, unknown>, stepId: string) {
  const steps = record.steps;

  return Array.isArray(steps) &&
    steps.some((step) => isObject(step) && step.id === stepId && step.status === "completed");
}

function hasFailedStep(record: Record<string, unknown>, stepId: string) {
  const steps = record.steps;

  return Array.isArray(steps) &&
    steps.some((step) => isObject(step) && step.id === stepId && step.status === "failed");
}

async function readTimestampFromEvidenceFile(filePath: unknown, timestampKeys: string[], baseDir?: string) {
  const normalizedPath = stringValue(filePath);

  if (!normalizedPath) {
    return undefined;
  }

  const resolvedPath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.resolve(baseDir ?? process.cwd(), normalizedPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    return undefined;
  }

  for (const key of timestampKeys) {
    const timestamp = timestampValue(parsed[key]);

    if (timestamp) {
      return timestamp;
    }
  }

  return undefined;
}

async function collectBackupAutomationMetrics(
  recordPath: string | undefined,
  now: Date
): Promise<Awaited<ReturnType<SiteFlowRuntimeMetricsCollector>>> {
  const missing = {
    backupAutomationLastSuccessAgeSeconds: -1,
    backupRestoreDrillLastSuccessAgeSeconds: -1,
    backupOffloadLastSuccessAgeSeconds: -1,
    backupPruneLastSuccessAgeSeconds: -1,
    backupOffloadLastRunFailed: 0,
    backupPruneLastRunFailed: 0,
    backupMetricsCollectionError: 1
  };

  if (!recordPath) {
    return missing;
  }

  try {
    const resolvedRecordPath = path.resolve(recordPath);
    const record = JSON.parse(await readFile(resolvedRecordPath, "utf8")) as unknown;

    if (!isObject(record) || record.name !== "siteflow-backup-automation-run") {
      return missing;
    }

    const evidenceBaseDir = path.dirname(resolvedRecordPath);
    const evidenceFiles = nestedObject(record, "evidenceFiles");
    const completed = record.status === "completed" && record.exitCode === 0;
    const restoreDrillTimestamp = await readTimestampFromEvidenceFile(evidenceFiles?.restoreDrill, [
      "completedAt",
      "drilledAt",
      "timestamp",
      "createdAt"
    ], evidenceBaseDir);
    const offloadTimestamp = await readTimestampFromEvidenceFile(evidenceFiles?.backupOffload, [
      "offloadedAt",
      "completedAt",
      "timestamp",
      "createdAt"
    ], evidenceBaseDir);
    const pruneTimestamp = await readTimestampFromEvidenceFile(evidenceFiles?.backupPrune, [
      "checkedAt",
      "prunedAt",
      "completedAt",
      "timestamp",
      "createdAt"
    ], evidenceBaseDir);

    const failed = statusValue(record.status) === "failed";

    return {
      backupAutomationLastSuccessAgeSeconds: completed ? ageSeconds(timestampValue(record.completedAt), now) ?? -1 : -1,
      backupRestoreDrillLastSuccessAgeSeconds: ageSeconds(restoreDrillTimestamp, now) ?? -1,
      backupOffloadLastSuccessAgeSeconds: ageSeconds(offloadTimestamp, now) ?? -1,
      backupPruneLastSuccessAgeSeconds: ageSeconds(pruneTimestamp, now) ?? -1,
      backupOffloadLastRunFailed: failed && (
        hasFailedStep(record, "backup_offload") ||
        hasCompletedStep(record, "restore_drill") && !hasCompletedStep(record, "backup_offload")
      )
        ? 1
        : 0,
      backupPruneLastRunFailed: failed && (
        hasFailedStep(record, "backup_prune") ||
        hasCompletedStep(record, "backup_prune_plan") && hasCompletedStep(record, "backup_offload") && !hasCompletedStep(record, "backup_prune")
      )
        ? 1
        : 0,
      backupMetricsCollectionError: completed && restoreDrillTimestamp && offloadTimestamp && pruneTimestamp ? 0 : 1
    };
  } catch {
    return missing;
  }
}

function storageMetricPath(value: string | undefined) {
  const normalized = stringValue(value);

  return normalized ? path.resolve(normalized) : undefined;
}

function statfsAvailableBytes(stats: Awaited<ReturnType<typeof statfs>>) {
  return Number(stats.bavail) * Number(stats.bsize);
}

async function collectStorageFreeBytes(storagePath: string | undefined) {
  if (!storagePath) {
    return {
      freeBytes: -1,
      missing: 0,
      error: 0
    };
  }

  try {
    const stats = await statfs(storagePath);
    const freeBytes = statfsAvailableBytes(stats);

    return Number.isFinite(freeBytes) && freeBytes >= 0
      ? { freeBytes, missing: 0, error: 0 }
      : { freeBytes: -1, missing: 1, error: 1 };
  } catch {
    return {
      freeBytes: -1,
      missing: 1,
      error: 1
    };
  }
}

async function collectStorageMetrics(options: ProductionMetricsCollectorOptions) {
  const [artifact, evidence, temp] = await Promise.all([
    collectStorageFreeBytes(storageMetricPath(options.artifactRoot)),
    collectStorageFreeBytes(storageMetricPath(options.evidenceRoot)),
    collectStorageFreeBytes(storageMetricPath(options.tempRoot ?? os.tmpdir()))
  ]);

  return {
    storageArtifactFreeBytes: artifact.freeBytes,
    storageEvidenceFreeBytes: evidence.freeBytes,
    storageTempFreeBytes: temp.freeBytes,
    storageMissingPaths: artifact.missing + evidence.missing + temp.missing,
    storageMetricsCollectionError: artifact.error || evidence.error || temp.error ? 1 : 0
  };
}

export function createProductionMetricsCollector(
  pool: Pick<Pool, "query">,
  options: ProductionMetricsCollectorOptions = {}
): SiteFlowRuntimeMetricsCollector {
  return async () => {
    const result = await pool.query<ProductionMetricsRow>(`
      SELECT
        count(*) FILTER (WHERE status = 'queued')::int AS queued_build_jobs,
        count(*) FILTER (WHERE status = 'running')::int AS running_build_jobs,
        count(*) FILTER (
          WHERE status = 'running'
            AND (locked_until IS NULL OR locked_until <= now())
        )::int AS stale_build_jobs,
        COALESCE(EXTRACT(EPOCH FROM (now() - min(queued_at) FILTER (WHERE status = 'queued'))), 0)::float8 AS oldest_queued_age_seconds,
        COALESCE(EXTRACT(EPOCH FROM (now() - min(heartbeat_at) FILTER (WHERE status = 'running' AND heartbeat_at IS NOT NULL))), 0)::float8 AS oldest_running_heartbeat_age_seconds
      FROM siteflow_build_jobs
    `);
    const row = result.rows[0];
    const backupMetrics = await collectBackupAutomationMetrics(options.backupAutomationRunRecordPath, options.now?.() ?? new Date());
    const storageMetrics = await collectStorageMetrics(options);

    return {
      queuedBuildJobs: metricValue(row?.queued_build_jobs),
      runningBuildJobs: metricValue(row?.running_build_jobs),
      staleBuildJobs: metricValue(row?.stale_build_jobs),
      oldestQueuedBuildAgeSeconds: metricValue(row?.oldest_queued_age_seconds),
      oldestRunningBuildHeartbeatAgeSeconds: metricValue(row?.oldest_running_heartbeat_age_seconds),
      ...storageMetrics,
      ...backupMetrics
    };
  };
}

export function defaultSecureCookies(env: NodeJS.ProcessEnv = process.env) {
  return isProductionRuntime(env);
}

function validateTrustedProxyEntry(entry: string) {
  const [address, prefix] = entry.split("/");
  const family = address ? isIP(address) : 0;

  if (family === 0) {
    throw new Error("SITEFLOW_TRUST_PROXY must be loopback, private, or a comma-separated list of IP/CIDR entries.");
  }

  if (prefix === undefined) {
    return;
  }

  const prefixLength = Number(prefix);
  const maxPrefix = family === 4 ? 32 : 128;

  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxPrefix) {
    throw new Error("SITEFLOW_TRUST_PROXY CIDR prefixes must match the IP family.");
  }

  if (prefixLength === 0) {
    throw new Error("SITEFLOW_TRUST_PROXY must not trust all source addresses.");
  }
}

export function defaultTrustProxy(env: NodeJS.ProcessEnv = process.env): SiteFlowTrustedProxyPolicy | undefined {
  const configured = env.SITEFLOW_TRUST_PROXY?.trim();

  if (!configured || !isEnabledFlag(configured) && ["0", "false", "no", "off"].includes(configured.toLowerCase())) {
    return undefined;
  }

  const normalized = configured.toLowerCase();

  if (isEnabledFlag(configured)) {
    return "loopback";
  }

  if (normalized === "loopback" || normalized === "private") {
    return normalized;
  }

  const entries = configured.split(",").map((entry) => entry.trim()).filter(Boolean);

  if (entries.length === 0) {
    return undefined;
  }

  entries.forEach(validateTrustedProxyEntry);

  return entries;
}

export function defaultOperatorSessionIdleTimeoutSeconds(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS?.trim();

  if (!configured) {
    return 1800;
  }

  const idleTimeoutSeconds = Number(configured);

  if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 60 || idleTimeoutSeconds > 86_400) {
    throw new Error("SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS must be an integer from 60 to 86400.");
  }

  return idleTimeoutSeconds;
}

function positiveIntegerEnv(value: string | undefined, fallback: number, name: string) {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function defaultPrebuiltUploadBudget(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxUploadBytes: positiveIntegerEnv(
      env.SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES,
      defaultPrebuiltMaxUploadBytes,
      "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES"
    ),
    maxFiles: positiveIntegerEnv(
      env.SITEFLOW_PREBUILT_MAX_FILES,
      defaultPrebuiltMaxUploadFiles,
      "SITEFLOW_PREBUILT_MAX_FILES"
    )
  };
}

export function gitWebhookSecretsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    github: resolveSecretEnvValue("SITEFLOW_GITHUB_WEBHOOK_SECRET", env),
    gitlab: resolveSecretEnvValue("SITEFLOW_GITLAB_WEBHOOK_SECRET", env),
    gitea: resolveSecretEnvValue("SITEFLOW_GITEA_WEBHOOK_SECRET", env),
    generic: resolveSecretEnvValue("SITEFLOW_GENERIC_WEBHOOK_SECRET", env)
  };
}

/**
 * Estate RBAC convention: the global admin groups (admins/infra-admins) always
 * hold admin scope; the product-domain operations group is configurable via
 * SITEFLOW_ADMIN_GROUP (Steadholme default: deploy-admins).
 */
export function defaultGatewayAdminGroups(env: NodeJS.ProcessEnv = process.env) {
  const productGroup = env.SITEFLOW_ADMIN_GROUP?.trim() || "deploy-admins";
  return [...new Set(["admins", "infra-admins", productGroup])];
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl) {
    return undefined;
  }

  const postgresPassword = resolveSecretEnvValue("SITEFLOW_POSTGRES_PASSWORD", env);

  if (!postgresPassword) {
    return databaseUrl;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid postgres URL when SITEFLOW_POSTGRES_PASSWORD or SITEFLOW_POSTGRES_PASSWORD_FILE is configured.");
  }

  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol when SITEFLOW_POSTGRES_PASSWORD or SITEFLOW_POSTGRES_PASSWORD_FILE is configured.");
  }

  if (parsedUrl.password) {
    return databaseUrl;
  }

  parsedUrl.password = postgresPassword;

  return parsedUrl.toString();
}

export async function main() {
  const databaseUrl = resolveDatabaseUrl();
  const port = Number(process.env.SITEFLOW_API_PORT ?? process.env.PORT ?? 8787);
  const version = process.env.SITEFLOW_VERSION ?? "0.1.0";
  const artifactRoot = process.env.SITEFLOW_ARTIFACT_ROOT ?? "/var/lib/siteflow/artifacts";
  const evidenceRoot = process.env.SITEFLOW_EVIDENCE_ROOT ?? "/var/lib/siteflow/evidence";
  const publicScheme = process.env.SITEFLOW_PUBLIC_SCHEME === "http" ? "http" : "https";
  const apiToken = resolveSecretEnvValue("SITEFLOW_API_TOKEN");
  const metricsToken = resolveSecretEnvValue("SITEFLOW_METRICS_TOKEN");
  const releaseEvidenceAttestationSigningKey = resolveSecretEnvValue("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY");
  const releaseEvidenceRequiredAttestationKeyId = defaultReleaseEvidenceRequiredAttestationKeyId();
  const baseDomain = process.env.SITEFLOW_BASE_DOMAIN;
  const gitWebhookSecrets = gitWebhookSecretsFromEnv();
  const prebuiltUploadBudget = defaultPrebuiltUploadBudget();
  // Steadholme gateway integration (all optional; absent = stock SiteFlow).
  const gatewayHmacKey = resolveSecretEnvValue("GATEWAY_HMAC_KEY");
  const gatewayAdminGroups = defaultGatewayAdminGroups();
  const consoleHost = process.env.SITEFLOW_CONSOLE_HOST?.trim() || undefined;
  const consoleDistDir = process.env.SITEFLOW_CONSOLE_DIST?.trim()
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
  const loomCloneBaseUrl = process.env.SITEFLOW_LOOM_CLONE_BASE_URL?.trim() || undefined;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the SiteFlow control-plane API.");
  }

  if (isProductionRuntime()) {
    requireProductionSecret();
    requireProductionMetricsToken();
    requireProductionApiToken();
    requireProductionGitWebhookSecrets();
    requireProductionReleaseEvidenceSigningKey();
  }

  const pool = new Pool({ connectionString: databaseUrl });

  await runMigrations(pool);

  const server = createSiteFlowServer({
    repository: new PostgresSiteFlowReadRepository(pool, {
      artifactRoot,
      publicScheme,
      baseDomain,
      operatorSessionIdleTimeoutSeconds: defaultOperatorSessionIdleTimeoutSeconds(),
      prebuiltMaxUploadBytes: prebuiltUploadBudget.maxUploadBytes,
      prebuiltMaxFiles: prebuiltUploadBudget.maxFiles
    }),
    version,
    allowedOrigin: process.env.SITEFLOW_ALLOWED_ORIGIN,
    apiToken,
    metricsToken,
    baseDomain,
    githubWebhookSecret: gitWebhookSecrets.github,
    gitWebhookSecrets,
    requestLogger: createDefaultRequestLogger(version),
    readinessCheck: createProductionReadinessCheck(pool, artifactRoot),
    runtimeMetricsCollector: createProductionMetricsCollector(pool, {
      backupAutomationRunRecordPath: process.env.SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD,
      artifactRoot,
      evidenceRoot,
      tempRoot: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir()
    }),
    secureCookies: defaultSecureCookies(),
    trustProxy: defaultTrustProxy(),
    prebuiltMaxUploadBytes: prebuiltUploadBudget.maxUploadBytes,
    prebuiltMaxFiles: prebuiltUploadBudget.maxFiles,
    releaseEvidenceAttestationSigningKey,
    releaseEvidenceRequiredAttestationKeyId,
    productionRuntime: isProductionRuntime(),
    allowSameProcessFunctionRuntime: defaultAllowSameProcessFunctionRuntime(),
    gatewayHmacKey,
    gatewayAdminGroups,
    consoleHost,
    consoleDistDir,
    loomCloneBaseUrl
  });

  server.listen(port, () => {
    process.stdout.write(`SiteFlow control-plane API listening on ${port}\n`);
  });

  async function shutdown() {
    server.close();
    await pool.end();
  }

  process.on("SIGINT", () => {
    void shutdown().then(() => {
      process.exitCode = 0;
    });
  });

  process.on("SIGTERM", () => {
    void shutdown().then(() => {
      process.exitCode = 0;
    });
  });
}

function isEntrypoint() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  await main();
}
