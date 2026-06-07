# VP-102 CORS Preflight Cache Metadata

## Summary

- Added preflight-only `Access-Control-Max-Age` metadata to CORS `OPTIONS` responses.
- Kept the header scoped to preflight handling so ordinary CORS-enabled `HEAD` responses do not include preflight cache metadata.
- Preserved centralized CORS allow-method, allow-header, and expose-header behavior.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 61 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 219 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
