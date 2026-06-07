# VP-044: Static Asset Cache Semantics

Issue: `ISS-20260527-044`
Artifact: `EXC-052`
Depends on: `EXC-051`
Status: completed

## Scope

- Apply Vercel-like cache headers to static artifact responses.
- Serve HTML and mutable text metadata files with `max-age=0, must-revalidate`.
- Serve fingerprinted static assets with long-lived immutable cache headers.
- Serve non-fingerprinted static assets with bounded browser cache headers.
- Generate deployment-scoped weak ETags for static artifact files.
- Return `304 Not Modified` when `If-None-Match` matches.

## Implementation

- Added static cache-control selection in `server/httpServer.ts`.
- Added deployment/path/body based weak ETag generation for static artifact responses.
- Added `If-None-Match` parsing and `304` handling before response body writes.
- Preserved routing headers, deployment headers, HEAD handling, and rollout headers.
- Added HTTP coverage for HTML revalidation, fingerprinted immutable assets, ETags, HEAD, and conditional 304 responses.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 43 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 200 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test run are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
