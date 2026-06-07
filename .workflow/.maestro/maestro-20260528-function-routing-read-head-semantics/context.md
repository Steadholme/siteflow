# VP-092 Function and Routing Read HEAD Semantics

## Summary

- Allowed `HEAD /api/projects/:id/functions` to hit the same route as `GET /api/projects/:id/functions`.
- Allowed `HEAD /api/projects/:id/functions/:path` to hit the same route as `GET /api/projects/:id/functions/:path`.
- Allowed `HEAD /api/projects/:id/routing-rules` to hit the same route as `GET /api/projects/:id/routing-rules`.
- Allowed `HEAD /api/projects/:id/routing-rules/match` to hit the same route as `GET /api/projects/:id/routing-rules/match`.
- Threaded `request.method` through function and routing read JSON responses.
- Added raw HTTP coverage for bodyless authorized function and routing reads.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 57 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 215 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
