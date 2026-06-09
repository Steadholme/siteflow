# SiteFlow Production Entry Point

This is the short production entry point for operators and release owners. It
does not replace the detailed runbooks under `docs/`; it points to the minimum
gate and evidence needed before any production promotion.

## Current status

SiteFlow is not automatically production-ready.

Current production-hardening supports only a narrow trusted single-host or
controlled staging profile. Full production promotion still depends on
target-environment evidence for the exact release commit, including release
gate, Docker build rehearsal, Postgres rehearsal, source provider provenance,
backup/restore, observability, operator access, ingress, non-session
credential, and upgrade/rollback evidence.

The single-host Docker Compose profile is an audited baseline, not a
high-availability or multi-tenant production design. The worker profile still
mounts `/var/run/docker.sock`; treat the worker as having host Docker daemon
control. The worker defaults to non-root `SITEFLOW_WORKER_USER=1000:1000`, and
the target env-file must set `SITEFLOW_DOCKER_SOCKET_GID` to
`stat -c '%g' /var/run/docker.sock` from the target host.

Private repository checkout must use worker-mounted filesystem paths, not
URL-embedded credentials. Configure `SITEFLOW_GIT_SSH_KEY_PATH` and
`SITEFLOW_GIT_KNOWN_HOSTS_PATH` only to sanitized target paths backed by
operator-managed deploy-key and host-key evidence.

## Shortest local gate

Run this from a clean release checkout before collecting target evidence:

```sh
npm ci
npm run release:source:check
npm run release:commit:plan -- --fail-on-blocked --json
npm test -- --run
npm run build
npm run release:artifacts:check -- --commit-ref <full-sha> --repo <owner/repo> --branch main --target-environment ci --json
npm run test:e2e
npm run siteflow -- release-gate --allow-dirty --allow-manual-branch-protection
```

This is a local/static gate only. `--allow-manual-branch-protection` and dirty
worktree allowances are acceptable for no-secret sanity checks, not for
production promotion. The local artifact check above proves source artifacts;
production artifact evidence still must attach a release-bound deployment detail
or sanitized deployment artifact manifest through the release preflight flow.

For promotion, the gate must run against the target release identity and real
runtime configuration:

```sh
npm run siteflow -- release-gate --promotion --env-file <target-env-file> --repo <owner/repo> --branch main --commit-ref <sha> --require-commit-status
```

## Target evidence bundle

Collect and archive evidence for the exact `<sha>`, `<owner/repo>`, `main`, and
`production` target environment. The release bundle is the promotion contract;
individual dry-run templates or local checks are not enough.

Set `SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY` or
`SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE` before composing and checking the
final bundle. Production API startup and production mutation gates require this
key to verify the bundle attestation signature. Set
`SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID` when the API must pin a
specific non-secret attestation key id during key rotation.

Key evidence commands:

```sh
npm run --silent release:evidence:rehearsal-pack -- --commit-ref <sha> --repo <owner/repo> --branch main --source-provider github --target-env-file <target-env-file> --public-base-url <https-url> --operator-name <operator> --release-ticket <ticket> --output-dir <evidence-dir> --docker-socket-profile-accepted --json

npm run --silent release:evidence:pack-contract -- --json

SITEFLOW_DIRECT_API_URL=<direct-api-health-url> \
SITEFLOW_RELEASE_IMAGE_DIGEST=sha256:<release-image-digest> \
SITEFLOW_RELEASE_IMAGE_RUN_ID=<github-actions-run-id> \
SITEFLOW_TRUST_PROXY=<trust-proxy-policy> \
SITEFLOW_API_INSTANCE_COUNT=<count> \
SITEFLOW_API_PROCESS_COUNT=<count> \
SITEFLOW_INGRESS_COUNT=<count> \
SITEFLOW_API_RATE_LIMIT_SCOPE=<edge|shared|global|distributed|process_local> \
SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT=<edge|proxy|load_balancer|gateway|ingress|cdn|api> \
SITEFLOW_SOURCE_PROVIDER_WEBHOOK_DELIVERY_ID=<delivery-id> \
SITEFLOW_SOURCE_PROVIDER_DEPLOY_KEY_PATH=<deploy-key-path> \
SITEFLOW_SOURCE_PROVIDER_KNOWN_HOSTS_PATH=<known-hosts-path> \
SITEFLOW_OPERATOR_ACCESS_PROJECT_ID=<allowed-project-id> \
SITEFLOW_OPERATOR_ACCESS_DENIED_PROJECT_ID=<denied-project-id> \
SITEFLOW_OLD_METRICS_TOKEN_REDACTED_ID=<old-metrics-token-redacted-id> \
SITEFLOW_NEW_METRICS_TOKEN_REDACTED_ID=<new-metrics-token-redacted-id> \
SITEFLOW_OLD_ROOT_API_TOKEN_REDACTED_ID=<old-root-api-token-redacted-id> \
SITEFLOW_NEW_ROOT_API_TOKEN_REDACTED_ID=<new-root-api-token-redacted-id> \
SITEFLOW_BREAK_GLASS_SOURCE=<vault-or-ticket-system> \
SITEFLOW_BREAK_GLASS_APPROVER_COUNT=<count> \
npm run --silent release:evidence:target-run -- \
  --pack <evidence-dir>/release-evidence-rehearsal-pack.json \
  --confirm-target-environment production \
  --set-env direct-api-url=SITEFLOW_DIRECT_API_URL \
  --set-env release-image-digest=SITEFLOW_RELEASE_IMAGE_DIGEST \
  --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID \
  --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY \
  --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT \
  --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT \
  --set-env ingress-count=SITEFLOW_INGRESS_COUNT \
  --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE \
  --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT \
  --set-env webhook-delivery-id=SITEFLOW_SOURCE_PROVIDER_WEBHOOK_DELIVERY_ID \
  --set-env deploy-key-path=SITEFLOW_SOURCE_PROVIDER_DEPLOY_KEY_PATH \
  --set-env known-hosts-path=SITEFLOW_SOURCE_PROVIDER_KNOWN_HOSTS_PATH \
  --set-env operator-access-project-id=SITEFLOW_OPERATOR_ACCESS_PROJECT_ID \
  --set-env operator-access-denied-project-id=SITEFLOW_OPERATOR_ACCESS_DENIED_PROJECT_ID \
  --set-env old-metrics-token-redacted-id=SITEFLOW_OLD_METRICS_TOKEN_REDACTED_ID \
  --set-env new-metrics-token-redacted-id=SITEFLOW_NEW_METRICS_TOKEN_REDACTED_ID \
  --set-env old-root-api-token-redacted-id=SITEFLOW_OLD_ROOT_API_TOKEN_REDACTED_ID \
  --set-env new-root-api-token-redacted-id=SITEFLOW_NEW_ROOT_API_TOKEN_REDACTED_ID \
  --set-env break-glass-source=SITEFLOW_BREAK_GLASS_SOURCE \
  --set-env break-glass-approver-count=SITEFLOW_BREAK_GLASS_APPROVER_COUNT \
  --json

SITEFLOW_RUN_POSTGRES_INTEGRATION=1 TEST_DATABASE_URL=<target-or-disposable-postgres-url> npm run --silent rehearsal:postgres -- --json --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production

SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL=1 SITEFLOW_BUILD_IMAGE=<target-image> npm run --silent rehearsal:docker-build -- --commit-ref <sha> --repo <owner/repo> --branch main --json

npm run --silent source-provider:evidence:collect -- --provider github --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --operator-name <operator> --release-ticket <ticket> --webhook-delivery-id <delivery-id> --webhook-signature-verified --webhook-secret-configured --deploy-key-path <deploy-key-path> --deploy-key-mounted --host-key-pinned --known-hosts-path <known-hosts-path> --output <source-provider-evidence-raw.json> --check-output <source-provider-evidence.json> --json

For GitLab, Gitea, or generic source providers, generate the rehearsal pack with
`--source-provider gitlab|gitea|generic`. The source-provider step uses
`source-provider:evidence:template` plus the checker path instead of the GitHub
collector and does not require `GITHUB_TOKEN`.

npm run --silent release:target-runtime:evidence:collect -- --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --public-base-url <https-url> --env-file <target-env-file> --operator-name <operator> --release-ticket <ticket> --output <target-runtime-evidence-raw.json> --check-output <target-runtime-evidence.json> --json

The target runtime collector must run on the actual target host. Its output must include sanitized target identity evidence (`hostname`, Docker context name, Docker context inspect hash, Compose project, and host fingerprint hash) before the final release bundle can pass.

siteflow backup verify --backup <dir>
siteflow backup restore-drill --backup <dir> --database-url <disposable-postgres-url> --artifact-root <temp-root> --yes
npm run --silent backup:evidence:compose -- --backup-verify <backup-verify.json> --restore-drill <restore-drill.json> --backup-offload <backup-offload.json> --backup-fetch <backup-fetch.json> --provider-security-audit <backup-provider-security-audit.json> --backup-prune <backup-prune.json> --policy <backup-policy.json> --operator-name <operator> --release-ticket <ticket> --require-off-host --output <backup-evidence-raw.json> --check-output <backup-evidence.json>

npm run --silent observability:operator-evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --operator-name <operator> --release-ticket <ticket> --output <operator-observability.json>

npm run --silent observability:evidence:collect -- --base-url <target-url> --backup-automation-run <backup-evidence-dir>/backup-automation-run.json --backup-automation-history <backup-history-dir>/backup-automation-history.json --backup-scheduler-ownership <backup-scheduler-ownership.json> --operator-evidence <operator-observability.json> --target-stack-api-url <observability-proof-url> --target-stack-token-env SITEFLOW_OBSERVABILITY_STACK_TOKEN --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --output <observability-evidence-raw.json> --check-output <observability-evidence.json>

npm run --silent operator-access:evidence:collect -- --base-url <https-url> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --operator-name <operator> --release-ticket <ticket> --project-id <allowed-project-id> --denied-project-id <denied-project-id> --admin-token-env SITEFLOW_API_TOKEN --low-scope-token-env SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN --execute-project-cutoff --execute-global-cutoff --i-understand-this-revokes-active-operator-sessions --browser-token-fallback-disabled --local-storage-fallback-disabled --output <operator-access-evidence-raw.json> --check-output <operator-access-evidence.json> --json

npm run --silent non-session-credential:evidence:collect -- --base-url <https-url> --old-metrics-token-env SITEFLOW_OLD_METRICS_TOKEN --new-metrics-token-env SITEFLOW_METRICS_TOKEN --old-api-token-env SITEFLOW_OLD_API_TOKEN --new-api-token-env SITEFLOW_API_TOKEN --old-redacted-identifier <old-metrics-token-redacted-id> --new-redacted-identifier <new-metrics-token-redacted-id> --old-api-redacted-identifier <old-root-api-token-redacted-id> --new-api-redacted-identifier <new-root-api-token-redacted-id> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --operator-name <operator> --release-ticket <ticket> --break-glass-source <vault-or-ticket-system> --break-glass-approver-count <count> --break-glass-reviewed --break-glass-time-bounded --break-glass-revocation-planned --output <non-session-credential-evidence-raw.json> --check-output <non-session-credential-evidence.json> --json

npm run --silent ingress:evidence:collect -- --public-base-url <https-url> --direct-api-url <direct-api-health-url> --target-environment production --commit-ref <sha> --repo <owner/repo> --branch main --trust-proxy-policy <SITEFLOW_TRUST_PROXY> --api-instance-count <count> --api-process-count <count> --ingress-count <count> --api-rate-limit-scope <edge|shared|global|distributed|process_local> --api-rate-limit-enforcement-point <edge|proxy|load_balancer|gateway|ingress|cdn|api> --operator-name <operator> --release-ticket <ticket> --operator-evidence <operator-ingress.json> --output <ingress-evidence-raw.json> --check-output <ingress-evidence.json> --json

npm run --silent upgrade-rollback:evidence -- --evidence <upgrade-rollback-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json

npm run --silent release:evidence:compose -- --release-gate <release-gate.json> --docker-build <docker-build-rehearsal.json> --postgres-rehearsal <postgres-rehearsal.json> --artifact-evidence <release-artifact-evidence.json> --release-image-evidence <release-image-evidence.json> --source-provider-evidence <source-provider-evidence.json> --target-runtime-evidence <target-runtime-evidence.json> --backup-evidence <backup-evidence.json> --observability-evidence <observability-evidence.json> --operator-access-evidence <operator-access-evidence.json> --non-session-credential-evidence <non-session-credential-evidence.json> --ingress-evidence <ingress-evidence.json> --upgrade-rollback-evidence <upgrade-rollback-evidence.json> --target-environment production --operator-name <operator> --release-ticket <ticket> --docker-socket-profile-accepted --attestation-key-env SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY --attestation-key-id-env SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID --output <release-evidence.json>

npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --attestation-key-env SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY --attestation-key-id-env SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID --json
```

The operator access collector is not read-only: it creates operator sessions,
creates and disables a temporary routing rule to prove server-derived actor
attribution, and `--execute-global-cutoff` revokes active operator sessions.
Cleanup failure blocks the evidence. The non-session credential collector
probes both `/metrics` and `/api/auth/verify` with old/new bearer tokens and
archives only status codes, env variable names, and redacted identifiers.
Evidence-run secrets such as `SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN`,
`SITEFLOW_OLD_METRICS_TOKEN`, and `SITEFLOW_OLD_API_TOKEN` may be supplied
through the matching `_FILE` variables and should not be stored in target
env files or evidence artifacts.

The generated pack uses `--attestation-key-env SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY`
and `--attestation-key-id-env SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID`.
If the key is mounted as `SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE`, the
compose/check commands and gap/target-run checks treat that file secret as
satisfying the same requirement. Manual compose/check commands can also use
`--attestation-key-file "$SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE"`.

For preflight only, add `--plan-only` to the same `release:evidence:target-run`
command with the same `--set` or `--set-env` replacements expected for the
target run. A passing plan-only run only proves the generated command contract,
placeholder replacements, and required environment variable names look usable;
it does not run Docker, Postgres, backup, observability, ingress, credential,
or rollback commands and does not create production evidence.

For read-only gap preflight, run `release:evidence:gaps` against the same pack
with the same `--set` or `--set-env` replacements used for target-run. A bare
gap command is expected to report unresolved input placeholders and is not a
useful production readiness signal.

Only pass `--docker-socket-profile-accepted` to the rehearsal-pack generator
after the release owner has explicitly accepted the trusted single-host worker
profile. Without it, the generated final compose command will still require
manual Docker socket profile acceptance before a production bundle can pass.

Target evidence must prove at least:

- Protected branch and exact successful required CI check for the release commit.
- Clean promotion gate with production env validation and strong API, metrics, and app/sealing secrets.
- Target-profile Docker build rehearsal or explicitly accepted trusted host-build exception.
- Target-equivalent Postgres migration and queue rehearsal.
- Source provider exact checkout, signed webhook delivery, safe remote URL, deploy-key and host-key posture, and no raw credential archival.
- Target runtime evidence from the actual target host: sanitized Compose config with redacted command, observation source, compose project, no build fallback, API/worker images pinned to the release digest, API non-root/socket-free posture, worker non-root Docker socket posture, Docker runner preflight, and private Git credential env wiring; startup command; service health command and compose project; worker health, queue probe, and fresh heartbeat; API/worker container and image IDs; restart smoke worker health; readiness; and no raw config/env/log archival.
- Real backup verification, off-host object-storage/provider-backed backup, fetch, restore drill into disposable targets, prune evidence, RPO/RTO policy, scheduler ownership, and alert metadata.
- Readiness, metrics, alerts, dashboards, log retention, and backup automation evidence from the target observability stack.
- Operator session, CSRF, token fallback, emergency cutoff, and no-raw-secret evidence.
- Non-session credential rotation or break-glass evidence.
- Ingress evidence proving direct API port blocking, forwarded-header cleanup, final-hop proxy policy, and shared or edge API rate limiting.
- Non-dry-run upgrade and rollback drill evidence, including an auditable transcript with commands, target host and Compose project, before/after/rollback deployment ids, artifact checksums, image digests, migration version queries, HTTP probe URL, metrics/logs/alert queries, backup evidence path/hash, operator, and ticket. Execute it in order: pre-backup -> before state -> upgrade -> after verify -> rollback -> rollback verify -> observability scrape -> checker -> gap report -> compose -> final `release:evidence`.

## Promotion go/no-go checklist

Do not promote unless every item is true:

- The release commit SHA, repository, branch, and target environment match across all evidence files.
- `npm run --silent release:commit:plan -- --fail-on-blocked --json` passes on the release checkout. Any `blocked` result means the release-readiness commit is still incomplete; before staging, the advisory JSON must also show `stagingCoverage.covered: true`, no `missingRequiredPaths`, and no `excludedSuggestedPathspecs`; use `npm run --silent release:commit:plan -- --review-checklist` for the human pathspec review without changing the Git index. If the JSON or Markdown checklist is written to a file during dirty-checkout convergence, write it under a temp or release evidence directory, not the repository root.
- The local/static gate passed, and the promotion release gate passed without `manual_required`, dirty-worktree exceptions, or missing GitHub evidence.
- `main` branch protection requires the expected CI job, currently `Install, test, and build`.
- `npm run --silent release:evidence:gaps` reports no target evidence or immediate input gaps except expected final bundle/check outputs before composition, and no remaining gaps after final bundle validation.
- If `release:evidence:target-run` is used for collection, the final run record is not `planOnly`, has `status: "completed"`, and records production evidence generation. `planned`, `running`, `blocked`, `failed`, `skipped`, `manual_required`, `dry_run_only`, and template-only outputs are promotion no-go states.
- `npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --attestation-key-env SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY --attestation-key-id-env SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID --json` passes.
- Production source builds are trusted and run through the Docker build runner unless a host-build exception is explicitly accepted and recorded.
- The build image is digest-pinned, or a tagged image is allowlisted and explicitly accepted.
- The production Compose runtime image (`SITEFLOW_IMAGE`) and Postgres image (`SITEFLOW_POSTGRES_IMAGE`) are digest-pinned release inputs; the committed production profile must not fall back to local `build:` or mutable image tags.
- Required production env is configured: `SITEFLOW_ENV=production` or `NODE_ENV=production`, `DATABASE_URL`, `SITEFLOW_API_PORT`, `SITEFLOW_ARTIFACT_ROOT`, `SITEFLOW_PUBLIC_SCHEME`, strong `SITEFLOW_API_TOKEN`, strong `SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY` or readable `SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE`, optional `SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID` when pinning a rotation key id, strong `SITEFLOW_METRICS_TOKEN` or documented private-scrape exception, and strong `SITEFLOW_APP_SECRET` or legacy `SITEFLOW_SEALING_KEY`.
- Production browser bundles do not embed `VITE_SITEFLOW_API_TOKEN` or fixture settings.
- `/readyz`, `/metrics`, request logs, backup automation metrics, and alert delivery are wired in the target environment.
- A restore drill from the fetched off-host backup has passed against disposable Postgres and artifact targets.
- TLS, DNS, preview routes, source provider credentials, ingress, operator access, credential handling, and upgrade/rollback have target evidence.
- An owner is assigned for incident response, key rotation, backup/restore, and release rollback.

Only after the checklist is green should a mutating production command use the
passing bundle, for example:

```sh
npm run siteflow -- promote <deploymentId> --project <project-id> --server https://siteflow.example.com --release-evidence <release-evidence.json> --reason "<release-ticket>: promote verified release evidence" --json
```

## Detailed references

- `docs/production-readiness.md`
- `docs/production-distance-matrix.md`
- `docs/deployment/production-single-host.md`
- `docs/operations-runbook.md`
- `package.json` scripts
