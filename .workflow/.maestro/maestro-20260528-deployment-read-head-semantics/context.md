# VP-087 Deployment Read HEAD Semantics

## Summary

- Allowed `HEAD /api/deployments` to hit the same route as `GET /api/deployments`.
- Allowed `HEAD /api/deployments/:id` to hit the same route as `GET /api/deployments/:id`.
- Allowed `HEAD /api/deployments/:id/logs` to hit the same route as `GET /api/deployments/:id/logs`.
- Threaded `request.method` through deployment read JSON responses.
- Added raw HTTP coverage proving all three `HEAD` responses preserve JSON metadata and omit body bytes.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 52 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 210 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
