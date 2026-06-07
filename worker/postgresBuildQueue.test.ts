import { describe, expect, it } from "vitest";
import type { BuildJobResult, QueuedBuildJob } from "./buildWorker";
import { PostgresBuildQueue } from "./postgresBuildQueue";

function queuedJob(): QueuedBuildJob {
  return {
    id: "build_skip_1",
    projectId: "project_docs",
    projectSlug: "docs",
    productionBranch: "main",
    sourceEventId: "src_skip_1",
    sourceEvent: {
      id: "src_skip_1",
      projectId: "project_docs",
      kind: "push",
      status: "accepted",
      disposition: "build_requested",
      providerDeliveryId: "delivery-skip",
      branch: "feature/skip",
      commitSha: "abc123",
      commitMessage: "Skip unchanged build",
      commitAuthor: "Ada",
      receivedAt: "2026-05-27T00:00:00.000Z",
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
      defaultBranch: "main"
    },
    buildSettings: {
      framework: "vite",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDirectory: "dist"
    }
  };
}

describe("PostgresBuildQueue", () => {
  it("marks skipped builds with a redacted reason", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      }
    };
    const queue = new PostgresBuildQueue(pool as never);

    await queue.skipJob(queuedJob(), "Build skipped by ignoreCommand: token=SITEFLOW_SECRET_CANARY_20260515.");

    expect(queries[0].text).toContain("SET status = 'skipped'");
    expect(queries[0].values).toEqual([
      "build_skip_1",
      "Build skipped by ignoreCommand: token=[REDACTED]."
    ]);
  });

  it("upserts source build cron jobs when completing a build", async () => {
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
    const queue = new PostgresBuildQueue(pool as never);
    const job = queuedJob();
    const result: BuildJobResult = {
      job,
      deploymentId: "dep_source_1",
      previewHost: "docs-preview.w33d.xyz",
      previewUrl: "https://docs-preview.w33d.xyz",
      artifact: {
        deploymentId: "dep_source_1",
        artifactRoot: "/tmp/siteflow/dep_source_1",
        entrypoint: "index.html",
        fileCount: 1,
        totalBytes: 14,
        checksum: "sha256",
        manifest: {
          entrypoint: "index.html",
          fileCount: 1,
          totalBytes: 14,
          checksum: "sha256:sha256",
          generatedAt: "2026-05-27T00:00:00.000Z",
          metadata: {
            routing: {
              cleanUrls: true
            }
          }
        }
      },
      crons: [
        {
          path: "/api/revalidate",
          schedule: "0 * * * *"
        }
      ]
    };

    await queue.completeJob(job, result);
    const cronUpsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_cron_jobs"));

    expect(cronUpsert?.values).toEqual([
      expect.stringMatching(/^cron_/),
      "project_docs",
      "vercel:/api/revalidate",
      "/api/revalidate",
      "0 * * * *",
      JSON.stringify({
        id: "siteflow:worker",
        name: "Build worker",
        role: "system"
      })
    ]);
    expect(cronUpsert?.text).toContain("ON CONFLICT (project_id, name) DO UPDATE");
    expect(cronUpsert?.text).toContain("status = 'active'");
  });
});
