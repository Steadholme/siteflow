import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  generateObservabilityProvisioningPlan,
  runObservabilityProvisioningPlanCli
} from "./observabilityProvisioningPlan";
import { requiredSiteFlowMetricNames } from "../src/lib/observabilityMetrics.ts";

const now = () => new Date("2026-06-07T12:00:00.000Z");

function sha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assetContent(plan: ReturnType<typeof generateObservabilityProvisioningPlan>, pathname: string) {
  const asset = plan.renderedAssets.find((candidate) => candidate.path === pathname);

  if (!asset) {
    throw new Error(`Missing rendered asset: ${pathname}`);
  }

  return asset.content;
}

describe("observabilityProvisioningPlan", () => {
  it("renders a versioned provisioning plan with checksummed assets", () => {
    const plan = generateObservabilityProvisioningPlan({ now });

    expect(plan).toMatchObject({
      schemaVersion: "siteflow.observabilityProvisioning.v1",
      name: "siteflow-observability-provisioning-plan",
      generatedAt: "2026-06-07T12:00:00.000Z",
      target: {
        metricsPath: "/metrics"
      }
    });
    expect(plan.requiredMetricNames).toEqual(requiredSiteFlowMetricNames);
    expect(plan.renderedAssets.map((asset) => asset.path)).toEqual([
      "prometheus-scrape.yaml",
      "prometheus-rules.yaml",
      "alertmanager-route.yaml",
      "grafana-dashboard.json"
    ]);
    expect(plan.renderedAssets.every((asset) => asset.sha256 === sha256(asset.content))).toBe(true);
  });

  it("renders authenticated Prometheus scrape config without embedding a bearer token", () => {
    const plan = generateObservabilityProvisioningPlan({
      now,
      scrapeTarget: "siteflow-api.prod.internal:443",
      scrapeScheme: "https",
      metricsTokenCredentialsFile: "/run/secrets/siteflow-metrics-token"
    });
    const scrape = assetContent(plan, "prometheus-scrape.yaml");

    expect(scrape).toContain("scheme: https");
    expect(scrape).toContain("metrics_path: /metrics");
    expect(scrape).toContain("authorization:");
    expect(scrape).toContain("type: Bearer");
    expect(scrape).toContain("credentials_file: /run/secrets/siteflow-metrics-token");
    expect(scrape).toContain('"siteflow-api.prod.internal:443"');
    expect(scrape).not.toContain("Authorization: Bearer");
    expect(scrape).not.toContain("super-secret");
  });

  it("renders minimum alert rules for readiness, metrics, HTTP, queue, and runtime errors", () => {
    const rules = assetContent(generateObservabilityProvisioningPlan({ now }), "prometheus-rules.yaml");

    expect(rules).toContain("SiteFlowReadinessDown");
    expect(rules).toContain('probe_success{job="siteflow-readyz"} == 0');
    expect(rules).toContain("SiteFlowMetricsMissing");
    expect(rules).toContain('up{job="siteflow-api"} == 0');
    expect(rules).toContain("SiteFlowHttp5xx");
    expect(rules).toContain("siteflow_http_5xx_total");
    expect(rules).toContain("SiteFlowRateLimitSpike");
    expect(rules).toContain("siteflow_http_429_total");
    expect(rules).toContain("SiteFlowBuildJobsStale");
    expect(rules).toContain("siteflow_build_jobs_stale");
    expect(rules).toContain("SiteFlowBuildQueueOldestQueued");
    expect(rules).toContain("siteflow_build_job_oldest_queued_age_seconds");
    expect(rules).toContain("SiteFlowBuildHeartbeatStale");
    expect(rules).toContain("siteflow_build_job_oldest_running_heartbeat_age_seconds");
    expect(rules).toContain("SiteFlowRuntimeMetricsCollectionFailed");
    expect(rules).toContain("siteflow_runtime_metrics_collection_error");
    expect(rules).toContain("SiteFlowBackupMetricsCollectionFailed");
    expect(rules).toContain("siteflow_backup_metrics_collection_error");
    expect(rules).toContain("SiteFlowBackupAutomationStale");
    expect(rules).toContain("siteflow_backup_automation_last_success_age_seconds");
    expect(rules).toContain("SiteFlowBackupRestoreDrillStale");
    expect(rules).toContain("siteflow_backup_restore_drill_last_success_age_seconds");
    expect(rules).toContain("SiteFlowBackupOffloadFailed");
    expect(rules).toContain("siteflow_backup_offload_last_run_failed");
    expect(rules).toContain("SiteFlowBackupPruneFailed");
    expect(rules).toContain("siteflow_backup_prune_last_run_failed");
  });

  it("renders an Alertmanager placeholder route without secrets", () => {
    const route = assetContent(
      generateObservabilityProvisioningPlan({
        now,
        alertReceiverName: "siteflow-platform-placeholder"
      }),
      "alertmanager-route.yaml"
    );

    expect(route).toContain("receiver: siteflow-platform-placeholder");
    expect(route).toContain("replace-with-alertmanager-receiver.example.invalid");
    expect(route).not.toContain("token=");
    expect(route).not.toContain("password");
    expect(route).not.toContain("secret");
  });

  it("renders a parseable Grafana dashboard that references HTTP and runtime metrics", () => {
    const dashboardJson = assetContent(
      generateObservabilityProvisioningPlan({
        now,
        grafanaDashboardUid: "siteflow-prod-minimum"
      }),
      "grafana-dashboard.json"
    );
    const dashboard = JSON.parse(dashboardJson);

    expect(dashboard).toMatchObject({
      uid: "siteflow-prod-minimum",
      title: "SiteFlow Minimum Operations"
    });
    expect(dashboardJson).toContain("siteflow_http_requests_total");
    expect(dashboardJson).toContain("siteflow_build_jobs_queued");
    expect(dashboardJson).toContain("siteflow_runtime_metrics_collection_error");
    expect(dashboardJson).toContain("siteflow_backup_automation_last_success_age_seconds");
    expect(dashboardJson).toContain("siteflow_backup_restore_drill_last_success_age_seconds");
    expect(dashboardJson).toContain("siteflow_backup_metrics_collection_error");
  });

  it("keeps every required metric visible in the plan, dashboard, or rules", () => {
    const plan = generateObservabilityProvisioningPlan({ now });
    const combined = [
      JSON.stringify(plan.requiredMetricNames),
      assetContent(plan, "prometheus-rules.yaml"),
      assetContent(plan, "grafana-dashboard.json")
    ].join("\n");

    for (const metricName of requiredSiteFlowMetricNames) {
      expect(combined).toContain(metricName);
    }
  });

  it("writes all artifacts and plan JSON from --output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-provisioning-"));
    let stdout = "";
    let stderr = "";

    try {
      const exitCode = await runObservabilityProvisioningPlanCli(
        ["--output", root],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { now }
      );
      const writtenPlan = JSON.parse(await readFile(path.join(root, "observability-provisioning-plan.json"), "utf8"));

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(root);
      expect(writtenPlan).toMatchObject({
        schemaVersion: "siteflow.observabilityProvisioning.v1",
        generatedAt: "2026-06-07T12:00:00.000Z"
      });
      await expect(readFile(path.join(root, "prometheus-scrape.yaml"), "utf8")).resolves.toContain("/metrics");
      await expect(readFile(path.join(root, "prometheus-rules.yaml"), "utf8")).resolves.toContain("SiteFlowMetricsMissing");
      await expect(readFile(path.join(root, "alertmanager-route.yaml"), "utf8")).resolves.toContain("receivers:");
      await expect(readFile(path.join(root, "grafana-dashboard.json"), "utf8")).resolves.toContain("SiteFlow Minimum Operations");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits parseable plan JSON from the CLI", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runObservabilityProvisioningPlanCli(
      ["--json", "--scrape-target", "siteflow-api.prod.internal:8787"],
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      },
      { now }
    );
    const parsed = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(parsed).toMatchObject({
      schemaVersion: "siteflow.observabilityProvisioning.v1",
      target: {
        scrapeTarget: "siteflow-api.prod.internal:8787"
      }
    });
  });
});
