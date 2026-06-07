# VP-103 Static Canonical Redirect Query Preservation

## Summary

- Preserved original query strings on static artifact canonical redirects.
- Kept clean URL `.html` redirects and trailing slash policy redirects on the existing 308 canonical response path.
- Extended clean URL/trailing slash coverage to assert redirect `Location` keeps query parameters.

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
