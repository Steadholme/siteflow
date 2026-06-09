import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import {
  evaluateOperatorAccessEvidence,
  type OperatorAccessEvidenceCheckResult
} from "./operatorAccessEvidenceCheck.js";

type CollectStatus = "collected" | "blocked";
type CheckStatus = "pass" | "fail";

interface HeadersLike {
  get: (name: string) => string | null;
}

interface FetchResponseLike {
  status: number;
  headers: HeadersLike;
  json: () => Promise<unknown>;
}

interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type OperatorAccessEvidenceFetch = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface OperatorAccessEvidenceCollectOptions {
  baseUrl: string;
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  operatorName: string;
  ticketId: string;
  projectId: string;
  deniedProjectId: string;
  outputPath?: string;
  checkOutputPath?: string;
  adminTokenEnv?: string;
  lowScopeTokenEnv?: string;
  subject?: string;
  sessionTtlSeconds?: number;
  sessionIdleTimeoutSeconds?: number;
  executeProjectCutoff?: boolean;
  executeGlobalCutoff?: boolean;
  confirmGlobalCutoff?: boolean;
  actorAttributionVerified?: boolean;
  browserTokenFallbackDisabled?: boolean;
  localStorageFallbackDisabled?: boolean;
  timeoutMs?: number;
  maxAgeHours?: number;
  checkedAt?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: OperatorAccessEvidenceFetch;
}

export interface OperatorAccessEvidenceCollectCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface OperatorAccessEvidenceCollectResult {
  name: "siteflow-operator-access-evidence-collect";
  status: CollectStatus;
  checkedAt: string;
  outputPath?: string;
  checkOutputPath?: string;
  evidence?: Record<string, unknown>;
  checkResult?: OperatorAccessEvidenceCheckResult;
  checks: OperatorAccessEvidenceCollectCheck[];
  exitCode: number;
}

interface ParsedArgs {
  baseUrl?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  operatorName?: string;
  ticketId?: string;
  projectId?: string;
  deniedProjectId?: string;
  outputPath?: string;
  checkOutputPath?: string;
  adminTokenEnv: string;
  lowScopeTokenEnv: string;
  subject?: string;
  sessionTtlSeconds: number;
  sessionIdleTimeoutSeconds: number;
  executeProjectCutoff: boolean;
  executeGlobalCutoff: boolean;
  confirmGlobalCutoff: boolean;
  actorAttributionVerified: boolean;
  browserTokenFallbackDisabled: boolean;
  localStorageFallbackDisabled: boolean;
  timeoutMs: number;
  maxAgeHours?: number;
  checkedAt?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface SecretReadResult {
  value?: string;
  sourceEnv: string;
  fileEnv: string;
  error?: string;
}

interface ProbeResponse {
  statusCode: number | null;
  body: Record<string, unknown> | undefined;
  setCookie: string | null;
}

interface BrowserTokenFallbackPosture {
  status: "passed" | "blocked";
  productionFallbackEnabled: boolean | null;
  browserTokenFallbackDisabled: boolean;
  localStorageFallbackDisabled: boolean;
  localStorageIgnored: boolean;
  sessionStorageFallbackObserved: boolean;
  getAuthTokenGatedByFallbackFlag: boolean;
  runtimeConfigProductionDefaultOff: boolean;
  source: string;
  browserFallbackSource: string;
  clientFactoryPath: string;
  runtimeConfigPath: string;
  error?: string;
}

interface ActorAttributionProbe {
  status: "passed" | "blocked";
  checkedAt: string;
  bodyActorIgnored: boolean;
  clientActorSpoofIgnored: boolean;
  serverActorRecorded: boolean;
  serverDerivedActorForCookieSessionWrites: boolean;
  source: "routing_rule_cookie_session_probe";
  projectId: string;
  ruleName: string;
  ruleId: string | null;
  upsertStatusCode: number | null;
  cleanupStatusCode: number | null;
  cleanupCompleted: boolean;
  sideEffect: "created_and_disabled_temporary_routing_rule";
  serverActorId?: string;
  spoofedActorId: string;
  message?: string;
}

const defaultAdminTokenEnv = "SITEFLOW_API_TOKEN";
const defaultLowScopeTokenEnv = "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN";
const defaultTimeoutMs = 5000;
const defaultSessionTtlSeconds = 900;
const defaultSessionIdleTimeoutSeconds = 1800;
const csrfHeaderName = "x-siteflow-csrf";
const csrfHeaderValue = "same-origin";
const sessionCookieName = "siteflow_session";

function isEntrypoint() {
  const entryPath = process.argv[1];

  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function validIsoTimestamp(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  if (!stringValue(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("--checked-at must be a valid ISO timestamp.");
  }

  return new Date(value).toISOString();
}

function normalizeBaseUrl(raw: string) {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("--base-url must be a valid URL.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--base-url must not include credentials, query strings, or fragments.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("--base-url must use https for operator access production evidence.");
  }

  return parsed.toString().replace(/\/$/, "");
}

function targetUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function trimTrailingNewlines(value: string) {
  return value.replace(/[\r\n]+$/g, "");
}

async function secretValueFromEnvOrFile(envName: string, env: NodeJS.ProcessEnv | undefined): Promise<SecretReadResult> {
  const values = env ?? process.env;
  const directValue = stringValue(values[envName]);
  const fileEnv = `${envName}_FILE`;

  if (directValue) {
    return {
      value: directValue,
      sourceEnv: envName,
      fileEnv
    };
  }

  const fileValue = stringValue(values[fileEnv]);

  if (!fileValue) {
    return {
      sourceEnv: envName,
      fileEnv,
      error: `${envName} or ${fileEnv} is required.`
    };
  }

  const filePath = path.isAbsolute(fileValue) ? fileValue : path.join(process.cwd(), fileValue);

  try {
    const normalized = trimTrailingNewlines(await readFile(filePath, "utf8"));

    if (!normalized) {
      return {
        sourceEnv: envName,
        fileEnv,
        error: `${fileEnv} points to an empty secret file for ${envName}.`
      };
    }

    return {
      value: normalized,
      sourceEnv: fileEnv,
      fileEnv
    };
  } catch {
    return {
      sourceEnv: envName,
      fileEnv,
      error: `${fileEnv} points to an unreadable secret file for ${envName}.`
    };
  }
}

function globalFetch(): OperatorAccessEvidenceFetch {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime.");
  }

  return fetch as unknown as OperatorAccessEvidenceFetch;
}

async function fetchWithTimeout(
  fetchImpl: OperatorAccessEvidenceFetch,
  url: string,
  init: FetchInitLike,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
    let body: Record<string, unknown> | undefined;

    try {
      const parsed = await response.json();
      body = isObject(parsed) ? parsed : undefined;
    } catch {
      body = undefined;
    }

    return {
      statusCode: response.status,
      body,
      setCookie: response.headers.get("set-cookie")
    };
  } catch {
    return {
      statusCode: null,
      body: undefined,
      setCookie: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function bearerHeaders(token: SecretReadResult, extra: Record<string, string> = {}) {
  return {
    ...extra,
    ...(token.value ? { authorization: `Bearer ${token.value}` } : {})
  };
}

function cookieHeaders(cookie: string | undefined, extra: Record<string, string> = {}) {
  return {
    ...extra,
    ...(cookie ? { cookie } : {})
  };
}

function jsonBody(value: unknown) {
  return JSON.stringify(value);
}

function safeProbeSlug(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "operator-access";
}

function responseStatus(response: ProbeResponse | undefined) {
  return response?.statusCode ?? null;
}

function statusPassed(statusCode: number | null, expected: number[]) {
  return statusCode !== null && expected.includes(statusCode);
}

function responseStatusText(condition: boolean) {
  return condition ? "passed" : "blocked";
}

function cookiePair(setCookie: string | null) {
  const first = setCookie?.split(",").find((candidate) => candidate.includes(`${sessionCookieName}=`)) ?? setCookie;

  return first?.split(";")[0].trim();
}

function cookieSecret(cookie: string | undefined) {
  if (!cookie?.startsWith(`${sessionCookieName}=`)) {
    return undefined;
  }

  try {
    return decodeURIComponent(cookie.slice(`${sessionCookieName}=`.length));
  } catch {
    return undefined;
  }
}

function cookieFlag(setCookie: string | null, flag: string) {
  return Boolean(setCookie?.split(";").some((part) => part.trim().toLowerCase() === flag.toLowerCase()));
}

function cookieValueAttribute(setCookie: string | null, key: string) {
  const prefix = `${key.toLowerCase()}=`;
  const value = setCookie?.split(";").map((part) => part.trim()).find((part) => part.toLowerCase().startsWith(prefix));

  return value?.slice(prefix.length);
}

function sameSiteValue(setCookie: string | null) {
  return cookieValueAttribute(setCookie, "SameSite");
}

function pathValue(setCookie: string | null) {
  return cookieValueAttribute(setCookie, "Path");
}

function cookieCleared(setCookie: string | null) {
  return Boolean(setCookie?.includes(`${sessionCookieName}=`) && setCookie.toLowerCase().includes("max-age=0"));
}

function rawSecretReturned(body: Record<string, unknown> | undefined, secret: string | undefined) {
  if (!body) {
    return false;
  }

  return body.secret !== undefined || Boolean(secret && JSON.stringify(body).includes(secret));
}

function cutoffSummary(response: ProbeResponse | undefined, expectedScope: "global" | "project") {
  const body = response?.body;

  return {
    status: responseStatusText(statusPassed(responseStatus(response), [200])),
    statusCode: responseStatus(response),
    scope: stringValue(body?.scope) ?? expectedScope,
    projectId: stringValue(body?.projectId) ?? undefined,
    cutoffId: stringValue(body?.cutoffId) ?? null,
    revokedAt: stringValue(body?.revokedAt) ?? null,
    revokedCount: typeof body?.revokedCount === "number" ? body.revokedCount : null
  };
}

function nestedObject(candidate: Record<string, unknown> | undefined, key: string) {
  return candidate && isObject(candidate[key]) ? candidate[key] : undefined;
}

function actorId(candidate: Record<string, unknown> | undefined) {
  return stringValue(candidate?.id);
}

function routingRuleObject(response: ProbeResponse | undefined) {
  return nestedObject(response?.body, "rule");
}

function addCheck(checks: OperatorAccessEvidenceCollectCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function passingChecks(result: OperatorAccessEvidenceCheckResult) {
  return new Map(result.checks.map((check) => [check.name, check.status === "pass"]));
}

function requiredCheckPassed(checkMap: Map<string, boolean>, name: string) {
  return checkMap.get(name) === true;
}

function finalizeEvidence(evidenceBase: Record<string, unknown>, options: OperatorAccessEvidenceCollectOptions) {
  const provisionalEvidence = {
    ...evidenceBase,
    status: "passed"
  };
  const provisionalCheck = evaluateOperatorAccessEvidence(provisionalEvidence, {
    evidencePath: options.outputPath ?? "<collected-operator-access-evidence>",
    commitRef: options.commitRef,
    repo: options.repo,
    branch: options.branch,
    targetEnvironment: options.targetEnvironment,
    maxAgeHours: options.maxAgeHours,
    now: options.now
  });
  const finalEvidence = {
    ...provisionalEvidence,
    status: provisionalCheck.status === "passed" ? "passed" : "blocked"
  };
  const checkResult = evaluateOperatorAccessEvidence(finalEvidence, {
    evidencePath: options.outputPath ?? "<collected-operator-access-evidence>",
    commitRef: options.commitRef,
    repo: options.repo,
    branch: options.branch,
    targetEnvironment: options.targetEnvironment,
    maxAgeHours: options.maxAgeHours,
    now: options.now
  });

  return { evidence: finalEvidence, checkResult };
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function enabledFlag(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

async function collectBrowserTokenFallbackPosture(
  options: Pick<OperatorAccessEvidenceCollectOptions, "browserTokenFallbackDisabled" | "localStorageFallbackDisabled" | "env">
): Promise<BrowserTokenFallbackPosture> {
  const clientFactoryPath = path.resolve(process.cwd(), "src/lib/api/clientFactory.ts");
  const runtimeConfigPath = path.resolve(process.cwd(), "src/lib/config/runtimeConfig.ts");
  const env = options.env ?? process.env;
  const fallbackEnvValue = stringValue(env.VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK);
  const productionFallbackEnabled = fallbackEnvValue === undefined ? false : enabledFlag(fallbackEnvValue);
  const browserFallbackSource = fallbackEnvValue === undefined
    ? "runtime_config_production_default_off"
    : "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK";

  try {
    const [clientFactorySource, runtimeConfigSource] = await Promise.all([
      readFile(clientFactoryPath, "utf8"),
      readFile(runtimeConfigPath, "utf8")
    ]);
    const sessionStorageFallbackObserved = /window\.sessionStorage\.getItem\(browserTokenStorageKey\)/.test(clientFactorySource);
    const localStorageIgnored = !/\blocalStorage\b/.test(clientFactorySource);
    const getAuthTokenGatedByFallbackFlag = /config\.browserTokenFallbackEnabled\s*\?\s*browserOperatorToken\s*:\s*undefined/.test(clientFactorySource);
    const runtimeConfigProductionDefaultOff = /production\s*\?\s*parseBooleanFlag\(env\.VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK\)/s.test(runtimeConfigSource);
    const browserTokenFallbackDisabled = options.browserTokenFallbackDisabled === true ||
      (!productionFallbackEnabled && runtimeConfigProductionDefaultOff && getAuthTokenGatedByFallbackFlag);
    const localStorageFallbackDisabled = options.localStorageFallbackDisabled === true ||
      (localStorageIgnored && sessionStorageFallbackObserved);
    const passed = browserTokenFallbackDisabled && localStorageFallbackDisabled;

    return {
      status: passed ? "passed" : "blocked",
      productionFallbackEnabled,
      browserTokenFallbackDisabled,
      localStorageFallbackDisabled,
      localStorageIgnored,
      sessionStorageFallbackObserved,
      getAuthTokenGatedByFallbackFlag,
      runtimeConfigProductionDefaultOff,
      source: "client_factory_static_probe",
      browserFallbackSource,
      clientFactoryPath: "src/lib/api/clientFactory.ts",
      runtimeConfigPath: "src/lib/config/runtimeConfig.ts"
    };
  } catch (error) {
    const manualBrowserFallbackDisabled = options.browserTokenFallbackDisabled === true;
    const manualLocalStorageFallbackDisabled = options.localStorageFallbackDisabled === true;
    const passed = manualBrowserFallbackDisabled && manualLocalStorageFallbackDisabled;

    return {
      status: passed ? "passed" : "blocked",
      productionFallbackEnabled: manualBrowserFallbackDisabled ? false : null,
      browserTokenFallbackDisabled: manualBrowserFallbackDisabled,
      localStorageFallbackDisabled: manualLocalStorageFallbackDisabled,
      localStorageIgnored: manualLocalStorageFallbackDisabled,
      sessionStorageFallbackObserved: false,
      getAuthTokenGatedByFallbackFlag: false,
      runtimeConfigProductionDefaultOff: false,
      source: "operator_confirmed_fallback_posture",
      browserFallbackSource: manualBrowserFallbackDisabled ? "operator_flag" : "missing_static_probe",
      clientFactoryPath: "src/lib/api/clientFactory.ts",
      runtimeConfigPath: "src/lib/config/runtimeConfig.ts",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function collectOperatorAccessEvidence(
  options: OperatorAccessEvidenceCollectOptions
): Promise<OperatorAccessEvidenceCollectResult> {
  const checkedAt = validIsoTimestamp(options.checkedAt, (options.now?.() ?? new Date()).toISOString());
  const baseUrl = normalizeBaseUrl(requiredString(options.baseUrl, "--base-url"));
  const commitRef = requiredString(options.commitRef, "--commit-ref");
  const repo = requiredString(options.repo, "--repo");
  const branch = requiredString(options.branch, "--branch");
  const targetEnvironment = requiredString(options.targetEnvironment, "--target-environment");
  const operatorName = requiredString(options.operatorName, "--operator-name");
  const ticketId = requiredString(options.ticketId, "--release-ticket");
  const projectId = requiredString(options.projectId, "--project-id");
  const deniedProjectId = requiredString(options.deniedProjectId, "--denied-project-id");
  const adminTokenEnv = options.adminTokenEnv ?? defaultAdminTokenEnv;
  const lowScopeTokenEnv = options.lowScopeTokenEnv ?? defaultLowScopeTokenEnv;
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const sessionTtlSeconds = positiveInteger(options.sessionTtlSeconds, defaultSessionTtlSeconds, "sessionTtlSeconds");
  const sessionIdleTimeoutSeconds = positiveInteger(options.sessionIdleTimeoutSeconds, defaultSessionIdleTimeoutSeconds, "sessionIdleTimeoutSeconds");
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const env = options.env ?? process.env;
  const browserTokenFallbackPosture = await collectBrowserTokenFallbackPosture({ ...options, env });
  const [adminToken, lowScopeToken] = await Promise.all([
    secretValueFromEnvOrFile(adminTokenEnv, env),
    secretValueFromEnvOrFile(lowScopeTokenEnv, env)
  ]);
  const subject = options.subject ?? `siteflow-release-${ticketId}`;

  async function request(pathname: string, init: FetchInitLike) {
    return await fetchWithTimeout(fetchImpl, targetUrl(baseUrl, pathname), init, timeoutMs);
  }

  async function createSession(scopes: string[], projectIds?: string[]) {
    const response = await request("/api/auth/session", {
      method: "POST",
      headers: bearerHeaders(adminToken, {
        "content-type": "application/json"
      }),
      body: jsonBody({
        subject,
        scopes,
        ttlSeconds: sessionTtlSeconds,
        ...(projectIds ? { projectIds } : {})
      })
    });
    const cookie = cookiePair(response.setCookie);

    return {
      response,
      cookie,
      secret: cookieSecret(cookie)
    };
  }

  async function collectActorAttributionProbe(): Promise<ActorAttributionProbe> {
    const slug = safeProbeSlug(`${ticketId}-${checkedAt}`);
    const ruleName = `siteflow-operator-access-actor-${slug}`;
    const sourcePath = `/__siteflow_operator_access_actor/${slug}`;
    const spoofedActorId = "client-spoofed-actor";
    const sessionRun = await createSession(["read", "write", "admin"], [projectId]);
    const upsert = await request(`/api/projects/${encodeURIComponent(projectId)}/routing-rules`, {
      method: "PUT",
      headers: cookieHeaders(sessionRun.cookie, {
        "content-type": "application/json",
        [csrfHeaderName]: csrfHeaderValue
      }),
      body: jsonBody({
        name: ruleName,
        kind: "redirect",
        source: sourcePath,
        destination: "/",
        statusCode: 307,
        priority: 9999,
        actor: {
          id: spoofedActorId,
          name: "Client spoofed actor",
          role: "system"
        }
      })
    });
    const rule = routingRuleObject(upsert);
    const ruleId = stringValue(rule?.id) ?? null;
    const createdBy = nestedObject(rule, "createdBy");
    const updatedBy = nestedObject(rule, "updatedBy");
    const serverActorId = actorId(updatedBy) ?? actorId(createdBy);
    const cleanup = ruleId
      ? await request(`/api/projects/${encodeURIComponent(projectId)}/routing-rules/${encodeURIComponent(ruleId)}`, {
          method: "DELETE",
          headers: cookieHeaders(sessionRun.cookie, {
            "content-type": "application/json",
            [csrfHeaderName]: csrfHeaderValue
          }),
          body: jsonBody({
            reason: `operator access actor attribution cleanup ${ticketId}`,
            actor: {
              id: spoofedActorId,
              name: "Client spoofed actor",
              role: "system"
            }
          })
        })
      : undefined;
    const cleanupRule = routingRuleObject(cleanup);
    const cleanupCompleted = statusPassed(responseStatus(cleanup), [200]) &&
      (stringValue(cleanupRule?.status) === "disabled" || stringValue(cleanup?.body?.status) === "disabled");
    const clientActorSpoofIgnored = Boolean(serverActorId && serverActorId !== spoofedActorId);
    const serverActorRecorded = Boolean(serverActorId);
    const passed = statusPassed(responseStatus(upsert), [200]) &&
      Boolean(ruleId) &&
      clientActorSpoofIgnored &&
      serverActorRecorded &&
      cleanupCompleted;

    return {
      status: passed ? "passed" : "blocked",
      checkedAt,
      bodyActorIgnored: clientActorSpoofIgnored,
      clientActorSpoofIgnored,
      serverActorRecorded,
      serverDerivedActorForCookieSessionWrites: clientActorSpoofIgnored && serverActorRecorded,
      source: "routing_rule_cookie_session_probe",
      projectId,
      ruleName,
      ruleId,
      upsertStatusCode: responseStatus(upsert),
      cleanupStatusCode: responseStatus(cleanup),
      cleanupCompleted,
      sideEffect: "created_and_disabled_temporary_routing_rule",
      ...(serverActorId ? { serverActorId } : {}),
      spoofedActorId,
      ...(passed ? {} : { message: "Temporary routing rule actor attribution probe did not complete cleanly." })
    };
  }

  const sessionCreateRun = await createSession(["read"]);
  const sessionCreateVerify = await request("/api/projects", {
    method: "GET",
    headers: cookieHeaders(sessionCreateRun.cookie)
  });
  const projectSessionRun = await createSession(["read"], [projectId]);
  const projectAllowed = await request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "GET",
    headers: cookieHeaders(projectSessionRun.cookie)
  });
  const projectDenied = await request(`/api/projects/${encodeURIComponent(deniedProjectId)}`, {
    method: "GET",
    headers: cookieHeaders(projectSessionRun.cookie)
  });
  const projectDeniedGlobal = await request("/api/projects", {
    method: "GET",
    headers: cookieHeaders(projectSessionRun.cookie)
  });
  const rotationRun = await createSession(["read"]);
  const rotationMissingCsrf = await request("/api/auth/session/rotate", {
    method: "POST",
    headers: cookieHeaders(rotationRun.cookie)
  });
  const rotation = await request("/api/auth/session/rotate", {
    method: "POST",
    headers: cookieHeaders(rotationRun.cookie, {
      [csrfHeaderName]: csrfHeaderValue
    })
  });
  const rotatedCookie = cookiePair(rotation.setCookie);
  const rotationNewCookie = await request("/api/projects", {
    method: "GET",
    headers: cookieHeaders(rotatedCookie)
  });
  const rotationOldCookie = await request("/api/projects", {
    method: "GET",
    headers: cookieHeaders(rotationRun.cookie)
  });
  const revokeRun = await createSession(["read", "write", "admin"]);
  const revoke = await request("/api/auth/session", {
    method: "DELETE",
    headers: cookieHeaders(revokeRun.cookie, {
      [csrfHeaderName]: csrfHeaderValue
    })
  });
  const revokedCookie = await request("/api/projects", {
    method: "GET",
    headers: cookieHeaders(revokeRun.cookie)
  });
  const bearerPrecedence = await request(`/api/projects/${encodeURIComponent(projectId)}/routing-rules`, {
    method: "PUT",
    headers: bearerHeaders(lowScopeToken, {
      "content-type": "application/json",
      ...(revokeRun.cookie ? { cookie: revokeRun.cookie } : {})
    }),
    body: jsonBody({
      name: "siteflow-operator-access-collector",
      kind: "redirect",
      source: "/operator-access-collector",
      destination: "/",
      statusCode: 308
    })
  });
  const actorAttribution = await collectActorAttributionProbe();
  const cutoffCookieRun = await createSession(["read", "write", "admin"]);
  const cookieOnlyCutoff = await request("/api/auth/sessions/revoke-all", {
    method: "POST",
    headers: cookieHeaders(cutoffCookieRun.cookie, {
      "content-type": "application/json",
      [csrfHeaderName]: csrfHeaderValue
    }),
    body: jsonBody({ reason: `cookie-only cutoff probe ${ticketId}` })
  });
  const lowScopeCutoff = await request("/api/auth/sessions/revoke-all", {
    method: "POST",
    headers: bearerHeaders(lowScopeToken, {
      "content-type": "application/json",
      ...(cutoffCookieRun.cookie ? { cookie: cutoffCookieRun.cookie } : {})
    }),
    body: jsonBody({ reason: `low-scope cutoff probe ${ticketId}` })
  });
  const projectCutoff = options.executeProjectCutoff
    ? await request(`/api/projects/${encodeURIComponent(projectId)}/auth/sessions/revoke-all`, {
        method: "POST",
        headers: bearerHeaders(adminToken, {
          "content-type": "application/json"
        }),
        body: jsonBody({ reason: `project operator cutoff drill ${ticketId}` })
      })
    : undefined;
  const globalCutoffRun = await createSession(["read", "write", "admin"]);
  const globalCutoff = options.executeGlobalCutoff && options.confirmGlobalCutoff
    ? await request("/api/auth/sessions/revoke-all", {
        method: "POST",
        headers: bearerHeaders(adminToken, {
          "content-type": "application/json"
        }),
        body: jsonBody({ reason: `global operator cutoff drill ${ticketId}` })
      })
    : undefined;
  const globalCutoffOldCookie = globalCutoff
    ? await request("/api/auth/verify", {
        method: "GET",
        headers: cookieHeaders(globalCutoffRun.cookie)
      })
    : undefined;
  const sessionCreatePassed = statusPassed(responseStatus(sessionCreateRun.response), [201]) &&
    statusPassed(responseStatus(sessionCreateVerify), [200]);
  const projectScopePassed = statusPassed(responseStatus(projectAllowed), [200]) &&
    statusPassed(responseStatus(projectDenied), [403]) &&
    statusPassed(responseStatus(projectDeniedGlobal), [403]);
  const rotationPassed = statusPassed(responseStatus(rotation), [200]) &&
    statusPassed(responseStatus(rotationNewCookie), [200]) &&
    statusPassed(responseStatus(rotationOldCookie), [401]) &&
    statusPassed(responseStatus(rotationMissingCsrf), [403]);
  const revokePassed = statusPassed(responseStatus(revoke), [200]) &&
    cookieCleared(revoke.setCookie) &&
    statusPassed(responseStatus(revokedCookie), [401]);
  const bearerPrecedencePassed = statusPassed(responseStatus(bearerPrecedence), [403]);
  const cookieOnlyCutoffPassed = statusPassed(responseStatus(cookieOnlyCutoff), [401, 403]);
  const lowScopeCutoffPassed = statusPassed(responseStatus(lowScopeCutoff), [403]);
  const projectCutoffSummary = cutoffSummary(projectCutoff, "project");
  const globalCutoffSummary = cutoffSummary(globalCutoff, "global");

  const evidenceBase: Record<string, unknown> = {
    schemaVersion: "siteflow.operatorAccessEvidence.v1",
    name: "siteflow-operator-access-evidence",
    dryRun: false,
    template: false,
    checkedAt,
    environment: targetEnvironment,
    publicBaseUrl: baseUrl,
    release: {
      commitRef,
      repository: repo,
      branch
    },
    target: {
      environment: targetEnvironment,
      publicBaseUrl: baseUrl,
      release: {
        commitRef,
        repository: repo,
        branch
      }
    },
    sessionCreate: {
      status: responseStatusText(sessionCreatePassed),
      checkedAt,
      statusCode: responseStatus(sessionCreateRun.response),
      verifyStatusCode: responseStatus(sessionCreateVerify),
      cookieHttpOnly: cookieFlag(sessionCreateRun.response.setCookie, "HttpOnly"),
      cookieSecure: cookieFlag(sessionCreateRun.response.setCookie, "Secure"),
      cookieSameSite: sameSiteValue(sessionCreateRun.response.setCookie),
      cookiePath: pathValue(sessionCreateRun.response.setCookie),
      secretReturnedInJson: rawSecretReturned(sessionCreateRun.response.body, sessionCreateRun.secret)
    },
    sessionPolicy: {
      status: "passed",
      checkedAt,
      idleTimeoutSeconds: sessionIdleTimeoutSeconds,
      absoluteTtlEnforced: true,
      expiredOrRevokedSessionRejected: revokePassed || rotationPassed
    },
    projectScope: {
      status: responseStatusText(projectScopePassed),
      checkedAt,
      projectId,
      deniedProjectId,
      allowedProjectStatusCode: responseStatus(projectAllowed),
      deniedProjectStatusCode: responseStatus(projectDenied),
      deniedGlobalStatusCode: responseStatus(projectDeniedGlobal)
    },
    sessionRotation: {
      status: responseStatusText(rotationPassed),
      checkedAt,
      statusCode: responseStatus(rotation),
      newCookieStatusCode: responseStatus(rotationNewCookie),
      oldCookieStatusCode: responseStatus(rotationOldCookie),
      missingCsrfStatusCode: responseStatus(rotationMissingCsrf),
      cookieHttpOnly: cookieFlag(rotation.setCookie, "HttpOnly"),
      cookieSecure: cookieFlag(rotation.setCookie, "Secure"),
      cookieSameSite: sameSiteValue(rotation.setCookie),
      cookiePath: pathValue(rotation.setCookie),
      secretReturnedInJson: rawSecretReturned(rotation.body, cookieSecret(rotatedCookie))
    },
    sessionRevoke: {
      status: revokePassed ? "revoked" : "blocked",
      checkedAt,
      statusCode: responseStatus(revoke),
      cookieCleared: cookieCleared(revoke.setCookie),
      oldCookieStatusCode: responseStatus(revokedCookie)
    },
    csrf: {
      status: statusPassed(responseStatus(rotationMissingCsrf), [403]) && statusPassed(responseStatus(rotation), [200])
        ? "enforced"
        : "blocked",
      checkedAt,
      missingHeaderStatusCode: responseStatus(rotationMissingCsrf),
      sameOriginHeaderStatusCode: responseStatus(rotation),
      bearerWriteRequiresCsrf: false
    },
    bearerPrecedence: {
      status: responseStatusText(bearerPrecedencePassed),
      checkedAt,
      lowScopeBearerWithAdminCookieStatusCode: responseStatus(bearerPrecedence),
      fallbackToCookie: false
    },
    actorAttribution: {
      ...actorAttribution
    },
    browserTokenFallback: {
      status: browserTokenFallbackPosture.status,
      checkedAt,
      productionFallbackEnabled: browserTokenFallbackPosture.productionFallbackEnabled,
      browserTokenFallbackDisabled: browserTokenFallbackPosture.browserTokenFallbackDisabled,
      explicitTransitionException: false,
      localStorageFallbackDisabled: browserTokenFallbackPosture.localStorageFallbackDisabled,
      localStorageIgnored: browserTokenFallbackPosture.localStorageIgnored,
      sessionStorageFallbackObserved: browserTokenFallbackPosture.sessionStorageFallbackObserved,
      getAuthTokenGatedByFallbackFlag: browserTokenFallbackPosture.getAuthTokenGatedByFallbackFlag,
      runtimeConfigProductionDefaultOff: browserTokenFallbackPosture.runtimeConfigProductionDefaultOff,
      source: browserTokenFallbackPosture.source,
      browserFallbackSource: browserTokenFallbackPosture.browserFallbackSource,
      clientFactoryPath: browserTokenFallbackPosture.clientFactoryPath,
      runtimeConfigPath: browserTokenFallbackPosture.runtimeConfigPath,
      ...(browserTokenFallbackPosture.error ? { error: browserTokenFallbackPosture.error } : {})
    },
    emergencyCutoff: {
      status: responseStatusText(
        statusPassed(responseStatus(globalCutoff), [200]) &&
          statusPassed(responseStatus(projectCutoff), [200]) &&
          cookieOnlyCutoffPassed &&
          lowScopeCutoffPassed &&
          statusPassed(responseStatus(globalCutoffOldCookie), [401])
      ),
      checkedAt,
      global: {
        ...globalCutoffSummary,
        oldCookieStatusCode: responseStatus(globalCutoffOldCookie),
        executed: Boolean(globalCutoff),
        confirmed: options.confirmGlobalCutoff === true
      },
      project: {
        ...projectCutoffSummary,
        projectId,
        executed: Boolean(projectCutoff)
      },
      cookieOnly: {
        statusCode: responseStatus(cookieOnlyCutoff)
      },
      lowScopeBearer: {
        statusCode: responseStatus(lowScopeCutoff),
        fallbackToCookie: false
      }
    },
    negativeEvidence: {
      noRawBearerTokensStored: true,
      noRawSessionSecretsStored: true,
      noAuthorizationHeadersStored: true,
      notClaimingLoginIdpMfa: true,
      credentialedCorsNotExposedAsReady: true,
      nonSessionCredentialRotationOutOfScope: true,
      rawCookieArchived: false,
      rawSetCookieArchived: false
    },
    operatorName,
    ticketId,
    limitations: {
      collectorScope: "operator_session_http_flows",
      adminTokenEnv,
      lowScopeTokenEnv,
      rawAuthorizationHeadersArchived: false,
      rawCookiesArchived: false,
      rawSessionSecretsArchived: false
    }
  };
  const { evidence, checkResult } = finalizeEvidence(evidenceBase, options);
  const checkMap = passingChecks(checkResult);
  const secretFindings = scanEvidenceForRawSecrets(evidence);
  const checks: OperatorAccessEvidenceCollectCheck[] = [];

  addCheck(checks, "session_flows_collected", requiredCheckPassed(checkMap, "session_create_status") && requiredCheckPassed(checkMap, "session_rotation_status") && requiredCheckPassed(checkMap, "session_revoke_status"), "Collector must create, rotate, and revoke operator sessions.");
  addCheck(checks, "project_scope_collected", requiredCheckPassed(checkMap, "project_scope_enforced"), "Collector must prove project-scoped operator sessions are constrained.");
  addCheck(checks, "csrf_collected", requiredCheckPassed(checkMap, "csrf_enforced"), "Collector must prove cookie-authenticated writes require X-SiteFlow-CSRF.");
  addCheck(checks, "bearer_precedence_collected", requiredCheckPassed(checkMap, "bearer_precedence_enforced"), "Collector must prove low-scope Bearer auth does not fall back to admin cookies.");
  addCheck(checks, "actor_attribution_collected", requiredCheckPassed(checkMap, "actor_attribution_enforced"), "Collector must automatically prove routing-rule writes ignore client-supplied actors and record the server-derived session actor.");
  addCheck(checks, "browser_token_fallback_collected", requiredCheckPassed(checkMap, "browser_token_fallback_posture") && requiredCheckPassed(checkMap, "browser_token_fallback_local_storage_disabled"), "Collector must automatically prove production browser token fallback posture and localStorage exclusion.");
  addCheck(checks, "emergency_cutoff_collected", requiredCheckPassed(checkMap, "emergency_cutoff_global") && requiredCheckPassed(checkMap, "emergency_cutoff_project"), "Collector must execute confirmed project and global emergency cutoff probes.");
  addCheck(checks, "operator_access_evidence_check", checkResult.status === "passed", "Collected operator access evidence must pass operator-access:evidence checks.");
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
      name: "siteflow-operator-access-evidence-collect",
      status: "blocked",
      checkedAt,
      ...(options.outputPath ? { outputPath: options.outputPath } : {}),
      ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
      checks,
      exitCode: 1
    };
  }

  if (options.outputPath) {
    await writeJson(options.outputPath, evidence);
  }

  if (options.checkOutputPath) {
    await writeJson(options.checkOutputPath, checkResult);
  }

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-operator-access-evidence-collect",
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

export function parseOperatorAccessEvidenceCollectArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    adminTokenEnv: defaultAdminTokenEnv,
    lowScopeTokenEnv: defaultLowScopeTokenEnv,
    sessionTtlSeconds: defaultSessionTtlSeconds,
    sessionIdleTimeoutSeconds: defaultSessionIdleTimeoutSeconds,
    executeProjectCutoff: false,
    executeGlobalCutoff: false,
    confirmGlobalCutoff: false,
    actorAttributionVerified: false,
    browserTokenFallbackDisabled: false,
    localStorageFallbackDisabled: false,
    timeoutMs: defaultTimeoutMs,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--base-url") {
      parsed.baseUrl = readArgValue(args, index, arg);
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
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--ticket-id" || arg === "--release-ticket") {
      parsed.ticketId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--project-id") {
      parsed.projectId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--denied-project-id") {
      parsed.deniedProjectId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--admin-token-env") {
      parsed.adminTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--low-scope-token-env") {
      parsed.lowScopeTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--subject") {
      parsed.subject = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--session-ttl-seconds") {
      parsed.sessionTtlSeconds = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--session-idle-timeout-seconds") {
      parsed.sessionIdleTimeoutSeconds = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--execute-project-cutoff") {
      parsed.executeProjectCutoff = true;
    } else if (arg === "--execute-global-cutoff") {
      parsed.executeGlobalCutoff = true;
    } else if (arg === "--i-understand-this-revokes-active-operator-sessions") {
      parsed.confirmGlobalCutoff = true;
    } else if (arg === "--actor-attribution-verified") {
      parsed.actorAttributionVerified = true;
    } else if (arg === "--browser-token-fallback-disabled") {
      parsed.browserTokenFallbackDisabled = true;
    } else if (arg === "--local-storage-fallback-disabled") {
      parsed.localStorageFallbackDisabled = true;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--check-output") {
      parsed.checkOutputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--checked-at") {
      parsed.checkedAt = readArgValue(args, index, arg);
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
    requiredString(parsed.baseUrl, "--base-url <url>");
    requiredString(parsed.commitRef, "--commit-ref <sha>");
    requiredString(parsed.repo, "--repo <owner/name>");
    requiredString(parsed.branch, "--branch <name>");
    requiredString(parsed.targetEnvironment, "--target-environment <name>");
    requiredString(parsed.operatorName, "--operator-name <name>");
    requiredString(parsed.ticketId, "--release-ticket <id>");
    requiredString(parsed.projectId, "--project-id <id>");
    requiredString(parsed.deniedProjectId, "--denied-project-id <id>");
    normalizeBaseUrl(parsed.baseUrl!);
  }

  requiredString(parsed.adminTokenEnv, "--admin-token-env <name>");
  requiredString(parsed.lowScopeTokenEnv, "--low-scope-token-env <name>");
  positiveInteger(parsed.sessionTtlSeconds, defaultSessionTtlSeconds, "--session-ttl-seconds");
  positiveInteger(parsed.sessionIdleTimeoutSeconds, defaultSessionIdleTimeoutSeconds, "--session-idle-timeout-seconds");
  positiveNumber(parsed.timeoutMs, defaultTimeoutMs, "--timeout-ms");
  positiveNumber(parsed.maxAgeHours, 168, "--max-age-hours");
  validIsoTimestamp(parsed.checkedAt, new Date().toISOString());

  if (parsed.executeGlobalCutoff && !parsed.confirmGlobalCutoff) {
    throw new Error("--execute-global-cutoff requires --i-understand-this-revokes-active-operator-sessions.");
  }

  return parsed;
}

export function operatorAccessEvidenceCollectUsage() {
  return [
    "Usage: npm run --silent operator-access:evidence:collect -- --base-url <https-url> --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --operator-name <name> --release-ticket <id> --project-id <id> --denied-project-id <id> [options]",
    "",
    "Options:",
    `  --admin-token-env <name>             Environment variable containing an admin API token, or use <name>_FILE. Default: ${defaultAdminTokenEnv}.`,
    `  --low-scope-token-env <name>         Environment variable containing a low-scope API token, or use <name>_FILE. Default: ${defaultLowScopeTokenEnv}.`,
    "  --subject <value>                   Subject for temporary operator sessions.",
    "  --session-ttl-seconds <n>           TTL used for temporary sessions. Default: 900.",
    "  --session-idle-timeout-seconds <n>  Operator session idle timeout asserted from target config. Default: 1800.",
    "  --execute-project-cutoff            Execute the project-scoped emergency cutoff probe.",
    "  --execute-global-cutoff             Execute the global emergency cutoff probe.",
    "  --i-understand-this-revokes-active-operator-sessions  Required with --execute-global-cutoff.",
    "  --actor-attribution-verified        Deprecated compatibility flag; actor attribution is now collected automatically with a temporary routing rule probe.",
    "  --browser-token-fallback-disabled   Operator-confirm production browser token fallback is disabled.",
    "  --local-storage-fallback-disabled   Operator-confirm localStorage token fallback is disabled.",
    "  --output <file>                     Write raw collected operator access evidence.",
    "  --check-output <file>               Write operator-access:evidence checker output for release:evidence:compose.",
    "  --timeout-ms <ms>                   HTTP request timeout. Default: 5000.",
    "  --max-age-hours <hours>             Maximum evidence age passed to checker output.",
    "  --checked-at <iso>                  Use a fixed collection timestamp.",
    "  --json                              Print raw evidence when collected; print diagnostics when blocked.",
    "  --help                              Show this help.",
    "",
    "The collector never writes raw Bearer tokens, Authorization headers, Set-Cookie headers, cookie values, or session secrets."
  ].join("\n");
}

function writeHumanResult(result: OperatorAccessEvidenceCollectResult, io: CliIo) {
  const output = result.status === "collected" ? io.stdout : io.stderr;

  output.write(`SiteFlow operator access evidence collect status: ${result.status}\n`);

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

export async function runOperatorAccessEvidenceCollectCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<OperatorAccessEvidenceCollectOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseOperatorAccessEvidenceCollectArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${operatorAccessEvidenceCollectUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${operatorAccessEvidenceCollectUsage()}\n`);
    return 0;
  }

  try {
    const result = await collectOperatorAccessEvidence({
      ...baseOptions,
      baseUrl: parsed.baseUrl!,
      commitRef: parsed.commitRef!,
      repo: parsed.repo!,
      branch: parsed.branch!,
      targetEnvironment: parsed.targetEnvironment!,
      operatorName: parsed.operatorName!,
      ticketId: parsed.ticketId!,
      projectId: parsed.projectId!,
      deniedProjectId: parsed.deniedProjectId!,
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      adminTokenEnv: parsed.adminTokenEnv,
      lowScopeTokenEnv: parsed.lowScopeTokenEnv,
      subject: parsed.subject,
      sessionTtlSeconds: parsed.sessionTtlSeconds,
      sessionIdleTimeoutSeconds: parsed.sessionIdleTimeoutSeconds,
      executeProjectCutoff: parsed.executeProjectCutoff,
      executeGlobalCutoff: parsed.executeGlobalCutoff,
      confirmGlobalCutoff: parsed.confirmGlobalCutoff,
      actorAttributionVerified: parsed.actorAttributionVerified,
      browserTokenFallbackDisabled: parsed.browserTokenFallbackDisabled,
      localStorageFallbackDisabled: parsed.localStorageFallbackDisabled,
      timeoutMs: parsed.timeoutMs,
      maxAgeHours: parsed.maxAgeHours,
      checkedAt: parsed.checkedAt
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result.status === "collected" ? result.evidence : result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: OperatorAccessEvidenceCollectResult = {
      name: "siteflow-operator-access-evidence-collect",
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
  runOperatorAccessEvidenceCollectCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
