# VP-047: Precompressed Static Artifact Negotiation

Issue: `ISS-20260527-047`
Artifact: `EXC-055`
Depends on: `EXC-054`
Status: completed

## Scope

- Serve precompressed static artifact files when `.br` or `.gz` variants exist beside the original file.
- Prefer Brotli over gzip when both are accepted.
- Set `Content-Encoding` and `Vary: accept-encoding` for encoded static responses.
- Preserve the original file content type, cache-control, and Last-Modified semantics.
- Keep byte range requests on the uncompressed representation.

## Implementation

- Added Accept-Encoding parsing and precompressed artifact selection in `server/httpServer.ts`.
- Added `.br` then `.gz` lookup beside the resolved static artifact file.
- Added `Content-Encoding` for encoded responses and `Vary: accept-encoding` for all static artifact responses.
- Preserved original content type and cache-control by continuing to classify the uncompressed source path.
- Bypassed encoded variants when the request has a Range header.
- Added raw HTTP test coverage to assert compressed bytes are served without client auto-decompression.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 45 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 202 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test run are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
