import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateBackupEvidence,
  runBackupEvidenceCheckCli
} from "./backupEvidenceCheck";

const now = () => new Date("2026-06-07T12:00:00.000Z");
const artifactTreeSha256 = "a".repeat(64);
const kmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    backupVerify: {
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
    },
    restoreDrill: {
      status: "restore_drilled",
      restoreDrill: true,
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
    },
    operatorName: "release-operator",
    releaseTicket: "REL-2026-0607",
    backupPolicy: {
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
    },
    ...overrides
  };
}

function validOffHostEvidence(overrides: Record<string, unknown> = {}) {
  return validEvidence({
    restoreDrill: {
      ...validEvidence().restoreDrill,
      backupPath: "/evidence/fetched-backups/siteflow-20260607"
    },
    backupOffload: {
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
    },
    backupFetch: {
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
    },
    backupProviderSecurityAudit: {
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
    },
    backupPrune: {
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
      deleted: []
    },
    ...overrides
  });
}

describe("backupEvidenceCheck", () => {
  it("passes when backup verify and restore-drill evidence are fresh and successful", () => {
    const result = evaluateBackupEvidence(validEvidence(), {
      evidencePath: "evidence.json",
      now,
      maxBackupAgeHours: 24,
      maxRestoreDrillAgeHours: 24
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(result.selectedEvidence.restoreDrill).toMatchObject({
      status: "restore_drilled",
      restoreDrill: true,
      timestamp: "2026-06-07T11:00:00.000Z"
    });
  });

  it("blocks failed backup verify evidence", () => {
    const result = evaluateBackupEvidence(
      validEvidence({
        backupVerify: {
          status: "failed",
          createdAt: "2026-06-07T10:30:00.000Z"
        }
      }),
      {
        evidencePath: "evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_verify_status",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing restore-drill evidence instead of passing static verification alone", () => {
    const result = evaluateBackupEvidence(
      {
        backupVerify: validEvidence().backupVerify
      },
      {
        evidencePath: "evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "restore_drill_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "restore_drill_flag",
          status: "fail"
        })
      ])
    );
  });

  it("blocks evidence that lacks required checksum and operator metadata", () => {
    const result = evaluateBackupEvidence(
      {
        backupVerify: {
          status: "verified",
          createdAt: "2026-06-07T10:30:00.000Z",
          backupPath: "/backups/siteflow-20260607"
        },
        restoreDrill: {
          status: "restore_drilled",
          restoreDrill: true,
          completedAt: "2026-06-07T11:00:00.000Z",
          durationMs: 2500,
          database: {
            target: "disposable_database"
          },
          artifacts: {
            target: "temporary_artifact_root",
            restoreMode: "replace_non_atomic"
          }
        }
      },
      {
        evidencePath: "evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_database_checksum",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_artifact_integrity",
          status: "fail"
        }),
        expect.objectContaining({
          name: "operator",
          status: "fail"
        }),
        expect.objectContaining({
          name: "ticket",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale backup and restore-drill evidence", () => {
    const result = evaluateBackupEvidence(
      validEvidence({
        backupVerify: {
          status: "verified",
          createdAt: "2026-06-05T10:00:00.000Z"
        },
        restoreDrill: {
          status: "restore_drilled",
          restoreDrill: true,
          completedAt: "2026-06-05T10:00:00.000Z"
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        maxBackupAgeHours: 24,
        maxRestoreDrillAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_age",
          status: "fail"
        }),
        expect.objectContaining({
          name: "restore_drill_age",
          status: "fail"
        })
      ])
    );
  });

  it("requires offload and prune evidence when off-host evidence is requested", () => {
    const withoutOffHost = evaluateBackupEvidence(validEvidence(), {
      evidencePath: "evidence.json",
      now,
      requireOffHost: true
    });
    const withOffHost = evaluateBackupEvidence(
      validOffHostEvidence(),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );

    expect(withoutOffHost.status).toBe("blocked");
    expect(withoutOffHost.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_offload_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_fetch_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_prune_present",
          status: "fail"
        })
      ])
    );
    expect(withOffHost.status).toBe("passed");
    expect(withOffHost.selectedEvidence.backupVerify?.offHostLocation).toBe("s3://siteflow-prod-backups/siteflow-20260607");
    expect(withOffHost.selectedEvidence.backupOffload).toMatchObject({
      status: "offloaded",
      backupPath: "/backups/siteflow-20260607",
      offHostLocation: "s3://siteflow-prod-backups/siteflow-20260607",
      provider: "s3",
      encrypted: true,
      kmsKeyRef,
      providerKmsProof: true,
      providerRetentionProof: true,
      providerRetentionDays: 30,
      providerRetentionMode: "compliance",
      retentionContract: "s3-object-lock-siteflow-prod"
    });
    expect(withOffHost.selectedEvidence.backupFetch).toMatchObject({
      status: "fetched",
      backupPath: "/evidence/fetched-backups/siteflow-20260607",
      offHostLocation: "s3://siteflow-prod-backups/siteflow-20260607",
      provider: "s3",
      treeSha256: "b".repeat(64),
      objectCount: 4,
      totalBytes: 512
    });
    expect(withOffHost.selectedEvidence.backupProviderSecurityAudit).toMatchObject({
      status: "passed",
      timestamp: "2026-06-07T11:16:00.000Z"
    });
    expect(withOffHost.selectedEvidence.backupPrune).toMatchObject({
      status: "pruned",
      retentionDays: 30,
      minimumBackups: 8,
      dryRun: false
    });
  });

  it("blocks missing, incomplete, or raw provider security audit evidence", () => {
    const missing = evaluateBackupEvidence(
      validOffHostEvidence({
        backupProviderSecurityAudit: undefined
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );
    const incomplete = evaluateBackupEvidence(
      validOffHostEvidence({
        backupProviderSecurityAudit: {
          schemaVersion: "siteflow.backupProviderSecurityAudit.v1",
          name: "siteflow-backup-provider-security-audit",
          status: "passed",
          checkedAt: "2026-06-07T11:16:00.000Z",
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
          }
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );
    const rawPolicy = evaluateBackupEvidence(
      validOffHostEvidence({
        backupProviderSecurityAudit: {
          ...(validOffHostEvidence().backupProviderSecurityAudit as Record<string, unknown>),
          policyDocument: {
            Statement: []
          }
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );

    expect(missing.status).toBe("blocked");
    expect(missing.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_provider_security_audit_present",
          status: "fail"
        })
      ])
    );
    expect(incomplete.status).toBe("blocked");
    expect(incomplete.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_provider_bucket_policy",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_provider_cross_account_restore_access",
          status: "fail"
        })
      ])
    );
    expect(rawPolicy.status).toBe("blocked");
    expect(rawPolicy.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_provider_security_audit_no_raw_policy_material",
          status: "fail"
        })
      ])
    );
  });

  it("blocks file offload, missing KMS evidence, and weak provider retention as production off-host evidence", () => {
    const fileOffload = evaluateBackupEvidence(
      validOffHostEvidence({
        backupOffload: {
          status: "offloaded",
          offloadedAt: "2026-06-07T11:10:00.000Z",
          backupPath: "/backups/siteflow-20260607",
          target: {
            provider: "file",
            location: "file:///mnt/offhost/siteflow-20260607",
            checksumVerified: true,
            treeSha256: "b".repeat(64),
            objectCount: 4,
            totalBytes: 512
          }
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );
    const missingKms = evaluateBackupEvidence(
      validOffHostEvidence({
        backupOffload: {
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
            providerRetention: {
              status: "enabled",
              mode: "compliance",
              retentionDays: 30,
              contractId: "s3-object-lock-siteflow-prod"
            }
          }
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );
    const weakRetention = evaluateBackupEvidence(
      validOffHostEvidence({
        backupOffload: {
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
              kmsKeyRef: "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups"
            },
            providerRetention: {
              status: "enabled",
              mode: "compliance",
              retentionDays: 7,
              contractId: "s3-object-lock-siteflow-prod"
            }
          }
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );

    expect(fileOffload.status).toBe("blocked");
    expect(fileOffload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_offload_object_storage_provider",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_offload_kms_encryption",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_offload_provider_retention_contract",
          status: "fail"
        })
      ])
    );
    expect(missingKms.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_offload_kms_encryption",
          status: "fail"
        })
      ])
    );
    expect(weakRetention.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_offload_provider_retention_contract",
          status: "fail"
        })
      ])
    );
  });

  it("blocks off-host evidence from dry-run prune output", () => {
    const result = evaluateBackupEvidence(
      validOffHostEvidence({
        backupPrune: {
          status: "planned",
          checkedAt: "2026-06-07T11:20:00.000Z",
          retentionDays: 30,
          minimumBackups: 8,
          dryRun: true,
          retained: [
            {
              backupPath: "/backups/siteflow-20260607"
            }
          ]
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_prune_status",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_prune_non_dry_run",
          status: "fail"
        })
      ])
    );
  });

  it("blocks off-host evidence when prune did not retain the verified backup", () => {
    const result = evaluateBackupEvidence(
      validOffHostEvidence({
        backupPrune: {
          status: "pruned",
          checkedAt: "2026-06-07T11:20:00.000Z",
          retentionDays: 30,
          minimumBackups: 8,
          dryRun: false,
          retained: [
            {
              backupPath: "/backups/siteflow-older"
            }
          ],
          deleted: [
            {
              backupPath: "/backups/siteflow-20260607"
            }
          ]
        }
      }),
      {
        evidencePath: "evidence.json",
        now,
        requireOffHost: true
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_prune_current_backup_retained",
          status: "fail"
        })
      ])
    );
  });

  it("blocks evidence without backup schedule, retention, RPO/RTO, and monitoring policy", () => {
    const result = evaluateBackupEvidence(
      validEvidence({
        backupPolicy: {
          schedule: {
            cron: "15 */6 * * *"
          },
          retention: {
            retentionDays: 0,
            minimumBackups: 0
          },
          objectives: {
            rpoHours: 0,
            rtoHours: 0
          },
          monitoring: {
            backupAgeAlertConfigured: true,
            restoreDrillAgeAlertConfigured: false,
            alertChannel: "",
            owner: ""
          }
        }
      }),
      {
        evidencePath: "evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_schedule",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_retention",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_objectives",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_monitoring",
          status: "fail"
        })
      ])
    );
  });

  it("blocks restore-drill evidence without matching restored artifact integrity", () => {
    const result = evaluateBackupEvidence(
      validEvidence({
        restoreDrill: {
          ...validEvidence().restoreDrill,
          artifacts: {
            target: "temporary_artifact_root",
            restoreMode: "replace_non_atomic",
            checksumVerified: true,
            treeSha256: "b".repeat(64),
            fileCount: 3,
            totalBytes: 128
          }
        }
      }),
      {
        evidencePath: "evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "restore_drill_artifact_integrity",
          status: "fail"
        })
      ])
    );
  });

  it("emits JSON from the CLI without requiring a real backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-evidence-"));
    const evidencePath = path.join(root, "evidence.json");
    let stdout = "";
    let stderr = "";

    try {
      await writeFile(evidencePath, `${JSON.stringify(validEvidence())}\n`, "utf8");

      const exitCode = await runBackupEvidenceCheckCli(
        ["--evidence", evidencePath, "--json"],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          now
        }
      );
      const parsed = JSON.parse(stdout);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(parsed).toMatchObject({
        name: "siteflow-backup-evidence-check",
        status: "passed",
        evidencePath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
