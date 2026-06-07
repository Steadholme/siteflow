# F-005 Artifact Storage Management

## Summary

Artifact Storage Management publishes, indexes, verifies, retains, and deletes immutable deployment outputs and manifests. Artifacts are the foundation for routing, preview, promotion, and rollback confidence.

## User Value

Release managers can roll back without rebuilding source. Operators can inspect artifact checksum, size, location, retention status, and manifest. Storage cleanup is safe because active and rollback-eligible artifacts are protected.

## Requirements

- MUST publish immutable artifacts with checksum verification.
- MUST write artifact manifest before any deployment becomes routable.
- MUST store project ID, deployment ID, build job ID, commit SHA, checksum, size, file count, content type summary, storage adapter, storage key, and creation time.
- SHOULD support local filesystem and S3-compatible backends behind one adapter contract.
- MUST NOT delete artifacts referenced by active release channels, rollback windows, active previews, pins, or holds.
- SHOULD keep tombstones and audit events for deletion.

## Data/State

`artifacts` records verification state, retention state, manifest schema version, manifest checksum, storage adapter, object key, and deletion timestamp. Manifest files include source, build, framework, output directory, file entries, cache hints, checksum algorithm, storage metadata, and producer worker image.

## Operations

Publish uses a two-phase pattern: upload temporary object, verify checksum, insert artifact and manifest records, then mark deployment ready. Garbage collection marks `delete_pending`, performs adapter deletion, and records durable outcome. Periodic verification checks active release artifacts against database, manifest, and backend metadata.

## Acceptance Criteria

- Deployment cannot become routable until manifest exists and checksum passes.
- Active production, staging, rollback, preview, pinned, or held artifacts cannot be deleted.
- Operators can see storage location, checksum, size, file count, and retention status.
- Failed publication fails the deployment before routing or promotion.
- Local and S3-like backends expose normalized error codes.

## Open Questions

- Which backend is the reference MVP default: local filesystem or S3-compatible?
- What are default retention windows for production, staging, preview, failed builds, and logs?
- Should content-addressed object keys be required or optional?

