# VP-006 CLI Parity And VP-008 Deploy Hooks Execution

Completed at: 2026-05-26T03:31:00+08:00

## Scope

- Added local project link metadata at `.siteflow/project.json`.
- Added `siteflow link`.
- Added `siteflow env pull` with metadata-only `.env` placeholders; secret values are not returned by the control plane.
- Added `siteflow deploy --prod` by chaining prebuilt deployment with the production promote API.
- Added `siteflow promote` and `siteflow rollback` release commands.
- Added `siteflow deploy-hook create/list/revoke`.
- Added persisted deploy hook resources:
  - Token hashes only in Postgres.
  - One-time visible create token and hook URL.
  - No full token exposure in list/revoke responses.
  - Revocation state.
  - Persistent hook event audit records for create, trigger, and revoke.
- Added unauthenticated deploy hook trigger route that validates the hook token and queues a source build job.
- Fixed `HttpSiteFlowClient.rollbackDeployment` to call `/api/projects/:projectId/rollback/:channel/rollback`.

## Files

- `cli/projectLink.ts`
- `cli/siteflowCli.ts`
- `cli/siteflowCli.test.ts`
- `server/migrations.ts`
- `server/readRepository.ts`
- `server/httpServer.ts`
- `server/httpServer.test.ts`
- `server/postgresReadRepository.ts`
- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/httpClient.test.ts`
- `src/lib/api/fixtureClient.ts`
- `.workflow/issues/issues.jsonl`
- `.workflow/state.json`

## Verification

- `npm run build:cli`
- `npm run build:server`
- `npm test -- --run cli/siteflowCli.test.ts server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts worker/buildWorker.test.ts`
- `npm run build`

## Notes

- Deploy hook trigger uses `provider = generic` source events and writes queued `siteflow_build_jobs`.
- Deploy hook trigger bypasses normal management bearer auth intentionally; the hook token hash is the capability check.
- Repeated trigger idempotency keys are scoped by hook id before writing `siteflow_source_events(provider, provider_delivery_id)`.
- Deploy hook event audit data never stores the raw hook token.
