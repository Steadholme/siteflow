# VP-095 CORS HEAD Method Metadata

## Summary

- Centralized CORS method metadata in `server/httpServer.ts`.
- Added `HEAD` to `Access-Control-Allow-Methods` for JSON API responses when CORS is enabled.
- Added `HEAD` to `Access-Control-Allow-Methods` for `OPTIONS` preflight responses when CORS is enabled.
- Added raw HTTP coverage for preflight and `HEAD` response CORS method metadata.

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
