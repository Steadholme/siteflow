import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReleaseEvidenceRehearsalPack } from "./releaseEvidenceRehearsalPack";
import {
  passingEvidenceForCommandArgs,
  writePassingReleaseEvidenceOutputs
} from "./releaseEvidencePassedFixtures.test-support";
import {
  parseReleaseEvidenceTargetRunArgs,
  runReleaseEvidenceTargetRun,
  runReleaseEvidenceTargetRunCli,
  targetRunCommandExecutable,
  type ReleaseEvidenceCommandRunner
} from "./releaseEvidenceTargetRun";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const operatorAccessRequiredChecks = [
  "non_dry_run",
  "release_identity",
  "environment",
  "public_base_url",
  "session_create_present",
  "session_create_status",
  "session_cookie_flags",
  "session_secret_not_returned",
  "session_policy_present",
  "session_policy_enforced",
  "project_scope_present",
  "project_scope_enforced",
  "session_revoke_present",
  "session_revoke_status",
  "csrf_present",
  "csrf_enforced",
  "bearer_precedence_present",
  "bearer_precedence_enforced",
  "actor_attribution_present",
  "actor_attribution_enforced",
  "emergency_cutoff_present",
  "emergency_cutoff_global",
  "emergency_cutoff_project",
  "emergency_cutoff_cookie_only_rejected",
  "emergency_cutoff_low_scope_bearer",
  "emergency_cutoff_old_cookie_rejected",
  "negative_evidence_present",
  "no_raw_secrets_stored",
  "operator",
  "ticket"
];
const nonSessionCredentialRequiredChecks = [
  "non_dry_run",
  "release_identity",
  "environment",
  "operator",
  "ticket",
  "credentials_present",
  "credential_types_supported",
  "credential_owners_and_tickets",
  "credential_redacted_identifiers",
  "no_raw_credentials_archived",
  "old_credentials_rejected",
  "new_credentials_accepted",
  "credential_specific_evidence",
  "break_glass_present",
  "break_glass_controls",
  "automation_not_claimed"
];

function passingCheck(name: string) {
  return {
    name,
    status: "pass",
    message: `${name} passed.`
  };
}

function passedOperatorAccessEvidence() {
  return {
    name: "siteflow-operator-access-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T12:00:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      environment: "production",
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main",
      publicBaseUrl: "https://siteflow.example.com",
      sessionCreate: { status: "passed" },
      projectScope: { status: "passed" },
      sessionRevoke: { status: "passed" },
      csrf: { status: "passed" },
      bearerPrecedence: { status: "passed" },
      actorAttribution: { status: "passed" },
      emergencyCutoff: { status: "passed" }
    },
    checks: operatorAccessRequiredChecks.map(passingCheck)
  };
}

function passedNonSessionCredentialEvidence() {
  return {
    name: "siteflow-non-session-credential-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T12:00:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      environment: "production",
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main",
      credentialTypes: ["scoped_api_token"],
      credentialCount: 1,
      breakGlass: { status: "passed" }
    },
    checks: nonSessionCredentialRequiredChecks.map(passingCheck)
  };
}

function targetRunPassingStdout(args: string[]) {
  if (args.includes("operator-access:evidence")) {
    return JSON.stringify(passedOperatorAccessEvidence());
  }

  if (args.includes("non-session-credential:evidence")) {
    return JSON.stringify(passedNonSessionCredentialEvidence());
  }

  return JSON.stringify({
    name: "not-release-gate",
    status: "blocked",
    checkedAt: "2026-06-08T12:00:00.000Z"
  });
}

function pack(outputDir: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.releaseEvidenceRehearsalPack.v1",
    name: "siteflow-release-evidence-rehearsal-pack",
    status: "planned",
    generatedAt: "2026-06-08T11:00:00.000Z",
    release: {
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      requiredStatusCheck: "Install, test, and build",
      operatorName: "release-operator",
      releaseTicket: "REL-123",
      publicBaseUrl: "https://siteflow.example.com",
      targetEnvFile: path.join(outputDir, "target.env")
    },
    outputDir,
    packPath: path.join(outputDir, "release-evidence-rehearsal-pack.json"),
    markdownPath: path.join(outputDir, "release-evidence-rehearsal-pack.md"),
    evidenceFiles: {},
    steps: [],
    finalCommands: {},
    blockedProductionClaims: [
      "The target run is not production evidence by itself."
    ],
    ...overrides
  };
}

function completePack(
  root: string,
  overrides: Record<string, unknown> = {},
  stepOverrides: Record<string, Record<string, unknown>> = {}
) {
  const generated = createReleaseEvidenceRehearsalPack({
    commitRef: "abc123",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvFile: path.join(root, "target.env"),
    publicBaseUrl: "https://siteflow.example.com",
    operatorName: "release-operator",
    releaseTicket: "REL-123",
    outputDir: root,
    now
  });

  return {
    ...generated,
    steps: generated.steps.map((step) => ({
      ...step,
      ...stepOverrides[step.id]
    })),
    ...overrides
  };
}

async function writePack(root: string, value: Record<string, unknown>) {
  const packPath = path.join(root, "release-evidence-rehearsal-pack.json");

  await writeFile(packPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  return packPath;
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFakeExecutable(root: string, executable: string) {
  const filename = targetRunCommandExecutable(executable);
  const filePath = path.join(root, filename);
  const content = process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";

  await writeFile(filePath, content, "utf8");

  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }

  return filePath;
}

async function fakeExecutableEnv(root: string, names: string[], extra: NodeJS.ProcessEnv = {}) {
  const binDir = path.join(root, "bin");

  await mkdir(binDir, { recursive: true });

  for (const name of names) {
    await writeFakeExecutable(binDir, name);
  }

  return {
    PATH: binDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ...extra
  };
}

describe("releaseEvidenceTargetRun", () => {
  it("uses Windows command shims for package-manager executables without invoking a shell", () => {
    expect(targetRunCommandExecutable("npm", "win32")).toBe("npm.cmd");
    expect(targetRunCommandExecutable("npx", "win32")).toBe("npx.cmd");
    expect(targetRunCommandExecutable("npm.cmd", "win32")).toBe("npm.cmd");
    expect(targetRunCommandExecutable("npm", "linux")).toBe("npm");
  });

  it("blocks incomplete rehearsal packs before command execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-incomplete-"));

    try {
      const packPath = await writePack(root, pack(root));

      await expect(runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        commandRunner: async () => {
          throw new Error("should not execute");
        },
        now
      })).rejects.toThrow("Release evidence rehearsal pack is incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks the whole run when target environment confirmation does not match the pack", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-env-"));

    try {
      const packPath = await writePack(root, completePack(root));
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "staging",
        commandRunner: async () => {
          throw new Error("should not execute");
        },
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("does not match");
      expect(result.steps).toHaveLength(15);
      expect(result.steps[0]).toMatchObject({
        id: "release_gate",
        status: "skipped"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to persist run records when pack command displays contain sensitive values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-record-secret-"));

    try {
      const targetPack = completePack(root);
      const releaseGateStep = targetPack.steps.find((step) => step.id === "release_gate")!;

      releaseGateStep.command = {
        ...releaseGateStep.command,
        display: `${releaseGateStep.command.display} Authorization: Bearer abcdefghijklmnop`
      };

      const packPath = await writePack(root, targetPack as unknown as Record<string, unknown>);

      await expect(runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "staging",
        now
      })).rejects.toThrow("Run record matched sensitive output patterns");
      expect(await exists(path.join(root, "release-evidence-target-run.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unresolved operator placeholders before command execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-placeholder-"));
    let calls = 0;

    try {
      const targetPack = completePack(root);
      const releaseGateStep = targetPack.steps.find((step) => step.id === "release_gate")!;
      releaseGateStep.command = {
        ...releaseGateStep.command,
        args: [...releaseGateStep.command.args, "--target", "<direct-api-url>"],
        display: `${releaseGateStep.command.display} --target <direct-api-url>`
      };
      const packPath = await writePack(root, targetPack as unknown as Record<string, unknown>);
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
        now
      });

      expect(calls).toBe(0);
      expect(result.status).toBe("blocked");
      expect(result.steps[0]).toMatchObject({
        id: "release_gate",
        status: "blocked",
        placeholders: ["direct-api-url"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not write captured stdout when it matches secret patterns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-secret-"));

    try {
      const outputPath = path.join(root, "release-gate.json");
      const packPath = await writePack(root, completePack(root));
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env: {
          GITHUB_TOKEN: "ghp_secretsecretsecretsecret12345"
        },
        commandRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            status: "passed",
            leaked: "SITEFLOW_SECRET_CANARY",
            authorization: "Bearer abcdefghijklmnop"
          }),
          stderr: "postgres://siteflow:secret@db/siteflow"
        }),
        now
      });
      const serialized = JSON.stringify(result);
      const runRecord = await readFile(result.runRecordPath, "utf8");

      expect(result.status).toBe("failed");
      expect(result.steps[0]).toMatchObject({
        id: "release_gate",
        status: "failed",
        stdoutBytes: expect.any(Number),
        stderrBytes: expect.any(Number)
      });
      expect(result.steps[0].message).toContain("sensitive output patterns");
      expect(await exists(outputPath)).toBe(false);
      expect(serialized).not.toContain("SITEFLOW_SECRET_CANARY");
      expect(serialized).not.toContain("Bearer abcdefghijklmnop");
      expect(serialized).not.toContain("ghp_secretsecretsecretsecret12345");
      expect(runRecord).not.toContain("SITEFLOW_SECRET_CANARY");
      expect(runRecord).not.toContain("secret@db");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not write captured stdout for failed commands and records safe stderr diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-command-failed-"));
    let initialRunRecordStatus: string | undefined;

    try {
      const outputPath = path.join(root, "release-gate.json");
      const packPath = await writePack(root, completePack(root));
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        env: {
          GITHUB_TOKEN: "present"
        },
        commandRunner: async () => {
          const initialRunRecord = JSON.parse(await readFile(path.join(root, "release-evidence-target-run.json"), "utf8"));

          initialRunRecordStatus = initialRunRecord.status;

          return {
            exitCode: 1,
            stdout: JSON.stringify({ status: "failed" }),
            stderr: "spawn npm.cmd ENOENT"
          };
        },
        now
      });

      expect(initialRunRecordStatus).toBe("running");
      expect(result.status).toBe("failed");
      expect(result.commandsExecuted).toBe(1);
      expect(result.productionEvidenceGenerated).toBe(false);
      expect(result.steps[0]).toMatchObject({
        id: "release_gate",
        status: "failed",
        stdoutDiscardedReason: expect.stringContaining("non-zero"),
        stderrPreview: "spawn npm.cmd ENOENT"
      });
      expect(result.steps[0]).not.toHaveProperty("stdoutCapturedTo");
      expect(await exists(outputPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts failed-command stderr diagnostics when stderr matches secret patterns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-command-secret-stderr-"));

    try {
      const outputPath = path.join(root, "release-gate.json");
      const packPath = await writePack(root, completePack(root));
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        env: {
          GITHUB_TOKEN: "present"
        },
        commandRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "postgres://siteflow:secret@db/siteflow"
        }),
        now
      });
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("failed");
      expect(result.steps[0]).toMatchObject({
        status: "failed",
        stderrSensitiveReasons: expect.arrayContaining(["URL credentials"])
      });
      expect(result.steps[0]).not.toHaveProperty("stderrPreview");
      expect(serialized).not.toContain("secret@db");
      expect(await exists(outputPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts sensitive checker diagnostics from gap report snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-gap-secret-"));

    try {
      const outputPath = path.join(root, "release-gate.json");
      const packPath = await writePack(root, completePack(root));

      await writeFile(outputPath, `${JSON.stringify({
        status: "blocked",
        checkedAt: "2026-06-08T11:30:00.000Z",
        checks: [
          {
            name: "bad_diagnostic",
            status: "fail",
            message: "unexpected Authorization header Bearer abcdefghijklmnop"
          }
        ]
      }, null, 2)}\n`, "utf8");

      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        now
      });
      const snapshotPath = path.join(root, "gap-reports", "000-initial.json");
      const snapshot = await readFile(snapshotPath, "utf8");

      expect(result.status).toBe("blocked");
      expect(await exists(snapshotPath)).toBe(true);
      expect(snapshot).not.toContain("abcdefghijklmnop");
      expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes gap report snapshots when checker diagnostics mention bearer precedence without tokens", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-gap-bearer-precedence-"));

    try {
      const outputPath = path.join(root, "release-gate.json");
      const packPath = await writePack(root, completePack(root));

      await writeFile(outputPath, `${JSON.stringify({
        status: "blocked",
        checkedAt: "2026-06-08T11:30:00.000Z",
        checks: [
          {
            name: "bearer_precedence_present",
            status: "fail",
            message: "Bearer precedence evidence must be present."
          }
        ]
      }, null, 2)}\n`, "utf8");

      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        env: {},
        now
      });

      expect(result.status).toBe("blocked");
      expect(await exists(path.join(root, "gap-reports", "000-initial.json"))).toBe(true);
      expect(await exists(path.join(root, "gap-reports", "001-release_gate.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies replacements to gap report snapshots without storing replacement values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-gap-replacements-"));
    const directApiUrl = "http://10.0.0.5:8787/healthz";
    const releaseImageRunId = "123456789";

    try {
      const packPath = await writePack(root, completePack(root));
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        replacements: {
          "direct-api-url": directApiUrl,
          "release-image-run-id": releaseImageRunId,
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        commandRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "stopped before evidence collection"
        }),
        now
      });
      const initialSnapshot = JSON.parse(await readFile(result.gapReports[0].path, "utf8"));
      const serializedSnapshot = JSON.stringify(initialSnapshot);
      const commandArgGaps = initialSnapshot.items.flatMap((item: { inputGaps: Array<{ source: string; value: string }> }) =>
        item.inputGaps.filter((gap) => gap.source === "command_arg").map((gap) => gap.value)
      );

      expect(commandArgGaps).not.toContain("direct-api-url");
      expect(commandArgGaps).not.toContain("release-image-run-id");
      expect(commandArgGaps).not.toContain("SITEFLOW_TRUST_PROXY");
      expect(serializedSnapshot).not.toContain(directApiUrl);
      expect(serializedSnapshot).not.toContain(releaseImageRunId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves --set-env replacements for command execution without storing env values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-set-env-"));
    const directApiUrl = "https://api.internal/do-not-leak/readyz";
    let observedArgs: string[] = [];

    try {
      const targetPack = completePack(root);
      const releaseGateStep = targetPack.steps.find((step) => step.id === "release_gate")!;

      releaseGateStep.command = {
        ...releaseGateStep.command,
        args: [...releaseGateStep.command.args, "--target", "<direct-api-url>"],
        display: `${releaseGateStep.command.display} --target <direct-api-url>`
      };

      const packPath = await writePack(root, targetPack as unknown as Record<string, unknown>);
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        envReplacements: {
          "direct-api-url": "SITEFLOW_DIRECT_API_URL"
        },
        env: {
          GITHUB_TOKEN: "present",
          SITEFLOW_DIRECT_API_URL: directApiUrl
        },
        commandRunner: async ({ args }) => {
          observedArgs = args;

          return {
            exitCode: 1,
            stdout: "",
            stderr: "stopped before evidence collection"
          };
        },
        now
      });
      const runRecord = await readFile(result.runRecordPath, "utf8");
      const initialSnapshot = await readFile(result.gapReports[0].path, "utf8");

      expect(observedArgs).toContain(directApiUrl);
      expect(result.steps[0]).toMatchObject({
        id: "release_gate",
        status: "failed",
        replacementKeys: ["direct-api-url"],
        envReplacementKeys: [
          {
            key: "direct-api-url",
            envName: "SITEFLOW_DIRECT_API_URL"
          }
        ]
      });
      expect(result.envReplacements).toEqual([
        {
          key: "direct-api-url",
          envName: "SITEFLOW_DIRECT_API_URL"
        }
      ]);
      expect(JSON.stringify(result)).not.toContain(directApiUrl);
      expect(runRecord).not.toContain(directApiUrl);
      expect(initialSnapshot).toContain("SITEFLOW_DIRECT_API_URL");
      expect(initialSnapshot).not.toContain(directApiUrl);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans target commands without executing them in plan-only mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-plan-only-"));
    let calls = 0;

    try {
      const packPath = await writePack(root, completePack(root));
      const env = await fakeExecutableEnv(root, ["npm", "gh"], {
        GITHUB_TOKEN: "present",
        GH_TOKEN: "present",
        SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
        SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
        TEST_DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow_rehearsal",
        SITEFLOW_METRICS_TOKEN: "present"
      });
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        planOnly: true,
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env,
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 1, stdout: "", stderr: "should not execute" };
        },
        now
      });
      const runRecord = JSON.parse(await readFile(result.runRecordPath, "utf8"));

      expect(calls).toBe(0);
      expect(result.status).toBe("planned");
      expect(result.exitCode).toBe(0);
      expect(result.planOnly).toBe(true);
      expect(result.commandsExecuted).toBe(0);
      expect(result.productionEvidenceGenerated).toBe(false);
      expect(result.initialGapReportStatus).toBe("blocked");
      expect(result.finalGapReportStatus).toBe("blocked");
      expect(result.message).toContain("No target commands were executed");
      expect(result.gapReports).toHaveLength(1);
      expect(result.gapReports[0].id).toBe("000-initial");
      expect(result.steps).toHaveLength(15);
      expect(result.steps.every((step) => step.status === "planned")).toBe(true);
      expect(result.steps.every((step) => step.executableRequirement?.status === "satisfied")).toBe(true);
      expect(runRecord).toMatchObject({
        status: "planned",
        planOnly: true,
        commandsExecuted: 0,
        productionEvidenceGenerated: false,
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "release_gate",
            status: "planned",
            message: expect.stringContaining("not executed")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks plan-only mode when fail-on-gaps sees an initial blocked gap report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-plan-only-gaps-"));
    let calls = 0;

    try {
      const packPath = await writePack(root, completePack(root));
      const env = await fakeExecutableEnv(root, ["npm", "gh"], {
        GITHUB_TOKEN: "present",
        GH_TOKEN: "present",
        SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
        SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
        TEST_DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow_rehearsal",
        SITEFLOW_METRICS_TOKEN: "present"
      });
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        planOnly: true,
        failOnGaps: true,
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env,
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 1, stdout: "", stderr: "should not execute" };
        },
        now
      });
      const runRecord = JSON.parse(await readFile(result.runRecordPath, "utf8"));

      expect(calls).toBe(0);
      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(2);
      expect(result.planOnly).toBe(true);
      expect(result.failOnGaps).toBe(true);
      expect(result.commandsExecuted).toBe(0);
      expect(result.productionEvidenceGenerated).toBe(false);
      expect(result.initialGapReportStatus).toBe("blocked");
      expect(result.finalGapReportStatus).toBe("blocked");
      expect(result.message).toContain("initial gap report");
      expect(result.gapReports).toHaveLength(1);
      expect(result.steps).toHaveLength(15);
      expect(result.steps.every((step) => step.status === "planned")).toBe(true);
      expect(runRecord).toMatchObject({
        status: "blocked",
        planOnly: true,
        failOnGaps: true,
        commandsExecuted: 0,
        productionEvidenceGenerated: false
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts readable _FILE environment requirements in plan-only mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-plan-only-file-env-"));
    let calls = 0;

    try {
      const tokenPath = path.join(root, "metrics-token");
      await writeFile(tokenPath, "metrics-token\n", "utf8");

      const packPath = await writePack(root, completePack(root));
      const env = await fakeExecutableEnv(root, ["npm", "gh"], {
        GITHUB_TOKEN: "present",
        GH_TOKEN: "present",
        SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
        SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
        TEST_DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow_rehearsal",
        SITEFLOW_METRICS_TOKEN_FILE: tokenPath
      });
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        planOnly: true,
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env,
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 1, stdout: "", stderr: "should not execute" };
        },
        now
      });
      const observabilityStep = result.steps.find((step) => step.id === "observability_evidence");

      expect(calls).toBe(0);
      expect(result.status).toBe("planned");
      expect(observabilityStep?.envRequirements).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "SITEFLOW_METRICS_TOKEN",
          status: "missing"
        }),
        expect.objectContaining({
          name: "SITEFLOW_METRICS_TOKEN_FILE",
          status: "satisfied"
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unreadable _FILE environment requirements in plan-only mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-plan-only-file-env-blocked-"));
    let calls = 0;

    try {
      const packPath = await writePack(root, completePack(root));
      const env = await fakeExecutableEnv(root, ["npm", "gh"], {
        GITHUB_TOKEN: "present",
        GH_TOKEN: "present",
        SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
        SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
        TEST_DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow_rehearsal",
        SITEFLOW_METRICS_TOKEN_FILE: path.join(root, "missing-metrics-token")
      });
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        planOnly: true,
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env,
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 1, stdout: "", stderr: "should not execute" };
        },
        now
      });
      const observabilityStep = result.steps.find((step) => step.id === "observability_evidence");

      expect(calls).toBe(0);
      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(2);
      expect(observabilityStep).toMatchObject({
        status: "blocked",
        envRequirements: expect.arrayContaining([
          expect.objectContaining({
            name: "SITEFLOW_METRICS_TOKEN_FILE",
            status: "mismatch",
            message: expect.stringContaining("cannot be read")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks plan-only mode when a required executable is missing from PATH", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-plan-only-executable-"));
    let calls = 0;

    try {
      const packPath = await writePack(root, completePack(root));
      const env = await fakeExecutableEnv(root, ["npm"], {
        GITHUB_TOKEN: "present",
        GH_TOKEN: "present",
        SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
        SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
        TEST_DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow_rehearsal",
        SITEFLOW_METRICS_TOKEN: "present"
      });
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        planOnly: true,
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env,
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
        now
      });
      const blockedExecutableStep = result.steps.find((step) => step.executableRequirement?.name === "gh");

      expect(calls).toBe(0);
      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(2);
      expect(blockedExecutableStep).toMatchObject({
        status: "blocked",
        executableRequirement: {
          name: "gh",
          status: "missing",
          message: expect.stringContaining("not found on PATH")
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks plan-only mode when placeholders remain unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-plan-only-blocked-"));
    let calls = 0;

    try {
      const targetPack = completePack(root);
      const releaseGateStep = targetPack.steps.find((step) => step.id === "release_gate")!;
      releaseGateStep.command = {
        ...releaseGateStep.command,
        args: [...releaseGateStep.command.args, "--target", "<direct-api-url>"],
        display: `${releaseGateStep.command.display} --target <direct-api-url>`
      };
      const packPath = await writePack(root, targetPack as unknown as Record<string, unknown>);
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        planOnly: true,
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
        now
      });

      expect(calls).toBe(0);
      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(2);
      expect(result.planOnly).toBe(true);
      expect(result.steps[0]).toMatchObject({
        id: "release_gate",
        status: "blocked",
        placeholders: ["direct-api-url"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("fails when all commands exit zero but the final gap report still has gaps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-gaps-"));

    try {
      const outputPath = path.join(root, "release-gate.json");
      const packPath = await writePack(root, completePack(root));
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "1",
          "api-process-count": "1",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env: {
          GITHUB_TOKEN: "present",
          GH_TOKEN: "present",
          SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
          SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
          TEST_DATABASE_URL: "postgres://siteflow:secret@localhost:5432/siteflow_rehearsal",
          SITEFLOW_METRICS_TOKEN: "present"
        },
        commandRunner: async ({ args }) => ({
          exitCode: 0,
          stdout: targetRunPassingStdout(args),
          stderr: ""
        }),
        now
      });

      expect(result.steps[0]).toMatchObject({
        status: "completed",
        stdoutCapturedTo: outputPath
      });
      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("still reports gaps");
      expect(result.gapReports.at(-1)?.status).toBe("blocked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it("completes when all target commands pass and the final gap report has no gaps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-passed-"));

    try {
      const targetPack = createReleaseEvidenceRehearsalPack({
        commitRef: "abc123def4567890",
        repo: "acme/siteflow",
        branch: "main",
        targetEnvFile: path.join(root, "target.env"),
        publicBaseUrl: "https://siteflow.example.com",
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0608",
        outputDir: root,
        now
      });
      const packPath = await writePack(root, targetPack as unknown as Record<string, unknown>);
      let seeded = false;
      const commandRunner: ReleaseEvidenceCommandRunner = async ({ args }) => {
        if (!seeded) {
          await writePassingReleaseEvidenceOutputs(targetPack);
          seeded = true;
        }

        const evidence = passingEvidenceForCommandArgs(args, targetPack);

        return {
          exitCode: 0,
          stdout: evidence ? JSON.stringify(evidence) : "",
          stderr: ""
        };
      };
      const result = await runReleaseEvidenceTargetRun({
        packPath,
        confirmTargetEnvironment: "production",
        replacements: {
          "direct-api-url": "http://10.0.0.5:8787/healthz",
          "release-image-run-id": "123456789",
          "api-instance-count": "2",
          "api-process-count": "2",
          "ingress-count": "1",
          "api-rate-limit-scope": "edge",
          "api-rate-limit-enforcement-point": "ingress",
          SITEFLOW_TRUST_PROXY: "loopback"
        },
        env: {
          GITHUB_TOKEN: "present",
          GH_TOKEN: "present",
          SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "1",
          SITEFLOW_BUILD_IMAGE: "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
          TEST_DATABASE_URL: "postgres://siteflow@localhost:5432/siteflow_rehearsal",
          SITEFLOW_METRICS_TOKEN: "present"
        },
        commandRunner,
        now
      });
      const artifactEvidence = JSON.parse(await readFile(targetPack.evidenceFiles.releaseArtifact, "utf8"));

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.steps).toHaveLength(15);
      expect(result.steps.every((step) => step.status === "completed")).toBe(true);
      expect(result.gapReports.at(-1)).toMatchObject({
        id: "015-release_evidence_check",
        status: "passed",
        summary: expect.objectContaining({ gaps: 0 })
      });
      expect(result.message).toContain("no remaining gaps");
      expect(artifactEvidence.artifactManifest).toEqual({ functions: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it("runs the CLI without printing env values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-run-cli-"));
    let stdout = "";
    let stderr = "";

    try {
      const packPath = await writePack(root, pack(root));
      const exitCode = await runReleaseEvidenceTargetRunCli(
        [
          "--pack", packPath,
          "--confirm-target-environment", "production",
          "--set", "direct-api-url=http://10.0.0.5:8787/healthz",
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          env: {
            GITHUB_TOKEN: "ghp_secretsecretsecretsecret12345"
          },
          now
        }
      );
      const result = JSON.parse(stdout);

      expect(exitCode).toBe(2);
      expect(stderr).toBe("");
      expect(result.status).toBe("blocked");
      expect(result.message).toContain("Release evidence rehearsal pack is incomplete");
      expect(stdout).not.toContain("ghp_secretsecretsecretsecret12345");
      expect(stdout).not.toContain("http://10.0.0.5:8787/healthz");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns usage errors for missing required options and invalid replacements", () => {
    expect(parseReleaseEvidenceTargetRunArgs([
      "--pack", "pack.json",
      "--confirm-target-environment", "production",
      "--plan-only",
      "--fail-on-gaps",
      "--set-env", "direct-api-url=SITEFLOW_DIRECT_API_URL"
    ])).toMatchObject({
      planOnly: true,
      failOnGaps: true,
      envReplacements: {
      "direct-api-url": "SITEFLOW_DIRECT_API_URL"
      }
    });
    expect(() => parseReleaseEvidenceTargetRunArgs([])).toThrow("--pack is required");
    expect(() => parseReleaseEvidenceTargetRunArgs([
      "--pack", "pack.json",
      "--confirm-target-environment", "production",
      "--set", "bad"
    ])).toThrow("--set requires KEY=value");
    expect(() => parseReleaseEvidenceTargetRunArgs([
      "--pack", "pack.json",
      "--confirm-target-environment", "production",
      "--set", "bad/key=value"
    ])).toThrow("Replacement key bad/key");
    expect(() => parseReleaseEvidenceTargetRunArgs([
      "--pack", "pack.json",
      "--confirm-target-environment", "production",
      "--set-env", "direct-api-url=1_BAD"
    ])).toThrow("--set-env direct-api-url");
  });
});
