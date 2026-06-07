# Data Architect Analysis

Role: data-architect  
Topic: SiteFlow self-hosted Vercel-like deployment framework  
Primary concern: durable control-plane data, immutable artifact metadata, deployment lineage, storage boundaries, retention, indexing, and auditability.

## Position

SiteFlow SHOULD treat the relational control-plane database as the source of truth for projects, source events, build jobs, deployments, release channels, routing intent, retention policy, and audit trail. Artifact backends MUST own bytes, but MUST NOT be the only location for lineage or release state.

The central data invariant is: source input plus build execution produces an immutable artifact; deployment records bind that artifact to a project and Git revision; release channels and previews are mutable pointers or routes to immutable deployments. Rollback MUST move pointers, not rebuild source and not mutate artifact contents.

## Output Index

- `analysis-cross-cutting.md`: shared data model decisions, lineage rules, consistency boundaries, artifact manifest shape, indexing, retention, audit, and storage adapter contract.
- `analysis-F-001-project-management.md`: project, repository, domain, environment, retention, and audit boundaries.
- `analysis-F-002-git-webhook-ingestion.md`: webhook event normalization, idempotency, event storage, and queue consistency.
- `analysis-F-003-framework-detection-versioning.md`: detector outputs, version sequences, build metadata, and preset change history.
- `analysis-F-004-docker-build-worker.md`: job state persistence, leases, logs, worker events, and build-to-artifact handoff.
- `analysis-F-005-artifact-storage-management.md`: artifact records, manifests, storage adapter contracts, verification, garbage collection, and retention.
- `analysis-F-006-routing-cdn-integration.md`: domain and route bindings, generated config revisions, CDN operation history, and routing consistency.
- `analysis-F-007-preview-deployments.md`: preview URL identity, branch and PR lineage, update behavior, review metadata, and retention.
- `analysis-F-008-release-promotion-rollback.md`: release channel pointer model, transactional promotion, rollback history, audit, and routing coupling.

## Data Architecture Themes

SiteFlow MUST separate logical entities from provider-specific payloads. Git providers, storage systems, routing targets, and CDN vendors SHOULD be represented by adapter metadata and normalized tables so the product can add providers without changing deployment lineage.

Artifact manifests MUST be versioned. A manifest schema version allows storage verification, future compression formats, file-level metadata, and CDN prewarm logic to evolve without rewriting historical deployment records.

Indexes MUST be designed for operational workflows: project deployment history, commit lookup, branch preview lookup, active release resolution, pending job claims, artifact protection checks, and audit timeline search.

Retention MUST be reference-aware. Active release channels, rollback windows, active previews, pinned deployments, and explicit legal or operator holds MUST protect artifacts from deletion.

Audit events SHOULD be append-only and actor-aware. Administrative actions, provider-triggered events, system-generated transitions, retention deletions, routing reloads, and CDN purges MUST be traceable to an actor, source, timestamp, and target entity.
