# VP-015 Blob Storage

Issue: `ISS-20260527-015`

Completed at: `2026-05-27T16:15:52+08:00`

## Scope

- Added project-scoped Blob domain/read-model contracts for upload, list, explicit content read, and delete.
- Added Postgres migration and repository persistence for Blob metadata plus `bytea` content, including SHA-256, ETag, size, content type, access, cache metadata, and audit events.
- Added HTTP routes under `/api/projects/:projectId/blobs` with read/write authorization.
- Added SDK, HTTP client, fixture client, and CLI commands:
  - `siteflow blob put <localPath>`
  - `siteflow blob list`
  - `siteflow blob get <pathname> --output <localPath>`
  - `siteflow blob delete <pathname>`

## Verification

- `npm test -- --run server/httpServer.test.ts src/lib/api/httpClient.test.ts src/lib/api/siteflowClient.test.ts cli/siteflowCli.test.ts`
  - 4 files, 90 tests passed.
- `npx tsc --noEmit -p tsconfig.json`
- `npx tsc --noEmit -p tsconfig.server.json`
- `npx tsc --noEmit -p tsconfig.cli.json`
- `npm test -- --run`
  - 18 files, 152 tests passed.
- `npm run build`

## Notes

- Blob listings are metadata-only; content is returned only through explicit `getBlob` / CLI `blob get`.
- CLI upload/download uses local filesystem paths rooted at the linked/project root when `--root` is provided.
- Next planned issue remains `ISS-20260527-016` Image Optimization.
