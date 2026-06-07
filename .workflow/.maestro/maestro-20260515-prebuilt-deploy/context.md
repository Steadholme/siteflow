# Maestro Session Report: Prebuilt Deploy MVP

Date: 2026-05-15
Session: `maestro-20260515-prebuilt-deploy`

## Summary

This implementation adds the first Vercel-like deploy loop for SiteFlow:

`siteflow deploy --prebuilt ./dist --server https://siteflow.example.com --project docs --base-domain w33d.xyz`

The CLI packages a local static output directory, uploads it to the control-plane API, and the server creates a generated preview host such as `abc123.w33d.xyz`. The server persists deployment metadata in Postgres, writes uploaded files to the configured artifact root, stores a host route, and serves the artifact by matching the incoming preview `Host` or `X-Forwarded-Host` header.

## Implemented

- Shared prebuilt deploy contract: `src/lib/api/deployContracts.ts`
- CLI pack/upload flow: `cli/deploy.ts`
- CLI command: `siteflow deploy --prebuilt`
- Postgres migration for projects, deployments, and artifact routes.
- Postgres repository support for prebuilt deploys and route lookup.
- HTTP API endpoint: `POST /api/deployments/prebuilt`
- Static artifact serving by preview host.
- Tests for CLI packaging/upload, API deploy endpoint, and host-based artifact serving.

## Operational Requirements

- `*.w33d.xyz` must point to the SiteFlow server.
- Nginx should forward wildcard preview hosts to the SiteFlow API/artifact server and preserve `Host` or set `X-Forwarded-Host`.
- `SITEFLOW_ARTIFACT_ROOT` must be writable by the API service.
- `DATABASE_URL` is required for production API startup.

## Verification

- `npm test -- --run`: passed, 73 tests.
- `npm run build`: passed.
- `npm run test:e2e`: passed, 51 tests.
- `node dist-cli/cli/index.js --help`: includes `siteflow deploy`.
- `node dist-cli/cli/index.js install --topology single --domain siteflow.example.com --dry-run --json`: passed.

## Remaining Work

- Auth and `siteflow login`.
- Streaming archive uploads instead of JSON/base64.
- Nginx config rendering for wildcard preview domain.
- Wildcard TLS automation or documented cert path.
- Source deploy with Docker build worker.

