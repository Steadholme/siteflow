# SiteFlow Prebuilt Deploy MVP

Date: 2026-05-15
Status: in progress

## Goal

Enable an operator to deploy SiteFlow on a server and let any client run a CLI command that uploads a local static output directory to the server, receives a generated preview hostname such as `8f3a9c2e.w33d.xyz`, and serves the uploaded artifact over public HTTP through wildcard DNS/Nginx forwarding.

## MVP Scope

- CLI command: `siteflow deploy --prebuilt <dir> --server https://siteflow.example.com --project <slug> --base-domain w33d.xyz`.
- API endpoint: `POST /api/deployments/prebuilt`.
- Upload format: JSON manifest with base64 file content. This is acceptable for the first slice and keeps the implementation dependency-light; later releases can switch to streaming tar/zstd.
- Persistence:
  - Store artifact files under `SITEFLOW_ARTIFACT_ROOT/<deploymentId>/`.
  - Store deployment metadata and host route in Postgres.
  - Maintain existing read-model table for console queries.
- Runtime route:
  - API server can serve artifact files by `Host` header using DB route lookup.
  - In production, Nginx wildcard vhost forwards `*.w33d.xyz` to the API/artifact server.

## Non-Scope

- Docker source build worker.
- Login/token management.
- Wildcard DNS automation.
- ACME wildcard certificate automation.
- Streaming upload protocol.

## Execution Steps

1. Extend Postgres migrations with artifact and route tables.
2. Add deploy request/response contracts to shared API client.
3. Add server prebuilt deploy handler with path safety, checksum, artifact file writes, and route insert.
4. Add static artifact serving by preview host.
5. Add CLI packer for prebuilt directories and `siteflow deploy` command.
6. Add tests for upload contract, route serving, and CLI dry packaging behavior.

