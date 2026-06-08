import type { Pool } from "pg";
import { createHash } from "node:crypto";
import type { ProjectBuildSettings, RepositoryBinding, SourceEvent } from "../src/domain/siteflow.js";
import { redactLogLine } from "../src/lib/redaction.js";
import { unsealSecretValue } from "../src/lib/sealedSecrets.js";
import type { BuildCronJob, BuildJobResult, BuildQueue, QueuedBuildJob } from "./buildWorker.js";

interface BuildJobClaimRow {
  job_id: string;
  project_id: string;
  project_slug: string;
  production_branch: string;
  repository: RepositoryBinding | Record<string, never>;
  project_build_settings: ProjectBuildSettings | Record<string, never>;
  source_event_id: string;
  kind: SourceEvent["kind"];
  provider_delivery_id: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  commit_author: string;
  received_at: Date;
  actor: SourceEvent["actor"];
  framework: string;
  install_command: string;
  build_command: string;
  output_directory: string;
  environment_variables: Record<string, string> | null;
}

export interface PostgresBuildQueueOptions {
  leaseMs?: number;
}

interface ClaimedBuildLease {
  workerId: string;
}

interface BuildJobAttemptRow {
  attempt_count: number;
  max_attempts: number;
}

const DEFAULT_BUILD_JOB_LEASE_MS = 30 * 60 * 1000;
const EXHAUSTED_BUILD_LEASE_FAILURE_REASON = "Build lease expired after max attempts.";

function normalizeLeaseMs(value: number | undefined) {
  if (value === undefined) {
    return DEFAULT_BUILD_JOB_LEASE_MS;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Postgres build queue leaseMs must be a positive number.");
  }

  return Math.ceil(value);
}

function defaultRepository(row: BuildJobClaimRow): RepositoryBinding {
  return {
    provider: "generic",
    owner: "local",
    name: row.project_slug,
    defaultBranch: row.production_branch
  };
}

function queueJobFromRow(row: BuildJobClaimRow): QueuedBuildJob {
  const repository = Object.keys(row.repository).length > 0 ? row.repository as RepositoryBinding : defaultRepository(row);
  const projectBuildSettings = row.project_build_settings as Partial<ProjectBuildSettings>;
  const environmentVariables = unsealEnvironmentVariables(row.environment_variables);

  return {
    id: row.job_id,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    productionBranch: row.production_branch,
    sourceEventId: row.source_event_id,
    sourceEvent: {
      id: row.source_event_id,
      projectId: row.project_id,
      kind: row.kind,
      status: "accepted",
      disposition: "build_requested",
      providerDeliveryId: row.provider_delivery_id,
      branch: row.branch,
      commitSha: row.commit_sha,
      commitMessage: row.commit_message,
      commitAuthor: row.commit_author,
      receivedAt: row.received_at.toISOString(),
      actor: row.actor
    },
    repository,
    buildSettings: {
      framework: row.framework || projectBuildSettings.framework || "static",
      installCommand: row.install_command,
      buildCommand: row.build_command,
      outputDirectory: row.output_directory,
      rootDirectory: projectBuildSettings.rootDirectory,
      ignoreCommand: projectBuildSettings.ignoreCommand
    },
    environmentVariables
  };
}

function unsealEnvironmentVariables(values: Record<string, string> | null | undefined) {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [key, unsealSecretValue(value)])
  );
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function cronJobName(pathName: string) {
  const normalizedPath = pathName.trim().replace(/\s+/g, " ");
  const baseName = `vercel:${normalizedPath}`;

  if (baseName.length <= 80) {
    return baseName;
  }

  const digest = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 12);
  return `vercel:${normalizedPath.slice(0, 60)}:${digest}`;
}

function normalizeCronPath(value: string) {
  const pathName = value.trim();

  if (!pathName.startsWith("/") || pathName.includes("://") || pathName.includes("..") || pathName.length > 512) {
    throw new Error("Cron job path must start with / and must not contain protocol or parent directory segments.");
  }

  return pathName;
}

function normalizeCronSchedule(value: string) {
  const schedule = value.trim().replace(/\s+/g, " ");
  const fields = schedule.split(" ");

  if (fields.length !== 5) {
    throw new Error("Cron schedule must contain five fields: minute hour day-of-month month day-of-week.");
  }

  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7]
  ] as const;

  fields.forEach((field, index) => {
    if (!isCronField(field, ranges[index][0], ranges[index][1])) {
      throw new Error(`Cron schedule field ${index + 1} is invalid: ${field}.`);
    }
  });

  return schedule;
}

function isCronField(field: string, min: number, max: number) {
  return field.split(",").every((part) => isCronPart(part, min, max));
}

function isCronPart(part: string, min: number, max: number) {
  const [rangePart, stepPart] = part.split("/", 2);

  if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1 || Number(stepPart) > max)) {
    return false;
  }

  if (rangePart === "*") {
    return true;
  }

  if (rangePart.includes("-")) {
    const [left, right] = rangePart.split("-", 2).map(Number);
    return Number.isInteger(left) && Number.isInteger(right) && left >= min && right <= max && left <= right;
  }

  if (!/^\d+$/.test(rangePart)) {
    return false;
  }

  const numeric = Number(rangePart);
  return numeric >= min && numeric <= max;
}

async function upsertBuildCronJob(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, projectId: string, cron: BuildCronJob) {
  const name = cronJobName(cron.path);
  const pathName = normalizeCronPath(cron.path);
  const schedule = normalizeCronSchedule(cron.schedule);

  await client.query(
    `
      INSERT INTO siteflow_cron_jobs (
        id,
        project_id,
        name,
        path,
        schedule,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (project_id, name) DO UPDATE
      SET path = EXCLUDED.path,
          schedule = EXCLUDED.schedule,
          status = 'active',
          disabled_by = NULL,
          disable_reason = NULL,
          disabled_at = NULL,
          updated_at = now()
    `,
    [
      stableId("cron", `${projectId}:${name}`),
      projectId,
      name,
      pathName,
      schedule,
      JSON.stringify({
        id: "siteflow:worker",
        name: "Build worker",
        role: "system"
      })
    ]
  );
}

export class PostgresBuildQueue implements BuildQueue {
  private readonly leaseMs: number;
  private readonly claimedBuildLeases = new WeakMap<QueuedBuildJob, ClaimedBuildLease>();

  constructor(private readonly pool: Pool, options: PostgresBuildQueueOptions = {}) {
    this.leaseMs = normalizeLeaseMs(options.leaseMs);
  }

  private claimedWorkerId(job: QueuedBuildJob, action: string) {
    const lease = this.claimedBuildLeases.get(job);

    if (!lease?.workerId) {
      throw new Error(`Cannot ${action} build job ${job.id} without an active local worker lease.`);
    }

    return lease.workerId;
  }

  async claimNextJob(workerId: string): Promise<QueuedBuildJob | undefined> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          UPDATE siteflow_build_jobs
          SET status = 'failed',
              finished_at = now(),
              locked_until = NULL,
              heartbeat_at = now(),
              failure_reason = $1
          WHERE status = 'running'
            AND (locked_until IS NULL OR locked_until <= now())
            AND attempt_count >= max_attempts
        `,
        [EXHAUSTED_BUILD_LEASE_FAILURE_REASON]
      );

      const result = await client.query<BuildJobClaimRow>(
        `
          SELECT
            build.id AS job_id,
            build.project_id,
            project.slug AS project_slug,
            project.production_branch,
            project.repository,
            project.build_settings AS project_build_settings,
            source.id AS source_event_id,
            source.kind,
            source.provider_delivery_id,
            source.branch,
            source.commit_sha,
            source.commit_message,
            source.commit_author,
            source.received_at,
            source.actor,
            build.framework,
            build.install_command,
            build.build_command,
            build.output_directory,
            COALESCE(
              (
                SELECT jsonb_object_agg(env.key, env.sealed_value)
                FROM siteflow_environment_variables env
                WHERE env.project_id = build.project_id
                  AND env.scope = 'build'
                  AND env.source = 'sealed'
                  AND env.sealed_value IS NOT NULL
                  AND env.target_environment = CASE
                    WHEN source.branch = project.production_branch THEN 'production'
                    ELSE 'preview'
                  END
              ),
              '{}'::jsonb
            ) AS environment_variables
          FROM siteflow_build_jobs build
          JOIN siteflow_projects project ON project.id = build.project_id
          JOIN siteflow_source_events source ON source.id = build.source_event_id
          WHERE (
              build.status = 'queued'
              OR (
                build.status = 'running'
                AND (build.locked_until IS NULL OR build.locked_until <= now())
              )
            )
            AND build.attempt_count < build.max_attempts
          ORDER BY build.queued_at ASC
          FOR UPDATE OF build SKIP LOCKED
          LIMIT 1
        `
      );
      const row = result.rows[0];

      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }

      await client.query(
        `
          UPDATE siteflow_build_jobs
          SET status = 'running',
              worker_id = $2,
              started_at = now(),
              heartbeat_at = now(),
              locked_until = now() + ($3::integer * interval '1 millisecond'),
              attempt_count = attempt_count + 1,
              finished_at = NULL,
              failure_reason = NULL
          WHERE id = $1
        `,
        [row.job_id, workerId, this.leaseMs]
      );

      await client.query("COMMIT");
      const job = queueJobFromRow(row);
      this.claimedBuildLeases.set(job, { workerId });
      return job;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendLog(jobId: string, line: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO siteflow_build_logs (build_job_id, line)
        VALUES ($1, $2)
      `,
      [jobId, redactLogLine(line)]
    );
  }

  async heartbeatJob(job: QueuedBuildJob): Promise<void> {
    const workerId = this.claimedWorkerId(job, "renew");

    await this.pool.query(
      `
        UPDATE siteflow_build_jobs
        SET heartbeat_at = now(),
            locked_until = now() + ($2::integer * interval '1 millisecond')
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $3
      `,
      [job.id, this.leaseMs, workerId]
    );
  }

  async completeJob(job: QueuedBuildJob, result: BuildJobResult): Promise<void> {
    const workerId = this.claimedWorkerId(job, "complete");
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const markSucceeded = await client.query(
        `
          UPDATE siteflow_build_jobs
          SET status = 'succeeded',
              finished_at = now(),
              locked_until = NULL,
              heartbeat_at = now(),
              failure_reason = NULL
          WHERE id = $1
            AND status = 'running'
            AND worker_id = $2
        `,
        [job.id, workerId]
      );

      if (markSucceeded.rowCount === 0) {
        await client.query("COMMIT");
        this.claimedBuildLeases.delete(job);
        return;
      }

      await client.query(
        `
          INSERT INTO siteflow_deployments (
            id,
            project_id,
            source_type,
            source_branch,
            source_commit_sha,
            status,
            artifact_root,
            checksum,
            file_count,
            total_bytes,
            preview_host,
            source_event_id,
            build_job_id,
            artifact_manifest
          )
          VALUES ($1, $2, 'git', $3, $4, 'ready', $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        `,
        [
          result.deploymentId,
          job.projectId,
          job.sourceEvent.branch,
          job.sourceEvent.commitSha,
          result.artifact.artifactRoot,
          result.artifact.checksum,
          result.artifact.fileCount,
          result.artifact.totalBytes,
          result.previewHost,
          job.sourceEventId,
          job.id,
          JSON.stringify(result.artifact.manifest)
        ]
      );

      await client.query(
        `
          INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
          VALUES ($1, $2, $3, $4)
        `,
        [result.previewHost, result.deploymentId, result.artifact.artifactRoot, result.artifact.entrypoint]
      );

      for (const cron of result.crons ?? []) {
        await upsertBuildCronJob(client, job.projectId, cron);
      }

      await client.query("COMMIT");
      this.claimedBuildLeases.delete(job);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async skipJob(job: QueuedBuildJob, reason: string): Promise<void> {
    const workerId = this.claimedWorkerId(job, "skip");

    await this.pool.query(
      `
        UPDATE siteflow_build_jobs
        SET status = 'skipped',
            finished_at = now(),
            locked_until = NULL,
            heartbeat_at = now(),
            failure_reason = $2
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $3
      `,
      [job.id, redactLogLine(reason), workerId]
    );
    this.claimedBuildLeases.delete(job);
  }

  async failJob(job: QueuedBuildJob, reason: string): Promise<void> {
    const workerId = this.claimedWorkerId(job, "fail");
    const client = await this.pool.connect();
    const failureReason = redactLogLine(reason);

    try {
      await client.query("BEGIN");

      const attemptResult = await client.query<BuildJobAttemptRow>(
        `
          SELECT attempt_count, max_attempts
          FROM siteflow_build_jobs
          WHERE id = $1
            AND status = 'running'
            AND worker_id = $2
          FOR UPDATE
        `,
        [job.id, workerId]
      );
      const attempt = attemptResult.rows[0];

      if (!attempt) {
        await client.query("COMMIT");
        this.claimedBuildLeases.delete(job);
        return;
      }

      if (attempt.attempt_count < attempt.max_attempts) {
        await client.query(
          `
            UPDATE siteflow_build_jobs
            SET status = 'queued',
                queued_at = now(),
                finished_at = NULL,
                worker_id = NULL,
                locked_until = NULL,
                heartbeat_at = now(),
                failure_reason = $2
            WHERE id = $1
              AND worker_id = $3
          `,
          [job.id, failureReason, workerId]
        );
      } else {
        await client.query(
          `
            UPDATE siteflow_build_jobs
            SET status = 'failed',
                finished_at = now(),
                locked_until = NULL,
                heartbeat_at = now(),
                failure_reason = $2
            WHERE id = $1
              AND worker_id = $3
          `,
          [job.id, failureReason, workerId]
        );
      }

      await client.query("COMMIT");
      this.claimedBuildLeases.delete(job);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
