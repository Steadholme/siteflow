# SiteFlow CLI Installer Roadmap

Date: 2026-05-15
Status: implementation roadmap

## Guiding Strategy

Build the installer around real production primitives before broad feature coverage. The first release should be boring: one host, bundled Postgres, local artifacts, local worker, managed Nginx, real database migrations, real Docker builds, and real route apply. Multi-host and external providers should reuse the same state, rendering, validation, and operation engine.

## Phase 0: Repository And Runtime Foundation

Goal: reshape the project from a frontend-only console into a deployable SiteFlow system without breaking the existing UI.

Deliverables:

- Decide package layout for CLI, API/control plane, worker, shared domain types, migration tooling, and console.
- Introduce real runtime configuration for the console while keeping fixtures test-only.
- Select server stack, database migration tool, command framework, and process manager integration.
- Define release bundle format and versioning.
- Add CI scripts for unit, integration, build, and install smoke tests.

Exit criteria:

- The console can point to a real API through environment config.
- Test fixtures are isolated to tests/dev helpers.
- A minimal API process starts and serves health/version endpoints.
- A CLI skeleton runs `siteflow --help`, `siteflow doctor --help`, and `siteflow install --help`.

## Phase 1: CLI Foundation And Install State

Goal: create the reusable installer engine all lifecycle commands will share.

Deliverables:

- Command framework with global flags: `--config`, `--json`, `--dry-run`, `--yes`, `--verbose`.
- Install-state manifest schema and parser.
- Operation checkpoint schema.
- Host preflight checks.
- Template renderer for Compose, env, systemd, Nginx, and backup manifests.
- Atomic write, staged diff, checksum, and previous snapshot helpers.
- Secret generation and file-permission primitives.

Exit criteria:

- `siteflow doctor` can run before install and report host readiness.
- `siteflow install --dry-run --json` produces a complete plan without writing active files.
- Unit tests cover state parsing, renderer checksums, idempotency decisions, and secret redaction.

## Phase 2: Single-Host Install

Goal: make a fresh server become a working SiteFlow node.

Deliverables:

- `siteflow install --topology single`.
- Bundled Postgres service and migrations.
- API/control-plane service with real persistence.
- Local worker service with Docker access checks.
- Local artifact storage directory and validation.
- Managed Nginx render, validate, symlink, reload, and rollback-to-previous config.
- TLS integration for Let's Encrypt or provided cert paths.
- Admin bootstrap token file and first-login instructions.

Exit criteria:

- Fresh VM install completes and `siteflow doctor` passes critical checks.
- Re-running install is safe and idempotent.
- API and console use the real persisted control-plane state.
- No production install code imports fixture clients or fake storage.

## Phase 3: Deployable Core Loop

Goal: prove the product path that justifies the installer.

Deliverables:

- Project creation and repository binding in the control plane.
- Deploy-key generation and public-key output.
- Webhook endpoint with signed event verification and idempotency.
- Framework detection for initial static targets.
- Docker build worker job claim, execution, logs, and cleanup.
- Immutable local artifact publication with manifest and checksum.
- Deployment records and release-channel promotion.
- Nginx route generation from DB-owned desired route state.
- Rollback to previous immutable deployment without rebuild.

Exit criteria:

- A Git webhook triggers a real build.
- The build publishes a verifiable artifact.
- A domain or path route serves the artifact through Nginx.
- Promotion and rollback are auditable and deterministic.
- Failed builds, failed route apply, and stale rollback targets are visible in the console.

## Phase 4: Lifecycle Operations

Goal: make the installed server operable after day one.

Deliverables:

- `siteflow backup` with bundled DB dump, config snapshot, install-state copy, and optional artifacts.
- `siteflow restore` with validation and replacement-host support.
- `siteflow upgrade` with release bundle verification, backup, migration lock, post-upgrade doctor, and rollback constraints.
- `siteflow uninstall --keep-data` and guarded `--purge-data`.
- `siteflow status` and `siteflow logs`.
- Expanded `doctor` checks for backup age, route drift, migration state, and service health.

Exit criteria:

- Backup and restore succeeds on a replacement VM.
- Upgrade from one local release bundle to another preserves projects, deployments, artifacts, and active routes.
- Uninstall removes generated services and config while preserving data by default.

## Phase 5: Production Extensions

Goal: extend beyond single-host without redesigning the installer.

Deliverables:

- External Postgres mode.
- S3-compatible artifact storage mode.
- `siteflow domain` lifecycle.
- `siteflow deploy-key` full lifecycle.
- `siteflow join-worker` with short-lived worker token.
- Worker capacity and labels.
- CDN adapter hooks for purge/prewarm.
- Config diff/render commands for operator review.

Exit criteria:

- A control-plane host can use external DB and S3.
- A separate worker host can join and process builds.
- Domain changes apply through validated Nginx revisions.
- CDN operations are optional, observable, and retryable.

## Explicit Deferrals

- Kubernetes operator.
- Serverless or edge runtime support.
- Arbitrary CI/CD pipeline language.
- Enterprise multi-tenant identity.
- Fully automated DNS provider management.
- Hidden one-command install that prevents inspection of generated assets.

