# VP-054: Static Directory Request Guard

Issue: `ISS-20260527-054`
Artifact: `EXC-062`
Depends on: `EXC-061`
Status: completed

## Scope

- Return `404` for directory-style static artifact requests when the directory has no `index.html`.
- Prevent directory requests such as `/assets/` from falling back to the deployment entrypoint.
- Preserve `/` entrypoint behavior and directory `index.html` serving when an index file exists.
- Preserve clean URL, trailing slash, cache, range, and precompressed behavior.

## Implementation

- Updated `resolveArtifactFile` in `server/httpServer.ts` so non-root paths ending in `/` only resolve via `<path>/index.html`.
- Return `SiteFlowNotFoundError` when a directory-style request has no index file instead of using the deployment entrypoint fallback.
- Added HTTP coverage in `server/httpServer.test.ts` proving `/assets/` returns `404` when `assets/index.html` is absent.
- Relied on existing clean URL and skip-trailing-slash tests to prove directory `index.html` behavior remains intact.

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
