# VP-086 Read-Only Control Plane HEAD Semantics

## Summary

- Allowed `HEAD /healthz` to hit the same route as `GET /healthz`.
- Allowed `HEAD /api/auth/verify` to hit the same route as `GET /api/auth/verify`.
- Threaded `request.method` through auth verification success responses and auth failure responses.
- Added raw HTTP coverage for bodyless `HEAD` health, authenticated auth verify, and unauthenticated auth verify responses.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 51 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 209 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
