import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import { evaluateIngressEvidence, type IngressEvidenceCheckResult } from "./ingressEvidenceCheck.js";

type CollectStatus = "collected" | "blocked";
type CheckStatus = "pass" | "fail";

interface FetchResponseLike {
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type IngressEvidenceFetch = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface IngressEvidenceCollectOptions {
  publicBaseUrl: string;
  directApiUrl: string;
  environment: string;
  commitRef: string;
  repo: string;
  branch: string;
  trustProxyPolicy: string;
  operatorName: string;
  ticketId: string;
  outputPath?: string;
  checkOutputPath?: string;
  operatorEvidencePath?: string;
  forwardedHeaderEchoUrl?: string;
  proxyFinalHopMatched?: boolean;
  allSourcesTrusted?: boolean;
  apiInstanceCount?: number;
  apiProcessCount?: number;
  ingressCount?: number;
  multiInstance?: boolean;
  multiProcess?: boolean;
  multiIngress?: boolean;
  apiRateLimitEdgeEnforced?: boolean;
  apiRateLimitSharedAcrossInstances?: boolean;
  apiRateLimitProcessLocalOnly?: boolean;
  apiRateLimitScope?: string;
  apiRateLimitEnforcementPoint?: string;
  apiRateLimitPath?: string;
  rateLimitAttempts?: number;
  healthPath?: string;
  readyPath?: string;
  metricsPath?: string;
  previewPath?: string;
  staticPath?: string;
  timeoutMs?: number;
  maxAgeHours?: number;
  now?: () => Date;
  fetchImpl?: IngressEvidenceFetch;
}

export interface IngressEvidenceCollectCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface IngressEvidenceCollectResult {
  name: "siteflow-ingress-evidence-collect";
  status: CollectStatus;
  checkedAt: string;
  outputPath?: string;
  checkOutputPath?: string;
  evidence?: Record<string, unknown>;
  checkResult?: IngressEvidenceCheckResult;
  checks: IngressEvidenceCollectCheck[];
  exitCode: number;
}

interface ParsedArgs {
  publicBaseUrl?: string;
  directApiUrl?: string;
  environment?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  trustProxyPolicy?: string;
  operatorName?: string;
  ticketId?: string;
  outputPath?: string;
  checkOutputPath?: string;
  operatorEvidencePath?: string;
  forwardedHeaderEchoUrl?: string;
  proxyFinalHopMatched?: boolean;
  allSourcesTrusted?: boolean;
  apiInstanceCount?: number;
  apiProcessCount?: number;
  ingressCount?: number;
  multiInstance?: boolean;
  multiProcess?: boolean;
  multiIngress?: boolean;
  apiRateLimitEdgeEnforced?: boolean;
  apiRateLimitSharedAcrossInstances?: boolean;
  apiRateLimitProcessLocalOnly?: boolean;
  apiRateLimitScope?: string;
  apiRateLimitEnforcementPoint?: string;
  apiRateLimitPath: string;
  rateLimitAttempts: number;
  healthPath: string;
  readyPath: string;
  metricsPath: string;
  previewPath: string;
  staticPath: string;
  timeoutMs: number;
  maxAgeHours?: number;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultTimeoutMs = 5000;
const defaultRateLimitAttempts = 12;
const spoofedForwardedFor = "203.0.113.10";
const spoofedForwardedHost = "spoofed.siteflow.invalid";
const spoofedForwardedProto = "http";

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

function requiredString(value: string | undefined, label: string) {
  const normalized = stringValue(value);

  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function positiveNumber(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

function positiveInteger(value: number | undefined, fallback: number, label: string) {
  const candidate = positiveNumber(value, fallback, label);

  if (!Number.isSafeInteger(candidate)) {
    throw new Error(`${label} must be an integer.`);
  }

  return candidate;
}

function normalizedUrl(raw: string, label: string, requireHttps: boolean) {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (requireHttps && parsed.protocol !== "https:") {
    throw new Error(`${label} must use https.`);
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not include credentials, query strings, or fragments.`);
  }

  return parsed.toString().replace(/\/$/, "");
}

function normalizedPath(raw: string, label: string) {
  const value = requiredString(raw, label);

  if (!value.startsWith("/")) {
    throw new Error(`${label} must start with '/'.`);
  }

  if (value.includes("?") || value.includes("#")) {
    throw new Error(`${label} must not include query strings or fragments.`);
  }

  return value;
}

function targetUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function globalFetch(): IngressEvidenceFetch {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime.");
  }

  return fetch as unknown as IngressEvidenceFetch;
}

async function fetchWithTimeout(
  fetchImpl: IngressEvidenceFetch,
  url: string,
  init: FetchInitLike,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readOperatorEvidence(filePath: string | undefined) {
  if (!filePath) {
    return {};
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  const status = statusValue(parsed.status);

  if (parsed.template === true) {
    throw new Error(`${filePath} is an operator evidence template and cannot be merged into collected ingress evidence.`);
  }

  if (parsed.dryRun === true) {
    throw new Error(`${filePath} is dry-run operator evidence and cannot be merged into collected ingress evidence.`);
  }

  if (status === "blocked" || status === "todo") {
    throw new Error(`${filePath} has operator evidence status ${status} and cannot be merged into collected ingress evidence.`);
  }

  return parsed;
}

function addCheck(checks: IngressEvidenceCollectCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

async function collectDirectApiPortEvidence(options: IngressEvidenceCollectOptions, checkedAt: string) {
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const directApiUrl = normalizedUrl(options.directApiUrl, "directApiUrl", false);

  try {
    const response = await fetchWithTimeout(fetchImpl, directApiUrl, { method: "GET" }, timeoutMs);

    return {
      status: "reachable",
      checked: true,
      reachable: true,
      checkedAt,
      target: directApiUrl,
      statusCode: response.status
    };
  } catch {
    return {
      status: "blocked",
      checked: true,
      reachable: false,
      checkedAt,
      target: directApiUrl
    };
  }
}

function caseInsensitiveValue(record: Record<string, unknown>, key: string) {
  const wanted = key.toLowerCase();
  const match = Object.entries(record).find(([candidate]) => candidate.toLowerCase() === wanted);

  return stringValue(match?.[1]);
}

function observedHeaderValue(root: Record<string, unknown>, names: string[]) {
  const headers = isObject(root.headers) ? root.headers : undefined;

  for (const name of names) {
    const direct = stringValue(root[name]) ?? caseInsensitiveValue(root, name);
    const nested = headers ? caseInsensitiveValue(headers, name) : undefined;

    if (direct) {
      return direct;
    }

    if (nested) {
      return nested;
    }
  }

  return undefined;
}

async function collectForwardedHeadersEvidence(options: IngressEvidenceCollectOptions, checkedAt: string) {
  if (!options.forwardedHeaderEchoUrl) {
    return undefined;
  }

  const fetchImpl = options.fetchImpl ?? globalFetch();
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const echoUrl = normalizedUrl(options.forwardedHeaderEchoUrl, "forwardedHeaderEchoUrl", true);
  const publicHost = new URL(options.publicBaseUrl).host.toLowerCase();

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      echoUrl,
      {
        method: "GET",
        headers: {
          "x-forwarded-for": spoofedForwardedFor,
          "x-forwarded-host": spoofedForwardedHost,
          "x-forwarded-proto": spoofedForwardedProto,
          "x-siteflow-ingress-probe": "forwarded-header-sanitization"
        }
      },
      timeoutMs
    );
    const body = await response.json();
    const root = isObject(body) ? body : {};
    const observedXForwardedFor = observedHeaderValue(root, ["x-forwarded-for", "xForwardedFor"]);
    const observedXForwardedHost = observedHeaderValue(root, ["x-forwarded-host", "xForwardedHost"]);
    const observedXForwardedProto = observedHeaderValue(root, ["x-forwarded-proto", "xForwardedProto"]);
    const xForwardedForOverwritten = Boolean(observedXForwardedFor && !observedXForwardedFor.includes(spoofedForwardedFor));
    const xForwardedHostOverwritten = Boolean(observedXForwardedHost && observedXForwardedHost.toLowerCase() === publicHost);
    const xForwardedProtoOverwritten = observedXForwardedProto === "https";
    const proxyAddXForwardedForUsed = Boolean(observedXForwardedFor?.includes(","));
    const passed = response.status >= 200 &&
      response.status <= 299 &&
      xForwardedForOverwritten &&
      xForwardedHostOverwritten &&
      xForwardedProtoOverwritten &&
      !proxyAddXForwardedForUsed;

    return {
      status: passed ? "passed" : "blocked",
      checkedAt,
      endpoint: echoUrl,
      xForwardedForOverwritten,
      xForwardedHostOverwritten,
      xForwardedProtoOverwritten,
      proxyAddXForwardedForUsed,
      observed: {
        xForwardedFor: observedXForwardedFor,
        xForwardedHost: observedXForwardedHost,
        xForwardedProto: observedXForwardedProto
      }
    };
  } catch {
    return {
      status: "blocked",
      checkedAt,
      endpoint: echoUrl,
      xForwardedForOverwritten: false,
      xForwardedHostOverwritten: false,
      xForwardedProtoOverwritten: false,
      proxyAddXForwardedForUsed: true
    };
  }
}

function collectProxySourcePolicyEvidence(options: IngressEvidenceCollectOptions, checkedAt: string) {
  if (options.proxyFinalHopMatched === undefined && options.allSourcesTrusted === undefined) {
    return undefined;
  }

  const finalHopMatched = options.proxyFinalHopMatched === true;
  const allSourcesTrusted = options.allSourcesTrusted === true;

  return {
    status: finalHopMatched && !allSourcesTrusted ? "passed" : "blocked",
    checkedAt,
    configured: options.trustProxyPolicy,
    finalHopMatched,
    allSourcesTrusted
  };
}

async function collectApiRateLimitEvidence(options: IngressEvidenceCollectOptions, checkedAt: string) {
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const attempts = positiveInteger(options.rateLimitAttempts, defaultRateLimitAttempts, "rateLimitAttempts");
  const path = normalizedPath(options.apiRateLimitPath ?? "/api/projects", "apiRateLimitPath");
  const statusCodes: number[] = [];

  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        targetUrl(options.publicBaseUrl, path),
        {
          method: "GET",
          headers: {
            "cache-control": "no-store",
            "x-forwarded-for": `203.0.113.${10 + index}`,
            "x-forwarded-host": `${index}.${spoofedForwardedHost}`,
            "x-forwarded-proto": spoofedForwardedProto
          }
        },
        timeoutMs
      );

      statusCodes.push(response.status);

      if (response.status === 429) {
        break;
      }
    } catch {
      statusCodes.push(0);
      break;
    }
  }

  const rateLimited = statusCodes.includes(429);

  return {
    status: rateLimited ? "limited" : "blocked",
    checkedAt,
    path,
    attempts: statusCodes.length,
    statusCodes,
    ...(rateLimited ? { rateLimitedStatusCode: 429 } : {}),
    clientIpBucketed: rateLimited,
    spoofedXForwardedForIgnored: rateLimited,
    edgeEnforced: false
  };
}

async function collectRouteStatus(
  options: IngressEvidenceCollectOptions,
  path: string,
  kind: "application" | "metrics"
) {
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      targetUrl(options.publicBaseUrl, path),
      { method: "GET" },
      timeoutMs
    );

    return {
      path,
      statusCode: response.status,
      rateLimited: response.status === 429,
      kind
    };
  } catch {
    return {
      path,
      statusCode: 0,
      rateLimited: false,
      kind
    };
  }
}

function routePasses(route: { statusCode: number; rateLimited: boolean }, kind: "application" | "metrics") {
  if (route.rateLimited) {
    return false;
  }

  if (kind === "metrics") {
    return route.statusCode === 200 || route.statusCode === 401 || route.statusCode === 403;
  }

  return route.statusCode >= 200 && route.statusCode <= 299;
}

async function collectUnthrottledRoutesEvidence(options: IngressEvidenceCollectOptions, checkedAt: string) {
  const paths = {
    healthz: normalizedPath(options.healthPath ?? "/healthz", "healthPath"),
    readyz: normalizedPath(options.readyPath ?? "/readyz", "readyPath"),
    metrics: normalizedPath(options.metricsPath ?? "/metrics", "metricsPath"),
    preview: normalizedPath(options.previewPath ?? "/", "previewPath"),
    static: normalizedPath(options.staticPath ?? "/index.html", "staticPath")
  };
  const [healthz, readyz, metrics, preview, staticRoute] = await Promise.all([
    collectRouteStatus(options, paths.healthz, "application"),
    collectRouteStatus(options, paths.readyz, "application"),
    collectRouteStatus(options, paths.metrics, "metrics"),
    collectRouteStatus(options, paths.preview, "application"),
    collectRouteStatus(options, paths.static, "application")
  ]);
  const passed = routePasses(healthz, "application") &&
    routePasses(readyz, "application") &&
    routePasses(metrics, "metrics") &&
    routePasses(preview, "application") &&
    routePasses(staticRoute, "application");

  return {
    status: passed ? "passed" : "blocked",
    checkedAt,
    healthz,
    readyz,
    metrics,
    preview,
    static: staticRoute
  };
}

function sectionFromOperator(operatorEvidence: Record<string, unknown>, key: string) {
  return isObject(operatorEvidence[key]) ? operatorEvidence[key] : undefined;
}

function firstSectionFromOperator(operatorEvidence: Record<string, unknown>, keys: string[]) {
  return keys
    .map((key) => sectionFromOperator(operatorEvidence, key))
    .find((section): section is Record<string, unknown> => Boolean(section));
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function booleanField(source: Record<string, unknown> | undefined, key: string) {
  return typeof source?.[key] === "boolean" ? source[key] : undefined;
}

function stringField(source: Record<string, unknown> | undefined, key: string) {
  return stringValue(source?.[key]);
}

function collectDeploymentTopologyEvidence(
  options: IngressEvidenceCollectOptions,
  operatorEvidence: Record<string, unknown>
) {
  const operatorTopology = firstSectionFromOperator(operatorEvidence, ["deploymentTopology", "topology"]);
  const topology: Record<string, unknown> = {
    ...(operatorTopology ?? {})
  };

  assignDefined(topology, "apiInstanceCount", options.apiInstanceCount);
  assignDefined(topology, "apiProcessCount", options.apiProcessCount);
  assignDefined(topology, "ingressCount", options.ingressCount);
  assignDefined(topology, "multiInstance", options.multiInstance);
  assignDefined(topology, "multiProcess", options.multiProcess);
  assignDefined(topology, "multiIngress", options.multiIngress);

  return Object.keys(topology).length > 0 ? topology : undefined;
}

function collectApiRateLimitTopologyEvidence(
  options: IngressEvidenceCollectOptions,
  operatorEvidence: Record<string, unknown>
) {
  const operatorRateLimit = firstSectionFromOperator(operatorEvidence, ["apiRateLimit", "edgeRateLimit", "sharedRateLimit"]);
  const proof: Record<string, unknown> = {};

  for (const key of ["edgeEnforced", "sharedAcrossInstances", "processLocalOnly", "processLocal", "processLocalLimiter"]) {
    assignDefined(proof, key, booleanField(operatorRateLimit, key));
  }

  for (const key of ["limiterScope", "scope", "limiterType", "type", "enforcementPoint", "enforcedAt"]) {
    assignDefined(proof, key, stringField(operatorRateLimit, key));
  }

  assignDefined(proof, "edgeEnforced", options.apiRateLimitEdgeEnforced);
  assignDefined(proof, "sharedAcrossInstances", options.apiRateLimitSharedAcrossInstances);
  assignDefined(proof, "processLocalOnly", options.apiRateLimitProcessLocalOnly);
  assignDefined(proof, "limiterScope", stringValue(options.apiRateLimitScope));
  assignDefined(proof, "enforcementPoint", stringValue(options.apiRateLimitEnforcementPoint));

  return proof;
}

function finalizeEvidence(
  evidence: Record<string, unknown>,
  options: IngressEvidenceCollectOptions
) {
  const provisionalEvidence = {
    ...evidence,
    status: "passed"
  };
  const provisionalCheck = evaluateIngressEvidence(provisionalEvidence, {
    evidencePath: options.outputPath ?? "<collected-ingress-evidence>",
    commitRef: options.commitRef,
    repo: options.repo,
    branch: options.branch,
    maxAgeHours: options.maxAgeHours,
    now: options.now
  });
  const finalEvidence = {
    ...provisionalEvidence,
    status: provisionalCheck.status === "passed" ? "passed" : "blocked"
  };
  const checkResult = evaluateIngressEvidence(finalEvidence, {
    evidencePath: options.outputPath ?? "<collected-ingress-evidence>",
    commitRef: options.commitRef,
    repo: options.repo,
    branch: options.branch,
    maxAgeHours: options.maxAgeHours,
    now: options.now
  });

  return { evidence: finalEvidence, checkResult };
}

export async function collectIngressEvidence(
  options: IngressEvidenceCollectOptions
): Promise<IngressEvidenceCollectResult> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const publicBaseUrl = normalizedUrl(options.publicBaseUrl, "publicBaseUrl", true);
  const operatorEvidence = await readOperatorEvidence(options.operatorEvidencePath);
  const [directApiPort, forwardedHeaders, apiRateLimitProbe, unthrottledRoutes] = await Promise.all([
    collectDirectApiPortEvidence(options, checkedAt),
    collectForwardedHeadersEvidence({ ...options, publicBaseUrl }, checkedAt),
    collectApiRateLimitEvidence({ ...options, publicBaseUrl }, checkedAt),
    collectUnthrottledRoutesEvidence({ ...options, publicBaseUrl }, checkedAt)
  ]);
  const proxySourcePolicy = collectProxySourcePolicyEvidence(options, checkedAt) ??
    sectionFromOperator(operatorEvidence, "proxySourcePolicy");
  const deploymentTopology = collectDeploymentTopologyEvidence(options, operatorEvidence);
  const apiRateLimit = {
    ...apiRateLimitProbe,
    ...collectApiRateLimitTopologyEvidence(options, operatorEvidence)
  };
  const evidenceBase: Record<string, unknown> = {
    schemaVersion: "siteflow.ingressEvidence.v1",
    name: "siteflow-ingress-evidence",
    dryRun: false,
    checkedAt,
    environment: options.environment,
    publicBaseUrl,
    release: {
      commitRef: options.commitRef,
      repository: options.repo,
      branch: options.branch
    },
    trustProxyPolicy: options.trustProxyPolicy,
    deploymentTopology,
    directApiPort,
    forwardedHeaders: forwardedHeaders ?? sectionFromOperator(operatorEvidence, "forwardedHeaders"),
    proxySourcePolicy,
    apiRateLimit,
    unthrottledRoutes,
    operatorName: options.operatorName,
    ticketId: options.ticketId
  };
  const { evidence, checkResult } = finalizeEvidence(evidenceBase, options);
  const checks: IngressEvidenceCollectCheck[] = [];
  const secretFindings = scanEvidenceForRawSecrets(evidence);

  addCheck(
    checks,
    "direct_api_port_collected",
    directApiPort.reachable === false,
    "Collector must prove the direct API URL is not reachable outside the trusted ingress."
  );
  addCheck(
    checks,
    "api_rate_limit_collected",
    apiRateLimit.rateLimitedStatusCode === 429,
    "Collector must observe a 429 response for repeated /api requests."
  );
  addCheck(
    checks,
    "unthrottled_routes_collected",
    unthrottledRoutes.status === "passed",
    "Collector must observe non-API route responses without edge API throttling."
  );
  addCheck(
    checks,
    "deployment_topology_collected",
    checkResult.checks.some((check) => check.name === "deployment_topology_present" && check.status === "pass"),
    "Collector must include deploymentTopology/topology with API instance/process and ingress shape."
  );
  addCheck(
    checks,
    "api_rate_limit_topology_collected",
    checkResult.checks.some((check) => check.name === "api_rate_limit_topology" && check.status === "pass"),
    "Collector must include edge/shared API limiter proof when topology has multiple API instances, processes, or ingresses."
  );
  addCheck(
    checks,
    "ingress_evidence_check",
    checkResult.status === "passed",
    "Collected ingress evidence must pass ingress:evidence checks."
  );
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Collector output must not include raw secret-like values."
      : `Collector output includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );

  if (secretFindings.length > 0) {
    return {
      name: "siteflow-ingress-evidence-collect",
      status: "blocked",
      checkedAt,
      ...(options.outputPath ? { outputPath: options.outputPath } : {}),
      ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
      checks,
      exitCode: 1
    };
  }

  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  if (options.checkOutputPath) {
    await writeFile(options.checkOutputPath, `${JSON.stringify(checkResult, null, 2)}\n`, "utf8");
  }

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-ingress-evidence-collect",
    status: passed ? "collected" : "blocked",
    checkedAt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
    evidence,
    checkResult,
    checks,
    exitCode: passed ? 0 : 1
  };
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseIngressEvidenceCollectArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    apiRateLimitPath: "/api/projects",
    rateLimitAttempts: defaultRateLimitAttempts,
    healthPath: "/healthz",
    readyPath: "/readyz",
    metricsPath: "/metrics",
    previewPath: "/",
    staticPath: "/index.html",
    timeoutMs: defaultTimeoutMs,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--public-base-url") {
      parsed.publicBaseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--direct-api-url") {
      parsed.directApiUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--environment" || arg === "--target-environment") {
      parsed.environment = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--commit-ref") {
      parsed.commitRef = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--trust-proxy-policy") {
      parsed.trustProxyPolicy = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--ticket-id" || arg === "--release-ticket") {
      parsed.ticketId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-evidence") {
      parsed.operatorEvidencePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--forwarded-header-echo-url") {
      parsed.forwardedHeaderEchoUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--proxy-final-hop-matched") {
      parsed.proxyFinalHopMatched = true;
    } else if (arg === "--all-sources-trusted") {
      parsed.allSourcesTrusted = true;
    } else if (arg === "--api-instance-count") {
      parsed.apiInstanceCount = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--api-process-count") {
      parsed.apiProcessCount = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--ingress-count") {
      parsed.ingressCount = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--multi-instance") {
      parsed.multiInstance = true;
    } else if (arg === "--multi-process") {
      parsed.multiProcess = true;
    } else if (arg === "--multi-ingress") {
      parsed.multiIngress = true;
    } else if (arg === "--api-rate-limit-edge-enforced") {
      parsed.apiRateLimitEdgeEnforced = true;
    } else if (arg === "--api-rate-limit-shared-across-instances") {
      parsed.apiRateLimitSharedAcrossInstances = true;
    } else if (arg === "--api-rate-limit-process-local-only") {
      parsed.apiRateLimitProcessLocalOnly = true;
    } else if (arg === "--api-rate-limit-scope") {
      parsed.apiRateLimitScope = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--api-rate-limit-enforcement-point") {
      parsed.apiRateLimitEnforcementPoint = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--api-rate-limit-path") {
      parsed.apiRateLimitPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--rate-limit-attempts") {
      parsed.rateLimitAttempts = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--health-path") {
      parsed.healthPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--ready-path") {
      parsed.readyPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--metrics-path") {
      parsed.metricsPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--preview-path") {
      parsed.previewPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--static-path") {
      parsed.staticPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--check-output") {
      parsed.checkOutputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help) {
    requiredString(parsed.publicBaseUrl, "--public-base-url <url>");
    requiredString(parsed.directApiUrl, "--direct-api-url <url>");
    requiredString(parsed.environment, "--target-environment <name>");
    requiredString(parsed.commitRef, "--commit-ref <sha>");
    requiredString(parsed.repo, "--repo <owner/name>");
    requiredString(parsed.branch, "--branch <name>");
    requiredString(parsed.trustProxyPolicy, "--trust-proxy-policy <policy>");
    requiredString(parsed.operatorName, "--operator-name <name>");
    requiredString(parsed.ticketId, "--release-ticket <id>");
    normalizedUrl(parsed.publicBaseUrl!, "--public-base-url", true);
    normalizedUrl(parsed.directApiUrl!, "--direct-api-url", false);

    if (parsed.forwardedHeaderEchoUrl) {
      normalizedUrl(parsed.forwardedHeaderEchoUrl, "--forwarded-header-echo-url", true);
    }
  }

  positiveNumber(parsed.timeoutMs, defaultTimeoutMs, "--timeout-ms");
  positiveInteger(parsed.rateLimitAttempts, defaultRateLimitAttempts, "--rate-limit-attempts");
  positiveNumber(parsed.maxAgeHours, 24, "--max-age-hours");

  for (const [label, value] of [
    ["--api-instance-count", parsed.apiInstanceCount],
    ["--api-process-count", parsed.apiProcessCount],
    ["--ingress-count", parsed.ingressCount]
  ] as const) {
    if (value !== undefined) {
      positiveInteger(value, 1, label);
    }
  }

  for (const [label, value] of [
    ["--api-rate-limit-path", parsed.apiRateLimitPath],
    ["--health-path", parsed.healthPath],
    ["--ready-path", parsed.readyPath],
    ["--metrics-path", parsed.metricsPath],
    ["--preview-path", parsed.previewPath],
    ["--static-path", parsed.staticPath]
  ] as const) {
    normalizedPath(value, label);
  }

  return parsed;
}

export function ingressEvidenceCollectUsage() {
  return [
    "Usage: npm run --silent ingress:evidence:collect -- --public-base-url <url> --direct-api-url <url> --target-environment <name> --commit-ref <sha> --repo <owner/name> --branch <branch> --trust-proxy-policy <policy> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --operator-evidence <file>            Optional JSON with forwardedHeaders, proxySourcePolicy, deploymentTopology/topology, and apiRateLimit limiter proof.",
    "  --forwarded-header-echo-url <url>     HTTPS endpoint that echoes received X-Forwarded-* headers as JSON.",
    "  --proxy-final-hop-matched             Operator-confirmed final ingress hop matches SITEFLOW_TRUST_PROXY.",
    "  --all-sources-trusted                 Record a failing all-source proxy trust finding.",
    "  --api-instance-count <count>          Number of API service instances or replicas behind ingress.",
    "  --api-process-count <count>           Number of API processes serving the release.",
    "  --ingress-count <count>               Number of ingress/proxy entrypoints for the release.",
    "  --multi-instance                      Declare a multi-instance API topology.",
    "  --multi-process                       Declare a multi-process API topology.",
    "  --multi-ingress                       Declare multiple ingress/proxy entrypoints.",
    "  --api-rate-limit-edge-enforced        Operator-confirmed API limiter is enforced at edge/proxy/ingress.",
    "  --api-rate-limit-shared-across-instances Operator-confirmed API limiter state is shared across API instances.",
    "  --api-rate-limit-process-local-only   Record a failing process-local-only API limiter finding.",
    "  --api-rate-limit-scope <scope>        Limiter scope such as edge, shared, global, distributed, or process_local.",
    "  --api-rate-limit-enforcement-point <point> Limiter enforcement point such as edge, proxy, gateway, ingress, or api.",
    "  --api-rate-limit-path <path>          API path used for repeated 429 probing. Default: /api/projects.",
    `  --rate-limit-attempts <count>         Repeated API requests before declaring rate-limit evidence missing. Default: ${defaultRateLimitAttempts}.`,
    "  --health-path <path>                  Health route path. Default: /healthz.",
    "  --ready-path <path>                   Readiness route path. Default: /readyz.",
    "  --metrics-path <path>                 Metrics route path. Default: /metrics.",
    "  --preview-path <path>                 Preview/application route path. Default: /.",
    "  --static-path <path>                  Static asset route path. Default: /index.html.",
    "  --output <file>                       Write raw ingress evidence.",
    "  --check-output <file>                 Write ingress:evidence checker output for release:evidence:compose.",
    "  --timeout-ms <ms>                     HTTP request timeout. Default: 5000.",
    "  --max-age-hours <hours>               Maximum evidence age passed to checker output.",
    "  --json                                Print raw evidence when collected; print diagnostics when blocked.",
    "  --help                                Show this help.",
    "",
    "The collector probes target ingress paths, but proxy final-hop ownership and forwarded-header cleanup still need a target echo endpoint or operator evidence."
  ].join("\n");
}

function writeHumanResult(result: IngressEvidenceCollectResult, io: CliIo) {
  const output = result.status === "collected" ? io.stdout : io.stderr;

  output.write(`SiteFlow ingress evidence collect status: ${result.status}\n`);

  if (result.outputPath) {
    output.write(`Output: ${result.outputPath}\n`);
  }

  if (result.checkOutputPath) {
    output.write(`Check output: ${result.checkOutputPath}\n`);
  }

  if (result.status === "blocked") {
    output.write("Checks:\n");
    for (const check of result.checks) {
      output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
    }
  }
}

export async function runIngressEvidenceCollectCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<IngressEvidenceCollectOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseIngressEvidenceCollectArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${ingressEvidenceCollectUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${ingressEvidenceCollectUsage()}\n`);
    return 0;
  }

  try {
    const result = await collectIngressEvidence({
      ...baseOptions,
      publicBaseUrl: parsed.publicBaseUrl!,
      directApiUrl: parsed.directApiUrl!,
      environment: parsed.environment!,
      commitRef: parsed.commitRef!,
      repo: parsed.repo!,
      branch: parsed.branch!,
      trustProxyPolicy: parsed.trustProxyPolicy!,
      operatorName: parsed.operatorName!,
      ticketId: parsed.ticketId!,
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      operatorEvidencePath: parsed.operatorEvidencePath,
      forwardedHeaderEchoUrl: parsed.forwardedHeaderEchoUrl,
      proxyFinalHopMatched: parsed.proxyFinalHopMatched,
      allSourcesTrusted: parsed.allSourcesTrusted,
      apiInstanceCount: parsed.apiInstanceCount,
      apiProcessCount: parsed.apiProcessCount,
      ingressCount: parsed.ingressCount,
      multiInstance: parsed.multiInstance,
      multiProcess: parsed.multiProcess,
      multiIngress: parsed.multiIngress,
      apiRateLimitEdgeEnforced: parsed.apiRateLimitEdgeEnforced,
      apiRateLimitSharedAcrossInstances: parsed.apiRateLimitSharedAcrossInstances,
      apiRateLimitProcessLocalOnly: parsed.apiRateLimitProcessLocalOnly,
      apiRateLimitScope: parsed.apiRateLimitScope,
      apiRateLimitEnforcementPoint: parsed.apiRateLimitEnforcementPoint,
      apiRateLimitPath: parsed.apiRateLimitPath,
      rateLimitAttempts: parsed.rateLimitAttempts,
      healthPath: parsed.healthPath,
      readyPath: parsed.readyPath,
      metricsPath: parsed.metricsPath,
      previewPath: parsed.previewPath,
      staticPath: parsed.staticPath,
      timeoutMs: parsed.timeoutMs,
      maxAgeHours: parsed.maxAgeHours
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result.status === "collected" ? result.evidence : result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: IngressEvidenceCollectResult = {
      name: "siteflow-ingress-evidence-collect",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      checks: [
        {
          name: "collect",
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
  runIngressEvidenceCollectCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
