import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateObservabilityEvidence,
  requiredObservabilityEvidenceCheckNames,
  runObservabilityEvidenceCheckCli
} from "./observabilityEvidenceCheck";
import { requiredSiteFlowMetricNames } from "../src/lib/observabilityMetrics.ts";

const now = () => new Date("2026-06-07T12:00:00.000Z");
const commitRef = "abc123def456";
const repository = "acme/siteflow";
const branch = "main";
const prometheusScrapeSha = "a".repeat(64);
const prometheusRulesSha = "b".repeat(64);
const alertmanagerRouteSha = "c".repeat(64);
const grafanaDashboardSha = "d".repeat(64);
const backupAutomationRunPath = "evidence/backup-run/backup-automation-run.json";
const backupAutomationHistoryPath = "evidence/backup-history/backup-automation-history.json";

function observabilityProvisioning() {
  return {
    schemaVersion: "siteflow.observabilityProvisioning.v1",
    name: "siteflow-observability-provisioning-plan",
    generatedAt: "2026-06-07T11:30:00.000Z",
    target: {
      metricsPath: "/metrics",
      alertReceiverName: "siteflow-platform",
      grafanaDashboardUid: "siteflow-prod"
    },
    renderedAssets: [
      { path: "prometheus-scrape.yaml", kind: "prometheus_scrape", sha256: prometheusScrapeSha },
      {
        path: "prometheus-rules.yaml",
        kind: "prometheus_rules",
        sha256: prometheusRulesSha,
        content: "groups:\n  - name: siteflow\n    rules:\n      - alert: SiteFlowHighErrorRate\n"
      },
      { path: "alertmanager-route.yaml", kind: "alertmanager_route", sha256: alertmanagerRouteSha },
      { path: "grafana-dashboard.json", kind: "grafana_dashboard", sha256: grafanaDashboardSha }
    ]
  };
}

function observabilityApplyProof(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.observabilityApplyProof.v1",
    name: "siteflow-observability-apply-proof",
    status: "applied",
    appliedAt: "2026-06-07T11:40:00.000Z",
    evidenceSource: "target_stack_api",
    operator: "release-operator",
    ticket: "REL-2026-0607",
    provisioningPlan: {
        schemaVersion: "siteflow.observabilityProvisioning.v1",
        generatedAt: "2026-06-07T11:30:00.000Z",
        target: {
          metricsPath: "/metrics",
          alertReceiverName: "siteflow-platform",
          grafanaDashboardUid: "siteflow-prod"
        }
      },
    appliedAssets: [
      { path: "prometheus-scrape.yaml", kind: "prometheus_scrape", sha256: prometheusScrapeSha },
      { path: "prometheus-rules.yaml", kind: "prometheus_rules", sha256: prometheusRulesSha },
      { path: "alertmanager-route.yaml", kind: "alertmanager_route", sha256: alertmanagerRouteSha },
      { path: "grafana-dashboard.json", kind: "grafana_dashboard", sha256: grafanaDashboardSha }
    ],
    ...overrides
  };
}

function observabilityTargetStackProof(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.observabilityTargetStackProof.v1",
    name: "siteflow-observability-target-stack-proof",
    status: "passed",
    checkedAt: "2026-06-07T11:58:00.000Z",
    evidenceSource: "target_stack_api",
    operator: "release-operator",
    ticket: "REL-2026-0607",
    release: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production"
    },
    prometheusRules: {
      status: "passed",
      apiUrl: "https://prometheus.example.com/api/v1/rules",
      renderedAssetKind: "prometheus_rules",
      renderedAssetSha256: prometheusRulesSha,
      matchedAlertNames: ["SiteFlowHighErrorRate"],
      missingAlertNames: [],
      rulesHealth: "ok"
    },
    grafanaDashboard: {
      status: "passed",
      apiUrl: "https://grafana.example.com/api/dashboards/uid/siteflow-prod",
      dashboardUid: "siteflow-prod",
      dashboardUrl: "https://grafana.example.com/d/siteflow-prod",
      renderedAssetKind: "grafana_dashboard",
      renderedAssetSha256: grafanaDashboardSha,
      observedTitle: "SiteFlow Minimum Operations",
      matchedMetricNames: requiredSiteFlowMetricNames
    },
    alertmanagerReceiver: {
      status: "delivered",
      alertmanagerApiUrl: "https://alertmanager.example.com/api/v2/alerts",
      receiverName: "siteflow-platform",
      proofId: "siteflow-proof-20260607-001",
      sentAt: "2026-06-07T11:58:00.000Z",
      deliveredAt: "2026-06-07T11:58:03.000Z",
      receiverReceiptSha256: "e".repeat(64)
    },
    ...overrides
  };
}

function backupAutomationRunHistory(overrides: Record<string, unknown> = {}) {
  const currentRun = {
    runId: "2026-06-07T11-50-00.000Z-siteflow-20260607",
    status: "completed",
    startedAt: "2026-06-07T11:30:00.000Z",
    completedAt: "2026-06-07T11:50:00.000Z",
    restoreDrillCompletedAt: "2026-06-07T11:50:00.000Z",
    exitCode: 0,
    backupPath: "/backups/siteflow-20260607",
    evidenceFiles: {
      backupAutomationRun: backupAutomationRunPath,
      backupEvidenceCheck: "evidence/backup-evidence.json"
    },
    steps: [
      { id: "backup", status: "completed" },
      { id: "backup_verify", status: "completed" },
      { id: "restore_drill", status: "completed" },
      { id: "backup_offload", status: "completed" },
      { id: "backup_prune", status: "completed" },
      { id: "backup_evidence", status: "completed" }
    ],
    restoreDrillCompleted: true,
    backupEvidenceStatus: "passed",
    composeStatus: "composed"
  };

  return {
    schemaVersion: "siteflow.backupAutomationRunHistory.v1",
    name: "siteflow-backup-automation-run-history",
    updatedAt: "2026-06-07T11:50:00.000Z",
    cadence: {
      restoreDrillMaxGapHours: 168,
      minimumSuccessfulRestoreDrills: 2
    },
    evidenceFiles: {
      backupAutomationRunHistory: backupAutomationHistoryPath
    },
    runs: [
      {
        ...currentRun,
        runId: "2026-06-01T11-50-00.000Z-siteflow-20260601",
        startedAt: "2026-06-01T11:30:00.000Z",
        completedAt: "2026-06-01T11:50:00.000Z",
        restoreDrillCompletedAt: "2026-06-01T11:50:00.000Z",
        backupPath: "/backups/siteflow-20260601"
      },
      currentRun
    ],
    ...overrides
  };
}

function backupSchedulerOwnership(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.backupSchedulerOwnership.v1",
    name: "siteflow-backup-scheduler-ownership",
    status: "applied",
    checkedAt: "2026-06-07T11:55:00.000Z",
    evidenceSource: "systemd_timer",
    operator: "release-operator",
    ticket: "REL-2026-0607",
    release: {
      targetEnvironment: "production"
    },
    scheduler: {
      kind: "systemd_timer",
      id: "siteflow-backup.timer",
      enabled: true,
      schedule: "15 */6 * * *",
      timezone: "UTC",
      command: "npm run --silent backup:automation -- --run-record evidence/backup-run/backup-automation-run.json --run-history evidence/backup-history/backup-automation-history.json",
      evidenceFiles: {
        backupAutomationRun: backupAutomationRunPath,
        backupAutomationRunHistory: backupAutomationHistoryPath
      }
    },
    owner: "platform",
    alertTarget: "pager",
    ...overrides
  };
}

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    readinessProbe: {
      status: "passed",
      checkedAt: "2026-06-07T11:45:00.000Z",
      endpoint: "/readyz",
      healthyStatusCode: 200,
      failureStatusCode: 503,
      trafficRemovedOnFailure: true
    },
    metricsScrape: {
      status: "scraped",
      scrapedAt: "2026-06-07T11:46:00.000Z",
      endpoint: "/metrics",
      authenticated: true,
      metricNames: requiredSiteFlowMetricNames
    },
    backupAutomationRun: {
      name: "siteflow-backup-automation-run",
      status: "completed",
      startedAt: "2026-06-07T11:30:00.000Z",
      completedAt: "2026-06-07T11:50:00.000Z",
      exitCode: 0,
      evidenceFiles: {
        backupEvidenceCheck: "evidence/backup-evidence.json",
        backupAutomationRun: backupAutomationRunPath
      },
      steps: [
        { id: "backup", status: "completed" },
        { id: "backup_verify", status: "completed" },
        { id: "restore_drill", status: "completed" },
        { id: "backup_offload", status: "completed" },
        { id: "backup_prune_plan", status: "completed" },
        { id: "backup_prune", status: "completed" },
        { id: "backup_evidence", status: "completed" }
      ],
      composeResult: {
        status: "composed",
        checkResult: {
          status: "passed"
        }
      }
    },
    backupAutomationRunHistory: backupAutomationRunHistory(),
    backupSchedulerOwnership: backupSchedulerOwnership(),
    observabilityProvisioning: observabilityProvisioning(),
    observabilityApplyProof: observabilityApplyProof(),
    observabilityTargetStackProof: observabilityTargetStackProof(),
    alertDelivery: {
      status: "delivered",
      deliveredAt: "2026-06-07T11:47:00.000Z",
      delivered: true,
      channel: "pager"
    },
    dashboard: {
      status: "available",
      checkedAt: "2026-06-07T11:48:00.000Z",
      dashboardUid: "siteflow-prod",
      owner: "platform"
    },
    logPipeline: {
      status: "passed",
      checkedAt: "2026-06-07T11:49:00.000Z",
      retentionDays: 30,
      redactionSpotCheckPassed: true
    },
    ...overrides
  };
}

describe("observabilityEvidenceCheck", () => {
  it("passes when all production observability evidence is fresh and complete", () => {
    const result = evaluateObservabilityEvidence(validEvidence(), {
      evidencePath: "observability-evidence.json",
      now,
      maxAgeHours: 24
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(result.selectedEvidence.metricsScrape).toMatchObject({
      status: "scraped",
      timestamp: "2026-06-07T11:46:00.000Z",
      authenticated: true
    });
    expect(result.selectedEvidence.backupAutomationRun).toMatchObject({
      status: "completed",
      timestamp: "2026-06-07T11:50:00.000Z"
    });
    expect(result.selectedEvidence.backupAutomationRunHistory).toMatchObject({
      timestamp: "2026-06-07T11:50:00.000Z"
    });
    expect(result.selectedEvidence.backupSchedulerOwnership).toMatchObject({
      status: "applied",
      timestamp: "2026-06-07T11:55:00.000Z"
    });
    expect(result.selectedEvidence.observabilityApplyProof).toMatchObject({
      status: "applied",
      timestamp: "2026-06-07T11:40:00.000Z"
    });
    expect(result.selectedEvidence.observabilityTargetStackProof).toMatchObject({
      status: "passed",
      timestamp: "2026-06-07T11:58:00.000Z"
    });
  });

  it("exports a required-check contract covered by successful evaluator output", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        release: {
          commitRef,
          repository,
          branch,
          targetEnvironment: "production"
        }
      }),
      {
      evidencePath: "observability-evidence.json",
      now,
        maxAgeHours: 24,
        commitRef,
        repo: repository,
        branch,
        targetEnvironment: "production"
      }
    );
    const checkNames = new Set(result.checks.map((check) => check.name));

    expect(new Set(requiredObservabilityEvidenceCheckNames).size).toBe(requiredObservabilityEvidenceCheckNames.length);
    expect(requiredObservabilityEvidenceCheckNames).toEqual(
      expect.arrayContaining([
        "observability_apply_proof_non_dry_run",
        "observability_target_stack_proof_non_dry_run"
      ])
    );
    expect(requiredObservabilityEvidenceCheckNames.every((name) => checkNames.has(name))).toBe(true);
  });

  it("blocks raw secret-like values in merged observability evidence", () => {
    const evidence = validEvidence();
    const metricsScrape = evidence.metricsScrape as Record<string, unknown>;
    metricsScrape.authorization = "Bearer abcdefghijklmnop";
    const result = evaluateObservabilityEvidence(evidence, {
      evidencePath: "observability-evidence.json",
      now,
      maxAgeHours: 24
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

  it("passes release identity and target environment checks when expected metadata matches", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        release: {
          commitRef,
          repository,
          branch,
          targetEnvironment: "production"
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        commitRef,
        repo: repository,
        branch,
        targetEnvironment: "production",
        now
      }
    );

    expect(result.status).toBe("passed");
    expect(result.selectedEvidence).toMatchObject({
      commitRef,
      repository,
      branch,
      targetEnvironment: "production"
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release_identity",
          status: "pass"
        }),
        expect.objectContaining({
          name: "target_environment",
          status: "pass"
        })
      ])
    );
  });

  it("blocks observability evidence with mismatched release identity or target environment", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        release: {
          commitRef: "different-sha",
          repository,
          branch,
          targetEnvironment: "staging"
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        commitRef,
        repo: repository,
        branch,
        targetEnvironment: "production",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release_identity",
          status: "fail"
        }),
        expect.objectContaining({
          name: "target_environment",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing readiness traffic-removal evidence", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        readinessProbe: {
          status: "passed",
          checkedAt: "2026-06-07T11:45:00.000Z",
          healthyStatusCode: 200,
          failureStatusCode: 503
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "readiness_traffic_removed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks unauthenticated metrics evidence without a private-scrape exception", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        metricsScrape: {
          status: "scraped",
          scrapedAt: "2026-06-07T11:46:00.000Z",
          authenticated: false
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "metrics_access_control",
          status: "fail"
        })
      ])
    );
  });

  it("preserves metrics private-scrape exception evidence in the selected summary", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        metricsScrape: {
          status: "scraped",
          scrapedAt: "2026-06-07T11:46:00.000Z",
          endpoint: "/metrics",
          authenticated: false,
          privateScrapeException: true,
          observedStatusCode: 200,
          metricNames: requiredSiteFlowMetricNames
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(result.status).toBe("passed");
    expect(result.selectedEvidence.metricsScrape).toMatchObject({
      status: "scraped",
      timestamp: "2026-06-07T11:46:00.000Z",
      authenticated: false,
      privateScrapeException: true,
      observedStatusCode: 200
    });
  });

  it("blocks metrics evidence without the expected SiteFlow metric names", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        metricsScrape: {
          status: "scraped",
          scrapedAt: "2026-06-07T11:46:00.000Z",
          endpoint: "/metrics",
          authenticated: true,
          metricNames: [
            "siteflow_http_requests_total"
          ]
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "metrics_expected_names",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing or incomplete backup automation run evidence", () => {
    const missing = evaluateObservabilityEvidence(
      validEvidence({
        backupAutomationRun: undefined
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const incomplete = evaluateObservabilityEvidence(
      validEvidence({
        backupAutomationRun: {
          name: "siteflow-backup-automation-run",
          status: "failed",
          completedAt: "2026-06-07T11:50:00.000Z",
          exitCode: 1,
          steps: [
            { id: "backup", status: "completed" }
          ]
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(missing.status).toBe("blocked");
    expect(missing.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_automation_run_present",
          status: "fail"
        })
      ])
    );
    expect(incomplete.status).toBe("blocked");
    expect(incomplete.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_automation_run_status",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_automation_run_steps",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_automation_checker_output",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing or insufficient backup automation history", () => {
    const missing = evaluateObservabilityEvidence(
      validEvidence({
        backupAutomationRunHistory: undefined
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const insufficient = evaluateObservabilityEvidence(
      validEvidence({
        backupAutomationRunHistory: backupAutomationRunHistory({
          runs: [
            {
              runId: "2026-06-07T11-50-00.000Z-siteflow-20260607",
              status: "completed",
              completedAt: "2026-06-07T11:50:00.000Z",
              restoreDrillCompletedAt: "2026-06-07T11:50:00.000Z",
              exitCode: 0,
              steps: [
                { id: "restore_drill", status: "completed" },
                { id: "backup_evidence", status: "completed" }
              ],
              restoreDrillCompleted: true,
              backupEvidenceStatus: "passed"
            }
          ]
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(missing.status).toBe("blocked");
    expect(missing.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_automation_history_present",
          status: "fail"
        })
      ])
    );
    expect(insufficient.status).toBe("blocked");
    expect(insufficient.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_restore_drill_cadence_count",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing or mismatched backup scheduler ownership evidence", () => {
    const missing = evaluateObservabilityEvidence(
      validEvidence({
        backupSchedulerOwnership: undefined
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const mismatched = evaluateObservabilityEvidence(
      validEvidence({
        backupSchedulerOwnership: backupSchedulerOwnership({
          scheduler: {
            kind: "systemd_timer",
            id: "siteflow-backup.timer",
            enabled: true,
            schedule: "15 */6 * * *",
            timezone: "UTC",
            command: "npm run --silent backup:automation -- --run-record evidence/other/backup-automation-run.json",
            evidenceFiles: {
              backupAutomationRun: "evidence/other/backup-automation-run.json",
              backupAutomationRunHistory: backupAutomationHistoryPath
            }
          }
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const disabled = evaluateObservabilityEvidence(
      validEvidence({
        backupSchedulerOwnership: backupSchedulerOwnership({
          scheduler: {
            kind: "systemd_timer",
            id: "siteflow-backup.timer",
            enabled: false,
            schedule: "15 */6 * * *",
            timezone: "UTC",
            command: "npm run --silent backup:automation -- --run-record evidence/backup-run/backup-automation-run.json",
            evidenceFiles: {
              backupAutomationRun: backupAutomationRunPath,
              backupAutomationRunHistory: backupAutomationHistoryPath
            }
          }
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(missing.status).toBe("blocked");
    expect(missing.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_scheduler_ownership_present",
          status: "fail"
        })
      ])
    );
    expect(mismatched.status).toBe("blocked");
    expect(mismatched.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_scheduler_ownership_run_links",
          status: "fail"
        })
      ])
    );
    expect(disabled.status).toBe("blocked");
    expect(disabled.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_scheduler_ownership_enabled",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale or unavailable dashboard evidence", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        dashboard: {
          status: "unavailable",
          checkedAt: "2026-06-05T11:48:00.000Z",
          dashboardUid: "siteflow-prod",
          owner: "platform"
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now,
        maxAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "dashboard_status",
          status: "fail"
        }),
        expect.objectContaining({
          name: "dashboard_age",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing or mismatched observability apply proof", () => {
    const missing = evaluateObservabilityEvidence(
      validEvidence({
        observabilityApplyProof: undefined
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const mismatchedAsset = evaluateObservabilityEvidence(
      validEvidence({
        observabilityApplyProof: observabilityApplyProof({
          appliedAssets: [
            { path: "prometheus-scrape.yaml", kind: "prometheus_scrape", sha256: prometheusScrapeSha },
            { path: "prometheus-rules.yaml", kind: "prometheus_rules", sha256: "0".repeat(64) },
            { path: "alertmanager-route.yaml", kind: "alertmanager_route", sha256: alertmanagerRouteSha },
            { path: "grafana-dashboard.json", kind: "grafana_dashboard", sha256: grafanaDashboardSha }
          ]
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const dryRun = evaluateObservabilityEvidence(
      validEvidence({
        observabilityApplyProof: observabilityApplyProof({
          dryRun: true
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(missing.status).toBe("blocked");
    expect(missing.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_apply_proof_present",
          status: "fail"
        })
      ])
    );
    expect(mismatchedAsset.status).toBe("blocked");
    expect(mismatchedAsset.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_apply_proof_assets",
          status: "fail"
        })
      ])
    );
    expect(dryRun.status).toBe("blocked");
    expect(dryRun.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_apply_proof_non_dry_run",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing, mismatched, or incomplete target-stack proof", () => {
    const missing = evaluateObservabilityEvidence(
      validEvidence({
        observabilityTargetStackProof: undefined
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const mismatchedGrafanaAsset = evaluateObservabilityEvidence(
      validEvidence({
        observabilityTargetStackProof: observabilityTargetStackProof({
          grafanaDashboard: {
            ...(observabilityTargetStackProof().grafanaDashboard as Record<string, unknown>),
            renderedAssetSha256: "0".repeat(64)
          }
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const wrongReceiver = evaluateObservabilityEvidence(
      validEvidence({
        observabilityProvisioning: {
          ...observabilityProvisioning(),
          target: {
            ...(observabilityProvisioning().target as Record<string, unknown>),
            alertReceiverName: "siteflow-platform"
          }
        },
        observabilityTargetStackProof: observabilityTargetStackProof({
          alertmanagerReceiver: {
            ...(observabilityTargetStackProof().alertmanagerReceiver as Record<string, unknown>),
            receiverName: "different-receiver"
          }
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const partialPrometheusRules = evaluateObservabilityEvidence(
      validEvidence({
        observabilityProvisioning: {
          ...observabilityProvisioning(),
          renderedAssets: [
            { path: "prometheus-scrape.yaml", kind: "prometheus_scrape", sha256: prometheusScrapeSha },
            {
              path: "prometheus-rules.yaml",
              kind: "prometheus_rules",
              sha256: prometheusRulesSha,
              content: [
                "groups:",
                "  - name: siteflow",
                "    rules:",
                "      - alert: SiteFlowHighErrorRate",
                "      - alert: SiteFlowBackupAutomationStale",
                ""
              ].join("\n")
            },
            { path: "alertmanager-route.yaml", kind: "alertmanager_route", sha256: alertmanagerRouteSha },
            { path: "grafana-dashboard.json", kind: "grafana_dashboard", sha256: grafanaDashboardSha }
          ]
        },
        observabilityTargetStackProof: observabilityTargetStackProof({
          prometheusRules: {
            ...(observabilityTargetStackProof().prometheusRules as Record<string, unknown>),
            matchedAlertNames: ["SiteFlowHighErrorRate"],
            missingAlertNames: []
          }
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );
    const dryRun = evaluateObservabilityEvidence(
      validEvidence({
        observabilityTargetStackProof: observabilityTargetStackProof({
          mode: "dry-run"
        })
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(missing.status).toBe("blocked");
    expect(missing.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_target_stack_proof_present",
          status: "fail"
        })
      ])
    );
    expect(mismatchedGrafanaAsset.status).toBe("blocked");
    expect(mismatchedGrafanaAsset.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_target_stack_grafana_dashboard",
          status: "fail"
        })
      ])
    );
    expect(partialPrometheusRules.status).toBe("blocked");
    expect(partialPrometheusRules.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_target_stack_prometheus_rules",
          status: "fail"
        })
      ])
    );
    expect(dryRun.status).toBe("blocked");
    expect(dryRun.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_target_stack_proof_non_dry_run",
          status: "fail"
        })
      ])
    );
    expect(wrongReceiver.status).toBe("blocked");
    expect(wrongReceiver.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_target_stack_alertmanager_receiver",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale alert and log evidence", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        alertDelivery: {
          status: "delivered",
          deliveredAt: "2026-06-05T11:47:00.000Z",
          delivered: true,
          channel: "pager"
        },
        logPipeline: {
          status: "passed",
          checkedAt: "2026-06-05T11:49:00.000Z",
          retentionDays: 30,
          redactionSpotCheckPassed: true
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now,
        maxAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "alert_age",
          status: "fail"
        }),
        expect.objectContaining({
          name: "log_pipeline_age",
          status: "fail"
        })
      ])
    );
  });

  it("blocks log evidence without retention or redaction spot-check", () => {
    const result = evaluateObservabilityEvidence(
      validEvidence({
        logPipeline: {
          status: "passed",
          checkedAt: "2026-06-07T11:49:00.000Z",
          retentionDays: 0,
          redactionSpotCheckPassed: false
        }
      }),
      {
        evidencePath: "observability-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "log_retention",
          status: "fail"
        }),
        expect.objectContaining({
          name: "log_redaction_spot_check",
          status: "fail"
        })
      ])
    );
  });

  it("emits JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-evidence-"));
    const evidencePath = path.join(root, "evidence.json");
    let stdout = "";
    let stderr = "";

    try {
      await writeFile(evidencePath, `${JSON.stringify(validEvidence())}\n`, "utf8");

      const exitCode = await runObservabilityEvidenceCheckCli(
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
        name: "siteflow-observability-evidence-check",
        status: "passed",
        evidencePath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
