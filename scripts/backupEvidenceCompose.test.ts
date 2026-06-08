import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  composeBackupEvidence,
  parseBackupEvidenceComposeArgs,
  runBackupEvidenceComposeCli
} from "./backupEvidenceCompose";

const now = () => new Date("2026-06-07T12:00:00.000Z");
const artifactTreeSha256 = "a".repeat(64);
const kmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";

function backupVerify() {
  return {
    status: "verified",
    createdAt: "2026-06-07T10:30:00.000Z",
    backupPath: "/backups/siteflow-20260607",
    database: {
      checksumVerified: true
    },
    artifacts: {
      checksumVerified: true,
      treeSha256: artifactTreeSha256,
      fileCount: 3,
      totalBytes: 128
    }
  };
}

function restoreDrill() {
  return {
    status: "restore_drilled",
    restoreDrill: true,
    backupPath: "/evidence/fetched-backups/siteflow-20260607",
    completedAt: "2026-06-07T11:00:00.000Z",
    durationMs: 2500,
    database: {
      target: "disposable_database"
    },
    artifacts: {
      target: "temporary_artifact_root",
      restoreMode: "replace_non_atomic",
      checksumVerified: true,
      treeSha256: artifactTreeSha256,
      fileCount: 3,
      totalBytes: 128
    }
  };
}

function backupFetch() {
  return {
    status: "fetched",
    fetchedAt: "2026-06-07T11:15:00.000Z",
    backupPath: "/evidence/fetched-backups/siteflow-20260607",
    source: {
      provider: "s3",
      location: "s3://siteflow-prod-backups/siteflow-20260607",
      objectCount: 4,
      totalBytes: 512,
      treeSha256: "b".repeat(64)
    },
    objectCount: 4,
    totalBytes: 512,
    treeSha256: "b".repeat(64),
    checksumVerified: true
  };
}

function backupOffload() {
  return {
    status: "offloaded",
    offloadedAt: "2026-06-07T11:10:00.000Z",
    backupPath: "/backups/siteflow-20260607",
    target: {
      provider: "s3",
      location: "s3://siteflow-prod-backups/siteflow-20260607",
      checksumVerified: true,
      treeSha256: "b".repeat(64),
      objectCount: 4,
      totalBytes: 512,
      encryption: {
        mode: "kms",
        kmsKeyRef
      },
      providerRetention: {
        status: "enabled",
        mode: "compliance",
        retentionDays: 30,
        contractId: "s3-object-lock-siteflow-prod"
      },
      providerProof: {
        status: "verified",
        checkedAt: "2026-06-07T11:10:00.000Z",
        provider: "aws_s3",
        bucket: "siteflow-prod-backups",
        prefix: "siteflow-20260607",
        sampleObjectKey: "siteflow-20260607/manifest.json",
        object: {
          serverSideEncryption: "aws:kms",
          sseKmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups",
          objectLockMode: "COMPLIANCE",
          objectLockRetainUntilDate: "2026-07-08T11:10:00.000Z",
          retentionDaysRemaining: 31
        },
        bucketObjectLock: {
          objectLockEnabled: true,
          defaultRetentionMode: "COMPLIANCE",
          defaultRetentionDays: 30
        },
        checks: [
          { name: "s3_head_object", status: "pass" },
          { name: "s3_object_kms", status: "pass" },
          { name: "s3_object_lock_retention", status: "pass" },
          { name: "s3_bucket_object_lock", status: "pass" }
        ],
        evidenceSource: "provider_api"
      }
    }
  };
}

function providerSecurityAudit() {
  return {
    schemaVersion: "siteflow.backupProviderSecurityAudit.v1",
    name: "siteflow-backup-provider-security-audit",
    status: "passed",
    checkedAt: "2026-06-07T11:16:00.000Z",
    provider: "aws_s3",
    evidenceSource: "provider_security_audit",
    operator: "release-operator",
    ticket: "REL-2026-0607",
    kmsKeyPolicy: {
      status: "passed",
      kmsKeyRef,
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
      s3GetObjectTest: {
        status: "passed"
      },
      kmsDecryptTest: {
        status: "passed"
      }
    },
    crossAccountRestoreDrill: {
      status: "passed",
      restoreDrill: true,
      completedAt: "2026-06-07T11:17:00.000Z",
      restoreAccountId: "444455556666",
      restoreRoleArn: "arn:aws:iam::444455556666:role/siteflow-restore",
      backupPath: "/evidence/fetched-backups/siteflow-20260607"
    }
  };
}

function backupPrune(overrides: Record<string, unknown> = {}) {
  return {
    status: "pruned",
    checkedAt: "2026-06-07T11:20:00.000Z",
    retentionDays: 30,
    minimumBackups: 8,
    dryRun: false,
    retained: [
      {
        backupPath: "/backups/siteflow-20260607",
        createdAt: "2026-06-07T10:30:00.000Z"
      }
    ],
    deleted: [],
    ...overrides
  };
}

function backupPolicy() {
  return {
    schedule: {
      cron: "15 */6 * * *",
      timezone: "UTC"
    },
    retention: {
      retentionDays: 30,
      minimumBackups: 8
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

async function writeJson(root: string, name: string, value: unknown) {
  const filePath = path.join(root, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function writeEvidenceFiles(root: string, prune: Record<string, unknown> = backupPrune()) {
  return {
    backupVerify: await writeJson(root, "backup-verify.json", backupVerify()),
    restoreDrill: await writeJson(root, "restore-drill.json", restoreDrill()),
    backupOffload: await writeJson(root, "backup-offload.json", backupOffload()),
    backupFetch: await writeJson(root, "backup-fetch.json", backupFetch()),
    providerSecurityAudit: await writeJson(root, "backup-provider-security-audit.json", providerSecurityAudit()),
    backupPrune: await writeJson(root, "backup-prune.json", prune),
    policy: await writeJson(root, "backup-policy.json", backupPolicy())
  };
}

describe("backupEvidenceCompose", () => {
  it("composes backup command outputs into the evidence shape accepted by backup:evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-compose-"));

    try {
      const files = await writeEvidenceFiles(root);
      const result = await composeBackupEvidence({
        backupVerifyPath: files.backupVerify,
        restoreDrillPath: files.restoreDrill,
        backupOffloadPath: files.backupOffload,
        backupFetchPath: files.backupFetch,
        providerSecurityAuditPath: files.providerSecurityAudit,
        backupPrunePath: files.backupPrune,
        policyPath: files.policy,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        requireOffHost: true,
        check: true,
        now
      });

      expect(result.status).toBe("composed");
      expect(result.exitCode).toBe(0);
      expect(result.evidence).toMatchObject({
        backupVerify: {
          status: "verified"
        },
        restoreDrill: {
          restoreDrill: true
        },
        backupOffload: {
          status: "offloaded"
        },
        backupFetch: {
          status: "fetched"
        },
        backupProviderSecurityAudit: {
          status: "passed"
        },
        backupPrune: {
          status: "pruned",
          dryRun: false
        },
        backupPolicy: {
          retention: {
            retentionDays: 30,
            minimumBackups: 8
          }
        },
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607"
      });
      expect(result.checkResult).toMatchObject({
        name: "siteflow-backup-evidence-check",
        status: "passed",
        thresholds: {
          requireOffHost: true
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes raw composed evidence and prints it from --json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-compose-cli-"));
    let stdout = "";
    let stderr = "";

    try {
      const files = await writeEvidenceFiles(root);
      const outputPath = path.join(root, "backup-evidence-raw.json");
      const exitCode = await runBackupEvidenceComposeCli(
        [
          "--backup-verify", files.backupVerify,
          "--restore-drill", files.restoreDrill,
          "--backup-offload", files.backupOffload,
          "--backup-fetch", files.backupFetch,
          "--provider-security-audit", files.providerSecurityAudit,
          "--backup-prune", files.backupPrune,
          "--policy", files.policy,
          "--operator-name", "release-operator",
          "--ticket-id", "REL-2026-0607",
          "--output", outputPath,
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { now }
      );
      const printed = JSON.parse(stdout);
      const written = JSON.parse(await readFile(outputPath, "utf8"));

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toEqual(written);
      expect(printed).toMatchObject({
        backupVerify: {
          status: "verified"
        },
        releaseTicket: "REL-2026-0607"
      });
      expect(printed.name).toBeUndefined();
      expect(printed.checks).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes checker output for release bundles when --check-output is provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-compose-check-"));

    try {
      const files = await writeEvidenceFiles(root);
      const rawOutputPath = path.join(root, "backup-evidence-raw.json");
      const checkOutputPath = path.join(root, "backup-evidence-check.json");
      const exitCode = await runBackupEvidenceComposeCli(
        [
          "--backup-verify", files.backupVerify,
          "--restore-drill", files.restoreDrill,
          "--backup-offload", files.backupOffload,
          "--backup-fetch", files.backupFetch,
          "--provider-security-audit", files.providerSecurityAudit,
          "--backup-prune", files.backupPrune,
          "--policy", files.policy,
          "--operator-name", "release-operator",
          "--release-ticket", "REL-2026-0607",
          "--require-off-host",
          "--output", rawOutputPath,
          "--check-output", checkOutputPath
        ],
        {
          stdout: { write: () => true },
          stderr: { write: () => true }
        },
        { now }
      );
      const raw = JSON.parse(await readFile(rawOutputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));
      const passedCheckNames = new Set(
        check.checks.filter((candidate: { status: string }) => candidate.status === "pass").map((candidate: { name: string }) => candidate.name)
      );

      expect(exitCode).toBe(0);
      expect(raw.name).toBeUndefined();
      expect(check).toMatchObject({
        name: "siteflow-backup-evidence-check",
        status: "passed",
        exitCode: 0,
        thresholds: {
          requireOffHost: true
        },
        selectedEvidence: {
          backupOffload: expect.any(Object),
          backupFetch: expect.any(Object),
          backupProviderSecurityAudit: expect.any(Object),
          backupPrune: expect.any(Object)
        }
      });
      for (const checkName of [
        "backup_offload_present",
        "backup_offload_status",
        "backup_offload_object_storage_provider",
        "backup_offload_kms_encryption",
        "backup_offload_provider_retention_contract",
        "backup_fetch_present",
        "backup_fetch_status",
        "backup_fetch_integrity",
        "restore_drill_from_fetched_backup",
        "backup_provider_security_audit_present",
        "backup_provider_security_audit_status",
        "backup_provider_security_audit_age",
        "backup_provider_security_audit_schema",
        "backup_provider_security_audit_source",
        "backup_provider_security_audit_no_raw_policy_material",
        "backup_provider_kms_key_policy",
        "backup_provider_bucket_policy",
        "backup_provider_lifecycle_policy",
        "backup_provider_cross_account_restore_access",
        "backup_provider_cross_account_restore_drill",
        "backup_prune_present",
        "backup_prune_status",
        "backup_prune_non_dry_run"
      ]) {
        expect(passedCheckNames.has(checkName)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks --require-off-host before composing when offload or prune input is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-compose-blocked-"));
    let stdout = "";
    let stderr = "";

    try {
      const files = await writeEvidenceFiles(root);
      const exitCode = await runBackupEvidenceComposeCli(
        [
          "--backup-verify", files.backupVerify,
          "--restore-drill", files.restoreDrill,
          "--policy", files.policy,
          "--operator-name", "release-operator",
          "--release-ticket", "REL-2026-0607",
          "--require-off-host",
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { now }
      );
      const parsed = JSON.parse(stdout);

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(parsed).toMatchObject({
        name: "siteflow-backup-evidence-compose",
        status: "blocked"
      });
      expect(parsed.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "off_host_inputs",
            status: "fail"
          })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns blocked checker output for dry-run prune evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-compose-dry-run-"));
    let stdout = "";

    try {
      const files = await writeEvidenceFiles(root, backupPrune({
        status: "planned",
        dryRun: true
      }));
      const checkOutputPath = path.join(root, "backup-evidence-check.json");
      const exitCode = await runBackupEvidenceComposeCli(
        [
          "--backup-verify", files.backupVerify,
          "--restore-drill", files.restoreDrill,
          "--backup-offload", files.backupOffload,
          "--backup-fetch", files.backupFetch,
          "--provider-security-audit", files.providerSecurityAudit,
          "--backup-prune", files.backupPrune,
          "--policy", files.policy,
          "--operator-name", "release-operator",
          "--release-ticket", "REL-2026-0607",
          "--require-off-host",
          "--check-output", checkOutputPath,
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: () => true }
        },
        { now }
      );
      const printed = JSON.parse(stdout);
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(exitCode).toBe(1);
      expect(printed).toMatchObject({
        status: "blocked",
        checkResult: {
          status: "blocked"
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-backup-evidence-check",
        status: "blocked",
        exitCode: 1
      });
      expect(check.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "backup_prune_non_dry_run",
            status: "fail"
          })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns usage errors for missing required options", () => {
    expect(() => parseBackupEvidenceComposeArgs(["--backup-verify", "verify.json"])).toThrow(
      "Missing required option"
    );
    expect(() => parseBackupEvidenceComposeArgs(["--backup-verify"])).toThrow(
      "--backup-verify requires a value"
    );
  });
});
