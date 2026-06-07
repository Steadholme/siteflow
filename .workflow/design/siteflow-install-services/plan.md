# SiteFlow Install Services Iteration

Date: 2026-05-15
Status: completed

## Goal

Extend `siteflow install --yes` beyond env and Nginx routing so a single-host install has real service assets: root-owned secrets, Compose, and a systemd unit that manages the SiteFlow stack.

## Changes

- Render `compose.yaml` for bundled Postgres and SiteFlow API.
- Render `siteflow.service` systemd unit that runs Docker Compose.
- Add install-state secret references for API token, Postgres password, app secret, and worker token.
- Generate missing secret files with random bytes and reuse existing files.
- Add `--image` / `SITEFLOW_IMAGE` support for operator-selected release images.
- Apply flow now runs:
  - `systemctl daemon-reload`
  - `systemctl enable --now siteflow.service`
  - `nginx -t`
  - `nginx -s reload`

## Validation

- `npm test -- --run cli/installAssets.test.ts cli/installApply.test.ts cli/siteflowCli.test.ts`
- `npm run build`
- `npm test -- --run`
- `npm run test:e2e`
