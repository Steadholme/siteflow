# Synthesis Changelog

Topic: SiteFlow self-hosted Vercel-like deployment framework  
Date: 2026-05-15  
Source roles: system-architect, data-architect, product-manager

## Consensus

- SiteFlow should be a deployment product, not a general CI/CD pipeline runner.
- Static and prerendered artifacts are the MVP boundary; server runtimes and edge functions remain future scope.
- The relational control-plane database is the source of truth for projects, source events, jobs, deployments, release channels, routing intent, retention, and audit.
- Artifact bytes live behind storage adapters, but deployment lineage and release state live in the database.
- Deployments bind source event, build job, artifact, framework metadata, and version lineage.
- Release channels and previews point to deployments, not directly to artifacts.
- Promotion and rollback are pointer operations over immutable deployments and MUST NOT rebuild source.
- Routing and CDN changes are materialized side effects that should be driven from persisted route revisions or an outbox.
- Nginx config validation and previous known-good preservation are non-negotiable for P0.
- Secret values must not appear in APIs, logs, manifests, route config, or artifacts.

## Unique Contributions

- System architect: defined the service boundary, state machines, route outbox model, Docker isolation concerns, observability metrics, and manifest-before-routable invariant.
- Data architect: formalized normalized entities, lineage expression, manifest schema, indexing, reference-aware retention, tombstones, and audit record shape.
- Product manager: clarified MVP positioning, persona value, API-first plus minimal console direction, milestone sequencing, release gates, and scope boundaries against Vercel and CI/CD tools.

## Conflicts

- [RESOLVED] Preview priority vs routing primitives: F-007 remains P1, but F-006 reserves preview-compatible route keys, URL identity, and retention references during P0.
- [RESOLVED] Storage cost vs rollback safety: retention defaults favor safety. Active channels, rollback windows, active previews, promoted previews, pins, and holds protect artifacts. Storage budgets and cleanup reports can tune cost later.
- [RESOLVED] API-only vs usable operations: MVP should be API-first with a minimal operator console for project state, build logs, artifact status, route status, promotion, and rollback.
- [RESOLVED] Channel transaction vs Nginx/CDN side effects: channel pointer, audit, and pending routing revision are committed transactionally; Nginx reload and CDN calls run after commit as idempotent, observable side effects.
- [SUGGESTED] Artifact backend default: expose a common adapter in P0, use local filesystem for simplest reference install, and document S3-compatible storage as the production-oriented backend if operations require object durability.
- [SUGGESTED] Git provider scope: choose one first-class provider for polished setup, while keeping a generic webhook contract for self-hosted adopters.
- [UNRESOLVED] Required reference stack: database, queue, object storage default, secrets provider, and observability stack still need explicit selection.
- [UNRESOLVED] Docker network policy: MVP must decide whether outbound package downloads are allowed by default or constrained per project from the beginning.
- [UNRESOLVED] Preview URL mode: wildcard DNS, path-based previews, or both remain product and operations decisions.

## Decisions

- Generate one feature spec for each guidance feature F-001 through F-008.
- Keep F-001 through F-006 and F-008 as P0; keep F-007 as P1 while preserving data and route compatibility.
- Treat `source_event -> build_job -> artifact -> deployment -> release_channel or preview_deployment` as the canonical lineage.
- Require artifact manifest and checksum verification before any deployment becomes routable.
- Model release history as append-only channel events with previous deployment, next deployment, actor, reason, route revision, and outcome.
- Avoid arbitrary pipelines, matrix builds, long-running services, serverless runtimes, and complex enterprise tenancy in MVP.

## Unresolved Items

- Select the first Git provider and decide whether generic webhook-only support ships with MVP.
- Select reference database, queue, artifact backend, secrets provider, and observability stack.
- Define default Docker resource limits and network isolation policy.
- Choose preview routing mode and preview retention defaults.
- Decide whether production promotion approval is P1 or required for MVP.

## Quality Gate Status

Status: PASS

Unresolved conflict count: 3. This does not exceed the warning threshold of more than 3 unresolved conflicts.

Produced artifacts:

- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-001-project-management.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-002-git-webhook-ingestion.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-003-framework-detection-versioning.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-004-docker-build-worker.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-005-artifact-storage-management.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-006-routing-cdn-integration.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-007-preview-deployments.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-specs/F-008-release-promotion-rollback.md`
- `.workflow/.csv-wave/20260515-brainstorm-siteflow-self-hosted-vercel/.brainstorming/feature-index.json`

## Confidence Summary

Overall confidence: 0.86

Dimensions:

- role_coverage: 0.90 - three complementary roles covered architecture, data, and product.
- cross_role_consistency: 0.88 - most core invariants matched across roles.
- feature_completeness: 0.86 - all eight guidance features received specs and index entries.
- spec_quality: 0.84 - specs are concise, operational, and acceptance-oriented.
- design_feasibility: 0.82 - design is feasible, but stack selection and Docker network policy remain open.

Weighted factors:

- analysis_depth: 0.88 * 0.30 = 0.264
- evidence_strength: 0.86 * 0.25 = 0.215
- coverage_breadth: 0.90 * 0.20 = 0.180
- user_validation: 0.75 * 0.15 = 0.113
- consistency: 0.88 * 0.10 = 0.088

Weighted total: 0.86

