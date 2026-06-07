# SiteFlow Install Services Iteration

Date: 2026-05-15
Status: completed

## Outcome

`siteflow install --yes` now applies more than router files. It renders and writes a single-host service stack with root-owned secret files, Docker Compose, and a systemd unit, then starts the service before applying Nginx.

## Implemented

- `cli/installAssets.ts`
  - `renderComposeFile`
  - `renderSystemdUnit`
  - expanded `renderSiteFlowEnvFile`
- `cli/installPlan.ts`
  - added `renderedAssets.compose`
  - added `renderedAssets.systemd`
  - added secret specs
  - added `--image` support through plan input
- `cli/installState.ts`
  - added service `unitPath`
  - added secret references
- `cli/installApply.ts`
  - generates missing secret files
  - reuses existing secret files
  - writes Compose and systemd assets
  - starts `siteflow.service` through `systemctl`
- `cli/siteflowCli.ts`
  - exposes `--image` / `SITEFLOW_IMAGE` for install plans.

## Generated Service Shape

The Compose stack includes:

- `postgres` with `POSTGRES_PASSWORD_FILE`.
- `api` using the selected SiteFlow image.
- `api` reads secrets from `/run/secrets`.
- `api` constructs `DATABASE_URL` inside the container command, so raw DB credentials do not appear in generated non-secret env files.

The systemd unit runs:

```text
/usr/bin/docker compose -f /opt/siteflow/compose.yaml up -d
```

## Validation

- `npm test -- --run cli/installAssets.test.ts cli/installApply.test.ts cli/siteflowCli.test.ts`: passed, 17 tests.
- `npm run build`: passed.
- `npm test -- --run`: passed, 88 tests.
- `npm run test:e2e`: passed, 51 tests.

## Remaining Production Gaps

- The default image is `ghcr.io/siteflow/siteflow:<version>`; a real published image or local bundle still needs to be produced.
- No real worker process exists yet; worker secret is reserved but not used by a running worker.
- Install apply does not yet perform final health checks against `/healthz`.
- Install apply does not yet wait for Postgres/API readiness beyond systemd command success.
- Wildcard TLS DNS-01/provided certificate integration remains pending.
