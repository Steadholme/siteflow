# VP-027 vercel.json Cron Import

## Purpose

Import Vercel-compatible `crons` entries from `vercel.json` into SiteFlow project cron jobs during prebuilt deploy.

## Changes

- Added prebuilt cron contracts to `src/lib/api/deployContracts.ts`.
- Extended `cli/deploy.ts` to parse `vercel.json.crons` and include them in the prebuilt deploy payload.
- Extended `server/postgresReadRepository.ts` to upsert imported cron jobs inside the prebuilt deploy transaction.
- Added/updated coverage in CLI, HTTP API, and Postgres repository tests.

## Verification

- `npm test -- --run cli/siteflowCli.test.ts server/httpServer.test.ts server/postgresReadRepository.test.ts` passed with 71 tests.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npm test -- --run` passed with 181 tests.
- `npm run build` passed.
