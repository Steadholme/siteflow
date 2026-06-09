import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import {
  evaluateReleaseTargetRuntimeEvidence,
  type ReleaseTargetRuntimeEvidenceCheckResult
} from "./releaseTargetRuntimeEvidenceCheck.js";

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

interface ExecFileOptionsLike {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export type ReleaseTargetRuntimeEvidenceFetch = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;
export type ReleaseTargetRuntimeEvidenceExecFile = (
  file: string,
  args: string[],
  options?: ExecFileOptionsLike
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface ReleaseTargetRuntimeEvidenceCollectOptions {
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  publicBaseUrl: string;
  operatorName: string;
  ticketId: string;
  outputPath?: string;
  checkOutputPath?: string;
  composeFile?: string;
  envFile?: string;
  composeProject?: string;
  expectedDigest?: string;
  loopbackBaseUrl?: string;
  systemdUnit?: string;
  restartServices?: string[];
  logSince?: string;
  logTail?: number;
  timeoutMs?: number;
  maxAgeHours?: number;
  checkedAt?: string;
  now?: () => Date;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ReleaseTargetRuntimeEvidenceFetch;
  execFileImpl?: ReleaseTargetRuntimeEvidenceExecFile;
}

export interface ReleaseTargetRuntimeEvidenceCollectCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface ReleaseTargetRuntimeEvidenceCollectResult {
  name: "siteflow-target-runtime-evidence-collect";
  status: CollectStatus;
  checkedAt: string;
  outputPath?: string;
  checkOutputPath?: string;
  evidence?: Record<string, unknown>;
  checkResult?: ReleaseTargetRuntimeEvidenceCheckResult;
  checks: ReleaseTargetRuntimeEvidenceCollectCheck[];
  exitCode: number;
}

interface ParsedArgs {
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  publicBaseUrl?: string;
  operatorName?: string;
  ticketId?: string;
  outputPath?: string;
  checkOutputPath?: string;
  composeFile?: string;
  envFile?: string;
  composeProject?: string;
  expectedDigest?: string;
  loopbackBaseUrl?: string;
  systemdUnit?: string;
  restartServices?: string[];
  logSince?: string;
  logTail?: number;
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

interface CommandResult {
  command: string;
  stdout: string;
  exitCode: number;
}

const execFilePromise = promisify(execFileCallback) as ReleaseTargetRuntimeEvidenceExecFile;
const defaultComposeFile = "docker-compose.production.yml";
const defaultComposeProject = "siteflow-prod";
const defaultLoopbackBaseUrl = "http://127.0.0.1:8787";
const defaultTimeoutMs = 30_000;
const defaultLogSince = "10m";
const defaultLogTail = 200;
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;
const sha256HexPattern = /^[a-f0-9]{64}$/i;
const dockerMemoryPattern = /^[1-9]\d*(?:[bkmg])?$/i;

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

function normalizedBaseUrl(raw: string, label: string, requireHttps: boolean) {
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

function normalizedDigest(value: string | undefined) {
  const raw = stringValue(value);

  if (!raw) {
    return undefined;
  }

  if (sha256HexPattern.test(raw)) {
    return `sha256:${raw}`;
  }

  if (!sha256DigestPattern.test(raw)) {
    throw new Error("--expected-digest must be a sha256 digest.");
  }

  return raw;
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function redactSensitiveString(value: string) {
  return value
    .replace(/\bAuthorization\b[^\n\r]{0,160}\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Authorization: Bearer <redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>")
    .replace(/[a-z][a-z0-9+.-]*:\/\/([^:\s/@]+):([^@\s/]+)@/gi, (match) => match.replace(/:\/\/[^:\s/@]+:[^@\s/]+@/, "://<redacted>:<redacted>@"))
    .replace(/([?&](?:password|token|secret)=)[^&\s#]+/gi, "$1<redacted>")
    .replace(/SITEFLOW_SECRET_CANARY_[A-Z0-9_-]+/gi, "SITEFLOW_SECRET_CANARY_<redacted>");
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function displayCommand(file: string, args: string[]) {
  return redactSensitiveString([file, ...args].map(shellQuote).join(" "));
}

function composeArgs(options: {
  composeFile: string;
  envFile?: string;
  composeProject: string;
}, extra: string[]) {
  return [
    "compose",
    "--project-name",
    options.composeProject,
    ...(options.envFile ? ["--env-file", options.envFile] : []),
    "-f",
    options.composeFile,
    ...extra
  ];
}

function globalFetch(): ReleaseTargetRuntimeEvidenceFetch {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime.");
  }

  return fetch as unknown as ReleaseTargetRuntimeEvidenceFetch;
}

async function fetchWithTimeout(
  fetchImpl: ReleaseTargetRuntimeEvidenceFetch,
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

function targetUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

async function runCommand(
  execFileImpl: ReleaseTargetRuntimeEvidenceExecFile,
  file: string,
  args: string[],
  options: Pick<ReleaseTargetRuntimeEvidenceCollectOptions, "cwd" | "env"> & { timeoutMs: number }
): Promise<CommandResult> {
  try {
    const result = await execFileImpl(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs
    });

    return {
      command: displayCommand(file, args),
      stdout: result.stdout.toString(),
      exitCode: 0
    };
  } catch (error) {
    const candidate = error as { stdout?: string | Buffer; code?: unknown };

    return {
      command: displayCommand(file, args),
      stdout: candidate.stdout?.toString() ?? "",
      exitCode: typeof candidate.code === "number" ? candidate.code : 1
    };
  }
}

function parseJsonOutput(stdout: string) {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const entries: unknown[] = [];

    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();

      if (!candidate) {
        continue;
      }

      try {
        entries.push(JSON.parse(candidate) as unknown);
      } catch {
        return undefined;
      }
    }

    return entries.length > 0 ? entries : undefined;
  }
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function arrayStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringList(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === "number" ? String(entry) : entry)
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function serviceMap(composeConfig: Record<string, unknown> | undefined) {
  const services = isObject(composeConfig?.services) ? composeConfig.services : {};

  return services as Record<string, unknown>;
}

function serviceObject(composeConfig: Record<string, unknown> | undefined, service: string) {
  const entry = serviceMap(composeConfig)[service];

  return isObject(entry) ? entry : undefined;
}

function serviceImage(composeConfig: Record<string, unknown> | undefined, service: string) {
  return stringValue(serviceObject(composeConfig, service)?.image);
}

function rootSecrets(composeConfig: Record<string, unknown> | undefined) {
  const secrets = composeConfig?.secrets;

  if (isObject(secrets)) {
    return Object.keys(secrets);
  }

  return arrayStrings(secrets);
}

function serviceHasHealthcheck(service: Record<string, unknown> | undefined) {
  return Boolean(service?.healthcheck && isObject(service.healthcheck) && service.healthcheck.disable !== true);
}

function serviceEnvironment(service: Record<string, unknown> | undefined) {
  const environment = service?.environment;
  const values = new Map<string, string | null>();

  if (isObject(environment)) {
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        values.set(key, String(value));
      } else {
        values.set(key, null);
      }
    }
  }

  for (const entry of arrayStrings(environment)) {
    const separator = entry.indexOf("=");

    if (separator === -1) {
      values.set(entry, null);
    } else {
      values.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
  }

  return values;
}

function environmentValue(service: Record<string, unknown> | undefined, name: string) {
  return serviceEnvironment(service).get(name);
}

function serviceMountTargets(service: Record<string, unknown> | undefined) {
  return arrayStrings(service?.volumes).map((entry) => {
    const segments = entry.split(":");

    return segments.length >= 2 ? segments[1] : entry;
  }).concat(
    Array.isArray(service?.volumes)
      ? service.volumes.flatMap((entry) => {
          if (!isObject(entry)) {
            return [];
          }

          const target = stringValue(entry.target) ?? stringValue(entry.Target) ?? stringValue(entry.destination);

          return target ? [target] : [];
        })
      : []
  );
}

function serviceDockerSocketMounted(service: Record<string, unknown> | undefined) {
  return serviceMountTargets(service).includes("/var/run/docker.sock");
}

function serviceCommandText(service: Record<string, unknown> | undefined) {
  const command = service?.command;

  if (typeof command === "string") {
    return command;
  }

  return stringList(command).join(" ");
}

function dangerousSecurityOptions(entries: string[]) {
  return entries.filter((entry) => {
    const normalized = entry.trim().toLowerCase();

    return normalized === "seccomp=unconfined" || normalized === "apparmor=unconfined";
  });
}

function serviceNetworkMode(service: Record<string, unknown> | undefined) {
  return stringValue(service?.network_mode ?? service?.networkMode);
}

function numericString(value: unknown) {
  const raw = stringValue(value);

  return raw && /^\d+$/.test(raw) ? raw : null;
}

function positiveNumberString(value: unknown) {
  const raw = stringValue(value);
  const parsed = Number(raw);

  return Boolean(raw && Number.isFinite(parsed) && parsed > 0);
}

function positiveIntegerString(value: unknown) {
  const raw = stringValue(value);
  const parsed = Number(raw);

  return Boolean(raw && Number.isInteger(parsed) && parsed > 0);
}

function dockerMemoryString(value: unknown) {
  const raw = stringValue(value);

  return Boolean(raw && dockerMemoryPattern.test(raw));
}

function dockerSocketGidFromStat(command: CommandResult) {
  const firstLine = firstOutputLine(command.stdout);

  return numericString(firstLine);
}

function serviceProfiles(composeConfig: Record<string, unknown> | undefined, hostDockerSocketGid: string | null) {
  const api = serviceObject(composeConfig, "api");
  const worker = serviceObject(composeConfig, "worker");
  const apiCapDrop = stringList(api?.cap_drop ?? api?.capDrop).map((entry) => entry.toUpperCase());
  const workerCapDrop = stringList(worker?.cap_drop ?? worker?.capDrop).map((entry) => entry.toUpperCase());
  const apiCapAdd = stringList(api?.cap_add ?? api?.capAdd);
  const workerCapAdd = stringList(worker?.cap_add ?? worker?.capAdd);
  const apiSecurityOpt = stringList(api?.security_opt ?? api?.securityOpt);
  const workerSecurityOpt = stringList(worker?.security_opt ?? worker?.securityOpt);
  const workerGroupAdd = stringList(worker?.group_add ?? worker?.groupAdd);
  const workerCommand = serviceCommandText(worker);
  const apiNetworkMode = serviceNetworkMode(api);
  const workerNetworkMode = serviceNetworkMode(worker);
  const buildMemory = environmentValue(worker, "SITEFLOW_BUILD_MEMORY");
  const buildCpus = environmentValue(worker, "SITEFLOW_BUILD_CPUS");
  const buildPidsLimit = environmentValue(worker, "SITEFLOW_BUILD_PIDS_LIMIT");

  return {
    api: {
      user: stringValue(api?.user) ?? null,
      privileged: api?.privileged === true,
      readOnly: api?.read_only === true || api?.readOnly === true,
      capDropAll: apiCapDrop.includes("ALL"),
      capAdd: apiCapAdd,
      capAddEmpty: apiCapAdd.length === 0,
      noNewPrivileges: apiSecurityOpt.includes("no-new-privileges:true"),
      dangerousSecurityOpt: dangerousSecurityOptions(apiSecurityOpt),
      dangerousSecurityOptConfigured: dangerousSecurityOptions(apiSecurityOpt).length > 0,
      networkMode: apiNetworkMode ?? null,
      hostNetworkMode: apiNetworkMode?.toLowerCase() === "host",
      dockerSocketMounted: serviceDockerSocketMounted(api)
    },
    worker: {
      user: stringValue(worker?.user) ?? null,
      groupAdd: workerGroupAdd,
      groupAddConfigured: workerGroupAdd.length > 0,
      hostDockerSocketGid: hostDockerSocketGid ? Number(hostDockerSocketGid) : null,
      groupAddMatchesHostDockerSocketGid: Boolean(hostDockerSocketGid && workerGroupAdd.includes(hostDockerSocketGid)),
      privileged: worker?.privileged === true,
      readOnly: worker?.read_only === true || worker?.readOnly === true,
      capDropAll: workerCapDrop.includes("ALL"),
      capAdd: workerCapAdd,
      capAddEmpty: workerCapAdd.length === 0,
      noNewPrivileges: workerSecurityOpt.includes("no-new-privileges:true"),
      dangerousSecurityOpt: dangerousSecurityOptions(workerSecurityOpt),
      dangerousSecurityOptConfigured: dangerousSecurityOptions(workerSecurityOpt).length > 0,
      networkMode: workerNetworkMode ?? null,
      hostNetworkMode: workerNetworkMode?.toLowerCase() === "host",
      dockerSocketMounted: serviceDockerSocketMounted(worker),
      buildRunnerDocker: environmentValue(worker, "SITEFLOW_BUILD_RUNNER") === "docker",
      buildNetworkNone: environmentValue(worker, "SITEFLOW_BUILD_NETWORK") === "none",
      buildMemory: buildMemory ?? null,
      buildMemoryConfigured: dockerMemoryString(buildMemory),
      buildCpus: buildCpus ?? null,
      buildCpusConfigured: positiveNumberString(buildCpus),
      buildPidsLimit: buildPidsLimit ?? null,
      buildPidsLimitConfigured: positiveIntegerString(buildPidsLimit),
      dockerCliPreflightPresent: /\bcommand\s+-v\s+docker\b/.test(workerCommand),
      dockerInfoPreflightPresent: /\bdocker\s+info\b/.test(workerCommand),
      gitSshKeyPathEnvPresent: serviceEnvironment(worker).has("SITEFLOW_GIT_SSH_KEY_PATH"),
      gitKnownHostsPathEnvPresent: serviceEnvironment(worker).has("SITEFLOW_GIT_KNOWN_HOSTS_PATH")
    }
  };
}

function digestFromImageReference(value: unknown) {
  const raw = stringValue(value);
  const match = raw?.match(/@?(sha256:[a-f0-9]{64})$/i);

  return match?.[1];
}

function digestPinned(value: unknown) {
  return Boolean(digestFromImageReference(value));
}

function collectComposeConfigSummary(command: CommandResult, composeProject: string, dockerSocketGidCommand: CommandResult) {
  const parsed = parseJsonOutput(command.stdout);
  const config = isObject(parsed) ? parsed : undefined;
  const services = Object.keys(serviceMap(config));
  const healthchecks = services.filter((service) => serviceHasHealthcheck(serviceObject(config, service)));
  const buildServices = services.filter((service) => serviceObject(config, service)?.build !== undefined);
  const images = {
    postgres: serviceImage(config, "postgres") ?? null,
    api: serviceImage(config, "api") ?? null,
    worker: serviceImage(config, "worker") ?? null
  };
  const noBuildFallback = command.exitCode === 0 && buildServices.length === 0;
  const hostDockerSocketGid = dockerSocketGidFromStat(dockerSocketGidCommand);
  const dockerSocketGidPassed = dockerSocketGidCommand.exitCode === 0 && hostDockerSocketGid !== null;

  return {
    status: command.exitCode === 0 && config && dockerSocketGidPassed ? "passed" : "blocked",
    command: command.command,
    source: "target_host_docker_compose_config",
    composeProject,
    dockerSocketGidCommand: dockerSocketGidCommand.command,
    dockerSocketGidStatus: dockerSocketGidPassed ? "passed" : "blocked",
    hostDockerSocketGid: hostDockerSocketGid ? Number(hostDockerSocketGid) : null,
    services,
    secrets: rootSecrets(config),
    healthchecks,
    images,
    serviceProfiles: serviceProfiles(config, hostDockerSocketGid),
    imagePolicy: {
      postgresDigestPinned: digestPinned(images.postgres),
      apiDigestPinned: digestPinned(images.api),
      workerDigestPinned: digestPinned(images.worker),
      noBuildFallback
    },
    buildServices,
    buildFallbacks: buildServices,
    noBuildFallback,
    configSha256: command.stdout ? sha256Hex(command.stdout) : null,
    sanitized: true,
    rawConfigArchived: false
  };
}

function firstOutputLine(value: string) {
  return value.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
}

function collectTargetIdentitySummary(
  hostnameCommand: CommandResult,
  dockerContextCommand: CommandResult,
  dockerContextInspectCommand: CommandResult,
  options: {
    composeProject: string;
    composeFile: string;
    envFile?: string;
    publicBaseUrl: string;
  }
) {
  const hostname = firstOutputLine(hostnameCommand.stdout);
  const dockerContext = firstOutputLine(dockerContextCommand.stdout);
  const dockerContextInspectSha256 = dockerContextInspectCommand.stdout
    ? sha256Hex(redactSensitiveString(dockerContextInspectCommand.stdout))
    : undefined;
  const hostFingerprintSha256 = hostname && dockerContext && dockerContextInspectSha256
    ? sha256Hex(JSON.stringify({
      hostname,
      dockerContext,
      dockerContextInspectSha256,
      composeProject: options.composeProject,
      publicBaseUrl: options.publicBaseUrl
    }))
    : undefined;
  const passed = hostnameCommand.exitCode === 0 &&
    dockerContextCommand.exitCode === 0 &&
    dockerContextInspectCommand.exitCode === 0 &&
    Boolean(hostname && dockerContext && dockerContextInspectSha256 && hostFingerprintSha256);

  return {
    status: passed ? "passed" : "blocked",
    command: [
      hostnameCommand.command,
      dockerContextCommand.command,
      dockerContextInspectCommand.command
    ].join(" && "),
    source: "target_host_identity_probe",
    hostname: hostname ?? null,
    dockerContext: dockerContext ?? null,
    dockerContextInspectSha256: dockerContextInspectSha256 ?? null,
    rawContextArchived: false,
    hostFingerprintSha256: hostFingerprintSha256 ?? null,
    composeProject: options.composeProject,
    composeFile: options.composeFile,
    envFileConfigured: Boolean(options.envFile),
    publicBaseUrl: options.publicBaseUrl
  };
}

function psEntries(stdout: string) {
  const parsed = parseJsonOutput(stdout);

  if (Array.isArray(parsed)) {
    return parsed.filter(isObject);
  }

  return isObject(parsed) ? [parsed] : [];
}

function lowerString(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function firstStringField(entry: Record<string, unknown> | undefined, keys: string[]) {
  if (!entry) {
    return undefined;
  }

  for (const key of keys) {
    const value = stringValue(entry[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function psServiceName(entry: Record<string, unknown>) {
  return firstStringField(entry, ["Service", "service", "Name", "name"]);
}

function psEntryFor(entries: Record<string, unknown>[], service: string) {
  return entries.find((entry) => psServiceName(entry) === service);
}

function psState(entry: Record<string, unknown> | undefined) {
  return lowerString(entry?.State) ?? lowerString(entry?.state) ?? lowerString(entry?.Status) ?? lowerString(entry?.status);
}

function psHealth(entry: Record<string, unknown> | undefined) {
  return lowerString(entry?.Health) ?? lowerString(entry?.health);
}

function psImage(entry: Record<string, unknown> | undefined) {
  return firstStringField(entry, ["Image", "image"]);
}

function psContainerId(entry: Record<string, unknown> | undefined) {
  return firstStringField(entry, ["ID", "Id", "ContainerID", "containerId", "Name", "name"]);
}

function serviceRunning(entry: Record<string, unknown> | undefined) {
  return psState(entry) === "running";
}

function serviceHealthy(entry: Record<string, unknown> | undefined) {
  const health = psHealth(entry);

  return serviceRunning(entry) && (health === "healthy" || health === "running");
}

function restartLoopDetected(entries: Record<string, unknown>[]) {
  return entries.some((entry) => {
    const state = psState(entry) ?? "";
    const status = lowerString(entry.Status) ?? lowerString(entry.status) ?? "";

    return state.includes("restart") || status.includes("restart");
  });
}

function summarizeServiceHealth(command: CommandResult, composeProject: string, workerHealthcheckPassed: boolean) {
  const entries = psEntries(command.stdout);
  const postgres = psEntryFor(entries, "postgres");
  const api = psEntryFor(entries, "api");
  const worker = psEntryFor(entries, "worker");
  const workerHealthy = serviceHealthy(worker) && workerHealthcheckPassed;
  const postgresHealthy = serviceHealthy(postgres);
  const apiHealthy = serviceHealthy(api);
  const workerRunning = serviceRunning(worker);
  const passed = command.exitCode === 0 &&
    postgresHealthy &&
    apiHealthy &&
    workerRunning &&
    workerHealthy &&
    !restartLoopDetected(entries);

  return {
    status: passed ? "passed" : "blocked",
    command: command.command,
    composeProject,
    postgresHealthy,
    apiHealthy,
    workerRunning,
    workerHealthy,
    workerQueueProbePassed: workerHealthy,
    workerHeartbeatFresh: workerHealthy,
    restartLoopDetected: restartLoopDetected(entries),
    services: entries.map(psServiceName).filter((entry): entry is string => Boolean(entry)),
    containerIds: {
      postgres: psContainerId(postgres) ?? null,
      api: psContainerId(api) ?? null,
      worker: psContainerId(worker) ?? null
    }
  };
}

async function collectReadiness(
  fetchImpl: ReleaseTargetRuntimeEvidenceFetch,
  baseUrl: string,
  timeoutMs: number
) {
  try {
    const response = await fetchWithTimeout(fetchImpl, targetUrl(baseUrl, "/readyz"), { method: "GET" }, timeoutMs);
    const bodyStatus = await readinessBodyStatus(response);

    return {
      statusCode: response.status,
      bodyStatus,
      passed: response.status >= 200 && response.status < 300 && (bodyStatus === "ok" || bodyStatus === "ready")
    };
  } catch {
    return {
      statusCode: 0,
      bodyStatus: "unreachable",
      passed: false
    };
  }
}

async function readinessBodyStatus(response: FetchResponseLike) {
  try {
    const body = await response.json();

    if (isObject(body)) {
      const status = lowerString(body.status) ?? lowerString(body.ready) ?? lowerString(body.health);

      if (status === "ok" || status === "ready") {
        return status;
      }
    }
  } catch {
    // Fall back to text below.
  }

  try {
    const text = (await response.text()).trim().toLowerCase();

    return text === "ok" || text === "ready" ? text : "unrecognized";
  } catch {
    return "unrecognized";
  }
}

async function collectReadinessEvidence(
  fetchImpl: ReleaseTargetRuntimeEvidenceFetch,
  publicBaseUrl: string,
  loopbackBaseUrl: string,
  timeoutMs: number
) {
  const [loopback, publicProbe] = await Promise.all([
    collectReadiness(fetchImpl, loopbackBaseUrl, timeoutMs),
    collectReadiness(fetchImpl, publicBaseUrl, timeoutMs)
  ]);
  const passed = loopback.passed && publicProbe.passed;

  return {
    status: passed ? "passed" : "blocked",
    loopbackStatusCode: loopback.statusCode,
    publicStatusCode: publicProbe.statusCode,
    loopbackBodyStatus: loopback.bodyStatus,
    publicBodyStatus: publicProbe.bodyStatus
  };
}

function imageInspectEntries(stdout: string) {
  const parsed = parseJsonOutput(stdout);

  if (Array.isArray(parsed)) {
    return parsed.filter(isObject);
  }

  return isObject(parsed) ? [parsed] : [];
}

function repoDigestFromInspect(entry: Record<string, unknown> | undefined) {
  const repoDigests = Array.isArray(entry?.RepoDigests) ? entry?.RepoDigests : [];

  return repoDigests.map(digestFromImageReference).find(Boolean);
}

function imageIdFromInspect(entry: Record<string, unknown> | undefined) {
  return stringValue(entry?.Id) ?? stringValue(entry?.ID);
}

function collectImageBindingSummary(
  command: CommandResult,
  serviceEntries: Record<string, unknown>[],
  composeImages: Record<string, unknown>,
  expectedDigest: string | undefined
) {
  const entries = imageInspectEntries(command.stdout);
  const apiInspect = entries[0];
  const workerInspect = entries[1] ?? entries[0];
  const apiDigest = digestFromImageReference(composeImages.api) ?? repoDigestFromInspect(apiInspect);
  const workerDigest = digestFromImageReference(composeImages.worker) ?? repoDigestFromInspect(workerInspect);
  const releaseDigest = expectedDigest ?? (apiDigest && workerDigest && apiDigest === workerDigest ? apiDigest : undefined);
  const apiImageId = imageIdFromInspect(apiInspect);
  const workerImageId = imageIdFromInspect(workerInspect);
  const apiMatchesReleaseImage = Boolean(releaseDigest && apiDigest === releaseDigest);
  const workerMatchesReleaseImage = Boolean(releaseDigest && workerDigest === releaseDigest);
  const apiPs = psEntryFor(serviceEntries, "api");
  const workerPs = psEntryFor(serviceEntries, "worker");
  const passed = command.exitCode === 0 &&
    Boolean(releaseDigest && apiDigest && workerDigest && apiImageId && workerImageId && psContainerId(apiPs) && psContainerId(workerPs)) &&
    apiMatchesReleaseImage &&
    workerMatchesReleaseImage;

  return {
    status: passed ? "passed" : "blocked",
    command: command.command,
    expectedDigest: releaseDigest ?? null,
    apiImageDigest: apiDigest ?? null,
    workerImageDigest: workerDigest ?? null,
    apiContainerId: psContainerId(apiPs) ?? null,
    workerContainerId: psContainerId(workerPs) ?? null,
    apiImageId: apiImageId ?? null,
    workerImageId: workerImageId ?? null,
    apiMatchesReleaseImage,
    workerMatchesReleaseImage
  };
}

function logSanitySummary(command: CommandResult) {
  const output = command.stdout;
  const fatalErrors = (output.match(/\b(?:fatal|panic|uncaught|unhandled|segmentation fault)\b/gi) ?? []).length;
  const workerPreflightFailures = (output.match(/\bworker\b[^\n\r]{0,160}\b(?:preflight|healthcheck|docker info)\b[^\n\r]{0,160}\b(?:fail|failed|requires)\b/gi) ?? []).length;
  const secretLeakFindings = scanEvidenceForRawSecrets(output).length;
  const passed = command.exitCode === 0 && fatalErrors === 0 && workerPreflightFailures === 0 && secretLeakFindings === 0;

  return {
    status: passed ? "passed" : "blocked",
    command: command.command,
    fatalErrors,
    workerPreflightFailures,
    secretLeakFindings,
    rawLogsArchived: false
  };
}

function addTimestamps<T extends Record<string, unknown>>(section: T, checkedAt: string) {
  return {
    checkedAt,
    ...section
  };
}

function passingChecks(result: ReleaseTargetRuntimeEvidenceCheckResult) {
  return new Map(result.checks.map((check) => [check.name, check.status === "pass"]));
}

function addCheck(checks: ReleaseTargetRuntimeEvidenceCollectCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function finalizeEvidence(evidenceBase: Record<string, unknown>, options: ReleaseTargetRuntimeEvidenceCollectOptions) {
  const provisionalEvidence = {
    ...evidenceBase,
    status: "passed"
  };
  const provisionalCheck = evaluateReleaseTargetRuntimeEvidence(provisionalEvidence, {
    evidencePath: options.outputPath ?? "<collected-target-runtime-evidence>",
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
  const checkResult = evaluateReleaseTargetRuntimeEvidence(finalEvidence, {
    evidencePath: options.outputPath ?? "<collected-target-runtime-evidence>",
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

export async function collectReleaseTargetRuntimeEvidence(
  options: ReleaseTargetRuntimeEvidenceCollectOptions
): Promise<ReleaseTargetRuntimeEvidenceCollectResult> {
  const checkedAt = validIsoTimestamp(options.checkedAt, (options.now?.() ?? new Date()).toISOString());
  const commitRef = requiredString(options.commitRef, "--commit-ref");
  const repo = requiredString(options.repo, "--repo");
  const branch = requiredString(options.branch, "--branch");
  const targetEnvironment = requiredString(options.targetEnvironment, "--target-environment");
  const publicBaseUrl = normalizedBaseUrl(requiredString(options.publicBaseUrl, "--public-base-url"), "--public-base-url", true);
  const loopbackBaseUrl = normalizedBaseUrl(options.loopbackBaseUrl ?? defaultLoopbackBaseUrl, "--loopback-base-url", false);
  const operatorName = requiredString(options.operatorName, "--operator-name");
  const ticketId = requiredString(options.ticketId, "--release-ticket");
  const composeFile = stringValue(options.composeFile) ?? defaultComposeFile;
  const composeProject = stringValue(options.composeProject) ?? defaultComposeProject;
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const logTail = positiveInteger(options.logTail, defaultLogTail, "logTail");
  const expectedDigest = normalizedDigest(options.expectedDigest);
  const envFile = stringValue(options.envFile);
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const execFileImpl = options.execFileImpl ?? execFilePromise;
  const restartServices = options.restartServices?.length ? options.restartServices : ["api", "worker"];
  const composeBase = { composeFile, envFile, composeProject };
  const commandOptions = {
    cwd: options.cwd,
    env: options.env,
    timeoutMs
  };

  const hostnameCommand = await runCommand(execFileImpl, "hostname", [], commandOptions);
  const dockerContextCommand = await runCommand(execFileImpl, "docker", ["context", "show"], commandOptions);
  const dockerContext = firstOutputLine(dockerContextCommand.stdout) ?? "default";
  const dockerContextInspectCommand = await runCommand(execFileImpl, "docker", ["context", "inspect", dockerContext], commandOptions);
  const targetIdentity = collectTargetIdentitySummary(
    hostnameCommand,
    dockerContextCommand,
    dockerContextInspectCommand,
    {
      composeProject,
      composeFile,
      envFile,
      publicBaseUrl
    }
  );
  const configCommand = await runCommand(execFileImpl, "docker", composeArgs(composeBase, ["config", "--format", "json"]), commandOptions);
  const dockerSocketGidCommand = await runCommand(execFileImpl, "stat", ["-c", "%g", "/var/run/docker.sock"], commandOptions);
  const composeConfig = collectComposeConfigSummary(configCommand, composeProject, dockerSocketGidCommand);
  const startupCommand = options.systemdUnit
    ? await runCommand(execFileImpl, "systemctl", ["restart", options.systemdUnit], commandOptions)
    : await runCommand(execFileImpl, "docker", composeArgs(composeBase, ["up", "-d"]), commandOptions);
  const systemdActive = options.systemdUnit
    ? (await runCommand(execFileImpl, "systemctl", ["is-active", "--quiet", options.systemdUnit], commandOptions)).exitCode === 0
    : undefined;
  const systemdEnabled = options.systemdUnit
    ? (await runCommand(execFileImpl, "systemctl", ["is-enabled", "--quiet", options.systemdUnit], commandOptions)).exitCode === 0
    : undefined;
  const workerHealthcheckCommand = await runCommand(
    execFileImpl,
    "docker",
    composeArgs(composeBase, ["exec", "-T", "worker", "node", "dist-worker/worker/index.js", "--healthcheck"]),
    commandOptions
  );
  const serviceHealthCommand = await runCommand(execFileImpl, "docker", composeArgs(composeBase, ["ps", "--format", "json"]), commandOptions);
  const serviceEntries = psEntries(serviceHealthCommand.stdout);
  const serviceHealth = summarizeServiceHealth(serviceHealthCommand, composeProject, workerHealthcheckCommand.exitCode === 0);
  const readiness = await collectReadinessEvidence(fetchImpl, publicBaseUrl, loopbackBaseUrl, timeoutMs);
  const composeImages: Record<string, unknown> = isObject(composeConfig.images) ? composeConfig.images : {};
  const apiImage = stringValue(composeImages.api) ?? psImage(psEntryFor(serviceEntries, "api"));
  const workerImage = stringValue(composeImages.worker) ?? psImage(psEntryFor(serviceEntries, "worker"));
  const imageInspectCommand = await runCommand(
    execFileImpl,
    "docker",
    ["image", "inspect", ...(apiImage ? [apiImage] : []), ...(workerImage && workerImage !== apiImage ? [workerImage] : [])],
    commandOptions
  );
  const imageBinding = collectImageBindingSummary(imageInspectCommand, serviceEntries, composeImages, expectedDigest);
  const restartCommand = await runCommand(execFileImpl, "docker", composeArgs(composeBase, ["restart", ...restartServices]), commandOptions);
  const postRestartWorkerHealthcheck = await runCommand(
    execFileImpl,
    "docker",
    composeArgs(composeBase, ["exec", "-T", "worker", "node", "dist-worker/worker/index.js", "--healthcheck"]),
    commandOptions
  );
  const postRestartServiceHealthCommand = await runCommand(execFileImpl, "docker", composeArgs(composeBase, ["ps", "--format", "json"]), commandOptions);
  const postRestartServiceHealth = summarizeServiceHealth(
    postRestartServiceHealthCommand,
    composeProject,
    postRestartWorkerHealthcheck.exitCode === 0
  );
  const postRestartReadiness = await collectReadinessEvidence(fetchImpl, publicBaseUrl, loopbackBaseUrl, timeoutMs);
  const logsCommand = await runCommand(
    execFileImpl,
    "docker",
    composeArgs(composeBase, ["logs", "--no-color", "--since", options.logSince ?? defaultLogSince, "--tail", String(logTail), "postgres", "api", "worker"]),
    commandOptions
  );
  const logSanity = logSanitySummary(logsCommand);
  const restartSmoke = {
    status: restartCommand.exitCode === 0 &&
      postRestartServiceHealth.status === "passed" &&
      postRestartReadiness.status === "passed"
      ? "passed"
      : "blocked",
    restartCommand: restartCommand.command,
    restarted: restartCommand.exitCode === 0,
    serviceHealthAfterRestart: postRestartServiceHealth.status === "passed",
    workerHealthAfterRestart: postRestartServiceHealth.workerHealthy === true,
    readinessAfterRestart: postRestartReadiness.status === "passed"
  };
  const startup = {
    status: startupCommand.exitCode === 0 && (systemdActive === undefined || systemdActive) ? "passed" : "blocked",
    command: startupCommand.command,
    ...(systemdActive !== undefined ? { systemdActive, systemdEnabled } : { composeUpExitCode: startupCommand.exitCode })
  };
  const evidenceBase: Record<string, unknown> = {
    schemaVersion: "siteflow.targetRuntimeEvidence.v1",
    name: "siteflow-target-runtime-evidence",
    dryRun: false,
    template: false,
    checkedAt,
    targetEnvironment,
    publicBaseUrl,
    release: {
      commitRef,
      repository: repo,
      branch
    },
    targetIdentity: addTimestamps(targetIdentity, checkedAt),
    composeConfig: addTimestamps(composeConfig, checkedAt),
    startup: addTimestamps(startup, checkedAt),
    serviceHealth: addTimestamps(serviceHealth, checkedAt),
    readiness: addTimestamps(readiness, checkedAt),
    imageBinding: addTimestamps(imageBinding, checkedAt),
    restartSmoke: addTimestamps(restartSmoke, checkedAt),
    logSanity: addTimestamps(logSanity, checkedAt),
    negativeEvidence: {
      noRawComposeConfigArchived: true,
      noRawEnvArchived: true,
      noRawSecretsArchived: true,
      noUnredactedLogsArchived: true
    },
    operatorName,
    ticketId
  };
  const { evidence, checkResult } = finalizeEvidence(evidenceBase, options);
  const checks: ReleaseTargetRuntimeEvidenceCollectCheck[] = [];
  const checkMap = passingChecks(checkResult);
  const secretFindings = scanEvidenceForRawSecrets(evidence);

  addCheck(checks, "compose_config_collected", checkMap.get("compose_config_status") === true, "Collector must summarize target docker compose config metadata.");
  addCheck(checks, "target_identity_collected", checkMap.get("target_identity_status") === true && checkMap.get("target_identity_compose_project") === true, "Collector must bind evidence to target host identity, Docker context, and Compose project.");
  addCheck(checks, "startup_collected", checkMap.get("startup_status") === true, "Collector must start or restart the target runtime.");
  addCheck(checks, "service_health_collected", checkMap.get("service_health_status") === true, "Collector must collect target service status and health.");
  addCheck(checks, "worker_healthcheck_collected", workerHealthcheckCommand.exitCode === 0 && checkMap.get("service_health_worker") === true, "Collector must execute the worker runtime healthcheck on the target.");
  addCheck(checks, "readiness_collected", checkMap.get("readiness_loopback") === true && checkMap.get("readiness_public") === true, "Collector must observe loopback and public /readyz.");
  addCheck(checks, "image_binding_collected", checkMap.get("image_binding_digests") === true, "Collector must bind API and worker containers to the release image digest.");
  addCheck(checks, "restart_smoke_collected", checkMap.get("restart_smoke_status") === true, "Collector must restart the target services and re-check health/readiness.");
  addCheck(checks, "target_runtime_evidence_check", checkResult.status === "passed", "Collected target runtime evidence must pass release:target-runtime:evidence.");
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
      name: "siteflow-target-runtime-evidence-collect",
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
    name: "siteflow-target-runtime-evidence-collect",
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

export function parseReleaseTargetRuntimeEvidenceCollectArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    timeoutMs: defaultTimeoutMs,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--commit-ref") {
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
    } else if (arg === "--public-base-url") {
      parsed.publicBaseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--release-ticket" || arg === "--ticket-id") {
      parsed.ticketId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--check-output") {
      parsed.checkOutputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--compose-file") {
      parsed.composeFile = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--env-file") {
      parsed.envFile = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--compose-project") {
      parsed.composeProject = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--expected-digest") {
      parsed.expectedDigest = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--loopback-base-url") {
      parsed.loopbackBaseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--systemd-unit") {
      parsed.systemdUnit = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--restart-services") {
      parsed.restartServices = readArgValue(args, index, arg).split(",").map((entry) => entry.trim()).filter(Boolean);
      index += 1;
    } else if (arg === "--log-since") {
      parsed.logSince = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--log-tail") {
      parsed.logTail = Number(readArgValue(args, index, arg));
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
    requiredString(parsed.commitRef, "--commit-ref <sha>");
    requiredString(parsed.repo, "--repo <owner/name>");
    requiredString(parsed.branch, "--branch <name>");
    requiredString(parsed.targetEnvironment, "--target-environment <name>");
    requiredString(parsed.publicBaseUrl, "--public-base-url <url>");
    requiredString(parsed.operatorName, "--operator-name <name>");
    requiredString(parsed.ticketId, "--release-ticket <id>");
    normalizedBaseUrl(parsed.publicBaseUrl!, "--public-base-url", true);

    if (parsed.loopbackBaseUrl) {
      normalizedBaseUrl(parsed.loopbackBaseUrl, "--loopback-base-url", false);
    }

    normalizedDigest(parsed.expectedDigest);
  }

  positiveNumber(parsed.timeoutMs, defaultTimeoutMs, "--timeout-ms");
  positiveNumber(parsed.maxAgeHours, 168, "--max-age-hours");
  positiveInteger(parsed.logTail, defaultLogTail, "--log-tail");
  validIsoTimestamp(parsed.checkedAt, new Date().toISOString());

  return parsed;
}

export function releaseTargetRuntimeEvidenceCollectUsage() {
  return [
    "Usage: npm run --silent release:target-runtime:evidence:collect -- --commit-ref <sha> --repo <owner/name> --branch <branch> --target-environment <env> --public-base-url <url> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    `  --compose-file <file>           Compose file. Default: ${defaultComposeFile}.`,
    "  --env-file <file>               Target env file passed to docker compose; contents are never written.",
    `  --compose-project <name>        Compose project name. Default: ${defaultComposeProject}.`,
    "  --expected-digest <sha256>      Release image digest expected for API and worker.",
    `  --loopback-base-url <url>       Loopback API base URL. Default: ${defaultLoopbackBaseUrl}.`,
    "  --systemd-unit <unit>           Restart the named systemd unit for startup evidence instead of docker compose up -d.",
    "  --restart-services <csv>        Compose services restarted for smoke evidence. Default: api,worker.",
    `  --log-since <duration>          Startup log window for redacted summary. Default: ${defaultLogSince}.`,
    `  --log-tail <count>              Max log lines read into memory for summary. Default: ${defaultLogTail}.`,
    "  --output <file>                 Write collected raw target runtime evidence.",
    "  --check-output <file>           Write release:target-runtime:evidence checker output.",
    `  --timeout-ms <ms>               Command and HTTP timeout. Default: ${defaultTimeoutMs}.`,
    "  --max-age-hours <hours>         Maximum evidence age passed to checker output.",
    "  --checked-at <iso>              Use a fixed collection timestamp.",
    "  --json                          Print raw evidence when collected; print diagnostics when blocked.",
    "  --help                          Show this help.",
    "",
    "The collector runs on the target host and writes only sanitized host/Docker context identity, metadata, hashes, status fields, container/image identifiers, and counts. It does not archive raw Docker context inspect output, Compose config, env files, secrets, or unredacted logs."
  ].join("\n");
}

function writeHumanResult(result: ReleaseTargetRuntimeEvidenceCollectResult, io: CliIo) {
  const output = result.status === "collected" ? io.stdout : io.stderr;

  output.write(`SiteFlow target runtime evidence collect status: ${result.status}\n`);

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

export async function runReleaseTargetRuntimeEvidenceCollectCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseTargetRuntimeEvidenceCollectOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseTargetRuntimeEvidenceCollectArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseTargetRuntimeEvidenceCollectUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseTargetRuntimeEvidenceCollectUsage()}\n`);
    return 0;
  }

  try {
    const result = await collectReleaseTargetRuntimeEvidence({
      ...baseOptions,
      commitRef: parsed.commitRef!,
      repo: parsed.repo!,
      branch: parsed.branch!,
      targetEnvironment: parsed.targetEnvironment!,
      publicBaseUrl: parsed.publicBaseUrl!,
      operatorName: parsed.operatorName!,
      ticketId: parsed.ticketId!,
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      composeFile: parsed.composeFile,
      envFile: parsed.envFile,
      composeProject: parsed.composeProject,
      expectedDigest: parsed.expectedDigest,
      loopbackBaseUrl: parsed.loopbackBaseUrl,
      systemdUnit: parsed.systemdUnit,
      restartServices: parsed.restartServices,
      logSince: parsed.logSince,
      logTail: parsed.logTail,
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
    const result: ReleaseTargetRuntimeEvidenceCollectResult = {
      name: "siteflow-target-runtime-evidence-collect",
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
  runReleaseTargetRuntimeEvidenceCollectCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
