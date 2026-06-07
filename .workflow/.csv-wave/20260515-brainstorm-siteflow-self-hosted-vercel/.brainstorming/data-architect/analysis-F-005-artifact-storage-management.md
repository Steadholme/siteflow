# F-005 Artifact Storage Management - Data Architecture

## Artifact Entity

Artifacts MUST be immutable and checksum-verified. The `artifacts` table SHOULD include artifact ID, project ID, deployment ID, build job ID, checksum algorithm, checksum, size bytes, file count, manifest schema version, content type summary, storage adapter, storage key, compression format, creation time, verification state, retention class, retention state, and deletion timestamp.

Artifact identity MAY be content-addressed, deployment-addressed, or both. Even when object keys are deployment-addressed, checksum MUST be indexed to support verification and duplicate detection.

## Manifest Requirements

An artifact manifest MUST be written before any deployment becomes routable. The manifest SHOULD be stored alongside the artifact bytes and referenced from the database by manifest key and manifest checksum.

The manifest MUST include enough data to serve, verify, and audit the artifact without accessing Git or rerunning builds. File-level entries SHOULD include path, size, checksum, content type, and cache policy hints.

## Storage Adapter Contract

Local filesystem and S3-compatible storage MUST share the same logical behavior:

- uploads are written to a temporary key first
- final commit verifies expected checksum
- committed objects are immutable from the SiteFlow perspective
- `head` can confirm object existence and size
- deletion returns a durable outcome

Adapters SHOULD surface backend-specific errors as normalized codes such as `not_found`, `checksum_mismatch`, `permission_denied`, `quota_exceeded`, and `transient_failure`.

## Consistency and Verification

Publishing SHOULD be two-phase: upload temp object, verify checksum, insert artifact and manifest rows, then mark deployment ready. If database insert fails after upload, a cleanup job SHOULD remove orphan temp objects. If adapter deletion fails during garbage collection, the artifact SHOULD remain `delete_pending` for retry.

SiteFlow SHOULD periodically verify active release artifacts by checking database checksum, manifest checksum, and backend object metadata. Full byte rehash MAY be scheduled for low-frequency integrity checks.

## Retention

Retention MUST be reference-aware. The collector MUST NOT delete artifacts referenced by active release channels, rollback windows, active previews, pinned deployments, or holds. Preview artifacts SHOULD have configurable age and count limits per project.

Deletion SHOULD create an audit event and a tombstone with artifact ID, object key, deletion actor, deletion reason, and adapter result.

## Indexing

Required operational indexes:

- `artifacts(project_id, created_at)`
- `artifacts(deployment_id)` unique
- `artifacts(checksum)`
- `artifacts(retention_state, retention_after)`
- `artifacts(storage_adapter, storage_key)`
- `artifacts(verification_state, updated_at)`
