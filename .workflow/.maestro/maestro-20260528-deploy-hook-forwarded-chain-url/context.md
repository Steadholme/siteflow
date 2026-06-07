# VP-119 Deploy Hook Forwarded Chain URL

## Summary

- Extended deploy hook creation coverage for reverse-proxy forwarded header chains.
- Verified generated deploy hook trigger URLs use the first `X-Forwarded-Host` and `X-Forwarded-Proto` token.
- Preserved deploy hook create, list, revoke, and management authorization behavior.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 65 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 223 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
