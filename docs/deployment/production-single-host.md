# Production single-host Docker Compose

`docker-compose.production.yml` is the auditable single-host deployment profile for the current P0 production path. It is intentionally close to the installer-generated profile, but makes the Docker socket boundary explicit:

- `api` runs as `1000:1000`, uses `read_only: true`, drops Linux capabilities, sets `no-new-privileges`, and does not mount `/var/run/docker.sock`.
- `worker` keeps the trusted single-host Docker socket mount because source builds still require the host Docker daemon. Treat that worker as having host Docker control. It defaults to `SITEFLOW_WORKER_USER=1000:1000`; `SITEFLOW_DOCKER_SOCKET_GID` is required and must match `stat -c '%g' /var/run/docker.sock` on the target host.
- `SITEFLOW_TRUST_PROXY` defaults to disabled in both the committed profile and generated installer assets. Set it only when the final ingress hop overwrites forwarded headers and target ingress evidence proves that policy.
- The runtime image defaults to `USER node`; the worker no longer falls back to root for socket access. Fix socket group ownership/configuration instead of running the worker as root.
- `SITEFLOW_IMAGE` and `SITEFLOW_POSTGRES_IMAGE` are required and must be digest-pinned. The committed profile intentionally has no local `build:` fallback or mutable image tag default.
- Both services use the same host-visible `SITEFLOW_ARTIFACT_ROOT` bind mount so worker-created Docker bind mounts resolve on the host.
- `api` mounts `SITEFLOW_EVIDENCE_ROOT` read-only and reads `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD` from that directory so `/metrics` can expose backup automation gauges from the latest externally scheduled `backup:automation` run.
- Runtime secrets are passed as Docker secret file paths such as `SITEFLOW_APP_SECRET_FILE`, `SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE`, and `SITEFLOW_POSTGRES_PASSWORD_FILE`; do not expand them with `cat`/`export` in Compose commands.

Before running it on a Linux host:

```sh
sudo install -d -m 0750 -o 1000 -g 1000 /var/lib/siteflow/artifacts
sudo install -d -m 0750 -o 1000 -g 1000 /var/lib/siteflow/evidence
sudo install -d -m 0700 /var/lib/siteflow/postgres
sudo install -d -m 0700 /etc/siteflow/secrets
```

Create these secret files under `/etc/siteflow/secrets` with mode `0600`: `app-secret.secret`, `api-token.secret`, `metrics-token.secret`, `release-evidence-signing-key.secret`, `postgres-password.secret`, `github-webhook.secret`, `gitlab-webhook.secret`, `gitea-webhook.secret`, and `generic-webhook.secret`.

Required operator inputs:

- `SITEFLOW_BASE_DOMAIN`
- `SITEFLOW_IMAGE`, pinned to the release image digest produced by the release image workflow
- `SITEFLOW_POSTGRES_IMAGE`, pinned to the reviewed Postgres image digest
- `SITEFLOW_BUILD_IMAGE`, pinned to a digest
- `SITEFLOW_DOCKER_SOCKET_GID`, set to the target host Docker socket group id from `stat -c '%g' /var/run/docker.sock`
- `SITEFLOW_WORKER_USER`, unless the reviewed default `1000:1000` is accepted
- `SITEFLOW_BUILD_IMAGE_ALLOWLIST`, matching the pinned build image when a tagged-image exception is intentionally used; digest-pinned build images do not require an allowlist
- `SITEFLOW_BUILD_MIN_FREE_BYTES`
- `SITEFLOW_BUILD_STEP_TIMEOUT_MS` and `SITEFLOW_GIT_TIMEOUT_MS`, unless the reviewed defaults `900000` and `300000` are accepted
- `SITEFLOW_BUILD_MEMORY`, `SITEFLOW_BUILD_CPUS`, and `SITEFLOW_BUILD_PIDS_LIMIT`, using explicit positive Docker build resource limits
- `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES` and `SITEFLOW_BUILD_MAX_ARTIFACT_FILES`, unless the reviewed defaults `536870912` and `20000` are accepted
- `SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES` and `SITEFLOW_PREBUILT_MAX_FILES`, unless the reviewed defaults `536870912` and `20000` are accepted
- `SITEFLOW_TRUST_PROXY`, only when the API is reachable exclusively through a trusted ingress or reverse proxy that overwrites forwarded headers; keep it unset or false for direct API exposure
- `SITEFLOW_GIT_SSH_KEY_PATH` and `SITEFLOW_GIT_KNOWN_HOSTS_PATH`, when private repository checkout uses an operator-mounted SSH deploy key and pinned provider host keys
- `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD`, unless the default `/var/lib/siteflow/evidence/backup-automation-run.json` is used
- `SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID`, when production API gates must pin a release evidence signing key id during rotation

Target env-file for promotion evidence:

Use a reviewed target env-file for `siteflow release-gate --promotion --env-file`,
`release:evidence:rehearsal-pack --target-env-file`, and
`release:target-runtime:evidence:collect --env-file`. Keep long-lived runtime
secrets in files and reference them with `_FILE` variables; do not put raw
tokens, passwords, app secrets, or signing keys in the env-file.

```dotenv
SITEFLOW_ENV=production
DATABASE_URL=postgres://siteflow:<password-redacted>@postgres:5432/siteflow
SITEFLOW_API_PORT=8787
SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts
SITEFLOW_EVIDENCE_ROOT=/var/lib/siteflow/evidence
SITEFLOW_PUBLIC_SCHEME=https
SITEFLOW_BASE_DOMAIN=example.com
SITEFLOW_WORKER_USER=1000:1000
SITEFLOW_DOCKER_SOCKET_GID=<stat -c '%g' /var/run/docker.sock>
# Keep unset/false unless the final ingress hop overwrites forwarded headers.
# SITEFLOW_TRUST_PROXY=loopback
SITEFLOW_API_TOKEN_FILE=/etc/siteflow/secrets/api-token.secret
SITEFLOW_METRICS_TOKEN_FILE=/etc/siteflow/secrets/metrics-token.secret
SITEFLOW_APP_SECRET_FILE=/etc/siteflow/secrets/app-secret.secret
SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE=/etc/siteflow/secrets/release-evidence-signing-key.secret
SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID=<non-secret-key-id>
SITEFLOW_POSTGRES_PASSWORD_FILE=/etc/siteflow/secrets/postgres-password.secret
SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/github-webhook.secret
SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/gitlab-webhook.secret
SITEFLOW_GITEA_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/gitea-webhook.secret
SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/generic-webhook.secret
SITEFLOW_GIT_SSH_KEY_PATH=/etc/siteflow/secrets/git-deploy-key
SITEFLOW_GIT_KNOWN_HOSTS_PATH=/etc/siteflow/ssh/known_hosts
SITEFLOW_IMAGE=ghcr.io/siteflow/siteflow@sha256:<release-image-digest>
SITEFLOW_POSTGRES_IMAGE=postgres@sha256:<postgres-image-digest>
SITEFLOW_BUILD_RUNNER=docker
SITEFLOW_BUILD_IMAGE=node:20-bookworm-slim@sha256:<build-image-digest>
SITEFLOW_BUILD_IMAGE_ALLOWLIST=node:20-bookworm-slim@sha256:<build-image-digest>
SITEFLOW_BUILD_NETWORK=none
SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824
SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000
SITEFLOW_GIT_TIMEOUT_MS=300000
SITEFLOW_BUILD_MEMORY=1g
SITEFLOW_BUILD_CPUS=2
SITEFLOW_BUILD_PIDS_LIMIT=256
SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912
SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000
SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912
SITEFLOW_PREBUILT_MAX_FILES=20000
```

Evidence-only secrets such as `SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN`,
`SITEFLOW_OLD_METRICS_TOKEN`, and `SITEFLOW_OLD_API_TOKEN` should be supplied
only in the evidence run shell, CI secrets, or matching `_FILE` variables for
that run. Do not store retired tokens in the long-lived target env-file.

Static validation:

```sh
SITEFLOW_BASE_DOMAIN=example.com \
SITEFLOW_IMAGE=ghcr.io/siteflow/siteflow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SITEFLOW_POSTGRES_IMAGE=postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
SITEFLOW_BUILD_IMAGE=node:20-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SITEFLOW_WORKER_USER=1000:1000 \
SITEFLOW_DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)" \
SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824 \
SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000 \
SITEFLOW_GIT_TIMEOUT_MS=300000 \
SITEFLOW_BUILD_MEMORY=1g \
SITEFLOW_BUILD_CPUS=2 \
SITEFLOW_BUILD_PIDS_LIMIT=256 \
SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912 \
SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000 \
SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912 \
SITEFLOW_PREBUILT_MAX_FILES=20000 \
docker compose -f docker-compose.production.yml config
```

Remaining accepted risk: the worker still mounts `/var/run/docker.sock` and therefore can control the host Docker daemon. This profile reduces the default API blast radius, but it is not a multi-tenant sandbox and still needs target-profile Docker build rehearsal evidence before promotion.
