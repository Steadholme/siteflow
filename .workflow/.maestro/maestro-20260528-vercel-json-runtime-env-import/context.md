# VP-043: vercel.json Runtime Env Import

Issue: `ISS-20260527-043`
Artifact: `EXC-051`
Depends on: `EXC-050`
Status: completed

## Scope

- Read Vercel-compatible top-level `env` from source build `vercel.json`.
- Preserve only string-valued runtime env entries.
- Store imported runtime env values as sealed artifact manifest metadata, never raw strings.
- Persist imported runtime env keys separately for manifest visibility.
- Inject deployment-scoped runtime env into `/api/*` functions when resolving artifact routes.
- Let sealed project runtime env override deployment-scoped `vercel.json env` values.

## Implementation

- Added `runtimeEnv` parsing to `worker/buildWorker.ts` from top-level `vercel.json env`.
- Sealed imported runtime env values with the existing `sealSecretValue` envelope before writing artifact manifests.
- Added `runtimeEnvKeys` metadata for visible keys and `sealedRuntimeEnv` metadata for encrypted runtime values.
- Added artifact manifest runtime env extraction in `server/postgresReadRepository.ts`.
- Merged artifact runtime env with project sealed runtime env at route resolution, with project env taking precedence.
- Extended worker and repository tests for sealing, no raw secret leakage, unsealing, and override precedence.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed: 17 tests.
- `npm test -- --run server/postgresReadRepository.test.ts` passed: 3 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 199 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test run are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
