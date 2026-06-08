import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactLogLine } from "../src/lib/redaction.js";
import { type BuildJobResult, type BuildQueue, type QueuedBuildJob, type SourceResolver, runBuildWorkerOnce } from "../worker/buildWorker.js";
import {
  dockerImageMatchesAllowlist,
  hasDockerDigest,
  validateDockerImageReference,
  validateProductionDockerBuildImagePolicy,
  type DockerBuildRunnerConfig
} from "../worker/buildSandbox.js";

type PrerequisiteStatus = "passed" | "failed";
type RehearsalStatus = "blocked" | "dry_run" | "passed" | "failed";
type CommandStdio = "inherit" | "pipe";

export interface CommandRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: CommandStdio;
}

export interface CommandRunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions
) => Promise<CommandRunResult>;

export interface DockerBuildExecutorOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  docker: DockerBuildRunnerConfig;
  buildStepTimeoutMs?: number;
  maxArtifactBytes?: number;
  maxArtifactFiles?: number;
}

export interface DockerBuildExecutorResult {
  deploymentId: string;
  previewUrl: string;
  artifact: {
    entrypoint: string;
    fileCount: number;
    totalBytes: number;
    checksum: string;
  };
  artifactLimits: {
    maxArtifactBytes: number;
    maxArtifactFiles: number;
  };
  logs: string[];
  redactionVerified: boolean;
  sourceFixture: {
    dependencyInstallVerified: boolean;
    dependencyMarker: string;
  };
}

export type DockerBuildExecutor = (
  options: DockerBuildExecutorOptions
) => Promise<DockerBuildExecutorResult>;

export interface DockerBuildRehearsalOptions {
  dryRun?: boolean;
  json?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  buildExecutor?: DockerBuildExecutor;
  now?: () => Date;
  commitRef?: string;
  repo?: string;
  branch?: string;
  buildStepTimeoutMs?: number;
}

export interface PrerequisiteCheck {
  name: string;
  required: true;
  status: PrerequisiteStatus;
  message: string;
}

export interface DockerBuildRehearsalResult {
  name: "siteflow-docker-build-rehearsal";
  status: RehearsalStatus;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  releaseCommit?: string;
  repository?: string;
  branch?: string;
  buildRunner: "docker";
  docker: {
    image: string | null;
    imageDigestPinned: boolean | null;
    imageAllowlistConfigured: boolean;
    imageAllowedByAllowlist: boolean | null;
    imageTaggedTrustedExceptionAccepted: boolean;
    network: "none" | "bridge";
    memory: string;
    cpus: string;
    pidsLimit: number;
    user: string | null;
    dockerVersion: string | null;
    dockerInfoAvailable: boolean;
  };
  prerequisites: PrerequisiteCheck[];
  buildCommands: string[];
  sourceFixture: {
    packageManager: "npm";
    lockfile: "package-lock.json";
    installCommand: "npm ci";
    buildCommand: "npm run build";
    dependencyCount: number;
    lockfilePackageCount: number;
    dependencies: {
      name: string;
      version: string;
      spec: string;
      source: "file";
    }[];
    network: {
      mode: "none" | "bridge";
      egressAllowed: boolean;
      dependencyInstallRequiresNetwork: false;
    };
    dependencyInstallVerified: boolean | null;
  };
  artifactLimits: DockerBuildExecutorResult["artifactLimits"];
  artifact: DockerBuildExecutorResult["artifact"] | null;
  redactionVerified: boolean | null;
  exitCode: number;
  errorMessage?: string;
}

interface ParsedArgs {
  dryRun: boolean;
  json: boolean;
  help: boolean;
  commitRef?: string;
  repo?: string;
  branch?: string;
  buildStepTimeoutMs?: number;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const rehearsalName = "siteflow-docker-build-rehearsal" as const;
const rehearsalSecretValue = "SITEFLOW_DOCKER_REHEARSAL_SECRET_20260607";
const defaultBuildMemory = "1g";
const defaultBuildCpus = "2";
const defaultBuildPidsLimit = 256;
const defaultBuildNetwork = "none";
const defaultBuildStepTimeoutMs = 120_000;
const defaultMaxArtifactBytes = 512 * 1024 * 1024;
const defaultMaxArtifactFiles = 20_000;
const buildCommands = ["npm ci", "npm run build"];
const rehearsalDependencyName = "siteflow-rehearsal-dependency";
const rehearsalDependencyVersion = "1.0.0";
const rehearsalDependencySpec = "file:./fixture-deps/siteflow-rehearsal-dependency";
const rehearsalDependencyMarker = "siteflow-rehearsal-dependency:offline-fixture";
const rehearsalDependencyOutput = `dependency=${rehearsalDependencyMarker}`;
const rehearsalLockfilePackageCount = 3;

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function hasValue(value: string | undefined) {
  return Boolean(value?.trim());
}

function stringValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseAllowlist(value: string | undefined) {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
}

function enabledFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseNetwork(value: string | undefined): "none" | "bridge" {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return defaultBuildNetwork;
  }

  if (normalized === "none" || normalized === "bridge") {
    return normalized;
  }

  throw new Error("SITEFLOW_BUILD_NETWORK must be either none or bridge.");
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string) {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parsePositiveNumberOption(value: string | undefined, label: string) {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.ceil(parsed);
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = stringValue(args[index + 1]);

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function resolveDockerConfig(env: NodeJS.ProcessEnv): DockerBuildRunnerConfig {
  const allowlist = parseAllowlist(env.SITEFLOW_BUILD_IMAGE_ALLOWLIST);
  const image = env.SITEFLOW_BUILD_IMAGE ? validateDockerImageReference(env.SITEFLOW_BUILD_IMAGE, allowlist) : undefined;

  const docker: DockerBuildRunnerConfig = {
    image,
    imageAllowlist: allowlist,
    imageTaggedTrustedExceptionAccepted: enabledFlag(env.SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE),
    network: parseNetwork(env.SITEFLOW_BUILD_NETWORK),
    memory: stringValue(env.SITEFLOW_BUILD_MEMORY) ?? defaultBuildMemory,
    cpus: stringValue(env.SITEFLOW_BUILD_CPUS) ?? defaultBuildCpus,
    pidsLimit: parsePositiveInteger(env.SITEFLOW_BUILD_PIDS_LIMIT, defaultBuildPidsLimit, "SITEFLOW_BUILD_PIDS_LIMIT"),
    user: stringValue(env.SITEFLOW_BUILD_USER)
  };

  if (image) {
    validateProductionDockerBuildImagePolicy(docker);
  }

  return docker;
}

function resolveArtifactLimits(env: NodeJS.ProcessEnv) {
  return {
    maxArtifactBytes: parsePositiveInteger(
      env.SITEFLOW_BUILD_MAX_ARTIFACT_BYTES,
      defaultMaxArtifactBytes,
      "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES"
    ),
    maxArtifactFiles: parsePositiveInteger(
      env.SITEFLOW_BUILD_MAX_ARTIFACT_FILES,
      defaultMaxArtifactFiles,
      "SITEFLOW_BUILD_MAX_ARTIFACT_FILES"
    )
  };
}

export async function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandRunOptions
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    if (options.stdio === "pipe") {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr,
        errorMessage: error.message
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: options.stdio === "pipe" ? stdout : undefined,
        stderr: options.stdio === "pipe" ? stderr : undefined
      });
    });
  });
}

async function dockerPrerequisites(
  runner: CommandRunner,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{
  checks: PrerequisiteCheck[];
  dockerVersion: string | null;
  dockerInfoAvailable: boolean;
}> {
  const checks: PrerequisiteCheck[] = [];

  checks.push({
    name: "SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL",
    required: true,
    status: env.SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL === "1" ? "passed" : "failed",
    message: env.SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL === "1"
      ? "SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL is set to 1."
      : 'SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL must be set to "1" to opt in to the real Docker build rehearsal.'
  });

  checks.push({
    name: "SITEFLOW_BUILD_IMAGE",
    required: true,
    status: hasValue(env.SITEFLOW_BUILD_IMAGE) ? "passed" : "failed",
    message: hasValue(env.SITEFLOW_BUILD_IMAGE)
      ? "SITEFLOW_BUILD_IMAGE is present."
      : "SITEFLOW_BUILD_IMAGE is required so the rehearsal uses the target Docker build image."
  });

  const version = await runner("docker", ["--version"], { cwd, env, stdio: "pipe" });
  const dockerVersion = version.exitCode === 0 ? version.stdout?.trim() || "docker available" : null;

  checks.push({
    name: "docker_cli",
    required: true,
    status: version.exitCode === 0 ? "passed" : "failed",
    message: version.exitCode === 0 ? "Docker CLI is available." : "Docker CLI is required for the Docker build rehearsal."
  });

  const info = await runner("docker", ["info"], { cwd, env, stdio: "pipe" });
  const dockerInfoAvailable = info.exitCode === 0;

  checks.push({
    name: "docker_daemon",
    required: true,
    status: dockerInfoAvailable ? "passed" : "failed",
    message: dockerInfoAvailable ? "Docker daemon is reachable." : "Docker daemon must be reachable for the Docker build rehearsal."
  });

  return {
    checks,
    dockerVersion,
    dockerInfoAvailable
  };
}

function hasBlockingPrerequisite(checks: PrerequisiteCheck[]) {
  return checks.some((check) => check.status === "failed");
}

function releaseIdentityPrerequisite(options: DockerBuildRehearsalOptions): PrerequisiteCheck {
  const missing = [
    ["--commit-ref", options.commitRef],
    ["--repo", options.repo],
    ["--branch", options.branch]
  ].filter(([, value]) => !hasValue(value));

  return {
    name: "release_identity",
    required: true,
    status: missing.length === 0 ? "passed" : "failed",
    message: missing.length === 0
      ? "Release commit, repository, and branch are present."
      : `Docker build rehearsal evidence requires release identity. Missing: ${missing.map(([flag]) => flag).join(", ")}.`
  };
}

function buildNetworkPrerequisite(docker: DockerBuildRunnerConfig): PrerequisiteCheck {
  return {
    name: "SITEFLOW_BUILD_NETWORK",
    required: true,
    status: docker.network === "none" ? "passed" : "failed",
    message: docker.network === "none"
      ? "SITEFLOW_BUILD_NETWORK is none."
      : "SITEFLOW_BUILD_NETWORK must be none for production Docker build rehearsal."
  };
}

function sourceFixtureEvidence(
  docker: DockerBuildRunnerConfig,
  dependencyInstallVerified: boolean | null
): DockerBuildRehearsalResult["sourceFixture"] {
  const networkMode = docker.network ?? defaultBuildNetwork;

  return {
    packageManager: "npm",
    lockfile: "package-lock.json",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    dependencyCount: 1,
    lockfilePackageCount: rehearsalLockfilePackageCount,
    dependencies: [
      {
        name: rehearsalDependencyName,
        version: rehearsalDependencyVersion,
        spec: rehearsalDependencySpec,
        source: "file"
      }
    ],
    network: {
      mode: networkMode,
      egressAllowed: networkMode === "bridge",
      dependencyInstallRequiresNetwork: false
    },
    dependencyInstallVerified
  };
}

function queuedJob(sourceDirectory: string): QueuedBuildJob {
  return {
    id: "build_docker_rehearsal_1",
    projectId: "project_docker_rehearsal",
    projectSlug: "docker-rehearsal",
    productionBranch: "main",
    sourceEventId: "src_docker_rehearsal_1",
    sourceEvent: {
      id: "src_docker_rehearsal_1",
      projectId: "project_docker_rehearsal",
      kind: "push",
      status: "accepted",
      disposition: "build_requested",
      providerDeliveryId: "docker-rehearsal",
      branch: "main",
      commitSha: "docker-rehearsal",
      commitMessage: "Docker build rehearsal",
      commitAuthor: "SiteFlow",
      receivedAt: new Date(0).toISOString(),
      actor: {
        id: "system:docker-rehearsal",
        name: "docker-rehearsal",
        role: "developer"
      }
    },
    repository: {
      provider: "github",
      owner: "siteflow",
      name: "docker-rehearsal",
      defaultBranch: "main",
      providerPayload: {
        localPath: sourceDirectory
      }
    },
    buildSettings: {
      framework: "static",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDirectory: "dist"
    },
    environmentVariables: {
      SITEFLOW_DOCKER_REHEARSAL_SECRET: rehearsalSecretValue
    }
  };
}

class MemoryBuildQueue implements BuildQueue {
  readonly logs: string[] = [];
  completed?: BuildJobResult;
  failed?: string;

  constructor(private job: QueuedBuildJob | undefined) {}

  async claimNextJob(): Promise<QueuedBuildJob | undefined> {
    const next = this.job;
    this.job = undefined;
    return next;
  }

  async appendLog(_jobId: string, line: string): Promise<void> {
    this.logs.push(line);
  }

  async completeJob(_job: QueuedBuildJob, result: BuildJobResult): Promise<void> {
    this.completed = result;
  }

  async skipJob(_job: QueuedBuildJob, reason: string): Promise<void> {
    this.failed = `skipped:${reason}`;
  }

  async failJob(_job: QueuedBuildJob, reason: string): Promise<void> {
    this.failed = reason;
  }
}

class FixedSourceResolver implements SourceResolver {
  constructor(private sourceDirectory: string) {}

  async checkout(): Promise<{ sourceDirectory: string }> {
    return { sourceDirectory: this.sourceDirectory };
  }
}

async function writeRehearsalProject(sourceDirectory: string) {
  const dependencyDirectory = path.join(sourceDirectory, "fixture-deps", rehearsalDependencyName);

  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(dependencyDirectory, { recursive: true });
  await writeFile(
    path.join(dependencyDirectory, "package.json"),
    `${JSON.stringify({
      name: rehearsalDependencyName,
      version: rehearsalDependencyVersion,
      type: "module",
      exports: "./index.mjs"
    }, null, 2)}\n`
  );
  await writeFile(
    path.join(dependencyDirectory, "index.mjs"),
    [
      `export const marker = ${JSON.stringify(rehearsalDependencyMarker)};`,
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(sourceDirectory, "package.json"),
    `${JSON.stringify({
      name: "siteflow-docker-rehearsal",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        build: "node build.mjs"
      },
      dependencies: {
        [rehearsalDependencyName]: rehearsalDependencySpec
      }
    }, null, 2)}\n`
  );
  await writeFile(
    path.join(sourceDirectory, "package-lock.json"),
    `${JSON.stringify({
      name: "siteflow-docker-rehearsal",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "siteflow-docker-rehearsal",
          version: "0.0.0",
          dependencies: {
            [rehearsalDependencyName]: rehearsalDependencySpec
          }
        },
        [`fixture-deps/${rehearsalDependencyName}`]: {
          version: rehearsalDependencyVersion
        },
        [`node_modules/${rehearsalDependencyName}`]: {
          resolved: `fixture-deps/${rehearsalDependencyName}`,
          link: true
        }
      }
    }, null, 2)}\n`
  );
  await writeFile(
    path.join(sourceDirectory, "build.mjs"),
    [
      `import { marker } from '${rehearsalDependencyName}';`,
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "await mkdir('dist', { recursive: true });",
      "console.log(`rehearsal secret=${process.env.SITEFLOW_DOCKER_REHEARSAL_SECRET}`);",
      `console.log(\`${rehearsalDependencyOutput}\`);`,
      `if (marker !== ${JSON.stringify(rehearsalDependencyMarker)}) {`,
      "  throw new Error('Rehearsal dependency marker mismatch.');",
      "}",
      `await writeFile('dist/index.html', '<h1>SiteFlow Docker rehearsal</h1><p>${rehearsalDependencyOutput}</p>');`
    ].join("\n")
  );
}

export const defaultBuildExecutor: DockerBuildExecutor = async (options) => {
  const sourceDirectory = path.join(options.root, "source");
  const workspaceRoot = path.join(options.root, "workspace");
  const artifactRoot = path.join(options.root, "artifacts");

  await writeRehearsalProject(sourceDirectory);

  const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
  const result = await runBuildWorkerOnce({
    workerId: "worker-docker-rehearsal",
    queue,
    sourceResolver: new FixedSourceResolver(sourceDirectory),
    workspaceRoot,
    artifactRoot,
    baseDomain: "siteflow.local",
    publicScheme: "https",
    allowUnsandboxedSourceBuilds: false,
    buildRunner: "docker",
    dockerBuild: options.docker,
    buildStepTimeoutMs: options.buildStepTimeoutMs ?? defaultBuildStepTimeoutMs,
    maxArtifactBytes: options.maxArtifactBytes,
    maxArtifactFiles: options.maxArtifactFiles
  });

  if (!result || queue.failed) {
    throw new Error(queue.failed ?? "Docker build rehearsal did not complete a build job.");
  }

  const logs = queue.logs;
  const joinedLogs = logs.join("\n");
  const redactionVerified = joinedLogs.includes("[REDACTED]") && !joinedLogs.includes(rehearsalSecretValue);
  const indexHtml = await readFile(path.join(result.artifact.artifactRoot, result.artifact.entrypoint), "utf8");

  if (!indexHtml.includes("SiteFlow Docker rehearsal")) {
    throw new Error("Docker build rehearsal artifact entrypoint did not contain the expected output.");
  }

  if (!indexHtml.includes(rehearsalDependencyOutput) || !joinedLogs.includes(rehearsalDependencyOutput)) {
    throw new Error("Docker build rehearsal did not prove dependency installation through the build output.");
  }

  if (!redactionVerified) {
    throw new Error("Docker build rehearsal logs did not redact the injected rehearsal secret.");
  }

  return {
    deploymentId: result.deploymentId,
    previewUrl: result.previewUrl,
    artifact: {
      entrypoint: result.artifact.entrypoint,
      fileCount: result.artifact.fileCount,
      totalBytes: result.artifact.totalBytes,
      checksum: result.artifact.checksum
    },
    artifactLimits: {
      maxArtifactBytes: options.maxArtifactBytes ?? defaultMaxArtifactBytes,
      maxArtifactFiles: options.maxArtifactFiles ?? defaultMaxArtifactFiles
    },
    logs,
    redactionVerified,
    sourceFixture: {
      dependencyInstallVerified: true,
      dependencyMarker: rehearsalDependencyMarker
    }
  };
};

function dockerEvidence(
  docker: DockerBuildRunnerConfig,
  dockerVersion: string | null,
  dockerInfoAvailable: boolean
): DockerBuildRehearsalResult["docker"] {
  const image = docker.image ?? null;
  const allowlist = docker.imageAllowlist ?? [];

  return {
    image,
    imageDigestPinned: image ? hasDockerDigest(image) : null,
    imageAllowlistConfigured: allowlist.length > 0,
    imageAllowedByAllowlist: image ? dockerImageMatchesAllowlist(image, allowlist) : null,
    imageTaggedTrustedExceptionAccepted: docker.imageTaggedTrustedExceptionAccepted === true,
    network: docker.network ?? defaultBuildNetwork,
    memory: docker.memory ?? defaultBuildMemory,
    cpus: docker.cpus ?? defaultBuildCpus,
    pidsLimit: docker.pidsLimit ?? defaultBuildPidsLimit,
    user: docker.user ?? null,
    dockerVersion,
    dockerInfoAvailable
  };
}

export async function runDockerBuildRehearsal(
  options: DockerBuildRehearsalOptions = {}
): Promise<DockerBuildRehearsalResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const buildExecutor = options.buildExecutor ?? defaultBuildExecutor;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const dryRun = Boolean(options.dryRun);
  const artifactLimits = resolveArtifactLimits(env);
  let docker: DockerBuildRunnerConfig;

  try {
    docker = resolveDockerConfig(env);
  } catch (error) {
    const completedAt = now().toISOString();
    return {
      name: rehearsalName,
      status: "blocked",
      dryRun,
      startedAt,
      completedAt,
      ...(options.commitRef ? { releaseCommit: options.commitRef } : {}),
      ...(options.repo ? { repository: options.repo } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      buildRunner: "docker",
      docker: dockerEvidence({}, null, false),
      prerequisites: [
        {
          name: "SITEFLOW_BUILD_IMAGE_POLICY",
          required: true,
          status: "failed",
          message: error instanceof Error ? error.message : "Docker build image policy is invalid."
        }
      ],
      buildCommands,
      sourceFixture: sourceFixtureEvidence({}, null),
      artifactLimits,
      artifact: null,
      redactionVerified: null,
      exitCode: 1
    };
  }

  const prereq = await dockerPrerequisites(commandRunner, cwd, env);
  const prerequisiteChecks = [
    ...prereq.checks,
    buildNetworkPrerequisite(docker),
    releaseIdentityPrerequisite(options)
  ];
  const baseResult = {
    name: rehearsalName,
    dryRun,
    startedAt,
    ...(options.commitRef ? { releaseCommit: options.commitRef } : {}),
    ...(options.repo ? { repository: options.repo } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    buildRunner: "docker" as const,
    docker: dockerEvidence(docker, prereq.dockerVersion, prereq.dockerInfoAvailable),
    prerequisites: prerequisiteChecks,
    buildCommands,
    sourceFixture: sourceFixtureEvidence(docker, null),
    artifactLimits
  };

  if (hasBlockingPrerequisite(prerequisiteChecks)) {
    return {
      ...baseResult,
      status: "blocked",
      completedAt: now().toISOString(),
      artifact: null,
      redactionVerified: null,
      exitCode: 1
    };
  }

  if (dryRun) {
    return {
      ...baseResult,
      status: "dry_run",
      completedAt: now().toISOString(),
      artifact: null,
      redactionVerified: null,
      exitCode: 0
    };
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-docker-rehearsal-"));

  try {
    const build = await buildExecutor({
      root,
      env,
      docker,
      buildStepTimeoutMs: options.buildStepTimeoutMs,
      maxArtifactBytes: artifactLimits.maxArtifactBytes,
      maxArtifactFiles: artifactLimits.maxArtifactFiles
    });

    if (
      build.sourceFixture?.dependencyInstallVerified !== true
      || build.sourceFixture?.dependencyMarker !== rehearsalDependencyMarker
    ) {
      throw new Error("Docker build rehearsal executor did not verify the dependency fixture install.");
    }

    return {
      ...baseResult,
      status: "passed",
      completedAt: now().toISOString(),
      sourceFixture: sourceFixtureEvidence(docker, true),
      artifact: build.artifact,
      redactionVerified: build.redactionVerified,
      exitCode: 0
    };
  } catch (error) {
    return {
      ...baseResult,
      status: "failed",
      completedAt: now().toISOString(),
      artifact: null,
      redactionVerified: false,
      exitCode: 1,
      errorMessage: redactLogLine(error instanceof Error ? error.message : String(error))
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function parseDockerBuildRehearsalArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--commit-ref") {
      parsed.commitRef = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      parsed.buildStepTimeoutMs = parsePositiveNumberOption(readArgValue(args, index, arg), "--timeout-ms");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

export function dockerBuildRehearsalUsage() {
  return [
    "Usage: npm run --silent rehearsal:docker-build -- [--dry-run] [--json] --commit-ref <sha> --repo <owner/repo> --branch <name>",
    "",
    "Required environment:",
    "  SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL=1",
    "  SITEFLOW_BUILD_IMAGE=<target docker build image>",
    "",
    "Options:",
    "  --dry-run            Check prerequisites and image posture without running a Docker build.",
    "  --json               Emit a single JSON evidence object.",
    "  --commit-ref <sha>   Required release commit SHA for the evidence.",
    "  --repo <owner/repo>  Required target repository for the evidence.",
    "  --branch <name>      Required target branch for the evidence.",
    "  --timeout-ms <ms>    Per build-step timeout. Default: 120000.",
    "  --help               Show this help."
  ].join("\n");
}

function writeHumanResult(result: DockerBuildRehearsalResult, io: CliIo) {
  const output = result.status === "passed" || result.status === "dry_run" ? io.stdout : io.stderr;

  output.write(`SiteFlow Docker build rehearsal status: ${result.status}\n`);
  output.write("Prerequisites:\n");

  for (const check of result.prerequisites) {
    output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
  }

  output.write(`Build image: ${result.docker.image ?? "missing"}\n`);
  output.write(`Build commands: ${result.buildCommands.join(", ")}\n`);

  if (result.status === "dry_run") {
    output.write("Dry run only; Docker build worker was not executed.\n");
  } else if (result.status === "failed" && result.errorMessage) {
    output.write(`Failure: ${result.errorMessage}\n`);
  }
}

export async function runDockerBuildRehearsalCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: DockerBuildRehearsalOptions = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseDockerBuildRehearsalArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${dockerBuildRehearsalUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${dockerBuildRehearsalUsage()}\n`);
    return 0;
  }

  const result = await runDockerBuildRehearsal({
    ...baseOptions,
    dryRun: parsed.dryRun,
    json: parsed.json,
    commitRef: parsed.commitRef,
    repo: parsed.repo,
    branch: parsed.branch,
    buildStepTimeoutMs: parsed.buildStepTimeoutMs
  });

  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, io);
  }

  return result.exitCode;
}

if (isEntrypoint()) {
  runDockerBuildRehearsalCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
