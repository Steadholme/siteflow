import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertProductionSecretStrength } from "../src/lib/sealedSecrets.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import {
  evaluateNonSessionCredentialEvidence,
  type NonSessionCredentialEvidenceCheckResult
} from "./nonSessionCredentialEvidenceCheck.js";

type CollectStatus = "collected" | "blocked";
type CheckStatus = "pass" | "fail";

interface FetchResponseLike {
  status: number;
}

interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type NonSessionCredentialEvidenceFetch = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface NonSessionCredentialEvidenceCollectOptions {
  baseUrl: string;
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  operatorName: string;
  ticketId: string;
  outputPath?: string;
  checkOutputPath?: string;
  oldMetricsTokenEnv?: string;
  newMetricsTokenEnv?: string;
  oldApiTokenEnv?: string;
  newApiTokenEnv?: string;
  oldRedactedIdentifier?: string;
  oldPrefix?: string;
  newRedactedIdentifier?: string;
  newPrefix?: string;
  oldApiRedactedIdentifier?: string;
  oldApiPrefix?: string;
  newApiRedactedIdentifier?: string;
  newApiPrefix?: string;
  credentialOwner?: string;
  breakGlassTicket?: string;
  breakGlassSource?: string;
  breakGlassApproverCount?: number;
  breakGlassLeastPrivilegeReviewed?: boolean;
  breakGlassTimeBoundedAccess?: boolean;
  breakGlassPostIncidentRevocationPlanned?: boolean;
  timeoutMs?: number;
  maxAgeHours?: number;
  checkedAt?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: NonSessionCredentialEvidenceFetch;
}

export interface NonSessionCredentialEvidenceCollectCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface NonSessionCredentialEvidenceCollectResult {
  name: "siteflow-non-session-credential-evidence-collect";
  status: CollectStatus;
  checkedAt: string;
  outputPath?: string;
  checkOutputPath?: string;
  evidence?: Record<string, unknown>;
  checkResult?: NonSessionCredentialEvidenceCheckResult;
  checks: NonSessionCredentialEvidenceCollectCheck[];
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
  outputPath?: string;
  checkOutputPath?: string;
  oldMetricsTokenEnv: string;
  newMetricsTokenEnv: string;
  oldApiTokenEnv?: string;
  newApiTokenEnv?: string;
  oldRedactedIdentifier?: string;
  oldPrefix?: string;
  newRedactedIdentifier?: string;
  newPrefix?: string;
  oldApiRedactedIdentifier?: string;
  oldApiPrefix?: string;
  newApiRedactedIdentifier?: string;
  newApiPrefix?: string;
  credentialOwner?: string;
  breakGlassTicket?: string;
  breakGlassSource?: string;
  breakGlassApproverCount?: number;
  breakGlassLeastPrivilegeReviewed: boolean;
  breakGlassTimeBoundedAccess: boolean;
  breakGlassPostIncidentRevocationPlanned: boolean;
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

interface BearerProbeResult {
  status: "accepted" | "rejected" | "blocked";
  checkedAt: string;
  endpoint: "/metrics" | "/api/auth/verify";
  tokenEnv: string;
  observedStatusCode: number | null;
  expectedStatusCodes: number[];
  responseBodyArchived: false;
  authorizationHeaderArchived: false;
  error?: string;
}

const defaultOldMetricsTokenEnv = "SITEFLOW_OLD_METRICS_TOKEN";
const defaultNewMetricsTokenEnv = "SITEFLOW_METRICS_TOKEN";
const defaultOldApiTokenEnv = "SITEFLOW_OLD_API_TOKEN";
const defaultNewApiTokenEnv = "SITEFLOW_API_TOKEN";
const defaultTimeoutMs = 5000;

function isEntrypoint() {
  const entryPath = process.argv[1];

  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function nonNegativeInteger(value: number | undefined, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value;
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

  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("--base-url must use https outside localhost tests.");
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
  let fileContent: string;

  try {
    fileContent = await readFile(filePath, "utf8");
  } catch {
    return {
      sourceEnv: envName,
      fileEnv,
      error: `${fileEnv} points to an unreadable secret file for ${envName}.`
    };
  }

  const normalized = trimTrailingNewlines(fileContent);

  if (normalized.length === 0) {
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
}

function secretEnvConfigured(envName: string, env: NodeJS.ProcessEnv | undefined) {
  const values = env ?? process.env;

  return Boolean(stringValue(values[envName]) || stringValue(values[`${envName}_FILE`]));
}

function globalFetch(): NonSessionCredentialEvidenceFetch {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime.");
  }

  return fetch as unknown as NonSessionCredentialEvidenceFetch;
}

async function fetchWithTimeout(
  fetchImpl: NonSessionCredentialEvidenceFetch,
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

async function probeBearerToken(options: {
  baseUrl: string;
  endpoint: "/metrics" | "/api/auth/verify";
  fetchImpl: NonSessionCredentialEvidenceFetch;
  timeoutMs: number;
  token: SecretReadResult;
  checkedAt: string;
  expect: "rejected" | "accepted";
  failureMessage: string;
}): Promise<BearerProbeResult> {
  const expectedStatusCodes = options.expect === "rejected" ? [401, 403] : [200];

  if (!options.token.value) {
    return {
      status: "blocked",
      checkedAt: options.checkedAt,
      endpoint: options.endpoint,
      tokenEnv: options.token.sourceEnv,
      observedStatusCode: null,
      expectedStatusCodes,
      responseBodyArchived: false,
      authorizationHeaderArchived: false,
      error: options.token.error
    };
  }

  try {
    const response = await fetchWithTimeout(
      options.fetchImpl,
      targetUrl(options.baseUrl, options.endpoint),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.token.value}`
        }
      },
      options.timeoutMs
    );
    const matched = expectedStatusCodes.includes(response.status);

    return {
      status: matched ? options.expect : "blocked",
      checkedAt: options.checkedAt,
      endpoint: options.endpoint,
      tokenEnv: options.token.sourceEnv,
      observedStatusCode: response.status,
      expectedStatusCodes,
      responseBodyArchived: false,
      authorizationHeaderArchived: false
    };
  } catch {
    return {
      status: "blocked",
      checkedAt: options.checkedAt,
      endpoint: options.endpoint,
      tokenEnv: options.token.sourceEnv,
      observedStatusCode: null,
      expectedStatusCodes,
      responseBodyArchived: false,
      authorizationHeaderArchived: false,
      error: options.failureMessage
    };
  }
}

async function probeMetricsToken(options: Omit<Parameters<typeof probeBearerToken>[0], "endpoint" | "failureMessage">) {
  return probeBearerToken({
    ...options,
    endpoint: "/metrics",
    failureMessage: "Metrics probe request failed."
  });
}

async function probeApiToken(options: Omit<Parameters<typeof probeBearerToken>[0], "endpoint" | "failureMessage">) {
  return probeBearerToken({
    ...options,
    endpoint: "/api/auth/verify",
    failureMessage: "API token verify probe request failed."
  });
}

function tokenStrengthPassed(token: SecretReadResult, envName: string) {
  if (!token.value) {
    return false;
  }

  try {
    assertProductionSecretStrength(token.value, envName);
    return true;
  } catch {
    return false;
  }
}

function noRawArchiveFlags() {
  return {
    rawSecretArchived: false,
    rawCredentialArchived: false,
    authorizationHeaderArchived: false,
    databaseUrlPasswordArchived: false
  };
}

function addCheck(checks: NonSessionCredentialEvidenceCollectCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function passingChecks(result: NonSessionCredentialEvidenceCheckResult) {
  return new Map(result.checks.map((check) => [check.name, check.status === "pass"]));
}

function finalizeEvidence(evidenceBase: Record<string, unknown>, options: NonSessionCredentialEvidenceCollectOptions) {
  const provisionalEvidence = {
    ...evidenceBase,
    status: "passed"
  };
  const provisionalCheck = evaluateNonSessionCredentialEvidence(provisionalEvidence, {
    evidencePath: options.outputPath ?? "<collected-non-session-credential-evidence>",
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
  const checkResult = evaluateNonSessionCredentialEvidence(finalEvidence, {
    evidencePath: options.outputPath ?? "<collected-non-session-credential-evidence>",
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

function breakGlassStatus(options: NonSessionCredentialEvidenceCollectOptions) {
  return options.breakGlassSource &&
    options.breakGlassLeastPrivilegeReviewed === true &&
    options.breakGlassTimeBoundedAccess === true &&
    options.breakGlassPostIncidentRevocationPlanned === true &&
    ((options.breakGlassApproverCount ?? 0) >= 2)
    ? "passed"
    : "blocked";
}

export async function collectNonSessionCredentialEvidence(
  options: NonSessionCredentialEvidenceCollectOptions
): Promise<NonSessionCredentialEvidenceCollectResult> {
  const checkedAt = validIsoTimestamp(options.checkedAt, (options.now?.() ?? new Date()).toISOString());
  const baseUrl = normalizeBaseUrl(requiredString(options.baseUrl, "--base-url"));
  const commitRef = requiredString(options.commitRef, "--commit-ref");
  const repo = requiredString(options.repo, "--repo");
  const branch = requiredString(options.branch, "--branch");
  const targetEnvironment = requiredString(options.targetEnvironment, "--target-environment");
  const operatorName = requiredString(options.operatorName, "--operator-name");
  const ticketId = requiredString(options.ticketId, "--release-ticket");
  const oldMetricsTokenEnv = options.oldMetricsTokenEnv ?? defaultOldMetricsTokenEnv;
  const newMetricsTokenEnv = options.newMetricsTokenEnv ?? defaultNewMetricsTokenEnv;
  const oldApiTokenEnv = options.oldApiTokenEnv ?? defaultOldApiTokenEnv;
  const newApiTokenEnv = options.newApiTokenEnv ?? defaultNewApiTokenEnv;
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const env = options.env ?? process.env;
  const rootApiTokenProbeEnabled = Boolean(
    options.oldApiTokenEnv ||
      options.newApiTokenEnv ||
      secretEnvConfigured(oldApiTokenEnv, env)
  );
  const [oldToken, newToken, oldApiToken, newApiToken] = await Promise.all([
    secretValueFromEnvOrFile(oldMetricsTokenEnv, env),
    secretValueFromEnvOrFile(newMetricsTokenEnv, env),
    rootApiTokenProbeEnabled ? secretValueFromEnvOrFile(oldApiTokenEnv, env) : Promise.resolve(undefined),
    rootApiTokenProbeEnabled ? secretValueFromEnvOrFile(newApiTokenEnv, env) : Promise.resolve(undefined)
  ]);
  const [oldProbe, newProbe, oldApiProbe, newApiProbe] = await Promise.all([
    probeMetricsToken({
      baseUrl,
      fetchImpl,
      timeoutMs,
      token: oldToken,
      checkedAt,
      expect: "rejected"
    }),
    probeMetricsToken({
      baseUrl,
      fetchImpl,
      timeoutMs,
      token: newToken,
      checkedAt,
      expect: "accepted"
    }),
    rootApiTokenProbeEnabled
      ? probeApiToken({
        baseUrl,
        fetchImpl,
        timeoutMs,
        token: oldApiToken!,
        checkedAt,
        expect: "rejected"
      })
      : Promise.resolve(undefined),
    rootApiTokenProbeEnabled
      ? probeApiToken({
        baseUrl,
        fetchImpl,
        timeoutMs,
        token: newApiToken!,
        checkedAt,
        expect: "accepted"
      })
      : Promise.resolve(undefined)
  ]);
  const newStrengthPassed = tokenStrengthPassed(newToken, newMetricsTokenEnv);
  const oldCredentialRejected = oldProbe.status === "rejected";
  const newCredentialAccepted = newProbe.status === "accepted";
  const runtimeTokenPassed = oldCredentialRejected && newCredentialAccepted && newStrengthPassed;
  const oldApiCredentialRejected = oldApiProbe?.status === "rejected";
  const newApiCredentialAccepted = newApiProbe?.status === "accepted";
  const newApiStrengthPassed = rootApiTokenProbeEnabled ? tokenStrengthPassed(newApiToken!, newApiTokenEnv) : false;
  const rootApiTokenPassed = rootApiTokenProbeEnabled &&
    oldApiCredentialRejected &&
    newApiCredentialAccepted &&
    newApiStrengthPassed;
  const breakGlass = {
    status: breakGlassStatus(options),
    checkedAt,
    incidentTicket: options.breakGlassTicket ?? ticketId,
    approverCount: options.breakGlassApproverCount ?? 0,
    emergencyCredentialSource: options.breakGlassSource ?? null,
    leastPrivilegeReviewed: options.breakGlassLeastPrivilegeReviewed === true,
    timeBoundedAccess: options.breakGlassTimeBoundedAccess === true,
    postIncidentRevocationPlanned: options.breakGlassPostIncidentRevocationPlanned === true,
    ...noRawArchiveFlags()
  };
  const credentials: Record<string, unknown>[] = [
    {
      type: "metrics_token",
      status: runtimeTokenPassed ? "passed" : "blocked",
      checkedAt,
      owner: options.credentialOwner ?? operatorName,
      ticketId,
      oldCredential: {
        redactedIdentifier: options.oldRedactedIdentifier ?? `env:${oldMetricsTokenEnv}`,
        ...(options.oldPrefix ? { prefix: options.oldPrefix } : {}),
        oldCredentialRejected,
        metricsProbe: oldProbe
      },
      newCredential: {
        redactedIdentifier: options.newRedactedIdentifier ?? `env:${newMetricsTokenEnv}`,
        ...(options.newPrefix ? { prefix: options.newPrefix } : {}),
        newCredentialAccepted,
        metricsProbe: newProbe
      },
      strengthStatus: newStrengthPassed ? "pass" : "blocked",
      secretStoreUpdated: newCredentialAccepted,
      serviceReloaded: newCredentialAccepted,
      scraperReloaded: newCredentialAccepted,
      ...noRawArchiveFlags()
    }
  ];

  if (rootApiTokenProbeEnabled) {
    credentials.push({
      type: "root_api_token",
      status: rootApiTokenPassed ? "passed" : "blocked",
      checkedAt,
      owner: options.credentialOwner ?? operatorName,
      ticketId,
      oldCredential: {
        redactedIdentifier: options.oldApiRedactedIdentifier ?? `env:${oldApiTokenEnv}`,
        ...(options.oldApiPrefix ? { prefix: options.oldApiPrefix } : {}),
        oldCredentialRejected: oldApiCredentialRejected,
        apiVerifyProbe: oldApiProbe
      },
      newCredential: {
        redactedIdentifier: options.newApiRedactedIdentifier ?? `env:${newApiTokenEnv}`,
        ...(options.newApiPrefix ? { prefix: options.newApiPrefix } : {}),
        newCredentialAccepted: newApiCredentialAccepted,
        apiVerifyProbe: newApiProbe
      },
      strengthStatus: newApiStrengthPassed ? "pass" : "blocked",
      secretStoreUpdated: newApiCredentialAccepted,
      serviceReloaded: newApiCredentialAccepted,
      ...noRawArchiveFlags()
    });
  }

  const evidenceBase: Record<string, unknown> = {
    schemaVersion: "siteflow.nonSessionCredentialEvidence.v1",
    name: "siteflow-non-session-credential-evidence",
    dryRun: false,
    template: false,
    checkedAt,
    targetEnvironment,
    release: {
      commitRef,
      repository: repo,
      branch
    },
    target: {
      environment: targetEnvironment,
      release: {
        commitRef,
        repository: repo,
        branch
      }
    },
    operatorName,
    ticketId,
    credentials,
    breakGlass,
    limitations: {
      automaticRotationClaimed: false,
      siteflowRotatedExternalSecrets: false,
      collectorScope: rootApiTokenProbeEnabled ? "metrics_token_and_root_api_token_probe" : "metrics_token_probe",
      notes: [
        rootApiTokenProbeEnabled
          ? "Collector probes metrics token cutover on /metrics and root API token cutover on /api/auth/verify."
          : "Collector probes only the metrics token cutover on /metrics.",
        "External credential rotation remains operator-managed."
      ]
    }
  };
  const { evidence, checkResult } = finalizeEvidence(evidenceBase, options);
  const checkMap = passingChecks(checkResult);
  const secretFindings = scanEvidenceForRawSecrets(evidence);
  const checks: NonSessionCredentialEvidenceCollectCheck[] = [];

  addCheck(checks, "old_metrics_token_rejected", oldCredentialRejected, "Old metrics token must receive HTTP 401 or 403 from /metrics.");
  addCheck(checks, "new_metrics_token_accepted", newCredentialAccepted, "New metrics token must receive HTTP 200 from /metrics.");
  addCheck(checks, "new_metrics_token_strength", newStrengthPassed, "New metrics token must pass the production bearer token strength policy.");
  if (rootApiTokenProbeEnabled) {
    addCheck(checks, "old_root_api_token_rejected", oldApiCredentialRejected, "Old root API token must receive HTTP 401 or 403 from /api/auth/verify.");
    addCheck(checks, "new_root_api_token_accepted", newApiCredentialAccepted, "New root API token must receive HTTP 200 from /api/auth/verify.");
    addCheck(checks, "new_root_api_token_strength", newApiStrengthPassed, "New root API token must pass the production bearer token strength policy.");
  }
  addCheck(
    checks,
    "break_glass_controls_collected",
    checkMap.get("break_glass_controls") === true,
    "Collector must include operator-supplied break-glass controls."
  );
  addCheck(
    checks,
    "non_session_credential_evidence_check",
    checkResult.status === "passed",
    "Collected non-session credential evidence must pass non-session-credential:evidence checks."
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
      name: "siteflow-non-session-credential-evidence-collect",
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
    name: "siteflow-non-session-credential-evidence-collect",
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

export function parseNonSessionCredentialEvidenceCollectArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    oldMetricsTokenEnv: defaultOldMetricsTokenEnv,
    newMetricsTokenEnv: defaultNewMetricsTokenEnv,
    breakGlassLeastPrivilegeReviewed: false,
    breakGlassTimeBoundedAccess: false,
    breakGlassPostIncidentRevocationPlanned: false,
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
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--check-output") {
      parsed.checkOutputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--old-metrics-token-env") {
      parsed.oldMetricsTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--new-metrics-token-env") {
      parsed.newMetricsTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--old-api-token-env") {
      parsed.oldApiTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--new-api-token-env") {
      parsed.newApiTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--old-redacted-identifier") {
      parsed.oldRedactedIdentifier = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--old-prefix") {
      parsed.oldPrefix = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--new-redacted-identifier") {
      parsed.newRedactedIdentifier = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--new-prefix") {
      parsed.newPrefix = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--old-api-redacted-identifier") {
      parsed.oldApiRedactedIdentifier = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--old-api-prefix") {
      parsed.oldApiPrefix = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--new-api-redacted-identifier") {
      parsed.newApiRedactedIdentifier = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--new-api-prefix") {
      parsed.newApiPrefix = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--credential-owner") {
      parsed.credentialOwner = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--break-glass-ticket") {
      parsed.breakGlassTicket = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--break-glass-source") {
      parsed.breakGlassSource = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--break-glass-approver-count") {
      parsed.breakGlassApproverCount = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--break-glass-reviewed") {
      parsed.breakGlassLeastPrivilegeReviewed = true;
    } else if (arg === "--break-glass-time-bounded") {
      parsed.breakGlassTimeBoundedAccess = true;
    } else if (arg === "--break-glass-revocation-planned") {
      parsed.breakGlassPostIncidentRevocationPlanned = true;
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
    normalizeBaseUrl(parsed.baseUrl!);
  }

  requiredString(parsed.oldMetricsTokenEnv, "--old-metrics-token-env <name>");
  requiredString(parsed.newMetricsTokenEnv, "--new-metrics-token-env <name>");
  if (parsed.oldApiTokenEnv !== undefined) {
    requiredString(parsed.oldApiTokenEnv, "--old-api-token-env <name>");
  }
  if (parsed.newApiTokenEnv !== undefined) {
    requiredString(parsed.newApiTokenEnv, "--new-api-token-env <name>");
  }
  positiveNumber(parsed.timeoutMs, defaultTimeoutMs, "--timeout-ms");
  positiveNumber(parsed.maxAgeHours, 168, "--max-age-hours");
  nonNegativeInteger(parsed.breakGlassApproverCount, "--break-glass-approver-count");
  validIsoTimestamp(parsed.checkedAt, new Date().toISOString());

  return parsed;
}

export function nonSessionCredentialEvidenceCollectUsage() {
  return [
    "Usage: npm run --silent non-session-credential:evidence:collect -- --base-url <url> --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    `  --old-metrics-token-env <name>        Environment variable containing the retired metrics bearer token, or use <name>_FILE. Default: ${defaultOldMetricsTokenEnv}.`,
    `  --new-metrics-token-env <name>        Environment variable containing the active metrics bearer token, or use <name>_FILE. Default: ${defaultNewMetricsTokenEnv}.`,
    `  --old-api-token-env <name>            Optional environment variable containing the retired root API token, or use <name>_FILE. Default when enabled: ${defaultOldApiTokenEnv}.`,
    `  --new-api-token-env <name>            Optional environment variable containing the active root API token, or use <name>_FILE. Default when enabled: ${defaultNewApiTokenEnv}.`,
    "  --old-redacted-identifier <id>       Redacted identifier for the old metrics token. Default: env:<old env name>.",
    "  --old-prefix <prefix>                Redacted prefix for the old metrics token.",
    "  --new-redacted-identifier <id>       Redacted identifier for the new metrics token. Default: env:<new env name>.",
    "  --new-prefix <prefix>                Redacted prefix for the new metrics token.",
    "  --old-api-redacted-identifier <id>   Redacted identifier for the old root API token. Default: env:<old API env name>.",
    "  --old-api-prefix <prefix>            Redacted prefix for the old root API token.",
    "  --new-api-redacted-identifier <id>   Redacted identifier for the new root API token. Default: env:<new API env name>.",
    "  --new-api-prefix <prefix>            Redacted prefix for the new root API token.",
    "  --credential-owner <name>            Credential owner. Default: --operator-name.",
    "  --break-glass-ticket <id>            Break-glass incident/change ticket. Default: --release-ticket.",
    "  --break-glass-source <name>          Non-secret emergency credential source, such as vault.",
    "  --break-glass-approver-count <n>     Number of break-glass approvers.",
    "  --break-glass-reviewed              Confirm break-glass least-privilege review.",
    "  --break-glass-time-bounded          Confirm break-glass access is time bounded.",
    "  --break-glass-revocation-planned    Confirm post-incident revocation is planned.",
    "  --output <file>                      Write raw collected non-session credential evidence.",
    "  --check-output <file>                Write non-session-credential:evidence checker output for release:evidence:compose.",
    "  --timeout-ms <ms>                    HTTP request timeout. Default: 5000.",
    "  --max-age-hours <hours>              Maximum evidence age passed to checker output.",
    "  --checked-at <iso>                   Use a fixed collection timestamp.",
    "  --json                               Print raw evidence when collected; print diagnostics when blocked.",
    "  --help                               Show this help.",
    "",
    "The collector probes /metrics with old and new metrics bearer tokens. When enabled, it also probes /api/auth/verify with old and new root API tokens. It never writes raw tokens, Authorization headers, response bodies, or secret file contents."
  ].join("\n");
}

function writeHumanResult(result: NonSessionCredentialEvidenceCollectResult, io: CliIo) {
  const output = result.status === "collected" ? io.stdout : io.stderr;

  output.write(`SiteFlow non-session credential evidence collect status: ${result.status}\n`);

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

export async function runNonSessionCredentialEvidenceCollectCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<NonSessionCredentialEvidenceCollectOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseNonSessionCredentialEvidenceCollectArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${nonSessionCredentialEvidenceCollectUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${nonSessionCredentialEvidenceCollectUsage()}\n`);
    return 0;
  }

  try {
    const result = await collectNonSessionCredentialEvidence({
      ...baseOptions,
      baseUrl: parsed.baseUrl!,
      commitRef: parsed.commitRef!,
      repo: parsed.repo!,
      branch: parsed.branch!,
      targetEnvironment: parsed.targetEnvironment!,
      operatorName: parsed.operatorName!,
      ticketId: parsed.ticketId!,
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      oldMetricsTokenEnv: parsed.oldMetricsTokenEnv,
      newMetricsTokenEnv: parsed.newMetricsTokenEnv,
      oldApiTokenEnv: parsed.oldApiTokenEnv,
      newApiTokenEnv: parsed.newApiTokenEnv,
      oldRedactedIdentifier: parsed.oldRedactedIdentifier,
      oldPrefix: parsed.oldPrefix,
      newRedactedIdentifier: parsed.newRedactedIdentifier,
      newPrefix: parsed.newPrefix,
      oldApiRedactedIdentifier: parsed.oldApiRedactedIdentifier,
      oldApiPrefix: parsed.oldApiPrefix,
      newApiRedactedIdentifier: parsed.newApiRedactedIdentifier,
      newApiPrefix: parsed.newApiPrefix,
      credentialOwner: parsed.credentialOwner,
      breakGlassTicket: parsed.breakGlassTicket,
      breakGlassSource: parsed.breakGlassSource,
      breakGlassApproverCount: parsed.breakGlassApproverCount,
      breakGlassLeastPrivilegeReviewed: parsed.breakGlassLeastPrivilegeReviewed,
      breakGlassTimeBoundedAccess: parsed.breakGlassTimeBoundedAccess,
      breakGlassPostIncidentRevocationPlanned: parsed.breakGlassPostIncidentRevocationPlanned,
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
    const result: NonSessionCredentialEvidenceCollectResult = {
      name: "siteflow-non-session-credential-evidence-collect",
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
  runNonSessionCredentialEvidenceCollectCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
