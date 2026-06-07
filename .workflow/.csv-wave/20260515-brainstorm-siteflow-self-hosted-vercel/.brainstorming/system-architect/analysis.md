# System Architect Analysis

Role: system-architect  
Topic: SiteFlow self-hosted Vercel-like deployment framework  
Guidance source: `../guidance-specification.md`

## Architecture Position

SiteFlow SHOULD be implemented as a small deployment control plane with separate execution and routing adapters. The core boundary MUST be: Git events create deployment intent, workers produce immutable artifacts, release channels point at verified deployments, and routing adapters materialize those pointers into Nginx and optional CDN state.

The MVP SHOULD NOT become a generic CI/CD orchestrator. It MUST optimize for deterministic static/prerendered deployments, reliable rollback, auditable promotion, and reproducible artifact metadata.

## Output Index

- `analysis-cross-cutting.md`: shared system decisions, data model, state machine, error handling, observability, and configuration model.
- `analysis-F-001-project-management.md`: project aggregate, settings ownership, domain uniqueness, secret references, and audit boundaries.
- `analysis-F-002-git-webhook-ingestion.md`: signed webhook intake, normalization, idempotency, queueing, and retry handling.
- `analysis-F-003-framework-detection-versioning.md`: framework detection, explicit override precedence, deployment versioning, and reproducibility metadata.
- `analysis-F-004-docker-build-worker.md`: build scheduler, Docker worker lifecycle, isolation, logs, cache policy, and failure contracts.
- `analysis-F-005-artifact-storage-management.md`: immutable artifact publishing, manifests, storage adapters, retention, and delete safeguards.
- `analysis-F-006-routing-cdn-integration.md`: route resolution, generated Nginx config, atomic reload, CDN adapter model, and recovery path.
- `analysis-F-007-preview-deployments.md`: preview URL model, PR/branch lifecycle, retention, and separation from release channels.
- `analysis-F-008-release-promotion-rollback.md`: transactional channel movement, rollback without rebuild, audit trail, and route application.

## Primary System Shape

SiteFlow SHOULD use a relational database as the source of truth, a durable queue for build work and routing work, Docker workers for untrusted build execution, an artifact storage adapter for local or S3-compatible backends, and a routing applier that renders Nginx config from validated database state.

Promotion and rollback MUST be pointer operations against immutable deployments. The system SHOULD use an outbox pattern for side effects such as Nginx reloads, CDN purges, Git provider status callbacks, and notification hooks. This keeps database state auditable while allowing side effects to be retried safely.

The strongest architectural invariant is: a deployment MUST NOT become routable until its artifact manifest is written, checksum-verified, and linked to the deployment record.
