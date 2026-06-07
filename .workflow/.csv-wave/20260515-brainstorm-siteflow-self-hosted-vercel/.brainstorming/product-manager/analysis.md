# Product Manager Analysis Index

## Role Position

SiteFlow SHOULD be positioned as an internal deployment platform for teams that want Vercel-like static deployment ergonomics without outsourcing infrastructure, artifact custody, routing control, or release history. The product promise is not "all CI/CD in one box"; it is "a Git commit becomes a verified immutable artifact that can be previewed, promoted, routed, and rolled back under operator control."

## Primary Personas

- Platform operator: owns SiteFlow installation, routing adapters, build workers, artifact storage, secrets policy, and operational health.
- Project owner: configures a project, domains, framework settings, environment variables, and release policy.
- Developer: pushes code or opens pull requests and expects reliable build feedback, preview URLs, and visible failures.
- Release manager: promotes successful deployments and performs rollback with audit context.
- Support engineer: needs fast read-only lookup of current production version, previous deployment, build logs, and routing status.

## Product Priorities

P0 MUST prove the deployment loop end to end: project setup, signed webhook ingestion, framework detection, Docker build execution, immutable artifact publishing, Nginx routing, and promotion or rollback. F-007 previews SHOULD remain P1 unless the team has wildcard DNS and routing primitives already stabilized; previews are high value but should not delay the reliable production path.

The MVP SHOULD ship as API-first plus a minimal operator console for project state, deployments, logs, promotion, rollback, and routing status. A polished multi-tenant SaaS dashboard MUST NOT be treated as part of MVP.

## Feature Files

- [F-001 Project Management](analysis-F-001-project-management.md): product model, setup flow, settings, audit, project lifecycle.
- [F-002 Git Webhook Ingestion](analysis-F-002-git-webhook-ingestion.md): provider intake, deployment intent, deduplication, feedback.
- [F-003 Framework Detection and Versioning](analysis-F-003-framework-detection-versioning.md): detection confidence, explicit overrides, version lineage.
- [F-004 Docker Build Worker](analysis-F-004-docker-build-worker.md): build lifecycle, logs, isolation, developer-visible failures.
- [F-005 Artifact Storage Management](analysis-F-005-artifact-storage-management.md): immutable artifacts, manifests, retention, deletion guardrails.
- [F-006 Routing and CDN Integration](analysis-F-006-routing-cdn-integration.md): atomic Nginx routing, optional CDN operations, operator confidence.
- [F-007 Preview Deployments](analysis-F-007-preview-deployments.md): PR and branch previews, retention, review workflow.
- [F-008 Release Promotion and Rollback](analysis-F-008-release-promotion-rollback.md): transactional channel movement, rollback, audit trail.

## Cross-Cutting File

[Cross-Cutting Product Decisions](analysis-cross-cutting.md) captures positioning against Vercel and self-hosted CI/CD, MVP boundaries, roadmap, success metrics, packaging, and release gates.

## MVP Acceptance Summary

MVP acceptance SHOULD require one supported Git provider, one artifact backend, Nginx routing, Docker worker isolation, at least three framework presets, visible build logs, deterministic rollback, and documented operator setup. The product MUST demonstrate that an operator can create a project, push a commit, produce an artifact, route staging or production to it, and roll back without rebuilding source.
