import { runSiteFlowCli, type CliIo } from "./siteflowCli";
import type { SiteFlowCommandRunner } from "./doctor";
import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createIo() {
  const output = {
    stdout: "",
    stderr: ""
  };
  const io: CliIo = {
    stdout: (message) => {
      output.stdout += message;
    },
    stderr: (message) => {
      output.stderr += message;
    }
  };

  return { io, output };
}

const passingRunner: SiteFlowCommandRunner = async (command) => ({
  exitCode: 0,
  stdout: `${command} ok`,
  stderr: ""
});

const installRuntimeImage = `ghcr.io/siteflow/siteflow@sha256:${"a".repeat(64)}`;
const installPostgresImage = `postgres@sha256:${"b".repeat(64)}`;
const installBuildImage = `node:20-bookworm-slim@sha256:${"c".repeat(64)}`;

const validReleaseGateProductionEnv = {
  SITEFLOW_ENV: "production",
  DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
  SITEFLOW_API_PORT: "8787",
  SITEFLOW_ARTIFACT_ROOT: "/var/lib/siteflow/artifacts",
  SITEFLOW_PUBLIC_SCHEME: "https",
  SITEFLOW_API_TOKEN: "siteflow-api-token-0123456789abcdef",
  SITEFLOW_APP_SECRET: "siteflow-app-secret-0123456789abcdef",
  SITEFLOW_METRICS_TOKEN: "siteflow-metrics-token-0123456789abcdef",
  SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS: "0",
  VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK: "0",
  SITEFLOW_BUILD_RUNNER: "docker",
  SITEFLOW_BUILD_IMAGE: "registry.example.com/siteflow/build@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  SITEFLOW_BUILD_IMAGE_ALLOWLIST: "",
  SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE: "0",
  SITEFLOW_TRUSTED_SOURCE_BUILDS: "0",
  SITEFLOW_ALLOW_UNSANDBOXED_BUILDS: "0",
  SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "536870912",
  SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "20000",
  SITEFLOW_BUILD_MIN_FREE_BYTES: "1073741824",
  SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "536870912",
  SITEFLOW_PREBUILT_MAX_FILES: "20000",
  SITEFLOW_BUILD_STEP_TIMEOUT_MS: "900000",
  SITEFLOW_GIT_TIMEOUT_MS: "300000",
  SITEFLOW_BUILD_NETWORK: "none"
};

const validReleaseGateCliWorkflow = [
  "name: CI",
  "jobs:",
  "  test-build:",
  "    steps:",
  "      - run: npm run --silent release:dependency:policy -- --json",
  "      - run: npm ci",
  "      - run: npm run --silent release:source:check -- --json",
  "      - run: npm run --silent release:commit:plan -- --fail-on-blocked --json",
  "      - run: npm test -- --run",
  "      - run: npm run build",
  "      - run: npm run --silent release:artifacts:check -- --json",
  "      - run: npm run test:e2e",
  "      - run: npm run siteflow -- release-gate --allow-dirty --allow-manual-branch-protection"
].join("\n");

const validReleasePreflightCliWorkflow = [
  "name: Release Preflight",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      siteflow_api_url:",
  "      candidate_deployment_id:",
  "      direct_api_url:",
  "      release_image_run_id:",
  "      trust_proxy_policy:",
  "      api_instance_count:",
  "      api_process_count:",
  "      ingress_count:",
  "      api_rate_limit_scope:",
  "      api_rate_limit_enforcement_point:",
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
  "      - run: npm run siteflow -- release-gate --promotion --env-file \"$SITEFLOW_TARGET_ENV_FILE\" --commit-ref abc123 --require-commit-status --json",
  "      - run: npm run --silent release:evidence:rehearsal-pack -- --commit-ref abc123 --repo acme/siteflow --branch main --target-env-file \"$SITEFLOW_TARGET_ENV_FILE\" --public-base-url https://siteflow.example.com --operator-name operator --release-ticket REL-1",
  "      - env:",
  "          GITHUB_TOKEN: ${{ secrets.SITEFLOW_RELEASE_GITHUB_TOKEN || github.token }}",
  "          GH_TOKEN: ${{ secrets.SITEFLOW_RELEASE_GITHUB_TOKEN || github.token }}",
  "        run: npm run --silent release:evidence:target-run -- --pack evidence/release-evidence-rehearsal-pack.json --confirm-target-environment production --run-record evidence/release-evidence-target-run.json --gap-report-dir evidence/gap-reports --set-env direct-api-url=SITEFLOW_DIRECT_API_URL --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT --set-env ingress-count=SITEFLOW_INGRESS_COUNT --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT --json",
  "      - run: npm run --silent release:evidence:gaps -- --pack evidence/release-evidence-rehearsal-pack.json --set-env direct-api-url=SITEFLOW_DIRECT_API_URL --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT --set-env ingress-count=SITEFLOW_INGRESS_COUNT --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT --json",
  "      - run: rm -f \"$SITEFLOW_TARGET_ENV_FILE\"",
  "      - uses: actions/upload-artifact@v4"
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
  "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
  "      SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD: /var/lib/siteflow/evidence/backup-automation-run.json",
  "      SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: 536870912",
  "      SITEFLOW_PREBUILT_MAX_FILES: 20000",
  "    secrets:",
  "      - siteflow_app_secret",
  "      - siteflow_api_token",
  "      - siteflow_metrics_token",
  "      - siteflow_postgres_password",
  "    healthcheck:",
  "      test: fetch /readyz",
  "  worker:",
  "    image: ${SITEFLOW_IMAGE:?SITEFLOW_IMAGE must be the digest-pinned release image for production}",
  "    user: \"${SITEFLOW_WORKER_USER:-0:0}\"",
  "    group_add:",
  "      - \"${SITEFLOW_DOCKER_SOCKET_GID:-0}\"",
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
  "    secrets:",
  "      - siteflow_app_secret",
  "      - siteflow_postgres_password",
  "    volumes:",
  "      - type: bind",
  "        source: /var/run/docker.sock",
  "        target: /var/run/docker.sock",
  "secrets:",
  "  siteflow_app_secret:",
  "    file: /etc/siteflow/secrets/app-secret.secret",
  "  siteflow_api_token:",
  "    file: /etc/siteflow/secrets/api-token.secret",
  "  siteflow_metrics_token:",
  "    file: /etc/siteflow/secrets/metrics-token.secret",
  "  siteflow_postgres_password:",
  "    file: /etc/siteflow/secrets/postgres-password.secret"
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
  "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
  "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
  "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
  "SITEFLOW_PREBUILT_MAX_FILES",
  "SITEFLOW_POSTGRES_PASSWORD_FILE",
  "docker compose -f docker-compose.production.yml config"
].join("\n");

async function writeReleaseGateCliFixtureFiles(root: string) {
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(root, "docs", "deployment"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "ci.yml"), validReleaseGateCliWorkflow);
  await writeFile(path.join(root, ".github", "workflows", "release-preflight.yml"), validReleasePreflightCliWorkflow);
  await writeFile(path.join(root, "docker-compose.production.yml"), validProductionCompose);
  await writeFile(path.join(root, "docs", "deployment", "production-single-host.md"), validProductionDeploymentDoc);
  await writeFile(path.join(root, "docs", "production-readiness.md"), [
    "Branch protection must require CI.",
    "DATABASE_URL",
    "SITEFLOW_API_PORT",
    "SITEFLOW_ARTIFACT_ROOT",
    "SITEFLOW_PUBLIC_SCHEME",
    "SITEFLOW_API_TOKEN",
    "SITEFLOW_APP_SECRET",
    "SITEFLOW_SEALING_KEY",
    "SITEFLOW_METRICS_TOKEN",
    "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS",
    "SITEFLOW_BUILD_RUNNER",
    "SITEFLOW_BUILD_IMAGE",
    "SITEFLOW_BUILD_IMAGE_ALLOWLIST",
    "SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE",
    "SITEFLOW_TRUSTED_SOURCE_BUILDS",
    "SITEFLOW_ALLOW_UNSANDBOXED_BUILDS",
    "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK",
    "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
    "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
    "SITEFLOW_BUILD_MIN_FREE_BYTES",
    "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
    "SITEFLOW_PREBUILT_MAX_FILES",
    "SITEFLOW_BUILD_STEP_TIMEOUT_MS",
    "SITEFLOW_GIT_TIMEOUT_MS",
    "SITEFLOW_BUILD_NETWORK"
  ].join("\n"));
}

async function writeVerifiableBackup(backupPath: string) {
  await mkdir(path.join(backupPath, "database"), { recursive: true });
  await mkdir(path.join(backupPath, "artifacts", "project-a"), { recursive: true });
  await writeFile(path.join(backupPath, "database", "siteflow.sql"), "database dump\n", "utf8");
  await writeFile(path.join(backupPath, "artifacts", "project-a", "index.html"), "<h1>Verified</h1>", "utf8");
  await writeFile(
    path.join(backupPath, "manifest.json"),
    `${JSON.stringify({
      version: "0.1.0-test",
      createdAt: "2026-06-07T00:00:00.000Z",
      database: {
        dumpFile: "database/siteflow.sql",
        format: "plain"
      },
      artifacts: {
        sourcePath: "/var/lib/siteflow/artifacts",
        path: "artifacts",
        copied: true
      }
    })}\n`,
    "utf8"
  );
}

async function s3RecursiveListingForDirectory(rootPath: string) {
  const files: Array<{ relativePath: string; size: number }> = [];

  async function collect(currentPath: string) {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await collect(entryPath);
      } else if (entry.isFile()) {
        files.push({
          relativePath: path.relative(rootPath, entryPath).replaceAll("\\", "/"),
          size: (await stat(entryPath)).size
        });
      }
    }
  }

  await collect(rootPath);

  return files
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => `2026-06-07 01:00:00 ${file.size.toString().padStart(10, " ")} ${file.relativePath}`)
    .join("\n");
}

async function directoryTreeIntegrity(rootPath: string) {
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];

  async function collect(currentPath: string) {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await collect(entryPath);
      } else if (entry.isFile()) {
        files.push({
          relativePath: path.relative(rootPath, entryPath).replaceAll("\\", "/"),
          bytes: await readFile(entryPath)
        });
      }
    }
  }

  await collect(rootPath);

  const checksum = createHash("sha256");
  let totalBytes = 0;

  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    checksum.update(file.relativePath);
    checksum.update("\0");
    checksum.update(file.bytes);
    totalBytes += file.bytes.byteLength;
  }

  return {
    treeSha256: checksum.digest("hex"),
    fileCount: files.length,
    totalBytes
  };
}

function projectSettingsResponse() {
  return {
    project: {
      id: "project-acme-dashboard",
      slug: "acme-dashboard",
      name: "Acme Dashboard"
    },
    environmentVariables: [
      {
        key: "SITEFLOW_TOKEN",
        targetEnvironment: "preview",
        scope: "build",
        source: "sealed",
        fingerprint: "sha256:redacted"
      },
      {
        key: "API_URL",
        targetEnvironment: "production",
        scope: "runtime",
        source: "external",
        fingerprint: "external"
      }
    ],
    apiTokens: [
      {
        id: "token_ci",
        projectId: "project-acme-dashboard",
        name: "CI deploy",
        tokenPrefix: "sft_ci_tok",
        scopes: ["read", "write"],
        status: "active",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    auditEvents: [
      {
        id: "audit_promote",
        action: "deployment.promoted",
        actor: {
          name: "Acme Dev"
        },
        targetType: "deployment",
        targetId: "dep_123",
        summary: "Promotion route applied.",
        createdAt: "2026-05-26T00:00:00.000Z"
      }
    ]
  };
}

function acceptedPromotionResponse() {
  return {
    status: "accepted",
    operationId: "op_promote",
    message: "Promotion route applied.",
    routeRevision: {
      id: "route_promote",
      status: "applied",
      channel: "production",
      deploymentId: "dep_123"
    },
    safetyChecks: [
      {
        label: "Target deployment ready",
        status: "pass",
        summary: "Deployment dep_123 is ready."
      }
    ]
  };
}

function releaseEvidenceDependencies() {
  return {
    now: () => new Date("2026-06-08T12:00:00.000Z"),
    evaluate: (rawEvidence: unknown, options: { evidencePath: string }) => ({
      name: "siteflow-release-evidence-bundle-check" as const,
      status: (rawEvidence && typeof rawEvidence === "object" && "blocked" in rawEvidence ? "blocked" : "passed") as "passed" | "blocked",
      checkedAt: "2026-06-08T12:00:00.000Z",
      evidencePath: options.evidencePath,
      thresholds: {
        maxEvidenceAgeHours: 168,
        allowHostBuildException: false
      },
      selectedEvidence: {
        releaseCommitRef: "abc123def456abc123def456abc123def456abcd7890",
        repository: "acme/siteflow",
        branch: "main",
        releaseGateStatus: "pass",
        dockerBuildRehearsalStatus: "passed",
        postgresRehearsalStatus: "passed",
        artifactEvidenceStatus: "passed",
        releaseImageDigest: `sha256:${"f".repeat(64)}`,
        backupEvidenceStatus: "passed",
        observabilityEvidenceStatus: "passed",
        operatorAccessEvidenceStatus: "passed",
        nonSessionCredentialEvidenceStatus: "passed",
        ingressEvidenceStatus: "passed",
        upgradeRollbackDrillStatus: "passed"
      },
      checks: rawEvidence && typeof rawEvidence === "object" && "blocked" in rawEvidence
        ? [{ name: "promotion_evidence", status: "fail" as const, message: "blocked" }]
        : [{ name: "bundle_shape", status: "pass" as const, message: "passed" }],
      exitCode: rawEvidence && typeof rawEvidence === "object" && "blocked" in rawEvidence ? 1 : 0
    })
  };
}

async function writeReleaseEvidence(root: string, overrides: Record<string, unknown> = {}) {
  const evidencePath = path.join(root, "release-evidence.json");

  await writeFile(
    evidencePath,
    `${JSON.stringify({
      schemaVersion: "siteflow.releaseEvidence.v1",
      name: "siteflow-release-evidence-bundle",
      targetEnvironment: "production",
      release: {
        commitRef: "abc123def456abc123def456abc123def456abcd7890",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production",
        releaseTicket: "REL-2026-0608",
        operatorName: "release-operator"
      },
      ...overrides
    }, null, 2)}\n`,
    "utf8"
  );

  return evidencePath;
}

function deployHookListResponse() {
  return {
    projectId: "project-acme-dashboard",
    hooks: [
      {
        id: "hook_preview",
        projectId: "project-acme-dashboard",
        name: "CMS rebuild",
        branch: "main",
        targetEnvironment: "preview",
        tokenPrefix: "sfh_test_tok",
        status: "active",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-25T00:00:00.000Z"
  };
}

function deployHookCreateResponse() {
  return {
    status: "created",
    hook: deployHookListResponse().hooks[0],
    token: "sfh_test_token",
    hookUrl: "https://siteflow.example.com/api/deploy-hooks/sfh_test_token/trigger",
    message: "Deploy hook created."
  };
}

function deployHookRevokeResponse() {
  return {
    status: "revoked",
    hook: {
      ...deployHookListResponse().hooks[0],
      status: "revoked",
      updatedAt: "2026-05-25T00:01:00.000Z",
      revokedAt: "2026-05-25T00:01:00.000Z"
    },
    message: "Deploy hook revoked."
  };
}

function rollingCommandResponse(percentage = 10, status = "active") {
  return {
    status: "accepted",
    message: status === "completed"
      ? "Rolling release completed."
      : status === "aborted"
        ? "Rolling release aborted."
        : `Rolling release updated to ${percentage}%.`,
    rollout: {
      id: "rollout_preview",
      projectId: "project-acme-dashboard",
      channel: "production",
      currentDeploymentId: "dep-current",
      candidateDeploymentId: "dep-canary",
      percentage,
      status,
      actor: {
        id: "user_1",
        name: "Acme Dev",
        role: "developer"
      },
      reason: "canary",
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:01:00.000Z"
    },
    safetyChecks: []
  };
}

function cronJobListResponse() {
  return {
    projectId: "project-acme-dashboard",
    jobs: [
      {
        id: "cron_revalidate",
        projectId: "project-acme-dashboard",
        name: "Revalidate homepage",
        path: "/api/revalidate",
        schedule: "0 * * * *",
        status: "active",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function cronJobCreateResponse() {
  return {
    status: "created",
    job: cronJobListResponse().jobs[0],
    message: "Cron job saved."
  };
}

function cronJobDisableResponse() {
  return {
    status: "disabled",
    job: {
      ...cronJobListResponse().jobs[0],
      status: "disabled",
      updatedAt: "2026-05-26T00:01:00.000Z",
      disabledAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Cron job disabled."
  };
}

function cronJobRunResponse() {
  return {
    status: "accepted",
    job: {
      ...cronJobListResponse().jobs[0],
      lastDispatchedAt: "2026-05-26T00:01:00.000Z"
    },
    dispatch: {
      id: "crondispatch_revalidate",
      cronJobId: "cron_revalidate",
      projectId: "project-acme-dashboard",
      targetUrl: "https://dashboard.acme.test/api/revalidate",
      method: "GET",
      userAgent: "vercel-cron/1.0",
      status: "queued",
      reason: "manual",
      scheduledAt: "2026-05-26T00:01:00.000Z",
      dispatchedAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Cron dispatch queued."
  };
}

function logQueryResponse() {
  return {
    projectId: "project-acme-dashboard",
    filters: {
      source: "build",
      severity: "warning",
      search: "deploy"
    },
    entries: [
      {
        id: "log_build_warn",
        projectId: "project-acme-dashboard",
        source: "build",
        severity: "warning",
        message: "Build warning: deprecated dependency",
        timestamp: "2026-05-26T00:00:00.000Z",
        deploymentId: "dep_123",
        buildJobId: "build_123"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function logDrainListResponse() {
  return {
    projectId: "project-acme-dashboard",
    drains: [
      {
        id: "drain_datadog",
        projectId: "project-acme-dashboard",
        name: "Datadog",
        url: "https://logs.example.test/siteflow",
        sources: ["build", "function"],
        minimumSeverity: "warning",
        status: "active",
        signingSecretPrefix: "sfd_test_sec",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function logDrainCreateResponse() {
  return {
    status: "created",
    drain: logDrainListResponse().drains[0],
    message: "Log drain created."
  };
}

function logDrainDeliveryResponse() {
  return {
    status: "delivered",
    drain: {
      ...logDrainListResponse().drains[0],
      lastDeliveredAt: "2026-05-26T00:01:00.000Z"
    },
    delivery: {
      id: "delivery_1",
      drainId: "drain_datadog",
      projectId: "project-acme-dashboard",
      status: "delivered",
      responseStatus: 202,
      eventsDelivered: 1,
      attempt: 1,
      payloadSha256: "sha256:payload",
      deliveredAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Log drain delivered."
  };
}

function firewallRuleListResponse() {
  return {
    projectId: "project-acme-dashboard",
    rules: [
      {
        id: "fw_block_admin",
        projectId: "project-acme-dashboard",
        name: "Block admin",
        action: "block",
        priority: 10,
        status: "active",
        conditions: {
          pathPattern: "/admin/*",
          header: {
            name: "x-plan",
            value: "free"
          }
        },
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function firewallRuleCreateResponse() {
  return {
    status: "created",
    rule: firewallRuleListResponse().rules[0],
    message: "Firewall rule created."
  };
}

function firewallRuleDisableResponse() {
  return {
    status: "disabled",
    rule: {
      ...firewallRuleListResponse().rules[0],
      status: "disabled",
      updatedAt: "2026-05-26T00:01:00.000Z",
      disabledAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Firewall rule disabled."
  };
}

function routingRuleListResponse() {
  return {
    projectId: "project-acme-dashboard",
    rules: [
      {
        id: "route_docs",
        projectId: "project-acme-dashboard",
        name: "Docs redirect",
        kind: "redirect",
        source: "/docs",
        destination: "/documentation",
        statusCode: 308,
        priority: 10,
        status: "active",
        createdAt: "2026-05-27T00:00:00.000Z",
        updatedAt: "2026-05-27T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function routingRuleUpsertResponse() {
  return {
    status: "upserted",
    rule: routingRuleListResponse().rules[0],
    message: "Routing rule saved."
  };
}

function routingRuleDisableResponse() {
  return {
    status: "disabled",
    rule: {
      ...routingRuleListResponse().rules[0],
      status: "disabled",
      updatedAt: "2026-05-27T00:01:00.000Z",
      disabledAt: "2026-05-27T00:01:00.000Z"
    },
    message: "Routing rule disabled."
  };
}

function edgeConfigResponse() {
  return {
    projectId: "project-acme-dashboard",
    entries: [
      {
        id: "edge_maintenance",
        projectId: "project-acme-dashboard",
        key: "maintenance",
        value: false,
        valueType: "boolean",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function edgeConfigUpsertResponse() {
  return {
    status: "upserted",
    entry: {
      id: "edge_maintenance",
      projectId: "project-acme-dashboard",
      key: "maintenance",
      value: {
        enabled: true
      },
      valueType: "json",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Edge Config entry saved."
  };
}

function edgeConfigDeleteResponse() {
  return {
    status: "deleted",
    message: "Edge Config entry maintenance deleted."
  };
}

function blobFixture(pathname = "assets/config/app.json") {
  return {
    id: "blob_config_app",
    projectId: "project-acme-dashboard",
    pathname,
    access: "private",
    contentType: "application/json",
    cacheControlMaxAge: 120,
    size: 16,
    sha256: "d8d9c1b51a05fbd72c1277d9e33276805e3026d5a4b8bb58f49b754019318212",
    etag: "\"fixture\"",
    url: `/api/projects/project-acme-dashboard/blobs/${encodeURIComponent(pathname)}`,
    uploadedAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function blobListResponse() {
  return {
    projectId: "project-acme-dashboard",
    blobs: [blobFixture()],
    total: 1,
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function blobPutResponse() {
  return {
    status: "uploaded",
    blob: blobFixture(),
    message: "Blob uploaded."
  };
}

function blobReadResponse() {
  return {
    projectId: "project-acme-dashboard",
    blob: blobFixture(),
    contentBase64: Buffer.from("{\"enabled\":true}", "utf8").toString("base64")
  };
}

function blobDeleteResponse() {
  return {
    status: "deleted",
    blob: blobFixture(),
    message: "Blob deleted."
  };
}

function cacheEntryFixture(pathname = "/pricing", status = "stale") {
  return {
    id: `cache_${pathname.replace(/[^a-z0-9]+/gi, "_")}`,
    projectId: "project-acme-dashboard",
    key: `page:${pathname}`,
    path: pathname,
    tags: ["marketing", pathname === "/" ? "home" : "pricing"],
    status,
    contentType: "text/html; charset=utf-8",
    size: 4096,
    etag: `"cache-${pathname}"`,
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 300,
    lastGeneratedAt: "2026-05-27T00:00:00.000Z",
    expiresAt: "2026-05-27T00:01:00.000Z",
    staleAt: "2026-05-27T00:06:00.000Z",
    updatedAt: "2026-05-27T00:06:00.000Z"
  };
}

function cacheListResponse() {
  return {
    projectId: "project-acme-dashboard",
    entries: [cacheEntryFixture()],
    total: 1,
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function cachePurgeResponse() {
  return {
    status: "purged",
    projectId: "project-acme-dashboard",
    purged: [
      {
        ...cacheEntryFixture("/pricing", "purged"),
        purgedAt: "2026-05-27T00:10:00.000Z",
        updatedAt: "2026-05-27T00:10:00.000Z"
      }
    ],
    total: 1,
    message: "Purged 1 cache entry."
  };
}

function functionRuntimeEntry() {
  return {
    projectId: "project-acme-dashboard",
    deploymentId: "dep_function",
    function: {
      path: "/api/revalidate",
      sourcePath: ".siteflow/functions/api/revalidate.js",
      runtime: "nodejs20.x",
      handler: "default",
      methods: ["POST"]
    },
    limits: {
      timeoutMs: 10000,
      memoryMb: 512,
      concurrency: 50
    },
    summary: {
      invocations: 2,
      errors: 1,
      errorRate: 0.5,
      averageDurationMs: 110,
      p95DurationMs: 180,
      lastInvokedAt: "2026-05-27T00:10:00.000Z"
    }
  };
}

function functionListResponse() {
  return {
    projectId: "project-acme-dashboard",
    deploymentId: "dep_function",
    functions: [functionRuntimeEntry()],
    total: 1,
    updatedAt: "2026-05-27T00:12:00.000Z"
  };
}

function functionRuntimeResponse() {
  return {
    projectId: "project-acme-dashboard",
    deploymentId: "dep_function",
    function: functionRuntimeEntry(),
    recentInvocations: [
      {
        id: "fninv_ok",
        path: "/api/revalidate",
        method: "POST",
        status: "succeeded",
        responseStatus: 200,
        durationMs: 40,
        requestId: "req_ok",
        invokedAt: "2026-05-27T00:10:00.000Z"
      }
    ],
    updatedAt: "2026-05-27T00:12:00.000Z"
  };
}

describe("siteflow CLI", () => {
  it("prints help", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(["--help"], io);

    expect(code).toBe(0);
    expect(output.stdout).toContain("siteflow install");
    expect(output.stdout).toContain("siteflow backup restore-drill");
    expect(output.stdout).toContain("siteflow backup offload");
    expect(output.stdout).toContain("siteflow backup fetch");
    expect(output.stdout).toContain("siteflow backup prune");
    expect(output.stdout).toContain("disposable-postgres-url");
    expect(output.stdout).toContain("siteflow release-gate");
    expect(output.stdout).toContain("siteflow rolling start <deploymentId> --percentage 10");
    expect(output.stdout).toContain("[--release-evidence release-evidence.json]");
  });

  it("runs release gate with JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gate-cli-"));
    const { io, output } = createIo();

    try {
      await writeReleaseGateCliFixtureFiles(root);

      const code = await runSiteFlowCli([
        "release-gate",
        "--root",
        root,
        "--allow-dirty",
        "--allow-manual-branch-protection",
        "--json"
      ], io, {
        env: {},
        releaseGate: {
          now: () => new Date("2026-06-08T12:00:00.000Z"),
          runner: async () => ({
            exitCode: 0,
            stdout: " M dist/index.html\n",
            stderr: ""
          })
        }
      });
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: "pass",
        root,
        checkedAt: "2026-06-08T12:00:00.000Z"
      });
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "external.githubBranchProtection",
        status: "manual_required"
      }));
      expect(result.promotionEvidence).toMatchObject({
        gateStatus: "pass",
        checkedAt: "2026-06-08T12:00:00.000Z",
        promotion: false,
        manualRequired: true,
        manualRequiredCheckIds: ["external.githubBranchProtection"],
        branchProtection: {
          status: "manual_required",
          branch: "main",
          requiredStatusCheck: "Install, test, and build"
        },
        commitStatus: {
          status: "skipped",
          requiredStatusCheck: "Install, test, and build"
        },
        runtimeEnv: {
          status: "skipped",
          metricsTokenConfigured: null
        },
        dirtyWorktree: {
          status: "pass",
          dirty: true,
          entries: [" M dist/index.html"]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns promotion JSON as manual_required when GitHub evidence is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gate-cli-manual-"));
    const { io, output } = createIo();

    try {
      await writeReleaseGateCliFixtureFiles(root);

      const code = await runSiteFlowCli([
        "release-gate",
        "--root",
        root,
        "--promotion",
        "--allow-manual-branch-protection",
        "--commit-ref",
        "abc123def456abc123def456abc123def456abcd",
        "--json"
      ], io, {
        env: validReleaseGateProductionEnv,
        releaseGate: {
          runner: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: ""
          })
        }
      });
      const result = JSON.parse(output.stdout);

      expect(code).toBe(1);
      expect(result.status).toBe("manual_required");
      expect(result.promotionEvidence).toMatchObject({
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
          buildImage: "registry.example.com/siteflow/build@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          buildImageDigestPinned: true,
          buildImagePolicyStatus: "pass",
          buildImagePolicy: "digest"
        },
        dirtyWorktree: {
          status: "pass",
          dirty: false
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes release gate repository, branch, and commit evidence options", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gate-cli-evidence-"));
    const { io, output } = createIo();
    const requests: Array<{ url: string; authorization: string }> = [];

    try {
      await writeReleaseGateCliFixtureFiles(root);

      const code = await runSiteFlowCli([
        "release-gate",
        "--root",
        root,
        "--repo",
        "acme/siteflow",
        "--branch",
        "release",
        "--commit-ref",
        "abc123def456abc123def456abc123def456abcd",
        "--required-status-check",
        "Required / siteflow",
        "--require-commit-status",
        "--promotion",
        "--json"
      ], io, {
        env: {
          ...validReleaseGateProductionEnv,
          GITHUB_TOKEN: "ghs_test"
        },
        releaseGate: {
          runner: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: ""
          }),
          fetch: async (input, init) => {
            const url = input.toString();
            requests.push({
              url,
              authorization: new Headers(init?.headers).get("authorization") ?? ""
            });

            if (url.includes("/required_status_checks")) {
              return new Response(JSON.stringify({
                contexts: ["Required / siteflow"],
                checks: []
              }), {
                status: 200,
                headers: { "content-type": "application/json" }
              });
            }

            if (/\/branches\/[^/]+$/.test(url)) {
              return new Response(JSON.stringify({
                commit: { sha: "abc123def456abc123def456abc123def456abcd" }
              }), {
                status: 200,
                headers: { "content-type": "application/json" }
              });
            }

            return new Response(JSON.stringify({
              check_runs: [
                {
                  name: "Required / siteflow",
                  status: "completed",
                  conclusion: "success"
                }
              ]
            }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        }
      });
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result.status).toBe("pass");
      expect(result.promotionEvidence).toMatchObject({
        gateStatus: "pass",
        promotion: true,
        commitRef: "abc123def456abc123def456abc123def456abcd",
        repository: "acme/siteflow",
        branch: "release",
        requiredStatusCheck: "Required / siteflow",
        branchProtection: {
          status: "pass",
          repository: "acme/siteflow",
          branch: "release",
          requiredStatusCheck: "Required / siteflow",
          requiredStatusChecks: ["Required / siteflow"]
        },
        protectedBranchCommit: {
          status: "pass",
          repository: "acme/siteflow",
          branch: "release",
          commitRef: "abc123def456abc123def456abc123def456abcd",
          branchHeadSha: "abc123def456abc123def456abc123def456abcd"
        },
        commitStatus: {
          status: "pass",
          repository: "acme/siteflow",
          commitRef: "abc123def456abc123def456abc123def456abcd",
          requiredStatusCheck: "Required / siteflow",
          checkRun: {
            name: "Required / siteflow",
            status: "completed",
            conclusion: "success"
          }
        },
        manualRequired: false,
        manualRequiredCheckIds: [],
        runtimeEnv: {
          status: "pass",
          metricsTokenConfigured: true,
          sourceBuildPostureStatus: "pass",
          buildRunner: "docker",
          hostBuildException: false,
          buildImage: "registry.example.com/siteflow/build@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          buildImageDigestPinned: true,
          buildImagePolicyStatus: "pass",
          buildImagePolicy: "digest"
        },
        dirtyWorktree: {
          status: "pass",
          dirty: false,
          entries: []
        }
      });
      expect(requests).toEqual([
        {
          url: "https://api.github.com/repos/acme/siteflow/branches/release/protection/required_status_checks",
          authorization: "Bearer ghs_test"
        },
        {
          url: "https://api.github.com/repos/acme/siteflow/branches/release",
          authorization: "Bearer ghs_test"
        },
        {
          url: "https://api.github.com/repos/acme/siteflow/commits/abc123def456abc123def456abc123def456abcd/check-runs?check_name=Required+%2F+siteflow",
          authorization: "Bearer ghs_test"
        }
      ]);
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "external.githubCommitStatus",
        status: "pass"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs doctor with JSON output", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(["doctor", "--json"], io, {
      doctor: {
        platform: "linux",
        arch: "x64",
        runner: passingRunner
      }
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "pass"
    });
  });

  it("prints a single-host install dry-run plan", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli([
      "install",
      "--topology",
      "single",
      "--domain",
      "siteflow.example.com",
      "--image",
      installRuntimeImage,
      "--postgres-image",
      installPostgresImage,
      "--build-image",
      installBuildImage,
      "--dry-run",
      "--json"
    ], io, {
      version: "0.1.0-test"
    });
    const plan = JSON.parse(output.stdout);

    expect(code).toBe(0);
    expect(plan).toMatchObject({
      topology: "single",
      dryRun: true,
      installState: {
        siteflowVersion: "0.1.0-test",
        router: {
          controlPlaneHost: "siteflow.example.com",
          wildcardBaseDomain: "siteflow.example.com",
          previewHostPattern: "*.siteflow.example.com"
        },
        tls: {
          domains: ["siteflow.example.com", "*.siteflow.example.com"]
        }
      },
      runtimeEnv: {
        SITEFLOW_BASE_DOMAIN: "siteflow.example.com",
        SITEFLOW_WORKER_POLL_INTERVAL_MS: "5000",
        SITEFLOW_IMAGE: installRuntimeImage,
        SITEFLOW_POSTGRES_IMAGE: installPostgresImage,
        SITEFLOW_BUILD_IMAGE: installBuildImage,
        SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "536870912",
        SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "20000",
        SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "536870912",
        SITEFLOW_PREBUILT_MAX_FILES: "20000"
      }
    });
    expect(plan.renderedAssets.env.content).toContain("SITEFLOW_BASE_DOMAIN=siteflow.example.com");
    expect(plan.renderedAssets.env.content).not.toContain("WEBHOOK_SECRET");
    expect(plan.renderedAssets.compose.content).toContain("  worker:");
    expect(plan.renderedAssets.compose.content).toContain("exec node dist-worker/worker/index.js");
    expect(plan.renderedAssets.compose.content).toContain("condition: service_healthy");
    expect(plan.renderedAssets.compose.content).toContain("fetch('http://127.0.0.1:8787/readyz')");
    expect(plan.renderedAssets.compose.content).toContain('    user: "${SITEFLOW_WORKER_USER:-0:0}"');
    expect(plan.renderedAssets.compose.content).toContain("    group_add:");
    expect(plan.renderedAssets.compose.content).toContain("SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE");
    expect(plan.renderedAssets.compose.content).toContain('DATABASE_URL: "postgres://siteflow@postgres:5432/siteflow"');
    expect(plan.renderedAssets.compose.content).not.toContain("export SITEFLOW_");
    expect(plan.renderedAssets.compose.content).not.toContain("$(cat /run/secrets/");
    expect(plan.renderedAssets.nginx.content).toContain("server_name *.siteflow.example.com;");
    expect(plan.installState.secrets).toMatchObject({
      githubWebhookSecretRef: "/etc/siteflow/secrets/github-webhook.secret",
      gitlabWebhookSecretRef: "/etc/siteflow/secrets/gitlab-webhook.secret",
      giteaWebhookSecretRef: "/etc/siteflow/secrets/gitea-webhook.secret",
      genericWebhookSecretRef: "/etc/siteflow/secrets/generic-webhook.secret"
    });
    expect(plan.secrets.map((secret: { id: string }) => secret.id)).toEqual(
      expect.arrayContaining(["github-webhook", "gitlab-webhook", "gitea-webhook", "generic-webhook"])
    );
    expect(plan.steps.map((step: { id: string }) => step.id)).toContain("router");
  });

  it("renders an explicit wildcard base domain separately from the control-plane domain", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "install",
        "--topology",
        "single",
        "--domain",
        "siteflow.w33d.xyz",
        "--base-domain",
        "w33d.xyz",
        "--image",
        installRuntimeImage,
        "--postgres-image",
        installPostgresImage,
        "--build-image",
        installBuildImage,
        "--dry-run",
        "--json"
      ],
      io,
      {
        version: "0.1.0-test"
      }
    );
    const plan = JSON.parse(output.stdout);

    expect(code).toBe(0);
    expect(plan.installState.router).toMatchObject({
      controlPlaneHost: "siteflow.w33d.xyz",
      wildcardBaseDomain: "w33d.xyz",
      previewHostPattern: "*.w33d.xyz"
    });
    expect(plan.installState.tls.domains).toEqual(["siteflow.w33d.xyz", "*.w33d.xyz"]);
    expect(plan.runtimeEnv.SITEFLOW_BASE_DOMAIN).toBe("w33d.xyz");
    expect(plan.runtimeEnv.SITEFLOW_WORKER_POLL_INTERVAL_MS).toBe("5000");
    expect(plan.renderedAssets.nginx.content).toContain("server_name siteflow.w33d.xyz;");
    expect(plan.renderedAssets.nginx.content).toContain("server_name *.w33d.xyz;");
    expect(plan.renderedAssets.nginx.content).toContain("location ^~ /api/");
  });

  it("requires explicit confirmation before install apply", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(["install"], io);

    expect(code).toBe(2);
    expect(output.stderr).toContain("requires --yes");
  });

  it("applies install assets when explicitly confirmed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-install-cli-"));
    const commands: string[] = [];
    const healthRequests: string[] = [];
    const { io, output } = createIo();

    try {
      const code = await runSiteFlowCli(
        [
          "install",
          "--topology",
          "single",
          "--domain",
          "siteflow.w33d.xyz",
          "--base-domain",
          "w33d.xyz",
          "--image",
          installRuntimeImage,
          "--postgres-image",
          installPostgresImage,
          "--build-image",
          installBuildImage,
          "--yes",
          "--json"
        ],
        io,
        {
          version: "0.1.0-test",
          install: {
            root,
            linkStrategy: "copy",
            runner: async (command, args) => {
              commands.push([command, ...args].join(" "));
              return {
                exitCode: 0,
                stdout: "ok",
                stderr: ""
              };
            },
            fetch: async (input) => {
              healthRequests.push(input.toString());
              return new Response(JSON.stringify({ status: "ok" }), {
                status: 200,
                headers: { "content-type": "application/json" }
              });
            }
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: "installed",
        doctor: {
          status: "pass"
        },
        router: {
          wildcardBaseDomain: "w33d.xyz",
          previewHostPattern: "*.w33d.xyz"
        }
      });
      expect(commands).toEqual([
        "systemctl daemon-reload",
        "systemctl enable --now siteflow.service",
        "nginx -t",
        "nginx -s reload",
        "systemctl is-active siteflow.service"
      ]);
      expect(healthRequests).toEqual(["http://127.0.0.1:8787/readyz"]);
      const envFile = await readFile(path.join(root, "etc/siteflow/siteflow.env"), "utf8");
      const composeFile = await readFile(path.join(root, "opt/siteflow/compose.yaml"), "utf8");
      expect(envFile).toContain("SITEFLOW_BASE_DOMAIN=w33d.xyz");
      expect(envFile).toContain("SITEFLOW_TRUST_PROXY=loopback");
      expect(composeFile).toContain(installRuntimeImage);
      expect(composeFile).toContain(installPostgresImage);
      expect(composeFile).toContain(`SITEFLOW_BUILD_IMAGE: "${installBuildImage}"`);
      expect(composeFile).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
      expect(composeFile).toContain('SITEFLOW_TRUST_PROXY: "loopback"');
      expect(composeFile).toContain("condition: service_healthy");
      expect(composeFile).toContain("fetch('http://127.0.0.1:8787/readyz')");
      expect(composeFile).toContain('    user: "${SITEFLOW_WORKER_USER:-0:0}"');
      expect(composeFile).toContain("    group_add:");
      expect(composeFile).toContain("  worker:");
      expect(composeFile).toContain("SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE");
      expect(composeFile).toContain("SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE");
      expect(composeFile).toContain("SITEFLOW_GITEA_WEBHOOK_SECRET_FILE");
      expect(composeFile).toContain("SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE");
      expect(composeFile).toContain('DATABASE_URL: "postgres://siteflow@postgres:5432/siteflow"');
      expect(composeFile).not.toContain("export SITEFLOW_");
      expect(composeFile).not.toContain("$(cat /run/secrets/");
      expect(composeFile).toContain("/etc/siteflow/secrets/github-webhook.secret");
      expect(composeFile).toContain("/etc/siteflow/secrets/gitlab-webhook.secret");
      expect(composeFile).toContain("/etc/siteflow/secrets/gitea-webhook.secret");
      expect(composeFile).toContain("/etc/siteflow/secrets/generic-webhook.secret");
      const activeNginx = await readFile(path.join(root, "etc/nginx/sites-enabled/siteflow.conf"), "utf8");
      expect(activeNginx).toContain("limit_req_zone $binary_remote_addr zone=siteflow_api:10m rate=120r/m;");
      expect(activeNginx).toContain("limit_req_status 429;");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks restore without explicit confirmation", async () => {
    const databaseUrl = "postgres://siteflow:supersecret@localhost:5432/siteflow";
    const { io, output } = createIo();
    let runnerCalled = false;
    const code = await runSiteFlowCli(
      [
        "restore",
        "--backup",
        path.join(os.tmpdir(), "siteflow-backup"),
        "--database-url",
        databaseUrl,
        "--artifact-root",
        path.join(os.tmpdir(), "siteflow-artifacts"),
        "--json"
      ],
      io,
      {
        backup: {
          runner: async () => {
            runnerCalled = true;

            return {
              exitCode: 0,
              stdout: "ok",
              stderr: ""
            };
          }
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(result).toMatchObject({
      status: "blocked"
    });
    expect(result.message).toContain("requires --yes");
    expect(runnerCalled).toBe(false);
  });

  it("blocks backup restore-drill without explicit confirmation", async () => {
    const databaseUrl = "postgres://siteflow:supersecret@localhost:5432/siteflow_drill";
    const { io, output } = createIo();
    let runnerCalled = false;
    const code = await runSiteFlowCli(
      [
        "backup",
        "restore-drill",
        "--backup",
        path.join(os.tmpdir(), "siteflow-backup"),
        "--database-url",
        databaseUrl,
        "--artifact-root",
        path.join(os.tmpdir(), "siteflow-drill-artifacts"),
        "--json"
      ],
      io,
      {
        backup: {
          runner: async () => {
            runnerCalled = true;

            return {
              exitCode: 0,
              stdout: "ok",
              stderr: ""
            };
          }
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(result).toMatchObject({
      status: "blocked",
      restoreDrill: true
    });
    expect(result.message).toContain("requires --yes");
    expect(result.message).toContain("disposable database");
    expect(result.message).toContain("Do not use production targets");
    expect(runnerCalled).toBe(false);
  });

  it("blocks backup restore-drill when env DATABASE_URL matches the drill database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-restore-drill-db-overlap-"));
    const backupPath = path.join(root, "backup");
    const databaseUrl = "postgres://siteflow:supersecret@localhost:5432/siteflow";
    const { io, output } = createIo();
    let runnerCalled = false;

    try {
      await writeVerifiableBackup(backupPath);

      const code = await runSiteFlowCli(
        [
          "backup",
          "restore-drill",
          "--backup",
          backupPath,
          "--database-url",
          databaseUrl,
          "--artifact-root",
          path.join(root, "drill-artifacts"),
          "--yes",
          "--json"
        ],
        io,
        {
          backup: {
            runner: async () => {
              runnerCalled = true;

              return {
                exitCode: 0,
                stdout: "ok",
                stderr: ""
              };
            }
          },
          env: {
            DATABASE_URL: "postgresql://siteflow:prodsecret@LOCALHOST/siteflow?sslmode=require",
            SITEFLOW_ARTIFACT_ROOT: path.join(root, "current-artifacts")
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(1);
      expect(result).toMatchObject({
        status: "failed",
        restoreDrill: true
      });
      expect(result.message).toContain("Restore drill database URL must be isolated");
      expect(result.message).not.toContain("prodsecret");
      expect(runnerCalled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks backup restore-drill when explicit current artifact root overlaps the target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-restore-drill-artifact-overlap-"));
    const backupPath = path.join(root, "backup");
    const currentArtifactRoot = path.join(root, "current-artifacts");
    const { io, output } = createIo();
    let runnerCalled = false;

    try {
      await writeVerifiableBackup(backupPath);
      await mkdir(currentArtifactRoot, { recursive: true });
      await writeFile(path.join(currentArtifactRoot, "keep.txt"), "production artifact\n", "utf8");

      const code = await runSiteFlowCli(
        [
          "backup",
          "restore-drill",
          "--backup",
          backupPath,
          "--database-url",
          "postgres://siteflow:supersecret@localhost:5432/siteflow_drill",
          "--artifact-root",
          currentArtifactRoot,
          "--current-artifact-root",
          currentArtifactRoot,
          "--yes",
          "--json"
        ],
        io,
        {
          backup: {
            runner: async () => {
              runnerCalled = true;

              return {
                exitCode: 0,
                stdout: "ok",
                stderr: ""
              };
            }
          },
          env: {
            DATABASE_URL: "postgres://siteflow:prodsecret@localhost:5432/siteflow"
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(1);
      expect(result).toMatchObject({
        status: "failed",
        restoreDrill: true
      });
      expect(result.message).toContain("Restore drill artifact root must be isolated from the current artifact root");
      expect(runnerCalled).toBe(false);
      expect(await readFile(path.join(currentArtifactRoot, "keep.txt"), "utf8")).toBe("production artifact\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns redacted JSON when backup command execution fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-"));
    const databaseUrl = "postgres://siteflow:supersecret@localhost:5432/siteflow";
    const { io, output } = createIo();

    try {
      const code = await runSiteFlowCli(
        [
          "backup",
          "--output",
          path.join(root, "backup"),
          "--database-url",
          databaseUrl,
          "--artifact-root",
          path.join(root, "artifacts"),
          "--json"
        ],
        io,
        {
          backup: {
            runner: async () => ({
              exitCode: 1,
              stdout: "",
              stderr: `pg_dump failed for ${databaseUrl} password=supersecret`
            })
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(1);
      expect(result).toMatchObject({
        status: "failed"
      });
      expect(result.message).toContain("[redacted database url]");
      expect(result.message).not.toContain(databaseUrl);
      expect(result.message).not.toContain("supersecret");
      expect(output.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies a backup with JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-verify-json-"));
    const backupPath = path.join(root, "backup");
    const { io, output } = createIo();

    try {
      await writeVerifiableBackup(backupPath);

      const code = await runSiteFlowCli(["backup", "verify", "--backup", backupPath, "--json"], io);
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: "verified",
        backupPath,
        verificationType: "static",
        restoreDrill: false,
        artifacts: {
          copied: true,
          present: true
        }
      });
      expect(result.note).toContain("no database restore was performed");
      expect(output.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies a backup with text output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-verify-text-"));
    const backupPath = path.join(root, "backup");
    const { io, output } = createIo();

    try {
      await writeVerifiableBackup(backupPath);

      const code = await runSiteFlowCli(["backup", "verify", "--backup", backupPath], io);

      expect(code).toBe(0);
      expect(output.stdout).toContain("SiteFlow backup verified");
      expect(output.stdout).toContain("Scope: Static verification only; no database restore was performed.");
      expect(output.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("offloads a backup with JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-offload-json-"));
    const backupPath = path.join(root, "backup");
    const offHostRoot = path.join(root, "offhost");
    const { io, output } = createIo();

    try {
      await writeVerifiableBackup(backupPath);

      const code = await runSiteFlowCli([
        "backup",
        "offload",
        "--backup",
        backupPath,
        "--target",
        pathToFileURL(offHostRoot).href,
        "--json"
      ], io, {
        backup: {
          now: () => new Date("2026-06-07T02:00:00.000Z")
        }
      });
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: "offloaded",
        backupPath,
        offloadedAt: "2026-06-07T02:00:00.000Z",
        target: {
          provider: "file",
          checksumVerified: true
        }
      });
      expect(result.target.location).toBe(pathToFileURL(path.join(offHostRoot, "backup")).href);
      expect(await readFile(path.join(offHostRoot, "backup", "database", "siteflow.sql"), "utf8")).toBe("database dump\n");
      expect(output.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches a backup from S3 with JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-fetch-json-"));
    const remoteBackupPath = path.join(root, "remote", "siteflow-20260607");
    const outputRoot = path.join(root, "fetched");
    const commands: Array<{ command: string; args: string[] }> = [];
    const { io, output } = createIo();

    try {
      await writeVerifiableBackup(remoteBackupPath);
      const expectedIntegrity = await directoryTreeIntegrity(remoteBackupPath);
      const code = await runSiteFlowCli(
        [
          "backup",
          "fetch",
          "--source",
          "s3://siteflow-prod-backups/backups/siteflow-20260607",
          "--output",
          outputRoot,
          "--expected-tree-sha256",
          expectedIntegrity.treeSha256,
          "--expected-object-count",
          String(expectedIntegrity.fileCount),
          "--expected-total-bytes",
          String(expectedIntegrity.totalBytes),
          "--json"
        ],
        io,
        {
          backup: {
            runner: async (command, args) => {
              commands.push({ command, args });

              if (command === "aws" && args[0] === "s3" && args[1] === "ls") {
                return {
                  exitCode: 0,
                  stdout: await s3RecursiveListingForDirectory(remoteBackupPath),
                  stderr: ""
                };
              }

              if (command === "aws" && args[0] === "s3" && args[1] === "cp") {
                await cp(remoteBackupPath, args[3], { recursive: true });

                return { exitCode: 0, stdout: "", stderr: "" };
              }

              return { exitCode: 1, stdout: "", stderr: "unexpected command" };
            },
            now: () => new Date("2026-06-07T02:00:00.000Z")
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(commands).toHaveLength(2);
      expect(result).toMatchObject({
        status: "fetched",
        backupPath: path.join(outputRoot, "siteflow-20260607"),
        fetchedAt: "2026-06-07T02:00:00.000Z",
        checksumVerified: true,
        verifyResult: {
          status: "verified",
          version: "0.1.0-test"
        }
      });
      expect(result.source.location).toBe("s3://siteflow-prod-backups/backups/siteflow-20260607");
      expect(result.treeSha256).toBe(expectedIntegrity.treeSha256);
      expect(await readFile(path.join(outputRoot, "siteflow-20260607", "database", "siteflow.sql"), "utf8")).toBe("database dump\n");
      expect(output.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans backup pruning with JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-prune-json-"));
    const backupRoot = path.join(root, "backups");
    const { io, output } = createIo();

    try {
      await writeVerifiableBackup(path.join(backupRoot, "siteflow-old-a"));
      await writeVerifiableBackup(path.join(backupRoot, "siteflow-old-b"));
      await writeFile(
        path.join(backupRoot, "siteflow-old-a", "manifest.json"),
        `${JSON.stringify({
          version: "0.1.0-test",
          createdAt: "2026-01-01T00:00:00.000Z",
          database: {
            dumpFile: "database/siteflow.sql",
            format: "plain"
          },
          artifacts: {
            sourcePath: "/var/lib/siteflow/artifacts",
            path: "artifacts",
            copied: true
          }
        })}\n`,
        "utf8"
      );

      const code = await runSiteFlowCli([
        "backup",
        "prune",
        "--backup-root",
        backupRoot,
        "--retention-days",
        "30",
        "--minimum-backups",
        "1",
        "--dry-run",
        "--json"
      ], io, {
        backup: {
          now: () => new Date("2026-06-07T00:00:00.000Z")
        }
      });
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: "planned",
        backupRoot,
        retentionDays: 30,
        minimumBackups: 1,
        dryRun: true,
        evaluatedBackups: 2
      });
      expect(result.candidates.map((backup: { backupPath: string }) => path.basename(backup.backupPath))).toEqual(["siteflow-old-a"]);
      expect(result.deleted).toEqual([]);
      expect(await readFile(path.join(backupRoot, "siteflow-old-a", "manifest.json"), "utf8")).toContain("2026-01-01T00:00:00.000Z");
      expect(output.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks backup pruning without dry-run or explicit confirmation", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli([
      "backup",
      "prune",
      "--backup-root",
      path.join(os.tmpdir(), "siteflow-backups"),
      "--retention-days",
      "30",
      "--minimum-backups",
      "8",
      "--json"
    ], io);
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(result).toMatchObject({
      status: "blocked"
    });
    expect(result.message).toContain("requires --yes");
    expect(output.stderr).toBe("");
  });

  it("runs backup restore-drill with JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-cli-restore-drill-json-"));
    const backupPath = path.join(root, "backup");
    const artifactRoot = path.join(root, "drill-artifacts");
    const databaseUrl = "postgres://siteflow:supersecret@localhost:5432/siteflow_drill";
    const commands: Array<{ command: string; args: string[] }> = [];
    let nowCallCount = 0;
    const { io, output } = createIo();

    try {
      await writeVerifiableBackup(backupPath);

      const code = await runSiteFlowCli(
        [
          "backup",
          "restore-drill",
          "--backup",
          backupPath,
          "--database-url",
          databaseUrl,
          "--artifact-root",
          artifactRoot,
          "--yes",
          "--json"
        ],
        io,
        {
          backup: {
            runner: async (command, args) => {
              commands.push({ command, args });

              return {
                exitCode: 0,
                stdout: "ok",
                stderr: ""
              };
            },
            now: () => new Date(nowCallCount++ === 0 ? "2026-06-07T00:00:00.000Z" : "2026-06-07T00:00:00.125Z")
          },
          env: {
            DATABASE_URL: "postgres://siteflow:prodsecret@localhost:5432/siteflow",
            SITEFLOW_ARTIFACT_ROOT: path.join(root, "current-artifacts")
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: "restore_drilled",
        restoreDrill: true,
        backupPath,
        durationMs: 125,
        database: {
          target: "disposable_database",
          databaseUrl: "[redacted database url]"
        },
        artifacts: {
          target: "temporary_artifact_root",
          targetPath: artifactRoot,
          copied: true,
          restoreMode: "replace_non_atomic"
        }
      });
      expect(commands).toEqual([
        {
          command: "psql",
          args: [
            "--dbname",
            databaseUrl,
            "--set",
            "ON_ERROR_STOP=1",
            "--single-transaction",
            "--file",
            path.join(backupPath, "database", "siteflow.sql")
          ]
        }
      ]);
      expect(output.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads a prebuilt directory and prints the preview URL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteflow-prebuilt-"));

    try {
      await writeFile(path.join(directory, "index.html"), "<h1>Hello SiteFlow</h1>");
      await writeFile(path.join(directory, "vercel.json"), JSON.stringify({
        redirects: [
          {
            source: "/docs",
            destination: "/documentation",
            permanent: true
          }
        ],
        rewrites: [
          {
            source: "/blog/:slug",
            destination: "/posts/:slug"
          }
        ],
        headers: [
          {
            source: "/(.*)",
            headers: [
              {
                key: "x-frame-options",
                value: "DENY"
              }
            ]
          }
        ],
        cleanUrls: true,
        trailingSlash: false,
        skipTrailingSlashRedirect: true,
        public: true,
        fluid: true,
        images: {
          sizes: [320, 640],
          qualities: [70, 80],
          formats: ["image/webp"],
          minimumCacheTTL: 120,
          dangerouslyAllowSVG: true,
          contentSecurityPolicy: "script-src 'none'; sandbox;",
          contentDispositionType: "inline"
        },
        crons: [
          {
            path: "/api/revalidate",
            schedule: "0 * * * *"
          }
        ]
      }));
      const requests: unknown[] = [];
      const authHeaders: Array<string | null> = [];
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          directory,
          "--server",
          "https://siteflow.example.com",
          "--project",
          "docs",
          "--base-domain",
          "w33d.xyz",
          "--token",
          "secret-token",
          "--host-prefix",
          "abc123",
          "--json"
        ],
        io,
        {
          fetch: async (_input, init) => {
            authHeaders.push(new Headers(init?.headers).get("authorization"));
            requests.push(JSON.parse(init?.body?.toString() ?? "{}"));
            return new Response(
              JSON.stringify({
                deploymentId: "dep_prebuilt",
                projectId: "project_docs",
                projectSlug: "docs",
                previewHost: "abc123.w33d.xyz",
                previewUrl: "https://abc123.w33d.xyz",
                artifactRoot: "/var/lib/siteflow/artifacts/dep_prebuilt",
                fileCount: 1,
                totalBytes: 23,
                checksum: "abc"
              }),
              { status: 201, headers: { "content-type": "application/json" } }
            );
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result.previewUrl).toBe("https://abc123.w33d.xyz");
      expect(authHeaders).toEqual(["Bearer secret-token"]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        projectSlug: "docs",
        baseDomain: "w33d.xyz",
        requestedHostPrefix: "abc123",
        public: true,
        fluid: true,
        images: {
          sizes: [320, 640],
          qualities: [70, 80],
          formats: ["image/webp"],
          minimumCacheTTL: 120,
          dangerouslyAllowSVG: true,
          contentSecurityPolicy: "script-src 'none'; sandbox;",
          contentDispositionType: "inline"
        },
        routing: {
          redirects: [
            {
              source: "/docs",
              destination: "/documentation",
              statusCode: 308
            }
          ],
          rewrites: [
            {
              source: "/blog/:slug",
              destination: "/posts/:slug"
            }
          ],
          headers: [
            {
              source: "/(.*)",
              headers: [
                {
                  key: "x-frame-options",
                  value: "DENY"
                }
              ]
            }
          ],
          cleanUrls: true,
          trailingSlash: false,
          skipTrailingSlashRedirect: true
        },
        crons: [
          {
            path: "/api/revalidate",
            schedule: "0 * * * *"
          }
        ]
      });
      const uploadedFiles = (requests[0] as { files: Array<{ path: string; contentBase64: string; size: number }> }).files;
      const uploadedByPath = new Map(uploadedFiles.map((file) => [file.path, file]));

      expect(uploadedFiles).toEqual([
        expect.objectContaining({
          path: "index.html",
          size: 23
        }),
        expect.objectContaining({
          path: "index.html.br"
        }),
        expect.objectContaining({
          path: "index.html.gz"
        }),
        expect.objectContaining({
          path: "vercel.json"
        }),
        expect.objectContaining({
          path: "vercel.json.br"
        }),
        expect.objectContaining({
          path: "vercel.json.gz"
        })
      ]);
      expect(brotliDecompressSync(Buffer.from(uploadedByPath.get("index.html.br")?.contentBase64 ?? "", "base64")).toString("utf8"))
        .toBe("<h1>Hello SiteFlow</h1>");
      expect(gunzipSync(Buffer.from(uploadedByPath.get("index.html.gz")?.contentBase64 ?? "", "base64")).toString("utf8"))
        .toBe("<h1>Hello SiteFlow</h1>");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks prebuilt uploads before HTTP when the package exceeds the configured budget", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteflow-prebuilt-budget-"));
    let fetchCalls = 0;

    try {
      await writeFile(path.join(directory, "index.html"), "<h1>Hello SiteFlow</h1>");
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          directory,
          "--server",
          "https://siteflow.example.com",
          "--project",
          "docs",
          "--base-domain",
          "w33d.xyz",
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "4"
          },
          fetch: async () => {
            fetchCalls += 1;
            return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(1);
      expect(fetchCalls).toBe(0);
      expect(result).toMatchObject({
        status: "failed"
      });
      expect(result.message).toContain("SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets prebuilt deploy omit baseDomain when the server owns the wildcard domain", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteflow-prebuilt-default-domain-"));

    try {
      await writeFile(path.join(directory, "index.html"), "<h1>Hello Default Domain</h1>");
      const requests: Array<Record<string, unknown>> = [];
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          directory,
          "--server",
          "https://siteflow.example.com",
          "--project",
          "docs",
          "--token",
          "secret-token",
          "--host-prefix",
          "abc123",
          "--json"
        ],
        io,
        {
          fetch: async (_input, init) => {
            requests.push(JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                deploymentId: "dep_prebuilt",
                projectId: "project_docs",
                projectSlug: "docs",
                previewHost: "abc123.w33d.xyz",
                previewUrl: "https://abc123.w33d.xyz",
                artifactRoot: "/var/lib/siteflow/artifacts/dep_prebuilt",
                fileCount: 1,
                totalBytes: 29,
                checksum: "abc"
              }),
              { status: 201, headers: { "content-type": "application/json" } }
            );
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result.previewUrl).toBe("https://abc123.w33d.xyz");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        projectSlug: "docs",
        requestedHostPrefix: "abc123"
      });
      expect(Object.prototype.hasOwnProperty.call(requests[0], "baseDomain")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs in and stores the server-reported base domain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-login-server-domain-"));
    const configPath = path.join(root, "config.json");

    try {
      const seen = {
        url: "",
        authorization: ""
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "login",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "saved-token",
          "--config",
          configPath,
          "--json"
        ],
        io,
        {
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            return new Response(
              JSON.stringify({
                authenticated: true,
                authRequired: true,
                baseDomain: "w33d.xyz"
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
        }
      );

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/auth/verify");
      expect(seen.authorization).toBe("Bearer saved-token");
      expect(JSON.parse(output.stdout)).toMatchObject({
        status: "logged_in",
        baseDomain: "w33d.xyz"
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultServer: "https://siteflow.example.com",
        servers: {
          "https://siteflow.example.com": {
            token: "saved-token",
            baseDomain: "w33d.xyz"
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs in, stores config, and lets deploy reuse saved server settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-login-"));
    const configPath = path.join(root, "config.json");
    const site = path.join(root, "dist");

    try {
      await import("node:fs/promises").then((fs) => fs.mkdir(site, { recursive: true }));
      await writeFile(path.join(site, "index.html"), "<h1>Saved Config</h1>");

      const loginIo = createIo();
      const loginCode = await runSiteFlowCli(
        [
          "login",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "saved-token",
          "--base-domain",
          "w33d.xyz",
          "--config",
          configPath,
          "--json"
        ],
        loginIo.io,
        {
          fetch: async () => new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { "content-type": "application/json" } })
        }
      );

      expect(loginCode).toBe(0);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultServer: "https://siteflow.example.com",
        servers: {
          "https://siteflow.example.com": {
            token: "saved-token",
            baseDomain: "w33d.xyz"
          }
        }
      });

      const deployIo = createIo();
      const seen = {
        url: "",
        authorization: ""
      };
      const deployCode = await runSiteFlowCli(["deploy", "--prebuilt", site, "--project", "docs", "--config", configPath, "--json"], deployIo.io, {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              deploymentId: "dep_saved",
              projectId: "project_docs",
              projectSlug: "docs",
              previewHost: "saved.w33d.xyz",
              previewUrl: "https://saved.w33d.xyz",
              artifactRoot: "/var/lib/siteflow/artifacts/dep_saved",
              fileCount: 1,
              totalBytes: 21,
              checksum: "saved"
            }),
            { status: 201, headers: { "content-type": "application/json" } }
          );
        }
      });

      expect(deployCode).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/deployments/prebuilt");
      expect(seen.authorization).toBe("Bearer saved-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links the current directory to a project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-link-"));

    try {
      const seen = {
        url: "",
        authorization: ""
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "link",
          "--project",
          "project-acme-dashboard",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "secret-token",
          "--root",
          root,
          "--json"
        ],
        io,
        {
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            return new Response(JSON.stringify(projectSettingsResponse()), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );
      const result = JSON.parse(output.stdout);
      const storedLink = JSON.parse(await readFile(path.join(root, ".siteflow", "project.json"), "utf8"));

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/settings");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(result).toMatchObject({
        status: "linked",
        projectId: "project-acme-dashboard",
        projectSlug: "acme-dashboard",
        projectName: "Acme Dashboard",
        serverUrl: "https://siteflow.example.com"
      });
      expect(storedLink).toMatchObject({
        projectId: "project-acme-dashboard",
        projectSlug: "acme-dashboard",
        projectName: "Acme Dashboard",
        serverUrl: "https://siteflow.example.com"
      });
      expect(storedLink.linkedAt).toEqual(expect.any(String));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pulls metadata-only env placeholders from a linked project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-env-pull-"));

    try {
      await mkdir(path.join(root, ".siteflow"), { recursive: true });
      await writeFile(
        path.join(root, ".siteflow", "project.json"),
        `${JSON.stringify({
          projectId: "project-acme-dashboard",
          projectSlug: "acme-dashboard",
          projectName: "Acme Dashboard",
          serverUrl: "https://siteflow.example.com",
          linkedAt: "2026-05-25T12:00:00.000Z"
        })}\n`
      );

      const seen = {
        url: "",
        authorization: ""
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "env",
          "pull",
          "--root",
          root,
          "--output",
          ".env.local",
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_API_TOKEN: "secret-token"
          },
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            return new Response(JSON.stringify(projectSettingsResponse()), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );
      const result = JSON.parse(output.stdout);
      const envFile = await readFile(path.join(root, ".env.local"), "utf8");

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/settings");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(result).toMatchObject({
        status: "pulled",
        projectId: "project-acme-dashboard",
        targetEnvironment: "preview",
        variables: 1,
        metadataOnly: true
      });
      expect(envFile).toContain("# SiteFlow env pull writes metadata-only placeholders.");
      expect(envFile).toContain("# Secret values are not returned by the control plane.");
      expect(envFile).toContain("# Project: Acme Dashboard (project-acme-dashboard)");
      expect(envFile).toContain("# SITEFLOW_TOKEN scope=build source=sealed fingerprint=sha256:redacted");
      expect(envFile).toContain("# SITEFLOW_TOKEN=");
      expect(envFile).not.toContain("secret-token");
      expect(envFile).not.toContain("API_URL=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes a prebuilt deploy when --prod is requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-prod-deploy-"));
    const configPath = path.join(root, "config.json");
    const site = path.join(root, "dist");

    try {
      const evidencePath = await writeReleaseEvidence(root);

      await mkdir(site, { recursive: true });
      await writeFile(path.join(site, "index.html"), "<h1>Production</h1>");
      await writeFile(
        configPath,
        `${JSON.stringify({
          defaultServer: "https://siteflow.example.com",
          servers: {
            "https://siteflow.example.com": {
              token: "saved-token",
              baseDomain: "w33d.xyz"
            }
          }
        })}\n`
      );

      const calls: Array<{
        url: string;
        method?: string;
        authorization: string;
        body: Record<string, unknown>;
      }> = [];
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          site,
          "--project",
          "docs",
          "--prod",
          "--release-evidence",
          evidencePath,
          "--config",
          configPath,
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev",
            SITEFLOW_ACTOR_EMAIL: "dev@example.com"
          },
          releaseEvidence: releaseEvidenceDependencies(),
          fetch: async (input, init) => {
            calls.push({
              url: input.toString(),
              method: init?.method,
              authorization: new Headers(init?.headers).get("authorization") ?? "",
              body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
            });

            if (input.toString().endsWith("/api/deployments/prebuilt")) {
              return new Response(
                JSON.stringify({
                  deploymentId: "dep_prebuilt",
                  projectId: "project_docs",
                  projectSlug: "docs",
                  previewHost: "preview.w33d.xyz",
                  previewUrl: "https://preview.w33d.xyz",
                  artifactRoot: "/var/lib/siteflow/artifacts/dep_prebuilt",
                  fileCount: 1,
                  totalBytes: 19,
                  checksum: "prod"
                }),
                { status: 201, headers: { "content-type": "application/json" } }
              );
            }

            return new Response(
              JSON.stringify({
                ...acceptedPromotionResponse(),
                routeRevision: {
                  id: "route_promote",
                  status: "applied",
                  channel: "production",
                  deploymentId: "dep_prebuilt"
                }
              }),
              { status: 202, headers: { "content-type": "application/json" } }
            );
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        url: "https://siteflow.example.com/api/deployments/prebuilt",
        method: "POST",
        authorization: "Bearer saved-token",
        body: {
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          source: {
            repository: "acme/siteflow",
            branch: "main",
            commitSha: "abc123def456abc123def456abc123def456abcd7890"
          },
          releaseEvidence: {
            evidencePath,
            bundle: expect.objectContaining({
              schemaVersion: "siteflow.releaseEvidence.v1",
              name: "siteflow-release-evidence-bundle",
              targetEnvironment: "production"
            })
          }
        }
      });
      expect(calls[1]).toMatchObject({
        url: "https://siteflow.example.com/api/projects/project_docs/release/production/promote",
        method: "POST",
        authorization: "Bearer saved-token",
        body: {
          projectId: "project_docs",
          channel: "production",
          targetDeploymentId: "dep_prebuilt",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            email: "dev@example.com",
            role: "developer"
          },
          idempotencyKey: "promote:dep_prebuilt:production",
          dryRun: false,
          releaseEvidence: {
            evidencePath,
            bundle: expect.objectContaining({
              schemaVersion: "siteflow.releaseEvidence.v1",
              name: "siteflow-release-evidence-bundle",
              targetEnvironment: "production"
            })
          }
        }
      });
      expect(result).toMatchObject({
        deploymentId: "dep_prebuilt",
        production: {
          status: "accepted"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production prebuilt promotion before upload when release evidence is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-prod-deploy-blocked-"));
    const configPath = path.join(root, "config.json");
    const site = path.join(root, "dist");

    try {
      await mkdir(site, { recursive: true });
      await writeFile(path.join(site, "index.html"), "<h1>Production</h1>");
      await writeFile(
        configPath,
        `${JSON.stringify({
          defaultServer: "https://siteflow.example.com",
          servers: {
            "https://siteflow.example.com": {
              token: "saved-token",
              baseDomain: "w33d.xyz"
            }
          }
        })}\n`
      );

      const calls: string[] = [];
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          site,
          "--project",
          "docs",
          "--prod",
          "--config",
          configPath,
          "--json"
        ],
        io,
        {
          fetch: async (input) => {
            calls.push(input.toString());
            return new Response("{}", { status: 500 });
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(2);
      expect(calls).toEqual([]);
      expect(result).toMatchObject({
        status: "blocked",
        message: expect.stringContaining("--release-evidence")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes a deployment through the release API", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-promote-evidence-"));
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();

    try {
      const evidencePath = await writeReleaseEvidence(root);
      const code = await runSiteFlowCli(
        [
          "promote",
          "dep_123",
          "--project",
          "project-acme-dashboard",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "secret-token",
          "--reason",
          "ship",
          "--release-evidence",
          evidencePath,
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev",
            SITEFLOW_ACTOR_EMAIL: "dev@example.com"
          },
          releaseEvidence: releaseEvidenceDependencies(),
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
            return new Response(JSON.stringify(acceptedPromotionResponse()), {
              status: 202,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/release/production/promote");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(seen.body).toMatchObject({
        projectId: "project-acme-dashboard",
        channel: "production",
        targetDeploymentId: "dep_123",
        actor: {
          id: "user_1",
          name: "Acme Dev",
          email: "dev@example.com",
          role: "developer"
        },
        reason: "ship",
        idempotencyKey: "promote:dep_123:production",
        dryRun: false,
        releaseEvidence: {
          evidencePath,
          bundle: expect.objectContaining({
            schemaVersion: "siteflow.releaseEvidence.v1",
            name: "siteflow-release-evidence-bundle",
            targetEnvironment: "production"
          })
        }
      });
      expect(JSON.parse(output.stdout)).toMatchObject({
        status: "accepted"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production promotion when release evidence is missing", async () => {
    const seen: string[] = [];
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "promote",
        "dep_123",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--json"
      ],
      io,
      {
        fetch: async (input) => {
          seen.push(input.toString());
          return new Response("{}", { status: 500 });
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(seen).toEqual([]);
    expect(result).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("--release-evidence")
    });
  });

  it("blocks production promotion dry-run when release evidence is missing", async () => {
    const seen: string[] = [];
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "promote",
        "dep_123",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--dry-run",
        "--json"
      ],
      io,
      {
        fetch: async (input) => {
          seen.push(input.toString());
          return new Response("{}", { status: 500 });
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(seen).toEqual([]);
    expect(result).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("--release-evidence")
    });
  });

  it("rolls a release channel back to a known deployment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-rollback-evidence-"));
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();

    try {
      const evidencePath = await writeReleaseEvidence(root);
      const code = await runSiteFlowCli(
        [
          "rollback",
          "dep_123",
          "--project",
          "project-acme-dashboard",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "secret-token",
          "--current-deployment",
          "dep_current",
          "--release-evidence",
          evidencePath,
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev"
          },
          releaseEvidence: releaseEvidenceDependencies(),
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
            return new Response(
              JSON.stringify({
                ...acceptedPromotionResponse(),
                message: "Rollback route applied."
              }),
              { status: 202, headers: { "content-type": "application/json" } }
            );
          }
        }
      );

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/rollback/production/rollback");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(seen.body).toMatchObject({
        projectId: "project-acme-dashboard",
        channel: "production",
        targetDeploymentId: "dep_123",
        currentDeploymentId: "dep_current",
        actor: {
          id: "user_1",
          name: "Acme Dev",
          role: "developer"
        },
        idempotencyKey: "rollback:dep_123:production",
        dryRun: false,
        releaseEvidence: {
          evidencePath,
          bundle: expect.objectContaining({
            schemaVersion: "siteflow.releaseEvidence.v1",
            name: "siteflow-release-evidence-bundle",
            targetEnvironment: "production"
          })
        }
      });
      expect(JSON.parse(output.stdout)).toMatchObject({
        status: "accepted"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production rollback when release evidence is missing", async () => {
    const seen: string[] = [];
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "rollback",
        "dep_123",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--json"
      ],
      io,
      {
        fetch: async (input) => {
          seen.push(input.toString());
          return new Response("{}", { status: 500 });
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(seen).toEqual([]);
    expect(result).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("--release-evidence")
    });
  });

  it("creates a deploy hook for a linked project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-hook-create-"));

    try {
      await mkdir(path.join(root, ".siteflow"), { recursive: true });
      await writeFile(
        path.join(root, ".siteflow", "project.json"),
        `${JSON.stringify({
          projectId: "project-acme-dashboard",
          projectSlug: "acme-dashboard",
          projectName: "Acme Dashboard",
          serverUrl: "https://siteflow.example.com",
          linkedAt: "2026-05-25T12:00:00.000Z"
        })}\n`
      );

      const seen = {
        url: "",
        authorization: "",
        body: {} as Record<string, unknown>
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy-hook",
          "create",
          "CMS rebuild",
          "--root",
          root,
          "--branch",
          "main",
          "--environment",
          "preview",
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_API_TOKEN: "secret-token",
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev"
          },
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
            return new Response(JSON.stringify(deployHookCreateResponse()), {
              status: 201,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/deploy-hooks");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(seen.body).toMatchObject({
        projectId: "project-acme-dashboard",
        name: "CMS rebuild",
        branch: "main",
        targetEnvironment: "preview",
        actor: {
          id: "user_1",
          name: "Acme Dev",
          role: "developer"
        }
      });
      expect(result).toMatchObject({
        status: "created",
        token: "sfh_test_token",
        hookUrl: "https://siteflow.example.com/api/deploy-hooks/sfh_test_token/trigger",
        hook: {
          id: "hook_preview",
          projectId: "project-acme-dashboard"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists deploy hooks without exposing full hook tokens", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "deploy-hook",
        "list",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(JSON.stringify(deployHookListResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );
    const result = JSON.parse(output.stdout);
    const serialized = JSON.stringify(result);

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/deploy-hooks");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(result).toMatchObject({
      total: 1,
      hooks: [
        {
          id: "hook_preview",
          tokenPrefix: "sfh_test_tok"
        }
      ]
    });
    expect(serialized).not.toContain("sfh_test_token");
  });

  it("revokes a deploy hook through the management API", async () => {
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "deploy-hook",
        "revoke",
        "hook_preview",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--reason",
        "rotated",
        "--json"
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
          return new Response(JSON.stringify(deployHookRevokeResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/deploy-hooks/hook_preview");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(seen.body).toMatchObject({
      projectId: "project-acme-dashboard",
      hookId: "hook_preview",
      reason: "rotated",
      actor: {
        id: "user_1",
        name: "Acme Dev",
        role: "developer"
      }
    });
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "revoked",
      hook: {
        id: "hook_preview",
        status: "revoked"
      }
    });
  });

  it("starts a rolling release through the management API", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-rolling-evidence-"));
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();

    try {
      const evidencePath = await writeReleaseEvidence(root);
      const code = await runSiteFlowCli(
        [
          "rolling",
          "start",
          "dep-canary",
          "--project",
          "project-acme-dashboard",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "secret-token",
          "--percentage",
          "10",
          "--release-evidence",
          evidencePath,
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev"
          },
          releaseEvidence: releaseEvidenceDependencies(),
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
            return new Response(JSON.stringify(rollingCommandResponse(10)), {
              status: 202,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/start");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(seen.body).toMatchObject({
        projectId: "project-acme-dashboard",
        channel: "production",
        candidateDeploymentId: "dep-canary",
        percentage: 10,
        idempotencyKey: "rolling:start:dep-canary:production",
        actor: {
          id: "user_1",
          name: "Acme Dev",
          role: "developer"
        },
        releaseEvidence: {
          evidencePath,
          bundle: expect.objectContaining({
            schemaVersion: "siteflow.releaseEvidence.v1",
            name: "siteflow-release-evidence-bundle",
            targetEnvironment: "production"
          })
        }
      });
      expect(JSON.parse(output.stdout)).toMatchObject({
        status: "accepted",
        rollout: {
          id: "rollout_preview",
          percentage: 10
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production rolling release when release evidence is missing", async () => {
    const seen: string[] = [];
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "rolling",
        "start",
        "dep-canary",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--percentage",
        "10",
        "--json"
      ],
      io,
      {
        fetch: async (input) => {
          seen.push(input.toString());
          return new Response("{}", { status: 500 });
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(seen).toEqual([]);
    expect(result).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("--release-evidence")
    });
  });

  it("advances, completes, and aborts rolling releases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-rolling-evidence-"));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { io } = createIo();

    try {
      const evidencePath = await writeReleaseEvidence(root);
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: input.toString(),
          body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
        });
        const action = input.toString().split("/").pop();
        const response = action === "complete"
          ? rollingCommandResponse(100, "completed")
          : action === "abort"
            ? rollingCommandResponse(25, "aborted")
            : rollingCommandResponse(50);

        return new Response(JSON.stringify(response), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      };
      const common = [
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--json"
      ];
      const productionEvidence = ["--release-evidence", evidencePath];
      const cliDependencies = {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        releaseEvidence: releaseEvidenceDependencies(),
        fetch
      };
      const advanceCode = await runSiteFlowCli(["rolling", "advance", "--percentage", "50", ...productionEvidence, ...common], io, cliDependencies);
      const completeCode = await runSiteFlowCli(["rolling", "complete", ...productionEvidence, ...common], io, cliDependencies);
      const abortCode = await runSiteFlowCli(["rolling", "abort", "--reason", "stop canary", ...common], io, {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch
      });

      expect([advanceCode, completeCode, abortCode]).toEqual([0, 0, 0]);
      expect(requests).toEqual([
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/advance",
          body: expect.objectContaining({
            percentage: 50,
            idempotencyKey: "rolling:advance:active:production",
            releaseEvidence: expect.objectContaining({
              evidencePath,
              bundle: expect.objectContaining({
                schemaVersion: "siteflow.releaseEvidence.v1",
                targetEnvironment: "production"
              })
            })
          })
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/complete",
          body: expect.objectContaining({
            idempotencyKey: "rolling:complete:active:production",
            releaseEvidence: expect.objectContaining({
              evidencePath,
              bundle: expect.objectContaining({
                schemaVersion: "siteflow.releaseEvidence.v1",
                targetEnvironment: "production"
              })
            })
          })
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/abort",
          body: expect.objectContaining({
            reason: "stop canary",
            idempotencyKey: "rolling:abort:active:production",
            releaseEvidenceException: {
              type: "production_rolling_abort_stop_rollout",
              targetEnvironment: "production",
              acceptedWithoutReleaseEvidence: true,
              reason: "stop canary"
            }
          })
        }
      ]);
      expect(requests[2].body).not.toHaveProperty("releaseEvidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production rolling abort without an explicit audit reason", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const code = await runSiteFlowCli([
      "rolling",
      "abort",
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ], io, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: input.toString(),
          body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
        });
        return new Response(JSON.stringify(rollingCommandResponse(25, "aborted")), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const result = JSON.parse(output.stdout);

    expect(code).toBe(2);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("--reason")
    });
  });

  it("creates and lists cron jobs through the management API", async () => {
    const requests: Array<{ url: string; authorization: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "cron",
        "create",
        "Revalidate homepage",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--path",
        "/api/revalidate",
        "--schedule",
        "0 * * * *",
        "--json"
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch: async (input, init) => {
          requests.push({
            url: input.toString(),
            authorization: new Headers(init?.headers).get("authorization") ?? "",
            body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
          });
          return new Response(JSON.stringify(cronJobCreateResponse()), {
            status: 201,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );
    const listCode = await runSiteFlowCli(
      [
        "cron",
        "list",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          requests.push({
            url: input.toString(),
            authorization: new Headers(init?.headers).get("authorization") ?? ""
          });
          return new Response(JSON.stringify(cronJobListResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect([code, listCode]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs",
        authorization: "Bearer secret-token",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Revalidate homepage",
          path: "/api/revalidate",
          schedule: "0 * * * *",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs",
        authorization: "Bearer secret-token"
      }
    ]);
    expect(JSON.parse(output.stdout.split("\n}\n")[0] + "\n}")).toMatchObject({
      status: "created",
      job: {
        id: "cron_revalidate"
      }
    });
  });

  it("runs and disables cron jobs through the management API", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { io } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
      });
      const response = input.toString().endsWith("/run") ? cronJobRunResponse() : cronJobDisableResponse();

      return new Response(JSON.stringify(response), {
        status: input.toString().endsWith("/run") ? 202 : 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];
    const runCode = await runSiteFlowCli(["cron", "run", "cron_revalidate", "--reason", "manual", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const disableCode = await runSiteFlowCli(["cron", "disable", "cron_revalidate", "--reason", "pause", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([runCode, disableCode]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate/run",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          jobId: "cron_revalidate",
          reason: "manual",
          idempotencyKey: "cron:run:cron_revalidate:project-acme-dashboard"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          jobId: "cron_revalidate",
          reason: "pause"
        })
      }
    ]);
  });

  it("queries project logs through the observability API", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "logs",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--source",
        "build",
        "--severity",
        "warning",
        "--search",
        "deploy",
        "--limit",
        "25",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(JSON.stringify(logQueryResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/logs?source=build&severity=warning&search=deploy&limit=25");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(JSON.parse(output.stdout)).toMatchObject({
      total: 1,
      entries: [
        {
          source: "build",
          severity: "warning"
        }
      ]
    });
  });

  it("creates, lists, and delivers log drains through the management API", async () => {
    const requests: Array<{ url: string; authorization: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });
      const url = input.toString();
      const response = url.endsWith("/deliver")
        ? logDrainDeliveryResponse()
        : init?.method === "POST"
          ? logDrainCreateResponse()
          : logDrainListResponse();

      return new Response(JSON.stringify(response), {
        status: init?.method === "POST" ? 202 : 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];
    const createCode = await runSiteFlowCli(
      [
        "log-drain",
        "create",
        "Datadog",
        "--url",
        "https://logs.example.test/siteflow",
        "--sources",
        "build,function",
        "--severity",
        "warning",
        "--signing-secret",
        "sfd_super_secret",
        ...common
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch
      }
    );
    const listCode = await runSiteFlowCli(["log-drain", "list", ...common], io, { fetch });
    const deliverCode = await runSiteFlowCli(["log-drain", "deliver", "drain_datadog", "--reason", "manual", ...common], io, { fetch });
    const serialized = output.stdout;

    expect([createCode, listCode, deliverCode]).toEqual([0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains",
        authorization: "Bearer secret-token",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Datadog",
          url: "https://logs.example.test/siteflow",
          sources: ["build", "function"],
          minimumSeverity: "warning",
          signingSecret: "sfd_super_secret",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains",
        authorization: "Bearer secret-token",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains/drain_datadog/deliver",
        authorization: "Bearer secret-token",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          drainId: "drain_datadog",
          reason: "manual"
        })
      }
    ]);
    expect(serialized).toContain("drain_datadog");
    expect(serialized).not.toContain("sfd_super_secret");
  });

  it("lists audit events and manages scoped API tokens", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });

      if (url.endsWith("/api-tokens") && init?.method === "POST") {
        return new Response(JSON.stringify({
          status: "created",
          token: {
            id: "token_created",
            projectId: "project-acme-dashboard",
            name: "CI deploy",
            tokenPrefix: "sft_created",
            scopes: ["read", "write"],
            status: "active",
            createdAt: "2026-05-26T00:00:00.000Z",
            updatedAt: "2026-05-26T00:00:00.000Z"
          },
          secret: "sft_created_secret",
          message: "API token created."
        }), { status: 201, headers: { "content-type": "application/json" } });
      }

      if (url.includes("/api-tokens/token_ci") && init?.method === "DELETE") {
        return new Response(JSON.stringify({
          status: "revoked",
          token: {
            ...projectSettingsResponse().apiTokens[0],
            status: "revoked",
            revokedAt: "2026-05-26T00:01:00.000Z"
          },
          message: "API token revoked."
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response(JSON.stringify(projectSettingsResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const auditCode = await runSiteFlowCli(["audit", "list", ...common], io, { fetch });
    const listCode = await runSiteFlowCli(["api-token", "list", ...common], io, { fetch });
    const createCode = await runSiteFlowCli(["api-token", "create", "CI deploy", "--scopes", "read,write", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const revokeCode = await runSiteFlowCli(["api-token", "revoke", "token_ci", "--reason", "rotated", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([auditCode, listCode, createCode, revokeCode]).toEqual([0, 0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/api-tokens",
        authorization: "Bearer secret-token",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "CI deploy",
          scopes: ["read", "write"],
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/api-tokens/token_ci",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          tokenId: "token_ci",
          reason: "rotated"
        })
      }
    ]);
    expect(output.stdout).toContain("auditEvents");
    expect(output.stdout).toContain("apiTokens");
    expect(output.stdout).toContain("token_created");
    expect(output.stdout).toContain("token_ci");
  });

  it("manages firewall rules and Edge Config through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });

      if (url.endsWith("/firewall-rules") && init?.method === "POST") {
        return new Response(JSON.stringify(firewallRuleCreateResponse()), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.includes("/firewall-rules/fw_block_admin") && init?.method === "DELETE") {
        return new Response(JSON.stringify(firewallRuleDisableResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/edge-config/maintenance") && init?.method === "PUT") {
        return new Response(JSON.stringify(edgeConfigUpsertResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/edge-config/maintenance") && init?.method === "DELETE") {
        return new Response(JSON.stringify(edgeConfigDeleteResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/firewall-rules")) {
        return new Response(JSON.stringify(firewallRuleListResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(edgeConfigResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const firewallCreate = await runSiteFlowCli(
      [
        "firewall",
        "create",
        "Block admin",
        "--action",
        "block",
        "--path",
        "/admin/*",
        "--ip",
        "203.0.113.*",
        "--header",
        "x-plan=free",
        "--user-agent",
        "curl",
        "--priority",
        "10",
        ...common
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch
      }
    );
    const firewallList = await runSiteFlowCli(["firewall", "list", ...common], io, { fetch });
    const firewallDisable = await runSiteFlowCli(["firewall", "disable", "fw_block_admin", "--reason", "rotated", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const edgeList = await runSiteFlowCli(["edge-config", "list", ...common], io, { fetch });
    const edgeSet = await runSiteFlowCli(["edge-config", "set", "maintenance", "{\"enabled\":true}", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const edgeDelete = await runSiteFlowCli(["edge-config", "delete", "maintenance", "--reason", "cleanup", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([firewallCreate, firewallList, firewallDisable, edgeList, edgeSet, edgeDelete]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules",
        authorization: "Bearer secret-token",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Block admin",
          action: "block",
          priority: 10,
          conditions: {
            ipRanges: ["203.0.113.*"],
            pathPattern: "/admin/*",
            header: {
              name: "x-plan",
              value: "free"
            },
            userAgent: "curl"
          },
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules/fw_block_admin",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          ruleId: "fw_block_admin",
          reason: "rotated"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config/maintenance",
        authorization: "Bearer secret-token",
        method: "PUT",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          key: "maintenance",
          value: {
            enabled: true
          },
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config/maintenance",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          key: "maintenance",
          reason: "cleanup"
        })
      }
    ]);
    expect(output.stdout).toContain("fw_block_admin");
    expect(output.stdout).toContain("maintenance");
  });

  it("manages blobs through project APIs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-blob-cli-"));

    try {
      const localPath = path.join(root, "config.json");
      const outputPath = path.join(root, "download", "config.json");
      await writeFile(localPath, "{\"enabled\":true}");

      const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
      const { io, output } = createIo();
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
        });

        if (url.endsWith("/blobs") && init?.method === "POST") {
          return new Response(JSON.stringify(blobPutResponse()), {
            status: 201,
            headers: { "content-type": "application/json" }
          });
        }

        if (url.includes("/blobs/assets%2Fconfig%2Fapp.json") && init?.method === "DELETE") {
          return new Response(JSON.stringify(blobDeleteResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (url.includes("/blobs/assets%2Fconfig%2Fapp.json")) {
          return new Response(JSON.stringify(blobReadResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        return new Response(JSON.stringify(blobListResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };
      const common = [
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--root",
        root,
        "--json"
      ];

      const put = await runSiteFlowCli(
        [
          "blob",
          "put",
          "config.json",
          "--pathname",
          "assets/config/app.json",
          "--content-type",
          "application/json",
          "--access",
          "private",
          "--cache-max-age",
          "120",
          ...common
        ],
        io,
        {
          env: {
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev"
          },
          fetch
        }
      );
      const list = await runSiteFlowCli(["blob", "list", "--prefix", "assets/", ...common], io, { fetch });
      const get = await runSiteFlowCli(["blob", "get", "assets/config/app.json", "--output", "download/config.json", ...common], io, {
        fetch
      });
      const deleted = await runSiteFlowCli(["blob", "delete", "assets/config/app.json", "--reason", "cleanup", ...common], io, {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch
      });

      expect([put, list, get, deleted]).toEqual([0, 0, 0, 0]);
      expect(await readFile(outputPath, "utf8")).toBe("{\"enabled\":true}");
      expect(requests).toEqual([
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs",
          authorization: "Bearer secret-token",
          method: "POST",
          body: expect.objectContaining({
            projectId: "project-acme-dashboard",
            pathname: "assets/config/app.json",
            contentBase64: Buffer.from("{\"enabled\":true}", "utf8").toString("base64"),
            contentType: "application/json",
            access: "private",
            cacheControlMaxAge: 120,
            actor: {
              id: "user_1",
              name: "Acme Dev",
              role: "developer"
            }
          })
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs?prefix=assets%2F",
          authorization: "Bearer secret-token",
          method: "GET",
          body: undefined
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs/assets%2Fconfig%2Fapp.json",
          authorization: "Bearer secret-token",
          method: "GET",
          body: undefined
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs/assets%2Fconfig%2Fapp.json",
          authorization: "Bearer secret-token",
          method: "DELETE",
          body: expect.objectContaining({
            projectId: "project-acme-dashboard",
            pathname: "assets/config/app.json",
            reason: "cleanup"
          })
        }
      ]);
      expect(output.stdout).toContain("assets/config/app.json");
      expect(output.stdout).toContain("downloaded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inspects and purges cache through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });

      if (url.endsWith("/cache/purge")) {
        return new Response(JSON.stringify(cachePurgeResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(cacheListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const list = await runSiteFlowCli(["cache", "list", "--tag", "marketing", "--status", "stale", ...common], io, { fetch });
    const purge = await runSiteFlowCli(["cache", "purge", "--tag", "marketing", "--reason", "content update", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([list, purge]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cache?tag=marketing&status=stale",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cache/purge",
        authorization: "Bearer secret-token",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          tag: "marketing",
          reason: "content update",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      }
    ]);
    expect(output.stdout).toContain("entries");
    expect(output.stdout).toContain("purged");
  });

  it("inspects deployed function runtime controls through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET"
      });

      if (url.includes("/functions/%2Fapi%2Frevalidate")) {
        return new Response(JSON.stringify(functionRuntimeResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(functionListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--deployment",
      "dep_function",
      "--json"
    ];

    const list = await runSiteFlowCli(["functions", "list", ...common], io, { fetch });
    const inspect = await runSiteFlowCli(["functions", "inspect", "/api/revalidate", "--limit", "1", ...common], io, { fetch });

    expect([list, inspect]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/functions?deploymentId=dep_function",
        authorization: "Bearer secret-token",
        method: "GET"
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/functions/%2Fapi%2Frevalidate?deploymentId=dep_function&limit=1",
        authorization: "Bearer secret-token",
        method: "GET"
      }
    ]);
    expect(output.stdout).toContain("/api/revalidate");
    expect(output.stdout).toContain("recentInvocations");
  });

  it("manages routing rules through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: unknown }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) : undefined
      });

      if (init?.method === "PUT") {
        return new Response(JSON.stringify(routingRuleUpsertResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (init?.method === "DELETE") {
        return new Response(JSON.stringify(routingRuleDisableResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(routingRuleListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const list = await runSiteFlowCli(["routing-rules", "list", "--kind", "redirect", ...common], io, { fetch });
    const upsert = await runSiteFlowCli([
      "routing-rules",
      "upsert",
      "Docs redirect",
      "--kind",
      "redirect",
      "--source",
      "/docs",
      "--destination",
      "/documentation",
      "--status-code",
      "308",
      "--priority",
      "10",
      ...common
    ], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const disable = await runSiteFlowCli(["routing-rules", "disable", "route_docs", "--reason", "cleanup", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([list, upsert, disable]).toEqual([0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules?kind=redirect",
        authorization: "Bearer secret-token",
        method: "GET"
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules",
        authorization: "Bearer secret-token",
        method: "PUT",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Docs redirect",
          kind: "redirect",
          source: "/docs",
          destination: "/documentation",
          statusCode: 308,
          priority: 10
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules/route_docs",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          ruleId: "route_docs",
          reason: "cleanup"
        })
      }
    ]);
    expect(output.stdout).toContain("route_docs");
    expect(output.stdout).toContain("disabled");
  });

  it("lists deployments from the management API", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "deployments",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--project",
        "project-acme-dashboard",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              deployments: [
                {
                  id: "dep_123",
                  projectId: "project-acme-dashboard",
                  projectName: "Acme Dashboard",
                  version: "2026.05.25.1200",
                  commitSha: "4f3a9c2d1b0e",
                  branch: "main",
                  status: "ready",
                  routeRevisionStatus: "applied",
                  createdAt: "2026-05-25T12:00:00.000Z"
                }
              ],
              total: 1,
              projectId: "project-acme-dashboard",
              updatedAt: "2026-05-25T12:01:00.000Z"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/deployments?projectId=project-acme-dashboard");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(result).toMatchObject({
      total: 1,
      deployments: [
        {
          id: "dep_123",
          status: "ready",
          routeRevisionStatus: "applied"
        }
      ]
    });
  });

  it("inspects a deployment and prints source, artifact, and route evidence", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "inspect",
        "dep_123",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              project: {
                name: "Acme Dashboard"
              },
              deployment: {
                id: "dep_123",
                status: "ready",
                environment: "production",
                version: "2026.05.25.1200",
                readyAt: "2026-05-25T12:00:00.000Z"
              },
              lineage: {
                sourceEvent: {
                  branch: "main",
                  commitSha: "4f3a9c2d1b0e"
                },
                buildJob: {
                  status: "succeeded"
                },
                artifact: {
                  verificationStatus: "verified",
                  manifest: {
                    fileCount: 128,
                    totalBytes: 4821108,
                    checksum: "sha256:abc"
                  }
                },
                routeRevision: {
                  id: "route_123",
                  status: "applied",
                  releaseEvidence: {
                    evidencePath: "evidence/release-evidence.json",
                    checkedAt: "2026-06-08T12:00:00.000Z",
                    status: "passed",
                    commitRef: "abc123def456abc123def456abc123def456abcd7890",
                    repository: "acme/siteflow",
                    branch: "main",
                    targetEnvironment: "production",
                    releaseTicket: "REL-2026-0608",
                    operatorName: "release-operator"
                  }
                }
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/deployments/dep_123");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(output.stdout).toContain("Deployment dep_123");
    expect(output.stdout).toContain("Source:     main@4f3a9c2d");
    expect(output.stdout).toContain("Route:      route_123 / applied");
    expect(output.stdout).toContain("Evidence:   passed / acme/siteflow@main@abc123de / evidence/release-evidence.json");
  });
});
