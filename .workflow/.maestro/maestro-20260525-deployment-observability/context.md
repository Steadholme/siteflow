# VP-005 Deployment Observability Execution

Completed at: 2026-05-26T02:26:30+08:00

## Scope

- Added deployment inventory read model contract and API/client support.
- Added `GET /api/deployments` with optional `projectId` filtering.
- Added real Postgres deployment list fallback from `siteflow_deployments`, `siteflow_projects`, and latest route revision state.
- Added real Postgres deployment inspect fallback that composes project, source event, build job, artifact, deployment, route evidence, and logs.
- Added prebuilt deployment inspect fallback for deployments without Git source/build rows.
- Added CLI management commands:
  - `siteflow deployments`
  - `siteflow inspect <deploymentId>`
- Kept fixture clients and test-only client doubles aligned with the expanded `SiteFlowClient` interface.

## Files

- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `src/lib/api/httpClient.test.ts`
- `src/lib/api/siteflowClient.test.ts`
- `server/readRepository.ts`
- `server/httpServer.ts`
- `server/httpServer.test.ts`
- `server/postgresReadRepository.ts`
- `cli/siteflowCli.ts`
- `cli/siteflowCli.test.ts`
- `src/test/consoleSmoke.test.tsx`
- `src/features/projects/projects.test.tsx`
- `.workflow/issues/issues.jsonl`
- `.workflow/state.json`

## Verification

- `npm run build:server`
- `npm run build:cli`
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts worker/buildWorker.test.ts`
- `npm run build`

## Notes

- `GET /api/deployments/:id` still prefers fixture read models when present, then falls back to real Postgres rows.
- Prebuilt deployments do not have source/build rows, so inspect uses deterministic synthetic `manual` source and `siteflow-prebuilt` build lineage.
- No real Postgres integration test harness exists yet; repository SQL behavior is protected by TypeScript compilation and exposed HTTP/CLI contract tests.
