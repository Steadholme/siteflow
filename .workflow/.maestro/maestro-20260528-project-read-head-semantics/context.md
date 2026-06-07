# VP-088 Project Read HEAD Semantics

## Summary

- Allowed `HEAD /api/projects` to hit the same route as `GET /api/projects`.
- Allowed `HEAD /api/projects/:id` to hit the same route as `GET /api/projects/:id`.
- Allowed `HEAD /api/projects/:id/settings` to hit the same route as `GET /api/projects/:id/settings`.
- Threaded `request.method` through project read JSON responses.
- Added raw HTTP coverage for bodyless project list, detail, authorized settings, and unauthorized settings responses.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 53 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 211 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
