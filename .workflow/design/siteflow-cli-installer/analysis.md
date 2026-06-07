# SiteFlow CLI Installer Design Analysis

Date: 2026-05-15
Skill call: `$maestro-plan --dir .workflow/design/siteflow-cli-installer "Design CLI installer for self-hosted SiteFlow"`
Scope: design analysis only. No source changes.

## 1. Product Position

SiteFlow should make a Git commit deployable into a verified immutable artifact, then route that artifact through Nginx and optional CDN integration with deterministic promotion and rollback. The CLI installer should support that product promise by giving operators a fast, understandable path from a fresh server to a working SiteFlow control plane.

The installer is not the control plane itself. It is an operator bootstrap and lifecycle tool that prepares host prerequisites, writes deployment configuration, creates secrets, starts services, validates health, and records enough installation state to make later upgrades, backups, restores, and worker joins repeatable.

The strongest installer design rule is: make the default path convenient, but keep infrastructure facts visible. Operators must be able to inspect generated `compose.yaml`, `systemd` units, Nginx snippets, environment files, secret file paths, volume paths, ports, and health checks.

## 2. CLI User Experience

### Primary UX Goals

- First install should be a guided wizard with a non-interactive mode for automation.
- Every command should support `--dry-run` when it would write files, restart services, change routing, rotate credentials, or delete data.
- Every mutating command should be idempotent and should show whether it created, updated, skipped, or failed each step.
- The CLI should emit human-readable output by default and `--json` for automation.
- The CLI should never print secret values after generation. It may print file paths and secret names.
- The CLI should write an install state manifest, for example `/etc/siteflow/install-state.json`, containing versions, paths, selected topology, generated asset checksums, and service names.

### Command Set

`siteflow install`

- Purpose: bootstrap a new SiteFlow node or single-machine installation.
- Interactive defaults: ask deployment topology, public domain, email for TLS, database mode, artifact storage mode, worker mode, Nginx ownership, ports, install directory, data directory, and backup directory.
- Non-interactive flags:
  - `--topology single|control-plane|worker`
  - `--domain app.example.com`
  - `--email ops@example.com`
  - `--db bundled|external`
  - `--database-url postgres://...`
  - `--storage local|s3`
  - `--s3-endpoint`, `--s3-bucket`, `--s3-region`
  - `--nginx managed|external|none`
  - `--tls letsencrypt|provided|none`
  - `--install-dir /opt/siteflow`
  - `--data-dir /var/lib/siteflow`
  - `--yes`
  - `--dry-run`
- Expected outputs:
  - `compose.yaml` or equivalent service definition.
  - Optional `systemd` unit for lifecycle management.
  - `.env` or `siteflow.env` with non-secret config and secret references.
  - Secret files under a root-owned directory.
  - Optional Nginx server block.
  - Initial admin bootstrap token path.
  - Install state manifest.

`siteflow doctor`

- Purpose: validate host, services, network, routing, storage, and control-plane health.
- Checks:
  - OS, architecture, disk, memory, CPU, clock sync.
  - Docker or container runtime availability.
  - Required ports: HTTP, HTTPS, internal API, worker queue, DB if bundled.
  - Nginx syntax, active server block, reload status.
  - TLS certificate presence and expiry.
  - Control-plane health endpoint and version.
  - Worker registration and job claim ability.
  - DB migrations state.
  - Artifact store write/read/checksum test.
  - S3 credentials if configured.
  - Webhook public URL reachability, when possible.
  - Backup directory permissions.
- Output should classify findings as `pass`, `warn`, or `fail`, and include exact remediation commands where practical.

`siteflow upgrade`

- Purpose: upgrade SiteFlow components while protecting data and rollback path.
- Flow:
  - Read install state.
  - Fetch or use pinned release bundle.
  - Validate compatibility and migration plan.
  - Run preflight `doctor`.
  - Require or create backup unless `--no-backup` is explicitly supplied.
  - Pull images or binaries.
  - Apply config migrations.
  - Apply DB migrations with migration lock.
  - Restart services.
  - Run post-upgrade `doctor`.
- Flags:
  - `--to <version>`
  - `--channel stable|rc`
  - `--backup`
  - `--dry-run`
  - `--rollback-on-fail`
- Upgrade must not delete old images, config snapshots, or backups until retention policy allows it.

`siteflow uninstall`

- Purpose: remove installed services safely.
- Modes:
  - `--keep-data` default.
  - `--purge-data` requires explicit confirmation phrase or `--yes --purge-data-confirm <token>`.
  - `--keep-nginx` for externally managed routing.
- Must stop services, remove generated units, optionally remove Nginx config, and leave a final uninstall report.

`siteflow backup`

- Purpose: create a restorable backup of control-plane state and local artifact state.
- Backups should include:
  - Database dump for bundled Postgres or instructions/connector for external DB.
  - Install state manifest.
  - Generated config files.
  - Secret metadata and optional encrypted secret export.
  - Local artifacts if storage is local.
  - Nginx generated config snapshots.
- Flags:
  - `--output <path>`
  - `--include-artifacts`
  - `--encrypt-age-recipient <recipient>`
  - `--dry-run`
- External S3 artifacts should not be copied by default; backup should record bucket, prefix, manifest records, and verification sample.

`siteflow restore`

- Purpose: restore a backup into the same host or a replacement host.
- Flow:
  - Validate backup manifest and target topology.
  - Stop affected services.
  - Restore DB.
  - Restore local artifacts if included.
  - Restore generated config and secrets.
  - Re-render host-specific config where paths, domains, or IPs changed.
  - Run `doctor`.
- Flags:
  - `--from <backup>`
  - `--target-domain <domain>`
  - `--remap-path old=new`
  - `--dry-run`
- Restore must never implicitly overwrite an existing live installation without explicit confirmation.

`siteflow join-worker`

- Purpose: add a build worker node to an existing control plane.
- Control plane side should generate a short-lived join token:
  - `siteflow worker-token create --ttl 15m --name worker-01`
- Worker side:
  - `siteflow join-worker --control-plane https://siteflow.example.com --token <token> --worker-name worker-01`
- The worker install should configure:
  - Worker service only.
  - Docker build permissions.
  - Resource limits.
  - Job queue credentials or mTLS/client token.
  - Artifact storage credentials scoped to publish/read required prefixes.
- Worker join should be repeatable: if the worker already exists, refresh registration after operator confirmation or `--replace`.

`siteflow domain`

- Purpose: manage domains and generated Nginx/TLS integration.
- Subcommands:
  - `siteflow domain add <host> --project <slug> --channel production`
  - `siteflow domain remove <host>`
  - `siteflow domain verify <host>`
  - `siteflow domain list`
  - `siteflow domain render-nginx --dry-run`
  - `siteflow domain apply`
- Domain changes should be control-plane records first, then routing side effects. Nginx reload should follow validate-and-swap behavior with previous known-good config preserved.

`siteflow deploy-key`

- Purpose: create, register, rotate, and inspect repository clone credentials.
- Subcommands:
  - `siteflow deploy-key generate --project <slug> --provider github|gitlab|gitea|generic`
  - `siteflow deploy-key show-public --project <slug>`
  - `siteflow deploy-key test --project <slug>`
  - `siteflow deploy-key rotate --project <slug>`
  - `siteflow deploy-key revoke --project <slug>`
- Private keys should be generated on the server, stored as secrets, and never printed. Public key output should be printable and copyable for Git provider setup.

Additional useful commands:

- `siteflow status`: compact view of version, services, topology, domains, workers, queue depth, and last routing apply.
- `siteflow logs`: tails control-plane, worker, router, and migration logs with service filters.
- `siteflow config render`: re-render compose, env, systemd, or Nginx assets without applying.
- `siteflow config diff`: show drift between generated desired config and currently applied files.
- `siteflow secrets rotate`: rotate internal app keys, webhook secrets, worker tokens, and optional deploy keys with scoped workflows.
- `siteflow migration status`: inspect database schema version and pending migrations.

## 3. Target Deployment Topologies

### Topology A: Single Machine

Use case: fastest MVP install, internal teams, small project count.

Components:

- SiteFlow API/control plane.
- Bundled Postgres.
- Bundled queue or DB-backed job queue.
- One local build worker.
- Local filesystem artifact store.
- Nginx on the same host.
- Optional Let's Encrypt TLS.

Pros:

- Minimal operator burden.
- Best for first end-to-end demo.
- Simple backup and restore.

Constraints:

- Build workloads compete with API and routing.
- Local artifacts make horizontal scale and disaster recovery harder.
- Nginx reload failures directly affect the only node.

Installer default: this should be MVP default.

### Topology B: Control Plane Plus Worker Nodes

Use case: teams with heavier builds or isolation requirements.

Components:

- Control-plane host: API, scheduler, DB connection, routing applier, Nginx.
- Worker hosts: Docker build workers only.
- Shared artifact storage, preferably S3-compatible or a network filesystem with clear caveats.
- Workers communicate with control plane through HTTPS and a queue or broker endpoint.

Pros:

- Isolates untrusted build execution from API and routing.
- Allows worker scale-out.
- Enables different resource profiles.

Constraints:

- Requires secure worker registration.
- Requires network policy for worker egress and artifact storage.
- Backup spans control-plane DB plus shared artifact storage metadata.

Installer behavior:

- `install --topology control-plane` configures API, router, DB, storage, and join-token issuance.
- `join-worker` configures worker-only services and registration.

### Topology C: External DB And S3

Use case: production-grade operations with durable backing services.

Components:

- SiteFlow services run on one or more hosts.
- External Postgres is the source of truth.
- External S3-compatible storage owns immutable artifact bytes.
- Optional managed Redis or queue if the product uses one.
- Nginx may remain local, be externally managed, or sit behind a load balancer/CDN.

Pros:

- Better durability and disaster recovery.
- Easier worker scale-out.
- Artifact retention and capacity management move out of the application host.

Constraints:

- Installer cannot fully back up external dependencies unless credentials and policy allow it.
- Doctor must validate permissions precisely: DB migration rights, artifact write/read/delete policy, bucket versioning expectations, lifecycle rules.

Installer behavior:

- Require explicit external connection strings and storage credentials.
- Store only references and scoped credentials.
- Print external backup responsibilities clearly.

### Topology D: Nginx And CDN Front Door

Use case: production domains, TLS, cache behavior, and optional CDN purge/prewarm.

Components:

- Nginx resolves host/path to release channels or preview deployments.
- Generated Nginx config points to immutable artifact paths or internal artifact-serving endpoint, depending on storage mode.
- CDN sits in front of Nginx or directly in front of artifact-serving routes where supported.
- Routing state remains DB-owned; Nginx/CDN are side effects.

Required behavior:

- Generated Nginx config must be syntax-checked before reload.
- Apply should write a new config revision and preserve the previous known-good revision.
- CDN purge/prewarm must be optional and retryable.
- Domain verification must distinguish DNS, TLS, Nginx, and control-plane failures.

## 4. Installer Responsibility Boundaries

The installer should generate and manage:

- `compose.yaml` for the selected topology.
- Optional `systemd` unit such as `siteflow.service`.
- Nginx site files or include snippets when `--nginx managed`.
- Environment files with non-secret config and secret file references.
- Secret files with strict permissions.
- Directory structure under `/opt/siteflow`, `/var/lib/siteflow`, `/var/log/siteflow`, and `/etc/siteflow`.
- Install state manifest.
- Backup manifests and config snapshots.
- Worker registration files.
- Optional TLS bootstrap through ACME client integration.

The installer should not hide or own:

- DNS provider setup, unless a future adapter is explicitly configured.
- External DB creation, backup, failover, and patching.
- S3 bucket lifecycle, replication, and account-level access policy.
- Host firewall strategy beyond checks and optional suggested commands.
- OS patching and Docker daemon hardening.
- CDN account configuration beyond a scoped adapter token.
- Git provider UI steps for adding public deploy keys, unless provider API credentials are supplied.

This boundary matters because SiteFlow is self-hosted. A Vercel-like CLI experience should reduce setup friction, but operators still need to understand which process listens on which port, where bytes live, how secrets are stored, how routing is applied, and what must be backed up.

## 5. Security Model

### Root And Sudo

- `install`, `upgrade`, `uninstall`, `domain apply`, and TLS operations may need root or sudo because they write system directories, manage services, bind ports, and reload Nginx.
- The CLI should perform privileged steps through a narrow elevation path and drop privileges for application-level operations.
- Runtime services should run as a dedicated `siteflow` user, not root.
- Build workers need Docker access; this is a high-privilege boundary and should be documented as equivalent to host-level trust unless rootless/container isolation is later implemented.

### Secret Generation And Storage

Secrets generated during install:

- Application signing key.
- Session/auth secret.
- Internal service token.
- Worker join signing key.
- Webhook secret generation seed or per-project webhook secret store key.
- DB password for bundled Postgres.
- Artifact storage credentials when local service is bundled, if applicable.
- Admin bootstrap token.

Rules:

- Use cryptographically strong random generation.
- Store secrets in root-owned files, for example `/etc/siteflow/secrets/*.secret`, readable only by the service user where required.
- Never write raw secret values into logs, install state, Nginx config, artifact manifests, or command output.
- Support secret rotation workflows with compatibility windows where required.

### Git Deploy Keys

- Prefer per-project deploy keys over broad account tokens.
- Generate SSH key pairs server-side.
- Store private keys as secrets with least-readable permissions.
- Print or export only public keys.
- Provide `deploy-key test` to verify clone access without exposing credentials.
- Rotation should create a new key, test it, switch project reference, and then allow old key revocation.

### TLS

- For managed Nginx, support Let's Encrypt HTTP-01 by default and provided certificate paths for restricted environments.
- Store certificate paths in config and certificate metadata in install state, not certificate private key contents.
- `doctor` should warn before expiry.
- TLS should be mandatory for control-plane URLs used by worker join, Git webhooks, and admin access unless an explicit local-only mode is selected.

### Webhook Secrets

- Per-project webhook secrets are required for provider webhooks.
- The CLI can generate and show a one-time setup value during project binding, then store it only as a secret reference.
- Webhook verification failures must be safe and non-revealing.
- Webhook event IDs or fingerprints should be persisted for idempotency.

### Least Privilege

- Separate control-plane, worker, router-applier, and backup credentials.
- Worker credentials should not permit control-plane administration.
- Artifact credentials should be scoped by bucket/prefix and operation where possible.
- DB users should be separated for application runtime and migrations if the target operational model supports it.
- CDN tokens should be scoped to purge/prewarm for configured zones only.
- Generated Nginx should serve artifacts without exposing internal admin endpoints.

## 6. Upgrade, Rollback, Backup, And Restore

### Upgrade Strategy

Upgrades should be release-bundle driven. A release bundle should include image tags or binary checksums, config schema version, migration metadata, compatibility notes, and rollback constraints.

Recommended sequence:

1. Read install state and current versions.
2. Run preflight `doctor`.
3. Create config snapshot.
4. Create or verify a recent backup.
5. Pull new images or binaries.
6. Render new config to a staging path.
7. Validate config diff and Nginx syntax if routing config changes.
8. Acquire migration lock and run DB migrations.
9. Restart services.
10. Run health checks and post-upgrade `doctor`.
11. Mark install state as upgraded.

### Rollback Strategy

There are two rollback types:

- SiteFlow platform rollback: revert the installed SiteFlow version after a failed upgrade.
- Deployment rollback: move a project release channel to a previous immutable deployment.

The installer primarily owns platform rollback. It should preserve old config, old images, and backup metadata long enough to revert a failed upgrade. DB rollback is harder after irreversible migrations, so release bundles must declare migration reversibility. If a migration is not reversible, the CLI should require an explicit backup confirmation before proceeding.

Deployment rollback remains a control-plane operation, but the installer must preserve the routing adapter invariant: previous known-good Nginx config is retained and can be restored if a generated config fails validation or reload.

### Backup Strategy

Backup must be topology-aware:

- Single-machine local storage: DB dump plus local artifacts plus config and secrets metadata.
- External DB/S3: DB backup may be delegated, artifacts may remain in S3, but the backup manifest must record external dependency coordinates and verification results.
- Control-plane plus workers: workers are mostly replaceable if their registration and control-plane state are intact; backup should focus on control-plane DB, config, secrets, artifact metadata, and storage.

The backup manifest should include:

- Backup schema version.
- SiteFlow version.
- Install topology.
- DB dump metadata and checksum.
- Artifact inclusion mode and checksum samples.
- Config file checksums.
- Secret export mode.
- Generated Nginx revision.
- Created-at time and host identity.

### Restore Strategy

Restore should validate before writing. It must detect whether it is restoring into the same host, replacement host, or different topology. Host-specific paths and domains may need remapping.

Restore should not claim success until:

- DB is reachable and migrated to expected version.
- Artifact manifest checks pass.
- Config renders successfully.
- Services start.
- Nginx validates and reloads if managed.
- `doctor` passes critical checks.

## 7. Failure Recovery And Idempotency

The installer should model operations as steps with durable checkpoints in install state. Each step should be safe to rerun.

Examples:

- Directory exists with expected owner: skip.
- Secret exists: reuse unless `--rotate` is requested.
- Compose file rendered with same checksum: skip write.
- Compose file differs: write staged file, show diff, then replace.
- Service exists: update only if generated unit changed.
- Nginx config exists: validate ownership marker before changing.
- DB migration already applied: skip.
- Worker already registered: verify identity or require `--replace`.
- Backup already exists for operation ID: verify checksum and reuse.

Failure handling principles:

- Write to staging paths before replacing active files.
- Keep previous known-good config for compose, env, systemd, and Nginx.
- Never delete data as part of failed install or upgrade cleanup.
- Mark partial operations clearly in install state.
- Offer `siteflow doctor` and `siteflow repair` style remediation hints, even if `repair` is introduced later.
- Use operation IDs so retrying after network or process failure does not duplicate tokens, domains, workers, or migrations.

Critical failure scenarios:

- Nginx reload fails: keep previous config active, record failed revision, surface exact `nginx -t` error.
- DB migration fails: stop dependent services, preserve logs, require operator decision before retry or restore.
- TLS issuance fails: keep HTTP or previous certificate based on selected policy, do not block non-public local install unless TLS was required.
- S3 validation fails: do not start deployment services that would publish artifacts.
- Worker join token expires: fail safely and request a new token.
- Upgrade health check fails: attempt platform rollback only if release bundle declares rollback-safe; otherwise stop and point to backup restore.

## 8. MVP And Later Phases

### MVP: Single-Host Installable SiteFlow

MVP should include:

- `install`, `doctor`, `upgrade`, `uninstall`, `backup`, and `restore`.
- Single-machine topology.
- Bundled Postgres.
- Local artifact storage.
- Local worker.
- Managed Nginx.
- TLS via Let's Encrypt or provided cert.
- Secret generation and storage.
- Install state manifest.
- Config render/diff internals, even if not exposed as first-class commands.
- Clear operator documentation output after install.

MVP should prove the core product path:

- Create project.
- Configure Git webhook and deploy key.
- Build static or prerendered output in Docker.
- Publish immutable artifact.
- Route through Nginx.
- Promote or roll back without rebuilding.

### Phase 2: Production Operations

Add:

- External Postgres.
- S3-compatible artifact storage.
- `deploy-key` full lifecycle.
- `domain` lifecycle.
- Upgrade rollback improvements.
- Encrypted backups.
- Better service logs and metrics checks in `doctor`.
- DB migration status command.

### Phase 3: Distributed Workers

Add:

- `join-worker`.
- Worker token lifecycle.
- Worker health and capacity reporting.
- Worker labels and resource classes.
- Stronger Docker isolation guidance.
- Queue/broker externalization if needed.

### Phase 4: Advanced Routing And CDN

Add:

- CDN adapter configuration.
- Purge/prewarm validation.
- Wildcard preview domains.
- Path-based preview fallback.
- Multi-domain project workflows.
- Safer route preview and staged apply.

### Explicit Non-MVP

- Kubernetes operator.
- Full CI/CD pipeline language.
- Serverless runtime installation.
- Enterprise multi-tenant identity.
- Fully automated DNS provider integration.
- Opaque one-command install that hides generated system assets.

## 9. Open Decisions

- Standard reference database and queue: bundled Postgres plus DB-backed queue is simplest; Redis or another broker may be useful later.
- Artifact serving mode: Nginx direct filesystem serving is simplest for local artifacts; S3-backed installs may need a SiteFlow artifact-serving endpoint or CDN-origin pattern.
- Preview URL default: wildcard DNS is ergonomic but requires DNS control; path-based routing is easier for MVP but less Vercel-like.
- Rootless build isolation: Docker group access is operationally risky; decide whether MVP documents this or invests in stronger isolation.
- Backup secret export: decide whether default backup includes encrypted secrets or only secret metadata and operator instructions.

## 10. Recommended Planning Shape

This design should become a small number of implementation tasks, grouped by feature rather than file:

1. CLI foundation and install state: command framework, config model, state manifest, render/apply primitives, dry-run and JSON output.
2. Single-host install path: compose, env, secrets, systemd, Nginx, TLS, first-run doctor.
3. Lifecycle operations: doctor, backup, restore, upgrade, uninstall with staged writes and idempotency.
4. Security workflows: deploy key generation, webhook secret handling, least-privilege file permissions, secret rotation hooks.
5. Production topology extensions: external DB/S3, domain management, worker join, CDN-ready routing.

The first implementation should not attempt all commands at full depth. It should build the shared installer engine first, then make `install` and `doctor` excellent for a single-machine deployment. Every later command depends on the same state, rendering, validation, and checkpoint model.
