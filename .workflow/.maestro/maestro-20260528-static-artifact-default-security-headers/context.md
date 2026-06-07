# VP-053: Static Artifact Default Security Headers

Issue: `ISS-20260527-053`
Artifact: `EXC-061`
Depends on: `EXC-060`
Status: completed

## Scope

- Add conservative default security headers to static artifact responses.
- Set `X-Content-Type-Options: nosniff` for static artifact responses.
- Set `Referrer-Policy: strict-origin-when-cross-origin` for static artifact responses.
- Let artifact-local or project routing header rules override the defaults.
- Preserve cache, ETag, Last-Modified, range, precompressed negotiation, and routing behavior.

## Implementation

- Added `setDefaultStaticSecurityHeaders` in `server/httpServer.ts`.
- Applied default static security headers alongside other static artifact response headers.
- Kept routing headers applied afterward so user-configured header rules retain precedence.
- Extended cache/static response tests to assert default security headers for HTML and fingerprinted assets.
- Extended artifact-local routing metadata tests to prove `Referrer-Policy` can be overridden by routing headers while `X-Content-Type-Options` remains present.

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
