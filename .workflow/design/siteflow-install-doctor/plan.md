# SiteFlow Install Doctor Iteration

Date: 2026-05-15
Status: completed

## Goal

Prevent `siteflow install --yes` from persisting a successful install state unless the final host and router checks pass.

## Changes

- Run final install doctor after API health and Nginx apply.
- Check service active state, rendered assets, secrets, artifact storage, and active Nginx config.
- Return doctor details in install apply JSON output.
- Abort before install-state write when final doctor fails.
- Cover success and failure behavior in CLI installer tests.

## Validation

- `npm test -- --run cli/installApply.test.ts cli/siteflowCli.test.ts`
- `npm run build`
- `npm test -- --run`
- `npm run test:e2e`
