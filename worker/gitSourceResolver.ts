import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { SourceCheckout, SourceResolver, QueuedBuildJob } from "./buildWorker.js";
import { localPathFromPayload, workspaceJobRoot } from "./localSourceResolver.js";

const remoteProviders = new Set(["github", "gitlab", "gitea", "generic"]);
const unsafeRemoteCharacters = /[\u0000-\u001f\u007f\s]/;
const commitShaPattern = /^[a-f0-9]{7,64}$/i;

interface GitCommandResult {
  stdout: string;
}

export interface GitSourceResolverOptions {
  commandTimeoutMs?: number;
  sshKeyPath?: string;
  knownHostsPath?: string;
}

const defaultGitCommandTimeoutMs = 300_000;
const unsafeCredentialPathCharacters = /[\u0000-\u001f\u007f\s]/;
const safeCredentialPathPattern = /^[A-Za-z0-9_./:@+=,\\-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveTimeoutMs(value: number | undefined) {
  const timeoutMs = value ?? defaultGitCommandTimeoutMs;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Git command timeout must be a positive number.");
  }

  return Math.ceil(timeoutMs);
}

export function validateGitCredentialPath(value: string, name: string) {
  if (
    value !== value.trim()
    || unsafeCredentialPathCharacters.test(value)
    || !safeCredentialPathPattern.test(value)
    || !path.isAbsolute(value)
    || value.split(/[\\/]+/).includes("..")
    || value.endsWith("/")
    || value.endsWith("\\")
  ) {
    throw new Error(`${name} must be an absolute mounted file path without whitespace or unsafe characters.`);
  }

  return value;
}

function gitSshCommand(options: GitSourceResolverOptions) {
  const sshKeyPath = options.sshKeyPath
    ? validateGitCredentialPath(options.sshKeyPath, "SITEFLOW_GIT_SSH_KEY_PATH")
    : undefined;
  const knownHostsPath = options.knownHostsPath
    ? validateGitCredentialPath(options.knownHostsPath, "SITEFLOW_GIT_KNOWN_HOSTS_PATH")
    : undefined;

  if (!sshKeyPath) {
    if (knownHostsPath) {
      throw new Error("SITEFLOW_GIT_KNOWN_HOSTS_PATH requires SITEFLOW_GIT_SSH_KEY_PATH.");
    }

    return undefined;
  }

  const parts = [
    "ssh",
    "-i",
    quoteShellArgument(sshKeyPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes"
  ];

  if (knownHostsPath) {
    parts.push("-o", `UserKnownHostsFile=${quoteShellArgument(knownHostsPath)}`);
  }

  return parts.join(" ");
}

function quoteShellArgument(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function payloadString(payload: unknown, fieldName: string) {
  if (!isRecord(payload)) {
    return undefined;
  }

  const value = payload[fieldName];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function rawRemoteUrlFromPayload(payload: unknown) {
  return payloadString(payload, "remoteUrl") ?? payloadString(payload, "url");
}

function assertSafeHostname(hostname: string) {
  if (!hostname || hostname.startsWith("-") || unsafeRemoteCharacters.test(hostname)) {
    throw new Error("Git remote URL must include a safe hostname.");
  }
}

function validateUrlRemote(remoteUrl: string) {
  let parsed: URL;

  try {
    parsed = new URL(remoteUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new Error("Git remote URL must use http(s) or SSH.");
  }

  if (parsed.password || ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username)) {
    throw new Error("Git remote URL must not include embedded credentials.");
  }

  assertSafeHostname(parsed.hostname);

  if (!parsed.pathname || parsed.pathname === "/" || parsed.pathname.includes("\\") || parsed.pathname.split("/").includes("..")) {
    throw new Error("Git remote URL must include a safe repository path.");
  }

  return true;
}

function validateScpLikeRemote(remoteUrl: string) {
  const match = /^(?:(?<user>[A-Za-z0-9._-]+)@)?(?<host>[A-Za-z0-9][A-Za-z0-9.-]*):(?<repoPath>[^:]+)$/.exec(remoteUrl);

  if (!match?.groups) {
    return false;
  }

  const { user, host, repoPath } = match.groups;

  if (!user && host.length === 1) {
    return false;
  }

  assertSafeHostname(host);

  if (
    repoPath.startsWith("/")
    || repoPath.startsWith("-")
    || repoPath.includes("\\")
    || !repoPath.includes("/")
    || repoPath.split("/").includes("..")
  ) {
    throw new Error("Git remote URL must include a safe repository path.");
  }

  return true;
}

export function validateGitRemoteUrl(value: string) {
  if (value !== value.trim() || unsafeRemoteCharacters.test(value) || value.startsWith("-")) {
    throw new Error("Git remote URL contains unsafe characters.");
  }

  if (validateUrlRemote(value) || validateScpLikeRemote(value)) {
    return value;
  }

  throw new Error("Git remote URL must be an http(s) URL or SSH Git URL.");
}

export function gitRemoteUrlForJob(job: QueuedBuildJob) {
  const remoteUrl = rawRemoteUrlFromPayload(job.repository.providerPayload);

  if (!remoteUrl) {
    throw new Error("Git source resolver requires repository.providerPayload.remoteUrl or url.");
  }

  return validateGitRemoteUrl(remoteUrl);
}

export function shouldUseGitSourceResolver(job: QueuedBuildJob) {
  if (localPathFromPayload(job.repository.providerPayload)) {
    return false;
  }

  return remoteProviders.has(String(job.repository.provider).toLowerCase())
    && Boolean(rawRemoteUrlFromPayload(job.repository.providerPayload));
}

function targetCommitForJob(job: QueuedBuildJob) {
  const commitSha = job.sourceEvent.commitSha.trim();

  if (!commitShaPattern.test(commitSha)) {
    throw new Error("Git source resolver requires sourceEvent.commitSha to be a hex commit SHA.");
  }

  return commitSha.toLowerCase();
}

async function hasGitDirectory(checkoutRoot: string) {
  const gitDirectory = await stat(path.join(checkoutRoot, ".git")).catch(() => undefined);
  return gitDirectory?.isDirectory() === true;
}

function runGit(args: string[], timeoutMs: number, controlledSshCommand: string | undefined): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: ""
    };

    delete env.GIT_SSH_COMMAND;

    if (controlledSshCommand) {
      env.GIT_SSH_COMMAND = controlledSshCommand;
    }

    const child = spawn("git", ["-c", "credential.helper=", "-c", "core.askPass=", ...args], {
      shell: false,
      env
    });
    const stdout: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        reject(error);
      }
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new Error(`Git command timed out after ${timeoutMs}ms.`));
      }, 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => fail(new Error(`Git command failed to start: ${error.message}`)));
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);

      if (timedOut) {
        reject(new Error(`Git command timed out after ${timeoutMs}ms.`));
        return;
      }

      if (exitCode === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
        return;
      }

      reject(new Error(`Git command failed with exit code ${exitCode ?? 1}.`));
    });
  });
}

async function cloneOrFetch(remoteUrl: string, checkoutRoot: string, timeoutMs: number, controlledSshCommand: string | undefined) {
  if (await hasGitDirectory(checkoutRoot)) {
    await runGit(["-C", checkoutRoot, "remote", "set-url", "origin", remoteUrl], timeoutMs, controlledSshCommand);
  } else {
    await rm(checkoutRoot, { recursive: true, force: true });
    await mkdir(path.dirname(checkoutRoot), { recursive: true });
    await runGit(["clone", "--no-checkout", "--", remoteUrl, checkoutRoot], timeoutMs, controlledSshCommand);
  }

  await runGit(["-C", checkoutRoot, "fetch", "--force", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], timeoutMs, controlledSshCommand);
}

async function resolveCommit(
  checkoutRoot: string,
  targetCommit: string,
  timeoutMs: number,
  controlledSshCommand: string | undefined
) {
  const revParse = async () =>
    (await runGit(["-C", checkoutRoot, "rev-parse", "--verify", `${targetCommit}^{commit}`], timeoutMs, controlledSshCommand)).stdout.trim().toLowerCase();

  try {
    return await revParse();
  } catch (error) {
    if (targetCommit.length < 40) {
      throw error;
    }

    await runGit(["-C", checkoutRoot, "fetch", "--force", "origin", targetCommit], timeoutMs, controlledSshCommand);
    return await revParse();
  }
}

async function checkoutCommit(checkoutRoot: string, targetCommit: string, timeoutMs: number, controlledSshCommand: string | undefined) {
  const resolvedCommit = await resolveCommit(checkoutRoot, targetCommit, timeoutMs, controlledSshCommand);

  if (!resolvedCommit.startsWith(targetCommit)) {
    throw new Error("Git resolved commit did not match the requested commit.");
  }

  await runGit(["-C", checkoutRoot, "clean", "-fdx"], timeoutMs, controlledSshCommand);
  await runGit(["-C", checkoutRoot, "checkout", "--detach", "--force", resolvedCommit], timeoutMs, controlledSshCommand);
  await runGit(["-C", checkoutRoot, "clean", "-fdx"], timeoutMs, controlledSshCommand);

  const headCommit = (await runGit(["-C", checkoutRoot, "rev-parse", "HEAD"], timeoutMs, controlledSshCommand)).stdout.trim().toLowerCase();

  if (headCommit !== resolvedCommit || !headCommit.startsWith(targetCommit)) {
    throw new Error("Git checkout HEAD did not match the requested commit.");
  }
}

export class GitSourceResolver implements SourceResolver {
  private readonly commandTimeoutMs: number;
  private readonly controlledSshCommand: string | undefined;

  constructor(options: GitSourceResolverOptions = {}) {
    this.commandTimeoutMs = positiveTimeoutMs(options.commandTimeoutMs);
    this.controlledSshCommand = gitSshCommand(options);
  }

  async checkout(job: QueuedBuildJob, workspaceRoot: string): Promise<SourceCheckout> {
    const remoteUrl = gitRemoteUrlForJob(job);
    const targetCommit = targetCommitForJob(job);
    const jobRoot = workspaceJobRoot(workspaceRoot, job.id);
    const checkoutRoot = path.join(jobRoot, "source");

    try {
      await cloneOrFetch(remoteUrl, checkoutRoot, this.commandTimeoutMs, this.controlledSshCommand);
      await checkoutCommit(checkoutRoot, targetCommit, this.commandTimeoutMs, this.controlledSshCommand);
    } catch (error) {
      await rm(jobRoot, { recursive: true, force: true });
      throw error;
    }

    return {
      sourceDirectory: checkoutRoot,
      cleanup: async () => {
        await rm(jobRoot, { recursive: true, force: true });
      }
    };
  }
}
