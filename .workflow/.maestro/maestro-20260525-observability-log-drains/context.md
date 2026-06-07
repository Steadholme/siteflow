# VP-012 Observability And Log Drains

Status: completed
Issue: `ISS-20260525-012`
Execution: `EXC-020`

## Scope

- Added a unified observability log query API for build logs, function invocation summaries/log lines, and cron dispatches.
- Added saved log query persistence and filtered read models for source, severity, deployment, search, cursor, and limit.
- Added log drain persistence with source filters, minimum severity, signing secret prefix exposure only, and delivery history.
- Added signed external log drain delivery with `x-siteflow-signature` and `x-siteflow-delivery` headers.
- Redacted log messages and metadata before returning API data or posting drain payloads.
- Added CLI commands: `siteflow logs` and `siteflow log-drain create/list/deliver`.

## Files

- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `server/readRepository.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `cli/siteflowCli.ts`
- `server/httpServer.test.ts`
- `src/lib/api/httpClient.test.ts`
- `src/lib/api/siteflowClient.test.ts`
- `cli/siteflowCli.test.ts`

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm run build`

## Notes

- Route `projectId` and `drainId` take precedence over body values for mutating project-scoped endpoints.
- Drain signing secrets are stored server-side for HMAC signing, but only `signingSecretPrefix` is returned in read models.
- Drain delivery currently supports manual delivery via API/CLI; scheduling/retry workers can use the same `prepareLogDrainDelivery` and `recordLogDrainDelivery` contracts later.
