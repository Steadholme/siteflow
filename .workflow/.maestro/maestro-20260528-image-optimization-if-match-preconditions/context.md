# Image Optimization If-Match Preconditions

## Summary

- Completed `VP-073` / `ISS-20260527-073` / `EXC-081`.
- Added `If-Match` precondition handling to `_siteflow/image`.
- Failed optimized image preconditions return `412 Precondition Failed` with no body and no `Content-Length`.
- Failed `If-Match` now takes precedence over matching `If-None-Match`.
- `If-Match: *` continues to return the normal optimized image `200 OK` response for existing image sources.

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
