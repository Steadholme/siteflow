# VP-004 Production Route State Execution

Completed at: 2026-05-26T01:42:40+08:00

## Scope

- Persisted project production/staging/preview domain bindings.
- Added route revision and release channel state tables.
- Made promote/rollback idempotent release commands create route revisions.
- Applied production/staging/preview hostnames to `siteflow_artifact_routes` so existing artifact serving can route custom domains.
- Bound HTTP release routes to URL `projectId` and `channel` instead of trusting body values.

## Files

- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `server/httpServer.test.ts`
- `src/domain/readModels.ts`
- `src/lib/api/fixtureClient.ts`
- `.workflow/issues/issues.jsonl`
- `.workflow/state.json`

## Verification

- `npm run build:server`
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts worker/buildWorker.test.ts`
- `npm run build`

## Notes

- `siteflow_deployments` still does not store `entrypoint`; production route apply derives it from the deployment preview route or artifact manifest.
- No real Postgres integration test harness exists yet, so repository behavior is verified by TypeScript compilation and HTTP contract tests for exposed API behavior.
