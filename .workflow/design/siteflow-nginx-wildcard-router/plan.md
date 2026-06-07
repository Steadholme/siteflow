# SiteFlow Managed Nginx Wildcard Router Iteration

Date: 2026-05-15
Status: completed

## Goal

Move the `*.w33d.xyz` production path from application-only support toward installable infrastructure by rendering a managed Nginx config during `siteflow install --dry-run`.

## Changes

- Add an installer router renderer for the control-plane host and wildcard preview base domain.
- Add `--base-domain` support to `siteflow install`, with `SITEFLOW_BASE_DOMAIN` as the environment fallback.
- Record the wildcard preview host pattern in install state.
- Include a non-secret runtime env file in the dry-run plan so `SITEFLOW_BASE_DOMAIN` is visible before apply exists.
- Cover renderer and CLI dry-run behavior with tests.

## Validation

- `npm test -- --run cli/installAssets.test.ts cli/siteflowCli.test.ts`
- `npm run build`
- `npm test -- --run`
- `npm run test:e2e`
