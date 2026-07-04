#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "../server/migrations.js";
import { GitSourceResolver, shouldUseGitSourceResolver, validateGitCredentialPath } from "./gitSourceResolver.js";
import { LocalSourceResolver } from "./localSourceResolver.js";
import { PostgresBuildQueue } from "./postgresBuildQueue.js";
import { type BuildJobResult, type SourceResolver, runBuildWorkerOnce } from "./buildWorker.js";
import {
  cleanupStaleDockerBuildContainers,
  validateProductionDockerBuildImagePolicy,
  type BuildRunner,
  type DockerBuildRunnerConfig
} from "./buildSandbox.js";
import { isProductionRuntime, requireProductionSecret, resolveSecretEnvValue } from "../src/lib/sealedSecrets.js";
import { createKlaxonBuildNotifier } from "./klaxonNotifier.js";

const defaultPollIntervalMs = 5000;
const defaultBuildStepTimeoutMs = 900_000;
const defaultGitTimeoutMs = 300_000;
const defaultDockerStaleContainerMaxAgeMs = 60 * 60 * 1000;
const defaultMaxArtifactBytes = 512 * 1024 * 1024;
const defaultMaxArtifactFiles = 20_000;
const dockerHealthcheckTimeoutMs = 2000;

export interface WorkerRuntimeConfig {
  databaseUrl: string;
  artifactRoot: string;
  baseDomain: string;
  publicScheme: "http" | "https";
  sourceRoot?: string;
  workerId: string;
  pollIntervalMs: number;
  buildStepTimeoutMs: number;
  gitTimeoutMs: number;
  gitSshKeyPath?: string;
  gitKnownHostsPath?: string;
  runOnce: boolean;
  allowUnsandboxedSourceBuilds: boolean;
  buildRunner: BuildRunner;
  dockerBuild: DockerBuildRunnerConfig;
  maxArtifactBytes: number;
  maxArtifactFiles: number;
  minBuildFreeBytes: number;
}

export interface BuildWorkerLoopOptions {
  processNextJob: () => Promise<BuildJobResult | undefined>;
  pollIntervalMs: number;
  runOnce: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface WorkerRuntimeHealthcheckOptions {
  cwd?: string;
  log?: (message: string) => void;
  checkDockerAccess?: (cwd: string) => Promise<void>;
}

function parsePollIntervalMs(value: string | undefined) {
  if (value === undefined || value.trim() === "") {
    return defaultPollIntervalMs;
  }

  const intervalMs = Number(value);

  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("SITEFLOW_WORKER_POLL_INTERVAL_MS must be a positive integer.");
  }

  return intervalMs;
}

function parsePositiveTimeoutMs(value: string | undefined, defaultValue: number, envName: string) {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const timeoutMs = Number(value);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${envName} must be a positive integer.`);
  }

  return timeoutMs;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number, envName: string) {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${envName} must be a positive integer.`);
  }

  return parsed;
}

function isEnabledFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isDisabledFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function nonEmptyValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function optionalConfiguredValue(value: string | undefined) {
  return value === undefined || value === "" ? undefined : value;
}

function parseBuildRunner(value: string | undefined, production: boolean): BuildRunner {
  const normalized = nonEmptyValue(value)?.toLowerCase();

  if (normalized === undefined) {
    return production ? "docker" : "host";
  }

  if (normalized === "host" || normalized === "docker") {
    return normalized;
  }

  throw new Error("SITEFLOW_BUILD_RUNNER must be either host or docker.");
}

function parseBuildNetwork(value: string | undefined): DockerBuildRunnerConfig["network"] {
  const normalized = nonEmptyValue(value)?.toLowerCase();

  if (normalized === undefined) {
    return "none";
  }

  if (normalized === "none" || normalized === "bridge") {
    return normalized;
  }

  throw new Error("SITEFLOW_BUILD_NETWORK must be either none or bridge.");
}

function parseBuildMemory(value: string | undefined) {
  const normalized = nonEmptyValue(value);

  if (normalized === undefined) {
    return undefined;
  }

  if (!/^[1-9]\d*(?:[bkmg])?$/i.test(normalized)) {
    throw new Error("SITEFLOW_BUILD_MEMORY must be a positive Docker memory value such as 512m or 1g.");
  }

  return normalized;
}

function parseBuildCpus(value: string | undefined) {
  const normalized = nonEmptyValue(value);

  if (normalized === undefined) {
    return undefined;
  }

  const cpus = Number(normalized);

  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error("SITEFLOW_BUILD_CPUS must be a positive number.");
  }

  return normalized;
}

function parseBuildPidsLimit(value: string | undefined) {
  const normalized = nonEmptyValue(value);

  if (normalized === undefined) {
    return undefined;
  }

  const pidsLimit = Number(normalized);

  if (!Number.isInteger(pidsLimit) || pidsLimit < 1) {
    throw new Error("SITEFLOW_BUILD_PIDS_LIMIT must be a positive integer.");
  }

  return pidsLimit;
}

function parseBuildUser(value: string | undefined) {
  const normalized = nonEmptyValue(value);

  if (normalized === undefined) {
    return undefined;
  }

  if (!/^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    throw new Error("SITEFLOW_BUILD_USER must be a Docker user name, uid, or uid:gid without whitespace.");
  }

  return normalized;
}

function parseBuildImageAllowlist(value: string | undefined) {
  const normalized = nonEmptyValue(value);

  if (normalized === undefined) {
    return undefined;
  }

  const entries = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0 || entries.some((entry) => entry.startsWith("-") || /\s/.test(entry))) {
    throw new Error("SITEFLOW_BUILD_IMAGE_ALLOWLIST must contain comma-separated Docker image references or prefix* entries.");
  }

  return entries;
}

function parseDockerCleanupStaleContainers(value: string | undefined) {
  return !isDisabledFlag(value);
}

function parseDockerBuildConfig(env: NodeJS.ProcessEnv): DockerBuildRunnerConfig {
  return {
    image: nonEmptyValue(env.SITEFLOW_BUILD_IMAGE),
    imageAllowlist: parseBuildImageAllowlist(env.SITEFLOW_BUILD_IMAGE_ALLOWLIST),
    imageTaggedTrustedExceptionAccepted: isEnabledFlag(env.SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE),
    network: parseBuildNetwork(env.SITEFLOW_BUILD_NETWORK),
    memory: parseBuildMemory(env.SITEFLOW_BUILD_MEMORY),
    cpus: parseBuildCpus(env.SITEFLOW_BUILD_CPUS),
    pidsLimit: parseBuildPidsLimit(env.SITEFLOW_BUILD_PIDS_LIMIT),
    user: parseBuildUser(env.SITEFLOW_BUILD_USER),
    cleanupStaleContainers: parseDockerCleanupStaleContainers(env.SITEFLOW_DOCKER_CLEANUP_STALE_CONTAINERS),
    staleContainerMaxAgeMs: parsePositiveTimeoutMs(
      env.SITEFLOW_DOCKER_STALE_CONTAINER_MAX_AGE_MS,
      defaultDockerStaleContainerMaxAgeMs,
      "SITEFLOW_DOCKER_STALE_CONTAINER_MAX_AGE_MS"
    )
  };
}

function parseGitCredentialConfig(env: NodeJS.ProcessEnv) {
  const gitSshKeyPath = optionalConfiguredValue(env.SITEFLOW_GIT_SSH_KEY_PATH);
  const gitKnownHostsPath = optionalConfiguredValue(env.SITEFLOW_GIT_KNOWN_HOSTS_PATH);

  if (gitKnownHostsPath && !gitSshKeyPath) {
    throw new Error("SITEFLOW_GIT_KNOWN_HOSTS_PATH requires SITEFLOW_GIT_SSH_KEY_PATH.");
  }

  return {
    gitSshKeyPath: gitSshKeyPath
      ? validateGitCredentialPath(gitSshKeyPath, "SITEFLOW_GIT_SSH_KEY_PATH")
      : undefined,
    gitKnownHostsPath: gitKnownHostsPath
      ? validateGitCredentialPath(gitKnownHostsPath, "SITEFLOW_GIT_KNOWN_HOSTS_PATH")
      : undefined
  };
}

function allowUnsandboxedSourceBuilds(env: NodeJS.ProcessEnv) {
  if (!isProductionRuntime(env)) {
    return true;
  }

  return isEnabledFlag(env.SITEFLOW_ALLOW_UNSANDBOXED_BUILDS) || isEnabledFlag(env.SITEFLOW_TRUSTED_SOURCE_BUILDS);
}

function resolveDatabaseUrl(env: NodeJS.ProcessEnv) {
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

export function requireWorkerProductionSecret(env: NodeJS.ProcessEnv = process.env) {
  if (isProductionRuntime(env)) {
    requireProductionSecret(env);
  }
}

export function parseWorkerRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeConfig {
  const databaseUrl = resolveDatabaseUrl(env);
  const baseDomain = env.SITEFLOW_BASE_DOMAIN;
  const production = isProductionRuntime(env);
  const gitCredentials = parseGitCredentialConfig(env);
  const buildRunner = parseBuildRunner(env.SITEFLOW_BUILD_RUNNER, production);
  const dockerBuild = parseDockerBuildConfig(env);
  const maxArtifactBytes = parsePositiveInteger(
    env.SITEFLOW_BUILD_MAX_ARTIFACT_BYTES,
    defaultMaxArtifactBytes,
    "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES"
  );
  const maxArtifactFiles = parsePositiveInteger(
    env.SITEFLOW_BUILD_MAX_ARTIFACT_FILES,
    defaultMaxArtifactFiles,
    "SITEFLOW_BUILD_MAX_ARTIFACT_FILES"
  );

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the SiteFlow build worker.");
  }

  if (!baseDomain) {
    throw new Error("SITEFLOW_BASE_DOMAIN is required to publish preview build routes.");
  }

  if (production && buildRunner === "docker") {
    validateProductionDockerBuildImagePolicy(dockerBuild);
  }

  return {
    databaseUrl,
    artifactRoot: env.SITEFLOW_ARTIFACT_ROOT ?? "/var/lib/siteflow/artifacts",
    baseDomain,
    publicScheme: env.SITEFLOW_PUBLIC_SCHEME === "http" ? "http" : "https",
    sourceRoot: env.SITEFLOW_SOURCE_ROOT,
    workerId: env.SITEFLOW_WORKER_ID ?? `worker-${process.pid}`,
    pollIntervalMs: parsePollIntervalMs(env.SITEFLOW_WORKER_POLL_INTERVAL_MS),
    buildStepTimeoutMs: parsePositiveTimeoutMs(
      env.SITEFLOW_BUILD_STEP_TIMEOUT_MS,
      defaultBuildStepTimeoutMs,
      "SITEFLOW_BUILD_STEP_TIMEOUT_MS"
    ),
    gitTimeoutMs: parsePositiveTimeoutMs(env.SITEFLOW_GIT_TIMEOUT_MS, defaultGitTimeoutMs, "SITEFLOW_GIT_TIMEOUT_MS"),
    maxArtifactBytes,
    maxArtifactFiles,
    minBuildFreeBytes: parsePositiveInteger(
      env.SITEFLOW_BUILD_MIN_FREE_BYTES,
      maxArtifactBytes * 2,
      "SITEFLOW_BUILD_MIN_FREE_BYTES"
    ),
    ...gitCredentials,
    runOnce: env.SITEFLOW_WORKER_RUN_ONCE === "1",
    allowUnsandboxedSourceBuilds: allowUnsandboxedSourceBuilds(env),
    buildRunner,
    dockerBuild
  };
}

function waitForPollInterval(intervalMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    };

    timeout = setTimeout(done, intervalMs);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runBuildWorkerLoop(options: BuildWorkerLoopOptions): Promise<void> {
  const log = options.log ?? ((message: string) => process.stdout.write(message));

  while (!options.signal?.aborted) {
    try {
      const result = await options.processNextJob();

      if (result) {
        log(`SiteFlow build completed: ${result.previewUrl}\n`);
      } else {
        log("SiteFlow build worker found no queued jobs.\n");
      }
    } catch (error) {
      if (options.runOnce) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Build worker failed.";
      log(`SiteFlow build worker error: ${message}\n`);
    }

    if (options.runOnce || options.signal?.aborted) {
      break;
    }

    await waitForPollInterval(options.pollIntervalMs, options.signal);
  }
}

export function createWorkerSourceResolver(
  sourceRoot?: string,
  gitTimeoutMs?: number,
  gitCredentials: { gitSshKeyPath?: string; gitKnownHostsPath?: string } = {}
): SourceResolver {
  const localSourceResolver = new LocalSourceResolver({ sourceRoot });
  const gitSourceResolver = new GitSourceResolver({
    commandTimeoutMs: gitTimeoutMs,
    sshKeyPath: gitCredentials.gitSshKeyPath,
    knownHostsPath: gitCredentials.gitKnownHostsPath
  });

  return {
    checkout: (job, workspaceRoot) =>
      shouldUseGitSourceResolver(job)
        ? gitSourceResolver.checkout(job, workspaceRoot)
        : localSourceResolver.checkout(job, workspaceRoot)
  };
}

function installShutdownHandlers(controller: AbortController, log: (message: string) => void) {
  const shutdown = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted) {
      log(`SiteFlow build worker received ${signal}; shutting down after the current job.\n`);
      controller.abort();
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}

function checkDockerDaemonAccess(cwd: string) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn("docker", ["info"], {
      cwd,
      shell: false,
      stdio: "ignore"
    });
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("SiteFlow worker healthcheck timed out while checking Docker daemon access."));
    }, dockerHealthcheckTimeoutMs);

    timer.unref?.();
    child.on("error", (error) =>
      finish(new Error(`SiteFlow worker healthcheck could not run docker info: ${error.message}`))
    );
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        finish();
        return;
      }

      finish(new Error("SiteFlow worker healthcheck requires access to the trusted Docker socket."));
    });
  });
}

export async function runWorkerRuntimeHealthcheck(
  env: NodeJS.ProcessEnv = process.env,
  options: WorkerRuntimeHealthcheckOptions = {}
): Promise<void> {
  const config = parseWorkerRuntimeConfig(env);

  requireWorkerProductionSecret(env);

  if (config.buildRunner === "docker") {
    await (options.checkDockerAccess ?? checkDockerDaemonAccess)(options.cwd ?? process.cwd());
  }

  options.log?.(`SiteFlow build worker healthcheck passed: ${config.workerId} (${config.buildRunner}).\n`);
}

export async function startSiteFlowBuildWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseWorkerRuntimeConfig(env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const controller = new AbortController();
  const log = (message: string) => process.stdout.write(message);
  const removeShutdownHandlers = installShutdownHandlers(controller, log);
  // HOLDFAST Klaxon build notifications: enabled only when KLAXON_NOTIFY_URL +
  // KLAXON_INGEST_TOKEN are both set; fire-and-forget, never blocks the build.
  const buildEventNotifier = createKlaxonBuildNotifier(env);

  if (buildEventNotifier) {
    log("SiteFlow build worker notifications: Klaxon enabled.\n");
  }

  try {
    requireWorkerProductionSecret(env);

    if (config.buildRunner === "docker" && config.dockerBuild.cleanupStaleContainers) {
      await cleanupStaleDockerBuildContainers({
        cwd: process.cwd(),
        maxAgeMs: config.dockerBuild.staleContainerMaxAgeMs,
        log
      });
    }

    await runMigrations(pool);
    log(
      config.runOnce
        ? `SiteFlow build worker started: ${config.workerId} (run-once).\n`
        : `SiteFlow build worker started: ${config.workerId} (polling every ${config.pollIntervalMs}ms).\n`
    );

    await runBuildWorkerLoop({
      runOnce: config.runOnce,
      pollIntervalMs: config.pollIntervalMs,
      signal: controller.signal,
      processNextJob: () =>
        runBuildWorkerOnce({
          workerId: config.workerId,
          queue: new PostgresBuildQueue(pool),
          sourceResolver: createWorkerSourceResolver(config.sourceRoot, config.gitTimeoutMs, {
            gitSshKeyPath: config.gitSshKeyPath,
            gitKnownHostsPath: config.gitKnownHostsPath
          }),
          artifactRoot: config.artifactRoot,
          baseDomain: config.baseDomain,
          publicScheme: config.publicScheme,
          allowUnsandboxedSourceBuilds: config.allowUnsandboxedSourceBuilds,
          buildRunner: config.buildRunner,
          dockerBuild: config.dockerBuild,
          buildStepTimeoutMs: config.buildStepTimeoutMs,
          maxArtifactBytes: config.maxArtifactBytes,
          maxArtifactFiles: config.maxArtifactFiles,
          minBuildFreeBytes: config.minBuildFreeBytes,
          buildEventNotifier
        })
    });
  } finally {
    removeShutdownHandlers();
    await pool.end();
  }
}

export function isWorkerEntrypoint(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  return Boolean(argvPath) && path.resolve(fileURLToPath(metaUrl)) === path.resolve(argvPath);
}

if (isWorkerEntrypoint()) {
  const run = process.argv.includes("--healthcheck") || isEnabledFlag(process.env.SITEFLOW_WORKER_HEALTHCHECK)
    ? runWorkerRuntimeHealthcheck()
    : startSiteFlowBuildWorker();

  run.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "SiteFlow build worker failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
