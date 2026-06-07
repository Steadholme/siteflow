# SiteFlow Managed Nginx Wildcard Router Iteration

Date: 2026-05-15
Status: completed

## Outcome

The installer dry-run now renders the infrastructure assets needed for Vercel-like wildcard preview routing. Operators can inspect how `siteflow.w33d.xyz` and `*.w33d.xyz` will be wired before an apply engine exists.

## Implemented

- Added `cli/installAssets.ts` with DNS validation, non-secret env rendering, and managed Nginx rendering.
- Added `siteflow install --base-domain`, with `SITEFLOW_BASE_DOMAIN` as fallback.
- Updated install state with `router.controlPlaneHost`, `router.wildcardBaseDomain`, `router.previewHostPattern`, and `router.nginxConfigPath`.
- Dry-run install plans now include `runtimeEnv`, `renderedAssets.env`, and `renderedAssets.nginx`.
- Wildcard Nginx preview hosts forward `Host` and `X-Forwarded-Host` to the SiteFlow API artifact route and block control-plane `/api` and `/healthz` paths on preview domains.

## Usage

```bash
siteflow install --topology single \
  --domain siteflow.w33d.xyz \
  --base-domain w33d.xyz \
  --dry-run \
  --json
```

The dry-run plan includes:

- `SITEFLOW_BASE_DOMAIN=w33d.xyz`
- `server_name siteflow.w33d.xyz;`
- `server_name *.w33d.xyz;`
- `previewHostPattern: "*.w33d.xyz"`

## Validation

- `npm test -- --run cli/installAssets.test.ts cli/siteflowCli.test.ts`: passed, 12 tests.
- `npm run build`: passed.
- `npm test -- --run`: passed, 83 tests.
- `npm run test:e2e`: passed, 51 tests.

## Remaining Production Gaps

- `siteflow install` still blocks real apply; rendered files are not written to `/etc/siteflow` or `/etc/nginx`.
- Nginx `nginx -t`, symlink/swap, reload, and previous-known-good rollback are not implemented yet.
- Wildcard TLS still needs the DNS-01/provided-certificate path.
