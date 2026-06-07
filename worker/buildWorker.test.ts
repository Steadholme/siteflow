import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { BuildJobResult, BuildQueue, QueuedBuildJob } from "./buildWorker";
import { runBuildWorkerOnce } from "./buildWorker";
import { detectBuildSettings } from "./frameworkDetector";
import { LocalSourceResolver } from "./localSourceResolver";

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
      "await writeFile('dist/index.html', `<h1>${process.env.SITEFLOW_PUBLIC_FLAG}</h1><p>${process.env.SITEFLOW_CONFIG_SECRET}</p>`);"
    ].join("\n")
  );
}

describe("SiteFlow build worker", () => {
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
          handler: "default"
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
          handler: "default",
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
          handler: "default",
          regions: ["iad1"],
          failoverRegions: ["dub1"]
        },
        {
          path: "/api/edge",
          sourcePath: ".siteflow/functions/api/edge.js",
          runtime: "nodejs20.x",
          handler: "default",
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
      await writeFile(path.join(sourceDirectory, "data", "private", "secret.json"), JSON.stringify({ visibility: "private" }));
      await writeFile(
        path.join(sourceDirectory, "vercel.json"),
        JSON.stringify({
          functions: {
            "api/lookup.js": {
              includeFiles: ["data/**/*.json"],
              excludeFiles: ["data/private/**"]
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
      expect(indexHtml).toContain(configSecret);
      expect(indexHtml).not.toContain("From vercel.json");
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
