# Image Optimization Conditional HEAD Preconditions

## Summary

- Completed `VP-077` / `ISS-20260527-077` / `EXC-085`.
- Added optimized image `HEAD` coverage for stale `If-Unmodified-Since` preconditions.
- Verified the response returns `412 Precondition Failed`.
- Verified the response keeps the optimized image ETag.
- Verified the response has no body and no `Content-Length`.
- No runtime change was required because `HEAD` already follows the shared optimized image precondition path.

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
