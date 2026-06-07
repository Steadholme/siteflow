# VP-035 vercel.json Git Deployment Controls

## Purpose

Honor Vercel-compatible `git.deploymentEnabled` during SiteFlow source builds.

## Changes

- Parsed `vercel.json.git.deploymentEnabled` from the resolved source project root.
- Supported both global boolean deployment disablement and branch-pattern rule objects.
- Matched source event branches against branch patterns before running install/build commands.
- Reused the existing `BuildSkippedError` and queue `skipJob` path for disabled Git deployments.
- Kept `ignoreCommand` behavior intact and still evaluated after Git deployment controls.
- Added worker coverage proving global and branch-pattern disabled deployments skip before user build commands run.

## Verification

- `npm test -- --run worker/buildWorker.test.ts` passed with 16 tests.
- `npm test -- --run worker/buildWorker.test.ts worker/postgresBuildQueue.test.ts server/httpServer.test.ts` passed with 57 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 194 tests.
- `npm run build` passed.
