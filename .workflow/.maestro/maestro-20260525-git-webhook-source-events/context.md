# VP-002 Git Webhook And Source Events

Date: 2026-05-26
Status: completed

## Summary

Implemented the Git webhook source event slice for Vercel parity. The HTTP server now accepts signed GitHub webhook deliveries, verifies the raw request body with `x-hub-signature-256`, normalizes `push` and `pull_request` payloads into SiteFlow source events, and hands them to repository persistence for idempotent build queue creation.

## Files

- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `server/readRepository.ts`
- `server/httpServer.ts`
- `server/index.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.test.ts`
- `src/lib/api/httpClient.test.ts`
- `src/lib/api/siteflowClient.test.ts`

## Verification

- `npm run build:server` passed.
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts` passed: 3 files, 32 tests.
- `npm run build` passed.

## Notes

The real GitHub webhook route is intentionally separate from the generic `SiteFlowClient.ingestGitWebhook` contract because GitHub signature verification depends on the raw HTTP body and provider headers. Duplicate deliveries return the stored source/build metadata without enqueueing another build.
