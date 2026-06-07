# VP-091 Blob and Cache Read HEAD Semantics

## Summary

- Allowed `HEAD /api/projects/:id/blobs` to hit the same route as `GET /api/projects/:id/blobs`.
- Allowed `HEAD /api/projects/:id/blobs/:pathname` to hit the same route as `GET /api/projects/:id/blobs/:pathname`.
- Allowed `HEAD /api/projects/:id/cache` to hit the same route as `GET /api/projects/:id/cache`.
- Threaded `request.method` through blob and cache read JSON responses.
- Added raw HTTP coverage for bodyless authorized blob/cache reads and bodyless unauthorized blob list reads.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 56 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 214 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
