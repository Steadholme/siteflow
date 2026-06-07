# SiteFlow Install Health Iteration

Date: 2026-05-15
Status: completed

## Goal

Ensure `siteflow install --yes` does not apply Nginx routes or persist a successful install state until the SiteFlow API is actually healthy.

## Changes

- Add API health polling after `systemctl enable --now siteflow.service`.
- Poll `http://127.0.0.1:<SITEFLOW_API_PORT>/healthz`.
- Make health polling injectable for tests.
- Stop before Nginx apply if API health never becomes ready.
- Stop before successful install-state write if API health never becomes ready.

## Validation

- `npm test -- --run cli/installApply.test.ts cli/siteflowCli.test.ts`
- `npm run build`
- `npm test -- --run`
- `npm run test:e2e`
