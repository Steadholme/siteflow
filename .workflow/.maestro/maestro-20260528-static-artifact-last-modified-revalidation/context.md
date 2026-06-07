# VP-046: Static Artifact Last-Modified Revalidation

Issue: `ISS-20260527-046`
Artifact: `EXC-054`
Depends on: `EXC-053`
Status: completed

## Scope

- Add `Last-Modified` headers to static artifact responses.
- Support `If-Modified-Since` conditional requests for static artifacts.
- Return `304 Not Modified` when the static file mtime is not newer than `If-Modified-Since`.
- Keep `If-None-Match` precedence over `If-Modified-Since`.
- Preserve ETag, cache-control, range, HEAD, routing, and rollout behavior.

## Implementation

- Added `Last-Modified` from static artifact file mtime in `server/httpServer.ts`.
- Added `If-Modified-Since` parsing and second-level mtime comparison.
- Kept `If-None-Match` as the stronger validator, so mismatched ETags do not return `304` from modified-since.
- Reused the existing static cache/ETag test coverage to verify modified-since behavior and validator precedence.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 44 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 201 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test run are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
