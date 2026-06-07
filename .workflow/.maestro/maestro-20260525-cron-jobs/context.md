# VP-009 Cron Jobs

Status: completed
Issue: `ISS-20260525-009`
Execution: `EXC-017`

## Scope

- Added project-scoped cron job domain models and read models.
- Added five-field UTC cron expression validation for Vercel-style schedules.
- Added management API/client/fixture/CLI support for create, list, run-now, and disable.
- Added dispatch records that resolve the verified production domain and store the target URL plus `vercel-cron/1.0` user agent.

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

- `npx tsc --noEmit -p tsconfig.json`
- `npm run build:server`
- `npm run build:cli`
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts worker/buildWorker.test.ts`
- `npm run build`

## Notes

- Run-now currently records a queued dispatch audit entry and does not perform outbound HTTP execution.
- Scheduler daemon execution remains future work; the current slice establishes persisted resources and auditable invocation intent.
