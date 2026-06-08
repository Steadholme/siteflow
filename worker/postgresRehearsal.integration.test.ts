import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrationAdvisoryLockKeys, migrations, runMigrations } from "../server/migrations";
import { PostgresBuildQueue } from "./postgresBuildQueue";

const shouldRunPostgresIntegration = process.env.SITEFLOW_RUN_POSTGRES_INTEGRATION === "1";
const describePostgres = shouldRunPostgresIntegration ? describe : describe.skip;

interface BuildJobSeed {
  id: string;
  sourceEventId: string;
  branch?: string;
  status?: "queued" | "running";
  queuedAt?: string;
  startedAt?: string | null;
  workerId?: string | null;
  attemptCount?: number;
  maxAttempts?: number;
  lockedUntil?: string | null;
  heartbeatAt?: string | null;
}

type ScenarioScalar = string | number | boolean | null;

interface ScenarioEvidenceDetails {
  assertions?: Record<string, ScenarioScalar>;
  metrics?: Record<string, ScenarioScalar>;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function sanitizeEvidenceMessage(value: unknown) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[REDACTED]@")
    .replace(/(token|secret|password|passwd|pwd|key)=([^.\s]+)/gi, "$1=[REDACTED]");
}

async function appendScenarioEvidence(entry: Record<string, unknown>) {
  const evidencePath = process.env.SITEFLOW_POSTGRES_REHEARSAL_EVIDENCE_PATH;

  if (!evidencePath) {
    return;
  }

  await mkdir(path.dirname(evidencePath), { recursive: true });
  await appendFile(evidencePath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function recordScenario(scope: string, run: () => Promise<ScenarioEvidenceDetails | void>) {
  const startedAt = Date.now();

  try {
    const details = await run();

    await appendScenarioEvidence({
      scope,
      status: "passed",
      recordedAt: new Date().toISOString(),
      assertions: details?.assertions,
      metrics: {
        durationMs: Date.now() - startedAt,
        ...details?.metrics
      }
    });
  } catch (error) {
    await appendScenarioEvidence({
      scope,
      status: "failed",
      recordedAt: new Date().toISOString(),
      metrics: {
        durationMs: Date.now() - startedAt
      },
      message: sanitizeEvidenceMessage(error instanceof Error ? error.message : error)
    });
    throw error;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timed-out" }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
  });
  const result = await Promise.race([
    promise.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    ),
    timeout
  ]);

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  return result;
}

describePostgres("Postgres production rehearsal", () => {
  let adminPool: Pool;
  let pool: Pool;
  let schemaName: string;
  let databaseUrl: string;

  beforeAll(async () => {
    databaseUrl = process.env.TEST_DATABASE_URL ?? "";

    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required when SITEFLOW_RUN_POSTGRES_INTEGRATION=1.");
    }

    schemaName = `siteflow_rehearsal_${process.pid}_${Date.now()}`.toLowerCase();
    adminPool = new Pool({ connectionString: databaseUrl, max: 4 });

    await resetRehearsalSchema();

    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      options: `-c search_path=${schemaName}`
    });
  });

  beforeEach(async () => {
    await resetRehearsalSchema();
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await adminPool?.end();
  });

  async function resetRehearsalSchema() {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  }

  function createSchemaPool(max = 4) {
    return new Pool({
      connectionString: databaseUrl,
      max,
      options: `-c search_path=${schemaName}`
    });
  }

  async function waitForMigrationLockWaiter(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await adminPool.query<{ waiters: number }>(
        `
          SELECT count(*)::int AS waiters
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = $1::oid
            AND objid = $2::oid
            AND granted = false
        `,
        [...migrationAdvisoryLockKeys]
      );

      if (Number(result.rows[0]?.waiters ?? 0) > 0) {
        return true;
      }

      await delay(25);
    }

    return false;
  }

  async function seedBuildJob(seed: BuildJobSeed) {
    const branch = seed.branch ?? "main";

    await pool.query(
      `
        INSERT INTO siteflow_projects (
          id,
          slug,
          name,
          production_branch,
          repository,
          build_settings
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        "project_docs",
        "docs",
        "Docs",
        "main",
        JSON.stringify({
          provider: "github",
          owner: "acme",
          name: "docs",
          defaultBranch: "main"
        }),
        JSON.stringify({
          framework: "vite",
          rootDirectory: "apps/docs"
        })
      ]
    );

    await pool.query(
      `
        INSERT INTO siteflow_source_events (
          id,
          project_id,
          provider,
          provider_delivery_id,
          kind,
          status,
          disposition,
          branch,
          commit_sha,
          commit_message,
          commit_author,
          actor,
          provider_payload,
          received_at
        )
        VALUES ($1, 'project_docs', 'github', $2, 'push', 'accepted', 'build_requested', $3, $4, $5, 'Ada', $6::jsonb, '{}'::jsonb, $7)
      `,
      [
        seed.sourceEventId,
        `delivery-${seed.sourceEventId}`,
        branch,
        `sha-${seed.sourceEventId}`,
        `Build ${seed.sourceEventId}`,
        JSON.stringify({
          id: "github:ada",
          name: "ada",
          role: "developer"
        }),
        "2026-06-07T00:00:00.000Z"
      ]
    );

    await pool.query(
      `
        INSERT INTO siteflow_build_jobs (
          id,
          project_id,
          source_event_id,
          status,
          framework,
          install_command,
          build_command,
          output_directory,
          queued_at,
          started_at,
          worker_id,
          attempt_count,
          max_attempts,
          locked_until,
          heartbeat_at
        )
        VALUES ($1, 'project_docs', $2, $3, 'vite', 'npm ci', 'npm run build', 'dist', $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        seed.id,
        seed.sourceEventId,
        seed.status ?? "queued",
        seed.queuedAt ?? "2026-06-07T00:00:00.000Z",
        seed.startedAt ?? null,
        seed.workerId ?? null,
        seed.attemptCount ?? 0,
        seed.maxAttempts ?? 3,
        seed.lockedUntil ?? null,
        seed.heartbeatAt ?? null
      ]
    );
  }

  it("serializes real migrations with the advisory transaction lock and records checksums", async () => {
    await recordScenario("migration_advisory_lock", async () => {
      const locker = await pool.connect();

      try {
        await locker.query("BEGIN");
        await locker.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
          ...migrationAdvisoryLockKeys
        ]);

        const migrationRun = runMigrations(pool);
        const sawWaitingMigration = await waitForMigrationLockWaiter();

        await locker.query("COMMIT");
        await migrationRun;

        const applied = await pool.query<{ count: number; missing_checksums: number }>(
          `
            SELECT
              count(*)::int AS count,
              count(*) FILTER (WHERE checksum_sha256 IS NULL OR checksum_sha256 = '')::int AS missing_checksums
            FROM siteflow_schema_migrations
          `
        );
        const appliedMigrationCount = Number(applied.rows[0]?.count);
        const missingChecksumCount = Number(applied.rows[0]?.missing_checksums);

        expect(sawWaitingMigration).toBe(true);
        expect(appliedMigrationCount).toBe(migrations.length);
        expect(missingChecksumCount).toBe(0);

        return {
          assertions: {
            lockWaiterObserved: sawWaitingMigration,
            checksumsComplete: missingChecksumCount === 0
          },
          metrics: {
            appliedMigrationCount,
            expectedMigrationCount: migrations.length,
            missingChecksumCount
          }
        };
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
    });
  });

  it("fails real migration rehearsal when an applied checksum drifts", async () => {
    await recordScenario("migration_checksum_drift", async () => {
      await runMigrations(pool);
      await pool.query(
        "UPDATE siteflow_schema_migrations SET checksum_sha256 = 'drifted' WHERE version = $1",
        [migrations[0].version]
      );

      await expect(runMigrations(pool)).rejects.toThrow(`Migration drift detected for ${migrations[0].version}`);

      return {
        assertions: {
          driftRejected: true
        },
        metrics: {
          driftedVersion: migrations[0].version
        }
      };
    });
  });

  it("serializes concurrent API and worker migration startup on real Postgres", async () => {
    await recordScenario("concurrent_migration_startup", async () => {
      const apiPool = createSchemaPool(2);
      const workerPool = createSchemaPool(2);

      try {
        await Promise.all([runMigrations(apiPool), runMigrations(workerPool)]);

        const applied = await pool.query<{ count: number; duplicate_versions: number; missing_checksums: number }>(
          `
            SELECT
              count(*)::int AS count,
              (count(*) - count(DISTINCT version))::int AS duplicate_versions,
              count(*) FILTER (WHERE checksum_sha256 IS NULL OR checksum_sha256 = '')::int AS missing_checksums
            FROM siteflow_schema_migrations
          `
        );

        expect(applied.rows[0]).toEqual({
          count: migrations.length,
          duplicate_versions: 0,
          missing_checksums: 0
        });

        return {
          assertions: {
            noDuplicateVersions: applied.rows[0]?.duplicate_versions === 0,
            checksumsComplete: applied.rows[0]?.missing_checksums === 0
          },
          metrics: {
            appliedMigrationCount: applied.rows[0]?.count ?? 0,
            duplicateVersionCount: applied.rows[0]?.duplicate_versions ?? 0,
            missingChecksumCount: applied.rows[0]?.missing_checksums ?? 0
          }
        };
      } finally {
        await apiPool.end();
        await workerPool.end();
      }
    });
  });

  it("claims a second queued build while the first row is locked", async () => {
    await recordScenario("skip_locked_claim", async () => {
      await runMigrations(pool);
      await seedBuildJob({
        id: "build_locked_a",
        sourceEventId: "source_locked_a",
        queuedAt: "2026-06-07T00:00:00.000Z"
      });
      await seedBuildJob({
        id: "build_locked_b",
        sourceEventId: "source_locked_b",
        queuedAt: "2026-06-07T00:00:01.000Z"
      });

      const queue = new PostgresBuildQueue(pool, { leaseMs: 5000 });
      const locker = await pool.connect();
      let claimPromise: Promise<Awaited<ReturnType<PostgresBuildQueue["claimNextJob"]>>> | undefined;
      let claimedJobId: string | null = null;

      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM siteflow_build_jobs WHERE id = $1 FOR UPDATE", ["build_locked_a"]);

        claimPromise = queue.claimNextJob("worker-skip-locked");
        const claim = await settleWithin(claimPromise, 1000);

        expect(claim.status).toBe("resolved");

        if (claim.status === "rejected") {
          throw claim.error;
        }

        if (claim.status === "resolved") {
          claimedJobId = claim.value?.id ?? null;
          expect(claim.value?.id).toBe("build_locked_b");
        }

        return {
          assertions: {
            claimResolved: true,
            claimedSecondQueuedBuild: claimedJobId === "build_locked_b"
          },
          metrics: {
            timeoutMs: 1000,
            lockedJobId: "build_locked_a",
            claimedJobId
          }
        };
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
        await claimPromise?.catch(() => undefined);
      }
    });
  });

  it("lets concurrent workers claim distinct queued builds on real Postgres", async () => {
    await recordScenario("concurrent_worker_claim", async () => {
      await runMigrations(pool);
      await seedBuildJob({
        id: "build_concurrent_a",
        sourceEventId: "source_concurrent_a",
        queuedAt: "2026-06-07T00:00:00.000Z"
      });
      await seedBuildJob({
        id: "build_concurrent_b",
        sourceEventId: "source_concurrent_b",
        queuedAt: "2026-06-07T00:00:01.000Z"
      });

      const queueA = new PostgresBuildQueue(pool, { leaseMs: 5000 });
      const queueB = new PostgresBuildQueue(pool, { leaseMs: 5000 });
      const [claimA, claimB] = await Promise.all([
        queueA.claimNextJob("worker-concurrent-a"),
        queueB.claimNextJob("worker-concurrent-b")
      ]);

      expect([claimA?.id, claimB?.id].sort()).toEqual(["build_concurrent_a", "build_concurrent_b"]);

      const claimed = await pool.query<{ id: string; status: string; worker_id: string; attempt_count: number }>(
        `
          SELECT id, status, worker_id, attempt_count
          FROM siteflow_build_jobs
          WHERE id IN ('build_concurrent_a', 'build_concurrent_b')
          ORDER BY id ASC
        `
      );
      const distinctWorkerCount = new Set(claimed.rows.map((row) => row.worker_id)).size;

      expect(claimed.rows).toEqual([
        {
          id: "build_concurrent_a",
          status: "running",
          worker_id: expect.stringMatching(/^worker-concurrent-/),
          attempt_count: 1
        },
        {
          id: "build_concurrent_b",
          status: "running",
          worker_id: expect.stringMatching(/^worker-concurrent-/),
          attempt_count: 1
        }
      ]);
      expect(distinctWorkerCount).toBe(2);

      return {
        assertions: {
          distinctQueuedBuildsClaimed: true,
          distinctWorkers: distinctWorkerCount === 2
        },
        metrics: {
          claimedJobCount: claimed.rows.length,
          distinctWorkerCount,
          runningJobCount: claimed.rows.filter((row) => row.status === "running").length,
          attemptCount: 1
        }
      };
    });
  });

  it("rehearses build lease claim and heartbeat renewal on real Postgres", async () => {
    await recordScenario("lease_heartbeat", async () => {
      await runMigrations(pool);
      await seedBuildJob({
        id: "build_lease",
        sourceEventId: "source_lease"
      });

      const queue = new PostgresBuildQueue(pool, { leaseMs: 5000 });
      const job = await queue.claimNextJob("worker-heartbeat");

      expect(job?.id).toBe("build_lease");

      const beforeHeartbeat = await pool.query<{
        status: string;
        worker_id: string;
        attempt_count: number;
        locked_until: Date;
        heartbeat_at: Date;
      }>(
        `
          SELECT status, worker_id, attempt_count, locked_until, heartbeat_at
          FROM siteflow_build_jobs
          WHERE id = 'build_lease'
        `
      );

      await delay(25);
      await queue.heartbeatJob(job!);

      const afterHeartbeat = await pool.query<{ locked_until: Date; heartbeat_at: Date }>(
        `
          SELECT locked_until, heartbeat_at
          FROM siteflow_build_jobs
          WHERE id = 'build_lease'
        `
      );
      const lockedUntilAdvanced = afterHeartbeat.rows[0]!.locked_until.getTime() >
        beforeHeartbeat.rows[0]!.locked_until.getTime();
      const heartbeatAdvancedOrEqual = afterHeartbeat.rows[0]!.heartbeat_at.getTime() >=
        beforeHeartbeat.rows[0]!.heartbeat_at.getTime();

      expect(beforeHeartbeat.rows[0]).toMatchObject({
        status: "running",
        worker_id: "worker-heartbeat",
        attempt_count: 1
      });
      expect(lockedUntilAdvanced).toBe(true);
      expect(heartbeatAdvancedOrEqual).toBe(true);

      return {
        assertions: {
          claimedLease: job?.id === "build_lease",
          lockedUntilAdvanced,
          heartbeatAdvancedOrEqual
        },
        metrics: {
          attemptCount: beforeHeartbeat.rows[0]?.attempt_count ?? 0,
          leaseMs: 5000
        }
      };
    });
  });

  it("recovers stale running builds and fails exhausted stale leases on real Postgres", async () => {
    await runMigrations(pool);
    const queue = new PostgresBuildQueue(pool, { leaseMs: 5000 });

    await recordScenario("stale_lease_recovery", async () => {
      await seedBuildJob({
        id: "build_stale_retry",
        sourceEventId: "source_stale_retry",
        status: "running",
        startedAt: "2026-06-07T00:00:00.000Z",
        workerId: "worker-old",
        attemptCount: 1,
        maxAttempts: 3,
        lockedUntil: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z"
      });

      const staleJob = await queue.claimNextJob("worker-new");

      expect(staleJob?.id).toBe("build_stale_retry");

      await queue.failJob(staleJob!, "Failed with token=SITEFLOW_SECRET_CANARY_20260515.");

      const retried = await pool.query<{
        status: string;
        worker_id: string | null;
        locked_until: Date | null;
        attempt_count: number;
        failure_reason: string;
      }>(
        `
          SELECT status, worker_id, locked_until, attempt_count, failure_reason
          FROM siteflow_build_jobs
          WHERE id = 'build_stale_retry'
        `
      );

      expect(retried.rows[0]).toMatchObject({
        status: "queued",
        worker_id: null,
        locked_until: null,
        attempt_count: 2,
        failure_reason: "Failed with token=[REDACTED]."
      });

      return {
        assertions: {
          staleJobClaimed: staleJob?.id === "build_stale_retry",
          workerCleared: retried.rows[0]?.worker_id === null,
          lockedUntilCleared: retried.rows[0]?.locked_until === null,
          failureReasonRedacted: retried.rows[0]?.failure_reason === "Failed with token=[REDACTED]."
        },
        metrics: {
          finalStatus: retried.rows[0]?.status ?? "unknown",
          attemptCount: retried.rows[0]?.attempt_count ?? 0
        }
      };
    });

    await recordScenario("exhausted_lease_failure", async () => {
      await pool.query("DELETE FROM siteflow_build_jobs WHERE id = 'build_stale_retry'");
      await seedBuildJob({
        id: "build_stale_exhausted",
        sourceEventId: "source_stale_exhausted",
        status: "running",
        startedAt: "2026-06-07T00:00:00.000Z",
        workerId: "worker-old",
        attemptCount: 3,
        maxAttempts: 3,
        lockedUntil: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z"
      });

      await expect(queue.claimNextJob("worker-new")).resolves.toBeUndefined();

      const exhausted = await pool.query<{ status: string; failure_reason: string }>(
        `
          SELECT status, failure_reason
          FROM siteflow_build_jobs
          WHERE id = 'build_stale_exhausted'
        `
      );

      expect(exhausted.rows[0]).toEqual({
        status: "failed",
        failure_reason: "Build lease expired after max attempts."
      });

      return {
        assertions: {
          claimReturnedUndefined: true,
          exhaustedLeaseFailed: exhausted.rows[0]?.status === "failed"
        },
        metrics: {
          finalStatus: exhausted.rows[0]?.status ?? "unknown",
          attemptCountAtSeed: 3,
          maxAttemptsAtSeed: 3
        }
      };
    });
  });
});
