import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  requiredSiteFlowMetricNames,
  siteFlowMetricDefinitions
} from "../src/lib/observabilityMetrics.js";

type RenderedAssetKind = "prometheus_scrape" | "prometheus_rules" | "alertmanager_route" | "grafana_dashboard";

export interface ObservabilityProvisioningPlanOptions {
  outputDir?: string;
  scrapeTarget?: string;
  scrapeScheme?: "http" | "https";
  metricsTokenCredentialsFile?: string;
  alertReceiverName?: string;
  grafanaDashboardUid?: string;
  now?: () => Date;
}

export interface RenderedObservabilityAsset {
  path: string;
  kind: RenderedAssetKind;
  sha256: string;
  content: string;
}

export interface ObservabilityProvisioningPlan {
  schemaVersion: "siteflow.observabilityProvisioning.v1";
  name: "siteflow-observability-provisioning-plan";
  generatedAt: string;
  target: {
    scrapeTarget: string;
    scrapeScheme: "http" | "https";
    metricsPath: "/metrics";
    metricsTokenCredentialsFile: string;
    alertReceiverName: string;
    grafanaDashboardUid: string;
  };
  requiredMetricNames: string[];
  renderedAssets: RenderedObservabilityAsset[];
  operatorActions: string[];
  limitations: string[];
}

interface ParsedArgs {
  outputDir?: string;
  scrapeTarget?: string;
  scrapeScheme?: "http" | "https";
  metricsTokenCredentialsFile?: string;
  alertReceiverName?: string;
  grafanaDashboardUid?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultScrapeTarget = "siteflow-api.internal:8787";
const defaultMetricsTokenCredentialsFile = "/etc/prometheus/secrets/siteflow-metrics-token";
const defaultAlertReceiverName = "siteflow-operator-placeholder";
const defaultGrafanaDashboardUid = "siteflow-minimum";

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function sha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function renderedAsset(pathname: string, kind: RenderedAssetKind, content: string): RenderedObservabilityAsset {
  return {
    path: pathname,
    kind,
    sha256: sha256(content),
    content
  };
}

function yamlQuote(value: string) {
  return JSON.stringify(value);
}

function renderPrometheusScrapeYaml(options: Required<Pick<ObservabilityProvisioningPlanOptions, "scrapeTarget" | "scrapeScheme" | "metricsTokenCredentialsFile">>) {
  return [
    "scrape_configs:",
    "  - job_name: siteflow-api",
    `    scheme: ${options.scrapeScheme}`,
    "    metrics_path: /metrics",
    "    authorization:",
    "      type: Bearer",
    `      credentials_file: ${options.metricsTokenCredentialsFile}`,
    "    static_configs:",
    "      - targets:",
    `          - ${yamlQuote(options.scrapeTarget)}`,
    ""
  ].join("\n");
}

function renderPrometheusRulesYaml() {
  return [
    "groups:",
    "  - name: siteflow-minimum",
    "    rules:",
    "      - alert: SiteFlowReadinessDown",
    "        expr: probe_success{job=\"siteflow-readyz\"} == 0",
    "        for: 2m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow readiness is failing",
    "",
    "      - alert: SiteFlowMetricsMissing",
    "        expr: up{job=\"siteflow-api\"} == 0",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow metrics scrape is missing",
    "",
    "      - alert: SiteFlowHttp5xx",
    "        expr: increase(siteflow_http_5xx_total[5m]) > 0",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow API is returning 5xx responses",
    "",
    "      - alert: SiteFlowRateLimitSpike",
    "        expr: increase(siteflow_http_429_total[5m]) > 20",
    "        for: 10m",
    "        labels:",
    "          severity: ticket",
    "        annotations:",
    "          summary: SiteFlow API rate limiting increased",
    "",
    "      - alert: SiteFlowBuildJobsStale",
    "        expr: siteflow_build_jobs_stale > 0",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow build jobs are stale",
    "",
    "      - alert: SiteFlowBuildQueueOldestQueued",
    "        expr: siteflow_build_job_oldest_queued_age_seconds > 900",
    "        for: 10m",
    "        labels:",
    "          severity: ticket",
    "        annotations:",
    "          summary: SiteFlow build queue has old queued jobs",
    "",
    "      - alert: SiteFlowBuildHeartbeatStale",
    "        expr: siteflow_build_job_oldest_running_heartbeat_age_seconds > 300",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow running build heartbeat is stale",
    "",
    "      - alert: SiteFlowRuntimeMetricsCollectionFailed",
    "        expr: siteflow_runtime_metrics_collection_error == 1",
    "        for: 5m",
    "        labels:",
    "          severity: ticket",
    "        annotations:",
    "          summary: SiteFlow runtime metrics collection failed",
    "",
    "      - alert: SiteFlowStorageMetricsCollectionFailed",
    "        expr: siteflow_storage_metrics_collection_error == 1",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow storage metrics collection failed",
    "",
    "      - alert: SiteFlowStoragePathMissing",
    "        expr: siteflow_storage_missing_paths > 0",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow storage path is missing or unreadable",
    "",
    "      - alert: SiteFlowArtifactStorageLow",
    "        expr: siteflow_storage_artifact_free_bytes >= 0 and siteflow_storage_artifact_free_bytes < 1073741824",
    "        for: 10m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow artifact storage has less than 1 GiB free",
    "",
    "      - alert: SiteFlowEvidenceStorageLow",
    "        expr: siteflow_storage_evidence_free_bytes >= 0 and siteflow_storage_evidence_free_bytes < 1073741824",
    "        for: 10m",
    "        labels:",
    "          severity: ticket",
    "        annotations:",
    "          summary: SiteFlow evidence storage has less than 1 GiB free",
    "",
    "      - alert: SiteFlowTempStorageLow",
    "        expr: siteflow_storage_temp_free_bytes >= 0 and siteflow_storage_temp_free_bytes < 268435456",
    "        for: 10m",
    "        labels:",
    "          severity: ticket",
    "        annotations:",
    "          summary: SiteFlow temp storage has less than 256 MiB free",
    "",
    "      - alert: SiteFlowBackupMetricsCollectionFailed",
    "        expr: siteflow_backup_metrics_collection_error == 1",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow backup automation metrics are missing or incomplete",
    "",
    "      - alert: SiteFlowBackupAutomationStale",
    "        expr: siteflow_backup_automation_last_success_age_seconds < 0 or siteflow_backup_automation_last_success_age_seconds > 86400",
    "        for: 15m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow backup automation has no fresh successful run",
    "",
    "      - alert: SiteFlowBackupRestoreDrillStale",
    "        expr: siteflow_backup_restore_drill_last_success_age_seconds < 0 or siteflow_backup_restore_drill_last_success_age_seconds > 604800",
    "        for: 30m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow backup restore drill evidence is stale or missing",
    "",
    "      - alert: SiteFlowBackupOffloadFailed",
    "        expr: siteflow_backup_offload_last_run_failed == 1",
    "        for: 5m",
    "        labels:",
    "          severity: page",
    "        annotations:",
    "          summary: SiteFlow backup offload failed in the latest automation run",
    "",
    "      - alert: SiteFlowBackupPruneFailed",
    "        expr: siteflow_backup_prune_last_run_failed == 1",
    "        for: 5m",
    "        labels:",
    "          severity: ticket",
    "        annotations:",
    "          summary: SiteFlow backup prune failed in the latest automation run",
    ""
  ].join("\n");
}

function renderAlertmanagerRouteYaml(receiverName: string) {
  return [
    "route:",
    `  receiver: ${receiverName}`,
    "  group_by:",
    "    - alertname",
    "  group_wait: 30s",
    "  group_interval: 5m",
    "  repeat_interval: 4h",
    "receivers:",
    `  - name: ${receiverName}`,
    "    webhook_configs:",
    "      - url: https://replace-with-alertmanager-receiver.example.invalid/siteflow",
    "        send_resolved: true",
    ""
  ].join("\n");
}

function panel(id: number, title: string, expr: string, y: number) {
  return {
    id,
    type: "timeseries",
    title,
    gridPos: {
      h: 6,
      w: 12,
      x: id % 2 === 0 ? 12 : 0,
      y
    },
    targets: [
      {
        refId: "A",
        expr
      }
    ]
  };
}

function renderGrafanaDashboardJson(uid: string) {
  const dashboard = {
    uid,
    title: "SiteFlow Minimum Operations",
    timezone: "utc",
    schemaVersion: 39,
    version: 1,
    refresh: "30s",
    tags: ["siteflow", "minimum-observability"],
    panels: [
      panel(1, "HTTP Requests", "rate(siteflow_http_requests_total[5m])", 0),
      panel(2, "HTTP 5xx", "increase(siteflow_http_5xx_total[5m])", 0),
      panel(3, "HTTP 429", "increase(siteflow_http_429_total[5m])", 6),
      panel(4, "Build Jobs Queued", "siteflow_build_jobs_queued", 6),
      panel(5, "Build Jobs Running", "siteflow_build_jobs_running", 12),
      panel(6, "Build Jobs Stale", "siteflow_build_jobs_stale", 12),
      panel(7, "Oldest Queued Build Age", "siteflow_build_job_oldest_queued_age_seconds", 18),
      panel(8, "Oldest Running Heartbeat Age", "siteflow_build_job_oldest_running_heartbeat_age_seconds", 18),
      panel(9, "Runtime Metrics Collection Error", "siteflow_runtime_metrics_collection_error", 24),
      panel(10, "Backup Automation Age", "siteflow_backup_automation_last_success_age_seconds", 24),
      panel(11, "Restore Drill Age", "siteflow_backup_restore_drill_last_success_age_seconds", 30),
      panel(12, "Backup Offload Age", "siteflow_backup_offload_last_success_age_seconds", 30),
      panel(13, "Backup Prune Age", "siteflow_backup_prune_last_success_age_seconds", 36),
      panel(14, "Backup Failure Flags", "siteflow_backup_offload_last_run_failed or siteflow_backup_prune_last_run_failed", 36),
      panel(15, "Backup Metrics Collection Error", "siteflow_backup_metrics_collection_error", 42),
      panel(16, "Artifact Storage Free Bytes", "siteflow_storage_artifact_free_bytes", 42),
      panel(17, "Evidence Storage Free Bytes", "siteflow_storage_evidence_free_bytes", 48),
      panel(18, "Temp Storage Free Bytes", "siteflow_storage_temp_free_bytes", 48),
      panel(19, "Storage Missing Paths", "siteflow_storage_missing_paths", 54),
      panel(20, "Storage Metrics Collection Error", "siteflow_storage_metrics_collection_error", 54)
    ]
  };

  return `${JSON.stringify(dashboard, null, 2)}\n`;
}

export function generateObservabilityProvisioningPlan(
  options: ObservabilityProvisioningPlanOptions = {}
): ObservabilityProvisioningPlan {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const scrapeTarget = options.scrapeTarget ?? defaultScrapeTarget;
  const scrapeScheme = options.scrapeScheme ?? "http";
  const metricsTokenCredentialsFile = options.metricsTokenCredentialsFile ?? defaultMetricsTokenCredentialsFile;
  const alertReceiverName = options.alertReceiverName ?? defaultAlertReceiverName;
  const grafanaDashboardUid = options.grafanaDashboardUid ?? defaultGrafanaDashboardUid;
  const renderedAssets = [
    renderedAsset(
      "prometheus-scrape.yaml",
      "prometheus_scrape",
      renderPrometheusScrapeYaml({ scrapeTarget, scrapeScheme, metricsTokenCredentialsFile })
    ),
    renderedAsset("prometheus-rules.yaml", "prometheus_rules", renderPrometheusRulesYaml()),
    renderedAsset("alertmanager-route.yaml", "alertmanager_route", renderAlertmanagerRouteYaml(alertReceiverName)),
    renderedAsset("grafana-dashboard.json", "grafana_dashboard", renderGrafanaDashboardJson(grafanaDashboardUid))
  ];

  return {
    schemaVersion: "siteflow.observabilityProvisioning.v1",
    name: "siteflow-observability-provisioning-plan",
    generatedAt,
    target: {
      scrapeTarget,
      scrapeScheme,
      metricsPath: "/metrics",
      metricsTokenCredentialsFile,
      alertReceiverName,
      grafanaDashboardUid
    },
    requiredMetricNames: requiredSiteFlowMetricNames,
    renderedAssets,
    operatorActions: [
      "Review generated artifacts before applying them to the target observability stack.",
      "Replace the Alertmanager placeholder receiver URL with the real receiver managed outside SiteFlow.",
      "Apply Prometheus scrape and rule configuration through the target infrastructure workflow.",
      "Import the Grafana dashboard JSON into the target Grafana workspace.",
      "Collect real readiness, authenticated metrics scrape, alert delivery, dashboard ownership, log retention, and redaction evidence before promotion."
    ],
    limitations: [
      "This plan renders artifacts only; it does not apply Prometheus, Alertmanager, or Grafana configuration.",
      "No alert delivery, dashboard availability, log shipping, retention, network allowlist, TLS, or load-balancer behavior is verified by this plan.",
      "SiteFlow metrics are process-local unless the operator adds target-stack aggregation."
    ]
  };
}

export async function writeObservabilityProvisioningPlan(plan: ObservabilityProvisioningPlan, outputDir: string) {
  await mkdir(outputDir, { recursive: true });

  for (const asset of plan.renderedAssets) {
    await writeFile(path.join(outputDir, asset.path), asset.content, "utf8");
  }

  await writeFile(path.join(outputDir, "observability-provisioning-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

export async function runObservabilityProvisioningPlan(options: ObservabilityProvisioningPlanOptions = {}) {
  const plan = generateObservabilityProvisioningPlan(options);

  if (options.outputDir) {
    await writeObservabilityProvisioningPlan(plan, options.outputDir);
  }

  return plan;
}

export function parseObservabilityProvisioningPlanArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--output") {
      parsed.outputDir = args[++index];
    } else if (arg === "--scrape-target") {
      parsed.scrapeTarget = args[++index];
    } else if (arg === "--scrape-scheme") {
      const scheme = args[++index];
      if (scheme !== "http" && scheme !== "https") {
        throw new Error("--scrape-scheme must be http or https.");
      }
      parsed.scrapeScheme = scheme;
    } else if (arg === "--metrics-token-credentials-file") {
      parsed.metricsTokenCredentialsFile = args[++index];
    } else if (arg === "--alert-receiver-name") {
      parsed.alertReceiverName = args[++index];
    } else if (arg === "--grafana-dashboard-uid") {
      parsed.grafanaDashboardUid = args[++index];
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

export function observabilityProvisioningPlanUsage() {
  return [
    "Usage: npm run --silent observability:provisioning -- [--json] [--output <dir>]",
    "",
    "Options:",
    "  --output <dir>                         Write artifacts and plan JSON to a directory.",
    "  --scrape-target <host:port>             Prometheus target. Default: siteflow-api.internal:8787.",
    "  --scrape-scheme <http|https>            Prometheus scrape scheme. Default: http.",
    "  --metrics-token-credentials-file <path> Prometheus bearer token credentials_file path.",
    "  --alert-receiver-name <name>            Alertmanager placeholder receiver name.",
    "  --grafana-dashboard-uid <uid>           Grafana dashboard UID.",
    "  --json                                 Emit the plan JSON to stdout.",
    "  --help                                 Show this help."
  ].join("\n");
}

export async function runObservabilityProvisioningPlanCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ObservabilityProvisioningPlanOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseObservabilityProvisioningPlanArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${observabilityProvisioningPlanUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${observabilityProvisioningPlanUsage()}\n`);
    return 0;
  }

  const plan = await runObservabilityProvisioningPlan({
    ...baseOptions,
    outputDir: parsed.outputDir,
    scrapeTarget: parsed.scrapeTarget,
    scrapeScheme: parsed.scrapeScheme,
    metricsTokenCredentialsFile: parsed.metricsTokenCredentialsFile,
    alertReceiverName: parsed.alertReceiverName,
    grafanaDashboardUid: parsed.grafanaDashboardUid
  });

  if (parsed.json || !parsed.outputDir) {
    io.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    io.stdout.write(`SiteFlow observability provisioning plan written to ${parsed.outputDir}\n`);
  }

  return 0;
}

if (isEntrypoint()) {
  runObservabilityProvisioningPlanCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
