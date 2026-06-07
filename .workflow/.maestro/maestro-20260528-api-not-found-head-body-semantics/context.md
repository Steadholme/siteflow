# API Not Found HEAD Body Semantics

## Summary

- Completed `VP-082` / `ISS-20260527-082` / `EXC-090`.
- Updated generic `notFound` handling to pass the request method into shared JSON response handling.
- Added raw HTTP coverage for `HEAD /missing-route`.
- Verified the response returns `404` with JSON content type, no `Content-Length`, and zero body bytes.
- Preserved existing `GET` not-found JSON behavior.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 47 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 205 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remained existing warnings and were not failures.
- `git rev-parse --is-inside-work-tree` reports this directory is not a Git repository, so no commit was created.
