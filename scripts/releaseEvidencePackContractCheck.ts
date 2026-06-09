import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import { createReleaseEvidenceRehearsalPack, type ReleaseEvidenceRehearsalPackOptions } from "./releaseEvidenceRehearsalPack.js";
import { validateReleaseEvidenceRehearsalPackContract } from "./releaseEvidenceRehearsalPackContract.js";
import { runReleaseEvidenceTargetRun } from "./releaseEvidenceTargetRun.js";

const releaseEvidenceSigningKeyEnv = "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY";
const releaseEvidenceRequiredSigningKeyIdEnv = "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID";
const contractSigningKey = "release-evidence-contract-signing-key-with-enough-entropy";
const expectedCommandPlaceholders = new Set([
  "SITEFLOW_TRUST_PROXY",
  "api-instance-count",
  "api-process-count",
  "api-rate-limit-enforcement-point",
  "api-rate-limit-scope",
  "break-glass-approver-count",
  "break-glass-source",
  "candidate-deployment-detail-path",
  "deploy-key-path",
  "direct-api-url",
  "ingress-count",
  "known-hosts-path",
  "new-metrics-token-redacted-id",
  "new-root-api-token-redacted-id",
  "old-metrics-token-redacted-id",
  "old-root-api-token-redacted-id",
  "operator-access-denied-project-id",
  "operator-access-project-id",
  "release-image-digest",
  "webhook-delivery-id",
  "release-image-run-id"
]);
const expectedEnvPlaceholders = new Set([
  "target-image@sha256:...",
  "target-or-disposable-postgres-url"
]);

export interface ReleaseEvidencePackContractCheckOptions {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ReleaseEvidencePackContractCheckResult {
  name: "siteflow-release-evidence-pack-contract-check";
  status: "passed" | "blocked";
  checkedAt: string;
  pack: {
    stepCount: number;
    finalCommands: string[];
    commandPlaceholders: string[];
    envPlaceholders: string[];
  };
  planOnly: {
    status: string;
    stepCount: number;
    blockedSteps: string[];
  };
  checks: Array<{
    name: string;
    status: "pass" | "fail";
    message: string;
  }>;
  exitCode: number;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

function isEntrypoint() {
  const entryPath = process.argv[1];

  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function placeholderNames(values: unknown[]) {
  const names = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    for (const match of value.matchAll(/<([^<>]+)>/g)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }
  }

  return [...names].sort();
}

function commandArgs(command: unknown) {
  return command && typeof command === "object" && !Array.isArray(command) &&
    Array.isArray((command as Record<string, unknown>).args)
    ? ((command as Record<string, unknown>).args as unknown[])
    : [];
}

function commandEnv(command: unknown) {
  return command && typeof command === "object" && !Array.isArray(command) &&
    Array.isArray((command as Record<string, unknown>).env)
    ? ((command as Record<string, unknown>).env as unknown[])
    : [];
}

function packCommands(pack: ReturnType<typeof createReleaseEvidenceRehearsalPack>) {
  return [
    ...pack.steps.map((step) => step.command),
    pack.finalCommands.compose,
    pack.finalCommands.check
  ];
}

function unknownValues(actual: string[], expected: Set<string>) {
  return actual.filter((entry) => !expected.has(entry));
}

function missingValues(expected: Set<string>, actual: string[]) {
  const actualSet = new Set(actual);

  return [...expected].filter((entry) => !actualSet.has(entry));
}

function pushSetCheck(
  checks: ReleaseEvidencePackContractCheckResult["checks"],
  name: string,
  actual: string[],
  expected: Set<string>,
  label: string
) {
  const missing = missingValues(expected, actual);
  const unknown = unknownValues(actual, expected);

  if (missing.length === 0 && unknown.length === 0) {
    checks.push({
      name,
      status: "pass",
      message: `${label} match the release evidence pack contract.`
    });
    return;
  }

  checks.push({
    name,
    status: "fail",
    message: [
      missing.length > 0 ? `missing ${missing.join(", ")}` : undefined,
      unknown.length > 0 ? `unexpected ${unknown.join(", ")}` : undefined
    ].filter(Boolean).join("; ")
  });
}

function contractPackOptions(outputDir: string, now: () => Date): ReleaseEvidenceRehearsalPackOptions {
  return {
    commitRef: "abc123def4567890",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvFile: path.join(outputDir, "target.env"),
    publicBaseUrl: "https://siteflow.example.com",
    operatorName: "release-operator",
    releaseTicket: "REL-2026-0608",
    observabilityTargetStackApiUrl: "https://observability.example.com/siteflow-proof",
    outputDir,
    checkedAt: now().toISOString(),
    now
  };
}

async function writeFakeExecutable(binDir: string, name: string) {
  const fileName = process.platform === "win32" ? `${name}.cmd` : name;
  const filePath = path.join(binDir, fileName);
  const contents = process.platform === "win32"
    ? "@echo off\r\nexit /b 0\r\n"
    : "#!/bin/sh\nexit 0\n";

  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

async function fakeExecutableEnv(root: string) {
  const binDir = path.join(root, "bin");

  await mkdir(binDir, { recursive: true });
  await Promise.all([
    writeFakeExecutable(binDir, "npm"),
    writeFakeExecutable(binDir, "gh")
  ]);

  return {
    PATH: binDir,
    Path: binDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    GITHUB_TOKEN: "present",
    GH_TOKEN: "present",
    SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
    SITEFLOW_BUILD_IMAGE: `registry.local/siteflow/runtime@sha256:${"a".repeat(64)}`,
    SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
    TEST_DATABASE_URL: "postgres://siteflow:redacted@localhost:5432/siteflow_rehearsal",
    SITEFLOW_API_TOKEN: "present",
    SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN: "present",
    SITEFLOW_OLD_METRICS_TOKEN: "present",
    SITEFLOW_METRICS_TOKEN: "present",
    SITEFLOW_OBSERVABILITY_STACK_TOKEN: "present",
    SITEFLOW_OLD_API_TOKEN: "present",
    [releaseEvidenceSigningKeyEnv]: contractSigningKey,
    [releaseEvidenceRequiredSigningKeyIdEnv]: "sha256:1111111111111111"
  };
}

function targetRunReplacements() {
  return {
    "direct-api-url": "http://10.0.0.5:8787/healthz",
    "candidate-deployment-detail-path": path.join("evidence", "private", "deployment-detail.json"),
    "release-image-digest": `sha256:${"a".repeat(64)}`,
    "release-image-run-id": "123456789",
    "api-instance-count": "1",
    "api-process-count": "1",
    "ingress-count": "1",
    "api-rate-limit-scope": "edge",
    "api-rate-limit-enforcement-point": "ingress",
    "deploy-key-path": "/run/secrets/siteflow_git_ssh_key",
    "known-hosts-path": "/etc/ssh/ssh_known_hosts",
    "webhook-delivery-id": "delivery-123",
    "operator-access-project-id": "project-allowed",
    "operator-access-denied-project-id": "project-denied",
    "old-metrics-token-redacted-id": "metrics-token-old-redacted",
    "new-metrics-token-redacted-id": "metrics-token-new-redacted",
    "old-root-api-token-redacted-id": "root-api-token-old-redacted",
    "new-root-api-token-redacted-id": "root-api-token-new-redacted",
    "break-glass-source": "pager-duty",
    "break-glass-approver-count": "2",
    SITEFLOW_TRUST_PROXY: "loopback"
  };
}

function targetEnvFileFixture() {
  return [
    "# release pack contract target env fixture",
    "SITEFLOW_ENV=production",
    "DATABASE_URL=postgres://siteflow@postgres:5432/siteflow",
    "SITEFLOW_API_PORT=8787",
    "SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts",
    "SITEFLOW_EVIDENCE_ROOT=/var/lib/siteflow/evidence",
    "SITEFLOW_PUBLIC_SCHEME=https",
    "SITEFLOW_BASE_DOMAIN=siteflow.example.com",
    "SITEFLOW_WORKER_USER=1000:1000",
    "SITEFLOW_DOCKER_SOCKET_GID=998",
    "SITEFLOW_API_TOKEN_FILE=/etc/siteflow/secrets/api-token.secret",
    "SITEFLOW_METRICS_TOKEN_FILE=/etc/siteflow/secrets/metrics-token.secret",
    "SITEFLOW_APP_SECRET_FILE=/etc/siteflow/secrets/app-secret.secret",
    "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE=/etc/siteflow/secrets/release-evidence-signing-key.secret",
    "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID=release-evidence-key-id",
    "SITEFLOW_POSTGRES_PASSWORD_FILE=/etc/siteflow/secrets/postgres-password.secret",
    "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/github-webhook.secret",
    "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/gitlab-webhook.secret",
    "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/gitea-webhook.secret",
    "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE=/etc/siteflow/secrets/generic-webhook.secret",
    `SITEFLOW_IMAGE=ghcr.io/siteflow/siteflow@sha256:${"a".repeat(64)}`,
    `SITEFLOW_POSTGRES_IMAGE=postgres@sha256:${"b".repeat(64)}`,
    "SITEFLOW_BUILD_RUNNER=docker",
    `SITEFLOW_BUILD_IMAGE=registry.local/siteflow/runtime@sha256:${"c".repeat(64)}`,
    "SITEFLOW_BUILD_NETWORK=none",
    "SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824",
    "SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000",
    "SITEFLOW_GIT_TIMEOUT_MS=300000",
    "SITEFLOW_BUILD_MEMORY=1g",
    "SITEFLOW_BUILD_CPUS=2",
    "SITEFLOW_BUILD_PIDS_LIMIT=256",
    "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912",
    "SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000",
    "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912",
    "SITEFLOW_PREBUILT_MAX_FILES=20000",
    ""
  ].join("\n");
}

export async function runReleaseEvidencePackContractCheck(
  options: ReleaseEvidencePackContractCheckOptions = {}
): Promise<ReleaseEvidencePackContractCheckResult> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-pack-contract-"));
  const outputDir = path.join(root, "evidence");
  const checks: ReleaseEvidencePackContractCheckResult["checks"] = [];

  try {
    const pack = createReleaseEvidenceRehearsalPack(contractPackOptions(outputDir, now));

    validateReleaseEvidenceRehearsalPackContract(pack as unknown as Record<string, unknown>);
    checks.push({
      name: "pack_contract",
      status: "pass",
      message: "Generated rehearsal pack satisfies the release evidence rehearsal contract."
    });

    const commands = packCommands(pack);
    const commandPlaceholders = placeholderNames(commands.flatMap((command) => commandArgs(command)));
    const envPlaceholders = placeholderNames(commands.flatMap((command) => commandEnv(command)));

    pushSetCheck(checks, "command_placeholders", commandPlaceholders, expectedCommandPlaceholders, "Command placeholders");
    pushSetCheck(checks, "env_placeholders", envPlaceholders, expectedEnvPlaceholders, "Environment placeholders");

    const secretFindings = scanEvidenceForRawSecrets(pack, { maxFindings: 5 });

    if (secretFindings.length > 0 || JSON.stringify(pack).includes(contractSigningKey)) {
      checks.push({
        name: "sensitive_output",
        status: "fail",
        message: secretFindings.length > 0
          ? `Generated pack contains sensitive-looking output: ${evidenceSecretFindingSummary(secretFindings)}.`
          : "Generated pack contains the release evidence signing key value."
      });
    } else {
      checks.push({
        name: "sensitive_output",
        status: "pass",
        message: "Generated pack contains only env names and placeholders, not secret values."
      });
    }

    await mkdir(outputDir, { recursive: true });
    await writeFile(pack.release.targetEnvFile, targetEnvFileFixture(), "utf8");
    await writeFile(pack.packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

    const plan = await runReleaseEvidenceTargetRun({
      packPath: pack.packPath,
      confirmTargetEnvironment: "production",
      planOnly: true,
      replacements: targetRunReplacements(),
      env: {
        ...(options.env ?? {}),
        ...(await fakeExecutableEnv(root))
      },
      cwd: options.cwd ?? process.cwd(),
      now
    });
    const blockedSteps = plan.steps
      .filter((step) => step.status === "blocked")
      .map((step) => step.id);

    checks.push({
      name: "target_run_plan_only",
      status: plan.status === "planned" && blockedSteps.length === 0 ? "pass" : "fail",
      message: plan.status === "planned" && blockedSteps.length === 0
        ? "Generated pack can be planned by release:evidence:target-run without executing target commands."
        : `Plan-only target run is ${plan.status}; blocked steps: ${blockedSteps.join(", ") || "none"}.`
    });

    const status = checks.every((check) => check.status === "pass") ? "passed" : "blocked";

    return {
      name: "siteflow-release-evidence-pack-contract-check",
      status,
      checkedAt,
      pack: {
        stepCount: pack.steps.length,
        finalCommands: Object.keys(pack.finalCommands),
        commandPlaceholders,
        envPlaceholders
      },
      planOnly: {
        status: plan.status,
        stepCount: plan.steps.length,
        blockedSteps
      },
      checks,
      exitCode: status === "passed" ? 0 : 1
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function releaseEvidencePackContractCheckUsage() {
  return [
    "Usage: npm run --silent release:evidence:pack-contract -- [--json]",
    "",
    "Options:",
    "  --json   Print the contract check result as JSON.",
    "  --help   Show this help."
  ].join("\n");
}

export async function runReleaseEvidencePackContractCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr }
) {
  const json = args.includes("--json");

  if (args.includes("--help") || args.includes("-h")) {
    io.stdout.write(`${releaseEvidencePackContractCheckUsage()}\n`);
    return 0;
  }

  const unknown = args.filter((arg) => arg !== "--json");

  if (unknown.length > 0) {
    io.stderr.write(`Unknown option(s): ${unknown.join(", ")}\n\n`);
    io.stderr.write(`${releaseEvidencePackContractCheckUsage()}\n`);
    return 2;
  }

  try {
    const result = await runReleaseEvidencePackContractCheck();

    if (json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout.write(`SiteFlow release evidence pack contract: ${result.status}\n`);
      for (const check of result.checks) {
        io.stdout.write(`${check.status.toUpperCase()} ${check.name}: ${check.message}\n`);
      }
    }

    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (json) {
      io.stdout.write(`${JSON.stringify({
        name: "siteflow-release-evidence-pack-contract-check",
        status: "blocked",
        message,
        exitCode: 1
      }, null, 2)}\n`);
    } else {
      io.stderr.write(`${message}\n`);
    }

    return 1;
  }
}

if (isEntrypoint()) {
  runReleaseEvidencePackContractCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
