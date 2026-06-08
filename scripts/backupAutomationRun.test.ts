import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseBackupAutomationRunArgs,
  runBackupAutomation,
  runBackupAutomationRunCli
} from "./backupAutomationRun";
import type { SiteFlowCommandRunner } from "../cli/doctor";

const databaseUrl = "postgres://siteflow:supersecret@localhost:5432/siteflow";
const restoreDrillDatabaseUrl = "postgres://siteflow:restoresecret@localhost:5432/siteflow_drill";
const backupKmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";

function makeClock() {
  let ticks = 0;
  const baseMs = Date.parse("2026-06-07T12:00:00.000Z");

  return () => {
    const next = new Date(baseMs + ticks * 60_000);
    ticks += 1;
    return next;
  };
}

function backupPolicy(retentionDays = 30, minimumBackups = 1) {
  return {
    schedule: {
      cron: "15 */6 * * *",
      timezone: "UTC"
    },
    retention: {
      retentionDays,
      minimumBackups
    },
    objectives: {
      rpoHours: 6,
      rtoHours: 2
    },
    monitoring: {
      backupAgeAlertConfigured: true,
      restoreDrillAgeAlertConfigured: true,
      alertChannel: "pager",
      owner: "platform"
    }
  };
}

function providerSecurityAudit() {
  return {
    schemaVersion: "siteflow.backupProviderSecurityAudit.v1",
    name: "siteflow-backup-provider-security-audit",
    status: "passed",
    checkedAt: "2026-06-07T12:00:00.000Z",
    provider: "aws_s3",
    evidenceSource: "provider_security_audit",
    operator: "release-operator",
    ticket: "REL-2026-0607",
    kmsKeyPolicy: {
      status: "passed",
      kmsKeyRef: backupKmsKeyRef,
      policySha256: "c".repeat(64),
      backupRoleEncryptDecryptAllowed: true,
      restoreRoleDecryptAllowed: true,
      crossAccountRestoreRoleAllowed: true,
      publicAccessDenied: true
    },
    bucketPolicy: {
      status: "passed",
      policySha256: "d".repeat(64),
      publicAccessBlocked: true,
      insecureTransportDenied: true,
      unencryptedUploadsDenied: true,
      backupRoleWriteAllowed: true,
      restoreRoleReadAllowed: true
    },
    lifecyclePolicy: {
      status: "passed",
      ruleId: "retain-siteflow-prod-backups",
      enabled: true,
      versioningEnabled: true,
      retentionDays: 30
    },
    crossAccountRestore: {
      status: "passed",
      sourceAccountId: "111122223333",
      restoreAccountId: "444455556666",
      restoreRoleArn: "arn:aws:iam::444455556666:role/siteflow-restore",
      s3GetObjectTest: { status: "passed" },
      kmsDecryptTest: { status: "passed" }
    },
    crossAccountRestoreDrill: {
      status: "passed",
      restoreDrill: true,
      completedAt: "2026-06-07T12:01:00.000Z",
      restoreAccountId: "444455556666",
      restoreRoleArn: "arn:aws:iam::444455556666:role/siteflow-restore",
      backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260607"
    }
  };
}

async function writeJson(root: string, name: string, value: unknown) {
  const filePath = path.join(root, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function createArtifactRoot(root: string) {
  const artifactRoot = path.join(root, "artifacts-source");

  await mkdir(path.join(artifactRoot, "project-a"), { recursive: true });
  await writeFile(path.join(artifactRoot, "project-a", "index.html"), "<h1>SiteFlow</h1>", "utf8");

  return artifactRoot;
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
    .map((file) => `2026-06-07 12:00:00 ${file.size.toString().padStart(10, " ")} ${file.relativePath}`)
    .join("\n");
}

function createBackupRunner(options: { failPsql?: boolean } = {}) {
  const commands: Array<{ command: string; args: string[] }> = [];
  let s3UploadSourcePath: string | undefined;
  const runner: SiteFlowCommandRunner = async (command, args) => {
    commands.push({ command, args });

    if (command === "pg_dump") {
      await writeFile(args[args.indexOf("--file") + 1], "database dump\n", "utf8");
    }

    if (command === "psql" && options.failPsql) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `restore failed for ${restoreDrillDatabaseUrl}`
      };
    }

    if (command === "aws" && args[0] === "s3" && args[1] === "cp") {
      if (args[2].startsWith("s3://")) {
        if (s3UploadSourcePath) {
          await cp(s3UploadSourcePath, args[3], { recursive: true });
        }
      } else {
        s3UploadSourcePath = args[2];
      }

      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }

    if (command === "aws" && args[0] === "s3" && args[1] === "ls") {
      return {
        exitCode: 0,
        stdout: s3UploadSourcePath ? await s3RecursiveListingForDirectory(s3UploadSourcePath) : "",
        stderr: ""
      };
    }

    if (command === "aws" && args[0] === "s3api" && args[1] === "head-object") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups",
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: "2026-07-08T12:00:00.000Z"
        }),
        stderr: ""
      };
    }

    if (command === "aws" && args[0] === "s3api" && args[1] === "get-object-lock-configuration") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ObjectLockConfiguration: {
            ObjectLockEnabled: "Enabled",
            Rule: {
              DefaultRetention: {
                Mode: "COMPLIANCE",
                Days: 30
              }
            }
          }
        }),
        stderr: ""
      };
    }

    return {
      exitCode: 0,
      stdout: "ok",
      stderr: ""
    };
  };

  return { commands, runner };
}

async function createAutomationInputs(root: string) {
  const backupRoot = path.join(root, "backups");
  const evidenceDir = path.join(root, "evidence");
  const offloadRoot = path.join(root, "offhost");
  const restoreDrillArtifactRoot = path.join(root, "restore-artifacts");
  const artifactRoot = await createArtifactRoot(root);
  const policyPath = await writeJson(root, "backup-policy.json", backupPolicy());
  const providerSecurityAuditPath = await writeJson(root, "backup-provider-security-audit.json", providerSecurityAudit());

  return {
    backupRoot,
    evidenceDir,
    offloadRoot,
    restoreDrillArtifactRoot,
    artifactRoot,
    policyPath,
    providerSecurityAuditPath
  };
}

describe("backupAutomationRun", () => {
  it("runs local backup steps but blocks production backup evidence for file offload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-"));
    const { commands, runner } = createBackupRunner();

    try {
      const inputs = await createAutomationInputs(root);
      const result = await runBackupAutomation({
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: pathToFileURL(inputs.offloadRoot).href,
        restoreDrillDatabaseUrl,
        restoreDrillArtifactRoot: inputs.restoreDrillArtifactRoot,
        restoreDrillConfirmed: true,
        evidenceDir: inputs.evidenceDir,
        policyPath: inputs.policyPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        version: "0.1.0-test",
        backupName: "siteflow-20260607",
        now: makeClock(),
        dependencies: {
          runner
        }
      });
      const runRecord = JSON.parse(await readFile(result.evidenceFiles.backupAutomationRun!, "utf8"));
      const resultJson = JSON.stringify(result);

      expect(result).toMatchObject({
        name: "siteflow-backup-automation-run",
        status: "failed",
        exitCode: 1,
        backupPath: path.join(inputs.backupRoot, "siteflow-20260607")
      });
      expect(commands.map((command) => command.command)).toEqual(["pg_dump", "psql"]);
      expect(result.evidenceFiles.backupEvidenceRaw).toBeUndefined();
      expect(result.evidenceFiles.backupEvidenceCheck).toBeUndefined();
      expect(result.composeResult).toMatchObject({
        name: "siteflow-backup-evidence-compose",
        status: "blocked",
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "off_host_inputs",
            status: "fail"
          })
        ])
      });
      expect(result.composeResult?.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "off_host_inputs",
            status: "fail"
          })
        ])
      );
      expect(runRecord).toMatchObject({
        name: "siteflow-backup-automation-run",
        status: "failed",
        evidenceFiles: {
          backupAutomationRun: path.join(inputs.evidenceDir, "backup-automation-run.json")
        }
      });
      expect(resultJson).not.toContain("supersecret");
      expect(resultJson).not.toContain("restoresecret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs production-compatible backup evidence with S3 offload metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-s3-"));
    const { commands, runner } = createBackupRunner();

    try {
      const inputs = await createAutomationInputs(root);
      const result = await runBackupAutomation({
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: "s3://siteflow-prod-backups/automation",
        offloadKmsKeyRef: backupKmsKeyRef,
        offloadProviderRetentionMode: "compliance",
        offloadProviderRetentionDays: 30,
        offloadProviderRetentionContract: "s3-object-lock-siteflow-prod",
        offloadProviderProof: true,
        providerSecurityAuditPath: inputs.providerSecurityAuditPath,
        restoreDrillDatabaseUrl,
        restoreDrillArtifactRoot: inputs.restoreDrillArtifactRoot,
        restoreDrillConfirmed: true,
        evidenceDir: inputs.evidenceDir,
        policyPath: inputs.policyPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        version: "0.1.0-test",
        backupName: "siteflow-20260607",
        now: makeClock(),
        dependencies: {
          runner
        }
      });
      const check = JSON.parse(await readFile(result.evidenceFiles.backupEvidenceCheck!, "utf8"));
      const backupOffload = JSON.parse(await readFile(result.evidenceFiles.backupOffload!, "utf8"));
      const backupFetch = JSON.parse(await readFile(result.evidenceFiles.backupFetch!, "utf8"));

      expect(commands.map((command) => command.command)).toEqual(["pg_dump", "aws", "aws", "aws", "aws", "aws", "aws", "aws", "psql"]);
      expect(commands[1].args).toEqual([
        "s3",
        "ls",
        "s3://siteflow-prod-backups/automation/siteflow-20260607/",
        "--recursive"
      ]);
      expect(commands[2].args).toEqual([
        "s3",
        "cp",
        path.join(inputs.backupRoot, "siteflow-20260607"),
        "s3://siteflow-prod-backups/automation/siteflow-20260607/",
        "--recursive",
        "--only-show-errors",
        "--sse",
        "aws:kms",
        "--sse-kms-key-id",
        "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups"
      ]);
      expect(commands[3].args).toEqual([
        "s3",
        "ls",
        "s3://siteflow-prod-backups/automation/siteflow-20260607/",
        "--recursive"
      ]);
      expect(commands[4].args).toEqual([
        "s3api",
        "head-object",
        "--bucket",
        "siteflow-prod-backups",
        "--key",
        "automation/siteflow-20260607/manifest.json",
        "--output",
        "json"
      ]);
      expect(commands[5].args).toEqual([
        "s3api",
        "get-object-lock-configuration",
        "--bucket",
        "siteflow-prod-backups",
        "--output",
        "json"
      ]);
      expect(commands[6].args).toEqual([
        "s3",
        "ls",
        "s3://siteflow-prod-backups/automation/siteflow-20260607/",
        "--recursive"
      ]);
      expect(commands[7].args).toEqual([
        "s3",
        "cp",
        "s3://siteflow-prod-backups/automation/siteflow-20260607/",
        path.join(inputs.evidenceDir, "fetched-backups", "siteflow-20260607"),
        "--recursive",
        "--only-show-errors"
      ]);
      expect(result).toMatchObject({
        name: "siteflow-backup-automation-run",
        status: "completed",
        exitCode: 0,
        composeResult: {
          status: "composed"
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-backup-evidence-check",
        status: "passed",
        selectedEvidence: {
          backupOffload: {
            provider: "s3",
            kmsKeyRef: backupKmsKeyRef,
            providerKmsProof: true,
            providerRetentionProof: true,
            retentionContract: "s3-object-lock-siteflow-prod"
          },
          backupFetch: {
            status: "fetched",
            backupPath: path.join(inputs.evidenceDir, "fetched-backups", "siteflow-20260607"),
            offHostLocation: "s3://siteflow-prod-backups/automation/siteflow-20260607",
            provider: "s3"
          },
          backupProviderSecurityAudit: {
            status: "passed",
            timestamp: "2026-06-07T12:00:00.000Z"
          }
        }
      });
      expect(result.evidenceFiles.backupFetch).toBe(path.join(inputs.evidenceDir, "backup-fetch.json"));
      expect(result.evidenceFiles.backupProviderSecurityAudit).toBe(inputs.providerSecurityAuditPath);
      expect(backupOffload).toMatchObject({
        status: "offloaded",
        target: {
          provider: "s3",
          location: "s3://siteflow-prod-backups/automation/siteflow-20260607",
          checksumVerified: true,
          encryption: {
            mode: "kms",
            kmsKeyRef: backupKmsKeyRef
          },
          providerRetention: {
            status: "enabled",
            mode: "compliance",
            retentionDays: 30,
            contractId: "s3-object-lock-siteflow-prod"
          },
          providerProof: {
            status: "verified",
            provider: "aws_s3",
            sampleObjectKey: "automation/siteflow-20260607/manifest.json"
          }
        }
      });
      expect(backupFetch).toMatchObject({
        status: "fetched",
        source: {
          provider: "s3",
          location: "s3://siteflow-prod-backups/automation/siteflow-20260607"
        },
        backupPath: path.join(inputs.evidenceDir, "fetched-backups", "siteflow-20260607"),
        checksumVerified: true
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("appends backup automation run history for recurring restore-drill evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-history-"));

    try {
      const inputs = await createAutomationInputs(root);
      const runHistoryPath = path.join(root, "backup-automation-history.json");
      const clock = makeClock();
      const baseOptions = {
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: "s3://siteflow-prod-backups/automation",
        offloadKmsKeyRef: backupKmsKeyRef,
        offloadProviderRetentionMode: "compliance",
        offloadProviderRetentionDays: 30,
        offloadProviderRetentionContract: "s3-object-lock-siteflow-prod",
        offloadProviderProof: true,
        providerSecurityAuditPath: inputs.providerSecurityAuditPath,
        restoreDrillDatabaseUrl,
        restoreDrillArtifactRoot: inputs.restoreDrillArtifactRoot,
        restoreDrillConfirmed: true,
        policyPath: inputs.policyPath,
        runHistoryPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        version: "0.1.0-test",
        now: clock
      };

      const first = await runBackupAutomation({
        ...baseOptions,
        evidenceDir: path.join(root, "evidence-1"),
        backupName: "siteflow-20260601",
        dependencies: {
          runner: createBackupRunner().runner
        }
      });
      const second = await runBackupAutomation({
        ...baseOptions,
        evidenceDir: path.join(root, "evidence-2"),
        backupName: "siteflow-20260607",
        dependencies: {
          runner: createBackupRunner().runner
        }
      });
      const history = JSON.parse(await readFile(runHistoryPath, "utf8"));
      const serializedHistory = JSON.stringify(history);

      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect(second.evidenceFiles.backupAutomationRunHistory).toBe(runHistoryPath);
      expect(second.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "backup_automation_run_history",
            status: "completed",
            outputPath: runHistoryPath
          })
        ])
      );
      expect(history).toMatchObject({
        schemaVersion: "siteflow.backupAutomationRunHistory.v1",
        name: "siteflow-backup-automation-run-history",
        cadence: {
          restoreDrillMaxGapHours: 168,
          minimumSuccessfulRestoreDrills: 2
        }
      });
      expect(history.runs).toHaveLength(2);
      expect(history.runs[1]).toMatchObject({
        status: "completed",
        exitCode: 0,
        backupPath: path.join(inputs.backupRoot, "siteflow-20260607"),
        restoreDrillCompleted: true,
        backupEvidenceStatus: "passed",
        composeStatus: "composed"
      });
      expect(serializedHistory).not.toContain("supersecret");
      expect(serializedHistory).not.toContain("restoresecret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it("blocks restore drill automation unless disposable target confirmation is explicit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-blocked-"));
    const { runner } = createBackupRunner();

    try {
      const inputs = await createAutomationInputs(root);
      const result = await runBackupAutomation({
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: pathToFileURL(inputs.offloadRoot).href,
        restoreDrillDatabaseUrl,
        restoreDrillArtifactRoot: inputs.restoreDrillArtifactRoot,
        restoreDrillConfirmed: false,
        evidenceDir: inputs.evidenceDir,
        policyPath: inputs.policyPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        now: makeClock(),
        dependencies: {
          runner
        }
      });

      expect(result).toMatchObject({
        status: "blocked",
        exitCode: 2,
        message: expect.stringContaining("--restore-drill-yes"),
        evidenceFiles: {
          backupAutomationRun: path.join(inputs.evidenceDir, "backup-automation-run.json")
        }
      });
      await expect(readFile(result.evidenceFiles.backupAutomationRun!, "utf8")).resolves.toContain("\"status\": \"blocked\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore drill targets that match the source targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-same-target-"));
    const { runner } = createBackupRunner();

    try {
      const inputs = await createAutomationInputs(root);
      const result = await runBackupAutomation({
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: pathToFileURL(inputs.offloadRoot).href,
        restoreDrillDatabaseUrl: databaseUrl,
        restoreDrillArtifactRoot: inputs.restoreDrillArtifactRoot,
        restoreDrillConfirmed: true,
        evidenceDir: inputs.evidenceDir,
        policyPath: inputs.policyPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        now: makeClock(),
        dependencies: {
          runner
        }
      });

      expect(result).toMatchObject({
        status: "blocked",
        exitCode: 2,
        message: expect.stringContaining("restore-drill database URL to differ")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore drill database URLs that resolve to the same Postgres target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-same-postgres-"));
    const { runner } = createBackupRunner();

    try {
      const inputs = await createAutomationInputs(root);
      const result = await runBackupAutomation({
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: pathToFileURL(inputs.offloadRoot).href,
        restoreDrillDatabaseUrl: "postgres://restore:other@LOCALHOST/siteflow?sslmode=require",
        restoreDrillArtifactRoot: inputs.restoreDrillArtifactRoot,
        restoreDrillConfirmed: true,
        evidenceDir: inputs.evidenceDir,
        policyPath: inputs.policyPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        now: makeClock(),
        dependencies: {
          runner
        }
      });

      expect(result).toMatchObject({
        status: "blocked",
        exitCode: 2,
        message: expect.stringContaining("restore-drill database URL to differ")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restore drill artifact roots that overlap the source artifact root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-overlap-artifacts-"));
    const { runner } = createBackupRunner();

    try {
      const inputs = await createAutomationInputs(root);
      const result = await runBackupAutomation({
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: pathToFileURL(inputs.offloadRoot).href,
        restoreDrillDatabaseUrl,
        restoreDrillArtifactRoot: path.join(inputs.artifactRoot, "restore-drill"),
        restoreDrillConfirmed: true,
        evidenceDir: inputs.evidenceDir,
        policyPath: inputs.policyPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        now: makeClock(),
        dependencies: {
          runner
        }
      });

      expect(result).toMatchObject({
        status: "blocked",
        exitCode: 2,
        message: expect.stringContaining("restore-drill artifact root to be isolated")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns CLI usage errors for missing required options", async () => {
    let stdout = "";
    let stderr = "";

    expect(() => parseBackupAutomationRunArgs(["--backup-root", "backups"])).toThrow("Missing required option");
    expect(() => parseBackupAutomationRunArgs(["--backup-root"])).toThrow("--backup-root requires a value");

    const exitCode = await runBackupAutomationRunCli([], {
      stdout: { write: (chunk: string) => ((stdout += chunk), true) },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Missing required option");
    expect(stderr).toContain("backup:automation");
    expect(stderr).toContain("--policy");
  });

  it("prints the automation result as JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-cli-"));
    const { runner } = createBackupRunner();
    let stdout = "";
    let stderr = "";

    try {
      const inputs = await createAutomationInputs(root);
      const exitCode = await runBackupAutomationRunCli(
        [
          "--backup-root", inputs.backupRoot,
          "--database-url", databaseUrl,
          "--artifact-root", inputs.artifactRoot,
          "--offload-target", pathToFileURL(inputs.offloadRoot).href,
          "--restore-drill-database-url", restoreDrillDatabaseUrl,
          "--restore-drill-artifact-root", inputs.restoreDrillArtifactRoot,
          "--restore-drill-yes",
          "--evidence-dir", inputs.evidenceDir,
          "--policy", inputs.policyPath,
          "--run-record", path.join(inputs.evidenceDir, "latest-backup-automation-run.json"),
          "--operator-name", "release-operator",
          "--release-ticket", "REL-2026-0607",
          "--retention-days", "30",
          "--minimum-backups", "1",
          "--backup-name", "siteflow-cli-20260607",
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          now: makeClock(),
          dependencies: {
            runner
          }
        }
      );
      const printed = JSON.parse(stdout);

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(printed).toMatchObject({
        name: "siteflow-backup-automation-run",
        status: "failed",
        exitCode: 1,
        composeResult: {
          status: "blocked",
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "off_host_inputs",
              status: "fail"
            })
          ])
        }
      });
      expect(printed.evidenceFiles.backupEvidenceCheck).toBeUndefined();
      expect(printed.evidenceFiles.backupAutomationRun).toBe(path.join(inputs.evidenceDir, "latest-backup-automation-run.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps partial evidence and redacts restore secrets when restore drill fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-automation-failure-"));
    const { runner } = createBackupRunner({ failPsql: true });

    try {
      const inputs = await createAutomationInputs(root);
      const result = await runBackupAutomation({
        backupRoot: inputs.backupRoot,
        databaseUrl,
        artifactRoot: inputs.artifactRoot,
        offloadTarget: pathToFileURL(inputs.offloadRoot).href,
        restoreDrillDatabaseUrl,
        restoreDrillArtifactRoot: inputs.restoreDrillArtifactRoot,
        restoreDrillConfirmed: true,
        evidenceDir: inputs.evidenceDir,
        policyPath: inputs.policyPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        retentionDays: 30,
        minimumBackups: 1,
        backupName: "siteflow-failure-20260607",
        now: makeClock(),
        dependencies: {
          runner
        }
      });

      expect(result).toMatchObject({
        status: "failed",
        exitCode: 1,
        evidenceFiles: {
          backup: path.join(inputs.evidenceDir, "backup.json"),
          backupVerify: path.join(inputs.evidenceDir, "backup-verify.json")
        }
      });
      await expect(readFile(result.evidenceFiles.backup!, "utf8")).resolves.toContain("backed_up");
      await expect(readFile(result.evidenceFiles.backupVerify!, "utf8")).resolves.toContain("verified");
      expect(result.evidenceFiles.restoreDrill).toBeUndefined();
      expect(result.evidenceFiles.backupEvidenceCheck).toBeUndefined();
      expect(result.evidenceFiles.backupAutomationRun).toBe(path.join(inputs.evidenceDir, "backup-automation-run.json"));
      expect(result.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "restore_drill",
            status: "failed"
          })
        ])
      );
      expect(JSON.stringify(result)).not.toContain("supersecret");
      expect(JSON.stringify(result)).not.toContain("restoresecret");
      expect(result.message).toContain("[redacted database url]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
