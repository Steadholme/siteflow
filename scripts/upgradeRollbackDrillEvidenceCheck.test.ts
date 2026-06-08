import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateUpgradeRollbackDrillEvidence,
  runUpgradeRollbackDrillEvidenceCheckCli
} from "./upgradeRollbackDrillEvidenceCheck";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck";

const now = () => new Date("2026-06-07T12:00:00.000Z");
const commitRef = "abc123def456";
const repository = "acme/siteflow";
const branch = "main";
const beforeApiDigest = `registry.local/siteflow/api@sha256:${"a".repeat(64)}`;
const afterApiDigest = `registry.local/siteflow/api@sha256:${"b".repeat(64)}`;
const beforeWorkerDigest = `registry.local/siteflow/worker@sha256:${"c".repeat(64)}`;
const afterWorkerDigest = `registry.local/siteflow/worker@sha256:${"d".repeat(64)}`;
const beforeArtifact = `sha256:${"e".repeat(64)}`;
const afterArtifact = `sha256:${"f".repeat(64)}`;
const backupKmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";

function validBackupEvidence() {
  return {
    name: "siteflow-backup-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T09:55:00.000Z",
    thresholds: {
      maxBackupAgeHours: 24,
      maxRestoreDrillAgeHours: 168,
      requireOffHost: true
    },
    selectedEvidence: {
      backupVerify: {
        status: "verified",
        backupPath: "/backups/siteflow-20260607",
        timestamp: "2026-06-07T09:45:00.000Z"
      },
      restoreDrill: {
        status: "restore_drilled",
        restoreDrill: true,
        timestamp: "2026-06-07T09:50:00.000Z"
      },
      backupOffload: {
        status: "offloaded",
        backupPath: "/backups/siteflow-20260607",
        offHostLocation: "s3://siteflow-prod-backups/siteflow-20260607",
        provider: "s3",
        encrypted: true,
        kmsKeyRef: backupKmsKeyRef,
        providerKmsProof: true,
        providerRetentionProof: true,
        providerRetentionDays: 30,
        providerRetentionMode: "compliance",
        retentionContract: "s3-object-lock-siteflow-prod"
      },
      backupFetch: {
        status: "fetched",
        backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260607",
        offHostLocation: "s3://siteflow-prod-backups/siteflow-20260607",
        provider: "s3",
        timestamp: "2026-06-07T09:52:00.000Z"
      },
      backupProviderSecurityAudit: {
        status: "passed",
        timestamp: "2026-06-07T09:53:00.000Z",
        schemaVersion: "siteflow.backupProviderSecurityAudit.v1",
        name: "siteflow-backup-provider-security-audit",
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
          completedAt: "2026-06-07T09:54:00.000Z",
          restoreAccountId: "444455556666",
          restoreRoleArn: "arn:aws:iam::444455556666:role/siteflow-restore",
          backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260607"
        }
      },
      backupPrune: {
        status: "pruned",
        dryRun: false,
        retentionDays: 30,
        minimumBackups: 8
      }
    },
    checks: [
      {
        name: "backup_verify_present",
        status: "pass",
        message: "backup verify present"
      },
      ...requiredOffHostBackupEvidenceCheckNames.map((name) => ({
        name,
        status: "pass",
        message: `${name} passed.`
      }))
    ],
    exitCode: 0
  };
}

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.upgradeRollbackDrill.v1",
    name: "siteflow-upgrade-rollback-drill",
    status: "passed",
    dryRun: false,
    startedAt: "2026-06-07T10:00:00.000Z",
    completedAt: "2026-06-07T11:00:00.000Z",
    targetEnvironment: "staging",
    release: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "staging",
      fromVersion: "0.1.0",
      toVersion: "0.1.1",
      rollbackVersion: "0.1.0",
      operatorName: "release-operator",
      releaseTicket: "REL-2026-0607"
    },
    services: {
      api: {
        before: {
          imageDigest: beforeApiDigest
        },
        after: {
          imageDigest: afterApiDigest
        },
        rollback: {
          imageDigest: beforeApiDigest
        }
      },
      worker: {
        before: {
          imageDigest: beforeWorkerDigest
        },
        after: {
          imageDigest: afterWorkerDigest
        },
        rollback: {
          imageDigest: beforeWorkerDigest
        }
      }
    },
    migrations: {
      before: {
        currentVersion: "019_build_job_leases"
      },
      after: {
        currentVersion: "020_operator_sessions"
      },
      rollback: {
        currentVersion: "020_operator_sessions"
      },
      rollbackCompatibilityVerified: true
    },
    backupEvidence: validBackupEvidence(),
    operations: {
      upgrade: {
        operationId: "op_upgrade_1",
        status: "succeeded",
        dryRun: false,
        completedAt: "2026-06-07T10:20:00.000Z"
      },
      rollback: {
        operationId: "op_rollback_1",
        status: "succeeded",
        dryRun: false,
        completedAt: "2026-06-07T10:50:00.000Z"
      }
    },
    route: {
      before: {
        deploymentId: "dep_previous",
        routeRevisionId: "route_rev_1",
        artifactChecksum: beforeArtifact
      },
      after: {
        deploymentId: "dep_candidate",
        routeRevisionId: "route_rev_2",
        artifactChecksum: afterArtifact
      },
      rollback: {
        deploymentId: "dep_previous",
        routeRevisionId: "route_rev_3",
        artifactChecksum: beforeArtifact
      }
    },
    httpVerification: {
      rollback: {
        status: "passed",
        checkedAt: "2026-06-07T10:55:00.000Z",
        statusCode: 200,
        deploymentId: "dep_previous",
        artifactChecksum: beforeArtifact
      }
    },
    readiness: {
      before: {
        status: "ready",
        statusCode: 200
      },
      after: {
        status: "ready",
        statusCode: 200
      },
      rollback: {
        status: "ready",
        statusCode: 200
      },
      trafficRemovedDuringUpgrade: true
    },
    observability: {
      metrics: {
        status: "scraped",
        rollbackObserved: true,
        rollbackOperationId: "op_rollback_1",
        scrapedAt: "2026-06-07T10:51:00.000Z"
      },
      logs: {
        status: "queried",
        rollbackOperationId: "op_rollback_1",
        queriedAt: "2026-06-07T10:52:00.000Z"
      },
      alertDelivery: {
        status: "delivered",
        channel: "pager",
        deliveredAt: "2026-06-07T10:53:00.000Z"
      }
    },
    ...overrides
  };
}

describe("upgradeRollbackDrillEvidenceCheck", () => {
  it("passes complete upgrade and rollback drill evidence", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence(), {
      evidencePath: "upgrade-rollback.json",
      now,
      commitRef,
      repo: repository,
      branch,
      targetEnvironment: "staging"
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(result.selectedEvidence).toMatchObject({
      commitRef,
      repository,
      branch,
      targetEnvironment: "staging",
      fromVersion: "0.1.0",
      toVersion: "0.1.1",
      rollbackVersion: "0.1.0",
      upgradeOperationId: "op_upgrade_1",
      rollbackOperationId: "op_rollback_1"
    });
  });

  it("blocks dry-run drill evidence", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({ dryRun: true }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "non_dry_run",
          status: "fail"
        })
      ])
    );
  });

  it("blocks template evidence explicitly", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({ template: true }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "not_template",
          status: "fail"
        })
      ])
    );
  });

  it("requires final passed status", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({ status: "completed" }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "status_final",
          status: "fail"
        })
      ])
    );
  });

  it("blocks raw secret-like values in drill attachments", () => {
    const evidence = validEvidence();
    const observability = evidence.observability as Record<string, unknown>;
    observability.authorization = "Bearer abcdefghijklmnop";
    const result = evaluateUpgradeRollbackDrillEvidence(evidence, {
      evidencePath: "upgrade-rollback.json",
      now
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
      ])
    );
    expect(serialized).not.toContain("abcdefghijklmnop");
  });

  it("blocks release identity mismatches", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence(), {
      evidencePath: "upgrade-rollback.json",
      now,
      commitRef: "different",
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release_identity",
          status: "fail"
        })
      ])
    );
  });

  it("blocks target environment mismatches", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence(), {
      evidencePath: "upgrade-rollback.json",
      now,
      targetEnvironment: "production"
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "target_environment",
          status: "fail",
          message: "Drill evidence target environment must be production."
        })
      ])
    );
  });

  it("blocks unordered drill phase timestamps", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({
      operations: {
        upgrade: {
          operationId: "op_upgrade_1",
          status: "succeeded",
          dryRun: false,
          completedAt: "2026-06-07T10:55:00.000Z"
        },
        rollback: {
          operationId: "op_rollback_1",
          status: "succeeded",
          dryRun: false,
          completedAt: "2026-06-07T10:50:00.000Z"
        }
      }
    }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "drill_time_order",
          status: "fail"
        })
      ])
    );
  });

  it("blocks reused upgrade and rollback operation ids", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({
      operations: {
        upgrade: {
          operationId: "op_same",
          status: "succeeded",
          dryRun: false,
          completedAt: "2026-06-07T10:20:00.000Z"
        },
        rollback: {
          operationId: "op_same",
          status: "succeeded",
          dryRun: false,
          completedAt: "2026-06-07T10:50:00.000Z"
        }
      }
    }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release_operations",
          status: "fail"
        })
      ])
    );
  });

  it("blocks evidence without rollback route restoration", () => {
    const evidence = validEvidence({
      route: {
        before: {
          deploymentId: "dep_previous",
          artifactChecksum: beforeArtifact
        },
        after: {
          deploymentId: "dep_candidate",
          artifactChecksum: afterArtifact
        },
        rollback: {
          deploymentId: "dep_candidate",
          artifactChecksum: afterArtifact
        }
      }
    });

    const result = evaluateUpgradeRollbackDrillEvidence(evidence, {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "route_rollback_restores_previous_artifact",
          status: "fail"
        }),
        expect.objectContaining({
          name: "http_rollback_verification",
          status: "fail"
        })
      ])
    );
  });

  it("blocks evidence without migration versions and rollback compatibility", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({ migrations: {} }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "migration_versions",
          status: "fail"
        }),
        expect.objectContaining({
          name: "schema_rollback_compatibility",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale drill evidence and missing operator or ticket", () => {
    const evidence = validEvidence({
      completedAt: "2026-05-01T11:00:00.000Z",
      release: {
        commitRef,
        repository,
        branch,
        targetEnvironment: "staging",
        fromVersion: "0.1.0",
        toVersion: "0.1.1",
        rollbackVersion: "0.1.0"
      }
    });

    const result = evaluateUpgradeRollbackDrillEvidence(evidence, {
      evidencePath: "upgrade-rollback.json",
      now,
      maxAgeHours: 24
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "drill_age",
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

  it("blocks evidence without passed off-host backup evidence", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({
      backupEvidence: {
        ...validBackupEvidence(),
        thresholds: {
          requireOffHost: false
        }
      }
    }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_evidence_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks passed backup evidence when embedded backup checks failed", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({
      backupEvidence: {
        ...validBackupEvidence(),
        checks: [
          {
            name: "backup_shape",
            status: "fail",
            message: "missing selected evidence"
          }
        ]
      }
    }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_evidence_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks rollback log evidence for the wrong operation id", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({
      observability: {
        metrics: {
          status: "scraped",
          rollbackObserved: true,
          rollbackOperationId: "op_rollback_1",
          scrapedAt: "2026-06-07T10:51:00.000Z"
        },
        logs: {
          status: "queried",
          rollbackOperationId: "op_other",
          queriedAt: "2026-06-07T10:52:00.000Z"
        },
        alertDelivery: {
          status: "delivered",
          channel: "pager",
          deliveredAt: "2026-06-07T10:53:00.000Z"
        }
      }
    }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "logs_evidence",
          status: "fail"
        })
      ])
    );
  });

  it("blocks rollback observability evidence without fresh timestamps", () => {
    const result = evaluateUpgradeRollbackDrillEvidence(validEvidence({
      observability: {
        metrics: {
          status: "scraped",
          rollbackObserved: true,
          rollbackOperationId: "op_rollback_1"
        },
        logs: {
          status: "queried",
          rollbackOperationId: "op_rollback_1"
        },
        alertDelivery: {
          status: "delivered",
          channel: "pager"
        }
      }
    }), {
      evidencePath: "upgrade-rollback.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "metrics_evidence",
          status: "fail"
        }),
        expect.objectContaining({
          name: "logs_evidence",
          status: "fail"
        }),
        expect.objectContaining({
          name: "alert_evidence",
          status: "fail"
        })
      ])
    );
  });

  it("emits JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-upgrade-rollback-"));
    const evidencePath = path.join(root, "upgrade-rollback.json");
    let stdout = "";
    let stderr = "";

    try {
      await writeFile(evidencePath, `${JSON.stringify(validEvidence())}\n`, "utf8");

      const exitCode = await runUpgradeRollbackDrillEvidenceCheckCli(
        [
          "--evidence", evidencePath,
          "--commit-ref", commitRef,
          "--repo", repository,
          "--branch", branch,
          "--target-environment", "staging",
          "--json"
        ],
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
        name: "siteflow-upgrade-rollback-drill-evidence-check",
        status: "passed",
        evidencePath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
