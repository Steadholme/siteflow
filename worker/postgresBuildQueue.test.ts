import { describe, expect, it, vi } from "vitest";
import { migrations } from "../server/migrations";
import type { BuildJobResult, QueuedBuildJob } from "./buildWorker";
import { PostgresBuildQueue } from "./postgresBuildQueue";

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

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

function claimRow(job?: QueuedBuildJob) {
  const sourceEvent = job?.sourceEvent;

  return {
    job_id: job?.id ?? "build_claim_1",
    project_id: job?.projectId ?? "project_docs",
    project_slug: job?.projectSlug ?? "docs",
    production_branch: job?.productionBranch ?? "main",
    repository: job?.repository ?? {},
    project_build_settings: job?.buildSettings ?? {},
    source_event_id: job?.sourceEventId ?? "src_claim_1",
    kind: sourceEvent?.kind ?? "push",
    provider_delivery_id: sourceEvent?.providerDeliveryId ?? "delivery-claim",
    branch: sourceEvent?.branch ?? "main",
    commit_sha: sourceEvent?.commitSha ?? "abc123",
    commit_message: sourceEvent?.commitMessage ?? "Claim build",
    commit_author: sourceEvent?.commitAuthor ?? "Ada",
    received_at: new Date(sourceEvent?.receivedAt ?? "2026-05-27T00:00:00.000Z"),
    actor: sourceEvent?.actor ?? {
      id: "github:ada",
      name: "ada",
      role: "developer"
    },
    framework: job?.buildSettings.framework ?? "vite",
    install_command: job?.buildSettings.installCommand ?? "npm ci",
    build_command: job?.buildSettings.buildCommand ?? "npm run build",
    output_directory: job?.buildSettings.outputDirectory ?? "dist",
    environment_variables: {}
  };
}

function connectPool(
  queries: RecordedQuery[],
  resultFor: (text: string) => { rows: unknown[]; rowCount?: number | null }
) {
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return resultFor(text);
    }),
    release: vi.fn()
  };

  return {
    connect: async () => client,
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return resultFor(text);
    }
  };
}

describe("PostgresBuildQueue", () => {
  it("defines build job lease migration columns and claim index", () => {
    const migration = migrations.find((entry) => entry.version === "019_build_job_leases");

    expect(migration?.sql).toContain("attempt_count integer NOT NULL DEFAULT 0");
    expect(migration?.sql).toContain("max_attempts integer NOT NULL DEFAULT 3");
    expect(migration?.sql).toContain("locked_until timestamptz");
    expect(migration?.sql).toContain("heartbeat_at timestamptz");
    expect(migration?.sql).toContain("idx_siteflow_build_jobs_claimable");
  });

  it("claims queued and stale running builds with a lease", async () => {
    const queries: RecordedQuery[] = [];
    const pool = connectPool(queries, (text) => {
      if (text.includes("FROM siteflow_build_jobs build")) {
        return { rows: [claimRow()], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
    const queue = new PostgresBuildQueue(pool as never, { leaseMs: 5000 });

    const job = await queue.claimNextJob("worker-a");
    const claimSelect = queries.find((query) => query.text.includes("FROM siteflow_build_jobs build"));
    const claimUpdate = queries.find((query) => query.text.includes("attempt_count = attempt_count + 1"));

    expect(job?.id).toBe("build_claim_1");
    expect(claimSelect?.text).toContain("build.status = 'queued'");
    expect(claimSelect?.text).toContain("build.status = 'running'");
    expect(claimSelect?.text).toContain("build.locked_until IS NULL OR build.locked_until <= now()");
    expect(claimSelect?.text).toContain("build.attempt_count < build.max_attempts");
    expect(claimSelect?.text).toContain("FOR UPDATE OF build SKIP LOCKED");
    expect(claimUpdate?.text).toContain("heartbeat_at = now()");
    expect(claimUpdate?.text).toContain("locked_until = now() + ($3::integer * interval '1 millisecond')");
    expect(claimUpdate?.values).toEqual(["build_claim_1", "worker-a", 5000]);
  });

  it("marks exhausted stale running builds failed before claiming", async () => {
    const queries: RecordedQuery[] = [];
    const pool = connectPool(queries, () => ({ rows: [], rowCount: 0 }));
    const queue = new PostgresBuildQueue(pool as never);

    const job = await queue.claimNextJob("worker-a");
    const staleFailureUpdate = queries.find((query) => query.text.includes("attempt_count >= max_attempts"));

    expect(job).toBeUndefined();
    expect(staleFailureUpdate?.text).toContain("SET status = 'failed'");
    expect(staleFailureUpdate?.text).toContain("locked_until = NULL");
    expect(staleFailureUpdate?.text).toContain("failure_reason = $1");
    expect(staleFailureUpdate?.values).toEqual(["Build lease expired after max attempts."]);
    expect(queries.findIndex((query) => query.text.includes("attempt_count >= max_attempts"))).toBeLessThan(
      queries.findIndex((query) => query.text.includes("FROM siteflow_build_jobs build"))
    );
  });

  it("renews claimed build leases with the current worker guard", async () => {
    const queries: RecordedQuery[] = [];
    const pool = connectPool(queries, (text) => {
      if (text.includes("FROM siteflow_build_jobs build")) {
        return { rows: [claimRow()], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
    const queue = new PostgresBuildQueue(pool as never, { leaseMs: 7500 });
    const job = await queue.claimNextJob("worker-heartbeat");

    await queue.heartbeatJob(job as QueuedBuildJob);
    const heartbeatUpdate = queries.find((query) => query.text.includes("SET heartbeat_at = now()"));

    expect(heartbeatUpdate?.text).toContain("locked_until = now() + ($2::integer * interval '1 millisecond')");
    expect(heartbeatUpdate?.text).toContain("AND worker_id = $3");
    expect(heartbeatUpdate?.values).toEqual(["build_claim_1", 7500, "worker-heartbeat"]);
  });

  it("rejects state changes without an active local worker lease", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn()
    };
    const queue = new PostgresBuildQueue(pool as never);
    const job = queuedJob();
    const result = {
      job,
      deploymentId: "dep_unclaimed",
      previewHost: "docs-preview.w33d.xyz",
      previewUrl: "https://docs-preview.w33d.xyz",
      artifact: {
        deploymentId: "dep_unclaimed",
        artifactRoot: "/tmp/siteflow/dep_unclaimed",
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
          metadata: {}
        }
      }
    } satisfies BuildJobResult;

    await expect(queue.heartbeatJob(job)).rejects.toThrow("without an active local worker lease");
    await expect(queue.skipJob(job, "ignored")).rejects.toThrow("without an active local worker lease");
    await expect(queue.failJob(job, "failed")).rejects.toThrow("without an active local worker lease");
    await expect(queue.completeJob(job, result)).rejects.toThrow("without an active local worker lease");
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("marks skipped builds with a redacted reason", async () => {
    const queries: RecordedQuery[] = [];
    const expectedJob = queuedJob();
    const pool = connectPool(queries, (text) => {
      if (text.includes("FROM siteflow_build_jobs build")) {
        return { rows: [claimRow(expectedJob)], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
    const queue = new PostgresBuildQueue(pool as never);
    const job = await queue.claimNextJob("worker-skip") as QueuedBuildJob;

    await queue.skipJob(job, "Build skipped by ignoreCommand: token=SITEFLOW_SECRET_CANARY_20260515.");
    const skipUpdate = queries.find((query) => query.text.includes("SET status = 'skipped'"));

    expect(skipUpdate?.text).toContain("AND worker_id = $3");
    expect(skipUpdate?.values).toEqual([
      "build_skip_1",
      "Build skipped by ignoreCommand: token=[REDACTED].",
      "worker-skip"
    ]);
  });

  it("upserts source build cron jobs when completing a build", async () => {
    const queries: RecordedQuery[] = [];
    const expectedJob = queuedJob();
    const pool = connectPool(queries, (text) => {
      if (text.includes("FROM siteflow_build_jobs build")) {
        return { rows: [claimRow(expectedJob)], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
    const queue = new PostgresBuildQueue(pool as never);
    const job = await queue.claimNextJob("worker-complete") as QueuedBuildJob;
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
    const markSucceeded = queries.find((query) => query.text.includes("SET status = 'succeeded'"));
    const cronUpsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_cron_jobs"));

    expect(markSucceeded?.text).toContain("AND worker_id = $2");
    expect(markSucceeded?.values).toEqual(["build_skip_1", "worker-complete"]);
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

  it("requeues failed builds when attempts remain", async () => {
    const queries: RecordedQuery[] = [];
    const expectedJob = queuedJob();
    const pool = connectPool(queries, (text) => {
      if (text.includes("FROM siteflow_build_jobs build")) {
        return { rows: [claimRow(expectedJob)], rowCount: 1 };
      }

      if (text.includes("SELECT attempt_count, max_attempts")) {
        return { rows: [{ attempt_count: 1, max_attempts: 3 }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
    const queue = new PostgresBuildQueue(pool as never);
    const job = await queue.claimNextJob("worker-fail") as QueuedBuildJob;

    await queue.failJob(job, "Install failed with token=SITEFLOW_SECRET_CANARY_20260515.");
    const attemptSelect = queries.find((query) => query.text.includes("SELECT attempt_count, max_attempts"));
    const requeueUpdate = queries.find((query) => query.text.includes("SET status = 'queued'"));

    expect(attemptSelect?.text).toContain("AND worker_id = $2");
    expect(attemptSelect?.text).toContain("FOR UPDATE");
    expect(requeueUpdate?.text).toContain("queued_at = now()");
    expect(requeueUpdate?.text).toContain("worker_id = NULL");
    expect(requeueUpdate?.text).toContain("locked_until = NULL");
    expect(requeueUpdate?.text).toContain("AND worker_id = $3");
    expect(requeueUpdate?.values).toEqual([
      "build_skip_1",
      "Install failed with token=[REDACTED].",
      "worker-fail"
    ]);
  });

  it("marks failed builds final when max attempts are reached", async () => {
    const queries: RecordedQuery[] = [];
    const expectedJob = queuedJob();
    const pool = connectPool(queries, (text) => {
      if (text.includes("FROM siteflow_build_jobs build")) {
        return { rows: [claimRow(expectedJob)], rowCount: 1 };
      }

      if (text.includes("SELECT attempt_count, max_attempts")) {
        return { rows: [{ attempt_count: 3, max_attempts: 3 }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
    const queue = new PostgresBuildQueue(pool as never);
    const job = await queue.claimNextJob("worker-final") as QueuedBuildJob;

    await queue.failJob(job, "Build failed with token=SITEFLOW_SECRET_CANARY_20260515.");
    const finalUpdate = queries.find((query) =>
      query.text.includes("SET status = 'failed'") && query.values?.[0] === "build_skip_1"
    );

    expect(finalUpdate?.text).toContain("finished_at = now()");
    expect(finalUpdate?.text).toContain("locked_until = NULL");
    expect(finalUpdate?.text).toContain("AND worker_id = $3");
    expect(finalUpdate?.values).toEqual([
      "build_skip_1",
      "Build failed with token=[REDACTED].",
      "worker-final"
    ]);
  });
});
