# VP-093 Release Operations Read HEAD Semantics

## Summary

- Allowed `HEAD /api/projects/:id/deploy-hooks` to hit the same route as `GET /api/projects/:id/deploy-hooks`.
- Allowed `HEAD /api/projects/:id/cron-jobs` to hit the same route as `GET /api/projects/:id/cron-jobs`.
- Allowed `HEAD /api/projects/:id/rolling/:channel` to hit the same route as `GET /api/projects/:id/rolling/:channel`.
- Allowed `HEAD /api/projects/:id/release/:channel` to hit the same route as `GET /api/projects/:id/release/:channel`.
- Allowed `HEAD /api/projects/:id/rollback/:channel` to hit the same route as `GET /api/projects/:id/rollback/:channel`.
- Threaded `request.method` through release operations read JSON responses.
- Added raw HTTP coverage for bodyless authorized, public, and unauthorized release operations reads.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 58 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 216 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
