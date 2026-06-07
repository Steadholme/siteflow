# Function Runtime Limit Enforcement

Date: 2026-05-27
Issue: `ISS-20260527-025`
Artifact: `EXC-033`

## Objective

Continue Vercel parity by making function runtime control metadata affect actual `/api/*` invocation behavior.

## Implemented

- Added in-process function concurrency tracking keyed by deployment and function path.
- Enforced `entry.concurrency`, defaulting to 50.
- Returns HTTP 429 with `Retry-After: 1` when concurrency is exceeded.
- Enforced `entry.timeoutMs`, defaulting to 10000 ms.
- Returns HTTP 504 when the configured timeout is exceeded.
- Records timeout and concurrency failures as function invocations with failed status.
- Preserved runtime environment injection, handler context, response headers, routing headers, and log redaction.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 37 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npm test -- --run` passed: 19 files, 179 tests.
- `npm run build` passed.

## Notes

- Memory limits are still metadata-only. Enforcing memory robustly needs a real sandbox or worker-thread/process isolation task.
- Timeout cannot cancel arbitrary user code running in the same process; it controls the SiteFlow response and recorded invocation. A later sandbox task should add hard cancellation.
