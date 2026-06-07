# SiteFlow Vercel Parity Roadmap

Date: 2026-05-25
Status: iterating

## Goal

Move SiteFlow from a working self-hosted prebuilt deploy loop toward a Vercel-class deployment platform: Git-connected projects, preview and production environments, environment variables, domains, deployment history, observability, rollbacks, and a CLI that feels natural for local and CI workflows.

## Vercel Baseline

The parity target is based on the current Vercel public docs:

- Deployment creation paths: Git, CLI, Deploy Hooks, and REST API.
- Git behavior: preview deployments for pushes and pull requests, production deployments from the production branch, and rollback through previous deployments.
- Environment model: Local, Preview, Production, plus custom environments for advanced workflows.
- CLI behavior: source deploy, prebuilt deploy, project linking, stdout deployment URL, promotion flows.
- Dashboard behavior: deployment history, filters, logs, errors, custom domain assignment, promotion to production.
- Advanced rollout: staged rolling releases with observable canary metrics.

## Current SiteFlow Position

Already present:

- `siteflow deploy --prebuilt` uploads static output and receives a preview URL.
- API token auth and `siteflow login` config are implemented.
- Wildcard host routing and local artifact serving exist.
- Installer planning and single-host service generation are underway.
- Console already has project, deployment, release, and rollback views backed by fixture/read-model contracts.

Main gaps:

- No Git repository import, webhook verification, deploy hook, or build queue.
- No persisted environment variables or per-environment build/runtime config.
- No real build worker loop for source deployments.
- No production alias/domain lifecycle beyond generated preview hosts.
- Console uses read models but lacks live deployment filtering, metrics, and error traces from real operations.
- Rolling/canary release semantics are not modeled yet.

## Milestone VP-001: Project And Environment Foundation

Goal: make projects first-class resources with Vercel-like environments and secrets before adding source builds.

Deliverables:

- Project create/update API and CLI paths.
- Repository binding model with provider, owner, repo, default branch, production branch, install metadata, and webhook secret reference.
- Environment model: `local`, `preview`, `production`, and optional custom names.
- Environment variable storage metadata with encrypted value placeholder, scope, target environment, and last updated actor.
- Console project settings surface for repository, build settings, domains, and environment variables.

Success criteria:

- A new project can be created without fixture data.
- Preview and production environment settings are persisted independently.
- Secrets never appear in API responses, logs, CLI JSON, or UI snapshots.

## Milestone VP-002: Git Deploy Loop

Goal: support automatic preview and production deployments from a connected Git repository.

Deliverables:

- `POST /api/webhooks/git/:provider` endpoint with signature verification and idempotency.
- Source event persistence for branch push and pull request events.
- Build queue table and job claiming state machine.
- Framework detection for static targets and basic React/Vite output.
- Worker command executor with install/build/output-directory settings.
- Build log streaming into deployment detail view.

Success criteria:

- A branch push creates a preview deployment.
- A production-branch push creates or stages a production deployment according to project policy.
- Duplicate webhook delivery does not enqueue duplicate builds.

## Milestone VP-003: Production Domains And Promotion

Goal: make production deployment semantics explicit instead of treating every upload as an isolated preview host.

Deliverables:

- Domain resource lifecycle: add, verify, assign to environment/channel, remove.
- Route desired-state table for preview aliases, branch aliases, commit aliases, and production domains.
- Promotion command that assigns a ready deployment to production after safety checks.
- Rollback command that reassigns production to a previous immutable deployment.
- Route apply operation history with drift detection.

Success criteria:

- A deployment can be promoted to production without rebuilding.
- Rollback restores a previous deployment and records audit reason.
- Route drift is visible in console and `siteflow doctor`.

## Milestone VP-004: Deployment Management And Observability

Goal: match the operational dashboard expectations users have from Vercel.

Deliverables:

- Deployment list filters by project, branch, environment, status, date range, and source.
- Deployment summary with build duration, output size, framework, commit metadata, and generated URLs.
- Log retention policy and paginated log chunks.
- Operation timeline for build, artifact verification, route apply, CDN/purge placeholder, and promotion.
- Error classification for build failure, route failure, auth failure, and artifact verification failure.

Success criteria:

- Operators can debug failed deploys from the console without SSH.
- CLI can list deployments and inspect one deployment by ID.
- Console read models can be generated from real Postgres data, not only fixtures.

## Milestone VP-005: Vercel-Style CLI UX

Goal: make CLI usage feel close to `vercel` while preserving explicit self-hosted controls.

Deliverables:

- `siteflow link` stores project and organization/server metadata in a local `.siteflow` directory.
- `siteflow env pull` writes local environment variables to `.env.local`.
- `siteflow deploy` works from linked project root without requiring `--project`.
- `siteflow deploy --prod` maps to production target/promotion policy.
- `siteflow promote`, `siteflow rollback`, `siteflow deployments`, and `siteflow inspect`.
- `siteflow deploy-hook create/list/revoke` for external triggers.

Success criteria:

- CI can deploy with only saved server config, project link metadata, and token.
- CLI stdout for deploy remains script-friendly: deployment URL by default, structured JSON with `--json`.

## Milestone VP-006: Rolling Release

Goal: provide staged production rollout as a differentiator once the core loop is reliable.

Deliverables:

- Rolling release config: enabled, stages, percentage, duration, advancement type.
- Request bucketing strategy at route layer.
- Canary/current deployment comparison read model.
- Complete, abort, and advance commands.
- Safety gate hooks based on failure counts and operator override.

Success criteria:

- A production promotion can start at 5% or 10% traffic.
- Operators can complete or abort from console and CLI.
- Rollout state is auditable and deterministic.

## Execution Order

1. VP-001 must come first because source deploys, CLI link, deploy hooks, and env pull depend on persisted project/env settings.
2. VP-002 follows to unlock the core Vercel loop: push code, get preview URL.
3. VP-003 turns preview artifacts into production channel/domain behavior.
4. VP-004 makes the system operable and debuggable.
5. VP-005 should be implemented alongside VP-002 to keep CLI ergonomics honest.
6. VP-006 is intentionally later because traffic splitting is risky before route state and observability are solid.

## Next Iteration

After completing VP-001 through VP-014, the next Vercel parity loop focuses on platform services around deployed applications:

- VP-015 Blob Storage: project-scoped object storage with upload, list, download, delete, metadata, CLI, and audit trail.
- VP-016 Image Optimization: transform/caching endpoint for user and artifact images.
- VP-017 Cache And ISR Controls: cache entries, tags, purge APIs, and CLI controls.
- VP-018 Functions Runtime Controls: timeout/memory/concurrency metadata and runtime inspection.
