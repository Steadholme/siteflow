import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactLogLine } from "../src/lib/redaction.js";

export type BuildRunner = "host" | "docker";

export interface DockerBuildRunnerConfig {
  image?: string;
  imageAllowlist?: string[];
  imageTaggedTrustedExceptionAccepted?: boolean;
  network?: "none" | "bridge";
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  user?: string;
  cleanupStaleContainers?: boolean;
  staleContainerMaxAgeMs?: number;
  cleanupCommandTimeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
}

export interface RunBuildCommandOptions {
  cwd: string;
  appendLog: (line: string) => Promise<void>;
  environmentVariables?: Record<string, string>;
  secretPatterns?: RegExp[];
  runner?: BuildRunner;
  docker?: DockerBuildRunnerConfig;
  timeoutMs?: number;
}

interface CommandInvocation {
  command: string;
  args: string[];
}

const allowedCommands = new Set(["npm ci", "npm install", "npm run build", "npm test", "npm run test"]);
const dockerWorkdir = "/workspace";
const defaultDockerImage = "node:20-bookworm-slim";
const defaultDockerMemory = "1g";
const defaultDockerCpus = "2";
const defaultDockerPidsLimit = 256;
const defaultDockerStaleContainerMaxAgeMs = 60 * 60 * 1000;
const dockerManagedLabel = "siteflow.managed=true";
const dockerRoleLabel = "siteflow.role=build-runner";
const dockerCreatedAtLabel = "siteflow.created-at-ms";
const environmentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const dockerCleanupCommandTimeoutMs = 2000;

interface ResolvedDockerRunConfig {
  image: string;
  network: "none" | "bridge";
  memory: string;
  cpus: string;
  pidsLimit: number;
  user: string;
}

function positiveTimeoutMs(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Build command timeout must be a positive number.");
  }

  return Math.ceil(value);
}

function positiveMilliseconds(value: number, name: string) {
  const normalized = Math.ceil(value);

  if (!Number.isFinite(value) || normalized < 1 || normalized > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a finite positive number of milliseconds.`);
  }

  return normalized;
}

function timestampMilliseconds(value: number, name: string) {
  const normalized = Math.trunc(value);

  if (!Number.isFinite(value) || normalized < 0 || normalized > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a finite non-negative timestamp in milliseconds.`);
  }

  return normalized;
}

function npmCommand(parts: string[]): CommandInvocation {
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

export function allowedBuildCommandParts(command: string) {
  const trimmed = command.trim();

  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed.split(/\s+/);
  const normalized = parts.slice(0, Math.min(parts.length, 3)).join(" ");

  if (!allowedCommands.has(normalized)) {
    throw new Error(`Build command is not allowed: ${command}`);
  }

  return parts;
}

function hostCommand(parts: string[]): CommandInvocation {
  if (parts[0] === "npm") {
    return npmCommand(parts);
  }

  return {
    command: parts[0],
    args: parts.slice(1)
  };
}

function buildCommandEnvironment(environmentVariables: Record<string, string> | undefined) {
  return {
    ...(environmentVariables ?? {}),
    CI: environmentVariables?.CI ?? process.env.CI ?? "1"
  };
}

function buildDockerCommandEnvironment(environmentVariables: Record<string, string> | undefined) {
  return {
    HOME: "/tmp/siteflow-home",
    TMPDIR: "/tmp",
    npm_config_cache: "/tmp/siteflow-npm-cache",
    ...buildCommandEnvironment(environmentVariables)
  };
}

function dockerUser() {
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    const uid = process.getuid();
    const gid = process.getgid();

    if (uid > 0) {
      return `${uid}:${gid}`;
    }
  }

  return "1000:1000";
}

export function hasDockerDigest(image: string) {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}

function imageTag(image: string) {
  if (hasDockerDigest(image)) {
    return undefined;
  }

  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");

  if (lastColon <= lastSlash) {
    return undefined;
  }

  return image.slice(lastColon + 1);
}

function validImageName(image: string) {
  const withoutDigest = image.replace(/@sha256:[a-f0-9]{64}$/i, "");
  const tag = imageTag(image);
  const withoutTag = tag ? withoutDigest.slice(0, -(tag.length + 1)) : withoutDigest;

  if (!withoutTag || withoutTag.includes("..") || withoutTag.includes("//")) {
    return false;
  }

  return withoutTag.split("/").every((segment, index) => {
    if (!segment) {
      return false;
    }

    const [host, port] = index === 0 ? segment.split(":", 2) : [segment, undefined];
    const name = port === undefined ? segment : host;

    if (port !== undefined && !/^[1-9]\d*$/.test(port)) {
      return false;
    }

    return /^[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)*$/.test(name);
  });
}

export function dockerImageMatchesAllowlist(image: string, allowlist: string[]) {
  return allowlist.some((entry) => {
    if (entry.endsWith("*")) {
      return image.startsWith(entry.slice(0, -1));
    }

    return image === entry;
  });
}

export function validateDockerImageReference(image: string, allowlist: string[] | undefined) {
  const normalized = image.trim();
  const tag = imageTag(normalized);

  if (
    normalized !== image
    || !normalized
    || normalized.length > 255
    || normalized.startsWith("-")
    || /[\s\x00-\x1f\x7f]/.test(normalized)
    || normalized.includes("://")
    || !validImageName(normalized)
  ) {
    throw new Error("SITEFLOW_BUILD_IMAGE must be a valid Docker image reference.");
  }

  if (!hasDockerDigest(normalized) && tag === undefined) {
    throw new Error("SITEFLOW_BUILD_IMAGE must include an explicit tag or sha256 digest.");
  }

  if (tag?.toLowerCase() === "latest") {
    throw new Error("SITEFLOW_BUILD_IMAGE must not use the mutable latest tag.");
  }

  if (allowlist?.length && !dockerImageMatchesAllowlist(normalized, allowlist)) {
    throw new Error("SITEFLOW_BUILD_IMAGE is not allowed by SITEFLOW_BUILD_IMAGE_ALLOWLIST.");
  }

  return normalized;
}

export function validateProductionDockerBuildImagePolicy(config: DockerBuildRunnerConfig) {
  const image = config.image?.trim();

  if (!image) {
    throw new Error("SITEFLOW_BUILD_IMAGE is required for production Docker source builds.");
  }

  const normalized = validateDockerImageReference(image, config.imageAllowlist);
  const allowlistConfigured = Boolean(config.imageAllowlist?.length);
  const allowedByAllowlist = allowlistConfigured && dockerImageMatchesAllowlist(normalized, config.imageAllowlist!);
  const taggedImageException = config.imageTaggedTrustedExceptionAccepted === true;

  if (!hasDockerDigest(normalized) && !(allowedByAllowlist && taggedImageException)) {
    throw new Error(
      "Production Docker source builds require SITEFLOW_BUILD_IMAGE to be pinned to a sha256 digest. Tagged images require both SITEFLOW_BUILD_IMAGE_ALLOWLIST and SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1."
    );
  }

  return normalized;
}

function dockerProjectRootLabel(projectRoot: string) {
  const digest = createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24);
  return `siteflow.project-root-sha=${digest}`;
}

function dockerContainerLabels(projectRoot: string, nowMs = Date.now()) {
  return [
    dockerManagedLabel,
    dockerRoleLabel,
    `${dockerCreatedAtLabel}=${Math.trunc(nowMs)}`,
    dockerProjectRootLabel(projectRoot)
  ];
}

function dockerWorkspaceMount(projectRoot: string) {
  return [
    "type=bind",
    `source=${projectRoot}`,
    `target=${dockerWorkdir}`,
    "bind-propagation=rprivate"
  ].join(",");
}

function resolvedDockerConfig(config: DockerBuildRunnerConfig | undefined): ResolvedDockerRunConfig {
  const image = config?.image ?? defaultDockerImage;

  return {
    image: validateDockerImageReference(image, config?.imageAllowlist),
    network: config?.network ?? "none",
    memory: config?.memory ?? defaultDockerMemory,
    cpus: config?.cpus ?? defaultDockerCpus,
    pidsLimit: config?.pidsLimit ?? defaultDockerPidsLimit,
    user: config?.user ?? dockerUser()
  };
}

export function buildDockerRunArgs(
  parts: string[],
  projectRoot: string,
  envFilePath: string,
  cidFilePath: string,
  config: DockerBuildRunnerConfig | undefined
) {
  const dockerConfig = resolvedDockerConfig(config);
  const labelArgs = dockerContainerLabels(projectRoot).flatMap((label) => ["--label", label]);

  return [
    "run",
    "--rm",
    "--init",
    "--cidfile",
    cidFilePath,
    ...labelArgs,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs",
    "/home/siteflow:rw,nosuid,nodev,size=64m",
    "--network",
    dockerConfig.network,
    "--memory",
    dockerConfig.memory,
    "--cpus",
    dockerConfig.cpus,
    "--pids-limit",
    String(dockerConfig.pidsLimit),
    "-u",
    dockerConfig.user,
    "--mount",
    dockerWorkspaceMount(projectRoot),
    "-w",
    dockerWorkdir,
    "--env-file",
    envFilePath,
    dockerConfig.image,
    parts[0],
    ...parts.slice(1)
  ];
}

function dockerEnvFileContents(environmentVariables: Record<string, string>) {
  return Object.entries(environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!environmentKeyPattern.test(key)) {
        throw new Error(`Invalid build environment variable name for Docker env-file: ${key}`);
      }

      if (value.includes("\n") || value.includes("\r")) {
        throw new Error(`Build environment variable ${key} contains an unsupported newline for Docker env-file.`);
      }

      return `${key}=${value}`;
    })
    .join("\n");
}

async function withDockerEnvFile<T>(environmentVariables: Record<string, string>, run: (envFilePath: string) => Promise<T>) {
  const contents = `${dockerEnvFileContents(environmentVariables)}\n`;
  const envDirectory = await mkdtemp(path.join(os.tmpdir(), "siteflow-build-env-"));
  const envFilePath = path.join(envDirectory, "build.env");

  try {
    await writeFile(envFilePath, contents, { mode: 0o600 });
    return await run(envFilePath);
  } finally {
    await rm(envDirectory, { recursive: true, force: true });
  }
}

function collectCommandOutput(
  child: ReturnType<typeof spawn>,
  appendLog: (line: string) => Promise<void>,
  secretPatterns: RegExp[],
  timeoutMs: number | undefined,
  onTimeout?: () => Promise<void> | void
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    if (!child.stdout || !child.stderr) {
      reject(new Error("Build command stdio was not available."));
      return;
    }

    let stdoutTail = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const logWrites: Promise<void>[] = [];
    const stdout = child.stdout;
    const stderr = child.stderr;

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

    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        reject(error);
      }
    };

    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        logWrites.push(appendLog(`Build command timed out after ${timeoutMs}ms; terminating process.`));
        logWrites.push(Promise.resolve().then(() => onTimeout?.()));
        child.kill("SIGTERM");

        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          void Promise.all(logWrites)
            .then(() => fail(new Error(`Build command timed out after ${timeoutMs}ms.`)))
            .catch(fail);
        }, 5000);
        killTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", (error) =>
      fail(new Error(redactLogLine(`Build command failed to start: ${error.message}`, { extraPatterns: secretPatterns })))
    );
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      logWrites.push(...[stdoutTail, stderrTail].filter(Boolean).map(flushLine));
      void Promise.all(logWrites)
        .then(() => {
          if (timedOut) {
            reject(new Error(`Build command timed out after ${timeoutMs}ms.`));
            return;
          }

          resolve({ exitCode: exitCode ?? 1 });
        })
        .catch(reject);
    });
  });
}

function runDockerCleanupCommand(args: string[], cwd: string, timeoutMs = dockerCleanupCommandTimeoutMs) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const child = spawn("docker", args, {
      cwd,
      shell: false
    });
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);

    timer.unref?.();
    child.on("error", finish);
    child.on("close", finish);
  });
}

function runDockerOutputCommand(args: string[], cwd: string) {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn("docker", args, {
      cwd,
      shell: false
    });
    let stdout = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (exitCode) => resolve(exitCode === 0 ? stdout : undefined));
  });
}

function staleDockerContainerIds(psOutput: string, maxAgeMs: number, nowMs: number) {
  return psOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [containerId, createdAtValue] = line.split(/\s+/, 2);
      const createdAtMs = Number(createdAtValue);

      if (!containerId || !Number.isFinite(createdAtMs)) {
        return [];
      }

      return nowMs - createdAtMs >= maxAgeMs ? [containerId] : [];
    });
}

export async function cleanupStaleDockerBuildContainers(options: {
  cwd: string;
  maxAgeMs?: number;
  nowMs?: number;
  log?: (message: string) => void;
}) {
  const maxAgeMs = positiveMilliseconds(
    options.maxAgeMs ?? defaultDockerStaleContainerMaxAgeMs,
    "Docker build container cleanup maxAgeMs"
  );
  const nowMs = timestampMilliseconds(
    options.nowMs ?? Date.now(),
    "Docker build container cleanup nowMs"
  );
  const output = await runDockerOutputCommand([
    "ps",
    "-a",
    "--filter",
    `label=${dockerManagedLabel}`,
    "--filter",
    `label=${dockerRoleLabel}`,
    "--format",
    `{{.ID}} {{.Label "${dockerCreatedAtLabel}"}}`
  ], options.cwd);

  if (output === undefined) {
    options.log?.("SiteFlow Docker build container cleanup skipped; Docker daemon is unavailable.\n");
    return;
  }

  const containerIds = staleDockerContainerIds(output, maxAgeMs, nowMs);

  for (const containerId of containerIds) {
    await runDockerCleanupCommand(["rm", "-f", containerId], options.cwd);
  }

  if (containerIds.length > 0) {
    options.log?.(`SiteFlow Docker build container cleanup removed ${containerIds.length} stale container(s).\n`);
  }
}

async function cleanupTimedOutDockerContainer(cidFilePath: string, cwd: string, cleanupCommandTimeoutMs?: number) {
  const containerId = (await readFile(cidFilePath, "utf8").catch(() => "")).trim();

  if (!containerId) {
    return;
  }

  await runDockerCleanupCommand(["kill", containerId], cwd, cleanupCommandTimeoutMs);
  await runDockerCleanupCommand(["rm", "-f", containerId], cwd, cleanupCommandTimeoutMs);
}

function runHostCommand(
  parts: string[],
  cwd: string,
  appendLog: (line: string) => Promise<void>,
  environmentVariables: Record<string, string> | undefined,
  secretPatterns: RegExp[],
  timeoutMs: number | undefined
) {
  const invocation = hostCommand(parts);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    env: {
      ...process.env,
      ...buildCommandEnvironment(environmentVariables)
    }
  });

  return collectCommandOutput(child, appendLog, secretPatterns, timeoutMs);
}

async function runDockerCommand(
  parts: string[],
  cwd: string,
  appendLog: (line: string) => Promise<void>,
  environmentVariables: Record<string, string> | undefined,
  secretPatterns: RegExp[],
  config: DockerBuildRunnerConfig | undefined,
  timeoutMs: number | undefined
) {
  resolvedDockerConfig(config);

  return await withDockerEnvFile(buildDockerCommandEnvironment(environmentVariables), async (envFilePath) => {
    const cidFilePath = path.join(path.dirname(envFilePath), "container.cid");
    const child = spawn("docker", buildDockerRunArgs(parts, cwd, envFilePath, cidFilePath, config), {
      cwd,
      shell: false
    });

    return await collectCommandOutput(
      child,
      appendLog,
      secretPatterns,
      timeoutMs,
      () => cleanupTimedOutDockerContainer(cidFilePath, cwd, config?.cleanupCommandTimeoutMs)
    );
  });
}

export async function runBuildCommand(command: string, options: RunBuildCommandOptions): Promise<CommandResult> {
  const parts = allowedBuildCommandParts(command);
  const timeoutMs = positiveTimeoutMs(options.timeoutMs);

  if (!parts) {
    return { exitCode: 0 };
  }

  await options.appendLog(`$ ${command}`);

  if (options.runner === "docker") {
    return await runDockerCommand(
      parts,
      options.cwd,
      options.appendLog,
      options.environmentVariables,
      options.secretPatterns ?? [],
      options.docker,
      timeoutMs
    );
  }

  return await runHostCommand(
    parts,
    options.cwd,
    options.appendLog,
    options.environmentVariables,
    options.secretPatterns ?? [],
    timeoutMs
  );
}
