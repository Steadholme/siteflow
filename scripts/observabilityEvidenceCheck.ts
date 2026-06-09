import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { requiredSiteFlowMetricNames } from "../src/lib/observabilityMetrics.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface ObservabilityEvidenceCheckOptions {
  evidencePath: string;
  maxAgeHours?: number;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  now?: () => Date;
}

export interface ObservabilityEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface ObservabilityEvidenceSummary {
  status?: string;
  timestamp?: string;
  sourceApplied?: boolean;
  authenticated?: boolean;
  privateScrapeException?: boolean;
  observedStatusCode?: number;
}

export interface ObservabilityEvidenceCheckResult {
  name: "siteflow-observability-evidence-check";
  status: EvidenceStatus;
  checkedAt: string;
  evidencePath: string;
  thresholds: {
    maxAgeHours: number;
  };
  selectedEvidence: {
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    targetEnvironment: string | null;
    readinessProbe: ObservabilityEvidenceSummary | null;
    metricsScrape: ObservabilityEvidenceSummary | null;
    backupAutomationRun: ObservabilityEvidenceSummary | null;
    backupAutomationRunHistory: ObservabilityEvidenceSummary | null;
    backupSchedulerOwnership: ObservabilityEvidenceSummary | null;
    observabilityApplyProof: ObservabilityEvidenceSummary | null;
    observabilityTargetStackProof: ObservabilityEvidenceSummary | null;
    alertDelivery: ObservabilityEvidenceSummary | null;
    dashboard: ObservabilityEvidenceSummary | null;
    logPipeline: ObservabilityEvidenceSummary | null;
  };
  checks: ObservabilityEvidenceCheck[];
  exitCode: number;
}

interface ParsedArgs {
  evidencePath?: string;
  json: boolean;
  help: boolean;
  maxAgeHours: number;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMaxAgeHours = 24;
const defaultRestoreDrillCadenceHours = 168;
const passStatuses = new Set(["pass", "passed", "ok", "healthy", "scraped", "delivered", "available"]);
export const requiredObservabilityEvidenceCheckNames = [
  "release_identity",
  "target_environment",
  "readiness_present",
  "readiness_status",
  "readiness_age",
  "readiness_status_codes",
  "readiness_traffic_removed",
  "metrics_present",
  "metrics_status",
  "metrics_age",
  "metrics_access_control",
  "metrics_expected_names",
  "backup_automation_run_present",
  "backup_automation_run_identity",
  "backup_automation_run_status",
  "backup_automation_run_age",
  "backup_automation_run_steps",
  "backup_automation_checker_output",
  "backup_automation_history_present",
  "backup_automation_history_identity",
  "backup_automation_history_latest_run",
  "backup_automation_history_latest_status",
  "backup_restore_drill_cadence_count",
  "backup_restore_drill_cadence_gap",
  "backup_history_checker_output",
  "backup_scheduler_ownership_present",
  "backup_scheduler_ownership_status",
  "backup_scheduler_ownership_age",
  "backup_scheduler_ownership_schema",
  "backup_scheduler_ownership_source",
  "backup_scheduler_ownership_target_environment",
  "backup_scheduler_ownership_enabled",
  "backup_scheduler_ownership_schedule",
  "backup_scheduler_ownership_command",
  "backup_scheduler_ownership_run_links",
  "backup_scheduler_ownership_owner",
  "observability_apply_proof_present",
  "observability_apply_proof_status",
  "observability_apply_proof_age",
  "observability_apply_proof_schema",
  "observability_apply_proof_source",
  "observability_apply_proof_non_dry_run",
  "observability_apply_proof_plan_schema",
  "observability_apply_proof_assets",
  "observability_target_stack_proof_present",
  "observability_target_stack_proof_status",
  "observability_target_stack_proof_age",
  "observability_target_stack_proof_schema",
  "observability_target_stack_proof_source",
  "observability_target_stack_proof_non_dry_run",
  "observability_target_stack_proof_release_identity",
  "observability_target_stack_proof_target_environment",
  "observability_target_stack_prometheus_rules",
  "observability_target_stack_grafana_dashboard",
  "observability_target_stack_alertmanager_receiver",
  "alert_present",
  "alert_status",
  "alert_age",
  "alert_delivered",
  "dashboard_present",
  "dashboard_status",
  "dashboard_age",
  "dashboard_reference",
  "dashboard_owner",
  "log_pipeline_present",
  "log_pipeline_status",
  "log_pipeline_age",
  "log_retention",
  "log_redaction_spot_check",
  "no_sensitive_evidence_values"
] as const;

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function timestampValue(value: unknown) {
  const raw = stringValue(value);

  if (!raw || Number.isNaN(Date.parse(raw))) {
    return undefined;
  }

  return raw;
}

function positiveNumber(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ageHours(timestamp: string, now: Date) {
  return (now.getTime() - Date.parse(timestamp)) / (60 * 60 * 1000);
}

function collectObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjects(item));
  }

  if (!isObject(value)) {
    return [];
  }

  return [
    value,
    ...Object.values(value).flatMap((item) => collectObjects(item))
  ];
}

function firstTimestamp(candidate: Record<string, unknown> | undefined, keys: string[]) {
  if (!candidate) {
    return undefined;
  }

  for (const key of keys) {
    const timestamp = timestampValue(candidate[key]);

    if (timestamp) {
      return timestamp;
    }
  }

  return undefined;
}

function latestByTimestamp(candidates: Record<string, unknown>[], timestampKeys: string[]) {
  return candidates
    .map((candidate) => ({
      candidate,
      timestamp: firstTimestamp(candidate, timestampKeys)
    }))
    .sort((left, right) => Date.parse(right.timestamp ?? "") - Date.parse(left.timestamp ?? ""))[0]?.candidate;
}

function firstCandidate(root: unknown, keys: string[]) {
  if (!isObject(root)) {
    return undefined;
  }

  for (const key of keys) {
    if (isObject(root[key])) {
      return root[key];
    }
  }

  return undefined;
}

function kindValue(candidate: Record<string, unknown>) {
  return statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
}

function looksLikeKind(expectedKinds: string[]) {
  return (candidate: Record<string, unknown>) => {
    const kind = kindValue(candidate) ?? statusValue(candidate.name);

    return Boolean(kind && expectedKinds.includes(kind));
  };
}

function selectEvidence(root: unknown, directKeys: string[], kinds: string[], timestampKeys: string[]) {
  return firstCandidate(root, directKeys) ??
    latestByTimestamp(collectObjects(root).filter(looksLikeKind(kinds)), timestampKeys);
}

function selectedTimestamp(candidate: Record<string, unknown> | undefined) {
  return firstTimestamp(candidate, [
    "checkedAt",
    "scrapedAt",
    "deliveredAt",
    "appliedAt",
    "completedAt",
    "updatedAt",
    "createdAt",
    "timestamp"
  ]);
}

function summarizeEvidence(candidate: Record<string, unknown> | undefined) {
  if (!candidate) {
    return null;
  }

  return {
    status: stringValue(candidate.status),
    timestamp: selectedTimestamp(candidate),
    sourceApplied: candidate.sourceApplied === true ? true : undefined
  };
}

function booleanSummaryValue(candidate: Record<string, unknown>, key: string) {
  return typeof candidate[key] === "boolean" ? candidate[key] : undefined;
}

function numberSummaryValue(candidate: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = candidate[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function summarizeMetricsScrapeEvidence(candidate: Record<string, unknown> | undefined) {
  const summary = summarizeEvidence(candidate);

  if (!summary || !candidate) {
    return summary;
  }

  const authenticated = booleanSummaryValue(candidate, "authenticated");
  const privateScrapeException = booleanSummaryValue(candidate, "privateScrapeException");
  const observedStatusCode = numberSummaryValue(candidate, ["observedStatusCode", "statusCode", "httpStatusCode"]);

  return {
    ...summary,
    ...(authenticated !== undefined ? { authenticated } : {}),
    ...(privateScrapeException !== undefined ? { privateScrapeException } : {}),
    ...(observedStatusCode !== undefined ? { observedStatusCode } : {})
  };
}

function addCheck(checks: ObservabilityEvidenceCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function isPassingStatus(status: unknown) {
  const normalized = statusValue(status);

  return Boolean(normalized && passStatuses.has(normalized));
}

function freshTimestamp(candidate: Record<string, unknown> | undefined, now: Date, maxAgeHours: number) {
  const timestamp = selectedTimestamp(candidate);

  return Boolean(timestamp && ageHours(timestamp, now) >= 0 && ageHours(timestamp, now) <= maxAgeHours);
}

function hasDashboardReference(candidate: Record<string, unknown> | undefined) {
  return Boolean(
    candidate &&
      (stringValue(candidate.url) ??
        stringValue(candidate.dashboardUrl) ??
        stringValue(candidate.uid) ??
        stringValue(candidate.dashboardUid))
  );
}

function includesAllStrings(candidate: unknown, required: string[]) {
  return Array.isArray(candidate) && required.every((value) => candidate.includes(value));
}

function timestampMs(value: unknown) {
  const timestamp = timestampValue(value);

  return timestamp ? Date.parse(timestamp) : undefined;
}

function sha256Value(value: unknown) {
  const raw = stringValue(value);

  return raw && /^[a-f0-9]{64}$/i.test(raw) ? raw.toLowerCase() : undefined;
}

function renderedAssets(rawEvidence: unknown) {
  const root = isObject(rawEvidence) ? rawEvidence : {};
  const candidates = [
    nestedObject(root, "observabilityProvisioning"),
    nestedObject(root, "provisioningPlan"),
    root
  ].filter(Boolean) as Record<string, unknown>[];

  return candidates.flatMap((candidate) =>
    Array.isArray(candidate.renderedAssets)
      ? candidate.renderedAssets.filter(isObject)
      : []
  );
}

function renderedAsset(rawEvidence: unknown, kind: string) {
  return renderedAssets(rawEvidence).find((asset) => stringValue(asset.kind) === kind);
}

function renderedAssetSha(rawEvidence: unknown, kind: string) {
  return sha256Value(renderedAsset(rawEvidence, kind)?.sha256);
}

function renderedAssetContent(rawEvidence: unknown, kind: string) {
  return stringValue(renderedAsset(rawEvidence, kind)?.content);
}

function renderedPrometheusAlertNames(rawEvidence: unknown) {
  const content = renderedAssetContent(rawEvidence, "prometheus_rules");

  if (!content) {
    return [];
  }

  return [...content.matchAll(/^\s*(?:-\s*)?alert:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((value): value is string => Boolean(value));
}

function renderedTargetValue(rawEvidence: unknown, key: string) {
  const root = isObject(rawEvidence) ? rawEvidence : {};
  const candidates = [
    nestedObject(root, "observabilityProvisioning"),
    nestedObject(root, "provisioningPlan"),
    root
  ].filter(Boolean) as Record<string, unknown>[];

  for (const candidate of candidates) {
    const value = stringValue(nestedValue(candidate, ["target", key])) ?? stringValue(candidate[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function alertRuleInRenderedRules(rawEvidence: unknown, ruleName: string) {
  const content = renderedAssetContent(rawEvidence, "prometheus_rules");

  if (!content) {
    return false;
  }

  return content.includes(`alert: ${ruleName}`) || content.includes(`alert: ${JSON.stringify(ruleName)}`);
}

function productionProofNotDryRun(candidate: Record<string, unknown> | undefined) {
  const mode = statusValue(candidate?.mode) ?? statusValue(candidate?.applyMode) ?? statusValue(candidate?.evidenceMode);
  const normalizedMode = mode?.replace(/[-\s]+/g, "_");

  return Boolean(
    candidate &&
      candidate.dryRun !== true &&
      candidate.template !== true &&
      candidate.sourceApplied !== false &&
      normalizedMode !== "dry_run" &&
      normalizedMode !== "template"
  );
}

function appliedAssetMap(applyProof: Record<string, unknown> | undefined) {
  const assets = Array.isArray(applyProof?.appliedAssets) ? applyProof.appliedAssets.filter(isObject) : [];

  return new Map(
    assets
      .map((asset) => [stringValue(asset.kind), sha256Value(asset.sha256)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
  );
}

function applyProofAssetsMatchPlan(applyProof: Record<string, unknown> | undefined, rawEvidence: unknown) {
  const requiredKinds = ["prometheus_scrape", "prometheus_rules", "alertmanager_route", "grafana_dashboard"];
  const applied = appliedAssetMap(applyProof);

  return requiredKinds.every(
    (kind) => applied.get(kind) && renderedAssetSha(rawEvidence, kind) && applied.get(kind) === renderedAssetSha(rawEvidence, kind)
  );
}

function targetStackReleaseIdentityMatches(
  proof: Record<string, unknown> | undefined,
  expectedCommitRef: string | undefined,
  expectedRepository: string | undefined,
  expectedBranch: string | undefined
) {
  if (!proof) {
    return false;
  }

  return Boolean(
    (!expectedCommitRef || evidenceCommitValue(proof) === expectedCommitRef) &&
      (!expectedRepository || evidenceRepositoryValue(proof) === expectedRepository) &&
      (!expectedBranch || evidenceBranchValue(proof) === expectedBranch)
  );
}

function targetStackEnvironmentMatches(
  proof: Record<string, unknown> | undefined,
  expectedTargetEnvironment: string | undefined
) {
  return Boolean(!expectedTargetEnvironment || evidenceTargetEnvironmentValue(proof) === expectedTargetEnvironment);
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function targetStackPrometheusRulesPassed(proof: Record<string, unknown> | undefined, rawEvidence: unknown) {
  const prometheusRules = nestedObject(proof, "prometheusRules");
  const matchedAlertNames = arrayOfStrings(prometheusRules?.matchedAlertNames);
  const missingAlertNames = arrayOfStrings(prometheusRules?.missingAlertNames);
  const expectedAlertNames = renderedPrometheusAlertNames(rawEvidence);

  return Boolean(
    prometheusRules &&
      isPassingStatus(prometheusRules.status) &&
      stringValue(prometheusRules.apiUrl) &&
      prometheusRules.rulesHealth === "ok" &&
      stringValue(prometheusRules.renderedAssetKind) === "prometheus_rules" &&
      sha256Value(prometheusRules.renderedAssetSha256) === renderedAssetSha(rawEvidence, "prometheus_rules") &&
      expectedAlertNames.length > 0 &&
      expectedAlertNames.every((ruleName) => matchedAlertNames.includes(ruleName)) &&
      missingAlertNames.length === 0 &&
      matchedAlertNames.every((ruleName) => alertRuleInRenderedRules(rawEvidence, ruleName))
  );
}

function targetStackGrafanaDashboardPassed(proof: Record<string, unknown> | undefined, rawEvidence: unknown) {
  const grafanaDashboard = nestedObject(proof, "grafanaDashboard");
  const expectedUid = renderedTargetValue(rawEvidence, "grafanaDashboardUid");

  return Boolean(
    grafanaDashboard &&
      isPassingStatus(grafanaDashboard.status) &&
      stringValue(grafanaDashboard.apiUrl) &&
      stringValue(grafanaDashboard.observedTitle) &&
      stringValue(grafanaDashboard.renderedAssetKind) === "grafana_dashboard" &&
      sha256Value(grafanaDashboard.renderedAssetSha256) === renderedAssetSha(rawEvidence, "grafana_dashboard") &&
      (!expectedUid || stringValue(grafanaDashboard.dashboardUid) === expectedUid) &&
      includesAllStrings(grafanaDashboard.matchedMetricNames, requiredSiteFlowMetricNames)
  );
}

function targetStackAlertmanagerReceiverPassed(proof: Record<string, unknown> | undefined, rawEvidence: unknown) {
  const alertmanagerReceiver = nestedObject(proof, "alertmanagerReceiver");
  const expectedReceiverName = renderedTargetValue(rawEvidence, "alertReceiverName");

  return Boolean(
    alertmanagerReceiver &&
      statusValue(alertmanagerReceiver.status) === "delivered" &&
      stringValue(alertmanagerReceiver.alertmanagerApiUrl) &&
      stringValue(alertmanagerReceiver.proofId) &&
      timestampValue(alertmanagerReceiver.sentAt) &&
      timestampValue(alertmanagerReceiver.deliveredAt) &&
      sha256Value(alertmanagerReceiver.receiverReceiptSha256) &&
      (!expectedReceiverName || stringValue(alertmanagerReceiver.receiverName) === expectedReceiverName)
  );
}

function stepCompleted(candidate: Record<string, unknown> | undefined, stepId: string) {
  return Array.isArray(candidate?.steps) &&
    candidate.steps.some((step) => isObject(step) && step.id === stepId && step.status === "completed");
}

function historyRuns(candidate: Record<string, unknown> | undefined) {
  return Array.isArray(candidate?.runs) ? candidate.runs.filter(isObject) : [];
}

function historyRunTimestamp(candidate: Record<string, unknown>) {
  return firstTimestamp(candidate, ["restoreDrillCompletedAt", "completedAt", "timestamp", "createdAt"]);
}

function successfulHistoryRuns(candidate: Record<string, unknown> | undefined) {
  return historyRuns(candidate)
    .filter((run) => (
      run.status === "completed" &&
        run.exitCode === 0 &&
        run.restoreDrillCompleted === true &&
        stepCompleted(run, "restore_drill") &&
        stepCompleted(run, "backup_evidence") &&
        (run.backupEvidenceStatus === "passed" || run.composeStatus === "composed")
    ))
    .map((run) => ({
      run,
      timestamp: historyRunTimestamp(run)
    }))
    .filter((entry): entry is { run: Record<string, unknown>; timestamp: string } => Boolean(entry.timestamp))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function maxHistoryGapHours(successfulRuns: Array<{ timestamp: string }>) {
  let maxGap = 0;

  for (let index = 1; index < successfulRuns.length; index += 1) {
    const gap = (Date.parse(successfulRuns[index].timestamp) - Date.parse(successfulRuns[index - 1].timestamp)) / (60 * 60 * 1000);
    maxGap = Math.max(maxGap, gap);
  }

  return maxGap;
}

function latestHistoryRun(candidate: Record<string, unknown> | undefined) {
  return historyRuns(candidate)
    .map((run) => ({
      run,
      timestamp: firstTimestamp(run, ["completedAt", "timestamp", "createdAt"])
    }))
    .filter((entry): entry is { run: Record<string, unknown>; timestamp: string } => Boolean(entry.timestamp))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0]?.run;
}

function nestedObject(candidate: Record<string, unknown> | undefined, key: string) {
  const value = candidate?.[key];

  return isObject(value) ? value : undefined;
}

function nestedValue(candidate: Record<string, unknown> | undefined, keys: string[]) {
  return keys.reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), candidate);
}

function rootObject(candidate: unknown) {
  return isObject(candidate) ? candidate : undefined;
}

function evidenceCommitValue(candidate: Record<string, unknown> | undefined) {
  return stringValue(candidate?.commitRef) ??
    stringValue(candidate?.commitSha) ??
    stringValue(nestedValue(candidate, ["release", "commitRef"])) ??
    stringValue(nestedValue(candidate, ["release", "commitSha"]));
}

function evidenceRepositoryValue(candidate: Record<string, unknown> | undefined) {
  return stringValue(candidate?.repository) ??
    stringValue(candidate?.repo) ??
    stringValue(nestedValue(candidate, ["release", "repository"])) ??
    stringValue(nestedValue(candidate, ["release", "repo"]));
}

function evidenceBranchValue(candidate: Record<string, unknown> | undefined) {
  return stringValue(candidate?.branch) ?? stringValue(nestedValue(candidate, ["release", "branch"]));
}

function evidenceTargetEnvironmentValue(candidate: Record<string, unknown> | undefined) {
  return stringValue(candidate?.targetEnvironment) ??
    stringValue(candidate?.environment) ??
    stringValue(nestedValue(candidate, ["release", "targetEnvironment"])) ??
    stringValue(nestedValue(candidate, ["release", "environment"]));
}

function evidenceFilePath(candidate: Record<string, unknown> | undefined, key: string) {
  return stringValue(nestedObject(candidate, "evidenceFiles")?.[key]);
}

function backupSchedulerNestedObject(candidate: Record<string, unknown> | undefined, key: string) {
  return nestedObject(nestedObject(candidate, "scheduler"), key) ?? nestedObject(candidate, key);
}

function backupSchedulerStringValue(candidate: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const direct = stringValue(candidate?.[key]) ?? stringValue(nestedObject(candidate, "scheduler")?.[key]);

    if (direct) {
      return direct;
    }
  }

  return undefined;
}

function backupSchedulerPathValue(candidate: Record<string, unknown> | undefined, keys: string[]) {
  const evidenceFiles = nestedObject(candidate, "evidenceFiles") ?? nestedObject(nestedObject(candidate, "scheduler"), "evidenceFiles");

  for (const key of keys) {
    const value = stringValue(evidenceFiles?.[key]) ??
      stringValue(candidate?.[key]) ??
      stringValue(nestedObject(candidate, "scheduler")?.[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function backupSchedulerOwnershipSourcePassed(candidate: Record<string, unknown> | undefined) {
  return Boolean(
    backupSchedulerStringValue(candidate, ["evidenceSource", "proofSource"]) &&
      backupSchedulerStringValue(candidate, ["operator", "operatorName"]) &&
      backupSchedulerStringValue(candidate, ["ticket", "releaseTicket", "changeTicket"])
  );
}

function backupSchedulerOwnershipEnabled(candidate: Record<string, unknown> | undefined) {
  const scheduler = nestedObject(candidate, "scheduler") ?? candidate;

  return scheduler?.enabled === true && Boolean(backupSchedulerStringValue(candidate, ["kind", "schedulerKind"]) && backupSchedulerStringValue(candidate, ["id", "jobId", "unitName"]));
}

function backupSchedulerOwnershipSchedulePassed(candidate: Record<string, unknown> | undefined) {
  const schedule = backupSchedulerNestedObject(candidate, "schedule");
  const scheduleValue =
    backupSchedulerStringValue(candidate, ["schedule", "cron", "expression"]) ??
    stringValue(schedule?.cron) ??
    stringValue(schedule?.expression);
  const timezoneValue = backupSchedulerStringValue(candidate, ["timezone"]) ?? stringValue(schedule?.timezone);

  return Boolean(scheduleValue && timezoneValue);
}

function backupSchedulerOwnershipCommandPassed(candidate: Record<string, unknown> | undefined) {
  const scheduler = nestedObject(candidate, "scheduler") ?? candidate;
  const command = backupSchedulerStringValue(candidate, ["command", "commandLine"]);
  const args = Array.isArray(scheduler?.args) ? scheduler.args.filter((entry): entry is string => typeof entry === "string") : [];
  const commandText = command ?? args.join(" ");

  return Boolean(commandText && commandText.includes("backup:automation"));
}

function backupSchedulerOwnershipRunLinksPassed(
  schedulerOwnership: Record<string, unknown> | undefined,
  backupAutomationRun: Record<string, unknown> | undefined,
  backupAutomationRunHistory: Record<string, unknown> | undefined
) {
  const schedulerRunRecord = backupSchedulerPathValue(schedulerOwnership, ["backupAutomationRun", "runRecord", "runRecordPath", "backupAutomationRunPath"]);
  const schedulerRunHistory = backupSchedulerPathValue(schedulerOwnership, ["backupAutomationRunHistory", "runHistory", "runHistoryPath", "backupAutomationHistoryPath"]);
  const selectedRunRecord = evidenceFilePath(backupAutomationRun, "backupAutomationRun");
  const selectedRunHistory = evidenceFilePath(backupAutomationRunHistory, "backupAutomationRunHistory");

  return Boolean(
    schedulerRunRecord &&
      schedulerRunHistory &&
      (!selectedRunRecord || selectedRunRecord === schedulerRunRecord) &&
      (!selectedRunHistory || selectedRunHistory === schedulerRunHistory)
  );
}

function backupSchedulerOwnershipOwnerPassed(candidate: Record<string, unknown> | undefined) {
  const owner = backupSchedulerStringValue(candidate, ["owner", "team"]) ??
    stringValue(nestedValue(candidate, ["owner", "name"])) ??
    stringValue(nestedValue(candidate, ["ownership", "team"]));
  const alertTarget = backupSchedulerStringValue(candidate, ["alertTarget", "alertChannel", "escalationTarget"]) ??
    stringValue(nestedValue(candidate, ["monitoring", "alertChannel"])) ??
    stringValue(nestedValue(candidate, ["monitoring", "escalationTarget"]));

  return Boolean(owner && alertTarget);
}

export function evaluateObservabilityEvidence(
  rawEvidence: unknown,
  options: ObservabilityEvidenceCheckOptions
): ObservabilityEvidenceCheckResult {
  const now = options.now?.() ?? new Date();
  const maxAgeHours = positiveNumber(options.maxAgeHours, defaultMaxAgeHours, "maxAgeHours");
  const root = rootObject(rawEvidence);
  const evidenceCommitRef = evidenceCommitValue(root);
  const evidenceRepository = evidenceRepositoryValue(root);
  const evidenceBranch = evidenceBranchValue(root);
  const evidenceTargetEnvironment = evidenceTargetEnvironmentValue(root);
  const releaseIdentityRequired = Boolean(options.commitRef || options.repo || options.branch || evidenceCommitRef || evidenceRepository || evidenceBranch);
  const targetEnvironmentRequired = Boolean(options.targetEnvironment || evidenceTargetEnvironment);
  const readinessProbe = selectEvidence(
    rawEvidence,
    ["readinessProbe", "readiness"],
    ["readiness_probe", "readiness-probe"],
    ["checkedAt", "timestamp", "createdAt"]
  );
  const metricsScrape = selectEvidence(
    rawEvidence,
    ["metricsScrape", "metrics"],
    ["metrics_scrape", "metrics-scrape"],
    ["scrapedAt", "checkedAt", "timestamp", "createdAt"]
  );
  const alertDelivery = selectEvidence(
    rawEvidence,
    ["alertDelivery", "alert"],
    ["alert_delivery", "alert-delivery"],
    ["deliveredAt", "checkedAt", "timestamp", "createdAt"]
  );
  const backupAutomationRun = selectEvidence(
    rawEvidence,
    ["backupAutomationRun", "backupAutomation"],
    ["backup_automation_run", "backup-automation-run"],
    ["completedAt", "checkedAt", "timestamp", "createdAt"]
  );
  const backupAutomationRunHistory = firstCandidate(
    rawEvidence,
    ["backupAutomationRunHistory", "backupAutomationHistory"]
  );
  const backupSchedulerOwnership = selectEvidence(
    rawEvidence,
    ["backupSchedulerOwnership", "backupScheduler"],
    ["backup_scheduler_ownership", "backup-scheduler-ownership"],
    ["checkedAt", "appliedAt", "timestamp", "createdAt"]
  );
  const observabilityApplyProof = selectEvidence(
    rawEvidence,
    ["observabilityApplyProof", "applyProof"],
    ["observability_apply_proof", "observability-apply-proof"],
    ["appliedAt", "checkedAt", "timestamp", "createdAt"]
  );
  const observabilityTargetStackProof = selectEvidence(
    rawEvidence,
    ["observabilityTargetStackProof", "targetStackProof"],
    ["observability_target_stack_proof", "observability-target-stack-proof"],
    ["checkedAt", "completedAt", "timestamp", "createdAt"]
  );
  const dashboard = selectEvidence(
    rawEvidence,
    ["dashboard", "operationsDashboard"],
    ["operations_dashboard", "dashboard"],
    ["checkedAt", "updatedAt", "timestamp", "createdAt"]
  );
  const logPipeline = selectEvidence(
    rawEvidence,
    ["logPipeline", "logs"],
    ["log_pipeline", "log-pipeline"],
    ["checkedAt", "timestamp", "createdAt"]
  );
  const latestHistory = latestHistoryRun(backupAutomationRunHistory);
  const successfulHistory = successfulHistoryRuns(backupAutomationRunHistory);
  const latestSuccessfulHistory = successfulHistory.at(-1);
  const minimumSuccessfulRestoreDrills =
    numberValue(nestedValue(backupAutomationRunHistory, ["cadence", "minimumSuccessfulRestoreDrills"])) ?? 2;
  const restoreDrillCadenceHours =
    numberValue(nestedValue(backupAutomationRunHistory, ["cadence", "restoreDrillMaxGapHours"])) ??
    defaultRestoreDrillCadenceHours;
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const checks: ObservabilityEvidenceCheck[] = [];

  if (releaseIdentityRequired) {
    addCheck(
      checks,
      "release_identity",
      Boolean(
        evidenceCommitRef &&
          evidenceRepository &&
          evidenceBranch &&
          (!options.commitRef || evidenceCommitRef === options.commitRef) &&
          (!options.repo || evidenceRepository === options.repo) &&
          (!options.branch || evidenceBranch === options.branch)
      ),
      "Observability evidence release identity must include matching commitRef, repository, and branch."
    );
  }

  if (targetEnvironmentRequired) {
    addCheck(
      checks,
      "target_environment",
      Boolean(evidenceTargetEnvironment && (!options.targetEnvironment || evidenceTargetEnvironment === options.targetEnvironment)),
      "Observability evidence targetEnvironment must match the expected release target environment."
    );
  }

  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Observability evidence must not include raw secret-like values."
      : `Observability evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );

  addCheck(checks, "readiness_present", Boolean(readinessProbe), "Readiness probe evidence must be present.");
  addCheck(
    checks,
    "readiness_status",
    Boolean(readinessProbe && isPassingStatus(readinessProbe.status)),
    "Readiness probe evidence status must be passing."
  );
  addCheck(
    checks,
    "readiness_age",
    freshTimestamp(readinessProbe, now, maxAgeHours),
    `Readiness probe evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "readiness_status_codes",
    readinessProbe?.healthyStatusCode === 200 && readinessProbe?.failureStatusCode === 503,
    "Readiness evidence must include healthyStatusCode: 200 and failureStatusCode: 503."
  );
  addCheck(
    checks,
    "readiness_traffic_removed",
    readinessProbe?.trafficRemovedOnFailure === true,
    "Readiness evidence must prove traffic is removed when /readyz fails."
  );

  addCheck(checks, "metrics_present", Boolean(metricsScrape), "Metrics scrape evidence must be present.");
  addCheck(
    checks,
    "metrics_status",
    Boolean(metricsScrape && isPassingStatus(metricsScrape.status)),
    "Metrics scrape evidence status must be passing."
  );
  addCheck(
    checks,
    "metrics_age",
    freshTimestamp(metricsScrape, now, maxAgeHours),
    `Metrics scrape evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "metrics_access_control",
    metricsScrape?.authenticated === true || metricsScrape?.privateScrapeException === true,
    "Metrics evidence must include authenticated: true or privateScrapeException: true."
  );
  addCheck(
    checks,
    "metrics_expected_names",
    includesAllStrings(metricsScrape?.metricNames, requiredSiteFlowMetricNames),
    "Metrics evidence must include the expected SiteFlow HTTP, queue, runtime, storage, and backup metric names."
  );

  addCheck(checks, "backup_automation_run_present", Boolean(backupAutomationRun), "Backup automation run evidence must be present.");
  addCheck(
    checks,
    "backup_automation_run_identity",
    backupAutomationRun?.name === "siteflow-backup-automation-run",
    "Backup automation run evidence must come from backup:automation."
  );
  addCheck(
    checks,
    "backup_automation_run_status",
    backupAutomationRun?.status === "completed" && backupAutomationRun?.exitCode === 0,
    "Backup automation run evidence must be completed with exitCode 0."
  );
  addCheck(
    checks,
    "backup_automation_run_age",
    freshTimestamp(backupAutomationRun, now, maxAgeHours),
    `Backup automation run evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "backup_automation_run_steps",
    [
      "backup",
      "backup_verify",
      "restore_drill",
      "backup_offload",
      "backup_prune_plan",
      "backup_prune",
      "backup_evidence"
    ].every((stepId) => stepCompleted(backupAutomationRun, stepId)),
    "Backup automation run evidence must show completed backup, verify, restore-drill, offload, prune, and evidence steps."
  );
  addCheck(
    checks,
    "backup_automation_checker_output",
    Boolean(evidenceFilePath(backupAutomationRun, "backupEvidenceCheck")) &&
      nestedObject(backupAutomationRun, "composeResult")?.status === "composed" &&
      nestedObject(nestedObject(backupAutomationRun, "composeResult"), "checkResult")?.status === "passed",
    "Backup automation run evidence must point to passed backup checker output."
  );
  addCheck(
    checks,
    "backup_automation_history_present",
    Boolean(backupAutomationRunHistory),
    "Backup automation run history evidence must be present."
  );
  addCheck(
    checks,
    "backup_automation_history_identity",
    backupAutomationRunHistory?.schemaVersion === "siteflow.backupAutomationRunHistory.v1" &&
      backupAutomationRunHistory?.name === "siteflow-backup-automation-run-history",
    "Backup automation run history must use the expected schema and name."
  );
  addCheck(
    checks,
    "backup_automation_history_latest_run",
    Boolean(
      latestHistory &&
        backupAutomationRun &&
        latestHistory.status === backupAutomationRun.status &&
        latestHistory.completedAt === backupAutomationRun.completedAt &&
        (
          !evidenceFilePath(backupAutomationRun, "backupAutomationRun") ||
            nestedObject(latestHistory, "evidenceFiles")?.backupAutomationRun === evidenceFilePath(backupAutomationRun, "backupAutomationRun")
        )
    ),
    "Backup automation history latest run must match the selected backup automation run."
  );
  addCheck(
    checks,
    "backup_automation_history_latest_status",
    latestHistory?.status === "completed" && latestHistory?.exitCode === 0,
    "Backup automation history latest run must be completed with exitCode 0."
  );
  addCheck(
    checks,
    "backup_restore_drill_cadence_count",
    successfulHistory.length >= minimumSuccessfulRestoreDrills,
    `Backup automation history must include at least ${minimumSuccessfulRestoreDrills} successful restore drills.`
  );
  addCheck(
    checks,
    "backup_restore_drill_cadence_gap",
    successfulHistory.length >= minimumSuccessfulRestoreDrills &&
      maxHistoryGapHours(successfulHistory) <= restoreDrillCadenceHours,
    `Backup automation restore-drill history must not have gaps over ${restoreDrillCadenceHours} hours.`
  );
  addCheck(
    checks,
    "backup_history_checker_output",
    successfulHistory.length >= minimumSuccessfulRestoreDrills &&
      successfulHistory.every(({ run }) => run.backupEvidenceStatus === "passed" || run.composeStatus === "composed"),
    "Backup automation history successful runs must have passed backup checker output."
  );

  addCheck(
    checks,
    "backup_scheduler_ownership_present",
    Boolean(backupSchedulerOwnership),
    "Backup scheduler ownership evidence must be present."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_status",
    backupSchedulerOwnership?.status === "applied" || backupSchedulerOwnership?.status === "passed",
    "Backup scheduler ownership status must be applied or passed."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_age",
    freshTimestamp(backupSchedulerOwnership, now, maxAgeHours),
    `Backup scheduler ownership evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_schema",
    backupSchedulerOwnership?.schemaVersion === "siteflow.backupSchedulerOwnership.v1" &&
      backupSchedulerOwnership?.name === "siteflow-backup-scheduler-ownership",
    "Backup scheduler ownership evidence must use the expected schema and name."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_source",
    backupSchedulerOwnershipSourcePassed(backupSchedulerOwnership),
    "Backup scheduler ownership evidence must include proof source, operator, and ticket."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_target_environment",
    targetStackEnvironmentMatches(backupSchedulerOwnership, options.targetEnvironment ?? evidenceTargetEnvironment),
    "Backup scheduler ownership targetEnvironment must match the selected release target environment."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_enabled",
    backupSchedulerOwnershipEnabled(backupSchedulerOwnership),
    "Backup scheduler ownership evidence must include enabled scheduler kind and id."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_schedule",
    backupSchedulerOwnershipSchedulePassed(backupSchedulerOwnership),
    "Backup scheduler ownership evidence must include schedule and timezone."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_command",
    backupSchedulerOwnershipCommandPassed(backupSchedulerOwnership),
    "Backup scheduler ownership evidence must point at backup:automation."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_run_links",
    backupSchedulerOwnershipRunLinksPassed(backupSchedulerOwnership, backupAutomationRun, backupAutomationRunHistory),
    "Backup scheduler ownership evidence must link the selected backup automation run record and run history paths."
  );
  addCheck(
    checks,
    "backup_scheduler_ownership_owner",
    backupSchedulerOwnershipOwnerPassed(backupSchedulerOwnership),
    "Backup scheduler ownership evidence must include owner/team and alert or escalation target."
  );

  addCheck(checks, "observability_apply_proof_present", Boolean(observabilityApplyProof), "Observability apply proof evidence must be present.");
  addCheck(
    checks,
    "observability_apply_proof_status",
    observabilityApplyProof?.status === "applied" || observabilityApplyProof?.status === "passed",
    "Observability apply proof status must be applied or passed."
  );
  addCheck(
    checks,
    "observability_apply_proof_age",
    freshTimestamp(observabilityApplyProof, now, maxAgeHours),
    `Observability apply proof must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "observability_apply_proof_schema",
    observabilityApplyProof?.schemaVersion === "siteflow.observabilityApplyProof.v1" &&
      observabilityApplyProof?.name === "siteflow-observability-apply-proof",
    "Observability apply proof must use the expected schema and name."
  );
  addCheck(
    checks,
    "observability_apply_proof_source",
    Boolean(stringValue(observabilityApplyProof?.evidenceSource) && stringValue(observabilityApplyProof?.operator) && stringValue(observabilityApplyProof?.ticket)),
    "Observability apply proof must include evidenceSource, operator, and ticket."
  );
  addCheck(
    checks,
    "observability_apply_proof_non_dry_run",
    productionProofNotDryRun(observabilityApplyProof),
    "Observability apply proof must come from a production apply, not a template or dry-run."
  );
  addCheck(
    checks,
    "observability_apply_proof_plan_schema",
    nestedObject(observabilityApplyProof, "provisioningPlan")?.schemaVersion === "siteflow.observabilityProvisioning.v1",
    "Observability apply proof must reference a SiteFlow observability provisioning plan."
  );
  addCheck(
    checks,
    "observability_apply_proof_assets",
    applyProofAssetsMatchPlan(observabilityApplyProof, rawEvidence),
    "Observability apply proof must include applied asset hashes matching the rendered provisioning assets."
  );

  addCheck(checks, "observability_target_stack_proof_present", Boolean(observabilityTargetStackProof), "Observability target-stack proof evidence must be present.");
  addCheck(
    checks,
    "observability_target_stack_proof_status",
    observabilityTargetStackProof?.status === "passed",
    "Observability target-stack proof status must be passed."
  );
  addCheck(
    checks,
    "observability_target_stack_proof_age",
    freshTimestamp(observabilityTargetStackProof, now, maxAgeHours),
    `Observability target-stack proof must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "observability_target_stack_proof_schema",
    observabilityTargetStackProof?.schemaVersion === "siteflow.observabilityTargetStackProof.v1" &&
      observabilityTargetStackProof?.name === "siteflow-observability-target-stack-proof",
    "Observability target-stack proof must use the expected schema and name."
  );
  addCheck(
    checks,
    "observability_target_stack_proof_source",
    observabilityTargetStackProof?.evidenceSource === "target_stack_api" &&
      Boolean(stringValue(observabilityTargetStackProof?.operator) && stringValue(observabilityTargetStackProof?.ticket)),
    "Observability target-stack proof must come from target_stack_api and include operator and ticket."
  );
  addCheck(
    checks,
    "observability_target_stack_proof_non_dry_run",
    productionProofNotDryRun(observabilityTargetStackProof),
    "Observability target-stack proof must come from a real target stack query, not a template or dry-run."
  );
  addCheck(
    checks,
    "observability_target_stack_proof_release_identity",
    targetStackReleaseIdentityMatches(
      observabilityTargetStackProof,
      options.commitRef ?? evidenceCommitRef,
      options.repo ?? evidenceRepository,
      options.branch ?? evidenceBranch
    ),
    "Observability target-stack proof release identity must match the selected release commit, repository, and branch."
  );
  addCheck(
    checks,
    "observability_target_stack_proof_target_environment",
    targetStackEnvironmentMatches(observabilityTargetStackProof, options.targetEnvironment ?? evidenceTargetEnvironment),
    "Observability target-stack proof targetEnvironment must match the selected release target environment."
  );
  addCheck(
    checks,
    "observability_target_stack_prometheus_rules",
    targetStackPrometheusRulesPassed(observabilityTargetStackProof, rawEvidence),
    "Observability target-stack proof must show Prometheus API loaded matching SiteFlow alert rules."
  );
  addCheck(
    checks,
    "observability_target_stack_grafana_dashboard",
    targetStackGrafanaDashboardPassed(observabilityTargetStackProof, rawEvidence),
    "Observability target-stack proof must show Grafana API has the SiteFlow dashboard with required metric queries."
  );
  addCheck(
    checks,
    "observability_target_stack_alertmanager_receiver",
    targetStackAlertmanagerReceiverPassed(observabilityTargetStackProof, rawEvidence),
    "Observability target-stack proof must show Alertmanager test alert delivery to the configured receiver."
  );

  addCheck(checks, "alert_present", Boolean(alertDelivery), "Alert delivery evidence must be present.");
  addCheck(
    checks,
    "alert_status",
    Boolean(alertDelivery && isPassingStatus(alertDelivery.status)),
    "Alert delivery evidence status must be passing."
  );
  addCheck(
    checks,
    "alert_age",
    freshTimestamp(alertDelivery, now, maxAgeHours),
    `Alert delivery evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "alert_delivered",
    alertDelivery?.delivered === true && Boolean(stringValue(alertDelivery?.channel) ?? stringValue(alertDelivery?.target)),
    "Alert evidence must include delivered: true and a delivery channel or target."
  );

  addCheck(checks, "dashboard_present", Boolean(dashboard), "Operations dashboard evidence must be present.");
  addCheck(
    checks,
    "dashboard_status",
    Boolean(dashboard && isPassingStatus(dashboard.status)),
    "Dashboard evidence status must be passing."
  );
  addCheck(
    checks,
    "dashboard_age",
    freshTimestamp(dashboard, now, maxAgeHours),
    `Dashboard evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "dashboard_reference",
    hasDashboardReference(dashboard),
    "Dashboard evidence must include a dashboard URL or UID."
  );
  addCheck(
    checks,
    "dashboard_owner",
    Boolean(dashboard && (stringValue(dashboard.owner) ?? stringValue(dashboard.team))),
    "Dashboard evidence must include an owner or team."
  );

  addCheck(checks, "log_pipeline_present", Boolean(logPipeline), "Log pipeline evidence must be present.");
  addCheck(
    checks,
    "log_pipeline_status",
    Boolean(logPipeline && isPassingStatus(logPipeline.status)),
    "Log pipeline evidence status must be passing."
  );
  addCheck(
    checks,
    "log_pipeline_age",
    freshTimestamp(logPipeline, now, maxAgeHours),
    `Log pipeline evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "log_retention",
    typeof logPipeline?.retentionDays === "number" && Number.isFinite(logPipeline.retentionDays) && logPipeline.retentionDays > 0,
    "Log pipeline evidence must include a positive retentionDays value."
  );
  addCheck(
    checks,
    "log_redaction_spot_check",
    logPipeline?.redactionSpotCheckPassed === true,
    "Log pipeline evidence must include redactionSpotCheckPassed: true."
  );

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-observability-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxAgeHours
    },
    selectedEvidence: {
      commitRef: evidenceCommitRef ?? null,
      repository: evidenceRepository ?? null,
      branch: evidenceBranch ?? null,
      targetEnvironment: evidenceTargetEnvironment ?? null,
      readinessProbe: summarizeEvidence(readinessProbe),
      metricsScrape: summarizeMetricsScrapeEvidence(metricsScrape),
      backupAutomationRun: summarizeEvidence(backupAutomationRun),
      backupAutomationRunHistory: summarizeEvidence(backupAutomationRunHistory),
      backupSchedulerOwnership: summarizeEvidence(backupSchedulerOwnership),
      observabilityApplyProof: summarizeEvidence(observabilityApplyProof),
      observabilityTargetStackProof: summarizeEvidence(observabilityTargetStackProof),
      alertDelivery: summarizeEvidence(alertDelivery),
      dashboard: summarizeEvidence(dashboard),
      logPipeline: summarizeEvidence(logPipeline)
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runObservabilityEvidenceCheck(
  options: ObservabilityEvidenceCheckOptions
): Promise<ObservabilityEvidenceCheckResult> {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateObservabilityEvidence(raw, options);
}

export function parseObservabilityEvidenceCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false,
    maxAgeHours: defaultMaxAgeHours
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--evidence") {
      parsed.evidencePath = args[++index];
    } else if (arg === "--commit-ref") {
      parsed.commitRef = args[++index];
    } else if (arg === "--repo") {
      parsed.repo = args[++index];
    } else if (arg === "--branch") {
      parsed.branch = args[++index];
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = args[++index];
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(args[++index]);
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.evidencePath) {
    throw new Error("--evidence <file> is required.");
  }

  positiveNumber(parsed.maxAgeHours, defaultMaxAgeHours, "--max-age-hours");

  return parsed;
}

export function observabilityEvidenceCheckUsage() {
  return [
    "Usage: npm run --silent observability:evidence -- --evidence <file> [--json]",
    "",
    "Options:",
    "  --evidence <file>              Evidence JSON containing readiness, metrics, alert, dashboard, and log records.",
    "  --commit-ref <sha>             Require observability evidence to be bound to this release commit.",
    "  --repo <owner/repo>            Require observability evidence to be bound to this repository.",
    "  --branch <branch>              Require observability evidence to be bound to this branch.",
    "  --target-environment <name>    Require observability evidence to be bound to this target environment.",
    `  --max-age-hours <hours>        Maximum evidence age. Default: ${defaultMaxAgeHours}.`,
    "  --json                        Emit a single JSON result.",
    "  --help                        Show this help."
  ].join("\n");
}

function writeHumanResult(result: ObservabilityEvidenceCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow observability evidence status: ${result.status}\n`);
  output.write(`Evidence: ${result.evidencePath}\n`);
  output.write("Checks:\n");

  for (const check of result.checks) {
    output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
  }
}

export async function runObservabilityEvidenceCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ObservabilityEvidenceCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseObservabilityEvidenceCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${observabilityEvidenceCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${observabilityEvidenceCheckUsage()}\n`);
    return 0;
  }

  try {
    const result = await runObservabilityEvidenceCheck({
      ...baseOptions,
      evidencePath: parsed.evidencePath!,
      maxAgeHours: parsed.maxAgeHours,
      commitRef: parsed.commitRef,
      repo: parsed.repo,
      branch: parsed.branch,
      targetEnvironment: parsed.targetEnvironment
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: ObservabilityEvidenceCheckResult = {
      name: "siteflow-observability-evidence-check",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      evidencePath: parsed.evidencePath!,
      thresholds: {
        maxAgeHours: parsed.maxAgeHours
      },
      selectedEvidence: {
        commitRef: null,
        repository: null,
        branch: null,
        targetEnvironment: null,
        readinessProbe: null,
        metricsScrape: null,
        backupAutomationRun: null,
        backupAutomationRunHistory: null,
        backupSchedulerOwnership: null,
        observabilityApplyProof: null,
        observabilityTargetStackProof: null,
        alertDelivery: null,
        dashboard: null,
        logPipeline: null
      },
      checks: [
        {
          name: "evidence_file",
          status: "fail",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      exitCode: 1
    };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runObservabilityEvidenceCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
