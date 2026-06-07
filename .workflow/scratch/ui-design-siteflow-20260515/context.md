# Brainstorm Report -- SiteFlow

## Summary

- Topic: SiteFlow, a self-hosted Vercel-like deployment framework.
- Roles analyzed: 3 (`system-architect`, `data-architect`, `product-manager`).
- Features decomposed: 8.
- Conflicts: 4 resolved, 2 suggested, 3 unresolved.
- Quality gate: PASS.
- Overall confidence: 0.86.

## Guidance Specification

SiteFlow is positioned as an internal deployment platform for teams that want Vercel-like static and prerendered delivery while retaining control over infrastructure, artifacts, routing, secrets, and release history.

The first implementation MUST make a Git commit deployable into an immutable build artifact, route that artifact through Nginx and optional CDN integration, expose controlled preview or review flows, and allow deterministic promotion or rollback to a known good deployment.

Primary MVP boundary: static and prerendered frontend outputs. Server-side runtimes, edge functions, arbitrary CI/CD pipelines, and complex enterprise tenancy are out of scope for the first release.

Guidance file: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/guidance-specification.md`

## Role Analysis Results

### system-architect

Key finding: SiteFlow SHOULD use separate control-plane, worker, artifact storage, and routing adapter boundaries. The database is the source of truth; side effects such as Nginx reloads, CDN purge, and Git status callbacks SHOULD be handled through an outbox-style pattern. A deployment MUST NOT become routable before its artifact manifest is written and checksum-verified.

Analysis file: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/system-architect/analysis.md`

### data-architect

Key finding: DB-owned lineage and release state are central. Artifact stores own immutable bytes, but deployment lineage, manifest metadata, retention protection, rollback references, active previews, pins, and audit trail MUST live in durable control-plane data.

Analysis file: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/data-architect/analysis.md`

### product-manager

Key finding: P0 should prove the production deployment loop end to end: project setup, signed webhook ingestion, framework detection, Docker build, immutable artifact publishing, Nginx routing, promotion, and rollback. PR previews are high value but SHOULD remain P1 unless routing primitives are already stable.

Analysis file: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/product-manager/analysis.md`

## Synthesis

Consensus areas:

- SiteFlow is a deployment product, not a general CI/CD runner.
- The relational control-plane database is the source of truth.
- Artifacts are immutable and must be checksum-verified.
- Release channels and previews point to deployments, not directly to artifact paths.
- Promotion and rollback are pointer operations over immutable deployments.
- Routing/CDN operations are observable, retryable side effects.
- Secret values must never appear in APIs, logs, manifests, route config, or artifacts.

Resolved conflicts:

- Preview deployments stay P1, while P0 routing keeps preview-compatible route keys.
- Retention defaults favor rollback safety before storage cost optimization.
- MVP is API-first with a minimal operator console.
- Release-channel state is transactional; Nginx/CDN side effects run after commit.

Unresolved items:

- Reference stack: database, queue, object storage default, secrets provider, and observability stack.
- Docker network policy: open outbound dependency downloads vs constrained per-project access.
- Preview URL mode: wildcard DNS, path-based routing, or both.

Synthesis file: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/synthesis-changelog.md`

## Feature Index

- F-001 `project-management`: P0, M1 Deployable Core.
- F-002 `git-webhook-ingestion`: P0, M1 Deployable Core.
- F-003 `framework-detection-versioning`: P0, M1 Deployable Core.
- F-004 `docker-build-worker`: P0, M1 Deployable Core, high risk.
- F-005 `artifact-storage-management`: P0, M1 Deployable Core, high risk.
- F-006 `routing-cdn-integration`: P0, M1/M2, high risk.
- F-007 `preview-deployments`: P1, M3 Team Workflow.
- F-008 `release-promotion-rollback`: P0, M2 Controlled Release, high risk.

Feature index: `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-index.json`

## Next Steps

- `maestro-ui-design`: generate operator console and deployment workflow UI prototypes.
- `maestro-analyze`: lock feasibility decisions such as database, queue, Docker network policy, routing mode, and artifact backend.
- `maestro-plan`: turn the feature specs into an execution plan.
- `maestro-roadmap`: expand the brainstorm into a full spec package and milestone roadmap.
