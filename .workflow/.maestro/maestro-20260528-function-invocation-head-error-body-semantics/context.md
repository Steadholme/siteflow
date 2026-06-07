# VP-084 Function Invocation HEAD Error Body Semantics

## Summary

- Updated function invocation JSON error responses to pass `requestMethod` into `sendJson`.
- Covered `HEAD` runtime failure responses with bodyless `500` JSON metadata.
- Covered `HEAD` concurrency guard responses with bodyless `429` JSON metadata and preserved `Retry-After: 1`.
- Covered `HEAD` memory guard responses with bodyless `507` JSON metadata.
- Verified invocation records still capture `HEAD` methods and response statuses.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 49 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 207 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
