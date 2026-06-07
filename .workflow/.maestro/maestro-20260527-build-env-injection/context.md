# Build Environment Variable Injection

Date: 2026-05-27
Issue: `ISS-20260527-022`
Artifact: `EXC-030`

## Objective

Continue Vercel parity by making project build-scope environment variables available to source builds while keeping secret values out of API responses, CLI output, UI models, and build logs.

## Implemented

- Updated `server/postgresReadRepository.ts` so sealed environment variable values are persisted for worker use.
- Kept environment variable read models metadata-only; `listEnvironmentVariables` still does not select `sealed_value`.
- Updated `worker/postgresBuildQueue.ts` to load build-scope sealed variables for the target build environment:
  - production branch -> `production`
  - other branches -> `preview`
- Added `environmentVariables` to queued build jobs.
- Updated `worker/buildWorker.ts` to inject environment variables into install/build subprocesses.
- Added injected-value redaction patterns so build logs redact exact environment variable values.
- Added worker coverage proving build scripts can read injected env values and logs do not leak them.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed: 7 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npm test -- --run` passed: 18 files, 173 tests.
- `npm run build` passed.

## Notes

- Raw environment values are intentionally only exposed to the worker queue path.
- The current storage is still a self-hosted sealed placeholder rather than real encryption; a later hardening task should replace this with encrypted-at-rest secret handling.
