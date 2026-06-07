# Cross-Cutting System Architecture

## Service Boundaries

SiteFlow SHOULD be split into five deployable responsibilities:

1. Control Plane API: owns projects, deployments, release channels, audit records, and operator APIs.
2. Webhook Ingestion: verifies provider payloads and records normalized deployment intents.
3. Scheduler and Build Workers: claims jobs, clones source, detects frameworks, runs Docker builds, and publishes artifacts.
4. Artifact Store Adapter: writes immutable artifacts and manifests to local filesystem or S3-compatible storage.
5. Routing Applier: renders Nginx configuration from release-channel and preview state, validates it, reloads atomically, and optionally calls CDN adapters.

The database MUST be the source of truth for desired state. Nginx, CDN, local files, and object storage are materialized state and MUST be reconcilable from database records plus artifact manifests.

## Data Model

SiteFlow SHOULD start with these five core entities:

- Project: `id`, `slug`, `name`, `repo_binding`, `default_branch`, `framework_override`, `build_settings`, `domains`, `secret_refs`, `deployment_policy`, `status`, audit timestamps. Project slugs and active domains MUST be globally unique.
- BuildJob: `id`, `project_id`, `source_event_id`, `commit_sha`, `branch`, `state`, `worker_id`, `docker_image`, `resource_limits`, `log_ref`, `error_code`, `attempt`, `lease_expires_at`. Jobs MUST be claimed atomically.
- Deployment: `id`, `project_id`, `build_job_id`, `artifact_id`, `commit_sha`, `branch`, `tag`, `framework_preset`, `package_manager`, `build_command`, `output_dir`, `sequence`, `status`, `urls`. A deployment MUST record the exact build and artifact metadata used.
- Artifact: `id`, `deployment_id`, `checksum`, `manifest_uri`, `storage_uri`, `size_bytes`, `file_count`, `content_summary`, `retention_class`, `created_at`, `deleted_at`. Artifacts MUST be immutable after publish.
- ReleaseChannel: `project_id`, `name`, `active_deployment_id`, `previous_deployment_id`, `route_revision`, `operation_state`, `updated_by`, `updated_at`. A channel MUST point to exactly one active deployment when enabled.

## State Machine

Webhook event lifecycle MUST be explicit: `received -> verified -> normalized -> deduplicated -> ignored | enqueued`. Invalid events MUST stop before queueing and SHOULD retain safe diagnostic metadata.

Build job lifecycle MUST be: `queued -> claimed -> cloning -> detecting -> installing -> building -> validating_output -> publishing_artifact -> succeeded`. Terminal failure states are `failed`, `canceled`, and `timed_out`. A worker heartbeat loss SHOULD return a leased job to `queued` only when the build container has been stopped or marked orphaned.

Deployment lifecycle MUST be: `created -> building -> artifact_ready -> preview_active | release_candidate -> promoted | superseded | failed | expired`. A deployment MUST NOT enter `artifact_ready` until the artifact manifest and checksum verification succeed.

Release channel lifecycle MUST be: `idle -> promotion_pending -> route_applying -> active` or `idle -> rollback_pending -> route_applying -> active`. If route validation or reload fails, the channel operation MUST be marked failed and the previous known-good route config MUST remain active.

## Error Handling

Every failure SHOULD have a stable `error_code`, safe user message, internal details reference, and retry classification. Public APIs MUST NOT expose secrets, clone credentials, webhook secrets, raw environment variables, or redacted log segments.

Side effects MUST be idempotent. Webhook processing SHOULD use provider event IDs or deterministic fingerprints. Artifact publish SHOULD use staging keys followed by a final manifest commit. Routing changes SHOULD use an outbox record keyed by `route_revision`. CDN purges MAY be retried independently after the channel pointer is committed.

Promotion and rollback MUST use database transactions for channel pointer updates, deployment status updates, and audit records. External side effects MUST NOT be performed inside the database transaction; they SHOULD be driven by outbox records so failures can be retried or reconciled.

## Observability

SiteFlow MUST emit structured logs with correlation IDs for webhook event, build job, deployment, artifact, route revision, and release operation. It SHOULD emit traces across webhook ingestion, queue enqueue, worker execution, artifact publish, and route apply.

Minimum metrics SHOULD include:

- `siteflow_webhook_total{provider,event_type,result}`
- `siteflow_webhook_signature_failures_total{provider}`
- `siteflow_build_queue_depth{priority,environment}`
- `siteflow_build_claim_latency_seconds`
- `siteflow_build_duration_seconds{framework,result}`
- `siteflow_worker_active_containers{worker_id}`
- `siteflow_artifact_publish_bytes_total{backend}`
- `siteflow_artifact_checksum_failures_total{backend}`
- `siteflow_route_reload_total{result}`
- `siteflow_route_apply_duration_seconds`
- `siteflow_cdn_operation_duration_seconds{provider,operation,result}`
- `siteflow_release_channel_changes_total{channel,operation,result}`
- `siteflow_preview_active_total{project}`

Alerts SHOULD cover webhook rejection spikes, queue age above SLO, worker heartbeat loss, artifact checksum failures, Nginx reload failures, route drift, storage capacity pressure, and repeated CDN purge failures.

## Configuration Model

Configuration SHOULD have clear precedence: deployment request overrides project settings; project settings override framework preset defaults; preset defaults override global defaults. The resolved configuration used for a deployment MUST be persisted with the deployment.

Global configuration MUST include database, queue, artifact backend, Nginx config paths, CDN adapters, default Docker image, resource limits, timeout limits, log retention, artifact retention, and secret provider settings.

Project configuration MUST include repository binding, branch policies, framework override, build command override, output directory override, environment variables as secret references, domains, preview policy, and release policy.

Worker configuration MUST include allowed Docker images, CPU/memory limits, network mode, cache mounts, workspace root, clone timeout, build timeout, and maximum concurrent jobs. Workers MUST reject jobs whose requested configuration exceeds operator-defined limits.

Secrets MUST be referenced by stable IDs and resolved only by trusted control-plane or worker components at the point of use. Secret values MUST NOT be stored in deployment manifests, artifacts, route config, or build logs.
