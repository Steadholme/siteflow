# Function Runtime Memory Guardrails

Date: 2026-05-27
Issue: `ISS-20260527-026`
Artifact: `EXC-034`

## Objective

Continue Vercel parity by making function `memoryMb` configuration observable in runtime behavior, while staying honest about the current in-process runtime model.

## Implemented

- Added a pre-invocation memory guard in `server/httpServer.ts`.
- Uses current process RSS compared with `entry.memoryMb`, defaulting to 512 MB.
- Rejects invocation before loading user function code if the guard is exceeded.
- Returns HTTP 507 with a stable `requestId`.
- Records a failed function invocation with memory-limit logs.
- Preserves timeout, concurrency, runtime environment, and log redaction behavior.
- Added HTTP coverage proving the guard rejects invocation and skips module loading.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 38 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npm test -- --run` passed: 19 files, 180 tests.
- `npm run build` passed.

## Notes

- This is a guardrail, not strict memory isolation. A true Vercel-grade function runtime still needs worker-thread or process-level sandboxing for hard memory enforcement and cancellation.
