# Static Conditional Range Precedence

## Summary

- Completed `VP-069` / `ISS-20260527-069` / `EXC-077`.
- Added static HTTP coverage for requests combining conditional validators with invalid byte ranges.
- Verified matching `If-None-Match` plus invalid `Range` returns `304 Not Modified`.
- Verified failed `If-Match` plus invalid `Range` returns `412 Precondition Failed`.
- Confirmed both conditional no-body responses omit `Content-Range` and `Content-Length`.
- No runtime change was required because existing static handling already evaluates preconditions and revalidation before range parsing.

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
