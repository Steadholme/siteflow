import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { BuildJobResult, BuildQueue, QueuedBuildJob, SourceResolver } from "./buildWorker";
import { assertBuildStoragePreflight, executeBuildJob, runBuildWorkerOnce } from "./buildWorker";
import { detectBuildSettings } from "./frameworkDetector";
import { LocalSourceResolver } from "./localSourceResolver";

const trustedHostBuildPathTestTimeoutMs = 30_000;

function queuedJob(sourceDirectory: string): QueuedBuildJob {
  return {
    id: "build_test_1",
    projectId: "project_docs",
    projectSlug: "docs",
    productionBranch: "main",
    sourceEventId: "src_test_1",
    sourceEvent: {
      id: "src_test_1",
      projectId: "project_docs",
      kind: "push",
      status: "accepted",
      disposition: "build_requested",
      providerDeliveryId: "delivery-1",
      branch: "feature/preview",
      commitSha: "4f3a9c2d1b0e",
      commitMessage: "Ship preview",
      commitAuthor: "Ada Lovelace",
      receivedAt: "2026-05-26T00:00:00.000Z",
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
        localPath: sourceDirectory
      }
    },
    buildSettings: {
      framework: "static",
      installCommand: "",
      buildCommand: "npm run build",
      outputDirectory: "dist"
    }
  };
}

class MemoryBuildQueue implements BuildQueue {
  readonly logs: string[] = [];
  heartbeatCount = 0;
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

  async heartbeatJob(): Promise<void> {
    this.heartbeatCount += 1;
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

async function createTinySourceProject(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        build: "node build.mjs"
      }
    })
  );
  await writeFile(
    path.join(root, "build.mjs"),
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "await mkdir('dist', { recursive: true });",
      "console.log('building with SITEFLOW_SECRET_CANARY_20260515');",
      "await writeFile('dist/index.html', '<h1>SiteFlow Preview</h1>');"
    ].join("\n")
  );
}

async function createAutoViteSourceProject(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        build: "node build.mjs"
      },
      devDependencies: {
        vite: "^5.4.11"
      }
    })
  );
  await writeFile(
    path.join(root, "build.mjs"),
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "await mkdir('dist', { recursive: true });",
      "await writeFile('dist/index.html', '<h1>Auto Vite Preview</h1>');"
    ].join("\n")
  );
}

async function createEnvAwareSourceProject(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        build: "node build.mjs"
      }
    })
  );
  await writeFile(
    path.join(root, "build.mjs"),
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "await mkdir('dist', { recursive: true });",
      "console.log(`secret=${process.env.SITEFLOW_BUILD_SECRET}`);",
      "console.log(`config=${process.env.SITEFLOW_CONFIG_SECRET}`);",
      "console.log(`ignored=${process.env.IGNORED_OBJECT}`);",
      "await writeFile('dist/index.html', `<h1>${process.env.SITEFLOW_PUBLIC_FLAG}</h1>`);"
    ].join("\n")
  );
}

async function createSlowSourceProject(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        build: "node build.mjs"
      }
    })
  );
  await writeFile(
    path.join(root, "build.mjs"),
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "await new Promise((resolve) => setTimeout(resolve, 50));",
      "await mkdir('dist', { recursive: true });",
      "await writeFile('dist/index.html', '<h1>Slow Preview</h1>');"
    ].join("\n")
  );
}

async function createCommandProbeSourceProject(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        test: "node install-probe.mjs",
        build: "node build.mjs"
      }
    })
  );
  await writeFile(
    path.join(root, "install-probe.mjs"),
    [
      "import { writeFile } from 'node:fs/promises';",
      "await writeFile('install-ran.txt', 'yes');"
    ].join("\n")
  );
  await writeFile(
    path.join(root, "build.mjs"),
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "await mkdir('dist', { recursive: true });",
      "await writeFile('dist/index.html', '<h1>Trusted Preview</h1>');"
    ].join("\n")
  );
}

describe("SiteFlow build worker", () => {
  it("checks build storage capacity before source checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-storage-preflight-"));
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");
    let checkoutCalled = false;
    const sourceResolver: SourceResolver = {
      checkout: async () => {
        checkoutCalled = true;
        throw new Error("checkout should not run");
      }
    };

    try {
      await expect(assertBuildStoragePreflight({
        workspaceRoot,
        artifactRoot,
        minFreeBytes: 1
      })).resolves.toBeUndefined();
      await expect(executeBuildJob(queuedJob(path.join(root, "source")), {
        sourceResolver,
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        allowUnsandboxedSourceBuilds: true,
        minBuildFreeBytes: Number.MAX_SAFE_INTEGER
      })).rejects.toThrow("SITEFLOW_BUILD_MIN_FREE_BYTES preflight failed");
      expect(checkoutCalled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects networked Docker builds with sensitive build environment variables without leaking values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-network-secret-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      const job = {
        ...queuedJob(sourceDirectory),
        environmentVariables: {
          SITEFLOW_CONFIG_SECRET: "network-secret-value-20260608"
        }
      };

      await expect(executeBuildJob(job, {
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        buildRunner: "docker",
        dockerBuild: {
          network: "bridge"
        }
      })).rejects.toThrow("Networked Docker builds cannot receive sensitive build environment variables: SITEFLOW_CONFIG_SECRET");
      await expect(executeBuildJob(job, {
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        buildRunner: "docker",
        dockerBuild: {
          network: "bridge"
        }
      })).rejects.not.toThrow("network-secret-value-20260608");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows networked Docker builds to proceed when build environment variables are public", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-network-public-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await writeFile(path.join(sourceDirectory, "vercel.json"), JSON.stringify({
        git: {
          deploymentEnabled: false
        }
      }));
      const job = {
        ...queuedJob(sourceDirectory),
        environmentVariables: {
          NEXT_PUBLIC_FLAG: "public-value"
        }
      };

      await expect(executeBuildJob(job, {
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        buildRunner: "docker",
        dockerBuild: {
          network: "bridge"
        }
      })).rejects.toThrow("Build skipped by git.deploymentEnabled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claims a queued source build, redacts logs, and publishes an immutable preview artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-test-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      const job = queuedJob(sourceDirectory);
      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.previewUrl).toMatch(/^https:\/\/docs-4f3a9c2d1b0e-[a-f0-9]{8}\.w33d\.xyz$/);
      expect(queue.completed?.deploymentId).toBe(result?.deploymentId);
      expect(queue.failed).toBeUndefined();
      expect(queue.logs.join("\n")).toContain("[REDACTED]");
      expect(queue.logs.join("\n")).not.toContain("SITEFLOW_SECRET_CANARY_20260515");
      expect(result?.artifact.manifest.metadata).toMatchObject({
        buildJobId: "build_test_1",
        sourceEventId: "src_test_1",
        branch: "feature/preview",
        commitSha: "4f3a9c2d1b0e",
        environment: "preview",
        routing: {}
      });
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html"), "utf8")).toContain("SiteFlow Preview");
      expect(brotliDecompressSync(await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html.br"))).toString("utf8"))
        .toContain("SiteFlow Preview");
      expect(gunzipSync(await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html.gz"))).toString("utf8"))
        .toContain("SiteFlow Preview");
      expect(result?.artifact.manifest.metadata).toMatchObject({
        precompressed: {
          br: 1,
          gzip: 1
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a stable production host and publishes only non-sensitive client build env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-production-client-env-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      const baseJob = queuedJob(sourceDirectory);
      const job: QueuedBuildJob = {
        ...baseJob,
        sourceEvent: {
          ...baseJob.sourceEvent,
          branch: "main"
        },
        environmentVariables: {
          CISTERN_REST_URL: "https://cistern.example.test",
          CISTERN_SERVICE_KEY: "service-secret-value-20260706"
        }
      };

      const result = await executeBuildJob(job, {
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        allowUnsandboxedSourceBuilds: true
      });
      const envJs = await readFile(path.join(result.artifact.artifactRoot, "__siteflow", "env.js"), "utf8");

      expect(result.productionHost).toBe("docs.w33d.xyz");
      expect(result.artifact.manifest.metadata).toMatchObject({
        environment: "production"
      });
      expect(envJs).toContain('"CISTERN_REST_URL":"https://cistern.example.test"');
      expect(envJs).not.toContain("CISTERN_SERVICE_KEY");
      expect(envJs).not.toContain("service-secret-value-20260706");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked output root that resolves outside the project root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-output-realpath-"));
    const sourceDirectory = path.join(root, "source");
    const outsideOutputRoot = path.join(root, "outside-output");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");
    const outputDirectory = "linked-output/dist";
    const job = {
      ...queuedJob("unused"),
      buildSettings: {
        ...queuedJob("unused").buildSettings,
        installCommand: "",
        buildCommand: "",
        outputDirectory
      }
    };
    const sourceResolver: SourceResolver = {
      checkout: async () => ({
        sourceDirectory
      })
    };
    const queue = new MemoryBuildQueue(job);

    try {
      await mkdir(path.join(outsideOutputRoot, "dist"), { recursive: true });
      await writeFile(path.join(outsideOutputRoot, "dist", "index.html"), "<h1>Outside Output</h1>");
      await mkdir(sourceDirectory, { recursive: true });

      try {
        await symlink(outsideOutputRoot, path.join(sourceDirectory, "linked-output"), "dir");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EPERM", "EINVAL"].includes(String(error.code))) {
          return;
        }

        throw error;
      }

      await expect(runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver,
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      })).rejects.toThrow(`Build output directory resolves outside the project root: ${outputDirectory}.`);
      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toBe(`Build output directory resolves outside the project root: ${outputDirectory}.`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes from a regular nested output root after realpath validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-output-normal-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");
    const job = {
      ...queuedJob("unused"),
      buildSettings: {
        ...queuedJob("unused").buildSettings,
        installCommand: "",
        buildCommand: "",
        outputDirectory: "nested/dist"
      }
    };
    const sourceResolver: SourceResolver = {
      checkout: async () => ({
        sourceDirectory
      })
    };

    try {
      await mkdir(path.join(sourceDirectory, "nested", "dist"), { recursive: true });
      await writeFile(path.join(sourceDirectory, "nested", "dist", "index.html"), "<h1>Nested Output</h1>");

      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver,
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.entrypoint).toBe("index.html");
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html"), "utf8")).toContain("Nested Output");
      expect(queue.failed).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes an internally-created temp workspace after executing a build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-temp-cleanup-"));
    const artifactRoot = path.join(root, "artifacts");
    const job = {
      ...queuedJob("unused"),
      buildSettings: {
        ...queuedJob("unused").buildSettings,
        installCommand: "",
        buildCommand: "",
        outputDirectory: "dist"
      }
    };
    let tempWorkspaceRoot = "";
    let cleanupCalled = false;
    const sourceResolver: SourceResolver = {
      checkout: async (checkoutJob, workspaceRoot) => {
        tempWorkspaceRoot = workspaceRoot;
        const sourceDirectory = path.join(workspaceRoot, checkoutJob.id, "source");

        await mkdir(path.join(sourceDirectory, "dist"), { recursive: true });
        await writeFile(path.join(sourceDirectory, "dist", "index.html"), "<h1>Temp Workspace</h1>");

        return {
          sourceDirectory,
          cleanup: async () => {
            cleanupCalled = true;
          }
        };
      }
    };

    try {
      const result = await executeBuildJob(job, {
        sourceResolver,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result.artifact.manifest.entrypoint).toBe("index.html");
      expect(cleanupCalled).toBe(true);
      expect(tempWorkspaceRoot).toContain("siteflow-worker-");
      await expect(stat(tempWorkspaceRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      if (tempWorkspaceRoot) {
        await rm(tempWorkspaceRoot, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes an internally-created temp workspace when checkout fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-temp-checkout-fail-"));
    let tempWorkspaceRoot = "";
    const sourceResolver: SourceResolver = {
      checkout: async (_checkoutJob, workspaceRoot) => {
        tempWorkspaceRoot = workspaceRoot;
        await mkdir(path.join(workspaceRoot, "partial"), { recursive: true });
        throw new Error("checkout failed");
      }
    };

    try {
      await expect(executeBuildJob(queuedJob("unused"), {
        sourceResolver,
        artifactRoot: path.join(root, "artifacts"),
        baseDomain: "w33d.xyz"
      })).rejects.toThrow("checkout failed");
      expect(tempWorkspaceRoot).toContain("siteflow-worker-");
      await expect(stat(tempWorkspaceRoot)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      if (tempWorkspaceRoot) {
        await rm(tempWorkspaceRoot, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a caller-provided workspace root after executing a build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-provided-workspace-"));
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");
    const markerPath = path.join(workspaceRoot, "caller-marker.txt");
    const job = {
      ...queuedJob("unused"),
      buildSettings: {
        ...queuedJob("unused").buildSettings,
        installCommand: "",
        buildCommand: "",
        outputDirectory: "dist"
      }
    };
    const sourceResolver: SourceResolver = {
      checkout: async (checkoutJob, providedWorkspaceRoot) => {
        const jobRoot = path.join(providedWorkspaceRoot, checkoutJob.id);
        const sourceDirectory = path.join(jobRoot, "source");

        await mkdir(path.join(sourceDirectory, "dist"), { recursive: true });
        await writeFile(path.join(sourceDirectory, "dist", "index.html"), "<h1>Provided Workspace</h1>");

        return {
          sourceDirectory,
          cleanup: async () => {
            await rm(jobRoot, { recursive: true, force: true });
          }
        };
      }
    };

    try {
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(markerPath, "keep", "utf8");

      const result = await executeBuildJob(job, {
        sourceResolver,
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result.artifact.manifest.entrypoint).toBe("index.html");
      expect(await readFile(markerPath, "utf8")).toBe("keep");
      expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
      await expect(stat(path.join(workspaceRoot, job.id))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renews the build job heartbeat while a job is running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-heartbeat-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createSlowSourceProject(sourceDirectory);
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https",
        jobHeartbeatIntervalMs: 5
      });

      expect(result?.artifact.manifest.entrypoint).toBe("index.html");
      expect(queue.heartbeatCount).toBeGreaterThan(0);
      expect(queue.failed).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects production unsafe source builds before running install or build commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-unsafe-guard-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createCommandProbeSourceProject(sourceDirectory);
      const job = {
        ...queuedJob(sourceDirectory),
        buildSettings: {
          ...queuedJob(sourceDirectory).buildSettings,
          installCommand: "npm test",
          buildCommand: "npm run build"
        }
      };
      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https",
        allowUnsandboxedSourceBuilds: false,
        buildRunner: "host"
      });
      const logs = queue.logs.join("\n");

      expect(result).toBeUndefined();
      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toContain("skipped:Production source build rejected");
      expect(logs).toContain("Production source build rejected");
      expect(logs).not.toContain("$ npm test");
      expect(logs).not.toContain("$ npm run build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows production source builds when the docker runner is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-docker-guard-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await mkdir(path.join(sourceDirectory, "dist"), { recursive: true });
      await writeFile(path.join(sourceDirectory, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(path.join(sourceDirectory, "dist", "index.html"), "<h1>Docker Guard Preview</h1>");
      const job = {
        ...queuedJob(sourceDirectory),
        buildSettings: {
          ...queuedJob(sourceDirectory).buildSettings,
          installCommand: "",
          buildCommand: "",
          outputDirectory: "dist"
        }
      };
      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https",
        allowUnsandboxedSourceBuilds: false,
        buildRunner: "docker"
      });
      const logs = queue.logs.join("\n");

      expect(result?.artifact.manifest.entrypoint).toBe("index.html");
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html"), "utf8")).toContain("Docker Guard Preview");
      expect(queue.completed?.deploymentId).toBe(result?.deploymentId);
      expect(queue.failed).toBeUndefined();
      expect(logs).not.toContain("Production source build rejected");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the existing source build path when unsandboxed source builds are explicitly trusted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-trusted-build-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createCommandProbeSourceProject(sourceDirectory);
      const job = {
        ...queuedJob(sourceDirectory),
        buildSettings: {
          ...queuedJob(sourceDirectory).buildSettings,
          installCommand: "npm test",
          buildCommand: "npm run build"
        }
      };
      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https",
        allowUnsandboxedSourceBuilds: true,
        buildRunner: "host"
      });
      const logs = queue.logs.join("\n");

      expect(result?.artifact.manifest.entrypoint).toBe("index.html");
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html"), "utf8")).toContain("Trusted Preview");
      expect(queue.completed?.deploymentId).toBe(result?.deploymentId);
      expect(queue.failed).toBeUndefined();
      expect(logs).toContain("$ npm test");
      expect(logs).toContain("$ npm run build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, trustedHostBuildPathTestTimeoutMs);

  it("detects Node.js functions and publishes them with the artifact manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-functions-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "revalidate.js"),
        [
          "export default async function handler(request) {",
          "  return { status: 200, body: { ok: true, method: request.method } };",
          "}"
        ].join("\n")
      );

      const job = queuedJob(sourceDirectory);
      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.functions).toEqual([
        {
          path: "/api/revalidate",
          sourcePath: ".siteflow/functions/api/revalidate.js",
          runtime: "nodejs20.x",
          runtimeIsolation: "same_process",
          handler: "default",
          apiStyle: "fetch"
        }
      ]);
      expect(queue.logs.join("\n")).toContain("Detected 1 Node.js function.");
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "api", "revalidate.js"), "utf8"))
        .toContain("export default async function handler");
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "package.json"), "utf8"))
        .toContain('"type":"module"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects Vercel req/res API functions and lets vercel.json force fetch style", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-api-style-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "auto.js"),
        [
          "export default function handler(req, res) {",
          "  res.status(200).json({ ok: true });",
          "}"
        ].join("\n")
      );
      await writeFile(
        path.join(sourceDirectory, "api", "forced.js"),
        [
          "export default function handler(req, res) {",
          "  res.status(200).json({ ok: true });",
          "}"
        ].join("\n")
      );
      await writeFile(
        path.join(sourceDirectory, "api", "proxy.js"),
        [
          // Fetch-style handler (2nd param is context) that names an upstream fetch Response `res`.
          // The sniff must NOT flip this to node on the raw `res.json(` text or the handler breaks.
          "export default async function handler(request, context) {",
          "  const res = await fetch('https://upstream.example');",
          "  return Response.json(await res.json());",
          "}"
        ].join("\n")
      );
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          functions: {
            "api/forced.js": {
              api: "fetch"
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.functions).toHaveLength(3);
      expect(result?.artifact.manifest.functions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "/api/auto",
          apiStyle: "node"
        }),
        expect.objectContaining({
          path: "/api/forced",
          apiStyle: "fetch"
        }),
        expect.objectContaining({
          path: "/api/proxy",
          apiStyle: "fetch"
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked api directories before publishing function artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-api-symlink-"));
    const sourceDirectory = path.join(root, "source");
    const outsideApiDirectory = path.join(root, "outside-api");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(outsideApiDirectory, { recursive: true });
      await writeFile(
        path.join(outsideApiDirectory, "leak.js"),
        "export default async function handler() { return { status: 200 }; }"
      );

      try {
        await symlink(outsideApiDirectory, path.join(sourceDirectory, "api"), "dir");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EPERM", "EINVAL"].includes(String(error.code))) {
          return;
        }

        throw error;
      }

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));

      await expect(runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      })).rejects.toThrow("Function api directory must not be a symlink: api.");
      expect(queue.failed).toContain("Function api directory must not be a symlink: api.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies vercel.json function runtime overrides to detected API functions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-config-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "revalidate.js"),
        [
          "export default async function handler() {",
          "  return { status: 200, body: { ok: true } };",
          "}"
        ].join("\n")
      );
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          fluid: true,
          functions: {
            "api/revalidate.js": {
              maxDuration: 3,
              memory: 256,
              concurrency: 7
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.functions).toEqual([
        {
          path: "/api/revalidate",
          sourcePath: ".siteflow/functions/api/revalidate.js",
          runtime: "nodejs20.x",
          runtimeIsolation: "same_process",
          handler: "default",
          apiStyle: "fetch",
          timeoutMs: 3000,
          concurrency: 7
        }
      ]);
      expect(result?.artifact.manifest.metadata).toMatchObject({
        fluid: true
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies vercel.json function region metadata to detected API functions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-regions-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "default.js"),
        [
          "export default async function handler() {",
          "  return { status: 200, body: { ok: true } };",
          "}"
        ].join("\n")
      );
      await writeFile(
        path.join(sourceDirectory, "api", "edge.js"),
        [
          "export default async function handler() {",
          "  return { status: 200, body: { edge: true } };",
          "}"
        ].join("\n")
      );
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          regions: ["iad1"],
          functionFailoverRegions: ["dub1"],
          functions: {
            "api/edge.js": {
              regions: "sfo1",
              functionFailoverRegions: ["iad1"]
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.functions).toEqual([
        {
          path: "/api/default",
          sourcePath: ".siteflow/functions/api/default.js",
          runtime: "nodejs20.x",
          runtimeIsolation: "same_process",
          handler: "default",
          apiStyle: "fetch",
          regions: ["iad1"],
          failoverRegions: ["dub1"]
        },
        {
          path: "/api/edge",
          sourcePath: ".siteflow/functions/api/edge.js",
          runtime: "nodejs20.x",
          runtimeIsolation: "same_process",
          handler: "default",
          apiStyle: "fetch",
          regions: ["sfo1"],
          failoverRegions: ["iad1"]
        }
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bundles vercel.json function includeFiles with detected API functions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-includes-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await mkdir(path.join(sourceDirectory, "data"), { recursive: true });
      await mkdir(path.join(sourceDirectory, "secrets"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "lookup.js"),
        [
          "import { readFile } from 'node:fs/promises';",
          "export default async function handler() {",
          "  const content = await readFile(new URL('../data/config.json', import.meta.url), 'utf8');",
          "  return { status: 200, body: JSON.parse(content) };",
          "}"
        ].join("\n")
      );
      await writeFile(path.join(sourceDirectory, "data", "config.json"), JSON.stringify({ region: "iad1" }));
      await writeFile(path.join(sourceDirectory, "secrets", "ignored.txt"), "do-not-bundle");
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          functions: {
            "api/lookup.js": {
              includeFiles: ["data/**/*.json"]
            },
            "api/missing.js": {
              includeFiles: ["secrets/*.txt"]
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.fileCount).toBe(6);
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "data", "config.json"), "utf8"))
        .toContain("iad1");
      await expect(readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "data", "config.json.br"), "utf8"))
        .rejects.toThrow();
      await expect(readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "secrets", "ignored.txt"), "utf8"))
        .rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects vercel.json function includeFiles that resolve through symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-include-symlink-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");
    const outsideSecret = path.join(root, "outside-secret.json");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await mkdir(path.join(sourceDirectory, "data"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "lookup.js"),
        [
          "export default async function handler() {",
          "  return { status: 200, body: { ok: true } };",
          "}"
        ].join("\n")
      );
      await writeFile(outsideSecret, JSON.stringify({ token: "outside" }));

      try {
        await symlink(outsideSecret, path.join(sourceDirectory, "data", "linked.json"), "file");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EPERM", "EINVAL"].includes(String(error.code))) {
          return;
        }

        throw error;
      }

      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          functions: {
            "api/lookup.js": {
              includeFiles: ["data/**/*.json"]
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));

      await expect(runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      })).rejects.toThrow("Function includeFiles entry must not be a symlink: data/linked.json.");
      expect(queue.failed).toContain("Function includeFiles entry must not be a symlink: data/linked.json.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects vercel.json function includeFiles that match secret-like paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-include-secret-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await mkdir(path.join(sourceDirectory, "data"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "lookup.js"),
        [
          "export default async function handler() {",
          "  return { status: 200, body: { ok: true } };",
          "}"
        ].join("\n")
      );
      await writeFile(path.join(sourceDirectory, "data", ".env"), "DATABASE_URL=postgres://secret");
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          functions: {
            "api/lookup.js": {
              includeFiles: ["data/**"]
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));

      await expect(runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      })).rejects.toThrow("Function includeFiles entry is blocked because it looks like a .env file: data/.env.");
      expect(queue.failed).toContain("Function includeFiles entry is blocked because it looks like a .env file: data/.env.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes vercel.json function excludeFiles from included function bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-function-excludes-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await mkdir(path.join(sourceDirectory, "api"), { recursive: true });
      await mkdir(path.join(sourceDirectory, "data", "private"), { recursive: true });
      await writeFile(
        path.join(sourceDirectory, "api", "lookup.js"),
        [
          "export default async function handler() {",
          "  return { status: 200, body: { ok: true } };",
          "}"
        ].join("\n")
      );
      await writeFile(path.join(sourceDirectory, "data", "public.json"), JSON.stringify({ visibility: "public" }));
      await writeFile(path.join(sourceDirectory, "data", ".env"), "DATABASE_URL=postgres://excluded");
      await writeFile(path.join(sourceDirectory, "data", "private", "secret.json"), JSON.stringify({ visibility: "private" }));
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          functions: {
            "api/lookup.js": {
              includeFiles: ["data/**"],
              excludeFiles: ["data/.env", "data/private/**"]
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "data", "public.json"), "utf8"))
        .toContain("public");
      await expect(readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "data", ".env"), "utf8"))
        .rejects.toThrow();
      await expect(readFile(path.join(result?.artifact.artifactRoot ?? "", ".siteflow", "functions", "data", "private", "secret.json"), "utf8"))
        .rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-detects Vite build settings from package.json before publishing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-vite-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createAutoViteSourceProject(sourceDirectory);
      const job = {
        ...queuedJob(sourceDirectory),
        buildSettings: {
          framework: "auto",
          installCommand: "",
          buildCommand: "",
          outputDirectory: "dist"
        }
      };
      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.metadata.framework).toBe("vite");
      expect(queue.logs.join("\n")).toContain("Resolved build settings: framework=vite, output=dist.");
      expect(await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html"), "utf8")).toContain("Auto Vite Preview");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports vercel.json routing and cron config into source build results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-app-config-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          cleanUrls: true,
          trailingSlash: false,
          skipTrailingSlashRedirect: true,
          public: true,
          fluid: null,
          bunVersion: "1.x",
          env: {
            RUNTIME_SECRET: "runtime-secret-20260527",
            PUBLIC_RUNTIME_FLAG: "enabled",
            IGNORED_RUNTIME_OBJECT: {
              nested: true
            }
          },
          images: {
            sizes: [320, 640],
            qualities: [70, 80],
            formats: ["image/webp"],
            minimumCacheTTL: 120,
            dangerouslyAllowSVG: true,
            contentSecurityPolicy: "script-src 'none'; sandbox;",
            contentDispositionType: "inline"
          },
          redirects: [
            {
              source: "/docs",
              destination: "/documentation",
              permanent: true
            }
          ],
          rewrites: [
            {
              source: "/blog/:slug",
              destination: "/posts/:slug.html"
            }
          ],
          headers: [
            {
              source: "/(.*)",
              headers: [
                {
                  key: "x-frame-options",
                  value: "DENY"
                }
              ]
            }
          ],
          crons: [
            {
              path: "/api/revalidate",
              schedule: "0 * * * *"
            }
          ]
        })
      );
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.metadata).toMatchObject({
        public: true,
        fluid: null,
        bunVersion: "1.x",
        runtimeEnvKeys: ["PUBLIC_RUNTIME_FLAG", "RUNTIME_SECRET"],
        images: {
          sizes: [320, 640],
          qualities: [70, 80],
          formats: ["image/webp"],
          minimumCacheTTL: 120,
          dangerouslyAllowSVG: true,
          contentSecurityPolicy: "script-src 'none'; sandbox;",
          contentDispositionType: "inline"
        },
        routing: {
          cleanUrls: true,
          trailingSlash: false,
          skipTrailingSlashRedirect: true,
          redirects: [
            {
              source: "/docs",
              destination: "/documentation",
              statusCode: 308
            }
          ],
          rewrites: [
            {
              source: "/blog/:slug",
              destination: "/posts/:slug.html"
            }
          ],
          headers: [
            {
              source: "/(.*)",
              headers: [
                {
                  key: "x-frame-options",
                  value: "DENY"
                }
              ]
            }
          ]
        }
      });
      expect(result?.artifact.manifest.metadata.sealedRuntimeEnv).toMatchObject({
        RUNTIME_SECRET: expect.stringMatching(/^sfseal:v1:/),
        PUBLIC_RUNTIME_FLAG: expect.stringMatching(/^sfseal:v1:/)
      });
      expect(result?.artifact.manifest.metadata.sealedRuntimeEnv).not.toHaveProperty("IGNORED_RUNTIME_OBJECT");
      expect(JSON.stringify(result?.artifact.manifest.metadata)).not.toContain("runtime-secret-20260527");
      expect(result?.crons).toEqual([
        {
          path: "/api/revalidate",
          schedule: "0 * * * *"
        }
      ]);
      expect(queue.completed?.crons).toEqual(result?.crons);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores unsupported vercel.json bunVersion values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-bun-version-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          bunVersion: "2.x"
        })
      );
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.artifact.manifest.metadata).not.toHaveProperty("bunVersion");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies vercel.json build setting overrides from the checkout root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-vercel-json-"));
    const sourceDirectory = path.join(root, "source");

    try {
      await createAutoViteSourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          framework: "vite",
          installCommand: "",
          buildCommand: "npm run build",
          outputDirectory: "public",
          ignoreCommand: "npm test"
        })
      );

      await expect(detectBuildSettings(sourceDirectory, queuedJob(sourceDirectory).buildSettings)).resolves.toMatchObject({
        framework: "vite",
        installCommand: "",
        buildCommand: "npm run build",
        outputDirectory: "public",
        ignoreCommand: "npm test"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit build settings when package.json detection disagrees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-explicit-"));
    const sourceDirectory = path.join(root, "source");

    try {
      await createAutoViteSourceProject(sourceDirectory);

      await expect(detectBuildSettings(sourceDirectory, {
        framework: "custom-static",
        installCommand: "",
        buildCommand: "npm run build",
        outputDirectory: "build"
      })).resolves.toMatchObject({
        framework: "custom-static",
        buildCommand: "npm run build",
        outputDirectory: "build"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects build environment variables and redacts their values from logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-env-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");
    const secret = "env-secret-20260527";
    const configSecret = "config-secret-20260527";

    try {
      await createEnvAwareSourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          build: {
            env: {
              SITEFLOW_PUBLIC_FLAG: "From vercel.json",
              SITEFLOW_CONFIG_SECRET: configSecret,
              IGNORED_OBJECT: {
                nested: true
              }
            }
          }
        })
      );
      const job = {
        ...queuedJob(sourceDirectory),
        environmentVariables: {
          SITEFLOW_BUILD_SECRET: secret,
          SITEFLOW_PUBLIC_FLAG: "Injected Preview"
        }
      };
      const queue = new MemoryBuildQueue(job);
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });
      const logs = queue.logs.join("\n");

      expect(logs).toContain("secret=[REDACTED]");
      expect(logs).not.toContain(secret);
      expect(logs).toContain("config=[REDACTED]");
      expect(logs).toContain("ignored=undefined");
      expect(logs).not.toContain(configSecret);
      expect(result?.artifact.manifest.metadata).toMatchObject({
        buildEnvKeys: ["SITEFLOW_CONFIG_SECRET", "SITEFLOW_PUBLIC_FLAG"]
      });
      const indexHtml = await readFile(path.join(result?.artifact.artifactRoot ?? "", "index.html"), "utf8");

      expect(indexHtml).toContain("Injected Preview");
      expect(indexHtml).not.toContain(configSecret);
      expect(indexHtml).not.toContain("From vercel.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails builds when sensitive build environment values are written to public artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-env-leak-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");
    const secret = "config-secret-20260527";

    try {
      await createEnvAwareSourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "build.mjs"),
        [
          "import { mkdir, writeFile } from 'node:fs/promises';",
          "await mkdir('dist', { recursive: true });",
          "console.log(`config=${process.env.SITEFLOW_CONFIG_SECRET}`);",
          "await writeFile('dist/index.html', `<p>${process.env.SITEFLOW_CONFIG_SECRET}</p>`);"
        ].join("\n")
      );
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          build: {
            env: {
              SITEFLOW_CONFIG_SECRET: secret
            }
          }
        })
      );
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));

      await expect(runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      })).rejects.toThrow("Build artifact contains blocked secret value for SITEFLOW_CONFIG_SECRET in index.html.");

      expect(queue.failed).toContain("Build artifact contains blocked secret value for SITEFLOW_CONFIG_SECRET in index.html.");
      expect(queue.failed).not.toContain(secret);
      expect(queue.logs.join("\n")).not.toContain(secret);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips builds when vercel.json ignoreCommand exits successfully", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-ignore-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            build: "node build.mjs",
            test: "node -e \"process.exit(0)\""
          }
        })
      );
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          ignoreCommand: "npm test"
        })
      );
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result).toBeUndefined();
      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toContain("skipped:Build skipped by ignoreCommand: npm test.");
      expect(queue.logs.join("\n")).toContain("$ npm test");
      expect(queue.logs.join("\n")).toContain("Build skipped by ignoreCommand: npm test.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips source builds when vercel.json git deployment is disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-git-disabled-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          git: {
            deploymentEnabled: false
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result).toBeUndefined();
      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toBe("skipped:Build skipped by git.deploymentEnabled for branch feature/preview.");
      expect(queue.logs.join("\n")).not.toContain("$ npm run build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips source builds when vercel.json git deployment branch rules disable the branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-git-branch-disabled-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          git: {
            deploymentEnabled: {
              "feature/*": false,
              main: true
            }
          }
        })
      );

      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result).toBeUndefined();
      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toBe("skipped:Build skipped by git.deploymentEnabled for branch feature/preview.");
      expect(queue.logs.join("\n")).not.toContain("$ npm run build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues builds when vercel.json ignoreCommand exits non-zero", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-ignore-continue-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      await writeFile(
        path.join(sourceDirectory, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            build: "node build.mjs",
            test: "node -e \"process.exit(1)\""
          }
        })
      );
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          ignoreCommand: "npm test"
        })
      );
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));
      const result = await runBuildWorkerOnce({
        workerId: "worker-test",
        queue,
        sourceResolver: new LocalSourceResolver(),
        workspaceRoot,
        artifactRoot,
        baseDomain: "w33d.xyz",
        publicScheme: "https"
      });

      expect(result?.deploymentId).toBeDefined();
      expect(queue.completed?.deploymentId).toBe(result?.deploymentId);
      expect(queue.failed).toBeUndefined();
      expect(queue.logs.join("\n")).toContain("ignoreCommand exited with code 1; continuing build.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the build when the published artifact exceeds the byte budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-artifact-bytes-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));

      await expect(
        runBuildWorkerOnce({
          workerId: "worker-test",
          queue,
          sourceResolver: new LocalSourceResolver(),
          workspaceRoot,
          artifactRoot,
          baseDomain: "w33d.xyz",
          publicScheme: "https",
          maxArtifactBytes: 10
        })
      ).rejects.toThrow("SITEFLOW_BUILD_MAX_ARTIFACT_BYTES");

      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toContain("SITEFLOW_BUILD_MAX_ARTIFACT_BYTES");
      expect(queue.logs.join("\n")).toContain("SITEFLOW_BUILD_MAX_ARTIFACT_BYTES");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the build when precompressed artifacts exceed the final file budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-artifact-files-"));
    const sourceDirectory = path.join(root, "source");
    const workspaceRoot = path.join(root, "workspace");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await createTinySourceProject(sourceDirectory);
      const queue = new MemoryBuildQueue(queuedJob(sourceDirectory));

      await expect(
        runBuildWorkerOnce({
          workerId: "worker-test",
          queue,
          sourceResolver: new LocalSourceResolver(),
          workspaceRoot,
          artifactRoot,
          baseDomain: "w33d.xyz",
          publicScheme: "https",
          maxArtifactBytes: 1024 * 1024,
          maxArtifactFiles: 1
        })
      ).rejects.toThrow("SITEFLOW_BUILD_MAX_ARTIFACT_FILES");

      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toContain("SITEFLOW_BUILD_MAX_ARTIFACT_FILES");
      expect(queue.logs.join("\n")).toContain("SITEFLOW_BUILD_MAX_ARTIFACT_FILES");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects build commands outside the allowlist and marks the job failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-worker-command-"));
    const sourceDirectory = path.join(root, "source");

    try {
      await createTinySourceProject(sourceDirectory);
      const job = {
        ...queuedJob(sourceDirectory),
        buildSettings: {
          ...queuedJob(sourceDirectory).buildSettings,
          buildCommand: "curl https://example.com/script.sh"
        }
      };
      const queue = new MemoryBuildQueue(job);

      await expect(
        runBuildWorkerOnce({
          workerId: "worker-test",
          queue,
          sourceResolver: new LocalSourceResolver(),
          workspaceRoot: path.join(root, "workspace"),
          artifactRoot: path.join(root, "artifacts"),
          baseDomain: "w33d.xyz"
        })
      ).rejects.toThrow(/not allowed/i);

      expect(queue.completed).toBeUndefined();
      expect(queue.failed).toMatch(/not allowed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
