import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupStaleDockerBuildContainers,
  runBuildCommand,
  validateDockerImageReference,
  validateProductionDockerBuildImagePolicy
} from "./buildSandbox";

vi.mock("node:child_process", () => {
  const spawnMock = vi.fn();

  return {
    default: {
      spawn: spawnMock
    },
    spawn: spawnMock
  };
});

interface SpawnCall {
  command: string;
  args: string[];
  options: {
    cwd?: string;
    shell?: boolean;
    env?: NodeJS.ProcessEnv;
  };
}

interface MockSpawnOptions {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  beforeClose?: (call: SpawnCall) => Promise<void> | void;
}

function mockSpawn(options: MockSpawnOptions = {}) {
  const calls: SpawnCall[] = [];

  vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions: SpawnCall["options"] = {}) => {
    const call = {
      command,
      args: [...args],
      options: spawnOptions
    };
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };

    calls.push(call);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(() => {
      void (async () => {
        if (options.error) {
          child.emit("error", options.error);
          return;
        }

        await options.beforeClose?.(call);

        if (options.stdout) {
          child.stdout.emit("data", Buffer.from(options.stdout));
        }

        if (options.stderr) {
          child.stderr.emit("data", Buffer.from(options.stderr));
        }

        child.emit("close", options.exitCode ?? 0);
      })().catch((error: unknown) => {
        child.emit("error", error);
      });
    });

    return child;
  }) as never);

  return calls;
}

function dockerArg(args: string[], name: string) {
  const index = args.indexOf(name);
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1];
}

function dockerArgs(args: string[], name: string) {
  return args.flatMap((entry, index) => entry === name ? [args[index + 1]] : []);
}

describe("build sandbox runner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("runs allowed build commands through docker with an env-file and isolation flags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-docker-build-"));
    let envFilePath = "";
    let envFileContents = "";
    const calls = mockSpawn({
      stdout: "token=docker-secret-20260607\n",
      beforeClose: async (call) => {
        envFilePath = dockerArg(call.args, "--env-file");
        envFileContents = await readFile(envFilePath, "utf8");
      }
    });
    const logs: string[] = [];

    try {
      const result = await runBuildCommand("npm run build", {
        cwd: root,
        runner: "docker",
        docker: {
          image: "node:20-test",
          memory: "512m",
          cpus: "0.5",
          pidsLimit: 64,
          user: "1001:1001"
        },
        environmentVariables: {
          PUBLIC_FLAG: "enabled",
          SITEFLOW_BUILD_TOKEN: "docker-secret-20260607"
        },
        secretPatterns: [/docker-secret-20260607/g],
        appendLog: async (line) => {
          logs.push(line);
        }
      });

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("docker");
      expect(calls[0].options).toMatchObject({
        cwd: root,
        shell: false
      });
      expect(calls[0].args.slice(0, 2)).toEqual(["run", "--rm"]);
      expect(calls[0].args).toContain("--init");
      expect(dockerArg(calls[0].args, "--cidfile")).toContain("container.cid");
      expect(dockerArgs(calls[0].args, "--label")).toEqual(expect.arrayContaining([
        "siteflow.managed=true",
        "siteflow.role=build-runner",
        expect.stringMatching(/^siteflow\.created-at-ms=\d+$/),
        expect.stringMatching(/^siteflow\.project-root-sha=[a-f0-9]{24}$/)
      ]));
      expect(dockerArg(calls[0].args, "--cap-drop")).toBe("ALL");
      expect(dockerArg(calls[0].args, "--security-opt")).toBe("no-new-privileges");
      expect(calls[0].args).toContain("--read-only");
      expect(dockerArgs(calls[0].args, "--tmpfs")).toEqual([
        "/tmp:rw,nosuid,nodev,size=256m",
        "/home/siteflow:rw,nosuid,nodev,size=64m"
      ]);
      expect(dockerArg(calls[0].args, "--network")).toBe("none");
      expect(dockerArg(calls[0].args, "--memory")).toBe("512m");
      expect(dockerArg(calls[0].args, "--cpus")).toBe("0.5");
      expect(dockerArg(calls[0].args, "--pids-limit")).toBe("64");
      expect(dockerArg(calls[0].args, "-u")).toBe("1001:1001");
      expect(dockerArg(calls[0].args, "--mount")).toBe(`type=bind,source=${root},target=/workspace,bind-propagation=rprivate`);
      expect(dockerArg(calls[0].args, "-w")).toBe("/workspace");
      expect(calls[0].args.slice(calls[0].args.indexOf("node:20-test"))).toEqual(["node:20-test", "npm", "run", "build"]);
      expect(envFileContents).toContain("CI=1\n");
      expect(envFileContents).toContain("HOME=/tmp/siteflow-home\n");
      expect(envFileContents).toContain("TMPDIR=/tmp\n");
      expect(envFileContents).toContain("npm_config_cache=/tmp/siteflow-npm-cache\n");
      expect(envFileContents).toContain("PUBLIC_FLAG=enabled\n");
      expect(envFileContents).toContain("SITEFLOW_BUILD_TOKEN=docker-secret-20260607\n");
      await expect(readFile(envFilePath, "utf8")).rejects.toThrow();
      expect(logs).toEqual(["$ npm run build", "token=[REDACTED]"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans the docker env-file when docker fails to start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-docker-build-error-"));
    const calls = mockSpawn({
      error: new Error("docker executable not found")
    });

    try {
      await expect(runBuildCommand("npm test", {
        cwd: root,
        runner: "docker",
        environmentVariables: {
          SITEFLOW_BUILD_TOKEN: "docker-secret-20260607"
        },
        secretPatterns: [/docker-secret-20260607/g],
        appendLog: async () => undefined
      })).rejects.toThrow("docker executable not found");

      await expect(readFile(dockerArg(calls[0].args, "--env-file"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans the Docker env-file when child stdio is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-docker-build-stdio-"));
    let envFilePath = "";

    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions: SpawnCall["options"] = {}) => {
      const call = {
        command,
        args: [...args],
        options: spawnOptions
      };
      const child = new EventEmitter();

      envFilePath = dockerArg(call.args, "--env-file");

      return child;
    }) as never);

    try {
      await expect(runBuildCommand("npm test", {
        cwd: root,
        runner: "docker",
        environmentVariables: {
          SITEFLOW_BUILD_TOKEN: "docker-secret-20260607"
        },
        secretPatterns: [/docker-secret-20260607/g],
        appendLog: async () => undefined
      })).rejects.toThrow("Build command stdio was not available.");

      await expect(readFile(envFilePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates build commands when the configured timeout elapses", async () => {
    vi.useFakeTimers();
    const killSignals: string[] = [];

    vi.mocked(spawn).mockImplementation(((_command: string, _args: readonly string[] = [], _spawnOptions: SpawnCall["options"] = {}) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: NodeJS.Signals | number) => boolean;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal?: NodeJS.Signals | number) => {
        killSignals.push(String(signal));
        queueMicrotask(() => child.emit("close", null));
        return true;
      };

      return child;
    }) as never);

    const logs: string[] = [];
    const result = runBuildCommand("npm test", {
      cwd: os.tmpdir(),
      timeoutMs: 10,
      appendLog: async (line) => {
        logs.push(line);
      }
    });
    const rejection = expect(result).rejects.toThrow("timed out after 10ms");

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(killSignals).toContain("SIGTERM");
    expect(logs).toContain("Build command timed out after 10ms; terminating process.");
  });

  it("cleans up Docker containers by cidfile when a Docker build times out", async () => {
    const calls: SpawnCall[] = [];
    const killSignals: string[] = [];
    let envFilePath = "";

    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions: SpawnCall["options"] = {}) => {
      const call = {
        command,
        args: [...args],
        options: spawnOptions
      };
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: NodeJS.Signals | number) => boolean;
      };

      calls.push(call);
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal?: NodeJS.Signals | number) => {
        killSignals.push(String(signal));
        queueMicrotask(() => child.emit("close", null));
        return true;
      };

      if (command === "docker" && call.args[0] === "run") {
        envFilePath = dockerArg(call.args, "--env-file");
        writeFileSync(dockerArg(call.args, "--cidfile"), "container-timeout\n", "utf8");
      } else {
        queueMicrotask(() => child.emit("close", 0));
      }

      return child;
    }) as never);

    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-docker-timeout-"));

    try {
      const result = runBuildCommand("npm run build", {
        cwd: root,
        runner: "docker",
        timeoutMs: 1,
        appendLog: async () => undefined
      });
      const rejection = expect(result).rejects.toThrow("timed out after 1ms");

      await rejection;
      expect(killSignals).toContain("SIGTERM");
      expect(calls[0].args).toContain("--cidfile");
      expect(calls.map((call) => call.args)).toContainEqual(["kill", "container-timeout"]);
      expect(calls.map((call) => call.args)).toContainEqual(["rm", "-f", "container-timeout"]);
      await expect(readFile(envFilePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let Docker cidfile cleanup hang the build timeout rejection", async () => {
    const calls: SpawnCall[] = [];
    let envFilePath = "";

    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions: SpawnCall["options"] = {}) => {
      const call = {
        command,
        args: [...args],
        options: spawnOptions
      };
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: NodeJS.Signals | number) => boolean;
      };

      calls.push(call);
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        if (call.args[0] === "run") {
          queueMicrotask(() => child.emit("close", null));
        }

        return true;
      };

      if (command === "docker" && call.args[0] === "run") {
        envFilePath = dockerArg(call.args, "--env-file");
        writeFileSync(dockerArg(call.args, "--cidfile"), "container-hung-cleanup\n", "utf8");
      }

      return child;
    }) as never);

    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-docker-timeout-hung-cleanup-"));

    try {
      const result = runBuildCommand("npm run build", {
        cwd: root,
        runner: "docker",
        timeoutMs: 1,
        docker: {
          cleanupCommandTimeoutMs: 1
        },
        appendLog: async () => undefined
      });
      const rejection = expect(result).rejects.toThrow("timed out after 1ms");

      await rejection;

      expect(calls.map((call) => call.args)).toContainEqual(["kill", "container-hung-cleanup"]);
      expect(calls.map((call) => call.args)).toContainEqual(["rm", "-f", "container-hung-cleanup"]);
      await expect(readFile(envFilePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects commands outside the build allowlist before spawning a runner", async () => {
    const calls = mockSpawn();

    await expect(runBuildCommand("node build.mjs", {
      cwd: os.tmpdir(),
      runner: "docker",
      appendLog: async () => undefined
    })).rejects.toThrow(/not allowed/i);

    expect(calls).toEqual([]);
  });

  it("rejects invalid Docker config before preparing the Docker env-file or spawning", async () => {
    const calls = mockSpawn();

    await expect(runBuildCommand("npm run build", {
      cwd: os.tmpdir(),
      runner: "docker",
      docker: {
        image: "--privileged"
      },
      environmentVariables: {
        "INVALID-ENV-KEY": "value"
      },
      appendLog: async () => undefined
    })).rejects.toThrow("SITEFLOW_BUILD_IMAGE");

    expect(calls).toEqual([]);
  });

  it("rejects Docker env-file keys and newline values before spawning", async () => {
    const calls = mockSpawn();

    await expect(runBuildCommand("npm run build", {
      cwd: os.tmpdir(),
      runner: "docker",
      docker: {
        image: "node:20-test"
      },
      environmentVariables: {
        "INVALID-ENV-KEY": "value"
      },
      appendLog: async () => undefined
    })).rejects.toThrow("Invalid build environment variable name");

    await expect(runBuildCommand("npm run build", {
      cwd: os.tmpdir(),
      runner: "docker",
      docker: {
        image: "node:20-test"
      },
      environmentVariables: {
        SITEFLOW_BUILD_TOKEN: "line-one\nline-two"
      },
      appendLog: async () => undefined
    })).rejects.toThrow("unsupported newline");

    expect(calls).toEqual([]);
  });

  it("rejects dangerous Docker image references before spawning a runner", async () => {
    const calls = mockSpawn();

    await expect(runBuildCommand("npm run build", {
      cwd: os.tmpdir(),
      runner: "docker",
      docker: {
        image: "--privileged"
      },
      appendLog: async () => undefined
    })).rejects.toThrow("SITEFLOW_BUILD_IMAGE");

    await expect(runBuildCommand("npm run build", {
      cwd: os.tmpdir(),
      runner: "docker",
      docker: {
        image: "node:latest"
      },
      appendLog: async () => undefined
    })).rejects.toThrow("latest");

    expect(calls).toEqual([]);
  });

  it("enforces a Docker image allowlist when configured", () => {
    expect(validateDockerImageReference("registry.local:5000/siteflow/build-node:20.11", [
      "registry.local:5000/siteflow/*"
    ])).toBe("registry.local:5000/siteflow/build-node:20.11");

    expect(() => validateDockerImageReference("node:20-bookworm-slim", [
      "registry.local:5000/siteflow/*"
    ])).toThrow("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
  });

  it("requires production Docker build images to be digest pinned unless a tagged-image exception is explicit", () => {
    expect(validateProductionDockerBuildImagePolicy({
      image: "registry.local:5000/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })).toBe("registry.local:5000/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(() => validateProductionDockerBuildImagePolicy({
      image: "registry.local:5000/siteflow/build-node:20.11",
      imageAllowlist: ["registry.local:5000/siteflow/*"]
    })).toThrow("SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1");

    expect(validateProductionDockerBuildImagePolicy({
      image: "registry.local:5000/siteflow/build-node:20.11",
      imageAllowlist: ["registry.local:5000/siteflow/*"],
      imageTaggedTrustedExceptionAccepted: true
    })).toBe("registry.local:5000/siteflow/build-node:20.11");
  });

  it("removes only stale labelled Docker build containers during startup cleanup", async () => {
    const calls: SpawnCall[] = [];
    const nowMs = 1_780_000_000_000;

    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions: SpawnCall["options"] = {}) => {
      const call = {
        command,
        args: [...args],
        options: spawnOptions
      };
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      calls.push(call);
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        if (call.args[0] === "ps") {
          child.stdout.emit("data", Buffer.from([
            `stale-container ${nowMs - 10_000}`,
            `fresh-container ${nowMs - 500}`,
            "invalid-container not-a-number",
            ""
          ].join("\n")));
        }

        child.emit("close", 0);
      });

      return child;
    }) as never);

    await cleanupStaleDockerBuildContainers({
      cwd: os.tmpdir(),
      maxAgeMs: 1000,
      nowMs
    });

    expect(calls[0].args).toEqual([
      "ps",
      "-a",
      "--filter",
      "label=siteflow.managed=true",
      "--filter",
      "label=siteflow.role=build-runner",
      "--format",
      '{{.ID}} {{.Label "siteflow.created-at-ms"}}'
    ]);
    expect(calls.map((call) => call.args)).toContainEqual(["rm", "-f", "stale-container"]);
    expect(calls.map((call) => call.args)).not.toContainEqual(["rm", "-f", "fresh-container"]);
    expect(calls.map((call) => call.args)).not.toContainEqual(["rm", "-f", "invalid-container"]);
  });

  it("skips stale Docker build container cleanup when the Docker daemon is unavailable", async () => {
    const calls = mockSpawn({
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon"
    });
    const logs: string[] = [];

    await cleanupStaleDockerBuildContainers({
      cwd: os.tmpdir(),
      log: (message) => logs.push(message)
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("ps");
    expect(calls.map((call) => call.args)).not.toContainEqual(expect.arrayContaining(["rm"]));
    expect(logs).toEqual([
      "SiteFlow Docker build container cleanup skipped; Docker daemon is unavailable.\n"
    ]);
  });

  it("swallows Docker rm failures during stale container cleanup", async () => {
    const calls: SpawnCall[] = [];
    const logs: string[] = [];
    const nowMs = 1_780_000_000_000;

    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[] = [], spawnOptions: SpawnCall["options"] = {}) => {
      const call = {
        command,
        args: [...args],
        options: spawnOptions
      };
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      calls.push(call);
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        if (call.args[0] === "ps") {
          child.stdout.emit("data", Buffer.from([
            `stale-one ${nowMs - 10_000}`,
            `stale-two ${nowMs - 20_000}`
          ].join("\n")));
          child.emit("close", 0);
          return;
        }

        if (call.args[0] === "rm" && call.args[2] === "stale-one") {
          child.emit("error", new Error("docker rm failed"));
          return;
        }

        child.emit("close", 0);
      });

      return child;
    }) as never);

    await cleanupStaleDockerBuildContainers({
      cwd: os.tmpdir(),
      maxAgeMs: 1000,
      nowMs,
      log: (message) => logs.push(message)
    });

    expect(calls.map((call) => call.args)).toContainEqual(["rm", "-f", "stale-one"]);
    expect(calls.map((call) => call.args)).toContainEqual(["rm", "-f", "stale-two"]);
    expect(logs).toEqual([
      "SiteFlow Docker build container cleanup removed 2 stale container(s).\n"
    ]);
  });

  it("rejects invalid stale Docker cleanup timing inputs before spawning Docker", async () => {
    const invalidCases = [
      {
        options: { maxAgeMs: Number.NaN, nowMs: 1_780_000_000_000 },
        message: "maxAgeMs"
      },
      {
        options: { maxAgeMs: Number.POSITIVE_INFINITY, nowMs: 1_780_000_000_000 },
        message: "maxAgeMs"
      },
      {
        options: { maxAgeMs: -1, nowMs: 1_780_000_000_000 },
        message: "maxAgeMs"
      },
      {
        options: { maxAgeMs: 0, nowMs: 1_780_000_000_000 },
        message: "maxAgeMs"
      },
      {
        options: { maxAgeMs: 1000, nowMs: Number.NaN },
        message: "nowMs"
      },
      {
        options: { maxAgeMs: 1000, nowMs: Number.POSITIVE_INFINITY },
        message: "nowMs"
      },
      {
        options: { maxAgeMs: 1000, nowMs: -1 },
        message: "nowMs"
      }
    ];

    for (const invalidCase of invalidCases) {
      const calls = mockSpawn();

      await expect(cleanupStaleDockerBuildContainers({
        cwd: os.tmpdir(),
        ...invalidCase.options
      })).rejects.toThrow(invalidCase.message);
      expect(calls).toEqual([]);
    }
  });
});
