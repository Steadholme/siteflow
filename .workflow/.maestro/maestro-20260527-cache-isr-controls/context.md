# VP-017 Cache And ISR Controls

Issue: `ISS-20260527-017`

Completed at: `2026-05-27T17:03:52+08:00`

## Scope

- Added project cache entry domain/read-model contracts with path, tags, status, ETag, max-age, and stale-while-revalidate metadata.
- Added Postgres persistence for cache entries.
- Added project API routes:
  - `GET /api/projects/:projectId/cache`
  - `POST /api/projects/:projectId/cache/purge`
- Added SDK, HTTP client, fixture client, and CLI support:
  - `siteflow cache list`
  - `siteflow cache purge --path /path`
  - `siteflow cache purge --tag tag`
- Added `cache.purged` audit events for manual invalidation.

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
  - 4 files, 98 tests passed.
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm test -- --run`
  - 18 files, 160 tests passed.
- `npm run build`

## Notes

- This slice implements control-plane metadata and invalidation. Runtime cache population can build on `siteflow_cache_entries` without changing the API contract.
- Next planned issue remains `ISS-20260527-018` Functions runtime controls.
