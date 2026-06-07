# VP-020 vercel.json Routing Import

Issue: `ISS-20260527-020`

Completed at: `2026-05-27T18:31:25+08:00`

## Scope

- Added prebuilt deploy contract fields for routing config imported from `vercel.json`.
- Updated CLI prebuilt deploy packaging to read local `vercel.json` and normalize:
  - `redirects`
  - `rewrites`
  - `headers`
- Included normalized routing config in `/api/deployments/prebuilt` payloads.
- Updated server-side prebuilt deploy persistence to upsert imported routing config into project routing rules.

## Verification

- `npm test -- --run cli/siteflowCli.test.ts server/httpServer.test.ts`
  - 2 files, 66 tests passed.
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
  - 4 files, 107 tests passed.
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm test -- --run`
  - 18 files, 169 tests passed.
- `npm run build`

## Notes

- `vercel.json` is still included in the uploaded artifact files, matching the current prebuilt packaging behavior.
- The import path intentionally feeds the VP-019 routing rules engine rather than adding a second runtime config path.
