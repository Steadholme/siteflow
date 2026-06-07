# SiteFlow CLI Installer Specification

Date: 2026-05-15
Status: ready for implementation planning
Source: `.workflow/design/siteflow-cli-installer/analysis.md`

## 1. Objective

The `siteflow` CLI must give operators a Vercel-like installation path for a self-hosted SiteFlow server while keeping the operational model inspectable. The MVP target is a production-capable single-host install with real services: control plane, Postgres, build worker, local artifact storage, Nginx routing, TLS, secrets, install state, and doctor checks.

The installer is not a mock demo. It must create, start, validate, upgrade, back up, restore, and uninstall real infrastructure. Fixtures may remain in frontend tests and isolated local UI demos only; production and install flows must use real API, database, worker, storage, and routing adapters.

## 2. Product Boundary

The CLI owns bootstrap and lifecycle operations:

- Host preflight and dependency validation.
- Release bundle acquisition or local bundle use.
- Directory, user, permission, and secret setup.
- Config rendering for Compose, env files, systemd, Nginx, and TLS.
- Service start, migration, health validation, and install state persistence.
- Upgrade, backup, restore, uninstall, doctor, deploy-key, domain, and worker join workflows.

The control plane owns runtime product behavior:

- Project, repository, webhook, deployment, artifact, release-channel, preview, audit, and route state.
- Build job scheduling and worker coordination.
- Artifact metadata, retention protection, and rollback eligibility.
- Domain records and desired routing state.

The routing layer is an applied side effect of database-owned state. Nginx and CDN operations must be observable, retryable, and reversible to the previous known-good generated config.

## 3. MVP Topology

The first supported install mode is:

- One Linux host.
- `siteflow-api` control plane.
- Bundled Postgres.
- Local DB-backed queue or Postgres advisory-lock job queue.
- One local `siteflow-worker` using Docker to run builds.
- Local filesystem artifact store under `/var/lib/siteflow/artifacts`.
- Managed Nginx on the same host.
- TLS through Let's Encrypt HTTP-01 or provided certificate files.
- Root-owned config and secret files.
- Runtime services running as a dedicated `siteflow` user where possible.

External Postgres, S3-compatible storage, separate workers, CDN adapters, wildcard preview domains, and Kubernetes are later phases.

## 4. Command Contract

| Command | MVP | Purpose |
| --- | --- | --- |
| `siteflow install` | yes | Bootstrap the selected topology and run first `doctor`. |
| `siteflow doctor` | yes | Validate host, services, DB, storage, routing, TLS, and build readiness. |
| `siteflow backup` | yes | Create topology-aware backup with DB dump, config snapshot, manifest, and optional artifacts. |
| `siteflow restore` | yes | Restore a backup after validating target safety and remapping host-specific values. |
| `siteflow upgrade` | yes | Apply release bundle updates with preflight, backup, migration, health check, and rollback handling. |
| `siteflow uninstall` | yes | Remove generated services/config safely, keeping data by default. |
| `siteflow status` | yes | Compact state view for version, services, domains, workers, queue, and last route apply. |
| `siteflow logs` | yes | Tail service logs by component. |
| `siteflow deploy-key` | phase 2 | Generate, show public, test, rotate, and revoke repository deploy keys. |
| `siteflow domain` | phase 2 | Manage domain records and Nginx render/apply lifecycle. |
| `siteflow join-worker` | phase 3 | Register a worker-only host using a short-lived join token. |
| `siteflow config` | phase 2 | Render, diff, and validate generated config without applying. |
| `siteflow secrets rotate` | phase 3 | Rotate internal app, webhook, worker, and deploy-key secrets. |
| `siteflow migration status` | phase 2 | Inspect DB schema version and pending migrations. |

All mutating commands must support `--dry-run`. Commands that may be used by automation must support `--json`. Mutating commands must be idempotent and report step outcomes as `created`, `updated`, `skipped`, `validated`, or `failed`.

## 5. Host Layout

| Path | Owner | Purpose |
| --- | --- | --- |
| `/opt/siteflow` | root | Release bundle, rendered Compose file, templates, CLI-managed assets. |
| `/etc/siteflow` | root | Install state, non-secret env files, config snapshots. |
| `/etc/siteflow/secrets` | root | Secret files with restricted read permissions. |
| `/var/lib/siteflow` | `siteflow` | Postgres volume, local artifacts, worker cache, operation checkpoints. |
| `/var/log/siteflow` | `siteflow` | Service logs when not fully delegated to journald/Docker. |
| `/var/backups/siteflow` | root | Backup archives and manifests. |
| `/etc/nginx/sites-available/siteflow*` | root | Managed Nginx generated configs. |
| `/etc/nginx/sites-enabled/siteflow*` | root | Symlinked active config. |

The installer must mark generated files with ownership metadata and must refuse to overwrite unmanaged files unless the operator explicitly imports or replaces them.

## 6. Install State Manifest

`/etc/siteflow/install-state.json` is the durable source for CLI lifecycle operations. It must not contain raw secret values.

Minimum schema:

```json
{
  "schemaVersion": 1,
  "siteflowVersion": "0.1.0",
  "installedAt": "2026-05-15T00:00:00Z",
  "topology": "single",
  "paths": {
    "installDir": "/opt/siteflow",
    "configDir": "/etc/siteflow",
    "dataDir": "/var/lib/siteflow",
    "backupDir": "/var/backups/siteflow"
  },
  "services": {
    "manager": "systemd",
    "unit": "siteflow.service",
    "composeFile": "/opt/siteflow/compose.yaml"
  },
  "database": {
    "mode": "bundled",
    "schemaVersion": 1,
    "secretRef": "/etc/siteflow/secrets/postgres-password.secret"
  },
  "storage": {
    "mode": "local",
    "artifactRoot": "/var/lib/siteflow/artifacts"
  },
  "router": {
    "mode": "managed-nginx",
    "activeRevision": "nginx-rev-000001",
    "previousKnownGoodRevision": null
  },
  "tls": {
    "mode": "letsencrypt",
    "domains": ["siteflow.example.com"]
  },
  "checksums": {
    "compose": "sha256:...",
    "env": "sha256:...",
    "nginx": "sha256:..."
  },
  "lastOperation": {
    "id": "op_...",
    "type": "install",
    "status": "succeeded"
  }
}
```

Every lifecycle command must validate the manifest before writing and must snapshot it before replacement.

## 7. Operation Engine

Each mutating command should run the same internal operation phases:

1. `load`: read install state, release bundle metadata, command flags, and host facts.
2. `plan`: produce a step graph with prerequisites, writes, restarts, migrations, and checks.
3. `render`: write desired assets to staging paths and compute checksums.
4. `diff`: show changes unless `--yes` or non-interactive JSON mode suppresses prompts.
5. `apply`: perform writes through atomic replace, service actions, migrations, and route apply.
6. `verify`: run command-specific health checks.
7. `commit`: update install state and operation checkpoint.

Operation checkpoints belong under `/var/lib/siteflow/operations/<operation-id>.json`. Retrying the same operation must not duplicate secrets, tokens, Nginx revisions, DB migrations, backups, domains, or workers.

## 8. Single-Host Install Flow

`siteflow install --topology single` must:

1. Validate OS, architecture, CPU, memory, disk, time sync, Docker, Nginx, ports, DNS, and TLS inputs.
2. Create the `siteflow` user and required directories.
3. Generate secrets and admin bootstrap token files.
4. Render `compose.yaml`, env files, systemd unit, Nginx staging config, and TLS config.
5. Start Postgres and run DB migrations.
6. Start API and worker services.
7. Validate local artifact store write/read/checksum behavior.
8. Apply Nginx with validate-and-swap.
9. Issue or validate TLS certificates.
10. Run `siteflow doctor`.
11. Write install state and print an operator summary with secret paths, service names, public URL, and next commands.

Install must fail closed if DB, artifact storage, or Nginx validation fails. It must preserve staged files and logs for diagnosis, but it must not claim a successful installation until critical `doctor` checks pass.

## 9. Doctor Checks

`siteflow doctor` must classify checks as `pass`, `warn`, or `fail`:

- Host resources and OS support.
- Docker daemon availability and worker build permission.
- Service status and health endpoints.
- DB connectivity, migration state, and migration lock availability.
- Artifact store write/read/checksum.
- Nginx syntax and active generated revision.
- TLS certificate presence, hostname match, and expiry warning.
- Required ports and public reachability when domain is configured.
- Webhook URL reachability if public domain exists.
- Backup directory permissions and latest backup age.
- Queue/job claim readiness.
- Secret file ownership and permission drift.

Critical failures must include concrete remediation hints. JSON output must be stable enough for automation.

## 10. Backup And Restore

Backups must include:

- Backup manifest with schema version, SiteFlow version, topology, host identity, and timestamps.
- DB dump and checksum for bundled Postgres.
- Install state and rendered config snapshots.
- Secret export mode: metadata-only by default, encrypted export only when explicitly configured.
- Local artifacts when `--include-artifacts` is set.
- Nginx generated revision snapshots.

Restore must validate before writing. It must refuse to overwrite a live install unless the operator explicitly confirms. A successful restore requires DB reachability, expected schema version, artifact validation, config render success, service health, Nginx validation, and critical `doctor` pass.

## 11. Upgrade And Rollback

Upgrade must be release-bundle driven. A release bundle must describe images or binaries, checksums, config schema changes, DB migration metadata, compatibility notes, and rollback constraints.

Upgrade flow:

1. Read install state and current release bundle.
2. Run preflight `doctor`.
3. Create config snapshot and backup unless explicitly bypassed.
4. Pull or verify new images/binaries.
5. Render new config to staging.
6. Validate config diff, Nginx syntax, and migration plan.
7. Run DB migrations under a lock.
8. Restart services.
9. Run post-upgrade `doctor`.
10. Mark install state upgraded.

Platform rollback can only be automatic when the bundle declares rollback-safe migrations. Deployment rollback remains a control-plane release-channel operation over immutable deployments.

## 12. Security Requirements

- Runtime services must not run as root unless a component has a documented unavoidable reason.
- Secret values must never appear in stdout, logs, install state, Nginx config, artifact manifests, or generated route config.
- Deploy keys are generated server-side; only public keys may be printed.
- Worker join tokens are short-lived and single-purpose.
- Webhook secrets are per project.
- Nginx apply must preserve previous known-good config.
- Build worker Docker access must be documented as a high-trust boundary until stronger isolation is implemented.
- External DB, S3, and CDN credentials must be scoped and validated by `doctor`.

## 13. Production Readiness Gates

The MVP CLI installer is not ready until these gates pass:

- Fresh Ubuntu LTS VM install succeeds from a published release bundle.
- Re-running `siteflow install` is idempotent and does not rotate existing secrets.
- `siteflow doctor --json` produces stable machine-readable output.
- A real project can be created through the API, built by the worker, published to local artifacts, routed by Nginx, promoted, and rolled back.
- Backup and restore works on a replacement VM for bundled DB plus local artifacts.
- Upgrade from version N to N+1 preserves data and route state.
- Uninstall removes generated services/config and keeps data by default.
- No production path depends on frontend fixtures, fake clients, or mocked persistence.

