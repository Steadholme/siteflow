# F-005 Artifact Storage Management

## Architectural Scope

Artifact storage MUST provide immutable deployment outputs and manifests. The storage layer SHOULD expose one adapter contract for local filesystem and S3-compatible backends so routing and release logic are independent of storage implementation.

The artifact store MUST NOT be used as the source of truth for deployment state. The database tracks desired state and references artifact manifests; storage holds bytes and manifests.

## Publish Contract

Artifact publish SHOULD use a staging location, checksum calculation, manifest write, and final commit step. A deployment MUST NOT become `artifact_ready` until the final manifest is written and checksum verification succeeds.

The manifest MUST include deployment ID, project ID, commit SHA, framework preset, output directory, checksum, size, file count, content type summary, storage URI, created time, and producer worker image version.

## Adapter Requirements

The storage adapter SHOULD support:

- `put_staged(deployment_id, archive_or_directory)`
- `verify(checksum, storage_uri)`
- `commit_manifest(manifest)`
- `open_manifest(artifact_id)`
- `mark_for_retention(artifact_id, retention_class)`
- `delete_if_unreferenced(artifact_id)`

Delete operations MUST check active release channels, rollback eligibility, and retention policy before removing bytes.

## Routing Integration

Routing appliers SHOULD consume artifact manifests or a local materialized artifact view. For local filesystem routing, artifacts SHOULD be placed under content-addressed paths and exposed through stable release-channel symlinks or generated Nginx roots. For S3-backed storage, Nginx MAY proxy/cache through an origin path or artifacts MAY be synchronized to local edge storage.

## Failure Modes

Checksum mismatch MUST fail the deployment and SHOULD quarantine the staged artifact. Storage backend unavailability SHOULD block promotion for new deployments but MUST NOT affect already-routed local artifacts. Retention sweeps MUST be conservative and SHOULD emit audit records for deleted artifacts.
