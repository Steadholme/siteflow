# VP-018 Functions Runtime Controls

Issue: `ISS-20260527-018`

Completed at: `2026-05-27T17:32:12+08:00`

## Scope

- Added function runtime limit metadata for timeout, memory, and concurrency on deployment manifest entrypoints.
- Added runtime summary read models with invocation count, error count, error rate, and duration statistics.
- Added project API routes:
  - `GET /api/projects/:projectId/functions`
  - `GET /api/projects/:projectId/functions/:path`
- Added SDK, HTTP client, fixture client, and CLI support:
  - `siteflow functions list`
  - `siteflow functions inspect <path>`
- Added Postgres-backed function inspection using deployment manifest entries and recent function invocation rows.

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
  - 4 files, 102 tests passed.
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm test -- --run`
  - 18 files, 164 tests passed.
- `npm run build`

## Notes

- This slice exposes runtime configuration and telemetry inspection. Actual runtime enforcement can build on the same manifest limit fields.
- `tasks.md` currently ends at VP-018, so the next iteration should add a new Vercel parity task batch before execution.
