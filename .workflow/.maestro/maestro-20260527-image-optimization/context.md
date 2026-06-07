# VP-016 Image Optimization

Issue: `ISS-20260527-016`

Completed at: `2026-05-27T16:41:53+08:00`

## Scope

- Added `/_siteflow/image` route for same-site image optimization requests.
- Supported artifact image sources such as `/assets/hero.png`.
- Supported project Blob image sources such as `blob:assets/hero.webp`.
- Added parameter validation for width, quality, and format.
- Rejected external URLs and secret-bearing source query strings.
- Added stable cache-key, ETag, immutable cache, Vary, deployment, and transform metadata headers.
- Added `imageOptimizationUrl` helpers to HTTP and fixture clients.

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts`
  - 3 files, 65 tests passed.
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm test -- --run`
  - 18 files, 156 tests passed.
- `npm run build`

## Notes

- This slice intentionally focuses on safe routing, cache semantics, and contract shape. It currently returns source bytes with transform metadata headers; a future native/wasm codec can replace the byte passthrough without changing the public route contract.
- Next planned issue remains `ISS-20260527-017` Cache and ISR controls.
