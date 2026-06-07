# VP-063: Static If-None-Match Multi-Value Revalidation

Issue: `ISS-20260527-063`
Artifact: `EXC-071`
Depends on: `EXC-070`
Status: completed

## Scope

- Cover static artifact `If-None-Match` headers containing multiple ETags.
- Return `304 Not Modified` when any listed ETag matches the current static artifact validator.
- Preserve existing mismatch behavior when no listed ETag matches.
- Preserve weak comparison behavior for each listed ETag.
- Preserve cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

## Implementation

- Extended the static cache/revalidation HTTP test in `server/httpServer.test.ts`.
- Added coverage for `If-None-Match` with multiple ETags where a later value matches the current static artifact ETag.
- No runtime code changes were needed; the existing comma-separated ETag parsing plus VP-062 weak comparison already satisfied the covered behavior.

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
