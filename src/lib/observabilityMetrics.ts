export type SiteFlowMetricType = "counter" | "gauge";
export type SiteFlowMetricFamily = "http" | "queue" | "runtime" | "backup" | "storage";

export interface SiteFlowMetricDefinition {
  name: string;
  type: SiteFlowMetricType;
  family: SiteFlowMetricFamily;
  description: string;
}

export const siteFlowMetricDefinitions = [
  {
    name: "siteflow_http_requests_total",
    type: "counter",
    family: "http",
    description: "Total SiteFlow HTTP requests handled by the process."
  },
  {
    name: "siteflow_http_5xx_total",
    type: "counter",
    family: "http",
    description: "Total SiteFlow HTTP responses with status code 500 or greater."
  },
  {
    name: "siteflow_http_429_total",
    type: "counter",
    family: "http",
    description: "Total SiteFlow HTTP responses rejected by rate limiting."
  },
  {
    name: "siteflow_http_request_duration_ms_sum",
    type: "counter",
    family: "http",
    description: "Cumulative SiteFlow HTTP request duration in milliseconds."
  },
  {
    name: "siteflow_http_request_duration_ms_count",
    type: "counter",
    family: "http",
    description: "Number of SiteFlow HTTP request duration samples."
  },
  {
    name: "siteflow_build_jobs_queued",
    type: "gauge",
    family: "queue",
    description: "Number of queued SiteFlow build jobs."
  },
  {
    name: "siteflow_build_jobs_running",
    type: "gauge",
    family: "queue",
    description: "Number of running SiteFlow build jobs."
  },
  {
    name: "siteflow_build_jobs_stale",
    type: "gauge",
    family: "queue",
    description: "Number of running SiteFlow build jobs with stale heartbeat or lease state."
  },
  {
    name: "siteflow_build_job_oldest_queued_age_seconds",
    type: "gauge",
    family: "queue",
    description: "Age in seconds of the oldest queued SiteFlow build job."
  },
  {
    name: "siteflow_build_job_oldest_running_heartbeat_age_seconds",
    type: "gauge",
    family: "queue",
    description: "Heartbeat age in seconds of the oldest running SiteFlow build job."
  },
  {
    name: "siteflow_runtime_metrics_collection_error",
    type: "gauge",
    family: "runtime",
    description: "1 when runtime metric collection failed during the scrape, otherwise 0."
  },
  {
    name: "siteflow_storage_artifact_free_bytes",
    type: "gauge",
    family: "storage",
    description: "Available bytes on the artifact storage filesystem, or -1 when it cannot be measured."
  },
  {
    name: "siteflow_storage_evidence_free_bytes",
    type: "gauge",
    family: "storage",
    description: "Available bytes on the release evidence storage filesystem, or -1 when it cannot be measured."
  },
  {
    name: "siteflow_storage_temp_free_bytes",
    type: "gauge",
    family: "storage",
    description: "Available bytes on the runtime temporary filesystem, or -1 when it cannot be measured."
  },
  {
    name: "siteflow_storage_missing_paths",
    type: "gauge",
    family: "storage",
    description: "Number of configured storage paths that were missing or unreadable during the scrape."
  },
  {
    name: "siteflow_storage_metrics_collection_error",
    type: "gauge",
    family: "storage",
    description: "1 when storage metric collection failed during the scrape, otherwise 0."
  },
  {
    name: "siteflow_backup_automation_last_success_age_seconds",
    type: "gauge",
    family: "backup",
    description: "Age in seconds of the last completed SiteFlow backup automation run, or -1 when no successful run is known."
  },
  {
    name: "siteflow_backup_restore_drill_last_success_age_seconds",
    type: "gauge",
    family: "backup",
    description: "Age in seconds of the last successful SiteFlow backup restore drill, or -1 when no successful drill is known."
  },
  {
    name: "siteflow_backup_offload_last_success_age_seconds",
    type: "gauge",
    family: "backup",
    description: "Age in seconds of the last successful SiteFlow backup offload, or -1 when no successful offload is known."
  },
  {
    name: "siteflow_backup_prune_last_success_age_seconds",
    type: "gauge",
    family: "backup",
    description: "Age in seconds of the last successful non-dry-run SiteFlow backup prune, or -1 when no successful prune is known."
  },
  {
    name: "siteflow_backup_offload_last_run_failed",
    type: "gauge",
    family: "backup",
    description: "1 when the latest backup automation run failed during backup offload, otherwise 0."
  },
  {
    name: "siteflow_backup_prune_last_run_failed",
    type: "gauge",
    family: "backup",
    description: "1 when the latest backup automation run failed during non-dry-run backup prune, otherwise 0."
  },
  {
    name: "siteflow_backup_metrics_collection_error",
    type: "gauge",
    family: "backup",
    description: "1 when backup automation metric collection failed during the scrape, otherwise 0."
  }
] as const satisfies readonly SiteFlowMetricDefinition[];

export const requiredSiteFlowMetricNames = siteFlowMetricDefinitions.map((definition) => definition.name);
export const httpMetricNames = siteFlowMetricDefinitions
  .filter((definition) => definition.family === "http")
  .map((definition) => definition.name);
export const runtimeQueueMetricNames = siteFlowMetricDefinitions
  .filter((definition) => definition.family === "queue" || definition.family === "runtime")
  .map((definition) => definition.name);
export const backupMetricNames = siteFlowMetricDefinitions
  .filter((definition) => definition.family === "backup")
  .map((definition) => definition.name);
export const storageMetricNames = siteFlowMetricDefinitions
  .filter((definition) => definition.family === "storage")
  .map((definition) => definition.name);

export function metricDefinition(name: string) {
  return siteFlowMetricDefinitions.find((definition) => definition.name === name);
}

export function renderPrometheusTypeLine(definition: SiteFlowMetricDefinition) {
  return `# TYPE ${definition.name} ${definition.type}`;
}
