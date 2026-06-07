# VP-040 Execution Context: vercel.json Images Config Import

## Summary

Implemented Vercel-compatible `vercel.json images` import and deployment-scoped image optimization enforcement.

## Scope Completed

- Added `PrebuiltImageConfig` to deploy contracts.
- Parsed `images` from prebuilt deploy `vercel.json`.
- Parsed `images` from source build `vercel.json`.
- Persisted image config into artifact manifest metadata.
- Restored image config from artifact manifests during route resolution.
- Enforced configured image widths, qualities, and formats in `/_siteflow/image`.
- Applied configured `minimumCacheTTL`, `contentDispositionType`, `contentSecurityPolicy`, and `dangerouslyAllowSVG`.

## Files Modified

- `src/lib/api/deployContracts.ts`
- `cli/deploy.ts`
- `worker/buildWorker.ts`
- `server/readRepository.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `cli/siteflowCli.test.ts`
- `worker/buildWorker.test.ts`
- `server/postgresReadRepository.test.ts`
- `server/httpServer.test.ts`
- `.workflow/design/siteflow-vercel-parity/tasks.md`
- `.workflow/issues/issues.jsonl`
- `.workflow/state.json`

## Verification

- `npm test -- --run cli/siteflowCli.test.ts worker/buildWorker.test.ts server/postgresReadRepository.test.ts server/httpServer.test.ts`
  - Passed: 4 files, 93 tests.
- `npx tsc --noEmit -p tsconfig.cli.json`
  - Passed.
- `npx tsc --noEmit -p tsconfig.worker.json`
  - Passed.
- `npx tsc --noEmit -p tsconfig.server.json`
  - Passed.
- `npx tsc --noEmit -p tsconfig.json`
  - Passed.
- `npm test -- --run`
  - Passed: 21 files, 198 tests.
- `npm run build`
  - Passed.

## Notes

- Existing React Router future flag warnings remain during UI tests and are not introduced by this task.
- The workspace is not a Git repository, so no commit was created.
