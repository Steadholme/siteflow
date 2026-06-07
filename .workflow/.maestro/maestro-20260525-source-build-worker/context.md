# VP-003 Source Build Worker MVP

Date: 2026-05-26
Status: completed

## Summary

Implemented the first source build worker slice for the Vercel-parity Git deploy loop. A worker can claim one queued build job, resolve a local source checkout, run allowlisted npm build commands, redact build logs, publish immutable static artifacts, persist a git deployment, and register a preview artifact route.

## Files

- `worker/buildWorker.ts`
- `worker/artifactPublisher.ts`
- `worker/localSourceResolver.ts`
- `worker/postgresBuildQueue.ts`
- `worker/index.ts`
- `worker/buildWorker.test.ts`
- `server/migrations.ts`
- `server/postgresReadRepository.ts`
- `package.json`
- `tsconfig.worker.json`

## Verification

- `npm run build:worker` passed.
- `npm run build:server` passed.
- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts worker/buildWorker.test.ts` passed: 4 files, 34 tests.
- `npm run build` passed.

## Notes

The MVP intentionally uses a pluggable `SourceResolver`. The included `LocalSourceResolver` supports local source roots and `repository.providerPayload.localPath`, which gives a testable source-build loop without committing to Git credential handling yet. Remote GitHub clone support can be added by implementing the same resolver contract.

Worker command execution is constrained to an explicit npm allowlist and all persisted log lines pass through SiteFlow redaction before storage.
