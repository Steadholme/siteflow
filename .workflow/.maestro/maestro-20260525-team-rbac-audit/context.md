# VP-013 Team RBAC And Audit

Status: completed
Issue: `ISS-20260525-013`
Execution: `EXC-021`

## Scope

- Added project-scoped team members with owner/member/developer/viewer roles and derived read/write/admin permissions.
- Added scoped API tokens with hashed token storage, token prefixes in read models, last-used tracking, revoke support, and break-glass token compatibility.
- Added explicit HTTP route authorization for read, write, and admin operations while preserving unauthenticated analytics ingestion, deploy hooks, and signed GitHub webhooks.
- Added audit event persistence and surfaced recent audit history in project settings and console project detail.
- Added CLI coverage for `siteflow audit list` and `siteflow api-token create/list/revoke`.

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
- `src/features/projects/ProjectDetailPage.tsx`
- `src/features/projects/components/ProjectSettingsRail.tsx`
- `cli/siteflowCli.ts`
- `server/httpServer.test.ts`
- `src/lib/api/httpClient.test.ts`
- `src/lib/api/siteflowClient.test.ts`
- `cli/siteflowCli.test.ts`
- `src/features/projects/projects.test.tsx`

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts src/features/projects/projects.test.tsx`
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm run build`

## Notes

- Break-glass `SITEFLOW_API_TOKEN` still grants read/write/admin so existing self-hosted installs keep working.
- Scoped API tokens use coarse read/write/admin permissions to match the existing control-plane route surface.
- Token creation returns the secret once; read models only expose `tokenPrefix`.
