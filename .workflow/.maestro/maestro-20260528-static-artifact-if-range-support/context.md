# VP-055: Static Artifact If-Range Support

Issue: `ISS-20260527-055`
Artifact: `EXC-063`
Depends on: `EXC-062`
Status: completed

## Scope

- Support `If-Range` for static artifact byte range requests.
- Return `206 Partial Content` when `If-Range` matches the current ETag or Last-Modified validator.
- Ignore the `Range` header and return the full `200 OK` response when `If-Range` does not match.
- Preserve existing single-range, suffix range, invalid range, HEAD, cache, ETag, and Last-Modified behavior.

## Implementation

- Added `requestIfRangeMatches` in `server/httpServer.ts`.
- Matched `If-Range` against the current static artifact ETag.
- Matched HTTP-date `If-Range` values against the static artifact source mtime at second precision.
- Ignored range parsing when `If-Range` is present but does not match, returning the normal full response.
- Extended static range tests in `server/httpServer.test.ts` for matching ETag, matching date, and mismatched ETag behavior.

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
