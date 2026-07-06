import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FunctionApiStyle, ProjectBuildSettings, ReleaseChannelName, RepositoryBinding, RoutingHeader, SiteFlowId, SourceEvent } from "../src/domain/siteflow.js";
import { redactLogLine } from "../src/lib/redaction.js";
import { sealSecretValue } from "../src/lib/sealedSecrets.js";
import type { PrebuiltImageConfig } from "../src/lib/api/deployContracts.js";
import { publishBuildArtifact, type ArtifactExtraFileInput, type FunctionArtifactInput, type PublishedBuildArtifact } from "./artifactPublisher.js";
import { runBuildCommand, type BuildRunner, type DockerBuildRunnerConfig } from "./buildSandbox.js";
import { detectBuildSettings } from "./frameworkDetector.js";

export interface QueuedBuildJob {
  id: SiteFlowId;
  projectId: SiteFlowId;
  projectSlug: string;
  productionBranch?: string;
  sourceEventId: SiteFlowId;
  sourceEvent: SourceEvent;
  repository: RepositoryBinding;
  buildSettings: ProjectBuildSettings;
  environmentVariables?: Record<string, string>;
}

export interface BuildJobResult {
  job: QueuedBuildJob;
  deploymentId: SiteFlowId;
  previewHost: string;
  previewUrl: string;
  productionHost?: string;
  artifact: PublishedBuildArtifact;
  crons?: BuildCronJob[];
}

export interface BuildQueue {
  claimNextJob(workerId: string): Promise<QueuedBuildJob | undefined>;
  appendLog(jobId: SiteFlowId, line: string): Promise<void>;
  heartbeatJob?(job: QueuedBuildJob): Promise<void>;
  completeJob(job: QueuedBuildJob, result: BuildJobResult): Promise<void>;
  skipJob(job: QueuedBuildJob, reason: string): Promise<void>;
  failJob(job: QueuedBuildJob, reason: string): Promise<void>;
}

export interface SourceCheckout {
  sourceDirectory: string;
  cleanup?: () => Promise<void>;
}

export interface SourceResolver {
  checkout(job: QueuedBuildJob, workspaceRoot: string): Promise<SourceCheckout>;
}

export interface BuildWorkerOptions {
  workerId: string;
  queue: BuildQueue;
  sourceResolver: SourceResolver;
  workspaceRoot?: string;
  artifactRoot: string;
  baseDomain: string;
  publicScheme?: "http" | "https";
  entrypoint?: string;
  jobHeartbeatIntervalMs?: number;
  allowUnsandboxedSourceBuilds?: boolean;
  buildRunner?: BuildRunner;
  dockerBuild?: DockerBuildRunnerConfig;
  buildStepTimeoutMs?: number;
  maxArtifactBytes?: number;
  maxArtifactFiles?: number;
  minBuildFreeBytes?: number;
  /**
   * Optional fire-and-forget build outcome notifier (HOLDFAST Klaxon). Invoked
   * AFTER the job status is durably written; implementations must never throw
   * and never block (see worker/klaxonNotifier.ts).
   */
  buildEventNotifier?: (event: {
    status: "succeeded" | "failed";
    job: QueuedBuildJob;
    result?: BuildJobResult;
    reason?: string;
  }) => void;
}

export interface BuildExecutionOptions {
  sourceResolver: SourceResolver;
  workspaceRoot?: string;
  artifactRoot: string;
  baseDomain: string;
  publicScheme?: "http" | "https";
  entrypoint?: string;
  allowUnsandboxedSourceBuilds?: boolean;
  buildRunner?: BuildRunner;
  dockerBuild?: DockerBuildRunnerConfig;
  buildStepTimeoutMs?: number;
  maxArtifactBytes?: number;
  maxArtifactFiles?: number;
  minBuildFreeBytes?: number;
  appendLog?: (line: string) => Promise<void>;
}

export interface BuildCronJob {
  path: string;
  schedule: string;
}

interface SourceRoutingRule {
  name?: string;
  source: string;
  destination?: string;
  statusCode?: 301 | 302 | 307 | 308;
  headers?: RoutingHeader[];
}

interface SourceVercelConfig {
  public?: boolean;
  fluid?: boolean | null;
  bunVersion?: string;
  buildEnv?: Record<string, string>;
  runtimeEnv?: Record<string, string>;
  images?: PrebuiltImageConfig;
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  skipTrailingSlashRedirect?: boolean;
  redirects?: SourceRoutingRule[];
  rewrites?: SourceRoutingRule[];
  headers?: SourceRoutingRule[];
  crons?: BuildCronJob[];
  functions?: SourceFunctionConfig[];
  regions?: string[];
  failoverRegions?: string[];
  gitDeployment?: GitDeploymentConfig;
}

interface GitDeploymentConfig {
  enabled?: boolean;
  rules?: GitDeploymentRule[];
}

interface GitDeploymentRule {
  pattern: string;
  enabled: boolean;
}

interface SourceFunctionConfig {
  pattern: string;
  timeoutMs?: number;
  memoryMb?: number;
  concurrency?: number;
  apiStyle?: FunctionApiStyle;
  includeFiles?: string[];
  excludeFiles?: string[];
  regions?: string[];
  failoverRegions?: string[];
}

class BuildSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildSkippedError";
  }
}

const defaultJobHeartbeatIntervalMs = 60_000;
const unsafeSourceBuildGuardMessage =
  "Production source build rejected: no sandboxed build runner is configured. " +
  "Set SITEFLOW_TRUSTED_SOURCE_BUILDS=1 or SITEFLOW_ALLOW_UNSANDBOXED_BUILDS=1 only for trusted source builds.";

function shouldRejectUnsandboxedSourceBuild(options: { allowUnsandboxedSourceBuilds?: boolean; buildRunner?: BuildRunner }) {
  return options.allowUnsandboxedSourceBuilds === false && options.buildRunner !== "docker";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactionPatternsFor(values: Record<string, string> | undefined) {
  return Object.values(values ?? {})
    .filter((value) => value.length >= 4)
    .map((value) => new RegExp(escapeRegExp(value), "g"));
}

function isSensitiveBuildEnvKey(key: string) {
  if (/^(?:NEXT_PUBLIC_|VITE_|PUBLIC_)/.test(key)) {
    return false;
  }

  return /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASS|PRIVATE_KEY|API_KEY|SERVICE_KEY|AUTH)(?:_|$)/i.test(key);
}

function blockedArtifactContentValues(values: Record<string, string> | undefined) {
  return Object.entries(values ?? {})
    .filter(([key, value]) => isSensitiveBuildEnvKey(key) || /SITEFLOW_SECRET_CANARY/i.test(value))
    .map(([label, value]) => ({ label, value }));
}

function sensitiveBuildEnvKeys(values: Record<string, string> | undefined) {
  return Object.keys(values ?? {})
    .filter(isSensitiveBuildEnvKey)
    .sort();
}

function clientBuildEnvVariables(values: Record<string, string> | undefined) {
  return Object.fromEntries(
    Object.entries(values ?? {})
      .filter(([key]) => !isSensitiveBuildEnvKey(key))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function assertNetworkedDockerBuildEnvAllowed(
  options: { buildRunner?: BuildRunner; dockerBuild?: DockerBuildRunnerConfig },
  values: Record<string, string> | undefined
) {
  if (options.buildRunner !== "docker" || options.dockerBuild?.network !== "bridge") {
    return;
  }

  const sensitiveKeys = sensitiveBuildEnvKeys(values);

  if (sensitiveKeys.length > 0) {
    throw new Error(
      `Networked Docker builds cannot receive sensitive build environment variables: ${sensitiveKeys.join(", ")}. ` +
      "Set SITEFLOW_BUILD_NETWORK=none or remove sensitive build env."
    );
  }
}

export interface BuildStoragePreflightOptions {
  workspaceRoot: string;
  artifactRoot: string;
  tempRoot?: string;
  minFreeBytes?: number;
}

function positiveMinFreeBytes(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("SITEFLOW_BUILD_MIN_FREE_BYTES must be a positive integer.");
  }

  return value;
}

function availableBytes(stats: Awaited<ReturnType<typeof statfs>>) {
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function assertBuildStoragePreflight(options: BuildStoragePreflightOptions) {
  const minFreeBytes = positiveMinFreeBytes(options.minFreeBytes);

  if (minFreeBytes === undefined) {
    return;
  }

  await mkdir(options.workspaceRoot, { recursive: true });
  await mkdir(options.artifactRoot, { recursive: true });

  const roots = [
    { label: "workspaceRoot", path: options.workspaceRoot },
    { label: "artifactRoot", path: options.artifactRoot },
    { label: "tempRoot", path: options.tempRoot ?? os.tmpdir() }
  ];
  const checkedPaths = new Set<string>();
  const failures: string[] = [];

  for (const root of roots) {
    const resolvedPath = path.resolve(root.path);

    if (checkedPaths.has(resolvedPath)) {
      continue;
    }

    checkedPaths.add(resolvedPath);

    const freeBytes = availableBytes(await statfs(resolvedPath));

    if (freeBytes < minFreeBytes) {
      failures.push(`${root.label} ${resolvedPath} has ${freeBytes} available bytes, requires ${minFreeBytes}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`SITEFLOW_BUILD_MIN_FREE_BYTES preflight failed: ${failures.join("; ")}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }

    throw error;
  }
}

function cronJob(value: unknown): BuildCronJob | undefined {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.schedule !== "string") {
    return undefined;
  }

  return {
    path: value.path,
    schedule: value.schedule
  };
}

function statusCode(value: unknown) {
  return value === 301 || value === 302 || value === 307 || value === 308 ? value : undefined;
}

function routingRule(value: unknown): SourceRoutingRule | undefined {
  if (!isRecord(value) || typeof value.source !== "string") {
    return undefined;
  }

  const headers = Array.isArray(value.headers)
    ? value.headers.flatMap((entry): RoutingHeader[] => {
      if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
        return [];
      }

      return [
        {
          key: entry.key,
          value: entry.value
        }
      ];
    })
    : undefined;

  return {
    name: typeof value.name === "string" ? value.name : undefined,
    source: value.source,
    destination: typeof value.destination === "string" ? value.destination : undefined,
    statusCode: statusCode(value.statusCode ?? (value.permanent === true ? 308 : undefined)),
    headers: headers?.length ? headers : undefined
  };
}

function routingRules(value: unknown) {
  return Array.isArray(value) ? value.map(routingRule).filter((entry): entry is SourceRoutingRule => Boolean(entry)) : undefined;
}

function gitDeploymentConfig(value: unknown): GitDeploymentConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const deploymentEnabled = value.deploymentEnabled;

  if (typeof deploymentEnabled === "boolean") {
    return {
      enabled: deploymentEnabled
    };
  }

  if (!isRecord(deploymentEnabled)) {
    return undefined;
  }

  const rules = Object.entries(deploymentEnabled).flatMap(([pattern, enabled]): GitDeploymentRule[] => {
    if (typeof enabled !== "boolean") {
      return [];
    }

    return [
      {
        pattern: pattern.replace(/\\/g, "/").replace(/^\/+/, ""),
        enabled
      }
    ];
  }).filter((rule) => rule.pattern.length > 0);

  return rules.length ? { rules } : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.trim() ? [value] : undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return entries.length ? entries : undefined;
}

function vercelRegionList(value: unknown): string[] | undefined {
  const entries = stringList(value)
    ?.map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[a-z]{3}\d$/.test(entry));

  return entries?.length ? [...new Set(entries)] : undefined;
}

function safeFilePattern(value: string, fieldName: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid ${fieldName} pattern: ${value}`);
  }

  return normalized;
}

function bunVersion(value: unknown): string | undefined {
  if (value !== "1.x") {
    return undefined;
  }

  return value;
}

function positiveIntegerList(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .filter((entry): entry is number => Number.isInteger(entry) && entry > 0);
  return entries.length ? [...new Set(entries)].sort((left, right) => left - right) : undefined;
}

function imageFormats(value: unknown): PrebuiltImageConfig["formats"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.filter((entry): entry is "image/avif" | "image/webp" =>
    entry === "image/avif" || entry === "image/webp"
  );
  return entries.length ? [...new Set(entries)] : undefined;
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function positiveHeartbeatIntervalMs(value: number | undefined) {
  if (value === undefined) {
    return defaultJobHeartbeatIntervalMs;
  }

  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Build job heartbeat interval must be a positive number.");
  }

  return Math.ceil(value);
}

function imageConfig(value: unknown): PrebuiltImageConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config: PrebuiltImageConfig = {
    sizes: positiveIntegerList(value.sizes),
    qualities: positiveIntegerList(value.qualities),
    formats: imageFormats(value.formats),
    minimumCacheTTL: nonNegativeInteger(value.minimumCacheTTL),
    dangerouslyAllowSVG: typeof value.dangerouslyAllowSVG === "boolean" ? value.dangerouslyAllowSVG : undefined,
    contentSecurityPolicy: typeof value.contentSecurityPolicy === "string" && value.contentSecurityPolicy.trim()
      ? value.contentSecurityPolicy.trim()
      : undefined,
    contentDispositionType: value.contentDispositionType === "inline" || value.contentDispositionType === "attachment"
      ? value.contentDispositionType
      : undefined
  };

  return Object.values(config).some((entry) => entry !== undefined) ? config : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function buildEnvKeys(value: Record<string, string> | undefined) {
  return value ? Object.keys(value).sort() : undefined;
}

function sealedRuntimeEnv(value: Record<string, string> | undefined) {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sealSecretValue(entry)]));
}

async function readSourceVercelConfig(projectRoot: string): Promise<SourceVercelConfig> {
  const parsed = await readJsonFile(path.resolve(projectRoot, "vercel.json"));

  if (!isRecord(parsed)) {
    return {};
  }

  const crons = Array.isArray(parsed.crons)
    ? parsed.crons.map(cronJob).filter((entry): entry is BuildCronJob => Boolean(entry))
    : undefined;
  const functions = isRecord(parsed.functions)
    ? Object.entries(parsed.functions).flatMap(([pattern, config]): SourceFunctionConfig[] => {
      if (!isRecord(config)) {
        return [];
      }

      const maxDuration = typeof config.maxDuration === "number" ? config.maxDuration : undefined;
      const memory = parsed.fluid === true ? undefined : typeof config.memory === "number" ? config.memory : undefined;
      const concurrency = typeof config.concurrency === "number" ? config.concurrency : undefined;
      const rawApiStyle = config.api ?? config.apiStyle;
      const apiStyle = rawApiStyle === "node" || rawApiStyle === "fetch" ? rawApiStyle : undefined;
      const includeFiles = stringList(config.includeFiles)?.map((value) => safeFilePattern(value, "includeFiles"));
      const excludeFiles = stringList(config.excludeFiles)?.map((value) => safeFilePattern(value, "excludeFiles"));
      const regions = vercelRegionList(config.regions);
      const failoverRegions = vercelRegionList(config.functionFailoverRegions);

      return [
        {
          pattern,
          timeoutMs: maxDuration === undefined ? undefined : Math.max(1, Math.round(maxDuration * 1000)),
          memoryMb: memory === undefined ? undefined : Math.round(memory),
          concurrency: concurrency === undefined ? undefined : Math.round(concurrency),
          apiStyle,
          includeFiles,
          excludeFiles,
          regions,
          failoverRegions
        }
      ];
    }).filter((entry) =>
      entry.timeoutMs !== undefined
      || entry.memoryMb !== undefined
      || entry.concurrency !== undefined
      || entry.apiStyle !== undefined
      || Boolean(entry.includeFiles?.length)
      || Boolean(entry.excludeFiles?.length)
      || Boolean(entry.regions?.length)
      || Boolean(entry.failoverRegions?.length)
    )
    : undefined;
  const regions = vercelRegionList(parsed.regions);
  const failoverRegions = vercelRegionList(parsed.functionFailoverRegions);
  const gitDeployment = gitDeploymentConfig(parsed.git);
  const redirects = routingRules(parsed.redirects);
  const rewrites = routingRules(parsed.rewrites);
  const headers = routingRules(parsed.headers);
  const buildEnv = isRecord(parsed.build) ? stringRecord(parsed.build.env) : undefined;
  const runtimeEnv = stringRecord(parsed.env);

  return {
    public: typeof parsed.public === "boolean" ? parsed.public : undefined,
    fluid: typeof parsed.fluid === "boolean" || parsed.fluid === null ? parsed.fluid : undefined,
    bunVersion: bunVersion(parsed.bunVersion),
    buildEnv,
    runtimeEnv,
    images: imageConfig(parsed.images),
    cleanUrls: typeof parsed.cleanUrls === "boolean" ? parsed.cleanUrls : undefined,
    trailingSlash: typeof parsed.trailingSlash === "boolean" ? parsed.trailingSlash : undefined,
    skipTrailingSlashRedirect: typeof parsed.skipTrailingSlashRedirect === "boolean" ? parsed.skipTrailingSlashRedirect : undefined,
    redirects: redirects?.length ? redirects : undefined,
    rewrites: rewrites?.length ? rewrites : undefined,
    headers: headers?.length ? headers : undefined,
    crons: crons?.length ? crons : undefined,
    functions: functions?.length ? functions : undefined,
    regions,
    failoverRegions,
    gitDeployment
  };
}

function routeChannelFor(sourceEvent: SourceEvent, productionBranch: string): ReleaseChannelName {
  return sourceEvent.branch === productionBranch ? "production" : "preview";
}

function previewHostFor(job: QueuedBuildJob, deploymentId: SiteFlowId, baseDomain: string) {
  const shortCommit = job.sourceEvent.commitSha.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase() || deploymentId.slice(0, 12);
  const suffix = deploymentId.replace(/^dep_/, "").slice(0, 8);
  return `${job.projectSlug}-${shortCommit}-${suffix}.${baseDomain}`;
}

function resolveProjectRoot(sourceDirectory: string, rootDirectory: string | undefined) {
  const root = path.resolve(sourceDirectory, rootDirectory ?? ".");

  if (root !== sourceDirectory && !root.startsWith(`${sourceDirectory}${path.sep}`)) {
    throw new Error("Build root directory escapes the source checkout.");
  }

  return root;
}

function isPathWithinRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveOutputDirectory(projectRoot: string, outputDirectory: string) {
  const output = path.resolve(projectRoot, outputDirectory);

  if (!isPathWithinRoot(projectRoot, output)) {
    throw new Error("Build output directory escapes the project root.");
  }

  const realProjectRoot = await realpath(projectRoot);
  let realOutput: string;

  try {
    realOutput = await realpath(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Build output directory does not exist: ${outputDirectory}.`);
    }

    throw error;
  }

  if (!isPathWithinRoot(realProjectRoot, realOutput)) {
    throw new Error(`Build output directory resolves outside the project root: ${outputDirectory}.`);
  }

  return output;
}

function functionRoutePath(relativePath: string) {
  const withoutExtension = relativePath.replace(/\.(?:cjs|mjs|js)$/i, "");
  const routePath = withoutExtension === "index" ? "" : withoutExtension.replace(/\/index$/, "");
  const route = routePath ? `/api/${routePath}` : "/api";
  return route.replace(/\\/g, "/");
}

function functionConfigPatternMatches(routePath: string, sourcePath: string, pattern: string) {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalizedSource = sourcePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalizedRoute = routePath.replace(/^\/+/, "");

  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
    return regex.test(normalizedSource) || regex.test(normalizedRoute);
  }

  return normalizedPattern === normalizedSource
    || normalizedPattern === normalizedRoute
    || `api/${normalizedPattern}` === normalizedSource
    || `api/${normalizedPattern}` === normalizedRoute;
}

function functionArtifactSourcePath(entry: FunctionArtifactInput) {
  return entry.artifactPath.replace(/^\.siteflow\/functions\//, "");
}

function nodeApiStyleSniff(source: string): boolean {
  // Detect the Vercel/Node handler ONLY by its default export's second parameter being named
  // res/response. The earlier body-text `res.*(...)` heuristic was removed: it false-positived on
  // fetch-style handlers that name an upstream fetch Response `res` (e.g. `const res = await fetch()`
  // then `res.json()`), which would wrongly flip a working fetch function to node on rebuild. When
  // the signature is ambiguous, apiStyle stays 'fetch' (safe default); users force node via vercel.json.
  return /export\s+default\s+(?:async\s+)?function[^(]*\([^,)]*,\s*(?:res|response)\b/.test(source)
    || /export\s+default\s+(?:async\s+)?\([^,)]*,\s*(?:res|response)\b/.test(source);
}

function applyFunctionConfig(entries: FunctionArtifactInput[], config: SourceVercelConfig) {
  const configs = config.functions;

  if (!configs?.length) {
    return entries.map((entry) => ({
      ...entry,
      apiStyle: entry.apiStyle,
      regions: config.regions ?? entry.regions,
      failoverRegions: config.failoverRegions ?? entry.failoverRegions
    }));
  }

  return entries.map((entry) => {
    const matched = configs.find((config) => functionConfigPatternMatches(entry.path, functionArtifactSourcePath(entry), config.pattern));

    return {
      ...entry,
      timeoutMs: matched?.timeoutMs ?? entry.timeoutMs,
      memoryMb: matched?.memoryMb ?? entry.memoryMb,
      concurrency: matched?.concurrency ?? entry.concurrency,
      apiStyle: matched?.apiStyle ?? entry.apiStyle,
      regions: matched?.regions ?? config.regions ?? entry.regions,
      failoverRegions: matched?.failoverRegions ?? config.failoverRegions ?? entry.failoverRegions
    };
  });
}

function globToRegExp(pattern: string) {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;

        while (pattern[index + 1] === "*") {
          index += 1;
        }

        if (pattern[index + 1] === "/") {
          source += "(?:.*/)?";
          index += 1;
        } else {
          source += ".*";
        }
        continue;
      }

      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

function gitDeploymentEnabled(config: GitDeploymentConfig | undefined, branch: string) {
  if (!config) {
    return true;
  }

  if (config.enabled !== undefined) {
    return config.enabled;
  }

  const matches = (config.rules ?? [])
    .filter((rule) => globToRegExp(rule.pattern).test(branch));

  if (matches.length === 0) {
    return true;
  }

  return matches.some((rule) => rule.enabled);
}

function globStaticPrefix(pattern: string) {
  const wildcardIndex = pattern.search(/[*?{[]/);
  const literalPrefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  const lastSlash = literalPrefix.lastIndexOf("/");

  return lastSlash === -1 ? "" : literalPrefix.slice(0, lastSlash);
}

function resolveProjectFile(projectRoot: string, relativePath: string) {
  const fullPath = path.resolve(projectRoot, ...relativePath.split("/"));

  if (fullPath !== projectRoot && !fullPath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Included file escapes the project root: ${relativePath}`);
  }

  return fullPath;
}

function pathStaysInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function functionIncludeFileDenyReason(relativePath: string) {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/").map((segment) => segment.toLowerCase());
  const basename = segments[segments.length - 1] ?? "";
  const extension = path.posix.extname(basename);

  if (segments.some((segment) => segment === "secrets" || segment === ".secrets")) {
    return "secrets directory";
  }

  if (segments.includes(".ssh")) {
    return ".ssh directory";
  }

  if (segments.includes(".aws")) {
    return ".aws directory";
  }

  if (basename === ".env" || basename.startsWith(".env.")) {
    return ".env file";
  }

  if (basename === ".npmrc" || basename === ".pypirc" || basename === ".netrc") {
    return "credential config file";
  }

  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(basename)) {
    return "private key file";
  }

  if (basename.includes("private-key") || basename.includes("private_key")) {
    return "private key file";
  }

  if ([".pem", ".key", ".p12", ".pfx"].includes(extension)) {
    return "private key or certificate file";
  }

  return undefined;
}

async function collectIncludedFilesFromRoot(
  projectRoot: string,
  current: string,
  allowNodeModules: boolean,
  files: string[]
) {
  const currentStat = await lstat(current);

  if (currentStat.isSymbolicLink()) {
    throw new Error(`Function includeFiles search root must not be a symlink: ${path.relative(projectRoot, current).split(path.sep).join("/") || "."}.`);
  }

  if (!currentStat.isDirectory()) {
    throw new Error(`Function includeFiles search root must be a directory: ${path.relative(projectRoot, current).split(path.sep).join("/") || "."}.`);
  }

  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".siteflow" || (!allowNodeModules && entry.name === "node_modules")) {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join("/");

    if (entry.isSymbolicLink()) {
      throw new Error(`Function includeFiles entry must not be a symlink: ${relativePath}.`);
    }

    if (entry.isDirectory()) {
      await collectIncludedFilesFromRoot(projectRoot, fullPath, allowNodeModules, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(relativePath);
  }
}

async function collectFunctionIncludeFiles(
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  occupiedArtifactPaths: Set<string>
) {
  if (includePatterns.length === 0) {
    return [];
  }

  const matchers = includePatterns.map((pattern) => ({
    pattern,
    regex: globToRegExp(pattern)
  }));
  const excludeMatchers = excludePatterns.map((pattern) => ({
    pattern,
    regex: globToRegExp(pattern)
  }));
  const candidateFiles = new Set<string>();
  const searchPrefixes = new Set(includePatterns.map(globStaticPrefix));

  for (const prefix of searchPrefixes) {
    const searchRoot = resolveProjectFile(projectRoot, prefix);
    const searchStat = await lstat(searchRoot).catch(() => undefined);

    if (!searchStat) {
      continue;
    }

    if (searchStat.isSymbolicLink()) {
      throw new Error(`Function includeFiles entry must not be a symlink: ${prefix || "."}.`);
    }

    if (searchStat.isFile()) {
      candidateFiles.add(prefix);
      continue;
    }

    if (searchStat.isDirectory()) {
      const files: string[] = [];
      await collectIncludedFilesFromRoot(projectRoot, searchRoot, prefix.startsWith("node_modules"), files);
      files.forEach((file) => candidateFiles.add(file));
    }
  }

  const extraFiles: ArtifactExtraFileInput[] = [];

  for (const relativePath of [...candidateFiles].sort((left, right) => left.localeCompare(right))) {
    if (!matchers.some((matcher) => matcher.regex.test(relativePath))) {
      continue;
    }

    if (excludeMatchers.some((matcher) => matcher.regex.test(relativePath))) {
      continue;
    }

    const deniedReason = functionIncludeFileDenyReason(relativePath);

    if (deniedReason) {
      throw new Error(`Function includeFiles entry is blocked because it looks like a ${deniedReason}: ${relativePath}.`);
    }

    const artifactPath = `.siteflow/functions/${relativePath}`;

    if (occupiedArtifactPaths.has(artifactPath)) {
      continue;
    }

    const sourcePath = resolveProjectFile(projectRoot, relativePath);
    const sourceStat = await lstat(sourcePath);

    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`Function includeFiles entry must be a regular file: ${relativePath}.`);
    }

    extraFiles.push({
      artifactPath,
      contents: await readFile(sourcePath)
    });
    occupiedArtifactPaths.add(artifactPath);
  }

  return extraFiles;
}

async function collectFunctionEntrypoints(
  projectRootRealPath: string,
  apiRoot: string,
  current: string,
  entries: FunctionArtifactInput[]
) {
  const children = await readdir(current, { withFileTypes: true });

  for (const child of children) {
    const fullPath = path.join(current, child.name);
    const relativePath = path.relative(apiRoot, fullPath).split(path.sep).join("/");

    if (child.isSymbolicLink()) {
      throw new Error(`Function source entry must not be a symlink: api/${relativePath}.`);
    }

    if (child.isDirectory()) {
      await collectFunctionEntrypoints(projectRootRealPath, apiRoot, fullPath, entries);
      continue;
    }

    if (!child.isFile() || !/\.(?:cjs|mjs|js)$/i.test(child.name)) {
      continue;
    }

    const sourceRealPath = await realpath(fullPath);

    if (!pathStaysInside(projectRootRealPath, sourceRealPath)) {
      throw new Error(`Function source entry escapes the project root: api/${relativePath}.`);
    }

    const source = await readFile(fullPath, "utf8");

    entries.push({
      path: functionRoutePath(relativePath),
      sourcePath: fullPath,
      artifactPath: `.siteflow/functions/api/${relativePath}`,
      runtime: "nodejs20.x",
      handler: "default",
      apiStyle: nodeApiStyleSniff(source) ? "node" : undefined
    });
  }
}

async function detectFunctionEntrypoints(projectRoot: string) {
  const apiRoot = path.resolve(projectRoot, "api");
  const apiRootStat = await lstat(apiRoot).catch(() => undefined);

  if (!apiRootStat) {
    return [];
  }

  if (apiRootStat.isSymbolicLink()) {
    throw new Error("Function api directory must not be a symlink: api.");
  }

  if (!apiRootStat.isDirectory()) {
    throw new Error("Function api path must be a directory: api.");
  }

  const projectRootRealPath = await realpath(projectRoot);
  const apiRootRealPath = await realpath(apiRoot);

  if (!pathStaysInside(projectRootRealPath, apiRootRealPath)) {
    throw new Error("Function api directory escapes the project root: api.");
  }

  const entries: FunctionArtifactInput[] = [];
  await collectFunctionEntrypoints(projectRootRealPath, apiRoot, apiRoot, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function functionBundleExtraFiles(
  projectRoot: string,
  functions: FunctionArtifactInput[],
  configs: SourceFunctionConfig[] | undefined
): Promise<ArtifactExtraFileInput[]> {
  const extraFiles: ArtifactExtraFileInput[] = [];
  const occupiedArtifactPaths = new Set(functions.map((entry) => entry.artifactPath));

  if (!functions.some((entry) => entry.artifactPath.endsWith(".js"))) {
    return extraFiles;
  }

  const packageJsonPath = path.resolve(projectRoot, "package.json");
  const packageJson = await readFile(packageJsonPath, "utf8").catch(() => undefined);

  if (packageJson) {
    const parsed = JSON.parse(packageJson) as { type?: unknown };

    if (parsed.type === "module") {
      const artifactPath = ".siteflow/functions/package.json";
      extraFiles.push({
        artifactPath,
        contents: JSON.stringify({ type: "module" })
      });
      occupiedArtifactPaths.add(artifactPath);
    }
  }

  const matchedConfigs = (configs ?? [])
    .filter((config) => functions.some((entry) => functionConfigPatternMatches(entry.path, functionArtifactSourcePath(entry), config.pattern)));
  const includePatterns = matchedConfigs.flatMap((config) => config.includeFiles ?? []);
  const excludePatterns = matchedConfigs.flatMap((config) => config.excludeFiles ?? []);

  extraFiles.push(...await collectFunctionIncludeFiles(projectRoot, includePatterns, excludePatterns, occupiedArtifactPaths));
  return extraFiles;
}

export async function executeBuildJob(job: QueuedBuildJob, options: BuildExecutionOptions): Promise<BuildJobResult> {
  if (shouldRejectUnsandboxedSourceBuild(options)) {
    await options.appendLog?.(redactLogLine(unsafeSourceBuildGuardMessage));
    throw new BuildSkippedError(unsafeSourceBuildGuardMessage);
  }

  const createdWorkspaceRoot = options.workspaceRoot === undefined;
  const workspaceRoot = path.resolve(options.workspaceRoot ?? await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-")));
  let checkout: SourceCheckout | undefined;

  try {
    await mkdir(workspaceRoot, { recursive: true });
    await assertBuildStoragePreflight({
      workspaceRoot,
      artifactRoot: options.artifactRoot,
      minFreeBytes: options.minBuildFreeBytes
    });
    checkout = await options.sourceResolver.checkout(job, workspaceRoot);
    const sourceDirectory = path.resolve(checkout.sourceDirectory);
    const buildSettings = await detectBuildSettings(sourceDirectory, job.buildSettings);
    const projectRoot = resolveProjectRoot(sourceDirectory, buildSettings.rootDirectory);
    const sourceConfig = await readSourceVercelConfig(projectRoot);
    const buildEnvironmentVariables = {
      ...(sourceConfig.buildEnv ?? {}),
      ...(job.environmentVariables ?? {})
    };
    const releaseChannel = routeChannelFor(job.sourceEvent, job.productionBranch ?? job.repository.defaultBranch);
    assertNetworkedDockerBuildEnvAllowed(options, buildEnvironmentVariables);
    const appendLog = async (line: string) => {
      await options.appendLog?.(line);
    };
    const secretPatterns = redactionPatternsFor(buildEnvironmentVariables);
    const runBuildStep = (command: string) =>
      runBuildCommand(command, {
        cwd: projectRoot,
        appendLog,
        environmentVariables: buildEnvironmentVariables,
        secretPatterns,
        runner: options.buildRunner,
        docker: options.dockerBuild,
        timeoutMs: options.buildStepTimeoutMs
      });

    await appendLog(`SiteFlow worker picked build ${job.id}.`);
    await appendLog(`Resolved build settings: framework=${buildSettings.framework ?? "unknown"}, output=${buildSettings.outputDirectory}.`);

    if (!gitDeploymentEnabled(sourceConfig.gitDeployment, job.sourceEvent.branch)) {
      throw new BuildSkippedError(`Build skipped by git.deploymentEnabled for branch ${job.sourceEvent.branch}.`);
    }

    if (buildSettings.ignoreCommand) {
      const ignore = await runBuildStep(buildSettings.ignoreCommand);

      if (ignore.exitCode === 0) {
        throw new BuildSkippedError(`Build skipped by ignoreCommand: ${buildSettings.ignoreCommand}.`);
      }

      await appendLog(`ignoreCommand exited with code ${ignore.exitCode}; continuing build.`);
    }

    const install = await runBuildStep(buildSettings.installCommand);

    if (install.exitCode !== 0) {
      throw new Error(`Install command exited with code ${install.exitCode}.`);
    }

    const build = await runBuildStep(buildSettings.buildCommand);

    if (build.exitCode !== 0) {
      throw new Error(`Build command exited with code ${build.exitCode}.`);
    }

    const functions = applyFunctionConfig(await detectFunctionEntrypoints(projectRoot), sourceConfig);
    const extraFiles = await functionBundleExtraFiles(projectRoot, functions, sourceConfig.functions);
    const routingMetadata = {
      ...(sourceConfig.cleanUrls !== undefined ? { cleanUrls: sourceConfig.cleanUrls } : {}),
      ...(sourceConfig.trailingSlash !== undefined ? { trailingSlash: sourceConfig.trailingSlash } : {}),
      ...(sourceConfig.skipTrailingSlashRedirect !== undefined ? { skipTrailingSlashRedirect: sourceConfig.skipTrailingSlashRedirect } : {}),
      ...(sourceConfig.redirects?.length ? { redirects: sourceConfig.redirects } : {}),
      ...(sourceConfig.rewrites?.length ? { rewrites: sourceConfig.rewrites } : {}),
      ...(sourceConfig.headers?.length ? { headers: sourceConfig.headers } : {})
    };

    if (functions.length > 0) {
      await appendLog(`Detected ${functions.length} Node.js function${functions.length === 1 ? "" : "s"}.`);
    }

    const artifact = await publishBuildArtifact({
      buildJobId: job.id,
      sourceEventId: job.sourceEventId,
      outputDirectory: await resolveOutputDirectory(projectRoot, buildSettings.outputDirectory),
      artifactRoot: options.artifactRoot,
      entrypoint: options.entrypoint,
      functions,
      extraFiles,
      clientEnvironmentVariables: clientBuildEnvVariables(buildEnvironmentVariables),
      maxArtifactBytes: options.maxArtifactBytes,
      maxArtifactFiles: options.maxArtifactFiles,
      blockedContentValues: blockedArtifactContentValues(buildEnvironmentVariables),
      metadata: {
        framework: buildSettings.framework ?? job.repository.provider,
        repository: `${job.repository.owner}/${job.repository.name}`,
        branch: job.sourceEvent.branch,
        commitSha: job.sourceEvent.commitSha,
        environment: releaseChannel,
        ...(sourceConfig.public !== undefined ? { public: sourceConfig.public } : {}),
        ...(sourceConfig.fluid !== undefined ? { fluid: sourceConfig.fluid } : {}),
        ...(sourceConfig.bunVersion !== undefined ? { bunVersion: sourceConfig.bunVersion } : {}),
        ...(sourceConfig.buildEnv ? { buildEnvKeys: buildEnvKeys(sourceConfig.buildEnv) } : {}),
        ...(sourceConfig.runtimeEnv ? { runtimeEnvKeys: buildEnvKeys(sourceConfig.runtimeEnv) } : {}),
        ...(sourceConfig.runtimeEnv ? { sealedRuntimeEnv: sealedRuntimeEnv(sourceConfig.runtimeEnv) } : {}),
        ...(sourceConfig.images !== undefined ? { images: sourceConfig.images } : {}),
        routing: routingMetadata
      }
    });
    const previewHost = previewHostFor(job, artifact.deploymentId, options.baseDomain);
    const productionHost = releaseChannel === "production" && job.projectSlug ? `${job.projectSlug}.${options.baseDomain}` : undefined;

    await appendLog(`Artifact published as ${artifact.deploymentId}.`);

    return {
      job,
      deploymentId: artifact.deploymentId,
      previewHost,
      previewUrl: `${options.publicScheme ?? "https"}://${previewHost}`,
      productionHost,
      artifact,
      crons: sourceConfig.crons
    };
  } finally {
    try {
      await checkout?.cleanup?.();
    } finally {
      if (createdWorkspaceRoot) {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }
  }
}

export async function runBuildWorkerOnce(options: BuildWorkerOptions): Promise<BuildJobResult | undefined> {
  const job = await options.queue.claimNextJob(options.workerId);

  if (!job) {
    return undefined;
  }

  if (shouldRejectUnsandboxedSourceBuild(options)) {
    await options.queue.appendLog(job.id, redactLogLine(unsafeSourceBuildGuardMessage));
    await options.queue.skipJob(job, unsafeSourceBuildGuardMessage);
    return undefined;
  }

  const heartbeatIntervalMs = positiveHeartbeatIntervalMs(options.jobHeartbeatIntervalMs);
  const heartbeatTimer = options.queue.heartbeatJob
    ? setInterval(() => {
      void options.queue.heartbeatJob?.(job).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : "Build job heartbeat failed.";
        await options.queue.appendLog(job.id, redactLogLine(`Build job heartbeat failed: ${message}`));
      });
    }, heartbeatIntervalMs)
    : undefined;

  heartbeatTimer?.unref?.();

  try {
    const result = await executeBuildJob(job, {
      sourceResolver: options.sourceResolver,
      workspaceRoot: options.workspaceRoot,
      artifactRoot: options.artifactRoot,
      baseDomain: options.baseDomain,
      publicScheme: options.publicScheme,
      entrypoint: options.entrypoint,
      allowUnsandboxedSourceBuilds: options.allowUnsandboxedSourceBuilds,
      buildRunner: options.buildRunner,
      dockerBuild: options.dockerBuild,
      buildStepTimeoutMs: options.buildStepTimeoutMs,
      maxArtifactBytes: options.maxArtifactBytes,
      maxArtifactFiles: options.maxArtifactFiles,
      minBuildFreeBytes: options.minBuildFreeBytes,
      appendLog: (line) => options.queue.appendLog(job.id, line)
    });
    await options.queue.completeJob(job, result);
    options.buildEventNotifier?.({ status: "succeeded", job, result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Build worker failed.";
    await options.queue.appendLog(job.id, redactLogLine(message));
    if (error instanceof BuildSkippedError) {
      await options.queue.skipJob(job, message);
      return undefined;
    }
    await options.queue.failJob(job, message);
    options.buildEventNotifier?.({ status: "failed", job, reason: message });
    throw error;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

export async function cleanupWorkspace(pathToRemove: string) {
  await rm(pathToRemove, { recursive: true, force: true });
}
