# VP-036 Source Build vercel.json Routing Rules Import

## Purpose

Make source-built deployments honor Vercel-compatible `redirects`, `rewrites`, and `headers` from `vercel.json`.

## Changes

- Parsed source build `vercel.json.redirects`, `rewrites`, and `headers` in the worker.
- Persisted those routing rules into artifact manifest `metadata.routing`.
- Added artifact-local routing rules to `ArtifactRoute`.
- Reconstructed artifact-local routing rules from artifact manifests in the Postgres repository.
- Applied artifact-local redirects, rewrites, and headers in the HTTP artifact runtime.
- Preserved project-level routing rules and merged headers when artifact and project rules both apply.
- Added worker coverage for routing metadata persistence and HTTP coverage for artifact-local redirect/rewrite/header behavior.

## Verification

- `npm test -- --run worker/buildWorker.test.ts server/httpServer.test.ts` passed with 56 tests.
- `npm test -- --run worker/buildWorker.test.ts server/httpServer.test.ts server/postgresReadRepository.test.ts cli/siteflowCli.test.ts` passed with 90 tests.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 195 tests.
- `npm run build` passed.
