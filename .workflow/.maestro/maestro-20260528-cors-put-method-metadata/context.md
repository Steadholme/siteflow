# VP-096 CORS PUT Method Metadata

## Summary

- Added `PUT` to centralized CORS method metadata in `server/httpServer.ts`.
- Kept JSON API responses and `OPTIONS` preflight responses on the same allow-method list.
- Extended raw HTTP coverage to assert both `HEAD` and `PUT` are advertised when CORS is enabled.

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
