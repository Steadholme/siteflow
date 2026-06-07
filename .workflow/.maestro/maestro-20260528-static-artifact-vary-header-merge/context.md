# VP-056: Static Artifact Vary Header Merge

Issue: `ISS-20260527-056`
Artifact: `EXC-064`
Depends on: `EXC-063`
Status: completed

## Scope

- Merge routing header rules for `Vary` with the static artifact default `Vary: accept-encoding`.
- Deduplicate `Vary` tokens case-insensitively.
- Keep routing header rules able to override all non-`Vary` static response headers.
- Preserve precompressed negotiation, cache, ETag, Last-Modified, range, security headers, rewrites, and project/artifact routing behavior.

## Implementation

- Added `mergeVaryHeader` in `server/httpServer.ts`.
- Updated `applyRoutingHeaders` so `Vary` rules append to the existing response `Vary` value instead of replacing it.
- Kept normal `setHeader` override semantics for all other routing response headers.
- Extended the artifact-local routing metadata test in `server/httpServer.test.ts` to prove a custom `Vary` token is merged while `accept-encoding` remains present.

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
