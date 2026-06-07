# VP-030 Source Build vercel.json App Config Import

## Purpose

Make Git/source builds inherit Vercel-compatible app configuration that prebuilt deploys already import.

## Changes

- Added worker-side parsing for source project `vercel.json` app config.
- Persisted `cleanUrls` and `trailingSlash` into source build artifact metadata.
- Carried imported `crons` through the build result.
- Upserted imported source build cron jobs during Postgres build completion.
- Added worker and Postgres queue tests for metadata and cron import.

## Verification

- `npm test -- --run worker/buildWorker.test.ts worker/postgresBuildQueue.test.ts server/httpServer.test.ts` passed with 51 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npm test -- --run` passed with 188 tests.
- `npm run build` passed.
