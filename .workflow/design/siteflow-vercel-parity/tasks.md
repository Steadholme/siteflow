# SiteFlow Vercel Parity Tasks

Date: 2026-05-25
Status: iterating

## Task VP-001: Project And Environment Foundation

Issue: `ISS-20260525-001`

Scope:

- Add project create/update/delete read/write paths.
- Add environment tables and read models.
- Add environment variable metadata with redaction.
- Extend console settings surfaces for project, build, domains, and env vars.

Suggested files:

- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/readRepository.ts`
- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/features/projects/`
- `cli/siteflowCli.ts`

Verification:

- Unit tests for redaction and validation.
- API tests for project/env CRUD.
- Console tests for no secret leakage.

## Task VP-002: Git Webhook And Source Events

Issue: `ISS-20260525-002`

Scope:

- Add webhook endpoint per provider.
- Verify signatures and normalize provider payloads.
- Persist source events with idempotency key.
- Enqueue build jobs for branch push and pull request events.

Suggested files:

- `server/httpServer.ts`
- `server/postgresReadRepository.ts`
- `server/migrations.ts`
- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `server/*webhook*`

Verification:

- Tests for signature failures, duplicate deliveries, branch mapping, PR preview events.

## Task VP-003: Build Worker MVP

Issue: `ISS-20260525-003`

Scope:

- Add a worker process that claims queued build jobs.
- Detect framework/output directory for static React/Vite projects.
- Run install/build commands in a sandboxed workspace.
- Store build logs and immutable artifact manifest.

Suggested files:

- `worker/`
- `server/migrations.ts`
- `src/domain/siteflow.ts`
- `server/postgresReadRepository.ts`
- `package.json`
- `tsconfig.worker.json`

Verification:

- Integration test with a tiny Vite fixture project.
- Log chunk API returns build output without secrets.

## Task VP-004: Production Domains And Promotion Semantics

Issue: `ISS-20260525-004`

Scope:

- Model domain resources, branch aliases, commit aliases, preview aliases, and production aliases.
- Add promotion and rollback route apply operations.
- Track route desired state and applied state separately.
- Surface drift in console and doctor.

Suggested files:

- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `src/features/release/`
- `src/features/projects/`
- `cli/doctor.ts`

Verification:

- API tests for promote/rollback idempotency.
- E2E tests for production route reassignment.

## Task VP-005: Deployment Management And Observability

Issue: `ISS-20260525-005`

Scope:

- Add deployment list filtering by branch, environment, status, source, and date.
- Add operation timeline and error classification read models.
- Add deployment inspect API/CLI.
- Generate console read models from real Postgres state.

Suggested files:

- `src/features/deployments/`
- `src/lib/api/siteflowClient.ts`
- `server/postgresReadRepository.ts`
- `cli/siteflowCli.ts`
- `cli/deploy.ts`

Verification:

- Vitest coverage for filters/status mapping.
- Playwright coverage for failed deploy debugging path.

## Task VP-006: CLI Parity

Issue: `ISS-20260525-006`

Scope:

- Add `siteflow link`.
- Add `siteflow env pull`.
- Add `siteflow deploy --prod`.
- Add `siteflow deployments`, `siteflow inspect`, `siteflow promote`, and `siteflow rollback`.
- Add deploy hook create/list/revoke commands.

Suggested files:

- `cli/siteflowCli.ts`
- `cli/config.ts`
- `cli/deploy.ts`
- `cli/*deployHook*`
- `src/lib/api/deployContracts.ts`

Verification:

- CLI tests for stdout URL behavior and `--json`.
- Config tests for local project link metadata.

## Task VP-007: Rolling Release

Issue: `ISS-20260525-007`

Scope:

- Add rolling release config and rollout state.
- Add request bucketing at artifact route resolution.
- Add canary/current comparison read model.
- Add complete, abort, and advance operations.

Suggested files:

- `server/httpServer.ts`
- `server/postgresReadRepository.ts`
- `server/migrations.ts`
- `src/features/release/`
- `cli/siteflowCli.ts`

Verification:

- Deterministic bucket tests.
- Route serving tests for staged rollout.
- Console and CLI tests for complete/abort.

## Task VP-008: Deploy Hooks

Issue: `ISS-20260525-008`

Scope:

- Add deploy hook resource linked to project, branch, and environment.
- Generate one-time visible hook secret/URL.
- Trigger build by POST without normal auth but with unguessable token.
- Add revoke and audit trail.

Suggested files:

- `server/httpServer.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `src/domain/siteflow.ts`
- `cli/siteflowCli.ts`

Verification:

- Tests for hook trigger, revoked hook, wrong token, and audit event.

## Task VP-009: Cron Jobs

Issue: `ISS-20260525-009`

Scope:

- Add project-scoped cron job resources with `path` and five-field UTC cron schedule.
- Validate Vercel-compatible cron expression constraints.
- Record cron dispatch attempts with target production URL and `vercel-cron/1.0` user agent.
- Add management API and CLI for create, list, disable, and run-now operations.

Suggested files:

- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/readRepository.ts`
- `server/httpServer.ts`
- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `cli/siteflowCli.ts`

Verification:

- Cron expression validation tests.
- API and CLI tests for create/list/disable/run.
- Tests that cron dispatch records use production URL and `vercel-cron/1.0`.

## Task VP-010: Functions Runtime MVP

Issue: `ISS-20260525-010`

Scope:

- Detect function entrypoints in `api/` or build output metadata.
- Add Node.js function bundle metadata to deployments.
- Route `/api/*` requests to function handlers with isolated execution boundaries.
- Capture runtime logs, duration, status, and errors per invocation.

Suggested files:

- `worker/`
- `server/httpServer.ts`
- `server/postgresReadRepository.ts`
- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`

Verification:

- Integration test for a small API function returning JSON.
- Runtime log and error classification tests.
- Route tests proving static artifacts and functions coexist.

## Task VP-011: Web Analytics And Speed Insights

Issue: `ISS-20260525-011`

Scope:

- Add privacy-preserving pageview and custom event ingestion.
- Aggregate top pages, referrers, countries, browsers, devices, and Core Web Vitals.
- Add project dashboard read models for analytics and speed insights.
- Redact sensitive URLs and avoid cookie-based tracking.

Suggested files:

- `server/httpServer.ts`
- `server/postgresReadRepository.ts`
- `src/features/analytics/`
- `src/lib/api/siteflowClient.ts`

Verification:

- Tests for redaction and no-cookie event ingestion.
- Aggregation tests for pageview and Web Vitals summaries.
- Console smoke tests for analytics dashboard.

## Task VP-012: Observability And Log Drains

Issue: `ISS-20260525-012`

Scope:

- Add runtime logs, build logs, cron logs, and function invocation logs under one query API.
- Add saved queries and severity/time filters.
- Add log drain destinations that POST structured events to external endpoints.
- Add retry, signing, and redaction for drain delivery.

Suggested files:

- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `src/domain/readModels.ts`
- `cli/siteflowCli.ts`

Verification:

- Query API tests for filters and pagination.
- Drain delivery tests with mocked external endpoint.
- Redaction tests for secrets in log payloads.

## Task VP-013: Team RBAC And Audit

Issue: `ISS-20260525-013`

Scope:

- Add team, member, role, and project access models.
- Enforce owner/member/developer/viewer permissions on mutating routes.
- Add scoped API tokens and audit events for project operations.
- Surface audit history in console and CLI.

Suggested files:

- `server/httpServer.ts`
- `server/postgresReadRepository.ts`
- `server/migrations.ts`
- `src/domain/siteflow.ts`
- `src/features/settings/`
- `cli/siteflowCli.ts`

Verification:

- Authorization matrix tests for all mutating APIs.
- Token scope tests.
- Audit event tests for sensitive operations.

## Task VP-014: Firewall And Edge Config

Issue: `ISS-20260525-014`

Scope:

- Add project firewall rules for IP, path, header, and user-agent matching.
- Add Edge Config-like key/value store for feature flags and runtime config.
- Apply firewall decisions before artifact/function routing.
- Add CLI/API management and audit trail.

Suggested files:

- `server/httpServer.ts`
- `server/postgresReadRepository.ts`
- `server/migrations.ts`
- `src/domain/siteflow.ts`
- `src/lib/api/siteflowClient.ts`
- `cli/siteflowCli.ts`

Verification:

- Route tests for allow/block/challenge decisions.
- Edge config read/write consistency tests.
- CLI tests for rule and config management.

## Task VP-015: Blob Storage

Issue: `ISS-20260527-015`

Scope:

- Add project-scoped Blob objects for user-uploaded files and generated assets.
- Add `put`, `list`, `get`, and `delete` APIs with metadata-only listings and explicit content reads.
- Support public/private access metadata, content type, cache-control max age, ETag, size, and SHA-256 checksums.
- Add CLI commands for upload, list, download, and delete.
- Add audit events for upload and delete operations.

Suggested files:

- `server/httpServer.ts`
- `server/postgresReadRepository.ts`
- `server/migrations.ts`
- `server/readRepository.ts`
- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `cli/siteflowCli.ts`

Verification:

- API tests for upload/list/get/delete behavior.
- SDK and fixture client tests for Blob contracts.
- CLI tests for file upload/download/delete and JSON behavior.

## Task VP-016: Image Optimization

Issue: `ISS-20260527-016`

Scope:

- Add image transform API for width, quality, format, and cache metadata.
- Integrate optimized image responses with project artifact/blob sources.
- Add cache keys, validation, and no-secret URL handling.

Verification:

- Tests for transform parameter validation and cache key stability.
- Route tests for optimized image response headers.

## Task VP-017: Cache And ISR Controls

Issue: `ISS-20260527-017`

Scope:

- Add project cache entries, tags, invalidation, and stale-while-revalidate metadata.
- Add CLI/API commands for cache inspect and purge by path/tag.
- Record audit events for manual invalidation.

Verification:

- API tests for tag/path purge behavior.
- CLI tests for cache inspect and purge.

## Task VP-018: Functions Runtime Controls

Issue: `ISS-20260527-018`

Scope:

- Add function timeout/memory/concurrency metadata and per-function runtime controls.
- Add runtime error rate and duration summaries for operations.
- Add CLI/API inspection for function configuration and recent invocations.

Verification:

- Function routing tests for configured methods and runtime limits.
- API/CLI tests for function configuration inspection.

## Task VP-019: Routing Rules

Issue: `ISS-20260527-019`

Scope:

- Add project-level routing rules for redirects, rewrites, and response headers.
- Support Vercel-style path sources with named and wildcard parameters for same-application routing.
- Apply redirects before rewrites, and apply header rules to artifact/function responses.
- Add API/CLI management for list, upsert, and disable operations with audit events.

Verification:

- Route tests for redirect, rewrite, and header application order.
- API/client/fixture tests for routing rule management.
- CLI tests for routing rule list/upsert/disable and JSON behavior.

## Task VP-020: vercel.json Routing Import

Issue: `ISS-20260527-020`

Scope:

- Read `vercel.json` redirects, rewrites, and headers during prebuilt deploy packaging.
- Include normalized routing config in prebuilt deploy requests.
- Persist imported routing config as project routing rules during server-side prebuilt deploy.

Verification:

- CLI deploy test proving `vercel.json` routing config is sent with the prebuilt deploy payload.
- HTTP/API test proving prebuilt deploy accepts routing config.
- Type checks, full tests, and build.

## Task VP-021: Framework Build Settings Detection

Issue: `ISS-20260527-021`

Scope:

- Detect framework presets from source `package.json` during worker execution.
- Support Vite, Next.js, Astro, Create React App, and static defaults.
- Read Vercel-compatible build setting overrides from `vercel.json`.
- Resolve `auto`/default static build settings into artifact metadata and output lookup paths.
- Preserve explicit project build settings when they disagree with detection.

Suggested files:

- `worker/buildWorker.ts`
- `worker/frameworkDetector.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker tests for Vite auto-detection, `vercel.json` overrides, and explicit setting preservation.
- Worker type checks.
- Full test suite and production build.

## Task VP-022: Build Environment Variable Injection

Issue: `ISS-20260527-022`

Scope:

- Preserve sealed build-scope environment variable values for worker use while keeping API/UI responses metadata-only.
- Load target-environment build variables when claiming queued build jobs.
- Inject preview/production build variables into install/build subprocesses.
- Redact injected secret values from worker logs.

Suggested files:

- `server/postgresReadRepository.ts`
- `worker/postgresBuildQueue.ts`
- `worker/buildWorker.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving build scripts can read injected variables while logs redact secret values.
- Worker and server type checks.
- Full test suite and production build.

## Task VP-023: Sealed Environment Storage Hardening

Issue: `ISS-20260527-023`

Scope:

- Replace plaintext sealed environment variable storage with an encrypted envelope.
- Decrypt sealed build variables only in the worker queue path.
- Preserve backward compatibility for existing plaintext sealed values.
- Add tests for encryption, decryption, wrong-key failures, and legacy plaintext compatibility.

Suggested files:

- `src/lib/sealedSecrets.ts`
- `src/lib/sealedSecrets.test.ts`
- `server/postgresReadRepository.ts`
- `worker/postgresBuildQueue.ts`
- `tsconfig.server.json`
- `tsconfig.worker.json`

Verification:

- Targeted sealed-secret, worker, API, and server tests.
- Server and worker type checks.
- Full test suite and production build.

## Task VP-024: Function Runtime Environment Injection

Issue: `ISS-20260527-024`

Scope:

- Load runtime-scope sealed environment variables when resolving artifact routes.
- Select preview or production runtime variables from route context and deployment branch.
- Inject runtime variables into deployed `/api/*` function handlers through `process.env` and handler context.
- Restore process environment after invocation.
- Redact injected runtime values from function logs and invocation records.

Suggested files:

- `server/readRepository.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `server/httpServer.test.ts`
- `src/lib/environmentTarget.ts`
- `tsconfig.server.json`
- `tsconfig.worker.json`

Verification:

- HTTP route test proving function runtime env injection, log redaction, and process env restoration.
- Server and worker type checks.
- Full test suite and production build.

## Task VP-025: Function Runtime Limit Enforcement

Issue: `ISS-20260527-025`

Scope:

- Enforce function `timeoutMs` during `/api/*` invocation.
- Enforce function `concurrency` during in-process invocation.
- Record failed invocation summaries for timeout and concurrency limit failures.
- Preserve method filtering, runtime environment injection, and log redaction behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route tests for timeout and concurrency limit enforcement.
- Server type checks.
- Full test suite and production build.

## Task VP-026: Function Runtime Memory Guardrails

Issue: `ISS-20260527-026`

Scope:

- Enforce a pre-invocation memory guard from function `memoryMb`.
- Reject function invocation before loading user code when the current process exceeds the configured limit.
- Record failed invocation summaries for memory guard failures.
- Keep timeout, concurrency, runtime environment injection, and log redaction behavior intact.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving memory guard rejection and failed invocation recording.
- Server type checks.
- Full test suite and production build.

## Task VP-027: vercel.json Cron Import

Issue: `ISS-20260527-027`

Scope:

- Read Vercel-compatible `crons` entries from `vercel.json` during prebuilt deploy packaging.
- Include imported cron definitions in the prebuilt deployment API payload.
- Persist imported cron definitions as project cron jobs during prebuilt deploy.
- Upsert existing imported jobs by stable project/name identity so repeat deploys update schedules without duplicates.
- Re-enable previously disabled imported cron jobs when a new deploy imports them again.

Suggested files:

- `cli/deploy.ts`
- `src/lib/api/deployContracts.ts`
- `server/postgresReadRepository.ts`
- `cli/siteflowCli.test.ts`
- `server/httpServer.test.ts`
- `server/postgresReadRepository.test.ts`

Verification:

- CLI deploy test proving `vercel.json` cron config is sent with the prebuilt deploy payload.
- HTTP API contract test proving prebuilt cron payload reaches the repository.
- Repository test proving prebuilt deploy upserts cron rows.
- CLI/server type checks.
- Full test suite and production build.

## Task VP-028: vercel.json Clean URL Routing

Issue: `ISS-20260527-028`

Scope:

- Read Vercel-compatible `cleanUrls` and `trailingSlash` settings from `vercel.json` during prebuilt deploy packaging.
- Include clean URL routing settings in the prebuilt deployment API payload.
- Persist clean URL routing settings into deployment artifact metadata.
- Resolve extensionless static paths to matching `.html` files when `cleanUrls` is enabled.
- Apply 308 canonical redirects for `.html` paths and trailing-slash policy.

Suggested files:

- `cli/deploy.ts`
- `src/lib/api/deployContracts.ts`
- `server/readRepository.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `cli/siteflowCli.test.ts`
- `server/httpServer.test.ts`
- `server/postgresReadRepository.test.ts`

Verification:

- CLI deploy test proving `vercel.json` clean URL settings are sent with the prebuilt deploy payload.
- Repository test proving prebuilt deploy persists clean URL settings into artifact metadata.
- HTTP route test proving clean URL resolution and canonical redirects.
- CLI/server/worker type checks.
- Full test suite and production build.

## Task VP-029: Build Skip Command

Issue: `ISS-20260527-029`

Scope:

- Read Vercel-compatible `ignoreCommand` from `vercel.json` during source build settings detection.
- Execute the ignore command before install/build in the worker using the existing allowlist command runner.
- Mark the build job as `skipped` when `ignoreCommand` exits with code `0`.
- Continue the build when `ignoreCommand` exits non-zero.
- Redact skip reasons and build logs consistently with the existing worker logging path.

Suggested files:

- `src/domain/siteflow.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `worker/frameworkDetector.ts`
- `worker/buildWorker.ts`
- `worker/postgresBuildQueue.ts`
- `worker/buildWorker.test.ts`
- `worker/postgresBuildQueue.test.ts`
- `src/features/deployments/deploymentStatus.ts`
- `src/lib/fixtures/siteflow.fixtures.ts`

Verification:

- Worker tests proving skip-on-zero and continue-on-nonzero behavior.
- Postgres queue test proving skipped status persistence with redacted reason.
- Type checks for app, server, worker, and CLI.
- Full test suite and production build.

## Task VP-030: Source Build vercel.json App Config Import

Issue: `ISS-20260527-030`

Scope:

- Read app-level `vercel.json` config from the resolved source project root during worker builds.
- Persist `cleanUrls` and `trailingSlash` into source build artifact metadata so runtime static serving matches prebuilt behavior.
- Import `crons` from source builds and upsert project cron jobs when the build completes.
- Reuse the same stable imported cron identity as prebuilt deploys.
- Validate imported cron paths and schedules before persistence.

Suggested files:

- `worker/buildWorker.ts`
- `worker/postgresBuildQueue.ts`
- `worker/buildWorker.test.ts`
- `worker/postgresBuildQueue.test.ts`

Verification:

- Worker test proving source build artifact metadata and cron payload include imported `vercel.json` app config.
- Postgres queue test proving source build completion upserts imported cron rows.
- Server/worker/app/CLI type checks.
- Full test suite and production build.

## Task VP-031: vercel.json Function Runtime Overrides

Issue: `ISS-20260527-031`

Scope:

- Read Vercel-compatible `functions` configuration from `vercel.json` during source builds.
- Match function config entries to detected `api/` function files.
- Map supported runtime settings onto SiteFlow function metadata:
  - `maxDuration` -> `timeoutMs`
  - `memory` -> `memoryMb`
  - `concurrency` -> `concurrency`
- Persist the resulting function metadata in the artifact manifest so existing runtime guardrails enforce it.

Suggested files:

- `worker/buildWorker.ts`
- `worker/artifactPublisher.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving detected API functions receive `timeoutMs`, `memoryMb`, and `concurrency` from `vercel.json`.
- Existing HTTP runtime tests proving those fields are enforced.
- Worker/server/app/CLI type checks.
- Full test suite and production build.

## Task VP-032: vercel.json Function Include Files

Issue: `ISS-20260527-032`

Scope:

- Read Vercel-compatible `functions.*.includeFiles` entries from `vercel.json` during source builds.
- Apply include file patterns only to detected API functions matched by the same `functions` config entry.
- Copy matched project files into the function bundle under `.siteflow/functions/` while preserving project-relative paths.
- Prevent include patterns from escaping the resolved source project root.
- Avoid duplicate extra-file conflicts with function entrypoints and generated function package metadata.

Suggested files:

- `worker/buildWorker.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving matched `includeFiles` are bundled with detected API functions and unmatched function config does not leak files.
- Worker/server target test suite.
- Worker/server/app/CLI type checks.
- Full test suite and production build.

## Task VP-033: vercel.json Function Exclude Files

Issue: `ISS-20260527-033`

Scope:

- Read Vercel-compatible `functions.*.excludeFiles` entries from `vercel.json` during source builds.
- Apply exclude file patterns only to detected API functions matched by the same `functions` config entry.
- Filter excluded files out of the explicit `includeFiles` bundle set before artifact publishing.
- Reuse include/exclude path safety checks so patterns cannot escape the resolved source project root.
- Preserve generated function package metadata and function entrypoint publishing behavior.

Suggested files:

- `worker/buildWorker.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving `excludeFiles` removes private files from an included function bundle.
- Worker/server target test suite.
- Worker/server/app/CLI type checks.
- Full test suite and production build.

## Task VP-034: vercel.json Function Regions Metadata

Issue: `ISS-20260527-034`

Scope:

- Read Vercel-compatible project-level `regions` and `functionFailoverRegions` from `vercel.json` during source builds.
- Read function-level `functions.*.regions` and `functions.*.functionFailoverRegions` overrides.
- Persist primary and failover region metadata in function artifact manifest entries.
- Preserve existing local runtime behavior while making region intent visible to function list/inspect surfaces.
- Validate region identifiers conservatively before writing manifest metadata.

Suggested files:

- `src/domain/siteflow.ts`
- `worker/buildWorker.ts`
- `worker/artifactPublisher.ts`
- `server/postgresReadRepository.ts`
- `cli/siteflowCli.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving project-level region defaults and function-level overrides are persisted in manifest functions.
- CLI/read-model type checks proving region metadata is exposed without breaking function inspection.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-035: vercel.json Git Deployment Controls

Issue: `ISS-20260527-035`

Scope:

- Read Vercel-compatible `git.deploymentEnabled` from `vercel.json` during source builds.
- Support global boolean disablement and branch-pattern deployment rules.
- Skip source build jobs before install/build when Git deployment is disabled for the source branch.
- Preserve existing `ignoreCommand` skip behavior and skipped build persistence.
- Log a clear skipped reason without running user build commands.

Suggested files:

- `worker/buildWorker.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker tests proving global `deploymentEnabled: false` skips before build.
- Worker tests proving branch-pattern deployment rules can disable a matching branch.
- Worker/server target tests.
- Worker/server/app/CLI type checks.
- Full test suite and production build.

## Task VP-036: Source Build vercel.json Routing Rules Import

Issue: `ISS-20260527-036`

Scope:

- Read Vercel-compatible `redirects`, `rewrites`, and `headers` from `vercel.json` during source builds.
- Persist source build routing rules into artifact manifest metadata alongside clean URL settings.
- Resolve artifact-local redirects, rewrites, and headers at runtime before static artifact responses.
- Keep project-level routing rules working and merge response headers when both artifact and project rules apply.
- Preserve prebuilt deploy routing behavior.

Suggested files:

- `worker/buildWorker.ts`
- `server/readRepository.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `worker/buildWorker.test.ts`
- `server/httpServer.test.ts`

Verification:

- Worker test proving source build artifact metadata includes `redirects`, `rewrites`, and `headers`.
- HTTP route test proving artifact-local routing metadata redirects, rewrites, and applies headers.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-037: vercel.json skipTrailingSlashRedirect

Issue: `ISS-20260527-037`

Scope:

- Read Vercel-compatible `skipTrailingSlashRedirect` from `vercel.json` during prebuilt deploy packaging and source builds.
- Persist the flag into artifact manifest routing metadata.
- Resolve artifact routes with the skip flag available to static canonicalization.
- Skip trailing-slash canonical redirects while preserving clean URL `.html` canonical redirects.
- Serve directory `index.html` directly when slash redirect is skipped.

Suggested files:

- `src/lib/api/deployContracts.ts`
- `cli/deploy.ts`
- `worker/buildWorker.ts`
- `server/readRepository.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `cli/siteflowCli.test.ts`
- `worker/buildWorker.test.ts`
- `server/postgresReadRepository.test.ts`
- `server/httpServer.test.ts`

Verification:

- CLI test proving prebuilt `vercel.json` packages `skipTrailingSlashRedirect` into deploy routing metadata.
- Worker test proving source build artifact metadata includes `skipTrailingSlashRedirect`.
- Postgres read repository test proving artifact manifests preserve and restore the flag.
- HTTP route test proving trailing slash redirects are skipped and directory `index.html` is served.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-038: vercel.json Public Deployment Metadata

Issue: `ISS-20260527-038`

Scope:

- Read Vercel-compatible `public` from `vercel.json` during prebuilt deploy packaging.
- Include the public deployment intent in prebuilt deploy requests.
- Read `public` from source build `vercel.json`.
- Persist the flag into artifact manifest metadata for both prebuilt and source-built deployments.
- Expose the flag through existing deployment artifact manifest read models without enabling anonymous source or log access.

Suggested files:

- `src/lib/api/deployContracts.ts`
- `cli/deploy.ts`
- `worker/buildWorker.ts`
- `server/postgresReadRepository.ts`
- `cli/siteflowCli.test.ts`
- `worker/buildWorker.test.ts`
- `server/postgresReadRepository.test.ts`

Verification:

- CLI test proving prebuilt `vercel.json` packages `public` into the deploy payload.
- Worker test proving source build artifact metadata includes `public`.
- Repository test proving prebuilt deploy persists `public` into artifact manifest metadata.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-039: vercel.json Bun Version Metadata

Issue: `ISS-20260527-039`

Scope:

- Read Vercel-compatible `bunVersion` from source build `vercel.json`.
- Accept the currently supported Vercel value `1.x` and ignore unsupported values.
- Persist accepted Bun version intent into source build artifact manifest metadata.
- Keep the runtime behavior unchanged until SiteFlow has an explicit Bun function/build runtime.

Suggested files:

- `worker/buildWorker.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving `bunVersion: "1.x"` is persisted into artifact manifest metadata.
- Worker test proving unsupported `bunVersion` values are ignored.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-040: vercel.json Images Config Import

Issue: `ISS-20260527-040`

Scope:

- Read Vercel-compatible `images` config from `vercel.json` during prebuilt deploy packaging and source builds.
- Persist supported image settings into artifact manifest metadata:
  - `sizes`
  - `qualities`
  - `formats`
  - `minimumCacheTTL`
  - `dangerouslyAllowSVG`
  - `contentSecurityPolicy`
  - `contentDispositionType`
- Restore deployment image config when resolving artifact routes.
- Enforce deployment image config in `/_siteflow/image` for allowed widths, qualities, and formats.
- Apply deployment-specific image cache TTL, content disposition, SVG policy, and CSP headers.

Suggested files:

- `src/lib/api/deployContracts.ts`
- `cli/deploy.ts`
- `worker/buildWorker.ts`
- `server/readRepository.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `cli/siteflowCli.test.ts`
- `worker/buildWorker.test.ts`
- `server/postgresReadRepository.test.ts`
- `server/httpServer.test.ts`

Verification:

- CLI test proving prebuilt `vercel.json` packages `images` into the deploy payload.
- Worker test proving source build artifact metadata includes `images`.
- Repository test proving prebuilt deploy persists `images` into artifact manifest metadata.
- HTTP route test proving image width, quality, format, SVG, TTL, CSP, and disposition behavior.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-041: vercel.json Fluid Compute Metadata

Issue: `ISS-20260527-041`

Scope:

- Read Vercel-compatible `fluid` from `vercel.json` during prebuilt deploy packaging and source builds.
- Persist `fluid` as deployment artifact manifest metadata for both prebuilt and source-built deployments.
- Support `boolean` and `null` values while ignoring unsupported value shapes.
- In source builds, avoid applying `functions.*.memory` overrides when `fluid: true`, matching Vercel's Fluid compute constraint.
- Keep SiteFlow runtime behavior otherwise unchanged until Fluid compute scheduling is explicitly implemented.

Suggested files:

- `src/lib/api/deployContracts.ts`
- `cli/deploy.ts`
- `worker/buildWorker.ts`
- `server/postgresReadRepository.ts`
- `cli/siteflowCli.test.ts`
- `worker/buildWorker.test.ts`
- `server/postgresReadRepository.test.ts`

Verification:

- CLI test proving prebuilt `vercel.json` packages `fluid` into the deploy payload.
- Worker test proving source build artifact metadata includes `fluid`.
- Worker test proving `functions.*.memory` is ignored when `fluid: true`.
- Repository test proving prebuilt deploy persists `fluid` into artifact manifest metadata.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-042: vercel.json Build Env Import

Issue: `ISS-20260527-042`

Scope:

- Read Vercel-compatible `build.env` from source build `vercel.json`.
- Inject string-valued build env entries into `ignoreCommand`, install, and build commands.
- Let sealed/project build env from the queue override repository `vercel.json` build env.
- Redact imported build env values from worker logs.
- Persist only imported env keys in artifact manifest metadata, never raw values.

Suggested files:

- `worker/buildWorker.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving `vercel.json build.env` is injected into source build commands.
- Worker test proving queue/project environment variables override repository build env.
- Worker test proving imported env secret values are redacted from logs and non-string values are ignored.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-043: vercel.json Runtime Env Import

Issue: `ISS-20260527-043`

Scope:

- Read Vercel-compatible top-level `env` from source build `vercel.json`.
- Preserve only string-valued runtime env entries.
- Store imported runtime env values as sealed artifact manifest metadata, never raw strings.
- Persist imported runtime env keys separately for manifest visibility.
- Inject deployment-scoped runtime env into `/api/*` functions when resolving artifact routes.
- Let sealed project runtime env override deployment-scoped `vercel.json env` values.

Suggested files:

- `worker/buildWorker.ts`
- `server/postgresReadRepository.ts`
- `worker/buildWorker.test.ts`
- `server/postgresReadRepository.test.ts`

Verification:

- Worker test proving top-level `env` is sealed in artifact metadata and raw values are absent.
- Repository test proving sealed artifact runtime env is unsealed into route runtime env.
- Repository test proving project runtime env overrides imported artifact runtime env.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-044: Static Asset Cache Semantics

Issue: `ISS-20260527-044`

Scope:

- Apply Vercel-like cache headers to static artifact responses.
- Serve HTML and other mutable text metadata files with `max-age=0, must-revalidate`.
- Serve fingerprinted static assets with long-lived immutable cache headers.
- Serve non-fingerprinted static assets with bounded browser cache headers.
- Generate deployment-scoped weak ETags for static artifact files.
- Return `304 Not Modified` when `If-None-Match` matches the generated ETag.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving HTML receives revalidation cache headers and ETag.
- HTTP route test proving fingerprinted assets receive immutable cache headers.
- HTTP route test proving matching `If-None-Match` returns `304`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-093: Release Operations Read HEAD Semantics

Issue: `ISS-20260527-093`

Scope:

- Treat `HEAD /api/projects/:id/deploy-hooks` as the metadata-only equivalent of `GET /api/projects/:id/deploy-hooks`.
- Treat `HEAD /api/projects/:id/cron-jobs` as the metadata-only equivalent of `GET /api/projects/:id/cron-jobs`.
- Treat `HEAD /api/projects/:id/rolling/:channel` as the metadata-only equivalent of `GET /api/projects/:id/rolling/:channel`.
- Treat `HEAD /api/projects/:id/release/:channel` as the metadata-only equivalent of `GET /api/projects/:id/release/:channel`.
- Treat `HEAD /api/projects/:id/rollback/:channel` as the metadata-only equivalent of `GET /api/projects/:id/rollback/:channel`.
- Pass request method through release operations read responses.
- Preserve bodyless auth failures for protected release operations `HEAD` requests.
- Preserve existing `GET` release operations JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving authorized `HEAD` deploy hook, cron job, and rolling release reads return `200`, JSON content type, and no body.
- Raw HTTP test proving public `HEAD` release and rollback console reads return `200`, JSON content type, and no body.
- Raw HTTP test proving unauthorized `HEAD /api/projects/:id/deploy-hooks` returns `401`, JSON content type, and no body.
- Existing `GET` release operations tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-094: Operation Poll Read HEAD Semantics

Issue: `ISS-20260527-094`

Scope:

- Treat `HEAD /api/operations/:id` as the metadata-only equivalent of `GET /api/operations/:id`.
- Pass request method through operation polling JSON responses.
- Preserve existing `GET` operation polling JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD /api/operations/:id` returns `200`, JSON content type, and no body.
- Existing operation polling repository behavior continues to serve the same read model.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-095: CORS HEAD Method Metadata

Issue: `ISS-20260527-095`

Scope:

- Advertise `HEAD` in `Access-Control-Allow-Methods` for JSON API responses when CORS is enabled.
- Advertise `HEAD` in `Access-Control-Allow-Methods` for `OPTIONS` preflight responses when CORS is enabled.
- Keep CORS method metadata centralized so route support and preflight support do not diverge.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `OPTIONS /api/projects` with configured CORS origin includes `HEAD` in `Access-Control-Allow-Methods`.
- Raw HTTP test proving `HEAD /api/projects` with configured CORS origin includes `HEAD` in `Access-Control-Allow-Methods` and no body.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-096: CORS PUT Method Metadata

Issue: `ISS-20260527-096`

Scope:

- Advertise `PUT` in `Access-Control-Allow-Methods` for JSON API responses when CORS is enabled.
- Advertise `PUT` in `Access-Control-Allow-Methods` for `OPTIONS` preflight responses when CORS is enabled.
- Keep CORS method metadata aligned with existing `PUT` mutation routes such as edge config and routing rules.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `OPTIONS /api/projects` with configured CORS origin includes `PUT` in `Access-Control-Allow-Methods`.
- Raw HTTP test proving `HEAD /api/projects` with configured CORS origin includes the centralized allow-method metadata and no body.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-097: CORS Conditional Request Header Metadata

Issue: `ISS-20260527-097`

Scope:

- Advertise `Range` in `Access-Control-Allow-Headers` for browser static artifact range requests.
- Advertise `If-None-Match`, `If-Modified-Since`, `If-Match`, `If-Unmodified-Since`, and `If-Range` in `Access-Control-Allow-Headers` for browser cache revalidation and precondition requests.
- Keep CORS header metadata centralized so JSON responses and preflight responses do not diverge.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `OPTIONS /api/projects` with configured CORS origin includes conditional and range request headers in `Access-Control-Allow-Headers`.
- Raw HTTP test proving `HEAD /api/projects` with configured CORS origin includes the same centralized allow-header metadata and no body.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-098: CORS Response Header Exposure Metadata

Issue: `ISS-20260527-098`

Scope:

- Expose cache and range response headers such as `ETag`, `Last-Modified`, `Content-Range`, and `Accept-Ranges` when CORS is enabled.
- Expose navigation and control headers such as `Location`, `Retry-After`, and `Allow` when CORS is enabled.
- Expose `x-siteflow-*` deployment, routing, firewall, function, and image metadata headers for browser clients.
- Keep CORS metadata centralized so JSON responses and preflight responses do not diverge.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `OPTIONS /api/projects` with configured CORS origin includes exposed cache/range and SiteFlow metadata headers.
- Raw HTTP test proving `HEAD /api/projects` with configured CORS origin includes the same centralized expose-header metadata and no body.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-099: Static Artifact CORS Metadata

Issue: `ISS-20260527-099`

Scope:

- Apply centralized CORS metadata to static artifact file responses when CORS is enabled.
- Apply centralized CORS metadata to static artifact canonical redirects when CORS is enabled.
- Apply centralized CORS metadata to routing-rule redirects for artifact routes when CORS is enabled.
- Preserve existing static artifact cache, security, range, and `HEAD` behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving preview-host static artifact `GET` responses include `Access-Control-Allow-Origin` and exposed SiteFlow metadata headers.
- Raw HTTP test proving preview-host static artifact `HEAD` responses include CORS metadata and no body.
- Raw HTTP test proving static canonical redirects include CORS metadata and redirect headers.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-100: Image Optimization CORS Metadata

Issue: `ISS-20260527-100`

Scope:

- Apply centralized CORS metadata to optimized image responses when CORS is enabled.
- Preserve optimized image cache, ETag, `HEAD`, precondition, content disposition, and SiteFlow image metadata behavior.
- Cover artifact-backed and blob-backed optimized image sources.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP test proving artifact-backed optimized image `GET` responses include CORS metadata and exposed image headers.
- HTTP test proving artifact-backed optimized image `HEAD` responses include CORS metadata and no body.
- HTTP test proving blob-backed optimized image responses include CORS metadata and exposed image headers.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-101: Function Runtime CORS Metadata

Issue: `ISS-20260527-101`

Scope:

- Apply centralized CORS metadata to successful deployed function runtime responses when CORS is enabled.
- Preserve runtime-provided response headers and SiteFlow deployment/function/request metadata headers.
- Expose function response metadata headers to browser clients for cross-origin preview and dashboard workflows.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP test proving deployed API function responses include `Access-Control-Allow-Origin` when CORS is configured.
- HTTP test proving deployed API function responses expose `x-siteflow-deployment`, `x-siteflow-function`, and `x-siteflow-request-id`.
- Existing function invocation logging, request ID, and runtime header behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-102: CORS Preflight Cache Metadata

Issue: `ISS-20260527-102`

Scope:

- Advertise `Access-Control-Max-Age` on CORS preflight responses when CORS is enabled.
- Keep preflight cache metadata scoped to `OPTIONS` responses instead of ordinary `GET`, `HEAD`, or JSON responses.
- Preserve centralized CORS allow-method, allow-header, and expose-header metadata.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `OPTIONS /api/projects` includes `Access-Control-Max-Age`.
- Raw HTTP test proving a CORS-enabled `HEAD /api/projects` response does not include preflight-only cache metadata.
- Existing allow-method, allow-header, and expose-header CORS assertions remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-103: Static Canonical Redirect Query Preservation

Issue: `ISS-20260527-103`

Scope:

- Preserve the original query string on static artifact canonical redirects.
- Keep clean URL `.html` redirects and trailing slash policy redirects on the same 308 canonical response path.
- Preserve CORS metadata and `x-siteflow-static-redirect` headers for canonical redirects.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving a trailing slash canonical redirect keeps `?query` parameters in `Location`.
- Existing HTTP route tests proving clean URL canonical redirects, CORS redirect metadata, and static artifact serving remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-104: Routing Redirect Query Preservation

Issue: `ISS-20260527-104`

Scope:

- Preserve the original query string on project-level routing rule redirects.
- Preserve the original query string on artifact-local routing rule redirects.
- Keep existing redirect status, destination parameter substitution, CORS metadata, and `x-siteflow-redirect` headers intact.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving project-level routing redirects keep `?query` parameters in `Location`.
- HTTP route test proving artifact-local routing redirects keep `?query` parameters in `Location`.
- Existing rewrite, header, CORS redirect metadata, and static artifact tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-105: Routing Redirect URL Composition

Issue: `ISS-20260527-105`

Scope:

- Merge original request query strings into routing redirect destinations that already contain query parameters.
- Preserve routing redirect fragments after merged query parameters.
- Share redirect query composition between routing redirects and static canonical redirects.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving project-level routing redirects append original query parameters with `&` when the destination already has `?query`.
- HTTP route test proving artifact-local routing redirects preserve destination fragments after merged query parameters.
- Existing query preservation, rewrite, header, CORS redirect metadata, and static artifact tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-106: Function Runtime Successful HEAD Semantics

Issue: `ISS-20260527-106`

Scope:

- Cover successful deployed function `HEAD` invocations as bodyless metadata-only responses.
- Preserve runtime-provided response headers and SiteFlow deployment/function/request metadata headers.
- Record successful `HEAD` function invocations with the correct method, request ID, and response status.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving successful `HEAD /api/*` function responses keep headers and return no body.
- Test proving successful `HEAD` function invocation logs are recorded as succeeded with method `HEAD`.
- Existing function `GET` / `POST`, error `HEAD`, CORS metadata, and runtime logging tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-107: CORS Vary Origin Metadata

Issue: `ISS-20260527-107`

Scope:

- Add `Vary: Origin` to CORS-enabled responses so caches distinguish allowed-origin variants.
- Preserve and merge existing static artifact `Vary: accept-encoding` metadata.
- Preserve and merge existing image optimization `Vary: accept` metadata.
- Keep routing header `Vary` merge behavior intact.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving CORS-enabled JSON/preflight responses include `Vary: Origin`.
- Raw HTTP test proving CORS-enabled static artifact responses include both `Origin` and `accept-encoding` vary tokens.
- HTTP test proving CORS-enabled optimized image responses include both `Origin` and `accept` vary tokens.
- Existing CORS, static artifact, image optimization, and routing header merge tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-108: Static Conditional CORS Metadata

Issue: `ISS-20260527-108`

Scope:

- Cover static artifact conditional `304 Not Modified` responses with CORS metadata.
- Cover static artifact precondition `412 Precondition Failed` responses with CORS metadata.
- Cover static artifact invalid range `416 Range Not Satisfiable` responses with CORS metadata.
- Preserve bodyless conditional/range responses, validators, `Content-Range`, and `Vary: Origin` metadata.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP test proving CORS-enabled static `304` responses keep `Access-Control-Allow-Origin` and `Vary: Origin`.
- HTTP test proving CORS-enabled static `412` responses keep `Access-Control-Allow-Origin` and no body.
- HTTP test proving CORS-enabled static `416` responses keep `Access-Control-Allow-Origin`, `Vary: Origin`, and `Content-Range`.
- Existing static cache, range, CORS, and HEAD tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-109: Image Conditional CORS Metadata

Issue: `ISS-20260527-109`

Scope:

- Cover optimized image conditional `304 Not Modified` responses with CORS metadata.
- Cover optimized image precondition `412 Precondition Failed` responses with CORS metadata.
- Cover both artifact-backed and blob-backed optimized image sources.
- Preserve bodyless conditional responses, validators, and `Vary: accept, Origin` metadata.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP test proving CORS-enabled artifact-backed image `304` and `412` responses keep `Access-Control-Allow-Origin` and vary metadata.
- HTTP test proving CORS-enabled blob-backed image `304` and `412` responses keep `Access-Control-Allow-Origin` and vary metadata.
- Existing optimized image cache, precondition, HEAD, and CORS success tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-110: Function Runtime Vary Origin Merge

Issue: `ISS-20260527-110`

Scope:

- Preserve function runtime-provided `Vary` response tokens when centralized CORS metadata is applied.
- Merge `Origin` into function runtime responses without overwriting cache negotiation dimensions such as `accept-language`.
- Keep deployed function metadata, CORS exposure headers, body parsing, and invocation logging behavior intact.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP test proving a deployed API function response with `Vary: accept-language` keeps both `accept-language` and `Origin` when CORS is configured.
- Existing deployed function response metadata and invocation logging assertions remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-111: Function Runtime Set-Cookie Preservation

Issue: `ISS-20260527-111`

Scope:

- Preserve multiple function runtime `Set-Cookie` response headers as independent wire headers.
- Allow object-style function runtime response headers to include string arrays for multi-value headers.
- Keep ordinary runtime response headers, CORS metadata, `Vary` merging, body parsing, and invocation logging behavior intact.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving a deployed API function response returns two independent `Set-Cookie` headers.
- HTTP test proving ordinary runtime response metadata, CORS metadata, `Vary` merge behavior, and invocation logging still work.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-112: Function Runtime Web Response Set-Cookie

Issue: `ISS-20260527-112`

Scope:

- Cover deployed API functions that return a Web `Response` instance with multiple `Set-Cookie` headers.
- Preserve multiple `Set-Cookie` values as independent wire headers for Web `Response` results, not only object-style runtime results.
- Keep function metadata headers, response body forwarding, and invocation logging behavior intact.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving a Web `Response` function result returns two independent `Set-Cookie` headers.
- Test proves SiteFlow function metadata headers and invocation logs are still recorded.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-113: Function Runtime No Content Metadata

Issue: `ISS-20260527-113`

Scope:

- Cover successful deployed API functions that return `204 No Content`.
- Preserve runtime-provided metadata headers and SiteFlow function metadata headers on `204` responses.
- Keep `204` function responses bodyless and without `Content-Length`.
- Record successful invocation logs with response status `204`.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving a deployed API function `POST` returns `204`, preserves runtime and SiteFlow metadata headers, and has no body.
- Test proves invocation logging records `responseStatus: 204` as a successful invocation.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-114: Function Runtime Not Modified Metadata

Issue: `ISS-20260527-114`

Scope:

- Cover successful deployed API functions that return `304 Not Modified`.
- Preserve runtime-provided validator/cache headers and SiteFlow function metadata headers on `304` responses.
- Keep `304` function responses bodyless and without `Content-Length`.
- Record successful invocation logs with response status `304`.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving a deployed API function `GET` returns `304`, preserves ETag/cache metadata and SiteFlow metadata headers, and has no body.
- Test proves invocation logging records `responseStatus: 304` as a successful invocation.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-115: Function Runtime Bodyless Status Coercion

Issue: `ISS-20260527-115`

Scope:

- Treat object-style function runtime results with no-body statuses as metadata-only responses even when a body field is present.
- Normalize `204`, `205`, and `304` object-style runtime responses to `Response(null, ...)` before forwarding.
- Preserve runtime headers, SiteFlow metadata, and invocation logging instead of surfacing a `500` from the Fetch `Response` constructor.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving an object-style function result with `status: 204` and a body field still returns `204`, preserves metadata, and has no body.
- Existing `304`, HEAD, cookie, CORS, and invocation logging tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-116: Function Runtime CORS Expose Header Merge

Issue: `ISS-20260527-116`

Scope:

- Preserve function runtime-provided `Access-Control-Expose-Headers` values when centralized CORS metadata is applied.
- Merge runtime custom exposed headers with platform SiteFlow/cache/range exposed headers without duplicates.
- Keep CORS `Vary: Origin`, function metadata, cookies, and invocation logging behavior intact.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP test proving a deployed API function response with `Access-Control-Expose-Headers: x-runtime-cache` keeps `x-runtime-cache` plus SiteFlow metadata expose headers when CORS is configured.
- Existing static/image CORS expose header tests and function CORS metadata tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-117: Function Runtime CORS Allow Metadata Merge

Issue: `ISS-20260527-117`

Scope:

- Preserve function runtime-provided `Access-Control-Allow-Headers` values when centralized CORS metadata is applied.
- Preserve function runtime-provided `Access-Control-Allow-Methods` values when centralized CORS metadata is applied.
- Merge runtime custom allow metadata with platform allow headers and methods without duplicates.
- Keep CORS expose header merging, `Vary: Origin`, function metadata, cookies, and invocation logging behavior intact.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP test proving a deployed API function response with custom allow headers/methods keeps those values plus platform allow metadata when CORS is configured.
- Existing preflight and JSON CORS allow metadata tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-118: Forwarded Header Chain Canonicalization

Issue: `ISS-20260527-118`

Scope:

- Canonicalize comma-separated proxy header chains by using the first `X-Forwarded-Host` token for artifact routing, image optimization routing, and function runtime request URL construction.
- Canonicalize comma-separated `X-Forwarded-Proto` chains by using the first token for function runtime request URL construction and deploy hook URL generation.
- Reuse the same first-token handling for `X-Forwarded-For` IP and bucket-key fallback parsing.
- Preserve existing single-value forwarded header behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP test proving a deployed API function request with `X-Forwarded-Host: preview, proxy` still routes to the preview host and exposes the runtime request origin from the first host/proto token.
- Existing artifact, image, firewall, and function routing tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-119: Deploy Hook Forwarded Chain URL

Issue: `ISS-20260527-119`

Scope:

- Cover deploy hook creation behind reverse proxies that send comma-separated `X-Forwarded-Host` and `X-Forwarded-Proto` chains.
- Ensure generated deploy hook trigger URLs use the first forwarded host/proto token rather than the internal server base URL.
- Preserve deploy hook create/list/revoke behavior and authorization semantics.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP test proving deploy hook creation with `X-Forwarded-Host: public, internal` and `X-Forwarded-Proto: https, http` returns a public `https://public/.../trigger` hook URL.
- Existing deploy hook list/revoke and management auth assertions remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-120: Image Forwarded Chain Host

Issue: `ISS-20260527-120`

Scope:

- Cover image optimization artifact routing behind reverse proxies that send comma-separated `X-Forwarded-Host` chains.
- Ensure `_siteflow/image` uses the first forwarded host token when resolving the artifact route.
- Preserve existing artifact and blob image optimization behavior, cache metadata, and conditional request semantics.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP test proving `_siteflow/image` with `X-Forwarded-Host: preview, internal` still resolves the public preview host and returns an artifact image response.
- Existing artifact/blob image cache, HEAD, CORS, and precondition assertions remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-121: Static Artifact Forwarded Chain Host

Issue: `ISS-20260527-121`

Scope:

- Cover static artifact routing behind reverse proxies that send comma-separated `X-Forwarded-Host` chains.
- Ensure artifact preview routes use the first forwarded host token when resolving deployment artifacts.
- Preserve deployed HTML response behavior and deployment metadata headers.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP test proving a static artifact request with `X-Forwarded-Host: preview, internal` still resolves the public preview host and returns the deployed HTML.
- Existing static artifact cache, CORS, range, redirect, and precompressed response assertions remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-045: Static Artifact Byte Range Responses

Issue: `ISS-20260527-045`

Scope:

- Support HTTP byte range requests for static artifact responses.
- Advertise `Accept-Ranges: bytes` on static artifact responses.
- Return `206 Partial Content` with `Content-Range` and partial bytes for valid single ranges.
- Support suffix byte ranges for media/download use cases.
- Return `416 Range Not Satisfiable` with `Content-Range: bytes */size` for invalid ranges.
- Keep `HEAD`, ETag, cache-control, routing, and rollout headers compatible with range handling.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving valid single ranges return `206` and the requested bytes.
- HTTP route test proving suffix ranges return the expected trailing bytes.
- HTTP route test proving invalid ranges return `416`.
- HTTP route test proving `HEAD` keeps full-resource headers without a body.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-046: Static Artifact Last-Modified Revalidation

Issue: `ISS-20260527-046`

Scope:

- Add `Last-Modified` headers to static artifact responses.
- Support `If-Modified-Since` conditional requests for static artifacts.
- Return `304 Not Modified` when the static file mtime is not newer than `If-Modified-Since`.
- Keep `If-None-Match` precedence over `If-Modified-Since`, matching HTTP conditional request semantics.
- Preserve ETag, cache-control, range, HEAD, routing, and rollout behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving static artifact responses include `Last-Modified`.
- HTTP route test proving matching `If-Modified-Since` returns `304`.
- HTTP route test proving mismatched `If-None-Match` prevents `If-Modified-Since` from forcing `304`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-047: Precompressed Static Artifact Negotiation

Issue: `ISS-20260527-047`

Scope:

- Serve precompressed static artifact files when `.br` or `.gz` variants exist beside the original file.
- Prefer Brotli over gzip when both are accepted.
- Set `Content-Encoding` and `Vary: accept-encoding` for encoded static responses.
- Preserve the original file content type, cache-control, and Last-Modified semantics.
- Keep byte range requests on the uncompressed representation to avoid unsafe compressed range semantics.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `Accept-Encoding: br` serves the `.br` artifact with `Content-Encoding: br`.
- HTTP route test proving gzip fallback serves the `.gz` artifact.
- HTTP route test proving range requests bypass precompressed variants and return unencoded partial bytes.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-048: Source Build Artifact Precompression

Issue: `ISS-20260527-048`

Scope:

- Generate `.br` and `.gz` variants for compressible source-built static artifacts.
- Skip function bundles and existing `.br` / `.gz` files.
- Preserve artifact checksum and file-count determinism by including generated variants.
- Persist precompressed variant counts in artifact manifest metadata.

Suggested files:

- `worker/artifactPublisher.ts`
- `worker/buildWorker.test.ts`

Verification:

- Worker test proving source-built `index.html` emits decomposable `.br` and `.gz` variants.
- Worker test proving artifact manifest metadata records precompressed variant counts.
- Worker test proving function bundle extra files are not precompressed.
- Worker/server/CLI/app type checks.
- Full test suite and production build.

## Task VP-049: Prebuilt Deploy Artifact Precompression

Issue: `ISS-20260527-049`

Scope:

- Generate `.br` and `.gz` variants for compressible static files during CLI prebuilt packaging.
- Skip `.siteflow/functions/` files and existing `.br` / `.gz` variants.
- Upload generated variants with correct size and SHA-256 metadata so server-side artifact verification remains authoritative.
- Record precompressed variant counts in prebuilt deployment artifact manifest metadata.
- Reuse the existing runtime precompressed static artifact negotiation path.

Suggested files:

- `cli/deploy.ts`
- `cli/siteflowCli.test.ts`
- `server/postgresReadRepository.ts`
- `server/postgresReadRepository.test.ts`

Verification:

- CLI test proving prebuilt uploads include decomposable `.br` and `.gz` variants for compressible files.
- Repository test proving prebuilt artifact manifest metadata records precompressed variant counts.
- Repository test proving function bundle files are not counted as static precompressed variants.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-050: Accept-Encoding Quality Negotiation

Issue: `ISS-20260527-050`

Scope:

- Parse `Accept-Encoding` quality values for precompressed static artifact negotiation.
- Respect `q=0` as an explicit refusal for `br` or `gzip`.
- Prefer the available encoding with the highest accepted quality.
- Preserve Brotli preference when Brotli and gzip have equal quality.
- Keep range requests on the uncompressed representation.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving gzip is selected when it has higher `q` than Brotli.
- HTTP route test proving `br;q=0` disables Brotli and falls back to gzip.
- Existing HTTP route tests proving same-quality Brotli preference and range bypass remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-051: Static Artifact Method Semantics

Issue: `ISS-20260527-051`

Scope:

- Return `405 Method Not Allowed` for static artifact routes when the request method is not `GET` or `HEAD`.
- Set `Allow: GET, HEAD` on rejected static artifact method responses.
- Keep `/api/*` function method handling independent from static artifact method handling.
- Preserve canonical redirects, rewrites, firewall checks, and static artifact `GET` / `HEAD` behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `POST` to a static artifact returns `405` with `Allow: GET, HEAD`.
- Existing HTTP route tests proving static `GET`, static `HEAD`, cache headers, ranges, and precompressed negotiation remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-052: Private Function Bundle Static Guard

Issue: `ISS-20260527-052`

Scope:

- Prevent `.siteflow/functions/` artifact files from being served through static artifact routes.
- Keep function bundle files available to the runtime function loader for `/api/*` invocation.
- Preserve normal static artifact fallback behavior for public files.
- Return a not-found response instead of exposing internal function source or include files.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving direct requests to `.siteflow/functions/*` return `404`.
- HTTP route test proving normal public static artifact serving still works in the same deployment.
- Existing function invocation tests remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-053: Static Artifact Default Security Headers

Issue: `ISS-20260527-053`

Scope:

- Add conservative default security headers to static artifact responses.
- Set `X-Content-Type-Options: nosniff` for static artifact responses.
- Set `Referrer-Policy: strict-origin-when-cross-origin` for static artifact responses.
- Let artifact-local or project routing header rules override the defaults.
- Preserve cache, ETag, Last-Modified, range, precompressed negotiation, and routing behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving HTML and fingerprinted static assets receive the default security headers.
- HTTP route test proving routing header rules can override a default security header.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-054: Static Directory Request Guard

Issue: `ISS-20260527-054`

Scope:

- Return `404` for directory-style static artifact requests when the directory has no `index.html`.
- Prevent directory requests such as `/assets/` from falling back to the deployment entrypoint.
- Preserve `/` entrypoint behavior and directory `index.html` serving when an index file exists.
- Preserve clean URL, trailing slash, cache, range, and precompressed behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `/assets/` returns `404` when `assets/index.html` is absent.
- Existing HTTP route tests proving `/`, directory `index.html`, clean URL, and trailing slash behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-055: Static Artifact If-Range Support

Issue: `ISS-20260527-055`

Scope:

- Support `If-Range` for static artifact byte range requests.
- Return `206 Partial Content` when `If-Range` matches the current ETag or Last-Modified validator.
- Ignore the `Range` header and return the full `200 OK` response when `If-Range` does not match.
- Preserve existing single-range, suffix range, invalid range, HEAD, cache, ETag, and Last-Modified behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving matching ETag `If-Range` returns partial content.
- HTTP route test proving matching date `If-Range` returns partial content.
- HTTP route test proving mismatched `If-Range` ignores the range and returns full content.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-056: Static Artifact Vary Header Merge

Issue: `ISS-20260527-056`

Scope:

- Merge routing header rules for `Vary` with the static artifact default `Vary: accept-encoding`.
- Deduplicate `Vary` tokens case-insensitively while preserving deterministic response headers.
- Keep routing header rules able to override all non-`Vary` static response headers.
- Preserve precompressed negotiation, cache, ETag, Last-Modified, range, security headers, rewrites, and project/artifact routing behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving artifact-local routing metadata can add a custom `Vary` token without dropping `accept-encoding`.
- Existing HTTP route tests proving static precompression, security header overrides, cache headers, ranges, and routing behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-057: Static Artifact Precondition Requests

Issue: `ISS-20260527-057`

Scope:

- Support `If-Match` preconditions for static artifact responses.
- Support `If-Unmodified-Since` preconditions for static artifact responses.
- Return `412 Precondition Failed` when a static artifact precondition fails.
- Evaluate failed preconditions before `If-None-Match` / `If-Modified-Since` revalidation and before range handling.
- Preserve weak ETag generation, cache headers, Last-Modified, HEAD, range, precompressed negotiation, security headers, and routing behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving a matching weak ETag does not satisfy `If-Match` strong comparison and returns `412`.
- HTTP route test proving `If-Match: *` passes for an existing static artifact.
- HTTP route test proving stale `If-Unmodified-Since` returns `412`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-058: Accept-Encoding Wildcard Negotiation

Issue: `ISS-20260527-058`

Scope:

- Cover `Accept-Encoding` wildcard negotiation for precompressed static artifacts.
- Preserve Brotli preference when wildcard quality makes Brotli and gzip equally acceptable.
- Ensure explicit encoding refusal such as `br;q=0` overrides wildcard acceptance.
- Keep range requests on the uncompressed representation.
- Preserve explicit quality negotiation, cache headers, `Vary`, ETag, Last-Modified, and routing behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `Accept-Encoding: *` selects the Brotli precompressed variant when available.
- HTTP route test proving `Accept-Encoding: *, br;q=0` falls back to gzip.
- Existing HTTP route tests proving explicit q-values, range bypass, and cache headers remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-059: Static Conditional HEAD Semantics

Issue: `ISS-20260527-059`

Scope:

- Cover static artifact `HEAD` responses for conditional cache revalidation.
- Preserve validator and cache headers on `HEAD` responses that return `304 Not Modified`.
- Cover static artifact `HEAD` responses for failed preconditions.
- Preserve validator and cache headers on `HEAD` responses that return `412 Precondition Failed`.
- Ensure conditional `HEAD` responses return no response body.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `HEAD` with matching `If-None-Match` returns `304` with validator headers and no body.
- HTTP route test proving `HEAD` with stale `If-Unmodified-Since` returns `412` with validator headers and no body.
- Existing HTTP route tests proving static `GET`, static `HEAD`, 304, 412, range, and precompressed behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-060: Precompressed Static Revalidation Headers

Issue: `ISS-20260527-060`

Scope:

- Cover conditional revalidation for precompressed static artifact responses.
- Preserve `Content-Encoding` on `304 Not Modified` responses for an encoded representation.
- Preserve `Vary: accept-encoding` on encoded `304 Not Modified` responses.
- Preserve representation-specific ETags for encoded static artifact responses.
- Ensure encoded `304 Not Modified` responses return no response body.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving Brotli static artifacts return `304` with `Content-Encoding: br`, `Vary: accept-encoding`, matching ETag, and no body when revalidated by `If-None-Match`.
- Existing HTTP route tests proving precompressed `200`, wildcard negotiation, range bypass, and cache behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-061: Precompressed Static HEAD Headers

Issue: `ISS-20260527-061`

Scope:

- Cover `HEAD` responses for precompressed static artifact representations.
- Preserve `Content-Encoding` on encoded `HEAD` responses.
- Preserve encoded representation `Content-Length` on encoded `HEAD` responses.
- Preserve `Vary: accept-encoding` on encoded `HEAD` responses.
- Ensure encoded `HEAD` responses return no response body.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving Brotli `HEAD` responses include `Content-Encoding: br`, compressed `Content-Length`, `Vary: accept-encoding`, and no body.
- Existing HTTP route tests proving precompressed `GET`, `304`, wildcard negotiation, range bypass, and cache behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-062: Static If-None-Match Weak Comparison

Issue: `ISS-20260527-062`

Scope:

- Use weak ETag comparison for static artifact `If-None-Match` revalidation.
- Treat strong and weak forms of the same opaque ETag as matching for `GET` / `HEAD` cache validation.
- Preserve strong comparison semantics for `If-Match` preconditions.
- Preserve `If-Modified-Since` precedence behavior when `If-None-Match` is present.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `If-None-Match` with the strong form of SiteFlow's weak static ETag returns `304`.
- Existing HTTP route tests proving exact weak ETag revalidation, `If-Match` preconditions, Last-Modified revalidation, range handling, and precompressed behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-063: Static If-None-Match Multi-Value Revalidation

Issue: `ISS-20260527-063`

Scope:

- Cover static artifact `If-None-Match` headers containing multiple ETags.
- Return `304 Not Modified` when any listed ETag matches the current static artifact validator.
- Preserve existing mismatch behavior when no listed ETag matches.
- Preserve weak comparison behavior for each listed ETag.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `If-None-Match: W/"old", <current>` returns `304`.
- Existing HTTP route tests proving exact weak ETag revalidation, strong-form weak comparison, mismatched ETag behavior, `If-Match` preconditions, and precompressed behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-064: Static If-Match Multi-Value Preconditions

Issue: `ISS-20260527-064`

Scope:

- Cover static artifact `If-Match` headers containing multiple ETags.
- Preserve strong comparison semantics for every listed ETag.
- Return `412 Precondition Failed` when no listed ETag strongly matches the current static artifact validator.
- Allow `If-Match` lists containing `*` to pass for an existing static artifact.
- Preserve weak `If-None-Match` revalidation behavior, cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `If-Match: W/"old", <weak-current>` returns `412`.
- HTTP route test proving `If-Match: W/"old", *` passes for an existing static artifact.
- Existing HTTP route tests proving `If-Match: *`, single weak `If-Match`, `If-None-Match`, and precompressed behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-065: Static If-Unmodified-Since Invalid Date

Issue: `ISS-20260527-065`

Scope:

- Cover static artifact `If-Unmodified-Since` headers with invalid HTTP-date values.
- Ignore invalid `If-Unmodified-Since` dates instead of failing the precondition.
- Preserve stale valid `If-Unmodified-Since` behavior returning `412 Precondition Failed`.
- Preserve `If-Match` precedence over `If-Unmodified-Since`.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `If-Unmodified-Since: not-a-date` returns the normal `200` static artifact response.
- Existing HTTP route tests proving stale valid `If-Unmodified-Since`, `If-Match`, `If-None-Match`, and precompressed behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-066: Static If-Modified-Since Invalid Date

Issue: `ISS-20260527-066`

Scope:

- Cover static artifact `If-Modified-Since` headers with invalid HTTP-date values.
- Ignore invalid `If-Modified-Since` dates instead of returning `304 Not Modified`.
- Preserve valid `If-Modified-Since` revalidation behavior returning `304`.
- Preserve `If-None-Match` precedence over `If-Modified-Since`.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `If-Modified-Since: not-a-date` returns the normal `200` static artifact response.
- Existing HTTP route tests proving valid `If-Modified-Since`, `If-None-Match`, preconditions, and precompressed behavior remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-067: Static If-Range Strong ETag Semantics

Issue: `ISS-20260527-067`

Scope:

- Use strong ETag comparison for static artifact `If-Range` validators.
- Prevent weak static ETags from allowing byte range responses through `If-Range`.
- Return the full `200 OK` response when `If-Range` contains a weak ETag validator.
- Preserve HTTP-date `If-Range` behavior for Last-Modified validators.
- Preserve range parsing, suffix ranges, invalid range handling, precompressed range bypass, cache headers, and HEAD behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `If-Range` with SiteFlow's weak static ETag returns full `200 OK` instead of `206 Partial Content`.
- Existing HTTP route tests proving matching `If-Range` date, mismatched `If-Range`, normal ranges, invalid ranges, and precompressed range bypass remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-068: Static Empty Status Content-Length Guard

Issue: `ISS-20260527-068`

Scope:

- Normalize static artifact responses that must not send a message body.
- Remove `Content-Length` from static `304 Not Modified`, `412 Precondition Failed`, and `416 Range Not Satisfiable` responses.
- Prevent route headers or future response changes from leaking stale body length metadata onto no-body static responses.
- Preserve successful `200 OK`, `206 Partial Content`, and `HEAD` content length behavior where a representation length is expected.
- Preserve conditional request handling, range handling, cache headers, precompressed negotiation, and routing behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route tests proving static `304`, `412`, and `416` responses omit `Content-Length`.
- Existing HTTP route tests proving `200`, `206`, and `HEAD` responses still expose expected lengths.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-069: Static Conditional Range Precedence

Issue: `ISS-20260527-069`

Scope:

- Cover static artifact requests that combine conditional validators with byte ranges.
- Ensure matching cache validators return `304 Not Modified` before evaluating invalid `Range` headers.
- Ensure failed preconditions return `412 Precondition Failed` before evaluating invalid `Range` headers.
- Prevent conditional no-body responses from leaking `Content-Range` or `Content-Length`.
- Preserve normal invalid range behavior returning `416 Range Not Satisfiable`.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving `If-None-Match` plus invalid `Range` returns `304` without range headers.
- HTTP route test proving failed `If-Match` plus invalid `Range` returns `412` without range headers.
- Existing HTTP route tests proving normal ranges, invalid ranges, `If-Range`, HEAD behavior, and no-body `Content-Length` handling remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-070: Image Optimization ETag Revalidation

Issue: `ISS-20260527-070`

Scope:

- Add conditional cache revalidation to `_siteflow/image` optimized image responses.
- Reuse the stable image cache key ETag for `If-None-Match` comparisons.
- Return `304 Not Modified` with validator and cache metadata when the optimized image ETag matches.
- Ensure image `304` responses do not include `Content-Length` or a response body.
- Preserve optimized image `200 OK`, `HEAD`, blob source, metadata, and safety validation behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving optimized artifact images return `304` for matching `If-None-Match`.
- HTTP route test proving optimized image `HEAD` with matching `If-None-Match` returns `304` with no body.
- Existing HTTP route tests proving normal optimized image responses, blob images, metadata enforcement, and unsafe parameter rejection remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-071: Image Optimization Content-Length Semantics

Issue: `ISS-20260527-071`

Scope:

- Add explicit `Content-Length` to optimized image `200 OK` responses.
- Preserve `Content-Length` on optimized image `HEAD` responses where the representation length is expected.
- Keep optimized image `304 Not Modified` responses bodyless and without `Content-Length`.
- Preserve image cache metadata, ETag revalidation, artifact source behavior, blob source behavior, and safety validation behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving optimized image `GET` returns the source byte length.
- HTTP route test proving optimized image `HEAD` returns the same byte length with no body.
- Existing HTTP route tests proving optimized image `304` removes `Content-Length`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-072: Image Optimization If-None-Match Variants

Issue: `ISS-20260527-072`

Scope:

- Cover optimized image `If-None-Match` variants beyond exact ETag matching.
- Return `304 Not Modified` for weak-form optimized image ETags.
- Return `304 Not Modified` when any ETag in a multi-value `If-None-Match` header matches.
- Return `304 Not Modified` for `If-None-Match: *` on an existing optimized image response.
- Preserve image `Content-Length` semantics for `200` / `HEAD` and no-body semantics for `304`.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving weak-form optimized image validators return `304`.
- HTTP route test proving multi-value optimized image validators return `304`.
- HTTP route test proving wildcard optimized image validators return `304`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-073: Image Optimization If-Match Preconditions

Issue: `ISS-20260527-073`

Scope:

- Add `If-Match` precondition handling to optimized image responses.
- Return `412 Precondition Failed` when no listed `If-Match` validator strongly matches the optimized image ETag.
- Preserve `If-Match: *` success for existing optimized image responses.
- Ensure failed preconditions take precedence over matching `If-None-Match` revalidation.
- Keep failed precondition responses bodyless and without `Content-Length`.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving mismatched optimized image `If-Match` returns `412`.
- HTTP route test proving mismatched `If-Match` plus matching `If-None-Match` returns `412`.
- HTTP route test proving optimized image `If-Match: *` returns normal `200`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-074: Image Optimization If-Match Strong Comparison

Issue: `ISS-20260527-074`

Scope:

- Cover optimized image `If-Match` strong comparison behavior.
- Ensure weak-form optimized image validators do not satisfy `If-Match`.
- Ensure multi-value `If-Match` lists pass when one listed validator strongly matches the optimized image ETag.
- Ensure multi-value `If-Match` lists fail when they only contain mismatched and weak validators.
- Preserve optimized image cache revalidation, `Content-Length`, and no-body precondition response behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving weak-form optimized image `If-Match` returns `412`.
- HTTP route test proving a multi-value optimized image `If-Match` with a strong match returns `200`.
- HTTP route test proving a multi-value optimized image `If-Match` with only weak/mismatched validators returns `412`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-075: Image Optimization Last-Modified Revalidation

Issue: `ISS-20260527-075`

Scope:

- Add `Last-Modified` metadata to optimized image responses.
- Use artifact file mtime and blob `updatedAt` as optimized image modification validators.
- Return `304 Not Modified` for fresh optimized image `If-Modified-Since` requests.
- Ignore invalid optimized image `If-Modified-Since` dates.
- Preserve `If-None-Match` precedence over `If-Modified-Since`, image `If-Match` preconditions, `Content-Length`, and no-body response semantics.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving optimized image responses expose `Last-Modified`.
- HTTP route test proving optimized image `If-Modified-Since` returns `304`.
- HTTP route test proving invalid optimized image `If-Modified-Since` returns normal `200`.
- HTTP route test proving mismatched `If-None-Match` prevents date-only revalidation.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-076: Image Optimization If-Unmodified-Since Preconditions

Issue: `ISS-20260527-076`

Scope:

- Add `If-Unmodified-Since` precondition handling to optimized image responses.
- Return `412 Precondition Failed` when the optimized image source has changed after the supplied date.
- Ignore invalid optimized image `If-Unmodified-Since` dates.
- Preserve `If-Match` precedence over `If-Unmodified-Since`.
- Keep failed precondition responses bodyless and without `Content-Length`.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- HTTP route test proving stale optimized image `If-Unmodified-Since` returns `412`.
- HTTP route test proving invalid optimized image `If-Unmodified-Since` returns normal `200`.
- HTTP route test proving matching `If-Match` makes stale `If-Unmodified-Since` irrelevant.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-077: Image Optimization Conditional HEAD Preconditions

Issue: `ISS-20260527-077`

Scope:

- Cover optimized image `HEAD` requests that fail conditional preconditions.
- Return `412 Precondition Failed` for stale optimized image `HEAD` preconditions.
- Preserve validator and cache metadata on optimized image `HEAD` precondition failures.
- Keep optimized image `HEAD` precondition failures bodyless and without `Content-Length`.
- Preserve existing optimized image `HEAD` `200` and `304` behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving optimized image `HEAD` with stale `If-Unmodified-Since` returns `412`.
- HTTP route test proving the `412` retains the optimized image ETag.
- Existing optimized image tests proving `HEAD 200`, `HEAD 304`, and `Content-Length` semantics remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-078: Blob Image Optimization Last-Modified Revalidation

Issue: `ISS-20260527-078`

Scope:

- Cover optimized image `Last-Modified` behavior for blob-backed image sources.
- Use blob `updatedAt` as the optimized image `Last-Modified` response header.
- Return `304 Not Modified` for blob optimized image `If-Modified-Since` requests.
- Keep blob image revalidation responses bodyless and without `Content-Length`.
- Preserve artifact image conditional request behavior and blob source metadata behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving blob optimized image responses expose `Last-Modified` from blob `updatedAt`.
- HTTP route test proving blob optimized image `If-Modified-Since` returns `304`.
- Existing optimized image tests proving artifact image `Last-Modified`, ETag, preconditions, and blob source metadata remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-079: Blob Image Optimization If-Unmodified-Since Preconditions

Issue: `ISS-20260527-079`

Scope:

- Cover blob-backed optimized image `If-Unmodified-Since` precondition behavior.
- Use blob `updatedAt` as the comparison timestamp for stale preconditions.
- Return `412 Precondition Failed` for stale blob optimized image preconditions.
- Keep failed blob precondition responses bodyless and without `Content-Length`.
- Preserve blob optimized image `Last-Modified` revalidation and source metadata behavior.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving blob optimized image stale `If-Unmodified-Since` returns `412`.
- HTTP route test proving the `412` retains the blob-derived `Last-Modified` header.
- Existing optimized image tests proving blob `If-Modified-Since`, artifact preconditions, and image metadata remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-080: Image Optimization SVG Allow Security Headers

Issue: `ISS-20260527-080`

Scope:

- Cover optimized image responses when SVG sources are explicitly allowed.
- Preserve `dangerouslyAllowSVG` rejection behavior when SVG is not allowed.
- Return the SVG source with `image/svg+xml` content type when SVG is allowed.
- Apply configured `contentDispositionType` to allowed SVG responses.
- Apply configured image `contentSecurityPolicy` to allowed SVG responses.

Suggested files:

- `server/httpServer.test.ts`

Verification:

- HTTP route test proving disallowed SVG optimization still returns `400`.
- HTTP route test proving allowed SVG optimization returns `200` with `image/svg+xml`.
- HTTP route test proving allowed SVG optimization carries configured `Content-Disposition` and `Content-Security-Policy`.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-081: JSON HEAD Error Body Semantics

Issue: `ISS-20260527-081`

Scope:

- Ensure JSON error responses for `HEAD` requests do not send a response body.
- Preserve JSON content type and status codes for `HEAD` error responses.
- Apply the no-body behavior to image optimization input errors surfaced through the shared server error handler.
- Preserve `GET` JSON error responses and existing API behavior.
- Preserve optimized image success and conditional request behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving optimized image `HEAD` with invalid input returns `400`.
- Raw HTTP test proving the `HEAD` error response has JSON content type, no `Content-Length`, and zero body bytes.
- Existing image optimization unsafe parameter tests proving `GET` errors still return JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-082: API Not Found HEAD Body Semantics

Issue: `ISS-20260527-082`

Scope:

- Apply shared JSON `HEAD` no-body behavior to generic API not-found responses.
- Pass request method through the API `notFound` fallback path.
- Return `404` and JSON content type for `HEAD` not-found responses.
- Omit `Content-Length` and response body bytes for `HEAD` not-found responses.
- Preserve existing `GET` not-found JSON behavior and image optimization `HEAD` error behavior.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD /missing-route` returns `404`.
- Raw HTTP test proving the `HEAD` not-found response has JSON content type, no `Content-Length`, and zero body bytes.
- Existing repository not-found tests proving `GET` 404 JSON bodies remain intact.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-083: Function Route HEAD Error Body Semantics

Issue: `ISS-20260527-083`

Scope:

- Apply shared JSON `HEAD` no-body behavior to deployed function route errors.
- Pass request method through function route not-found and method-not-allowed responses.
- Return `404` with JSON content type and no body for missing deployed function `HEAD` requests.
- Return `405` with `Allow` and JSON content type but no body for disallowed deployed function `HEAD` requests.
- Preserve function invocation behavior for valid methods.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD /api/missing` on an artifact host returns `404`.
- Raw HTTP test proving `HEAD /api/revalidate` with methods limited to `GET` returns `405` and `Allow: GET`.
- Raw HTTP assertions proving both `HEAD` function route errors omit `Content-Length` and response body bytes.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-084: Function Invocation HEAD Error Body Semantics

Issue: `ISS-20260527-084`

Scope:

- Apply shared JSON `HEAD` no-body behavior to deployed function invocation errors.
- Pass request method through function concurrency-limit, memory-limit, and runtime failure responses.
- Preserve `Retry-After` metadata on `HEAD` concurrency-limit responses.
- Preserve function invocation logging for `HEAD` failures.
- Preserve existing `GET` function error JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD` runtime function failures return `500` with JSON content type and no body.
- Raw HTTP test proving `HEAD` concurrency guard failures return `429`, `Retry-After: 1`, JSON content type, and no body.
- Raw HTTP test proving `HEAD` memory guard failures return `507` with JSON content type and no body.
- Existing `GET` timeout, concurrency, and memory tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-085: Firewall HEAD Error Body Semantics

Issue: `ISS-20260527-085`

Scope:

- Apply shared JSON `HEAD` no-body behavior to artifact firewall rejections.
- Pass request method through firewall block and challenge responses.
- Preserve `x-siteflow-firewall` metadata on bodyless `HEAD` block responses.
- Preserve `x-siteflow-firewall` metadata on bodyless `HEAD` challenge responses.
- Preserve existing `GET` firewall rejection JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD` firewall block responses return `403`, JSON content type, firewall rule header, and no body.
- Raw HTTP test proving `HEAD` firewall challenge responses return `403`, JSON content type, firewall rule header, and no body.
- Existing `GET` firewall tests continue to parse JSON bodies and record evaluation inputs.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-086: Read-Only Control Plane HEAD Semantics

Issue: `ISS-20260527-086`

Scope:

- Treat `HEAD /healthz` as the metadata-only equivalent of `GET /healthz`.
- Treat `HEAD /api/auth/verify` as the metadata-only equivalent of `GET /api/auth/verify`.
- Pass request method through auth verification success responses.
- Pass request method through auth mutation failure responses.
- Preserve existing `GET` health and auth verify JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD /healthz` returns `200`, JSON content type, and no body.
- Raw HTTP test proving authenticated `HEAD /api/auth/verify` returns `200`, JSON content type, and no body.
- Raw HTTP test proving unauthenticated `HEAD /api/auth/verify` returns `401`, JSON content type, and no body.
- Existing `GET` health and auth verify tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-087: Deployment Read HEAD Semantics

Issue: `ISS-20260527-087`

Scope:

- Treat `HEAD /api/deployments` as the metadata-only equivalent of `GET /api/deployments`.
- Treat `HEAD /api/deployments/:id` as the metadata-only equivalent of `GET /api/deployments/:id`.
- Treat `HEAD /api/deployments/:id/logs` as the metadata-only equivalent of `GET /api/deployments/:id/logs`.
- Pass request method through deployment read responses.
- Preserve existing `GET` deployment inventory, detail, and log JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD /api/deployments?projectId=...` returns `200`, JSON content type, and no body.
- Raw HTTP test proving `HEAD /api/deployments/:id` returns `200`, JSON content type, and no body.
- Raw HTTP test proving `HEAD /api/deployments/:id/logs` returns `200`, JSON content type, and no body.
- Existing `GET` deployment inventory test continues to parse JSON body.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-088: Project Read HEAD Semantics

Issue: `ISS-20260527-088`

Scope:

- Treat `HEAD /api/projects` as the metadata-only equivalent of `GET /api/projects`.
- Treat `HEAD /api/projects/:id` as the metadata-only equivalent of `GET /api/projects/:id`.
- Treat `HEAD /api/projects/:id/settings` as the metadata-only equivalent of `GET /api/projects/:id/settings`.
- Pass request method through project read responses.
- Preserve bodyless auth failures for protected project settings `HEAD` requests.
- Preserve existing `GET` project JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD /api/projects` returns `200`, JSON content type, and no body.
- Raw HTTP test proving `HEAD /api/projects/:id` returns `200`, JSON content type, and no body.
- Raw HTTP test proving authorized `HEAD /api/projects/:id/settings` returns `200`, JSON content type, and no body.
- Raw HTTP test proving unauthorized `HEAD /api/projects/:id/settings` returns `401`, JSON content type, and no body.
- Existing `GET` project and settings tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-089: Project Observability Read HEAD Semantics

Issue: `ISS-20260527-089`

Scope:

- Treat `HEAD /api/projects/:id/environments` as the metadata-only equivalent of `GET /api/projects/:id/environments`.
- Treat `HEAD /api/projects/:id/analytics` as the metadata-only equivalent of `GET /api/projects/:id/analytics`.
- Treat `HEAD /api/projects/:id/logs` as the metadata-only equivalent of `GET /api/projects/:id/logs`.
- Pass request method through project observability read responses.
- Preserve existing `GET` environments, analytics, and logs JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving `HEAD /api/projects/:id/environments` returns `200`, JSON content type, and no body.
- Raw HTTP test proving `HEAD /api/projects/:id/analytics` returns `200`, JSON content type, and no body.
- Raw HTTP test proving `HEAD /api/projects/:id/logs?...` returns `200`, JSON content type, and no body.
- Existing `GET` observability tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-090: Project Resource Read HEAD Semantics

Issue: `ISS-20260527-090`

Scope:

- Treat `HEAD /api/projects/:id/log-queries` as the metadata-only equivalent of `GET /api/projects/:id/log-queries`.
- Treat `HEAD /api/projects/:id/log-drains` as the metadata-only equivalent of `GET /api/projects/:id/log-drains`.
- Treat `HEAD /api/projects/:id/firewall-rules` as the metadata-only equivalent of `GET /api/projects/:id/firewall-rules`.
- Treat `HEAD /api/projects/:id/edge-config` as the metadata-only equivalent of `GET /api/projects/:id/edge-config`.
- Pass request method through protected project resource read responses.
- Preserve bodyless auth failures for protected project resource `HEAD` requests.
- Preserve existing `GET` resource JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving authorized `HEAD` log query, log drain, firewall rule, and edge config reads return `200`, JSON content type, and no body.
- Raw HTTP test proving unauthorized `HEAD /api/projects/:id/edge-config` returns `401`, JSON content type, and no body.
- Existing `GET` resource tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-091: Blob and Cache Read HEAD Semantics

Issue: `ISS-20260527-091`

Scope:

- Treat `HEAD /api/projects/:id/blobs` as the metadata-only equivalent of `GET /api/projects/:id/blobs`.
- Treat `HEAD /api/projects/:id/blobs/:pathname` as the metadata-only equivalent of `GET /api/projects/:id/blobs/:pathname`.
- Treat `HEAD /api/projects/:id/cache` as the metadata-only equivalent of `GET /api/projects/:id/cache`.
- Pass request method through blob and cache read responses.
- Preserve bodyless auth failures for protected blob/cache `HEAD` requests.
- Preserve existing `GET` blob and cache JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving authorized `HEAD` blob list, blob read, and cache list requests return `200`, JSON content type, and no body.
- Raw HTTP test proving unauthorized `HEAD /api/projects/:id/blobs` returns `401`, JSON content type, and no body.
- Existing `GET` blob and cache tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.

## Task VP-092: Function and Routing Read HEAD Semantics

Issue: `ISS-20260527-092`

Scope:

- Treat `HEAD /api/projects/:id/functions` as the metadata-only equivalent of `GET /api/projects/:id/functions`.
- Treat `HEAD /api/projects/:id/functions/:path` as the metadata-only equivalent of `GET /api/projects/:id/functions/:path`.
- Treat `HEAD /api/projects/:id/routing-rules` as the metadata-only equivalent of `GET /api/projects/:id/routing-rules`.
- Treat `HEAD /api/projects/:id/routing-rules/match` as the metadata-only equivalent of `GET /api/projects/:id/routing-rules/match`.
- Pass request method through function and routing read responses.
- Preserve existing `GET` function and routing JSON bodies.

Suggested files:

- `server/httpServer.ts`
- `server/httpServer.test.ts`

Verification:

- Raw HTTP test proving authorized `HEAD` function list, function runtime, routing rule list, and routing match requests return `200`, JSON content type, and no body.
- Existing `GET` function and routing tests continue to parse JSON bodies.
- Server/worker/CLI/app type checks.
- Full test suite and production build.
