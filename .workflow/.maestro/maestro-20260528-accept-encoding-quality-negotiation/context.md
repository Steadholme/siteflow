# VP-050: Accept-Encoding Quality Negotiation

Issue: `ISS-20260527-050`
Artifact: `EXC-058`
Depends on: `EXC-057`
Status: completed

## Scope

- Parse `Accept-Encoding` quality values for precompressed static artifact negotiation.
- Respect `q=0` as an explicit refusal for `br` or `gzip`.
- Prefer the available encoding with the highest accepted quality.
- Preserve Brotli preference when Brotli and gzip have equal quality.
- Keep range requests on the uncompressed representation.

## Implementation

- Replaced token-only `Accept-Encoding` handling in `server/httpServer.ts` with quality-aware parsing.
- Added q-value clamping to the HTTP range `0..1`.
- Supported wildcard fallback quality for known encodings.
- Sorted encoded artifact candidates by accepted quality while keeping the existing Brotli-before-gzip order for ties.
- Kept range requests bypassing encoded variants.
- Extended the existing precompressed static artifact raw HTTP test in `server/httpServer.test.ts`.

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
