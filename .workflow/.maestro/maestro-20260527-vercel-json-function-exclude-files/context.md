# VP-033 vercel.json Function Exclude Files

## Purpose

Filter Vercel-compatible `functions.*.excludeFiles` out of SiteFlow source-built API function bundles.

## Changes

- Parsed `excludeFiles` from `vercel.json.functions` entries.
- Reused the same safe project-relative pattern normalization used by `includeFiles`.
- Applied exclude patterns only from function config entries that match detected API functions.
- Filtered excluded paths out of the explicit include-file bundle before publishing artifact extra files.
- Preserved function entrypoint publishing and generated `.siteflow/functions/package.json` behavior.
- Added worker coverage proving included public files remain bundled while excluded private files are omitted.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed with 13 tests.
- `npm test -- --run worker/buildWorker.test.ts server/httpServer.test.ts` passed with 52 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npm test -- --run` passed with 191 tests.
- `npm run build` passed.
