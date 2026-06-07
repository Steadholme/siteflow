# VP-052: Private Function Bundle Static Guard

Issue: `ISS-20260527-052`
Artifact: `EXC-060`
Depends on: `EXC-059`
Status: completed

## Scope

- Prevent `.siteflow/functions/` artifact files from being served through static artifact routes.
- Keep function bundle files available to the runtime function loader for `/api/*` invocation.
- Preserve normal static artifact fallback behavior for public files.
- Return a not-found response instead of exposing internal function source or include files.

## Implementation

- Added `.siteflow/functions/` prefix rejection in `server/httpServer.ts` artifact path resolution.
- Applied the guard before filesystem probing so direct internal paths, directory index candidates, and clean URL candidates share the same protection.
- Kept `/api/*` function invocation unchanged because runtime loading uses `safeFunctionPath`, not static artifact resolution.
- Added HTTP coverage in `server/httpServer.test.ts` proving direct internal bundle requests return `404` while public static files still serve normally.

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
