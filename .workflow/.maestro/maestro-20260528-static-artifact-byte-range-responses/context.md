# VP-045: Static Artifact Byte Range Responses

Issue: `ISS-20260527-045`
Artifact: `EXC-053`
Depends on: `EXC-052`
Status: completed

## Scope

- Support HTTP byte range requests for static artifact responses.
- Advertise `Accept-Ranges: bytes` on static artifact responses.
- Return `206 Partial Content` with `Content-Range` and partial bytes for valid single ranges.
- Support suffix byte ranges for media/download use cases.
- Return `416 Range Not Satisfiable` with `Content-Range: bytes */size` for invalid ranges.
- Keep `HEAD`, ETag, cache-control, routing, and rollout headers compatible with range handling.

## Implementation

- Added single byte-range parsing in `server/httpServer.ts`.
- Added suffix range handling and invalid-range detection.
- Added `Accept-Ranges: bytes` to static artifact responses.
- Added `206` partial response handling with `Content-Range` and `Content-Length`.
- Added `416` handling for invalid or unsatisfiable ranges.
- Preserved full-resource `HEAD` behavior and existing cache/ETag logic.
- Added HTTP tests for regular ranges, suffix ranges, invalid ranges, and `HEAD`.

## Verification

- `npm test -- --run server/httpServer.test.ts` passed: 44 tests.
- `npx tsc --noEmit -p tsconfig.server.json` passed.
- `npx tsc --noEmit -p tsconfig.worker.json` passed.
- `npx tsc --noEmit -p tsconfig.cli.json` passed.
- `npx tsc --noEmit -p tsconfig.json` passed.
- `npm test -- --run` passed: 21 files, 201 tests.
- `npm run build` passed.

Notes:

- React Router future flag warnings during full test run are existing warnings and not failures.
- This workspace is not a Git repository, so no commit was created.
