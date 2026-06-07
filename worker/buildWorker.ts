import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectBuildSettings, ReleaseChannelName, RepositoryBinding, RoutingHeader, SiteFlowId, SourceEvent } from "../src/domain/siteflow.js";
import { redactLogLine } from "../src/lib/redaction.js";
import { sealSecretValue } from "../src/lib/sealedSecrets.js";
import type { PrebuiltImageConfig } from "../src/lib/api/deployContracts.js";
import { publishBuildArtifact, type ArtifactExtraFileInput, type FunctionArtifactInput, type PublishedBuildArtifact } from "./artifactPublisher.js";
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
  artifact: PublishedBuildArtifact;
  crons?: BuildCronJob[];
}

export interface BuildQueue {
  claimNextJob(workerId: string): Promise<QueuedBuildJob | undefined>;
  appendLog(jobId: SiteFlowId, line: string): Promise<void>;
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
}

export interface BuildExecutionOptions {
  sourceResolver: SourceResolver;
  workspaceRoot?: string;
  artifactRoot: string;
  baseDomain: string;
  publicScheme?: "http" | "https";
  entrypoint?: string;
  appendLog?: (line: string) => Promise<void>;
}

interface CommandResult {
  exitCode: number;
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

const allowedCommands = new Set(["npm ci", "npm install", "npm run build", "npm test", "npm run test"]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactionPatternsFor(values: Record<string, string> | undefined) {
  return Object.values(values ?? {})
    .filter((value) => value.length >= 4)
    .map((value) => new RegExp(escapeRegExp(value), "g"));
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

function npmCommand(parts: string[]) {
  if (process.platform !== "win32") {
    return {
      command: "npm",
      args: parts.slice(1)
    };
  }

  const npmCli = process.env.npm_execpath ??
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

  if (existsSync(npmCli)) {
    return {
      command: process.execPath,
      args: [npmCli, ...parts.slice(1)]
    };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npm", ...parts.slice(1)]
  };
}

function commandParts(command: string) {
  const trimmed = command.trim();

  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed.split(/\s+/);
  const normalized = parts.slice(0, Math.min(parts.length, 3)).join(" ");

  if (!allowedCommands.has(normalized)) {
    throw new Error(`Build command is not allowed: ${command}`);
  }

  if (parts[0] === "npm") {
    return npmCommand(parts);
  }

  return {
    command: parts[0],
    args: parts.slice(1)
  };
}

async function runCommand(
  command: string,
  cwd: string,
  appendLog: (line: string) => Promise<void>,
  environmentVariables: Record<string, string> | undefined,
  secretPatterns: RegExp[]
): Promise<CommandResult> {
  const parts = commandParts(command);

  if (!parts) {
    return { exitCode: 0 };
  }

  await appendLog(`$ ${command}`);

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(parts.command, parts.args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        ...(environmentVariables ?? {}),
        CI: environmentVariables?.CI ?? process.env.CI ?? "1"
      }
    });
    let stdoutTail = "";
    let stderrTail = "";
    const logWrites: Promise<void>[] = [];

    const flushLine = async (line: string) => {
      if (line.trim()) {
        await appendLog(redactLogLine(line, { extraPatterns: secretPatterns }));
      }
    };

    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const next = `${stream === "stdout" ? stdoutTail : stderrTail}${chunk.toString("utf8")}`;
      const lines = next.split(/\r?\n/);
      const tail = lines.pop() ?? "";

      if (stream === "stdout") {
        stdoutTail = tail;
      } else {
        stderrTail = tail;
      }

      logWrites.push(...lines.map(flushLine));
    };

    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      logWrites.push(...[stdoutTail, stderrTail].filter(Boolean).map(flushLine));
      void Promise.all(logWrites)
        .then(() => resolve({ exitCode: exitCode ?? 1 }))
        .catch(reject);
    });
  });
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

function resolveOutputDirectory(projectRoot: string, outputDirectory: string) {
  const output = path.resolve(projectRoot, outputDirectory);

  if (output !== projectRoot && !output.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("Build output directory escapes the project root.");
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

function applyFunctionConfig(entries: FunctionArtifactInput[], config: SourceVercelConfig) {
  const configs = config.functions;

  if (!configs?.length) {
    return entries.map((entry) => ({
      ...entry,
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

async function collectIncludedFilesFromRoot(
  projectRoot: string,
  current: string,
  allowNodeModules: boolean,
  files: string[]
) {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".siteflow" || (!allowNodeModules && entry.name === "node_modules")) {
      continue;
    }

    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      await collectIncludedFilesFromRoot(projectRoot, fullPath, allowNodeModules, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(path.relative(projectRoot, fullPath).split(path.sep).join("/"));
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
    const searchStat = await stat(searchRoot).catch(() => undefined);

    if (!searchStat) {
      continue;
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

    const artifactPath = `.siteflow/functions/${relativePath}`;

    if (occupiedArtifactPaths.has(artifactPath)) {
      continue;
    }

    extraFiles.push({
      artifactPath,
      contents: await readFile(resolveProjectFile(projectRoot, relativePath))
    });
    occupiedArtifactPaths.add(artifactPath);
  }

  return extraFiles;
}

async function collectFunctionEntrypoints(apiRoot: string, current: string, entries: FunctionArtifactInput[]) {
  const children = await readdir(current, { withFileTypes: true });

  for (const child of children) {
    const fullPath = path.join(current, child.name);

    if (child.isDirectory()) {
      await collectFunctionEntrypoints(apiRoot, fullPath, entries);
      continue;
    }

    if (!child.isFile() || !/\.(?:cjs|mjs|js)$/i.test(child.name)) {
      continue;
    }

    const relativePath = path.relative(apiRoot, fullPath).split(path.sep).join("/");

    entries.push({
      path: functionRoutePath(relativePath),
      sourcePath: fullPath,
      artifactPath: `.siteflow/functions/api/${relativePath}`,
      runtime: "nodejs20.x",
      handler: "default"
    });
  }
}

async function detectFunctionEntrypoints(projectRoot: string) {
  const apiRoot = path.resolve(projectRoot, "api");

  if (!existsSync(apiRoot)) {
    return [];
  }

  const entries: FunctionArtifactInput[] = [];
  await collectFunctionEntrypoints(apiRoot, apiRoot, entries);
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
  const workspaceRoot = path.resolve(options.workspaceRoot ?? await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-")));
  await mkdir(workspaceRoot, { recursive: true });

  const checkout = await options.sourceResolver.checkout(job, workspaceRoot);
  const sourceDirectory = path.resolve(checkout.sourceDirectory);

  try {
    const buildSettings = await detectBuildSettings(sourceDirectory, job.buildSettings);
    const projectRoot = resolveProjectRoot(sourceDirectory, buildSettings.rootDirectory);
    const sourceConfig = await readSourceVercelConfig(projectRoot);
    const buildEnvironmentVariables = {
      ...(sourceConfig.buildEnv ?? {}),
      ...(job.environmentVariables ?? {})
    };
    const appendLog = async (line: string) => {
      await options.appendLog?.(line);
    };
    const secretPatterns = redactionPatternsFor(buildEnvironmentVariables);

    await appendLog(`SiteFlow worker picked build ${job.id}.`);
    await appendLog(`Resolved build settings: framework=${buildSettings.framework ?? "unknown"}, output=${buildSettings.outputDirectory}.`);

    if (!gitDeploymentEnabled(sourceConfig.gitDeployment, job.sourceEvent.branch)) {
      throw new BuildSkippedError(`Build skipped by git.deploymentEnabled for branch ${job.sourceEvent.branch}.`);
    }

    if (buildSettings.ignoreCommand) {
      const ignore = await runCommand(buildSettings.ignoreCommand, projectRoot, appendLog, buildEnvironmentVariables, secretPatterns);

      if (ignore.exitCode === 0) {
        throw new BuildSkippedError(`Build skipped by ignoreCommand: ${buildSettings.ignoreCommand}.`);
      }

      await appendLog(`ignoreCommand exited with code ${ignore.exitCode}; continuing build.`);
    }

    const install = await runCommand(buildSettings.installCommand, projectRoot, appendLog, buildEnvironmentVariables, secretPatterns);

    if (install.exitCode !== 0) {
      throw new Error(`Install command exited with code ${install.exitCode}.`);
    }

    const build = await runCommand(buildSettings.buildCommand, projectRoot, appendLog, buildEnvironmentVariables, secretPatterns);

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
      outputDirectory: resolveOutputDirectory(projectRoot, buildSettings.outputDirectory),
      artifactRoot: options.artifactRoot,
      entrypoint: options.entrypoint,
      functions,
      extraFiles,
      metadata: {
        framework: buildSettings.framework ?? job.repository.provider,
        repository: `${job.repository.owner}/${job.repository.name}`,
        branch: job.sourceEvent.branch,
        commitSha: job.sourceEvent.commitSha,
        environment: routeChannelFor(job.sourceEvent, job.productionBranch ?? job.repository.defaultBranch),
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

    await appendLog(`Artifact published as ${artifact.deploymentId}.`);

    return {
      job,
      deploymentId: artifact.deploymentId,
      previewHost,
      previewUrl: `${options.publicScheme ?? "https"}://${previewHost}`,
      artifact,
      crons: sourceConfig.crons
    };
  } finally {
    await checkout.cleanup?.();
  }
}

export async function runBuildWorkerOnce(options: BuildWorkerOptions): Promise<BuildJobResult | undefined> {
  const job = await options.queue.claimNextJob(options.workerId);

  if (!job) {
    return undefined;
  }

  try {
    const result = await executeBuildJob(job, {
      sourceResolver: options.sourceResolver,
      workspaceRoot: options.workspaceRoot,
      artifactRoot: options.artifactRoot,
      baseDomain: options.baseDomain,
      publicScheme: options.publicScheme,
      entrypoint: options.entrypoint,
      appendLog: (line) => options.queue.appendLog(job.id, line)
    });
    await options.queue.completeJob(job, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Build worker failed.";
    await options.queue.appendLog(job.id, redactLogLine(message));
    if (error instanceof BuildSkippedError) {
      await options.queue.skipJob(job, message);
      return undefined;
    }
    await options.queue.failJob(job, message);
    throw error;
  }
}

export async function cleanupWorkspace(pathToRemove: string) {
  await rm(pathToRemove, { recursive: true, force: true });
}
