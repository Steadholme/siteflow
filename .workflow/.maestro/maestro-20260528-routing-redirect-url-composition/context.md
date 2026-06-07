# VP-105 Routing Redirect URL Composition

## Summary

- Added shared redirect query composition for routing redirects and static canonical redirects.
- Merged original request query strings with redirect destinations that already contain query parameters using `&`.
- Preserved redirect fragments after merged query parameters for project-level and artifact-local routing redirects.

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
