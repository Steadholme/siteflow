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
  "      - run: npm test -- --run",
  "      - run: npm run build",
  "      - run: npm run --silent release:artifacts:check -- --json",
  "      - run: npm run test:e2e",
  "      - run: npm run siteflow -- release-gate --allow-dirty --allow-manual-branch-protection"
].join("\n");

const requiredReleasePreflightEvidenceInputs = [
  "direct_api_url",
  "release_image_run_id",
  "trust_proxy_policy",
  "api_instance_count",
  "api_process_count",
  "ingress_count",
  "api_rate_limit_scope",
  "api_rate_limit_enforcement_point"
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
  "        run: npm run --silent release:evidence:target-run -- --pack evidence/release-evidence-rehearsal-pack.json --confirm-target-environment production --run-record evidence/release-evidence-target-run.json --gap-report-dir evidence/gap-reports --set-env direct-api-url=SITEFLOW_DIRECT_API_URL --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT --set-env ingress-count=SITEFLOW_INGRESS_COUNT --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT --json",
  "      - run: npm run --silent release:evidence:gaps -- --pack evidence/release-evidence-rehearsal-pack.json --set-env direct-api-url=SITEFLOW_DIRECT_API_URL --set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID --set-env SITEFLOW_TRUST_PROXY=SITEFLOW_TRUST_PROXY --set-env api-instance-count=SITEFLOW_API_INSTANCE_COUNT --set-env api-process-count=SITEFLOW_API_PROCESS_COUNT --set-env ingress-count=SITEFLOW_INGRESS_COUNT --set-env api-rate-limit-scope=SITEFLOW_API_RATE_LIMIT_SCOPE --set-env api-rate-limit-enforcement-point=SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT --json",
  "      - run: rm -f \"$SITEFLOW_TARGET_ENV_FILE\"",
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          name: release-preflight",
  "          path: |",
  "            $RUNNER_TEMP/siteflow-release-preflight/**",
  "            playwright-report/**",
  "            test-results/**"
].join("\n");

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

const cleanRunner: ReleaseGateCommandRunner = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: ""
});

const pinnedBuildImage = "node:20-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const strongApiToken = "siteflow-api-token-0123456789abcdef";
const strongAppSecret = "siteflow-app-secret-0123456789abcdef";
const strongMetricsToken = "siteflow-metrics-token-0123456789abcdef";

const validProductionEnv = {
  SITEFLOW_ENV: "production",
  DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow",
  SITEFLOW_API_PORT: "8787",
  SITEFLOW_ARTIFACT_ROOT: "/var/lib/siteflow/artifacts",
  SITEFLOW_PUBLIC_SCHEME: "https",
  SITEFLOW_API_TOKEN: strongApiToken,
  SITEFLOW_APP_SECRET: strongAppSecret,
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
  SITEFLOW_BUILD_NETWORK: "none"
};

async function createReleaseRoot(options: {
  ci?: boolean;
  releasePreflight?: boolean;
  docs?: boolean;
  compose?: boolean;
  deploymentDoc?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gate-"));

  if (options.ci !== false || options.releasePreflight !== false) {
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  }

  if (options.ci !== false) {
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), validCiWorkflow);
  }

  if (options.releasePreflight !== false) {
    await writeFile(path.join(root, ".github", "workflows", "release-preflight.yml"), validReleasePreflightWorkflow);
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
      "API prebuilt upload limit",
      "      SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: 536870912\n",
      "api SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES:"
    ],
    [
      "API readiness healthcheck",
      "      test: fetch /readyz\n",
      "api /readyz"
    ],
    [
      "worker Docker socket group override",
      "    group_add:\n      - \"${SITEFLOW_DOCKER_SOCKET_GID:-0}\"\n",
      "worker group_add:"
    ],
    [
      "worker build artifact file limit",
      "      SITEFLOW_BUILD_MAX_ARTIFACT_FILES: 20000\n",
      "worker SITEFLOW_BUILD_MAX_ARTIFACT_FILES:"
    ],
    [
      "API Postgres password file",
      "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password\n",
      "api SITEFLOW_POSTGRES_PASSWORD_FILE:"
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
      "postgres password secret mount",
      "      - siteflow_postgres_password\n    healthcheck:",
      "postgres secret siteflow_postgres_password"
    ],
    [
      "API token secret mount",
      "      - siteflow_api_token\n",
      "api secret siteflow_api_token"
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

  it("passes promotion when the exact release commit has the required GitHub check run", async () => {
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

      if (/\/branches\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({
          commit: { sha: "abc123def456abc123def456abc123def456abcd" }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify({
        total_count: 1,
        check_runs: [
          {
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.example.test/checks/1"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: "abc123def456abc123def456abc123def456abcd",
        promotion: true,
        runner: cleanRunner,
        fetch
      });

      expect(report.status).toBe("pass");
      expect(requests).toEqual([
        "https://api.github.com/repos/acme/siteflow/branches/main/protection/required_status_checks",
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
          requiredStatusChecks: ["Install, test, and build"]
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
          buildNetwork: "none"
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
        total_count: 1,
        check_runs: [
          {
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.example.test/checks/1"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        allowDirty: true,
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
        total_count: 1,
        check_runs: [
          {
            name: "Install, test, and build",
            status: "completed",
            conclusion: "failure"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
          buildNetwork: "none"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails promotion runtime env when metrics token is missing", async () => {
    const root = await createReleaseRoot();
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

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
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
        buildNetworkStatus: "pass",
        buildNetwork: "none"
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
    await writeFile(path.join(secretsDir, "app-secret.secret"), `${strongAppSecret}\n`);
    await writeFile(path.join(secretsDir, "postgres-password.secret"), "postgres-secret\n");

    await writeFile(path.join(root, envFile), [
      "SITEFLOW_ENV=production",
      "DATABASE_URL=postgres://siteflow@localhost:5432/siteflow",
      "SITEFLOW_API_PORT=8787",
      "SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts",
      "SITEFLOW_PUBLIC_SCHEME=https",
      "SITEFLOW_API_TOKEN_FILE=release-secrets/api-token.secret",
      "SITEFLOW_APP_SECRET_FILE=release-secrets/app-secret.secret",
      "SITEFLOW_METRICS_TOKEN_FILE=release-secrets/metrics-token.secret",
      "SITEFLOW_POSTGRES_PASSWORD_FILE=release-secrets/postgres-password.secret",
      "SITEFLOW_BUILD_RUNNER=docker",
      `SITEFLOW_BUILD_IMAGE=${pinnedBuildImage}`,
      "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912",
      "SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000",
      "SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824",
      "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912",
      "SITEFLOW_PREBUILT_MAX_FILES=20000",
      "SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000",
      "SITEFLOW_GIT_TIMEOUT_MS=300000",
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
        appSecretStrengthStatus: "pass",
        appSecretSource: "SITEFLOW_APP_SECRET_FILE",
        postgresPasswordStatus: "pass",
        postgresPasswordSource: "SITEFLOW_POSTGRES_PASSWORD_FILE"
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

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
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK: "1",
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

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
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

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
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const report = await runReleaseGate({
        root,
        env: {
          ...validProductionEnv,
          SITEFLOW_BUILD_IMAGE: "node:20-bookworm-slim",
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "acme/siteflow"
        },
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
    const fetch: ReleaseGateFetch = async (input) => {
      const url = input.toString();

      if (url.includes("/required_status_checks")) {
        return new Response(JSON.stringify({
          contexts: ["Install, test, and build"],
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
            name: "Install, test, and build",
            status: "completed",
            conclusion: "success"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

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
        commitSha: "abc123def456abc123def456abc123def456abcd",
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
