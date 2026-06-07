# Image Optimization ETag Revalidation

## Summary

- Completed `VP-070` / `ISS-20260527-070` / `EXC-078`.
- Generalized the no-body response helper in `server/httpServer.ts`.
- Added `If-None-Match` handling to `_siteflow/image` using the existing stable image cache key ETag.
- Verified optimized image `GET` and `HEAD` requests return `304 Not Modified` with no body and no `Content-Length`.
- Preserved optimized image metadata, artifact source behavior, blob source behavior, and validation behavior.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 46 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 204 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remained existing warnings and were not failures.
- `git rev-parse --is-inside-work-tree` reports this directory is not a Git repository, so no commit was created.
