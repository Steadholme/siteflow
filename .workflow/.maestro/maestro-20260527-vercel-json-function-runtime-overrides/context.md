# VP-031 vercel.json Function Runtime Overrides

## Purpose

Import supported Vercel function runtime settings from `vercel.json` into SiteFlow source-built API function metadata.

## Changes

- Parsed `vercel.json.functions` from the resolved source project root.
- Matched function config patterns against detected `api/` function files.
- Mapped `maxDuration` to `timeoutMs`, `memory` to `memoryMb`, and `concurrency` to `concurrency`.
- Persisted those fields through `publishBuildArtifact` into the artifact manifest.
- Added worker coverage proving the metadata is present for detected API functions.

## Verification

- `npm test -- --run worker/buildWorker.test.ts server/httpServer.test.ts` passed with 50 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npm test -- --run` passed with 189 tests.
- `npm run build` passed.
