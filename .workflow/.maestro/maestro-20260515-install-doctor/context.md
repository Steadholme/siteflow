# SiteFlow Install Doctor Iteration

Date: 2026-05-15
Status: completed

## Outcome

`siteflow install --yes` now has a final install doctor gate. The installer only writes `/etc/siteflow/install-state.json` after services start, API health passes, Nginx validates/reloads, and the final doctor checks pass.

## Implemented

- Added a `DoctorReport` to `InstallApplyResult`.
- Added final installer checks in `cli/installApply.ts`:
  - `systemctl is-active siteflow.service` when services are started.
  - rendered env, compose, and systemd files match the install plan.
  - generated secret files exist and are non-empty.
  - artifact root is writable and readable.
  - active Nginx config matches the generated wildcard router config.
- Added `runFinalDoctor` test hook for controlled install apply flows.
- Added failure behavior: if final doctor status is `fail`, install apply aborts before writing successful install state.

## Validation

- `npm test -- --run cli/installApply.test.ts cli/siteflowCli.test.ts`: passed, 14 tests.
- `npm run build`: passed.
- `npm test -- --run`: passed, 90 tests.
- `npm run test:e2e`: passed, 51 tests.

## Remaining Production Gaps

- Doctor does not yet verify live Postgres connectivity from the running service.
- TLS certificate issuance and renewal are not implemented.
- Docker image publish and real VM smoke install are still pending.
- Build worker execution is still not implemented.
