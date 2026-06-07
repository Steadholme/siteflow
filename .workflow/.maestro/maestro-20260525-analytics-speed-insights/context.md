# VP-011 Web Analytics And Speed Insights

Status: completed
Issue: `ISS-20260525-011`
Execution: `EXC-019`

## Scope

- Added privacy-preserving analytics event ingestion for pageviews, custom events, and Web Vitals.
- Sanitized paths and referrers by stripping query strings and fragments before persistence.
- Redacted sensitive dimensions and avoided cookie-based client ingestion by using `credentials: "omit"`.
- Added aggregate project dashboard read models for top pages, referrers, countries, browsers, devices, custom events, and Core Web Vitals p75 ratings.
- Added a project detail Web Analytics / Speed Insights panel.

## Files

- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/analytics.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `server/readRepository.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.ts`
- `src/features/projects/ProjectDetailPage.tsx`
- `src/features/projects/components/AnalyticsPanel.tsx`
- `src/features/projects/projects.css`
- `server/httpServer.test.ts`
- `src/lib/api/httpClient.test.ts`
- `src/features/projects/projects.test.tsx`
- `src/lib/analytics.test.ts`

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts src/features/projects/projects.test.tsx src/lib/analytics.test.ts`
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npm run build`

## Notes

- The project route `projectId` takes precedence over any body `projectId` during ingestion.
- Analytics ingestion does not require bearer auth and intentionally omits browser credentials.
- The dashboard aggregation window is currently fixed at `24h`.
