import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedBuildJob } from "./buildWorker";
import { GitSourceResolver, shouldUseGitSourceResolver, validateGitRemoteUrl } from "./gitSourceResolver";

vi.mock("node:child_process", () => {
  const spawnMock = vi.fn();

  return {
    default: {
      spawn: spawnMock
    },
    spawn: spawnMock
  };
});

const fullCommit = "4f3a9c2d1b0e4f3a9c2d1b0e4f3a9c2d1b0e4f3a";
const otherCommit = "9a8b7c6d5e4f9a8b7c6d5e4f9a8b7c6d5e4f9a8b";

interface SpawnCall {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface MockGitOptions {
  resolvedCommit?: string;
  headCommit?: string;
  shouldFail?: (args: string[]) => boolean;
}

function queuedJob(overrides: Partial<QueuedBuildJob> = {}): QueuedBuildJob {
  const base: QueuedBuildJob = {
    id: "build_git_1",
    projectId: "project_docs",
    projectSlug: "docs",
    productionBranch: "main",
    sourceEventId: "src_git_1",
    sourceEvent: {
      id: "src_git_1",
      projectId: "project_docs",
      kind: "push",
      status: "accepted",
      disposition: "build_requested",
      providerDeliveryId: "delivery-git",
      branch: "feature/git",
      commitSha: fullCommit,
      commitMessage: "Ship Git resolver",
      commitAuthor: "Ada",
      receivedAt: "2026-06-07T00:00:00.000Z",
      actor: {
        id: "github:ada",
        name: "ada",
        role: "developer"
      }
    },
    repository: {
      provider: "github",
      owner: "acme",
      name: "docs",
      defaultBranch: "main",
      providerPayload: {
        remoteUrl: "https://github.com/acme/docs.git"
      }
    },
    buildSettings: {
      framework: "static",
      installCommand: "",
      buildCommand: "npm run build",
      outputDirectory: "dist"
    }
  };

  return {
    ...base,
    ...overrides,
    sourceEvent: {
      ...base.sourceEvent,
      ...overrides.sourceEvent
    },
    repository: {
      ...base.repository,
      ...overrides.repository
    },
    buildSettings: {
      ...base.buildSettings,
      ...overrides.buildSettings
    }
  };
}

function stdoutFor(args: string[], options: MockGitOptions) {
  if (args.includes("rev-parse") && args.at(-1) === "HEAD") {
    return `${options.headCommit ?? options.resolvedCommit ?? fullCommit}\n`;
  }

  if (args.includes("rev-parse") && args.includes("--verify")) {
    return `${options.resolvedCommit ?? fullCommit}\n`;
  }

  return "";
}

function commandArgs(call: SpawnCall | undefined) {
  return call?.args.slice(4) ?? [];
}

function commandArgsList(calls: SpawnCall[]) {
  return calls.map((call) => commandArgs(call));
}

function mockGitSpawn(options: MockGitOptions = {}) {
  const calls: SpawnCall[] = [];

  vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions?: { env?: NodeJS.ProcessEnv }) => {
    const call = {
      command,
      args: [...args],
      env: spawnOptions?.env
    };
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };

    calls.push(call);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(() => {
      if (options.shouldFail?.(call.args)) {
        child.stderr.emit("data", Buffer.from("fatal: repository not found"));
        child.emit("close", 1);
        return;
      }

      const stdout = stdoutFor(call.args, options);

      if (stdout) {
        child.stdout.emit("data", Buffer.from(stdout));
      }

      child.emit("close", 0);
    });

    return child;
  }) as never);

  return calls;
}

describe("GitSourceResolver", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("selects Git only for remote providers with a remote URL and no local path", () => {
    expect(shouldUseGitSourceResolver(queuedJob())).toBe(true);
    expect(shouldUseGitSourceResolver(queuedJob({
      repository: {
        provider: "gitlab",
        owner: "acme",
        name: "docs",
        defaultBranch: "main",
        providerPayload: {
          url: "ssh://git@gitlab.com/acme/docs.git"
        }
      }
    }))).toBe(true);
    expect(shouldUseGitSourceResolver(queuedJob({
      repository: {
        provider: "github",
        owner: "acme",
        name: "docs",
        defaultBranch: "main",
        providerPayload: {
          remoteUrl: "https://github.com/acme/docs.git",
          localPath: "/srv/siteflow/docs"
        }
      }
    }))).toBe(false);
    expect(shouldUseGitSourceResolver(queuedJob({
      repository: {
        provider: "local" as never,
        owner: "acme",
        name: "docs",
        defaultBranch: "main",
        providerPayload: {
          remoteUrl: "https://github.com/acme/docs.git"
        }
      }
    }))).toBe(false);
  });

  it("allows only http(s) and SSH Git remote URL forms", () => {
    expect(validateGitRemoteUrl("https://github.com/acme/docs.git")).toBe("https://github.com/acme/docs.git");
    expect(validateGitRemoteUrl("http://git.example.com/acme/docs.git")).toBe("http://git.example.com/acme/docs.git");
    expect(validateGitRemoteUrl("ssh://git@github.com/acme/docs.git")).toBe("ssh://git@github.com/acme/docs.git");
    expect(validateGitRemoteUrl("git@github.com:acme/docs.git")).toBe("git@github.com:acme/docs.git");

    expect(() => validateGitRemoteUrl("https://token@github.com/acme/docs.git")).toThrow(/embedded credentials/i);
    expect(() => validateGitRemoteUrl("https://user:token@github.com/acme/docs.git")).toThrow(/embedded credentials/i);
    expect(() => validateGitRemoteUrl("ssh://git:secret@github.com/acme/docs.git")).toThrow(/embedded credentials/i);
    expect(() => validateGitRemoteUrl("file:///tmp/docs.git")).toThrow(/http\(s\)|SSH|unsafe/i);
    expect(() => validateGitRemoteUrl("C:\\repos\\docs")).toThrow(/http\(s\)|SSH|unsafe/i);
    expect(() => validateGitRemoteUrl("../docs")).toThrow(/http\(s\)|SSH|unsafe/i);
    expect(() => validateGitRemoteUrl("--upload-pack=sh")).toThrow(/unsafe/i);
    expect(() => validateGitRemoteUrl("https://github.com/acme/docs.git -c core.sshCommand=sh")).toThrow(/unsafe/i);
  });

  it("clones, fetches refs, checks out the requested commit, and verifies HEAD", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-resolver-"));
    const calls = mockGitSpawn();
    const job = queuedJob();

    try {
      const checkout = await new GitSourceResolver().checkout(job, root);
      const checkoutRoot = path.resolve(root, job.id, "source");

      expect(checkout.sourceDirectory).toBe(checkoutRoot);
      expect(calls[0]).toEqual({
        command: "git",
        args: ["-c", "credential.helper=", "-c", "core.askPass=", "clone", "--no-checkout", "--", "https://github.com/acme/docs.git", checkoutRoot],
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: ""
        })
      });
      expect(calls[0].env).not.toHaveProperty("GIT_SSH_COMMAND");
      expect(commandArgsList(calls)).toContainEqual([
        "-C",
        checkoutRoot,
        "fetch",
        "--force",
        "--tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*"
      ]);
      expect(commandArgsList(calls)).toContainEqual([
        "-C",
        checkoutRoot,
        "rev-parse",
        "--verify",
        `${fullCommit}^{commit}`
      ]);
      expect(commandArgsList(calls)).toContainEqual([
        "-C",
        checkoutRoot,
        "checkout",
        "--detach",
        "--force",
        fullCommit
      ]);
      expect(commandArgs(calls.at(-1))).toEqual(["-C", checkoutRoot, "rev-parse", "HEAD"]);

      await checkout.cleanup?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      commandName: "clone",
      shouldFail: (args: string[]) => args.includes("clone")
    },
    {
      commandName: "fetch",
      shouldFail: (args: string[]) => args.includes("fetch") && args.includes("--tags")
    },
    {
      commandName: "checkout",
      shouldFail: (args: string[]) => args.includes("checkout")
    }
  ])("removes the job workspace when Git $commandName fails", async ({ shouldFail }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-cleanup-fail-"));
    const job = queuedJob();

    mockGitSpawn({ shouldFail });

    try {
      await expect(new GitSourceResolver().checkout(job, root)).rejects.toThrow(/Git command failed/i);
      await expect(stat(path.join(root, job.id))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a controlled SSH command for configured operator-mounted deploy keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-ssh-key-"));
    const calls = mockGitSpawn();
    const originalGitSshCommand = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -i /tmp/ambient-key";
    const job = queuedJob({
      repository: {
        provider: "github",
        owner: "acme",
        name: "docs",
        defaultBranch: "main",
        providerPayload: {
          remoteUrl: "git@github.com:acme/docs.git"
        }
      }
    });

    try {
      await new GitSourceResolver({
        sshKeyPath: "/etc/siteflow/secrets/git-deploy-key",
        knownHostsPath: "/etc/siteflow/ssh/known_hosts"
      }).checkout(job, root);

      expect(calls[0].env).toEqual(expect.objectContaining({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_SSH_COMMAND: "ssh -i '/etc/siteflow/secrets/git-deploy-key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='/etc/siteflow/ssh/known_hosts'"
      }));
      expect(calls[0].env?.GIT_SSH_COMMAND).not.toContain("/tmp/ambient-key");
      expect(commandArgs(calls[0])).toEqual([
        "clone",
        "--no-checkout",
        "--",
        "git@github.com:acme/docs.git",
        path.resolve(root, job.id, "source")
      ]);
    } finally {
      if (originalGitSshCommand === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = originalGitSshCommand;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not inherit an external GIT_SSH_COMMAND when no deploy key is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-no-inherited-ssh-"));
    const calls = mockGitSpawn();
    const originalGitSshCommand = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "ssh -i /tmp/ambient-key";

    try {
      await new GitSourceResolver().checkout(queuedJob(), root);

      expect(calls[0].env).not.toHaveProperty("GIT_SSH_COMMAND");
    } finally {
      if (originalGitSshCommand === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = originalGitSshCommand;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe SSH credential paths before running Git", () => {
    const calls = mockGitSpawn();

    expect(() => new GitSourceResolver({ sshKeyPath: "relative/git-deploy-key" })).toThrow("SITEFLOW_GIT_SSH_KEY_PATH");
    expect(() => new GitSourceResolver({ sshKeyPath: "/etc/siteflow/secrets/git deploy key" })).toThrow("SITEFLOW_GIT_SSH_KEY_PATH");
    expect(() => new GitSourceResolver({ sshKeyPath: "/etc/siteflow/secrets/../git-deploy-key" })).toThrow("SITEFLOW_GIT_SSH_KEY_PATH");
    expect(() => new GitSourceResolver({ sshKeyPath: "/etc/siteflow/secrets/git-deploy-key;rm" })).toThrow("SITEFLOW_GIT_SSH_KEY_PATH");
    expect(() => new GitSourceResolver({ knownHostsPath: "/etc/siteflow/ssh/known_hosts" })).toThrow("SITEFLOW_GIT_KNOWN_HOSTS_PATH requires");
    expect(() => new GitSourceResolver({
      sshKeyPath: "/etc/siteflow/secrets/git-deploy-key",
      knownHostsPath: "/etc/siteflow/ssh/known hosts"
    })).toThrow("SITEFLOW_GIT_KNOWN_HOSTS_PATH");
    expect(calls).toEqual([]);
  });

  it("uses providerPayload.url when remoteUrl is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-url-field-"));
    const calls = mockGitSpawn();
    const job = queuedJob({
      repository: {
        provider: "gitea",
        owner: "acme",
        name: "docs",
        defaultBranch: "main",
        providerPayload: {
          url: "git@git.example.com:acme/docs.git"
        }
      }
    });

    try {
      await new GitSourceResolver().checkout(job, root);

      expect(commandArgs(calls[0])).toEqual([
        "clone",
        "--no-checkout",
        "--",
        "git@git.example.com:acme/docs.git",
        path.resolve(root, job.id, "source")
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches an existing workspace checkout instead of cloning again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-existing-"));
    const job = queuedJob();
    const checkoutRoot = path.resolve(root, job.id, "source");
    const calls = mockGitSpawn();

    try {
      await mkdir(path.join(checkoutRoot, ".git"), { recursive: true });

      await new GitSourceResolver().checkout(job, root);

      expect(calls.some((call) => commandArgs(call)[0] === "clone")).toBe(false);
      expect(commandArgs(calls[0])).toEqual(["-C", checkoutRoot, "remote", "set-url", "origin", "https://github.com/acme/docs.git"]);
      expect(commandArgs(calls[1])).toEqual([
        "-C",
        checkoutRoot,
        "fetch",
        "--force",
        "--tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects branch-only builds before running Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-no-sha-"));
    const calls = mockGitSpawn();

    try {
      await expect(new GitSourceResolver().checkout(queuedJob({
        sourceEvent: {
          ...queuedJob().sourceEvent,
          commitSha: ""
        }
      }), root)).rejects.toThrow(/commit SHA/i);

      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe checkout job ids before running Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-unsafe-job-"));
    const calls = mockGitSpawn();

    try {
      await expect(new GitSourceResolver().checkout(queuedJob({
        id: "../escape"
      }), root)).rejects.toThrow(/safe path segment/i);

      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves short commit SHAs before checkout and accepts matching HEAD prefixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-short-sha-"));
    const calls = mockGitSpawn({ resolvedCommit: fullCommit, headCommit: fullCommit });
    const shortCommit = fullCommit.slice(0, 8);

    try {
      await new GitSourceResolver().checkout(queuedJob({
        sourceEvent: {
          ...queuedJob().sourceEvent,
          commitSha: shortCommit
        }
      }), root);

      expect(commandArgsList(calls)).toContainEqual([
        "-C",
        path.resolve(root, "build_git_1", "source"),
        "rev-parse",
        "--verify",
        `${shortCommit}^{commit}`
      ]);
      expect(commandArgsList(calls)).toContainEqual([
        "-C",
        path.resolve(root, "build_git_1", "source"),
        "checkout",
        "--detach",
        "--force",
        fullCommit
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches a full commit directly when it is not present in fetched refs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-direct-fetch-"));
    let revParseAttempts = 0;
    const calls = mockGitSpawn({
      shouldFail: (args) => {
        if (args.includes("rev-parse") && args.includes("--verify")) {
          revParseAttempts += 1;
          return revParseAttempts === 1;
        }

        return false;
      }
    });

    try {
      await new GitSourceResolver().checkout(queuedJob(), root);

      expect(commandArgsList(calls)).toContainEqual([
        "-C",
        path.resolve(root, "build_git_1", "source"),
        "fetch",
        "--force",
        "origin",
        fullCommit
      ]);
      expect(revParseAttempts).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when checkout HEAD does not match the requested commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-head-mismatch-"));
    mockGitSpawn({ resolvedCommit: fullCommit, headCommit: otherCommit });

    try {
      await expect(new GitSourceResolver().checkout(queuedJob(), root)).rejects.toThrow(/HEAD did not match/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a hung Git command after the configured timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-git-timeout-"));
    const calls: SpawnCall[] = [];
    const killSignals: string[] = [];

    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions?: { env?: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: NodeJS.Signals | number) => boolean;
      };

      calls.push({
        command,
        args: [...args],
        env: spawnOptions?.env
      });
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal?: NodeJS.Signals | number) => {
        killSignals.push(String(signal));
        queueMicrotask(() => child.emit("close", null));
        return true;
      };

      return child;
    }) as never);

    try {
      const result = new GitSourceResolver({ commandTimeoutMs: 1 }).checkout(queuedJob(), root);
      const rejection = expect(result).rejects.toThrow("Git command timed out after 1ms");

      await rejection;
      expect(killSignals).toContain("SIGTERM");
      expect(calls).toHaveLength(1);
      expect(commandArgs(calls[0])[0]).toBe("clone");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
