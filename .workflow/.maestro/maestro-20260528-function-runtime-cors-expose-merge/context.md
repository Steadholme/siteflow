# VP-116 Function Runtime CORS Expose Header Merge

## Summary

- Merged existing `Access-Control-Expose-Headers` values with centralized platform CORS expose metadata.
- Preserved function runtime custom exposed headers while still exposing SiteFlow/cache/range metadata.
- Extended deployed function runtime coverage to assert `x-runtime-cache` remains exposed alongside SiteFlow metadata headers.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 65 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 223 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
