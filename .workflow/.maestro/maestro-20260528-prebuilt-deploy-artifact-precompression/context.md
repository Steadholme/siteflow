# VP-049: Prebuilt Deploy Artifact Precompression

Issue: `ISS-20260527-049`
Artifact: `EXC-057`
Depends on: `EXC-056`
Status: completed

## Scope

- Generate `.br` and `.gz` variants for compressible static files during CLI prebuilt packaging.
- Skip `.siteflow/functions/` files and existing `.br` / `.gz` variants.
- Upload generated variants with correct size and SHA-256 metadata so server-side artifact verification remains authoritative.
- Record precompressed variant counts in prebuilt deployment artifact manifest metadata.
- Reuse the existing runtime precompressed static artifact negotiation path.

## Implementation

- Added CLI-side Brotli and gzip generation in `cli/deploy.ts`.
- Limited automatic precompression to common text/static extensions: `.html`, `.css`, `.js`, `.mjs`, `.json`, `.svg`, `.txt`, `.xml`, and `.webmanifest`.
- Skipped `.siteflow/functions/` artifacts and existing `.br` / `.gz` files.
- Reused the same prebuilt file metadata path for generated variants, including `contentBase64`, byte size, and SHA-256.
- Added server-side manifest accounting in `server/postgresReadRepository.ts` by deriving `metadata.precompressed` from uploaded artifact paths.
- Kept the existing prebuilt deploy API contract unchanged.
- Added CLI test coverage proving generated compressed variants decompress to the original uploaded HTML.
- Added repository test coverage proving prebuilt manifests record static precompressed counts and ignore function bundle paths.

## Verification

- `npm test -- --run cli/siteflowCli.test.ts server/postgresReadRepository.test.ts` passed: 36 tests.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 203 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test runs are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
