# VP-060: Precompressed Static Revalidation Headers

Issue: `ISS-20260527-060`
Artifact: `EXC-068`
Depends on: `EXC-067`
Status: completed

## Scope

- Cover conditional revalidation for precompressed static artifact responses.
- Preserve `Content-Encoding` on `304 Not Modified` responses for an encoded representation.
- Preserve `Vary: accept-encoding` on encoded `304 Not Modified` responses.
- Preserve representation-specific ETags for encoded static artifact responses.
- Ensure encoded `304 Not Modified` responses return no response body.

## Implementation

- Extended the precompressed static artifact HTTP test in `server/httpServer.test.ts`.
- Added coverage for Brotli revalidation using `If-None-Match`.
- Asserted the `304` response keeps `Content-Encoding: br`, `Vary: accept-encoding`, the matching ETag, and an empty body.
- No runtime code changes were needed; the existing precompressed static response pipeline already satisfied the covered behavior.

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
