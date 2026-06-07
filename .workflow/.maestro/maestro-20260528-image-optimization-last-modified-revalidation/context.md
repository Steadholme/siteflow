# Image Optimization Last-Modified Revalidation

## Summary

- Completed `VP-075` / `ISS-20260527-075` / `EXC-083`.
- Added source modification metadata to optimized image sources.
- Artifact images now use file `mtime`; blob images use blob `updatedAt`.
- `_siteflow/image` now emits `Last-Modified`.
- Matching optimized image `If-Modified-Since` returns `304 Not Modified` with no body.
- Invalid optimized image `If-Modified-Since` is ignored and returns normal `200`.
- Mismatched `If-None-Match` continues to take precedence over `If-Modified-Since`.

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
