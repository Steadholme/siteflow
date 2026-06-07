# SiteFlow Install Health Iteration

Date: 2026-05-15
Status: completed

## Outcome

`siteflow install --yes` now waits for the local SiteFlow API health endpoint after starting `siteflow.service`. Nginx is only applied after the API reports healthy, which avoids routing traffic to a dead control plane.

## Implemented

- Added health wait to `cli/installApply.ts`.
- Health endpoint: `http://127.0.0.1:<SITEFLOW_API_PORT>/healthz`.
- Defaults:
  - `waitForHealth: true`
  - `healthAttempts: 30`
  - `healthIntervalMs: 1000`
- Test hooks:
  - injectable `fetch`
  - `healthAttempts`
  - `healthIntervalMs`
- Failure behavior:
  - systemd start can succeed,
  - but failed API health aborts before Nginx files are installed,
  - and before `/etc/siteflow/install-state.json` is written as successful.

## Validation

- `npm test -- --run cli/installApply.test.ts cli/siteflowCli.test.ts`: passed, 13 tests.
- `npm run build`: passed.
- `npm test -- --run`: passed, 89 tests.
- `npm run test:e2e`: passed, 51 tests.

## Remaining Production Gaps

- Health only checks `/healthz`; richer doctor checks for DB, artifact store, route, TLS, and secret permissions are still pending.
- API readiness relies on the container image containing `dist-server/server/index.js`.
- No published release image or VM install smoke exists yet.
- Worker process is still not implemented.
