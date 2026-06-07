# SiteFlow CLI Installer Implementation Tasks

Date: 2026-05-15
Status: backlog seed

## Epic A: Real Runtime Foundation

### CLI-001 Define Repository Package Layout

Scope: repo structure and build scripts.

Deliverables:

- Add packages/apps for CLI, API/control plane, worker, shared domain contracts, and console integration.
- Preserve current frontend tests while moving production data access behind a real API client boundary.
- Document which fixtures are test/dev only.

Acceptance:

- `npm run build` or replacement workspace build includes all packages.
- Production imports do not depend on fixture clients.

Tests:

- Workspace build.
- Import-boundary lint or unit test that blocks fixture imports in production entrypoints.

### CLI-002 Choose Runtime Stack And Release Bundle Format

Scope: architecture decision and scaffolding.

Deliverables:

- Pick command framework, HTTP server framework, DB migration tool, and packaging strategy.
- Define release bundle manifest with version, images/binaries, checksums, config schema, migrations, and rollback metadata.

Acceptance:

- Release bundle manifest can be parsed by CLI and validated in tests.

Tests:

- Manifest parser unit tests for valid, missing, incompatible, and checksum mismatch cases.

## Epic B: Installer Engine

### CLI-010 Command Framework Skeleton

Scope: `siteflow` binary.

Deliverables:

- `siteflow install`, `doctor`, `backup`, `restore`, `upgrade`, `uninstall`, `status`, and `logs` command shells.
- Global flags: `--json`, `--dry-run`, `--yes`, `--config`, `--verbose`.

Acceptance:

- Help output is stable.
- Commands return non-zero on invalid flags and invalid config.

Tests:

- CLI help snapshots.
- Flag parsing unit tests.

### CLI-011 Install State And Operation Checkpoints

Scope: durable lifecycle state.

Deliverables:

- Install-state schema, parser, validator, writer, and snapshotter.
- Operation checkpoint schema and resumable operation IDs.

Acceptance:

- State writer never persists raw secret values.
- Corrupt or incompatible state fails with clear remediation.

Tests:

- Schema validation.
- Redaction tests.
- Snapshot/restore unit tests.

### CLI-012 Render And Apply Primitives

Scope: generated assets.

Deliverables:

- Template render for Compose, env, systemd, Nginx, and backup manifests.
- Staged write, checksum comparison, diff, atomic replace, and previous known-good snapshot helpers.

Acceptance:

- Re-rendering identical assets reports `skipped`.
- Changed assets report diff and write through staging.

Tests:

- Renderer unit tests.
- Atomic replace tests using temp directories.

### CLI-013 Secret And Permission Primitives

Scope: secret files and file ownership.

Deliverables:

- Strong random secret generation.
- Root-owned secret file writer with service-user read policy where needed.
- Redacted output helper.

Acceptance:

- Existing secrets are reused unless rotation is requested.
- Logs and JSON output never include raw secret values.

Tests:

- Permission tests where supported.
- Secret redaction tests.

## Epic C: Single-Host Install

### CLI-020 Preflight Doctor

Scope: host readiness before install.

Deliverables:

- OS, architecture, Docker, Nginx, ports, disk, memory, clock, DNS, TLS input, and permission checks.
- Human and JSON outputs with `pass`, `warn`, `fail`.

Acceptance:

- Critical failures block install.
- Remediation hints are included for common failures.

Tests:

- Unit tests for check classification.
- Integration tests with mocked command adapters.

### CLI-021 Single-Host Compose And Systemd

Scope: local service orchestration.

Deliverables:

- Compose template for API, Postgres, worker, and console/static serving path as needed.
- Optional systemd unit to manage the Compose stack.

Acceptance:

- `siteflow install --dry-run` renders complete service definitions.
- Re-run does not rewrite unchanged files.

Tests:

- Template snapshot tests.
- Dry-run integration test.

### CLI-022 Real Control Plane Persistence

Scope: API, DB, migrations.

Deliverables:

- API service with health/version endpoints.
- Postgres connection and migration runner.
- Initial tables for projects, deployments, artifacts, release channels, route revisions, jobs, and audit events.

Acceptance:

- API reads/writes real persisted state.
- Console can be configured to call real API.

Tests:

- Migration tests.
- API integration tests against test Postgres.

### CLI-023 Local Worker And Artifact Store

Scope: Docker builder and local immutable artifacts.

Deliverables:

- Worker process that claims jobs, runs Docker builds, collects logs, validates output dir, and publishes artifact manifests.
- Local artifact backend with checksum verification.

Acceptance:

- A sample static project builds into an immutable artifact.
- Artifact metadata is recorded before deployment becomes routable.

Tests:

- Worker unit tests with command adapter mocks.
- Integration test for sample project build.

### CLI-024 Managed Nginx And TLS

Scope: routing side effects.

Deliverables:

- Nginx template rendering from desired route state.
- Syntax validate, symlink/swap, reload, and previous known-good rollback.
- TLS mode for Let's Encrypt or provided certificate files.

Acceptance:

- Invalid config never replaces active config.
- Route apply records revision status.

Tests:

- Nginx renderer tests.
- Apply adapter tests with mocked `nginx -t` and reload.

## Epic D: Product Loop

### CLI-030 Deploy Key And Webhook Setup

Scope: repository integration.

Deliverables:

- Server-side SSH deploy key generation and public key output.
- Per-project webhook secret generation.
- Signed webhook verification and idempotency.

Acceptance:

- Private keys and webhook secrets are never printed.
- Duplicate webhook deliveries do not enqueue duplicate builds.

Tests:

- Signature verification tests.
- Idempotency tests.

### CLI-031 Framework Detection

Scope: build preset selection.

Deliverables:

- Initial presets for Vite/static and at least one prerender/static-export framework.
- Package manager and output directory detection.
- Manual override support.

Acceptance:

- Ambiguous detection requires explicit project setting.
- Deployment records include preset, command, output path, and commit.

Tests:

- Fixture repositories for supported/ambiguous/unsupported cases.

### CLI-032 Promotion And Rollback

Scope: release-channel operations.

Deliverables:

- Transactional release-channel pointer changes.
- Route revision enqueue/apply.
- Audit reason, actor, idempotency key, and previous target preservation.

Acceptance:

- Rollback selects a prior successful deployment and does not rebuild.
- Failed route apply leaves the prior route active.

Tests:

- Transaction tests.
- Route apply failure tests.

## Epic E: Lifecycle Operations

### CLI-040 Backup

Scope: restorable backups.

Deliverables:

- Bundled DB dump.
- Install-state and config snapshot.
- Backup manifest and checksums.
- Optional local artifact inclusion.

Acceptance:

- Backup manifest validates independently.
- Secret export is metadata-only unless encrypted export is explicitly requested.

Tests:

- Backup manifest tests.
- DB dump command adapter tests.

### CLI-041 Restore

Scope: replacement-host recovery.

Deliverables:

- Backup validation.
- Restore DB, config, install state, and optional artifacts.
- Host/domain/path remapping.
- Post-restore doctor.

Acceptance:

- Restore refuses to overwrite an active install without explicit confirmation.
- Replacement-host restore reaches critical doctor pass.

Tests:

- Restore plan tests.
- Integration restore smoke test.

### CLI-042 Upgrade

Scope: release-bundle upgrades.

Deliverables:

- Bundle fetch/use-local flow.
- Compatibility and migration plan validation.
- Pre-upgrade backup, migration lock, restart, post-upgrade doctor.
- Rollback-on-fail only when bundle metadata permits it.

Acceptance:

- Upgrade preserves data and route state.
- Irreversible migration requires explicit backup confirmation.

Tests:

- Bundle compatibility tests.
- Migration lock tests.
- Upgrade failure path tests.

### CLI-043 Uninstall, Status, Logs

Scope: operator lifecycle commands.

Deliverables:

- Safe uninstall with `--keep-data` default and guarded purge.
- Status view for services, version, topology, domains, queue, workers, and last route apply.
- Logs tailing by service.

Acceptance:

- Uninstall removes generated units/config and leaves data by default.
- Purge requires explicit confirmation.

Tests:

- Uninstall plan tests.
- Status output tests.

## Epic F: Verification Harness

### CLI-050 Install Smoke Test VM

Scope: production confidence.

Deliverables:

- Automated fresh-host install smoke test for Ubuntu LTS.
- Sample project build, route, promote, rollback, backup, restore, and uninstall checks.

Acceptance:

- A release candidate cannot pass without a fresh install smoke result.

Tests:

- End-to-end VM or containerized host test.

### CLI-051 Security Regression Suite

Scope: secret and fixture boundaries.

Deliverables:

- Tests that assert production output and logs do not include secret canaries.
- Tests that assert production bundles do not import fixtures.
- Permission drift checks in doctor.

Acceptance:

- Secret canaries are absent from CLI output, logs, API responses, artifacts, and generated Nginx config.

Tests:

- Canary tests.
- Import-boundary tests.

