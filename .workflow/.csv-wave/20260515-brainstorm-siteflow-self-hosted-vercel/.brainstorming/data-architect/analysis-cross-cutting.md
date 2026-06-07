# Cross-Cutting Data Architecture

## Ownership Boundaries

The control-plane database MUST be authoritative for identity, policy, lifecycle state, routing intent, release channels, deployment lineage, and audit history. Artifact storage MUST be authoritative only for immutable bytes and backend-native object metadata. Nginx and CDN state SHOULD be treated as derived state generated from validated database records.

Provider-specific payloads SHOULD be stored in bounded raw tables or JSON columns only for troubleshooting and replay. Normalized SiteFlow entities MUST drive product behavior so GitHub, GitLab, Gitea, local filesystem, S3-compatible storage, Nginx, and CDN adapters can vary independently.

## Core Persistent Entities

- `projects`: stable project identity, slug, default branch, status, framework defaults, retention policy, and timestamps.
- `repository_bindings`: provider, repository identity, clone URL, default branch, credential reference, webhook secret reference, and adapter config.
- `source_events`: normalized webhook or manual deployment intent with event fingerprint, branch, commit SHA, PR metadata, actor, and dedupe status.
- `build_jobs`: queued work item with project, source event, status, lease, worker, selected build config, timestamps, and failure summary.
- `deployments`: immutable lineage record linking project, source revision, build job, artifact, environment intent, status, sequence number, and URLs.
- `artifacts`: immutable metadata record with checksum, size, file count, manifest version, storage adapter, object key, retention class, and verification state.
- `release_channels`: mutable pointer from project plus channel name to one active deployment.
- `channel_events`: append-only promotion and rollback history with previous and next deployment, actor, reason, routing revision, and outcome.
- `preview_deployments`: branch, PR, or commit preview route linked to a deployment and retention policy.
- `audit_events`: append-only operational trail for human, provider, and system actions.

## Deployment Lineage

Lineage MUST be expressible as:

`source_event -> build_job -> artifact -> deployment -> preview_deployment or release_channel`

Every deployment MUST record commit SHA, branch, optional tag, source event, framework preset, package manager, build command, output directory, builder image version, artifact checksum, and manifest ID. SiteFlow MUST NOT infer these values later from mutable project settings.

Release channels MUST point to deployments, not artifacts directly. This preserves context such as source revision, build log, environment intent, validation status, and audit history.

## Artifact Manifest Contract

Each artifact MUST have a manifest stored with the artifact and indexed in the database. The manifest SHOULD include:

- `schemaVersion`
- `projectId`, `deploymentId`, `buildJobId`
- `commitSha`, `branch`, optional `tag`
- `artifactChecksum`, `checksumAlgorithm`, `sizeBytes`, `fileCount`
- `files[]` with path, size, checksum, content type, and cache hints for routable assets
- `frameworkPreset`, `packageManager`, `buildCommand`, `outputDirectory`
- `storageAdapter`, `storageKey`, optional compression format
- `createdAt`, `createdByWorker`, `retentionClass`

Manifest writes MUST complete before a deployment can become routable. Manifest schema changes MUST be backward compatible or explicitly migrated.

## Consistency Boundaries

Webhook ingestion MUST dedupe before enqueueing build jobs. Build workers MUST claim jobs atomically using a row lock, compare-and-swap status update, or queue lease. Artifact publication SHOULD use a two-phase pattern: upload to temporary key, verify checksum, write artifact and manifest records, then mark deployment publishable.

Promotion and rollback MUST be transactional across release channel pointer update, channel event insertion, routing revision creation, and audit event insertion. Applying Nginx or CDN changes is external side effect work, so SiteFlow SHOULD persist a pending routing revision first, then mark it applied or failed after validation and reload.

## Retention and Deletion

Retention MUST evaluate references before deleting bytes. Protected references include active release channels, configured rollback windows, pinned deployments, active previews, unresolved incident holds, and audit/legal holds. Garbage collection SHOULD mark artifacts as `delete_pending`, perform adapter deletion, then mark `deleted` with a tombstone record.

Deletion MUST NOT remove deployment or audit records. Historical rows MAY redact sensitive provider payload fragments, but lineage and operator actions SHOULD remain queryable.

## Audit Trail

Audit events MUST include actor type, actor ID, action, target type, target ID, correlation ID, request ID where available, source IP for API actions, before/after summary, and timestamp. System-generated transitions SHOULD use actor type `system` plus worker or scheduler identity.

Audit storage SHOULD be append-only. Updates to business tables MUST NOT be the only record of promotion, rollback, retention deletion, domain ownership changes, or secret reference changes.

## Indexing

Required indexes SHOULD include:

- `projects(slug)` unique and `projects(status, updated_at)`
- `repository_bindings(provider, repo_external_id)` unique where applicable
- `source_events(project_id, event_fingerprint)` unique
- `build_jobs(status, priority, created_at)` for claims
- `deployments(project_id, sequence)` unique and `deployments(project_id, commit_sha)`
- `artifacts(checksum)` and `artifacts(retention_state, created_at)`
- `release_channels(project_id, name)` unique
- `preview_deployments(project_id, branch_slug)` and `preview_deployments(project_id, pr_number)`
- `audit_events(target_type, target_id, created_at)`

## Storage Adapter Contract

Storage adapters MUST implement a small, testable contract:

- `putTemporary(stream, metadata) -> tempRef`
- `commit(tempRef, finalKey, expectedChecksum) -> objectRef`
- `head(objectRef) -> objectMetadata`
- `open(objectRef) -> stream`
- `delete(objectRef) -> deletionResult`
- `signReadUrl(objectRef, ttl)` where backend supports signed URLs

Adapters MUST provide consistent checksum behavior. Local filesystem and S3-compatible backends SHOULD use the same logical object key convention: `projects/{projectId}/deployments/{deploymentId}/artifact.{ext}` plus `manifest.json`.
