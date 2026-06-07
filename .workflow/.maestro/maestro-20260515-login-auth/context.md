# Maestro Session Report: CLI Login And Deploy Auth

Date: 2026-05-15
Session: `maestro-20260515-login-auth`

## Summary

This iteration adds the first deploy authentication layer for the SiteFlow prebuilt deploy MVP.

Clients can now run:

```bash
siteflow login --server https://siteflow.example.com --token <token> --base-domain w33d.xyz
siteflow deploy --prebuilt ./dist --project docs
```

The login command stores server configuration in `~/.siteflow/config.json` or `SITEFLOW_CONFIG`. Deploy reads the saved server URL, token, and base domain when flags are not supplied, then sends `Authorization: Bearer <token>` to the server.

The server now supports `SITEFLOW_API_TOKEN`. When configured, mutating endpoints such as prebuilt deploy, promote, and rollback require a matching bearer token. `GET /api/auth/verify` lets CLI login validate credentials.

## Implemented

- CLI config file read/write: `cli/config.ts`
- `siteflow login`
- deploy config fallback from saved server config
- deploy bearer auth header
- server `apiToken` option
- `SITEFLOW_API_TOKEN` support in `server/index.ts`
- auth verification route: `GET /api/auth/verify`
- token enforcement for mutating endpoints

## Verification

- `npm test -- --run`: passed, 75 tests.
- `npm run build`: passed.
- `npm run test:e2e`: passed, 51 tests.
- Compiled CLI smoke: `siteflow login --skip-verify --json` wrote config successfully.

## Remaining Work

- Replace shared server token with issued user/project tokens.
- Add token revocation/rotation commands.
- Add project-scoped permissions.
- Add Nginx wildcard config generation and TLS docs/automation.

