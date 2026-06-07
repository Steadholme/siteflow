# F-004 Docker Build Worker - Data Architecture

## Build Job State

`build_jobs` MUST be claimable atomically and MUST move through explicit states: `queued`, `running`, `succeeded`, `failed`, `canceled`, or `timed_out`. The table SHOULD include priority, attempts, lease owner, lease expiration, worker ID, queued timestamp, started timestamp, finished timestamp, timeout seconds, and failure code.

Workers MUST NOT claim jobs by reading and updating without a concurrency guard. SiteFlow SHOULD use row locks, compare-and-swap status updates, or a queue primitive with lease semantics.

## Worker and Phase Events

Build execution SHOULD emit append-only `build_events`: job claimed, source checkout started, dependency install started, build command started, output validation started, artifact upload started, artifact verification completed, job completed, job failed, and timeout.

Each event SHOULD include build job ID, worker ID, phase, status, timestamp, duration where known, and redacted message. These events support UI timelines, metrics, and failure diagnosis without parsing logs.

## Logs

Build logs SHOULD be stored separately from core job rows. Log chunks MAY live in object storage or a log backend, but metadata MUST be indexed by build job ID. Logs MUST be redacted for configured secret patterns before persistence or display.

Retention policy SHOULD support shorter retention for failed build logs than for successful deployment metadata, while incident-pinned logs MAY be protected.

## Artifact Handoff

The worker MUST validate that the output directory exists before publishing. Artifact creation SHOULD use a transaction boundary that prevents a `succeeded` job without a verified artifact and prevents a routable deployment without a manifest.

Recommended sequence:

1. Worker claims job and creates or updates deployment as `building`.
2. Worker completes build and validates output directory.
3. Worker uploads artifact to temporary storage key.
4. Worker verifies checksum and writes artifact plus manifest records.
5. Worker marks deployment `ready` and job `succeeded`.

If artifact upload or verification fails, the job MUST fail with a distinct failure code and the deployment MUST NOT become routable.

## Caches

Build cache metadata SHOULD be separated from artifacts. Cache records MAY include project ID, framework preset, cache key, backend key, created time, last used time, and size. Cache deletion MUST NOT affect artifact reproducibility or deployment lineage.

## Indexing

The scheduler needs indexes on `build_jobs(status, priority, created_at)` and `build_jobs(lease_expires_at)` for stale lease recovery. Operators need `build_jobs(project_id, created_at)`, `build_jobs(worker_id, started_at)`, and `build_events(build_job_id, created_at)`.
