# SiteFlow Operations Runbook

Date: 2026-06-08

This runbook covers the current production-hardening state. It does not declare SiteFlow fully production-ready. The supported operating profile is still a trusted single-host or controlled staging deployment with known limitations.

## Operating scope

- Supported today: trusted operators, single-host Docker Compose, bundled Postgres, local artifact storage, optional managed Nginx, production API/worker processes, `/readyz`, `/metrics`, backup verify, restore drill, and release-gate promotion checks.
- Trusted single-host only: the installer-generated worker mounts `/var/run/docker.sock`. Treat that worker as having host Docker daemon control.
- Staging only unless explicitly accepted: source builds through the Docker runner. The runner is a minimum isolation mechanism, not a multi-tenant sandbox.
- Not supported for full production yet: untrusted tenant source builds, multi-host/multi-instance control plane, external object storage as the primary documented path, and unattended disaster recovery.

## Operator Access

CLI and automation should continue to use scoped Bearer tokens. Browser/operator-console access can use the minimum server-side session API:

```bash
curl -i \
  -X POST https://siteflow.example.com/api/auth/session \
  -H "Authorization: Bearer <admin-api-token>" \
  -H "Content-Type: application/json" \
  --data '{"subject":"operator@example.com","scopes":["read","write","admin"],"projectIds":["project-acme-dashboard"],"ttlSeconds":3600}'
```

The optional `projectIds` array limits the session's effective scopes to matching project routes. Omit `projectIds` only for trusted global operator workflows. The response sets `siteflow_session=<secret>` as `HttpOnly; SameSite=Lax; Path=/`; the JSON body returns session metadata but does not include the raw session secret. Production API startup forces `Secure` on operator session cookies, and non-production servers still add `Secure` when the request reaches the server over TLS or trusted-proxy mode accepts `X-Forwarded-Proto: https`. Bearer authorization takes precedence over the cookie whenever both are present.

Operator sessions have both the requested absolute TTL and a server-side idle timeout. The default idle timeout is 1800 seconds; set `SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS` to an integer from 60 to 86400 when the target operator policy needs a different window. Session use refreshes `last_used_at` only when the stored session is active, within its absolute TTL, and still inside the idle window.

Rotate the current cookie session without changing its subject, scopes, project scope, or absolute expiry:

```bash
curl -i \
  -X POST https://siteflow.example.com/api/auth/session/rotate \
  -H "Cookie: siteflow_session=<session-secret>" \
  -H "X-SiteFlow-CSRF: same-origin"
```

The rotate response sets a new `siteflow_session` cookie and returns only session metadata. The old cookie is revoked server-side and should return `401` after rotation.

Revoke the current cookie session from the browser or an operator shell that sends the cookie:

```bash
curl -i \
  -X DELETE https://siteflow.example.com/api/auth/session \
  -H "Cookie: siteflow_session=<session-secret>" \
  -H "X-SiteFlow-CSRF: same-origin"
```

Cookie-authenticated browser writes must send `X-SiteFlow-CSRF: same-origin`. The server enforces this only after a `siteflow_session` cookie has satisfied authorization for `POST`, `PUT`, `PATCH`, or `DELETE`; Bearer token requests remain the automation path and do not require this header.

Server-side audit actor attribution is derived from the authenticated Bearer token or operator session for control-plane writes. Client-provided `actor` and `requestedBy` values are ignored for the executing principal, except where `actor` is the explicit business target such as the team member being edited.

Emergency cutoff for operator sessions is Bearer-only. Use it when an operator cookie may be compromised or when all existing console sessions must be invalidated:

```bash
curl -i \
  -X POST https://siteflow.example.com/api/auth/sessions/revoke-all \
  -H "Authorization: Bearer <global-admin-api-token>" \
  -H "Content-Type: application/json" \
  --data '{"reason":"incident ticket INC-1234"}'
```

Project-scoped cutoff is available when the authenticated Bearer token has admin scope for the target project:

```bash
curl -i \
  -X POST https://siteflow.example.com/api/projects/project-acme-dashboard/auth/sessions/revoke-all \
  -H "Authorization: Bearer <project-admin-api-token>" \
  -H "Content-Type: application/json" \
  --data '{"reason":"project incident ticket INC-1235"}'
```

These endpoints ignore client-provided `actor` or `requestedBy` values and derive the actor from the Bearer token. Cookie-only requests are rejected, and a low-scope Bearer token is not allowed to fall back to an admin cookie. The response includes `scope`, `projectId` when applicable, `cutoffId`, `revokedAt`, and `revokedCount`; keep it with the incident ticket. This cutoff revokes operator sessions only. Rotate API tokens, app/sealing secrets, webhook secrets, database credentials, and any exposed Bearer tokens through their separate credential procedures.

This session API is not a complete human login system. Full production still needs login UI or external IdP integration, MFA/SSO, documented use of project-scoped versus global operator sessions, real non-session credential rotation execution, and target-environment evidence. Do not expose cross-origin cookie-authenticated writes until CORS credentials are explicitly designed and tested.

## Git webhooks

Configure a signing secret only for each source provider you enable:

```text
SITEFLOW_GITHUB_WEBHOOK_SECRET=<secret>
SITEFLOW_GITLAB_WEBHOOK_SECRET=<secret>
SITEFLOW_GITEA_WEBHOOK_SECRET=<secret>
SITEFLOW_GENERIC_WEBHOOK_SECRET=<secret>
```

Supported endpoints are `/api/webhooks/git/github`, `/api/webhooks/git/gitlab`, `/api/webhooks/git/gitea`, and `/api/webhooks/git/generic`. The API verifies the raw request body before parsing JSON and fails closed when the provider secret is missing or the signature is invalid.

- GitHub: `X-GitHub-Delivery`, `X-GitHub-Event`, and `X-Hub-Signature-256: sha256=<hex>`.
- GitLab: Standard Webhooks headers `webhook-id`, `webhook-timestamp`, and `webhook-signature: v1,<base64>`. `whsec_` signing tokens are decoded before HMAC verification, and stale timestamps are rejected.
- Gitea: `X-Gitea-Delivery`, `X-Gitea-Event`, and `X-Gitea-Signature` HMAC-SHA256 hex, with compatible `X-GitHub-*` delivery/event headers and `X-Hub-Signature-256` accepted as fallback. JSON bodies and form-encoded `payload=<json>` bodies are supported.
- Generic SiteFlow: `X-SiteFlow-Delivery`, `X-SiteFlow-Event`, and `X-SiteFlow-Signature: sha256=<hex>`.

Provider payloads are normalized into SiteFlow source events. Repository clone URLs must be present in provider payload metadata, or for generic webhooks in `repository.remoteUrl`; signed payloads without clone metadata are rejected before build queueing. Do not embed credentials in those URLs.

## Source provider evidence

Before a production promotion, archive source provider evidence for the exact release commit and target environment. Start from the blocking dry-run template when the operator needs the required JSON skeleton:

```powershell
npm run --silent source-provider:evidence:template -- `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-environment production `
  --provider <github|gitlab|gitea|generic> `
  --operator-name <operator> `
  --release-ticket <ticket> `
  --output evidence/source-provider-evidence-raw.json
```

The template writes `status: "blocked"`, `dryRun: true`, and `template: true` with `todo` / `null` fields. It is only a manual evidence skeleton and does not prove source-provider readiness or satisfy production by itself. Replace every placeholder with real target or target-equivalent provider observations before running the checker:

```powershell
npm run --silent source-provider:evidence -- `
  --evidence evidence/source-provider-evidence-raw.json `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-environment production `
  --json > evidence/source-provider-evidence.json
```

The raw evidence must be non-dry-run target or target-equivalent evidence. It must include the provider name (`github`, `gitlab`, `gitea`, or `generic`), release commit/repository/branch, target environment, safe clone remote URL without embedded credentials, exact checkout proof, a signed webhook delivery id/event with signature verification, webhook secret hygiene without raw secret or signature archival, deploy-key evidence for private repositories, pinned host-key evidence for SSH remotes when applicable, release provenance recording, operator, and ticket metadata.

`source-provenance:evidence` is an alias for the same checker. Passing source provider evidence is required by the release rehearsal pack, final bundle composer, final `release:evidence` checker, and gap reporter. The checker does not call GitHub/GitLab/Gitea, fetch repositories, rotate deploy keys, or inspect provider settings by itself; it validates the evidence the operator collected.

## Trusted Proxy Boundary

By default, the control-plane API ignores `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`. Set `SITEFLOW_TRUST_PROXY` only when the API port is reachable exclusively through a trusted ingress or reverse proxy that overwrites those headers before forwarding to SiteFlow.

Supported values:

- `loopback` for same-host Nginx or another proxy connecting from `127.0.0.0/8` or `::1`.
- `private` for RFC1918 IPv4, IPv4 link-local, IPv6 unique-local, IPv6 link-local, and loopback ingress.
- A comma-separated list of exact IP or CIDR entries, such as `10.0.0.10,10.12.0.0/16,2001:db8::/32`.
- `1`, `true`, `yes`, and `on` are accepted as compatibility aliases for `loopback`.

The installer-managed Nginx profile sets `SITEFLOW_TRUST_PROXY=loopback` and emits proxy headers that overwrite client-supplied values:

```nginx
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
```

If another load balancer, CDN, or proxy sits before Nginx, configure Nginx `set_real_ip_from` only for that trusted upstream, use `real_ip_header X-Forwarded-For`, and keep forwarding `$remote_addr` to SiteFlow. Do not trust `0.0.0.0/0` or `::/0`, do not expose the API port directly when `SITEFLOW_TRUST_PROXY` is enabled, and do not use `$proxy_add_x_forwarded_for` in the SiteFlow-facing proxy hop.

Trusted proxy mode controls request host/scheme reconstruction, artifact route host matching, API rate-limit bucket identity, firewall IP evaluation, and non-production Secure cookie auto-detection. It does not make the rate limiter shared across processes or hosts.

## Managed Nginx API Edge Rate Limit

The installer-managed Nginx profile applies an ingress rate limit only to the control-plane API path:

```nginx
limit_req_zone $binary_remote_addr zone=siteflow_api:10m rate=120r/m;

location = /api {
    limit_req zone=siteflow_api burst=60 nodelay;
    limit_req_status 429;
}

location ^~ /api/ {
    limit_req zone=siteflow_api burst=60 nodelay;
    limit_req_status 429;
}
```

The key is `$binary_remote_addr`, after any trusted `real_ip_header` processing done by Nginx. The limiter does not apply to `/healthz`, `/readyz`, `/metrics`, preview routes, or static artifact traffic. Multi-instance or multi-ingress deployments still need target evidence that an equivalent shared or edge limiter is enforced before requests reach any API instance.

## Readiness

Wire `/readyz` into the load balancer, reverse proxy, or orchestrator readiness probe.

Expected behavior:

- `GET /readyz` returns `200` with `{"status":"ready","details":{...}}` when Postgres and the artifact root are usable.
- `GET /readyz` returns `503` with sanitized `{"status":"not_ready","details":{...}}` when readiness fails.
- `HEAD /readyz` is supported for probe clients that do not need the body.
- `/healthz` is only liveness. Do not use `/healthz` as the traffic admission gate.

Minimum operator actions:

- Remove the instance from customer traffic when `/readyz` returns non-`200` for 2 consecutive probe windows.
- Check Postgres connectivity first, then `SITEFLOW_ARTIFACT_ROOT` existence and permissions.
- Keep the failed readiness response body in incident notes, but do not expect it to contain internal error details.
- Confirm recovery by observing `/readyz` returning `200` for at least 2 consecutive probe windows before sending traffic back.

## Metrics scrape

`GET /metrics` exposes minimal process-local Prometheus text metrics:

- `siteflow_http_requests_total`
- `siteflow_http_5xx_total`
- `siteflow_http_429_total`
- `siteflow_http_request_duration_ms_sum`
- `siteflow_http_request_duration_ms_count`
- `siteflow_build_jobs_queued`
- `siteflow_build_jobs_running`
- `siteflow_build_jobs_stale`
- `siteflow_build_job_oldest_queued_age_seconds`
- `siteflow_build_job_oldest_running_heartbeat_age_seconds`
- `siteflow_runtime_metrics_collection_error`
- `siteflow_backup_automation_last_success_age_seconds`
- `siteflow_backup_restore_drill_last_success_age_seconds`
- `siteflow_backup_offload_last_success_age_seconds`
- `siteflow_backup_prune_last_success_age_seconds`
- `siteflow_backup_offload_last_run_failed`
- `siteflow_backup_prune_last_run_failed`
- `siteflow_backup_metrics_collection_error`

The endpoint does not include path labels, query strings, request bodies, authorization headers, bearer tokens, deploy hook tokens, or internal error messages. Set `SITEFLOW_METRICS_TOKEN` in production and configure the scraper to send `Authorization: Bearer <metrics-token>`. Production startup rejects missing `SITEFLOW_METRICS_TOKEN` unless `SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1` is explicitly set as a documented exception. Keep the endpoint on a private network, localhost sidecar, or reverse-proxy allowlist even when the bearer token is configured.

Set `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD` to the stable JSON file written by `backup:automation --run-record <file>` so `/metrics` can derive backup automation gauges. Relative evidence file paths inside the run record are resolved from the run record directory, not from the API process working directory. Age gauges emit `-1` when no successful run or step is known. `siteflow_backup_metrics_collection_error` is `1` when the run record is missing, unreadable, or malformed during a scrape; it does not expose parser errors or file contents.

Example Prometheus scrape shape:

```yaml
scrape_configs:
  - job_name: siteflow-api
    scheme: http
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/siteflow-metrics-token
    static_configs:
      - targets:
          - siteflow-api.internal:8787
```

Generate the baseline observability artifacts for review:

```powershell
npm run --silent observability:provisioning -- `
  --output evidence/observability-provisioning `
  --scrape-target siteflow-api.internal:8787 `
  --metrics-token-credentials-file /etc/prometheus/secrets/siteflow-metrics-token
```

The command writes `prometheus-scrape.yaml`, `prometheus-rules.yaml`, `alertmanager-route.yaml`, `grafana-dashboard.json`, and `observability-provisioning-plan.json`. Treat these as reviewed inputs to the target infrastructure workflow. The command does not apply Prometheus, Alertmanager, or Grafana configuration, does not create secrets, and does not prove alert delivery or dashboard availability.

Minimum alerts before accepting customer traffic:

```yaml
groups:
  - name: siteflow-minimum
    rules:
      - alert: SiteFlowReadinessDown
        expr: probe_success{job="siteflow-readyz"} == 0
        for: 2m
        labels:
          severity: page
        annotations:
          summary: SiteFlow readiness is failing

      - alert: SiteFlowMetricsMissing
        expr: up{job="siteflow-api"} == 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: SiteFlow metrics scrape is missing

      - alert: SiteFlowHttp5xx
        expr: increase(siteflow_http_5xx_total[5m]) > 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: SiteFlow API is returning 5xx responses

      - alert: SiteFlowRateLimitSpike
        expr: increase(siteflow_http_429_total[5m]) > 20
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: SiteFlow API rate limiting increased

      - alert: SiteFlowBuildJobsStale
        expr: siteflow_build_jobs_stale > 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: SiteFlow build jobs are stale

      - alert: SiteFlowBuildQueueOldestQueued
        expr: siteflow_build_job_oldest_queued_age_seconds > 900
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: SiteFlow build queue has old queued jobs

      - alert: SiteFlowRuntimeMetricsCollectionFailed
        expr: siteflow_runtime_metrics_collection_error == 1
        for: 5m
        labels:
          severity: ticket
        annotations:
          summary: SiteFlow runtime metrics collection failed

      - alert: SiteFlowBackupMetricsCollectionFailed
        expr: siteflow_backup_metrics_collection_error == 1
        for: 5m
        labels:
          severity: ticket
        annotations:
          summary: SiteFlow backup automation metrics collection failed

      - alert: SiteFlowBackupAutomationStale
        expr: siteflow_backup_automation_last_success_age_seconds < 0 or siteflow_backup_automation_last_success_age_seconds > 86400
        for: 10m
        labels:
          severity: page
        annotations:
          summary: SiteFlow backup automation has no fresh successful run

      - alert: SiteFlowRestoreDrillStale
        expr: siteflow_backup_restore_drill_last_success_age_seconds < 0 or siteflow_backup_restore_drill_last_success_age_seconds > 604800
        for: 10m
        labels:
          severity: page
        annotations:
          summary: SiteFlow restore drill evidence is stale

      - alert: SiteFlowBackupOffloadFailed
        expr: siteflow_backup_offload_last_run_failed == 1
        for: 5m
        labels:
          severity: page
        annotations:
          summary: SiteFlow latest backup automation run failed during offload

      - alert: SiteFlowBackupPruneFailed
        expr: siteflow_backup_prune_last_run_failed == 1
        for: 5m
        labels:
          severity: ticket
        annotations:
          summary: SiteFlow latest backup automation run failed during prune
```

Current metrics limitations:

- Metrics are process-local and reset on process restart.
- Basic build queue gauges and queue-age gauges are present, but there is no multi-instance aggregation built into SiteFlow.
- Backup automation, restore-drill, offload, and prune gauges are derived from the latest `backup:automation` run record; SiteFlow does not discover remote object storage, KMS posture, or recurring scheduler state from the infrastructure provider.
- There are no disk or Postgres replication metrics yet.
- `SITEFLOW_METRICS_TOKEN` protects the scrape endpoint, but it is not a substitute for network-level restrictions and alert routing.
- Logs must still be shipped separately from NDJSON stdout.

## Observability evidence

Before accepting customer traffic, collect target-environment evidence for readiness, metrics, alerting, dashboards, and logs.

Use the collector to scrape the target `/readyz` and `/metrics` endpoints, merge operator-supplied evidence, and optionally write the checker output used by release bundles:

```powershell
npm run --silent observability:evidence:collect -- `
  --base-url https://siteflow.example.com `
  --metrics-token-env SITEFLOW_METRICS_TOKEN `
  --backup-automation-run evidence/backup-run/backup-automation-run.json `
  --backup-automation-history evidence/backup-history/backup-automation-history.json `
  --backup-scheduler-ownership evidence/backup-scheduler-ownership.json `
  --operator-evidence evidence/operator-observability.json `
  --target-stack-api-url https://observability.example.com/siteflow-proof `
  --target-stack-token-env SITEFLOW_OBSERVABILITY_STACK_TOKEN `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-environment production `
  --output evidence/observability-evidence-raw.json `
  --check-output evidence/observability-evidence.json
```

The optional `--backup-automation-run <file>` input includes a summarized backup automation run record in the observability evidence. The checker requires that record to come from `siteflow-backup-automation-run`, be completed with `exitCode: 0`, include completed backup, verify, restore-drill, offload, prune, and evidence steps, and point to passed backup checker output. The optional `--backup-automation-history <file>` input proves recurring restore-drill cadence: the history must use `siteflow.backupAutomationRunHistory.v1`, its latest run must match the selected run record, and it must contain at least 2 successful restore drills without a gap over the recorded cadence window. The optional `--backup-scheduler-ownership <file>` input proves the target scheduler is enabled, owned, monitored, and points at the same backup automation run record and run history. For production, that backup checker output must satisfy the object-storage/KMS/provider-retention/fetch/provider-security-audit off-host contract; the built-in `backup:automation --offload-target file://...` path cannot satisfy this by itself. The optional `--target-stack-api-url <url>` input fetches `observabilityTargetStackProof` from a target observability stack proof endpoint, authenticated with the bearer token named by `--target-stack-token-env` or `SITEFLOW_OBSERVABILITY_STACK_TOKEN`; the token is sent in the request and is not serialized into evidence. For release evidence, pass `--commit-ref`, `--repo`, `--branch`, and `--target-environment`; the checker records and validates those fields so old or cross-environment observability output cannot satisfy a release bundle. The operator evidence file or flags must still provide facts the collector cannot prove by scraping or by the proof endpoint: `/readyz` failure status, proof that failed readiness removes traffic, observability apply proof, alert delivery, dashboard ownership, log retention, and redaction spot-checks. For small one-off runs, scrape/readiness/dashboard/log fields can be supplied with flags such as `--readiness-failure-status-code 503`, `--traffic-removed-on-failure`, `--alert-delivered`, `--alert-channel <name>`, `--dashboard-uid <uid>`, `--dashboard-owner <owner>`, `--log-retention-days <days>`, and `--log-redaction-spot-check-passed`; apply proof should come from the target monitoring stack or operator evidence file.

If evidence is already assembled by another system, run the evidence checker directly:

```powershell
npm run --silent observability:evidence -- --evidence <observability-evidence.json> --json
```

Evidence file shape:

```json
{
  "release": {
    "commitRef": "abc123def4567890",
    "repository": "acme/siteflow",
    "branch": "main",
    "targetEnvironment": "production"
  },
  "readinessProbe": {
    "status": "passed",
    "checkedAt": "2026-06-07T11:45:00.000Z",
    "endpoint": "/readyz",
    "healthyStatusCode": 200,
    "failureStatusCode": 503,
    "trafficRemovedOnFailure": true
  },
  "metricsScrape": {
    "status": "scraped",
    "scrapedAt": "2026-06-07T11:46:00.000Z",
    "endpoint": "/metrics",
    "authenticated": true,
    "metricNames": [
      "siteflow_http_requests_total",
      "siteflow_http_5xx_total",
      "siteflow_http_429_total",
      "siteflow_http_request_duration_ms_sum",
      "siteflow_http_request_duration_ms_count",
      "siteflow_build_jobs_queued",
      "siteflow_build_jobs_running",
      "siteflow_build_jobs_stale",
      "siteflow_build_job_oldest_queued_age_seconds",
      "siteflow_build_job_oldest_running_heartbeat_age_seconds",
      "siteflow_runtime_metrics_collection_error",
      "siteflow_backup_automation_last_success_age_seconds",
      "siteflow_backup_restore_drill_last_success_age_seconds",
      "siteflow_backup_offload_last_success_age_seconds",
      "siteflow_backup_prune_last_success_age_seconds",
      "siteflow_backup_offload_last_run_failed",
      "siteflow_backup_prune_last_run_failed",
      "siteflow_backup_metrics_collection_error"
    ]
  },
  "backupAutomationRun": {
    "name": "siteflow-backup-automation-run",
    "status": "completed",
    "completedAt": "2026-06-07T11:44:00.000Z",
    "exitCode": 0,
    "evidenceFiles": {
      "backupEvidenceCheck": "evidence/backup-run/backup-evidence.json"
    },
    "steps": [
      { "id": "backup", "status": "completed" },
      { "id": "backup_verify", "status": "completed" },
      { "id": "restore_drill", "status": "completed" },
      { "id": "backup_offload", "status": "completed" },
      { "id": "backup_prune_plan", "status": "completed" },
      { "id": "backup_prune", "status": "completed" },
      { "id": "backup_evidence", "status": "completed" }
    ],
    "composeResult": {
      "status": "composed",
      "checkResult": {
        "status": "passed"
      }
    }
  },
  "backupAutomationRunHistory": {
    "schemaVersion": "siteflow.backupAutomationRunHistory.v1",
    "name": "siteflow-backup-automation-run-history",
    "updatedAt": "2026-06-07T11:50:00.000Z",
    "cadence": {
      "restoreDrillMaxGapHours": 168,
      "minimumSuccessfulRestoreDrills": 2
    },
    "runs": [
      {
        "runId": "2026-06-01T11-50-00.000Z-siteflow-20260601",
        "status": "completed",
        "completedAt": "2026-06-01T11:50:00.000Z",
        "restoreDrillCompletedAt": "2026-06-01T11:50:00.000Z",
        "exitCode": 0,
        "steps": [
          { "id": "restore_drill", "status": "completed" },
          { "id": "backup_evidence", "status": "completed" }
        ],
        "restoreDrillCompleted": true,
        "backupEvidenceStatus": "passed",
        "composeStatus": "composed"
      },
      {
        "runId": "2026-06-07T11-50-00.000Z-siteflow-20260607",
        "status": "completed",
        "completedAt": "2026-06-07T11:50:00.000Z",
        "restoreDrillCompletedAt": "2026-06-07T11:50:00.000Z",
        "exitCode": 0,
        "evidenceFiles": {
          "backupAutomationRun": "evidence/backup-run/backup-automation-run.json",
          "backupEvidenceCheck": "evidence/backup-run/backup-evidence.json"
        },
        "steps": [
          { "id": "restore_drill", "status": "completed" },
          { "id": "backup_evidence", "status": "completed" }
        ],
        "restoreDrillCompleted": true,
        "backupEvidenceStatus": "passed",
        "composeStatus": "composed"
      }
    ]
  },
  "backupSchedulerOwnership": {
    "schemaVersion": "siteflow.backupSchedulerOwnership.v1",
    "name": "siteflow-backup-scheduler-ownership",
    "status": "applied",
    "checkedAt": "2026-06-07T11:55:00.000Z",
    "evidenceSource": "systemd_timer",
    "operator": "release-operator",
    "ticket": "REL-2026-0607",
    "release": {
      "targetEnvironment": "production"
    },
    "scheduler": {
      "kind": "systemd_timer",
      "id": "siteflow-backup.timer",
      "enabled": true,
      "schedule": "15 */6 * * *",
      "timezone": "UTC",
      "command": "npm run --silent backup:automation -- --run-record evidence/backup-run/backup-automation-run.json --run-history evidence/backup-history/backup-automation-history.json",
      "evidenceFiles": {
        "backupAutomationRun": "evidence/backup-run/backup-automation-run.json",
        "backupAutomationRunHistory": "evidence/backup-history/backup-automation-history.json"
      }
    },
    "owner": "platform",
    "alertTarget": "pager"
  },
  "observabilityProvisioning": {
    "schemaVersion": "siteflow.observabilityProvisioning.v1",
    "name": "siteflow-observability-provisioning-plan",
    "renderedAssets": [
      { "path": "prometheus-scrape.yaml", "kind": "prometheus_scrape", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { "path": "prometheus-rules.yaml", "kind": "prometheus_rules", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { "path": "alertmanager-route.yaml", "kind": "alertmanager_route", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
      { "path": "grafana-dashboard.json", "kind": "grafana_dashboard", "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }
    ]
  },
  "observabilityApplyProof": {
    "schemaVersion": "siteflow.observabilityApplyProof.v1",
    "name": "siteflow-observability-apply-proof",
    "status": "applied",
    "appliedAt": "2026-06-07T11:46:30.000Z",
    "evidenceSource": "target_stack_api",
    "operator": "release-operator",
    "ticket": "REL-2026-0607",
    "provisioningPlan": {
      "schemaVersion": "siteflow.observabilityProvisioning.v1"
    },
    "appliedAssets": [
      { "path": "prometheus-scrape.yaml", "kind": "prometheus_scrape", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { "path": "prometheus-rules.yaml", "kind": "prometheus_rules", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { "path": "alertmanager-route.yaml", "kind": "alertmanager_route", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
      { "path": "grafana-dashboard.json", "kind": "grafana_dashboard", "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }
    ]
  },
  "observabilityTargetStackProof": {
    "schemaVersion": "siteflow.observabilityTargetStackProof.v1",
    "name": "siteflow-observability-target-stack-proof",
    "status": "passed",
    "checkedAt": "2026-06-07T11:46:45.000Z",
    "evidenceSource": "target_stack_api",
    "operator": "release-operator",
    "ticket": "REL-2026-0607",
    "release": {
      "commitRef": "abc123def4567890",
      "repository": "acme/siteflow",
      "branch": "main",
      "targetEnvironment": "production"
    },
    "prometheusRules": {
      "status": "passed",
      "apiUrl": "https://prometheus.example.com/api/v1/rules",
      "rulesHealth": "ok",
      "renderedAssetKind": "prometheus_rules",
      "renderedAssetSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "matchedAlertNames": ["SiteFlowHighErrorRate", "SiteFlowBackupAutomationStale"],
      "missingAlertNames": []
    },
    "grafanaDashboard": {
      "status": "passed",
      "apiUrl": "https://grafana.example.com/api/dashboards/uid/siteflow-prod",
      "dashboardUid": "siteflow-prod",
      "observedTitle": "SiteFlow Production",
      "renderedAssetKind": "grafana_dashboard",
      "renderedAssetSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "matchedMetricNames": [
        "siteflow_http_requests_total",
        "siteflow_build_jobs_queued",
        "siteflow_backup_automation_last_success_age_seconds"
      ]
    },
    "alertmanagerReceiver": {
      "status": "delivered",
      "alertmanagerApiUrl": "https://alertmanager.example.com/api/v2/alerts",
      "receiverName": "pager",
      "proofId": "am-proof-20260607",
      "sentAt": "2026-06-07T11:46:40.000Z",
      "deliveredAt": "2026-06-07T11:46:44.000Z",
      "receiverReceiptSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  },
  "alertDelivery": {
    "status": "delivered",
    "deliveredAt": "2026-06-07T11:47:00.000Z",
    "delivered": true,
    "channel": "pager"
  },
  "dashboard": {
    "status": "available",
    "checkedAt": "2026-06-07T11:48:00.000Z",
    "dashboardUid": "siteflow-prod",
    "owner": "platform"
  },
  "logPipeline": {
    "status": "passed",
    "checkedAt": "2026-06-07T11:49:00.000Z",
    "retentionDays": 30,
    "redactionSpotCheckPassed": true
  }
}
```

The metrics evidence must prove the scrape returned SiteFlow's expected HTTP, runtime queue, and backup automation metric names, not only that a scrape endpoint responded. Release-bound observability evidence must include matching commit, repository, branch, and target environment metadata. Backup scheduler ownership evidence must use `siteflow.backupSchedulerOwnership.v1`, be fresh, have status `applied` or `passed`, match the target environment, identify the enabled cron/systemd/orchestrator job, include schedule and timezone, point at `backup:automation`, link the selected run record and run history paths, and include owner plus alert/escalation target metadata. The observability apply proof must use `siteflow.observabilityApplyProof.v1`, have status `applied` or `passed`, be fresh, include `evidenceSource`, `operator`, and `ticket`, reference `siteflow.observabilityProvisioning.v1`, and include applied `prometheus_scrape`, `prometheus_rules`, `alertmanager_route`, and `grafana_dashboard` asset hashes matching `observabilityProvisioning.renderedAssets`. The observability target-stack proof must use `siteflow.observabilityTargetStackProof.v1`, come from `target_stack_api`, include operator and ticket metadata, match the release identity and target environment, prove Prometheus loaded matching SiteFlow alert rules, prove the Grafana dashboard exposes required SiteFlow metrics, and prove Alertmanager delivered a receiver test alert. Dashboard evidence must have a passing status, a fresh timestamp, a URL or UID, and an owner/team.

The provisioning plan only renders candidate observability artifacts, the collector only scrapes `/readyz` and `/metrics`, optionally fetches target-stack proof from an external proof endpoint, and merges operator evidence; the checker audits evidence only. They do not configure Prometheus, Alertmanager, dashboards, log shipping, retention, or network allowlists. Target operators must still apply the artifacts through the real observability stack and collect apply proof, alert-delivery, dashboard, log-pipeline, and readiness traffic-removal evidence.

## Backup and restore drill

Static backup verification is required before every restore attempt, but it is not disaster-recovery evidence by itself.

Create a candidate backup from the real source environment:

```powershell
npm run siteflow -- backup --output <backup-dir> --database-url <source-postgres-url> --artifact-root <source-artifact-root> --json
```

Verify the candidate backup:

```powershell
npm run siteflow -- backup verify --backup <backup-dir> --json
```

For local or staging rehearsals, offload the verified backup to an off-host filesystem mount or externally replicated path:

```powershell
npm run siteflow -- backup offload --backup <backup-dir> --target file://<offhost-backup-root> --json
```

`file://` offload is not production-grade off-host evidence. For a production-compatible S3 offload, run the command on a host with the AWS CLI already authenticated to the target account and pass the operator/provider evidence that binds the upload to KMS encryption and a retention contract:

```powershell
npm run siteflow -- backup offload --backup <backup-dir> `
  --target s3://<bucket>/<prefix> `
  --kms-key-ref <kms-key-arn-or-id> `
  --provider-retention-mode compliance `
  --provider-retention-days 30 `
  --provider-retention-contract <provider-contract-id> `
  --provider-proof `
  --json
```

The S3 adapter first checks that the destination prefix is empty with `aws s3 ls --recursive`, uploads with `aws s3 cp --recursive`, requests `aws:kms` server-side encryption when `--kms-key-ref` is supplied, and verifies the remote object count and byte count with a second `aws s3 ls --recursive`. `--provider-proof` then calls `aws s3api head-object` for the uploaded `manifest.json` and `aws s3api get-object-lock-configuration` for the bucket, recording provider API proof that the sampled object uses SSE-KMS and Object Lock retention, and that bucket Object Lock default retention meets the requested window. The KMS key reference and provider retention contract are still operator-supplied anchors. Production backup evidence must also include a separate summary-only provider security audit for KMS key policy, bucket policy, lifecycle/versioning controls, cross-account restore access, and a cross-account restore drill.

Fetch the off-host backup back into an isolated local directory before the restore drill. The expected checksum, object count, and byte count should come from the S3 offload evidence, and the restore drill used for production evidence must point at the fetched backup path:

```powershell
npm run siteflow -- backup fetch `
  --source s3://<bucket>/<prefix>/<backup-name> `
  --output evidence/fetched-backups `
  --expected-tree-sha256 <tree-sha256-from-offload> `
  --expected-object-count <object-count-from-offload> `
  --expected-total-bytes <total-bytes-from-offload> `
  --json
```

`siteflow backup fetch` currently supports S3 sources through the AWS CLI. It lists the remote prefix, verifies the remote object count and byte count, downloads into a new destination backup directory, verifies the downloaded tree checksum, and runs static backup verification on the fetched copy. This proves the object-store copy can be read back. Cross-account restore, KMS key policy correctness, bucket policy correctness, lifecycle rules, and disaster-recovery account access are proven by the provider security audit summary described below, not by the fetch command alone.

Create a provider security audit summary from the target cloud account and recovery account. Archive only summaries, hashes, booleans, timestamps, operator metadata, and ticket references. Do not archive raw IAM/KMS/bucket policy JSON, AWS CLI stdout/stderr, credentials, presigned URLs, authorization headers, cookies, tokens, database URLs, private keys, or secret material:

```json
{
  "schemaVersion": "siteflow.backupProviderSecurityAudit.v1",
  "name": "siteflow-backup-provider-security-audit",
  "status": "passed",
  "checkedAt": "2026-06-07T11:16:00.000Z",
  "provider": "aws_s3",
  "evidenceSource": "provider_security_audit",
  "operator": "release-operator",
  "ticket": "REL-2026-0607",
  "kmsKeyPolicy": {
    "status": "passed",
    "kmsKeyRef": "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups",
    "policySha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "backupRoleEncryptDecryptAllowed": true,
    "restoreRoleDecryptAllowed": true,
    "crossAccountRestoreRoleAllowed": true,
    "publicAccessDenied": true
  },
  "bucketPolicy": {
    "status": "passed",
    "policySha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "publicAccessBlocked": true,
    "insecureTransportDenied": true,
    "unencryptedUploadsDenied": true,
    "backupRoleWriteAllowed": true,
    "restoreRoleReadAllowed": true
  },
  "lifecyclePolicy": {
    "status": "passed",
    "ruleId": "retain-siteflow-prod-backups",
    "enabled": true,
    "versioningEnabled": true,
    "retentionDays": 30
  },
  "crossAccountRestore": {
    "status": "passed",
    "sourceAccountId": "111122223333",
    "restoreAccountId": "444455556666",
    "restoreRoleArn": "arn:aws:iam::444455556666:role/siteflow-restore",
    "s3GetObjectTest": { "status": "passed" },
    "kmsDecryptTest": { "status": "passed" }
  },
  "crossAccountRestoreDrill": {
    "status": "passed",
    "restoreDrill": true,
    "completedAt": "2026-06-07T11:17:00.000Z",
    "restoreAccountId": "444455556666",
    "restoreRoleArn": "arn:aws:iam::444455556666:role/siteflow-restore",
    "backupPath": "evidence/fetched-backups/siteflow-20260607"
  }
}
```

Apply the retention policy from the backup root. Inspect the plan first, then run the destructive prune explicitly:

```powershell
npm run siteflow -- backup prune --backup-root <backup-root> --retention-days 30 --minimum-backups 8 --dry-run --json
npm run siteflow -- backup prune --backup-root <backup-root> --retention-days 30 --minimum-backups 8 --yes --json
```

Run a real restore drill into disposable targets:

```powershell
npm run siteflow -- backup restore-drill --backup <backup-dir> --database-url <disposable-postgres-url> --artifact-root <temp-artifact-root> --yes --json
```

The restore-drill artifact root must be isolated from the backup manifest's source artifact root. A target that is equal to, inside, or a parent of the source artifact root is rejected before `psql` runs.

The one-shot automation runner can execute the same sequence and write the release-bundle backup checker output in one evidence directory:

```powershell
npm run --silent backup:automation -- `
  --backup-root <backup-root> `
  --database-url <source-postgres-url> `
  --artifact-root <source-artifact-root> `
  --offload-target s3://<bucket>/<prefix> `
  --offload-kms-key-ref <kms-key-arn-or-id> `
  --offload-provider-retention-mode compliance `
  --offload-provider-retention-days 30 `
  --offload-provider-retention-contract <provider-contract-id> `
  --offload-provider-proof `
  --provider-security-audit evidence/backup-provider-security-audit.json `
  --restore-drill-database-url <disposable-postgres-url> `
  --restore-drill-artifact-root <temp-artifact-root> `
  --restore-drill-yes `
  --evidence-dir evidence/backup-run `
  --policy evidence/backup-policy.json `
  --operator-name "<operator>" `
  --release-ticket "<ticket>" `
  --retention-days 30 `
  --minimum-backups 8 `
  --run-record evidence/backup-run/backup-automation-run.json `
  --run-history evidence/backup-history/backup-automation-history.json `
  --json
```

`backup:automation` is intended for cron, systemd timers, or an external orchestrator to invoke as a single run. It calls the internal backup APIs directly, writes each successful step output immediately, performs a real restore drill against caller-confirmed disposable targets, requires operator-provided policy evidence, and writes `backup-evidence-raw.json` plus `backup-evidence.json` checker output for release bundles. The restore-drill database URL is compared by Postgres host, port, and database name, so different credentials or query strings do not make the source database disposable; the restore-drill artifact root must also be isolated from the source artifact root. `--run-record <file>` writes a stable machine-readable latest-run record for both `/metrics` and `observability:evidence:collect --backup-automation-run`; point `SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD` at the same file for production scrapes. `--run-history <file>` appends a bounded, secret-free history summary for `observability:evidence:collect --backup-automation-history`, letting the release bundle prove recurring restore-drill cadence instead of only the latest run. `file://` offload targets remain local/staging rehearsal only; `s3://` offload targets can produce production-compatible off-host checker evidence when the AWS CLI upload succeeds, `--offload-provider-proof` verifies the sampled S3 object and bucket Object Lock metadata, and the operator supplies KMS plus provider retention metadata that meets the policy. Production-compatible runs must also pass `--provider-security-audit <file>` with the summary-only provider audit described above. The runner still does not configure schedules or alerts, does not clean up disposable drill targets automatically, does not generate the provider security audit by itself, and is not unattended disaster recovery.

Compose the backup verify, restore-drill, policy, offload, fetch, provider security audit, and prune outputs into one raw operator evidence file:

```powershell
npm run --silent backup:evidence:compose -- `
  --backup-verify evidence/backup-verify.json `
  --restore-drill evidence/restore-drill.json `
  --backup-offload evidence/backup-offload.json `
  --backup-fetch evidence/backup-fetch.json `
  --provider-security-audit evidence/backup-provider-security-audit.json `
  --backup-prune evidence/backup-prune.json `
  --policy evidence/backup-policy.json `
  --operator-name "<operator>" `
  --release-ticket "<ticket>" `
  --require-off-host `
  --output evidence/backup-evidence-raw.json `
  --check-output evidence/backup-evidence.json
```

`backup:evidence:compose` writes raw composed evidence to `--output`. When `--check-output` is provided, it also runs the same checks as `backup:evidence` and writes the checker output expected by `release:evidence:compose`. Do not pass the raw composed evidence file directly to the release bundle composer.

If evidence is already assembled by another system, run the evidence checker directly:

```powershell
npm run --silent backup:evidence -- --evidence <backup-evidence.json> --json
```

When production policy requires the backup to be stored away from the SiteFlow host, require object-storage offload, KMS encryption, provider retention, and retention execution evidence:

```powershell
npm run --silent backup:evidence -- --evidence <backup-evidence.json> --require-off-host --json
```

Evidence file shape:

```json
{
  "backupVerify": {
    "status": "verified",
    "createdAt": "2026-06-07T10:30:00.000Z",
    "backupPath": "/backups/siteflow-20260607",
    "database": {
      "checksumVerified": true
    },
    "artifacts": {
      "checksumVerified": true,
      "treeSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "fileCount": 3,
      "totalBytes": 128
    }
  },
  "restoreDrill": {
    "status": "restore_drilled",
    "restoreDrill": true,
    "completedAt": "2026-06-07T11:00:00.000Z",
    "durationMs": 2500,
    "database": {
      "target": "disposable_database"
    },
    "artifacts": {
      "target": "temporary_artifact_root",
      "restoreMode": "replace_non_atomic",
      "checksumVerified": true,
      "treeSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "fileCount": 3,
      "totalBytes": 128
    }
  },
  "backupOffload": {
    "status": "offloaded",
    "offloadedAt": "2026-06-07T11:05:00.000Z",
    "backupPath": "/backups/siteflow-20260607",
    "target": {
      "provider": "s3",
      "location": "s3://siteflow-prod-backups/siteflow-20260607",
      "checksumVerified": true,
      "treeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "objectCount": 4,
      "totalBytes": 512,
      "encryption": {
        "mode": "kms",
        "kmsKeyRef": "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups"
      },
      "providerRetention": {
        "status": "enabled",
        "mode": "compliance",
        "retentionDays": 30,
        "contractId": "s3-object-lock-siteflow-prod"
      }
    }
  },
  "backupFetch": {
    "status": "fetched",
    "source": {
      "provider": "s3",
      "location": "s3://siteflow-prod-backups/siteflow-20260607",
      "objectCount": 4,
      "totalBytes": 512,
      "treeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "backupPath": "evidence/fetched-backups/siteflow-20260607",
    "fetchedAt": "2026-06-07T11:06:00.000Z",
    "objectCount": 4,
    "totalBytes": 512,
    "treeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "checksumVerified": true
  },
  "backupProviderSecurityAudit": {
    "schemaVersion": "siteflow.backupProviderSecurityAudit.v1",
    "name": "siteflow-backup-provider-security-audit",
    "status": "passed",
    "checkedAt": "2026-06-07T11:16:00.000Z",
    "evidenceSource": "provider_security_audit",
    "operator": "release-operator",
    "ticket": "REL-2026-0607",
    "kmsKeyPolicy": {
      "status": "passed",
      "kmsKeyRef": "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups",
      "policySha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "backupRoleEncryptDecryptAllowed": true,
      "restoreRoleDecryptAllowed": true,
      "crossAccountRestoreRoleAllowed": true,
      "publicAccessDenied": true
    },
    "bucketPolicy": {
      "status": "passed",
      "policySha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "publicAccessBlocked": true,
      "insecureTransportDenied": true,
      "unencryptedUploadsDenied": true,
      "backupRoleWriteAllowed": true,
      "restoreRoleReadAllowed": true
    },
    "lifecyclePolicy": {
      "status": "passed",
      "ruleId": "retain-siteflow-prod-backups",
      "enabled": true,
      "versioningEnabled": true,
      "retentionDays": 30
    },
    "crossAccountRestore": {
      "status": "passed",
      "sourceAccountId": "111122223333",
      "restoreAccountId": "444455556666",
      "restoreRoleArn": "arn:aws:iam::444455556666:role/siteflow-restore",
      "s3GetObjectTest": {
        "status": "passed"
      },
      "kmsDecryptTest": {
        "status": "passed"
      }
    },
    "crossAccountRestoreDrill": {
      "status": "passed",
      "restoreDrill": true,
      "completedAt": "2026-06-07T11:17:00.000Z",
      "restoreAccountId": "444455556666",
      "restoreRoleArn": "arn:aws:iam::444455556666:role/siteflow-restore",
      "backupPath": "evidence/fetched-backups/siteflow-20260607"
    }
  },
  "backupPrune": {
    "status": "pruned",
    "checkedAt": "2026-06-07T11:10:00.000Z",
    "retentionDays": 30,
    "minimumBackups": 8,
    "dryRun": false,
    "retained": [
      {
        "backupPath": "/backups/siteflow-20260607",
        "createdAt": "2026-06-07T10:30:00.000Z"
      }
    ],
    "deleted": []
  },
  "operatorName": "release-operator",
  "releaseTicket": "REL-2026-0607",
  "backupPolicy": {
    "schedule": {
      "cron": "15 */6 * * *",
      "timezone": "UTC"
    },
    "retention": {
      "retentionDays": 30,
      "minimumBackups": 8
    },
    "objectives": {
      "rpoHours": 6,
      "rtoHours": 2
    },
    "monitoring": {
      "backupAgeAlertConfigured": true,
      "restoreDrillAgeAlertConfigured": true,
      "alertChannel": "pager",
      "owner": "platform"
    }
  }
}
```

Default checker thresholds are 24 hours for the backup manifest timestamp and 168 hours for the restore-drill timestamp. Override them with `--max-backup-age-hours <hours>` and `--max-restore-drill-age-hours <hours>` only when the production RPO/RTO exception is recorded in the release or incident ticket.

Required restore-drill evidence:

- Backup path or immutable backup object id.
- Backup manifest timestamp.
- Database dump checksum verification result.
- Artifact checksum, file count, and byte count verification result.
- Disposable Postgres target identifier with credentials redacted.
- Temporary artifact target path or object prefix.
- `restoreDrill: true`.
- Restore duration.
- Artifact restore mode. Current artifact restore evidence is `replace_non_atomic` when artifacts are copied.
- Restored artifact checksum, file count, and byte count matching the backup verify evidence.
- Operator name and incident/release ticket id.
- Backup schedule and timezone.
- Retention policy with positive `retentionDays` and `minimumBackups`.
- Explicit RPO/RTO hour targets.
- Backup-age and restore-drill-age alerts with an owner and delivery target.
- Off-host backup output with matching backup identity, non-`file://` object-storage or provider-backed location, checksum verification, object count, byte count, timestamp, KMS encryption evidence, provider retention or immutability contract evidence, and provider API proof for the sampled S3 object. `siteflow backup offload --target s3://... --provider-proof` can produce this shape with the AWS CLI.
- Backup fetch output from `siteflow backup fetch` proving the object-storage source matches the offload location, object count, byte count, and tree checksum.
- Summary-only provider security audit evidence proving KMS key policy, bucket policy, lifecycle/versioning controls, cross-account restore access, and cross-account restore drill status. The checker rejects evidence that archives raw policy documents, AWS CLI stdout/stderr, credentials, tokens, presigned URLs, database URLs, private keys, or authorization material.
- Restore-drill evidence whose `backupPath` is the fetched off-host backup path, not the original local backup path.
- Non-dry-run retention output from `siteflow backup prune` with matching retention policy and proof that the current verified backup was retained.
- `siteflow-backup-evidence-check` JSON output with `status: "passed"` for the final evidence file.
- If `backup:evidence:compose` is used, archive both the raw composed evidence and the `--check-output` checker result; the release bundle consumes the checker result.

Hard rule: do not treat `siteflow backup verify` as a substitute for `siteflow backup restore-drill`. Full production readiness requires recurring restore drills against disposable infrastructure created outside unit tests.

Remaining backup hard blockers:

- No SiteFlow-managed backup scheduler; cron, systemd timers, or an external orchestrator must run `backup:automation`, preserve both the latest run record and the run history used for cadence evidence, and produce `backupSchedulerOwnership` evidence for the release gate.
- Retention policy enforcement is operator-invoked through `siteflow backup prune`; SiteFlow still does not schedule it.
- SiteFlow's built-in offload workflow supports `file://` rehearsal targets and S3 upload through the AWS CLI; `--provider-proof` verifies the uploaded manifest object's SSE-KMS and Object Lock retention plus bucket Object Lock default retention. The provider security audit summary is still collected outside SiteFlow, so the remaining blocker is target-account audit execution and evidence capture, not raw provider policy archival.
- Backup age and restore-drill age gauges plus starter alert rules exist, but target operators must still apply them and prove alert delivery through the real observability stack.
- No atomic artifact restore staging/swap.
- RPO/RTO targets are evidence-gated but not enforced by SiteFlow automation.

## Postgres rehearsal

The Postgres rehearsal is opt-in and must run against a target-equivalent or disposable Postgres database before accepting migration and queue behavior as production evidence. Ordinary `npm test` runs must not depend on Docker or Postgres.

Dry-run the operator entrypoint and capture JSON evidence:

```powershell
$env:SITEFLOW_RUN_POSTGRES_INTEGRATION = "1"
$env:TEST_DATABASE_URL = "postgres://siteflow:siteflow@localhost:5432/siteflow_rehearsal"
npm run --silent rehearsal:postgres -- --dry-run --json --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production
```

Run the real rehearsal:

```powershell
$env:SITEFLOW_RUN_POSTGRES_INTEGRATION = "1"
$env:TEST_DATABASE_URL = "postgres://siteflow:siteflow@localhost:5432/siteflow_rehearsal"
npm run --silent rehearsal:postgres -- --json --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production
```

When the rehearsal database is expected to be supplied by local Docker, require Docker explicitly:

```powershell
npm run --silent rehearsal:postgres -- --require-docker --json --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production
```

Required rehearsal evidence:

- `siteflow-postgres-rehearsal` JSON output with `status: "passed"`.
- `release.commitRef`, `release.repository`, and `release.branch` matching the candidate release.
- Confirmation that `SITEFLOW_RUN_POSTGRES_INTEGRATION` was set to `1`.
- Confirmation that `TEST_DATABASE_URL` was present, without recording the raw credential value.
- `targetDatabase` metadata with a redacted URL, host, database name, and `parseStatus: "passed"`.
- `rehearsalScope` entries for migration advisory locking, checksum drift, concurrent migration startup, `SKIP LOCKED`, concurrent worker claim, heartbeat renewal, stale recovery, and exhausted lease failure.
- `scenarioResults` entries with `status: "passed"` for every required `rehearsalScope` item. Each entry records non-sensitive metrics or assertions for the actual migration or queue scenario that ran.
- `scenarioValidation.status: "passed"` from the runner. If Vitest exits successfully but scenario evidence is missing or incomplete, the runner returns `status: "failed"` and `exitCode: 1`.
- The exact command `npx vitest run worker/postgresRehearsal.integration.test.ts`.
- Docker prerequisite status when local Docker is part of the rehearsal setup.

Hard rule: missing `SITEFLOW_RUN_POSTGRES_INTEGRATION`, missing `TEST_DATABASE_URL`, or missing required Docker must be treated as blocked rehearsal evidence. Do not record skipped or dry-run output as a passed production rehearsal.

## Docker build rehearsal

The Docker build rehearsal is opt-in and must run in the target worker profile before accepting Docker source builds as production evidence. It creates a tiny source project, runs `npm ci` and `npm run build` through the real Docker build runner, publishes an artifact, and verifies build-log redaction.

Dry-run the operator entrypoint and capture JSON evidence:

```powershell
$env:SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL = "1"
$env:SITEFLOW_BUILD_IMAGE = "<target-build-image@sha256:...>"
npm run --silent rehearsal:docker-build -- --dry-run --commit-ref <release-sha> --repo <owner/repo> --branch main --json
```

Run the real rehearsal:

```powershell
$env:SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL = "1"
$env:SITEFLOW_BUILD_IMAGE = "<target-build-image@sha256:...>"
npm run --silent rehearsal:docker-build -- --commit-ref <release-sha> --repo <owner/repo> --branch main --json
```

Required Docker build rehearsal evidence:

- `siteflow-docker-build-rehearsal` JSON output with `status: "passed"`.
- `dryRun: false` and `exitCode: 0`.
- Release identity fields for the exact commit, repository, and branch supplied through `--commit-ref`, `--repo`, and `--branch`.
- Confirmation that `SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL` was set to `1`.
- Confirmation that the Docker CLI and daemon were reachable.
- The build image, network, memory, CPU, PID limit, and user posture used for the run.
- The workspace bind mount uses explicit private propagation, equivalent to `--mount type=bind,target=/workspace,bind-propagation=rprivate`.
- The exact build commands `npm ci` and `npm run build`.
- A published artifact summary with entrypoint, file count, bytes, and checksum.
- `redactionVerified: true`.

Hard rule: `docker --version`, mocked Docker tests, static Compose generation, missing release identity, or `--dry-run` output must not be recorded as passed production Docker build evidence.

The release evidence gap report and final bundle check also reject weak Docker rehearsal JSON that omits required prerequisites, does not identify `siteflow-docker-build-rehearsal`, lacks Docker daemon availability, uses a non-`none` build network, omits resource posture, changes the expected `npm ci` / `npm run build` command sequence, or omits artifact byte/checksum evidence.

Release-gate promotion evidence must also include `SITEFLOW_BUILD_MIN_FREE_BYTES` as a positive explicit runtime control. The final bundle and gap report reject old release-gate JSON that omits this build storage preflight threshold, even if the Docker rehearsal output itself is otherwise complete.

Do not run production Docker build rehearsal with `SITEFLOW_BUILD_NETWORK=bridge`. The rehearsal runner records that as a blocking prerequisite and does not execute the build. Runtime Docker builds with `bridge` also reject sensitive build environment keys before build commands run; use `SITEFLOW_BUILD_NETWORK=none` for production promotion.

## Release promotion evidence

Run promotion checks for the exact release commit:

```powershell
$env:GITHUB_TOKEN = "<token-with-read-access>"
npm run siteflow -- release-gate --promotion --env-file <target-env-file> --repo <owner/repo> --branch main --commit-ref <release-sha> --require-commit-status --json
```

Required promotion evidence:

- Exact release commit SHA.
- Target repository and branch.
- `siteflow release-gate --promotion` JSON output.
- JSON `status` plus `promotionEvidence.gateStatus`.
- JSON `promotionEvidence.commitRef`, `repository`, `branch`, and `requiredStatusCheck`.
- JSON `promotionEvidence.branchProtection.status` and required status checks.
- JSON `promotionEvidence.commitStatus.status` plus the successful check-run evidence.
- JSON `promotionEvidence.manualRequired` and `manualRequiredCheckIds`.
- JSON `promotionEvidence.runtimeEnv.status`, `metricsTokenConfigured`, and `unauthenticatedMetricsAllowed`; production promotion must not pass without `SITEFLOW_METRICS_TOKEN` unless `SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1` is explicitly recorded as a private-scrape exception.
- JSON `promotionEvidence.runtimeEnv.apiTokenStrengthStatus`, `metricsTokenStrengthStatus`, `appSecretStrengthStatus`, and `appSecretSource`; production bearer tokens and app sealing secrets must meet the shared minimum strength policy.
- `local.releaseSourceTree` must pass. The release commit must not track `node_modules/`, `dist/`, `dist-cli/`, `dist-server/`, `dist-worker/`, `coverage/`, `playwright-report/`, `test-results/`, `.workflow/`, `.env*`, or local release artifact manifests; these paths are regenerated or secret/scratch state and make `npm ci` / `npm run build` dirty the checkout.
- JSON `promotionEvidence.dirtyWorktree.dirty=false` with no listed worktree entries. `--promotion` does not accept `--allow-dirty`; that flag is only for static sanity checks.
- GitHub branch protection evidence for `main`.
- Exact successful CI check-run evidence for the release commit.
- Required status check name. Default is `Install, test, and build` unless overridden by `--required-status-check`.
- If `github.token` cannot read the protected branch settings or exact commit check runs, configure the workflow secret `SITEFLOW_RELEASE_GITHUB_TOKEN` with repository-scoped read access to those GitHub APIs for release preflight only.
- Target env file review showing required production keys are present without committing secrets.
- Confirmation that the worktree used for promotion did not include unrelated changes.

`manual_required` is acceptable only for no-secret static sanity checks, such as CI running without a GitHub token. It is not acceptable production promotion evidence.

## Artifact Retention Cleanup

Before destructive artifact cleanup, generate a retention plan from an operator-reviewed artifact inventory. The planner is dry-run only: it validates artifact roots stay under the configured artifact root, protects routed or explicitly protected deployments, preserves a minimum number of artifacts per project, and suppresses delete candidates when the inventory is unsafe.

```powershell
npm run --silent release:artifact-retention:plan -- `
  --artifact-root <artifact-root> `
  --inventory <artifact-retention-inventory.json> `
  --retention-days 30 `
  --minimum-retained-per-project 3 `
  --grace-hours 24 `
  --protect-deployment <current-production-deployment-id> `
  --protect-deployment <rollback-deployment-id> `
  --output <artifact-retention-plan.json> `
  --json
```

The inventory file is intentionally summary-only:

```json
{
  "schemaVersion": "siteflow.artifactRetentionInventory.v1",
  "generatedAt": "2026-06-08T12:00:00.000Z",
  "artifacts": [
    {
      "deploymentId": "dep_current",
      "projectId": "project_docs",
      "artifactRoot": "/var/lib/siteflow/artifacts/dep_current",
      "createdAt": "2026-06-01T00:00:00.000Z",
      "retainedUntil": "2026-07-01T00:00:00.000Z",
      "routeChannels": ["production"],
      "storageStatus": "retained"
    }
  ]
}
```

Review `deleteCandidates` before any destructive step. The apply command accepts only a passed `siteflow-artifact-retention-plan`, revalidates every candidate path, and defaults to dry-run:

```powershell
npm run --silent release:artifact-retention:apply -- `
  --plan <artifact-retention-plan.json> `
  --output <artifact-retention-apply-dry-run.json> `
  --json
```

After operator review confirms the current production and rollback deployment ids are retained, run the destructive apply explicitly:

```powershell
npm run --silent release:artifact-retention:apply -- `
  --plan <artifact-retention-plan.json> `
  --output <artifact-retention-apply.json> `
  --yes `
  --json
```

Archive both the reviewed plan and the apply evidence. The apply command deletes only plan `deleteCandidates`; it blocks non-passed plans, candidates outside the plan artifact root, the artifact root itself, active-route candidates, and explicitly protected candidates. It does not schedule recurring cleanup, collect target alert evidence, or provide a rollback for deleted artifacts, so production operators still need backup/restore coverage and monitored scheduling around this workflow.

## Upgrade And Rollback Drill Evidence

Before composing release evidence, run or collect a target-equivalent upgrade/rollback drill for the exact version pair. The checker audits operator-collected evidence only; it does not deploy, restart services, run migrations, or execute rollback commands.

Minimum drill evidence must show:

- Release identity: commit SHA, repository, branch, target environment, operator, and release/change ticket.
- Version pair: `fromVersion`, `toVersion`, and `rollbackVersion`, with rollback returning to `fromVersion`.
- API and worker image digests before, after, and after rollback, pinned to `sha256`.
- Migration/schema versions before, after, and at rollback time, plus proof the rolled-back app is compatible with the post-upgrade schema.
- Passed production off-host backup evidence from `npm run --silent backup:evidence -- --require-off-host --json`, including selected verify, restore-drill, offload, prune evidence and all backup checker rows passing, especially object-storage provider, KMS encryption, provider retention contract, provider KMS proof, and provider retention proof rows.
- Successful non-dry-run upgrade and rollback operation ids that are distinct and ordered inside the drill window.
- Route evidence showing upgrade moved to a new deployment/artifact and rollback restored the previous deployment/artifact.
- Real HTTP verification of the rolled-back route.
- `/readyz` evidence before, after, and after rollback, plus proof traffic was removed during the upgrade window.
- Metrics, logs, and alert delivery evidence for the rollback drill, correlated to the rollback operation and timestamped after rollback completion.

Start from the non-passing raw evidence template when preparing the drill record:

```powershell
npm run --silent upgrade-rollback:evidence:template -- `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-environment production `
  --operator-name "<operator>" `
  --release-ticket "<ticket>" `
  --from-version <current-version> `
  --to-version <candidate-version> `
  --output <upgrade-rollback-evidence-raw.json>
```

The template writes `status: "blocked"`, `dryRun: true`, and `template: true` with `todo` / `null` fields for services, migrations, backup evidence, operations, route state, readiness, metrics, logs, and alert delivery. Replace every placeholder with observations from the real target or target-equivalent drill before checking it:

```powershell
npm run --silent upgrade-rollback:evidence -- --evidence <upgrade-rollback-evidence-raw.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json > <upgrade-rollback-evidence.json>
```

Hard rule: a passed `upgrade-rollback:evidence` result is a release gate input, not proof that SiteFlow has an automated upgrade orchestrator. Forward-compatible schema evidence is required; do not claim down-migration support unless it exists and is separately drilled.

## Ingress evidence

Before composing release evidence, prepare operator ingress proof for the same release commit. Start from the blocking dry-run template when the target has no echo endpoint or the operator needs a structured skeleton for proxy final-hop, forwarded-header, topology, and limiter proof:

```powershell
npm run --silent ingress:operator-evidence:template -- `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-environment production `
  --operator-name <operator> `
  --release-ticket <ticket> `
  --public-base-url <https-url> `
  --trust-proxy-policy <SITEFLOW_TRUST_PROXY> `
  --output <operator-ingress.json>
```

The template writes `status: "blocked"`, `dryRun: true`, and `template: true` with `todo` / `null` fields. It is only a manual operator evidence skeleton and does not prove ingress readiness or satisfy production by itself. Replace every placeholder with real target observations, then collect target ingress evidence:

```powershell
npm run --silent ingress:evidence:collect -- `
  --public-base-url <https-url> `
  --direct-api-url <direct-api-health-url> `
  --target-environment production `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --trust-proxy-policy <SITEFLOW_TRUST_PROXY> `
  --api-instance-count <api-instance-count> `
  --api-process-count <api-process-count> `
  --ingress-count <ingress-count> `
  --api-rate-limit-scope <api-rate-limit-scope> `
  --api-rate-limit-enforcement-point <api-rate-limit-enforcement-point> `
  --operator-name <operator> `
  --release-ticket <ticket> `
  --operator-evidence <operator-ingress.json> `
  --output <ingress-evidence-raw.json> `
  --check-output <ingress-evidence.json> `
  --json
```

The collector actively checks direct API reachability, repeated `/api` traffic for `429`, and non-API route status from the target network. Use `--forwarded-header-echo-url <url>` when the target exposes a controlled echo endpoint for received `X-Forwarded-*` headers; otherwise `--operator-evidence` must provide forwarded-header and proxy final-hop proof. The CLI topology flags can also be supplied through `operator-ingress.json` as `deploymentTopology` / `topology` and `apiRateLimit` evidence. The collector writes blocked raw evidence and blocked checker output when required target facts are missing.

To validate preassembled evidence directly, run:

```powershell
npm run --silent ingress:evidence -- --evidence <ingress-evidence-raw.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json
```

The raw evidence must use `schemaVersion: "siteflow.ingressEvidence.v1"` and `name: "siteflow-ingress-evidence"`. It must be non-dry-run target or target-equivalent evidence showing:

- The public base URL is HTTPS and bound to the target environment.
- The API port is not reachable outside the trusted ingress path.
- `SITEFLOW_TRUST_PROXY` is `loopback`, `private`, or explicit IP/CIDR entries, and the final ingress hop matches that policy without trusting all sources.
- The ingress overwrites `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`, and does not forward client-supplied chains with `$proxy_add_x_forwarded_for`.
- Abusive control-plane `/api` traffic returns `429` from an edge or shared limiter before it reaches any API instance.
- The checker output declares API instance count, API process count, ingress count, limiter scope, and limiter enforcement point. Multi-instance, multi-process, or multi-ingress targets must prove `edge`, `shared`, `global`, or distributed limiter scope, or equivalent edge/proxy/ingress enforcement.
- `/healthz`, `/readyz`, preview routes, and static artifact routes return 2xx and are not throttled by the API edge limiter; `/metrics` returns `200`, `401`, or `403` and is not throttled.
- Operator and release/change ticket metadata are present.

The collector does not configure the ingress, prove ownership of an arbitrary proxy hop without target echo/operator evidence, or replace multi-ingress shared limiter proof. The checker remains the release-bundle gate for the collected output.

## Operator access evidence

Before composing release evidence, collect target or target-equivalent operator access evidence for the same release commit:

```powershell
npm run --silent operator-access:evidence:template -- `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-environment production `
  --public-base-url https://siteflow.example.com `
  --operator-name "<operator>" `
  --release-ticket "<ticket>" `
  --output <operator-access-evidence-raw.json>
```

The template is only a non-passing starting point: it writes `status: "blocked"`, `dryRun: true`, and `template: true` with `todo` / `null` fields. Replace every placeholder with observations from the target or target-equivalent operator access run before checking it:

```powershell
npm run --silent operator-access:evidence -- --evidence <operator-access-evidence-raw.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json > <operator-access-evidence.json>
```

The raw evidence must use `schemaVersion: "siteflow.operatorAccessEvidence.v1"` and `name: "siteflow-operator-access-evidence"`. It must be non-dry-run target or target-equivalent evidence showing:

- Operator session creation uses Bearer admin auth, returns an HttpOnly Secure `SameSite=Lax; Path=/` cookie, and does not return the raw session secret in JSON.
- Session absolute TTL and server-side idle timeout are enforced, with the configured idle timeout in the accepted 60 to 86400 second range.
- Project-scoped sessions work only for matching project routes and are denied for non-matching project and global routes.
- Current-session rotation requires `X-SiteFlow-CSRF: same-origin`, returns a new HttpOnly Secure `SameSite=Lax; Path=/` cookie without returning the raw session secret in JSON, accepts the new cookie, and rejects the old cookie.
- Current-session revoke clears the cookie and rejects the old cookie.
- Cookie-authenticated writes require `X-SiteFlow-CSRF: same-origin`.
- Low-scope Bearer requests do not fall back to admin cookies when both Bearer and cookie credentials are present.
- Mutating control-plane writes derive the executing actor from the authenticated token/session and ignore spoofed body principals.
- Global and project emergency cutoff endpoints are Bearer-only, return `cutoffId` and `revokedAt`, reject cookie-only cutoff attempts, and reject old cookies after cutoff.
- Production browser token storage fallback is disabled in the promoted runtime posture, `localStorage` token fallback is disabled, and any transition exception evidence remains non-production-passing unless release-gate promotion also records fallback disabled.
- Evidence archives no raw Bearer tokens, raw session secrets, or authorization headers, and does not claim full login, IdP, MFA, credentialed CORS, or non-session credential rotation are complete.
- Operator and release/change/incident ticket metadata are present.

This checker audits operator-collected evidence only. It does not create sessions, collect the rotation proof by itself, rotate non-session credentials, probe CORS, or implement a login/IdP workflow.

## Non-session credential evidence

Before composing release evidence, collect target or target-equivalent evidence for non-session credential rotation and break-glass handling for the same release commit:

```powershell
npm run --silent non-session-credential:evidence:template -- `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-environment production `
  --operator-name "<operator>" `
  --release-ticket "<ticket>" `
  --output <non-session-credential-evidence-raw.json>
```

The template is only a non-passing starting point: it writes `status: "blocked"`, `dryRun: true`, and `template: true` with `todo` / `null` fields for supported credential types and break-glass controls. Replace every placeholder with target or target-equivalent observations before checking it:

```powershell
npm run --silent non-session-credential:evidence -- --evidence <non-session-credential-evidence-raw.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json > <non-session-credential-evidence.json>
```

The raw evidence must use `schemaVersion: "siteflow.nonSessionCredentialEvidence.v1"` and `name: "siteflow-non-session-credential-evidence"`. It must be non-dry-run target or target-equivalent evidence showing:

- Release identity, target environment, operator, and release/change/incident ticket metadata.
- At least one supported credential entry: `scoped_api_token`, `root_api_token`, `metrics_token`, `app_sealing_secret`, `database`, `webhook_secret`, `ssh_deploy_key`, `log_drain_signing_secret`, or `deploy_hook_token`.
- Credential owner and ticket metadata for every credential entry.
- Old and new credential identifiers or prefixes are redacted; no raw secret, Authorization header, database URL password, token body, or session secret is archived.
- Replaceable credentials prove old credential rejection and new credential acceptance.
- Scoped API tokens include create evidence, revoke evidence, audit events, consumer cutover, least-privilege review, and explicit scopes.
- Runtime root/API and metrics tokens include strength posture, secret-store update, service or scraper reload, old-token rejection, and new-token acceptance.
- App/sealing secret evidence includes backup completion, reseal plan, rollback plan, spot check, risk acceptance, and no automatic-rotation claim.
- Provider-managed credentials include provider rotation proof and dependent service verification.
- Break-glass evidence includes ticket/source, approval or accepted exception, least-privilege review, time bounds, post-incident revocation, and no raw credential archival.

This checker audits operator-collected evidence only. It does not generate, distribute, rotate, reload, or revoke external credentials by itself. A claim that SiteFlow automatically rotated non-session or external credentials blocks the evidence.

## Release evidence rehearsal pack

Before a target promotion window, generate an offline evidence rehearsal pack for the exact release commit:

```powershell
npm run --silent release:evidence:rehearsal-pack -- `
  --commit-ref <sha> `
  --repo <owner/repo> `
  --branch main `
  --target-env-file evidence/target.env `
  --public-base-url https://siteflow.example.com `
  --operator-name "<operator>" `
  --release-ticket "<ticket>" `
  --docker-socket-profile-accepted `
  --output-dir evidence/release-<sha> `
  --json
```

The pack writes `release-evidence-rehearsal-pack.json` and `release-evidence-rehearsal-pack.md`. It binds the expected evidence file paths and commands to one release identity and target environment: release gate, Docker build rehearsal, Postgres rehearsal, source provider evidence, backup evidence, observability evidence, operator access evidence, non-session credential evidence, ingress evidence, upgrade/rollback evidence, final bundle compose, and final release evidence check. The source provider, operator access, non-session credential, ingress operator, and upgrade/rollback steps also print matching template commands for their pack raw/operator evidence paths; those templates are intentionally blocked/dry-run manual evidence skeletons and must be completed with real observations before checker outputs can satisfy the release bundle.

Pass `--docker-socket-profile-accepted` only after the release owner has recorded acceptance of the trusted single-host Docker socket worker profile. Without that flag, the generated final compose command does not include Docker socket acceptance and a Docker-runner production bundle must still be manually accepted before it can pass.

The generated JSON pack is a contract. `release:evidence:target-run` and `release:evidence:gaps` reject incomplete, truncated, or hand-edited packs that omit required evidence steps, required command semantics, final commands, or release evidence output paths. The contract checks the expected `npm` executable, script names, release identity flags, target-environment flags, required environment variable names, and `captureStdoutTo` / `--output` / `--check-output` bindings before any target command is executed or reported.

This pack is a planning and operator handoff artifact only. It does not call GitHub, run Docker, run Postgres, create backups, execute the generated ingress collector, scrape metrics, create sessions, rotate credentials, or generate synthetic checker outputs. It is not production evidence until every command output exists and `npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment <environment> --json` passes.

## Release preflight workflow

Use the manual GitHub Actions `Release Preflight` workflow before a promotion window when GitHub has access to the release repository, a target env file can be supplied through the `SITEFLOW_RELEASE_ENV_FILE_B64` secret, and SiteFlow API access can be supplied through the `SITEFLOW_API_TOKEN` secret.

The workflow checks out the exact `commit_ref`, validates that the `repo` input matches the checkout, requires the target build image to be digest-pinned, requires `docker_socket_profile_accepted=true` before generating a pack that accepts the trusted single-host worker profile, runs the production build, checks that `npm ci` and `npm run build` leave the checkout clean before decoding target secrets, inspects `candidate_deployment_id` through `siteflow_api_url`, runs `release:artifacts:check` against the private deployment detail, writes only the sanitized `deployment-artifact-manifest.json`, runs `siteflow release-gate --promotion --require-commit-status`, generates the release evidence rehearsal pack, runs non-plan-only `release:evidence:target-run`, writes a gap report artifact, runs Playwright E2E safeguards, removes private inputs, and uploads the remaining evidence and Playwright artifacts.

Because that workflow target-run is not `--plan-only`, it may invoke generated pack commands against the supplied target or target-equivalent services. A `blocked` or `failed` target-run artifact is expected while evidence is incomplete and is not a production-ready signal. When the operator only wants to verify command contract, placeholder replacement, and required environment names, run the same target-run command with `--plan-only` before executing the workflow or before removing the flag locally.

To prepare the env file secret, base64-encode the target env file outside GitHub and store it as `SITEFLOW_RELEASE_ENV_FILE_B64`. The workflow decodes it to `$RUNNER_TEMP/siteflow-release-secrets/target.env`, referenced as `SITEFLOW_TARGET_ENV_FILE`, and removes it before artifact upload. The raw deployment detail is written under `$RUNNER_TEMP/siteflow-release-private` and removed before upload; only sanitized evidence under `$RUNNER_TEMP/siteflow-release-preflight` is uploaded. Do not add raw tokens, app secrets, database passwords, webhook signing secrets, or raw deployment details to other operator evidence files.

The preflight artifact is coordination evidence, not final production evidence. A failing gap report or target-run record is expected until target Docker, Postgres, source provider, backup, observability, operator access, non-session credential, ingress, and upgrade/rollback outputs have been collected. The final promotion still requires the composed `release-evidence.json` to pass `release:evidence` for the exact commit and `production` target.

## Release evidence gap report

During a promotion rehearsal, use the pack to report which target evidence files are still missing or blocked:

```powershell
$env:SITEFLOW_DIRECT_API_URL = 'https://siteflow-api.internal:8787/readyz'
$env:SITEFLOW_RELEASE_IMAGE_RUN_ID = '123456789'
npm run --silent release:evidence:gaps -- `
  --pack evidence/release-<sha>/release-evidence-rehearsal-pack.json `
  --set-env direct-api-url=SITEFLOW_DIRECT_API_URL `
  --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID `
  --json
```

The gap reporter reads the rehearsal pack and existing evidence outputs only. It first validates that the pack contains the complete required release evidence command contract, including command semantics and output target bindings. It then reports each planned evidence file, the final composed bundle, and the final release evidence check as `passed`, `missing`, `invalid`, `blocked`, `failed`, `manual_required`, `dry_run_only`, `stale`, or `identity_mismatch`, and includes the next command from the pack for non-passing items.

The report also includes `inputGaps` on each item when the next command references missing raw input files, required environment variable names, or unresolved structured command argument placeholders such as `<release-image-run-id>`, `<direct-api-url>`, and `<api-instance-count>`. Pass repeatable `--set KEY=value` options to rehearse placeholder replacement without running the command, or `--set-env KEY=ENV_NAME` to read the replacement from an environment variable. It never prints environment variable values, `--set` replacement values, or resolved `--set-env` values, and does not read target env-file contents; it only records referenced local files, variable names, placeholder keys, and `--set-env` key/env-name pairs.

For `postgres_rehearsal`, `docker_build_rehearsal`, `source_provider_evidence`, `backup_evidence`, `observability_evidence`, `operator_access_evidence`, `non_session_credential_evidence`, `ingress_evidence`, and `upgrade_rollback_evidence`, the gap reporter also runs evidence-specific diagnostics before the final bundle check. A JSON file that generically says `status: "passed"` is still reported as `blocked` when required Postgres scenario results are missing or were collected for a different `targetEnvironment`, Docker runner profile or artifact integrity fields are weak, source provider evidence lacks selected provider/webhook/release identity or required checker rows, backup evidence was not checked with `requireOffHost: true` and complete selected verify/restore/offload/prune evidence, observability evidence lacks selected readiness/metrics/backup automation/alert/dashboard/log summaries and required observability checker rows, operator access/non-session credential/ingress checker outputs lack selected release-bound evidence, target-environment binding, or non-empty passing checker rows, or upgrade/rollback evidence lacks target binding, operation order, backup, route, readiness, observability, operator, and ticket checker rows. These issues appear in `failedChecks` with names such as `postgres_target_environment`, `postgres_scenario_results`, `docker_build_rehearsal_profile`, `docker_build_rehearsal_artifact`, `source_provider_selected_evidence`, `source_provider_required_checks`, `backup_off_host_required`, `backup_offload_prune_checks`, `observability_selected_evidence`, `observability_required_checks`, `operator_access_target_environment`, `non_session_credential_target_environment`, `ingress_target_environment`, `upgrade_rollback_target_environment`, or `upgrade_rollback_required_checks` so operators can rerun the pack command instead of discovering the issue only at final bundle time.

For the final bundle and final release evidence check, the gap reporter runs the same final bundle checker semantics used by `release:evidence` and requires final check output to include the expected checker name, `evidencePath`, selected release identity, and non-empty passing checks. The final-check rows must include every currently recomputed release evidence bundle check `name` and `status`; copied stale final-check JSON whose rows no longer match the bundle checker is reported as `blocked` or `invalid`. A shallow bundle with only `schemaVersion` and `name`, a bundle for the wrong target environment, or copied final-check JSON without checker shape is reported as `blocked` or `invalid` before operators attempt promotion.

This is an audit and operator handoff tool. It does not call GitHub, run Docker, run Postgres, create backups, scrape metrics, execute the generated ingress collector, create sessions, rotate credentials, or perform upgrade/rollback drills. A clean gap report is not a substitute for the final `release:evidence` check; it only indicates that the expected files and immediate command inputs look usable.

Before collecting target evidence, verify the release source tree is clean enough to reconstruct from source:

```powershell
npm run --silent release:source:check -- --json
```

The check fails when Git tracks generated build output, dependency installs, real environment files, local release artifact manifests, Playwright output, or `.workflow/` scratch state. `.env.example` is the documented non-secret template and is allowed; `.env`, `.env.local`, `.env.production`, and other real env files remain forbidden. Treat failures as a release blocker: remove those paths from the Git index in a reviewed cleanup commit and keep them ignored before creating the release commit. Do not delete local operator evidence or unrelated worktree changes as part of this check.

To prepare that reviewed cleanup without changing the Git index, generate a cleanup plan:

```powershell
npm run --silent release:source:cleanup-plan -- `
  --output release-source-cleanup-plan.json `
  --json
```

The cleanup plan is a read-only Git index review tool. Its JSON status is `blocked` when forbidden tracked paths are present and `pass` when none are found. It reports `trackedPathCount`, `forbiddenPathCount`, grouped `forbiddenRoots`, a truncated `forbiddenPaths` list controlled by `--max-findings`, `recommendedCommands`, `warnings`, and `checkedAt`. The recommended commands intentionally include `git rm --cached -r -- .workflow dist dist-cli dist-server dist-worker node_modules test-results` so reviewed paths are removed from Git tracking only; the tool never runs those commands and does not delete working tree files.

Treat `recommendedCommands` as an operator checklist, not automation. A real Git index cleanup requires explicit human confirmation after reviewing the listed paths, then a separate cleanup commit. Do not run filesystem delete commands, `git reset`, `git checkout`, or broad staging to make the source check pass.

After the reviewed index-only cleanup plan, generate a release commit readiness plan before staging production-gate files:

```powershell
npm run --silent release:commit:plan -- `
  --output release-commit-readiness-plan.json `
  --json
```

The commit readiness plan is also read-only. It combines the forbidden tracked release-source summary with production-critical untracked files such as `.github/workflows/ci.yml`, `.github/workflows/release-preflight.yml`, `.github/workflows/release-image.yml`, `.gitignore`, `.dockerignore`, `Dockerfile`, `.env.example`, `tsconfig.scripts.json`, release gate/source policy files, release evidence scripts, and production runbooks. It also reports non-forbidden tracked dirty source files as `trackedDirtySource` so existing source edits are not missed when preparing the release commit. Its `suggestedStagingGroups` and `recommendedCommands` use explicit pathspecs and intentionally never recommend `git add .`. Review the plan, stage only the listed production-readiness paths that belong in the release commit, and keep generated, dependency, scratch, report, and evidence JSON paths excluded.

The safe source-to-commit sequence is: run `release:source:cleanup-plan`, perform any approved index-only cleanup as a separate commit, run `release:commit:plan`, stage reviewed production-readiness files with explicit pathspecs, then rerun `release:source:check` and `siteflow release-gate`. Neither planning command changes the Git index.

The release image workflow uploads `release-image-evidence.json` with the GHCR image name, version tag, commit tag, digest, repository, commit, ref, GitHub run identifiers, and registry attestation inspection metadata. The workflow fails before upload if the published digest does not expose registry SLSA provenance and SBOM attestation manifests. Archive that artifact with the release preflight outputs; a digest in a step summary is operator-readable, but the JSON artifact is the evidence input that downstream automation can compare. The release evidence rehearsal pack now includes a `release_image_evidence` step that downloads this artifact with `gh run download <release-image-run-id> --name release-image-evidence --dir <evidence-dir>`, and final `release:evidence:compose` requires `--release-image-evidence <file>`.

After a production promotion has been accepted and the route is expected to be applied, collect post-promotion evidence that the passing release bundle is the one stored on the live production route:

```powershell
npm run --silent release:evidence:post-promote -- `
  --release-evidence evidence/release-evidence.json `
  --server https://siteflow.example.com `
  --token $env:SITEFLOW_API_TOKEN `
  --deployment <deployment-id> `
  --project <project-id> `
  --expected-evidence-path evidence/release-evidence.json `
  --json
```

This checker is read-only. It re-runs the final release evidence bundle evaluator, fetches deployment detail through the SiteFlow API, verifies the deployment is ready, verifies the route revision is applied to the inspected deployment, and compares the route's stored release evidence metadata plus artifact counts against the release bundle. It proves the promotion record is bound to the live route it inspected; it does not replace the pre-promotion `release:evidence` gate or prove global CDN convergence.

## Release evidence target run

On the target evidence host, use the pack runner when you want a single command to execute the pack commands, write a stable run record, and archive gap snapshots after each step:

```powershell
$env:SITEFLOW_DIRECT_API_URL = 'https://siteflow-api.internal:8787/readyz'
$env:SITEFLOW_RELEASE_IMAGE_RUN_ID = '<github-actions-run-id>'
$env:SITEFLOW_TRUST_PROXY = 'loopback'
$env:SITEFLOW_API_INSTANCE_COUNT = '1'
$env:SITEFLOW_API_PROCESS_COUNT = '1'
$env:SITEFLOW_INGRESS_COUNT = '1'
$env:SITEFLOW_API_RATE_LIMIT_SCOPE = 'edge'
$env:SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT = 'ingress'
npm run --silent release:evidence:target-run -- `
  --pack evidence/release-<sha>/release-evidence-rehearsal-pack.json `
  --confirm-target-environment production `
  --set-env direct-api-url=SITEFLOW_DIRECT_API_URL `
  --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID `
  --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY `
  --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT `
  --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT `
  --set-env ingress-count=SITEFLOW_INGRESS_COUNT `
  --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE `
  --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT `
  --json
```

Before executing target commands, run the same command with `--plan-only`.
Plan-only mode writes the run record and initial gap snapshot, reports each
pack command as `planned` or `blocked`, and exits before invoking Docker,
Postgres, backup, observability, ingress, credential, or rollback commands.
Treat it as command-contract and prerequisite rehearsal only; it is not target
evidence and cannot satisfy the final promotion gate.

Do not copy bare angle-bracket placeholders into PowerShell commands. Replace placeholder values first, and prefer `--set-env KEY=ENV_NAME` for target topology values so run scripts show stable environment variable names rather than the values themselves. If you use `--set`, quote values that contain `=`, `:`, `/`, spaces, or shell-sensitive characters.

The runner refuses to start when the pack is incomplete, when a pack command no longer matches the generated command semantics, or when `--confirm-target-environment` does not match the pack. It also blocks commands that still contain unresolved placeholders, missing required environment variable names, missing `npm` / `gh` executables on `PATH`, command output that matches secret patterns before writing captured stdout to an evidence file, or gap report snapshots that would archive sensitive diagnostic text. The run record stores command display strings, env requirement names, executable requirement status, replacement key names, `--set-env` key/env-name pairs, output paths, exit codes, byte counts, and gap snapshot paths; it does not store environment variable values, replacement values, raw stdout, or raw stderr.

Use `--continue-on-error` only when collecting partial evidence during rehearsal. A target run is `completed` only when all pack commands have completed and the final `release:evidence:gaps` snapshot has no gaps. That still is not a production promotion by itself; the final `release:evidence` checker output remains the release gate.

## Release evidence bundle

After collecting the real promotion, Docker build rehearsal, Postgres rehearsal, source provider, target runtime, backup, observability, operator access, non-session credential, ingress, and upgrade/rollback drill outputs, compose them into one release evidence file:

```powershell
npm run --silent release:evidence:compose -- `
  --release-gate evidence/release-gate.json `
  --docker-build evidence/docker-build-rehearsal.json `
  --postgres-rehearsal evidence/postgres-rehearsal.json `
  --artifact-evidence evidence/release-artifact-evidence.json `
  --release-image-evidence evidence/release-image-evidence.json `
  --source-provider-evidence evidence/source-provider-evidence.json `
  --target-runtime-evidence evidence/target-runtime-evidence.json `
  --backup-evidence evidence/backup-evidence.json `
  --observability-evidence evidence/observability-evidence.json `
  --operator-access-evidence evidence/operator-access-evidence.json `
  --non-session-credential-evidence evidence/non-session-credential-evidence.json `
  --ingress-evidence evidence/ingress-evidence.json `
  --upgrade-rollback-evidence evidence/upgrade-rollback-evidence.json `
  --target-environment production `
  --operator-name "<operator>" `
  --release-ticket "<ticket>" `
  --output release-evidence.json
```

Use `--ticket-id` as an alias for `--release-ticket` when the release process names the change record that way. Use `--checked-at <iso>` only for a recorded, reproducible bundle timestamp. If `siteflow release-gate --promotion --json` records `SITEFLOW_BUILD_RUNNER=host` with a host-build exception, the composer requires `--host-build-exception-accepted` and records that exception in the bundle; do not use it for untrusted source builds. If the release gate records `SITEFLOW_BUILD_RUNNER=docker`, the Docker build rehearsal input is required and must include raw release commit, repository, and branch identity.

Then validate the composed bundle:

```powershell
npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json
```

Mutating CLI production promotion commands must use the same passing bundle:

```powershell
npm run siteflow -- promote <deploymentId> `
  --project <project-id> `
  --server https://siteflow.example.com `
  --release-evidence <release-evidence.json> `
  --reason "<release-ticket>: promote verified release evidence" `
  --json
```

```powershell
npm run siteflow -- deploy --prebuilt ./dist `
  --project <project-slug> `
  --prod `
  --release-evidence <release-evidence.json> `
  --json
```

For production prebuilt deployments, the CLI sends the passing bundle identity with the prebuilt upload before promotion. The deployment row records `source_branch` and `source_commit_sha`, and the artifact manifest metadata records `source.repository`, `source.branch`, `source.commitSha`, and the release evidence metadata. This improves provenance for static/prebuilt artifacts, but the final promotion still depends on the passing bundle for the exact release commit and target environment.

Production promotion and rolling traffic-advance actions also compare the supplied release evidence metadata with the target or candidate deployment source identity. A production command is rejected when repository, branch, or commit differ, or when an older deployment lacks source identity metadata. SiteFlow stores the release evidence metadata on release command and route revision records for audit, including rejected promotion commands. `siteflow inspect <deploymentId>` displays the route revision release evidence metadata when it is available, so incident review can start from a deployment id instead of requiring the original operation id.

Production rolling releases also require the same passing bundle for every action that can advance customer traffic or complete promotion. `rolling abort` does not require a full release evidence bundle because it stops the rollout, but production abort still requires an explicit audit reason and records a `production_rolling_abort_stop_rollout` release evidence exception on the command and route revision:

```powershell
npm run siteflow -- rolling start <candidateDeploymentId> `
  --project <project-id> `
  --server https://siteflow.example.com `
  --percentage 10 `
  --release-evidence <release-evidence.json> `
  --reason "<release-ticket>: start verified rolling release" `
  --json
```

```powershell
npm run siteflow -- rolling advance `
  --project <project-id> `
  --server https://siteflow.example.com `
  --percentage 50 `
  --release-evidence <release-evidence.json> `
  --reason "<release-ticket>: advance verified rolling release" `
  --json
```

```powershell
npm run siteflow -- rolling complete `
  --project <project-id> `
  --server https://siteflow.example.com `
  --release-evidence <release-evidence.json> `
  --reason "<release-ticket>: complete verified rolling release" `
  --json
```

```powershell
npm run siteflow -- rolling abort `
  --project <project-id> `
  --server https://siteflow.example.com `
  --reason "<incident-ticket>: stop rollout and preserve current production route" `
  --json
```

Evidence file shape:

```json
{
  "schemaVersion": "siteflow.releaseEvidence.v1",
  "name": "siteflow-release-evidence-bundle",
  "checkedAt": "2026-06-07T11:30:00.000Z",
  "targetEnvironment": "production",
  "release": {
    "commitRef": "abc123def456",
    "repository": "owner/repo",
    "branch": "main",
    "requiredStatusCheck": "Install, test, and build",
    "operatorName": "release-operator",
    "releaseTicket": "REL-2026-0607"
  },
  "releaseGate": {
    "sourcePath": "evidence/release-gate.json",
    "collectedAt": "2026-06-07T10:10:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "status": "pass",
      "checkedAt": "2026-06-07T10:09:00.000Z",
      "promotionEvidence": {
        "gateStatus": "pass",
        "checkedAt": "2026-06-07T10:09:00.000Z",
        "...": "promotionEvidence object from siteflow release-gate --promotion --json"
      }
    }
  },
  "postgresRehearsal": {
    "sourcePath": "evidence/postgres-rehearsal.json",
    "collectedAt": "2026-06-07T10:06:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent rehearsal:postgres -- --json"
    }
  },
  "dockerBuildRehearsal": {
    "sourcePath": "evidence/docker-build-rehearsal.json",
    "collectedAt": "2026-06-07T10:19:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent rehearsal:docker-build -- --json"
    }
  },
  "sourceProviderEvidence": {
    "sourcePath": "evidence/source-provider-evidence.json",
    "collectedAt": "2026-06-07T10:21:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent source-provider:evidence -- --json"
    }
  },
  "backupEvidence": {
    "sourcePath": "evidence/backup-evidence.json",
    "collectedAt": "2026-06-07T10:31:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent backup:evidence -- --require-off-host --json"
    }
  },
  "observabilityEvidence": {
    "sourcePath": "evidence/observability-evidence.json",
    "collectedAt": "2026-06-07T11:01:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent observability:evidence -- --json"
    }
  },
  "ingressEvidence": {
    "sourcePath": "evidence/ingress-evidence.json",
    "collectedAt": "2026-06-07T11:06:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent ingress:evidence -- --json"
    }
  },
  "operatorAccessEvidence": {
    "sourcePath": "evidence/operator-access-evidence.json",
    "collectedAt": "2026-06-07T11:04:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent operator-access:evidence -- --json"
    }
  },
  "nonSessionCredentialEvidence": {
    "sourcePath": "evidence/non-session-credential-evidence.json",
    "collectedAt": "2026-06-07T11:05:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent non-session-credential:evidence -- --json"
    }
  },
  "upgradeRollbackEvidence": {
    "sourcePath": "evidence/upgrade-rollback-evidence.json",
    "collectedAt": "2026-06-07T11:15:00.000Z",
    "releaseCommit": "abc123def456",
    "evidence": {
      "...": "output from npm run --silent upgrade-rollback:evidence -- --json"
    }
  }
}
```

The release bundle checker blocks:

- `manual_required`, `skipped`, failed, or non-promotion release-gate evidence.
- Missing, stale, future-dated, or wrapper-newer-than-raw release-gate `checkedAt` evidence; old `siteflow release-gate --promotion --json` output cannot be repackaged with a fresh bundle attachment.
- Missing or invalid `schemaVersion`, bundle `name`, `checkedAt`, `targetEnvironment`, attachment `sourcePath`, attachment `collectedAt`, or attachment `releaseCommit`.
- Missing or inconsistent commit, repository, branch, or required status check evidence.
- Missing GitHub branch protection or exact commit check-run evidence.
- Commit check-run evidence whose name, status, or conclusion does not match the required successful CI check.
- Runtime evidence that does not show passing production strength checks for `SITEFLOW_API_TOKEN`, `SITEFLOW_METRICS_TOKEN`, and `SITEFLOW_APP_SECRET` or `SITEFLOW_SEALING_KEY`, unless unauthenticated metrics are explicitly accepted as a private-scrape exception.
- Missing, dry-run, failed, stale, image-mismatched, or release-identity-missing Docker build rehearsal evidence when promotion runtime env uses `SITEFLOW_BUILD_RUNNER=docker`.
- Missing, failed, stale, spoofed-checker, target-environment-mismatched, or release-mismatched source provider evidence, including missing provider support, repository binding, exact checkout, safe remote URL, signed webhook verification, webhook secret hygiene, deploy-key policy, SSH host-key policy, release provenance, operator, or ticket checks.
- Postgres rehearsal evidence from `--dry-run`, failed prerequisites, missing release identity, wrong `targetEnvironment`, missing target database metadata, or incomplete rehearsal scope.
- Backup evidence not checked with `requireOffHost: true`.
- Backup, observability, operator access, non-session credential, or ingress checker output with any failed checks.
- Missing, failed, stale, spoofed-checker, target-environment-mismatched, or release-mismatched operator access evidence, including missing proof for session creation cookie flags, rotation cookie flags, secret-free responses, old-cookie rejection after rotation, project-scope denial, CSRF enforcement, Bearer precedence, actor attribution, Bearer-only emergency cutoff, cutoff old-cookie rejection, and no raw credential archival.
- Missing, failed, stale, spoofed-checker, target-environment-mismatched, or release-mismatched non-session credential evidence, including missing proof for redacted old/new identifiers, old credential rejection, new credential acceptance, scoped token audit/cutover, runtime token strength/reload, app-secret reseal/rollback planning, provider-managed rotation proof, break-glass controls, and no automatic rotation claim.
- Missing, failed, stale, spoofed-checker, target-environment-mismatched, or release-mismatched ingress evidence, including missing proof that direct API port access is blocked, forwarded headers are overwritten, final-hop proxy policy matches, API abuse returns `429`, and non-API routes are not throttled.
- Missing, failed, dry-run, stale, target-environment-mismatched, or release-mismatched upgrade/rollback drill evidence.
- Stale rehearsal/checker outputs, stale dashboard evidence, or invalid evidence timestamp order. Default maximum age is 168 hours; override only with a recorded release or incident exception.

The composer does not verify the evidence. The checker does not call GitHub, run Postgres, run Docker builds, perform restore drills, probe ingress, create sessions, scrape metrics, or deliver alerts. Together they only prove that the required target-environment evidence has been collected into the expected shape and is internally consistent.

## Known non-goals and remaining hard blockers

The following items are outside the current trusted single-host/staging profile and block a full production-ready claim:

- Untrusted multi-tenant source-build isolation.
- Real target-profile Docker build rehearsal is required before Docker source builds are promotion evidence; mocked tests and `docker --version` are not enough.
- Real Postgres multi-worker rehearsal for queue lease, retry, heartbeat, stale recovery, and migrations.
- Real protected GitHub repository promotion evidence for the exact release commit.
- Real restore drills against disposable Postgres and artifact targets.
- Object-storage/provider-backed off-host backup storage beyond `file://`, KMS/provider retention proof, applied recurring schedule evidence, recurring monitored restore drills, and monitored RPO/RTO workflow.
- Automated monitoring-stack configuration, log shipping, retention, and multi-instance aggregation.
- Target ingress evidence that proves the API port cannot be bypassed and that shared or edge API limiting is enforced for the actual topology.
- Full multi-user login/session lifecycle beyond the current API-level operator session MVP.
- Real non-session credential rotation and break-glass execution for root API tokens, metrics tokens, app/sealing secrets, database credentials, webhook secrets, deploy hooks, log drains, and deploy keys.
- External Postgres and external object storage install paths.
- Target-environment upgrade and rollback drills for API, worker, schema, and artifacts.
- TLS/DNS wildcard automation and renewal failure rollback.
