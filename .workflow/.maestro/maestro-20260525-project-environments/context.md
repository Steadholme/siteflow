# VP-001 Project And Environment Foundation

Date: 2026-05-26
Status: completed

## Summary

Implemented the first Vercel-parity foundation slice for persisted projects, environments, and environment variable metadata. The implementation exposes project create/update/archive contracts, settings/environment read models, and metadata-only environment variable upsert paths.

## Files

- `src/domain/siteflow.ts`
- `src/domain/readModels.ts`
- `src/lib/api/siteflowClient.ts`
- `src/lib/api/httpClient.ts`
- `src/lib/api/fixtureClient.ts`
- `server/readRepository.ts`
- `server/httpServer.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `server/httpServer.test.ts`
- `src/lib/api/httpClient.test.ts`
- `src/lib/api/siteflowClient.test.ts`

## Verification

- `npm run build` passed.
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts` passed: 3 files, 29 tests.

## Notes

Environment variables are exposed as metadata only. API and fixture clients return key, target environment, scope, source, fingerprint, actor metadata, and timestamps, but not secret values.

