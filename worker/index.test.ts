import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseWorkerRuntimeConfig,
  requireWorkerProductionSecret,
  runBuildWorkerLoop,
  runWorkerRuntimeHealthcheck
} from "./index";

const pinnedBuildImage = "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("SiteFlow worker entrypoint", () => {
  it("parses resident worker configuration from environment variables", () => {
    const config = parseWorkerRuntimeConfig({
      DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
      SITEFLOW_ARTIFACT_ROOT: "/tmp/siteflow/artifacts",
      SITEFLOW_BASE_DOMAIN: "w33d.xyz",
      SITEFLOW_PUBLIC_SCHEME: "http",
      SITEFLOW_SOURCE_ROOT: "/srv/siteflow/sources",
      SITEFLOW_WORKER_ID: "worker-test",
      SITEFLOW_WORKER_POLL_INTERVAL_MS: "25",
      SITEFLOW_BUILD_STEP_TIMEOUT_MS: "120000",
      SITEFLOW_GIT_TIMEOUT_MS: "60000",
      SITEFLOW_GIT_SSH_KEY_PATH: "/etc/siteflow/secrets/git-deploy-key",
      SITEFLOW_GIT_KNOWN_HOSTS_PATH: "/etc/siteflow/ssh/known_hosts",
      SITEFLOW_WORKER_RUN_ONCE: "1"
    });

    expect(config).toEqual({
      databaseUrl: "postgres://siteflow:secret@localhost:5432/siteflow",
      artifactRoot: "/tmp/siteflow/artifacts",
      baseDomain: "w33d.xyz",
      publicScheme: "http",
      sourceRoot: "/srv/siteflow/sources",
      workerId: "worker-test",
      pollIntervalMs: 25,
      buildStepTimeoutMs: 120000,
      gitTimeoutMs: 60000,
      maxArtifactBytes: 536870912,
      maxArtifactFiles: 20000,
      minBuildFreeBytes: 1073741824,
      gitSshKeyPath: "/etc/siteflow/secrets/git-deploy-key",
      gitKnownHostsPath: "/etc/siteflow/ssh/known_hosts",
      runOnce: true,
      allowUnsandboxedSourceBuilds: true,
      buildRunner: "host",
      dockerBuild: {
        image: undefined,
        imageAllowlist: undefined,
        imageTaggedTrustedExceptionAccepted: false,
        network: "none",
        memory: undefined,
        cpus: undefined,
        pidsLimit: undefined,
        user: undefined,
        cleanupStaleContainers: true,
        staleContainerMaxAgeMs: 3600000
      }
    });
  });

  it("accepts SITEFLOW_APP_SECRET_FILE for worker production startup checks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-secret-file-"));

    try {
      const appSecretPath = path.join(tempDir, "app-secret");
      await writeFile(appSecretPath, "0123456789abcdef0123456789abcdef\n", "utf8");

      expect(() =>
        requireWorkerProductionSecret({
          SITEFLOW_ENV: "production",
          SITEFLOW_APP_SECRET_FILE: appSecretPath
        })
      ).not.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects weak SITEFLOW_APP_SECRET_FILE values without exposing file contents", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-secret-file-"));

    try {
      const appSecretPath = path.join(tempDir, "app-secret");
      await writeFile(appSecretPath, "weak-worker-secret\n", "utf8");
      let message = "";

      try {
        requireWorkerProductionSecret({
          SITEFLOW_ENV: "production",
          SITEFLOW_APP_SECRET_FILE: appSecretPath
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("SITEFLOW_APP_SECRET");
      expect(message).not.toContain("weak-worker-secret");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects SITEFLOW_POSTGRES_PASSWORD_FILE into passwordless worker database URLs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-postgres-password-"));

    try {
      const passwordPath = path.join(tempDir, "postgres-password");
      await writeFile(passwordPath, "postgres-secret\n", "utf8");

      const config = parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow@localhost:5432/siteflow",
        SITEFLOW_POSTGRES_PASSWORD_FILE: passwordPath,
        SITEFLOW_BASE_DOMAIN: "w33d.xyz"
      });

      expect(config.databaseUrl).toBe("postgres://siteflow:postgres-secret@localhost:5432/siteflow");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps an explicit DATABASE_URL password ahead of SITEFLOW_POSTGRES_PASSWORD_FILE", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-postgres-password-"));

    try {
      const passwordPath = path.join(tempDir, "postgres-password");
      await writeFile(passwordPath, "file-secret\n", "utf8");

      const config = parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:url-secret@localhost:5432/siteflow",
        SITEFLOW_POSTGRES_PASSWORD_FILE: passwordPath,
        SITEFLOW_BASE_DOMAIN: "w33d.xyz"
      });

      expect(config.databaseUrl).toBe("postgres://siteflow:url-secret@localhost:5432/siteflow");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults production runtime config to the docker build runner without enabling host builds", () => {
    const config = parseWorkerRuntimeConfig({
      DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
      SITEFLOW_BASE_DOMAIN: "w33d.xyz",
      SITEFLOW_ENV: "production",
      SITEFLOW_BUILD_IMAGE: pinnedBuildImage
    });

    expect(config.allowUnsandboxedSourceBuilds).toBe(false);
    expect(config.buildRunner).toBe("docker");
    expect(config.dockerBuild.image).toBe(pinnedBuildImage);
    expect(config.dockerBuild.network).toBe("none");
    expect(config.dockerBuild.cleanupStaleContainers).toBe(true);
    expect(config.dockerBuild.staleContainerMaxAgeMs).toBe(3600000);
    expect(config.buildStepTimeoutMs).toBe(900000);
    expect(config.gitTimeoutMs).toBe(300000);
    expect(config.maxArtifactBytes).toBe(536870912);
    expect(config.maxArtifactFiles).toBe(20000);
    expect(config.minBuildFreeBytes).toBe(1073741824);
    expect(config.gitSshKeyPath).toBeUndefined();
    expect(config.gitKnownHostsPath).toBeUndefined();
  });

  it("rejects production docker builds without an explicit build image", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_ENV: "production"
      })
    ).toThrow("SITEFLOW_BUILD_IMAGE is required");
  });

  it("passes production docker worker healthcheck after validating secrets and Docker access", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-healthcheck-"));
    const logs: string[] = [];
    const dockerChecks: string[] = [];

    try {
      const appSecretPath = path.join(tempDir, "app-secret");
      await writeFile(appSecretPath, "0123456789abcdef0123456789abcdef\n", "utf8");

      await runWorkerRuntimeHealthcheck({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_ENV: "production",
        SITEFLOW_WORKER_ID: "worker-healthcheck-test",
        SITEFLOW_BUILD_IMAGE: pinnedBuildImage,
        SITEFLOW_APP_SECRET_FILE: appSecretPath
      }, {
        cwd: tempDir,
        log: (message) => logs.push(message),
        checkDockerAccess: async (cwd) => {
          dockerChecks.push(cwd);
        }
      });

      expect(dockerChecks).toEqual([tempDir]);
      expect(logs).toEqual([
        "SiteFlow build worker healthcheck passed: worker-healthcheck-test (docker).\n"
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails production docker worker healthcheck when Docker socket access is unavailable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-healthcheck-failed-"));

    try {
      const appSecretPath = path.join(tempDir, "app-secret");
      await writeFile(appSecretPath, "0123456789abcdef0123456789abcdef\n", "utf8");

      await expect(runWorkerRuntimeHealthcheck({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_ENV: "production",
        SITEFLOW_BUILD_IMAGE: pinnedBuildImage,
        SITEFLOW_APP_SECRET_FILE: appSecretPath
      }, {
        checkDockerAccess: async () => {
          throw new Error("docker socket unavailable");
        }
      })).rejects.toThrow("docker socket unavailable");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not require Docker socket access for host-runner worker healthcheck", async () => {
    let dockerChecks = 0;

    await runWorkerRuntimeHealthcheck({
      DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
      SITEFLOW_BASE_DOMAIN: "w33d.xyz",
      SITEFLOW_BUILD_RUNNER: "host"
    }, {
      checkDockerAccess: async () => {
        dockerChecks += 1;
      }
    });

    expect(dockerChecks).toBe(0);
  });

  it("rejects production docker build images that are not digest-pinned", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_ENV: "production",
        SITEFLOW_BUILD_RUNNER: "docker",
        SITEFLOW_BUILD_IMAGE: "node:20-bookworm-slim"
      })
    ).toThrow("sha256 digest");
  });

  it("rejects allowlisted production docker build image tags without an explicit trusted exception", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_ENV: "production",
        SITEFLOW_BUILD_RUNNER: "docker",
        SITEFLOW_BUILD_IMAGE: "node:20-bookworm-slim",
        SITEFLOW_BUILD_IMAGE_ALLOWLIST: "node:20-*"
      })
    ).toThrow("SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1");
  });

  it("parses explicit docker build runner resource controls", () => {
    const config = parseWorkerRuntimeConfig({
      DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
      SITEFLOW_BASE_DOMAIN: "w33d.xyz",
      SITEFLOW_ENV: "production",
      SITEFLOW_BUILD_RUNNER: "docker",
      SITEFLOW_BUILD_IMAGE: "node:20-test",
      SITEFLOW_BUILD_NETWORK: "bridge",
      SITEFLOW_BUILD_MEMORY: "512m",
      SITEFLOW_BUILD_CPUS: "0.5",
      SITEFLOW_BUILD_PIDS_LIMIT: "64",
      SITEFLOW_BUILD_USER: "1001:1001",
      SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "4096",
      SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "25",
      SITEFLOW_BUILD_MIN_FREE_BYTES: "8192",
      SITEFLOW_BUILD_IMAGE_ALLOWLIST: "node:20-*, registry.local/siteflow/*",
      SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE: "1",
      SITEFLOW_DOCKER_CLEANUP_STALE_CONTAINERS: "0",
      SITEFLOW_DOCKER_STALE_CONTAINER_MAX_AGE_MS: "120000"
    });

    expect(config).toMatchObject({
      allowUnsandboxedSourceBuilds: false,
      buildRunner: "docker",
      maxArtifactBytes: 4096,
      maxArtifactFiles: 25,
      minBuildFreeBytes: 8192,
      dockerBuild: {
        image: "node:20-test",
        imageAllowlist: ["node:20-*", "registry.local/siteflow/*"],
        imageTaggedTrustedExceptionAccepted: true,
        network: "bridge",
        memory: "512m",
        cpus: "0.5",
        pidsLimit: 64,
        user: "1001:1001",
        cleanupStaleContainers: false,
        staleContainerMaxAgeMs: 120000
      }
    });
  });

  it("allows production host source builds only when explicitly trusted", () => {
    expect(
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_ENV: "production",
        SITEFLOW_BUILD_RUNNER: "host",
        SITEFLOW_TRUSTED_SOURCE_BUILDS: "1"
      }).allowUnsandboxedSourceBuilds
    ).toBe(true);
    expect(
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        NODE_ENV: "production",
        SITEFLOW_BUILD_RUNNER: "host",
        SITEFLOW_ALLOW_UNSANDBOXED_BUILDS: "true"
      }).allowUnsandboxedSourceBuilds
    ).toBe(true);
  });

  it("rejects invalid build runner values", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_BUILD_RUNNER: "podman"
      })
    ).toThrow("SITEFLOW_BUILD_RUNNER");
  });

  it("rejects invalid poll intervals before opening the database pool", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_WORKER_POLL_INTERVAL_MS: "0"
      })
    ).toThrow("SITEFLOW_WORKER_POLL_INTERVAL_MS");
  });

  it("rejects invalid command timeout values before opening the database pool", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_BUILD_STEP_TIMEOUT_MS: "0"
      })
    ).toThrow("SITEFLOW_BUILD_STEP_TIMEOUT_MS");

    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_GIT_TIMEOUT_MS: "1.5"
      })
    ).toThrow("SITEFLOW_GIT_TIMEOUT_MS");

    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_DOCKER_STALE_CONTAINER_MAX_AGE_MS: "0"
      })
    ).toThrow("SITEFLOW_DOCKER_STALE_CONTAINER_MAX_AGE_MS");

    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "0"
      })
    ).toThrow("SITEFLOW_BUILD_MAX_ARTIFACT_BYTES");

    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "1.5"
      })
    ).toThrow("SITEFLOW_BUILD_MAX_ARTIFACT_FILES");

    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_BUILD_MIN_FREE_BYTES: "0"
      })
    ).toThrow("SITEFLOW_BUILD_MIN_FREE_BYTES");
  });

  it("rejects invalid Git credential path values before opening the database pool", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_GIT_SSH_KEY_PATH: "relative/git-deploy-key"
      })
    ).toThrow("SITEFLOW_GIT_SSH_KEY_PATH");

    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_GIT_SSH_KEY_PATH: "/etc/siteflow/secrets/git deploy key"
      })
    ).toThrow("SITEFLOW_GIT_SSH_KEY_PATH");

    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_GIT_KNOWN_HOSTS_PATH: "/etc/siteflow/ssh/known_hosts"
      })
    ).toThrow("SITEFLOW_GIT_KNOWN_HOSTS_PATH requires");
  });

  it("rejects invalid Docker image allowlist entries before opening the database pool", () => {
    expect(() =>
      parseWorkerRuntimeConfig({
        DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
        SITEFLOW_BASE_DOMAIN: "w33d.xyz",
        SITEFLOW_BUILD_IMAGE_ALLOWLIST: "node:20-bookworm-slim, bad entry"
      })
    ).toThrow("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
  });

  it("keeps run-once behavior available for tests and one-shot jobs", async () => {
    let attempts = 0;
    const logs: string[] = [];

    await runBuildWorkerLoop({
      runOnce: true,
      pollIntervalMs: 1,
      log: (message) => logs.push(message),
      processNextJob: async () => {
        attempts += 1;
        return undefined;
      }
    });

    expect(attempts).toBe(1);
    expect(logs).toEqual(["SiteFlow build worker found no queued jobs.\n"]);
  });

  it("polls until shutdown is requested in resident mode", async () => {
    const controller = new AbortController();
    let attempts = 0;

    await runBuildWorkerLoop({
      runOnce: false,
      pollIntervalMs: 1,
      signal: controller.signal,
      log: () => undefined,
      processNextJob: async () => {
        attempts += 1;

        if (attempts === 2) {
          controller.abort();
        }

        return undefined;
      }
    });

    expect(attempts).toBe(2);
  });
});
