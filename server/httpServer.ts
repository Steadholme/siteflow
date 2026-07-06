import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Actor, FunctionEntrypoint, PermissionScope, RepositoryBinding, RoutingHeader, RoutingRule, SourceEventInput, SourceProvider } from "../src/domain/siteflow.js";
import { redactLogLine, redactSecrets } from "../src/lib/redaction.js";
import { metricDefinition, renderPrometheusTypeLine } from "../src/lib/observabilityMetrics.js";
import {
  assertPrebuiltUploadBudget,
  defaultPrebuiltMaxUploadBytes,
  defaultPrebuiltMaxUploadFiles,
  type PrebuiltDeployCommand,
  type PrebuiltImageConfig,
  type PrebuiltUploadBudget
} from "../src/lib/api/deployContracts.js";
import { assertReleaseChannel, SiteFlowConflictError, SiteFlowInputError, SiteFlowNotFoundError, type ArtifactRoute, type LogDrainDeliveryPlan, type SiteFlowAuthPrincipal, type SiteFlowReadRepository } from "./readRepository.js";
import { gatewayIdentityEmail, gatewayIdentityGroups, gatewayIdentityOk, gatewayIdentitySubject } from "./gatewayIdentity.js";
import { isLoomWebhookPayload, loomPayloadToGeneric } from "./loomWebhook.js";
import { serveConsoleStatic } from "./consoleStatic.js";
import { createNodeCompat } from "./nodeCompat.js";
import {
  evaluateReleaseEvidenceBundle,
  releaseEvidenceBundleAttestationSignatureVerified,
  type ReleaseEvidenceBundleCheckOptions,
  type ReleaseEvidenceBundleResult
} from "../scripts/releaseEvidenceBundleCheck.js";

export type FunctionModuleLoader = (functionPath: string) => Promise<Record<string, unknown>>;
export type DrainFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type ReleaseEvidenceEvaluator = (
  rawEvidence: unknown,
  options: ReleaseEvidenceBundleCheckOptions
) => ReleaseEvidenceBundleResult;

export interface SiteFlowServerOptions {
  repository: SiteFlowReadRepository;
  version: string;
  allowedOrigin?: string;
  apiToken?: string;
  baseDomain?: string;
  githubWebhookSecret?: string;
  gitWebhookSecrets?: Partial<Record<SourceProvider, string>>;
  maxBodyBytes?: number;
  prebuiltMaxUploadBytes?: number;
  prebuiltMaxFiles?: number;
  rateLimit?: false | SiteFlowRateLimitOptions;
  functionModuleLoader?: FunctionModuleLoader;
  drainFetch?: DrainFetch;
  requestLogger?: SiteFlowRequestLogger;
  readinessCheck?: SiteFlowReadinessCheck;
  metricsToken?: string;
  runtimeMetricsCollector?: SiteFlowRuntimeMetricsCollector;
  secureCookies?: boolean;
  trustProxy?: SiteFlowTrustedProxyPolicy;
  releaseEvidenceEvaluator?: ReleaseEvidenceEvaluator;
  releaseEvidenceAttestationSigningKey?: string;
  releaseEvidenceRequiredAttestationKeyId?: string;
  productionRuntime?: boolean;
  allowSameProcessFunctionRuntime?: boolean;
  /**
   * HOLDFAST gateway integration (all optional; absent = stock SiteFlow):
   * - gatewayHmacKey: verifies Sluice-injected X-Auth-* identity headers via
   *   X-Auth-Sig (HMAC-SHA256, minute window; see gatewayIdentity.ts).
   * - gatewayAdminGroups: X-Auth-Groups values granted full admin scope
   *   (estate convention: admins/infra-admins + SITEFLOW_ADMIN_GROUP).
   * - consoleHost/consoleDistDir: serve the built console SPA (dist/) for
   *   non-API requests whose Host equals consoleHost.
   * - loomCloneBaseUrl: anonymous PUBLIC clone base for Loom webhook builds
   *   (e.g. https://git.w33d.xyz/git).
   */
  gatewayHmacKey?: string;
  gatewayAdminGroups?: string[];
  consoleHost?: string;
  consoleDistDir?: string;
  loomCloneBaseUrl?: string;
}

export type SiteFlowTrustedProxyPolicy = boolean | "loopback" | "private" | string[];

export interface SiteFlowRateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
  now?: () => number;
}

export interface SiteFlowRequestLogEntry {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorClass?: string;
}

export type SiteFlowRequestLogger = (entry: SiteFlowRequestLogEntry) => void | Promise<void>;

export type SiteFlowReadinessStatus = "ready" | "not_ready";
export type SiteFlowReadinessDetailValue = "ok" | "ready" | "configured" | "missing" | "degraded" | "unavailable" | "not_ready" | boolean | number | null;

export interface SiteFlowReadinessResult {
  status?: SiteFlowReadinessStatus;
  details?: Record<string, unknown>;
}

export type SiteFlowReadinessCheck = () => SiteFlowReadinessResult | void | Promise<SiteFlowReadinessResult | void>;

export interface SiteFlowRuntimeMetrics {
  queuedBuildJobs?: number;
  runningBuildJobs?: number;
  staleBuildJobs?: number;
  oldestQueuedBuildAgeSeconds?: number;
  oldestRunningBuildHeartbeatAgeSeconds?: number;
  storageArtifactFreeBytes?: number;
  storageEvidenceFreeBytes?: number;
  storageTempFreeBytes?: number;
  storageMissingPaths?: number;
  storageMetricsCollectionError?: number;
  backupAutomationLastSuccessAgeSeconds?: number;
  backupRestoreDrillLastSuccessAgeSeconds?: number;
  backupOffloadLastSuccessAgeSeconds?: number;
  backupPruneLastSuccessAgeSeconds?: number;
  backupOffloadLastRunFailed?: number;
  backupPruneLastRunFailed?: number;
  backupMetricsCollectionError?: number;
}

export type SiteFlowRuntimeMetricsCollector = () => SiteFlowRuntimeMetrics | Promise<SiteFlowRuntimeMetrics>;

interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  segments: string[];
}

interface RoutingMatch {
  redirect?: RoutingRule;
  rewrite?: RoutingRule;
  headers: RoutingRule[];
  rewrittenPath?: string;
}

interface ResolvedArtifactFile {
  filePath: string;
  resolvedPath: string;
}

const functionConcurrency = new Map<string, number>();
const requestBodyLimitBytes = new WeakMap<IncomingMessage, number>();
const defaultMaxBodyBytes = 1024 * 1024;
const defaultApiRateLimitMaxRequests = 120;
const defaultApiRateLimitWindowMs = 60_000;
const accessControlAllowHeaders = [
  "content-type",
  "accept",
  "authorization",
  "range",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
  "x-siteflow-csrf"
].join(", ");
const accessControlAllowMethods = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const accessControlMaxAge = "86400";
const accessControlExposeHeaders = [
  "etag",
  "last-modified",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "location",
  "retry-after",
  "allow",
  "x-siteflow-deployment",
  "x-siteflow-function",
  "x-siteflow-request-id",
  "x-siteflow-rollout",
  "x-siteflow-traffic-target",
  "x-siteflow-firewall",
  "x-siteflow-redirect",
  "x-siteflow-rewrite",
  "x-siteflow-static-redirect",
  "x-siteflow-image-cache-key",
  "x-siteflow-image-width",
  "x-siteflow-image-quality",
  "x-siteflow-image-format",
  "x-siteflow-image-source"
].join(", ");
const operatorSessionCookieName = "siteflow_session";
const operatorSessionCsrfHeaderName = "x-siteflow-csrf";
const operatorSessionCsrfHeaderValue = "same-origin";
const supportedGitWebhookProviders = new Set<SourceProvider>(["github", "gitlab", "gitea", "generic"]);
const allPermissionScopes: PermissionScope[] = ["read", "write", "admin"];
const rootApiTokenActor: Actor = {
  id: "siteflow:server",
  name: "SiteFlow server",
  role: "system"
};

function setCorsHeaders(response: ServerResponse, allowedOrigin: string, options?: { preflight?: boolean }) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-headers", mergeCommaHeader(response.getHeader("access-control-allow-headers"), accessControlAllowHeaders));
  response.setHeader("access-control-allow-methods", mergeCommaHeader(response.getHeader("access-control-allow-methods"), accessControlAllowMethods));
  response.setHeader("access-control-expose-headers", mergeCommaHeader(response.getHeader("access-control-expose-headers"), accessControlExposeHeaders));
  response.setHeader("vary", mergeVaryHeader(response.getHeader("vary"), "Origin"));

  if (options?.preflight) {
    response.setHeader("access-control-max-age", accessControlMaxAge);
  }
}

class ImageOptimizationInputError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ImageOptimizationInputError";
  }
}

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super("Request body is too large.");
    this.name = "RequestBodyTooLargeError";
  }
}

class PrebuiltUploadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrebuiltUploadTooLargeError";
  }
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface ResolvedRateLimitOptions {
  maxRequests: number;
  windowMs: number;
  now: () => number;
}

interface SiteFlowHttpMetrics {
  requestTotal: number;
  error5xxTotal: number;
  rateLimitedTotal: number;
  durationMsSum: number;
  durationMsCount: number;
}

const allowedReadinessDetailValues = new Set([
  "ok",
  "ready",
  "configured",
  "missing",
  "degraded",
  "unavailable",
  "not_ready"
]);

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;

async function loadFunctionModule(functionPath: string) {
  return nativeImport(pathToFileURL(functionPath).href);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, allowedOrigin?: string, method?: string) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (allowedOrigin) {
    setCorsHeaders(response, allowedOrigin);
  }

  if (method === "HEAD") {
    response.removeHeader("content-length");
    response.end();
    return;
  }

  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, statusCode: number, body: string, allowedOrigin?: string, method?: string) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");

  if (allowedOrigin) {
    setCorsHeaders(response, allowedOrigin);
  }

  if (method === "HEAD") {
    response.removeHeader("content-length");
    response.end();
    return;
  }

  response.end(body);
}

function createHttpMetrics(): SiteFlowHttpMetrics {
  return {
    requestTotal: 0,
    error5xxTotal: 0,
    rateLimitedTotal: 0,
    durationMsSum: 0,
    durationMsCount: 0
  };
}

function recordHttpMetrics(metrics: SiteFlowHttpMetrics, response: ServerResponse, startedAt: number) {
  const statusCode = response.statusCode || 500;
  const durationMs = Math.max(0, Date.now() - startedAt);

  metrics.requestTotal += 1;
  metrics.durationMsSum += durationMs;
  metrics.durationMsCount += 1;

  if (statusCode >= 500) {
    metrics.error5xxTotal += 1;
  }

  if (statusCode === 429) {
    metrics.rateLimitedTotal += 1;
  }
}

function metricNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function metricAgeSeconds(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : -1;
}

function metricBytes(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : -1;
}

function metricFlag(value: number | boolean | undefined) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value === 1 ? 1 : 0;
}

function hasBackupMetricValues(metrics: SiteFlowRuntimeMetrics) {
  return [
    metrics.backupAutomationLastSuccessAgeSeconds,
    metrics.backupRestoreDrillLastSuccessAgeSeconds,
    metrics.backupOffloadLastSuccessAgeSeconds,
    metrics.backupPruneLastSuccessAgeSeconds,
    metrics.backupOffloadLastRunFailed,
    metrics.backupPruneLastRunFailed,
    metrics.backupMetricsCollectionError
  ].some((value) => value !== undefined);
}

function prometheusTypeLine(name: string) {
  const definition = metricDefinition(name);

  if (!definition) {
    throw new Error(`Unknown SiteFlow metric: ${name}`);
  }

  return renderPrometheusTypeLine(definition);
}

function renderRuntimeMetrics(metrics: SiteFlowRuntimeMetrics, collectionError: boolean) {
  const backupCollectionError = collectionError || !hasBackupMetricValues(metrics)
    ? 1
    : metricFlag(metrics.backupMetricsCollectionError);

  return [
    prometheusTypeLine("siteflow_build_jobs_queued"),
    `siteflow_build_jobs_queued ${metricNumber(metrics.queuedBuildJobs)}`,
    prometheusTypeLine("siteflow_build_jobs_running"),
    `siteflow_build_jobs_running ${metricNumber(metrics.runningBuildJobs)}`,
    prometheusTypeLine("siteflow_build_jobs_stale"),
    `siteflow_build_jobs_stale ${metricNumber(metrics.staleBuildJobs)}`,
    prometheusTypeLine("siteflow_build_job_oldest_queued_age_seconds"),
    `siteflow_build_job_oldest_queued_age_seconds ${metricNumber(metrics.oldestQueuedBuildAgeSeconds)}`,
    prometheusTypeLine("siteflow_build_job_oldest_running_heartbeat_age_seconds"),
    `siteflow_build_job_oldest_running_heartbeat_age_seconds ${metricNumber(metrics.oldestRunningBuildHeartbeatAgeSeconds)}`,
    prometheusTypeLine("siteflow_runtime_metrics_collection_error"),
    `siteflow_runtime_metrics_collection_error ${collectionError ? 1 : 0}`,
    prometheusTypeLine("siteflow_storage_artifact_free_bytes"),
    `siteflow_storage_artifact_free_bytes ${metricBytes(metrics.storageArtifactFreeBytes)}`,
    prometheusTypeLine("siteflow_storage_evidence_free_bytes"),
    `siteflow_storage_evidence_free_bytes ${metricBytes(metrics.storageEvidenceFreeBytes)}`,
    prometheusTypeLine("siteflow_storage_temp_free_bytes"),
    `siteflow_storage_temp_free_bytes ${metricBytes(metrics.storageTempFreeBytes)}`,
    prometheusTypeLine("siteflow_storage_missing_paths"),
    `siteflow_storage_missing_paths ${metricNumber(metrics.storageMissingPaths)}`,
    prometheusTypeLine("siteflow_storage_metrics_collection_error"),
    `siteflow_storage_metrics_collection_error ${collectionError ? 1 : metricFlag(metrics.storageMetricsCollectionError)}`,
    prometheusTypeLine("siteflow_backup_automation_last_success_age_seconds"),
    `siteflow_backup_automation_last_success_age_seconds ${metricAgeSeconds(metrics.backupAutomationLastSuccessAgeSeconds)}`,
    prometheusTypeLine("siteflow_backup_restore_drill_last_success_age_seconds"),
    `siteflow_backup_restore_drill_last_success_age_seconds ${metricAgeSeconds(metrics.backupRestoreDrillLastSuccessAgeSeconds)}`,
    prometheusTypeLine("siteflow_backup_offload_last_success_age_seconds"),
    `siteflow_backup_offload_last_success_age_seconds ${metricAgeSeconds(metrics.backupOffloadLastSuccessAgeSeconds)}`,
    prometheusTypeLine("siteflow_backup_prune_last_success_age_seconds"),
    `siteflow_backup_prune_last_success_age_seconds ${metricAgeSeconds(metrics.backupPruneLastSuccessAgeSeconds)}`,
    prometheusTypeLine("siteflow_backup_offload_last_run_failed"),
    `siteflow_backup_offload_last_run_failed ${metricFlag(metrics.backupOffloadLastRunFailed)}`,
    prometheusTypeLine("siteflow_backup_prune_last_run_failed"),
    `siteflow_backup_prune_last_run_failed ${metricFlag(metrics.backupPruneLastRunFailed)}`,
    prometheusTypeLine("siteflow_backup_metrics_collection_error"),
    `siteflow_backup_metrics_collection_error ${backupCollectionError}`
  ];
}

async function renderHttpMetrics(metrics: SiteFlowHttpMetrics, runtimeMetricsCollector?: SiteFlowRuntimeMetricsCollector) {
  let runtimeMetricLines = renderRuntimeMetrics({}, true);

  if (runtimeMetricsCollector) {
    try {
      runtimeMetricLines = renderRuntimeMetrics(await runtimeMetricsCollector(), false);
    } catch {
      runtimeMetricLines = renderRuntimeMetrics({}, true);
    }
  }

  return [
    prometheusTypeLine("siteflow_http_requests_total"),
    `siteflow_http_requests_total ${metrics.requestTotal}`,
    prometheusTypeLine("siteflow_http_5xx_total"),
    `siteflow_http_5xx_total ${metrics.error5xxTotal}`,
    prometheusTypeLine("siteflow_http_429_total"),
    `siteflow_http_429_total ${metrics.rateLimitedTotal}`,
    prometheusTypeLine("siteflow_http_request_duration_ms_sum"),
    `siteflow_http_request_duration_ms_sum ${metrics.durationMsSum}`,
    prometheusTypeLine("siteflow_http_request_duration_ms_count"),
    `siteflow_http_request_duration_ms_count ${metrics.durationMsCount}`,
    ...runtimeMetricLines,
    ""
  ].join("\n");
}

function destroyRequestAfterResponse(request: IncomingMessage, response: ServerResponse) {
  if (request.destroyed) {
    return;
  }

  if (response.writableEnded) {
    request.destroy();
    return;
  }

  response.once("finish", () => {
    if (!request.destroyed) {
      request.destroy();
    }
  });
}

function nonNegativeInteger(value: number | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }

  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function maxBodyBytes(options: SiteFlowServerOptions) {
  return nonNegativeInteger(options.maxBodyBytes, defaultMaxBodyBytes);
}

function prebuiltUploadBudget(options: SiteFlowServerOptions): Required<PrebuiltUploadBudget> {
  return {
    maxUploadBytes: positiveInteger(options.prebuiltMaxUploadBytes, defaultPrebuiltMaxUploadBytes),
    maxFiles: positiveInteger(options.prebuiltMaxFiles, defaultPrebuiltMaxUploadFiles)
  };
}

function prebuiltRequestBodyLimitBytes(options: SiteFlowServerOptions) {
  const budget = prebuiltUploadBudget(options);
  const base64Bytes = Math.ceil(budget.maxUploadBytes * 4 / 3);
  const metadataBytes = budget.maxFiles * 512;

  return Math.max(maxBodyBytes(options), base64Bytes + metadataBytes + defaultMaxBodyBytes);
}

function assertPrebuiltUploadWithinBudget(command: PrebuiltDeployCommand, options: SiteFlowServerOptions) {
  if (!Array.isArray(command.files)) {
    throw new SyntaxError("Prebuilt deploy requires a files array.");
  }

  try {
    assertPrebuiltUploadBudget(command.files, prebuiltUploadBudget(options), "Prebuilt deploy upload");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prebuilt deploy upload failed budget validation.";

    if (message.includes("SITEFLOW_PREBUILT_MAX_")) {
      throw new PrebuiltUploadTooLargeError(message);
    }

    throw new SyntaxError(message);
  }
}

function rateLimitOptions(options: SiteFlowServerOptions): ResolvedRateLimitOptions | undefined {
  if (options.rateLimit === false) {
    return undefined;
  }

  return {
    maxRequests: positiveInteger(options.rateLimit?.maxRequests, defaultApiRateLimitMaxRequests),
    windowMs: positiveInteger(options.rateLimit?.windowMs, defaultApiRateLimitWindowMs),
    now: options.rateLimit?.now ?? Date.now
  };
}

async function readRawBody(request: IncomingMessage, maxBytes = requestBodyLimitBytes.get(request) ?? defaultMaxBodyBytes) {
  const declaredLength = optionalNumber(headerValue(request, "content-length"));

  if (declaredLength !== undefined && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage) {
  const raw = (await readRawBody(request)).toString("utf8");

  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw) as unknown;
}

function optionalNumber(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredIntegerParam(url: URL, name: string, min: number, max: number) {
  const value = url.searchParams.get(name);
  const parsed = value ? Number(value) : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ImageOptimizationInputError(`Image parameter ${name} must be an integer from ${min} to ${max}.`);
  }

  return parsed;
}

function optionalIntegerParam(url: URL, name: string, fallback: number, min: number, max: number) {
  const value = url.searchParams.get(name);

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ImageOptimizationInputError(`Image parameter ${name} must be an integer from ${min} to ${max}.`);
  }

  return parsed;
}

function logQueryFromUrl(projectId: string, url: URL) {
  return {
    projectId,
    source: url.searchParams.get("source") ?? undefined,
    severity: url.searchParams.get("severity") ?? undefined,
    deploymentId: url.searchParams.get("deploymentId") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    limit: optionalNumber(url.searchParams.get("limit")),
    cursor: url.searchParams.get("cursor") ?? undefined
  };
}

function notFound(response: ServerResponse, allowedOrigin?: string, method?: string) {
  sendJson(response, 404, { message: "SiteFlow API route not found." }, allowedOrigin, method);
}

function bearerToken(request: IncomingMessage) {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }

  return header.slice("Bearer ".length).trim();
}

function secretEquals(actual: string, expected: string) {
  const actualBuffer = createHash("sha256").update(actual, "utf8").digest();
  const expectedBuffer = createHash("sha256").update(expected, "utf8").digest();

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function headerValue(request: IncomingMessage, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function headerValues(request: IncomingMessage, name: string) {
  const normalized = name.toLowerCase();
  const values: string[] = [];

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === normalized && request.rawHeaders[index + 1]) {
      values.push(request.rawHeaders[index + 1]);
    }
  }

  if (values.length > 0) {
    return values;
  }

  const value = request.headers[normalized];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function firstHeaderToken(value: string | undefined) {
  return value?.split(",")[0]?.trim();
}

function normalizedRemoteAddress(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const address = value.trim().toLowerCase();
  const ipv4Mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);

  if (ipv4Mapped?.[1] && isIP(ipv4Mapped[1]) === 4) {
    return ipv4Mapped[1];
  }

  return isIP(address) ? address : undefined;
}

function isLoopbackAddress(address: string | undefined) {
  const normalized = normalizedRemoteAddress(address);

  if (!normalized) {
    return false;
  }

  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }

  return normalized === "::1";
}

function isPrivateAddress(address: string | undefined) {
  const normalized = normalizedRemoteAddress(address);

  if (!normalized) {
    return false;
  }

  if (isLoopbackAddress(normalized)) {
    return true;
  }

  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map((entry) => Number(entry));
    const [first, second] = octets;

    return first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254);
  }

  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function trustedProxyBlockList(entries: string[]) {
  const blockList = new BlockList();

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();

    if (!entry) {
      continue;
    }

    const [address, prefix] = entry.split("/");
    const normalized = normalizedRemoteAddress(address);
    const family = normalized ? isIP(normalized) : 0;

    if (!normalized || family === 0) {
      return undefined;
    }

    const type = family === 4 ? "ipv4" : "ipv6";

    if (prefix === undefined) {
      blockList.addAddress(normalized, type);
      continue;
    }

    const prefixLength = Number(prefix);
    const maxPrefix = family === 4 ? 32 : 128;

    if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxPrefix) {
      return undefined;
    }

    blockList.addSubnet(normalized, prefixLength, type);
  }

  return blockList;
}

function isTrustedProxyRequest(request: IncomingMessage, options: SiteFlowServerOptions | undefined) {
  const policy = options?.trustProxy;

  if (policy === true) {
    return true;
  }

  if (!policy) {
    return false;
  }

  const remoteAddress = normalizedRemoteAddress(request.socket.remoteAddress);

  if (!remoteAddress) {
    return false;
  }

  if (policy === "loopback") {
    return isLoopbackAddress(remoteAddress);
  }

  if (policy === "private") {
    return isPrivateAddress(remoteAddress);
  }

  if (Array.isArray(policy)) {
    const blockList = trustedProxyBlockList(policy);
    const family = isIP(remoteAddress);

    return Boolean(blockList?.check(remoteAddress, family === 4 ? "ipv4" : "ipv6"));
  }

  return false;
}

function trustedForwardedHeaderToken(request: IncomingMessage, options: SiteFlowServerOptions | undefined, name: string) {
  return isTrustedProxyRequest(request, options) ? firstHeaderToken(headerValue(request, name)) : undefined;
}

function requestHost(request: IncomingMessage, options?: SiteFlowServerOptions) {
  return trustedForwardedHeaderToken(request, options, "x-forwarded-host") || request.headers.host || "";
}

function requestScheme(request: IncomingMessage, options?: SiteFlowServerOptions) {
  const forwardedProto = trustedForwardedHeaderToken(request, options, "x-forwarded-proto");

  if (forwardedProto) {
    return forwardedProto;
  }

  return (request.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
}

function requestOrigin(request: IncomingMessage, options?: SiteFlowServerOptions) {
  const host = requestHost(request, options) || "127.0.0.1";
  const proto = requestScheme(request, options);

  return `${proto}://${host}`;
}

function cookieValue(request: IncomingMessage, name: string) {
  const cookieHeader = headerValue(request, "cookie");

  if (!cookieHeader) {
    return undefined;
  }

  for (const entry of cookieHeader.split(";")) {
    const separatorIndex = entry.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function operatorSessionToken(request: IncomingMessage) {
  return cookieValue(request, operatorSessionCookieName)?.trim() || undefined;
}

function isMutatingMethod(method: string | undefined) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function authorizeOperatorSessionCsrf(request: IncomingMessage, response: ServerResponse, options: SiteFlowServerOptions) {
  if (!isMutatingMethod(request.method)) {
    return true;
  }

  if (headerValue(request, operatorSessionCsrfHeaderName)?.trim() === operatorSessionCsrfHeaderValue) {
    return true;
  }

  sendJson(
    response,
    403,
    { message: "SiteFlow operator session writes require a same-origin CSRF header." },
    options.allowedOrigin,
    request.method
  );
  return false;
}

function shouldUseSecureCookie(request: IncomingMessage, options?: SiteFlowServerOptions) {
  if (options?.secureCookies) {
    return true;
  }

  const forwardedProto = trustedForwardedHeaderToken(request, options, "x-forwarded-proto");

  if (forwardedProto) {
    return forwardedProto === "https";
  }

  return Boolean((request.socket as { encrypted?: boolean }).encrypted);
}

function appendSetCookie(response: ServerResponse, cookie: string) {
  const current = response.getHeader("set-cookie");

  if (!current) {
    response.setHeader("set-cookie", cookie);
    return;
  }

  response.setHeader("set-cookie", Array.isArray(current) ? [...current, cookie] : [String(current), cookie]);
}

function operatorSessionCookie(secret: string, expiresAt: string, maxAgeSeconds: number, request: IncomingMessage, options?: SiteFlowServerOptions) {
  const attributes = [
    `${operatorSessionCookieName}=${encodeURIComponent(secret)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${new Date(expiresAt).toUTCString()}`
  ];

  if (shouldUseSecureCookie(request, options)) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function expiredOperatorSessionCookie(request: IncomingMessage, options?: SiteFlowServerOptions) {
  const attributes = [
    `${operatorSessionCookieName}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];

  if (shouldUseSecureCookie(request, options)) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function operatorSessionResponse(result: { status: string; session: unknown; message: string }) {
  return {
    status: result.status,
    session: result.session,
    message: result.message
  };
}

function requestHeaders(request: IncomingMessage) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => headers.append(key, entry));
      continue;
    }

    headers.set(key, value);
  }

  return headers;
}

function deployHookUrl(request: IncomingMessage, token: string, options?: SiteFlowServerOptions) {
  return `${requestOrigin(request, options).replace(/\/+$/, "")}/api/deploy-hooks/${encodeURIComponent(token)}/trigger`;
}

function requestLogPath(request: IncomingMessage) {
  try {
    const pathname = new URL(request.url ?? "/", "http://siteflow.local").pathname;
    const segments = pathname.split("/");

    if (segments[1] === "api" && segments[2] === "deploy-hooks" && segments[3]) {
      segments[3] = "[token]";
      return segments.join("/");
    }

    return pathname;
  } catch {
    return "/";
  }
}

function logRequestCompletion(
  options: SiteFlowServerOptions,
  entry: Omit<SiteFlowRequestLogEntry, "durationMs" | "status">,
  response: ServerResponse,
  startedAt: number
) {
  if (!options.requestLogger) {
    return;
  }

  const statusCode = response.statusCode || 500;
  const durationMs = Math.max(0, Date.now() - startedAt);

  try {
    const errorClass = entry.errorClass ?? (statusCode >= 400 ? "ExpectedHttpError" : undefined);

    void Promise.resolve(options.requestLogger({
      ...entry,
      status: statusCode,
      ...(errorClass ? { errorClass } : {}),
      durationMs
    })).catch(() => undefined);
  } catch {
    // Request logging must never affect control-plane response semantics.
  }
}

function requestBucketKey(request: IncomingMessage, options?: SiteFlowServerOptions) {
  const explicit = headerValue(request, "x-siteflow-bucket-key")?.trim();

  if (explicit) {
    return explicit;
  }

  const forwardedFor = trustedForwardedHeaderToken(request, options, "x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor;
  }

  const remoteAddress = request.socket.remoteAddress;
  const userAgent = headerValue(request, "user-agent");
  const fallback = [remoteAddress, userAgent].filter(Boolean).join(":");

  return fallback || undefined;
}

function requestRateLimitBucketKey(request: IncomingMessage, options?: SiteFlowServerOptions) {
  const forwardedFor = trustedForwardedHeaderToken(request, options, "x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor;
  }

  const remoteAddress = request.socket.remoteAddress;
  const userAgent = headerValue(request, "user-agent");
  const fallback = [remoteAddress, userAgent].filter(Boolean).join(":");

  return fallback || undefined;
}

function pruneExpiredRateLimitBuckets(buckets: Map<string, RateLimitBucket>, now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function allowApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: SiteFlowServerOptions,
  buckets: Map<string, RateLimitBucket>
) {
  const limits = rateLimitOptions(options);

  if (!limits) {
    return true;
  }

  const now = limits.now();
  const key = requestRateLimitBucketKey(request, options) ?? "anonymous";
  const existing = buckets.get(key);

  pruneExpiredRateLimitBuckets(buckets, now);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + limits.windowMs
    });
    return true;
  }

  if (existing.count >= limits.maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    response.setHeader("retry-after", String(retryAfterSeconds));
    sendJson(response, 429, { message: "SiteFlow API rate limit exceeded." }, options.allowedOrigin, request.method);
    return false;
  }

  existing.count += 1;
  return true;
}

function requestIp(request: IncomingMessage, options?: SiteFlowServerOptions) {
  return trustedForwardedHeaderToken(request, options, "x-forwarded-for") ?? request.socket.remoteAddress;
}

function lowerCaseRequestHeaders(request: IncomingMessage) {
  return Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value[0] : value
    ])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function permissionLevel(permission: PermissionScope) {
  return permission === "read" ? 0 : permission === "write" ? 1 : 2;
}

function hasPermission(scopes: PermissionScope[], required: PermissionScope) {
  return scopes.some((scope) => permissionLevel(scope) >= permissionLevel(required));
}

function rootApiTokenPrincipal(): SiteFlowAuthPrincipal {
  return {
    kind: "root_api_token",
    scopes: allPermissionScopes,
    actor: rootApiTokenActor
  };
}

function fallbackApiTokenPrincipal(scopes: PermissionScope[]): SiteFlowAuthPrincipal {
  return {
    kind: "api_token",
    scopes,
    actor: {
      id: "api-token:resolved",
      name: "SiteFlow API token",
      role: "system"
    }
  };
}

// Estate convention: the global admin groups always carry admin scope; the
// product-domain operations group is env-configurable (SITEFLOW_ADMIN_GROUP,
// wired through options.gatewayAdminGroups). Everyone else the gateway lets
// through is an authenticated estate user -> read-only.
const defaultGatewayAdminGroups = ["admins", "infra-admins"];

function gatewayIdentityScopes(request: IncomingMessage, options: SiteFlowServerOptions): PermissionScope[] {
  const adminGroups = options.gatewayAdminGroups?.length ? options.gatewayAdminGroups : defaultGatewayAdminGroups;
  const groups = gatewayIdentityGroups(request.headers);

  return groups.some((group) => adminGroups.includes(group)) ? ["read", "write", "admin"] : ["read"];
}

function fallbackOperatorSessionPrincipal(scopes: PermissionScope[]): SiteFlowAuthPrincipal {
  return {
    kind: "operator_session",
    scopes,
    actor: {
      id: "operator-session:resolved",
      name: "SiteFlow operator session",
      role: "operator"
    }
  };
}

function bodyWithActor(body: unknown, actor: Actor) {
  return {
    ...(isRecord(body) ? body : {}),
    actor
  };
}

function evidenceString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nestedEvidenceObject(candidate: Record<string, unknown> | undefined, key: string) {
  return candidate && isRecord(candidate[key]) ? candidate[key] : undefined;
}

function releaseEvidencePayload(evidence: Record<string, unknown>) {
  const bundle = nestedEvidenceObject(evidence, "bundle") ?? nestedEvidenceObject(evidence, "evidence") ?? evidence;
  const evidencePath = evidenceString(evidence.evidencePath) ?? evidenceString(evidence.sourcePath) ?? "request.releaseEvidence";

  return { bundle, evidencePath };
}

function releaseEvidenceMetadataFromBundle(
  rawBundle: unknown,
  evidencePath: string,
  check: ReleaseEvidenceBundleResult
) {
  if (!isRecord(rawBundle)) {
    throw new SyntaxError("Production releaseEvidence must contain a release evidence bundle object.");
  }

  const release = nestedEvidenceObject(rawBundle, "release");
  const commitRef = evidenceString(check.selectedEvidence.releaseCommitRef);
  const repository = evidenceString(check.selectedEvidence.repository);
  const branch = evidenceString(check.selectedEvidence.branch);
  const payloadDigest = evidenceString(check.payloadDigest);

  if (!commitRef || !repository || !branch) {
    throw new SyntaxError("Production release evidence bundle must include repository, branch, and commitRef.");
  }

  if (!payloadDigest) {
    throw new SyntaxError("Production release evidence bundle check must include payloadDigest.");
  }

  return {
    evidencePath,
    checkedAt: check.checkedAt,
    payloadDigest,
    status: "passed" as const,
    commitRef,
    repository,
    branch,
    targetEnvironment: evidenceString(rawBundle.targetEnvironment) ?? evidenceString(release?.targetEnvironment) ?? "production",
    ...(evidenceString(release?.releaseTicket) ? { releaseTicket: evidenceString(release?.releaseTicket) } : {}),
    ...(evidenceString(release?.operatorName) ? { operatorName: evidenceString(release?.operatorName) } : {})
  };
}

function requireProductionReleaseEvidence(
  channel: string,
  body: unknown,
  operation: string,
  options: SiteFlowServerOptions
) {
  if (channel !== "production") {
    return undefined;
  }

  if (!isRecord(body) || !isRecord(body.releaseEvidence)) {
    throw new SyntaxError(`Production ${operation} requires a full releaseEvidence bundle from a passing release:evidence check.`);
  }

  const { bundle, evidencePath } = releaseEvidencePayload(body.releaseEvidence);

  if (!options.releaseEvidenceAttestationSigningKey) {
    throw new SyntaxError("Production release evidence bundle verification requires SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY.");
  }

  if (!releaseEvidenceBundleAttestationSignatureVerified(
    bundle,
    options.releaseEvidenceAttestationSigningKey,
    options.releaseEvidenceRequiredAttestationKeyId
  )) {
    throw new SyntaxError("Production release evidence bundle must include compose-generated attestation metadata with a valid signature.");
  }

  const check = (options.releaseEvidenceEvaluator ?? evaluateReleaseEvidenceBundle)(bundle, {
    evidencePath,
    targetEnvironment: "production",
    attestationSigningKey: options.releaseEvidenceAttestationSigningKey,
    requiredAttestationKeyId: options.releaseEvidenceRequiredAttestationKeyId
  });

  if (check.status !== "passed") {
    const failed = check.checks
      .filter((entry) => entry.status !== "pass")
      .map((entry) => entry.name)
      .slice(0, 5)
      .join(", ");
    throw new SyntaxError(`Production release evidence bundle did not pass${failed ? `: ${failed}` : "."}`);
  }

  const metadata = releaseEvidenceMetadataFromBundle(bundle, evidencePath, check);

  if (metadata.targetEnvironment !== "production") {
    throw new SyntaxError("Production release evidence bundle must target production.");
  }

  return metadata;
}

function bodyWithProductionReleaseEvidence(
  channel: string,
  body: unknown,
  operation: string,
  options: SiteFlowServerOptions
) {
  const metadata = requireProductionReleaseEvidence(channel, body, operation, options);
  const normalizedBody = { ...(isRecord(body) ? body : {}) };

  if (!metadata) {
    delete normalizedBody.releaseEvidence;
    return normalizedBody;
  }

  return {
    ...normalizedBody,
    releaseEvidence: metadata
  };
}

function normalizePrebuiltSourceForReleaseEvidenceBody(body: Record<string, unknown>) {
  const releaseEvidence = isRecord(body.releaseEvidence) ? body.releaseEvidence : undefined;

  if (!releaseEvidence) {
    return body;
  }

  const repository = evidenceString(releaseEvidence.repository);
  const branch = evidenceString(releaseEvidence.branch);
  const commitRef = evidenceString(releaseEvidence.commitRef);

  if (!repository || !branch || !commitRef) {
    throw new SyntaxError("Prebuilt deploy release evidence metadata must include repository, branch, and commitRef.");
  }

  if (body.source !== undefined && !isRecord(body.source)) {
    throw new SyntaxError("Prebuilt deploy source must be a JSON object when release evidence is supplied.");
  }

  const source = isRecord(body.source) ? body.source : {};
  const mismatches = [
    evidenceString(source.repository) && evidenceString(source.repository) !== repository ? "repository" : undefined,
    evidenceString(source.branch) && evidenceString(source.branch) !== branch ? "branch" : undefined,
    evidenceString(source.commitSha) && evidenceString(source.commitSha) !== commitRef ? "commitSha" : undefined
  ].filter((entry): entry is string => Boolean(entry));

  if (mismatches.length > 0) {
    throw new SyntaxError(`Prebuilt deploy source must match release evidence metadata: ${mismatches.join(", ")}.`);
  }

  return {
    ...body,
    source: {
      ...source,
      repository,
      branch,
      commitSha: commitRef
    }
  };
}

function bodyWithOptionalProductionReleaseEvidence(
  channel: string,
  body: unknown,
  operation: string,
  options: SiteFlowServerOptions
) {
  if (!isRecord(body) || body.releaseEvidence === undefined) {
    const normalizedBody = { ...(isRecord(body) ? body : {}) };

    if (channel !== "production") {
      delete normalizedBody.releaseEvidence;
    }

    return normalizedBody;
  }

  return bodyWithProductionReleaseEvidence(channel, body, operation, options);
}

function productionRollingAbortReleaseEvidenceException(reason: string) {
  return {
    type: "production_rolling_abort_stop_rollout",
    targetEnvironment: "production",
    acceptedWithoutReleaseEvidence: true,
    reason
  };
}

function bodyWithProductionRollingAbortException(channel: string, body: unknown, options: SiteFlowServerOptions) {
  const normalizedBody = bodyWithOptionalProductionReleaseEvidence(channel, body, "rolling release abort", options);

  if (channel !== "production") {
    delete normalizedBody.releaseEvidenceException;
    return normalizedBody;
  }

  const reason = evidenceString(normalizedBody.reason);

  if (!reason) {
    throw new SyntaxError("Production rolling release abort requires a non-empty audit reason because it records a stop-rollout release evidence exception.");
  }

  if (normalizedBody.releaseEvidence !== undefined) {
    throw new SyntaxError("Production rolling release abort must not include releaseEvidence; it records a stop-rollout release evidence exception instead.");
  }

  const suppliedException = isRecord(normalizedBody.releaseEvidenceException)
    ? normalizedBody.releaseEvidenceException
    : undefined;

  if (
    suppliedException &&
    (
      evidenceString(suppliedException.type) !== "production_rolling_abort_stop_rollout" ||
      evidenceString(suppliedException.targetEnvironment) !== "production" ||
      suppliedException.acceptedWithoutReleaseEvidence !== true ||
      evidenceString(suppliedException.reason) !== reason
    )
  ) {
    throw new SyntaxError("Production rolling release abort releaseEvidenceException must record stop-rollout type, production targetEnvironment, acceptedWithoutReleaseEvidence=true, and matching reason.");
  }

  return {
    ...normalizedBody,
    reason,
    releaseEvidenceException: productionRollingAbortReleaseEvidenceException(reason)
  };
}

function bodyWithOptionalPrebuiltReleaseEvidence(body: unknown, options: SiteFlowServerOptions) {
  if (!isRecord(body) || body.releaseEvidence === undefined) {
    if (isRecord(body) && body.source !== undefined) {
      throw new SyntaxError("Prebuilt deploy source requires checked releaseEvidence metadata.");
    }

    return body;
  }

  return normalizePrebuiltSourceForReleaseEvidenceBody(
    bodyWithProductionReleaseEvidence("production", body, "prebuilt deploy upload", options)
  );
}

function bodyWithRequestedBy(body: unknown, requestedBy: Actor) {
  return {
    ...(isRecord(body) ? body : {}),
    requestedBy
  };
}

function bodyWithoutClientPrincipal(body: unknown) {
  const sanitized = { ...(isRecord(body) ? body : {}) };
  delete sanitized.actor;
  delete sanitized.requestedBy;
  return sanitized;
}

function isPermissionScope(value: unknown): value is PermissionScope {
  return value === "read" || value === "write" || value === "admin";
}

function operatorSessionCommandFromBody(body: unknown) {
  if (!isRecord(body)) {
    throw new SyntaxError("Operator session body must be a JSON object.");
  }

  const subject = body.subject;
  const scopes = body.scopes ?? allPermissionScopes;
  const projectIdsValue = body.projectIds;
  const ttlSecondsValue = body.ttlSeconds;
  const actor = body.actor;
  let ttlSeconds: number | undefined;
  let projectIds: string[] | undefined;

  if (subject !== undefined && typeof subject !== "string") {
    throw new SyntaxError("Operator session subject must be a string.");
  }

  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isPermissionScope)) {
    throw new SyntaxError("Operator session scopes must include read, write, or admin.");
  }

  if (projectIdsValue !== undefined) {
    if (!Array.isArray(projectIdsValue) || projectIdsValue.length === 0 || !projectIdsValue.every((entry) => typeof entry === "string")) {
      throw new SyntaxError("Operator session projectIds must be a non-empty string array when provided.");
    }

    projectIds = Array.from(new Set(projectIdsValue.map((entry) => entry.trim())));

    if (projectIds.some((entry) => !entry || entry.length > 120)) {
      throw new SyntaxError("Operator session projectIds must be non-empty project ids 120 characters or fewer.");
    }
  }

  if (
    ttlSecondsValue !== undefined &&
    (typeof ttlSecondsValue !== "number" || !Number.isInteger(ttlSecondsValue) || ttlSecondsValue < 60 || ttlSecondsValue > 86_400)
  ) {
    throw new SyntaxError("Operator session ttlSeconds must be an integer from 60 to 86400.");
  }

  if (ttlSecondsValue !== undefined) {
    ttlSeconds = ttlSecondsValue;
  }

  if (actor !== undefined && !isRecord(actor)) {
    throw new SyntaxError("Operator session actor must be a JSON object.");
  }

  return {
    subject,
    scopes: Array.from(new Set(scopes)),
    projectIds,
    ttlSeconds,
    actor: actor as Actor | undefined
  };
}

function operatorSessionRevokeAllCommandFromBody(body: unknown, actor: Actor, projectId?: string) {
  if (!isRecord(body)) {
    throw new SyntaxError("Operator session revoke-all body must be a JSON object.");
  }

  if (body.reason !== undefined && typeof body.reason !== "string") {
    throw new SyntaxError("Operator session revoke-all reason must be a string.");
  }

  const reason = body.reason?.trim() || undefined;

  return {
    projectId,
    actor,
    reason
  };
}

function sanitizedReadinessDetails(details: unknown): Record<string, SiteFlowReadinessDetailValue> {
  if (!isRecord(details)) {
    return {};
  }

  const sanitized: Record<string, SiteFlowReadinessDetailValue> = {};

  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(key)) {
      continue;
    }

    if (typeof value === "string") {
      if (allowedReadinessDetailValues.has(value)) {
        sanitized[key] = value as SiteFlowReadinessDetailValue;
      }
      continue;
    }

    if (typeof value === "boolean" || value === null) {
      sanitized[key] = value;
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

async function readinessBody(options: SiteFlowServerOptions): Promise<{ statusCode: number; body: { status: SiteFlowReadinessStatus; details: Record<string, SiteFlowReadinessDetailValue> } }> {
  try {
    const result = await options.readinessCheck?.();
    const status = result?.status === "not_ready" ? "not_ready" : "ready";

    return {
      statusCode: status === "ready" ? 200 : 503,
      body: {
        status,
        details: sanitizedReadinessDetails(result?.details)
      }
    };
  } catch {
    return {
      statusCode: 503,
      body: {
        status: "not_ready",
        details: {}
      }
    };
  }
}

function recordField(value: Record<string, unknown> | undefined, key: string) {
  const field = value?.[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string) {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function statusValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string) {
  const field = value?.[key];
  return typeof field === "number" ? field : undefined;
}

function requireString(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}

function safeCompareUtf8(actualValue: string | undefined, expectedValue: string) {
  if (!actualValue) {
    return false;
  }

  const expected = Buffer.from(expectedValue, "utf8");
  const actual = Buffer.from(actualValue, "utf8");

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

function verifySha256HexSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string) {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  return safeCompareUtf8(signatureHeader, `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
}

function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string) {
  return verifySha256HexSignature(rawBody, signatureHeader, secret);
}

const gitLabWebhookTimestampToleranceMs = 5 * 60 * 1000;

function decodeGitLabSigningKey(secret: string) {
  if (!secret.startsWith("whsec_")) {
    return secret;
  }

  const encoded = secret.slice("whsec_".length).replace(/-/g, "+").replace(/_/g, "/");
  const padded = encoded.padEnd(encoded.length + (4 - encoded.length % 4) % 4, "=");
  const decoded = Buffer.from(padded, "base64");

  return decoded.byteLength > 0 ? decoded : undefined;
}

function gitLabWebhookTimestampFresh(timestamp: string | undefined, nowMs = Date.now()) {
  if (!timestamp) {
    return false;
  }

  const numeric = Number(timestamp);
  const timestampMs = Number.isFinite(numeric)
    ? numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    : Date.parse(timestamp);

  return Number.isFinite(timestampMs) && Math.abs(nowMs - timestampMs) <= gitLabWebhookTimestampToleranceMs;
}

function gitLabSignatureValues(signatureHeaders: string[]) {
  return signatureHeaders.flatMap((value) =>
    Array.from(value.matchAll(/(?:^|[\s,])v1[=,]([^,\s]+)/g), (match) => match[1]).filter(Boolean)
  );
}

function verifyGitLabSignature(rawBody: Buffer, signatureHeaders: string[], secret: string, deliveryId: string | undefined, timestamp: string | undefined) {
  if (!deliveryId || !gitLabWebhookTimestampFresh(timestamp)) {
    return false;
  }

  const signingKey = decodeGitLabSigningKey(secret);

  if (!signingKey) {
    return false;
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${deliveryId}.${timestamp}.`, "utf8"),
    rawBody
  ]);
  const expected = createHmac("sha256", signingKey).update(signedPayload).digest("base64");

  return gitLabSignatureValues(signatureHeaders).some((signature) => safeCompareUtf8(signature, expected));
}

function verifyGiteaSignature(rawBody: Buffer, signatureHeader: string | undefined, hubSignatureHeader: string | undefined, secret: string) {
  if (signatureHeader) {
    return safeCompareUtf8(signatureHeader, createHmac("sha256", secret).update(rawBody).digest("hex"));
  }

  return verifySha256HexSignature(rawBody, hubSignatureHeader, secret);
}

async function deliverLogDrain(
  plan: LogDrainDeliveryPlan,
  command: Record<string, unknown>,
  options: SiteFlowServerOptions
) {
  const deliveredAt = new Date().toISOString();
  const payload = JSON.stringify({
    id: plan.deliveryId,
    projectId: plan.drain.projectId,
    drainId: plan.drain.id,
    reason: typeof command.reason === "string" ? command.reason : undefined,
    deliveredAt,
    events: plan.events
  });
  const payloadSha256 = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
  const signature = `sha256=${createHmac("sha256", plan.signingSecret).update(payload).digest("hex")}`;
  const fetchImpl = options.drainFetch ?? fetch;

  try {
    const drainResponse = await fetchImpl(plan.drain.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-siteflow-delivery": plan.deliveryId,
        "x-siteflow-signature": signature
      },
      body: payload
    });

    return options.repository.recordLogDrainDelivery({
      projectId: plan.drain.projectId,
      drainId: plan.drain.id,
      deliveryId: plan.deliveryId,
      status: drainResponse.ok ? "delivered" : "failed",
      responseStatus: drainResponse.status,
      eventsDelivered: plan.events.length,
      payloadSha256,
      errorMessage: drainResponse.ok ? undefined : `Log drain endpoint returned HTTP ${drainResponse.status}.`
    });
  } catch (error) {
    return options.repository.recordLogDrainDelivery({
      projectId: plan.drain.projectId,
      drainId: plan.drain.id,
      deliveryId: plan.deliveryId,
      status: "failed",
      eventsDelivered: plan.events.length,
      payloadSha256,
      errorMessage: error instanceof Error ? error.message : "Log drain delivery failed."
    });
  }
}

function actorFromGitHub(payload: Record<string, unknown>, fallbackName: string): Actor {
  const sender = recordField(payload, "sender");
  const login = stringField(sender, "login") ?? fallbackName;

  return {
    id: `github:${login}`,
    name: login,
    role: "developer"
  };
}

function repositoryFromGitHub(payload: Record<string, unknown>): RepositoryBinding {
  const repository = recordField(payload, "repository");
  const owner = recordField(repository ?? {}, "owner");
  const fullName = stringField(repository, "full_name");
  const fallbackOwner = fullName?.split("/")[0];
  const remoteUrl = requireString(stringField(repository, "ssh_url") ?? stringField(repository, "clone_url") ?? stringField(repository, "git_url"), "GitHub repository remoteUrl");

  return {
    provider: "github",
    owner: requireString(stringField(owner, "login") ?? stringField(owner, "name") ?? fallbackOwner, "GitHub repository owner"),
    name: requireString(stringField(repository, "name"), "GitHub repository name"),
    defaultBranch: stringField(repository, "default_branch") ?? "main",
    providerPayload: {
      id: numberField(repository, "id"),
      fullName,
      htmlUrl: stringField(repository, "html_url"),
      remoteUrl
    }
  };
}

function branchFromGitRef(ref: string) {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function sanitizeGitHubRepositoryPayload(payload: Record<string, unknown>) {
  const repository = recordField(payload, "repository");

  return {
    id: numberField(repository, "id"),
    fullName: stringField(repository, "full_name"),
    htmlUrl: stringField(repository, "html_url"),
    defaultBranch: stringField(repository, "default_branch"),
    remoteUrl: stringField(repository, "ssh_url") ?? stringField(repository, "clone_url") ?? stringField(repository, "git_url")
  };
}

function normalizeGitHubPush(payload: Record<string, unknown>, deliveryId: string, receivedAt: string): SourceEventInput | undefined {
  const ref = requireString(stringField(payload, "ref"), "GitHub push ref");
  const commitSha = requireString(stringField(payload, "after"), "GitHub push commit sha");

  if (/^0+$/.test(commitSha)) {
    return undefined;
  }

  const headCommit = recordField(payload, "head_commit");
  const commitAuthor = recordField(headCommit ?? {}, "author");
  const authorName = stringField(commitAuthor, "name") ?? stringField(recordField(payload, "sender"), "login") ?? "GitHub";

  return {
    provider: "github",
    deliveryId,
    kind: "push",
    repository: repositoryFromGitHub(payload),
    branch: branchFromGitRef(ref),
    commitSha,
    commitMessage: stringField(headCommit, "message") ?? "GitHub push",
    commitAuthor: authorName,
    receivedAt,
    actor: actorFromGitHub(payload, authorName),
    providerPayload: {
      event: "push",
      ref,
      before: stringField(payload, "before"),
      after: commitSha,
      repository: sanitizeGitHubRepositoryPayload(payload)
    }
  };
}

function normalizeGitHubPullRequest(payload: Record<string, unknown>, deliveryId: string, receivedAt: string): SourceEventInput {
  const pullRequest = recordField(payload, "pull_request");
  const head = recordField(pullRequest ?? {}, "head");
  const user = recordField(pullRequest ?? {}, "user");
  const number = numberField(pullRequest, "number") ?? numberField(payload, "number");
  const authorName = stringField(user, "login") ?? stringField(recordField(payload, "sender"), "login") ?? "GitHub";

  if (typeof number !== "number") {
    throw new Error("GitHub pull request number is required.");
  }

  return {
    provider: "github",
    deliveryId,
    kind: "pull_request",
    repository: repositoryFromGitHub(payload),
    branch: requireString(stringField(head, "ref"), "GitHub pull request head ref"),
    commitSha: requireString(stringField(head, "sha"), "GitHub pull request head sha"),
    commitMessage: stringField(pullRequest, "title") ?? `Pull request #${number}`,
    commitAuthor: authorName,
    pullRequestNumber: number,
    receivedAt,
    actor: actorFromGitHub(payload, authorName),
    providerPayload: {
      event: "pull_request",
      action: stringField(payload, "action"),
      pullRequest: {
        number,
        headRef: stringField(head, "ref"),
        headSha: stringField(head, "sha"),
        htmlUrl: stringField(pullRequest, "html_url")
      },
      repository: sanitizeGitHubRepositoryPayload(payload)
    }
  };
}

function normalizeGitHubWebhook(eventName: string, payload: unknown, deliveryId: string): SourceEventInput | undefined {
  if (!isRecord(payload)) {
    throw new Error("GitHub webhook payload must be a JSON object.");
  }

  const receivedAt = new Date().toISOString();

  if (eventName === "push") {
    return normalizeGitHubPush(payload, deliveryId, receivedAt);
  }

  if (eventName === "pull_request") {
    return normalizeGitHubPullRequest(payload, deliveryId, receivedAt);
  }

  return undefined;
}

function actorFromProvider(provider: SourceProvider, rawName: string | undefined, fallbackName: string): Actor {
  const name = rawName?.trim() || fallbackName;

  return {
    id: `${provider}:${name}`,
    name,
    role: "developer"
  };
}

function ownerAndNameFromPath(pathWithNamespace: string | undefined, fallbackName: string | undefined) {
  const parts = pathWithNamespace?.split("/").filter(Boolean) ?? [];

  return {
    owner: parts.length > 1 ? parts.slice(0, -1).join("/") : undefined,
    name: parts.at(-1) ?? fallbackName
  };
}

function repositoryFromGitLab(payload: Record<string, unknown>): RepositoryBinding {
  const project = recordField(payload, "project") ?? recordField(payload, "repository");
  const pathWithNamespace = stringField(project, "path_with_namespace");
  const fromPath = ownerAndNameFromPath(pathWithNamespace, stringField(project, "name"));
  const namespace = recordField(project, "namespace");
  const remoteUrl = requireString(stringField(project, "git_ssh_url") ??
    stringField(project, "ssh_url_to_repo") ??
    stringField(project, "git_http_url") ??
    stringField(project, "http_url_to_repo") ??
    stringField(project, "web_url"), "GitLab repository remoteUrl");

  return {
    provider: "gitlab",
    owner: requireString(stringField(namespace, "path") ?? stringField(namespace, "name") ?? fromPath.owner, "GitLab repository owner"),
    name: requireString(stringField(project, "name") ?? fromPath.name, "GitLab repository name"),
    defaultBranch: stringField(project, "default_branch") ?? "main",
    providerPayload: {
      id: numberField(project, "id"),
      pathWithNamespace,
      webUrl: stringField(project, "web_url"),
      remoteUrl
    }
  };
}

function normalizeGitLabPush(payload: Record<string, unknown>, deliveryId: string, receivedAt: string): SourceEventInput | undefined {
  const ref = requireString(stringField(payload, "ref"), "GitLab push ref");
  const commitSha = requireString(stringField(payload, "after") ?? stringField(payload, "checkout_sha"), "GitLab push commit sha");

  if (/^0+$/.test(commitSha)) {
    return undefined;
  }

  const commits = Array.isArray(payload.commits) ? payload.commits.filter(isRecord) : [];
  const commit = commits.find((entry) => stringField(entry, "id") === commitSha) ?? commits.at(-1);
  const author = recordField(commit ?? {}, "author");
  const actorName = stringField(payload, "user_username") ?? stringField(payload, "user_name") ?? stringField(author, "name") ?? "GitLab";

  return {
    provider: "gitlab",
    deliveryId,
    kind: "push",
    repository: repositoryFromGitLab(payload),
    branch: branchFromGitRef(ref),
    commitSha,
    commitMessage: stringField(commit, "message") ?? "GitLab push",
    commitAuthor: stringField(author, "name") ?? actorName,
    receivedAt,
    actor: actorFromProvider("gitlab", actorName, "GitLab"),
    providerPayload: {
      event: "push",
      ref,
      before: stringField(payload, "before"),
      after: commitSha
    }
  };
}

function normalizeGitLabMergeRequest(payload: Record<string, unknown>, deliveryId: string, receivedAt: string): SourceEventInput {
  const attrs = recordField(payload, "object_attributes");
  const lastCommit = recordField(attrs, "last_commit") ?? recordField(payload, "last_commit");
  const author = recordField(lastCommit ?? {}, "author");
  const iid = numberField(attrs, "iid") ?? numberField(payload, "iid");
  const actorName = stringField(payload, "user_username") ?? stringField(payload, "user_name") ?? stringField(author, "name") ?? "GitLab";

  if (typeof iid !== "number") {
    throw new Error("GitLab merge request iid is required.");
  }

  return {
    provider: "gitlab",
    deliveryId,
    kind: "pull_request",
    repository: repositoryFromGitLab(payload),
    branch: requireString(stringField(attrs, "source_branch"), "GitLab merge request source branch"),
    commitSha: requireString(stringField(lastCommit, "id") ?? stringField(attrs, "last_commit_sha"), "GitLab merge request commit sha"),
    commitMessage: stringField(attrs, "title") ?? `Merge request !${iid}`,
    commitAuthor: stringField(author, "name") ?? actorName,
    pullRequestNumber: iid,
    receivedAt,
    actor: actorFromProvider("gitlab", actorName, "GitLab"),
    providerPayload: {
      event: "merge_request",
      action: stringField(attrs, "action"),
      mergeRequest: {
        iid,
        sourceBranch: stringField(attrs, "source_branch"),
        targetBranch: stringField(attrs, "target_branch"),
        url: stringField(attrs, "url")
      }
    }
  };
}

function normalizeGitLabWebhook(eventName: string, payload: unknown, deliveryId: string): SourceEventInput | undefined {
  if (!isRecord(payload)) {
    throw new Error("GitLab webhook payload must be a JSON object.");
  }

  const receivedAt = new Date().toISOString();
  const objectKind = statusValue(payload.object_kind) ?? statusValue(payload.event_name) ?? statusValue(eventName);

  if (objectKind === "push" || eventName === "Push Hook") {
    return normalizeGitLabPush(payload, deliveryId, receivedAt);
  }

  if (objectKind === "merge_request" || eventName === "Merge Request Hook") {
    return normalizeGitLabMergeRequest(payload, deliveryId, receivedAt);
  }

  return undefined;
}

function repositoryFromGitea(payload: Record<string, unknown>): RepositoryBinding {
  const repository = recordField(payload, "repository");
  const owner = recordField(repository ?? {}, "owner");
  const fullName = stringField(repository, "full_name");
  const fromPath = ownerAndNameFromPath(fullName, stringField(repository, "name"));
  const remoteUrl = requireString(stringField(repository, "ssh_url") ?? stringField(repository, "clone_url") ?? stringField(repository, "html_url"), "Gitea repository remoteUrl");

  return {
    provider: "gitea",
    owner: requireString(stringField(owner, "username") ?? stringField(owner, "login") ?? stringField(owner, "name") ?? fromPath.owner, "Gitea repository owner"),
    name: requireString(stringField(repository, "name") ?? fromPath.name, "Gitea repository name"),
    defaultBranch: stringField(repository, "default_branch") ?? "main",
    providerPayload: {
      id: numberField(repository, "id"),
      fullName,
      htmlUrl: stringField(repository, "html_url"),
      remoteUrl
    }
  };
}

function normalizeGiteaPush(payload: Record<string, unknown>, deliveryId: string, receivedAt: string): SourceEventInput | undefined {
  const ref = requireString(stringField(payload, "ref"), "Gitea push ref");
  const commitSha = requireString(stringField(payload, "after"), "Gitea push commit sha");

  if (/^0+$/.test(commitSha)) {
    return undefined;
  }

  const headCommit = recordField(payload, "head_commit");
  const author = recordField(headCommit ?? {}, "author");
  const sender = recordField(payload, "sender");
  const actorName = stringField(sender, "login") ?? stringField(sender, "username") ?? stringField(author, "name") ?? "Gitea";

  return {
    provider: "gitea",
    deliveryId,
    kind: "push",
    repository: repositoryFromGitea(payload),
    branch: branchFromGitRef(ref),
    commitSha,
    commitMessage: stringField(headCommit, "message") ?? "Gitea push",
    commitAuthor: stringField(author, "name") ?? actorName,
    receivedAt,
    actor: actorFromProvider("gitea", actorName, "Gitea"),
    providerPayload: {
      event: "push",
      ref,
      before: stringField(payload, "before"),
      after: commitSha
    }
  };
}

function normalizeGiteaPullRequest(payload: Record<string, unknown>, deliveryId: string, receivedAt: string): SourceEventInput {
  const pullRequest = recordField(payload, "pull_request");
  const head = recordField(pullRequest ?? {}, "head");
  const user = recordField(pullRequest ?? {}, "user");
  const number = numberField(pullRequest, "number") ?? numberField(payload, "number");
  const actorName = stringField(user, "login") ?? stringField(user, "username") ?? stringField(recordField(payload, "sender"), "login") ?? "Gitea";

  if (typeof number !== "number") {
    throw new Error("Gitea pull request number is required.");
  }

  return {
    provider: "gitea",
    deliveryId,
    kind: "pull_request",
    repository: repositoryFromGitea(payload),
    branch: requireString(stringField(head, "ref"), "Gitea pull request head ref"),
    commitSha: requireString(stringField(head, "sha"), "Gitea pull request head sha"),
    commitMessage: stringField(pullRequest, "title") ?? `Pull request #${number}`,
    commitAuthor: actorName,
    pullRequestNumber: number,
    receivedAt,
    actor: actorFromProvider("gitea", actorName, "Gitea"),
    providerPayload: {
      event: "pull_request",
      action: stringField(payload, "action"),
      pullRequest: {
        number,
        headRef: stringField(head, "ref"),
        headSha: stringField(head, "sha"),
        htmlUrl: stringField(pullRequest, "html_url")
      }
    }
  };
}

function normalizeGiteaWebhook(eventName: string, payload: unknown, deliveryId: string): SourceEventInput | undefined {
  if (!isRecord(payload)) {
    throw new Error("Gitea webhook payload must be a JSON object.");
  }

  const receivedAt = new Date().toISOString();

  if (eventName === "push") {
    return normalizeGiteaPush(payload, deliveryId, receivedAt);
  }

  if (eventName === "pull_request") {
    return normalizeGiteaPullRequest(payload, deliveryId, receivedAt);
  }

  return undefined;
}

function repositoryFromGeneric(payload: Record<string, unknown>): RepositoryBinding {
  const repository = recordField(payload, "repository");
  const remoteUrl = requireString(stringField(repository, "remoteUrl") ?? stringField(repository, "url"), "Generic repository remoteUrl");

  return {
    provider: "generic",
    owner: requireString(stringField(repository, "owner"), "Generic repository owner"),
    name: requireString(stringField(repository, "name"), "Generic repository name"),
    defaultBranch: stringField(repository, "defaultBranch") ?? stringField(repository, "default_branch") ?? "main",
    providerPayload: {
      remoteUrl,
      url: remoteUrl,
      webUrl: stringField(repository, "webUrl") ?? stringField(repository, "web_url")
    }
  };
}

function normalizeGenericWebhook(eventName: string, payload: unknown, deliveryId: string): SourceEventInput | undefined {
  if (!isRecord(payload)) {
    throw new Error("Generic webhook payload must be a JSON object.");
  }

  const kind = statusValue(payload.kind) ?? statusValue(eventName);

  if (kind !== "push" && kind !== "pull_request") {
    return undefined;
  }

  const actor = recordField(payload, "actor");
  const actorName = stringField(actor, "name") ?? stringField(actor, "login") ?? "Generic";
  const ref = stringField(payload, "ref");
  const commitSha = requireString(stringField(payload, "commitSha") ?? stringField(payload, "commit_sha") ?? stringField(payload, "after"), "Generic webhook commitSha");

  if (kind === "push" && /^0+$/.test(commitSha)) {
    return undefined;
  }

  return {
    provider: "generic",
    deliveryId,
    kind,
    repository: repositoryFromGeneric(payload),
    branch: requireString(stringField(payload, "branch") ?? (ref ? branchFromGitRef(ref) : undefined), "Generic webhook branch"),
    commitSha,
    commitMessage: stringField(payload, "commitMessage") ?? stringField(payload, "commit_message") ?? "Generic webhook",
    commitAuthor: stringField(payload, "commitAuthor") ?? stringField(payload, "commit_author") ?? actorName,
    pullRequestNumber: kind === "pull_request" ? numberField(payload, "pullRequestNumber") ?? numberField(payload, "pull_request_number") : undefined,
    receivedAt: new Date().toISOString(),
    actor: {
      id: stringField(actor, "id") ?? `generic:${actorName}`,
      name: actorName,
      role: "developer"
    },
    providerPayload: {
      event: kind,
      ref,
      repository: {
        owner: stringField(recordField(payload, "repository"), "owner"),
        name: stringField(recordField(payload, "repository"), "name")
      }
    }
  };
}

function normalizeGitWebhook(provider: SourceProvider, eventName: string, payload: unknown, deliveryId: string): SourceEventInput | undefined {
  if (provider === "github") {
    return normalizeGitHubWebhook(eventName, payload, deliveryId);
  }

  if (provider === "gitlab") {
    return normalizeGitLabWebhook(eventName, payload, deliveryId);
  }

  if (provider === "gitea") {
    return normalizeGiteaWebhook(eventName, payload, deliveryId);
  }

  return normalizeGenericWebhook(eventName, payload, deliveryId);
}

function contentType(request: IncomingMessage) {
  return headerValue(request, "content-type")?.split(";")[0]?.trim().toLowerCase();
}

function parseGitWebhookPayload(provider: SourceProvider, request: IncomingMessage, rawBody: Buffer) {
  const bodyText = rawBody.toString("utf8");

  if (!bodyText.trim()) {
    return {};
  }

  if (provider === "gitea" && contentType(request) === "application/x-www-form-urlencoded") {
    const payload = new URLSearchParams(bodyText).get("payload");

    if (!payload?.trim()) {
      throw new Error("Gitea form webhook payload is required.");
    }

    return JSON.parse(payload) as unknown;
  }

  return JSON.parse(bodyText) as unknown;
}

function gitWebhookSecret(provider: SourceProvider, options: SiteFlowServerOptions) {
  return options.gitWebhookSecrets?.[provider] ?? (provider === "github" ? options.githubWebhookSecret : undefined);
}

function gitWebhookDeliveryId(provider: SourceProvider, request: IncomingMessage) {
  if (provider === "github") {
    return headerValue(request, "x-github-delivery");
  }

  if (provider === "gitlab") {
    return headerValue(request, "webhook-id") ?? headerValue(request, "x-gitlab-event-uuid");
  }

  if (provider === "gitea") {
    return headerValue(request, "x-gitea-delivery") ?? headerValue(request, "x-gogs-delivery") ?? headerValue(request, "x-github-delivery");
  }

  // Generic provider: SiteFlow's own headers, with the Loom (HOLDFAST git)
  // dialect as a fallback (X-Loom-Delivery / X-Loom-Event / X-Loom-Signature).
  return headerValue(request, "x-siteflow-delivery") ?? headerValue(request, "x-loom-delivery");
}

function gitWebhookEventName(provider: SourceProvider, request: IncomingMessage) {
  if (provider === "github") {
    return headerValue(request, "x-github-event");
  }

  if (provider === "gitlab") {
    return headerValue(request, "x-gitlab-event");
  }

  if (provider === "gitea") {
    return headerValue(request, "x-gitea-event") ?? headerValue(request, "x-gogs-event") ?? headerValue(request, "x-github-event");
  }

  return headerValue(request, "x-siteflow-event") ?? headerValue(request, "x-loom-event");
}

function gitWebhookSignatureValid(provider: SourceProvider, request: IncomingMessage, rawBody: Buffer, secret: string, deliveryId: string) {
  if (provider === "github") {
    return verifyGitHubSignature(rawBody, headerValue(request, "x-hub-signature-256"), secret);
  }

  if (provider === "gitlab") {
    return verifyGitLabSignature(rawBody, headerValues(request, "webhook-signature"), secret, deliveryId, headerValue(request, "webhook-timestamp"));
  }

  if (provider === "gitea") {
    return verifyGiteaSignature(rawBody, headerValue(request, "x-gitea-signature") ?? headerValue(request, "x-gogs-signature"), headerValue(request, "x-hub-signature-256"), secret);
  }

  // Loom signs with the same sha256=<hex> HMAC format, only the header differs.
  return verifySha256HexSignature(rawBody, headerValue(request, "x-siteflow-signature") ?? headerValue(request, "x-loom-signature"), secret);
}

function gitWebhookProviderLabel(provider: SourceProvider) {
  return provider === "gitea" ? "Gitea" : provider === "gitlab" ? "GitLab" : provider === "github" ? "GitHub" : "generic Git";
}

async function authorizeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: SiteFlowServerOptions,
  permission: PermissionScope,
  projectId?: string
): Promise<SiteFlowAuthPrincipal | undefined> {
  const token = bearerToken(request);

  if (token && options.apiToken && secretEquals(token, options.apiToken)) {
    return rootApiTokenPrincipal();
  }

  if (token) {
    const principal = await options.repository.resolveTokenPrincipal?.(token, projectId);
    const scopes = principal?.scopes ?? await options.repository.resolveTokenPermissions(token, projectId);

    if (scopes && hasPermission(scopes, permission)) {
      return principal ?? fallbackApiTokenPrincipal(scopes);
    }

    sendJson(response, 403, { message: `SiteFlow API token does not include ${permission} permission.` }, options.allowedOrigin, request.method);
    return undefined;
  }

  // HOLDFAST gateway identity: when GATEWAY_HMAC_KEY is configured and the
  // Sluice gateway injected a signed X-Auth-* identity, trust it and short-
  // circuit the operator session (single source of truth for console auth).
  // Root token / api_tokens / deploy-hook tokens above stay untouched.
  const gatewaySubject = options.gatewayHmacKey ? gatewayIdentitySubject(request.headers) : undefined;

  if (gatewaySubject) {
    if (!gatewayIdentityOk(request.headers, options.gatewayHmacKey)) {
      sendJson(response, 401, { message: "Gateway identity signature verification failed." }, options.allowedOrigin, request.method);
      return undefined;
    }

    const scopes = gatewayIdentityScopes(request, options);

    if (!hasPermission(scopes, permission)) {
      sendJson(response, 403, { message: `Gateway identity does not include ${permission} permission.` }, options.allowedOrigin, request.method);
      return undefined;
    }

    // Keep the same-origin CSRF header requirement for mutating requests: the
    // estate SSO cookie rides on cross-site browser requests (the gateway will
    // happily re-inject identity), so writes still demand the custom header the
    // console XHR client always sends (x-siteflow-csrf: same-origin).
    if (!authorizeOperatorSessionCsrf(request, response, options)) {
      return undefined;
    }

    const email = gatewayIdentityEmail(request.headers);

    return {
      kind: "gateway_identity",
      scopes,
      actor: {
        id: gatewaySubject,
        name: email ?? gatewaySubject,
        email,
        role: "operator"
      }
    };
  }

  const sessionToken = operatorSessionToken(request);

  if (sessionToken) {
    const principal = await options.repository.resolveSessionPrincipal?.(sessionToken, projectId);
    const scopes = principal?.scopes ?? await options.repository.resolveSessionPermissions(sessionToken, projectId);

    if (scopes && hasPermission(scopes, permission)) {
      return authorizeOperatorSessionCsrf(request, response, options)
        ? principal ?? fallbackOperatorSessionPrincipal(scopes)
        : undefined;
    }

    if (scopes) {
      sendJson(response, 403, { message: `SiteFlow operator session does not include ${permission} permission.` }, options.allowedOrigin, request.method);
      return undefined;
    }

    sendJson(response, 401, { message: "SiteFlow operator session is invalid or expired." }, options.allowedOrigin, request.method);
    return undefined;
  }

  if (!options.apiToken) {
    sendJson(response, 503, { message: "SiteFlow API token is not configured." }, options.allowedOrigin, request.method);
    return undefined;
  }

  sendJson(response, 401, { message: "SiteFlow API token is required." }, options.allowedOrigin, request.method);
  return undefined;
}

async function authorizeBearerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: SiteFlowServerOptions,
  permission: PermissionScope,
  projectId?: string
): Promise<SiteFlowAuthPrincipal | undefined> {
  const token = bearerToken(request);

  if (!token) {
    sendJson(response, 401, { message: "SiteFlow API token is required." }, options.allowedOrigin, request.method);
    return undefined;
  }

  if (options.apiToken && secretEquals(token, options.apiToken)) {
    return rootApiTokenPrincipal();
  }

  const principal = await options.repository.resolveTokenPrincipal?.(token, projectId);
  const scopes = principal?.scopes ?? await options.repository.resolveTokenPermissions(token, projectId);

  if (scopes && hasPermission(scopes, permission)) {
    return principal ?? fallbackApiTokenPrincipal(scopes);
  }

  sendJson(response, 403, { message: `SiteFlow API token does not include ${permission} permission.` }, options.allowedOrigin, request.method);
  return undefined;
}

function authorizeMetricsRequest(request: IncomingMessage, response: ServerResponse, options: SiteFlowServerOptions) {
  const metricsToken = options.metricsToken?.trim();

  if (!metricsToken) {
    return true;
  }

  const token = bearerToken(request);

  if (!token) {
    sendJson(response, 401, { message: "SiteFlow metrics token is required." }, options.allowedOrigin, request.method);
    return false;
  }

  if (!secretEquals(token, metricsToken)) {
    sendJson(response, 403, { message: "SiteFlow metrics token is invalid." }, options.allowedOrigin, request.method);
    return false;
  }

  return true;
}

async function authenticatedPermissions(request: IncomingMessage, options: SiteFlowServerOptions, projectId?: string): Promise<PermissionScope[]> {
  const token = bearerToken(request);

  if (token && options.apiToken && secretEquals(token, options.apiToken)) {
    return ["read", "write", "admin"];
  }

  if (token) {
    const principal = await options.repository.resolveTokenPrincipal?.(token, projectId);

    return principal?.scopes ?? await options.repository.resolveTokenPermissions(token, projectId) ?? [];
  }

  if (options.gatewayHmacKey && gatewayIdentitySubject(request.headers)) {
    return gatewayIdentityOk(request.headers, options.gatewayHmacKey)
      ? gatewayIdentityScopes(request, options)
      : [];
  }

  const sessionToken = operatorSessionToken(request);

  if (!sessionToken) {
    return [];
  }

  const principal = await options.repository.resolveSessionPrincipal?.(sessionToken, projectId);

  return principal?.scopes ?? await options.repository.resolveSessionPermissions(sessionToken, projectId) ?? [];
}

function contentTypeFor(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function staticAssetCacheControl(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".html" || extension === ".json" || extension === ".xml" || extension === ".txt") {
    return "public, max-age=0, must-revalidate";
  }

  const basename = path.basename(filePath, extension);
  const hasFingerprint = /(?:^|[-_.])[a-f0-9]{8,}(?:$|[-_.])/i.test(basename);

  return hasFingerprint
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600";
}

function weakStaticEtag(route: ArtifactRoute, resolvedPath: string, body: Buffer) {
  const hash = createHash("sha256")
    .update(route.deploymentId)
    .update("\0")
    .update(resolvedPath)
    .update("\0")
    .update(body)
    .digest("base64url");

  return `W/"${hash}"`;
}

function ifNoneMatchValues(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value.join(",") : value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requestHasMatchingEtag(request: IncomingMessage, etag: string) {
  const values = ifNoneMatchValues(request.headers["if-none-match"]);
  return values.includes("*") || values.some((value) => weakEtagMatches(value, etag));
}

function weakEtagMatches(candidate: string, etag: string) {
  const normalize = (value: string) => value.startsWith("W/") ? value.slice(2) : value;

  return normalize(candidate) === normalize(etag);
}

function strongEtagMatches(candidate: string, etag: string) {
  return !candidate.startsWith("W/") && !etag.startsWith("W/") && candidate === etag;
}

function requestIfMatchPasses(request: IncomingMessage, etag: string) {
  const values = ifNoneMatchValues(request.headers["if-match"]);

  if (!values.length) {
    return true;
  }

  return values.includes("*") || values.some((value) => strongEtagMatches(value, etag));
}

function requestHasFreshModifiedSince(request: IncomingMessage, modifiedAt: Date) {
  if (request.headers["if-none-match"]) {
    return false;
  }

  const value = singleRangeHeader(request.headers["if-modified-since"]);

  if (!value) {
    return false;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Math.floor(modifiedAt.getTime() / 1000) <= Math.floor(timestamp / 1000);
}

function requestIfUnmodifiedSincePasses(request: IncomingMessage, modifiedAt: Date) {
  if (request.headers["if-match"]) {
    return true;
  }

  const value = singleRangeHeader(request.headers["if-unmodified-since"]);

  if (!value) {
    return true;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return true;
  }

  return Math.floor(modifiedAt.getTime() / 1000) <= Math.floor(timestamp / 1000);
}

function requestPreconditionsPass(request: IncomingMessage, etag: string, modifiedAt: Date) {
  return requestIfMatchPasses(request, etag) && requestIfUnmodifiedSincePasses(request, modifiedAt);
}

interface ByteRange {
  start: number;
  end: number;
}

interface EncodedArtifactFile {
  filePath: string;
  encoding?: "br" | "gzip";
}

interface EncodedArtifactCandidate extends EncodedArtifactFile {
  quality: number;
}

function singleRangeHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function parseByteRange(value: string | string[] | undefined, size: number): ByteRange | "invalid" | undefined {
  const header = singleRangeHeader(value)?.trim();

  if (!header) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header);

  if (!match) {
    return "invalid";
  }

  const [, startText, endText] = match;

  if (!startText && !endText) {
    return "invalid";
  }

  if (!startText) {
    const suffixLength = Number(endText);

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }

    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    };
  }

  const start = Number(startText);
  const end = endText ? Number(endText) : size - 1;

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return "invalid";
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

function requestIfRangeMatches(request: IncomingMessage, etag: string, modifiedAt: Date) {
  const value = singleRangeHeader(request.headers["if-range"])?.trim();

  if (!value) {
    return true;
  }

  if (value.startsWith("\"") || value.startsWith("W/\"")) {
    return strongEtagMatches(value, etag);
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Math.floor(modifiedAt.getTime() / 1000) <= Math.floor(timestamp / 1000);
}

function acceptedEncodingQuality(value: string | string[] | undefined, encoding: "br" | "gzip") {
  const header = singleRangeHeader(value);

  if (!header) {
    return 0;
  }

  const qualities = new Map<string, number>();

  for (const rawEntry of header.split(",")) {
    const [rawToken, ...rawParameters] = rawEntry.split(";");
    const token = rawToken.trim().toLowerCase();

    if (!token) {
      continue;
    }

    const qualityParameter = rawParameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="));
    const parsedQuality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
    const quality = Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0;
    qualities.set(token, Math.max(qualities.get(token) ?? 0, quality));
  }

  if (qualities.has(encoding)) {
    return qualities.get(encoding) ?? 0;
  }

  return qualities.get("*") ?? 0;
}

async function selectEncodedArtifactFile(request: IncomingMessage, filePath: string): Promise<EncodedArtifactFile> {
  if (request.headers.range) {
    return { filePath };
  }

  const encodedArtifacts: EncodedArtifactFile[] = [
    { filePath: `${filePath}.br`, encoding: "br" },
    { filePath: `${filePath}.gz`, encoding: "gzip" }
  ];
  const candidates: EncodedArtifactCandidate[] = encodedArtifacts
    .map((candidate): EncodedArtifactCandidate => ({
      ...candidate,
      quality: candidate.encoding ? acceptedEncodingQuality(request.headers["accept-encoding"], candidate.encoding) : 0
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality);

  for (const candidate of candidates) {
    const candidateStat = await stat(candidate.filePath).catch(() => undefined);

    if (candidateStat?.isFile()) {
      return candidate;
    }
  }

  return { filePath };
}

function imageRouteHost(request: IncomingMessage, options?: SiteFlowServerOptions) {
  const rawHost = requestHost(request, options);
  return rawHost.toLowerCase().split(":")[0];
}

function normalizedImageFormat(value: string | null, config?: PrebuiltImageConfig) {
  const format = value ?? "auto";

  if (format === "jpg") {
    return "jpeg";
  }

  if (format !== "auto" && format !== "avif" && format !== "webp" && format !== "png" && format !== "jpeg") {
    throw new ImageOptimizationInputError("Image parameter format must be auto, avif, webp, png, or jpeg.");
  }

  const allowedFormats = config?.formats?.map((entry) => entry.replace(/^image\//, ""));

  if (allowedFormats?.length && format !== "auto" && !allowedFormats.includes(format)) {
    throw new ImageOptimizationInputError(`Image parameter format must be one of: ${allowedFormats.join(", ")}.`);
  }

  return format;
}

function imageContentType(format: string, sourceContentType: string) {
  if (format === "auto") {
    return sourceContentType;
  }

  if (format === "jpeg") {
    return "image/jpeg";
  }

  return `image/${format}`;
}

function assertSafeImageSource(value: string | null) {
  const source = value?.trim();

  if (!source) {
    throw new ImageOptimizationInputError("Image parameter url is required.");
  }

  if (/^https?:\/\//i.test(source) || source.startsWith("//")) {
    throw new ImageOptimizationInputError("External image sources are not supported.", 400);
  }

  if (/[?&](token|secret|key|password)=/i.test(source)) {
    throw new ImageOptimizationInputError("Image source URL must not include secret-bearing query parameters.");
  }

  return source;
}

function safeImageArtifactPath(source: string) {
  if (!source.startsWith("/")) {
    throw new ImageOptimizationInputError("Artifact image sources must start with /.");
  }

  const normalized = path.posix.normalize(source.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new ImageOptimizationInputError("Image source path is invalid.");
  }

  return `/${normalized}`;
}

async function readArtifactImage(route: ArtifactRoute, source: string) {
  const root = path.resolve(route.artifactRoot);
  const relativePath = safeImageArtifactPath(source).replace(/^\/+/, "");
  const filePath = path.resolve(root, ...relativePath.split("/"));

  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new ImageOptimizationInputError("Image source path escapes deployment root.");
  }

  const fileStat = await stat(filePath).catch(() => undefined);

  if (!fileStat?.isFile()) {
    throw new SiteFlowNotFoundError("Image source was not found.");
  }

  const contentType = contentTypeFor(filePath);

  if (!contentType.startsWith("image/")) {
    throw new ImageOptimizationInputError("Image source must resolve to an image content type.");
  }

  return {
    bytes: await readFile(filePath),
    contentType,
    modifiedAt: fileStat.mtime,
    sourceId: `${route.deploymentId}:${relativePath}`
  };
}

function assertImageWidthAllowed(width: number, config?: PrebuiltImageConfig) {
  if (config?.sizes?.length && !config.sizes.includes(width)) {
    throw new ImageOptimizationInputError(`Image parameter w must be one of: ${config.sizes.join(", ")}.`);
  }
}

function assertImageQualityAllowed(quality: number, config?: PrebuiltImageConfig) {
  if (config?.qualities?.length && !config.qualities.includes(quality)) {
    throw new ImageOptimizationInputError(`Image parameter q must be one of: ${config.qualities.join(", ")}.`);
  }
}

function cacheControlForImage(config?: PrebuiltImageConfig) {
  const ttl = config?.minimumCacheTTL;
  return ttl === undefined
    ? "public, max-age=31536000, immutable"
    : `public, max-age=${ttl}`;
}

async function readBlobImage(repository: SiteFlowReadRepository, route: ArtifactRoute, source: string) {
  if (!route.projectId) {
    throw new ImageOptimizationInputError("Blob image sources require a project-scoped route.");
  }

  const pathname = source.slice("blob:".length).replace(/^\/+/, "");

  if (!pathname || pathname.startsWith("../") || pathname.includes("/../")) {
    throw new ImageOptimizationInputError("Blob image source is invalid.");
  }

  const result = await repository.getBlob({
    projectId: route.projectId,
    pathname
  });

  if (!result.blob.contentType.startsWith("image/")) {
    throw new ImageOptimizationInputError("Blob image source must resolve to an image content type.");
  }

  return {
    bytes: Buffer.from(result.contentBase64, "base64"),
    contentType: result.blob.contentType,
    modifiedAt: new Date(result.blob.updatedAt),
    sourceId: `${route.projectId}:${result.blob.sha256}:${result.blob.pathname}`
  };
}

function imageCacheKey(parts: { sourceId: string; width: number; quality: number; format: string }) {
  return createHash("sha256")
    .update(`${parts.sourceId}:${parts.width}:${parts.quality}:${parts.format}`)
    .digest("hex")
    .slice(0, 24);
}

function normalizeFunctionPath(value: string) {
  const normalized = value.replace(/\/+$/, "");
  return normalized || "/";
}

function functionForPath(functions: FunctionEntrypoint[] | undefined, pathname: string) {
  const normalizedPath = normalizeFunctionPath(pathname);
  return functions?.find((entry) => normalizeFunctionPath(entry.path) === normalizedPath);
}

function pathMatchesPattern(pathname: string, pattern: string) {
  if (pattern === "/(.*)" || pattern === "/:path*" || pattern === "/:path*?") {
    return pathname.startsWith("/");
  }

  if (pattern.endsWith("*")) {
    return pathname.startsWith(pattern.slice(0, -1));
  }

  if (pattern.includes(":")) {
    const pathSegments = pathname.split("/").filter(Boolean);
    const patternSegments = pattern.split("/").filter(Boolean);

    for (let index = 0; index < patternSegments.length; index += 1) {
      const segment = patternSegments[index];
      const pathSegment = pathSegments[index];

      if (segment.startsWith(":") && segment.endsWith("*")) {
        return true;
      }

      if (pathSegment === undefined) {
        return false;
      }

      if (segment.startsWith(":")) {
        continue;
      }

      if (segment !== pathSegment) {
        return false;
      }
    }

    return pathSegments.length === patternSegments.length;
  }

  return pathname === pattern;
}

function safeFunctionPath(route: ArtifactRoute, sourcePath: string) {
  const root = path.resolve(route.artifactRoot);
  const relativePath = path.posix.normalize(sourcePath.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath.includes("/../")) {
    throw new SiteFlowNotFoundError("Function artifact path is invalid.");
  }

  const functionPath = path.resolve(root, ...relativePath.split("/"));

  if (!functionPath.startsWith(`${root}${path.sep}`)) {
    throw new SiteFlowNotFoundError("Function artifact path escapes deployment root.");
  }

  return functionPath;
}

function safeRoutePath(urlPath: string, entrypoint: string) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const rawPath = decoded === "/" ? entrypoint : decoded;
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return entrypoint;
  }

  return normalized;
}

function cleanUrlCandidate(routePath: string) {
  if (path.posix.extname(routePath) || routePath.endsWith("/")) {
    return undefined;
  }

  const normalized = path.posix.normalize(routePath.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return undefined;
  }

  return `${normalized}.html`;
}

async function tryResolveArtifactPath(root: string, relativePath: string): Promise<string | undefined> {
  if (relativePath.startsWith(".siteflow/functions/")) {
    throw new SiteFlowNotFoundError("Artifact route path was not found.");
  }

  const candidate = path.resolve(root, ...relativePath.split("/"));

  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new SiteFlowNotFoundError("Artifact route path is invalid.");
  }

  const fileStat = await stat(candidate).catch(() => undefined);
  return fileStat?.isFile() ? candidate : undefined;
}

async function resolveArtifactFile(route: ArtifactRoute, urlPath: string) {
  const root = path.resolve(route.artifactRoot);
  const relativePath = safeRoutePath(urlPath, route.entrypoint);
  const candidate = await tryResolveArtifactPath(root, relativePath);

  if (candidate) {
    return {
      filePath: candidate,
      resolvedPath: relativePath
    };
  }

  if (relativePath.endsWith("/")) {
    const indexCandidate = `${relativePath}index.html`;
    const indexFile = await tryResolveArtifactPath(root, indexCandidate);

    if (indexFile) {
      return {
        filePath: indexFile,
        resolvedPath: indexCandidate
      };
    }

    throw new SiteFlowNotFoundError("Artifact route path was not found.");
  }

  if (route.cleanUrls) {
    const cleanCandidate = cleanUrlCandidate(urlPath);
    const cleanFile = cleanCandidate ? await tryResolveArtifactPath(root, cleanCandidate) : undefined;

    if (cleanCandidate && cleanFile) {
      return {
        filePath: cleanFile,
        resolvedPath: cleanCandidate
      };
    }
  }

  const fallback = path.resolve(root, ...route.entrypoint.split("/"));

  if (!fallback.startsWith(`${root}${path.sep}`)) {
    throw new SiteFlowNotFoundError("Artifact entrypoint is invalid.");
  }

  const fallbackStat = await stat(fallback).catch(() => undefined);

  if (!fallbackStat?.isFile()) {
    throw new SiteFlowNotFoundError("Artifact entrypoint was not found.");
  }

  return {
    filePath: fallback,
    resolvedPath: route.entrypoint
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactionPatternsFor(values: Record<string, string> | undefined) {
  return Object.values(values ?? {})
    .filter((value) => value.length >= 4)
    .map((value) => new RegExp(escapeRegExp(value), "g"));
}

function captureLogArg(value: unknown, secretPatterns: RegExp[]) {
  const redactionOptions = { extraPatterns: secretPatterns };

  if (typeof value === "string") {
    return redactLogLine(value, redactionOptions);
  }

  try {
    const logValue = value instanceof Error
      ? {
          name: value.name,
          message: value.message,
          stack: value.stack,
          ...Object.fromEntries(Object.entries(value))
        }
      : value;
    const serialized = JSON.stringify(redactSecrets(logValue, redactionOptions));

    return typeof serialized === "string"
      ? redactLogLine(serialized, redactionOptions)
      : redactLogLine(String(serialized), redactionOptions);
  } catch {
    return "[unserializable]";
  }
}

async function withRuntimeEnvironment<T>(environment: Record<string, string> | undefined, callback: () => Promise<T>) {
  const entries = Object.entries(environment ?? {});
  const previous = new Map(entries.map(([key]) => [key, process.env[key]]));

  for (const [key, value] of entries) {
    process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function captureFunctionLogs<T>(callback: () => Promise<T>, secretPatterns: RegExp[] = []) {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args: unknown[]) => {
    logs.push(args.map((arg) => captureLogArg(arg, secretPatterns)).join(" "));
  };

  console.log = capture;
  console.warn = capture;
  console.error = capture;

  try {
    return {
      value: await callback(),
      logs
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function functionConcurrencyKey(route: ArtifactRoute, entry: FunctionEntrypoint) {
  return `${route.deploymentId}:${entry.path}`;
}

function memoryLimitExceeded(entry: FunctionEntrypoint) {
  const memoryMb = entry.memoryMb ?? 512;
  const rssMb = process.memoryUsage().rss / (1024 * 1024);

  return rssMb > memoryMb;
}

function currentFunctionConcurrency(route: ArtifactRoute, entry: FunctionEntrypoint) {
  return functionConcurrency.get(functionConcurrencyKey(route, entry)) ?? 0;
}

function enterFunctionInvocation(route: ArtifactRoute, entry: FunctionEntrypoint) {
  const key = functionConcurrencyKey(route, entry);
  functionConcurrency.set(key, (functionConcurrency.get(key) ?? 0) + 1);

  return () => {
    const next = (functionConcurrency.get(key) ?? 1) - 1;

    if (next <= 0) {
      functionConcurrency.delete(key);
    } else {
      functionConcurrency.set(key, next);
    }
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Function invocation timed out after ${timeoutMs}ms.`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

interface IsolatedFunctionRuntimeResponse {
  status: number;
  headers: [string, string][];
  setCookie?: string[];
  bodyBase64?: string;
}

interface IsolatedFunctionRuntimeResult {
  response: Response;
  logs: string[];
}

class IsolatedFunctionRuntimeError extends Error {
  readonly logs: string[];

  constructor(message: string, logs: string[] = []) {
    super(message);
    this.name = "IsolatedFunctionRuntimeError";
    this.logs = logs;
  }
}

const isolatedFunctionRunnerScript = String.raw`
const { createWriteStream } = require("node:fs");
const { pathToFileURL } = require("node:url");

const protocol = createWriteStream(null, { fd: 3 });
const logs = [];

function send(payload) {
  protocol.end(JSON.stringify({ ...payload, logs }));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function serializeLogArg(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    if (value instanceof Error) {
      return JSON.stringify({
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...Object.fromEntries(Object.entries(value))
      });
    }

    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return "[unserializable]";
  }
}

for (const method of ["log", "warn", "error"]) {
  console[method] = (...args) => {
    logs.push(args.map(serializeLogArg).join(" "));
  };
}

function responseStatusForbidsBody(status) {
  return status === 204 || status === 205 || status === 304;
}

function responseBody(value) {
  if (typeof value === "string" || value instanceof ArrayBuffer) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }

  return String(value);
}

function responseHeadersFromObject(value) {
  const headers = new Headers();

  for (const [key, rawValue] of Object.entries(value ?? {})) {
    if (typeof rawValue === "string") {
      headers.set(key, rawValue);
      continue;
    }

    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) {
        if (typeof entry === "string") {
          headers.append(key, entry);
        }
      }
    }
  }

  return headers;
}

function runtimeResultToResponse(result) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined || result === null) {
    return new Response(null, { status: 204 });
  }

  if (typeof result === "string" || result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
    return new Response(responseBody(result));
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const status = typeof result.status === "number" ? result.status : 200;
    const headers = responseHeadersFromObject(result.headers && typeof result.headers === "object" && !Array.isArray(result.headers) ? result.headers : undefined);
    const body = result.body;

    if (responseStatusForbidsBody(status)) {
      return new Response(null, { status, headers });
    }

    if (body === undefined || body === null) {
      return new Response(null, { status, headers });
    }

    if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return new Response(responseBody(body), { status, headers });
    }

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }

    return new Response(JSON.stringify(body), { status, headers });
  }

  return new Response(String(result));
}

async function sendRuntimeResponse(runtimeResponse) {
  const body = responseStatusForbidsBody(runtimeResponse.status)
    ? Buffer.alloc(0)
    : Buffer.from(await runtimeResponse.arrayBuffer());
  const setCookie = typeof runtimeResponse.headers.getSetCookie === "function"
    ? runtimeResponse.headers.getSetCookie()
    : [];
  const headers = [];

  runtimeResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookie.length > 0) {
      return;
    }

    headers.push([key, value]);
  });

  send({
    ok: true,
    response: {
      status: runtimeResponse.status,
      headers,
      setCookie,
      bodyBase64: body.toString("base64")
    }
  });
}

function createNodeCompat(runtimeRequest, requestBody, runtimeContext) {
  const requestUrl = new URL(runtimeRequest.url);
  const headers = new Map();
  const chunks = [];
  let statusCode = 200;
  let settled = false;
  let resolveResponse;
  const settledPromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const appendMultiValue = (target, key, value) => {
    const current = target[key];
    target[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  };
  const requestHeadersObject = (source) => {
    const next = {};
    source.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      next[lowerKey] = next[lowerKey] ? next[lowerKey] + ", " + value : value;
    });
    return next;
  };
  const requestQueryObject = (searchParams) => {
    const next = {};
    searchParams.forEach((value, key) => appendMultiValue(next, key, value));
    return next;
  };
  const requestCookiesObject = (cookieHeader) => {
    const cookies = {};
    for (const entry of (cookieHeader || "").split(";")) {
      const index = entry.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const key = entry.slice(0, index).trim();
      if (!key) {
        continue;
      }
      try {
        cookies[key] = decodeURIComponent(entry.slice(index + 1).trim());
      } catch {
        cookies[key] = entry.slice(index + 1).trim();
      }
    }
    return cookies;
  };
  const parseRequestBody = () => {
    if (!requestBody || requestBody.byteLength === 0) {
      return undefined;
    }
    const contentType = (runtimeRequest.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType === "application/json") {
      try {
        return JSON.parse(requestBody.toString("utf8"));
      } catch (_e) {
        return requestBody;
      }
    }
    if (contentType === "application/x-www-form-urlencoded") {
      return requestQueryObject(new URLSearchParams(requestBody.toString("utf8")));
    }
    if (contentType.startsWith("text/")) {
      return requestBody.toString("utf8");
    }
    return requestBody;
  };
  const bodyChunk = (value) => {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (typeof value === "string") {
      return Buffer.from(value, "utf8");
    }
    if (value instanceof ArrayBuffer) {
      return Buffer.from(value);
    }
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return Buffer.from(String(value), "utf8");
  };
  const applyHeaders = (nextHeaders) => {
    if (!nextHeaders) {
      return;
    }
    if (nextHeaders instanceof Headers) {
      nextHeaders.forEach((value, key) => headers.set(key.toLowerCase(), { key, value }));
      return;
    }
    for (const [key, value] of Object.entries(nextHeaders)) {
      if (value !== undefined) {
        headers.set(key.toLowerCase(), { key, value });
      }
    }
  };
  const responseHeaders = () => {
    const next = new Headers();
    for (const { key, value } of headers.values()) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          next.append(key, entry);
        }
      } else {
        next.set(key, String(value));
      }
    }
    return next;
  };
  const finalize = () => {
    if (settled) {
      return;
    }
    settled = true;
    res.headersSent = true;
    resolveResponse(new Response(responseStatusForbidsBody(statusCode) ? null : Buffer.concat(chunks), {
      status: statusCode,
      headers: responseHeaders()
    }));
  };
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
    headersSent: false,
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader(key, value) {
      headers.set(key.toLowerCase(), { key, value });
      return res;
    },
    getHeader(key) {
      return headers.get(key.toLowerCase())?.value;
    },
    removeHeader(key) {
      headers.delete(key.toLowerCase());
      return res;
    },
    writeHead(code, nextHeaders) {
      statusCode = code;
      applyHeaders(nextHeaders);
      return res;
    },
    write(chunk) {
      res.headersSent = true;
      chunks.push(bodyChunk(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) {
        res.write(chunk);
      }
      finalize();
      return res;
    },
    json(value) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(value));
    },
    send(value) {
      if (value === undefined || value === null) {
        return res.end();
      }
      if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        if (!res.getHeader("content-type")) {
          res.setHeader("content-type", "application/octet-stream");
        }
        return res.end(value);
      }
      if (typeof value === "object") {
        return res.json(value);
      }
      if (!res.getHeader("content-type")) {
        res.setHeader("content-type", "text/plain; charset=utf-8");
      }
      return res.end(String(value));
    },
    redirect(statusOrLocation, location) {
      const code = typeof statusOrLocation === "number" ? statusOrLocation : 302;
      const target = typeof statusOrLocation === "number" ? location : statusOrLocation;
      statusCode = code;
      if (target) {
        res.setHeader("location", target);
      }
      return res.end();
    },
    settled() {
      return settledPromise;
    }
  };
  return {
    req: {
      method: runtimeRequest.method,
      url: requestUrl.pathname + requestUrl.search,
      headers: requestHeadersObject(runtimeRequest.headers),
      query: requestQueryObject(requestUrl.searchParams),
      cookies: requestCookiesObject(runtimeRequest.headers.get("cookie")),
      body: parseRequestBody(),
      params: runtimeContext.params
    },
    res
  };
}

(async () => {
  try {
    const payload = JSON.parse(await readStdin());
    const requestBody = payload.request.bodyBase64 === undefined
      ? undefined
      : Buffer.from(payload.request.bodyBase64, "base64");
    const request = new Request(payload.request.url, {
      method: payload.request.method,
      headers: payload.request.headers,
      body: requestBody,
      ...(requestBody ? { duplex: "half" } : {})
    });
    const runtimeModule = await import(pathToFileURL(payload.modulePath).href + "?siteflow_invocation=" + encodeURIComponent(payload.requestId));
    const handler = payload.handler === "handler" ? runtimeModule.handler : runtimeModule.default ?? runtimeModule.handler;

    if (typeof handler !== "function") {
      throw new Error("Function " + payload.functionPath + " does not export a callable handler.");
    }

    if (payload.apiStyle === "node") {
      const { req, res } = createNodeCompat(request, requestBody, payload.context);
      const returned = await handler(req, res);
      await sendRuntimeResponse((returned !== null && returned !== undefined && returned !== res) ? runtimeResultToResponse(returned) : await res.settled());
    } else {
      const runtimeResponse = await runtimeResultToResponse(await handler(request, payload.context));
      await sendRuntimeResponse(runtimeResponse);
    }
  } catch (error) {
    send({
      ok: false,
      errorMessage: error instanceof Error ? error.message : "Function invocation failed."
    });
    process.exitCode = 1;
  }
})().catch((error) => {
  send({
    ok: false,
    errorMessage: error instanceof Error ? error.message : "Function invocation failed."
  });
  process.exitCode = 1;
});
`;

function isolatedFunctionEnvironment(runtimeEnvironment: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...runtimeEnvironment };

  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined && environment[key] === undefined) {
      environment[key] = process.env[key];
    }
  }

  environment.SITEFLOW_FUNCTION_RUNTIME_ISOLATION = "isolated_process";
  return environment;
}

async function readProcessPipe(pipe: NodeJS.ReadableStream | null | undefined): Promise<Buffer> {
  if (!pipe) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];

  for await (const chunk of pipe) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function childOutputLogs(buffer: Buffer, label: string, secretPatterns: RegExp[]) {
  const text = buffer.toString("utf8").trim();

  if (!text) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => redactLogLine(`${label}: ${line}`, { extraPatterns: secretPatterns }));
}

function isolatedRuntimeHeaders(headers: [string, string][], setCookie: string[] | undefined) {
  const next = new Headers(headers);

  for (const cookie of setCookie ?? []) {
    next.append("set-cookie", cookie);
  }

  return next;
}

function headerEntries(headers: Headers): [string, string][] {
  const entries: [string, string][] = [];
  headers.forEach((value, key) => entries.push([key, value]));
  return entries;
}

function isolatedRuntimeResponse(payload: IsolatedFunctionRuntimeResponse) {
  const body = payload.bodyBase64 ? Buffer.from(payload.bodyBase64, "base64") : undefined;

  return new Response(responseStatusForbidsBody(payload.status) ? null : body, {
    status: payload.status,
    headers: isolatedRuntimeHeaders(payload.headers, payload.setCookie)
  });
}

function parseIsolatedRuntimeProtocol(value: Buffer) {
  if (value.byteLength === 0) {
    throw new Error("Isolated function runtime did not return a protocol response.");
  }

  const parsed: unknown = JSON.parse(value.toString("utf8"));

  if (!isRecord(parsed)) {
    throw new Error("Isolated function runtime returned an invalid protocol response.");
  }

  return parsed;
}

async function invokeIsolatedFunction(
  functionPath: string,
  entry: FunctionEntrypoint,
  request: Request,
  requestBody: Buffer | undefined,
  context: {
    params: Record<string, string>;
    path: string;
    requestId: string;
    deploymentId: string;
    env: Record<string, string>;
  },
  timeoutMs: number,
  secretPatterns: RegExp[]
): Promise<IsolatedFunctionRuntimeResult> {
  const child = spawn(process.execPath, ["-e", isolatedFunctionRunnerScript], {
    env: isolatedFunctionEnvironment(context.env),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const protocolPipe = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
  const stdout = readProcessPipe(child.stdout);
  const stderr = readProcessPipe(child.stderr);
  const protocol = readProcessPipe(protocolPipe);
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(JSON.stringify({
    modulePath: functionPath,
    handler: entry.handler,
    apiStyle: entry.apiStyle ?? "fetch",
    functionPath: entry.path,
    requestId: context.requestId,
    request: {
      url: request.url,
      method: request.method,
      headers: headerEntries(request.headers),
      bodyBase64: requestBody ? requestBody.toString("base64") : undefined
    },
    context
  }));

  try {
    const [exit, stdoutBuffer, stderrBuffer, protocolBuffer] = await Promise.all([close, stdout, stderr, protocol]);
    const directLogs = [
      ...childOutputLogs(stdoutBuffer, "stdout", secretPatterns),
      ...childOutputLogs(stderrBuffer, "stderr", secretPatterns)
    ];

    if (timedOut) {
      throw new IsolatedFunctionRuntimeError(`Function invocation timed out after ${timeoutMs}ms.`, directLogs);
    }

    const payload = parseIsolatedRuntimeProtocol(protocolBuffer);
    const runtimeLogs = Array.isArray(payload.logs)
      ? payload.logs
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => redactLogLine(entry, { extraPatterns: secretPatterns }))
      : [];
    const logs = [...runtimeLogs, ...directLogs];

    if (payload.ok !== true) {
      throw new IsolatedFunctionRuntimeError(
        typeof payload.errorMessage === "string" ? payload.errorMessage : "Function invocation failed.",
        logs
      );
    }

    if (!isRecord(payload.response)) {
      throw new IsolatedFunctionRuntimeError("Isolated function runtime returned an invalid response.", logs);
    }

    const responsePayload = payload.response;

    if (
      typeof responsePayload.status !== "number" ||
      !Array.isArray(responsePayload.headers) ||
      !responsePayload.headers.every((header) => Array.isArray(header) && typeof header[0] === "string" && typeof header[1] === "string") ||
      (responsePayload.setCookie !== undefined && (!Array.isArray(responsePayload.setCookie) || !responsePayload.setCookie.every((cookie) => typeof cookie === "string"))) ||
      (responsePayload.bodyBase64 !== undefined && typeof responsePayload.bodyBase64 !== "string")
    ) {
      throw new IsolatedFunctionRuntimeError("Isolated function runtime returned an invalid response payload.", logs);
    }

    if (exit.code !== 0) {
      throw new IsolatedFunctionRuntimeError(`Isolated function runtime exited with code ${exit.code ?? "unknown"}.`, logs);
    }

    return {
      response: isolatedRuntimeResponse(responsePayload as unknown as IsolatedFunctionRuntimeResponse),
      logs
    };
  } finally {
    clearTimeout(timeout);
  }
}

function responseHeadersFromObject(value: Record<string, unknown> | undefined) {
  const headers = new Headers();

  for (const [key, rawValue] of Object.entries(value ?? {})) {
    if (typeof rawValue === "string") {
      headers.set(key, rawValue);
      continue;
    }

    if (Array.isArray(rawValue)) {
      rawValue.forEach((entry) => {
        if (typeof entry === "string") {
          headers.append(key, entry);
        }
      });
    }
  }

  return headers;
}

function headerValueFromRule(value: string, pathname: string) {
  return value.replaceAll(":path", pathname);
}

function mergeVaryHeader(existingValue: number | string | string[] | undefined, nextValue: string) {
  return mergeCommaHeader(existingValue, nextValue);
}

function mergeCommaHeader(existingValue: number | string | string[] | undefined, nextValue: string) {
  const values = new Map<string, string>();

  for (const value of [existingValue, nextValue].flatMap((entry) => Array.isArray(entry) ? entry : [entry])) {
    if (value === undefined) {
      continue;
    }

    for (const token of String(value).split(",")) {
      const normalized = token.trim().toLowerCase();

      if (normalized && !values.has(normalized)) {
        values.set(normalized, token.trim());
      }
    }
  }

  return [...values.values()].join(", ");
}

function applyRoutingHeaders(response: ServerResponse, rules: RoutingRule[] | undefined, pathname: string) {
  for (const rule of rules ?? []) {
    for (const header of rule.headers ?? []) {
      const value = headerValueFromRule(header.value, pathname);

      if (header.key.toLowerCase() === "vary") {
        response.setHeader(header.key, mergeVaryHeader(response.getHeader(header.key), value));
        continue;
      }

      response.setHeader(header.key, value);
    }
  }
}

function redirectLocation(rule: RoutingRule, pathname: string) {
  return applyRoutingDestination(pathname, rule.source, rule.destination) ?? pathname;
}

function appendSearchToRedirectLocation(location: string, search: string) {
  if (!search) {
    return location;
  }

  const [target, fragment] = location.split("#", 2);
  const separator = target.includes("?") ? "&" : "?";
  return `${target}${separator}${search.slice(1)}${fragment ? `#${fragment}` : ""}`;
}

function routingRedirectLocation(rule: RoutingRule, pathname: string, url: URL) {
  const location = redirectLocation(rule, pathname);
  return appendSearchToRedirectLocation(location, url.search);
}

function routingParams(pathname: string, pattern: string) {
  const params = new Map<string, string>();
  const pathSegments = pathname.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);

  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];

    if (!segment.startsWith(":")) {
      continue;
    }

    if (segment.endsWith("*")) {
      params.set(segment.slice(1, -1), pathSegments.slice(index).join("/"));
      break;
    }

    params.set(segment.slice(1), pathSegments[index] ?? "");
  }

  return params;
}

function applyRoutingDestination(pathname: string, source: string, destination: string | undefined) {
  if (!destination) {
    return undefined;
  }

  const params = routingParams(pathname, source);
  let nextPath = destination;

  for (const [key, value] of params) {
    nextPath = nextPath.replaceAll(`:${key}*`, value).replaceAll(`:${key}`, value);
  }

  return nextPath;
}

function matchArtifactRoutingRules(route: ArtifactRoute, pathname: string): RoutingMatch {
  const redirects = route.routingRules?.redirects ?? [];
  const rewrites = route.routingRules?.rewrites ?? [];
  const headers = route.routingRules?.headers ?? [];
  const redirect = redirects.find((rule) => pathMatchesPattern(pathname, rule.source));
  const rewrite = redirect ? undefined : rewrites.find((rule) => pathMatchesPattern(pathname, rule.source));

  return {
    redirect,
    rewrite,
    headers: headers.filter((rule) => pathMatchesPattern(pathname, rule.source)),
    rewrittenPath: rewrite ? applyRoutingDestination(pathname, rewrite.source, rewrite.destination) : undefined
  };
}

function canonicalStaticLocation(pathname: string, route: ArtifactRoute, resolved?: ResolvedArtifactFile) {
  if (route.cleanUrls && pathname.endsWith(".html")) {
    const cleanPath = pathname.slice(0, -".html".length) || "/";
    return cleanPath;
  }

  if (route.skipTrailingSlashRedirect) {
    return undefined;
  }

  if (route.trailingSlash === true && pathname !== "/" && !pathname.endsWith("/") && resolved?.resolvedPath.endsWith("index.html")) {
    return `${pathname}/`;
  }

  if (route.trailingSlash === false && pathname !== "/" && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "") || "/";
  }

  return undefined;
}

function staticCanonicalRedirectLocation(location: string, url: URL) {
  return appendSearchToRedirectLocation(location, url.search);
}

function redirectStaticCanonical(response: ServerResponse, location: string, url: URL, allowedOrigin?: string) {
  response.statusCode = 308;
  if (allowedOrigin) {
    setCorsHeaders(response, allowedOrigin);
  }
  response.setHeader("location", staticCanonicalRedirectLocation(location, url));
  response.setHeader("x-siteflow-static-redirect", "canonical");
  response.end();
}

function setDefaultStaticSecurityHeaders(response: ServerResponse) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
}

function endResponseWithoutBody(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.removeHeader("content-length");
  response.end();
}

function setRoutingResponseHeaders(response: ServerResponse, match: RoutingMatch | undefined, pathname: string) {
  if (!match) {
    return;
  }

  applyRoutingHeaders(response, match.headers, match.rewrittenPath ?? pathname);

  if (match.rewrite) {
    response.setHeader("x-siteflow-rewrite", match.rewrite.id);
  }
}

function responseBody(value: string | Uint8Array | ArrayBuffer): BodyInit {
  if (typeof value === "string" || value instanceof ArrayBuffer) {
    return value;
  }

  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function responseStatusForbidsBody(status: number) {
  return status === 204 || status === 205 || status === 304;
}

function runtimeResultToResponse(result: unknown) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined || result === null) {
    return new Response(null, { status: 204 });
  }

  if (typeof result === "string" || result instanceof Uint8Array || result instanceof ArrayBuffer) {
    return new Response(responseBody(result));
  }

  if (isRecord(result)) {
    const status = typeof result.status === "number" ? result.status : 200;
    const headers = responseHeadersFromObject(isRecord(result.headers) ? result.headers : undefined);
    const body = result.body;

    if (responseStatusForbidsBody(status)) {
      return new Response(null, { status, headers });
    }

    if (body === undefined || body === null) {
      return new Response(null, { status, headers });
    }

    if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      return new Response(responseBody(body), { status, headers });
    }

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }

    return new Response(JSON.stringify(body), { status, headers });
  }

  return new Response(String(result));
}

function runtimeSetCookieHeaders(headers: Headers) {
  const readableHeaders = headers as Headers & { getSetCookie?: () => string[] };

  return typeof readableHeaders.getSetCookie === "function" ? readableHeaders.getSetCookie() : [];
}

function setRuntimeResponseHeaders(response: ServerResponse, headers: Headers) {
  const setCookieHeaders = runtimeSetCookieHeaders(headers);

  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookieHeaders.length > 0) {
      return;
    }

    response.setHeader(key, value);
  });

  if (setCookieHeaders.length > 0) {
    response.setHeader("set-cookie", setCookieHeaders);
  }
}

async function invokeFunctionRoute(context: RouteContext, route: ArtifactRoute, entry: FunctionEntrypoint, options: SiteFlowServerOptions, routingMatch?: RoutingMatch) {
  const { request, response, url } = context;
  const requestId = `req_${randomUUID().replace(/-/g, "")}`;
  const startedAt = performance.now();
  const requestMethod = request.method ?? "GET";
  let responseStatus = 500;
  let logs: string[] = [];
  let errorMessage: string | undefined;
  const runtimeEnvironment = route.runtimeEnvironment ?? {};
  const secretPatterns = redactionPatternsFor(runtimeEnvironment);
  const timeoutMs = entry.timeoutMs ?? 10000;
  const concurrencyLimit = entry.concurrency ?? 50;
    // Keeping same_process as the default avoids per-request isolate spawn and module re-import
    // latency until a warm isolated_process pool exists.
    const runtimeIsolation = entry.runtimeIsolation ?? "same_process";
    const apiStyle = entry.apiStyle ?? "fetch";
  let releaseConcurrency: (() => void) | undefined;

  try {
    if (options.productionRuntime && runtimeIsolation !== "isolated_process" && !options.allowSameProcessFunctionRuntime) {
      responseStatus = 503;
      errorMessage = `Same-process function runtime is disabled in production for ${entry.path}.`;
      logs.push(redactLogLine(errorMessage, { extraPatterns: secretPatterns }));
      response.setHeader("x-siteflow-function-runtime", "disabled");
      sendJson(response, 503, { message: "Function runtime is disabled in production.", requestId }, options.allowedOrigin, requestMethod);
      return;
    }

    if (currentFunctionConcurrency(route, entry) >= concurrencyLimit) {
      responseStatus = 429;
      errorMessage = `Function concurrency limit exceeded for ${entry.path}.`;
      logs.push(redactLogLine(errorMessage, { extraPatterns: secretPatterns }));
      response.setHeader("retry-after", "1");
      sendJson(response, 429, { message: "Function concurrency limit exceeded.", requestId }, options.allowedOrigin, requestMethod);
      return;
    }

    if (memoryLimitExceeded(entry)) {
      responseStatus = 507;
      errorMessage = `Function memory limit exceeded for ${entry.path}.`;
      logs.push(redactLogLine(errorMessage, { extraPatterns: secretPatterns }));
      sendJson(response, 507, { message: "Function memory limit exceeded.", requestId }, options.allowedOrigin, requestMethod);
      return;
    }

    releaseConcurrency = enterFunctionInvocation(route, entry);
    const functionPath = safeFunctionPath(route, entry.sourcePath);
    const requestBody = requestMethod === "GET" || requestMethod === "HEAD" ? undefined : await readRawBody(request);
    const runtimeRequest = new Request(new URL(request.url ?? "/", requestOrigin(request, options)), {
      method: requestMethod,
      headers: requestHeaders(request),
      body: requestBody,
      ...(requestBody ? { duplex: "half" } : {})
    } as RequestInit & { duplex?: "half" });
    const runtimeContext = {
      params: {},
      path: url.pathname,
      requestId,
      deploymentId: route.deploymentId,
      env: runtimeEnvironment
    };
    let runtimeResponse: Response;

    if (runtimeIsolation === "isolated_process") {
      const isolated = await invokeIsolatedFunction(
        functionPath,
        entry,
        runtimeRequest,
        requestBody,
        runtimeContext,
        timeoutMs,
        secretPatterns
      );
      runtimeResponse = isolated.response;
      logs = isolated.logs;
      response.setHeader("x-siteflow-function-runtime", "isolated_process");
    } else {
      const module = await (options.functionModuleLoader ?? loadFunctionModule)(functionPath);
      const handler = entry.handler === "handler" ? module.handler : module.default ?? module.handler;

      if (typeof handler !== "function") {
        throw new Error(`Function ${entry.path} does not export a callable handler.`);
      }

      const captured = await captureFunctionLogs(
        () => withTimeout(
          withRuntimeEnvironment(
            runtimeEnvironment,
            apiStyle === "node"
              ? async () => {
                const { req, res } = createNodeCompat(runtimeRequest, requestBody, runtimeContext);
                const returned = await handler(req, res);
                // `res.status().json()` etc. return `res`; the idiomatic `return res.status(x).json(...)`
                // must resolve via res.settled(), NOT be treated as a returned Response.
                return (returned !== null && returned !== undefined && returned !== res) ? runtimeResultToResponse(returned) : await res.settled();
              }
              :
            async () => runtimeResultToResponse(await handler(runtimeRequest, runtimeContext))
          ),
          timeoutMs
        ),
        secretPatterns
      );
      runtimeResponse = captured.value;
      logs = captured.logs;
    }
    responseStatus = runtimeResponse.status;

    response.statusCode = runtimeResponse.status;
    setRuntimeResponseHeaders(response, runtimeResponse.headers);
    if (options.allowedOrigin) {
      setCorsHeaders(response, options.allowedOrigin);
    }
    response.setHeader("x-siteflow-deployment", route.deploymentId);
    response.setHeader("x-siteflow-function", entry.path);
    response.setHeader("x-siteflow-request-id", requestId);
    setRoutingResponseHeaders(response, routingMatch, url.pathname);

    if (route.rollingReleaseId) {
      response.setHeader("x-siteflow-rollout", route.rollingReleaseId);
    }

    if (route.trafficTarget) {
      response.setHeader("x-siteflow-traffic-target", route.trafficTarget);
    }

    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(Buffer.from(await runtimeResponse.arrayBuffer()));
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Function invocation failed.";
    if (error instanceof IsolatedFunctionRuntimeError) {
      logs.push(...error.logs);
    }
    logs.push(redactLogLine(errorMessage, { extraPatterns: secretPatterns }));

    if (error instanceof RequestBodyTooLargeError) {
      responseStatus = 413;
      destroyRequestAfterResponse(request, response);
      sendJson(response, 413, { message: error.message, requestId }, options.allowedOrigin, requestMethod);
    } else {
      responseStatus = /timed out/i.test(errorMessage) ? 504 : 500;
      sendJson(response, responseStatus, { message: responseStatus === 504 ? "Function invocation timed out." : "Function invocation failed.", requestId }, options.allowedOrigin, requestMethod);
    }
  } finally {
    releaseConcurrency?.();
    await options.repository.recordFunctionInvocation({
      id: `fninv_${randomUUID().replace(/-/g, "")}`,
      deploymentId: route.deploymentId,
      projectId: route.projectId ?? "project_unknown",
      path: url.pathname,
      method: requestMethod,
      status: responseStatus >= 500 ? "failed" : "succeeded",
      responseStatus,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      requestId,
      errorMessage,
      logs,
      invokedAt: new Date().toISOString()
    });
  }
}

async function tryServeArtifactRoute(context: RouteContext, options: SiteFlowServerOptions) {
  const { request, response, url } = context;
  const rawHost = requestHost(request, options);
  const host = rawHost.toLowerCase().split(":")[0];

  if (!host) {
    return false;
  }

  const route = await options.repository.resolveArtifactRoute(host, requestBucketKey(request, options));

  if (!route) {
    return false;
  }

  if (route.projectId) {
    const firewall = await options.repository.evaluateFirewall({
      projectId: route.projectId,
      ip: requestIp(request, options),
      path: url.pathname,
      method: request.method ?? "GET",
      headers: lowerCaseRequestHeaders(request),
      userAgent: headerValue(request, "user-agent")
    });

    if (firewall.decision === "block") {
      response.setHeader("x-siteflow-firewall", firewall.matchedRule?.id ?? "blocked");
      sendJson(response, 403, { message: "Request blocked by SiteFlow firewall.", ruleId: firewall.matchedRule?.id }, options.allowedOrigin, request.method);
      return true;
    }

    if (firewall.decision === "challenge") {
      response.setHeader("x-siteflow-firewall", firewall.matchedRule?.id ?? "challenge");
      sendJson(response, 403, { message: "Request requires a SiteFlow firewall challenge.", ruleId: firewall.matchedRule?.id }, options.allowedOrigin, request.method);
      return true;
    }
  }

  let routePath = url.pathname;
  let routingMatch: RoutingMatch | undefined = matchArtifactRoutingRules(route, url.pathname);

  if (routingMatch.redirect) {
    response.statusCode = routingMatch.redirect.statusCode ?? 308;
    if (options.allowedOrigin) {
      setCorsHeaders(response, options.allowedOrigin);
    }
    response.setHeader("location", routingRedirectLocation(routingMatch.redirect, url.pathname, url));
    response.setHeader("x-siteflow-redirect", routingMatch.redirect.id);
    response.end();
    return true;
  }

  routePath = routingMatch.rewrittenPath ?? url.pathname;

  if (route.projectId) {
    const match = await options.repository.matchRoutingRules({
      projectId: route.projectId,
      path: routePath
    });

    if (match.redirect) {
      response.statusCode = match.redirect.statusCode ?? 308;
      if (options.allowedOrigin) {
        setCorsHeaders(response, options.allowedOrigin);
      }
      response.setHeader("location", routingRedirectLocation(match.redirect, routePath, url));
      response.setHeader("x-siteflow-redirect", match.redirect.id);
      response.end();
      return true;
    }

    routingMatch = {
      rewrite: match.rewrite ?? routingMatch.rewrite,
      headers: [...(routingMatch.headers ?? []), ...match.headers],
      rewrittenPath: match.rewrittenPath ?? routingMatch.rewrittenPath
    };
    routePath = match.rewrittenPath ?? routePath;
  }

  if (routePath === "/api" || routePath.startsWith("/api/")) {
    const functionEntry = functionForPath(route.functions, routePath);

    if (!functionEntry) {
      sendJson(response, 404, { message: "Function route not found." }, options.allowedOrigin, request.method);
      return true;
    }

    if (functionEntry.methods && !functionEntry.methods.includes(request.method ?? "GET")) {
      response.setHeader("allow", functionEntry.methods.join(", "));
      sendJson(response, 405, { message: "Function method not allowed." }, options.allowedOrigin, request.method);
      return true;
    }

    await invokeFunctionRoute(context, route, functionEntry, options, routingMatch);
    return true;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    await resolveArtifactFile(route, routePath);
    response.setHeader("allow", "GET, HEAD");
    sendJson(response, 405, { message: "Static artifact routes only support GET and HEAD." }, options.allowedOrigin);
    return true;
  }

  const canonicalBeforeResolve = canonicalStaticLocation(routePath, route);

  if (canonicalBeforeResolve) {
    redirectStaticCanonical(response, canonicalBeforeResolve, url, options.allowedOrigin);
    return true;
  }

  const resolvedFile = await resolveArtifactFile(route, routePath);
  const canonicalAfterResolve = canonicalStaticLocation(routePath, route, resolvedFile);

  if (canonicalAfterResolve) {
    redirectStaticCanonical(response, canonicalAfterResolve, url, options.allowedOrigin);
    return true;
  }

  const encodedFile = await selectEncodedArtifactFile(request, resolvedFile.filePath);
  const [body, fileStat, sourceFileStat] = await Promise.all([
    readFile(encodedFile.filePath),
    stat(encodedFile.filePath),
    stat(resolvedFile.filePath)
  ]);
  const etag = weakStaticEtag(route, resolvedFile.resolvedPath, body);
  const lastModified = sourceFileStat.mtime.toUTCString();

  response.setHeader("content-type", contentTypeFor(resolvedFile.filePath));
  if (options.allowedOrigin) {
    setCorsHeaders(response, options.allowedOrigin);
  }
  response.setHeader("cache-control", staticAssetCacheControl(resolvedFile.filePath));
  response.setHeader("etag", etag);
  response.setHeader("last-modified", lastModified);
  response.setHeader("vary", mergeVaryHeader(response.getHeader("vary"), "accept-encoding"));
  response.setHeader("accept-ranges", "bytes");
  setDefaultStaticSecurityHeaders(response);

  if (encodedFile.encoding) {
    response.setHeader("content-encoding", encodedFile.encoding);
  }

  response.setHeader("x-siteflow-deployment", route.deploymentId);
  setRoutingResponseHeaders(response, routingMatch, url.pathname);

  if (route.rollingReleaseId) {
    response.setHeader("x-siteflow-rollout", route.rollingReleaseId);
  }

  if (route.trafficTarget) {
    response.setHeader("x-siteflow-traffic-target", route.trafficTarget);
  }

  if (!requestPreconditionsPass(request, etag, sourceFileStat.mtime)) {
    endResponseWithoutBody(response, 412);
    return true;
  }

  if (requestHasMatchingEtag(request, etag) || requestHasFreshModifiedSince(request, sourceFileStat.mtime)) {
    endResponseWithoutBody(response, 304);
    return true;
  }

  const range = request.method === "GET" && requestIfRangeMatches(request, etag, sourceFileStat.mtime)
    ? parseByteRange(request.headers.range, body.byteLength)
    : undefined;

  if (range === "invalid") {
    response.setHeader("content-range", `bytes */${body.byteLength}`);
    endResponseWithoutBody(response, 416);
    return true;
  }

  if (range) {
    const partialBody = body.subarray(range.start, range.end + 1);

    response.statusCode = 206;
    response.setHeader("content-range", `bytes ${range.start}-${range.end}/${body.byteLength}`);
    response.setHeader("content-length", String(partialBody.byteLength));
    response.end(partialBody);
    return true;
  }

  response.statusCode = 200;
  response.setHeader("content-length", String(body.byteLength));

  if (request.method === "HEAD") {
    response.end();
    return true;
  }

  response.end(body);
  return true;
}

async function tryServeImageOptimizationRoute(context: RouteContext, options: SiteFlowServerOptions) {
  const { request, response, url } = context;

  if (url.pathname !== "/_siteflow/image") {
    return false;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    sendJson(response, 405, { message: "Image optimization only supports GET and HEAD." }, options.allowedOrigin);
    return true;
  }

  const host = imageRouteHost(request, options);

  if (!host) {
    throw new ImageOptimizationInputError("Image optimization requires a request host.");
  }

  const route = await options.repository.resolveArtifactRoute(host, requestBucketKey(request, options));

  if (!route) {
    throw new SiteFlowNotFoundError("Image optimization route was not found.");
  }

  const source = assertSafeImageSource(url.searchParams.get("url"));
  const width = requiredIntegerParam(url, "w", 16, 3840);
  const quality = optionalIntegerParam(url, "q", 75, 1, 100);
  assertImageWidthAllowed(width, route.images);
  assertImageQualityAllowed(quality, route.images);
  const format = normalizedImageFormat(url.searchParams.get("format"), route.images);
  const sourceImage = source.startsWith("blob:")
    ? await readBlobImage(options.repository, route, source)
    : await readArtifactImage(route, source);

  if (sourceImage.contentType === "image/svg+xml" && !route.images?.dangerouslyAllowSVG) {
    throw new ImageOptimizationInputError("SVG image optimization requires images.dangerouslyAllowSVG.");
  }

  const cacheKey = imageCacheKey({
    sourceId: sourceImage.sourceId,
    width,
    quality,
    format
  });
  const etag = `"img-${cacheKey}"`;
  const lastModified = sourceImage.modifiedAt.toUTCString();

  response.statusCode = 200;
  response.setHeader("content-type", imageContentType(format, sourceImage.contentType));
  if (options.allowedOrigin) {
    setCorsHeaders(response, options.allowedOrigin);
  }
  response.setHeader("cache-control", cacheControlForImage(route.images));
  response.setHeader("etag", etag);
  response.setHeader("last-modified", lastModified);
  response.setHeader("vary", mergeVaryHeader(response.getHeader("vary"), "accept"));
  response.setHeader("content-length", String(sourceImage.bytes.byteLength));
  response.setHeader("content-disposition", `${route.images?.contentDispositionType ?? "attachment"}; filename="image"`);
  response.setHeader("x-siteflow-image-cache-key", cacheKey);
  response.setHeader("x-siteflow-image-width", String(width));
  response.setHeader("x-siteflow-image-quality", String(quality));
  response.setHeader("x-siteflow-image-format", format);
  response.setHeader("x-siteflow-image-source", source.startsWith("blob:") ? "blob" : "artifact");
  response.setHeader("x-siteflow-deployment", route.deploymentId);

  if (route.images?.contentSecurityPolicy) {
    response.setHeader("content-security-policy", route.images.contentSecurityPolicy);
  }

  if (route.rollingReleaseId) {
    response.setHeader("x-siteflow-rollout", route.rollingReleaseId);
  }

  if (route.trafficTarget) {
    response.setHeader("x-siteflow-traffic-target", route.trafficTarget);
  }

  if (!requestPreconditionsPass(request, etag, sourceImage.modifiedAt)) {
    endResponseWithoutBody(response, 412);
    return true;
  }

  if (requestHasMatchingEtag(request, etag) || requestHasFreshModifiedSince(request, sourceImage.modifiedAt)) {
    endResponseWithoutBody(response, 304);
    return true;
  }

  if (request.method === "HEAD") {
    response.end();
    return true;
  }

  response.end(sourceImage.bytes);
  return true;
}

async function handleApiRoute(context: RouteContext, options: SiteFlowServerOptions, rateLimitBuckets: Map<string, RateLimitBucket>, metrics: SiteFlowHttpMetrics) {
  const { request, response, segments, url } = context;
  const repository = options.repository;

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 1 && segments[0] === "healthz") {
    sendJson(response, 200, { status: "ok", version: options.version }, options.allowedOrigin, request.method);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 1 && segments[0] === "readyz") {
    const result = await readinessBody(options);
    sendJson(response, result.statusCode, result.body, options.allowedOrigin, request.method);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 1 && segments[0] === "metrics") {
    if (!authorizeMetricsRequest(request, response, options)) {
      return;
    }

    sendText(response, 200, await renderHttpMetrics(metrics, options.runtimeMetricsCollector), options.allowedOrigin, request.method);
    return;
  }

  if (segments[0] !== "api") {
    notFound(response, options.allowedOrigin, request.method);
    return;
  }

  if (!allowApiRequest(request, response, options, rateLimitBuckets)) {
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 3 && segments[1] === "auth" && segments[2] === "verify") {
    if (!await authorizeRequest(request, response, options, "read")) {
      return;
    }

    sendJson(
      response,
      200,
      { authenticated: true, authRequired: Boolean(options.apiToken), baseDomain: options.baseDomain },
      options.allowedOrigin,
      request.method
    );
    return;
  }

  if (request.method === "POST" && segments.length === 3 && segments[1] === "auth" && segments[2] === "session") {
    const auth = await authorizeRequest(request, response, options, "admin");
    if (!auth) {
      return;
    }

    const command = {
      ...operatorSessionCommandFromBody(await readJsonBody(request)),
      actor: auth.actor
    };
    const ttlSeconds = command.ttlSeconds ?? 3600;
    const result = await repository.createOperatorSession(command);
    appendSetCookie(response, operatorSessionCookie(result.secret, result.session.expiresAt, ttlSeconds, request, options));
    sendJson(response, 201, operatorSessionResponse(result), options.allowedOrigin);
    return;
  }

  if (request.method === "POST" && segments.length === 4 && segments[1] === "auth" && segments[2] === "session" && segments[3] === "rotate") {
    const sessionToken = operatorSessionToken(request);

    if (!sessionToken) {
      appendSetCookie(response, expiredOperatorSessionCookie(request, options));
      sendJson(response, 401, { message: "SiteFlow operator session is required." }, options.allowedOrigin);
      return;
    }

    const principal = await repository.resolveSessionPrincipal?.(sessionToken) ?? undefined;
    const scopes = principal?.scopes ?? await repository.resolveSessionPermissions(sessionToken);

    if (!scopes) {
      appendSetCookie(response, expiredOperatorSessionCookie(request, options));
      sendJson(response, 401, { message: "SiteFlow operator session is invalid or expired." }, options.allowedOrigin);
      return;
    }

    if (!authorizeOperatorSessionCsrf(request, response, options)) {
      return;
    }

    const result = await repository.rotateOperatorSession(sessionToken);

    if (!result) {
      appendSetCookie(response, expiredOperatorSessionCookie(request, options));
      sendJson(response, 401, { message: "SiteFlow operator session is invalid or expired." }, options.allowedOrigin);
      return;
    }

    appendSetCookie(response, operatorSessionCookie(result.secret, result.session.expiresAt, result.maxAgeSeconds, request, options));
    sendJson(response, 200, operatorSessionResponse(result), options.allowedOrigin);
    return;
  }

  if (request.method === "DELETE" && segments.length === 3 && segments[1] === "auth" && segments[2] === "session") {
    const sessionToken = operatorSessionToken(request);

    if (!sessionToken) {
      appendSetCookie(response, expiredOperatorSessionCookie(request, options));
      sendJson(response, 401, { message: "SiteFlow operator session is required." }, options.allowedOrigin);
      return;
    }

    const principal = await repository.resolveSessionPrincipal?.(sessionToken) ?? undefined;
    const scopes = principal?.scopes ?? await repository.resolveSessionPermissions(sessionToken);

    if (!scopes) {
      appendSetCookie(response, expiredOperatorSessionCookie(request, options));
      sendJson(response, 401, { message: "SiteFlow operator session is invalid or expired." }, options.allowedOrigin);
      return;
    }

    if (!authorizeOperatorSessionCsrf(request, response, options)) {
      return;
    }

    const result = await repository.revokeOperatorSession(sessionToken);
    appendSetCookie(response, expiredOperatorSessionCookie(request, options));
    sendJson(response, 200, result, options.allowedOrigin);
    return;
  }

  if (request.method === "POST" && segments.length === 4 && segments[1] === "auth" && segments[2] === "sessions" && segments[3] === "revoke-all") {
    const auth = await authorizeBearerRequest(request, response, options, "admin");
    if (!auth) {
      return;
    }

    sendJson(
      response,
      200,
      await repository.revokeAllOperatorSessions(operatorSessionRevokeAllCommandFromBody(await readJsonBody(request), auth.actor)),
      options.allowedOrigin
    );
    return;
  }

  if (request.method === "POST" && segments.length === 4 && segments[1] === "deploy-hooks" && segments[2] && segments[3] === "trigger") {
    const body = bodyWithoutClientPrincipal(await readJsonBody(request));
    const result = await repository.triggerDeployHook({
      ...body,
      token: decodeURIComponent(segments[2])
    } as never);

    sendJson(response, 202, result, options.allowedOrigin);
    return;
  }

  if (request.method === "POST" && segments.length === 4 && segments[1] === "webhooks" && segments[2] === "git" && segments[3]) {
    const provider = decodeURIComponent(segments[3]) as SourceProvider;

    if (!supportedGitWebhookProviders.has(provider)) {
      sendJson(response, 404, { message: `Unsupported git webhook provider: ${provider}.` }, options.allowedOrigin);
      return;
    }

    const label = gitWebhookProviderLabel(provider);
    const secret = gitWebhookSecret(provider, options);

    if (!secret) {
      sendJson(response, 503, { message: `${label} webhook secret is not configured.` }, options.allowedOrigin);
      return;
    }

    const deliveryId = gitWebhookDeliveryId(provider, request);
    const eventName = gitWebhookEventName(provider, request);

    if (!deliveryId || !eventName) {
      sendJson(response, 400, { message: `${label} delivery and event headers are required.` }, options.allowedOrigin);
      return;
    }

    const rawBody = await readRawBody(request);

    if (!gitWebhookSignatureValid(provider, request, rawBody, secret, deliveryId)) {
      sendJson(response, 401, { message: `${label} webhook signature verification failed.` }, options.allowedOrigin);
      return;
    }

    let event: SourceEventInput | undefined;

    try {
      let payload = parseGitWebhookPayload(provider, request, rawBody);

      // Loom dialect (signature already verified above): map the Loom push
      // payload into the generic shape, resolving the branch tip SHA because
      // Loom's payload carries none (see loomWebhook.ts).
      if (provider === "generic" && isLoomWebhookPayload(payload)) {
        payload = await loomPayloadToGeneric(payload, { cloneBaseUrl: options.loomCloneBaseUrl });
      }

      event = normalizeGitWebhook(provider, eventName, payload, deliveryId);
    } catch (error) {
      sendJson(response, 400, {
        message: error instanceof Error ? error.message : `${label} webhook payload is invalid.`
      }, options.allowedOrigin);
      return;
    }

    if (!event) {
      sendJson(response, 202, { status: "ignored", message: `${label} ${eventName} webhook ignored.` }, options.allowedOrigin);
      return;
    }

    const result = await repository.ingestGitWebhook({
      provider,
      deliveryId,
      event
    });

    sendJson(response, result.status === "duplicate" ? 200 : 202, result, options.allowedOrigin);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 2 && segments[1] === "projects") {
    if (!await authorizeRequest(request, response, options, "read")) {
      return;
    }

    sendJson(response, 200, await repository.listProjects(), options.allowedOrigin, request.method);
    return;
  }

  if (request.method === "POST" && segments.length === 2 && segments[1] === "projects") {
    const auth = await authorizeRequest(request, response, options, "admin");
    if (!auth) {
      return;
    }

    sendJson(response, 201, await repository.createProject(bodyWithActor(await readJsonBody(request), auth.actor) as never), options.allowedOrigin);
    return;
  }

  if (segments[1] === "projects" && segments[2]) {
    const projectId = decodeURIComponent(segments[2]);

    if (request.method === "POST" && segments.length === 6 && segments[3] === "auth" && segments[4] === "sessions" && segments[5] === "revoke-all") {
      const auth = await authorizeBearerRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.revokeAllOperatorSessions(operatorSessionRevokeAllCommandFromBody(await readJsonBody(request), auth.actor, projectId)),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 3) {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.getProject(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "PATCH" && segments.length === 3) {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(response, 200, await repository.updateProject(projectId, bodyWithActor(await readJsonBody(request), auth.actor) as never), options.allowedOrigin);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "domains") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(response, 201, await repository.addProjectDomain(projectId, bodyWithActor(await readJsonBody(request), auth.actor) as never), options.allowedOrigin);
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "domains") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(response, 200, await repository.removeProjectDomain(projectId, decodeURIComponent(segments[4]), auth.actor), options.allowedOrigin);
      return;
    }

    if (request.method === "DELETE" && segments.length === 3) {
      if (!await authorizeRequest(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.archiveProject(projectId), options.allowedOrigin);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "settings") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        {
          ...await repository.getProjectSettings(projectId),
          currentPermissions: await authenticatedPermissions(request, options, projectId)
        },
        options.allowedOrigin,
        request.method
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "environments") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.getProjectEnvironmentSettings(projectId), options.allowedOrigin, request.method);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "analytics") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.getAnalyticsDashboard(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 5 && segments[3] === "analytics" && segments[4] === "events") {
      sendJson(
        response,
        202,
        await repository.ingestAnalyticsEvent({
          ...bodyWithoutClientPrincipal(await readJsonBody(request)),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "logs") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.queryLogs(logQueryFromUrl(projectId, url) as never), options.allowedOrigin, request.method);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "log-queries") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listSavedLogQueries(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "log-queries") {
      const auth = await authorizeRequest(request, response, options, "write", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.saveLogQuery({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "log-drains") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listLogDrains(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "log-drains") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createLogDrain({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 6 && segments[3] === "log-drains" && segments[5] === "deliver") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      const body = bodyWithActor(await readJsonBody(request), auth.actor);
      const plan = await repository.prepareLogDrainDelivery({
        ...body,
        projectId,
        drainId: decodeURIComponent(segments[4])
      } as never);

      sendJson(response, 202, await deliverLogDrain(plan, body, options), options.allowedOrigin);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "environment-variables") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.upsertEnvironmentVariable({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "team-members") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.upsertTeamMember({
          ...bodyWithRequestedBy(await readJsonBody(request), auth.actor),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "team-members") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.removeTeamMember({
          ...bodyWithRequestedBy(await readJsonBody(request), auth.actor),
          projectId,
          memberId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "api-tokens") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createApiToken({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "api-tokens") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.revokeApiToken({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId,
          tokenId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "firewall-rules") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listFirewallRules(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "firewall-rules") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createFirewallRule({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "firewall-rules") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.disableFirewallRule({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId,
          ruleId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "edge-config") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.getEdgeConfig(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "PUT" && segments.length === 5 && segments[3] === "edge-config") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.upsertEdgeConfig({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId,
          key: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "edge-config") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.deleteEdgeConfig({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId,
          key: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (segments[3] === "blobs") {
      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4) {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.listBlobs({
            projectId,
            prefix: url.searchParams.get("prefix") ?? undefined,
            limit: optionalNumber(url.searchParams.get("limit")),
            cursor: url.searchParams.get("cursor") ?? undefined
          }),
          options.allowedOrigin,
          request.method
        );
        return;
      }

      if (request.method === "POST" && segments.length === 4) {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }

        sendJson(
          response,
          201,
          await repository.putBlob({
            ...bodyWithActor(await readJsonBody(request), auth.actor),
            projectId
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (segments.length >= 5) {
        const pathname = decodeURIComponent(segments.slice(4).join("/"));

        if (request.method === "GET" || request.method === "HEAD") {
          if (!await authorizeRequest(request, response, options, "read", projectId)) {
            return;
          }

          sendJson(
            response,
            200,
            await repository.getBlob({
              projectId,
              pathname
            }),
            options.allowedOrigin,
            request.method
          );
          return;
        }

        if (request.method === "DELETE") {
          const auth = await authorizeRequest(request, response, options, "write", projectId);
          if (!auth) {
            return;
          }

          sendJson(
            response,
            200,
            await repository.deleteBlob({
              ...bodyWithActor(await readJsonBody(request), auth.actor),
              projectId,
              pathname
            } as never),
            options.allowedOrigin
          );
          return;
        }
      }
    }

    if (segments[3] === "cache") {
      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4) {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.listCacheEntries({
            projectId,
            path: url.searchParams.get("path") ?? undefined,
            tag: url.searchParams.get("tag") ?? undefined,
            status: url.searchParams.get("status") as never ?? undefined,
            limit: optionalNumber(url.searchParams.get("limit"))
          }),
          options.allowedOrigin,
          request.method
        );
        return;
      }

      if (request.method === "POST" && segments.length === 5 && segments[4] === "purge") {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.purgeCache({
            ...bodyWithActor(await readJsonBody(request), auth.actor),
            projectId
          } as never),
          options.allowedOrigin
        );
        return;
      }
    }

    if (segments[3] === "functions") {
      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4) {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.listFunctions({
            projectId,
            deploymentId: url.searchParams.get("deploymentId") ?? undefined
          }),
          options.allowedOrigin,
          request.method
        );
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && segments.length >= 5) {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.getFunctionRuntime({
            projectId,
            path: decodeURIComponent(segments.slice(4).join("/")),
            deploymentId: url.searchParams.get("deploymentId") ?? undefined,
            limit: optionalNumber(url.searchParams.get("limit"))
          }),
          options.allowedOrigin,
          request.method
        );
        return;
      }
    }

    if (segments[3] === "routing-rules") {
      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4) {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.listRoutingRules({
            projectId,
            kind: url.searchParams.get("kind") as never ?? undefined,
            status: url.searchParams.get("status") as never ?? undefined
          }),
          options.allowedOrigin,
          request.method
        );
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 5 && segments[4] === "match") {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.matchRoutingRules({
            projectId,
            path: url.searchParams.get("path") ?? "/"
          }),
          options.allowedOrigin,
          request.method
        );
        return;
      }

      if (request.method === "PUT" && segments.length === 4) {
        const auth = await authorizeRequest(request, response, options, "admin", projectId);
        if (!auth) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.upsertRoutingRule({
            ...bodyWithActor(await readJsonBody(request), auth.actor),
            projectId
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "DELETE" && segments.length === 5) {
        const auth = await authorizeRequest(request, response, options, "admin", projectId);
        if (!auth) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.disableRoutingRule({
            ...bodyWithActor(await readJsonBody(request), auth.actor),
            projectId,
            ruleId: decodeURIComponent(segments[4])
          } as never),
          options.allowedOrigin
        );
        return;
      }
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "deploy-hooks") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listDeployHooks(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "deploy-hooks") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      const result = await repository.createDeployHook({
        ...bodyWithActor(await readJsonBody(request), auth.actor),
        projectId
      } as never);

      sendJson(
        response,
        201,
        {
          ...result,
          hookUrl: result.hookUrl ?? deployHookUrl(request, result.token, options)
        },
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "deploy-hooks") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.revokeDeployHook({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId,
          hookId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "cron-jobs") {
      if (!await authorizeRequest(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listCronJobs(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "cron-jobs") {
      const auth = await authorizeRequest(request, response, options, "write", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createCronJob({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "cron-jobs") {
      const auth = await authorizeRequest(request, response, options, "admin", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.disableCronJob({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId,
          jobId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 6 && segments[3] === "cron-jobs" && segments[5] === "run") {
      const auth = await authorizeRequest(request, response, options, "write", projectId);
      if (!auth) {
        return;
      }

      sendJson(
        response,
        202,
        await repository.runCronJob({
          ...bodyWithActor(await readJsonBody(request), auth.actor),
          projectId,
          jobId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (segments[3] === "rolling" && segments[4]) {
      const channel = decodeURIComponent(segments[4]);
      assertReleaseChannel(channel);

      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 5) {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(response, 200, await repository.getRollingRelease(projectId, channel), options.allowedOrigin, request.method);
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "start") {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }
        const body = bodyWithProductionReleaseEvidence(channel, await readJsonBody(request), "rolling release start", options);

        sendJson(
          response,
          202,
          await repository.startRollingRelease({
            ...bodyWithActor(body, auth.actor),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "advance") {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }
        const body = bodyWithProductionReleaseEvidence(channel, await readJsonBody(request), "rolling release advance", options);

        sendJson(
          response,
          202,
          await repository.advanceRollingRelease({
            ...bodyWithActor(body, auth.actor),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "complete") {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }
        const body = bodyWithProductionReleaseEvidence(channel, await readJsonBody(request), "rolling release complete", options);

        sendJson(
          response,
          202,
          await repository.completeRollingRelease({
            ...bodyWithActor(body, auth.actor),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "abort") {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }
        const body = bodyWithProductionRollingAbortException(channel, await readJsonBody(request), options);

        sendJson(
          response,
          202,
          await repository.abortRollingRelease({
            ...bodyWithActor(body, auth.actor),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }
    }

    if ((segments[3] === "release" || segments[3] === "rollback") && segments[4]) {
      const channel = decodeURIComponent(segments[4]);
      assertReleaseChannel(channel);

      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 5 && segments[3] === "release") {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(response, 200, await repository.getReleaseConsole(projectId, channel), options.allowedOrigin, request.method);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 5 && segments[3] === "rollback") {
        if (!await authorizeRequest(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(response, 200, await repository.getRollbackConsole(projectId, channel), options.allowedOrigin, request.method);
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[3] === "release" && segments[5] === "promote") {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }
        const body = bodyWithProductionReleaseEvidence(channel, await readJsonBody(request), "promotion", options);

        sendJson(
          response,
          202,
          await repository.promoteDeployment({
            ...bodyWithActor(body, auth.actor),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[3] === "rollback" && segments[5] === "rollback") {
        const auth = await authorizeRequest(request, response, options, "write", projectId);
        if (!auth) {
          return;
        }
        const body = bodyWithProductionReleaseEvidence(channel, await readJsonBody(request), "rollback", options);

        sendJson(
          response,
          202,
          await repository.rollbackDeployment({
            ...bodyWithActor(body, auth.actor),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 2 && segments[1] === "deployments") {
    if (!await authorizeRequest(request, response, options, "read", url.searchParams.get("projectId") ?? undefined)) {
      return;
    }

    sendJson(response, 200, await repository.listDeployments(url.searchParams.get("projectId") ?? undefined), options.allowedOrigin, request.method);
    return;
  }

  if (segments[1] === "deployments" && segments[2]) {
    const deploymentId = decodeURIComponent(segments[2]);

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 3) {
      if (!await authorizeRequest(request, response, options, "read")) {
        return;
      }

      sendJson(response, 200, await repository.getDeployment(deploymentId), options.allowedOrigin, request.method);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "logs") {
      if (!await authorizeRequest(request, response, options, "read")) {
        return;
      }

      sendJson(response, 200, await repository.getLogChunk(deploymentId, url.searchParams.get("cursor") ?? undefined), options.allowedOrigin, request.method);
      return;
    }
  }

  if (request.method === "POST" && segments.length === 3 && segments[1] === "deployments" && segments[2] === "prebuilt") {
    const auth = await authorizeRequest(request, response, options, "write");
    if (!auth) {
      return;
    }

    requestBodyLimitBytes.set(request, prebuiltRequestBodyLimitBytes(options));
    const body = bodyWithOptionalPrebuiltReleaseEvidence(await readJsonBody(request), options);
    const command = bodyWithActor(body, auth.actor) as unknown as PrebuiltDeployCommand;
    assertPrebuiltUploadWithinBudget(command, options);

    sendJson(response, 201, await repository.deployPrebuilt(command), options.allowedOrigin);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments[1] === "operations" && segments[2] && segments.length === 3) {
    if (!await authorizeRequest(request, response, options, "read")) {
      return;
    }

    sendJson(response, 200, await repository.pollOperation(decodeURIComponent(segments[2])), options.allowedOrigin, request.method);
    return;
  }

  notFound(response, options.allowedOrigin, request.method);
}

export function createSiteFlowServer(options: SiteFlowServerOptions) {
  const rateLimitBuckets = new Map<string, RateLimitBucket>();
  const metrics = createHttpMetrics();

  return http.createServer(async (request, response) => {
    const requestLogEntry: Omit<SiteFlowRequestLogEntry, "durationMs" | "status"> = {
      requestId: `req_${randomUUID().replace(/-/g, "")}`,
      method: request.method ?? "UNKNOWN",
      path: requestLogPath(request)
    };
    const startedAt = Date.now();

    response.once("finish", () => {
      recordHttpMetrics(metrics, response, startedAt);
      logRequestCompletion(options, requestLogEntry, response, startedAt);
    });

    try {
      if (request.method === "OPTIONS") {
        response.statusCode = 204;

        if (options.allowedOrigin) {
          setCorsHeaders(response, options.allowedOrigin, { preflight: true });
        }

        response.end();
        return;
      }

      const host = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const segments = url.pathname.split("/").filter(Boolean);
      requestBodyLimitBytes.set(request, maxBodyBytes(options));

      // Console SPA static serving: requests whose Host is the configured
      // console host (e.g. siteflow.w33d.xyz behind the HOLDFAST gateway) get
      // the built dist/ bundle, except API/health/metrics paths, which keep
      // flowing into the control-plane routes below.
      if (
        options.consoleHost
        && host.split(":")[0]?.toLowerCase() === options.consoleHost.toLowerCase()
        && segments[0] !== "api"
        && url.pathname !== "/healthz"
        && url.pathname !== "/readyz"
        && url.pathname !== "/metrics"
        && await serveConsoleStatic(request, response, url.pathname, options.consoleDistDir ?? "dist")
      ) {
        return;
      }

      if (await tryServeImageOptimizationRoute({ request, response, url, segments }, options)) {
        return;
      }

      if (await tryServeArtifactRoute({ request, response, url, segments }, options)) {
        return;
      }

      await handleApiRoute({ request, response, url, segments }, options, rateLimitBuckets, metrics);
    } catch (error) {
      if (error instanceof SiteFlowNotFoundError) {
        requestLogEntry.errorClass = error.name;
        sendJson(response, 404, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof SiteFlowConflictError) {
        requestLogEntry.errorClass = error.name;
        sendJson(response, 409, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof SiteFlowInputError) {
        requestLogEntry.errorClass = error.name;
        sendJson(response, 400, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof RequestBodyTooLargeError) {
        requestLogEntry.errorClass = error.name;
        destroyRequestAfterResponse(request, response);
        sendJson(response, 413, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof PrebuiltUploadTooLargeError) {
        requestLogEntry.errorClass = error.name;
        sendJson(response, 413, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof ImageOptimizationInputError) {
        requestLogEntry.errorClass = error.name;
        sendJson(response, error.statusCode, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof SyntaxError || error instanceof Error && error.message.startsWith("Invalid release channel")) {
        requestLogEntry.errorClass = error instanceof Error ? error.name : "SyntaxError";
        sendJson(response, 400, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      requestLogEntry.errorClass = error instanceof Error ? error.name : "UnknownError";
      sendJson(response, 500, { message: "Unexpected SiteFlow API error." }, options.allowedOrigin, request.method);
    }
  });
}
