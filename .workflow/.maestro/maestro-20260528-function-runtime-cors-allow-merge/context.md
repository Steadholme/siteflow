# VP-117 Function Runtime CORS Allow Metadata Merge

## Summary

- Merged existing `Access-Control-Allow-Headers` values with centralized platform CORS allow-header metadata.
- Merged existing `Access-Control-Allow-Methods` values with centralized platform CORS allow-method metadata.
- Extended deployed function runtime coverage to assert runtime custom allow header and method values remain visible alongside platform defaults.

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
