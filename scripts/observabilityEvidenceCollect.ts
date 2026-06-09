import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import { evaluateObservabilityEvidence, type ObservabilityEvidenceCheckResult } from "./observabilityEvidenceCheck.js";

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

export type ObservabilityEvidenceFetch = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface ObservabilityEvidenceCollectOptions {
  baseUrl: string;
  outputPath?: string;
  checkOutputPath?: string;
  operatorEvidencePath?: string;
  backupAutomationRunPath?: string;
  backupAutomationRunHistoryPath?: string;
  backupSchedulerOwnershipPath?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  metricsTokenEnv?: string;
  targetStackApiUrl?: string;
  targetStackTokenEnv?: string;
  operatorName?: string;
  releaseTicket?: string;
  env?: NodeJS.ProcessEnv;
  privateScrapeException?: boolean;
  timeoutMs?: number;
  check?: boolean;
  maxAgeHours?: number;
  readinessFailureStatusCode?: number;
  trafficRemovedOnFailure?: boolean;
  alertDelivered?: boolean;
  alertChannel?: string;
  alertTarget?: string;
  dashboardUrl?: string;
  dashboardUid?: string;
  dashboardOwner?: string;
  logRetentionDays?: number;
  logRedactionSpotCheckPassed?: boolean;
  now?: () => Date;
  fetchImpl?: ObservabilityEvidenceFetch;
}

export interface ObservabilityEvidenceCollectCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface ObservabilityEvidenceCollectResult {
  name: "siteflow-observability-evidence-collect";
  status: CollectStatus;
  checkedAt: string;
  outputPath?: string;
  checkOutputPath?: string;
  evidence?: Record<string, unknown>;
  checkResult?: ObservabilityEvidenceCheckResult;
  checks: ObservabilityEvidenceCollectCheck[];
  exitCode: number;
}

interface ParsedArgs {
  baseUrl?: string;
  outputPath?: string;
  checkOutputPath?: string;
  operatorEvidencePath?: string;
  backupAutomationRunPath?: string;
  backupAutomationRunHistoryPath?: string;
  backupSchedulerOwnershipPath?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  metricsTokenEnv: string;
  targetStackApiUrl?: string;
  targetStackTokenEnv: string;
  operatorName?: string;
  releaseTicket?: string;
  privateScrapeException: boolean;
  timeoutMs: number;
  check: boolean;
  maxAgeHours?: number;
  readinessFailureStatusCode?: number;
  trafficRemovedOnFailure: boolean;
  alertDelivered: boolean;
  alertChannel?: string;
  alertTarget?: string;
  dashboardUrl?: string;
  dashboardUid?: string;
  dashboardOwner?: string;
  logRetentionDays?: number;
  logRedactionSpotCheckPassed: boolean;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMetricsTokenEnv = "SITEFLOW_METRICS_TOKEN";
const defaultTargetStackTokenEnv = "SITEFLOW_OBSERVABILITY_STACK_TOKEN";
const defaultTimeoutMs = 5000;
const prometheusNamePattern = "[a-zA-Z_:][a-zA-Z0-9_:]*";

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

function targetStackProofNotDryRun(candidate: Record<string, unknown>) {
  const mode = (
    stringValue(candidate.mode) ??
    stringValue(candidate.applyMode) ??
    stringValue(candidate.evidenceMode)
  )?.toLowerCase().replace(/[-\s]+/g, "_");

  return candidate.dryRun !== true &&
    candidate.template !== true &&
    candidate.sourceApplied !== false &&
    mode !== "dry_run" &&
    mode !== "template";
}

function trimTrailingNewlines(value: string) {
  return value.replace(/[\r\n]+$/g, "");
}

async function secretValueFromEnvOrFile(envName: string, env: NodeJS.ProcessEnv | undefined) {
  const values = env ?? process.env;
  const directValue = stringValue(values[envName]);

  if (directValue) {
    return directValue;
  }

  const fileEnvName = `${envName}_FILE`;
  const fileValue = stringValue(values[fileEnvName]);

  if (!fileValue) {
    return undefined;
  }

  const filePath = path.isAbsolute(fileValue) ? fileValue : path.join(process.cwd(), fileValue);
  let fileContent: string;

  try {
    fileContent = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`${fileEnvName} points to an unreadable secret file for ${envName}.`);
  }

  const normalized = trimTrailingNewlines(fileContent);

  if (normalized.length === 0) {
    throw new Error(`${fileEnvName} points to an empty secret file for ${envName}.`);
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

function targetUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

function globalFetch(): ObservabilityEvidenceFetch {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime.");
  }

  return fetch as unknown as ObservabilityEvidenceFetch;
}

async function fetchWithTimeout(
  fetchImpl: ObservabilityEvidenceFetch,
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

export function parsePrometheusMetricNames(text: string) {
  const names = new Set<string>();
  const samplePattern = new RegExp(`^(${prometheusNamePattern})(?:\\{[^}]*\\})?\\s+[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?(?:\\s+\\d+)?\\s*$`);
  const typePattern = new RegExp(`^#\\s+TYPE\\s+(${prometheusNamePattern})\\s+`);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const typeMatch = line.match(typePattern);

    if (typeMatch) {
      names.add(typeMatch[1]);
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    const sampleMatch = line.match(samplePattern);

    if (sampleMatch) {
      names.add(sampleMatch[1]);
    }
  }

  return [...names].sort();
}

export async function collectReadinessProbeEvidence(
  options: Pick<ObservabilityEvidenceCollectOptions, "baseUrl" | "fetchImpl" | "timeoutMs" | "now">
) {
  const now = options.now?.() ?? new Date();
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    targetUrl(options.baseUrl, "/readyz"),
    { method: "GET" },
    positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs")
  );
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const passed = response.status === 200 && isObject(body) && body.status === "ready";

  return {
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    endpoint: "/readyz",
    ...(passed ? { healthyStatusCode: 200 } : { observedStatusCode: response.status })
  };
}

export async function collectMetricsScrapeEvidence(
  options: Pick<
    ObservabilityEvidenceCollectOptions,
    "baseUrl" | "fetchImpl" | "timeoutMs" | "now" | "env" | "metricsTokenEnv" | "privateScrapeException"
  >
) {
  const now = options.now?.() ?? new Date();
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const metricsTokenEnv = options.metricsTokenEnv ?? defaultMetricsTokenEnv;
  const metricsToken = await secretValueFromEnvOrFile(metricsTokenEnv, options.env);
  const headers = metricsToken ? { authorization: `Bearer ${metricsToken}` } : undefined;
  const response = await fetchWithTimeout(
    fetchImpl,
    targetUrl(options.baseUrl, "/metrics"),
    {
      method: "GET",
      ...(headers ? { headers } : {})
    },
    positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs")
  );
  const text = response.status === 200 ? await response.text() : "";
  const metricNames = response.status === 200 ? parsePrometheusMetricNames(text) : [];

  return {
    status: response.status === 200 ? "scraped" : "blocked",
    scrapedAt: now.toISOString(),
    endpoint: "/metrics",
    authenticated: Boolean(metricsToken),
    ...(options.privateScrapeException ? { privateScrapeException: true } : {}),
    metricNames,
    ...(response.status === 200 ? {} : { observedStatusCode: response.status })
  };
}

export async function collectTargetStackProofEvidence(
  options: Pick<
    ObservabilityEvidenceCollectOptions,
    "targetStackApiUrl" | "targetStackTokenEnv" | "fetchImpl" | "timeoutMs" | "now" | "env" | "operatorName" | "releaseTicket"
  >
) {
  if (!options.targetStackApiUrl) {
    return undefined;
  }

  const now = options.now?.() ?? new Date();
  const targetStackTokenEnv = options.targetStackTokenEnv ?? defaultTargetStackTokenEnv;
  const targetStackToken = await secretValueFromEnvOrFile(targetStackTokenEnv, options.env);
  const baseProof = {
    schemaVersion: "siteflow.observabilityTargetStackProof.v1",
    name: "siteflow-observability-target-stack-proof",
    checkedAt: now.toISOString(),
    evidenceSource: "target_stack_api",
    ...(options.operatorName ? { operator: options.operatorName } : {}),
    ...(options.releaseTicket ? { ticket: options.releaseTicket } : {})
  };

  if (!targetStackToken) {
    return {
      ...baseProof,
      status: "blocked",
      message: `${targetStackTokenEnv} is required to collect target-stack API proof.`
    };
  }

  const fetchImpl = options.fetchImpl ?? globalFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    options.targetStackApiUrl,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${targetStackToken}`
      }
    },
    positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs")
  );

  if (response.status < 200 || response.status >= 300) {
    return {
      ...baseProof,
      status: "blocked",
      observedStatusCode: response.status
    };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return {
      ...baseProof,
      status: "blocked",
      message: "Target-stack API proof returned invalid JSON."
    };
  }

  if (!isObject(body)) {
    return {
      ...baseProof,
      status: "blocked",
      message: "Target-stack API proof must be a JSON object."
    };
  }

  const productionProof = targetStackProofNotDryRun(body);

  return {
    ...body,
    ...baseProof,
    status: body.status === "passed" && productionProof ? "passed" : "blocked",
    ...(productionProof ? {} : { message: "Target-stack API proof must come from a real target stack query, not a template or dry-run." }),
    ...(isObject(body.release) ? { release: body.release } : {}),
    ...(isObject(body.prometheusRules) ? { prometheusRules: body.prometheusRules } : {}),
    ...(isObject(body.grafanaDashboard) ? { grafanaDashboard: body.grafanaDashboard } : {}),
    ...(isObject(body.alertmanagerReceiver) ? { alertmanagerReceiver: body.alertmanagerReceiver } : {})
  };
}

function flagEvidence(options: ObservabilityEvidenceCollectOptions, checkedAt: string) {
  const readinessProbe: Record<string, unknown> = {};

  if (options.readinessFailureStatusCode !== undefined) {
    readinessProbe.failureStatusCode = options.readinessFailureStatusCode;
  }

  if (options.trafficRemovedOnFailure) {
    readinessProbe.trafficRemovedOnFailure = true;
  }

  const alertDelivery = options.alertDelivered || options.alertChannel || options.alertTarget
    ? {
        status: options.alertDelivered ? "delivered" : "blocked",
        deliveredAt: checkedAt,
        delivered: Boolean(options.alertDelivered),
        ...(options.alertChannel ? { channel: options.alertChannel } : {}),
        ...(options.alertTarget ? { target: options.alertTarget } : {})
      }
    : undefined;
  const dashboard = options.dashboardUrl || options.dashboardUid || options.dashboardOwner
    ? {
        status: options.dashboardOwner && (options.dashboardUrl || options.dashboardUid) ? "available" : "blocked",
        checkedAt,
        ...(options.dashboardUrl ? { dashboardUrl: options.dashboardUrl } : {}),
        ...(options.dashboardUid ? { dashboardUid: options.dashboardUid } : {}),
        ...(options.dashboardOwner ? { owner: options.dashboardOwner } : {})
      }
    : undefined;
  const logPipeline = options.logRetentionDays !== undefined || options.logRedactionSpotCheckPassed
    ? {
        status: options.logRetentionDays && options.logRetentionDays > 0 && options.logRedactionSpotCheckPassed ? "passed" : "blocked",
        checkedAt,
        ...(options.logRetentionDays !== undefined ? { retentionDays: options.logRetentionDays } : {}),
        redactionSpotCheckPassed: Boolean(options.logRedactionSpotCheckPassed)
      }
    : undefined;

  return {
    ...(Object.keys(readinessProbe).length > 0 ? { readinessProbe } : {}),
    ...(alertDelivery ? { alertDelivery } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(logPipeline ? { logPipeline } : {})
  };
}

function mergeSection(
  operatorEvidence: Record<string, unknown>,
  flagEvidenceObject: Record<string, unknown>,
  collectedEvidence: Record<string, unknown>,
  key: string
) {
  const fromOperator = isObject(operatorEvidence[key]) ? operatorEvidence[key] : {};
  const fromFlags = isObject(flagEvidenceObject[key]) ? flagEvidenceObject[key] : {};
  const fromCollected = isObject(collectedEvidence[key]) ? collectedEvidence[key] : {};
  const merged = {
    ...fromOperator,
    ...fromFlags,
    ...fromCollected
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeObservabilityEvidence(
  collectedEvidence: Record<string, unknown>,
  operatorEvidence: Record<string, unknown> = {},
  flagEvidenceObject: Record<string, unknown> = {}
) {
  const evidence: Record<string, unknown> = {};

  for (const key of ["readinessProbe", "metricsScrape", "backupAutomationRun", "backupAutomationRunHistory", "backupSchedulerOwnership", "observabilityProvisioning", "observabilityApplyProof", "observabilityTargetStackProof", "alertDelivery", "dashboard", "logPipeline"]) {
    const merged = mergeSection(operatorEvidence, flagEvidenceObject, collectedEvidence, key);

    if (merged) {
      evidence[key] = merged;
    }
  }

  return evidence;
}

function releaseEvidence(options: ObservabilityEvidenceCollectOptions) {
  if (!options.commitRef && !options.repo && !options.branch && !options.targetEnvironment) {
    return {};
  }

  return {
    release: {
      ...(options.commitRef ? { commitRef: options.commitRef } : {}),
      ...(options.repo ? { repository: options.repo } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.targetEnvironment ? { targetEnvironment: options.targetEnvironment } : {})
    }
  };
}

async function readOperatorEvidence(filePath: string | undefined) {
  if (!filePath) {
    return {};
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

function summarizeBackupAutomationRun(raw: Record<string, unknown>) {
  const evidenceFiles = isObject(raw.evidenceFiles) ? raw.evidenceFiles : {};
  const composeResult = isObject(raw.composeResult) ? raw.composeResult : undefined;
  const checkResult = isObject(composeResult?.checkResult) ? composeResult.checkResult : undefined;

  return {
    name: raw.name,
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    exitCode: raw.exitCode,
    evidenceDir: raw.evidenceDir,
    evidenceFiles: {
      backupVerify: evidenceFiles.backupVerify,
      restoreDrill: evidenceFiles.restoreDrill,
      backupOffload: evidenceFiles.backupOffload,
      backupPrune: evidenceFiles.backupPrune,
      backupEvidenceCheck: evidenceFiles.backupEvidenceCheck,
      backupAutomationRun: evidenceFiles.backupAutomationRun
    },
    steps: Array.isArray(raw.steps)
      ? raw.steps
          .filter((step) => isObject(step))
          .map((step) => ({
            id: step.id,
            status: step.status,
            outputPath: step.outputPath
          }))
      : [],
    ...(composeResult
      ? {
          composeResult: {
            status: composeResult.status,
            checkedAt: composeResult.checkedAt,
            checkResult: checkResult
              ? {
                  name: checkResult.name,
                  status: checkResult.status,
                  checkedAt: checkResult.checkedAt,
                  exitCode: checkResult.exitCode
                }
              : undefined
          }
        }
      : {})
  };
}

async function readBackupAutomationRunEvidence(filePath: string | undefined) {
  if (!filePath) {
    return {};
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  if (parsed.name !== "siteflow-backup-automation-run") {
    throw new Error(`${filePath} must contain siteflow-backup-automation-run evidence.`);
  }

  const summarized = summarizeBackupAutomationRun(parsed);

  return {
    backupAutomationRun: {
      ...summarized,
      evidenceFiles: {
        ...(summarized.evidenceFiles as Record<string, unknown>),
        backupAutomationRun: (summarized.evidenceFiles as Record<string, unknown>).backupAutomationRun ?? filePath
      }
    }
  };
}

async function readBackupAutomationRunHistoryEvidence(filePath: string | undefined) {
  if (!filePath) {
    return {};
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  if (parsed.name !== "siteflow-backup-automation-run-history") {
    throw new Error(`${filePath} must contain siteflow-backup-automation-run-history evidence.`);
  }

  return {
    backupAutomationRunHistory: {
      ...parsed,
      evidenceFiles: {
        ...(isObject(parsed.evidenceFiles) ? parsed.evidenceFiles : {}),
        backupAutomationRunHistory: isObject(parsed.evidenceFiles) && parsed.evidenceFiles.backupAutomationRunHistory
          ? parsed.evidenceFiles.backupAutomationRunHistory
          : filePath
      }
    }
  };
}

async function readBackupSchedulerOwnershipEvidence(filePath: string | undefined) {
  if (!filePath) {
    return {};
  }

  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  if (parsed.name !== "siteflow-backup-scheduler-ownership") {
    throw new Error(`${filePath} must contain siteflow-backup-scheduler-ownership evidence.`);
  }

  return {
    backupSchedulerOwnership: parsed
  };
}

function addCheck(checks: ObservabilityEvidenceCollectCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function blockedResult(
  options: ObservabilityEvidenceCollectOptions,
  checkedAt: string,
  checks: ObservabilityEvidenceCollectCheck[],
  evidence?: Record<string, unknown>,
  checkResult?: ObservabilityEvidenceCheckResult
): ObservabilityEvidenceCollectResult {
  return {
    name: "siteflow-observability-evidence-collect",
    status: "blocked",
    checkedAt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
    ...(evidence ? { evidence } : {}),
    ...(checkResult ? { checkResult } : {}),
    checks,
    exitCode: 1
  };
}

export async function collectObservabilityEvidence(
  options: ObservabilityEvidenceCollectOptions
): Promise<ObservabilityEvidenceCollectResult> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const checks: ObservabilityEvidenceCollectCheck[] = [];
  const operatorEvidence = await readOperatorEvidence(options.operatorEvidencePath);
  const backupAutomationEvidence = await readBackupAutomationRunEvidence(options.backupAutomationRunPath);
  const backupAutomationHistoryEvidence = await readBackupAutomationRunHistoryEvidence(options.backupAutomationRunHistoryPath);
  const backupSchedulerOwnershipEvidence = await readBackupSchedulerOwnershipEvidence(options.backupSchedulerOwnershipPath);
  const [readinessProbe, metricsScrape, observabilityTargetStackProof] = await Promise.all([
    collectReadinessProbeEvidence(options),
    collectMetricsScrapeEvidence(options),
    collectTargetStackProofEvidence(options)
  ]);
  const collectedEvidence = {
    readinessProbe,
    metricsScrape,
    ...(observabilityTargetStackProof ? { observabilityTargetStackProof } : {}),
    ...backupAutomationEvidence,
    ...backupAutomationHistoryEvidence,
    ...backupSchedulerOwnershipEvidence
  };
  const evidence = {
    ...releaseEvidence(options),
    ...mergeObservabilityEvidence(collectedEvidence, operatorEvidence, flagEvidence(options, checkedAt))
  };
  const secretFindings = scanEvidenceForRawSecrets(evidence);

  addCheck(
    checks,
    "readiness_collected",
    readinessProbe.status === "passed",
    "Collector must receive a ready /readyz response from the target."
  );
  addCheck(
    checks,
    "metrics_collected",
    metricsScrape.status === "scraped",
    "Collector must receive a successful /metrics scrape from the target."
  );
  addCheck(
    checks,
    "target_stack_proof_configured",
    options.targetEnvironment !== "production" || Boolean(options.targetStackApiUrl),
    "Production observability evidence must collect target-stack API proof with --target-stack-api-url."
  );
  addCheck(
    checks,
    "target_stack_proof_collected",
    options.targetEnvironment !== "production" && !observabilityTargetStackProof || observabilityTargetStackProof?.status === "passed",
    "Collector must receive a passing target-stack API proof for production or when --target-stack-api-url is provided."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_loaded",
    !options.backupSchedulerOwnershipPath || Boolean((evidence as Record<string, unknown>).backupSchedulerOwnership),
    "Collector must load backup scheduler ownership evidence when --backup-scheduler-ownership is provided."
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
    return blockedResult(options, checkedAt, checks);
  }

  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  const shouldCheck = Boolean(options.check || options.checkOutputPath);
  let checkResult: ObservabilityEvidenceCheckResult | undefined;

  if (shouldCheck) {
    checkResult = evaluateObservabilityEvidence(evidence, {
      evidencePath: options.outputPath ?? "<collected-observability-evidence>",
      maxAgeHours: options.maxAgeHours,
      commitRef: options.commitRef,
      repo: options.repo,
      branch: options.branch,
      targetEnvironment: options.targetEnvironment,
      now: options.now
    });

    if (options.checkOutputPath) {
      await writeFile(options.checkOutputPath, `${JSON.stringify(checkResult, null, 2)}\n`, "utf8");
    }

    addCheck(
      checks,
      "observability_evidence_check",
      checkResult.status === "passed",
      "Collected observability evidence must pass observability:evidence checks."
    );
  }

  if (checks.some((check) => check.status === "fail")) {
    return blockedResult(options, checkedAt, checks, evidence, checkResult);
  }

  return {
    name: "siteflow-observability-evidence-collect",
    status: "collected",
    checkedAt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
    evidence,
    ...(checkResult ? { checkResult } : {}),
    checks,
    exitCode: 0
  };
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseObservabilityEvidenceCollectArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    metricsTokenEnv: defaultMetricsTokenEnv,
    targetStackTokenEnv: defaultTargetStackTokenEnv,
    privateScrapeException: false,
    timeoutMs: defaultTimeoutMs,
    check: false,
    trafficRemovedOnFailure: false,
    alertDelivered: false,
    logRedactionSpotCheckPassed: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--base-url") {
      parsed.baseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--metrics-token-env") {
      parsed.metricsTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-stack-api-url") {
      parsed.targetStackApiUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-stack-token-env") {
      parsed.targetStackTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-evidence") {
      parsed.operatorEvidencePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-automation-run") {
      parsed.backupAutomationRunPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-automation-history") {
      parsed.backupAutomationRunHistoryPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-scheduler-ownership") {
      parsed.backupSchedulerOwnershipPath = readArgValue(args, index, arg);
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
    } else if (arg === "--release-ticket" || arg === "--ticket-id") {
      parsed.releaseTicket = readArgValue(args, index, arg);
      index += 1;
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
    } else if (arg === "--readiness-failure-status-code") {
      parsed.readinessFailureStatusCode = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--traffic-removed-on-failure") {
      parsed.trafficRemovedOnFailure = true;
    } else if (arg === "--private-scrape-exception") {
      parsed.privateScrapeException = true;
    } else if (arg === "--alert-delivered") {
      parsed.alertDelivered = true;
    } else if (arg === "--alert-channel") {
      parsed.alertChannel = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--alert-target") {
      parsed.alertTarget = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--dashboard-url") {
      parsed.dashboardUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--dashboard-uid") {
      parsed.dashboardUid = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--dashboard-owner") {
      parsed.dashboardOwner = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--log-retention-days") {
      parsed.logRetentionDays = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--log-redaction-spot-check-passed") {
      parsed.logRedactionSpotCheckPassed = true;
    } else if (arg === "--check") {
      parsed.check = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.baseUrl) {
    throw new Error("--base-url <url> is required.");
  }

  positiveNumber(parsed.timeoutMs, defaultTimeoutMs, "--timeout-ms");
  positiveNumber(parsed.maxAgeHours, 24, "--max-age-hours");
  nonNegativeInteger(parsed.readinessFailureStatusCode, "--readiness-failure-status-code");
  nonNegativeInteger(parsed.logRetentionDays, "--log-retention-days");

  return parsed;
}

export function observabilityEvidenceCollectUsage() {
  return [
    "Usage: npm run --silent observability:evidence:collect -- --base-url <url> [options]",
    "",
    "Options:",
    "  --metrics-token-env <name>             Environment variable containing the metrics bearer token, or use <name>_FILE. Default: SITEFLOW_METRICS_TOKEN.",
    "  --target-stack-api-url <url>           Optional target observability stack proof API URL.",
    "  --target-stack-token-env <name>        Environment variable containing the target-stack API bearer token, or use <name>_FILE. Default: SITEFLOW_OBSERVABILITY_STACK_TOKEN.",
    "  --operator-evidence <file>             Optional JSON evidence for alert, dashboard, log, and readiness traffic-removal fields.",
    "  --backup-automation-run <file>         Optional backup:automation run record to include in observability evidence.",
    "  --backup-automation-history <file>     Optional backup automation run history for recurring restore-drill cadence evidence.",
    "  --backup-scheduler-ownership <file>    Optional backup scheduler ownership evidence for recurring schedule proof.",
    "  --commit-ref <sha>                     Release commit identity to write into collected evidence.",
    "  --repo <owner/repo>                    Release repository identity to write into collected evidence.",
    "  --branch <branch>                      Release branch identity to write into collected evidence.",
    "  --target-environment <name>            Release target environment to write into collected evidence.",
    "  --operator-name <name>                 Operator name written into target-stack proof evidence.",
    "  --release-ticket <id>                  Release or change ticket written into target-stack proof evidence.",
    "  --ticket-id <id>                       Alias for --release-ticket.",
    "  --output <file>                        Write raw collected observability evidence.",
    "  --check                                Run observability:evidence checks against the collected evidence.",
    "  --check-output <file>                  Write observability:evidence checker output for release:evidence:compose.",
    "  --timeout-ms <ms>                      HTTP request timeout. Default: 5000.",
    "  --max-age-hours <hours>                Maximum evidence age passed to --check.",
    "  --private-scrape-exception             Record a documented private-scrape exception when no metrics token is used.",
    "  --readiness-failure-status-code <code> Operator-supplied evidence for the /readyz failure status code.",
    "  --traffic-removed-on-failure           Operator-supplied evidence that readiness failure removes traffic.",
    "  --alert-delivered                      Operator-supplied evidence that an alert was delivered.",
    "  --alert-channel <name>                 Alert delivery channel.",
    "  --alert-target <target>                Alert delivery target.",
    "  --dashboard-url <url>                  Operations dashboard URL.",
    "  --dashboard-uid <uid>                  Operations dashboard UID.",
    "  --dashboard-owner <owner>              Dashboard owner or team.",
    "  --log-retention-days <days>            Log retention days.",
    "  --log-redaction-spot-check-passed      Operator-supplied log redaction spot-check evidence.",
    "  --json                                 Print raw evidence when collected; print diagnostics when blocked.",
    "  --help                                 Show this help.",
    "",
    "The collector does not configure Prometheus, Alertmanager, dashboards, log shipping, retention, or load-balancer behavior."
  ].join("\n");
}

function writeHumanResult(result: ObservabilityEvidenceCollectResult, io: CliIo) {
  const output = result.status === "collected" ? io.stdout : io.stderr;

  output.write(`SiteFlow observability evidence collect status: ${result.status}\n`);

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

export async function runObservabilityEvidenceCollectCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ObservabilityEvidenceCollectOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseObservabilityEvidenceCollectArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${observabilityEvidenceCollectUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${observabilityEvidenceCollectUsage()}\n`);
    return 0;
  }

  try {
    const result = await collectObservabilityEvidence({
      ...baseOptions,
      baseUrl: parsed.baseUrl!,
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      operatorEvidencePath: parsed.operatorEvidencePath,
      backupAutomationRunPath: parsed.backupAutomationRunPath,
      backupAutomationRunHistoryPath: parsed.backupAutomationRunHistoryPath,
      backupSchedulerOwnershipPath: parsed.backupSchedulerOwnershipPath,
      commitRef: parsed.commitRef,
      repo: parsed.repo,
      branch: parsed.branch,
      targetEnvironment: parsed.targetEnvironment,
      metricsTokenEnv: parsed.metricsTokenEnv,
      targetStackApiUrl: parsed.targetStackApiUrl,
      targetStackTokenEnv: parsed.targetStackTokenEnv,
      operatorName: parsed.operatorName,
      releaseTicket: parsed.releaseTicket,
      privateScrapeException: parsed.privateScrapeException,
      timeoutMs: parsed.timeoutMs,
      check: parsed.check,
      maxAgeHours: parsed.maxAgeHours,
      readinessFailureStatusCode: parsed.readinessFailureStatusCode,
      trafficRemovedOnFailure: parsed.trafficRemovedOnFailure,
      alertDelivered: parsed.alertDelivered,
      alertChannel: parsed.alertChannel,
      alertTarget: parsed.alertTarget,
      dashboardUrl: parsed.dashboardUrl,
      dashboardUid: parsed.dashboardUid,
      dashboardOwner: parsed.dashboardOwner,
      logRetentionDays: parsed.logRetentionDays,
      logRedactionSpotCheckPassed: parsed.logRedactionSpotCheckPassed
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result.status === "collected" ? result.evidence : result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: ObservabilityEvidenceCollectResult = {
      name: "siteflow-observability-evidence-collect",
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
  runObservabilityEvidenceCollectCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
