# SiteFlow Wildcard Base Domain Iteration

Date: 2026-05-15
Status: completed

## Goal

When the SiteFlow server is configured with `SITEFLOW_BASE_DOMAIN=w33d.xyz`, prebuilt deploys should automatically create preview hosts under `*.w33d.xyz`. Clients should not have to pass `--base-domain` after login, and even direct deploys may omit it if the server has a default.

## Changes

- Make `PrebuiltDeployCommand.baseDomain` optional.
- Add `baseDomain` to server options and `SITEFLOW_BASE_DOMAIN`.
- Make Postgres repository use command base domain first, otherwise server default.
- Return `baseDomain` from `GET /api/auth/verify`.
- Let `siteflow login` store server-returned base domain when `--base-domain` is omitted.
- Let `siteflow deploy` omit base domain when no saved value exists, delegating to server default.

## Validation

- `npm test -- --run cli/siteflowCli.test.ts server/httpServer.test.ts`
- `npm run build`
- `npm test -- --run`
- `npm run test:e2e`
