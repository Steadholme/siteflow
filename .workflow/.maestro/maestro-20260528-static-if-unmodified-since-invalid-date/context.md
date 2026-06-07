# VP-065: Static If-Unmodified-Since Invalid Date

Issue: `ISS-20260527-065`
Artifact: `EXC-073`
Depends on: `EXC-072`
Status: completed

## Scope

- Cover static artifact `If-Unmodified-Since` headers with invalid HTTP-date values.
- Ignore invalid `If-Unmodified-Since` dates instead of failing the precondition.
- Preserve stale valid `If-Unmodified-Since` behavior returning `412 Precondition Failed`.
- Preserve `If-Match` precedence over `If-Unmodified-Since`.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

## Implementation

- Extended the static cache/revalidation HTTP test in `server/httpServer.test.ts`.
- Added coverage for `If-Unmodified-Since: not-a-date`, proving the request returns the normal `200` static artifact response.
- No runtime code changes were needed; the existing precondition implementation already ignored invalid dates.

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
