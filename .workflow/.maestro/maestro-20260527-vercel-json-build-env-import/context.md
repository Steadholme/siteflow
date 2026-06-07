# VP-042: vercel.json Build Env Import

Issue: `ISS-20260527-042`
Artifact: `EXC-050`
Depends on: `EXC-049`
Status: completed

## Scope

- Read Vercel-compatible `build.env` from source build `vercel.json`.
- Inject string-valued build env entries into `ignoreCommand`, install, and build commands.
- Keep queued sealed/project environment variables authoritative over repository config.
- Redact imported build env values from worker logs.
- Persist only imported env keys in artifact manifest metadata.

## Implementation

- Added `buildEnv` parsing to `worker/buildWorker.ts` via `build.env` string entries.
- Merged env precedence as `vercel.json build.env` first, then `job.environmentVariables`.
- Switched worker command execution and log redaction to the merged build env map.
- Added `buildEnvKeys` artifact manifest metadata with sorted imported keys only.
- Extended `worker/buildWorker.test.ts` to verify injection, override precedence, non-string ignore behavior, redaction, and metadata key persistence.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed: 17 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 198 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test run are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
