# Function Runtime Environment Injection

Date: 2026-05-27
Issue: `ISS-20260527-024`
Artifact: `EXC-032`

## Objective

Continue Vercel parity by making runtime-scope environment variables available to deployed API function handlers while preserving secret redaction and process environment isolation.

## Implemented

- Added `src/lib/environmentTarget.ts` to share branch-to-environment targeting.
- Extended `ArtifactRoute` with `runtimeEnvironment`.
- Updated `server/postgresReadRepository.ts` route resolution to load runtime-scope sealed variables:
  - project domain channel is preferred when available
  - otherwise production branch maps to `production`, all other branches map to `preview`
- Decrypts sealed runtime values only for the function invocation route path.
- Updated `server/httpServer.ts` to inject runtime values into:
  - `process.env`
  - handler `context.env`
- Restores previous `process.env` values after each invocation.
- Adds runtime values to function log redaction patterns before recording invocation logs.
- Added HTTP coverage for runtime env injection, redaction, and restoration.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 35 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npm test -- --run` passed: 19 files, 177 tests.
- `npm run build` passed.

## Notes

- Runtime env injection currently uses process-level mutation around the function call. It is restored immediately after invocation, but true concurrent isolation should move to worker threads or another function sandbox model in a later task.
