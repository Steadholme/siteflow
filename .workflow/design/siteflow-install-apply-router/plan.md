# SiteFlow Install Apply Router Iteration

Date: 2026-05-15
Status: completed

## Goal

Move managed Nginx wildcard routing from dry-run-only assets to a real, guarded install apply primitive.

## Changes

- Add an install apply engine that writes rendered env and Nginx assets through root-mappable paths.
- Require `--yes` for non-dry-run `siteflow install`.
- Install Nginx config into staging, sites-available, and sites-enabled.
- Run `nginx -t` before reload.
- Run `nginx -s reload` after validation.
- Restore previous Nginx files if validation or reload fails.
- Persist `/etc/siteflow/install-state.json` after successful apply.

## Validation

- `npm test -- --run cli/installApply.test.ts cli/installAssets.test.ts cli/siteflowCli.test.ts`
- `npm run build`
- `npm test -- --run`
- `npm run test:e2e`
