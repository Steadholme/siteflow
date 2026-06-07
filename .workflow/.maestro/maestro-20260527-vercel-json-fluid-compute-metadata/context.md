# VP-041 Execution Context: vercel.json Fluid Compute Metadata

## Summary

Implemented Vercel-compatible `fluid` import as deployment artifact metadata and aligned source function memory override behavior with Fluid compute constraints.

## Scope Completed

- Added `fluid?: boolean | null` to prebuilt deploy contracts.
- Parsed `fluid` from prebuilt deploy `vercel.json`.
- Parsed `fluid` from source build `vercel.json`.
- Persisted `fluid` into artifact manifest metadata for prebuilt and source-built deployments.
- Preserved `null` values so deployments can explicitly record inherited/default Fluid compute intent.
- Ignored `functions.*.memory` overrides when source `vercel.json` has `fluid: true`.
- Left actual scheduling/runtime behavior unchanged until SiteFlow has an explicit Fluid compute runtime model.

## Files Modified

- `src/lib/api/deployContracts.ts`
- `cli/deploy.ts`
- `worker/buildWorker.ts`
- `server/postgresReadRepository.ts`
- `cli/siteflowCli.test.ts`
- `worker/buildWorker.test.ts`
- `server/postgresReadRepository.test.ts`
- `.workflow/design/siteflow-vercel-parity/tasks.md`
- `.workflow/issues/issues.jsonl`
- `.workflow/state.json`

## Verification

- `npm test -- --run cli/siteflowCli.test.ts worker/buildWorker.test.ts server/postgresReadRepository.test.ts`
  - Passed: 3 files, 51 tests.
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
