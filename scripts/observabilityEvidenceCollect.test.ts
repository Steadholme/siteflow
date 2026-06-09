import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectObservabilityEvidence,
  parseObservabilityEvidenceCollectArgs,
  parsePrometheusMetricNames,
  runObservabilityEvidenceCollectCli,
  type ObservabilityEvidenceFetch
} from "./observabilityEvidenceCollect";
import { requiredSiteFlowMetricNames } from "../src/lib/observabilityMetrics.ts";

const now = () => new Date("2026-06-07T12:00:00.000Z");
const metricsToken = "siteflow-metrics-token-1234567890";
const targetStackToken = "siteflow-target-stack-token-1234567890";
const commitRef = "abc123def456";
const repository = "acme/siteflow";
const branch = "main";
const prometheusScrapeSha = "a".repeat(64);
const prometheusRulesSha = "b".repeat(64);
const alertmanagerRouteSha = "c".repeat(64);
const grafanaDashboardSha = "d".repeat(64);
const backupAutomationRunRecordPath = "evidence/backup-run/backup-automation-run.json";
const backupAutomationRunHistoryRecordPath = "evidence/backup-history/backup-automation-history.json";

function metricsText() {
  return [
    "# HELP siteflow_http_requests_total Total SiteFlow HTTP requests.",
    "# TYPE siteflow_http_requests_total counter",
    "siteflow_http_requests_total 5",
    "siteflow_http_5xx_total 0",
    "siteflow_http_429_total 0",
    "siteflow_http_request_duration_ms_sum 12.5",
    "siteflow_http_request_duration_ms_count 5 1780843200000",
    "siteflow_build_jobs_queued{queue=\"default\"} 1",
    "siteflow_build_jobs_running 0",
    "siteflow_build_jobs_stale 0",
    "siteflow_build_job_oldest_queued_age_seconds 1.5e2",
    "siteflow_build_job_oldest_running_heartbeat_age_seconds 0",
    "siteflow_runtime_metrics_collection_error 0",
    "siteflow_storage_artifact_free_bytes 10737418240",
    "siteflow_storage_evidence_free_bytes 5368709120",
    "siteflow_storage_temp_free_bytes 268435456",
    "siteflow_storage_missing_paths 0",
    "siteflow_storage_metrics_collection_error 0",
    "siteflow_backup_automation_last_success_age_seconds 600",
    "siteflow_backup_restore_drill_last_success_age_seconds 900",
    "siteflow_backup_offload_last_success_age_seconds 800",
    "siteflow_backup_prune_last_success_age_seconds 700",
    "siteflow_backup_offload_last_run_failed 0",
    "siteflow_backup_prune_last_run_failed 0",
    "siteflow_backup_metrics_collection_error 0",
    "# ignored comment",
    ""
  ].join("\n");
}

function backupAutomationRun() {
  return {
    name: "siteflow-backup-automation-run",
    status: "completed",
    startedAt: "2026-06-07T11:30:00.000Z",
    completedAt: "2026-06-07T11:50:00.000Z",
    exitCode: 0,
    evidenceDir: "evidence/backup-run",
    evidenceFiles: {
      backupVerify: "evidence/backup-run/backup-verify.json",
      restoreDrill: "evidence/backup-run/restore-drill.json",
      backupOffload: "evidence/backup-run/backup-offload.json",
      backupPrune: "evidence/backup-run/backup-prune.json",
      backupEvidenceCheck: "evidence/backup-run/backup-evidence.json",
      backupAutomationRun: backupAutomationRunRecordPath
    },
    steps: [
      { id: "backup", status: "completed", outputPath: "evidence/backup-run/backup.json" },
      { id: "backup_verify", status: "completed", outputPath: "evidence/backup-run/backup-verify.json" },
      { id: "restore_drill", status: "completed", outputPath: "evidence/backup-run/restore-drill.json" },
      { id: "backup_offload", status: "completed", outputPath: "evidence/backup-run/backup-offload.json" },
      { id: "backup_prune_plan", status: "completed", outputPath: "evidence/backup-run/backup-prune-plan.json" },
      { id: "backup_prune", status: "completed", outputPath: "evidence/backup-run/backup-prune.json" },
      { id: "backup_evidence", status: "completed", outputPath: "evidence/backup-run/backup-evidence.json" }
    ],
    composeResult: {
      status: "composed",
      checkedAt: "2026-06-07T11:51:00.000Z",
      checkResult: {
        name: "siteflow-backup-evidence-check",
        status: "passed",
        checkedAt: "2026-06-07T11:51:00.000Z",
        exitCode: 0
      }
    }
  };
}

function backupAutomationRunHistory() {
  const currentRun = {
    runId: "2026-06-07T11-50-00.000Z-siteflow-20260607",
    status: "completed",
    startedAt: "2026-06-07T11:30:00.000Z",
    completedAt: "2026-06-07T11:50:00.000Z",
    restoreDrillCompletedAt: "2026-06-07T11:50:00.000Z",
    exitCode: 0,
    evidenceFiles: {
      backupAutomationRun: "evidence/backup-run/backup-automation-run.json",
      backupEvidenceCheck: "evidence/backup-run/backup-evidence.json"
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
      backupAutomationRunHistory: backupAutomationRunHistoryRecordPath
    },
    runs: [
      {
        ...currentRun,
        runId: "2026-06-01T11-50-00.000Z-siteflow-20260601",
        startedAt: "2026-06-01T11:30:00.000Z",
        completedAt: "2026-06-01T11:50:00.000Z",
        restoreDrillCompletedAt: "2026-06-01T11:50:00.000Z"
      },
      currentRun
    ]
  };
}

function backupSchedulerOwnership() {
  return {
    schemaVersion: "siteflow.backupSchedulerOwnership.v1",
    name: "siteflow-backup-scheduler-ownership",
    status: "applied",
    checkedAt: "2026-06-07T11:58:00.000Z",
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
        backupAutomationRun: backupAutomationRunRecordPath,
        backupAutomationRunHistory: backupAutomationRunHistoryRecordPath
      }
    },
    owner: "platform",
    alertTarget: "pager"
  };
}

function operatorEvidence() {
  return {
    readinessProbe: {
      failureStatusCode: 503,
      trafficRemovedOnFailure: true
    },
    backupAutomationRunHistory: backupAutomationRunHistory(),
    backupSchedulerOwnership: backupSchedulerOwnership(),
    alertDelivery: {
      status: "delivered",
      deliveredAt: "2026-06-07T11:58:00.000Z",
      delivered: true,
      channel: "pager"
    },
    observabilityProvisioning: {
      schemaVersion: "siteflow.observabilityProvisioning.v1",
      name: "siteflow-observability-provisioning-plan",
      generatedAt: "2026-06-07T11:30:00.000Z",
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
    },
    observabilityApplyProof: {
      schemaVersion: "siteflow.observabilityApplyProof.v1",
      name: "siteflow-observability-apply-proof",
      status: "applied",
      appliedAt: "2026-06-07T11:57:00.000Z",
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
      ]
    },
    observabilityTargetStackProof: {
      ...targetStackProof(),
      schemaVersion: "siteflow.observabilityTargetStackProof.v1",
      name: "siteflow-observability-target-stack-proof",
      checkedAt: "2026-06-07T11:58:00.000Z",
      evidenceSource: "target_stack_api",
      operator: "release-operator",
      ticket: "REL-2026-0607"
    },
    dashboard: {
      status: "available",
      checkedAt: "2026-06-07T11:58:00.000Z",
      dashboardUid: "siteflow-prod",
      owner: "platform"
    },
    logPipeline: {
      status: "passed",
      checkedAt: "2026-06-07T11:58:00.000Z",
      retentionDays: 30,
      redactionSpotCheckPassed: true
    },
    backupAutomationRun: backupAutomationRun()
  };
}

function targetStackProof() {
  return {
    status: "passed",
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
      sentAt: "2026-06-07T11:59:00.000Z",
      deliveredAt: "2026-06-07T11:59:03.000Z",
      receiverReceiptSha256: "e".repeat(64)
    }
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function textResponse(status: number, body: string) {
  return {
    status,
    json: async () => JSON.parse(body),
    text: async () => body
  };
}

function makeFetch(options: { metricsStatus?: number; readinessStatus?: number; readinessBody?: unknown; targetStackStatus?: number; targetStackBody?: unknown } = {}) {
  const calls: Array<{ input: string; init?: { method?: string; headers?: Record<string, string> } }> = [];
  const fetchImpl: ObservabilityEvidenceFetch = async (input, init) => {
    calls.push({ input, init });

    if (input.endsWith("/readyz")) {
      return jsonResponse(options.readinessStatus ?? 200, options.readinessBody ?? { status: "ready" });
    }

    if (input.endsWith("/metrics")) {
      return textResponse(options.metricsStatus ?? 200, metricsText());
    }

    if (input === "https://observability.example.com/siteflow-proof") {
      return jsonResponse(options.targetStackStatus ?? 200, options.targetStackBody ?? targetStackProof());
    }

    return textResponse(404, "not found");
  };

  return { fetchImpl, calls };
}

describe("observabilityEvidenceCollect", () => {
  it("parses Prometheus metric names from TYPE lines, samples, labels, duplicates, and timestamps", () => {
    expect(parsePrometheusMetricNames([
      "# HELP siteflow_http_requests_total helper",
      "# TYPE siteflow_http_requests_total counter",
      "siteflow_http_requests_total 1",
      "siteflow_http_requests_total{method=\"GET\"} 2 1780843200000",
      "siteflow_runtime_metrics_collection_error 0",
      "not a metric",
      ""
    ].join("\n"))).toEqual([
      "siteflow_http_requests_total",
      "siteflow_runtime_metrics_collection_error"
    ]);
  });

  it("collects readiness and authenticated metrics evidence without storing tokens or raw metrics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-collect-run-"));
    const { fetchImpl, calls } = makeFetch();

    try {
      const backupAutomationRunPath = path.join(root, "backup-automation-run.json");
      const operatorEvidencePath = path.join(root, "operator-observability.json");

      await writeFile(backupAutomationRunPath, `${JSON.stringify(backupAutomationRun(), null, 2)}\n`, "utf8");
      await writeFile(operatorEvidencePath, `${JSON.stringify(operatorEvidence(), null, 2)}\n`, "utf8");

      const result = await collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com?token=do-not-store",
        env: {
          SITEFLOW_METRICS_TOKEN: metricsToken,
          SITEFLOW_OBSERVABILITY_STACK_TOKEN: targetStackToken
        },
        fetchImpl,
        operatorEvidencePath,
        backupAutomationRunPath,
        commitRef,
        repo: repository,
        branch,
        targetEnvironment: "production",
        targetStackApiUrl: "https://observability.example.com/siteflow-proof",
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        readinessFailureStatusCode: 503,
        trafficRemovedOnFailure: true,
        alertDelivered: true,
        alertChannel: "pager",
        dashboardUid: "siteflow-prod",
        dashboardOwner: "platform",
        logRetentionDays: 30,
        logRedactionSpotCheckPassed: true,
        check: true,
        now
      });
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("collected");
      expect(result.exitCode).toBe(0);
      expect(result.evidence).toMatchObject({
        readinessProbe: {
          status: "passed",
          checkedAt: "2026-06-07T12:00:00.000Z",
          endpoint: "/readyz",
          healthyStatusCode: 200,
          failureStatusCode: 503,
          trafficRemovedOnFailure: true
        },
        metricsScrape: {
          status: "scraped",
          scrapedAt: "2026-06-07T12:00:00.000Z",
          endpoint: "/metrics",
          authenticated: true
        },
        backupAutomationRun: {
          name: "siteflow-backup-automation-run",
          status: "completed",
          completedAt: "2026-06-07T11:50:00.000Z"
        },
        backupSchedulerOwnership: {
          schemaVersion: "siteflow.backupSchedulerOwnership.v1",
          name: "siteflow-backup-scheduler-ownership",
          status: "applied"
        },
        observabilityTargetStackProof: {
          schemaVersion: "siteflow.observabilityTargetStackProof.v1",
          name: "siteflow-observability-target-stack-proof",
          status: "passed",
          evidenceSource: "target_stack_api",
          operator: "release-operator",
          ticket: "REL-2026-0607"
        }
      });
      expect(new Set((result.evidence?.metricsScrape as { metricNames: string[] }).metricNames)).toEqual(
        new Set(requiredSiteFlowMetricNames)
      );
      expect(result.checkResult).toMatchObject({
        status: "passed",
        exitCode: 0
      });
      expect(calls.find((call) => call.input.endsWith("/metrics"))?.init?.headers).toEqual({
        authorization: `Bearer ${metricsToken}`
      });
      expect(calls.find((call) => call.input === "https://observability.example.com/siteflow-proof")?.init?.headers).toEqual({
        authorization: `Bearer ${targetStackToken}`
      });
      expect(serialized).not.toContain(metricsToken);
      expect(serialized).not.toContain(targetStackToken);
      expect(serialized).not.toContain("do-not-store");
      expect(serialized).not.toContain("siteflow_http_requests_total 5");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects authenticated metrics evidence from SITEFLOW_METRICS_TOKEN_FILE", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-token-file-"));
    const { fetchImpl, calls } = makeFetch();

    try {
      const tokenPath = path.join(root, "metrics-token.secret");
      await writeFile(tokenPath, `${metricsToken}\n`, "utf8");

      const result = await collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        env: {
          SITEFLOW_METRICS_TOKEN_FILE: tokenPath
        },
        fetchImpl,
        now
      });
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("collected");
      expect(result.evidence).toMatchObject({
        metricsScrape: {
          status: "scraped",
          authenticated: true
        }
      });
      expect(calls.find((call) => call.input.endsWith("/metrics"))?.init?.headers).toEqual({
        authorization: `Bearer ${metricsToken}`
      });
      expect(serialized).not.toContain(metricsToken);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non backup automation evidence passed as the automation run record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-collect-invalid-run-"));
    const invalidRunPath = path.join(root, "backup-evidence.json");

    try {
      await writeFile(invalidRunPath, `${JSON.stringify({
        name: "siteflow-backup-evidence-check",
        status: "passed"
      })}\n`, "utf8");

      await expect(collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        env: {},
        fetchImpl: makeFetch().fetchImpl,
        backupAutomationRunPath: invalidRunPath,
        now
      })).rejects.toThrow("must contain siteflow-backup-automation-run evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non scheduler ownership evidence passed as the scheduler ownership input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-collect-invalid-scheduler-"));
    const invalidSchedulerPath = path.join(root, "operator-observability.json");

    try {
      await writeFile(invalidSchedulerPath, `${JSON.stringify({
        name: "siteflow-observability-evidence-check",
        status: "passed"
      })}\n`, "utf8");

      await expect(collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        env: {},
        fetchImpl: makeFetch().fetchImpl,
        backupSchedulerOwnershipPath: invalidSchedulerPath,
        now
      })).rejects.toThrow("must contain siteflow-backup-scheduler-ownership evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges operator evidence and writes checker output for release bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-collect-"));
    const { fetchImpl } = makeFetch();

    try {
      const operatorEvidencePath = path.join(root, "operator-observability.json");
      const backupAutomationHistoryPath = path.join(root, "backup-automation-history.json");
      const backupSchedulerOwnershipPath = path.join(root, "backup-scheduler-ownership.json");
      const outputPath = path.join(root, "observability-evidence-raw.json");
      const checkOutputPath = path.join(root, "observability-evidence-check.json");
      const operator = operatorEvidence();
      delete (operator as Record<string, unknown>).backupAutomationRunHistory;
      delete (operator as Record<string, unknown>).backupSchedulerOwnership;

      await writeFile(operatorEvidencePath, `${JSON.stringify(operator, null, 2)}\n`, "utf8");
      await writeFile(backupAutomationHistoryPath, `${JSON.stringify(backupAutomationRunHistory(), null, 2)}\n`, "utf8");
      await writeFile(backupSchedulerOwnershipPath, `${JSON.stringify(backupSchedulerOwnership(), null, 2)}\n`, "utf8");

      const exitCode = await runObservabilityEvidenceCollectCli(
        [
          "--base-url", "https://siteflow.example.com",
          "--operator-evidence", operatorEvidencePath,
          "--backup-automation-history", backupAutomationHistoryPath,
          "--backup-scheduler-ownership", backupSchedulerOwnershipPath,
          "--commit-ref", "abc123def456",
          "--repo", "acme/siteflow",
          "--branch", "main",
          "--target-environment", "production",
          "--target-stack-api-url", "https://observability.example.com/siteflow-proof",
          "--operator-name", "release-operator",
          "--release-ticket", "REL-2026-0607",
          "--output", outputPath,
          "--check-output", checkOutputPath,
          "--json"
        ],
        {
          stdout: { write: () => true },
          stderr: { write: () => true }
        },
        {
          env: {
            SITEFLOW_METRICS_TOKEN: metricsToken,
            SITEFLOW_OBSERVABILITY_STACK_TOKEN: targetStackToken
          },
          fetchImpl,
          now
        }
      );
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(exitCode).toBe(0);
      expect(raw).toMatchObject({
        release: {
          commitRef: "abc123def456",
          repository: "acme/siteflow",
          branch: "main",
          targetEnvironment: "production"
        },
        readinessProbe: {
          status: "passed",
          failureStatusCode: 503,
          trafficRemovedOnFailure: true
        },
        alertDelivery: {
          status: "delivered",
          channel: "pager"
        },
        observabilityApplyProof: {
          status: "applied"
        },
        observabilityTargetStackProof: {
          status: "passed"
        },
        dashboard: {
          dashboardUid: "siteflow-prod",
          owner: "platform"
        },
        logPipeline: {
          retentionDays: 30,
          redactionSpotCheckPassed: true
        },
        backupAutomationRun: {
          name: "siteflow-backup-automation-run",
          status: "completed"
        },
        backupAutomationRunHistory: {
          name: "siteflow-backup-automation-run-history"
        },
        backupSchedulerOwnership: {
          name: "siteflow-backup-scheduler-ownership",
          status: "applied"
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-observability-evidence-check",
        status: "passed",
        exitCode: 0,
        selectedEvidence: {
          commitRef: "abc123def456",
          repository: "acme/siteflow",
          branch: "main",
          targetEnvironment: "production",
          readinessProbe: expect.any(Object),
          metricsScrape: expect.any(Object),
          backupAutomationRun: expect.any(Object),
          backupAutomationRunHistory: expect.any(Object),
          backupSchedulerOwnership: expect.any(Object),
          observabilityApplyProof: expect.any(Object),
          observabilityTargetStackProof: expect.any(Object),
          alertDelivery: expect.any(Object),
          dashboard: expect.any(Object),
          logPipeline: expect.any(Object)
        }
      });
      expect(check.checks).toEqual(
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks raw secret-like operator evidence before writing collector outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-collect-secret-"));
    const { fetchImpl } = makeFetch();

    try {
      const operatorEvidencePath = path.join(root, "operator-observability.json");
      const outputPath = path.join(root, "observability-evidence-raw.json");
      const checkOutputPath = path.join(root, "observability-evidence-check.json");
      const operator = operatorEvidence();
      operator.dashboard = {
        ...(operator.dashboard as Record<string, unknown>),
        authorization: "Bearer abcdefghijklmnop"
      };

      await writeFile(operatorEvidencePath, `${JSON.stringify(operator, null, 2)}\n`, "utf8");

      const result = await collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        env: {
          SITEFLOW_METRICS_TOKEN: metricsToken,
          SITEFLOW_OBSERVABILITY_STACK_TOKEN: targetStackToken
        },
        fetchImpl,
        operatorEvidencePath,
        targetStackApiUrl: "https://observability.example.com/siteflow-proof",
        outputPath,
        checkOutputPath,
        now
      });
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("blocked");
      expect(result.evidence).toBeUndefined();
      expect(result.checkResult).toBeUndefined();
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
        ])
      );
      await expect(readFile(outputPath, "utf8")).rejects.toThrow();
      await expect(readFile(checkOutputPath, "utf8")).rejects.toThrow();
      expect(serialized).not.toContain("abcdefghijklmnop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks raw secret-like target-stack API proof before writing collector outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-target-secret-"));
    const { fetchImpl } = makeFetch({
      targetStackBody: {
        ...targetStackProof(),
        rawSecret: "SITEFLOW_SECRET_CANARY_20260515"
      }
    });

    try {
      const operatorEvidencePath = path.join(root, "operator-observability.json");
      const outputPath = path.join(root, "observability-evidence-raw.json");
      const checkOutputPath = path.join(root, "observability-evidence-check.json");

      await writeFile(operatorEvidencePath, `${JSON.stringify(operatorEvidence(), null, 2)}\n`, "utf8");

      const result = await collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        env: {
          SITEFLOW_METRICS_TOKEN: metricsToken,
          SITEFLOW_OBSERVABILITY_STACK_TOKEN: targetStackToken
        },
        fetchImpl,
        operatorEvidencePath,
        targetStackApiUrl: "https://observability.example.com/siteflow-proof",
        outputPath,
        checkOutputPath,
        now
      });
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("blocked");
      expect(result.evidence).toBeUndefined();
      expect(result.checkResult).toBeUndefined();
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
        ])
      );
      await expect(readFile(outputPath, "utf8")).rejects.toThrow();
      await expect(readFile(checkOutputPath, "utf8")).rejects.toThrow();
      expect(serialized).not.toContain("SITEFLOW_SECRET_CANARY_20260515");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks the checker when operator traffic-removal evidence is missing", async () => {
    const { fetchImpl } = makeFetch();

    const result = await collectObservabilityEvidence({
      baseUrl: "https://siteflow.example.com",
      env: {
        SITEFLOW_METRICS_TOKEN: metricsToken
      },
      fetchImpl,
      alertDelivered: true,
      alertChannel: "pager",
      dashboardUid: "siteflow-prod",
      dashboardOwner: "platform",
      logRetentionDays: 30,
      logRedactionSpotCheckPassed: true,
      check: true,
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checkResult).toMatchObject({
      status: "blocked",
      exitCode: 1
    });
    expect(result.checkResult?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "readiness_status_codes",
          status: "fail"
        }),
        expect.objectContaining({
          name: "readiness_traffic_removed",
          status: "fail"
        })
      ])
    );
  });

  it("supports a documented private scrape exception without a token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-private-"));
    const { fetchImpl, calls } = makeFetch();

    try {
      const operatorEvidencePath = path.join(root, "operator.json");

      await writeFile(
        operatorEvidencePath,
        `${JSON.stringify({ ...operatorEvidence(), backupAutomationRun: backupAutomationRun() }, null, 2)}\n`,
        "utf8"
      );

      const result = await collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        env: {},
        fetchImpl,
        privateScrapeException: true,
        operatorEvidencePath,
        readinessFailureStatusCode: 503,
        trafficRemovedOnFailure: true,
        alertDelivered: true,
        alertChannel: "pager",
        dashboardUid: "siteflow-prod",
        dashboardOwner: "platform",
        logRetentionDays: 30,
        logRedactionSpotCheckPassed: true,
        check: true,
        now
      });

      expect(result.status).toBe("collected");
      expect(result.evidence?.metricsScrape).toMatchObject({
        authenticated: false,
        privateScrapeException: true
      });
      expect(calls.find((call) => call.input.endsWith("/metrics"))?.init?.headers).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns blocked diagnostics when readiness or metrics cannot be collected", async () => {
    const { fetchImpl } = makeFetch({
      readinessStatus: 503,
      readinessBody: { status: "not_ready" },
      metricsStatus: 403
    });

    const result = await collectObservabilityEvidence({
      baseUrl: "https://siteflow.example.com",
      env: {
        SITEFLOW_METRICS_TOKEN: metricsToken
      },
      fetchImpl,
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "readiness_collected",
          status: "fail"
        }),
        expect.objectContaining({
          name: "metrics_collected",
          status: "fail"
        })
      ])
    );
    expect(result.evidence).toMatchObject({
      readinessProbe: {
        status: "blocked",
        observedStatusCode: 503
      },
      metricsScrape: {
        status: "blocked",
        observedStatusCode: 403,
        metricNames: []
      }
    });
  });

  it("returns blocked diagnostics when target-stack proof API cannot be verified", async () => {
    const { fetchImpl } = makeFetch({
      targetStackStatus: 401,
      targetStackBody: { status: "blocked" }
    });

    const result = await collectObservabilityEvidence({
      baseUrl: "https://siteflow.example.com",
      env: {
        SITEFLOW_METRICS_TOKEN: metricsToken,
        SITEFLOW_OBSERVABILITY_STACK_TOKEN: targetStackToken
      },
      fetchImpl,
      targetStackApiUrl: "https://observability.example.com/siteflow-proof",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.evidence).toMatchObject({
      observabilityTargetStackProof: {
        status: "blocked",
        observedStatusCode: 401
      }
    });
  });

  it("blocks production collection when target-stack proof API URL is missing", async () => {
    const { fetchImpl } = makeFetch();

    const result = await collectObservabilityEvidence({
      baseUrl: "https://siteflow.example.com",
      env: {
        SITEFLOW_METRICS_TOKEN: metricsToken
      },
      fetchImpl,
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "target_stack_proof_configured",
          status: "fail"
        }),
        expect.objectContaining({
          name: "target_stack_proof_collected",
          status: "fail"
        })
      ])
    );
  });

  it("reads target-stack proof API token from _FILE without serializing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-target-stack-token-file-"));
    const tokenPath = path.join(root, "target-stack-token");
    const { fetchImpl, calls } = makeFetch();

    try {
      await writeFile(tokenPath, `${targetStackToken}\n`, "utf8");

      const result = await collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        env: {
          SITEFLOW_METRICS_TOKEN: metricsToken,
          SITEFLOW_OBSERVABILITY_STACK_TOKEN_FILE: tokenPath
        },
        fetchImpl,
        targetEnvironment: "production",
        targetStackApiUrl: "https://observability.example.com/siteflow-proof",
        now
      });

      expect(result.status).toBe("collected");
      expect(calls.find((call) => call.input === "https://observability.example.com/siteflow-proof")?.init?.headers).toEqual({
        authorization: `Bearer ${targetStackToken}`
      });
      expect(JSON.stringify(result)).not.toContain(targetStackToken);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks target-stack dry-run proof before treating collector output as collected", async () => {
    const { fetchImpl } = makeFetch({
      targetStackBody: {
        ...targetStackProof(),
        dryRun: true
      }
    });

    const result = await collectObservabilityEvidence({
      baseUrl: "https://siteflow.example.com",
      env: {
        SITEFLOW_METRICS_TOKEN: metricsToken,
        SITEFLOW_OBSERVABILITY_STACK_TOKEN: targetStackToken
      },
      fetchImpl,
      targetStackApiUrl: "https://observability.example.com/siteflow-proof",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "target_stack_proof_collected",
          status: "fail"
        })
      ])
    );
    expect(result.evidence).toMatchObject({
      observabilityTargetStackProof: {
        status: "blocked",
        dryRun: true,
        message: "Target-stack API proof must come from a real target stack query, not a template or dry-run."
      }
    });
  });

  it("returns usage errors for missing required options and invalid numbers", () => {
    expect(() => parseObservabilityEvidenceCollectArgs([])).toThrow("--base-url <url> is required");
    expect(() => parseObservabilityEvidenceCollectArgs(["--base-url"])).toThrow("--base-url requires a value");
    expect(() => parseObservabilityEvidenceCollectArgs(["--base-url", "https://siteflow.example.com", "--timeout-ms", "0"])).toThrow(
      "--timeout-ms must be a positive number"
    );
  });
});
