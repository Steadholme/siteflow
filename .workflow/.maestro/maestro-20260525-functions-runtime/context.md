# VP-010 Functions Runtime MVP

## Scope

- Added function metadata to deployment artifact manifests.
- Detected Node.js API function entrypoints from `api/` during source builds.
- Published function source files into immutable artifacts under `.siteflow/functions/`.
- Routed deployed `/api/*` requests to artifact functions while preserving static artifact serving.
- Captured invocation duration, status, response status, request id, redacted logs, and errors.
- Persisted invocation telemetry in Postgres.

## Files

- `src/domain/siteflow.ts`
- `worker/artifactPublisher.ts`
- `worker/buildWorker.ts`
- `worker/buildWorker.test.ts`
- `server/readRepository.ts`
- `server/httpServer.ts`
- `server/httpServer.test.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`

## Verification

- `npx tsc --noEmit -p tsconfig.server.json`
- `npm test -- --run server/httpServer.test.ts worker/buildWorker.test.ts`
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts worker/buildWorker.test.ts`
- `npm run build`

## Notes

- The production function module loader still imports artifact files through file URLs.
- Tests inject a `functionModuleLoader` so Vitest does not intercept temporary artifact file URLs.
- Function invocation logs use existing redaction rules before persistence.
