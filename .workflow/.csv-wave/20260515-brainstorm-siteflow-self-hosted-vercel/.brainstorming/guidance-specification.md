# SiteFlow Guidance Specification

Topic: SiteFlow self-hosted Vercel-like framework with Git webhook, build worker, static artifact storage, Nginx/CDN routing, preview and rollback, project management, framework detection, automatic version control, Docker builder, and artifact management.

Date: 2026-05-15

## 1. Positioning

SiteFlow is a self-hosted deployment framework for teams that want Vercel-like static and prerendered web delivery while retaining control of infrastructure, artifacts, routing, secrets, and release history.

The product SHOULD prioritize a reliable control plane over broad platform breadth. Its first implementation MUST make a Git commit deployable into an immutable build artifact, route that artifact through Nginx and optional CDN integration, expose preview deployments for review, and allow deterministic promotion or rollback to a known good release.

SiteFlow is not positioned as a public SaaS platform. It is an internal platform component operated by an infrastructure or product engineering team for multiple projects, environments, and release channels.

## 2. Scope Boundaries

- SiteFlow MUST provide a control plane for projects, repository bindings, deployment records, build jobs, artifact metadata, route bindings, preview URLs, release promotion, and rollback.
- SiteFlow MUST run builds in isolated Docker-based workers and SHOULD keep build execution separate from the web/API control plane.
- SiteFlow MUST store immutable deployment artifacts in a versioned artifact store and SHOULD support an S3-compatible backend or local filesystem backend for early deployments.
- SiteFlow MUST integrate with Git providers through webhooks and repository clone credentials, but it SHOULD keep provider-specific code behind adapters.
- SiteFlow MUST support static and prerendered frontend outputs first. Server-side runtimes, background jobs, and edge functions MAY be considered later only if they do not weaken artifact immutability.
- SiteFlow MUST integrate with Nginx routing and MAY integrate with CDN cache invalidation where a provider API is configured.
- SiteFlow SHOULD support production, staging, and preview release channels, but SHOULD NOT require complex enterprise tenancy in the MVP.

## 3. Core Terminology

1. Project: A deployable application managed by SiteFlow, including repository binding, framework settings, environment variables, domains, and deployment history.
2. Repository Binding: The connection between a SiteFlow project and a Git repository, including provider, clone URL, default branch, webhook secret, and deploy key or token reference.
3. Webhook Event: A signed Git provider event that describes a push, pull request, tag, or release action and can enqueue a build job.
4. Framework Preset: A detected or manually selected build profile, such as Next.js static export, Vite, Astro, Nuxt static, Hugo, or plain static files.
5. Build Job: A queued unit of work that resolves source code, chooses a framework preset, runs a Docker build, validates output, and publishes an artifact.
6. Build Worker: An isolated process or service that executes build jobs in Docker with bounded CPU, memory, network, timeout, and secret exposure.
7. Artifact: An immutable deployable output directory or archive produced by a build job, stored with checksum, size, manifest, retention policy, and provenance metadata.
8. Deployment: A SiteFlow record that links a project, Git revision, build job, artifact, environment, status, and generated URLs.
9. Preview URL: A non-production route for a branch, pull request, or commit-specific deployment that allows review before release promotion.
10. Release Channel: A named pointer, such as production or staging, that resolves traffic to one deployment and can be moved forward or backward for promotion and rollback.

## 4. Non-Goals

- SiteFlow MUST NOT attempt to become a full source-code hosting, code review, or Git collaboration system.
- SiteFlow MUST NOT implement a general-purpose CI/CD suite with arbitrary pipelines in the MVP; builds are deployment-oriented and project-scoped.
- SiteFlow SHOULD NOT implement serverless functions, edge compute, long-running services, or databases in the first release.
- SiteFlow MUST NOT depend on a proprietary global network; CDN support is an integration layer, not a required owned CDN product.
- SiteFlow SHOULD NOT require Kubernetes for the MVP, although future deployment topologies MAY add it.
- SiteFlow MUST NOT mutate existing artifacts during rollback or release promotion; release channels move between immutable deployment versions.

## 5. Feature Decomposition

### F-001 project-management

Priority: P0

Description: Provide the control-plane model and UI/API surface for creating, configuring, listing, searching, pausing, and deleting projects.

Related roles: platform operator, project owner, developer, support engineer

RFC 2119 requirements:

- The system MUST store project identity, display name, repository binding, default branch, framework preset, output directory, domains, environment variables, and deployment policy.
- The system MUST validate project slugs and domain bindings for uniqueness before activation.
- The system SHOULD expose audit metadata for project creation, settings changes, release promotion, rollback, and deletion.
- The system MUST NOT expose secret values through read APIs, logs, or deployment manifests.
- The system MAY support lightweight team membership and role assignment after the single-operator MVP is stable.

### F-002 git-webhook-ingestion

Priority: P0

Description: Receive signed Git provider webhooks, normalize them into deployment intents, and enqueue build jobs idempotently.

Related roles: developer, Git provider, control-plane API, build scheduler

RFC 2119 requirements:

- The webhook endpoint MUST verify provider signatures using per-project webhook secrets before accepting events.
- The ingestion layer MUST normalize provider payloads into a common event model with repository, branch, commit SHA, author, event type, and pull request metadata where available.
- The system MUST deduplicate repeated webhook deliveries by provider event ID or a deterministic event fingerprint.
- Pushes to configured production or staging branches SHOULD enqueue release-candidate builds automatically.
- Pull request events SHOULD enqueue preview deployments when previews are enabled.
- The system MUST reject unsigned, malformed, or unauthorized webhook requests with safe error messages.

### F-003 framework-detection-versioning

Priority: P0

Description: Detect project framework and package manager, choose build commands and output paths, and record versioned deployment metadata automatically.

Related roles: developer, build worker, framework adapter, project owner

RFC 2119 requirements:

- The detector MUST inspect repository files such as package manifests, lockfiles, config files, and known output conventions before selecting a framework preset.
- The detector SHOULD prefer explicit project configuration over inferred defaults.
- Each deployment MUST record commit SHA, branch, tag if present, framework preset, package manager, build command, output directory, image version, and artifact checksum.
- The system MUST allow manual override when detection is ambiguous or unsupported.
- The system SHOULD maintain a deployment sequence number per project and release channel for human-readable version tracking.
- The system MUST NOT silently switch framework presets for an existing project without recording the change in deployment metadata.

### F-004 docker-build-worker

Priority: P0

Description: Execute builds in disposable Docker containers with clear lifecycle states, resource limits, logs, cache controls, and failure reporting.

Related roles: build worker, build scheduler, platform operator, developer

RFC 2119 requirements:

- A build worker MUST claim jobs atomically and MUST transition each job through queued, running, succeeded, failed, canceled, or timed-out states.
- Builds MUST run in isolated Docker containers with configured CPU, memory, timeout, environment variables, and workspace cleanup.
- The worker SHOULD support dependency cache mounts or remote cache adapters, but cached content MUST NOT compromise artifact reproducibility or secret isolation.
- Build logs MUST be streamed or persisted with redaction for configured secret patterns.
- The worker MUST validate that the configured output directory exists before publishing an artifact.
- The worker SHOULD emit structured events for job start, phase changes, completion, failure, and timeout.

### F-005 artifact-storage-management

Priority: P0

Description: Store, index, verify, retain, and delete immutable build artifacts and their manifests.

Related roles: artifact store, build worker, release manager, platform operator

RFC 2119 requirements:

- Published artifacts MUST be immutable and content-addressed or checksum-verified.
- Artifact metadata MUST include project ID, deployment ID, commit SHA, checksum, size, file count, content type summary, storage location, and creation time.
- The artifact store SHOULD support local filesystem and S3-compatible backends behind a common interface.
- The system MUST write an artifact manifest before a deployment becomes routable.
- Retention policies SHOULD preserve active release-channel artifacts and recent preview artifacts by default.
- The system MUST NOT delete artifacts referenced by an active release channel or rollback target.

### F-006 routing-cdn-integration

Priority: P0

Description: Route production, staging, and preview traffic to the correct immutable artifact through generated Nginx configuration and optional CDN cache operations.

Related roles: platform operator, routing adapter, CDN adapter, release manager

RFC 2119 requirements:

- The routing layer MUST resolve hostnames and paths to release channels or preview deployments deterministically.
- Nginx configuration updates MUST be generated from validated deployment state and applied atomically.
- The system SHOULD support a dry-run validation step before reloading Nginx.
- The system MUST preserve the previous known-good routing configuration if validation or reload fails.
- CDN integration MAY purge or prewarm paths after promotion or rollback when a provider adapter is configured.
- The system SHOULD expose routing status, last reload time, and last CDN operation result per domain.

### F-007 preview-deployments

Priority: P1

Description: Provide commit, branch, and pull-request preview deployments with stable URLs, lifecycle controls, and review metadata.

Related roles: developer, reviewer, project owner, Git provider

RFC 2119 requirements:

- Preview deployments MUST link to a project, source event, branch or pull request, commit SHA, build job, artifact, and preview URL.
- The system SHOULD generate predictable preview URLs that avoid collisions across projects and branches.
- Pull request previews SHOULD be updated when new commits arrive and SHOULD keep prior commit previews accessible until retention rules remove them.
- Preview deployments MAY post status callbacks to the Git provider when credentials are configured.
- Preview URLs MUST NOT replace production release channels unless explicitly promoted.
- Preview retention SHOULD be configurable per project.

### F-008 release-promotion-rollback

Priority: P0

Description: Move release channels between immutable deployments for controlled production/staging promotion and fast rollback.

Related roles: release manager, project owner, platform operator, support engineer

RFC 2119 requirements:

- Release promotion MUST require a successful deployment with a verified artifact.
- A release channel MUST point to exactly one active deployment at a time.
- Promotion and rollback operations MUST be transactional across release-channel state, routing generation, and audit logging.
- Rollback MUST select from previously successful deployments and MUST NOT rebuild source code as part of the rollback operation.
- The system SHOULD show deployment lineage, previous active deployment, operator, timestamp, and reason for every promotion or rollback.
- The system MAY support approval gates after the MVP control-plane and routing primitives are stable.

## 6. Assumptions

- SiteFlow is operated in a trusted self-hosted environment by a platform or engineering team.
- Git providers can deliver signed webhooks and the operator can configure deploy keys, access tokens, or clone credentials.
- Initial application targets are static sites or frameworks that can emit static/prerendered assets.
- A relational database is available for control-plane state, deployment lineage, job queue metadata, and audit records.
- Docker is available on build hosts, and workers can run with constrained permissions.
- Artifact storage is available through local filesystem or an S3-compatible service.
- Nginx is the first routing target, and CDN behavior is handled through optional provider adapters.
- Secrets are stored outside artifact manifests and are injected only into build containers when required.

## 7. Open Questions

1. Which Git providers are required first: GitHub, GitLab, Gitea, or generic webhook-only support?
2. Should the MVP include a web UI, API-only control plane, or both?
3. What database and queue technologies should be standard for the reference deployment?
4. How strict should Docker network isolation be during dependency installation?
5. Which framework presets are mandatory for the first release?
6. Should preview deployments use wildcard DNS, path-based routing, or both?
7. What artifact retention defaults balance rollback safety and storage cost?
8. Should release promotion require manual approval, branch policy checks, or Git provider status checks?
9. What observability stack should the reference deployment target for logs, metrics, and traces?
10. Will future support for server-side rendering require a separate runtime product boundary?
