import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatReleaseGateReport,
  parseReleaseGateEnvFile,
  runReleaseGate,
  type ReleaseGateCommandRunner,
  type ReleaseGateFetch
} from "./releaseGate";

const validCiWorkflow = [
  "name: CI",
  "jobs:",
  "  test-build:",
  "    steps:",
  "      - run: npm run --silent release:dependency:policy -- --json",
  "      - run: npm ci",
  "      - run: npm run --silent release:source:check -- --json",
  "      - run: npm run --silent release:commit:plan -- --fail-on-blocked --json",
  "      - run: npm run --silent release:evidence:pack-contract -- --json",
  "      - run: npm test -- --run",
  "      - run: npm run build",
  "      - run: npm run --silent release:artifacts:check -- --json",
  "      - run: npm run test:e2e",
  "      - run: npm run siteflow -- release-gate --allow-dirty --allow-manual-branch-protection"
].join("\n");

const requiredReleasePreflightEvidenceInputs = [
  "direct_api_url",
  "release_image_digest",
  "release_image_run_id",
  "source_provider_webhook_delivery_id",
  "source_provider_deploy_key_path",
  "source_provider_known_hosts_path",
  "trust_proxy_policy",
  "api_instance_count",
  "api_process_count",
  "ingress_count",
  "api_rate_limit_scope",
  "api_rate_limit_enforcement_point",
  "operator_access_project_id",
  "operator_access_denied_project_id",
  "old_metrics_token_redacted_id",
  "new_metrics_token_redacted_id",
  "old_root_api_token_redacted_id",
  "new_root_api_token_redacted_id",
  "break_glass_source",
  "break_glass_approver_count"
];

const validReleasePreflightWorkflow = [
  "name: Release Preflight",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      siteflow_api_url:",
  "      candidate_deployment_id:",
  ...requiredReleasePreflightEvidenceInputs.map((input) => `      ${input}:`),
  "permissions:",
  "  contents: read",
  "  checks: read",
  "  actions: read",
  "jobs:",
  "  preflight:",
  "    steps:",
  "      - run: echo 'repo input must match'",
  "      - run: echo 'build_image must be pinned'",
  "      - run: npm run --silent release:dependency:policy -- --json",
  "      - run: npm run --silent release:source:check -- --json",
  "      - run: npm run --silent release:commit:plan -- --fail-on-blocked --json",
  "      - run: npm run --silent release:evidence:pack-contract -- --json",
  "      - run: npm run build",
  "      - run: npx playwright install --with-deps chromium",
  "      - run: npm run test:e2e",
  "      - run: echo \"SITEFLOW_TARGET_ENV_FILE=$RUNNER_TEMP/siteflow-release-secrets/target.env\" >> \"$GITHUB_ENV\"",
  "      - env:",
  "          SITEFLOW_API_TOKEN: ${{ secrets.SITEFLOW_API_TOKEN }}",
  "        run: npm run siteflow -- inspect ${{ inputs.candidate_deployment_id }} --server ${{ inputs.siteflow_api_url }} --json > private/deployment-detail.json",
  "      - run: npm run --silent release:artifacts:check -- --json --manifest evidence/release-artifact-manifest.json --deployment-detail private/deployment-detail.json --write-deployment-artifact-manifest evidence/deployment-artifact-manifest.json --commit-ref abc123 --repo acme/siteflow --branch main --target-environment production",
  "      - env:",
  "          SITEFLOW_RELEASE_ENV_FILE_B64: ${{ secrets.SITEFLOW_RELEASE_ENV_FILE_B64 }}",
  "        run: printf '%s' \"$SITEFLOW_RELEASE_ENV_FILE_B64\" | base64 --decode > \"$SITEFLOW_TARGET_ENV_FILE\"",
  "      - env:",
  "          GITHUB_TOKEN: ${{ secrets.SITEFLOW_RELEASE_GITHUB_TOKEN || github.token }}",
  "        run: npm run siteflow -- release-gate --promotion --env-file \"$SITEFLOW_TARGET_ENV_FILE\" --commit-ref abc123 --require-commit-status --json",
  "      - run: npm run --silent release:evidence:rehearsal-pack -- --commit-ref abc123 --repo acme/siteflow --branch main --target-env-file \"$SITEFLOW_TARGET_ENV_FILE\" --public-base-url https://siteflow.example.com --operator-name operator --release-ticket REL-1",
  "      - env:",
  "          GITHUB_TOKEN: ${{ secrets.SITEFLOW_RELEASE_GITHUB_TOKEN || github.token }}",
  "          GH_TOKEN: ${{ secrets.SITEFLOW_RELEASE_GITHUB_TOKEN || github.token }}",
  "          SITEFLOW_API_TOKEN: ${{ secrets.SITEFLOW_API_TOKEN }}",
  "          SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN: ${{ secrets.SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN }}",
  "          SITEFLOW_OLD_METRICS_TOKEN: ${{ secrets.SITEFLOW_OLD_METRICS_TOKEN }}",
  "          SITEFLOW_METRICS_TOKEN: ${{ secrets.SITEFLOW_METRICS_TOKEN }}",
  "          SITEFLOW_OLD_API_TOKEN: ${{ secrets.SITEFLOW_OLD_API_TOKEN }}",
  "          SITEFLOW_OBSERVABILITY_STACK_TOKEN: ${{ secrets.SITEFLOW_OBSERVABILITY_STACK_TOKEN }}",
  "          SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID: ${{ secrets.SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID }}",
  "          SITEFLOW_RELEASE_IMAGE_DIGEST: ${{ inputs.release_image_digest }}",
  "          SITEFLOW_RELEASE_IMAGE_RUN_ID: ${{ inputs.release_image_run_id }}",
  "        run: npm run --silent release:evidence:target-run -- --pack evidence/release-evidence-rehearsal-pack.json --confirm-target-environment production --run-record evidence/release-evidence-target-run.json --gap-report-dir evidence/gap-reports --set-env direct-api-url=SITEFLOW_DIRECT_API_URL --set-env release-image-digest=SITEFLOW_RELEASE_IMAGE_DIGEST --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID --set-env webhook-delivery-id=SITEFLOW_SOURCE_PROVIDER_WEBHOOK_DELIVERY_ID --set-env deploy-key-path=SITEFLOW_SOURCE_PROVIDER_DEPLOY_KEY_PATH --set-env known-hosts-path=SITEFLOW_SOURCE_PROVIDER_KNOWN_HOSTS_PATH --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT --set-env ingress-count=SITEFLOW_INGRESS_COUNT --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT --set-env operator-access-project-id=SITEFLOW_OPERATOR_ACCESS_PROJECT_ID --set-env operator-access-denied-project-id=SITEFLOW_OPERATOR_ACCESS_DENIED_PROJECT_ID --set-env old-metrics-token-redacted-id=SITEFLOW_OLD_METRICS_TOKEN_REDACTED_ID --set-env new-metrics-token-redacted-id=SITEFLOW_NEW_METRICS_TOKEN_REDACTED_ID --set-env old-root-api-token-redacted-id=SITEFLOW_OLD_ROOT_API_TOKEN_REDACTED_ID --set-env new-root-api-token-redacted-id=SITEFLOW_NEW_ROOT_API_TOKEN_REDACTED_ID --set-env break-glass-source=SITEFLOW_BREAK_GLASS_SOURCE --set-env break-glass-approver-count=SITEFLOW_BREAK_GLASS_APPROVER_COUNT --json",
  "      - env:",
  "          SITEFLOW_API_TOKEN: ${{ secrets.SITEFLOW_API_TOKEN }}",
  "          SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN: ${{ secrets.SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN }}",
  "          SITEFLOW_OLD_METRICS_TOKEN: ${{ secrets.SITEFLOW_OLD_METRICS_TOKEN }}",
  "          SITEFLOW_METRICS_TOKEN: ${{ secrets.SITEFLOW_METRICS_TOKEN }}",
  "          SITEFLOW_OLD_API_TOKEN: ${{ secrets.SITEFLOW_OLD_API_TOKEN }}",
  "          SITEFLOW_OBSERVABILITY_STACK_TOKEN: ${{ secrets.SITEFLOW_OBSERVABILITY_STACK_TOKEN }}",
  "          SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID: ${{ secrets.SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID }}",
  "          SITEFLOW_RELEASE_IMAGE_DIGEST: ${{ inputs.release_image_digest }}",
  "          SITEFLOW_RELEASE_IMAGE_RUN_ID: ${{ inputs.release_image_run_id }}",
  "        run: npm run --silent release:evidence:gaps -- --pack evidence/release-evidence-rehearsal-pack.json --set-env direct-api-url=SITEFLOW_DIRECT_API_URL --set-env release-image-digest=SITEFLOW_RELEASE_IMAGE_DIGEST --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID --set-env webhook-delivery-id=SITEFLOW_SOURCE_PROVIDER_WEBHOOK_DELIVERY_ID --set-env deploy-key-path=SITEFLOW_SOURCE_PROVIDER_DEPLOY_KEY_PATH --set-env known-hosts-path=SITEFLOW_SOURCE_PROVIDER_KNOWN_HOSTS_PATH --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT --set-env ingress-count=SITEFLOW_INGRESS_COUNT --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT --set-env operator-access-project-id=SITEFLOW_OPERATOR_ACCESS_PROJECT_ID --set-env operator-access-denied-project-id=SITEFLOW_OPERATOR_ACCESS_DENIED_PROJECT_ID --set-env old-metrics-token-redacted-id=SITEFLOW_OLD_METRICS_TOKEN_REDACTED_ID --set-env new-metrics-token-redacted-id=SITEFLOW_NEW_METRICS_TOKEN_REDACTED_ID --set-env old-root-api-token-redacted-id=SITEFLOW_OLD_ROOT_API_TOKEN_REDACTED_ID --set-env new-root-api-token-redacted-id=SITEFLOW_NEW_ROOT_API_TOKEN_REDACTED_ID --set-env break-glass-source=SITEFLOW_BREAK_GLASS_SOURCE --set-env break-glass-approver-count=SITEFLOW_BREAK_GLASS_APPROVER_COUNT --json",
  "      - run: rm -f \"$SITEFLOW_TARGET_ENV_FILE\"",
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          name: release-preflight",
  "          path: |",
  "            $RUNNER_TEMP/siteflow-release-preflight/**",
  "            playwright-report/**",
  "            test-results/**"
].join("\n");

const validReleaseImageWorkflow = [
  "name: Release Image",
  "on:",
  "  workflow_dispatch:",
  "  push:",
  "    tags:",
  "      - \"v*\"",
  "permissions:",
  "  contents: read",
  "  packages: write",
  "jobs:",
  "  publish:",
  "    steps:",
  "      - run: npm run --silent release:dependency:policy -- --json",
  "      - run: npm ci",
  "      - run: npm run --silent release:source:check -- --json",
  "      - run: npm run --silent release:commit:plan -- --fail-on-blocked --json",
  "      - run: npm run --silent release:evidence:pack-contract -- --json",
  "      - run: npm test -- --run",
  "      - run: npm run build",
  "      - run: npm run --silent release:artifacts:check -- --json",
  "      - uses: docker/build-push-action@v6",
  "        with:",
  "          provenance: true",
  "          sbom: true",
  "      - run: docker buildx imagetools inspect --raw ghcr.io/siteflow/siteflow@sha256:abc",
  "      - run: echo '{}' > release-image-evidence.json",
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          name: release-image-evidence",
  "          path: release-image-evidence.json",
  "      - name: Gate image attestation evidence",
  "        run: |",
  "          const failed = [",
  "            ...(Array.isArray(attestations.provenance?.failedChecks) ? attestations.provenance.failedChecks : []),",
  "            ...(Array.isArray(attestations.sbom?.failedChecks) ? attestations.sbom.failedChecks : [])",
  "          ];",
  "          if (failed.length || attestations.provenance?.present !== true || attestations.sbom?.present !== true) {",
  "            throw new Error(\"Published image provenance/SBOM attestation evidence is incomplete.\");",
  "          }"
].join("\n");

const validPackageJson = JSON.stringify({
  scripts: {
    build: "npm run clean:build-artifacts && tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json && npm run build:scripts && npm run build:cli && npm run build:server && npm run build:worker && vite build",
    "build:scripts": "tsc --noEmit -p tsconfig.scripts.json",
    "clean:build-artifacts": "node scripts/cleanBuildArtifacts.mjs",
    "build:cli": "tsc -p tsconfig.cli.json",
    "build:server": "tsc -p tsconfig.server.json",
    "build:worker": "tsc -p tsconfig.worker.json",
    siteflow: "node dist-cli/cli/index.js",
    "release:dependency:policy": "node scripts/releaseDependencyPolicyCheck.mjs",
    "release:source:check": "node scripts/runCompiledScript.mjs releaseSourceTreeCheck.js",
    "release:commit:plan": "node scripts/runCompiledScript.mjs releaseCommitReadinessPlan.js",
    "release:evidence:pack-contract": "node scripts/runCompiledScript.mjs releaseEvidencePackContractCheck.js",
    "release:evidence:rehearsal-pack": "node scripts/runCompiledScript.mjs releaseEvidenceRehearsalPack.js",
    "release:evidence:target-run": "node scripts/runCompiledScript.mjs releaseEvidenceTargetRun.js",
    "release:evidence:gaps": "node scripts/runCompiledScript.mjs releaseEvidenceGapReport.js",
    "release:artifacts:check": "node scripts/runCompiledScript.mjs releaseArtifactCheck.js",
    test: "vitest",
    "test:e2e": "playwright test"
  }
}, null, 2);

const validProductionDocs = [
  "# Production",
  "",
  "Branch protection must require CI before merging.",
  "DATABASE_URL",
  "SITEFLOW_API_PORT",
  "SITEFLOW_ARTIFACT_ROOT",
  "SITEFLOW_PUBLIC_SCHEME",
  "SITEFLOW_API_TOKEN",
  "SITEFLOW_APP_SECRET",
  "SITEFLOW_SEALING_KEY",
  "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY",
  "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID",
  "SITEFLOW_METRICS_TOKEN",
  "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS",
  "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK",
  "SITEFLOW_BUILD_RUNNER",
  "SITEFLOW_IMAGE",
  "SITEFLOW_POSTGRES_IMAGE",
  "SITEFLOW_BUILD_IMAGE",
  "SITEFLOW_BUILD_IMAGE_ALLOWLIST",
  "SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE",
  "SITEFLOW_TRUSTED_SOURCE_BUILDS",
  "SITEFLOW_ALLOW_UNSANDBOXED_BUILDS",
  "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
  "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
  "SITEFLOW_BUILD_MIN_FREE_BYTES",
  "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
  "SITEFLOW_PREBUILT_MAX_FILES",
  "SITEFLOW_BUILD_STEP_TIMEOUT_MS",
  "SITEFLOW_GIT_TIMEOUT_MS",
  "SITEFLOW_BUILD_MEMORY",
  "SITEFLOW_BUILD_CPUS",
  "SITEFLOW_BUILD_PIDS_LIMIT",
  "SITEFLOW_TRUST_PROXY",
  "SITEFLOW_WORKER_USER",
  "SITEFLOW_DOCKER_SOCKET_GID",
  "SITEFLOW_GIT_SSH_KEY_PATH",
  "SITEFLOW_GIT_KNOWN_HOSTS_PATH",
  "SITEFLOW_BUILD_NETWORK"
].join("\n");

const validProductionCompose = [
  "services:",
  "  postgres:",
  "    image: ${SITEFLOW_POSTGRES_IMAGE:?SITEFLOW_POSTGRES_IMAGE must be pinned by digest for production}",
  "    environment:",
  "      POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
  "    secrets:",
  "      - siteflow_postgres_password",
  "    healthcheck:",
  "      test: pg_isready",
  "  api:",
  "    image: ${SITEFLOW_IMAGE:?SITEFLOW_IMAGE must be the digest-pinned release image for production}",
  "    user: \"1000:1000\"",
  "    init: true",
  "    read_only: true",
  "    cap_drop:",
  "      - ALL",
  "    security_opt:",
  "      - no-new-privileges:true",
  "    depends_on:",
  "      postgres:",
  "        condition: service_healthy",
  "    environment:",
  "      DATABASE_URL: postgres://siteflow@postgres:5432/siteflow",
  "      SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret",
  "      SITEFLOW_API_TOKEN_FILE: /run/secrets/siteflow_api_token",
  "      SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token",
  "      SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE: /run/secrets/siteflow_release_evidence_signing_key",
  "      SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID: sha256:1111111111111111",
  "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
  "      SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_github_webhook_secret",
  "      SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitlab_webhook_secret",
  "      SITEFLOW_GITEA_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitea_webhook_secret",
  "      SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_generic_webhook_secret",
  "      SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD: /var/lib/siteflow/evidence/backup-automation-run.json",
  "      SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: 536870912",
  "      SITEFLOW_PREBUILT_MAX_FILES: 20000",
  "      SITEFLOW_TRUST_PROXY: \"${SITEFLOW_TRUST_PROXY:-}\"",
  "    secrets:",
  "      - siteflow_app_secret",
  "      - siteflow_api_token",
  "      - siteflow_metrics_token",
  "      - siteflow_release_evidence_signing_key",
  "      - siteflow_postgres_password",
  "      - siteflow_github_webhook_secret",
  "      - siteflow_gitlab_webhook_secret",
  "      - siteflow_gitea_webhook_secret",
  "      - siteflow_generic_webhook_secret",
  "    healthcheck:",
  "      test: fetch /readyz",
  "    ports:",
  "      - \"${SITEFLOW_API_BIND:-127.0.0.1}:8787:8787\"",
  "  worker:",
  "    image: ${SITEFLOW_IMAGE:?SITEFLOW_IMAGE must be the digest-pinned release image for production}",
  "    user: \"${SITEFLOW_WORKER_USER:-1000:1000}\"",
  "    group_add:",
  "      - \"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}\"",
  "    init: true",
  "    read_only: true",
  "    cap_drop:",
  "      - ALL",
  "    security_opt:",
  "      - no-new-privileges:true",
  "    depends_on:",
  "      postgres:",
  "        condition: service_healthy",
  "      api:",
  "        condition: service_healthy",
  "    environment:",
  "      DATABASE_URL: postgres://siteflow@postgres:5432/siteflow",
  "      SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret",
  "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
  "      SITEFLOW_BUILD_RUNNER: docker",
  "      SITEFLOW_BUILD_NETWORK: none",
  "      SITEFLOW_BUILD_IMAGE: node:20-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "      SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: 536870912",
  "      SITEFLOW_BUILD_MAX_ARTIFACT_FILES: 20000",
  "      SITEFLOW_BUILD_MIN_FREE_BYTES: 1073741824",
  "      SITEFLOW_BUILD_STEP_TIMEOUT_MS: 900000",
  "      SITEFLOW_GIT_TIMEOUT_MS: 300000",
  "      SITEFLOW_BUILD_MEMORY: 1g",
  "      SITEFLOW_BUILD_CPUS: 2",
  "      SITEFLOW_BUILD_PIDS_LIMIT: 256",
  "      SITEFLOW_GIT_SSH_KEY_PATH: \"${SITEFLOW_GIT_SSH_KEY_PATH:-}\"",
  "      SITEFLOW_GIT_KNOWN_HOSTS_PATH: \"${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}\"",
  "    secrets:",
  "      - siteflow_app_secret",
  "      - siteflow_postgres_password",
  "    volumes:",
  "      - type: bind",
  "        source: /var/run/docker.sock",
  "        target: /var/run/docker.sock",
  "    command: |",
  "      command -v docker",
  "      docker info",
  "      exec node dist-worker/worker/index.js",
  "    healthcheck:",
  "      test: node dist-worker/worker/index.js --healthcheck",
  "secrets:",
  "  siteflow_app_secret:",
  "    file: /etc/siteflow/secrets/app-secret.secret",
  "  siteflow_api_token:",
  "    file: /etc/siteflow/secrets/api-token.secret",
  "  siteflow_metrics_token:",
  "    file: /etc/siteflow/secrets/metrics-token.secret",
  "  siteflow_release_evidence_signing_key:",
  "    file: /etc/siteflow/secrets/release-evidence-signing-key.secret",
  "  siteflow_postgres_password:",
  "    file: /etc/siteflow/secrets/postgres-password.secret",
  "  siteflow_github_webhook_secret:",
  "    file: /etc/siteflow/secrets/github-webhook.secret",
  "  siteflow_gitlab_webhook_secret:",
  "    file: /etc/siteflow/secrets/gitlab-webhook.secret",
  "  siteflow_gitea_webhook_secret:",
  "    file: /etc/siteflow/secrets/gitea-webhook.secret",
  "  siteflow_generic_webhook_secret:",
  "    file: /etc/siteflow/secrets/generic-webhook.secret"
].join("\n");

const validProductionDeploymentDoc = [
  "# Production single-host Docker Compose",
  "",
  "`docker-compose.production.yml` is the auditable profile.",
  "The worker mounts `/var/run/docker.sock` as an accepted trusted single-host risk.",
  "SITEFLOW_IMAGE",
  "SITEFLOW_POSTGRES_IMAGE",
  "SITEFLOW_BUILD_IMAGE",
  "SITEFLOW_BUILD_MIN_FREE_BYTES",
  "SITEFLOW_BUILD_STEP_TIMEOUT_MS",
  "SITEFLOW_GIT_TIMEOUT_MS",
  "SITEFLOW_BUILD_MEMORY",
  "SITEFLOW_BUILD_CPUS",
  "SITEFLOW_BUILD_PIDS_LIMIT",
  "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
  "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
  "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
  "SITEFLOW_PREBUILT_MAX_FILES",
  "SITEFLOW_TRUST_PROXY",
  "SITEFLOW_WORKER_USER",
  "SITEFLOW_DOCKER_SOCKET_GID",
  "SITEFLOW_GIT_SSH_KEY_PATH",
  "SITEFLOW_GIT_KNOWN_HOSTS_PATH",
  "SITEFLOW_APP_SECRET_FILE",
  "SITEFLOW_API_TOKEN_FILE",
  "SITEFLOW_METRICS_TOKEN_FILE",
  "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE",
  "SITEFLOW_POSTGRES_PASSWORD_FILE",
  "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE",
  "docker compose -f docker-compose.production.yml config"
].join("\n");

const cleanRunner: ReleaseGateCommandRunner = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: ""
});

const pinnedBuildImage = "node:20-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const strongApiToken = "siteflow-api-token-0123456789abcdef";
const strongAppSecret = "siteflow-app-secret-0123456789abcdef";
const strongMetricsToken = "siteflow-metrics-token-0123456789abcdef";
const strongReleaseEvidenceSigningKey = "siteflow-release-evidence-key-0123456789abcdef";

const validProductionEnv = {
  SITEFLOW_ENV: "production",
  DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
  SITEFLOW_API_PORT: "8787",
  SITEFLOW_ARTIFACT_ROOT: "/var/lib/siteflow/artifacts",
  SITEFLOW_PUBLIC_SCHEME: "https",
  SITEFLOW_API_TOKEN: strongApiToken,
  SITEFLOW_APP_SECRET: strongAppSecret,
  SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY: strongReleaseEvidenceSigningKey,
  SITEFLOW_METRICS_TOKEN: strongMetricsToken,
  SITEFLOW_BUILD_RUNNER: "docker",
  SITEFLOW_BUILD_IMAGE: pinnedBuildImage,
  SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "536870912",
  SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "20000",
  SITEFLOW_BUILD_MIN_FREE_BYTES: "1073741824",
  SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "536870912",
  SITEFLOW_PREBUILT_MAX_FILES: "20000",
  SITEFLOW_BUILD_STEP_TIMEOUT_MS: "900000",
  SITEFLOW_GIT_TIMEOUT_MS: "300000",
  SITEFLOW_BUILD_MEMORY: "1g",
  SITEFLOW_BUILD_CPUS: "2",
  SITEFLOW_BUILD_PIDS_LIMIT: "256",
  SITEFLOW_WORKER_USER: "1000:1000",
  SITEFLOW_DOCKER_SOCKET_GID: "998",
  SITEFLOW_BUILD_NETWORK: "none"
};

const releaseCommitSha = "abc123def456abc123def456abc123def456abcd";

const validGitHubRequiredStatusChecksResponse = {
  contexts: ["Install, test, and build"],
  checks: []
};

const validGitHubBranchProtectionResponse = {
  required_status_checks: validGitHubRequiredStatusChecksResponse,
  required_pull_request_reviews: {
    required_approving_review_count: 1
  },
  allow_force_pushes: {
    enabled: false
  },
  required_linear_history: {
    enabled: true
  },
  required_signatures: {
    enabled: true
  }
};

function gitHubJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createGitHubPromotionFetch(options: {
  requests?: string[];
  requiredStatusChecks?: unknown;
  requiredStatusChecksStatus?: number;
  requiredStatusChecksMessage?: string;
  branchProtection?: unknown;
  branchProtectionStatus?: number;
  branchProtectionMessage?: string;
  rulesets?: unknown;
  rulesetsStatus?: number;
  rulesetsMessage?: string;
  branchHeadSha?: string;
  checkRun?: {
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
  };
} = {}): ReleaseGateFetch {
  return async (input) => {
    const url = input.toString();
    options.requests?.push(url);

    if (url.includes("/required_status_checks")) {
      return gitHubJson(
        options.requiredStatusChecksStatus && options.requiredStatusChecksStatus >= 400
          ? { message: options.requiredStatusChecksMessage ?? "Resource not accessible by integration" }
          : options.requiredStatusChecks ?? validGitHubRequiredStatusChecksResponse,
        options.requiredStatusChecksStatus ?? 200
      );
    }

    if (/\/branches\/[^/]+\/protection$/.test(url)) {
      return gitHubJson(
        options.branchProtectionStatus && options.branchProtectionStatus >= 400
          ? { message: options.branchProtectionMessage ?? "Resource not accessible by integration" }
          : options.branchProtection ?? validGitHubBranchProtectionResponse,
        options.branchProtectionStatus ?? 200
      );
    }

    if (url.includes("/rulesets")) {
      return gitHubJson(
        options.rulesetsStatus && options.rulesetsStatus >= 400
          ? { message: options.rulesetsMessage ?? "Resource not accessible by integration" }
          : options.rulesets ?? [],
        options.rulesetsStatus ?? 200
      );
    }

    if (/\/branches\/[^/]+$/.test(url)) {
      return gitHubJson({
        commit: { sha: options.branchHeadSha ?? releaseCommitSha }
      });
    }

    return gitHubJson({
      total_count: 1,
      check_runs: [
        {
          name: "Install, test, and build",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.example.test/checks/1",
          ...options.checkRun
        }
      ]
    });
  };
}

async function createReleaseRoot(options: {
  ci?: boolean;
  releasePreflight?: boolean;
  releaseImage?: boolean;
  packageJson?: boolean;
  docs?: boolean;
  compose?: boolean;
  deploymentDoc?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gate-"));

  if (options.ci !== false || options.releasePreflight !== false || options.releaseImage !== false) {
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  }

  if (options.ci !== false) {
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), validCiWorkflow);
  }

  if (options.releasePreflight !== false) {
    await writeFile(path.join(root, ".github", "workflows", "release-preflight.yml"), validReleasePreflightWorkflow);
  }

  if (options.releaseImage !== false) {
    await writeFile(path.join(root, ".github", "workflows", "release-image.yml"), validReleaseImageWorkflow);
  }

  if (options.packageJson !== false) {
    await writeFile(path.join(root, "package.json"), validPackageJson);
  }

  if (options.docs !== false) {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "production-readiness.md"), validProductionDocs);
  }

  if (options.compose !== false) {
    await writeFile(path.join(root, "docker-compose.production.yml"), validProductionCompose);
  }

  if (options.deploymentDoc !== false) {
    await mkdir(path.join(root, "docs", "deployment"), { recursive: true });
    await writeFile(path.join(root, "docs", "deployment", "production-single-host.md"), validProductionDeploymentDoc);
  }

  return root;
}

describe("release gate", () => {
  it("records checkedAt on the gate report and promotion evidence", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true,
        now: () => new Date("2026-06-08T12:00:00.000Z")
      });

      expect(report.checkedAt).toBe("2026-06-08T12:00:00.000Z");
      expect(report.promotionEvidence.checkedAt).toBe("2026-06-08T12:00:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the CI workflow is missing", async () => {
    const root = await createReleaseRoot({ ci: false });

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.ciWorkflow",
        status: "fail"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the CI workflow omits production release sanity checks", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(path.join(root, ".github", "workflows", "ci.yml"), [
        "name: CI",
        "jobs:",
        "  test-build:",
        "    steps:",
        "      - run: npm ci",
        "      - run: npm test -- --run",
        "      - run: npm run build",
        "      - run: npm run test:e2e"
      ].join("\n"));

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.ciWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingCommands: [
            "release:dependency:policy",
            "release:source:check",
            "release:commit:plan -- --fail-on-blocked",
            "release:evidence:pack-contract",
            "release:artifacts:check",
            "release-gate --allow-dirty --allow-manual-branch-protection"
          ]
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the release preflight workflow is missing", async () => {
    const root = await createReleaseRoot({ releasePreflight: false });

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the release image workflow is missing", async () => {
    const root = await createReleaseRoot({ releaseImage: false });

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releaseImageWorkflow",
        status: "fail"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the release image workflow omits pack contract checks", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-image.yml"),
        validReleaseImageWorkflow.replace("      - run: npm run --silent release:evidence:pack-contract -- --json\n", "")
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releaseImageWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: expect.arrayContaining(["release:evidence:pack-contract"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "attestation gate step",
      "      - name: Gate image attestation evidence\n",
      "",
      "Gate image attestation evidence"
    ],
    [
      "provenance failed-check aggregation",
      "attestations.provenance?.failedChecks",
      "attestations.provenance?.warnings",
      "attestations.provenance?.failedChecks"
    ],
    [
      "SBOM present gate",
      "attestations.sbom?.present !== true",
      "attestations.sbom?.present === false",
      "attestations.sbom?.present !== true"
    ]
  ])("fails when the release image workflow omits %s", async (_label, original, replacement, missingTerm) => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-image.yml"),
        validReleaseImageWorkflow.replace(original, replacement)
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releaseImageWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: expect.arrayContaining([missingTerm])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when package.json is missing", async () => {
    const root = await createReleaseRoot({ packageJson: false });

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.packageScripts",
        status: "fail"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when package.json omits a production release script used by workflows", async () => {
    const root = await createReleaseRoot();
    const packageJson = JSON.parse(validPackageJson) as { scripts: Record<string, string> };
    delete packageJson.scripts["release:evidence:pack-contract"];

    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2));

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.packageScripts",
        status: "fail",
        details: expect.objectContaining({
          missingScripts: expect.arrayContaining(["release:evidence:pack-contract"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when a production release package script drifts to the wrong implementation", async () => {
    const root = await createReleaseRoot();
    const packageJson = JSON.parse(validPackageJson) as { scripts: Record<string, string> };
    packageJson.scripts["release:evidence:pack-contract"] = "node scripts/runCompiledScript.mjs releaseEvidenceBundleCheck.js";

    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2));

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.packageScripts",
        status: "fail",
        details: expect.objectContaining({
          driftedScripts: expect.arrayContaining([
            expect.objectContaining({
              script: "release:evidence:pack-contract",
              missingTerms: ["node scripts/runCompiledScript.mjs releaseEvidencePackContractCheck.js"]
            })
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the release preflight workflow uses static sanity overrides", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        `${validReleasePreflightWorkflow}\n      - run: npm run siteflow -- release-gate --allow-dirty --allow-manual-branch-protection\n`
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          forbiddenTerms: ["--allow-dirty", "--allow-manual-branch-protection"]
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["private directory", "$RUNNER_TEMP/siteflow-release-private/**", "siteflow-release-private"],
    ["secret directory", "$RUNNER_TEMP/siteflow-release-secrets/**", "siteflow-release-secrets"],
    ["raw deployment detail", "private/deployment-detail.json", "deployment-detail.json"],
    ["raw target env file", "$RUNNER_TEMP/siteflow-release-secrets/target.env", "target.env"],
    ["target env variable", "$SITEFLOW_TARGET_ENV_FILE", "SITEFLOW_TARGET_ENV_FILE"]
  ])(
    "fails when the release preflight artifact upload path includes the %s",
    async (_label, forbiddenPath, forbiddenTerm) => {
      const root = await createReleaseRoot();

      try {
        await writeFile(
          path.join(root, ".github", "workflows", "release-preflight.yml"),
          validReleasePreflightWorkflow.replace(
            [
              "            $RUNNER_TEMP/siteflow-release-preflight/**",
              "            playwright-report/**",
              "            test-results/**"
            ].join("\n"),
            [
              "            $RUNNER_TEMP/siteflow-release-preflight/**",
              `            ${forbiddenPath}`,
              "            playwright-report/**",
              "            test-results/**"
            ].join("\n")
          )
        );

        const report = await runReleaseGate({
          root,
          env: {},
          runner: cleanRunner,
          allowManualBranchProtection: true
        });

        expect(report.status).toBe("fail");
        expect(report.checks).toContainEqual(expect.objectContaining({
          id: "local.releasePreflightWorkflow",
          status: "fail",
          details: expect.objectContaining({
            forbiddenArtifactUploadPaths: expect.arrayContaining([forbiddenPath]),
            forbiddenArtifactUploadPathTerms: expect.arrayContaining([forbiddenTerm])
          })
        }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(requiredReleasePreflightEvidenceInputs)(
    "fails when the release preflight workflow omits the %s workflow_dispatch input declaration",
    async (inputName) => {
      const root = await createReleaseRoot();

      try {
        await writeFile(
          path.join(root, ".github", "workflows", "release-preflight.yml"),
          validReleasePreflightWorkflow
            .split(/\r?\n/)
            .filter((line) => line.trim() !== `${inputName}:`)
            .join("\n")
        );

        const report = await runReleaseGate({
          root,
          env: {},
          runner: cleanRunner,
          allowManualBranchProtection: true
        });

        expect(report.status).toBe("fail");
        expect(report.checks).toContainEqual(expect.objectContaining({
          id: "local.releasePreflightWorkflow",
          status: "fail",
          details: expect.objectContaining({
            missingTerms: expect.arrayContaining([`${inputName}:`])
          })
        }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("fails when the production compose profile is missing", async () => {
    const root = await createReleaseRoot({ compose: false });

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        summary: "docker-compose.production.yml is missing."
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the production API service mounts the Docker socket", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(
          [
            "    security_opt:",
            "      - no-new-privileges:true"
          ].join("\n"),
          [
            "    security_opt:",
            "      - no-new-privileges:true",
            "    volumes:",
            "      - /var/run/docker.sock:/var/run/docker.sock"
          ].join("\n")
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining(["api must not mount /var/run/docker.sock"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "API privileged mode",
      [
        "    security_opt:",
        "      - no-new-privileges:true"
      ].join("\n"),
      [
        "    security_opt:",
        "      - no-new-privileges:true",
        "    privileged: true"
      ].join("\n"),
      "api must not run privileged"
    ],
    [
      "worker capability add",
      [
        "    group_add:",
        "      - \"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}\"",
        "    init: true",
        "    read_only: true",
        "    cap_drop:",
        "      - ALL"
      ].join("\n"),
      [
        "    group_add:",
        "      - \"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}\"",
        "    init: true",
        "    read_only: true",
        "    cap_drop:",
        "      - ALL",
        "    cap_add:",
        "      - SYS_ADMIN"
      ].join("\n"),
      "worker must not add Linux capabilities"
    ],
    [
      "worker unconfined seccomp",
      [
        "    security_opt:",
        "      - no-new-privileges:true",
        "    depends_on:",
        "      postgres:",
        "        condition: service_healthy",
        "      api:"
      ].join("\n"),
      [
        "    security_opt:",
        "      - no-new-privileges:true",
        "      - seccomp=unconfined",
        "    depends_on:",
        "      postgres:",
        "        condition: service_healthy",
        "      api:"
      ].join("\n"),
      "worker must not disable seccomp or AppArmor"
    ],
    [
      "worker host network mode",
      [
        "    group_add:",
        "      - \"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}\"",
        "    init: true",
        "    read_only: true"
      ].join("\n"),
      [
        "    group_add:",
        "      - \"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}\"",
        "    init: true",
        "    network_mode: host",
        "    read_only: true"
      ].join("\n"),
      "worker must not use host network mode"
    ]
  ])("fails when production compose enables %s", async (_label, searchText, replacementText, expectedTerm) => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(searchText, replacementText)
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining([expectedTerm])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose defaults API trusted proxy policy to loopback", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(
          '      SITEFLOW_TRUST_PROXY: "${SITEFLOW_TRUST_PROXY:-}"',
          '      SITEFLOW_TRUST_PROXY: "${SITEFLOW_TRUST_PROXY:-loopback}"'
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining(["api SITEFLOW_TRUST_PROXY must default to disabled/unset"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose defaults worker socket posture to root and gid 0", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose
          .replace('    user: "${SITEFLOW_WORKER_USER:-1000:1000}"', '    user: "${SITEFLOW_WORKER_USER:-0:0}"')
          .replace(
            '      - "${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"',
            '      - "${SITEFLOW_DOCKER_SOCKET_GID:-0}"'
          )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining([
            "worker SITEFLOW_WORKER_USER must default to a non-root user",
            "worker SITEFLOW_DOCKER_SOCKET_GID must be explicitly required instead of defaulting to 0"
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "API prebuilt upload limit",
      "      SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: 536870912\n",
      "api SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES:"
    ],
    [
      "API trusted proxy opt-in",
      "      SITEFLOW_TRUST_PROXY: \"${SITEFLOW_TRUST_PROXY:-}\"\n",
      "api SITEFLOW_TRUST_PROXY:"
    ],
    [
      "API readiness healthcheck",
      "      test: fetch /readyz\n",
      "api /readyz"
    ],
    [
      "API loopback port binding",
      "      - \"${SITEFLOW_API_BIND:-127.0.0.1}:8787:8787\"\n",
      "api ${SITEFLOW_API_BIND:-127.0.0.1}:8787:8787"
    ],
    [
      "worker Docker socket group override",
      "    group_add:\n      - \"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}\"\n",
      "worker group_add:"
    ],
    [
      "worker Docker CLI preflight",
      "      command -v docker\n",
      "worker command -v docker"
    ],
    [
      "worker Docker daemon preflight",
      "      docker info\n",
      "worker docker info"
    ],
    [
      "worker healthcheck",
      "      test: node dist-worker/worker/index.js --healthcheck\n",
      "worker --healthcheck"
    ],
    [
      "worker build artifact file limit",
      "      SITEFLOW_BUILD_MAX_ARTIFACT_FILES: 20000\n",
      "worker SITEFLOW_BUILD_MAX_ARTIFACT_FILES:"
    ],
    [
      "worker build memory limit",
      "      SITEFLOW_BUILD_MEMORY: 1g\n",
      "worker SITEFLOW_BUILD_MEMORY:"
    ],
    [
      "worker build CPU limit",
      "      SITEFLOW_BUILD_CPUS: 2\n",
      "worker SITEFLOW_BUILD_CPUS:"
    ],
    [
      "worker build PIDs limit",
      "      SITEFLOW_BUILD_PIDS_LIMIT: 256\n",
      "worker SITEFLOW_BUILD_PIDS_LIMIT:"
    ],
    [
      "worker Git SSH key path",
      "      SITEFLOW_GIT_SSH_KEY_PATH: \"${SITEFLOW_GIT_SSH_KEY_PATH:-}\"\n",
      "worker SITEFLOW_GIT_SSH_KEY_PATH:"
    ],
    [
      "worker Git known_hosts path",
      "      SITEFLOW_GIT_KNOWN_HOSTS_PATH: \"${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}\"\n",
      "worker SITEFLOW_GIT_KNOWN_HOSTS_PATH:"
    ],
    [
      "API Postgres password file",
      "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password\n",
      "api SITEFLOW_POSTGRES_PASSWORD_FILE:"
    ],
    [
      "API GitHub webhook secret file",
      "      SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_github_webhook_secret\n",
      "api SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE:"
    ],
    [
      "worker Postgres password file",
      "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password\n      SITEFLOW_BUILD_RUNNER: docker",
      "worker SITEFLOW_POSTGRES_PASSWORD_FILE:"
    ],
    [
      "top-level API token secret",
      "  siteflow_api_token:\n    file: /etc/siteflow/secrets/api-token.secret\n",
      "top-level secret siteflow_api_token"
    ],
    [
      "top-level release evidence signing key secret",
      "  siteflow_release_evidence_signing_key:\n    file: /etc/siteflow/secrets/release-evidence-signing-key.secret\n",
      "top-level secret siteflow_release_evidence_signing_key"
    ],
    [
      "postgres password secret mount",
      "      - siteflow_postgres_password\n    healthcheck:",
      "postgres secret siteflow_postgres_password"
    ],
    [
      "API token secret mount",
      "      - siteflow_api_token\n",
      "api secret siteflow_api_token"
    ],
    [
      "API generic webhook secret mount",
      "      - siteflow_generic_webhook_secret\n",
      "api secret siteflow_generic_webhook_secret"
    ]
  ])("fails when production compose omits %s", async (_label, removedText, missingTerm) => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(removedText, "")
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining([missingTerm])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose omits worker service secret mounts", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(
          "    secrets:\n      - siteflow_app_secret\n      - siteflow_postgres_password\n    volumes:",
          "    secrets:\n      - siteflow_postgres_password\n    volumes:"
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining(["worker secret siteflow_app_secret"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose exposes the API on a bare host port", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(
          "      - \"${SITEFLOW_API_BIND:-127.0.0.1}:8787:8787\"",
          "      - \"8787:8787\""
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining([
            "api ${SITEFLOW_API_BIND:-127.0.0.1}:8787:8787",
            "api must default to loopback port binding and must not expose bare 8787:8787"
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose defines an unexpected service", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(
          "\nsecrets:",
          "\n  debug:\n    image: alpine:latest\nsecrets:"
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining(["unexpected service(s): debug"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose exports Docker secret values", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(
          "      test: fetch /readyz\n",
          "      test: fetch /readyz\n    command:\n      - sh\n      - -ec\n      - |\n        export SITEFLOW_APP_SECRET=\"$$(cat /run/secrets/siteflow_app_secret)\"\n        exec node dist-server/server/index.js\n"
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining(["api must not export Docker secret values"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose uses mutable images or local build defaults", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose
          .replace(
            "    image: ${SITEFLOW_POSTGRES_IMAGE:?SITEFLOW_POSTGRES_IMAGE must be pinned by digest for production}",
            "    image: postgres:16-alpine"
          )
          .replaceAll(
            "    image: ${SITEFLOW_IMAGE:?SITEFLOW_IMAGE must be the digest-pinned release image for production}",
            "    image: siteflow-console:production\n    build:\n      context: ."
          )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining([
            "postgres image: ${SITEFLOW_POSTGRES_IMAGE:?",
            "postgres image must not use mutable postgres:16-alpine default",
            "api image: ${SITEFLOW_IMAGE:?",
            "api must not define a local Docker build",
            "api image must not use mutable siteflow-console:production default",
            "worker image: ${SITEFLOW_IMAGE:?",
            "worker must not define a local Docker build",
            "worker image must not use mutable siteflow-console:production default"
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when production compose requires a build image allowlist for digest-pinned images", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, "docker-compose.production.yml"),
        validProductionCompose.replace(
          "      SITEFLOW_BUILD_IMAGE: node:20-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          [
            "      SITEFLOW_BUILD_IMAGE: node:20-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "      SITEFLOW_BUILD_IMAGE_ALLOWLIST: ${SITEFLOW_BUILD_IMAGE_ALLOWLIST:?SITEFLOW_BUILD_IMAGE_ALLOWLIST must match the pinned production build image}"
          ].join("\n")
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.productionCompose",
        status: "fail",
        details: expect.objectContaining({
          missingComposeTerms: expect.arrayContaining([
            "worker build image allowlist must remain optional for digest-pinned build images"
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "target-run",
      "release:evidence:target-run -- --pack evidence/release-evidence-rehearsal-pack.json",
      "release:evidence:target-run -- evidence/release-evidence-rehearsal-pack.json",
      "release:evidence:target-run --pack"
    ],
    [
      "target-run run record",
      "--run-record evidence/release-evidence-target-run.json ",
      "",
      "release:evidence:target-run --run-record"
    ],
    [
      "gap report",
      "release:evidence:gaps -- --pack evidence/release-evidence-rehearsal-pack.json",
      "release:evidence:gaps -- evidence/release-evidence-rehearsal-pack.json",
      "release:evidence:gaps --pack"
    ]
  ])(
    "fails when the release preflight %s command omits --pack",
    async (_label, originalCommand, replacementCommand, missingTerm) => {
      const root = await createReleaseRoot();

      try {
        await writeFile(
          path.join(root, ".github", "workflows", "release-preflight.yml"),
          validReleasePreflightWorkflow.replace(originalCommand, replacementCommand)
        );

        const report = await runReleaseGate({
          root,
          env: {},
          runner: cleanRunner,
          allowManualBranchProtection: true
        });

        expect(report.status).toBe("fail");
        expect(report.checks).toContainEqual(expect.objectContaining({
          id: "local.releasePreflightWorkflow",
          status: "fail",
          details: expect.objectContaining({
            missingTerms: expect.arrayContaining([missingTerm])
          })
        }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("fails when release preflight target-run uses plan-only mode", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        validReleasePreflightWorkflow.replace(
          "release:evidence:target-run -- --pack",
          "release:evidence:target-run -- --plan-only --pack"
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          forbiddenCommandTerms: expect.arrayContaining(["release:evidence:target-run --plan-only"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when release preflight target-run omits a required evidence placeholder mapping", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        validReleasePreflightWorkflow.replace(
          " --set-env webhook-delivery-id=SITEFLOW_SOURCE_PROVIDER_WEBHOOK_DELIVERY_ID",
          ""
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: expect.arrayContaining(["release:evidence:target-run --set-env webhook-delivery-id"])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when release preflight maps the release image digest placeholder to the wrong env", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        validReleasePreflightWorkflow.replace(
          "--set-env release-image-digest=SITEFLOW_RELEASE_IMAGE_DIGEST",
          "--set-env release-image-digest=SITEFLOW_WRONG_RELEASE_IMAGE_DIGEST"
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: expect.arrayContaining([
            "release:evidence:target-run --set-env release-image-digest=SITEFLOW_RELEASE_IMAGE_DIGEST"
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when release preflight does not bind the digest env to the workflow input", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        validReleasePreflightWorkflow.replaceAll(
          "          SITEFLOW_RELEASE_IMAGE_DIGEST: ${{ inputs.release_image_digest }}",
          "          SITEFLOW_RELEASE_IMAGE_DIGEST: ${{ inputs.wrong_release_image_digest }}"
        )
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: expect.arrayContaining([
            "SITEFLOW_RELEASE_IMAGE_DIGEST: ${{ inputs.release_image_digest }}"
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the release preflight gap report step cannot read the observability target stack token env", async () => {
    const root = await createReleaseRoot();

    try {
      const firstTokenEnv = "          SITEFLOW_OBSERVABILITY_STACK_TOKEN: ${{ secrets.SITEFLOW_OBSERVABILITY_STACK_TOKEN }}\n";
      const firstIndex = validReleasePreflightWorkflow.indexOf(firstTokenEnv);
      const secondIndex = validReleasePreflightWorkflow.indexOf(firstTokenEnv, firstIndex + firstTokenEnv.length);

      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        `${validReleasePreflightWorkflow.slice(0, secondIndex)}${validReleasePreflightWorkflow.slice(secondIndex + firstTokenEnv.length)}`
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: expect.arrayContaining([
            "release:evidence:gaps SITEFLOW_OBSERVABILITY_STACK_TOKEN: ${{ secrets.SITEFLOW_OBSERVABILITY_STACK_TOKEN }}"
          ])
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the release preflight workflow does not remove target env before uploading artifacts", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        validReleasePreflightWorkflow
          .split(/\r?\n/)
          .filter((line) => !line.includes("rm -f \"$SITEFLOW_TARGET_ENV_FILE\""))
          .join("\n")
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: ["rm -f \"$SITEFLOW_TARGET_ENV_FILE\""],
          targetEnvCleanupBeforeUpload: false
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when release preflight target env cleanup happens after artifact upload", async () => {
    const root = await createReleaseRoot();

    try {
      await writeFile(
        path.join(root, ".github", "workflows", "release-preflight.yml"),
        validReleasePreflightWorkflow
          .replace("      - run: rm -f \"$SITEFLOW_TARGET_ENV_FILE\"\n      - uses: actions/upload-artifact@v4", "      - uses: actions/upload-artifact@v4\n      - run: rm -f \"$SITEFLOW_TARGET_ENV_FILE\"")
      );

      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.releasePreflightWorkflow",
        status: "fail",
        details: expect.objectContaining({
          missingTerms: [],
          targetEnvCleanupBeforeUpload: false
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the git worktree is dirty unless explicitly allowed", async () => {
    const root = await createReleaseRoot();
    const dirtyRunner: ReleaseGateCommandRunner = async () => ({
      exitCode: 0,
      stdout: " M cli/releaseGate.ts\n",
      stderr: ""
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: dirtyRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.gitStatus",
        status: "fail"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps dirty worktree entries in promotion evidence while preserving the total count", async () => {
    const root = await createReleaseRoot();
    const dirtyLines = Array.from({ length: 205 }, (_value, index) => ` M src/file-${index}.ts`);
    const dirtyRunner: ReleaseGateCommandRunner = async (command, args, options) => {
      if (command === "git" && args[0] === "status") {
        return {
          exitCode: 0,
          stdout: `${dirtyLines.join("\n")}\n`,
          stderr: ""
        };
      }

      return cleanRunner(command, args, options);
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: dirtyRunner,
        allowDirty: true,
        allowManualBranchProtection: true
      });
      const gitStatus = report.checks.find((check) => check.id === "local.gitStatus");

      expect(report.status).toBe("pass");
      expect(gitStatus?.details).toMatchObject({
        dirty: true,
        entryCount: 205,
        truncated: true
      });
      expect((gitStatus?.details?.status as string[])).toHaveLength(200);
      expect(report.promotionEvidence.dirtyWorktree).toMatchObject({
        status: "pass",
        dirty: true,
        entryCount: 205,
        truncated: true
      });
      expect(report.promotionEvidence.dirtyWorktree.entries).toHaveLength(200);
      expect(report.promotionEvidence.dirtyWorktree.entries.at(-1)).toBe(" M src/file-199.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when generated, dependency, secret, or scratch paths are tracked", async () => {
    const root = await createReleaseRoot();
    const trackedGeneratedRunner: ReleaseGateCommandRunner = async (_command, args) => {
      if (args[0] === "ls-files") {
        return {
          exitCode: 0,
          stdout: [
            "src/main.ts",
            "node_modules/react/index.js",
            "dist/index.html",
            "dist-server/server/index.js",
            ".env.production",
            ".workflow/session.json"
          ].join("\n"),
          stderr: ""
        };
      }

      return cleanRunner(_command, args);
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: trackedGeneratedRunner,
        allowManualBranchProtection: true
      });
      const sourceTreeCheck = report.checks.find((check) => check.id === "local.releaseSourceTree");

      expect(report.status).toBe("fail");
      expect(sourceTreeCheck).toMatchObject({
        status: "fail",
        summary: expect.stringContaining("generated, dependency, secret, or scratch"),
        details: expect.objectContaining({
          suggestedIndexOnlyCleanupCommand: expect.objectContaining({
            display: "git rm --cached -r -- .env.production .workflow dist dist-server node_modules",
            removesWorkingTreeFiles: false,
            modifiesGitIndex: true,
            requiresReview: true
          })
        })
      });
      expect(JSON.stringify(sourceTreeCheck?.details)).toContain("node_modules/react/index.js");
      expect(JSON.stringify(sourceTreeCheck?.details)).toContain("dist/index.html");
      expect(JSON.stringify(sourceTreeCheck?.details)).toContain(".env.production");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when branch protection requires manual verification", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner
      });

      expect(report.status).toBe("manual_required");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "manual_required"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows explicit manual branch protection verification", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("pass");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "manual_required"
      }));
      expect(formatReleaseGateReport(report)).toContain("SiteFlow release gate: PASS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes with mocked GitHub required status checks", async () => {
    const root = await createReleaseRoot();
    const requests: Array<{ url: string; authorization: string }> = [];
    const fetch: ReleaseGateFetch = async (input, init) => {
      requests.push({
        url: input.toString(),
        authorization: new Headers(init?.headers).get("authorization") ?? ""
      });

      return new Response(JSON.stringify({
        contexts: ["Install, test, and build"],
        checks: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("pass");
      expect(requests).toEqual([
        {
          url: "https://api.github.com/repos/acme/siteflow/branches/main/protection/required_status_checks",
          authorization: "Bearer ghs_test"
        }
      ]);
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "pass"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when mocked GitHub branch protection has no required status checks", async () => {
    const root = await createReleaseRoot();
    const fetch: ReleaseGateFetch = async () => new Response(JSON.stringify({
      contexts: [],
      checks: []
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "fail"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when mocked GitHub branch protection does not require the expected CI check", async () => {
    const root = await createReleaseRoot();
    const fetch: ReleaseGateFetch = async () => new Response(JSON.stringify({
      contexts: ["Unrelated check"],
      checks: []
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "fail",
        summary: expect.stringContaining("Install, test, and build")
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a configured branch protection status check name", async () => {
    const root = await createReleaseRoot();
    const fetch: ReleaseGateFetch = async () => new Response(JSON.stringify({
      contexts: ["Required / siteflow"],
      checks: []
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        requiredStatusCheck: "Required / siteflow",
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("pass");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "pass"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes promotion when rulesets prove the branch hardening requirements", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch({
      branchProtection: {
        required_status_checks: validGitHubRequiredStatusChecksResponse
      },
      rulesets: [
        {
          name: "production",
          target: "branch",
          enforcement: "active",
          conditions: {
            ref_name: {
              include: ["refs/heads/main"],
              exclude: []
            }
          },
          rules: [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [
                  { context: "Install, test, and build" }
                ]
              }
            },
            { type: "pull_request", parameters: { required_approving_review_count: 1 } },
            { type: "non_fast_forward" },
            { type: "required_linear_history" },
            { type: "required_signatures" }
          ]
        }
      ]
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("pass");
      expect(report.promotionEvidence.branchProtection).toMatchObject({
        status: "pass",
        requiredStatusChecks: ["Install, test, and build"],
        pullRequestReviewsRequired: true,
        forcePushesBlocked: true,
        linearHistoryRequired: true,
        signedCommitsRequired: true,
        hardeningSources: expect.arrayContaining([
          "ruleset.production.pull_request",
          "ruleset.production.non_fast_forward",
          "ruleset.production.required_linear_history",
          "ruleset.production.required_signatures"
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires manual verification in promotion when GitHub hardening fields and rulesets are inaccessible", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch({
      branchProtection: {
        required_status_checks: validGitHubRequiredStatusChecksResponse
      },
      rulesetsStatus: 403,
      rulesetsMessage: "Resource not accessible by integration"
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("manual_required");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "manual_required",
        details: expect.objectContaining({
          pullRequestReviewsRequired: null,
          forcePushesBlocked: null,
          linearHistoryRequired: null,
          hardeningUnknowns: expect.arrayContaining([
            "required pull request reviews",
            "force-push prohibition",
            "required linear history"
          ]),
          apiIssues: expect.arrayContaining(["Resource not accessible by integration"])
        })
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "manual_required",
        manualRequired: true,
        manualRequiredCheckIds: ["external.githubBranchProtection"],
        branchProtection: {
          status: "manual_required",
          pullRequestReviewsRequired: null,
          forcePushesBlocked: null,
          linearHistoryRequired: null,
          hardeningUnknowns: expect.arrayContaining(["force-push prohibition"])
        },
        protectedBranchCommit: {
          status: "pass"
        },
        commitStatus: {
          status: "pass"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires manual verification in promotion when required status checks cannot be read", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch({
      requiredStatusChecksStatus: 403,
      requiredStatusChecksMessage: "Resource not accessible by integration"
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("manual_required");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "manual_required",
        summary: "Resource not accessible by integration"
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "manual_required",
        manualRequired: true,
        manualRequiredCheckIds: ["external.githubBranchProtection"],
        branchProtection: {
          status: "manual_required"
        },
        protectedBranchCommit: {
          status: "pass"
        },
        commitStatus: {
          status: "pass"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion when GitHub branch protection allows force pushes", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch({
      branchProtection: {
        ...validGitHubBranchProtectionResponse,
        allow_force_pushes: {
          enabled: true
        }
      }
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "fail",
        details: expect.objectContaining({
          forcePushesBlocked: false,
          hardeningFailures: expect.arrayContaining(["force-push prohibition"])
        })
      }));
      expect(report.promotionEvidence.branchProtection).toMatchObject({
        status: "fail",
        forcePushesBlocked: false,
        hardeningFailures: expect.arrayContaining(["force-push prohibition"])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes promotion when the exact release commit has the required GitHub check run", async () => {
    const root = await createReleaseRoot();
    const requests: string[] = [];
    const fetch = createGitHubPromotionFetch({ requests });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("pass");
      expect(requests).toEqual([
        "https://api.github.com/repos/acme/siteflow/branches/main/protection/required_status_checks",
        "https://api.github.com/repos/acme/siteflow/branches/main/protection",
        "https://api.github.com/repos/acme/siteflow/branches/main",
        "https://api.github.com/repos/acme/siteflow/commits/abc123def456abc123def456abc123def456abcd/check-runs?check_name=Install%2C+test%2C+and+build"
      ]);
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubCommitStatus",
        status: "pass"
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "pass",
        promotion: true,
        commitRef: "abc123def456abc123def456abc123def456abcd",
        repository: "acme/siteflow",
        branch: "main",
        requiredStatusCheck: "Install, test, and build",
        branchProtection: {
          status: "pass",
          requiredStatusChecks: ["Install, test, and build"],
          pullRequestReviewsRequired: true,
          forcePushesBlocked: true,
          linearHistoryRequired: true,
          signedCommitsRequired: true
        },
        protectedBranchCommit: {
          status: "pass",
          commitRef: "abc123def456abc123def456abc123def456abcd",
          branchHeadSha: "abc123def456abc123def456abc123def456abcd"
        },
        commitStatus: {
          status: "pass",
          commitRef: "abc123def456abc123def456abc123def456abcd",
          checkRun: {
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        },
        manualRequired: false,
        runtimeEnv: {
          status: "pass",
          metricsTokenConfigured: true,
          sourceBuildPostureStatus: "pass",
          buildRunner: "docker",
          hostBuildException: false,
          buildImage: pinnedBuildImage,
          buildImageDigestPinned: true,
          buildImagePolicyStatus: "pass",
          buildImagePolicy: "digest",
          buildMaxArtifactBytesStatus: "pass",
          buildMaxArtifactBytes: 536870912,
          buildMaxArtifactFilesStatus: "pass",
          buildMaxArtifactFiles: 20000,
          buildMinFreeBytesStatus: "pass",
          buildMinFreeBytes: 1073741824,
          prebuiltMaxUploadBytesStatus: "pass",
          prebuiltMaxUploadBytes: 536870912,
          prebuiltMaxFilesStatus: "pass",
          prebuiltMaxFiles: 20000,
          buildStepTimeoutStatus: "pass",
          buildStepTimeoutMs: 900000,
          gitTimeoutStatus: "pass",
          gitTimeoutMs: 300000,
          buildNetworkStatus: "pass",
          buildNetwork: "none",
          workerUserStatus: "pass",
          workerUser: "1000:1000",
          dockerSocketGidStatus: "pass",
          dockerSocketGid: 998
        },
        dirtyWorktree: {
          status: "pass",
          dirty: false,
          entries: []
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion from a dirty worktree even when allowDirty is requested", async () => {
    const root = await createReleaseRoot();
    const dirtyRunner: ReleaseGateCommandRunner = async () => ({
      exitCode: 0,
      stdout: " M cli/releaseGate.ts\n",
      stderr: ""
    });
    const fetch = createGitHubPromotionFetch();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        allowDirty: true,
        commitSha: releaseCommitSha,
        promotion: true,
        runner: dirtyRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.gitStatus",
        status: "fail",
        summary: "Worktree has uncommitted changes."
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "fail",
        promotion: true,
        branchProtection: {
          status: "pass"
        },
        commitStatus: {
          status: "pass"
        },
        dirtyWorktree: {
          status: "fail",
          dirty: true,
          entries: [" M cli/releaseGate.ts"]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion when the required release commit check run has not passed", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch({
      checkRun: {
        conclusion: "failure"
      }
    });

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubCommitStatus",
        status: "fail",
        summary: expect.stringContaining("has not completed successfully")
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "fail",
        promotion: true,
        commitRef: "abc123def456abc123def456abc123def456abcd",
        repository: "acme/siteflow",
        branchProtection: {
          status: "pass"
        },
        commitStatus: {
          status: "fail",
          commitRef: "abc123def456abc123def456abc123def456abcd",
          checkRuns: [
            {
              name: "Install, test, and build",
              status: "completed",
              conclusion: "failure"
            }
          ]
        },
        manualRequired: false,
        runtimeEnv: {
          status: "pass",
          metricsTokenConfigured: true
        },
        dirtyWorktree: {
          dirty: false
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion when commit ref is not a canonical full SHA", async () => {
    const root = await createReleaseRoot();
    const requests: string[] = [];
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();
      requests.push(url);

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
          checks: []
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      throw new Error(`Unexpected GitHub request: ${url}`);
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: "abc123",
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(requests).toEqual([
        "https://api.github.com/repos/acme/siteflow/branches/main/protection/required_status_checks"
      ]);
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubProtectedBranchCommit",
        status: "fail",
        summary: expect.stringContaining("canonical 40-character Git SHA")
      }));
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubCommitStatus",
        status: "fail",
        summary: expect.stringContaining("canonical 40-character Git SHA")
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "fail",
        commitRef: "abc123",
        protectedBranchCommit: {
          status: "fail",
          commitRef: "abc123"
        },
        commitStatus: {
          status: "fail",
          commitRef: "abc123"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let promotion mode pass with manual branch protection override", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_SHA: "abc123def456abc123def456abc123def456abcd"
        },
        runner: cleanRunner,
        allowManualBranchProtection: true,
        promotion: true
      });

      expect(report.status).toBe("manual_required");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "manual_required"
      }));
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "external.githubCommitStatus",
        status: "manual_required"
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "manual_required",
        promotion: true,
        commitRef: "abc123def456abc123def456abc123def456abcd",
        manualRequired: true,
        manualRequiredCheckIds: [
          "external.githubBranchProtection",
          "external.githubProtectedBranchCommit",
          "external.githubCommitStatus"
        ],
        branchProtection: {
          status: "manual_required"
        },
        protectedBranchCommit: {
          status: "manual_required",
          commitRef: "abc123def456abc123def456abc123def456abcd"
        },
        commitStatus: {
          status: "manual_required",
          commitRef: "abc123def456abc123def456abc123def456abcd"
        },
        runtimeEnv: {
          status: "pass",
          metricsTokenConfigured: true,
          sourceBuildPostureStatus: "pass",
          buildRunner: "docker",
          hostBuildException: false,
          buildImage: pinnedBuildImage,
          buildImageDigestPinned: true,
          buildImagePolicyStatus: "pass",
          buildImagePolicy: "digest",
          buildMaxArtifactBytesStatus: "pass",
          buildMaxArtifactFilesStatus: "pass",
          prebuiltMaxUploadBytesStatus: "pass",
          prebuiltMaxFilesStatus: "pass",
          buildStepTimeoutStatus: "pass",
          gitTimeoutStatus: "pass",
          buildNetworkStatus: "pass",
          buildNetwork: "none",
          workerUserStatus: "pass",
          workerUser: "1000:1000",
          dockerSocketGidStatus: "pass",
          dockerSocketGid: 998
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when metrics token is missing", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const {
        SITEFLOW_METRICS_TOKEN: _metricsToken,
        ...envWithoutMetricsToken
      } = validProductionEnv;
      const report = await runReleaseGate({
        root,
        env: {
          ...envWithoutMetricsToken,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          metricsTokenConfigured: false,
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.metricsToken",
              keys: ["SITEFLOW_METRICS_TOKEN", "SITEFLOW_METRICS_TOKEN_FILE", "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS"]
            })
          ])
        })
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "fail",
        promotion: true,
        runtimeEnv: {
          status: "fail",
          metricsTokenConfigured: false,
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.metricsToken",
              keys: ["SITEFLOW_METRICS_TOKEN", "SITEFLOW_METRICS_TOKEN_FILE", "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS"]
            })
          ])
        },
        branchProtection: {
          status: "pass"
        },
        commitStatus: {
          status: "pass"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails runtime env when production bearer tokens are weak", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_API_TOKEN: "token",
          SITEFLOW_METRICS_TOKEN: "metrics-token"
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          apiTokenStrengthStatus: "fail",
          metricsTokenStrengthStatus: "fail",
          appSecretStrengthStatus: "pass",
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.apiToken",
              keys: ["SITEFLOW_API_TOKEN", "SITEFLOW_API_TOKEN_FILE"]
            }),
            expect.objectContaining({
              id: "runtime.metricsToken",
              keys: ["SITEFLOW_METRICS_TOKEN", "SITEFLOW_METRICS_TOKEN_FILE", "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS"]
            })
          ]),
          secretStrengthViolations: expect.arrayContaining([
            expect.stringContaining("SITEFLOW_API_TOKEN"),
            expect.stringContaining("SITEFLOW_METRICS_TOKEN")
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        apiTokenStrengthStatus: "fail",
        metricsTokenStrengthStatus: "fail",
        appSecretStrengthStatus: "pass",
        secretStrengthViolations: expect.arrayContaining([
          expect.stringContaining("SITEFLOW_API_TOKEN"),
          expect.stringContaining("SITEFLOW_METRICS_TOKEN")
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows promotion runtime env when unauthenticated metrics are explicitly accepted", async () => {
    const root = await createReleaseRoot();
    const {
      SITEFLOW_METRICS_TOKEN: _metricsToken,
      ...envWithoutMetricsToken
    } = validProductionEnv;

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...envWithoutMetricsToken,
          SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS: "1"
        },
        promotion: true,
        allowManualBranchProtection: true,
        runner: cleanRunner
      });

      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "pass",
        details: expect.objectContaining({
          metricsTokenConfigured: false,
          unauthenticatedMetricsAllowed: true
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "pass",
        metricsTokenConfigured: false,
        unauthenticatedMetricsAllowed: true
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates required runtime env values from an env file", async () => {
    const root = await createReleaseRoot();
    const envFile = "release.env";

    await writeFile(path.join(root, envFile), [
      "SITEFLOW_ENV=production",
      "DATABASE_URL=postgres://siteflow:secret@localhost:5432/siteflow",
      "SITEFLOW_API_PORT=8787",
      "SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts",
      "SITEFLOW_PUBLIC_SCHEME=https",
      `SITEFLOW_API_TOKEN=${strongApiToken}`,
      `SITEFLOW_APP_SECRET=${strongAppSecret}`,
      `SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY=${strongReleaseEvidenceSigningKey}`,
      `SITEFLOW_METRICS_TOKEN=${strongMetricsToken}`,
      "SITEFLOW_BUILD_RUNNER=docker",
      `SITEFLOW_BUILD_IMAGE=${pinnedBuildImage}`,
      "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912",
      "SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000",
      "SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824",
      "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912",
      "SITEFLOW_PREBUILT_MAX_FILES=20000",
      "SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000",
      "SITEFLOW_GIT_TIMEOUT_MS=300000",
      "SITEFLOW_BUILD_MEMORY=1g",
      "SITEFLOW_BUILD_CPUS=2",
      "SITEFLOW_BUILD_PIDS_LIMIT=256",
      "SITEFLOW_WORKER_USER=1000:1000",
      "SITEFLOW_DOCKER_SOCKET_GID=998",
      "SITEFLOW_BUILD_NETWORK=none",
      "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK=0"
    ].join("\n"));

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        envFile,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("pass");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "pass",
        details: expect.objectContaining({
          metricsTokenConfigured: true
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        buildRunner: "docker",
        buildImage: pinnedBuildImage,
        buildImageDigestPinned: true,
        buildImagePolicyStatus: "pass",
        buildImagePolicy: "digest",
        buildMaxArtifactBytesStatus: "pass",
        buildMaxArtifactBytes: 536870912,
        buildMaxArtifactFilesStatus: "pass",
        buildMaxArtifactFiles: 20000,
        buildMinFreeBytesStatus: "pass",
        buildMinFreeBytes: 1073741824,
        prebuiltMaxUploadBytesStatus: "pass",
        prebuiltMaxUploadBytes: 536870912,
        prebuiltMaxFilesStatus: "pass",
        prebuiltMaxFiles: 20000,
        buildStepTimeoutStatus: "pass",
        buildStepTimeoutMs: 900000,
        gitTimeoutStatus: "pass",
        gitTimeoutMs: 300000,
        buildMemoryStatus: "pass",
        buildMemory: "1g",
        buildCpusStatus: "pass",
        buildCpus: 2,
        buildPidsLimitStatus: "pass",
        buildPidsLimit: 256,
        buildNetworkStatus: "pass",
        buildNetwork: "none",
        workerUserStatus: "pass",
        workerUser: "1000:1000",
        dockerSocketGidStatus: "pass",
        dockerSocketGid: 998
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates production secret values from *_FILE entries in an env file", async () => {
    const root = await createReleaseRoot();
    const envFile = "release.env";
    const secretsDir = path.join(root, "release-secrets");
    await mkdir(secretsDir, { recursive: true });
    await writeFile(path.join(secretsDir, "api-token.secret"), `${strongApiToken}\n`);
    await writeFile(path.join(secretsDir, "metrics-token.secret"), `${strongMetricsToken}\n`);
    await writeFile(path.join(secretsDir, "release-evidence-signing-key.secret"), `${strongReleaseEvidenceSigningKey}\n`);
    await writeFile(path.join(secretsDir, "app-secret.secret"), `${strongAppSecret}\n`);
    await writeFile(path.join(secretsDir, "postgres-password.secret"), "postgres-secret\n");
    await writeFile(path.join(secretsDir, "github-webhook.secret"), "github-webhook-secret-0123456789\n");
    await writeFile(path.join(secretsDir, "gitlab-webhook.secret"), "gitlab-webhook-secret-0123456789\n");
    await writeFile(path.join(secretsDir, "gitea-webhook.secret"), "gitea-webhook-secret-0123456789a\n");
    await writeFile(path.join(secretsDir, "generic-webhook.secret"), "generic-webhook-secret-012345678\n");

    await writeFile(path.join(root, envFile), [
      "SITEFLOW_ENV=production",
      "DATABASE_URL=postgres://siteflow@localhost:5432/siteflow",
      "SITEFLOW_API_PORT=8787",
      "SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts",
      "SITEFLOW_PUBLIC_SCHEME=https",
      "SITEFLOW_API_TOKEN_FILE=release-secrets/api-token.secret",
      "SITEFLOW_APP_SECRET_FILE=release-secrets/app-secret.secret",
      "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE=release-secrets/release-evidence-signing-key.secret",
      "SITEFLOW_METRICS_TOKEN_FILE=release-secrets/metrics-token.secret",
      "SITEFLOW_POSTGRES_PASSWORD_FILE=release-secrets/postgres-password.secret",
      "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE=release-secrets/github-webhook.secret",
      "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE=release-secrets/gitlab-webhook.secret",
      "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE=release-secrets/gitea-webhook.secret",
      "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE=release-secrets/generic-webhook.secret",
      "SITEFLOW_BUILD_RUNNER=docker",
      `SITEFLOW_BUILD_IMAGE=${pinnedBuildImage}`,
      "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912",
      "SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000",
      "SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824",
      "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912",
      "SITEFLOW_PREBUILT_MAX_FILES=20000",
      "SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000",
      "SITEFLOW_GIT_TIMEOUT_MS=300000",
      "SITEFLOW_BUILD_MEMORY=1g",
      "SITEFLOW_BUILD_CPUS=2",
      "SITEFLOW_BUILD_PIDS_LIMIT=256",
      "SITEFLOW_WORKER_USER=1000:1000",
      "SITEFLOW_DOCKER_SOCKET_GID=998",
      "SITEFLOW_BUILD_NETWORK=none",
      "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK=0"
    ].join("\n"));

    try {
      const report = await runReleaseGate({
        root,
        env: {},
        envFile,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("pass");
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "pass",
        metricsTokenConfigured: true,
        apiTokenStrengthStatus: "pass",
        metricsTokenStrengthStatus: "pass",
        releaseEvidenceSigningKeyStrengthStatus: "pass",
        releaseEvidenceSigningKeySource: "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE",
        appSecretStrengthStatus: "pass",
        appSecretSource: "SITEFLOW_APP_SECRET_FILE",
        gitWebhookSecretStrengthStatus: "pass",
        gitWebhookSecretSources: [
          "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE",
          "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE",
          "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE",
          "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE"
        ],
        postgresPasswordStatus: "pass",
        postgresPasswordSource: "SITEFLOW_POSTGRES_PASSWORD_FILE"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env from an env file when Docker socket gid is missing", async () => {
    const root = await createReleaseRoot();
    const envFile = "release.env";
    const fetch = createGitHubPromotionFetch();
    const {
      SITEFLOW_DOCKER_SOCKET_GID: _dockerSocketGid,
      ...envWithoutDockerSocketGid
    } = validProductionEnv;

    await writeFile(
      path.join(root, envFile),
      Object.entries(envWithoutDockerSocketGid)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")
    );

    try {
      const report = await runReleaseGate({
        root,
        env: {
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        envFile,
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          workerUserStatus: "pass",
          workerUser: "1000:1000",
          dockerSocketGidStatus: "fail",
          dockerSocketGid: null,
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.workerSocketPosture",
              keys: ["SITEFLOW_WORKER_USER", "SITEFLOW_DOCKER_SOCKET_GID"]
            })
          ]),
          runtimeControlViolations: expect.arrayContaining([
            "SITEFLOW_DOCKER_SOCKET_GID is required and must match /var/run/docker.sock group id on the target host."
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        workerUserStatus: "pass",
        workerUser: "1000:1000",
        dockerSocketGidStatus: "fail",
        dockerSocketGid: null,
        missing: expect.arrayContaining([
          expect.objectContaining({ id: "runtime.workerSocketPosture" })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when worker user is root", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_WORKER_USER: "0:0",
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          workerUserStatus: "fail",
          workerUser: "0:0",
          dockerSocketGidStatus: "pass",
          dockerSocketGid: 998,
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.workerSocketPosture",
              keys: ["SITEFLOW_WORKER_USER", "SITEFLOW_DOCKER_SOCKET_GID"]
            })
          ]),
          runtimeControlViolations: expect.arrayContaining([
            "SITEFLOW_WORKER_USER must not run the socket-mounted production worker as root."
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        workerUserStatus: "fail",
        workerUser: "0:0",
        dockerSocketGidStatus: "pass",
        dockerSocketGid: 998,
        missing: expect.arrayContaining([
          expect.objectContaining({ id: "runtime.workerSocketPosture" })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails runtime env when Docker build resource limits are missing or invalid", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_BUILD_MEMORY: "0g",
          SITEFLOW_BUILD_CPUS: "0",
          SITEFLOW_BUILD_PIDS_LIMIT: "0"
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          buildMemoryStatus: "fail",
          buildMemory: null,
          buildCpusStatus: "fail",
          buildCpus: null,
          buildPidsLimitStatus: "fail",
          buildPidsLimit: null,
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.buildResourceLimits",
              keys: ["SITEFLOW_BUILD_MEMORY", "SITEFLOW_BUILD_CPUS", "SITEFLOW_BUILD_PIDS_LIMIT"]
            })
          ]),
          runtimeControlViolations: expect.arrayContaining([
            "SITEFLOW_BUILD_MEMORY must be a positive Docker memory value such as 512m or 1g.",
            "SITEFLOW_BUILD_CPUS must be a positive number.",
            "SITEFLOW_BUILD_PIDS_LIMIT must be a positive integer."
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        buildMemoryStatus: "fail",
        buildMemory: null,
        buildCpusStatus: "fail",
        buildCpus: null,
        buildPidsLimitStatus: "fail",
        buildPidsLimit: null
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails runtime env when DATABASE_URL is passwordless without a Postgres password source", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          DATABASE_URL: "postgres://siteflow@localhost:5432/siteflow"
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          postgresPasswordStatus: "fail",
          postgresPasswordSource: null,
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.databasePassword",
              keys: ["DATABASE_URL", "SITEFLOW_POSTGRES_PASSWORD", "SITEFLOW_POSTGRES_PASSWORD_FILE"]
            })
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        postgresPasswordStatus: "fail",
        postgresPasswordSource: null
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts legacy SITEFLOW_SEALING_KEY_FILE as the app secret source", async () => {
    const root = await createReleaseRoot();
    const sealingKeyPath = path.join(root, "sealing-key.secret");
    await writeFile(sealingKeyPath, `${strongAppSecret}\n`);

    try {
      const {
        SITEFLOW_APP_SECRET: _appSecret,
        ...envWithoutAppSecret
      } = validProductionEnv;
      const report = await runReleaseGate({
        root,
        env: {
          ...envWithoutAppSecret,
          SITEFLOW_SEALING_KEY_FILE: sealingKeyPath
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("pass");
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        appSecretStrengthStatus: "pass",
        appSecretSource: "SITEFLOW_SEALING_KEY_FILE"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails runtime env when a *_FILE secret is weak", async () => {
    const root = await createReleaseRoot();
    const weakApiTokenPath = path.join(root, "weak-api-token.secret");
    await writeFile(weakApiTokenPath, "token\n");

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_API_TOKEN: undefined,
          SITEFLOW_API_TOKEN_FILE: weakApiTokenPath
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
          id: "local.requiredEnv",
          status: "fail",
          details: expect.objectContaining({
            apiTokenStrengthStatus: "fail",
            secretStrengthViolations: expect.arrayContaining([
              expect.stringContaining("SITEFLOW_API_TOKEN_FILE")
            ])
          })
        }));
      expect(JSON.stringify(report)).not.toContain("token\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails runtime env when a git webhook *_FILE secret is weak", async () => {
    const root = await createReleaseRoot();
    const weakWebhookSecretPath = path.join(root, "weak-github-webhook.secret");
    await writeFile(weakWebhookSecretPath, "weak-github-webhook-secret\n");

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: weakWebhookSecretPath
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          gitWebhookSecretStrengthStatus: "fail",
          gitWebhookSecretSources: ["SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE"],
          secretStrengthViolations: expect.arrayContaining([
            expect.stringContaining("SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE")
          ]),
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.gitWebhookSecrets"
            })
          ])
        })
      }));
      expect(JSON.stringify(report)).not.toContain("weak-github-webhook-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails runtime env when a *_FILE secret is empty", async () => {
    const root = await createReleaseRoot();
    const emptyMetricsTokenPath = path.join(root, "empty-metrics-token.secret");
    await writeFile(emptyMetricsTokenPath, "\n");

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_METRICS_TOKEN: undefined,
          SITEFLOW_METRICS_TOKEN_FILE: emptyMetricsTokenPath
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        summary: expect.stringContaining("SITEFLOW_METRICS_TOKEN_FILE points to an empty secret file")
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails runtime env when a *_FILE secret is unreadable", async () => {
    const root = await createReleaseRoot();
    const unreadableAppSecretPath = path.join(root, "missing-app-secret.secret");

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_APP_SECRET: undefined,
          SITEFLOW_APP_SECRET_FILE: unreadableAppSecretPath
        },
        requireRuntimeEnv: true,
        runner: cleanRunner,
        allowManualBranchProtection: true
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        summary: expect.stringContaining("SITEFLOW_APP_SECRET_FILE points to an unreadable secret file")
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when runtime resource controls are not explicit", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const {
        SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: _buildMaxArtifactBytes,
        SITEFLOW_BUILD_MAX_ARTIFACT_FILES: _buildMaxArtifactFiles,
        SITEFLOW_BUILD_MIN_FREE_BYTES: _buildMinFreeBytes,
        SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: _prebuiltMaxUploadBytes,
        SITEFLOW_PREBUILT_MAX_FILES: _prebuiltMaxFiles,
        SITEFLOW_BUILD_STEP_TIMEOUT_MS: _buildStepTimeout,
        SITEFLOW_GIT_TIMEOUT_MS: _gitTimeout,
        SITEFLOW_BUILD_NETWORK: _buildNetwork,
        ...envWithoutRuntimeControls
      } = validProductionEnv;
      const report = await runReleaseGate({
        root,
        env: {
          ...envWithoutRuntimeControls,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          buildMaxArtifactBytesStatus: "fail",
          buildMaxArtifactBytes: null,
          buildMaxArtifactFilesStatus: "fail",
          buildMaxArtifactFiles: null,
          buildMinFreeBytesStatus: "fail",
          buildMinFreeBytes: null,
          prebuiltMaxUploadBytesStatus: "fail",
          prebuiltMaxUploadBytes: null,
          prebuiltMaxFilesStatus: "fail",
          prebuiltMaxFiles: null,
          buildStepTimeoutStatus: "fail",
          buildStepTimeoutMs: null,
          gitTimeoutStatus: "fail",
          gitTimeoutMs: null,
          buildNetworkStatus: "fail",
          buildNetwork: null,
          missing: expect.arrayContaining([
            expect.objectContaining({ id: "runtime.buildArtifactBudget" }),
            expect.objectContaining({ id: "runtime.buildStoragePreflight" }),
            expect.objectContaining({ id: "runtime.prebuiltUploadBudget" }),
            expect.objectContaining({ id: "runtime.buildTimeouts" }),
            expect.objectContaining({ id: "runtime.buildNetwork" })
          ]),
          runtimeControlViolations: expect.arrayContaining([
            "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES is required.",
            "SITEFLOW_BUILD_MAX_ARTIFACT_FILES is required.",
            "SITEFLOW_BUILD_MIN_FREE_BYTES is required.",
            "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES is required.",
            "SITEFLOW_PREBUILT_MAX_FILES is required.",
            "SITEFLOW_BUILD_STEP_TIMEOUT_MS is required.",
            "SITEFLOW_GIT_TIMEOUT_MS is required.",
            "SITEFLOW_BUILD_NETWORK is required."
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        buildMaxArtifactBytesStatus: "fail",
        buildMaxArtifactBytes: null,
        buildMaxArtifactFilesStatus: "fail",
        buildMaxArtifactFiles: null,
        buildMinFreeBytesStatus: "fail",
        buildMinFreeBytes: null,
        prebuiltMaxUploadBytesStatus: "fail",
        prebuiltMaxUploadBytes: null,
        prebuiltMaxFilesStatus: "fail",
        prebuiltMaxFiles: null,
        buildStepTimeoutStatus: "fail",
        buildStepTimeoutMs: null,
        gitTimeoutStatus: "fail",
        gitTimeoutMs: null,
        buildNetworkStatus: "fail",
        buildNetwork: null,
        missing: expect.arrayContaining([
          expect.objectContaining({ id: "runtime.buildArtifactBudget" }),
          expect.objectContaining({ id: "runtime.buildStoragePreflight" }),
          expect.objectContaining({ id: "runtime.prebuiltUploadBudget" }),
          expect.objectContaining({ id: "runtime.buildTimeouts" }),
          expect.objectContaining({ id: "runtime.buildNetwork" })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when browser token fallback is enabled", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK: "1",
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          browserTokenFallbackEnabled: true,
          browserTokenFallbackStatus: "fail",
          browserTokenFallbackEnvValue: "1",
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.browserTokenFallback",
              keys: ["VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK"]
            })
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        browserTokenFallbackEnabled: true,
        browserTokenFallbackStatus: "fail",
        browserTokenFallbackEnvValue: "1"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when runtime resource controls are unsafe", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "0",
          SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "1.5",
          SITEFLOW_BUILD_MIN_FREE_BYTES: "-1",
          SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "-1",
          SITEFLOW_PREBUILT_MAX_FILES: "1.5",
          SITEFLOW_BUILD_STEP_TIMEOUT_MS: "0",
          SITEFLOW_GIT_TIMEOUT_MS: "9007199254740993",
          SITEFLOW_BUILD_NETWORK: "bridge",
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          buildMaxArtifactBytesStatus: "fail",
          buildMaxArtifactFilesStatus: "fail",
          buildMinFreeBytesStatus: "fail",
          prebuiltMaxUploadBytesStatus: "fail",
          prebuiltMaxFilesStatus: "fail",
          buildStepTimeoutStatus: "fail",
          gitTimeoutStatus: "fail",
          buildNetworkStatus: "fail",
          buildNetwork: "bridge",
          runtimeControlViolations: expect.arrayContaining([
            "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES must be a positive integer.",
            "SITEFLOW_BUILD_MAX_ARTIFACT_FILES must be a positive integer.",
            "SITEFLOW_BUILD_MIN_FREE_BYTES must be a positive integer.",
            "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES must be a positive integer.",
            "SITEFLOW_PREBUILT_MAX_FILES must be a positive integer.",
            "SITEFLOW_BUILD_STEP_TIMEOUT_MS must be a positive integer.",
            "SITEFLOW_GIT_TIMEOUT_MS must be a positive integer.",
            "SITEFLOW_BUILD_NETWORK must be none for production source builds."
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        buildMaxArtifactBytesStatus: "fail",
        buildMaxArtifactFilesStatus: "fail",
        buildMinFreeBytesStatus: "fail",
        prebuiltMaxUploadBytesStatus: "fail",
        prebuiltMaxFilesStatus: "fail",
        buildStepTimeoutStatus: "fail",
        gitTimeoutStatus: "fail",
        buildNetworkStatus: "fail",
        buildNetwork: "bridge"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when Docker runner and image policy are missing", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const {
        SITEFLOW_BUILD_RUNNER: _buildRunner,
        SITEFLOW_BUILD_IMAGE: _buildImage,
        ...envWithoutBuildPolicy
      } = validProductionEnv;
      const report = await runReleaseGate({
        root,
        env: {
          ...envWithoutBuildPolicy,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          sourceBuildPostureStatus: "fail",
          buildRunner: null,
          buildImage: null,
          buildImagePolicyStatus: "skipped",
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.sourceBuildPosture",
              keys: ["SITEFLOW_BUILD_RUNNER", "SITEFLOW_TRUSTED_SOURCE_BUILDS", "SITEFLOW_ALLOW_UNSANDBOXED_BUILDS"]
            })
          ])
        })
      }));
      expect(report.promotionEvidence).toMatchObject({
        gateStatus: "fail",
        promotion: true,
        runtimeEnv: {
          status: "fail",
          sourceBuildPostureStatus: "fail",
          buildRunner: null,
          buildImage: null,
          buildImagePolicyStatus: "skipped",
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.sourceBuildPosture"
            })
          ])
        },
        branchProtection: {
          status: "pass"
        },
        commitStatus: {
          status: "pass"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when the Docker image is mutable without an allowlist", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_BUILD_IMAGE: "node:20-bookworm-slim",
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("fail");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "fail",
        details: expect.objectContaining({
          sourceBuildPostureStatus: "pass",
          buildRunner: "docker",
          buildImage: "node:20-bookworm-slim",
          buildImageDigestPinned: false,
          buildImageAllowlistConfigured: false,
          buildImagePolicyStatus: "fail",
          buildImagePolicy: "mutable_tag_without_allowlist",
          missing: expect.arrayContaining([
            expect.objectContaining({
              id: "runtime.buildImagePolicy",
              keys: ["SITEFLOW_BUILD_IMAGE", "SITEFLOW_BUILD_IMAGE_ALLOWLIST", "SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE"]
            })
          ])
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "fail",
        sourceBuildPostureStatus: "pass",
        buildRunner: "docker",
        buildImage: "node:20-bookworm-slim",
        buildImageDigestPinned: false,
        buildImageAllowlistConfigured: false,
        buildImagePolicyStatus: "fail",
        buildImagePolicy: "mutable_tag_without_allowlist",
        missing: expect.arrayContaining([
          expect.objectContaining({
            id: "runtime.buildImagePolicy"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows trusted production host builds but records the exception in promotion evidence", async () => {
    const root = await createReleaseRoot();
    const fetch = createGitHubPromotionFetch();

    try {
      const {
        SITEFLOW_BUILD_IMAGE: _buildImage,
        ...hostBuildEnv
      } = validProductionEnv;
      const report = await runReleaseGate({
        root,
        env: {
          ...hostBuildEnv,
          SITEFLOW_BUILD_RUNNER: "host",
          SITEFLOW_TRUSTED_SOURCE_BUILDS: "1",
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: releaseCommitSha,
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("pass");
      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "pass",
        details: expect.objectContaining({
          sourceBuildPostureStatus: "pass",
          buildRunner: "host",
          hostBuildException: true,
          hostBuildExceptionReason: "SITEFLOW_TRUSTED_SOURCE_BUILDS",
          buildImage: null,
          buildImagePolicyStatus: "skipped",
          buildImagePolicy: "host_build_exception"
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        status: "pass",
        sourceBuildPostureStatus: "pass",
        buildRunner: "host",
        hostBuildException: true,
        hostBuildExceptionReason: "SITEFLOW_TRUSTED_SOURCE_BUILDS",
        buildImage: null,
        buildImagePolicyStatus: "skipped",
        buildImagePolicy: "host_build_exception"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks allowlisted Docker build image tags without an explicit tagged-image exception", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node:20.11",
          SITEFLOW_BUILD_IMAGE_ALLOWLIST: "registry.local/siteflow/*"
        },
        promotion: true,
        allowManualBranchProtection: true,
        runner: cleanRunner
      });

      expect(report.status).toBe("fail");
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        buildRunner: "docker",
        buildImage: "registry.local/siteflow/build-node:20.11",
        buildImageDigestPinned: false,
        buildImageAllowlistConfigured: true,
        buildImageAllowedByAllowlist: true,
        buildImageTaggedTrustedExceptionAccepted: false,
        buildImagePolicyStatus: "fail",
        buildImagePolicy: "tagged_image_without_exception"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows Docker build image tags only with an allowlist and explicit tagged-image exception", async () => {
    const root = await createReleaseRoot();

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node:20.11",
          SITEFLOW_BUILD_IMAGE_ALLOWLIST: "registry.local/siteflow/*",
          SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE: "1"
        },
        promotion: true,
        allowManualBranchProtection: true,
        runner: cleanRunner
      });

      expect(report.checks).toContainEqual(expect.objectContaining({
        id: "local.requiredEnv",
        status: "pass",
        details: expect.objectContaining({
          buildImageDigestPinned: false,
          buildImageAllowlistConfigured: true,
          buildImageAllowedByAllowlist: true,
          buildImageTaggedTrustedExceptionAccepted: true,
          buildImagePolicyStatus: "pass",
          buildImagePolicy: "tag_allowlist_exception"
        })
      }));
      expect(report.promotionEvidence.runtimeEnv).toMatchObject({
        buildRunner: "docker",
        buildImage: "registry.local/siteflow/build-node:20.11",
        buildImageDigestPinned: false,
        buildImageAllowlistConfigured: true,
        buildImageAllowedByAllowlist: true,
        buildImageTaggedTrustedExceptionAccepted: true,
        buildImagePolicyStatus: "pass",
        buildImagePolicy: "tag_allowlist_exception"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses simple env files", () => {
    expect(parseReleaseGateEnvFile([
      "# comment",
      "export SITEFLOW_ENV=production",
      "SITEFLOW_PUBLIC_SCHEME=\"https\"",
      "SITEFLOW_API_TOKEN='token'"
    ].join("\n"))).toEqual({
      SITEFLOW_ENV: "production",
      SITEFLOW_PUBLIC_SCHEME: "https",
      SITEFLOW_API_TOKEN: "token"
    });
  });
});
