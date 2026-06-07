# JSON HEAD Error Body Semantics

## Summary

- Completed `VP-081` / `ISS-20260527-081` / `EXC-089`.
- Updated shared `sendJson` handling so `HEAD` requests do not receive JSON response bodies.
- Threaded the request method through top-level server error handling.
- Added raw HTTP coverage for optimized image `HEAD` input errors.
- Verified the `HEAD` error keeps `400` and JSON content type, omits `Content-Length`, and sends zero body bytes.
- Preserved existing `GET` JSON error behavior.

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
