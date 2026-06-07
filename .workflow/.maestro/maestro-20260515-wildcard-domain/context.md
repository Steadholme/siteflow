# SiteFlow Wildcard Base Domain Iteration

Date: 2026-05-15
Status: completed

## Outcome

SiteFlow now supports server-owned wildcard preview domains for prebuilt deploys. When the server is started with `SITEFLOW_BASE_DOMAIN=w33d.xyz`, clients can deploy without passing `--base-domain`; the server-side repository resolves the preview host as `<prefix>.w33d.xyz`.

## Implemented

- `PrebuiltDeployCommand.baseDomain` is optional.
- `SITEFLOW_BASE_DOMAIN` is read by the server entrypoint and passed into the Postgres repository and HTTP server options.
- `GET /api/auth/verify` returns the configured `baseDomain` so `siteflow login` can save it automatically.
- `siteflow deploy` only sends `baseDomain` when a flag, environment value, or saved config provides one.
- CLI and HTTP tests cover login base domain discovery and deploy requests that omit `baseDomain`.

## Validation

- `npm test -- --run cli/siteflowCli.test.ts server/httpServer.test.ts`: passed, 16 tests.
- `npm run build`: passed.
- `npm test -- --run`: passed, 79 tests.
- `npm run test:e2e`: passed, 51 tests.

## Usage

Server:

```bash
DATABASE_URL=postgres://...
SITEFLOW_API_TOKEN=<token>
SITEFLOW_BASE_DOMAIN=w33d.xyz
SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts
npm run api
```

Client:

```bash
siteflow login --server https://siteflow.example.com --token <token>
siteflow deploy --prebuilt ./dist --project docs
```

Expected deploy result:

```text
https://<generated-prefix>.w33d.xyz
```

## Remaining Production Gaps

- Wildcard DNS and wildcard TLS are still external setup steps.
- Managed Nginx wildcard config generation is not implemented yet.
- Auth is still a shared API token, not a multi-user identity model.
- Prebuilt upload still uses JSON/base64 instead of streaming archives.
