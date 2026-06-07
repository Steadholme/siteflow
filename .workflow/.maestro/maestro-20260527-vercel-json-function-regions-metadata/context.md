# VP-034 vercel.json Function Regions Metadata

## Purpose

Persist Vercel-compatible function region intent from `vercel.json` into SiteFlow source-built function metadata.

## Changes

- Parsed project-level `regions` and `functionFailoverRegions` from `vercel.json`.
- Parsed function-level `functions.*.regions` and `functions.*.functionFailoverRegions` overrides.
- Added `regions` and `failoverRegions` fields to `FunctionEntrypoint`.
- Persisted region metadata through `publishBuildArtifact` into artifact manifest functions.
- Preserved region metadata when Postgres read models reconstruct function entries from manifests.
- Exposed region metadata in CLI function list and inspect output.
- Kept runtime scheduling behavior unchanged; this records deployment intent for the current single-host runtime.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed with 14 tests.
- `npm test -- --run worker/buildWorker.test.ts server/postgresReadRepository.test.ts cli/siteflowCli.test.ts` passed with 48 tests.
- `npm test -- --run worker/buildWorker.test.ts server/httpServer.test.ts server/postgresReadRepository.test.ts cli/siteflowCli.test.ts` passed with 87 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 192 tests.
- `npm run build` passed.
