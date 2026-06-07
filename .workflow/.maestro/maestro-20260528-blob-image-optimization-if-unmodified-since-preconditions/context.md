# Blob Image Optimization If-Unmodified-Since Preconditions

## Summary

- Completed `VP-079` / `ISS-20260527-079` / `EXC-087`.
- Added blob-backed optimized image coverage for stale `If-Unmodified-Since`.
- Verified blob `updatedAt` drives the failed precondition comparison.
- Verified stale blob optimized image preconditions return `412 Precondition Failed`.
- Verified the failure keeps the blob-derived `Last-Modified` header and omits `Content-Length`.
- No runtime change was required because blob source modification metadata already flows into the shared image precondition path.

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
