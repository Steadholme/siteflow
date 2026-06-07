# VP-064: Static If-Match Multi-Value Preconditions

Issue: `ISS-20260527-064`
Artifact: `EXC-072`
Depends on: `EXC-071`
Status: completed

## Scope

- Cover static artifact `If-Match` headers containing multiple ETags.
- Preserve strong comparison semantics for every listed ETag.
- Return `412 Precondition Failed` when no listed ETag strongly matches the current static artifact validator.
- Allow `If-Match` lists containing `*` to pass for an existing static artifact.
- Preserve weak `If-None-Match` revalidation behavior, cache headers, Last-Modified, range handling, precompressed negotiation, HEAD behavior, and routing behavior.

## Implementation

- Extended the static cache/revalidation HTTP test in `server/httpServer.test.ts`.
- Added coverage for multi-value `If-Match` containing only weak validators, which returns `412`.
- Added coverage for multi-value `If-Match` containing `*`, which passes for an existing static artifact.
- No runtime code changes were needed; the existing precondition implementation already satisfied the covered behavior.

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
