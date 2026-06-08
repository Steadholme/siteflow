# Production single-host Docker Compose

`docker-compose.production.yml` is the auditable single-host deployment profile for the current P0 production path. It is intentionally close to the installer-generated profile, but makes the root/socket boundary explicit:

- `api` runs as `1000:1000`, uses `read_only: true`, drops Linux capabilities, sets `no-new-privileges`, and does not mount `/var/run/docker.sock`.
- `worker` keeps the trusted single-host Docker socket mount because source builds still require the host Docker daemon. Treat that worker as having host Docker control. It defaults to `SITEFLOW_WORKER_USER=0:0`; operators may set `SITEFLOW_WORKER_USER` and `SITEFLOW_DOCKER_SOCKET_GID` only after proving the mounted socket is accessible without root.
- The runtime image defaults to `USER node`; the worker's root default is a Compose-level socket-access exception, not the image default.
- `SITEFLOW_IMAGE` and `SITEFLOW_POSTGRES_IMAGE` are required and must be digest-pinned. The committed profile intentionally has no local `build:` fallback or mutable image tag default.
- Both services use the same host-visible `SITEFLOW_ARTIFACT_ROOT` bind mount so worker-created Docker bind mounts resolve on the host.
- `api` mounts `SITEFLOW_EVIDENCE_ROOT` read-only and reads `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD` from that directory so `/metrics` can expose backup automation gauges from the latest externally scheduled `backup:automation` run.
- Runtime secrets are passed as Docker secret file paths such as `SITEFLOW_APP_SECRET_FILE` and `SITEFLOW_POSTGRES_PASSWORD_FILE`; do not expand them with `cat`/`export` in Compose commands.

Before running it on a Linux host:

```sh
sudo install -d -m 0750 -o 1000 -g 1000 /var/lib/siteflow/artifacts
sudo install -d -m 0750 -o 1000 -g 1000 /var/lib/siteflow/evidence
sudo install -d -m 0700 /var/lib/siteflow/postgres
sudo install -d -m 0700 /etc/siteflow/secrets
```

Create these secret files under `/etc/siteflow/secrets` with mode `0600`: `app-secret.secret`, `api-token.secret`, `metrics-token.secret`, `postgres-password.secret`, `github-webhook.secret`, `gitlab-webhook.secret`, `gitea-webhook.secret`, and `generic-webhook.secret`.

Required operator inputs:

- `SITEFLOW_BASE_DOMAIN`
- `SITEFLOW_IMAGE`, pinned to the release image digest produced by the release image workflow
- `SITEFLOW_POSTGRES_IMAGE`, pinned to the reviewed Postgres image digest
- `SITEFLOW_BUILD_IMAGE`, pinned to a digest
- `SITEFLOW_BUILD_IMAGE_ALLOWLIST`, matching the pinned build image when a tagged-image exception is intentionally used; digest-pinned build images do not require an allowlist
- `SITEFLOW_BUILD_MIN_FREE_BYTES`
- `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES` and `SITEFLOW_BUILD_MAX_ARTIFACT_FILES`, unless the reviewed defaults `536870912` and `20000` are accepted
- `SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES` and `SITEFLOW_PREBUILT_MAX_FILES`, unless the reviewed defaults `536870912` and `20000` are accepted
- `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD`, unless the default `/var/lib/siteflow/evidence/backup-automation-run.json` is used

Static validation:

```sh
SITEFLOW_BASE_DOMAIN=example.com \
SITEFLOW_IMAGE=ghcr.io/siteflow/siteflow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SITEFLOW_POSTGRES_IMAGE=postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
SITEFLOW_BUILD_IMAGE=node:20-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824 \
SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912 \
SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000 \
SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912 \
SITEFLOW_PREBUILT_MAX_FILES=20000 \
docker compose -f docker-compose.production.yml config
```

Remaining accepted risk: the worker still mounts `/var/run/docker.sock` and therefore can control the host Docker daemon. This profile reduces the default API blast radius, but it is not a multi-tenant sandbox and still needs target-profile Docker build rehearsal evidence before promotion.
