# VP-083 Function Route HEAD Error Body Semantics

## Summary

- Updated deployed function route `404` and `405` JSON responses to pass `request.method` into `sendJson`.
- Added raw HTTP coverage for artifact-hosted `HEAD` function route errors.
- Verified missing function routes return `404` with JSON content type, no `Content-Length`, and zero body bytes.
- Verified disallowed function methods return `405`, retain `Allow: GET`, and omit response bodies for `HEAD`.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 48 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 206 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
