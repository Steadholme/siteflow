# F-004 Docker Build Worker

## Architectural Scope

The Docker build worker MUST be isolated from the control-plane API. It SHOULD run as a horizontally scalable worker process that claims jobs from a durable queue or database-backed lease table.

Workers MUST treat repository source and build scripts as untrusted input. They MUST run builds in disposable containers with operator-defined CPU, memory, timeout, workspace, and network controls.

## Job Claim and Lifecycle

Job claims MUST be atomic and lease-based. A worker SHOULD heartbeat while running a job. If a heartbeat expires, a scheduler MUST verify container cleanup before retrying the job or marking it failed.

The worker lifecycle SHOULD use explicit phases: clone, detect, install, build, validate output, package, publish artifact, finalize deployment. Logs and structured phase events MUST include build job ID and deployment ID.

## Container Isolation

Build containers MUST NOT run privileged by default. Host Docker socket access MUST NOT be mounted into build containers. Filesystem mounts SHOULD be limited to a job workspace, read-only dependency cache where possible, and a controlled output path.

Network access SHOULD be configurable. The MVP MAY allow outbound package downloads, but operators SHOULD be able to restrict networks for reproducibility-sensitive projects.

## Secrets and Logs

Secrets MUST be injected only for the active build process and MUST be removed with workspace cleanup. Logs MUST be redacted using configured secret patterns before storage or streaming. Failed builds SHOULD preserve enough logs for diagnosis without exposing secret values.

## Cache Policy

Dependency cache mounts MAY improve speed, but cached content MUST NOT change artifact identity without being reflected in metadata. Cache keys SHOULD include package manager, lockfile checksum, framework preset, and worker image version.

## Failure Modes

Timeouts MUST stop the container and mark the job `timed_out`. Missing output directory MUST fail validation before artifact publication. Artifact publish failure MUST leave the deployment non-routable and SHOULD be retryable only when the output package is still available or reproducible.
