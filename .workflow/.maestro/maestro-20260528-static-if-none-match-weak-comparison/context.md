# VP-062: Static If-None-Match Weak Comparison

Issue: `ISS-20260527-062`
Artifact: `EXC-070`
Depends on: `EXC-069`
Status: completed

## Scope

- Use weak ETag comparison for static artifact `If-None-Match` revalidation.
- Treat strong and weak forms of the same opaque ETag as matching for `GET` / `HEAD` cache validation.
- Preserve strong comparison semantics for `If-Match` preconditions.
- Preserve `If-Modified-Since` precedence behavior when `If-None-Match` is present.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

## Implementation

- Added `weakEtagMatches` in `server/httpServer.ts`.
- Updated `requestHasMatchingEtag` to use weak ETag comparison for `If-None-Match`.
- Left `strongEtagMatches` and `If-Match` precondition behavior unchanged.
- Extended the static cache/revalidation HTTP test in `server/httpServer.test.ts` to prove the strong form of SiteFlow's weak static ETag returns `304`.

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
