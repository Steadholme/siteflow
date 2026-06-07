# Image Optimization If-Unmodified-Since Preconditions

## Summary

- Completed `VP-076` / `ISS-20260527-076` / `EXC-084`.
- Optimized image responses now use the shared precondition helper.
- Stale optimized image `If-Unmodified-Since` returns `412 Precondition Failed`.
- Invalid optimized image `If-Unmodified-Since` is ignored.
- Matching `If-Match` continues to take precedence over stale `If-Unmodified-Since`.
- Failed image precondition responses remain bodyless and omit `Content-Length`.

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
