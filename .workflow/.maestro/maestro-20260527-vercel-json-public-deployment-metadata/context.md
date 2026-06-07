# VP-038 Execution Context: vercel.json Public Deployment Metadata

## Summary

Implemented Vercel-compatible `public` deployment intent as artifact manifest metadata for prebuilt deploys and source builds.

## Scope Completed

- Added `public?: boolean` to prebuilt deploy command contracts.
- Parsed `public` from prebuilt `vercel.json`.
- Sent `public` in prebuilt deploy requests.
- Parsed `public` from source build `vercel.json`.
- Persisted `public` into source build artifact manifest metadata.
- Persisted `public` into prebuilt artifact manifest metadata.
- Left anonymous source/log access disabled; the flag is metadata only until an explicit access policy is implemented.

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
  - Passed: 3 files, 50 tests.
- `npx tsc --noEmit -p tsconfig.cli.json`
  - Passed.
- `npx tsc --noEmit -p tsconfig.worker.json`
  - Passed.
- `npx tsc --noEmit -p tsconfig.server.json`
  - Passed.
- `npx tsc --noEmit -p tsconfig.json`
  - Passed.
- `npm test -- --run`
  - Passed: 21 files, 196 tests.
- `npm run build`
  - Passed.

## Notes

- Existing React Router future flag warnings remain during UI tests and are not introduced by this task.
- The workspace is not a Git repository, so no commit was created.
