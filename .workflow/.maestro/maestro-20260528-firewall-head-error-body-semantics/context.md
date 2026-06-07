# VP-085 Firewall HEAD Error Body Semantics

## Summary

- Updated artifact firewall block and challenge responses to pass `request.method` into `sendJson`.
- Added raw HTTP coverage for `HEAD` firewall block rejections.
- Added raw HTTP coverage for `HEAD` firewall challenge rejections before function invocation.
- Verified both responses preserve `x-siteflow-firewall`, JSON content type, and omit `Content-Length` plus body bytes.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 50 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 208 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
