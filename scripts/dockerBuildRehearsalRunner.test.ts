import { describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  type DockerBuildExecutor,
  type DockerBuildExecutorResult,
  runDockerBuildRehearsal,
  runDockerBuildRehearsalCli
} from "./dockerBuildRehearsalRunner";

const pinnedBuildImage = "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
    SITEFLOW_BUILD_IMAGE: pinnedBuildImage,
    SITEFLOW_BUILD_NETWORK: "none",
    ...overrides
  };
}

function makeDockerRunner(exitCode = 0) {
  return vi.fn<CommandRunner>(async (command, args) => ({
    exitCode,
    stdout: command === "docker" && args[0] === "--version" ? "Docker version 27.0.0\n" : "ok\n",
    stderr: ""
  }));
}

function makeBuildExecutor(overrides: Partial<DockerBuildExecutorResult> = {}) {
  return vi.fn<DockerBuildExecutor>(async (options) => ({
    deploymentId: "dep_docker_rehearsal",
    previewUrl: "https://docker-rehearsal.siteflow.local",
    artifact: {
      entrypoint: "index.html",
      fileCount: 3,
      totalBytes: 512,
      checksum: "sha256:rehearsal"
    },
    artifactLimits: {
      maxArtifactBytes: options.maxArtifactBytes ?? 536870912,
      maxArtifactFiles: options.maxArtifactFiles ?? 20000
    },
    logs: ["$ npm ci", "$ npm run build", "rehearsal secret=[REDACTED]"],
    redactionVerified: true,
    sourceFixture: {
      dependencyInstallVerified: true,
      dependencyMarker: "siteflow-rehearsal-dependency:offline-fixture"
    },
    ...overrides
  }));
}

describe("dockerBuildRehearsalRunner", () => {
  it("blocks without the opt-in environment and build image", async () => {
    const commandRunner = makeDockerRunner();
    const buildExecutor = makeBuildExecutor();

    const result = await runDockerBuildRehearsal({
      env: {},
      commandRunner,
      buildExecutor
    });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL",
          status: "failed"
        }),
        expect.objectContaining({
          name: "SITEFLOW_BUILD_IMAGE",
          status: "failed"
        })
      ])
    );
    expect(buildExecutor).not.toHaveBeenCalled();
  });

  it("checks Docker prerequisites but does not execute the build during dry run", async () => {
    const commandRunner = makeDockerRunner();
    const buildExecutor = makeBuildExecutor();

    const result = await runDockerBuildRehearsal({
      dryRun: true,
      env: makeEnv(),
      commandRunner,
      buildExecutor,
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main"
    });

    expect(result.status).toBe("dry_run");
    expect(result.exitCode).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.releaseCommit).toBe("abc123def456");
    expect(result.repository).toBe("acme/siteflow");
    expect(result.branch).toBe("main");
    expect(result.docker).toMatchObject({
      image: pinnedBuildImage,
      imageDigestPinned: true,
      imageTaggedTrustedExceptionAccepted: false,
      network: "none",
      dockerVersion: "Docker version 27.0.0",
      dockerInfoAvailable: true
    });
    expect(result.buildCommands).toEqual(["npm ci", "npm run build"]);
    expect(result.sourceFixture).toMatchObject({
      packageManager: "npm",
      lockfile: "package-lock.json",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      dependencyCount: 1,
      lockfilePackageCount: 3,
      dependencyInstallVerified: null,
      dependencies: [
        {
          name: "siteflow-rehearsal-dependency",
          version: "1.0.0",
          spec: "file:./fixture-deps/siteflow-rehearsal-dependency",
          source: "file"
        }
      ],
      network: {
        mode: "none",
        egressAllowed: false,
        dependencyInstallRequiresNetwork: false
      }
    });
    expect(result.artifactLimits).toEqual({
      maxArtifactBytes: 536870912,
      maxArtifactFiles: 20000
    });
    expect(commandRunner).toHaveBeenCalledWith("docker", ["--version"], expect.objectContaining({ stdio: "pipe" }));
    expect(commandRunner).toHaveBeenCalledWith("docker", ["info"], expect.objectContaining({ stdio: "pipe" }));
    expect(buildExecutor).not.toHaveBeenCalled();
  });

  it("blocks missing release identity before executing the Docker build", async () => {
    const commandRunner = makeDockerRunner();
    const buildExecutor = makeBuildExecutor();

    const result = await runDockerBuildRehearsal({
      env: makeEnv(),
      commandRunner,
      buildExecutor
    });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release_identity",
          status: "failed",
          message: expect.stringContaining("--commit-ref")
        })
      ])
    );
    expect(commandRunner).toHaveBeenCalledWith("docker", ["--version"], expect.objectContaining({ stdio: "pipe" }));
    expect(commandRunner).toHaveBeenCalledWith("docker", ["info"], expect.objectContaining({ stdio: "pipe" }));
    expect(buildExecutor).not.toHaveBeenCalled();
  });

  it("blocks bridge network rehearsals before executing the Docker build", async () => {
    const commandRunner = makeDockerRunner();
    const buildExecutor = makeBuildExecutor();

    const result = await runDockerBuildRehearsal({
      env: makeEnv({
        SITEFLOW_BUILD_NETWORK: "bridge"
      }),
      commandRunner,
      buildExecutor,
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main"
    });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.docker.network).toBe("bridge");
    expect(result.prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "SITEFLOW_BUILD_NETWORK",
          status: "failed",
          message: expect.stringContaining("must be none")
        })
      ])
    );
    expect(commandRunner).toHaveBeenCalledWith("docker", ["--version"], expect.objectContaining({ stdio: "pipe" }));
    expect(commandRunner).toHaveBeenCalledWith("docker", ["info"], expect.objectContaining({ stdio: "pipe" }));
    expect(buildExecutor).not.toHaveBeenCalled();
  });

  it("blocks invalid Docker image posture before checking Docker", async () => {
    const commandRunner = makeDockerRunner();

    const result = await runDockerBuildRehearsal({
      env: makeEnv({
        SITEFLOW_BUILD_IMAGE: "node:latest"
      }),
      commandRunner,
      buildExecutor: makeBuildExecutor()
    });

    expect(result.status).toBe("blocked");
    expect(result.prerequisites).toEqual([
      expect.objectContaining({
        name: "SITEFLOW_BUILD_IMAGE_POLICY",
        status: "failed",
        message: expect.stringContaining("mutable latest")
      })
    ]);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("blocks allowlisted tagged Docker build images without an explicit tagged-image exception", async () => {
    const commandRunner = makeDockerRunner();

    const result = await runDockerBuildRehearsal({
      env: makeEnv({
        SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node:20.11",
        SITEFLOW_BUILD_IMAGE_ALLOWLIST: "registry.local/siteflow/*"
      }),
      commandRunner,
      buildExecutor: makeBuildExecutor()
    });

    expect(result.status).toBe("blocked");
    expect(result.prerequisites).toEqual([
      expect.objectContaining({
        name: "SITEFLOW_BUILD_IMAGE_POLICY",
        status: "failed",
        message: expect.stringContaining("SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1")
      })
    ]);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("records the explicit tagged-image exception in Docker rehearsal evidence", async () => {
    const result = await runDockerBuildRehearsal({
      dryRun: true,
      env: makeEnv({
        SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node:20.11",
        SITEFLOW_BUILD_IMAGE_ALLOWLIST: "registry.local/siteflow/*",
        SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE: "1"
      }),
      commandRunner: makeDockerRunner(),
      buildExecutor: makeBuildExecutor(),
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main"
    });

    expect(result.status).toBe("dry_run");
    expect(result.docker).toMatchObject({
      image: "registry.local/siteflow/build-node:20.11",
      imageDigestPinned: false,
      imageAllowlistConfigured: true,
      imageAllowedByAllowlist: true,
      imageTaggedTrustedExceptionAccepted: true
    });
  });

  it("passes when prerequisites and the Docker build executor pass", async () => {
    const commandRunner = makeDockerRunner();
    const buildExecutor = makeBuildExecutor();

    const result = await runDockerBuildRehearsal({
      env: makeEnv({
        SITEFLOW_BUILD_MEMORY: "768m",
        SITEFLOW_BUILD_CPUS: "1.5",
        SITEFLOW_BUILD_PIDS_LIMIT: "128",
        SITEFLOW_BUILD_USER: "1000:1000",
        SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "4096",
        SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "25"
      }),
      commandRunner,
      buildExecutor,
      buildStepTimeoutMs: 30_000,
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main"
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.releaseCommit).toBe("abc123def456");
    expect(result.repository).toBe("acme/siteflow");
    expect(result.branch).toBe("main");
    expect(result.artifact).toMatchObject({
      entrypoint: "index.html",
      fileCount: 3
    });
    expect(result.artifactLimits).toEqual({
      maxArtifactBytes: 4096,
      maxArtifactFiles: 25
    });
    expect(result.redactionVerified).toBe(true);
    expect(result.sourceFixture).toMatchObject({
      dependencyCount: 1,
      dependencyInstallVerified: true,
      network: {
        mode: "none",
        egressAllowed: false,
        dependencyInstallRequiresNetwork: false
      }
    });
    expect(result.docker).toMatchObject({
      memory: "768m",
      cpus: "1.5",
      pidsLimit: 128,
      user: "1000:1000"
    });
    expect(buildExecutor).toHaveBeenCalledWith(expect.objectContaining({
      docker: expect.objectContaining({
        image: pinnedBuildImage,
        network: "none"
      }),
      buildStepTimeoutMs: 30_000,
      maxArtifactBytes: 4096,
      maxArtifactFiles: 25
    }));
  });

  it("fails when the executor cannot prove the dependency fixture was installed", async () => {
    const result = await runDockerBuildRehearsal({
      env: makeEnv(),
      commandRunner: makeDockerRunner(),
      buildExecutor: makeBuildExecutor({
        sourceFixture: {
          dependencyInstallVerified: false,
          dependencyMarker: "siteflow-rehearsal-dependency:offline-fixture"
        }
      }),
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main"
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.sourceFixture).toMatchObject({
      dependencyCount: 1,
      dependencyInstallVerified: null,
      network: {
        mode: "none",
        egressAllowed: false
      }
    });
    expect(result.errorMessage).toContain("did not verify the dependency fixture install");
  });

  it("emits a single JSON evidence object from the CLI", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runDockerBuildRehearsalCli(
      ["--dry-run", "--json", "--commit-ref", "abc123def456", "--repo", "acme/siteflow", "--branch", "main"],
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      },
      {
        env: makeEnv(),
        commandRunner: makeDockerRunner(),
        buildExecutor: makeBuildExecutor()
      }
    );
    const parsed = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(parsed).toMatchObject({
      name: "siteflow-docker-build-rehearsal",
      status: "dry_run",
      dryRun: true,
      releaseCommit: "abc123def456",
      repository: "acme/siteflow",
      branch: "main"
    });
  });

  it("returns CLI usage errors for release identity flags without values", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runDockerBuildRehearsalCli(
      ["--commit-ref", "--repo", "acme/siteflow"],
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      },
      {
        env: makeEnv(),
        commandRunner: makeDockerRunner(),
        buildExecutor: makeBuildExecutor()
      }
    );

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--commit-ref requires a value");
  });
});
