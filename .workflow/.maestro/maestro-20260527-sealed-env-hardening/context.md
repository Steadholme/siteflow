# Sealed Environment Storage Hardening

Date: 2026-05-27
Issue: `ISS-20260527-023`
Artifact: `EXC-031`

## Objective

Harden the build environment variable path introduced in VP-022 so stored sealed values are encrypted instead of plaintext, while preserving worker compatibility and metadata-only public responses.

## Implemented

- Added `src/lib/sealedSecrets.ts`.
- Uses AES-256-GCM with a compact `sfseal:v1:` envelope.
- Derives the encryption key from `SITEFLOW_SEALING_KEY`, then `SITEFLOW_APP_SECRET`, then a local development fallback.
- Updated `server/postgresReadRepository.ts` to store sealed environment variable values as encrypted envelopes.
- Updated `worker/postgresBuildQueue.ts` to decrypt sealed values when claiming a build job.
- Kept legacy plaintext compatibility so existing `sealed_value` rows remain readable.
- Added `src/lib/sealedSecrets.test.ts` for encryption/decryption, wrong-key failure, and legacy plaintext fallback.
- Updated server/worker tsconfig include lists for the shared helper.

## Verification

- `npm test -- --run src/lib/sealedSecrets.test.ts worker/buildWorker.test.ts src/lib/api/siteflowClient.test.ts server/httpServer.test.ts` passed: 67 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npm test -- --run` passed: 19 files, 176 tests.
- `npm run build` passed.

## Notes

- This is a self-hosted envelope encryption baseline, not an external KMS integration.
- Production installs should set `SITEFLOW_SEALING_KEY` or `SITEFLOW_APP_SECRET`; otherwise the development fallback is deterministic and not suitable for secure production use.
