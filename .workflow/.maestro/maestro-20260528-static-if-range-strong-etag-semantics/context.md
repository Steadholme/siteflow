# VP-067: Static If-Range Strong ETag Semantics

Issue: `ISS-20260527-067`
Artifact: `EXC-075`
Depends on: `EXC-074`
Status: completed

## Scope

- Use strong ETag comparison for static artifact `If-Range` validators.
- Prevent weak static ETags from allowing byte range responses through `If-Range`.
- Return the full `200 OK` response when `If-Range` contains a weak ETag validator.
- Preserve HTTP-date `If-Range` behavior for Last-Modified validators.
- Preserve range parsing, suffix ranges, invalid range handling, precompressed range bypass, cache headers, and HEAD behavior.

## Implementation

- Updated `requestIfRangeMatches` in `server/httpServer.ts` to use `strongEtagMatches` for ETag validators.
- Kept HTTP-date `If-Range` matching unchanged.
- Updated the static byte range HTTP test in `server/httpServer.test.ts` so weak ETag `If-Range` returns the full `200 OK` response without `Content-Range`.

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
