# VP-099 Static Artifact CORS Metadata

## Summary

- Applied centralized CORS headers to static artifact file responses when `allowedOrigin` is configured.
- Applied centralized CORS headers to static artifact canonical redirects.
- Applied centralized CORS headers to artifact routing-rule redirects.
- Added raw HTTP coverage for preview-host static artifact `GET`, `HEAD`, and canonical redirect responses.

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
