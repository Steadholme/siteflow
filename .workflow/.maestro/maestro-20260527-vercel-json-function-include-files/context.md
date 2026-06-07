# VP-032 vercel.json Function Include Files

## Purpose

Bundle Vercel-compatible `functions.*.includeFiles` into SiteFlow source-built API function artifacts.

## Changes

- Parsed `includeFiles` from `vercel.json.functions` entries.
- Matched include-file config only against detected API functions covered by the same function pattern.
- Added lightweight glob matching for `*`, `**`, and `?` include patterns.
- Copied matched files into `.siteflow/functions/<project-relative-path>` as artifact extra files.
- Preserved existing generated `.siteflow/functions/package.json` behavior for ESM functions.
- Guarded include patterns and resolved files so they cannot escape the resolved project root.
- Added worker coverage proving matched include files are bundled and unmatched function config does not leak files.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed with 12 tests.
- `npm test -- --run worker/buildWorker.test.ts server/httpServer.test.ts` passed with 51 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npm test -- --run` passed with 190 tests.
- `npm run build` passed.
