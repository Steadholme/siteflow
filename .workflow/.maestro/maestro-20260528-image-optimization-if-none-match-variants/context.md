# Image Optimization If-None-Match Variants

## Summary

- Completed `VP-072` / `ISS-20260527-072` / `EXC-080`.
- Added optimized image coverage for weak-form `If-None-Match` validators.
- Added optimized image coverage for multi-value `If-None-Match` validators.
- Added optimized image coverage for `If-None-Match: *`.
- No runtime change was required because image revalidation reuses the existing ETag matching helper.

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
