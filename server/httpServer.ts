import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Actor, FunctionEntrypoint, PermissionScope, RepositoryBinding, RoutingHeader, RoutingRule, SourceEventInput } from "../src/domain/siteflow.js";
import { redactLogLine } from "../src/lib/redaction.js";
import type { PrebuiltImageConfig } from "../src/lib/api/deployContracts.js";
import { assertReleaseChannel, SiteFlowNotFoundError, type ArtifactRoute, type LogDrainDeliveryPlan, type SiteFlowReadRepository } from "./readRepository.js";

export type FunctionModuleLoader = (functionPath: string) => Promise<Record<string, unknown>>;
export type DrainFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SiteFlowServerOptions {
  repository: SiteFlowReadRepository;
  version: string;
  allowedOrigin?: string;
  apiToken?: string;
  baseDomain?: string;
  githubWebhookSecret?: string;
  functionModuleLoader?: FunctionModuleLoader;
  drainFetch?: DrainFetch;
}

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
const accessControlAllowHeaders = [
  "content-type",
  "accept",
  "authorization",
  "range",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range"
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

async function readRawBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

function headerValue(request: IncomingMessage, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function firstHeaderToken(value: string | undefined) {
  return value?.split(",")[0]?.trim();
}

function requestOrigin(request: IncomingMessage) {
  const forwardedHost = firstHeaderToken(headerValue(request, "x-forwarded-host"));
  const forwardedProto = firstHeaderToken(headerValue(request, "x-forwarded-proto"));
  const host = forwardedHost || request.headers.host || "127.0.0.1";
  const proto = forwardedProto || "http";

  return `${proto}://${host}`;
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

function deployHookUrl(request: IncomingMessage, token: string) {
  return `${requestOrigin(request).replace(/\/+$/, "")}/api/deploy-hooks/${encodeURIComponent(token)}/trigger`;
}

function requestBucketKey(request: IncomingMessage) {
  const explicit = headerValue(request, "x-siteflow-bucket-key")?.trim();

  if (explicit) {
    return explicit;
  }

  const forwardedFor = firstHeaderToken(headerValue(request, "x-forwarded-for"));

  if (forwardedFor) {
    return forwardedFor;
  }

  const remoteAddress = request.socket.remoteAddress;
  const userAgent = headerValue(request, "user-agent");
  const fallback = [remoteAddress, userAgent].filter(Boolean).join(":");

  return fallback || undefined;
}

function requestIp(request: IncomingMessage) {
  return firstHeaderToken(headerValue(request, "x-forwarded-for")) ?? request.socket.remoteAddress;
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

function recordField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string) {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
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

function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string) {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`, "utf8");
  const actual = Buffer.from(signatureHeader, "utf8");

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
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

  return {
    provider: "github",
    owner: requireString(stringField(owner, "login") ?? stringField(owner, "name") ?? fallbackOwner, "GitHub repository owner"),
    name: requireString(stringField(repository, "name"), "GitHub repository name"),
    defaultBranch: stringField(repository, "default_branch") ?? "main",
    providerPayload: {
      id: numberField(repository, "id"),
      fullName,
      htmlUrl: stringField(repository, "html_url")
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
    defaultBranch: stringField(repository, "default_branch")
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

async function authorizeMutation(
  request: IncomingMessage,
  response: ServerResponse,
  options: SiteFlowServerOptions,
  permission: PermissionScope,
  projectId?: string
) {
  const token = bearerToken(request);

  if (!options.apiToken && !token) {
    return true;
  }

  if (token && token === options.apiToken) {
    return true;
  }

  if (!token) {
    sendJson(response, 401, { message: "SiteFlow API token is required." }, options.allowedOrigin, request.method);
    return false;
  }

  if (await options.repository.authorizeToken(token, permission, projectId)) {
    return true;
  }

  sendJson(response, 403, { message: `SiteFlow API token does not include ${permission} permission.` }, options.allowedOrigin, request.method);
  return false;
}

async function authenticatedPermissions(request: IncomingMessage, options: SiteFlowServerOptions, projectId?: string): Promise<PermissionScope[]> {
  const token = bearerToken(request);

  if (token && token === options.apiToken) {
    return ["read", "write", "admin"];
  }

  if (!token) {
    return options.apiToken ? [] : ["read", "write", "admin"];
  }

  return await options.repository.resolveTokenPermissions(token, projectId) ?? [];
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

function imageRouteHost(request: IncomingMessage) {
  const forwardedHost = firstHeaderToken(headerValue(request, "x-forwarded-host"));
  const rawHost = forwardedHost || request.headers.host || "";
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
  if (typeof value === "string") {
    return redactLogLine(value, { extraPatterns: secretPatterns });
  }

  try {
    return redactLogLine(JSON.stringify(value), { extraPatterns: secretPatterns });
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
  let releaseConcurrency: (() => void) | undefined;

  try {
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
    const runtimeRequest = new Request(new URL(request.url ?? "/", requestOrigin(request)), {
      method: requestMethod,
      headers: requestHeaders(request),
      body: requestBody,
      ...(requestBody ? { duplex: "half" } : {})
    } as RequestInit & { duplex?: "half" });
    const module = await (options.functionModuleLoader ?? loadFunctionModule)(functionPath);
    const handler = entry.handler === "handler" ? module.handler : module.default ?? module.handler;

    if (typeof handler !== "function") {
      throw new Error(`Function ${entry.path} does not export a callable handler.`);
    }

    const captured = await captureFunctionLogs(
      () => withTimeout(
        withRuntimeEnvironment(
          runtimeEnvironment,
          async () => runtimeResultToResponse(await handler(runtimeRequest, {
            params: {},
            path: url.pathname,
            requestId,
            deploymentId: route.deploymentId,
            env: runtimeEnvironment
          }))
        ),
        timeoutMs
      ),
      secretPatterns
    );
    const runtimeResponse = captured.value;
    logs = captured.logs;
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
    logs.push(redactLogLine(errorMessage, { extraPatterns: secretPatterns }));
    responseStatus = /timed out/i.test(errorMessage) ? 504 : 500;
    sendJson(response, responseStatus, { message: responseStatus === 504 ? "Function invocation timed out." : "Function invocation failed.", requestId }, options.allowedOrigin, requestMethod);
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
  const rawHost = firstHeaderToken(headerValue(request, "x-forwarded-host")) || request.headers.host || "";
  const host = rawHost.toLowerCase().split(":")[0];

  if (!host) {
    return false;
  }

  const route = await options.repository.resolveArtifactRoute(host, requestBucketKey(request));

  if (!route) {
    return false;
  }

  if (route.projectId) {
    const firewall = await options.repository.evaluateFirewall({
      projectId: route.projectId,
      ip: requestIp(request),
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

  const host = imageRouteHost(request);

  if (!host) {
    throw new ImageOptimizationInputError("Image optimization requires a request host.");
  }

  const route = await options.repository.resolveArtifactRoute(host, requestBucketKey(request));

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

async function handleApiRoute(context: RouteContext, options: SiteFlowServerOptions) {
  const { request, response, segments, url } = context;
  const repository = options.repository;

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 1 && segments[0] === "healthz") {
    sendJson(response, 200, { status: "ok", version: options.version }, options.allowedOrigin, request.method);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 3 && segments[0] === "api" && segments[1] === "auth" && segments[2] === "verify") {
    if (!await authorizeMutation(request, response, options, "read")) {
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

  if (segments[0] !== "api") {
    notFound(response, options.allowedOrigin, request.method);
    return;
  }

  if (request.method === "POST" && segments.length === 4 && segments[1] === "deploy-hooks" && segments[2] && segments[3] === "trigger") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const result = await repository.triggerDeployHook({
      ...body,
      token: decodeURIComponent(segments[2])
    } as never);

    sendJson(response, 202, result, options.allowedOrigin);
    return;
  }

  if (request.method === "POST" && segments.length === 4 && segments[1] === "webhooks" && segments[2] === "git" && segments[3] === "github") {
    if (!options.githubWebhookSecret) {
      sendJson(response, 503, { message: "GitHub webhook secret is not configured." }, options.allowedOrigin);
      return;
    }

    const deliveryId = headerValue(request, "x-github-delivery");
    const eventName = headerValue(request, "x-github-event");

    if (!deliveryId || !eventName) {
      sendJson(response, 400, { message: "GitHub delivery and event headers are required." }, options.allowedOrigin);
      return;
    }

    const rawBody = await readRawBody(request);

    if (!verifyGitHubSignature(rawBody, headerValue(request, "x-hub-signature-256"), options.githubWebhookSecret)) {
      sendJson(response, 401, { message: "GitHub webhook signature verification failed." }, options.allowedOrigin);
      return;
    }

    const payload = rawBody.toString("utf8").trim() ? JSON.parse(rawBody.toString("utf8")) as unknown : {};
    const event = normalizeGitHubWebhook(eventName, payload, deliveryId);

    if (!event) {
      sendJson(response, 202, { status: "ignored", message: `GitHub ${eventName} webhook ignored.` }, options.allowedOrigin);
      return;
    }

    const result = await repository.ingestGitWebhook({
      provider: "github",
      deliveryId,
      event
    });

    sendJson(response, result.status === "duplicate" ? 200 : 202, result, options.allowedOrigin);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments.length === 2 && segments[1] === "projects") {
    sendJson(response, 200, await repository.listProjects(), options.allowedOrigin, request.method);
    return;
  }

  if (request.method === "POST" && segments.length === 2 && segments[1] === "projects") {
    if (!await authorizeMutation(request, response, options, "admin")) {
      return;
    }

    sendJson(response, 201, await repository.createProject((await readJsonBody(request)) as never), options.allowedOrigin);
    return;
  }

  if (segments[1] === "projects" && segments[2]) {
    const projectId = decodeURIComponent(segments[2]);

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 3) {
      sendJson(response, 200, await repository.getProject(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "PATCH" && segments.length === 3) {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.updateProject(projectId, (await readJsonBody(request)) as never), options.allowedOrigin);
      return;
    }

    if (request.method === "DELETE" && segments.length === 3) {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.archiveProject(projectId), options.allowedOrigin);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "settings") {
      if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
      sendJson(response, 200, await repository.getProjectEnvironmentSettings(projectId), options.allowedOrigin, request.method);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "analytics") {
      sendJson(response, 200, await repository.getAnalyticsDashboard(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 5 && segments[3] === "analytics" && segments[4] === "events") {
      sendJson(
        response,
        202,
        await repository.ingestAnalyticsEvent({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "logs") {
      sendJson(response, 200, await repository.queryLogs(logQueryFromUrl(projectId, url) as never), options.allowedOrigin, request.method);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "log-queries") {
      if (!await authorizeMutation(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listSavedLogQueries(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "log-queries") {
      if (!await authorizeMutation(request, response, options, "write", projectId)) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.saveLogQuery({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "log-drains") {
      if (!await authorizeMutation(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listLogDrains(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "log-drains") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createLogDrain({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 6 && segments[3] === "log-drains" && segments[5] === "deliver") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const plan = await repository.prepareLogDrainDelivery({
        ...body,
        projectId,
        drainId: decodeURIComponent(segments[4])
      } as never);

      sendJson(response, 202, await deliverLogDrain(plan, body, options), options.allowedOrigin);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "environment-variables") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.upsertEnvironmentVariable({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "team-members") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.upsertTeamMember({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "team-members") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.removeTeamMember({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId,
          memberId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "api-tokens") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createApiToken({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "api-tokens") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.revokeApiToken({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId,
          tokenId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "firewall-rules") {
      if (!await authorizeMutation(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listFirewallRules(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "firewall-rules") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createFirewallRule({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "firewall-rules") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.disableFirewallRule({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId,
          ruleId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "edge-config") {
      if (!await authorizeMutation(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.getEdgeConfig(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "PUT" && segments.length === 5 && segments[3] === "edge-config") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.upsertEdgeConfig({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId,
          key: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "edge-config") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.deleteEdgeConfig({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId,
          key: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (segments[3] === "blobs") {
      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4) {
        if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          201,
          await repository.putBlob({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (segments.length >= 5) {
        const pathname = decodeURIComponent(segments.slice(4).join("/"));

        if (request.method === "GET" || request.method === "HEAD") {
          if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
          if (!await authorizeMutation(request, response, options, "write", projectId)) {
            return;
          }

          sendJson(
            response,
            200,
            await repository.deleteBlob({
              ...((await readJsonBody(request)) as Record<string, unknown>),
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
        if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.purgeCache({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId
          } as never),
          options.allowedOrigin
        );
        return;
      }
    }

    if (segments[3] === "functions") {
      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4) {
        if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
        if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
        if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
        if (!await authorizeMutation(request, response, options, "read", projectId)) {
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
        if (!await authorizeMutation(request, response, options, "admin", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.upsertRoutingRule({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "DELETE" && segments.length === 5) {
        if (!await authorizeMutation(request, response, options, "admin", projectId)) {
          return;
        }

        sendJson(
          response,
          200,
          await repository.disableRoutingRule({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId,
            ruleId: decodeURIComponent(segments[4])
          } as never),
          options.allowedOrigin
        );
        return;
      }
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "deploy-hooks") {
      if (!await authorizeMutation(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listDeployHooks(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "deploy-hooks") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      const result = await repository.createDeployHook({
        ...((await readJsonBody(request)) as Record<string, unknown>),
        projectId
      } as never);

      sendJson(
        response,
        201,
        {
          ...result,
          hookUrl: result.hookUrl ?? deployHookUrl(request, result.token)
        },
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "deploy-hooks") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.revokeDeployHook({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId,
          hookId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "cron-jobs") {
      if (!await authorizeMutation(request, response, options, "read", projectId)) {
        return;
      }

      sendJson(response, 200, await repository.listCronJobs(projectId), options.allowedOrigin, request.method);
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[3] === "cron-jobs") {
      if (!await authorizeMutation(request, response, options, "write", projectId)) {
        return;
      }

      sendJson(
        response,
        201,
        await repository.createCronJob({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "DELETE" && segments.length === 5 && segments[3] === "cron-jobs") {
      if (!await authorizeMutation(request, response, options, "admin", projectId)) {
        return;
      }

      sendJson(
        response,
        200,
        await repository.disableCronJob({
          ...((await readJsonBody(request)) as Record<string, unknown>),
          projectId,
          jobId: decodeURIComponent(segments[4])
        } as never),
        options.allowedOrigin
      );
      return;
    }

    if (request.method === "POST" && segments.length === 6 && segments[3] === "cron-jobs" && segments[5] === "run") {
      if (!await authorizeMutation(request, response, options, "write", projectId)) {
        return;
      }

      sendJson(
        response,
        202,
        await repository.runCronJob({
          ...((await readJsonBody(request)) as Record<string, unknown>),
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
        if (!await authorizeMutation(request, response, options, "read", projectId)) {
          return;
        }

        sendJson(response, 200, await repository.getRollingRelease(projectId, channel), options.allowedOrigin, request.method);
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "start") {
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          202,
          await repository.startRollingRelease({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "advance") {
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          202,
          await repository.advanceRollingRelease({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "complete") {
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          202,
          await repository.completeRollingRelease({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[5] === "abort") {
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          202,
          await repository.abortRollingRelease({
            ...((await readJsonBody(request)) as Record<string, unknown>),
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
        sendJson(response, 200, await repository.getReleaseConsole(projectId, channel), options.allowedOrigin, request.method);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && segments.length === 5 && segments[3] === "rollback") {
        sendJson(response, 200, await repository.getRollbackConsole(projectId, channel), options.allowedOrigin, request.method);
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[3] === "release" && segments[5] === "promote") {
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          202,
          await repository.promoteDeployment({
            ...((await readJsonBody(request)) as Record<string, unknown>),
            projectId,
            channel
          } as never),
          options.allowedOrigin
        );
        return;
      }

      if (request.method === "POST" && segments.length === 6 && segments[3] === "rollback" && segments[5] === "rollback") {
        if (!await authorizeMutation(request, response, options, "write", projectId)) {
          return;
        }

        sendJson(
          response,
          202,
          await repository.rollbackDeployment({
            ...((await readJsonBody(request)) as Record<string, unknown>),
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
    sendJson(response, 200, await repository.listDeployments(url.searchParams.get("projectId") ?? undefined), options.allowedOrigin, request.method);
    return;
  }

  if (segments[1] === "deployments" && segments[2]) {
    const deploymentId = decodeURIComponent(segments[2]);

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 3) {
      sendJson(response, 200, await repository.getDeployment(deploymentId), options.allowedOrigin, request.method);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && segments.length === 4 && segments[3] === "logs") {
      sendJson(response, 200, await repository.getLogChunk(deploymentId, url.searchParams.get("cursor") ?? undefined), options.allowedOrigin, request.method);
      return;
    }
  }

  if (request.method === "POST" && segments.length === 3 && segments[1] === "deployments" && segments[2] === "prebuilt") {
    if (!await authorizeMutation(request, response, options, "write")) {
      return;
    }

    sendJson(response, 201, await repository.deployPrebuilt((await readJsonBody(request)) as never), options.allowedOrigin);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && segments[1] === "operations" && segments[2] && segments.length === 3) {
    sendJson(response, 200, await repository.pollOperation(decodeURIComponent(segments[2])), options.allowedOrigin, request.method);
    return;
  }

  notFound(response, options.allowedOrigin, request.method);
}

export function createSiteFlowServer(options: SiteFlowServerOptions) {
  return http.createServer(async (request, response) => {
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

      if (await tryServeImageOptimizationRoute({ request, response, url, segments }, options)) {
        return;
      }

      if (await tryServeArtifactRoute({ request, response, url, segments }, options)) {
        return;
      }

      await handleApiRoute({ request, response, url, segments }, options);
    } catch (error) {
      if (error instanceof SiteFlowNotFoundError) {
        sendJson(response, 404, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof ImageOptimizationInputError) {
        sendJson(response, error.statusCode, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      if (error instanceof SyntaxError || error instanceof Error && error.message.startsWith("Invalid release channel")) {
        sendJson(response, 400, { message: error.message }, options.allowedOrigin, request.method);
        return;
      }

      const message = error instanceof Error ? error.message : "Unexpected SiteFlow API error.";
      sendJson(response, 500, { message }, options.allowedOrigin, request.method);
    }
  });
}
