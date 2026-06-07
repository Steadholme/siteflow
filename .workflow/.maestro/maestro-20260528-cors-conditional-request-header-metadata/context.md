# VP-097 CORS Conditional Request Header Metadata

## Summary

- Centralized CORS allow-header metadata in `server/httpServer.ts`.
- Added `range` to allow browser static artifact range requests.
- Added `if-none-match`, `if-modified-since`, `if-match`, `if-unmodified-since`, and `if-range` to allow browser revalidation and precondition requests.
- Extended raw HTTP coverage to assert preflight and CORS-enabled `HEAD` responses share the same allow-header metadata.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 60 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 218 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
