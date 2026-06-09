import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  collectReleaseTargetRuntimeEvidence,
  parseReleaseTargetRuntimeEvidenceCollectArgs,
  runReleaseTargetRuntimeEvidenceCollectCli,
  type ReleaseTargetRuntimeEvidenceExecFile,
  type ReleaseTargetRuntimeEvidenceFetch
} from "./releaseTargetRuntimeEvidenceCollect";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const checkedAt = "2026-06-08T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const postgresImage = `postgres@sha256:${"b".repeat(64)}`;
const releaseImage = `ghcr.io/siteflow/siteflow@${digest}`;
const imageId = `sha256:${"c".repeat(64)}`;

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function makeFetch(options: { publicReady?: boolean; loopbackReady?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl: ReleaseTargetRuntimeEvidenceFetch = async (input) => {
    calls.push(input);
    const ready = input.startsWith("http://127.0.0.1")
      ? options.loopbackReady !== false
      : options.publicReady !== false;

    return jsonResponse(ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
  };

  return { fetchImpl, calls };
}

function composeConfigJson() {
  return JSON.stringify({
    services: {
      postgres: {
        image: postgresImage,
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready"]
        }
      },
      api: {
        image: releaseImage,
        user: "1000:1000",
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        healthcheck: {
          test: ["CMD-SHELL", "node -e fetch('/readyz')"]
        }
      },
      worker: {
        image: releaseImage,
        user: "1000:1000",
        group_add: ["998"],
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        environment: {
          SITEFLOW_BUILD_RUNNER: "docker",
          SITEFLOW_BUILD_NETWORK: "none",
          SITEFLOW_BUILD_MEMORY: "1g",
          SITEFLOW_BUILD_CPUS: "2",
          SITEFLOW_BUILD_PIDS_LIMIT: "256",
          SITEFLOW_GIT_SSH_KEY_PATH: "${SITEFLOW_GIT_SSH_KEY_PATH:-}",
          SITEFLOW_GIT_KNOWN_HOSTS_PATH: "${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}"
        },
        command: [
          "sh",
          "-ec",
          "if ! command -v docker >/dev/null 2>&1; then exit 1; fi\nif ! docker info >/dev/null 2>&1; then exit 1; fi\nexec node dist-worker/worker/index.js"
        ],
        healthcheck: {
          test: ["CMD", "node", "dist-worker/worker/index.js", "--healthcheck"]
        },
        volumes: [
          {
            type: "bind",
            source: "/var/run/docker.sock",
            target: "/var/run/docker.sock"
          }
        ]
      }
    },
    secrets: {
      siteflow_app_secret: {},
      siteflow_api_token: {},
      siteflow_metrics_token: {},
      siteflow_release_evidence_signing_key: {},
      siteflow_postgres_password: {}
    }
  });
}

function psJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      Service: "postgres",
      ID: "siteflow-postgres-1",
      State: "running",
      Health: "healthy",
      Image: postgresImage
    },
    {
      Service: "api",
      ID: "siteflow-api-1",
      State: "running",
      Health: "healthy",
      Image: releaseImage
    },
    {
      Service: "worker",
      ID: "siteflow-worker-1",
      State: "running",
      Health: "healthy",
      Image: releaseImage,
      ...overrides
    }
  ]);
}

function imageInspectJson() {
  return JSON.stringify([
    {
      Id: imageId,
      RepoDigests: [releaseImage]
    }
  ]);
}

function makeExec(options: { workerHealthExitCode?: number; logs?: string; psWorkerOverride?: Record<string, unknown> } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFileImpl: ReleaseTargetRuntimeEvidenceExecFile = async (file, args) => {
    calls.push({ file, args });
    const command = [file, ...args].join(" ");

    if (command === "hostname") {
      return { stdout: "siteflow-prod-01\n", stderr: "" };
    }

    if (command === "docker context show") {
      return { stdout: "siteflow-prod\n", stderr: "" };
    }

    if (command === "docker context inspect siteflow-prod") {
      return { stdout: JSON.stringify([{ Name: "siteflow-prod", Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]), stderr: "" };
    }

    if (command.includes(" config --format json")) {
      return { stdout: composeConfigJson(), stderr: "" };
    }

    if (command === "stat -c %g /var/run/docker.sock") {
      return { stdout: "998\n", stderr: "" };
    }

    if (command.includes(" up -d")) {
      return { stdout: "started", stderr: "" };
    }

    if (command.includes(" exec -T worker node dist-worker/worker/index.js --healthcheck")) {
      if (options.workerHealthExitCode && options.workerHealthExitCode !== 0) {
        const error = new Error("worker health failed") as Error & { code: number; stdout: string };
        error.code = options.workerHealthExitCode;
        error.stdout = "";
        throw error;
      }

      return { stdout: "SiteFlow build worker healthcheck passed.\n", stderr: "" };
    }

    if (command.includes(" ps --format json")) {
      return { stdout: psJson(options.psWorkerOverride), stderr: "" };
    }

    if (command.includes(" image inspect ")) {
      return { stdout: imageInspectJson(), stderr: "" };
    }

    if (command.includes(" restart api worker")) {
      return { stdout: "restarted", stderr: "" };
    }

    if (command.includes(" logs ")) {
      return { stdout: options.logs ?? "api started\nworker started\npostgres ready\n", stderr: "" };
    }

    throw new Error(`Unexpected command: ${command}`);
  };

  return { execFileImpl, calls };
}

function baseOptions(overrides: Partial<Parameters<typeof collectReleaseTargetRuntimeEvidence>[0]> = {}) {
  const { fetchImpl } = makeFetch();
  const { execFileImpl } = makeExec();

  return {
    commitRef: "abc123def456",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvironment: "production",
    publicBaseUrl: "https://siteflow.example.com",
    operatorName: "release-operator",
    ticketId: "REL-2026-0608",
    expectedDigest: digest,
    composeFile: "docker-compose.production.yml",
    envFile: "/etc/siteflow/target.env",
    composeProject: "siteflow-prod",
    fetchImpl,
    execFileImpl,
    now,
    ...overrides
  };
}

async function makeTempRoot(name: string) {
  const root = path.join(process.cwd(), ".tmp-test-output", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  await mkdir(root, { recursive: true });
  return root;
}

describe("releaseTargetRuntimeEvidenceCollect", () => {
  it("collects sanitized target runtime evidence that passes the checker", async () => {
    const root = await makeTempRoot("target-runtime-collect");

    try {
      const outputPath = path.join(root, "target-runtime-evidence-raw.json");
      const checkOutputPath = path.join(root, "target-runtime-evidence.json");
      const { fetchImpl } = makeFetch();
      const { execFileImpl, calls } = makeExec();
      const result = await collectReleaseTargetRuntimeEvidence(baseOptions({
        outputPath,
        checkOutputPath,
        fetchImpl,
        execFileImpl
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));
      const serialized = JSON.stringify(raw);

      expect(result.status).toBe("collected");
      expect(result.exitCode).toBe(0);
      expect(raw).toMatchObject({
        schemaVersion: "siteflow.targetRuntimeEvidence.v1",
        name: "siteflow-target-runtime-evidence",
        status: "passed",
        dryRun: false,
        template: false,
        checkedAt,
        targetEnvironment: "production",
        release: {
          commitRef: "abc123def456",
          repository: "acme/siteflow",
          branch: "main"
        },
        targetIdentity: {
          status: "passed",
          source: "target_host_identity_probe",
          hostname: "siteflow-prod-01",
          dockerContext: "siteflow-prod",
          rawContextArchived: false,
          composeProject: "siteflow-prod",
          composeFile: "docker-compose.production.yml",
          envFileConfigured: true,
          publicBaseUrl: "https://siteflow.example.com"
        },
        composeConfig: {
          status: "passed",
          composeProject: "siteflow-prod",
          services: ["postgres", "api", "worker"],
          secrets: [
            "siteflow_app_secret",
            "siteflow_api_token",
            "siteflow_metrics_token",
            "siteflow_release_evidence_signing_key",
            "siteflow_postgres_password"
          ],
          healthchecks: ["postgres", "api", "worker"],
          sanitized: true,
          rawConfigArchived: false,
          noBuildFallback: true,
          images: {
            postgres: postgresImage,
            api: releaseImage,
            worker: releaseImage
          },
          serviceProfiles: {
            api: {
              user: "1000:1000",
              privileged: false,
              readOnly: true,
              capDropAll: true,
              capAdd: [],
              capAddEmpty: true,
              noNewPrivileges: true,
              dangerousSecurityOpt: [],
              dangerousSecurityOptConfigured: false,
              networkMode: null,
              hostNetworkMode: false,
              dockerSocketMounted: false
            },
            worker: {
              user: "1000:1000",
              groupAdd: ["998"],
              groupAddConfigured: true,
              hostDockerSocketGid: 998,
              groupAddMatchesHostDockerSocketGid: true,
              privileged: false,
              readOnly: true,
              capDropAll: true,
              capAdd: [],
              capAddEmpty: true,
              noNewPrivileges: true,
              dangerousSecurityOpt: [],
              dangerousSecurityOptConfigured: false,
              networkMode: null,
              hostNetworkMode: false,
              dockerSocketMounted: true,
              buildRunnerDocker: true,
              buildNetworkNone: true,
              buildMemory: "1g",
              buildMemoryConfigured: true,
              buildCpus: "2",
              buildCpusConfigured: true,
              buildPidsLimit: "256",
              buildPidsLimitConfigured: true,
              dockerCliPreflightPresent: true,
              dockerInfoPreflightPresent: true,
              gitSshKeyPathEnvPresent: true,
              gitKnownHostsPathEnvPresent: true
            }
          }
        },
        serviceHealth: {
          status: "passed",
          postgresHealthy: true,
          apiHealthy: true,
          workerRunning: true,
          workerHealthy: true,
          workerQueueProbePassed: true,
          workerHeartbeatFresh: true
        },
        readiness: {
          status: "passed",
          loopbackStatusCode: 200,
          publicStatusCode: 200,
          loopbackBodyStatus: "ready",
          publicBodyStatus: "ready"
        },
        imageBinding: {
          status: "passed",
          expectedDigest: digest,
          apiImageDigest: digest,
          workerImageDigest: digest,
          apiContainerId: "siteflow-api-1",
          workerContainerId: "siteflow-worker-1",
          apiImageId: imageId,
          workerImageId: imageId
        },
        restartSmoke: {
          status: "passed",
          restarted: true,
          serviceHealthAfterRestart: true,
          workerHealthAfterRestart: true,
          readinessAfterRestart: true
        },
        negativeEvidence: {
          noRawComposeConfigArchived: true,
          noRawEnvArchived: true,
          noRawSecretsArchived: true,
          noUnredactedLogsArchived: true
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-target-runtime-evidence-check",
        status: "passed",
        exitCode: 0,
        selectedEvidence: {
          workerRuntimePosture: {
            status: "passed",
            dockerSocketMounted: true,
            groupAddConfigured: true,
            buildRunnerDocker: true,
            buildNetworkNone: true,
            dockerCliPreflightPresent: true,
            dockerInfoPreflightPresent: true,
            gitSshKeyPathEnvPresent: true,
            gitKnownHostsPathEnvPresent: true
          }
        }
      });
      expect(raw.composeConfig.configSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(raw.targetIdentity.dockerContextInspectSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(raw.targetIdentity.hostFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(serialized).not.toContain("POSTGRES_PASSWORD");
      expect(serialized).not.toContain("SITEFLOW_GIT_SSH_KEY_PATH");
      expect(serialized).not.toContain("SITEFLOW_GIT_KNOWN_HOSTS_PATH");
      expect(serialized).not.toContain("api started");
      expect(calls.some((call) => call.file === "hostname")).toBe(true);
      expect(calls.some((call) => call.args.join(" ") === "context show")).toBe(true);
      expect(calls.some((call) => call.args.join(" ") === "context inspect siteflow-prod")).toBe(true);
      expect(calls.some((call) => call.args.includes("--env-file") && call.args.includes("/etc/siteflow/target.env"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when worker healthcheck fails and writes checker diagnostics", async () => {
    const root = await makeTempRoot("target-runtime-blocked");

    try {
      const outputPath = path.join(root, "target-runtime-evidence-raw.json");
      const checkOutputPath = path.join(root, "target-runtime-evidence.json");
      const { execFileImpl } = makeExec({ workerHealthExitCode: 1 });
      const result = await collectReleaseTargetRuntimeEvidence(baseOptions({
        outputPath,
        checkOutputPath,
        execFileImpl
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(1);
      expect(raw.status).toBe("blocked");
      expect(raw.serviceHealth).toMatchObject({
        status: "blocked",
        workerHealthy: false,
        workerQueueProbePassed: false,
        workerHeartbeatFresh: false
      });
      expect(check).toMatchObject({
        status: "blocked",
        exitCode: 1
      });
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "worker_healthcheck_collected", status: "fail" }),
          expect.objectContaining({ name: "target_runtime_evidence_check", status: "fail" })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds checker output to release identity and targetEnvironment", async () => {
    const result = await collectReleaseTargetRuntimeEvidence(baseOptions({
      targetEnvironment: "staging"
    }));

    expect(result.status).toBe("collected");
    expect(result.checkResult).toMatchObject({
      status: "passed",
      selectedEvidence: {
        targetEnvironment: "staging",
        commitRef: "abc123def456",
        repository: "acme/siteflow",
        branch: "main"
      }
    });
  });

  it("blocks when target host identity cannot be collected", async () => {
    const { fetchImpl } = makeFetch();
    const { execFileImpl: baseExec } = makeExec();
    const execFileImpl: ReleaseTargetRuntimeEvidenceExecFile = async (file, args, options) => {
      if (file === "docker" && args.join(" ") === "context show") {
        const error = new Error("docker context unavailable") as Error & { code: number; stdout: string };
        error.code = 1;
        error.stdout = "";
        throw error;
      }

      return baseExec(file, args, options);
    };
    const result = await collectReleaseTargetRuntimeEvidence(baseOptions({
      fetchImpl,
      execFileImpl
    }));

    expect(result.status).toBe("blocked");
    expect(result.checkResult?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "target_identity_status", status: "fail" }),
        expect.objectContaining({ name: "target_identity_docker_context", status: "fail" })
      ])
    );
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "target_identity_collected",
      status: "fail"
    }));
  });

  it("does not persist raw logs or secret-like values when log sanity blocks", async () => {
    const root = await makeTempRoot("target-runtime-secret-log");

    try {
      const outputPath = path.join(root, "target-runtime-evidence-raw.json");
      const checkOutputPath = path.join(root, "target-runtime-evidence.json");
      const rawToken = "Bearer abcdefghijklmnop";
      const { execFileImpl } = makeExec({
        logs: `worker failed with Authorization: ${rawToken}\n`
      });
      const result = await collectReleaseTargetRuntimeEvidence(baseOptions({
        outputPath,
        checkOutputPath,
        execFileImpl
      }));
      const raw = await readFile(outputPath, "utf8");
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(result.status).toBe("blocked");
      expect(raw).not.toContain(rawToken);
      expect(raw).not.toContain("Authorization");
      expect(JSON.parse(raw).logSanity).toMatchObject({
        status: "blocked",
        secretLeakFindings: expect.any(Number),
        rawLogsArchived: false
      });
      expect(check.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "log_sanity_status", status: "fail" }),
          expect.objectContaining({ name: "no_sensitive_evidence_values", status: "pass" })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the CLI and prints collected evidence without raw env or log content", async () => {
    const { execFileImpl } = makeExec();
    const { fetchImpl } = makeFetch();
    let stdout = "";
    let stderr = "";

    const exitCode = await runReleaseTargetRuntimeEvidenceCollectCli(
      [
        "--commit-ref", "abc123def456",
        "--repo", "acme/siteflow",
        "--branch", "main",
        "--target-environment", "production",
        "--public-base-url", "https://siteflow.example.com",
        "--operator-name", "release-operator",
        "--release-ticket", "REL-2026-0608",
        "--expected-digest", digest,
        "--env-file", "/etc/siteflow/target.env",
        "--checked-at", checkedAt,
        "--json"
      ],
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      },
      {
        execFileImpl,
        fetchImpl,
        now
      }
    );
    const printed = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(printed.status).toBe("passed");
    expect(stdout).not.toContain("api started");
    expect(stdout).not.toContain("POSTGRES_PASSWORD");
  });

  it("returns usage errors for missing required options and unsafe URLs", () => {
    expect(parseReleaseTargetRuntimeEvidenceCollectArgs([
      "--commit-ref", "abc123def456",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--public-base-url", "https://siteflow.example.com",
      "--operator-name", "release-operator",
      "--release-ticket", "REL-2026-0608"
    ])).toMatchObject({
      commitRef: "abc123def456",
      targetEnvironment: "production"
    });
    expect(() => parseReleaseTargetRuntimeEvidenceCollectArgs([])).toThrow("--commit-ref <sha> is required");
    expect(() => parseReleaseTargetRuntimeEvidenceCollectArgs([
      "--commit-ref", "abc123def456",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--public-base-url", "http://siteflow.example.com",
      "--operator-name", "release-operator",
      "--release-ticket", "REL-2026-0608"
    ])).toThrow("--public-base-url must use https");
    expect(() => parseReleaseTargetRuntimeEvidenceCollectArgs([
      "--commit-ref", "abc123def456",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--public-base-url", "https://siteflow.example.com",
      "--operator-name", "release-operator",
      "--release-ticket", "REL-2026-0608",
      "--expected-digest", "latest"
    ])).toThrow("--expected-digest must be a sha256 digest");
  });
});
