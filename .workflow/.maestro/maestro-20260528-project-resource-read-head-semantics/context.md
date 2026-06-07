# VP-090 Project Resource Read HEAD Semantics

## Summary

- Allowed `HEAD /api/projects/:id/log-queries` to hit the same route as `GET /api/projects/:id/log-queries`.
- Allowed `HEAD /api/projects/:id/log-drains` to hit the same route as `GET /api/projects/:id/log-drains`.
- Allowed `HEAD /api/projects/:id/firewall-rules` to hit the same route as `GET /api/projects/:id/firewall-rules`.
- Allowed `HEAD /api/projects/:id/edge-config` to hit the same route as `GET /api/projects/:id/edge-config`.
- Threaded `request.method` through protected project resource JSON responses.
- Added raw HTTP coverage for bodyless authorized resource reads and bodyless unauthorized edge config reads.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 55 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 213 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
