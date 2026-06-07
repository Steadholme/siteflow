# VP-028 vercel.json Clean URL Routing

## Purpose

Support Vercel-compatible `cleanUrls` and `trailingSlash` behavior for prebuilt deployments.

## Changes

- Extended prebuilt routing contracts with `cleanUrls` and `trailingSlash`.
- Extended `cli/deploy.ts` to parse these fields from `vercel.json`.
- Persisted clean URL routing settings into prebuilt deployment artifact metadata.
- Added artifact route fields and runtime static serving behavior for extensionless `.html` resolution and 308 canonical redirects.
- Added CLI, HTTP, and Postgres repository coverage.

## Verification

- `npm test -- --run cli/siteflowCli.test.ts server/httpServer.test.ts server/postgresReadRepository.test.ts` passed with 73 tests.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npm test -- --run` passed with 183 tests.
- `npm run build` passed.
