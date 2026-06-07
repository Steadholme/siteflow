# VP-107 CORS Vary Origin Metadata

## Summary

- Added `Vary: Origin` to centralized CORS responses.
- Preserved static artifact `Vary: accept-encoding` by merging it with existing CORS vary metadata.
- Preserved image optimization `Vary: accept` by merging it with existing CORS vary metadata.
- Extended coverage for JSON/preflight CORS responses, static artifact responses, and optimized image responses.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 62 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 220 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
