# VP-057: Static Artifact Precondition Requests

Issue: `ISS-20260527-057`
Artifact: `EXC-065`
Depends on: `EXC-064`
Status: completed

## Scope

- Support `If-Match` preconditions for static artifact responses.
- Support `If-Unmodified-Since` preconditions for static artifact responses.
- Return `412 Precondition Failed` when a static artifact precondition fails.
- Evaluate failed preconditions before `If-None-Match` / `If-Modified-Since` revalidation and before range handling.
- Preserve weak ETag generation, cache headers, Last-Modified, HEAD, range, precompressed negotiation, security headers, and routing behavior.

## Implementation

- Added static precondition helpers in `server/httpServer.ts`.
- Implemented strong `If-Match` comparison semantics without changing SiteFlow's existing weak static ETags.
- Implemented `If-Match: *` support for existing static artifacts.
- Implemented `If-Unmodified-Since` timestamp checks, ignored invalid dates, and gave `If-Match` precedence when both headers are present.
- Inserted precondition failure handling before 304 revalidation and range parsing.
- Extended the static cache/revalidation HTTP test in `server/httpServer.test.ts`.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 46 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 204 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test runs are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
