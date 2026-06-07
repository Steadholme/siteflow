# VP-058: Accept-Encoding Wildcard Negotiation

Issue: `ISS-20260527-058`
Artifact: `EXC-066`
Depends on: `EXC-065`
Status: completed

## Scope

- Cover `Accept-Encoding` wildcard negotiation for precompressed static artifacts.
- Preserve Brotli preference when wildcard quality makes Brotli and gzip equally acceptable.
- Ensure explicit encoding refusal such as `br;q=0` overrides wildcard acceptance.
- Keep range requests on the uncompressed representation.
- Preserve explicit quality negotiation, cache headers, `Vary`, ETag, Last-Modified, and routing behavior.

## Implementation

- Made `acceptedEncodingQuality` in `server/httpServer.ts` explicitly prefer a direct encoding token over wildcard quality.
- Kept wildcard fallback when the requested encoding has no explicit token.
- Extended the precompressed static artifact test in `server/httpServer.test.ts` for wildcard Brotli selection and wildcard plus Brotli refusal fallback to gzip.

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
