# VP-007 Rolling Release Execution

Completed at: 2026-05-26T04:27:28+08:00

## Scope

- Added rolling release domain/read-model contracts.
- Added `siteflow_rolling_releases` persistence and Postgres repository operations:
  - start
  - advance
  - complete
  - abort
  - active rollout read model
- Added deterministic request bucketing in artifact route resolution.
- Kept production route unchanged during active rollout; `complete` applies the candidate deployment to production routes and release channel state.
- Added artifact serving headers for rollout diagnostics:
  - `x-siteflow-deployment`
  - `x-siteflow-rollout`
  - `x-siteflow-traffic-target`
- Added rolling management HTTP routes:
  - `GET /api/projects/:projectId/rolling/:channel`
  - `POST /api/projects/:projectId/rolling/:channel/start`
  - `POST /api/projects/:projectId/rolling/:channel/advance`
  - `POST /api/projects/:projectId/rolling/:channel/complete`
  - `POST /api/projects/:projectId/rolling/:channel/abort`
- Added HTTP client and fixture client rolling release methods.
- Added CLI commands:
  - `siteflow rolling start <deploymentId> --percentage <n>`
  - `siteflow rolling advance --percentage <n>`
  - `siteflow rolling complete`
  - `siteflow rolling abort`

## Files

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
- `src/lib/api/siteflowClient.test.ts`
- `.workflow/issues/issues.jsonl`
- `.workflow/state.json`

## Verification

- `npx tsc --noEmit -p tsconfig.json`
- `npm run build:server`
- `npm run build:cli`
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts worker/buildWorker.test.ts`
- `npm run build`

## Notes

- Rolling release traffic selection lives in `resolveArtifactRoute(host, bucketKey)`, so control-plane release routes remain explicit and auditable.
- The bucket key prefers `x-siteflow-bucket-key`, then `x-forwarded-for`, then socket/user-agent fallback.
- Active rollout requests return current or candidate artifacts without mutating production route state.
- `complete` updates `siteflow_artifact_routes` and `siteflow_release_channels`; `abort` preserves the current route.
