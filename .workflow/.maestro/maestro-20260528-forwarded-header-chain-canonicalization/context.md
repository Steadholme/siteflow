# VP-118 Forwarded Header Chain Canonicalization

## Summary

- Added first-token parsing for comma-separated forwarded header chains.
- Applied forwarded host canonicalization to artifact routing, image optimization routing, and function runtime request origin construction.
- Applied forwarded proto canonicalization to runtime request origin and deploy hook URL generation.
- Reused first-token parsing for forwarded IP and bucket-key fallback handling.
- Extended deployed function runtime coverage to prove chained forwarded host/proto values route correctly and produce the expected runtime request origin.

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
