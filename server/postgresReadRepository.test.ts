import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sealSecretValue } from "../src/lib/sealedSecrets";
import { PostgresSiteFlowReadRepository } from "./postgresReadRepository";

function prebuiltFile(filePath: string, content: string) {
  const bytes = Buffer.from(content);

  return {
    path: filePath,
    contentBase64: bytes.toString("base64"),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

describe("PostgresSiteFlowReadRepository", () => {
  it("imports vercel.json cron jobs during prebuilt deploy", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-prebuilt-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      const result = await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "abc123",
        files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
        crons: [
          {
            path: "/api/revalidate",
            schedule: "0 * * * *"
          }
        ]
      });
      const cronUpsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_cron_jobs"));
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));

      expect(result.previewHost).toBe("abc123.w33d.xyz");
      expect(JSON.parse(String(deploymentInsert?.values?.[9]))).toMatchObject({
        entrypoint: "index.html",
        metadata: {
          routing: {}
        }
      });
      expect(cronUpsert?.values).toEqual([
        expect.stringMatching(/^cron_/),
        "project_docs",
        "vercel:/api/revalidate",
        "/api/revalidate",
        "0 * * * *",
        JSON.stringify({
          id: "siteflow:prebuilt",
          name: "Prebuilt deploy",
          role: "system"
        })
      ]);
      expect(cronUpsert?.text).toContain("ON CONFLICT (project_id, name) DO UPDATE");
      expect(cronUpsert?.text).toContain("status = 'active'");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("persists prebuilt clean URL and trailing slash settings in the artifact manifest", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-clean-urls-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "clean123",
        files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
        public: true,
        fluid: true,
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
          skipTrailingSlashRedirect: true
        }
      });
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));

      expect(JSON.parse(String(deploymentInsert?.values?.[9]))).toMatchObject({
        entrypoint: "index.html",
        metadata: {
          public: true,
          fluid: true,
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
            skipTrailingSlashRedirect: true
          }
        }
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("records precompressed prebuilt artifact variants in the artifact manifest", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-precompressed-prebuilt-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "assets123",
        files: [
          prebuiltFile("index.html", "<h1>Hello</h1>"),
          prebuiltFile("index.html.br", "brotli bytes"),
          prebuiltFile("index.html.gz", "gzip bytes"),
          prebuiltFile(".siteflow/functions/api/config.json", "{\"secret\":true}"),
          prebuiltFile(".siteflow/functions/api/config.json.br", "function brotli bytes")
        ]
      });
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));

      expect(JSON.parse(String(deploymentInsert?.values?.[9]))).toMatchObject({
        entrypoint: "index.html",
        fileCount: 5,
        metadata: {
          precompressed: {
            br: 1,
            gzip: 1
          }
        }
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("resolves sealed artifact runtime env from vercel.json metadata and lets project runtime env override it", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("FROM siteflow_artifact_routes")) {
          return {
            rows: [
              {
                host: "abc123.w33d.xyz",
                project_id: "project_docs",
                deployment_id: "dep_runtime_env",
                artifact_root: "/tmp/siteflow/dep_runtime_env",
                entrypoint: "index.html",
                source_branch: "feature/runtime-env",
                production_branch: "main",
                route_channel: "preview",
                rolling_release_id: null,
                percentage: null,
                artifact_manifest: {
                  entrypoint: "index.html",
                  fileCount: 1,
                  totalBytes: 14,
                  checksum: "sha256:runtime",
                  generatedAt: "2026-05-27T00:00:00.000Z",
                  functions: [
                    {
                      path: "/api/env",
                      sourcePath: ".siteflow/functions/api/env.js",
                      runtime: "nodejs20.x",
                      handler: "default"
                    }
                  ],
                  metadata: {
                    runtimeEnvKeys: ["PUBLIC_RUNTIME_FLAG", "RUNTIME_SECRET"],
                    sealedRuntimeEnv: {
                      RUNTIME_SECRET: sealSecretValue("artifact-runtime-secret"),
                      PUBLIC_RUNTIME_FLAG: sealSecretValue("artifact-enabled")
                    },
                    routing: {}
                  }
                },
                candidate_deployment_id: null,
                candidate_artifact_root: null,
                candidate_entrypoint: null,
                candidate_project_id: null,
                candidate_source_branch: null,
                candidate_artifact_manifest: null
              }
            ]
          };
        }

        if (text.includes("FROM siteflow_environment_variables")) {
          return {
            rows: [
              {
                key: "RUNTIME_SECRET",
                sealed_value: sealSecretValue("project-runtime-secret")
              }
            ]
          };
        }

        return { rows: [] };
      }
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow",
      baseDomain: "w33d.xyz"
    });
    const route = await repository.resolveArtifactRoute("abc123.w33d.xyz");

    expect(route?.runtimeEnvironment).toEqual({
      RUNTIME_SECRET: "project-runtime-secret",
      PUBLIC_RUNTIME_FLAG: "artifact-enabled"
    });
    expect(route?.functions).toEqual([
      {
        path: "/api/env",
        sourcePath: ".siteflow/functions/api/env.js",
        runtime: "nodejs20.x",
        handler: "default"
      }
    ]);
    expect(queries.find((query) => query.text.includes("FROM siteflow_environment_variables"))?.values).toEqual([
      "project_docs",
      "preview"
    ]);
  });
});
