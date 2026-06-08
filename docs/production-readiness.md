# SiteFlow Production Readiness

This document records the current production scope and the gaps that remain. SiteFlow cannot be described as production-ready yet.

Current status as of 2026-06-08: production-hardening in progress for a narrow single-host, trusted-operator profile. The project still has P0 gaps that can cause unsafe builds, difficult recovery, or unsafe upgrades.

Operational follow-up documents:

- `docs/operations-runbook.md` describes the minimum readiness, metrics, restore-drill, and release-promotion runbooks for the current trusted single-host/staging profile.
- `docs/production-distance-matrix.md` lists current capabilities, trusted single-host or staging-only boundaries, full production blockers, and evidence that must come from real environments.
- `docs/private-repo-credentials.md` documents the explicit SSH deploy-key path for private repository checkout without URL-embedded credentials.

## Completed waves

### Wave 001 - runtime and installer safety baseline

- Server authorization fails closed when protected routes need auth and no API token is configured.
- Sensitive control-plane read routes require at least read access.
- Server 500 responses avoid returning raw internal error messages.
- HTTP client supports bearer token injection and typed/redacted errors.
- Runtime config exposes an operator-console API token path for the current MVP.
- Worker entrypoint supports a long-running poll loop with graceful shutdown.
- Installer output includes a worker service.
- Production secret sealing fails fast when no app/sealing secret is configured.
- Installer output injects the app/sealing secret into runtime services.
- Initial production readiness documentation was added.

### Wave 002 - source, queue, HTTP, and CI baseline

- Added GitHub Actions CI for `npm ci`, `npm test -- --run`, and `npm run build` on `main` pushes and pull requests.
- Added remote Git source resolution for GitHub/GitLab/Gitea/generic repositories when `repository.providerPayload.remoteUrl` or `url` is configured.
- Source builds now checkout `sourceEvent.commitSha` and verify `HEAD` after checkout instead of building whatever branch is current.
- Build jobs now have lease fields, retry accounting, stale `running` recovery, and heartbeat renewal while the worker is executing a job.
- Control-plane/API reads and writes now have a default request body limit and a configurable in-memory rate limit. Health and static artifact paths are not counted against the control-plane rate limit.
- Documented the current release/readiness state, remaining blockers, and minimum launch checklist.

### Wave 003 - migration safety, backup/restore CLI, and production unsafe build guard

- Schema migrations now run under a Postgres advisory transaction lock.
- Applied migrations now store `checksum_sha256`; legacy rows without a checksum are backfilled, and checksum drift fails migration startup.
- Added `siteflow backup` to create a local backup manifest, run `pg_dump`, and copy the configured artifact root when it exists.
- Added `siteflow restore` to require `--yes`, validate the backup manifest, run `psql`, and restore local artifacts.
- Added JSON output and database URL secret redaction for backup/restore CLI failures.
- This is only the minimum CLI loop. Production readiness still requires a real restore drill, scheduled/retained backups, off-host storage, monitoring, and documented RPO/RTO targets.
- Worker runtime config now exposes `allowUnsandboxedSourceBuilds`.
- When `NODE_ENV=production` or `SITEFLOW_ENV=production`, source build jobs are skipped before checkout/install/build unless `SITEFLOW_TRUSTED_SOURCE_BUILDS=1` or `SITEFLOW_ALLOW_UNSANDBOXED_BUILDS=1` is explicitly set.
- The skip reason is written to job logs and treated as a terminal skipped job so the worker does not retry the same policy rejection.
- This build guard is not a sandbox. It is only a fail-closed guard around the existing host build path.

### Wave 004 - release gate and backup static validation

#### Local release gate and branch protection evidence

- Added `siteflow release-gate` as a local production release check.
- The gate verifies the CI workflow exists and includes `npm ci`, `release:source:check`, `npm test`, `npm run build`, `release:artifacts:check`, `npm run test:e2e`, and the static release-gate sanity check.
- The release image workflow writes and uploads `release-image-evidence.json`, so GHCR digest evidence is machine-readable instead of only appearing in the GitHub step summary.
- The workflow now inspects the published image in the registry and records SLSA provenance and SBOM attestation manifest metadata in that evidence artifact.
- The final release evidence bundle now requires that `release-image-evidence.json` artifact and checks its schema, GHCR digest, image tags, source repository/commit, GitHub run metadata, registry attestation subject, provenance/SBOM attestation manifest digests, inspection freshness, and evidence freshness before `release:evidence` can pass.
- Added `npm run release:evidence:post-promote` to verify, after promotion, that the inspected production route stores release evidence metadata matching the final passing release bundle and deployment artifact counts.
- Added `npm run release:source:cleanup-plan` as a non-destructive, read-only Git index report for reviewing forbidden tracked release-source paths before a cleanup commit. It outputs `blocked` / `pass` JSON with recommended `git rm --cached -r -- ...` commands, but it does not execute cleanup or delete working tree files.
- The gate verifies this production readiness document exists and still documents the required env names and branch protection requirement.
- The gate checks `git status --porcelain` and fails on a dirty worktree unless `--allow-dirty` is passed for a static sanity check.
- Runtime env values can be checked from `--env-file` or from process env with `--require-env`.
- GitHub branch protection verification is attempted when `GITHUB_TOKEN` and `GITHUB_REPOSITORY` or `--repo` are available. If they are not available, the gate reports `manual_required` instead of passing.
- CI now runs `siteflow release-gate --allow-dirty --allow-manual-branch-protection` after the build as a no-secret static sanity check.

#### Backup verify static validation

- Added `siteflow backup verify --backup <dir>` to statically validate a backup before an operator attempts a restore.
- The verifier checks manifest schema, relative path safety, non-empty plain SQL dump presence, and artifact directory presence when the manifest says artifacts were copied.
- The verifier has JSON and text output and explicitly reports `verificationType: static` / `restoreDrill: false`.
- This is not a real restore drill. Production readiness still requires an isolated end-to-end restore into disposable Postgres and artifact targets, plus scheduled/retained/off-host backups, monitoring, and documented RPO/RTO targets.

#### Minimum Docker build runner entrypoint

- Worker runtime config now supports `SITEFLOW_BUILD_RUNNER=host|docker`.
- Production workers default to the Docker build runner; non-production workers keep the host runner by default.
- Docker builds execute the existing command allowlist through `docker run` with `shell:false`, a project-root bind mount, a temporary env-file for build env, and env-file cleanup after completion or start failure.
- The Docker runner applies minimum controls for network mode, memory, CPU, PID limit, and container user. Network defaults to `none`; `SITEFLOW_BUILD_NETWORK=bridge` can be set when dependency installation needs outbound network access.
- Installer-generated Compose explicitly sets `SITEFLOW_BUILD_RUNNER=docker`, mounts the host Docker socket, and checks `command -v docker` plus `docker info` before starting the worker so missing Docker CLI/daemon access fails closed.
- The generated socket mount is only for a trusted single-host operator profile. It is not appropriate for untrusted operators, tenant-controlled workloads, or a multi-tenant sandbox.
- Production host builds remain rejected unless `SITEFLOW_TRUSTED_SOURCE_BUILDS=1` or `SITEFLOW_ALLOW_UNSANDBOXED_BUILDS=1` is explicitly set.
- This is a minimum executable sandbox runner, not a complete untrusted multi-tenant build isolation boundary.

### Wave 005 - restore fail-fast, branch protection specificity, analytics read auth

- Restore now runs the same static backup verification before invoking `psql`, so missing artifact directories are rejected before database state is changed.
- Restore invokes `psql` with `ON_ERROR_STOP=1` and `--single-transaction` to fail fast and avoid partial plain-SQL restore execution when the dump supports transactional replay.
- GitHub branch protection verification now requires the expected CI status check name, defaulting to `Install, test, and build`. Use `--required-status-check <name>` or `SITEFLOW_REQUIRED_STATUS_CHECK` only when the protected job name intentionally differs.
- Analytics dashboard reads now require read authorization. Analytics event ingestion remains unauthenticated by design for browser telemetry and still applies privacy sanitization.

### Wave 006 - installer and Docker runner minimum alignment

- Installer-generated production Compose now sets `SITEFLOW_BUILD_RUNNER=docker` on the worker service instead of relying only on worker runtime defaults.
- The worker service mounts `/var/run/docker.sock`, sets `TMPDIR` to the host-visible artifact mount, and fails closed during startup when the Docker CLI or Docker daemon is unavailable.
- This generated profile is a trusted single-host operator profile. The Docker socket grants host Docker daemon control to the worker container and is not a multi-tenant sandbox boundary.
- Worker build steps now have `SITEFLOW_BUILD_STEP_TIMEOUT_MS` so hung install/test/build commands fail the job instead of renewing the queue lease indefinitely.
- Remote Git checkout/fetch commands now have `SITEFLOW_GIT_TIMEOUT_MS` so hung source resolution fails before checkout can block the worker forever.
- Docker runner timeouts now use a Docker `--cidfile` and attempt `docker kill` plus `docker rm -f` so the build container is not left running when the Docker CLI process is terminated.

### Wave 007 - control-plane rate-limit bucket hardening

- Control-plane API rate limiting no longer trusts client-provided `x-siteflow-bucket-key` values.
- API rate buckets are now derived from trusted network request context. Wave 037 superseded the original `X-Forwarded-For when present` behavior, and Wave 038 further limits forwarded header trust to matching proxy source policies.
- Static artifact/canary routing still accepts `x-siteflow-bucket-key`; this header is rollout/canary affinity input only, not authentication, authorization, or rate-limit identity.
- The current control-plane limiter is process-local memory. Multi-instance production deployments still need a shared limiter or edge/proxy rate-limit layer.

### Wave 008 - structured request log hook

- The control-plane HTTP server now accepts a `requestLogger` hook for structured request completion records.
- Request log entries include request id, method, sanitized path, status, duration, and error class.
- Query strings, request bodies, authorization headers, bearer tokens, deploy hook tokens, and internal error messages are not logged by the hook.
- Expected 4xx/5xx responses receive `ExpectedHttpError`; unexpected errors keep only the error class while responses still return generic 500 bodies.
- Logger sink failures are swallowed so logging cannot change response semantics.

### Wave 009 - production runtime and app secret hardening

- Frontend runtime config now treats `import.meta.env.PROD === true` as production even when `MODE` is not literally `production`.
- Production browser bundles fail closed when `VITE_SITEFLOW_API_TOKEN` or fixture mode is present under either `PROD=true` or `MODE=production`.
- Production sealing/app secrets now reject values shorter than 32 characters and obvious placeholders such as `replace-with-*`, `changeme`, and the local development fallback key.
- Strong `SITEFLOW_APP_SECRET` remains preferred for new installs; `SITEFLOW_SEALING_KEY` remains legacy-compatible but must meet the same production strength checks.

### Wave 010 - queue exhaustion, operator token persistence, and production request logs

- Stale `running` build jobs that have already reached `max_attempts` are now marked `failed` during the next claim transaction instead of remaining stuck forever.
- The browser operator client no longer falls back to `localStorage` for `siteflow.apiToken`; the MVP browser token path read only `sessionStorage` and ignored storage failures. Wave 093 later made that `sessionStorage` fallback default-off in production.
- Production control-plane startup now installs a default NDJSON stdout request logger.
- Production request log records include only the event name, service, version, request id, method, sanitized path, status, duration, and error class.
- The default production logger does not record query strings, bodies, headers, bearer tokens, deploy hook tokens, or internal error messages.

### Wave 011 - release evidence, browser build guard, and backup integrity

- `siteflow release-gate` now supports `--promotion`, `--require-commit-status`, and `--commit-ref <sha>` so a production promotion can require GitHub branch protection and exact commit check-run evidence.
- Promotion mode requires runtime env validation and does not allow `--allow-manual-branch-protection` to downgrade missing GitHub evidence into a passing gate.
- Exact commit evidence uses the expected CI check name and verifies a completed successful GitHub check run for the release commit.
- Vite browser builds now fail before bundling when `VITE_SITEFLOW_API_TOKEN`, fixture mode, or a fixture scenario is present in the browser build environment.
- New backups write SHA-256 and size metadata for the database dump plus SHA-256, file count, and byte count metadata for copied artifacts.
- `siteflow backup verify` recalculates those checksums and fails if the dump or artifact tree no longer matches the manifest. Legacy manifests without checksum metadata remain statically verifiable but are reported as weaker evidence.

### Wave 012 - readiness, restore drill, and Git credential hardening

- The control-plane API now exposes `/readyz` separately from `/healthz`.
- Production startup injects a readiness check that verifies `SELECT 1` against Postgres and confirms the artifact root exists as a directory.
- The control-plane API now exposes minimal process-local `/metrics` counters for HTTP request total, 5xx total, 429 total, and duration sum/count without path labels or request payload data.
- `siteflow backup restore-drill --backup <dir> --database-url <disposable-postgres-url> --artifact-root <temp-root> --yes` now runs a caller-confirmed restore drill against disposable targets and returns `restoreDrill: true` evidence.
- Restore drill output explicitly marks artifact restore as `replace_non_atomic` when artifacts are copied, so it does not claim atomic restore semantics.
- Git remote URL validation now rejects embedded HTTP(S)/SSH URL credentials so repository tokens are not passed through process argv or written into checkout config.
- Git subprocesses now disable terminal prompts, askpass, SSH command inheritance, and credential helpers.
- Local and Git source checkouts now reject unsafe build job ids before using them as workspace path segments.

### Wave 013 - operations runbook and production distance matrix

- Added `docs/operations-runbook.md` with readiness probe handling, metrics scrape and alert examples, backup restore-drill workflow, release promotion evidence, and known non-goals.
- Added `docs/production-distance-matrix.md` to identify current capability, trusted single-host/staging-only support, hard blockers for full production, and evidence that must be captured in real environments.
- This wave is documentation-only. It does not collect the missing target-environment Postgres rehearsal evidence, real restore-drill evidence, real GitHub promotion evidence, or deployed observability evidence.

### Wave 013 - Postgres migration and queue rehearsal addendum

- Added an opt-in real Postgres rehearsal test for schema migrations and build queue behavior.
- The rehearsal is skipped by default and does not require Docker or Postgres for ordinary `npm test` runs.
- Enable it with `SITEFLOW_RUN_POSTGRES_INTEGRATION=1` and `TEST_DATABASE_URL`, then run `npx vitest run worker/postgresRehearsal.integration.test.ts`.
- The rehearsal creates a temporary schema, runs real migrations, verifies advisory-lock waiting and checksum drift failure, and exercises queue `SKIP LOCKED`, lease claim, heartbeat renewal, stale retry, and exhausted stale lease failure paths.

### Wave 014 - operator Postgres rehearsal runner

- Added `npm run rehearsal:postgres` as the operator entrypoint for the existing real Postgres rehearsal.
- The runner checks `SITEFLOW_RUN_POSTGRES_INTEGRATION=1` and `TEST_DATABASE_URL` before invoking Vitest.
- `--dry-run` reports prerequisites and the exact Vitest command without executing the rehearsal.
- `--json` emits a single evidence object for production records without printing the raw database URL.
- `--check-docker` records Docker CLI availability, and `--require-docker` blocks the rehearsal when local Docker is required but unavailable.

### Wave 021 - Postgres rehearsal evidence hardening

- `npm run rehearsal:postgres -- --json --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <env>` now records release identity, redacted target database metadata, and an explicit rehearsal scope covering migration advisory locking, checksum drift, concurrent migration startup, `SKIP LOCKED`, concurrent worker claims, heartbeat renewal, stale recovery, and exhausted lease failure.
- The real Postgres integration rehearsal now includes concurrent API/worker migration startup and concurrent two-worker claim tests.
- `npm run release:evidence` now rejects Postgres rehearsal attachments that lack release identity, redacted target database metadata, or the required production rehearsal scope.

### Wave 022 - backup and DR policy evidence hardening

- `npm run backup:evidence` now requires backup schedule, timezone, retention policy, RPO/RTO targets, and backup-age plus restore-drill-age alert evidence.
- `siteflow backup restore-drill` now reports restored artifact tree checksum, file count, and byte count; `npm run backup:evidence` rejects restore-drill evidence unless those values match the backup verify artifact evidence.
- Release bundles inherit those checks because `npm run release:evidence` only accepts backup evidence checker output where every check passes and `requireOffHost: true` was used.
- This still audits operator evidence only. SiteFlow still does not schedule backups, enforce retention, upload off-host backups, or provision alerts by itself.

### Wave 023 - observability evidence hardening

- `npm run observability:evidence` now requires metrics scrape evidence to list the expected SiteFlow HTTP metric names from `/metrics`.
- Dashboard evidence now requires a passing status and fresh timestamp in the standalone checker, matching the release bundle freshness posture.
- This still audits evidence only. SiteFlow still does not provision Prometheus, Alertmanager, dashboards, log shipping, retention, or network allowlists.

### Wave 024 - runtime queue metrics

- `/metrics` now includes build queue gauges for queued, running, and stale jobs, plus oldest queued age and oldest running heartbeat age.
- Production startup wires those gauges to a Postgres-backed runtime metrics collector over `siteflow_build_jobs`.
- Metrics scrapes still return the HTTP metrics if runtime collection fails, and expose `siteflow_runtime_metrics_collection_error 1` without leaking the collector exception text.
- `npm run observability:evidence` now requires the runtime queue metric names in scrape evidence, so release bundles inherit the stronger queue observability gate through observability evidence.
- At Wave 024, this still did not provision dashboards, alert routing, log shipping, retention, multi-instance aggregation, backup/restore metrics, disk metrics, or Postgres replication metrics. Wave 047 later added run-record-backed backup automation gauges, while disk and Postgres replication metrics remain outside SiteFlow.

### Wave 025 - backup offload and retention execution

- Added `siteflow backup offload --backup <dir> --target file://<offhost-root>` to copy a verified backup to an off-host filesystem target and verify the copied tree checksum, object count, and byte count.
- Added `siteflow backup prune --backup-root <dir> --retention-days <days> --minimum-backups <count>` with `--dry-run` planning and `--yes` required for destructive deletion.
- `npm run backup:evidence -- --require-off-host` now requires offload evidence and non-dry-run prune evidence, including matching backup identity, off-host location, integrity, matching retention policy, and proof that the current verified backup was retained.
- `npm run release:evidence` now rejects backup checker outputs that lack the selected offload/prune evidence and corresponding passed checker names.
- Wave 068 later tightened production `--require-off-host` evidence so `file://` no longer satisfies the production off-host gate by itself.
- This still does not schedule backups or prune runs, upload to S3/object storage, provision backup alerts, or automate recurring restore drills.

### Wave 026 - operator session API MVP

- Added hashed `siteflow_operator_sessions` storage with token prefix, scopes, status, expiry, revoke timestamp, and last-used timestamp.
- Added `POST /api/auth/session` so an admin-authenticated operator can mint a short-lived operator session and receive an HttpOnly `siteflow_session` cookie.
- Added cookie-backed authorization for sensitive API routes when no Bearer token is present. Bearer tokens keep precedence over cookies so CLI and automation semantics do not change.
- Added `DELETE /api/auth/session` to revoke the current cookie session and clear the cookie.
- `/api/auth/verify` now accepts either existing Bearer token auth or a valid operator session cookie while preserving the existing response shape for CLI compatibility.
- This is still an API-level session MVP. Full production auth still needs password or external IdP login, login UI, MFA/SSO, idle timeout policy, session rotation, cross-origin cookie/CORS hardening, and a documented break-glass/rotation procedure.

### Wave 027 - upgrade/rollback drill evidence gate

- Added `npm run upgrade-rollback:evidence` to validate operator-collected API, worker, schema, route/artifact, readiness, metrics, logs, alert, backup, operator, and ticket evidence from a target-equivalent upgrade/rollback drill.
- The checker requires a non-dry-run drill, fresh timestamps, matching release commit/repository/branch, pinned API and worker image digests, successful upgrade and rollback operation ids, route rollback to the previous artifact, real HTTP rollback verification, and forward-compatible schema evidence.
- `npm run release:evidence:compose` now requires `--upgrade-rollback-evidence` and includes the checker output in the release bundle.
- `npm run release:evidence` now rejects release bundles that lack fresh passed upgrade/rollback drill evidence or have inconsistent release identity.
- This still audits evidence only. SiteFlow still does not implement an automated upgrade orchestrator, down migrations, multi-host rollout, CDN/object-storage rollback, or recurring drill scheduling.

### Wave 028 - observability provisioning artifacts

- Added `npm run observability:provisioning` to render a versioned `siteflow.observabilityProvisioning.v1` plan.
- The plan emits checksummed `prometheus-scrape.yaml`, `prometheus-rules.yaml`, `alertmanager-route.yaml`, and `grafana-dashboard.json` artifacts for the minimum SiteFlow `/metrics`, readiness, HTTP error/rate-limit, queue, and runtime collection alerts.
- The rendered Prometheus scrape config uses bearer-token `credentials_file` references instead of embedding token values.
- Added shared SiteFlow metric definitions so `/metrics`, the observability evidence checker, and the provisioning plan use the same required metric names.
- This still renders artifacts only. SiteFlow does not apply the monitoring stack, create secrets, verify alert delivery, import dashboards, ship logs, configure retention, or aggregate multi-instance metrics.

### Wave 029 - backup evidence composer

- Added `npm run backup:evidence:compose` to assemble backup verify, restore-drill, backup offload, backup prune, backup policy, operator, and ticket inputs into the raw backup evidence shape accepted by `npm run backup:evidence`.
- The composer supports `--require-off-host` so production evidence composition fails before writing a misleading output when offload or prune inputs are missing.
- The composer supports `--check` and `--check-output`; `--check-output` writes the `siteflow-backup-evidence-check` result expected by `npm run release:evidence:compose`.
- Added `scripts/backupEvidenceCompose.test.ts` covering raw evidence output, checker output, off-host requirements, dry-run prune blocking, CLI JSON, and usage errors.
- This still does not schedule backups, run restore drills, upload to cloud/object storage, provision alerts, or prove target storage durability. It only reduces manual evidence assembly errors.

### Wave 030 - observability evidence collector

- Added `npm run observability:evidence:collect` to scrape target `/readyz` and `/metrics`, parse Prometheus metric names, merge operator-supplied evidence, and optionally write the checker output expected by release bundles.
- The collector reads the metrics bearer token from `--metrics-token-env` and does not store the token, raw metrics body, or query string in evidence output.
- The collector supports `--private-scrape-exception` for documented private scrape paths, and it preserves the existing `observability:evidence` checker as the source of truth.
- Added `scripts/observabilityEvidenceCollect.test.ts` covering Prometheus parsing, authenticated scrape headers, secret non-persistence, operator evidence merge, private scrape exceptions, failed collection diagnostics, checker output, and CLI usage errors.
- This still does not provision or verify the external observability stack. Alert delivery, dashboard ownership, log retention, redaction spot-checks, and readiness traffic-removal proof must still come from the target operator or platform.

### Wave 031 - operator-session CSRF guard

- Cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests now require `X-SiteFlow-CSRF: same-origin` after the `siteflow_session` cookie has satisfied authorization.
- Bearer token authorization remains first priority and does not require the CSRF header, preserving CLI and automation behavior.
- `DELETE /api/auth/session` now uses the same CSRF guard for valid cookie sessions before revoking the session.
- The browser HTTP client automatically attaches the CSRF header for same-origin mutation requests when no Bearer token is configured, while credentialless analytics ingestion and Bearer requests remain unchanged.
- CORS preflight metadata now allows `x-siteflow-csrf`.
- This closes the minimum cookie-session write CSRF gap, but it is not a full production identity boundary. SiteFlow still needs login or external IdP, MFA/SSO, documented use of global versus project sessions, idle timeout, session rotation, credentialed-CORS design, and a break-glass/rotation runbook.

### Wave 032 - server-derived audit actor attribution

- Added authentication principal resolution for scoped API tokens and operator sessions while keeping the existing permission-only repository methods for compatibility.
- Root API token requests use a fixed server-side system actor, and scoped API token requests use the token creator when available or a token-scoped system fallback.
- Operator session requests use the stored session actor when available or a session-scoped operator fallback.
- Control-plane mutating routes now override client-provided `actor` with the authenticated actor for release, rollback, rolling release, project, environment variable, log query, log drain, API token, firewall, routing, edge config, blob, cache, deploy hook, cron, and prebuilt deploy commands.
- Team member upsert still preserves `actor` as the target team member, but `requestedBy` is now always the authenticated actor; team member removal also uses authenticated `requestedBy`.
- Public deploy-hook trigger and analytics ingest strip client-provided `actor` and `requestedBy` fields instead of accepting a spoofed principal.
- Added HTTP tests proving root Bearer token, scoped API token, and cookie session writes ignore spoofed body actors.
- This improves audit attribution for the current control plane, but full production identity still needs login or external IdP, MFA/SSO, documented use of global versus project sessions, idle timeout, session rotation, credentialed-CORS design, and a break-glass/rotation runbook.

### Wave 033 - project-scoped operator sessions

- Added optional `projectIds` to operator session creation and read models.
- Added `siteflow_operator_sessions.project_ids` storage with non-empty validation and a GIN index.
- Project-scoped operator sessions retain their normal permission scopes only for matching project routes; non-matching project requests and global routes without a project id resolve to no effective scopes and are rejected by the existing authorization path.
- Unscoped operator sessions remain supported for trusted global operator workflows, and Bearer token precedence remains unchanged.
- Added tests for session creation with deduplicated `projectIds`, allowed same-project reads, and denied cross-project reads.
- This narrows the API-level session boundary, but full production identity still needs login or external IdP, MFA/SSO, idle timeout policy, session rotation, credentialed-CORS design, documented use of global versus project sessions, break-glass/rotation runbooks, and target-environment access evidence.

### Wave 034 - promotion clean-worktree gate alignment

- `siteflow release-gate --promotion` now always evaluates the Git worktree as clean-required, even if `--allow-dirty` is passed.
- This aligns the local promotion gate with the release evidence bundle checker, which already rejects promotion evidence whose `promotionEvidence.dirtyWorktree.dirty` is not `false`.
- `--allow-dirty` remains available for no-secret static sanity checks, including dirty local or CI runs that are not production promotion evidence.
- Added release-gate tests proving `promotion + allowDirty + dirty worktree` fails while branch protection, exact commit status, and runtime env checks can otherwise pass.
- Full production still requires real target repository branch protection, exact commit CI evidence, target env validation, Docker/Postgres/backup/observability/upgrade-rollback evidence, and a clean release checkout.

### Wave 035 - operator session secret and cookie hardening

- `POST /api/auth/session` now uses the raw session secret only to set the `siteflow_session` cookie; the JSON response returns session metadata without a `secret` field.
- The public `OperatorSessionCreateReadModel` no longer exposes the raw session secret. Server repository implementations use an internal result type to pass the secret to the HTTP layer.
- Production API startup now forces `Secure` on operator session cookies. Non-production servers keep the prior TLS or `X-Forwarded-Proto: https` auto-detection behavior unless `secureCookies` is explicitly enabled.
- Release evidence bundle checks now reject promotion evidence that lists any dirty worktree entries, even if `dirtyWorktree.status` is `pass` and `dirtyWorktree.dirty` is `false`.
- Added HTTP, server config, and release evidence tests for secret-free session responses, forced secure cookies, production secure-cookie defaults, and dirty entry rejection.
- Full production identity still needs login or external IdP, MFA/SSO, idle timeout, session rotation, credentialed-CORS design, documented break-glass procedures, and target-environment access evidence.

### Wave 036 - operator session idle timeout

- Postgres operator session resolution now enforces a server-side idle timeout in the same atomic `UPDATE` that refreshes `last_used_at`.
- The default idle timeout is 1800 seconds. Operators can set `SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS` to an integer from 60 to 86400 for the target policy.
- Session use succeeds only when the stored session is active, within its absolute `expires_at` TTL, and within `COALESCE(last_used_at, created_at)` plus the idle timeout window.
- Added repository SQL-shape tests for idle timeout query values and server config tests for the default and invalid environment values.
- Full production identity still needs login or external IdP, MFA/SSO, session rotation, credentialed-CORS design, documented non-session credential break-glass procedures, and target-environment access evidence.

### Wave 037 - trusted proxy header boundary

- The control plane now ignores `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` by default.
- `SITEFLOW_TRUST_PROXY=1` explicitly enables forwarded header trust for deployments where the API is reachable only through a trusted reverse proxy that overwrites those headers. Wave 038 supersedes this boolean production guidance with source policies.
- The trusted proxy gate covers request host/scheme reconstruction, artifact route host matching, image optimization host matching, deploy hook URL generation, API rate-limit bucket identity, firewall IP evaluation, and non-production Secure cookie auto-detection.
- Installer-generated Nginx now overwrites `X-Forwarded-For` with `$remote_addr`, adds `X-Real-IP`, and enables trusted proxy mode in generated env/Compose for the managed single-host proxy profile.
- Added HTTP tests proving spoofed `X-Forwarded-For` cannot bypass rate limits when proxy trust is disabled and that trusted proxy mode still accepts sanitized forwarded client IPs.
- This was not a full proxy identity policy. Wave 038 adds source policy matching, but production still needs target evidence that only trusted ingress can reach the API port and shared or edge rate limiting for multi-instance deployments.

### Wave 038 - trusted proxy source policy

- `SITEFLOW_TRUST_PROXY` now accepts `loopback`, `private`, or comma-separated exact IP/CIDR entries. Truthy aliases such as `1` and `true` resolve to `loopback` for compatibility.
- Forwarded headers are trusted only when the socket peer matches the configured proxy source policy.
- The installer-managed Nginx profile now sets `SITEFLOW_TRUST_PROXY=loopback`, matching its same-host reverse-proxy topology.
- Added tests for default env parsing, invalid CIDR rejection, loopback trusted-proxy acceptance, and non-matching CIDR rejection.
- Remaining proxy gaps are target ingress verification, support for explicit hop-count semantics in complex proxy chains, and shared or edge rate limiting for multi-instance deployments.

### Wave 039 - managed Nginx API edge rate limit

- Installer-managed Nginx now emits `limit_req_zone $binary_remote_addr zone=siteflow_api:10m rate=120r/m;`.
- The control-plane `= /api` and `^~ /api/` locations apply `limit_req zone=siteflow_api burst=60 nodelay;` and return `429` when the edge bucket is exceeded.
- Preview/static traffic, `/healthz`, `/readyz`, and `/metrics` remain outside the Nginx API edge limiter.
- This closes the minimum installer-managed single-host ingress limiter gap. Multi-instance or multi-ingress production still needs target evidence that an equivalent shared or edge limiter is enforced before traffic reaches any API instance.

### Wave 040 - target ingress evidence gate

- Added `npm run ingress:evidence` to validate operator-collected target ingress evidence.
- The checker requires `siteflow.ingressEvidence.v1`, release identity, a non-dry-run target environment, HTTPS public base URL, blocked direct API port evidence, trusted proxy source policy evidence, forwarded-header overwrite evidence, API `429` edge/shared limiter evidence, non-API route non-throttling evidence, operator, and ticket metadata.
- `npm run release:evidence:compose` now requires `--ingress-evidence`, and `npm run release:evidence` rejects bundles without fresh passed ingress checker output tied to the release commit, repository, and branch.
- This is an evidence gate only. It does not probe networks or configure target ingress by itself; the evidence still has to come from the actual target topology.

### Wave 041 - operator session emergency cutoff

- Added Bearer-only global `POST /api/auth/sessions/revoke-all` and project-scoped `POST /api/projects/:projectId/auth/sessions/revoke-all` emergency cutoff endpoints.
- The endpoints reject cookie-only requests and do not fall back to an admin cookie when a lower-scope Bearer token is present.
- Revoke-all actor attribution is derived from the authenticated Bearer principal; request-body `actor` and `requestedBy` are ignored.
- Postgres stores append-only cutoff evidence in `siteflow_operator_session_cutoffs` and rejects sessions older than the latest matching global or project cutoff.
- This closes the operator-session emergency cutoff gap only. It does not implement full login, IdP/MFA, session rotation, API token rotation, app-secret rotation, or credentialed-CORS policy.

### Wave 042 - operator access evidence gate

- Added `npm run operator-access:evidence` to validate operator-collected target access evidence for the current API-level operator session boundary.
- The checker requires `siteflow.operatorAccessEvidence.v1`, release identity, non-dry-run target or target-equivalent evidence, HTTPS public URL, session create cookie flags, secret-free session responses, idle-timeout/TTL evidence, project-scope denial evidence, current-session revoke evidence, CSRF enforcement, Bearer precedence, server-derived actor attribution, Bearer-only global/project emergency cutoff evidence, raw credential hygiene, operator, and ticket metadata.
- `npm run release:evidence:compose` now requires `--operator-access-evidence`, and `npm run release:evidence` rejects bundles without fresh passed operator access checker output tied to the release commit, repository, and branch.
- This is an evidence gate only. It does not create sessions, rotate API tokens or app secrets, validate credentialed CORS, or implement login/IdP/MFA.

### Wave 043 - non-session credential evidence gate

- Added `npm run non-session-credential:evidence` to validate operator-collected non-session credential rotation and break-glass evidence.
- The checker requires `siteflow.nonSessionCredentialEvidence.v1`, release identity, non-dry-run target or target-equivalent evidence, target environment, operator, ticket metadata, supported credential types, credential owner/ticket metadata, redacted old/new identifiers, no raw credential archival, old credential rejection, new credential acceptance, type-specific rotation proof, break-glass controls, and an explicit no-automatic-rotation claim.
- Supported credential evidence covers scoped API tokens, root API tokens, metrics tokens, app/sealing secrets, database credentials, webhook secrets, SSH deploy keys, log-drain signing secrets, and deploy hook tokens.
- `npm run release:evidence:compose` now requires `--non-session-credential-evidence`, and `npm run release:evidence` rejects bundles without fresh passed non-session credential evidence tied to the release commit, repository, and branch.
- This is an evidence gate only. It does not generate, distribute, rotate, reload, or revoke external credentials by itself, and a claim that SiteFlow automatically rotated external credentials is a blocking failure.

### Wave 044 - release evidence rehearsal pack

- Added `npm run release:evidence:rehearsal-pack` with `release:evidence:pack` as a short alias.
- The pack generates a release-bound evidence collection manifest and Markdown runbook for the exact commit, repository, branch, target env file, HTTPS public URL, operator, and ticket.
- The pack enumerates command plans and expected output paths for release gate, Docker build rehearsal, Postgres rehearsal, backup evidence, observability evidence, operator access evidence, non-session credential evidence, ingress evidence, upgrade/rollback evidence, final bundle compose, and final bundle check.
- The pack rejects non-HTTPS public URLs and URLs containing credentials, query strings, or fragments so operator handoff artifacts do not archive raw access material.
- This is an offline planning artifact only. It does not call GitHub, run Docker, run Postgres, create backups, scrape metrics, execute the generated ingress collector, create sessions, rotate credentials, or generate synthetic checker output.

### Wave 045 - Docker workspace mount propagation hardening

- Docker source builds now mount the project workspace with explicit `--mount type=bind,target=/workspace,bind-propagation=rprivate` semantics instead of the shorter `-v` form.
- The build container still uses `--cap-drop ALL`, `--security-opt no-new-privileges`, read-only root filesystem, constrained tmpfs mounts, network/memory/CPU/PID/user controls, and an env-file that is removed after the command.
- This narrows host mount propagation behavior for the trusted single-host Docker runner, but it is not a complete untrusted multi-tenant build sandbox.

### Wave 014 - metrics scrape token hardening

- `/metrics` now supports optional bearer-token protection through `SITEFLOW_METRICS_TOKEN`.
- When a metrics token is configured, unauthenticated scrapes return `401` and incorrect bearer tokens return `403`; valid metrics scrapes still avoid path labels, query strings, request bodies, authorization headers, bearer tokens, deploy hook tokens, and internal error messages.
- Production startup now requires `SITEFLOW_METRICS_TOKEN` unless `SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1` is explicitly set as a documented private-scrape exception.
- This reduces the scrape endpoint exposure risk, but it does not replace private networking, reverse-proxy allowlists, dashboards, alert routing, or multi-instance metrics aggregation.

### Wave 015 - release-gate Docker runner and image posture

- Promotion runtime env validation now requires production source builds to declare `SITEFLOW_BUILD_RUNNER=docker`, unless `SITEFLOW_BUILD_RUNNER=host` is paired with `SITEFLOW_TRUSTED_SOURCE_BUILDS=1` or `SITEFLOW_ALLOW_UNSANDBOXED_BUILDS=1` as an explicit host-build exception.
- Docker promotion evidence now requires `SITEFLOW_BUILD_IMAGE` to be set to a sha256 digest. Tagged build images must be constrained by `SITEFLOW_BUILD_IMAGE_ALLOWLIST` and explicitly accepted with `SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1`.
- `siteflow release-gate --promotion --json` records source-build posture, host-build exceptions, and Docker image policy details under `promotionEvidence.runtimeEnv`.
- A `manual_required` branch protection or commit-status result still blocks production promotion; it is not downgraded by the Docker posture evidence.

### Wave 015 - private repository SSH credentials

- Remote Git checkout now supports explicit operator-mounted SSH deploy keys through `SITEFLOW_GIT_SSH_KEY_PATH`.
- `SITEFLOW_GIT_KNOWN_HOSTS_PATH` can pin provider host keys and requires `SITEFLOW_GIT_SSH_KEY_PATH`.
- Git subprocesses still disable terminal prompts, askpass, inherited `GIT_SSH_COMMAND`, and credential helpers by default; a controlled `GIT_SSH_COMMAND` is set only when the deploy-key path is configured.
- Credential paths must be absolute mounted file paths without whitespace, `..`, or shell-control characters.

### Wave 015 - backup and DR evidence checker

- Added `npm run backup:evidence` to validate an operator evidence JSON file for fresh backup verification and restore-drill records.
- The checker requires passing backup verify evidence, passing restore-drill evidence with `restoreDrill: true`, freshness windows, and optional off-host backup location evidence.
- Missing, stale, failed, or static-only evidence returns `status: "blocked"` and exits non-zero.
- This checker audits evidence only. It does not schedule backups, upload off-host copies, monitor RPO/RTO, or perform the restore drill.

### Wave 016 - production evidence gates

- Production Docker workers now fail closed at runtime when `SITEFLOW_BUILD_RUNNER=docker` is active without an explicit `SITEFLOW_BUILD_IMAGE`.
- Production Docker worker startup requires `SITEFLOW_BUILD_IMAGE` to be pinned to a sha256 digest, or for a tagged image to be both accepted by `SITEFLOW_BUILD_IMAGE_ALLOWLIST` and explicitly acknowledged with `SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1`, matching the release-gate posture rule.
- `npm run backup:evidence` now requires stronger DR evidence fields: backup identifier, database checksum verification, artifact checksum/file count/byte count, restore duration, disposable database target, temporary artifact target, artifact restore mode, operator, and incident or release ticket id.
- Added `npm run observability:evidence` to validate target-environment readiness, metrics scrape, alert delivery, dashboard ownership, log retention, and redaction spot-check evidence.
- These checks still audit evidence only. They do not collect the real GitHub, Postgres, backup, observability, log shipping, or rollback evidence that must come from the target environment.

### Wave 017 - release evidence bundle

- Added `npm run release:evidence` to validate a combined release evidence JSON file.
- The release evidence bundle requires `schemaVersion`, bundle `name`, `checkedAt`, `targetEnvironment`, and per-attachment `sourcePath`, `collectedAt`, and `releaseCommit` metadata.
- The bundle checker requires passing promotion-mode release-gate evidence, no `manual_required` checks, passing GitHub branch protection, passing exact commit status, passing runtime env posture, a clean promotion worktree with no listed dirty entries, and consistent commit/repository/branch evidence.
- The bundle checker requires a non-dry-run passed Docker build rehearsal when promotion runtime env uses `SITEFLOW_BUILD_RUNNER=docker`, a non-dry-run passed Postgres rehearsal, passing backup evidence checked with `requireOffHost: true`, and passing observability evidence.
- The bundle checker blocks stale rehearsal/checker outputs, stale dashboard evidence, invalid attachment timestamp ordering, and requires release operator plus incident or release ticket metadata.
- This still does not create the external evidence. It only prevents a release bundle from passing when target-environment evidence is missing, stale, inconsistent, or produced by dry-run/static-only paths.

### Wave 018 - production bearer token posture

- Production API startup now rejects missing, short, or placeholder `SITEFLOW_API_TOKEN` values with the same minimum strength policy used for app sealing secrets.
- Production metrics startup now rejects weak `SITEFLOW_METRICS_TOKEN` values when metrics bearer protection is configured; `SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1` remains an explicit private-scrape exception.
- Global API token comparisons now use a constant-time digest comparison helper, matching the metrics token path.
- `siteflow release-gate` records `apiTokenStrengthStatus`, `metricsTokenStrengthStatus`, `appSecretStrengthStatus`, and `appSecretSource` in `promotionEvidence.runtimeEnv`.
- `npm run release:evidence` now blocks release bundles whose promotion evidence does not show passing production token and app-secret strength posture.

### Wave 019 - Docker build rehearsal evidence

- Added `npm run rehearsal:docker-build` as an operator entrypoint for real Docker build runner rehearsal evidence.
- The runner requires `SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL=1`, `SITEFLOW_BUILD_IMAGE`, Docker CLI availability, and Docker daemon access before it will execute the build worker path.
- The real rehearsal creates a tiny source project with a locked local `file:` dependency, runs `npm ci` and `npm run build` through `runBuildWorkerOnce` with `buildRunner: "docker"`, publishes an artifact, records dependency/network posture, verifies the dependency was imported into the build output, and verifies that an injected build secret was redacted from logs.
- `--dry-run` reports prerequisites and Docker image posture without executing the build worker; dry-run output is not production evidence.
- The release evidence bundle now requires a fresh, non-dry-run, passed Docker build rehearsal attachment when promotion runtime env uses `SITEFLOW_BUILD_RUNNER=docker`, and the rehearsal image must match `promotionEvidence.runtimeEnv.buildImage`.

### Wave 020 - release evidence bundle composer

- Added `npm run release:evidence:compose` to assemble release-gate, Docker build rehearsal, Postgres rehearsal, backup, observability, operator access, non-session credential, ingress, and upgrade/rollback drill JSON outputs into the `siteflow.releaseEvidence.v1` bundle shape.
- The composer derives commit, repository, branch, and required status check metadata from release-gate promotion evidence unless explicitly overridden.
- The composer requires release operator and release ticket metadata, accepts `--ticket-id` as a release-ticket alias, and supports `--checked-at` for reproducible bundle timestamps.
- The composer fails before writing a bundle when Docker runner promotion evidence lacks Docker build rehearsal input, when a host-build exception is not explicitly accepted with `--host-build-exception-accepted`, or when raw evidence commit/repository/branch metadata conflicts with the selected release.
- The release evidence checker also rejects mismatched `release` metadata or raw attachment commit/repository/branch values, even when CLI target options and attachment wrapper metadata are correct.
- The composer is not a validator. A composed bundle must still pass `npm run release:evidence`.

### Wave 046 - backup automation runner

- Added `npm run backup:automation` as a one-shot backup automation runner for cron, systemd timers, or an external orchestrator.
- The runner calls the backup APIs directly to create a backup, statically verify it, perform a caller-confirmed restore drill against disposable targets, offload to `file://`, run dry-run and confirmed prune, then compose raw backup evidence plus backup checker output for release bundles.
- Wave 068 later made the `file://` output non-production-passing for `--require-off-host`; the runner remains useful as a local/staging rehearsal and run-record source, but it does not prove production object-storage durability by itself.
- The runner requires `--restore-drill-yes`, distinct restore-drill database/artifact targets, and an operator-provided `--policy` file with schedule, retention, RPO/RTO, and alert ownership evidence.
- Each completed step writes JSON evidence immediately, so partial backup and verify evidence remain available when a later step fails.
- `siteflow backup restore-drill` now includes `completedAt`, allowing its output to satisfy backup evidence freshness checks directly.
- This is not a daemon, cloud-object-storage adapter, KMS workflow, alert provisioner, or unattended disaster recovery system.

### Wave 047 - backup automation observability closure

- `backup:automation --run-record <file>` now writes a stable `siteflow-backup-automation-run` record for observability and release-adjacent evidence.
- `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD` lets `/metrics` derive backup automation, restore-drill, offload, and prune age gauges plus offload/prune failure flags from that run record.
- `/metrics` now includes backup gauges alongside HTTP and queue metrics; missing or unreadable run records surface as `siteflow_backup_metrics_collection_error` without leaking file contents or parse errors.
- `npm run observability:evidence:collect -- --backup-automation-run <file>` can merge the backup automation run summary into observability evidence, and `npm run observability:evidence` requires the completed run record, completed backup steps, and passed backup checker output. Wave 068 later made the built-in `file://` backup automation path insufficient for production-passing off-host backup checker output.
- Observability provisioning now includes starter backup automation and restore-drill freshness alerts, but this is still rendered configuration and evidence checking only. It does not prove alert delivery, configure cloud/object storage, manage KMS, or schedule recurring monitored restore drills.

### Wave 048 - release evidence gap reporter

- Added `npm run release:evidence:gaps` and alias `release:evidence:gap-report`.
- The reporter reads a `release:evidence:rehearsal-pack` JSON file and the existing target evidence outputs, then reports missing, invalid, blocked, failed, manual-required, dry-run-only, stale, and identity-mismatched items.
- Each gap includes the next command from the pack so operators can continue the target evidence run without re-deriving file paths or command arguments.
- The reporter is read-only. It does not call GitHub, run Docker, run Postgres, create backups, scrape metrics, probe ingress, create sessions, rotate credentials, compose fake evidence, or perform upgrade/rollback drills.
- A clean gap report is not production evidence. Production promotion still requires every target command to run and `npm run release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --json` to pass for the exact release commit.

### Wave 049 - release evidence prerequisite preflight

- `release:evidence:gaps` now inspects the rehearsal pack command arguments and environment requirements before operators rerun the next evidence command.
- Non-passing items include `inputGaps` for missing raw input files, missing env variable names, unresolved structured command argument placeholders, operator-supplied env placeholders, and fixed env requirements that do not match.
- The input preflight intentionally treats `step.outputPath`, `captureStdoutTo`, `--output`, and `--check-output` as outputs, not prerequisites, so raw input gaps do not get confused with missing evidence outputs.
- The report does not print secret values or env-file contents; it reports names and local paths only.
- This still does not execute or verify the real target systems. It reduces operator setup errors before a target evidence run, but production promotion still requires the final release evidence bundle check to pass.

### Wave 050 - Postgres rehearsal gap diagnostics

- `release:evidence:gaps` now applies Postgres-specific diagnostics to the `postgres_rehearsal` evidence file instead of relying only on generic status, exit code, and checker output shape.
- The reporter blocks generic-passing Postgres JSON when required prerequisites failed, release identity is absent, target database metadata is missing or contains credentials, or the required migration/queue rehearsal scope is incomplete.
- The Postgres item now reports those causes in `failedChecks` as `postgres_prerequisites`, `postgres_release_identity`, `postgres_target_database`, and `postgres_rehearsal_scope`, with the next pack command preserved for rerun.
- This wave does not run Postgres, Docker, psql, or the target environment. It does not close the Postgres P0 by itself; production promotion still requires a non-dry-run target-equivalent `rehearsal:postgres` output for the exact release commit and a passing final release evidence bundle.
- A deeper hardening remains: the runner should eventually archive structured per-scenario results for each required migration and queue scope instead of relying only on the static `rehearsalScope` list plus Vitest exit code.

### Wave 051 - Postgres scenario evidence closure

- The real Postgres integration rehearsal now writes structured per-scenario evidence when `SITEFLOW_POSTGRES_REHEARSAL_EVIDENCE_PATH` is supplied by the runner.
- `npm run rehearsal:postgres` creates a fresh temporary scenario evidence file for each non-dry-run execution, passes it to Vitest, reads the resulting JSONL records, and includes `scenarioResults` plus `scenarioValidation` in the final `siteflow-postgres-rehearsal` JSON.
- The runner returns `status: "failed"` and `exitCode: 1` when Vitest exits 0 but the scenario evidence is missing, incomplete, or contains a failed required scope.
- `release:evidence:gaps` and the final `release:evidence` bundle check now require passed `scenarioResults` for every required migration and queue scope through `postgres_scenario_results`.
- This improves evidence quality only. It still does not execute a target-equivalent Postgres rehearsal on this machine, does not prove branch protection, Docker build rehearsal, backup/DR, observability, ingress, credential, operator access, or upgrade/rollback evidence, and does not make SiteFlow production-ready by itself.

### Wave 052 - Docker and backup evidence diagnostics

- The final release evidence bundle now rejects weak Docker build rehearsal JSON when required prerequisites failed, the evidence name/build runner shape is wrong, Docker daemon evidence is absent, image policy is not digest-pinned or an explicitly accepted allowlisted tag, build network is not `none`, resource posture is incomplete, build commands are not exactly `npm ci` then `npm run build`, or artifact byte/checksum/redaction evidence is missing. The rehearsal output itself also records dependency fixture posture so operators can distinguish the non-empty dependency fixture from a no-dependency build.
- `release:evidence:gaps` now applies the same Docker diagnostics before final bundle composition through failed checks such as `docker_build_rehearsal_profile`, `docker_build_rehearsal_commands`, and `docker_build_rehearsal_artifact`.
- `release:evidence:gaps` now applies backup-specific diagnostics for `backup_evidence`, including `requireOffHost: true`, selected verify/restore/offload/prune evidence, and required offload/prune checker names.
- The gap reporter now reads `selectedEvidence.releaseCommitRef` from final release evidence check output so a final check from another release commit is reported as `identity_mismatch` before composition.
- This wave still does not run Docker, backup, restore drills, cloud/object storage, KMS, alert delivery, or target infrastructure. It reduces weak or misfiled evidence getting to final promotion checks, but real target evidence remains required.

### Wave 053 - release evidence gap and target environment consistency

- `release:evidence:gaps` now evaluates the final `siteflow.releaseEvidence.v1` bundle with the same `evaluateReleaseEvidenceBundle` logic used by `npm run release:evidence`, instead of accepting a bundle only because its schema and name look correct.
- The final bundle checker now accepts `--target-environment` and fails `target_environment` when the bundle target differs from the rehearsal pack target or when root and release-level target labels conflict.
- `release:evidence:rehearsal-pack` now includes `--target-environment` in both final compose and final check commands, and the composer writes `release.targetEnvironment` into the bundle.
- `release:evidence:gaps` now applies shape diagnostics to the final release evidence check output, requiring the `siteflow-release-evidence-bundle-check` name, `evidencePath`, selected release identity, and non-empty passing checks.
- This reduces false green gap reports for shallow final bundles or copied final check JSON. It still does not collect target evidence or replace the final `release:evidence` check.

### Wave 054 - ingress evidence false-positive hardening

- The ingress evidence checker no longer treats top-level `status: "blocked"` or `status: "limited"` as a passing evidence status; those statuses remain valid only for the direct-port and API rate-limit sub-evidence where they mean the expected control was observed.
- Explicit trusted proxy IP/CIDR entries are now validated with `node:net.isIP`, strict IPv4/IPv6 prefix ranges, and no `/0` all-source policy.
- Non-API route evidence now requires health, readiness, preview, and static routes to return 2xx while not rate-limited, and metrics to return `200`, `401`, or `403` while not rate-limited. A `500` response no longer passes as merely "not 429".
- This improves ingress evidence quality only. The checker still audits operator-collected evidence and does not probe the target network.

### Wave 055 - observability gap diagnostics

- `release:evidence:gaps` now applies observability-specific diagnostics to `observability_evidence` instead of relying only on generic `status`, `exitCode`, and failed checker rows.
- The gap reporter now requires observability checker output to come from `siteflow-observability-evidence-check`, be passed with `exitCode: 0`, include selected readiness, metrics, backup automation, alert, dashboard, and log pipeline summaries with status and timestamp, and include all passed check names from the observability checker.
- Weak JSON that only says `status: "passed"` or omits alert, dashboard, log, backup automation, or redaction checks is reported as `blocked` with `observability_selected_evidence` or `observability_required_checks` before final bundle composition.
- This remains evidence quality validation only. It does not apply Prometheus/Alertmanager/Grafana resources, deliver alerts, scrape target metrics, verify log shipping, or prove readiness traffic removal in the target environment.

### Wave 056 - upgrade/rollback drill evidence hardening

- `upgrade-rollback:evidence` now supports `--target-environment` and requires root/release target environment metadata to match the requested target.
- The drill checker now requires ordered drill timestamps, distinct upgrade and rollback operation ids, complete embedded backup checker output with all checks passing, and rollback metrics/logs/alerts correlated to the actual rollback operation after rollback completion.
- `release:evidence:gaps` and the final `release:evidence` bundle check now reject shallow upgrade/rollback checker JSON that lacks selected target environment, version pair, operation ids, or required drill checker rows such as `drill_time_order`, `backup_evidence_passed`, `route_rollback_restores_previous_artifact`, `metrics_evidence`, `logs_evidence`, and `alert_evidence`.
- `release:evidence:rehearsal-pack` now passes `--target-environment` to the generated `upgrade-rollback:evidence` command.
- This remains evidence validation only. It does not run an upgrade, execute rollback commands, probe HTTP endpoints, scrape metrics, query logs, or deliver alerts.

### Wave 057 - ingress evidence collector

- Added `npm run ingress:evidence:collect` to actively collect target ingress evidence before the existing `ingress:evidence` checker output is used by release bundles.
- The collector probes the target public URL for non-API routes, repeatedly probes a configurable `/api` path with rotating spoofed `X-Forwarded-For` values until `429` is observed, and checks that the direct API URL is not reachable outside the trusted ingress path.
- The collector can verify forwarded-header cleanup through a controlled `--forwarded-header-echo-url`, or merge `--operator-evidence` for forwarded-header and proxy final-hop proof when the target has no echo endpoint. Missing proof writes blocked raw evidence and blocked checker output rather than a passing artifact.
- `release:evidence:rehearsal-pack` now emits an `ingress:evidence:collect` command with raw output and checker output paths.
- This reduces manual ingress evidence collection, but it still does not configure ingress, prove arbitrary multi-hop proxy ownership without echo/operator evidence, or replace shared/edge limiter proof for multi-ingress topologies.

### Wave 058 - target evidence run orchestrator

- Added `npm run release:evidence:target-run` to execute a release-bound rehearsal pack on the target evidence host.
- The runner writes a stable `siteflow-release-evidence-target-run` record, captures gap report snapshots before and after each step, and executes final bundle compose plus final release evidence check from the pack.
- It blocks when the confirmed target environment does not match the pack, when command placeholders remain unresolved, when required environment names are missing or mismatched, when captured stdout matches sensitive output patterns before evidence capture, or when a gap snapshot would archive sensitive diagnostic text.
- The run record stores command displays, env requirement names, replacement key names, output paths, exit codes, byte counts, and gap snapshot paths; it does not store env values, replacement values, raw stdout, or raw stderr.
- A target run is `completed` only when all commands complete and the final `release:evidence:gaps` snapshot passes. It still does not deploy, publish images, create infrastructure, or replace the final `release:evidence` promotion gate.

### Wave 059 - evidence-gated production promotion

- `siteflow promote <deploymentId> --channel production` and `siteflow deploy --prod` now require `--release-evidence <release-evidence.json>` before making a production promotion API call. Preview or other non-production channels are unchanged.
- The CLI validates the supplied bundle with the same `release:evidence` checker semantics for `targetEnvironment=production` and includes only release evidence metadata in the promotion request body; it does not send the full evidence bundle to the API.
- `release:evidence` now requires observability, operator access, non-session credential, and ingress evidence checker outputs to include their required passed check names, not only shallow `status: "passed"` checker rows.
- `release:evidence:gaps` uses the same required check-name diagnostics for operator access, non-session credential, and ingress evidence before final bundle composition.
- `release:evidence:rehearsal-pack` now quotes generated PowerShell display commands for paths, status-check names, operator names, release tickets, placeholders, and stdout redirection targets that contain shell-sensitive characters.
- `release:evidence:target-run` no longer writes command stdout to a formal evidence output path when the command exits non-zero. It records byte counts plus a short safe stderr preview, or only sensitive-pattern names when stderr appears to contain credentials.

### Wave 060 - server-side promotion evidence envelope

- `siteflow rolling start|advance|complete --channel production` now uses the same CLI release evidence gate as production promote/deploy and sends only release evidence metadata to the API. `rolling abort` remains available without a full release evidence bundle because it stops an in-progress rollout, but production abort now requires an explicit audit reason and records a stop-rollout release evidence exception.
- The HTTP API now rejects direct production `release/production/promote` calls and production rolling `start`, `advance`, or `complete` calls unless the request body contains a release evidence metadata envelope with `status: "passed"` and production-bound release identity fields.
- Non-production promotion and rolling commands remain compatible without release evidence metadata.
- This closes the local CLI and direct HTTP empty-evidence bypasses, but it is still an envelope check. Full production promotion still requires a passing bundle for the exact commit and target environment, protected GitHub branch/commit evidence, and target runtime evidence.

### Wave 061 - release preflight workflow and evidence freshness

- Added a manual `Release Preflight` GitHub Actions workflow that checks out an exact release commit, runs the production build, collects `siteflow release-gate --promotion` evidence for that commit, generates a release evidence rehearsal pack, writes a gap report artifact, runs Playwright E2E safeguards, and uploads the release preflight artifacts without uploading the target env file.
- The local release gate now fails if `.github/workflows/release-preflight.yml` is missing, lacks the promotion/evidence commands, or uses static-sanity override flags such as `--allow-dirty` or `--allow-manual-branch-protection`.
- The minimum CI workflow now runs Playwright E2E tests after the production build and uploads Playwright artifacts on failure.
- Direct HTTP production promotion evidence metadata now requires a strict ISO `checkedAt`, rejects future timestamps, and rejects metadata older than 168 hours. CLI bundle validation remains the stronger evidence check.
- CLI help now documents `--release-evidence release-evidence.json` on production rolling `start`, `advance`, and `complete` examples.

### Wave 062 - production prebuilt provenance

- `siteflow deploy --prebuilt --prod --release-evidence <release-evidence.json>` now copies the passing release evidence identity into the prebuilt upload request before promotion.
- Production prebuilt uploads now carry `source.repository`, `source.branch`, `source.commitSha`, and `releaseEvidence` metadata derived from the same bundle used for the production promotion request.
- The prebuilt deployment repository continues to persist `source_branch` and `source_commit_sha`, and now also stores `metadata.source` plus `metadata.releaseEvidence` in the artifact manifest for later inspection/evidence tooling.
- The HTTP prebuilt endpoint validates any supplied `releaseEvidence` metadata with the same production envelope/freshness rules before calling `deployPrebuilt`.
- This closes the `manual@prebuilt` provenance gap for CLI-driven production prebuilt deployments, but it still does not force production promotion or rolling release commands to compare the evidence commit/branch/repository with the target or candidate deployment identity.

### Wave 063 - release evidence deployment identity binding

- Production promotion now rejects target deployments whose repository, branch, or commit do not match the supplied release evidence metadata.
- Production rolling `start`, `advance`, and `complete` now apply the same identity check to the candidate deployment. `rolling abort` remains exempt from the full bundle because it preserves or stops traffic instead of advancing promotion, but it is no longer evidence-free: production abort records an audit reason and stop-rollout release evidence exception.
- Deployment identity uses the prebuilt artifact manifest `metadata.source.repository` when available and falls back to the project repository binding, while commit and branch come from `siteflow_deployments.source_commit_sha` and `source_branch`.
- Added `023_release_evidence_lineage` to persist `release_evidence` JSON on `siteflow_release_commands` and `siteflow_route_revisions`.
- Rejected production promotion commands still persist the supplied release evidence on the failed command record, so operators can audit which bundle identity was rejected.
- This closes the internal “passing bundle could promote another deployment” gap for repository-backed release commands. It does not replace real branch protection, exact commit CI, target Docker/Postgres, backup, observability, ingress, credential, or upgrade/rollback evidence.

### Wave 064 - release evidence audit visibility and raw freshness

- Deployment detail / `siteflow inspect` now surfaces route revision `releaseEvidence` metadata, so operators can audit the evidence identity from a deployment id even when they no longer have the operation id.
- `siteflow release-gate --json` now records `checkedAt` on the report and on `promotionEvidence`, giving the raw promotion evidence its own freshness anchor.
- `release:evidence` now blocks bundles whose release-gate raw evidence is missing `checkedAt`, is stale, or was collected after the attachment wrapper timestamp.
- `release:evidence:gaps` now reports passing release-gate JSON without `checkedAt` as blocked instead of accepting old schema output as fresh evidence.
- This closes the “old release-gate JSON can be repackaged with fresh attachment metadata” gap. It still does not collect real target evidence; production remains blocked until the exact release commit has a passing target evidence bundle.

### Wave 065 - release evidence pack contract and target binding

- `release:evidence:target-run` and `release:evidence:gaps` now share a rehearsal pack contract validator.
- Incomplete, truncated, or hand-edited packs are rejected before command execution or gap reporting unless they contain every required evidence step, final compose command, final check command, and the required release evidence output paths.
- `release:evidence:compose` and `release:evidence` now require Docker build rehearsal raw evidence to include release commit, repository, and branch identity.
- `release:evidence:gaps` and `release:evidence` now require Postgres rehearsal evidence `targetEnvironment` to match the pack or bundle target environment.
- This closes local false-green cases where a shallow pack or wrong-environment evidence could look usable. It still does not collect real target evidence; production remains blocked until the exact release commit has a passing target evidence bundle.

### Wave 066 - DR target isolation and Docker evidence identity

- `siteflow backup restore-drill` now rejects artifact restore targets that overlap the backup manifest's source artifact root before running `psql`.
- `backup:automation` now treats restore-drill Postgres URLs with the same host, port, and database as the same target even when credentials, casing, or query strings differ.
- `backup:automation` now rejects restore-drill artifact roots that overlap the source artifact root instead of only checking exact path equality.
- Backup automation gauges now resolve relative run-record evidence paths from the run record directory, so API process working directory changes do not break `/metrics` backup age gauges.
- `rehearsal:docker-build` now requires release identity as a prerequisite and blocks before executing the Docker build when `--commit-ref`, `--repo`, or `--branch` is missing.
- This closes local false-positive cases around disposable DR targets and Docker evidence identity. It still does not collect real target evidence or replace production off-host storage, KMS/provider retention, scheduler, alert, and recurring restore-drill proof.

### Wave 067 - access evidence target binding

- `operator-access:evidence`, `non-session-credential:evidence`, and `ingress:evidence` now accept `--target-environment <name>` and block evidence collected for a different environment.
- `release:evidence:rehearsal-pack` now passes the release target environment to operator access and non-session credential evidence commands. The ingress collector command already carried the same target binding.
- `release:evidence` now checks the expected checker names for operator access, non-session credential, and ingress evidence, preventing shallow spoofed checker output from satisfying the bundle.
- `release:evidence` and `release:evidence:gaps` now require operator access, non-session credential, ingress, and upgrade/rollback evidence target environments to match the bundle or pack target environment.
- This closes local false-binding cases for access, credential, ingress, and rollback evidence. It still does not collect real target evidence.

### Wave 068 - production off-host backup evidence contract

- `npm run backup:evidence -- --require-off-host` now rejects `file://` offload as production off-host evidence and requires object-storage/provider-backed location evidence.
- Production off-host backup evidence now also requires KMS encryption evidence and a provider retention or immutability contract whose retention window meets the backup policy.
- `release:evidence`, `release:evidence:gaps`, and `upgrade-rollback:evidence` consume the same canonical required backup check names, so older shallow backup checker output cannot satisfy release or rollback gates.
- At this wave, `backup:automation` still only supported `file://` offload, so its local run could no longer claim production off-host backup evidence until an object-storage adapter or externally supplied provider-backed evidence was added. Wave 070 adds the S3 adapter.
- This closes a false-green DR gap. It did not by itself implement cloud/object-storage upload, remote object verification, KMS provisioning, provider retention setup, scheduler evidence, or alert delivery proof.

### Wave 069 - release pack command semantic contract

- `release:evidence:rehearsal-pack` outputs are now validated as command contracts, not just JSON shape.
- `release:evidence:target-run` and `release:evidence:gaps` now reject packs whose required steps or final commands have been hand-edited to run the wrong npm script, omit release identity or target-environment flags, point at the wrong evidence input, or write/capture output to the wrong path.
- Target-run tests now use the real rehearsal pack generator instead of maintaining a fake command table, reducing drift between the generated operator pack and the runner contract.
- This closes a false-green path where a structurally complete pack could mislead operators or execute the wrong evidence command. It does not collect any real target evidence.

### Wave 070 - S3 backup offload adapter and automation evidence

- `siteflow backup offload` now supports `s3://<bucket>/<prefix>` targets through the AWS CLI in addition to `file://` local/staging targets.
- S3 offload checks the destination prefix is empty, uploads the verified backup directory with `aws s3 cp --recursive`, lists the remote prefix with `aws s3 ls --recursive`, and records target object count, byte count, source tree checksum, and checksum verification when the remote listing matches the local backup tree.
- `--kms-key-ref`, `--provider-retention-mode`, `--provider-retention-days`, and `--provider-retention-contract` are now accepted by `siteflow backup offload`; `backup:automation` exposes matching `--offload-*` flags so a single run can produce production-compatible off-host backup checker evidence.
- The KMS and provider retention fields are explicit operator/provider evidence, not provider API proof. This wave does not configure KMS, object lock, lifecycle rules, bucket policy, scheduler execution, alert delivery, or recurring restore drills.

### Wave 071 - S3 provider-side backup proof

- `siteflow backup offload --provider-proof` now verifies the uploaded S3 `manifest.json` object with `aws s3api head-object` and records provider API proof under `target.providerProof`.
- Provider proof requires the sampled object to report `ServerSideEncryption: "aws:kms"`, a non-empty `SSEKMSKeyId`, Object Lock mode, and an Object Lock retain-until timestamp that covers the requested provider retention window.
- Provider proof also checks `aws s3api get-object-lock-configuration` and requires bucket Object Lock default retention to meet the requested retention window.
- `backup:automation --offload-provider-proof` exposes the same verification path for scheduled runs, and `backup:evidence --require-off-host` now requires `backup_offload_provider_kms_proof` and `backup_offload_provider_retention_proof` in addition to the operator KMS/retention metadata rows.
- This closes the false-green where operator-supplied KMS and retention fields alone could satisfy production off-host evidence. At this wave it did not audit KMS key policy, bucket policy, lifecycle rules, cross-account access, provider durability, scheduler execution, alert delivery, or recurring restore drills; Wave 077 later adds a summary-only provider security audit evidence gate for the policy and cross-account restore portions.

### Wave 072 - observability apply proof contract

- `npm run observability:evidence` now requires a separate `observabilityApplyProof` section instead of accepting only alert-delivery and dashboard flags as proof that monitoring assets were applied.
- The apply proof must use `siteflow.observabilityApplyProof.v1`, be fresh, have status `applied` or `passed`, include `evidenceSource`, `operator`, and `ticket`, and reference a `siteflow.observabilityProvisioning.v1` plan.
- The checker now requires applied asset hashes for `prometheus_scrape`, `prometheus_rules`, `alertmanager_route`, and `grafana_dashboard` to match `observabilityProvisioning.renderedAssets`.
- `observability:evidence:collect`, `release:evidence`, and `release:evidence:gaps` consume the same selected evidence and required check names, so shallow observability checker output cannot satisfy release bundles.
- This closes the false-green where a release could pass observability evidence with only `--alert-delivered` and `--dashboard-uid`. It still does not automatically apply Prometheus, Alertmanager, or Grafana configuration, call provider APIs, prove alert delivery, ship logs, or aggregate multi-instance metrics.

### Wave 073 - observability release and target binding

- `observability:evidence:collect` now accepts `--commit-ref`, `--repo`, `--branch`, and `--target-environment`, writes them into raw observability evidence, and passes the same expected values to `observability:evidence` when `--check-output` is used.
- `observability:evidence` now emits `release_identity` and `target_environment` checks whenever release or target metadata is present or expected, and its `selectedEvidence` includes the selected commit, repository, branch, and target environment.
- `release:evidence`, `release:evidence:gaps`, and `release:evidence:compose` now require observability checker output to be bound to the release identity, and release bundle checks require the observability target environment to match the bundle.
- `release:evidence:rehearsal-pack` now generates the observability collector command with release identity and target-environment flags, and its operator checklist calls out `observabilityProvisioning` plus `observabilityApplyProof` input requirements.
- This closes the false-green where old or cross-environment observability evidence could be attached to a release through wrapper metadata alone. It still does not call Prometheus, Alertmanager, or Grafana APIs to prove target-stack state.

### Wave 074 - backup automation run history cadence evidence

- `backup:automation` now accepts `--run-history <file>` and appends a bounded, secret-free `siteflow.backupAutomationRunHistory.v1` summary after writing the latest run record.
- The history records recent run status, timestamps, key evidence paths, completed steps, restore-drill completion, backup checker status, operator, and ticket metadata without storing database URLs or raw secrets.
- `observability:evidence:collect --backup-automation-history <file>` now merges that history into release-bound observability evidence.
- `observability:evidence`, `release:evidence`, and `release:evidence:gaps` now require history rows proving the latest run matches the selected `backupAutomationRun`, the latest run succeeded, at least 2 successful restore drills exist, adjacent successful drills stay inside the recorded cadence window, and counted runs have passed backup checker output.
- `release:evidence:rehearsal-pack` now includes a backup automation history path and passes it to the observability collector.
- This closes the false-green where only the latest backup automation run could satisfy observability evidence without proving recurring restore-drill cadence. It still does not create a SiteFlow-managed scheduler, clean disposable drill targets, or prove alert delivery through the target observability stack.

### Wave 075 - off-host fetch and target observability stack proof

- `siteflow backup fetch` now retrieves S3 off-host backups back into an isolated local backup directory, verifies remote object count and byte count, verifies the downloaded tree checksum against offload evidence, and runs static backup verification on the fetched copy.
- `backup:automation` now fetches S3 offload output before the restore drill, uses the fetched backup path for the drill, and passes `backupFetch` into composed backup evidence.
- `backup:evidence --require-off-host`, `release:evidence`, and `release:evidence:gaps` now require backup fetch evidence and a `restore_drill_from_fetched_backup` row, closing the false-green where a local backup could be restored while only the upload was proven off-host.
- `observability:evidence:collect` can fetch `observabilityTargetStackProof` from a target-stack API using `--target-stack-api-url` and a token env var, while keeping the token out of serialized evidence.
- `observability:evidence`, `release:evidence`, and `release:evidence:gaps` now require target-stack proof for Prometheus rules, Grafana dashboard metric coverage, Alertmanager receiver delivery, release identity, and target environment.
- `release:evidence:gaps` now compares final-check rows against the currently recomputed release bundle check rows, so stale copied final-check JSON cannot satisfy a rehearsal pack.
- This tightens off-host DR and observability evidence, but it still does not create a SiteFlow-managed backup scheduler, provision Prometheus/Alertmanager/Grafana, or configure log shipping. Wave 077 later adds a summary-only evidence gate for KMS key policy, bucket policy, and cross-account recovery proof, while the actual provider audit remains externally executed.

### Wave 076 - backup scheduler ownership evidence

- `observability:evidence:collect` now accepts `--backup-scheduler-ownership <file>` and merges `siteflow.backupSchedulerOwnership.v1` evidence into release-bound observability evidence.
- `observability:evidence` now requires scheduler ownership proof with fresh `applied` or `passed` status, target-environment binding, proof source/operator/ticket, enabled scheduler kind/id, schedule/timezone, a command pointing at `backup:automation`, owner plus alert/escalation target, and run record/history links matching the selected backup automation evidence.
- `release:evidence:rehearsal-pack` now creates a `backup-scheduler-ownership.json` evidence path and passes it to the observability collector, and the pack contract requires that command flag.
- `release:evidence` and `release:evidence:gaps` now require selected `backupSchedulerOwnership` evidence and the scheduler ownership checker rows, so a release cannot pass with backup run history alone.
- This closes the false-green where repeated backup runs proved cadence but not scheduler ownership. SiteFlow still does not install, enable, or monitor cron/systemd/orchestrator schedules by itself.

### Wave 077 - backup provider security audit evidence

- `backup:evidence:compose` now accepts `--provider-security-audit <file>` and requires it whenever `--require-off-host` is used.
- `backup:evidence --require-off-host` now requires summary-only provider audit evidence for KMS key policy, bucket policy, lifecycle/versioning controls, cross-account restore access, and a cross-account restore drill.
- The provider audit checker rejects raw policy documents, AWS CLI stdout/stderr, credentials, tokens, presigned URLs, database URLs, private keys, authorization material, cookies, and other secret-bearing material.
- `backup:automation` can pass externally collected provider audit summary evidence into the composed backup checker output, and release rehearsal packs now include a `backup-provider-security-audit.json` path in the backup evidence step.
- `release:evidence`, `release:evidence:gaps`, and `upgrade-rollback:evidence` now inherit this stricter backup posture through the backup checker output, including selected `backupProviderSecurityAudit` evidence.
- This closes the false-green where S3 upload/fetch and sampled Object Lock proof could pass without independent provider security posture evidence. SiteFlow still does not generate the cloud-provider audit itself or configure provider policies.

### Wave 078 - server-side release evidence enforcement

- Production promotion, production rolling `start` / `advance` / `complete`, and production prebuilt deployment upload now require a full release evidence bundle request instead of trusting client-supplied metadata.
- The HTTP server accepts either the raw bundle or an envelope with `evidencePath` plus `bundle` / `evidence`, evaluates it with the same release evidence bundle checker used by the CLI, and requires `targetEnvironment: production`.
- After the checker passes, the server stores only normalized release evidence metadata on route revisions and deployment records. Raw bundle material remains request-time evidence and is not persisted by these mutation paths.
- Metadata-only production requests are rejected, which closes the false-green where a caller could bypass the release bundle checker by posting `status: passed` fields directly.
- At this wave, the browser release console still did not provide a production release evidence input flow; Wave 079 adds the minimum bundle envelope path.

### Wave 079 - browser and npm evidence command closure

- The production release console now includes a production-only release evidence gate. Operators must provide an evidence path plus release evidence bundle JSON before the promote command can be submitted from the browser UI.
- Browser promotion requests send the same `{ evidencePath, bundle }` envelope as the CLI, so the server-side release evidence checker remains the enforcement point and the browser does not persist raw evidence after the request.
- Release and rolling API client command types now accept either stored release evidence metadata or a bundle request envelope, while the server repository layer rejects unnormalized bundle requests before persistence.
- Evidence-related npm scripts now compile `scripts/*.ts` into a temporary directory and execute the emitted JavaScript through `scripts/runCompiledScript.mjs` instead of relying on Node to run TypeScript source with mixed `.ts` and `.js` relative imports.
- The temporary compile output is removed after each command, so documented evidence commands do not leave a `dist-scripts` directory that dirties the release checkout.
- The release preflight workflow writes generated evidence and the decoded target env file under the GitHub runner temp directory instead of a repository-local `evidence/` path before the promotion release gate runs, preserving the clean-worktree check.
- This closes the immediate production workflow break where documented commands such as `npm run --silent release:evidence -- --help` could fail before reaching the checker because source-time ESM imports could not resolve.

### Wave 080 - build artifact output hard limits

- Build artifact publishing now enforces `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES` and `SITEFLOW_BUILD_MAX_ARTIFACT_FILES`, defaulting to 512 MiB and 20000 files.
- The publisher stats static output and function sources before reading file contents, then rechecks the final budget after generated `.br` and `.gz` variants are added.
- Worker runtime config and Docker build rehearsal both pass the same limits into the publish path.
- Docker build rehearsal evidence now records `artifactLimits`, and release bundle plus gap checks require the published artifact byte and file counts to fit within those recorded limits.
- This reduces memory and disk exposure from oversized build outputs. It does not replace container filesystem quotas, host disk quotas, artifact retention cleanup, or runtime sandbox hardening.

### Wave 081 - operator session rotation

- Added `POST /api/auth/session/rotate` for current-cookie session rotation. The route requires a valid `siteflow_session` cookie plus `X-SiteFlow-CSRF: same-origin`; Bearer-only requests cannot rotate a cookie session.
- Postgres rotation runs in a transaction: it locks the old active session, enforces absolute TTL, idle timeout, and cutoff checks, revokes the old token, inserts a new token with the same subject, actor, scopes, project scope, and expiry, then returns only session metadata while the new secret is set through `Set-Cookie`.
- The HTTP path rejects the old cookie after rotation and keeps raw session secrets and token hashes out of JSON responses.
- `operator-access:evidence`, `release:evidence`, and `release:evidence:gaps` now require selected session rotation evidence and passed checks for rotated cookie flags, secret-free response, CSRF enforcement, and old-cookie rejection.
- This closes the minimum operator session rotation workflow. It does not implement full login UI, IdP/MFA, credentialed CORS, or automated non-session credential rotation.

### Wave 082 - multi-provider signed git webhooks

- The git webhook endpoint now supports `/api/webhooks/git/github`, `/gitlab`, `/gitea`, and `/generic`.
- GitHub keeps `X-Hub-Signature-256`; GitLab uses Standard Webhooks `webhook-id`, `webhook-timestamp`, and `webhook-signature` with `whsec_` signing-token decoding and timestamp freshness checks; Gitea uses `X-Gitea-Signature` or compatible `X-Hub-Signature-256`; generic SiteFlow webhooks use `X-SiteFlow-Delivery`, `X-SiteFlow-Event`, and `X-SiteFlow-Signature`.
- Provider payloads are normalized into bounded `SourceEventInput` shapes for push and pull/merge request events. Repository clone metadata is required in `repository.providerPayload.remoteUrl` for worker checkout, and existing project repository metadata is refreshed from signed webhook payloads before queueing builds.
- The server reads `SITEFLOW_GITHUB_WEBHOOK_SECRET`, `SITEFLOW_GITLAB_WEBHOOK_SECRET`, `SITEFLOW_GITEA_WEBHOOK_SECRET`, and `SITEFLOW_GENERIC_WEBHOOK_SECRET`; missing provider secrets fail closed with `503`, and bad signatures fail before repository ingest.
- This closes the basic signed webhook adapter gap for supported providers. Full production source provenance still needs target-provider evidence, release provenance checks, deploy-key rotation, and provider-specific operational runbooks.

### Wave 083 - source provider evidence gate

- Added `npm run source-provider:evidence` with `source-provenance:evidence` as an alias. The checker validates non-dry-run source provider evidence for release identity, target environment, provider support, repository/remote binding, exact commit checkout, remote URL hygiene, signed webhook delivery, webhook secret hygiene, private repo deploy-key policy, SSH host-key policy, release provenance recording, redaction, operator, and ticket metadata.
- Added `npm run source-provider:evidence:template` as a blocking dry-run manual evidence skeleton for source-provider checkout, webhook, deploy-key, host-key, and provenance proof. The template output is not production evidence until every `todo` / `null` field is replaced with real target or target-equivalent observations and the checker passes.
- Release evidence rehearsal packs now include a `source_provider_evidence` step and final compose command input. The pack contract validates both the step and final compose semantics so a generated pack cannot silently omit the source provider evidence file.
- `release:evidence:compose` attaches `sourceProviderEvidence`, `release:evidence` blocks bundles that omit it or include shallow/spoofed/stale/target-mismatched checker output, and `release:evidence:gaps` reports source-provider-specific diagnostics before final bundle composition.
- This closes the first-class source provider evidence gate. Full production still needs the operator to collect real target-provider checkout/webhook/deploy-key/host-key/provenance evidence for the exact release commit, plus deploy-key and webhook-secret rotation runbooks.

### Wave 084 - ingress topology limiter release gate

- `release:evidence` now requires ingress checker output to include `selectedEvidence.deploymentTopology` or `selectedEvidence.topology` with API instance/process and ingress counts, or explicit `multiInstance`, `multiProcess`, or `multiIngress` flags.
- If that topology declares multiple API instances, multiple API processes, or multiple ingress paths, the attached API rate-limit evidence must prove `edgeEnforced` or `sharedAcrossInstances`. A process-local-only or in-memory limiter no longer satisfies the release bundle.
- `npm run ingress:operator-evidence:template` provides a blocking dry-run manual evidence skeleton for forwarded-header cleanup, proxy final-hop policy, deployment topology, and edge/shared limiter proof. The template output is not production evidence until every `todo` / `null` field is replaced with real target observations and `ingress:evidence:collect` or `ingress:evidence` produces passed checker output.
- `release:evidence:gaps` reports the same `ingress_deployment_topology` and `ingress_rate_limit_topology` diagnostics before final bundle composition, so old shallow ingress checker output cannot hide a multi-instance limiter gap until the final check.
- This is still an evidence gate. SiteFlow does not configure multi-ingress load balancers or a distributed limiter by itself.

### Wave 085 - operator access evidence template handoff

- `release:evidence:rehearsal-pack` now includes the matching `operator-access:evidence:template` command in the operator access step prompts, writing the raw operator access evidence template to the same release-bound path consumed by `operator-access:evidence`.
- The template remains intentionally non-passing with `status: "blocked"`, `dryRun: true`, and `template: true`, so a generated placeholder cannot satisfy the operator access checker or final release bundle until operators replace the placeholders with target evidence.
- This improves the operator handoff only. It does not collect operator access evidence, create sessions, prove IdP/MFA, or replace the final operator access checker output.

### Wave 086 - non-session credential evidence template

- Added `npm run non-session-credential:evidence:template` to generate a raw non-session credential evidence template with release identity, supported credential-type skeletons, break-glass controls, no-raw-archive flags, and no automatic-rotation claim.
- The template is intentionally blocked and dry-run (`status: "blocked"`, `dryRun: true`, `template: true`), so it cannot satisfy `non-session-credential:evidence` or the final release bundle until operators replace the placeholders with real target or target-equivalent evidence.
- This is a handoff aid only. It does not rotate credentials, reload consumers, collect provider proof, or archive any raw secret values.

### Wave 087 - upgrade/rollback evidence template handoff

- Added `npm run upgrade-rollback:evidence:template` to generate a raw upgrade/rollback drill evidence template with release identity, version pair fields, API and worker image digest placeholders, migration compatibility placeholders, backup evidence, operations, route state, readiness, observability, operator, and ticket skeletons.
- `release:evidence:rehearsal-pack` now prints matching non-session credential and upgrade/rollback template commands alongside the operator access template command, each writing to the same release-bound raw evidence path consumed by its checker.
- These templates remain intentionally blocked and dry-run. They improve operator handoff only; they do not rotate credentials, execute an upgrade, execute rollback, collect target evidence, or replace the final checker outputs.

### Wave 088 - preflight gap alignment and commit readiness planning

- `release:evidence:target-run` now passes the same `--set` replacements into every gap snapshot that it applies to command execution, so archived snapshots no longer report already-supplied structured command placeholders as input gaps.
- The `Release Preflight` workflow now passes the release image run id, direct API URL, trust proxy policy, topology counts, and rate-limit topology replacements into its final standalone `release:evidence:gaps` artifact. The static release gate checks for these terms so the workflow cannot silently regress to placeholder-only gap reports.
- `release:evidence:compose` now rejects source provider, operator access, non-session credential, ingress, and upgrade/rollback inputs that are still templates, dry-run output, or `blocked` / `todo`, preventing a weak `status: "composed"` result around placeholder evidence. Final `release:evidence` remains the promotion gate.
- Added `npm run release:commit:plan` as a read-only release commit readiness plan. It combines forbidden tracked release-source paths with production-critical untracked files and suggests explicit staging groups without running `git add`, `git rm`, or any cleanup. This helps operators prepare the release commit after a reviewed source cleanup while still avoiding `git add .`.

### Wave 089 - final evidence status and commit plan source coverage

- Raw source provider, operator access, non-session credential, ingress, and upgrade/rollback evidence checkers now expose a `not_template` row and a strict `status_final` row. `status_final` requires top-level `status: "passed"` for final production evidence, while older status aliases remain non-final diagnostics only.
- Final release bundle and gap-report diagnostics now require `not_template` and `status_final` rows from those evidence checker outputs, so copied or fabricated checker JSON that omits the final-status checks is blocked before promotion.
- `ingress:evidence:collect` rejects `--operator-evidence` files that are still templates, dry-run artifacts, or top-level `blocked` / `todo` records before merging them with active target probes.
- The release source policy now explicitly allows `.env.example` as the non-secret environment template while continuing to block `.env` and real `.env.*` files.
- `release:commit:plan` now reports non-forbidden tracked dirty source files in `trackedDirtySource` and adds explicit staging groups for them, closing the gap where only critical untracked production files were surfaced.

### Wave 090 - artifact retention apply guardrail

- Added `npm run release:artifact-retention:apply` for applying a reviewed artifact retention plan.
- The apply command accepts only a passed `siteflow-artifact-retention-plan`, revalidates that every delete candidate stays inside the plan artifact root, rejects the artifact root itself, and blocks active-route or explicitly protected candidates.
- The command defaults to dry-run and requires `--yes` before deleting any plan `deleteCandidates`.
- Apply output is machine-readable evidence with planned, deleted, skipped, checks, warnings, and dry-run status.
- This closes the missing reviewed executor path for local artifact pruning. It still does not provide recurring scheduling, target alert delivery, automatic rollback for deleted artifacts, or target-environment cleanup evidence.

### Wave 091 - production function artifact release gate

- Release evidence bundle checks now reject release artifact manifests that declare functions requiring `same_process` runtime isolation, even when a trusted exception field is present in the bundle.
- Release evidence gap reports now point operators toward isolated function runner evidence instead of suggesting a trusted exception field.
- Production HTTP runtime still fails closed by default for same-process functions; the emergency runtime env switch is no longer a production release evidence path for shipping function artifacts.
- This closes the false-green where a production bundle could accept function artifacts without an isolated runner. Wave 091 only added the release gate; a later server runtime change added the first `isolated_process` execution path.

### Wave 092 - Docker build image tag exception hardening

- Production Docker build image policy now defaults to digest-only at worker startup, release gate, Docker rehearsal, release bundle, and gap-report layers.
- Tagged build images require both a matching `SITEFLOW_BUILD_IMAGE_ALLOWLIST` entry and explicit `SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1` acceptance.
- Docker rehearsal evidence now records `imageTaggedTrustedExceptionAccepted`, and release evidence rejects allowlisted image tags when that exception is absent.
- This reduces false confidence around mutable build images. It does not provide image provenance, signing verification, SBOM, or dependency/cache policy enforcement.

### Wave 093 - browser token fallback default-off posture

- Browser runtime config now disables `sessionStorage` API token fallback by default in production.
- Non-production HTTP clients keep the transition fallback for local workflows, and the production runtime can only enable it with explicit `VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK=1`; Wave 094 makes that enabled posture non-production-passing for promotion evidence.
- The HTTP client factory now omits the browser token provider when `browserTokenFallbackEnabled` is false, so a production bundle with a normal API URL does not read `siteflow.apiToken` from browser storage.
- This reduces operator token exposure in production browsers. It does not replace full login, IdP, MFA, credentialed-CORS, or automated credential rotation.

### Wave 094 - browser fallback evidence gate and workspace cleanup

- `siteflow release-gate --promotion` now records `VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK` posture in promotion evidence and fails production runtime env validation when the flag is enabled.
- Operator-access raw evidence templates and checks now require browser token fallback posture evidence, including proof that `localStorage` token fallback is disabled and any transition exception is documented.
- The final release evidence bundle and gap report now reject old or incomplete evidence that omits browser fallback posture, and they block bundles whose release-gate runtime evidence shows browser token fallback enabled.
- Local and Git source checkout paths now clean their job workspace when copy, clone, fetch, or checkout fails. The build worker also cleans the temporary workspace root it creates internally while preserving caller-provided workspace roots.
- This wave reduces browser-token and workspace-residue risk, but it does not make the repo production-ready: the current Git index still tracks forbidden release-source roots, and target-environment release evidence is still required.

### Wave 095 - build storage preflight

- Build jobs now run a storage preflight before source checkout. The preflight checks workspace, artifact, and temp roots and fails fast when any checked filesystem has fewer available bytes than `SITEFLOW_BUILD_MIN_FREE_BYTES`.
- Worker runtime config defaults `SITEFLOW_BUILD_MIN_FREE_BYTES` to 2x `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES`, while production promotion evidence requires it to be explicitly configured.
- `siteflow release-gate --promotion`, the final release bundle checker, and the gap report now reject old or incomplete evidence that omits the build storage preflight threshold.
- This reduces partial-checkout and partial-build residue under low disk pressure. It does not replace container writable-layer quotas, host disk alerting, recurring cleanup, or target-profile rehearsal evidence.

### Wave 096 - networked build secret egress guard

- Docker source builds with `SITEFLOW_BUILD_NETWORK=bridge` now fail before build commands when the merged build environment contains sensitive keys such as secrets, tokens, passwords, private keys, API keys, or auth values. The error reports key names only, never values.
- Docker build rehearsal now treats `SITEFLOW_BUILD_NETWORK=bridge` as a blocking prerequisite, so target-run cannot execute a production Docker rehearsal with network egress enabled.
- Public-prefixed build env keys such as `NEXT_PUBLIC_*`, `VITE_*`, and `PUBLIC_*` remain allowed by this guard, while artifact publishing still scans sensitive env values before accepting build output.
- This reduces the highest-risk `network egress + secret env` combination. It does not replace complete egress policy, dependency allowlisting, or generic secret scanning of all generated artifacts.

### Wave 097 - release artifact evidence leak guard

- Release artifact evidence no longer stores raw `npm pack`, dependency policy, or production audit output when command output contains secret-like values. The check records redacted previews plus reason labels instead of archiving the raw stdout or stderr text.
- Release artifact content scanning now reuses the generic evidence secret scanner in addition to SiteFlow-specific canary and fixture patterns, so JSON credential fields, provider tokens, URL credentials, private keys, JWT-like strings, npm tokens, AWS access keys, and similar generated-asset leaks block `release:artifacts:check`.
- Release artifact topology checks now fail on source maps that embed `sourcesContent`, source maps with absolute/escaping/env/cache source paths, symlinked or non-regular artifact entries, and npm pack paths that escape the package root. npm pack backslash paths are normalized before allowlist checks.
- The build artifact publisher now rejects source maps with embedded `sourcesContent`, unsafe source-map source paths, symlinked or non-regular output entries, symlinked function artifact sources, and `vercel.json` function `includeFiles` that resolve through symlinks before a deployment directory is created.
- This reduces release evidence and built-asset leakage risk. It does not replace full worker output-root realpath policy, dependency allowlisting, or a source map policy in every external build pipeline.

### Wave 098 - Docker build env-file cleanup hardening

- Docker build runner config is validated before any secret-bearing env-file is created, so invalid Docker image references fail without writing build environment values to disk.
- Docker env-file cleanup is now covered for successful runs, Docker spawn failures, unavailable child stdio, and Docker build timeouts. Timeout cleanup also removes the env-file after using the cidfile to attempt container cleanup.
- Docker timeout cleanup commands have a bounded timeout and are best-effort, so a hung `docker kill` or `docker rm -f` process cannot prevent the original build timeout from rejecting.
- This reduces build secret residue risk on the worker host. It does not replace host-level temp directory monitoring, disk forensics, or target-profile evidence that the worker runtime is configured with isolated temp storage.

### Wave 099 - production compose and artifact publish/rehearsal hardening

- Added `docker-compose.production.yml` as an audited trusted single-host production profile. The API service runs as `1000:1000`, uses a read-only filesystem, drops Linux capabilities, sets `no-new-privileges`, and does not mount the Docker socket.
- The production profile keeps the worker on the trusted Docker socket path and makes that residual risk explicit through `SITEFLOW_WORKER_USER`, `SITEFLOW_DOCKER_SOCKET_GID`, and `docs/deployment/production-single-host.md`.
- `siteflow release-gate` now includes a static `local.productionCompose` check so the committed production Compose profile and its deployment doc cannot silently disappear from a release candidate.
- Build artifact publishing now writes into a `.publish-*` staging directory, rechecks deployment target collisions before publish, atomically renames the complete staging directory into place, and removes staging output on publish failure.
- Docker build rehearsal now uses a locked local `file:` dependency fixture instead of a no-dependency source project, records fixture dependency and lockfile posture, and fails when the dependency-install proof is missing from the build output.
- `release:commit:plan` treats `docker-compose.production.yml` and `docs/deployment/production-single-host.md` as critical release commit inputs.
- This wave still does not prove target deployment. The local machine used for this audit did not have Docker CLI available, so `docker compose -f docker-compose.production.yml config`, startup, restart, readiness, and target Docker build rehearsal evidence remain required before production promotion.

## CI and release surface

- `.github/workflows/ci.yml` is the current minimum CI gate. It checks dependency installation, unit/integration tests, the production build command, and Playwright E2E safeguards.
- `.github/workflows/release-preflight.yml` is a manual preflight workflow for release operators. It is not a deployment workflow and does not replace target evidence, but it archives promotion release-gate evidence, the release evidence rehearsal pack, the gap report, and Playwright artifacts for the exact release commit.
- `siteflow release-gate` is the local release gate. It statically checks the production Compose profile and deployment doc, but target `docker compose config` and startup smoke evidence remain external. Without `--allow-manual-branch-protection`, it exits non-zero when GitHub branch protection cannot be verified.
- `npm run release:commit:plan -- --fail-on-blocked` can be used in CI or release-preflight automation to make dirty/untracked release-readiness state fail by exit code. Without that flag it remains a read-only advisory report for local planning.
- Use `siteflow release-gate --promotion --env-file <target-env-file> --repo <owner/repo> --branch main --commit-ref <sha> --require-commit-status` before a real promotion to validate runtime env, GitHub branch protection, and exact commit CI evidence. Pass `--required-status-check <name>` only when the protected GitHub status check name differs from the default CI job.
- Release preflight should provide `SITEFLOW_RELEASE_GITHUB_TOKEN` when the default `github.token` cannot read branch protection or exact commit check-run evidence. Use a repository-scoped GitHub App token or fine-grained PAT with read access for branch protection settings and checks evidence; do not store that token in the target env file.
- `--allow-manual-branch-protection` is only for no-secret static sanity checks. It is intentionally ignored by `--promotion`.
- `--allow-dirty` is also only for no-secret static sanity checks. `siteflow release-gate --promotion` always requires a clean worktree so the gate output matches the release bundle checker.
- Promotion runtime env evidence includes browser token fallback, build storage preflight, Docker runner, and image policy posture. Do not promote with `VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK=1`; the production release gate requires it to be unset or false. Set `SITEFLOW_BUILD_MIN_FREE_BYTES` to a target-appropriate threshold before promotion. Do not promote with default mutable runtime, Postgres, or build image tags: set `SITEFLOW_IMAGE`, `SITEFLOW_POSTGRES_IMAGE`, and `SITEFLOW_BUILD_IMAGE` to digests. A tagged build image requires both an exact/prefix `SITEFLOW_BUILD_IMAGE_ALLOWLIST` match and `SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1`.
- Production Docker worker startup enforces the same image posture, so a target environment that omits `SITEFLOW_BUILD_IMAGE` or uses an unconstrained mutable tag should fail before processing source builds.
- Generate a target release evidence rehearsal pack before the promotion window with `npm run --silent release:evidence:rehearsal-pack -- --commit-ref <sha> --repo <owner/repo> --branch main --target-env-file <target-env-file> --public-base-url <https-url> --operator-name <operator> --release-ticket <ticket> --docker-socket-profile-accepted --output-dir <evidence-dir>`. Pass `--docker-socket-profile-accepted` only after the release owner records acceptance of the trusted single-host Docker socket worker profile. Use the generated Markdown as the operator checklist for the real evidence run; its operator access, non-session credential, and upgrade/rollback sections include matching template commands for creating non-passing raw evidence templates before operators fill in real target observations.
- During the evidence run, use `npm run --silent release:evidence:target-run -- --pack <evidence-dir>/release-evidence-rehearsal-pack.json --confirm-target-environment production --set direct-api-url=<direct-api-health-url> --set release-image-run-id=<github-actions-run-id> --set SITEFLOW_TRUST_PROXY=<trust-proxy-policy> --set api-instance-count=<count> --set api-process-count=<count> --set ingress-count=<count> --set api-rate-limit-scope=<edge|shared|global|distributed|process_local> --set api-rate-limit-enforcement-point=<edge|proxy|load_balancer|gateway|ingress|cdn|api> --json` to execute pack commands and archive gap snapshots, or add `--plan-only` to the same target-run command first to validate placeholders, required environment variable names, and command executability without running target commands or producing production evidence. Use `npm run --silent release:evidence:gaps -- --pack <evidence-dir>/release-evidence-rehearsal-pack.json --set direct-api-url=<direct-api-health-url> --set release-image-run-id=<github-actions-run-id> --set SITEFLOW_TRUST_PROXY=<trust-proxy-policy> --set api-instance-count=<count> --set api-process-count=<count> --set ingress-count=<count> --set api-rate-limit-scope=<edge|shared|global|distributed|process_local> --set api-rate-limit-enforcement-point=<edge|proxy|load_balancer|gateway|ingress|cdn|api> --json` as a read-only placeholder preflight. These commands first validate that the pack command semantics still match the generated contract, and none stores or prints `--set` replacement values. Before final bundle composition, the gap report is expected to show missing final bundle and final check outputs while helping operators clear target evidence outputs and immediate input gaps. After compose and final check complete, the final gap report or target-run final snapshot must have no missing, stale, manual-required, dry-run-only, failed, identity-mismatched, blocked, or invalid items. Neither target-run, target-run plan-only, nor gaps is a promotion gate by itself.
- After collecting promotion, Docker build rehearsal, Postgres rehearsal, release artifact, release image, source provider, backup, observability, operator access, non-session credential, ingress, and upgrade/rollback drill outputs, run `npm run --silent release:evidence:compose -- --release-gate <release-gate.json> --docker-build <docker-build.json> --postgres-rehearsal <postgres.json> --artifact-evidence <release-artifact-evidence.json> --release-image-evidence <release-image-evidence.json> --source-provider-evidence <source-provider-evidence.json> --backup-evidence <backup.json> --observability-evidence <observability.json> --operator-access-evidence <operator-access.json> --non-session-credential-evidence <non-session-credential.json> --ingress-evidence <ingress.json> --upgrade-rollback-evidence <upgrade-rollback.json> --target-environment production --operator-name <operator> --release-ticket <ticket> --docker-socket-profile-accepted --output <release-evidence.json>`, then run `npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` as the combined promotion evidence check. The raw release-gate JSON must include fresh `checkedAt` values from `siteflow release-gate --promotion --json`; repackaging old release-gate output under a new bundle wrapper is rejected. The generated pack includes `--docker-socket-profile-accepted` only when the pack generator was invoked with that explicit flag. Use `--host-build-exception-accepted` only when the release gate records a deliberate trusted-source host-build exception. Mutating CLI production promotion commands, including production rolling `start`, `advance`, and `complete`, must include the same bundle path with `--release-evidence <release-evidence.json>`; the server re-runs the release evidence checker on the submitted bundle before it stores normalized metadata.
- This is not a full release pipeline. It does not publish Docker images, execute target Docker Compose output, run dependency/license/security scans, create SBOMs, provision a target database, choose a safe `TEST_DATABASE_URL`, or deploy. `release:evidence:target-run` can invoke the generated Postgres rehearsal command only after the operator supplies the target or disposable database environment.
- The CI file alone does not protect `main`. Repository branch protection must require the CI job before merges for this to be an actual merge gate, and `siteflow release-gate` should verify that setting with a GitHub token when possible.
- Do not promote a commit unless CI is green on that exact commit and the external launch checklist below is complete.

## Current production scope

- Supported topology: single-host control plane with bundled Postgres, local artifact storage, Docker Compose, and optional managed Nginx.
- A committed `docker-compose.production.yml` provides a reviewed single-host profile for operators who want a static Compose baseline instead of generated installer output. It is still a trusted-operator profile and must be validated on the target host.
- Secret sealing now fails fast when `NODE_ENV=production` or `SITEFLOW_ENV=production` and neither `SITEFLOW_APP_SECRET` nor `SITEFLOW_SEALING_KEY` is configured.
- New installs should use `SITEFLOW_APP_SECRET`. `SITEFLOW_SEALING_KEY` remains accepted for legacy compatibility.
- Installer-generated Compose mounts `/etc/siteflow/secrets/app-secret.secret` as a Docker secret and exports it as `SITEFLOW_APP_SECRET` before starting API and worker processes.
- Installer-generated Compose starts the worker with `SITEFLOW_BUILD_RUNNER=docker`, `SITEFLOW_BUILD_NETWORK=none`, a host-visible `TMPDIR`, and `/var/run/docker.sock` mounted for access to the host Docker daemon.
- The generated Docker socket profile is restricted to trusted single-host operation. Treat the worker container as having host Docker control; do not use this as a multi-tenant sandbox.
- Installer secret files are generated with `0600` permissions, and existing secret files are reused with permissions tightened back to `0600`.
- Production browser bundles must not embed `VITE_SITEFLOW_API_TOKEN`; Vite build now fails before bundling if that variable or fixture controls are present. The control plane now has a minimum HttpOnly operator session API whose create and rotate responses no longer return raw session secrets in JSON, whose Postgres-backed sessions enforce a server-side idle timeout, whose current-cookie rotate path revokes the old cookie server-side, and whose Bearer-only emergency cutoff can revoke existing operator sessions globally or by project. The browser client ignores `localStorage` and disables the `sessionStorage` key `siteflow.apiToken` fallback in production by default; production promotion evidence requires `VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK` to be unset or false.

## Required production environment

Set one of:

- `SITEFLOW_ENV=production`
- `NODE_ENV=production`

Set all required runtime values:

- `DATABASE_URL`
- `SITEFLOW_API_PORT`
- `SITEFLOW_ARTIFACT_ROOT`
- `SITEFLOW_PUBLIC_SCHEME`
- `SITEFLOW_APP_SECRET` or `SITEFLOW_SEALING_KEY`, with `SITEFLOW_APP_SECRET` preferred. Production values must be at least 32 non-placeholder characters.
- `SITEFLOW_API_TOKEN` for protected API/CLI access. Production values must be at least 32 non-placeholder characters.
- `SITEFLOW_BASE_DOMAIN` when preview route publication is enabled.

Recommended production values:

- `SITEFLOW_ALLOWED_ORIGIN`
- `SITEFLOW_TRUST_PROXY` only when the API is reachable exclusively through a trusted ingress that overwrites `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`. Use `loopback` for same-host Nginx, `private` for private-network ingress, or comma-separated IP/CIDR entries for explicit proxy sources. Keep it unset or false for direct API exposure.
- `SITEFLOW_METRICS_TOKEN` for authenticated `/metrics` scrapes. Production values must be at least 32 non-placeholder characters.
- `SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1` only when the metrics endpoint is protected by a documented private scrape path or reverse-proxy allowlist and the residual risk is accepted.
- `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD` pointing at the latest stable `backup:automation --run-record` JSON file when backup automation gauges are expected from `/metrics`.
- `SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS` when the default 1800-second operator session idle window does not match the target access policy. Values must be integers from 60 to 86400.
- `SITEFLOW_GITHUB_WEBHOOK_SECRET`, `SITEFLOW_GITLAB_WEBHOOK_SECRET`, `SITEFLOW_GITEA_WEBHOOK_SECRET`, and/or `SITEFLOW_GENERIC_WEBHOOK_SECRET` for the signed git webhook providers that are enabled.
- A unique `SITEFLOW_WORKER_ID` for each worker process.
- `SITEFLOW_IMAGE`, pinned to the exact release image digest that will run the API and worker containers.
- `SITEFLOW_POSTGRES_IMAGE`, pinned to the reviewed Postgres image digest used by the single-host profile.
- `SITEFLOW_BUILD_RUNNER=docker` for production source builds. This is the production default, but setting it explicitly documents operator intent.
- `SITEFLOW_BUILD_IMAGE`, pinned to a sha256 digest. Production Docker workers require this value. If an operator intentionally accepts a tagged image, set `SITEFLOW_BUILD_IMAGE_ALLOWLIST` to the exact image or an explicit trusted prefix such as `registry.local/siteflow/*` and set `SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1`.
- `SITEFLOW_BUILD_MEMORY`, `SITEFLOW_BUILD_CPUS`, `SITEFLOW_BUILD_PIDS_LIMIT`, and `SITEFLOW_BUILD_USER` to match the deployment host capacity and file ownership model.
- `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES` and `SITEFLOW_BUILD_MAX_ARTIFACT_FILES` to match the largest expected production build output. Defaults are 536870912 bytes and 20000 files.
- `SITEFLOW_BUILD_MIN_FREE_BYTES` to fail builds before source checkout when workspace, artifact, or temp storage is below the accepted free-space threshold. The worker default is 2x `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES`, but production release-gate evidence requires an explicit value.
- `SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES` and `SITEFLOW_PREBUILT_MAX_FILES` to cap CLI/API prebuilt uploads before they are written to artifact storage. Defaults match the build artifact budget: 536870912 bytes and 20000 files.
- Keep `SITEFLOW_BUILD_NETWORK=none` for production promotion and Docker rehearsal. `SITEFLOW_BUILD_NETWORK=bridge` is allowed only for non-production or explicitly trusted local builds, and Docker source builds reject sensitive build env keys while bridge networking is enabled.
- `SITEFLOW_BUILD_STEP_TIMEOUT_MS` and `SITEFLOW_GIT_TIMEOUT_MS` to match the largest expected build and source checkout durations. Defaults are 900000ms for build steps and 300000ms for Git commands.
- `SITEFLOW_GIT_SSH_KEY_PATH` and optional `SITEFLOW_GIT_KNOWN_HOSTS_PATH` when private repository checkout uses an operator-mounted SSH deploy key.
- Leave `SITEFLOW_TRUSTED_SOURCE_BUILDS` and `SITEFLOW_ALLOW_UNSANDBOXED_BUILDS` unset unless the worker will execute only trusted source builds and the host-build risk is explicitly accepted.
- Leave `SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME` unset in production. Setting it enables artifact functions inside the control-plane API process for local or emergency trusted-operator use only; production release evidence rejects function artifacts that still require same-process runtime isolation.

## Installer behavior

- `siteflow.env` contains non-secret runtime configuration and `SITEFLOW_ENV=production`.
- Compose reads API, Postgres, app, and Git webhook signing secrets from files under `/etc/siteflow/secrets`.
- Compose exports `SITEFLOW_APP_SECRET` from the app secret file before launching `dist-server/server/index.js` and `dist-worker/worker/index.js`.
- Compose sets `SITEFLOW_TRUST_PROXY=loopback` for the installer-managed Nginx profile. The generated Nginx config overwrites forwarded host, proto, and client IP headers before proxying to the API.
- The generated Nginx config applies an edge `limit_req` policy to the control-plane `/api` path and leaves preview/static, readiness, health, and metrics routes unthrottled by that edge policy.
- Compose sets the worker to `SITEFLOW_BUILD_RUNNER=docker`, `SITEFLOW_BUILD_NETWORK=none`, and `TMPDIR=<artifact root>` so Docker bind mounts resolve through a host-visible path.
- Compose mounts `/var/run/docker.sock` into the worker and runs startup checks for the Docker CLI and daemon. If either check fails, the worker exits instead of silently falling back to host builds.
- The socket-mounted worker profile is for trusted single-host operators only and is not a multi-tenant sandbox.
- The non-secret env file must not contain raw tokens, app secrets, database passwords, or webhook signing secrets.
- Do not ship `VITE_SITEFLOW_API_TOKEN` in production frontend builds. Use the operator session API; keep `VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK` unset or false for production promotion.
- Production API runtime disables same-process artifact functions by default. `SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME=1` is not production release evidence and must not be used to publish artifacts that declare functions.

## Remaining P0 gaps

- Build execution now has a minimum Docker runner, command timeouts, explicit private bind-mount propagation, checkout-failure workspace cleanup, internally created temporary workspace cleanup, build storage free-space preflight, sensitive-env rejection for networked Docker builds, an opt-in Docker build rehearsal runner that blocks `bridge` network, uses a locked non-empty dependency fixture, records dependency-install proof, hard publish-time artifact byte/file budgets, atomic staging-directory publish with collision rechecks for worker-built and prebuilt artifacts, staging cleanup on publish failure before promotion, and a publish-time scan that blocks sensitive build env values from entering worker-built artifacts, but it still needs target-profile rehearsal output before promotion and is not complete for untrusted multi-tenant source. The worker path still needs stronger egress controls, container writable-layer and host disk quotas/alerting, image provenance, dependency/cache policy, container runtime hardening, broader secret egress protections, and target cleanup/reaping evidence.
- Artifact functions now fail closed in production unless `SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME=1` is explicitly set, release evidence rejects function artifacts that require same-process runtime isolation, and `isolated_process` function entries now run in a short-lived child process with per-invocation env injection, timeout kill, and redacted stdout/stderr/runtime logs. This is still an MVP: SiteFlow still needs OS/container-level CPU and memory accounting, durable log capture, concurrency controls, publisher defaults that do not silently fall back to `same_process`, and target-environment function evidence before treating artifact functions as production-complete.
- Queue execution now has lease, retry, heartbeat, stale recovery, exhausted-lease failure mechanics, concurrent worker claim rehearsal coverage, bundle-checked release-bound Postgres rehearsal scope, and basic runtime queue gauges, but still needs operator-collected target-environment evidence, dashboard wiring, and alert delivery proof before it is an operational invariant.
- Source provenance now includes exact Git commit checkout, HEAD verification, rejection of URL-embedded credentials, an explicit SSH deploy-key path for private repositories, signed webhook validation for GitHub, GitLab, Gitea, and generic SiteFlow webhook payloads, and a release-bundle-gated source provider evidence checker. It still needs real target-provider execution evidence, deploy-key rotation, webhook-secret rotation, and provider-specific operating runbooks.
- Backup and restore now have a CLI minimum loop plus static checks for manifest, dump, artifact, path safety, content checksums, restore preflight, `psql` fail-fast flags, a restore-drill command with restored artifact integrity and freshness evidence, file-target offload for local/staging rehearsal, S3 offload through the AWS CLI, S3 provider proof for sampled object SSE-KMS/Object Lock and bucket default retention, S3 fetch-back verification, restore-drill-from-fetched-copy gating, retention pruning, evidence-gated schedule/retention/RPO/RTO/age-alert policy, a production off-host evidence contract requiring object storage, KMS, provider retention metadata, provider proof, backup fetch, provider security audit summary, and fetched-copy restore evidence, a composer that can produce raw backup evidence plus checker output for release bundles, a one-shot automation runner suitable for cron/systemd invocation, run-record-backed `/metrics` gauges plus run-history-backed observability evidence checks for backup automation closure and recurring restore-drill cadence, and release-gated backup scheduler ownership evidence for externally managed cron/systemd/orchestrator jobs. They are still not production complete without real target-environment execution evidence, an actually applied target scheduler, alert delivery proof, a SiteFlow-managed scheduler if that is required by the operating model, and target-account provider/security audit execution evidence.
- Migration execution now has advisory transaction locking, checksum drift detection, concurrent API/worker startup rehearsal coverage, opt-in real Postgres rehearsal evidence, and bundle checks for that release-bound evidence scope, but still needs operator-collected target-environment evidence and a drift remediation runbook drill.
- Rollback/upgrade safety now has an evidence checker, release-bundle gate for API, worker, schema, and artifact rollback drills, and transaction-scoped advisory locks for promote/rollback idempotency keys plus project/channel route updates. It still needs real target-environment drill execution, automation, recurring rehearsal, and deeper real-Postgres concurrency coverage for route lineage.
- Production authentication/session hardening is incomplete. API token support, a minimum hashed operator session lifecycle, secret-free session create/rotate responses, production-forced Secure cookies, optional project-scoped operator sessions, server-side idle timeout, same-origin CSRF headers for cookie-authenticated writes and session rotation, server-derived audit actor attribution, Bearer-only global/project operator session emergency cutoff, operator access evidence, and non-session credential evidence gates now exist, but multi-user login, MFA/SSO, credentialed-CORS design, real credential rotation execution, and target-environment access evidence are not a finished production boundary.
- Trusted proxy hardening now prevents direct clients from spoofing forwarded host, proto, or IP headers by default, hardens installer-managed Nginx header forwarding, restricts forwarded-header trust to `loopback`, `private`, or explicit IP/CIDR proxy source policies, adds an installer-managed Nginx edge limiter for the control-plane `/api` path, and gates release evidence on fresh target ingress proof. Full production still needs that evidence collected from the actual topology, may still need hop-count semantics for complex proxy chains, and must prove an equivalent shared or edge limiter for multi-instance or multi-ingress topologies.
- Branch protection is an external P0 release control. The local `siteflow release-gate --promotion` now requires GitHub branch protection and exact commit CI evidence, but repository settings still must actually require that job for `main` and a token with enough GitHub read permissions must be available.

## Remaining P1 gaps

- External Postgres and external object storage modes need documented, tested install paths.
- TLS automation needs full DNS-01 wildcard coverage, renewal verification, and failure rollback.
- Observability now has a structured request log hook, default production NDJSON stdout sink, `/readyz`, process-local `/metrics` for HTTP, queue, and backup automation gauges with optional `SITEFLOW_METRICS_TOKEN` bearer protection, generated Prometheus/Alertmanager/Grafana starter artifacts, an evidence collector for `/readyz`, `/metrics`, backup automation run records, and target-stack API proof, and release-bound evidence checks for expected metric names, target environment, backup automation closure, applied provisioning asset hashes, Prometheus rule presence, Grafana dashboard metric coverage, Alertmanager receiver delivery, alert delivery, and fresh dashboard status. It still needs automated target-stack provisioning/apply lifecycle, log shipping/retention configuration, multi-instance aggregation, disk metrics, Postgres replication metrics, and operator runbooks.
- Secret rotation now has an evidence gate for operator-collected non-session credential rotation and break-glass handling, but SiteFlow still does not automate rotation for `SITEFLOW_APP_SECRET`, API tokens, worker tokens, webhook secrets, deploy keys, deploy hooks, log-drain secrets, or database credentials.
- Disaster recovery objectives now require explicit RPO/RTO targets in evidence, production off-host/prune evidence must include object-storage/provider, KMS, retention-contract proof, S3 provider proof where S3 offload is used, backup fetch evidence, provider security audit summary evidence, and restore from the fetched off-host copy. A one-shot backup automation runner can be scheduled externally for local file-offload rehearsal or S3 offload, and the latest run plus run history plus scheduler ownership proof can feed `/metrics`, observability evidence, and release gates when it completes. Full production still needs real target S3/object-storage execution evidence, applied alert delivery proof, the scheduler actually enabled in the target environment, and external execution of the provider audit workflow.
- CI should expand further to dependency/security scanning, Docker/Compose validation, and release artifact checks.
- Artifact lifecycle cleanup now has a dry-run retention planner, a plan-constrained apply executor that defaults to dry-run and requires `--yes`, and operator runbook coverage. It still needs scheduler/alerting and target-environment cleanup evidence before it can be treated as an operational production invariant.

## Minimum launch checklist

Do not launch until every item below is true for the exact release commit:

- GitHub Actions CI is green for `npm ci`, `npm test -- --run`, `npm run build`, and `npm run test:e2e`.
- `npm run --silent release:evidence:rehearsal-pack -- --commit-ref <sha> --repo <owner/repo> --branch main --target-env-file <target-env-file> --public-base-url <https-url> --operator-name <operator> --release-ticket <ticket> --docker-socket-profile-accepted --output-dir <evidence-dir> --json` has produced the release-bound evidence collection pack used for this launch after explicit trusted Docker socket profile acceptance.
- `siteflow release-gate --promotion --env-file <target-env-file> --repo <owner/repo> --branch main --commit-ref <sha> --require-commit-status` passes with the expected required status check, exact commit evidence, and a clean worktree. `manual_required` or dirty-worktree results are acceptable only for documented no-secret static sanity checks, not for production promotion.
- `main` branch protection requires the expected CI job, currently `Install, test, and build`, before merge.
- Production deployment is restricted to trusted operators and trusted static/prebuilt deployments, or source builds executed through the Docker runner with the remaining sandbox limitations explicitly accepted.
- `SITEFLOW_TRUSTED_SOURCE_BUILDS=1` or `SITEFLOW_ALLOW_UNSANDBOXED_BUILDS=1` is set only when every queued source build is trusted and host execution risk is explicitly accepted.
- Production source-build workers use `SITEFLOW_BUILD_RUNNER=docker` unless the host-build trust exception above is intentionally enabled.
- `SITEFLOW_BUILD_IMAGE` is configured as a sha256 digest, or the configured tag is explicitly constrained by `SITEFLOW_BUILD_IMAGE_ALLOWLIST` and acknowledged with `SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1`; do not rely on the default mutable Docker image tag for promotion.
- `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES`, `SITEFLOW_BUILD_MAX_ARTIFACT_FILES`, `SITEFLOW_BUILD_MIN_FREE_BYTES`, `SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES`, and `SITEFLOW_PREBUILT_MAX_FILES` are configured for the target host capacity, or the documented defaults of 536870912 bytes, 20000 files, and 1073741824 minimum free bytes are explicitly accepted.
- `SITEFLOW_ENV=production` or `NODE_ENV=production` is set.
- `DATABASE_URL`, `SITEFLOW_API_PORT`, `SITEFLOW_ARTIFACT_ROOT`, `SITEFLOW_PUBLIC_SCHEME`, and `SITEFLOW_API_TOKEN` are configured.
- `SITEFLOW_API_TOKEN` is configured with at least 32 non-placeholder characters.
- `SITEFLOW_METRICS_TOKEN` is configured with at least 32 non-placeholder characters, unless `SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1` is explicitly accepted for a private scrape path.
- `SITEFLOW_APP_SECRET` is configured with at least 32 non-placeholder characters, with `SITEFLOW_SEALING_KEY` used only for legacy compatibility and subject to the same production strength checks.
- No production browser bundle embeds `VITE_SITEFLOW_API_TOKEN`.
- Production browser build fails before bundling when `VITE_SITEFLOW_API_TOKEN`, `VITE_SITEFLOW_USE_FIXTURES`, or `VITE_SITEFLOW_FIXTURE_SCENARIO` is present.
- Browser operator access uses the HttpOnly `siteflow_session` API where possible. `sessionStorage` API token fallback must be disabled for production promotion, and operator-access evidence must prove browser fallback posture and `localStorage` token fallback disablement. Do not persist operator tokens in `localStorage`.
- API and CLI access require the expected bearer token in production, and browser cookie sessions must be short-lived, scoped, idle-timeout-bound, revocable, and paired with `X-SiteFlow-CSRF: same-origin` on mutating browser requests.
- Operator session rotation has target-equivalent evidence: the current cookie plus `X-SiteFlow-CSRF: same-origin` can mint a new Secure HttpOnly session cookie without returning a raw secret in JSON, the old cookie is rejected, missing-CSRF rotation is rejected, and Bearer-only requests cannot rotate cookie sessions.
- Operator session emergency cutoff has target-equivalent evidence: a global admin Bearer token can revoke all existing operator sessions, a project admin Bearer token can revoke only matching project sessions, cookie-only admin sessions are rejected, low-scope Bearer requests do not fall back to cookies, and the response `cutoffId` / `revokedAt` / incident ticket are archived.
- `npm run --silent operator-access:evidence -- --evidence <operator-access-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` passes for non-dry-run target or target-equivalent evidence covering disabled browser token fallback posture, disabled `localStorage` token fallback, operator session creation and rotation, Secure HttpOnly cookie flags, secret-free responses, idle timeout, project scope, CSRF, Bearer precedence, server-derived actor attribution, current-session revoke, global/project emergency cutoff, old-cookie rejection, and no raw credential archival.
- `npm run --silent non-session-credential:evidence -- --evidence <non-session-credential-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` passes for non-dry-run target or target-equivalent evidence covering non-session credential rotation or break-glass handling, redacted old/new identifiers, no raw credential archival, old credential rejection, new credential acceptance, scoped token audit/cutover, runtime token strength/reload, app-secret reseal/rollback planning, provider-managed rotation proof, break-glass controls, operator, and ticket metadata.
- If the API is behind a trusted reverse proxy, `SITEFLOW_TRUST_PROXY` is set to `loopback`, `private`, or explicit IP/CIDR proxy source entries and the ingress overwrites `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`; if the API is direct or the ingress cannot prove header cleanup, `SITEFLOW_TRUST_PROXY` remains unset/false.
- If operator ingress proof starts from `npm run --silent ingress:operator-evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --operator-name <operator> --release-ticket <ticket> --public-base-url <https-url> --trust-proxy-policy <SITEFLOW_TRUST_PROXY> --output <operator-ingress.json>`, every `todo` / `null` field has been replaced with real target observations. The template is a blocking dry-run skeleton only and is not production evidence by itself.
- `npm run --silent ingress:evidence:collect -- --public-base-url <https-url> --direct-api-url <direct-api-health-url> --target-environment production --commit-ref <sha> --repo <owner/repo> --branch main --trust-proxy-policy <SITEFLOW_TRUST_PROXY> --api-instance-count <count> --api-process-count <count> --ingress-count <count> --api-rate-limit-scope <edge|shared|global|distributed|process_local> --api-rate-limit-enforcement-point <edge|proxy|load_balancer|gateway|ingress|cdn|api> --operator-name <operator> --release-ticket <ticket> --operator-evidence <operator-ingress.json> --output <ingress-evidence-raw.json> --check-output <ingress-evidence.json> --json` has produced passed checker output for non-dry-run target ingress evidence proving the API port cannot be bypassed, forwarded headers are overwritten or backed by operator evidence, the configured proxy policy matches the final ingress hop, abusive `/api` traffic returns `429`, and health/readiness/preview/static routes return 2xx while metrics returns `200`, `401`, or `403` without API edge limiter throttling. The checker output attached to release evidence must also declare deployment topology; multi-instance, multi-process, or multi-ingress targets must prove `edgeEnforced` or `sharedAcrossInstances` API rate limiting rather than process-local-only limiting.
- `siteflow backup verify --backup <dir>` passes for the candidate backup with checksum verification for the dump and artifact tree, and `siteflow backup restore-drill --backup <dir> --database-url <disposable-postgres-url> --artifact-root <temp-root> --yes` has restored Postgres plus artifact storage into disposable targets with matching restored artifact checksum/file-count/byte-count evidence. Static verification is not a substitute for the restore drill.
- `siteflow backup fetch --source s3://<bucket>/<prefix>/<backup-name> --output <fetched-backup-root> --expected-tree-sha256 <sha256> --expected-object-count <count> --expected-total-bytes <bytes> --json` has fetched the off-host backup into an isolated restore source, and the restore drill used for production evidence points at that fetched backup path.
- `npm run --silent backup:evidence:compose -- --backup-verify <backup-verify.json> --restore-drill <restore-drill.json> --backup-offload <backup-offload.json> --backup-fetch <backup-fetch.json> --provider-security-audit <backup-provider-security-audit.json> --backup-prune <backup-prune.json> --policy <backup-policy.json> --operator-name <operator> --release-ticket <ticket> --require-off-host --output <backup-evidence-raw.json> --check-output <backup-evidence.json>` has produced archived raw evidence and passed checker output, or `npm run --silent backup:evidence -- --evidence <backup-evidence.json> --require-off-host --json` passes for equivalent preassembled evidence. The passing output must cover fresh backup verify, restore-drill, object-storage/provider-backed offload, backup fetch from the same offload location, provider security audit summary, restore drill from the fetched backup path, non-dry-run prune evidence, checksum, restored artifact integrity, non-`file://` off-host location, KMS encryption evidence, provider retention or immutability contract, provider KMS proof, provider retention proof, KMS key policy, bucket policy, lifecycle/versioning controls, cross-account restore access, cross-account restore drill, retained current backup, operator, ticket, schedule, retention, RPO/RTO, and monitoring metadata before accepting the backup/DR posture. `backup:automation --offload-target file://...` may still provide a local run record and restore/prune rehearsal, but it is not sufficient for this launch item by itself.
- The production cron, systemd timer, or external orchestrator job that invokes `backup:automation` is enabled and has archived `siteflow.backupSchedulerOwnership.v1` evidence proving scheduler kind/id, schedule/timezone, command, selected run record/history paths, owner, alert/escalation target, operator, ticket, and target environment.
- Migration execution is protected by the advisory transaction lock and checksum drift detection, and `SITEFLOW_RUN_POSTGRES_INTEGRATION=1 TEST_DATABASE_URL=<target-or-disposable-postgres-url> npm run --silent rehearsal:postgres -- --json --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production` has passed against a target-equivalent Postgres environment.
- Source builds use exact commit checkout, not branch tips, and the source provider credential path is documented for the target install.
- Git remote URLs do not contain embedded credentials; private repository access uses the documented `SITEFLOW_GIT_SSH_KEY_PATH` credential path outside clone URLs, with `SITEFLOW_GIT_KNOWN_HOSTS_PATH` configured when provider host keys are pinned.
- If source provider proof starts from `npm run --silent source-provider:evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --provider <github|gitlab|gitea|generic> --operator-name <operator> --release-ticket <ticket> --output <source-provider-evidence-raw.json>`, every `todo` / `null` field has been replaced with real target or target-equivalent observations. The template is a blocking dry-run skeleton only and is not production evidence by itself.
- `npm run --silent source-provider:evidence -- --evidence <source-provider-evidence-raw.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` passes for non-dry-run target or target-equivalent evidence proving the enabled provider, repository binding, exact checkout, signed webhook delivery, webhook secret hygiene, private repo deploy-key handling, pinned SSH host key policy when applicable, release provenance recording, no raw credential archival, operator, and ticket metadata.
- Build workers do not run production source builds on the host unless the unsafe-build trust flag is intentionally enabled. The Docker runner is the minimum source-build path, but it is not a complete sandbox substitute.
- `SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL=1 SITEFLOW_BUILD_IMAGE=<target-image> npm run --silent rehearsal:docker-build -- --commit-ref <sha> --repo <owner/repo> --branch main --json` has passed in the target profile. Mocked Docker tests, `docker --version`, static Compose generation, or `--dry-run` output are not production evidence.
- The Docker build rehearsal output includes `artifactLimits`, and its artifact `fileCount` and `totalBytes` are within those limits.
- `npm run --silent upgrade-rollback:evidence -- --evidence <upgrade-rollback-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` passes for a non-dry-run target-equivalent upgrade/rollback drill covering API, worker, schema, route/artifact, readiness, metrics, logs, alerts, backup evidence, operator, and ticket metadata.
- TLS, DNS, and preview route publication are verified for the target domain.
- NDJSON request logs are collected from stdout, `/readyz` is wired into the load balancer/orchestrator, `/metrics` is protected with `SITEFLOW_METRICS_TOKEN` or an explicitly documented `SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1` private-scrape exception, scraped or converted into operational metrics, and alerts are available before accepting customer traffic.
- `npm run --silent observability:provisioning -- --output <observability-provisioning-dir>` has produced reviewed Prometheus scrape/rule, Alertmanager route, and Grafana dashboard artifacts, and the target operator has applied equivalent configuration through the real observability stack.
- `npm run --silent observability:evidence:collect -- --base-url <target-url> --backup-automation-run <backup-evidence-dir>/backup-automation-run.json --backup-automation-history <backup-history-dir>/backup-automation-history.json --backup-scheduler-ownership <backup-scheduler-ownership.json> --operator-evidence <operator-observability.json> --target-stack-api-url <observability-proof-url> --target-stack-token-env SITEFLOW_OBSERVABILITY_STACK_TOKEN --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --output <observability-evidence-raw.json> --check-output <observability-evidence.json>` has produced archived raw evidence and passed checker output, or `npm run --silent observability:evidence -- --evidence <observability-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` passes for equivalent preassembled evidence. The passing output must cover matching release identity and target environment, fresh readiness, authenticated metrics scrape with expected SiteFlow HTTP, runtime queue, and backup automation metric names, completed production-compatible backup automation run evidence with passed object-storage/KMS/provider-retention/fetch/provider-security-audit backup checker output, run-history-backed recurring restore-drill cadence, backup scheduler ownership proof for the enabled recurring job, apply proof binding the target-stack assets to `observabilityProvisioning.renderedAssets`, target-stack proof for Prometheus rules, Grafana dashboard metric coverage, and Alertmanager receiver delivery, alert delivery, fresh dashboard ownership, log retention, and redaction spot-check evidence.
- Before final bundle composition, `npm run --silent release:evidence:gaps -- --pack <evidence-dir>/release-evidence-rehearsal-pack.json --json` validates the pack command contract, has no missing, invalid, blocked, failed, manual-required, dry-run-only, stale, or identity-mismatched target evidence outputs other than the expected final bundle and final check items, and has no immediate `inputGaps` for the next evidence commands. `release:evidence:target-run --plan-only` may be used before collection to validate command prerequisites, but its `planned` run record is not production evidence. After `release:evidence:compose` and the final `release:evidence` check complete, the final gap report has no remaining gaps, or a non-plan-only target-run final record has `status: "completed"`, `productionEvidenceGenerated: true`, and a final passed gap snapshot.
- `npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` passes for the combined release evidence bundle, including GHCR release image digest evidence, source provider, operator access, non-session credential, ingress, and upgrade/rollback drill evidence.
- An owner is assigned for incident response, key rotation, and restore drills.
