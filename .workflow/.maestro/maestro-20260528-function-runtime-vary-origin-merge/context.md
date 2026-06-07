# VP-110 Function Runtime Vary Origin Merge

## Summary

- Extended deployed function runtime coverage so runtime-provided `Vary: accept-language` is preserved.
- Asserted centralized CORS metadata merges `Origin` into the same `Vary` response rather than replacing runtime cache negotiation tokens.
- Kept existing function response metadata, CORS exposure headers, body parsing, and invocation logging assertions intact.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed with 62 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed with 21 files and 220 tests.
- `npm run build` passed.

## Notes

- React Router future flag warnings remain existing test warnings and did not fail verification.
- Workspace is not a Git repository, so no commit was created.
