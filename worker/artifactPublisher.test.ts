import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactPublisher } from "./artifactPublisher";
import type { ArtifactPublishOptions, PublishedBuildArtifact } from "./artifactPublisher";

async function writeStaticOutput(outputDirectory: string, html = "<h1>SiteFlow Preview</h1>") {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "index.html"), html, "utf8");
}

async function publishBuildArtifact(options: ArtifactPublishOptions): Promise<PublishedBuildArtifact> {
  const artifactPublisher = await import("./artifactPublisher");

  return artifactPublisher.publishBuildArtifact(options);
}

describe("publishBuildArtifact", () => {
  it("rejects output that exceeds the byte budget before creating a deployment directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-budget-bytes-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(outputDirectory);
      await mkdir(artifactRoot, { recursive: true });

      await expect(
        publishBuildArtifact({
          buildJobId: "build_budget_bytes",
          sourceEventId: "src_budget_bytes",
          outputDirectory,
          artifactRoot,
          maxArtifactBytes: 10,
          maxArtifactFiles: 100
        })
      ).rejects.toThrow("SITEFLOW_BUILD_MAX_ARTIFACT_BYTES");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects output that exceeds the final file budget after precompression", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-budget-files-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(outputDirectory);
      await mkdir(artifactRoot, { recursive: true });

      await expect(
        publishBuildArtifact({
          buildJobId: "build_budget_files",
          sourceEventId: "src_budget_files",
          outputDirectory,
          artifactRoot,
          maxArtifactBytes: 1024 * 1024,
          maxArtifactFiles: 1
        })
      ).rejects.toThrow("SITEFLOW_BUILD_MAX_ARTIFACT_FILES");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects artifacts that contain blocked secret values before creating a deployment directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-secret-scan-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(outputDirectory, "<h1>config-secret-20260527</h1>");
      await mkdir(artifactRoot, { recursive: true });

      await expect(
        publishBuildArtifact({
          buildJobId: "build_secret_scan",
          sourceEventId: "src_secret_scan",
          outputDirectory,
          artifactRoot,
          blockedContentValues: [
            {
              label: "SITEFLOW_CONFIG_SECRET",
              value: "config-secret-20260527"
            }
          ]
        })
      ).rejects.toThrow("Build artifact contains blocked secret value for SITEFLOW_CONFIG_SECRET in index.html.");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects source maps with embedded sourcesContent before creating a deployment directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-sourcemap-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(outputDirectory);
      await mkdir(path.join(outputDirectory, "assets"), { recursive: true });
      await writeFile(path.join(outputDirectory, "assets", "index.js.map"), JSON.stringify({
        version: 3,
        file: "index.js",
        sources: ["../../src/main.ts"],
        sourcesContent: ["const secret = 'not-for-release';"],
        mappings: ""
      }), "utf8");
      await mkdir(artifactRoot, { recursive: true });

      await expect(
        publishBuildArtifact({
          buildJobId: "build_sourcemap",
          sourceEventId: "src_sourcemap",
          outputDirectory,
          artifactRoot
        })
      ).rejects.toThrow("source map embeds sourcesContent");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked artifact entries before creating a deployment directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-symlink-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(outputDirectory);

      try {
        await symlink("index.html", path.join(outputDirectory, "linked.html"), "file");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EPERM", "EINVAL"].includes(String(error.code))) {
          return;
        }

        throw error;
      }

      await mkdir(artifactRoot, { recursive: true });

      await expect(
        publishBuildArtifact({
          buildJobId: "build_symlink",
          sourceEventId: "src_symlink",
          outputDirectory,
          artifactRoot
        })
      ).rejects.toThrow("unsupported symlink entry: linked.html");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked function artifact sources before creating a deployment directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-symlink-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");
    const functionRoot = path.join(root, "api");

    try {
      await writeStaticOutput(outputDirectory);
      await mkdir(functionRoot, { recursive: true });
      await writeFile(path.join(functionRoot, "handler.js"), "export default function handler() {}", "utf8");

      try {
        await symlink("handler.js", path.join(functionRoot, "linked.js"), "file");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["EPERM", "EINVAL"].includes(String(error.code))) {
          return;
        }

        throw error;
      }

      await mkdir(artifactRoot, { recursive: true });

      await expect(
        publishBuildArtifact({
          buildJobId: "build_function_symlink",
          sourceEventId: "src_function_symlink",
          outputDirectory,
          artifactRoot,
          functions: [
            {
              path: "/api/linked",
              sourcePath: path.join(functionRoot, "linked.js"),
              artifactPath: ".siteflow/functions/api/linked.js",
              runtime: "nodejs"
            }
          ]
        })
      ).rejects.toThrow("Function artifact source must be a regular file: .siteflow/functions/api/linked.js.");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records same-process isolation for function artifact entries by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-isolation-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");
    const functionRoot = path.join(root, "api");

    try {
      await writeStaticOutput(outputDirectory);
      await mkdir(functionRoot, { recursive: true });
      await writeFile(path.join(functionRoot, "handler.js"), "export default function handler() {}", "utf8");
      await mkdir(artifactRoot, { recursive: true });

      const artifact = await publishBuildArtifact({
        buildJobId: "build_function_isolation",
        sourceEventId: "src_function_isolation",
        outputDirectory,
        artifactRoot,
        functions: [
          {
            path: "/api/handler",
            sourcePath: path.join(functionRoot, "handler.js"),
            artifactPath: ".siteflow/functions/api/handler.js",
            runtime: "nodejs20.x"
          }
        ]
      });

      expect(artifact.manifest.functions).toEqual([
        {
          path: "/api/handler",
          sourcePath: ".siteflow/functions/api/handler.js",
          runtime: "nodejs20.x",
          runtimeIsolation: "same_process",
          handler: "default",
          apiStyle: "fetch"
        }
      ]);
      await expect(readdir(artifactRoot)).resolves.toEqual([artifact.deploymentId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits a client environment shim and injects it as the first head child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-client-env-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(outputDirectory, "<!doctype html><html><head><title>App</title></head><body>ok</body></html>");
      await mkdir(artifactRoot, { recursive: true });

      const artifact = await publishBuildArtifact({
        buildJobId: "build_client_env",
        sourceEventId: "src_client_env",
        outputDirectory,
        artifactRoot,
        clientEnvironmentVariables: {
          PUBLIC_FLAG: "enabled",
          CISTERN_REST_URL: "https://cistern.example.test"
        }
      });
      const html = await readFile(path.join(artifact.artifactRoot, "index.html"), "utf8");
      const env = await readFile(path.join(artifact.artifactRoot, "__siteflow", "env.js"), "utf8");

      expect(html).toContain('<head><script src="/__siteflow/env.js"></script><title>App</title>');
      expect(env).toBe('window.env = Object.assign(window.env || {}, {"CISTERN_REST_URL":"https://cistern.example.test","PUBLIC_FLAG":"enabled"});');
      expect(artifact.manifest.metadata?.precompressed).toEqual({
        br: 2,
        gzip: 2
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not inject duplicate client environment script tags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-client-env-idempotent-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(
        outputDirectory,
        '<html><head><script src="/__siteflow/env.js"></script><title>App</title></head><body>ok</body></html>'
      );
      await mkdir(artifactRoot, { recursive: true });

      const artifact = await publishBuildArtifact({
        buildJobId: "build_client_env_idempotent",
        sourceEventId: "src_client_env_idempotent",
        outputDirectory,
        artifactRoot,
        clientEnvironmentVariables: {
          PUBLIC_FLAG: "enabled"
        }
      });
      const html = await readFile(path.join(artifact.artifactRoot, "index.html"), "utf8");

      expect(html.match(/\/__siteflow\/env\.js/g)).toHaveLength(1);
      await expect(readFile(path.join(artifact.artifactRoot, "__siteflow", "env.js"), "utf8"))
        .resolves.toBe('window.env = Object.assign(window.env || {}, {"PUBLIC_FLAG":"enabled"});');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans staging files and leaves no partial deployment when artifact writing fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-atomic-failure-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeStaticOutput(outputDirectory);
      await writeFile(path.join(outputDirectory, "asset.bin"), "partial write canary", "utf8");
      await mkdir(artifactRoot, { recursive: true });

      const actualWriteFile = writeFile as unknown as (...args: unknown[]) => Promise<void>;
      const publishWithFault = createArtifactPublisher({
        writeFile: (async (...args: unknown[]) => {
          const targetPath = String(args[0]);

          if (targetPath.includes(`${path.sep}.publish-`) && targetPath.endsWith(`${path.sep}index.html`)) {
            throw new Error("injected artifact write failure");
          }

          return actualWriteFile(...args);
        }) as typeof writeFile
      });

      await expect(
        publishWithFault({
          buildJobId: "build_atomic_failure",
          sourceEventId: "src_atomic_failure",
          outputDirectory,
          artifactRoot
        })
      ).rejects.toThrow("injected artifact write failure");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects deployment id collisions without replacing an existing immutable artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-collision-"));
    const outputDirectory = path.join(root, "dist");
    const artifactRoot = path.join(root, "artifacts");
    const deploymentUuid = "11111111-1111-1111-1111-111111111111";
    const deploymentId = `dep_${deploymentUuid.replace(/-/g, "")}`;
    const existingArtifactRoot = path.join(artifactRoot, deploymentId);

    try {
      await writeStaticOutput(outputDirectory, "<h1>New artifact</h1>");
      await mkdir(existingArtifactRoot, { recursive: true });
      await writeFile(path.join(existingArtifactRoot, "index.html"), "<h1>Existing artifact</h1>", "utf8");

      const publishWithCollision = createArtifactPublisher({
        randomUUID: () => deploymentUuid
      });

      await expect(
        publishWithCollision({
          buildJobId: "build_collision",
          sourceEventId: "src_collision",
          outputDirectory,
          artifactRoot
        })
      ).rejects.toThrow("Deployment artifact target already exists");

      await expect(readFile(path.join(existingArtifactRoot, "index.html"), "utf8")).resolves.toBe("<h1>Existing artifact</h1>");
      await expect(readdir(artifactRoot)).resolves.toEqual([deploymentId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
