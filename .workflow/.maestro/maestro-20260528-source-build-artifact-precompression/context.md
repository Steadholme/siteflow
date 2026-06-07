# VP-048: Source Build Artifact Precompression

Issue: `ISS-20260527-048`
Artifact: `EXC-056`
Depends on: `EXC-055`
Status: completed

## Scope

- Generate `.br` and `.gz` variants for compressible source-built static artifacts.
- Skip function bundles and existing `.br` / `.gz` files.
- Preserve artifact checksum and file-count determinism by including generated variants.
- Persist precompressed variant counts in artifact manifest metadata.

## Implementation

- Added worker-side Brotli and gzip generation in `worker/artifactPublisher.ts`.
- Limited automatic precompression to common text/static extensions: `.html`, `.css`, `.js`, `.mjs`, `.json`, `.svg`, `.txt`, `.xml`, and `.webmanifest`.
- Skipped `.siteflow/functions/` artifacts so runtime function bundles and bundled support files are not treated as CDN static assets.
- Skipped existing `.br` and `.gz` artifact files to avoid recursively compressing compressed variants.
- Included generated variants before artifact sorting, checksum calculation, file counting, and disk writes so artifact manifests remain deterministic.
- Added `metadata.precompressed` counts for generated Brotli and gzip variants.
- Added worker test coverage proving generated variants decompress back to the original source-built HTML and function bundle extra files are skipped.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed: 17 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 202 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test runs are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
