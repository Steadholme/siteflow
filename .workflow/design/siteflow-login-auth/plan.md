# SiteFlow Login/Auth Iteration

Date: 2026-05-15
Status: in progress

## Goal

Make `siteflow deploy --prebuilt` usable from arbitrary client machines without passing all connection details every time, and prevent unauthenticated deploy mutations when the server is configured with a token.

## Scope

- `siteflow login --server <url> --token <token> --base-domain <domain>`.
- Store config in `~/.siteflow/config.json` or `SITEFLOW_CONFIG`.
- `siteflow deploy` reads server, token, and base domain from saved config when flags/env vars are absent.
- Server supports `SITEFLOW_API_TOKEN`.
- Server validates `Authorization: Bearer <token>` for mutating deployment/release endpoints when configured.
- `GET /api/auth/verify` lets CLI validate credentials.

## Deferrals

- Multi-user auth.
- Token issuance UI/API.
- Expiring session tokens.
- Project-scoped permissions.

