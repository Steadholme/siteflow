# VP-066: Static If-Modified-Since Invalid Date

Issue: `ISS-20260527-066`
Artifact: `EXC-074`
Depends on: `EXC-073`
Status: completed

## Scope

- Cover static artifact `If-Modified-Since` headers with invalid HTTP-date values.
- Ignore invalid `If-Modified-Since` dates instead of returning `304 Not Modified`.
- Preserve valid `If-Modified-Since` revalidation behavior returning `304`.
- Preserve `If-None-Match` precedence over `If-Modified-Since`.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

## Implementation

- Extended the static cache/revalidation HTTP test in `server/httpServer.test.ts`.
- Added coverage for `If-Modified-Since: not-a-date`, proving the request returns the normal `200` static artifact response.
- No runtime code changes were needed; the existing revalidation implementation already ignored invalid dates.

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
