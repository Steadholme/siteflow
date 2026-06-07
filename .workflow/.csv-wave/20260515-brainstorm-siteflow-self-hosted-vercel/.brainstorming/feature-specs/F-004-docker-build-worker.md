# F-004 Docker Build Worker

## Summary

The Docker Build Worker claims deployment jobs, clones source, resolves build profile, runs isolated Docker builds, validates output, streams redacted logs, and publishes verified artifacts. Workers are separate from the control-plane API and treat repository code as untrusted input.

## User Value

Developers receive actionable build feedback without SSH access. Operators can bound resource use, inspect worker health, and trust that successful jobs produce deployable artifacts while failed jobs remain non-routable.

## Requirements

- MUST claim jobs atomically with lease or queue semantics.
- MUST transition jobs through queued, running, succeeded, failed, canceled, or timed-out states.
- MUST run builds in disposable containers with CPU, memory, timeout, workspace cleanup, and controlled environment variables.
- MUST NOT mount the host Docker socket into build containers by default.
- MUST redact configured secret patterns in logs.
- MUST validate output directory before artifact publication.
- SHOULD emit structured phase events for clone, detect, install, build, validate, publish, and finalize.

## Data/State

`build_jobs` stores status, priority, attempts, lease owner, lease expiration, worker ID, timeouts, timestamps, selected config, and failure code. `build_events` stores phase timelines. Logs are stored separately with metadata indexed by build job. Cache records are separate from artifacts and never define deployment identity.

## Operations

Workers heartbeat while running jobs. Stale leases are retried only after container cleanup or orphan marking. Timeout stops the container and records `timed_out`. Artifact publication follows output validation, temporary upload, checksum verification, manifest write, and deployment readiness.

## Acceptance Criteria

- One queued job is claimed by only one worker.
- Timed-out jobs stop containers and expose timeout classification.
- Missing output directory fails before artifact publishing.
- Logs show phase markers and redact configured secrets.
- Successful jobs create verified artifact metadata and deployment metadata.

## Open Questions

- What are default CPU, memory, timeout, and concurrency limits?
- Should outbound network access be open for package install in MVP?
- Is dependency cache part of MVP or deferred until reproducibility checks exist?

