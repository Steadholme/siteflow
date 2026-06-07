# VP-051: Static Artifact Method Semantics

Issue: `ISS-20260527-051`
Artifact: `EXC-059`
Depends on: `EXC-058`
Status: completed

## Scope

- Return `405 Method Not Allowed` for static artifact routes when the request method is not `GET` or `HEAD`.
- Set `Allow: GET, HEAD` on rejected static artifact method responses.
- Keep `/api/*` function method handling independent from static artifact method handling.
- Preserve canonical redirects, rewrites, firewall checks, and static artifact `GET` / `HEAD` behavior.

## Implementation

- Added non-`GET` / non-`HEAD` static artifact method rejection in `server/httpServer.ts`.
- Resolve the artifact route before rejecting the method so the behavior is scoped to deployed artifact routes.
- Kept function route method checks in the `/api/*` branch unchanged.
- Added HTTP coverage in `server/httpServer.test.ts` proving `POST` to a static asset returns `405` with `Allow: GET, HEAD`.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 45 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 203 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test runs are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
