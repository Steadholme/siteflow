# SiteFlow Install Apply Router Iteration

Date: 2026-05-15
Status: completed

## Outcome

`siteflow install` can now perform a guarded apply for the rendered SiteFlow env file and managed Nginx wildcard router assets. Mutating install requires `--yes`; tests inject a temporary root and command runner so production paths and Nginx commands are exercised without touching the development machine.

## Implemented

- Added `cli/installApply.ts` with `applyInstallPlan`.
- Added `siteflow install --yes` flow in `cli/siteflowCli.ts`.
- Added root-mapped file writes for tests and future install smoke harnesses.
- Writes:
  - `/etc/siteflow/siteflow.env`
  - `/etc/siteflow/nginx/siteflow.conf`
  - `/etc/nginx/sites-available/siteflow.conf`
  - `/etc/nginx/sites-enabled/siteflow.conf`
  - `/etc/siteflow/install-state.json`
- Runs:
  - `nginx -t`
  - `nginx -s reload`
- Restores previous Nginx files when validation fails.
- Persists router metadata and active revision in install state after successful apply.

## Usage

```bash
siteflow install --topology single \
  --domain siteflow.w33d.xyz \
  --base-domain w33d.xyz \
  --yes \
  --json
```

## Validation

- `npm test -- --run cli/installApply.test.ts cli/installAssets.test.ts cli/siteflowCli.test.ts`: passed, 15 tests.
- `npm run build`: passed.
- `npm test -- --run`: passed, 86 tests.
- `npm run test:e2e`: passed, 51 tests.

## Remaining Production Gaps

- The apply engine currently covers env and Nginx router assets; Compose, systemd, secrets, database startup, migrations, API/worker startup, and final doctor are still pending.
- Nginx validation/reload is implemented, but full previous-known-good revision management and `systemctl reload nginx` fallback are not complete.
- Wildcard TLS still needs DNS-01 or provided certificate implementation.
- A fresh Linux VM smoke test is still required before claiming end-to-end install readiness.
