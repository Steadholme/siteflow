# VP-029 Build Skip Command

## Purpose

Support Vercel-compatible `ignoreCommand` for source builds so unchanged work can be skipped without recording a failed build.

## Changes

- Added `ignoreCommand` to project build settings and `vercel.json` build setting detection.
- Added `skipped` as a first-class build job status, including database migration and read-model/UI status handling.
- Executed allowlisted ignore commands before install/build in the worker.
- Added worker behavior for skip-on-zero and continue-on-nonzero.
- Added Postgres queue persistence for skipped jobs with redacted reasons.

## Verification

- `npm test -- --run worker/buildWorker.test.ts worker/postgresBuildQueue.test.ts src/domain/status.test.ts src/features/deployments/deployments.test.tsx src/features/projects/projects.test.tsx` passed with 25 tests.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npm test -- --run` passed with 186 tests.
- `npm run build` passed.
