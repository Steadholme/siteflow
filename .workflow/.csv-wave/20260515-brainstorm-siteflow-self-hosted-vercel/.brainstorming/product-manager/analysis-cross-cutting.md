# Cross-Cutting Product Decisions

## Product Strategy

SiteFlow SHOULD compete on control, auditability, artifact immutability, and operational predictability rather than on breadth of managed-cloud features. The immediate buyer/user is an engineering team that already runs infrastructure and wants Vercel-like deployment semantics in its own environment.

The MVP MUST focus on static and prerendered web delivery. Server runtimes, edge functions, arbitrary CI pipelines, marketplace integrations, and enterprise tenancy MUST NOT enter the first release unless they are hidden behind clear future extension points and do not affect P0 stability.

## Positioning

Against Vercel, SiteFlow SHOULD say: "bring the deployment model to your infrastructure." The differentiators are self-hosting, artifact ownership, Nginx/CDN adapter control, rollback from immutable artifacts, and transparent worker behavior. SiteFlow SHOULD NOT claim parity with Vercel's global edge network, analytics, image optimization, or serverless ecosystem in MVP.

Against generic self-hosted CI/CD, SiteFlow SHOULD say: "deployment product, not pipeline toolkit." The differentiators are project-scoped defaults, framework presets, artifact manifests, release channels, preview URLs, and routing state. SiteFlow MUST avoid becoming a YAML pipeline runner in the MVP.

## MVP Scope

P0 MUST include:

- Single-operator or small-team project management.
- One Git provider adapter plus a generic webhook contract if feasible.
- Signed webhook verification and idempotent build enqueueing.
- Framework detection for the first supported static frameworks.
- Docker build worker with logs, limits, and cleanup.
- Immutable artifact storage with manifest and retention guardrails.
- Nginx routing generation with validation and rollback to known-good config.
- Promotion and rollback for production and staging channels.

P1 SHOULD include:

- Pull request and branch preview deployments.
- Git provider status callbacks.
- Additional framework presets and package manager refinements.
- S3-compatible storage as a production-grade backend if local filesystem is MVP default, or vice versa.
- Basic role assignment if multiple operators are needed.

P2 MAY include:

- Approval gates, branch policy checks, richer UI workflows, CDN prewarming, template projects, Kubernetes deployment topology, and additional provider adapters.

## Personas and Jobs To Be Done

The platform operator needs confidence that routing and artifacts are correct before traffic moves. Therefore SiteFlow MUST expose the active release channel, routed artifact checksum, last routing reload, and last failed operation.

The developer needs fast, actionable feedback. Build failures MUST identify phase, command, exit code, and redacted logs. Ambiguous framework detection SHOULD produce a configuration action instead of surprising behavior.

The release manager needs reversible changes. Promotion and rollback MUST show before/after deployment IDs, commit SHA, actor, timestamp, and reason.

## Roadmap

Milestone 1, "Deployable Core", MUST prove API-level project creation, webhook enqueue, Docker build, artifact publish, and a manually triggered route to staging.

Milestone 2, "Controlled Release", MUST add release channels, transactional promotion, rollback, audit records, Nginx validation, and operator-visible logs/status.

Milestone 3, "Team Workflow", SHOULD add PR/branch previews, Git status callbacks, retention policies, search/listing improvements, and a minimal web console.

Milestone 4, "Operational Hardening", SHOULD add adapter expansion, CDN purge/prewarm, richer metrics, backup/restore documentation, and policy controls.

## Release Gates

A public MVP release MUST NOT be declared until at least one reference deployment can run from a clean install with documented prerequisites. The release test MUST include a successful deploy, a failed build with readable diagnostics, a promotion, a rollback, and proof that active artifacts are protected from deletion.

## Success Metrics

- Time from signed webhook to queued build SHOULD be under 5 seconds in normal load.
- Successful static build to routable staging SHOULD be measurable end to end.
- Rollback operation SHOULD complete without source rebuild.
- Build failure diagnosis SHOULD require no direct worker shell access for common failures.
- Artifact/routing mismatch count MUST be zero in release validation.
- Nginx reload failure MUST preserve previous known-good routing.

## Open Product Decisions

The team SHOULD decide early whether MVP is API-only plus CLI, or API plus minimal web console. Product recommendation: include a minimal console because release state, rollback, and logs are hard to trust through API calls alone.

The team SHOULD choose the first Git provider based on target users. GitHub is likely best for broad adoption, while GitLab or Gitea may be more aligned with self-hosted-first buyers.
