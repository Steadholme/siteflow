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
control.

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

Key evidence commands:

```sh
npm run --silent release:evidence:rehearsal-pack -- --commit-ref <sha> --repo <owner/repo> --branch main --target-env-file <target-env-file> --public-base-url <https-url> --operator-name <operator> --release-ticket <ticket> --output-dir <evidence-dir> --docker-socket-profile-accepted --json

npm run --silent release:evidence:gaps -- --pack <evidence-dir>/release-evidence-rehearsal-pack.json --json

SITEFLOW_DIRECT_API_URL=<direct-api-health-url> \
SITEFLOW_RELEASE_IMAGE_RUN_ID=<github-actions-run-id> \
SITEFLOW_TRUST_PROXY=<trust-proxy-policy> \
SITEFLOW_API_INSTANCE_COUNT=<count> \
SITEFLOW_API_PROCESS_COUNT=<count> \
SITEFLOW_INGRESS_COUNT=<count> \
SITEFLOW_API_RATE_LIMIT_SCOPE=<edge|shared|global|distributed|process_local> \
SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT=<edge|proxy|load_balancer|gateway|ingress|cdn|api> \
npm run --silent release:evidence:target-run -- --pack <evidence-dir>/release-evidence-rehearsal-pack.json --confirm-target-environment production --plan-only --set-env direct-api-url=SITEFLOW_DIRECT_API_URL --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT --set-env ingress-count=SITEFLOW_INGRESS_COUNT --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT --json

SITEFLOW_RUN_POSTGRES_INTEGRATION=1 TEST_DATABASE_URL=<target-or-disposable-postgres-url> npm run --silent rehearsal:postgres -- --json --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production

SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL=1 SITEFLOW_BUILD_IMAGE=<target-image> npm run --silent rehearsal:docker-build -- --commit-ref <sha> --repo <owner/repo> --branch main --json

npm run --silent source-provider:evidence -- --evidence <source-provider-evidence-raw.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json

npm run --silent release:target-runtime:evidence -- --evidence <target-runtime-evidence-raw.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json

siteflow backup verify --backup <dir>
siteflow backup restore-drill --backup <dir> --database-url <disposable-postgres-url> --artifact-root <temp-root> --yes
npm run --silent backup:evidence:compose -- --backup-verify <backup-verify.json> --restore-drill <restore-drill.json> --backup-offload <backup-offload.json> --backup-fetch <backup-fetch.json> --provider-security-audit <backup-provider-security-audit.json> --backup-prune <backup-prune.json> --policy <backup-policy.json> --operator-name <operator> --release-ticket <ticket> --require-off-host --output <backup-evidence-raw.json> --check-output <backup-evidence.json>

npm run --silent observability:evidence:collect -- --base-url <target-url> --backup-automation-run <backup-evidence-dir>/backup-automation-run.json --backup-automation-history <backup-history-dir>/backup-automation-history.json --backup-scheduler-ownership <backup-scheduler-ownership.json> --operator-evidence <operator-observability.json> --target-stack-api-url <observability-proof-url> --target-stack-token-env SITEFLOW_OBSERVABILITY_STACK_TOKEN --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --output <observability-evidence-raw.json> --check-output <observability-evidence.json>

npm run --silent operator-access:evidence -- --evidence <operator-access-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json

npm run --silent non-session-credential:evidence -- --evidence <non-session-credential-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json

npm run --silent ingress:evidence:collect -- --public-base-url <https-url> --direct-api-url <direct-api-health-url> --target-environment production --commit-ref <sha> --repo <owner/repo> --branch main --trust-proxy-policy <SITEFLOW_TRUST_PROXY> --api-instance-count <count> --api-process-count <count> --ingress-count <count> --api-rate-limit-scope <edge|shared|global|distributed|process_local> --api-rate-limit-enforcement-point <edge|proxy|load_balancer|gateway|ingress|cdn|api> --operator-name <operator> --release-ticket <ticket> --operator-evidence <operator-ingress.json> --output <ingress-evidence-raw.json> --check-output <ingress-evidence.json> --json

npm run --silent upgrade-rollback:evidence -- --evidence <upgrade-rollback-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json

npm run --silent release:evidence:compose -- --release-gate <release-gate.json> --docker-build <docker-build-rehearsal.json> --postgres-rehearsal <postgres-rehearsal.json> --artifact-evidence <release-artifact-evidence.json> --release-image-evidence <release-image-evidence.json> --source-provider-evidence <source-provider-evidence.json> --target-runtime-evidence <target-runtime-evidence.json> --backup-evidence <backup-evidence.json> --observability-evidence <observability-evidence.json> --operator-access-evidence <operator-access-evidence.json> --non-session-credential-evidence <non-session-credential-evidence.json> --ingress-evidence <ingress-evidence.json> --upgrade-rollback-evidence <upgrade-rollback-evidence.json> --target-environment production --operator-name <operator> --release-ticket <ticket> --docker-socket-profile-accepted --output <release-evidence.json>

npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json
```

Use `release:evidence:target-run --plan-only` with the same `--set` or
`--set-env` replacements expected for the target run before executing target
commands. A passing plan-only run only proves the generated command contract,
placeholder replacements, and required environment variable names look usable;
it does not run Docker, Postgres, backup, observability, ingress, credential,
or rollback commands and does not create production evidence.

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
- Real backup verification, off-host object-storage/provider-backed backup, fetch, restore drill into disposable targets, prune evidence, RPO/RTO policy, scheduler ownership, and alert metadata.
- Readiness, metrics, alerts, dashboards, log retention, and backup automation evidence from the target observability stack.
- Operator session, CSRF, token fallback, emergency cutoff, and no-raw-secret evidence.
- Non-session credential rotation or break-glass evidence.
- Ingress evidence proving direct API port blocking, forwarded-header cleanup, final-hop proxy policy, and shared or edge API rate limiting.
- Non-dry-run upgrade and rollback drill evidence.

## Promotion go/no-go checklist

Do not promote unless every item is true:

- The release commit SHA, repository, branch, and target environment match across all evidence files.
- `npm run --silent release:commit:plan -- --fail-on-blocked --json` passes on the release checkout. Any `blocked` result means the release-readiness commit is still incomplete.
- The local/static gate passed, and the promotion release gate passed without `manual_required`, dirty-worktree exceptions, or missing GitHub evidence.
- `main` branch protection requires the expected CI job, currently `Install, test, and build`.
- `npm run --silent release:evidence:gaps` reports no target evidence or immediate input gaps except expected final bundle/check outputs before composition, and no remaining gaps after final bundle validation.
- If `release:evidence:target-run` is used for collection, the final run record is not `planOnly`, has `status: "completed"`, and records production evidence generation. `planned`, `running`, `blocked`, `failed`, `skipped`, `manual_required`, `dry_run_only`, and template-only outputs are promotion no-go states.
- `npm run --silent release:evidence -- --evidence <release-evidence.json> --commit-ref <sha> --repo <owner/repo> --branch main --target-environment production --json` passes.
- Production source builds are trusted and run through the Docker build runner unless a host-build exception is explicitly accepted and recorded.
- The build image is digest-pinned, or a tagged image is allowlisted and explicitly accepted.
- The production Compose runtime image (`SITEFLOW_IMAGE`) and Postgres image (`SITEFLOW_POSTGRES_IMAGE`) are digest-pinned release inputs; the committed production profile must not fall back to local `build:` or mutable image tags.
- Required production env is configured: `SITEFLOW_ENV=production` or `NODE_ENV=production`, `DATABASE_URL`, `SITEFLOW_API_PORT`, `SITEFLOW_ARTIFACT_ROOT`, `SITEFLOW_PUBLIC_SCHEME`, strong `SITEFLOW_API_TOKEN`, strong `SITEFLOW_METRICS_TOKEN` or documented private-scrape exception, and strong `SITEFLOW_APP_SECRET` or legacy `SITEFLOW_SEALING_KEY`.
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
