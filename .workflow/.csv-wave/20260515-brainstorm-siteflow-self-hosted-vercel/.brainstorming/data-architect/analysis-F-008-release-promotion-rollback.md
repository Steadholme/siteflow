# F-008 Release Promotion and Rollback - Data Architecture

## Release Channel Model

A release channel MUST be a mutable pointer from project plus channel name to exactly one active deployment. The deployment MUST be successful, artifact-verified, and not deleted. Channel rows SHOULD include project ID, name, active deployment ID, status, updated by, updated at, and current sequence number.

Release channels MUST NOT point directly to storage objects. The deployment record is the durable boundary that carries artifact, source, build, framework, and audit context.

## Channel Event History

Every promotion and rollback MUST create an append-only `channel_event` with project ID, channel name, previous deployment ID, next deployment ID, event type, actor, reason, request ID, routing revision ID, status, and timestamp.

Rollback MUST select from previously successful deployments and MUST NOT create a new build job. If an operator rolls back to a deployment whose artifact is missing or unverified, the operation MUST fail before changing the active channel pointer.

## Transactional Promotion

Promotion and rollback SHOULD use a database transaction that:

1. Locks the release channel row.
2. Verifies target deployment status and artifact protection.
3. Updates the active deployment pointer and channel sequence.
4. Inserts channel event history.
5. Creates a pending routing config revision.
6. Inserts audit event.

External routing reload and CDN operations SHOULD run after commit and update their own operation records. If routing apply fails, SiteFlow SHOULD surface channel state as needing attention and preserve the last known-good routing revision.

## Rollback Safety

Artifact retention MUST protect deployments referenced by active channels and configured rollback windows. The release history UI/API SHOULD show whether a deployment is rollback-eligible, artifact-verified, retained, pinned, or blocked.

SiteFlow SHOULD support operator pinning for known-good deployments. Pins MUST be auditable and MUST block garbage collection.

## Indexing

Required indexes:

- `release_channels(project_id, name)` unique
- `channel_events(project_id, channel_name, sequence)` unique
- `channel_events(project_id, channel_name, created_at)`
- `deployments(project_id, status, created_at)`
- `deployments(project_id, commit_sha)`
- `artifacts(deployment_id, verification_state)`

## Audit and Compliance

Promotion and rollback audit events MUST include actor, reason, previous deployment, next deployment, commit SHA, artifact checksum, routing revision, and outcome. The reason SHOULD be required for production rollback.

Approval gates MAY be added later, but the data model SHOULD reserve room for approval records linked to channel events rather than embedding approvals directly in release channel rows.
