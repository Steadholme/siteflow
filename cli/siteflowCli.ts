import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyInstallPlan, type InstallApplyOptions } from "./installApply.js";
import { createSingleHostInstallPlan, formatInstallPlan } from "./installPlan.js";
import { parseInstallState } from "./installState.js";
import { formatDoctorReport, runDoctor, type DoctorOptions } from "./doctor.js";
import { deployPrebuilt, formatPrebuiltDeployResult, type DeployPrebuiltOptions } from "./deploy.js";
import { readCliConfig, resolveServerConfig, saveLoginConfig } from "./config.js";
import { readProjectLink, writeProjectLink } from "./projectLink.js";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliDependencies {
  doctor?: DoctorOptions;
  install?: InstallApplyOptions;
  version?: string;
  fetch?: DeployPrebuiltOptions["fetch"];
  env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

interface DeploymentListItem {
  id: string;
  projectId: string;
  projectName: string;
  version: string;
  commitSha: string;
  branch: string;
  status: string;
  routeRevisionStatus: string;
  createdAt: string;
}

interface DeploymentListResponse {
  deployments: DeploymentListItem[];
  total: number;
}

interface DeploymentInspectResponse {
  project: {
    name: string;
  };
  deployment: {
    id: string;
    status: string;
    environment: string;
    version: string;
    readyAt?: string;
  };
  lineage: {
    sourceEvent: {
      branch: string;
      commitSha: string;
    };
    buildJob: {
      status: string;
    };
    artifact: {
      verificationStatus: string;
      manifest: {
        fileCount: number;
        totalBytes: number;
        checksum: string;
      };
    };
    routeRevision?: {
      id: string;
      status: string;
    };
  };
}

interface ProjectSettingsResponse {
  project: {
    id: string;
    slug: string;
    name: string;
  };
  environmentVariables: Array<{
    key: string;
    targetEnvironment: string;
    scope: string;
    source: string;
    fingerprint: string;
  }>;
  apiTokens?: Array<{
    id: string;
    projectId?: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    status: string;
    createdAt: string;
    updatedAt: string;
    revokedAt?: string;
    lastUsedAt?: string;
  }>;
  auditEvents?: Array<{
    id: string;
    action: string;
    actor: {
      name: string;
    };
    targetType: string;
    targetId: string;
    summary: string;
    reason?: string;
    createdAt: string;
  }>;
}

interface CommandResultResponse {
  status: string;
  operationId?: string;
  message: string;
  routeRevision?: {
    id: string;
    status: string;
    channel: string;
    deploymentId: string;
  };
  safetyChecks?: Array<{
    label: string;
    status: string;
    summary: string;
  }>;
}

interface DeployHookItem {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  targetEnvironment: string;
  tokenPrefix: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  lastTriggeredAt?: string;
}

interface DeployHookListResponse {
  projectId: string;
  hooks: DeployHookItem[];
  total: number;
  updatedAt: string;
}

interface DeployHookCreateResponse {
  status: string;
  hook: DeployHookItem;
  token: string;
  hookUrl?: string;
  message: string;
}

interface DeployHookRevokeResponse {
  status: string;
  hook: DeployHookItem;
  message: string;
}

interface CronJobItem {
  id: string;
  projectId: string;
  name: string;
  path: string;
  schedule: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
  lastDispatchedAt?: string;
}

interface CronJobListResponse {
  projectId: string;
  jobs: CronJobItem[];
  total: number;
  updatedAt: string;
}

interface CronJobCreateResponse {
  status: string;
  job: CronJobItem;
  message: string;
}

interface CronJobDisableResponse {
  status: string;
  job: CronJobItem;
  message: string;
}

interface CronJobRunResponse {
  status: string;
  job?: CronJobItem;
  dispatch?: {
    id: string;
    cronJobId: string;
    projectId: string;
    targetUrl: string;
    method: string;
    userAgent: string;
    status: string;
    reason: string;
    scheduledAt: string;
    dispatchedAt: string;
  };
  message: string;
}

interface LogEntryItem {
  id: string;
  projectId: string;
  source: string;
  severity: string;
  message: string;
  timestamp: string;
  deploymentId?: string;
  buildJobId?: string;
  cronJobId?: string;
  requestId?: string;
}

interface LogQueryResponse {
  projectId: string;
  filters: {
    source?: string;
    severity?: string;
    deploymentId?: string;
    search?: string;
  };
  entries: LogEntryItem[];
  total: number;
  nextCursor?: string;
  updatedAt: string;
}

interface LogDrainItem {
  id: string;
  projectId: string;
  name: string;
  url: string;
  sources: string[];
  minimumSeverity: string;
  status: string;
  signingSecretPrefix: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveredAt?: string;
}

interface LogDrainListResponse {
  projectId: string;
  drains: LogDrainItem[];
  total: number;
  updatedAt: string;
}

interface LogDrainCreateResponse {
  status: string;
  drain: LogDrainItem;
  message: string;
}

interface LogDrainDeliveryResponse {
  status: string;
  drain: LogDrainItem;
  delivery: {
    id: string;
    drainId: string;
    projectId: string;
    status: string;
    responseStatus?: number;
    eventsDelivered: number;
    attempt: number;
    payloadSha256: string;
    errorMessage?: string;
    deliveredAt: string;
  };
  message: string;
}

interface ApiTokenCreateResponse {
  status: string;
  token: {
    id: string;
    projectId?: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  secret: string;
  message: string;
}

interface ApiTokenRevokeResponse {
  status: string;
  token: {
    id: string;
    projectId?: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    status: string;
    updatedAt: string;
    revokedAt?: string;
  };
  message: string;
}

interface FirewallRuleItem {
  id: string;
  projectId: string;
  name: string;
  action: string;
  priority: number;
  status: string;
  conditions: {
    ipRanges?: string[];
    pathPattern?: string;
    header?: {
      name: string;
      value?: string;
    };
    userAgent?: string;
  };
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
}

interface FirewallRuleListResponse {
  projectId: string;
  rules: FirewallRuleItem[];
  total: number;
  updatedAt: string;
}

interface FirewallRuleMutationResponse {
  status: string;
  rule: FirewallRuleItem;
  message: string;
}

interface EdgeConfigEntryItem {
  id: string;
  projectId: string;
  key: string;
  value: unknown;
  valueType: string;
  createdAt: string;
  updatedAt: string;
}

interface EdgeConfigResponse {
  projectId: string;
  entries: EdgeConfigEntryItem[];
  total: number;
  updatedAt: string;
}

interface EdgeConfigMutationResponse {
  status: string;
  entry?: EdgeConfigEntryItem;
  message: string;
}

interface BlobItem {
  id: string;
  projectId: string;
  pathname: string;
  contentType: string;
  access: "public" | "private";
  size: number;
  sha256: string;
  cacheControlMaxAge?: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface BlobListResponse {
  projectId: string;
  blobs: BlobItem[];
  total: number;
  nextCursor?: string;
  updatedAt: string;
}

interface BlobReadResponse {
  projectId: string;
  blob: BlobItem;
  contentBase64: string;
}

interface BlobMutationResponse {
  status: string;
  blob: BlobItem;
  message: string;
}

interface CacheEntryItem {
  id: string;
  projectId: string;
  key: string;
  path: string;
  tags: string[];
  status: string;
  contentType: string;
  size: number;
  etag: string;
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
  lastGeneratedAt: string;
  expiresAt: string;
  staleAt: string;
  purgedAt?: string;
  updatedAt: string;
}

interface CacheListResponse {
  projectId: string;
  entries: CacheEntryItem[];
  total: number;
  updatedAt: string;
}

interface CachePurgeResponse {
  status: string;
  projectId: string;
  purged: CacheEntryItem[];
  total: number;
  message: string;
}

interface FunctionRuntimeEntry {
  projectId: string;
  deploymentId: string;
  function: {
    path: string;
    sourcePath: string;
    runtime: string;
    handler: string;
    methods?: string[];
    regions?: string[];
    failoverRegions?: string[];
  };
  limits: {
    timeoutMs: number;
    memoryMb: number;
    concurrency: number;
  };
  summary: {
    invocations: number;
    errors: number;
    errorRate: number;
    averageDurationMs: number;
    p95DurationMs: number;
    lastInvokedAt?: string;
  };
}

interface FunctionRuntimeListResponse {
  projectId: string;
  deploymentId?: string;
  functions: FunctionRuntimeEntry[];
  total: number;
  updatedAt: string;
}

interface FunctionRuntimeResponse {
  projectId: string;
  deploymentId: string;
  function: FunctionRuntimeEntry;
  recentInvocations: Array<{
    id: string;
    path: string;
    method: string;
    status: string;
    responseStatus: number;
    durationMs: number;
    requestId: string;
    errorMessage?: string;
    invokedAt: string;
  }>;
  updatedAt: string;
}

interface RoutingHeaderItem {
  key: string;
  value: string;
}

interface RoutingRuleItem {
  id: string;
  projectId: string;
  name: string;
  kind: "redirect" | "rewrite" | "header";
  source: string;
  destination?: string;
  statusCode?: number;
  headers?: RoutingHeaderItem[];
  priority: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
}

interface RoutingRuleListResponse {
  projectId: string;
  rules: RoutingRuleItem[];
  total: number;
  updatedAt: string;
}

interface RoutingRuleMutationResponse {
  status: string;
  rule: RoutingRuleItem;
  message: string;
}

interface RollingCommandResponse {
  status: string;
  message: string;
  rollout?: {
    id: string;
    channel: string;
    currentDeploymentId: string;
    candidateDeploymentId: string;
    percentage: number;
    status: string;
  };
  routeRevision?: {
    id: string;
    status: string;
    channel: string;
    deploymentId: string;
  };
  safetyChecks?: Array<{
    label: string;
    status: string;
    summary: string;
  }>;
}

const lifecycleCommands = new Set(["backup", "restore", "upgrade", "uninstall"]);

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const next = rest[index + 1];

    if (inlineValue !== undefined) {
      flags[rawName] = inlineValue;
      continue;
    }

    if (next && !next.startsWith("--")) {
      flags[rawName] = next;
      index += 1;
      continue;
    }

    flags[rawName] = true;
  }

  return { command, flags, positionals };
}

function flagString(flags: Record<string, string | boolean>, name: string) {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(flags: Record<string, string | boolean>, name: string) {
  return flags[name] === true || flags[name] === "true" || flags[name] === "1";
}

function writeJson(io: CliIo, value: unknown) {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function formatShortSha(value: string) {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatDeploymentsList(list: DeploymentListResponse) {
  if (list.deployments.length === 0) {
    return "No deployments found.";
  }

  return list.deployments.map((deployment) => [
    deployment.id,
    deployment.projectName,
    deployment.status,
    deployment.routeRevisionStatus,
    `${deployment.branch}@${formatShortSha(deployment.commitSha)}`,
    deployment.createdAt
  ].join("  ")).join("\n");
}

function formatDeploymentInspect(detail: DeploymentInspectResponse) {
  const route = detail.lineage.routeRevision;

  return [
    `Deployment ${detail.deployment.id}`,
    `Project:    ${detail.project.name}`,
    `Status:     ${detail.deployment.status}`,
    `Target:     ${detail.deployment.environment}`,
    `Version:    ${detail.deployment.version}`,
    `Source:     ${detail.lineage.sourceEvent.branch}@${formatShortSha(detail.lineage.sourceEvent.commitSha)}`,
    `Build:      ${detail.lineage.buildJob.status}`,
    `Artifact:   ${detail.lineage.artifact.verificationStatus} / ${detail.lineage.artifact.manifest.fileCount} files / ${detail.lineage.artifact.manifest.totalBytes} bytes`,
    `Route:      ${route ? `${route.id} / ${route.status}` : "not applied"}`
  ].join("\n");
}

function formatCommandResult(result: CommandResultResponse) {
  const route = result.routeRevision;
  const lines = [
    `Status:    ${result.status}`,
    `Message:   ${result.message}`,
    `Operation: ${result.operationId ?? "not created"}`,
    `Route:     ${route ? `${route.id} / ${route.status} / ${route.channel}` : "not planned"}`
  ];

  for (const check of result.safetyChecks ?? []) {
    lines.push(`Check:     ${check.status} / ${check.label} / ${check.summary}`);
  }

  return lines.join("\n");
}

function formatDeployHooksList(list: DeployHookListResponse) {
  if (list.hooks.length === 0) {
    return "No deploy hooks found.";
  }

  return list.hooks.map((hook) => [
    hook.id,
    hook.name,
    hook.status,
    `${hook.branch}:${hook.targetEnvironment}`,
    hook.tokenPrefix,
    hook.lastTriggeredAt ?? "never"
  ].join("  ")).join("\n");
}

function formatDeployHookCreate(result: DeployHookCreateResponse) {
  return [
    `Status: ${result.status}`,
    `Hook:   ${result.hook.id}`,
    `Name:   ${result.hook.name}`,
    `Target: ${result.hook.branch}:${result.hook.targetEnvironment}`,
    `URL:    ${result.hookUrl ?? "not returned"}`,
    `Token:  ${result.token}`
  ].join("\n");
}

function formatDeployHookRevoke(result: DeployHookRevokeResponse) {
  return [
    `Status: ${result.status}`,
    `Hook:   ${result.hook.id}`,
    `Name:   ${result.hook.name}`,
    `Target: ${result.hook.branch}:${result.hook.targetEnvironment}`
  ].join("\n");
}

function formatCronJobsList(list: CronJobListResponse) {
  if (list.jobs.length === 0) {
    return "No cron jobs found.";
  }

  return list.jobs.map((job) => [
    job.id,
    job.name,
    job.status,
    job.schedule,
    job.path,
    job.lastDispatchedAt ?? "never"
  ].join("  ")).join("\n");
}

function formatCronJobCreate(result: CronJobCreateResponse) {
  return [
    `Status:   ${result.status}`,
    `Job:      ${result.job.id}`,
    `Name:     ${result.job.name}`,
    `Schedule: ${result.job.schedule}`,
    `Path:     ${result.job.path}`
  ].join("\n");
}

function formatCronJobDisable(result: CronJobDisableResponse) {
  return [
    `Status: ${result.status}`,
    `Job:    ${result.job.id}`,
    `Name:   ${result.job.name}`,
    `Path:   ${result.job.path}`
  ].join("\n");
}

function formatCronJobRun(result: CronJobRunResponse) {
  return [
    `Status:   ${result.status}`,
    `Message:  ${result.message}`,
    `Job:      ${result.job?.id ?? "not found"}`,
    `Dispatch: ${result.dispatch ? `${result.dispatch.id} / ${result.dispatch.status}` : "not queued"}`,
    `Target:   ${result.dispatch?.targetUrl ?? "not resolved"}`,
    `Agent:    ${result.dispatch?.userAgent ?? "not set"}`
  ].join("\n");
}

function formatLogQuery(result: LogQueryResponse) {
  if (result.entries.length === 0) {
    return "No logs matched.";
  }

  const lines = result.entries.map((entry) => [
    entry.timestamp,
    entry.source,
    entry.severity,
    entry.deploymentId ?? entry.requestId ?? entry.cronJobId ?? entry.buildJobId ?? "-",
    entry.message
  ].join("  "));

  if (result.nextCursor) {
    lines.push(`Next cursor: ${result.nextCursor}`);
  }

  return lines.join("\n");
}

function formatLogDrainsList(list: LogDrainListResponse) {
  if (list.drains.length === 0) {
    return "No log drains found.";
  }

  return list.drains.map((drain) => [
    drain.id,
    drain.name,
    drain.status,
    drain.minimumSeverity,
    drain.sources.join(","),
    drain.signingSecretPrefix,
    drain.lastDeliveredAt ?? "never"
  ].join("  ")).join("\n");
}

function formatLogDrainCreate(result: LogDrainCreateResponse) {
  return [
    `Status:   ${result.status}`,
    `Drain:    ${result.drain.id}`,
    `Name:     ${result.drain.name}`,
    `Sources:  ${result.drain.sources.join(",")}`,
    `Severity: ${result.drain.minimumSeverity}`,
    `Secret:   ${result.drain.signingSecretPrefix}`
  ].join("\n");
}

function formatLogDrainDelivery(result: LogDrainDeliveryResponse) {
  return [
    `Status:   ${result.status}`,
    `Message:  ${result.message}`,
    `Drain:    ${result.drain.id}`,
    `Delivery: ${result.delivery.id} / ${result.delivery.status}`,
    `Events:   ${result.delivery.eventsDelivered}`,
    `HTTP:     ${result.delivery.responseStatus ?? "not returned"}`
  ].join("\n");
}

function formatAuditEvents(settings: ProjectSettingsResponse) {
  const events = settings.auditEvents ?? [];

  if (events.length === 0) {
    return "No audit events found.";
  }

  return events.map((event) => [
    event.createdAt,
    event.action,
    event.actor.name,
    `${event.targetType}:${event.targetId}`,
    event.summary
  ].join("  ")).join("\n");
}

function formatApiTokens(settings: ProjectSettingsResponse) {
  const tokens = settings.apiTokens ?? [];

  if (tokens.length === 0) {
    return "No scoped API tokens found.";
  }

  return tokens.map((token) => [
    token.id,
    token.name,
    token.status,
    token.scopes.join(","),
    token.tokenPrefix,
    token.lastUsedAt ?? "never"
  ].join("  ")).join("\n");
}

function formatApiTokenCreate(result: ApiTokenCreateResponse) {
  return [
    `Status: ${result.status}`,
    `Token:  ${result.token.id}`,
    `Name:   ${result.token.name}`,
    `Scopes: ${result.token.scopes.join(",")}`,
    `Secret: ${result.secret}`
  ].join("\n");
}

function formatApiTokenRevoke(result: ApiTokenRevokeResponse) {
  return [
    `Status: ${result.status}`,
    `Token:  ${result.token.id}`,
    `Name:   ${result.token.name}`,
    `Scopes: ${result.token.scopes.join(",")}`
  ].join("\n");
}

function formatFirewallConditions(rule: FirewallRuleItem) {
  const parts = [
    rule.conditions.pathPattern ? `path=${rule.conditions.pathPattern}` : undefined,
    rule.conditions.ipRanges?.length ? `ip=${rule.conditions.ipRanges.join(",")}` : undefined,
    rule.conditions.header ? `header=${rule.conditions.header.name}${rule.conditions.header.value ? `=${rule.conditions.header.value}` : ""}` : undefined,
    rule.conditions.userAgent ? `ua=${rule.conditions.userAgent}` : undefined
  ].filter(Boolean);

  return parts.join(" ");
}

function formatFirewallRules(list: FirewallRuleListResponse) {
  if (list.rules.length === 0) {
    return "No firewall rules found.";
  }

  return list.rules.map((rule) => [
    rule.id,
    rule.name,
    rule.status,
    rule.action,
    `priority=${rule.priority}`,
    formatFirewallConditions(rule) || "all requests"
  ].join("  ")).join("\n");
}

function formatFirewallRuleMutation(result: FirewallRuleMutationResponse) {
  return [
    `Status:     ${result.status}`,
    `Rule:       ${result.rule.id}`,
    `Name:       ${result.rule.name}`,
    `Action:     ${result.rule.action}`,
    `Priority:   ${result.rule.priority}`,
    `Conditions: ${formatFirewallConditions(result.rule) || "all requests"}`
  ].join("\n");
}

function formatEdgeConfig(list: EdgeConfigResponse) {
  if (list.entries.length === 0) {
    return "No Edge Config entries found.";
  }

  return list.entries.map((entry) => [
    entry.key,
    entry.valueType,
    JSON.stringify(entry.value)
  ].join("  ")).join("\n");
}

function formatEdgeConfigMutation(result: EdgeConfigMutationResponse) {
  return [
    `Status: ${result.status}`,
    `Key:    ${result.entry?.key ?? "deleted"}`,
    `Type:   ${result.entry?.valueType ?? "n/a"}`,
    `Value:  ${result.entry ? JSON.stringify(result.entry.value) : "n/a"}`
  ].join("\n");
}

function formatBlobs(list: BlobListResponse) {
  if (list.blobs.length === 0) {
    return "No blobs found.";
  }

  return list.blobs.map((blob) => [
    blob.pathname,
    blob.contentType,
    blob.access,
    `${blob.size}b`,
    formatShortSha(blob.sha256)
  ].join("  ")).join("\n");
}

function formatBlobMutation(result: BlobMutationResponse) {
  return [
    `Status:       ${result.status}`,
    `Pathname:     ${result.blob.pathname}`,
    `Content-Type: ${result.blob.contentType}`,
    `Access:       ${result.blob.access}`,
    `Size:         ${result.blob.size}b`,
    `SHA256:       ${result.blob.sha256}`,
    `URL:          ${result.blob.url}`
  ].join("\n");
}

function formatBlobRead(result: BlobReadResponse, output: string) {
  return [
    "Status:       downloaded",
    `Pathname:     ${result.blob.pathname}`,
    `Content-Type: ${result.blob.contentType}`,
    `Access:       ${result.blob.access}`,
    `Size:         ${result.blob.size}b`,
    `Output:       ${output}`
  ].join("\n");
}

function formatCacheEntries(list: CacheListResponse) {
  if (list.entries.length === 0) {
    return "No cache entries found.";
  }

  return list.entries.map((entry) => [
    entry.path,
    entry.status,
    entry.tags.join(",") || "untagged",
    `${entry.maxAgeSeconds}s`,
    `${entry.staleWhileRevalidateSeconds}s`,
    entry.etag
  ].join("  ")).join("\n");
}

function formatCachePurge(result: CachePurgeResponse) {
  return [
    `Status: ${result.status}`,
    `Purged: ${result.total}`,
    `Keys:   ${result.purged.map((entry) => entry.key).join(", ") || "none"}`
  ].join("\n");
}

function formatFunctions(list: FunctionRuntimeListResponse) {
  if (list.functions.length === 0) {
    return "No functions found.";
  }

  return list.functions.map((entry) => [
    entry.function.path,
    entry.function.runtime,
    entry.function.methods?.join(",") ?? "ANY",
    `${entry.limits.timeoutMs}ms`,
    `${entry.limits.memoryMb}mb`,
    `concurrency=${entry.limits.concurrency}`,
    `regions=${entry.function.regions?.join(",") ?? "default"}`,
    `errors=${entry.summary.errors}/${entry.summary.invocations}`,
    `avg=${entry.summary.averageDurationMs}ms`
  ].join("  ")).join("\n");
}

function formatFunctionRuntime(result: FunctionRuntimeResponse) {
  const entry = result.function;
  const lines = [
    `Function:    ${entry.function.path}`,
    `Runtime:     ${entry.function.runtime}`,
    `Source:      ${entry.function.sourcePath}`,
    `Methods:     ${entry.function.methods?.join(",") ?? "ANY"}`,
    `Regions:     ${entry.function.regions?.join(",") ?? "default"}`,
    `Failover:    ${entry.function.failoverRegions?.join(",") ?? "none"}`,
    `Timeout:     ${entry.limits.timeoutMs}ms`,
    `Memory:      ${entry.limits.memoryMb}mb`,
    `Concurrency: ${entry.limits.concurrency}`,
    `Invocations: ${entry.summary.invocations}`,
    `Errors:      ${entry.summary.errors}`,
    `Error Rate:  ${entry.summary.errorRate}`,
    `Avg/P95:     ${entry.summary.averageDurationMs}ms / ${entry.summary.p95DurationMs}ms`
  ];

  for (const invocation of result.recentInvocations) {
    lines.push(`Invocation:  ${invocation.status} ${invocation.responseStatus} ${invocation.durationMs}ms ${invocation.requestId}`);
  }

  return lines.join("\n");
}

function formatRoutingRuleTarget(rule: RoutingRuleItem) {
  if (rule.kind === "header") {
    return (rule.headers ?? []).map((header) => `${header.key}=${header.value}`).join(",") || "no headers";
  }

  return rule.destination ?? "no destination";
}

function formatRoutingRules(list: RoutingRuleListResponse) {
  if (list.rules.length === 0) {
    return "No routing rules found.";
  }

  return list.rules.map((rule) => [
    rule.id,
    rule.name,
    rule.status,
    rule.kind,
    `priority=${rule.priority}`,
    `${rule.source} -> ${formatRoutingRuleTarget(rule)}`
  ].join("  ")).join("\n");
}

function formatRoutingRuleMutation(result: RoutingRuleMutationResponse) {
  return [
    `Status:   ${result.status}`,
    `Rule:     ${result.rule.id}`,
    `Name:     ${result.rule.name}`,
    `Kind:     ${result.rule.kind}`,
    `Source:   ${result.rule.source}`,
    `Target:   ${formatRoutingRuleTarget(result.rule)}`,
    `Priority: ${result.rule.priority}`
  ].join("\n");
}

function formatRollingCommandResult(result: RollingCommandResponse) {
  const rollout = result.rollout;
  const route = result.routeRevision;
  const lines = [
    `Status:  ${result.status}`,
    `Message: ${result.message}`,
    `Rollout: ${rollout ? `${rollout.id} / ${rollout.status} / ${rollout.percentage}%` : "not active"}`,
    `Traffic: ${rollout ? `${rollout.currentDeploymentId} -> ${rollout.candidateDeploymentId}` : "not routed"}`,
    `Route:   ${route ? `${route.id} / ${route.status} / ${route.channel}` : "not planned"}`
  ];

  for (const check of result.safetyChecks ?? []) {
    lines.push(`Check:   ${check.status} / ${check.label} / ${check.summary}`);
  }

  return lines.join("\n");
}

function actorFromEnv(env: NodeJS.ProcessEnv) {
  const name = env.SITEFLOW_ACTOR_NAME ?? env.USERNAME ?? env.USER ?? "SiteFlow CLI";

  return {
    id: env.SITEFLOW_ACTOR_ID ?? `cli:${name}`,
    name,
    email: env.SITEFLOW_ACTOR_EMAIL,
    role: "developer"
  };
}

function idempotencyKey(prefix: string, deploymentId: string, channel: string) {
  return `${prefix}:${deploymentId}:${channel}`;
}

function flagStringList(flags: Record<string, string | boolean>, name: string) {
  const value = flagString(flags, name);
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
}

function routingHeaders(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  return value.split(",").map((entry) => {
    const [key, ...valueParts] = entry.split("=");
    return {
      key: key.trim(),
      value: valueParts.join("=").trim()
    };
  }).filter((entry) => entry.key && entry.value);
}

function parseJsonOrString(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function headerCondition(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const [name, ...rest] = value.split("=");
  const trimmedName = name.trim();

  if (!trimmedName) {
    throw new Error("Firewall --header requires a header name.");
  }

  const headerValue = rest.join("=").trim();

  return {
    name: trimmedName,
    value: headerValue || undefined
  };
}

function blobAccess(value: string | undefined): "public" | "private" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "public" || value === "private") {
    return value;
  }

  throw new Error("Blob --access must be public or private.");
}

function optionalIntegerFlag(parsed: ParsedArgs, name: string) {
  const raw = flagString(parsed.flags, name);

  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isInteger(value)) {
    throw new Error(`--${name} must be an integer.`);
  }

  return value;
}

function routingKind(value: string | undefined): "redirect" | "rewrite" | "header" {
  if (value === "redirect" || value === "rewrite" || value === "header") {
    return value;
  }

  throw new Error("Routing rule kind must be redirect, rewrite, or header.");
}

function commandReason(parsed: ParsedArgs, action: "promote" | "rollback", deploymentId: string, channel: string, env: NodeJS.ProcessEnv) {
  return flagString(parsed.flags, "reason")
    ?? env.SITEFLOW_RELEASE_REASON
    ?? `${action === "promote" ? "Promote" : "Rollback"} ${deploymentId} to ${channel} via SiteFlow CLI.`;
}

function rollingReason(parsed: ParsedArgs, action: string, channel: string, env: NodeJS.ProcessEnv, deploymentId?: string) {
  const target = deploymentId ? ` ${deploymentId}` : "";

  return flagString(parsed.flags, "reason")
    ?? env.SITEFLOW_RELEASE_REASON
    ?? `${action} rolling release${target} on ${channel} via SiteFlow CLI.`;
}

function requiredPercentage(parsed: ParsedArgs) {
  const raw = flagString(parsed.flags, "percentage");
  const value = raw ? Number(raw) : Number.NaN;

  if (!Number.isInteger(value)) {
    throw new Error("Rolling release requires --percentage as an integer.");
  }

  return value;
}

function helpText() {
  return [
    "SiteFlow CLI",
    "",
    "Usage:",
    "  siteflow login --server https://siteflow.example.com --token <token> [--base-domain w33d.xyz]",
    "  siteflow link --project project-acme-dashboard [--server https://siteflow.example.com] [--root .] [--json]",
    "  siteflow env pull [--project project-acme-dashboard] [--environment preview] [--output .env.local] [--json]",
    "  siteflow install --topology single --domain siteflow.w33d.xyz --base-domain w33d.xyz --yes [--image ghcr.io/siteflow/siteflow:<version>] [--json]",
    "  siteflow deploy --prebuilt ./dist --project my-app [--prod] [--server https://siteflow.example.com] [--base-domain w33d.xyz] [--json]",
    "  siteflow deployments [--project project-acme-dashboard] [--server https://siteflow.example.com] [--json]",
    "  siteflow inspect <deploymentId> [--server https://siteflow.example.com] [--json]",
    "  siteflow promote <deploymentId> [--project project-acme-dashboard] [--channel production] [--reason text] [--json]",
    "  siteflow rollback <deploymentId> [--project project-acme-dashboard] [--channel production] [--reason text] [--json]",
    "  siteflow rolling start <deploymentId> --percentage 10 [--project project-acme-dashboard] [--channel production] [--json]",
    "  siteflow rolling advance --percentage 50 [--project project-acme-dashboard] [--channel production] [--json]",
    "  siteflow rolling complete [--project project-acme-dashboard] [--channel production] [--json]",
    "  siteflow rolling abort [--project project-acme-dashboard] [--channel production] [--reason text] [--json]",
    "  siteflow cron create <name> --path /api/revalidate --schedule \"0 * * * *\" [--project project-acme-dashboard] [--json]",
    "  siteflow cron list [--project project-acme-dashboard] [--json]",
    "  siteflow cron run <jobId> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow cron disable <jobId> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow deploy-hook create <name> [--project project-acme-dashboard] [--branch main] [--environment preview] [--json]",
    "  siteflow deploy-hook list [--project project-acme-dashboard] [--json]",
    "  siteflow deploy-hook revoke <hookId> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow logs [--project project-acme-dashboard] [--source build] [--severity warning] [--search text] [--json]",
    "  siteflow log-drain create <name> --url https://logs.example.test/siteflow [--sources build,function] [--severity warning] [--json]",
    "  siteflow log-drain list [--project project-acme-dashboard] [--json]",
    "  siteflow log-drain deliver <drainId> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow audit list [--project project-acme-dashboard] [--json]",
    "  siteflow api-token create <name> --scopes read,write [--project project-acme-dashboard] [--json]",
    "  siteflow api-token list [--project project-acme-dashboard] [--json]",
    "  siteflow api-token revoke <tokenId> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow firewall create <name> --action block [--path /admin/*] [--ip 203.0.113.*] [--header x-plan=free] [--user-agent curl] [--priority 10] [--json]",
    "  siteflow firewall list [--project project-acme-dashboard] [--json]",
    "  siteflow firewall disable <ruleId> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow edge-config list [--project project-acme-dashboard] [--json]",
    "  siteflow edge-config set <key> <jsonOrString> [--project project-acme-dashboard] [--json]",
    "  siteflow edge-config delete <key> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow blob put <localPath> [--pathname assets/file.txt] [--content-type text/plain] [--access public|private] [--cache-max-age 3600] [--project project-acme-dashboard] [--json]",
    "  siteflow blob list [--prefix assets/] [--project project-acme-dashboard] [--json]",
    "  siteflow blob get <pathname> --output <localPath> [--project project-acme-dashboard] [--json]",
    "  siteflow blob delete <pathname> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow cache list [--path /] [--tag marketing] [--status fresh|stale|purged] [--project project-acme-dashboard] [--json]",
    "  siteflow cache purge [--path /pricing] [--tag marketing] [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow functions list [--project project-acme-dashboard] [--deployment dep_123] [--json]",
    "  siteflow functions inspect <path> [--project project-acme-dashboard] [--deployment dep_123] [--limit 20] [--json]",
    "  siteflow routing-rules list [--project project-acme-dashboard] [--kind redirect|rewrite|header] [--json]",
    "  siteflow routing-rules upsert <name> --kind redirect --source /old --destination /new [--status-code 308] [--priority 10] [--json]",
    "  siteflow routing-rules upsert <name> --kind header --source /(.*) --headers x-frame-options=DENY [--json]",
    "  siteflow routing-rules disable <ruleId> [--project project-acme-dashboard] [--reason text] [--json]",
    "  siteflow doctor [--json]",
    "  siteflow status [--state /etc/siteflow/install-state.json] [--json]",
    "",
    "Commands:",
    "  login       Store server, token, and default base domain returned by the server.",
    "  link        Bind the current directory to a SiteFlow project.",
    "  env pull    Write metadata-safe environment variable placeholders for a linked project.",
    "  install     Plan or apply a SiteFlow server installation.",
    "  deploy      Upload a prebuilt static artifact and create a preview URL.",
    "  deployments List recent deployments with build, artifact, and route state.",
    "  inspect     Show one deployment's source, build, artifact, and route evidence.",
    "  promote     Promote a deployment to a release channel.",
    "  rollback    Roll a release channel back to a known-good deployment.",
    "  rolling     Start, advance, complete, or abort staged traffic rollout.",
    "  cron        Create, list, disable, and manually run scheduled production GET jobs.",
    "  deploy-hook Create, list, and revoke external deploy triggers.",
    "  logs        Query project build, function, and cron logs.",
    "  log-drain   Create, list, and manually deliver signed log drains.",
    "  audit       List project audit events.",
    "  api-token   Create, list, and revoke scoped API tokens.",
    "  firewall    Create, list, and disable project firewall rules.",
    "  edge-config Manage project Edge Config key/value entries.",
    "  blob        Upload, list, download, and delete project blobs.",
    "  cache       Inspect and purge project cache entries.",
    "  functions   Inspect deployed function runtime limits and invocations.",
    "  routing-rules Manage project redirects, rewrites, and response headers.",
    "  doctor      Validate host and SiteFlow runtime readiness.",
    "  status      Read the install-state manifest and print installed version/topology.",
    "  backup      Reserved lifecycle command.",
    "  restore     Reserved lifecycle command.",
    "  upgrade     Reserved lifecycle command.",
    "  uninstall   Reserved lifecycle command."
  ].join("\n");
}

async function resolveApiSession(parsed: ParsedArgs, env: NodeJS.ProcessEnv) {
  const configPath = flagString(parsed.flags, "config") ?? env.SITEFLOW_CONFIG;
  const saved = resolveServerConfig(await readCliConfig(configPath), flagString(parsed.flags, "server") ?? env.SITEFLOW_API_URL);
  const serverUrl = saved?.serverUrl;
  const apiToken = flagString(parsed.flags, "token") ?? env.SITEFLOW_API_TOKEN ?? saved?.config.token;

  if (!serverUrl) {
    throw new Error("Command requires --server or a saved login config.");
  }

  return { serverUrl, apiToken };
}

async function resolveLinkedProject(parsed: ParsedArgs, env: NodeJS.ProcessEnv) {
  const root = flagString(parsed.flags, "root") ?? env.SITEFLOW_PROJECT_ROOT ?? process.cwd();
  const explicitProject = flagString(parsed.flags, "project-id") ?? flagString(parsed.flags, "project");
  const link = explicitProject ? undefined : await readProjectLink(root);
  const projectId = explicitProject ?? link?.projectId;

  if (!projectId) {
    throw new Error("Command requires --project or a local SiteFlow link.");
  }

  return {
    root,
    projectId,
    linkedServerUrl: link?.serverUrl
  };
}

async function fetchApiJson<T>(
  serverUrl: string,
  pathName: string,
  apiToken: string | undefined,
  fetchImpl: DeployPrebuiltOptions["fetch"],
  init: RequestInit = {}
) {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...Object.fromEntries(new Headers(init.headers).entries())
  };

  if (init.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  if (apiToken) {
    headers.authorization = `Bearer ${apiToken}`;
  }

  const response = await (fetchImpl ?? fetch)(`${serverUrl.replace(/\/+$/, "")}${pathName}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(body?.message ?? `SiteFlow API request failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as T;
}

async function runLink(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const root = flagString(parsed.flags, "root") ?? env.SITEFLOW_PROJECT_ROOT ?? process.cwd();
  const projectId = flagString(parsed.flags, "project-id") ?? flagString(parsed.flags, "project");

  if (!projectId) {
    const message = "Link requires --project.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const session = await resolveApiSession(parsed, env);
    const settings = await fetchApiJson<ProjectSettingsResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(projectId)}/settings`,
      session.apiToken,
      fetchImpl
    );
    const link = {
      projectId: settings.project.id,
      projectSlug: settings.project.slug,
      projectName: settings.project.name,
      serverUrl: session.serverUrl,
      linkedAt: new Date().toISOString()
    };
    const linkPath = await writeProjectLink(root, link);
    const result = {
      status: "linked",
      projectId: link.projectId,
      projectSlug: link.projectSlug,
      projectName: link.projectName,
      serverUrl: link.serverUrl,
      path: linkPath
    };

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`Linked ${link.projectName} (${link.projectId})\nConfig: ${linkPath}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to link project.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

function envSkeleton(settings: ProjectSettingsResponse, targetEnvironment: string) {
  const variables = settings.environmentVariables
    .filter((variable) => variable.targetEnvironment === targetEnvironment)
    .sort((left, right) => left.key.localeCompare(right.key));
  const lines = [
    "# SiteFlow env pull writes metadata-only placeholders.",
    "# Secret values are not returned by the control plane.",
    `# Project: ${settings.project.name} (${settings.project.id})`,
    `# Environment: ${targetEnvironment}`,
    ""
  ];

  for (const variable of variables) {
    lines.push(`# ${variable.key} scope=${variable.scope} source=${variable.source} fingerprint=${variable.fingerprint}`);
    lines.push(`# ${variable.key}=`);
  }

  return `${lines.join("\n")}\n`;
}

async function runEnvPull(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const targetEnvironment = flagString(parsed.flags, "environment") ?? flagString(parsed.flags, "target") ?? "preview";
  const output = flagString(parsed.flags, "output") ?? ".env.local";

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );
    const settings = await fetchApiJson<ProjectSettingsResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/settings`,
      session.apiToken,
      fetchImpl
    );
    const targetPath = path.resolve(linked.root, output);
    const content = envSkeleton(settings, targetEnvironment);

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);

    const count = settings.environmentVariables.filter((variable) => variable.targetEnvironment === targetEnvironment).length;
    const result = {
      status: "pulled",
      projectId: linked.projectId,
      targetEnvironment,
      output: targetPath,
      variables: count,
      metadataOnly: true
    };

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`Wrote ${count} metadata-only env placeholder${count === 1 ? "" : "s"} to ${targetPath}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to pull environment variables.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runReleaseCommand(
  action: "promote" | "rollback",
  parsed: ParsedArgs,
  io: CliIo,
  env: NodeJS.ProcessEnv,
  fetchImpl: DeployPrebuiltOptions["fetch"]
) {
  const json = flagBoolean(parsed.flags, "json");
  const deploymentId = parsed.positionals[0];
  const channel = flagString(parsed.flags, "channel") ?? "production";

  if (!deploymentId) {
    const message = `${action === "promote" ? "Promote" : "Rollback"} requires a deployment id.`;

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );
    const reason = commandReason(parsed, action, deploymentId, channel, env);
    const body: Record<string, unknown> = {
      projectId: linked.projectId,
      channel,
      targetDeploymentId: deploymentId,
      actor: actorFromEnv(env),
      reason,
      idempotencyKey: flagString(parsed.flags, "idempotency-key") ?? idempotencyKey(action, deploymentId, channel),
      dryRun: flagBoolean(parsed.flags, "dry-run")
    };

    if (action === "rollback") {
      const currentDeploymentId = flagString(parsed.flags, "current-deployment");

      if (currentDeploymentId) {
        body.currentDeploymentId = currentDeploymentId;
      }
    }

    const result = await fetchApiJson<CommandResultResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/${action === "promote" ? "release" : "rollback"}/${encodeURIComponent(channel)}/${action}`,
      session.apiToken,
      fetchImpl,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatCommandResult(result)}\n`);
    }

    return result.status === "accepted" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unable to ${action} deployment.`;

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runDeployHook(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "create" && action !== "list" && action !== "revoke") {
    const message = "Deploy hook requires create, list, or revoke.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const result = await fetchApiJson<DeployHookListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/deploy-hooks`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatDeployHooksList(result)}\n`);
      }

      return 0;
    }

    if (action === "create") {
      const name = flagString(parsed.flags, "name") ?? parsed.positionals[1];

      if (!name) {
        const message = "Deploy hook create requires a name.";

        if (json) {
          writeJson(io, { status: "failed", message });
        } else {
          io.stderr(`${message}\n`);
        }

        return 1;
      }

      const result = await fetchApiJson<DeployHookCreateResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/deploy-hooks`,
        session.apiToken,
        fetchImpl,
        {
          method: "POST",
          body: JSON.stringify({
            projectId: linked.projectId,
            name,
            branch: flagString(parsed.flags, "branch"),
            targetEnvironment: flagString(parsed.flags, "environment") ?? flagString(parsed.flags, "target"),
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatDeployHookCreate(result)}\n`);
      }

      return result.status === "created" ? 0 : 1;
    }

    const hookId = parsed.positionals[1];

    if (!hookId) {
      const message = "Deploy hook revoke requires a hook id.";

      if (json) {
        writeJson(io, { status: "failed", message });
      } else {
        io.stderr(`${message}\n`);
      }

      return 1;
    }

    const result = await fetchApiJson<DeployHookRevokeResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/deploy-hooks/${encodeURIComponent(hookId)}`,
      session.apiToken,
      fetchImpl,
      {
        method: "DELETE",
        body: JSON.stringify({
          projectId: linked.projectId,
          hookId,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason")
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatDeployHookRevoke(result)}\n`);
    }

    return result.status === "revoked" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage deploy hooks.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runCronCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "create" && action !== "list" && action !== "disable" && action !== "run") {
    const message = "Cron requires create, list, disable, or run.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const result = await fetchApiJson<CronJobListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/cron-jobs`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatCronJobsList(result)}\n`);
      }

      return 0;
    }

    if (action === "create") {
      const name = flagString(parsed.flags, "name") ?? parsed.positionals[1];
      const pathName = flagString(parsed.flags, "path");
      const schedule = flagString(parsed.flags, "schedule");

      if (!name || !pathName || !schedule) {
        throw new Error("Cron create requires a name, --path, and --schedule.");
      }

      const result = await fetchApiJson<CronJobCreateResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/cron-jobs`,
        session.apiToken,
        fetchImpl,
        {
          method: "POST",
          body: JSON.stringify({
            projectId: linked.projectId,
            name,
            path: pathName,
            schedule,
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatCronJobCreate(result)}\n`);
      }

      return result.status === "created" ? 0 : 1;
    }

    const jobId = parsed.positionals[1];

    if (!jobId) {
      throw new Error(`Cron ${action} requires a job id.`);
    }

    if (action === "disable") {
      const result = await fetchApiJson<CronJobDisableResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/cron-jobs/${encodeURIComponent(jobId)}`,
        session.apiToken,
        fetchImpl,
        {
          method: "DELETE",
          body: JSON.stringify({
            projectId: linked.projectId,
            jobId,
            actor: actorFromEnv(env),
            reason: flagString(parsed.flags, "reason")
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatCronJobDisable(result)}\n`);
      }

      return result.status === "disabled" ? 0 : 1;
    }

    const result = await fetchApiJson<CronJobRunResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/cron-jobs/${encodeURIComponent(jobId)}/run`,
      session.apiToken,
      fetchImpl,
      {
        method: "POST",
        body: JSON.stringify({
          projectId: linked.projectId,
          jobId,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason"),
          idempotencyKey: flagString(parsed.flags, "idempotency-key") ?? idempotencyKey("cron:run", jobId, linked.projectId)
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatCronJobRun(result)}\n`);
    }

    return result.status === "accepted" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage cron jobs.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runLogsCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );
    const params = new URLSearchParams();
    const source = flagString(parsed.flags, "source");
    const severity = flagString(parsed.flags, "severity");
    const deploymentId = flagString(parsed.flags, "deployment") ?? flagString(parsed.flags, "deployment-id");
    const search = flagString(parsed.flags, "search");
    const limit = flagString(parsed.flags, "limit");
    const cursor = flagString(parsed.flags, "cursor");

    if (source) {
      params.set("source", source);
    }

    if (severity) {
      params.set("severity", severity);
    }

    if (deploymentId) {
      params.set("deploymentId", deploymentId);
    }

    if (search) {
      params.set("search", search);
    }

    if (limit) {
      params.set("limit", limit);
    }

    if (cursor) {
      params.set("cursor", cursor);
    }

    const query = params.toString();
    const result = await fetchApiJson<LogQueryResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/logs${query ? `?${query}` : ""}`,
      session.apiToken,
      fetchImpl
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatLogQuery(result)}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to query logs.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runLogDrainCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "create" && action !== "list" && action !== "deliver") {
    const message = "Log drain requires create, list, or deliver.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const result = await fetchApiJson<LogDrainListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/log-drains`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatLogDrainsList(result)}\n`);
      }

      return 0;
    }

    if (action === "create") {
      const name = flagString(parsed.flags, "name") ?? parsed.positionals[1];
      const url = flagString(parsed.flags, "url");

      if (!name || !url) {
        throw new Error("Log drain create requires a name and --url.");
      }

      const result = await fetchApiJson<LogDrainCreateResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/log-drains`,
        session.apiToken,
        fetchImpl,
        {
          method: "POST",
          body: JSON.stringify({
            projectId: linked.projectId,
            name,
            url,
            sources: flagStringList(parsed.flags, "sources"),
            minimumSeverity: flagString(parsed.flags, "severity") ?? flagString(parsed.flags, "minimum-severity"),
            signingSecret: flagString(parsed.flags, "signing-secret"),
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatLogDrainCreate(result)}\n`);
      }

      return result.status === "created" ? 0 : 1;
    }

    const drainId = parsed.positionals[1];

    if (!drainId) {
      throw new Error("Log drain deliver requires a drain id.");
    }

    const result = await fetchApiJson<LogDrainDeliveryResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/log-drains/${encodeURIComponent(drainId)}/deliver`,
      session.apiToken,
      fetchImpl,
      {
        method: "POST",
        body: JSON.stringify({
          projectId: linked.projectId,
          drainId,
          reason: flagString(parsed.flags, "reason"),
          limit: flagString(parsed.flags, "limit") ? Number(flagString(parsed.flags, "limit")) : undefined
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatLogDrainDelivery(result)}\n`);
    }

    return result.status === "delivered" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage log drains.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function readProjectSettingsForCli(parsed: ParsedArgs, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const linked = await resolveLinkedProject(parsed, env);
  const session = await resolveApiSession(
    {
      ...parsed,
      flags: {
        ...parsed.flags,
        server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
      }
    },
    env
  );
  const settings = await fetchApiJson<ProjectSettingsResponse>(
    session.serverUrl,
    `/api/projects/${encodeURIComponent(linked.projectId)}/settings`,
    session.apiToken,
    fetchImpl
  );

  return { linked, session, settings };
}

async function runAuditCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0] ?? "list";

  if (action !== "list") {
    const message = "Audit requires list.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const { settings } = await readProjectSettingsForCli(parsed, env, fetchImpl);

    if (json) {
      writeJson(io, {
        projectId: settings.project.id,
        auditEvents: settings.auditEvents ?? []
      });
    } else {
      io.stdout(`${formatAuditEvents(settings)}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list audit events.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runApiTokenCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "create" && action !== "list" && action !== "revoke") {
    const message = "API token requires create, list, or revoke.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const { linked, session, settings } = await readProjectSettingsForCli(parsed, env, fetchImpl);

    if (action === "list") {
      if (json) {
        writeJson(io, {
          projectId: settings.project.id,
          apiTokens: settings.apiTokens ?? []
        });
      } else {
        io.stdout(`${formatApiTokens(settings)}\n`);
      }

      return 0;
    }

    if (action === "create") {
      const name = flagString(parsed.flags, "name") ?? parsed.positionals[1];
      const scopes = flagStringList(parsed.flags, "scopes");

      if (!name || !scopes) {
        throw new Error("API token create requires a name and --scopes.");
      }

      const result = await fetchApiJson<ApiTokenCreateResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/api-tokens`,
        session.apiToken,
        fetchImpl,
        {
          method: "POST",
          body: JSON.stringify({
            projectId: linked.projectId,
            name,
            scopes,
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatApiTokenCreate(result)}\n`);
      }

      return result.status === "created" ? 0 : 1;
    }

    const tokenId = parsed.positionals[1];

    if (!tokenId) {
      throw new Error("API token revoke requires a token id.");
    }

    const result = await fetchApiJson<ApiTokenRevokeResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/api-tokens/${encodeURIComponent(tokenId)}`,
      session.apiToken,
      fetchImpl,
      {
        method: "DELETE",
        body: JSON.stringify({
          projectId: linked.projectId,
          tokenId,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason")
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatApiTokenRevoke(result)}\n`);
    }

    return result.status === "revoked" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage API tokens.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runFirewallCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "create" && action !== "list" && action !== "disable") {
    const message = "Firewall requires create, list, or disable.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const result = await fetchApiJson<FirewallRuleListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/firewall-rules`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatFirewallRules(result)}\n`);
      }

      return 0;
    }

    if (action === "create") {
      const name = flagString(parsed.flags, "name") ?? parsed.positionals[1];
      const actionValue = flagString(parsed.flags, "action");

      if (!name || !actionValue) {
        throw new Error("Firewall create requires a name and --action.");
      }

      if (actionValue !== "allow" && actionValue !== "block" && actionValue !== "challenge") {
        throw new Error("Firewall --action must be allow, block, or challenge.");
      }

      const priority = flagString(parsed.flags, "priority");
      const result = await fetchApiJson<FirewallRuleMutationResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/firewall-rules`,
        session.apiToken,
        fetchImpl,
        {
          method: "POST",
          body: JSON.stringify({
            projectId: linked.projectId,
            name,
            action: actionValue,
            priority: priority ? Number(priority) : undefined,
            conditions: {
              ipRanges: flagStringList(parsed.flags, "ip"),
              pathPattern: flagString(parsed.flags, "path"),
              header: headerCondition(flagString(parsed.flags, "header")),
              userAgent: flagString(parsed.flags, "user-agent")
            },
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatFirewallRuleMutation(result)}\n`);
      }

      return result.status === "created" ? 0 : 1;
    }

    const ruleId = parsed.positionals[1];

    if (!ruleId) {
      throw new Error("Firewall disable requires a rule id.");
    }

    const result = await fetchApiJson<FirewallRuleMutationResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/firewall-rules/${encodeURIComponent(ruleId)}`,
      session.apiToken,
      fetchImpl,
      {
        method: "DELETE",
        body: JSON.stringify({
          projectId: linked.projectId,
          ruleId,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason")
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatFirewallRuleMutation(result)}\n`);
    }

    return result.status === "disabled" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage firewall rules.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runEdgeConfigCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "list" && action !== "set" && action !== "delete") {
    const message = "Edge Config requires list, set, or delete.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const result = await fetchApiJson<EdgeConfigResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/edge-config`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatEdgeConfig(result)}\n`);
      }

      return 0;
    }

    const key = parsed.positionals[1];

    if (!key) {
      throw new Error(`Edge Config ${action} requires a key.`);
    }

    if (action === "set") {
      const rawValue = parsed.positionals[2] ?? flagString(parsed.flags, "value");

      if (rawValue === undefined) {
        throw new Error("Edge Config set requires a value.");
      }

      const result = await fetchApiJson<EdgeConfigMutationResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/edge-config/${encodeURIComponent(key)}`,
        session.apiToken,
        fetchImpl,
        {
          method: "PUT",
          body: JSON.stringify({
            projectId: linked.projectId,
            key,
            value: parseJsonOrString(rawValue),
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatEdgeConfigMutation(result)}\n`);
      }

      return result.status === "upserted" ? 0 : 1;
    }

    const result = await fetchApiJson<EdgeConfigMutationResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/edge-config/${encodeURIComponent(key)}`,
      session.apiToken,
      fetchImpl,
      {
        method: "DELETE",
        body: JSON.stringify({
          projectId: linked.projectId,
          key,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason")
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatEdgeConfigMutation(result)}\n`);
    }

    return result.status === "deleted" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage Edge Config.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runBlobCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "put" && action !== "list" && action !== "get" && action !== "delete") {
    const message = "Blob requires put, list, get, or delete.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const query = new URLSearchParams();
      const prefix = flagString(parsed.flags, "prefix");
      const cursor = flagString(parsed.flags, "cursor");
      const limit = optionalIntegerFlag(parsed, "limit");

      if (prefix) {
        query.set("prefix", prefix);
      }

      if (cursor) {
        query.set("cursor", cursor);
      }

      if (limit !== undefined) {
        query.set("limit", String(limit));
      }

      const queryString = query.toString();
      const result = await fetchApiJson<BlobListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/blobs${queryString ? `?${queryString}` : ""}`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatBlobs(result)}\n`);
      }

      return 0;
    }

    const pathname = parsed.positionals[1];

    if (action === "put") {
      const localPath = pathname;

      if (!localPath) {
        throw new Error("Blob put requires a local path.");
      }

      const sourcePath = path.resolve(linked.root, localPath);
      const bytes = await readFile(sourcePath);
      const blobPathname = flagString(parsed.flags, "pathname") ?? path.basename(sourcePath);
      const result = await fetchApiJson<BlobMutationResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/blobs`,
        session.apiToken,
        fetchImpl,
        {
          method: "POST",
          body: JSON.stringify({
            projectId: linked.projectId,
            pathname: blobPathname,
            contentBase64: bytes.toString("base64"),
            contentType: flagString(parsed.flags, "content-type"),
            access: blobAccess(flagString(parsed.flags, "access")),
            cacheControlMaxAge: optionalIntegerFlag(parsed, "cache-max-age"),
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatBlobMutation(result)}\n`);
      }

      return result.status === "uploaded" ? 0 : 1;
    }

    if (!pathname) {
      throw new Error(`Blob ${action} requires a pathname.`);
    }

    if (action === "get") {
      const output = flagString(parsed.flags, "output");

      if (!output) {
        throw new Error("Blob get requires --output.");
      }

      const result = await fetchApiJson<BlobReadResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/blobs/${encodeURIComponent(pathname)}`,
        session.apiToken,
        fetchImpl
      );
      const outputPath = path.resolve(linked.root, output);

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from(result.contentBase64, "base64"));

      if (json) {
        writeJson(io, {
          status: "downloaded",
          projectId: result.projectId,
          blob: result.blob,
          output: outputPath
        });
      } else {
        io.stdout(`${formatBlobRead(result, outputPath)}\n`);
      }

      return 0;
    }

    const result = await fetchApiJson<BlobMutationResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/blobs/${encodeURIComponent(pathname)}`,
      session.apiToken,
      fetchImpl,
      {
        method: "DELETE",
        body: JSON.stringify({
          projectId: linked.projectId,
          pathname,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason")
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatBlobMutation(result)}\n`);
    }

    return result.status === "deleted" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage blobs.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runCacheCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "list" && action !== "purge") {
    const message = "Cache requires list or purge.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const query = new URLSearchParams();
      const pathName = flagString(parsed.flags, "path");
      const tag = flagString(parsed.flags, "tag");
      const status = flagString(parsed.flags, "status");
      const limit = optionalIntegerFlag(parsed, "limit");

      if (pathName) {
        query.set("path", pathName);
      }

      if (tag) {
        query.set("tag", tag);
      }

      if (status) {
        query.set("status", status);
      }

      if (limit !== undefined) {
        query.set("limit", String(limit));
      }

      const queryString = query.toString();
      const result = await fetchApiJson<CacheListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/cache${queryString ? `?${queryString}` : ""}`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatCacheEntries(result)}\n`);
      }

      return 0;
    }

    const pathName = flagString(parsed.flags, "path") ?? parsed.positionals[1];
    const tag = flagString(parsed.flags, "tag");

    if (!pathName && !tag) {
      throw new Error("Cache purge requires --path or --tag.");
    }

    const result = await fetchApiJson<CachePurgeResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/cache/purge`,
      session.apiToken,
      fetchImpl,
      {
        method: "POST",
        body: JSON.stringify({
          projectId: linked.projectId,
          path: pathName,
          tag,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason")
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatCachePurge(result)}\n`);
    }

    return result.status === "purged" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage cache.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runFunctionsCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "list" && action !== "inspect") {
    const message = "Functions requires list or inspect.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );
    const deploymentId = flagString(parsed.flags, "deployment") ?? flagString(parsed.flags, "deployment-id");

    if (action === "list") {
      const query = new URLSearchParams();

      if (deploymentId) {
        query.set("deploymentId", deploymentId);
      }

      const queryString = query.toString();
      const result = await fetchApiJson<FunctionRuntimeListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/functions${queryString ? `?${queryString}` : ""}`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatFunctions(result)}\n`);
      }

      return 0;
    }

    const functionPath = parsed.positionals[1];

    if (!functionPath) {
      throw new Error("Functions inspect requires a function path.");
    }

    const query = new URLSearchParams();
    const limit = optionalIntegerFlag(parsed, "limit");

    if (deploymentId) {
      query.set("deploymentId", deploymentId);
    }

    if (limit !== undefined) {
      query.set("limit", String(limit));
    }

    const queryString = query.toString();
    const result = await fetchApiJson<FunctionRuntimeResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/functions/${encodeURIComponent(functionPath)}${queryString ? `?${queryString}` : ""}`,
      session.apiToken,
      fetchImpl
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatFunctionRuntime(result)}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to inspect functions.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runRoutingRulesCommand(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "list" && action !== "upsert" && action !== "disable") {
    const message = "Routing rules require list, upsert, or disable.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );

    if (action === "list") {
      const query = new URLSearchParams();
      const kind = flagString(parsed.flags, "kind");
      const status = flagString(parsed.flags, "status");

      if (kind) {
        query.set("kind", kind);
      }

      if (status) {
        query.set("status", status);
      }

      const queryString = query.toString();
      const result = await fetchApiJson<RoutingRuleListResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/routing-rules${queryString ? `?${queryString}` : ""}`,
        session.apiToken,
        fetchImpl
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatRoutingRules(result)}\n`);
      }

      return 0;
    }

    if (action === "upsert") {
      const name = flagString(parsed.flags, "name") ?? parsed.positionals[1];
      const kind = routingKind(flagString(parsed.flags, "kind"));
      const source = flagString(parsed.flags, "source");

      if (!name || !source) {
        throw new Error("Routing rule upsert requires a name and --source.");
      }

      const result = await fetchApiJson<RoutingRuleMutationResponse>(
        session.serverUrl,
        `/api/projects/${encodeURIComponent(linked.projectId)}/routing-rules`,
        session.apiToken,
        fetchImpl,
        {
          method: "PUT",
          body: JSON.stringify({
            projectId: linked.projectId,
            name,
            kind,
            source,
            destination: flagString(parsed.flags, "destination"),
            statusCode: optionalIntegerFlag(parsed, "status-code"),
            headers: routingHeaders(flagString(parsed.flags, "headers")),
            priority: optionalIntegerFlag(parsed, "priority"),
            actor: actorFromEnv(env)
          })
        }
      );

      if (json) {
        writeJson(io, result);
      } else {
        io.stdout(`${formatRoutingRuleMutation(result)}\n`);
      }

      return result.status === "upserted" ? 0 : 1;
    }

    const ruleId = parsed.positionals[1];

    if (!ruleId) {
      throw new Error("Routing rule disable requires a rule id.");
    }

    const result = await fetchApiJson<RoutingRuleMutationResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/routing-rules/${encodeURIComponent(ruleId)}`,
      session.apiToken,
      fetchImpl,
      {
        method: "DELETE",
        body: JSON.stringify({
          projectId: linked.projectId,
          ruleId,
          actor: actorFromEnv(env),
          reason: flagString(parsed.flags, "reason")
        })
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatRoutingRuleMutation(result)}\n`);
    }

    return result.status === "disabled" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage routing rules.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runRollingRelease(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const action = parsed.positionals[0];

  if (action !== "start" && action !== "advance" && action !== "complete" && action !== "abort") {
    const message = "Rolling release requires start, advance, complete, or abort.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const linked = await resolveLinkedProject(parsed, env);
    const session = await resolveApiSession(
      {
        ...parsed,
        flags: {
          ...parsed.flags,
          server: flagString(parsed.flags, "server") ?? linked.linkedServerUrl ?? false
        }
      },
      env
    );
    const channel = flagString(parsed.flags, "channel") ?? "production";
    const candidateDeploymentId = action === "start" ? parsed.positionals[1] : undefined;

    if (action === "start" && !candidateDeploymentId) {
      throw new Error("Rolling release start requires a deployment id.");
    }

    const body: Record<string, unknown> = {
      projectId: linked.projectId,
      channel,
      actor: actorFromEnv(env),
      reason: rollingReason(parsed, action, channel, env, candidateDeploymentId),
      idempotencyKey: flagString(parsed.flags, "idempotency-key")
        ?? idempotencyKey(`rolling:${action}`, candidateDeploymentId ?? "active", channel)
    };

    if (action === "start") {
      body.candidateDeploymentId = candidateDeploymentId;
      body.percentage = requiredPercentage(parsed);
    }

    if (action === "advance") {
      body.percentage = requiredPercentage(parsed);
    }

    const result = await fetchApiJson<RollingCommandResponse>(
      session.serverUrl,
      `/api/projects/${encodeURIComponent(linked.projectId)}/rolling/${encodeURIComponent(channel)}/${action}`,
      session.apiToken,
      fetchImpl,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );

    if (json) {
      writeJson(io, result);
    } else {
      io.stdout(`${formatRollingCommandResult(result)}\n`);
    }

    return result.status === "accepted" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage rolling release.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function promoteDeployResult(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  fetchImpl: DeployPrebuiltOptions["fetch"],
  serverUrl: string,
  apiToken: string | undefined,
  deploymentId: string,
  projectId: string
) {
  const channel = flagString(parsed.flags, "channel") ?? "production";
  const reason = commandReason(parsed, "promote", deploymentId, channel, env);

  return fetchApiJson<CommandResultResponse>(
    serverUrl,
    `/api/projects/${encodeURIComponent(projectId)}/release/${encodeURIComponent(channel)}/promote`,
    apiToken,
    fetchImpl,
    {
      method: "POST",
      body: JSON.stringify({
        projectId,
        channel,
        targetDeploymentId: deploymentId,
        actor: actorFromEnv(env),
        reason,
        idempotencyKey: flagString(parsed.flags, "idempotency-key") ?? idempotencyKey("promote", deploymentId, channel),
        dryRun: flagBoolean(parsed.flags, "dry-run")
      })
    }
  );
}

async function runDeployments(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const projectId = flagString(parsed.flags, "project-id") ?? flagString(parsed.flags, "project");

  try {
    const session = await resolveApiSession(parsed, env);
    const params = new URLSearchParams();

    if (projectId) {
      params.set("projectId", projectId);
    }

    const query = params.toString();
    const list = await fetchApiJson<DeploymentListResponse>(
      session.serverUrl,
      `/api/deployments${query ? `?${query}` : ""}`,
      session.apiToken,
      fetchImpl
    );

    if (json) {
      writeJson(io, list);
    } else {
      io.stdout(`${formatDeploymentsList(list)}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list deployments.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

async function runInspect(parsed: ParsedArgs, io: CliIo, env: NodeJS.ProcessEnv, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const json = flagBoolean(parsed.flags, "json");
  const deploymentId = parsed.positionals[0];

  if (!deploymentId) {
    const message = "Inspect requires a deployment id.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }

  try {
    const session = await resolveApiSession(parsed, env);
    const detail = await fetchApiJson<DeploymentInspectResponse>(
      session.serverUrl,
      `/api/deployments/${encodeURIComponent(deploymentId)}`,
      session.apiToken,
      fetchImpl
    );

    if (json) {
      writeJson(io, detail);
    } else {
      io.stdout(`${formatDeploymentInspect(detail)}\n`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to inspect deployment.";

    if (json) {
      writeJson(io, { status: "failed", message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 1;
  }
}

interface VerifyLoginResult {
  authenticated: boolean;
  authRequired: boolean;
  baseDomain?: string;
}

async function verifyLogin(serverUrl: string, token: string, fetchImpl: DeployPrebuiltOptions["fetch"]) {
  const response = await (fetchImpl ?? fetch)(`${serverUrl.replace(/\/+$/, "")}/api/auth/verify`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(body?.message ?? `Login verification failed with HTTP ${response.status}.`);
  }

  return (await response.json()) as VerifyLoginResult;
}

async function runStatus(parsed: ParsedArgs, io: CliIo) {
  const statePath = flagString(parsed.flags, "state") ?? "/etc/siteflow/install-state.json";
  const json = flagBoolean(parsed.flags, "json");

  try {
    const state = parseInstallState(JSON.parse(await readFile(statePath, "utf8")));

    if (json) {
      writeJson(io, {
        status: "installed",
        statePath,
        siteflowVersion: state.siteflowVersion,
        topology: state.topology,
        services: state.services,
        router: state.router
      });
      return 0;
    }

    io.stdout(`SiteFlow ${state.siteflowVersion} (${state.topology})\nState: ${statePath}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read install state.";

    if (json) {
      writeJson(io, { status: "not_installed", statePath, message });
    } else {
      io.stderr(`SiteFlow is not installed or state is unreadable: ${message}\n`);
    }

    return 1;
  }
}

export async function runSiteFlowCli(argv: string[], io: CliIo, dependencies: CliDependencies = {}) {
  const parsed = parseArgs(argv);
  const json = flagBoolean(parsed.flags, "json");
  const version = dependencies.version ?? "0.1.0";
  const env = dependencies.env ?? process.env;

  if (!parsed.command || parsed.command === "--help" || parsed.command === "help" || flagBoolean(parsed.flags, "help")) {
    io.stdout(`${helpText()}\n`);
    return 0;
  }

  if (parsed.command === "doctor") {
    const report = await runDoctor(dependencies.doctor);

    if (json) {
      writeJson(io, report);
    } else {
      io.stdout(`${formatDoctorReport(report)}\n`);
    }

    return report.status === "fail" ? 1 : 0;
  }

  if (parsed.command === "install") {
    const dryRun = flagBoolean(parsed.flags, "dry-run");
    const yes = flagBoolean(parsed.flags, "yes");
    const topology = flagString(parsed.flags, "topology") ?? "single";
    const domain = flagString(parsed.flags, "domain");
    const baseDomain = flagString(parsed.flags, "base-domain") ?? env.SITEFLOW_BASE_DOMAIN;
    const apiPortValue = flagString(parsed.flags, "api-port") ?? env.SITEFLOW_API_PORT;
    const image = flagString(parsed.flags, "image") ?? env.SITEFLOW_IMAGE;

    if (!dryRun && !yes) {
      const message = "Install apply requires --yes. Run with --dry-run to inspect the production install plan first.";

      if (json) {
        writeJson(io, { status: "blocked", message });
      } else {
        io.stderr(`${message}\n`);
      }

      return 2;
    }

    try {
      const plan = createSingleHostInstallPlan({
        topology: topology as "single",
        domain,
        baseDomain,
        apiPort: apiPortValue ? Number(apiPortValue) : undefined,
        image,
        dryRun,
        version
      });

      if (!dryRun) {
        const result = await applyInstallPlan(plan, dependencies.install);

        if (json) {
          writeJson(io, result);
        } else {
          io.stdout(`SiteFlow installed\nState: ${result.statePath}\n`);
        }

        return 0;
      }

      if (json) {
        writeJson(io, plan);
      } else {
        io.stdout(`${formatInstallPlan(plan)}\n`);
      }

      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Install planning failed.";

      if (json) {
        writeJson(io, { status: "failed", message });
      } else {
        io.stderr(`${message}\n`);
      }

      return 1;
    }
  }

  if (parsed.command === "login") {
    const serverUrl = flagString(parsed.flags, "server");
    const token = flagString(parsed.flags, "token") ?? env.SITEFLOW_API_TOKEN;
    const baseDomain = flagString(parsed.flags, "base-domain") ?? env.SITEFLOW_BASE_DOMAIN;
    const configPath = flagString(parsed.flags, "config") ?? env.SITEFLOW_CONFIG;
    const skipVerify = flagBoolean(parsed.flags, "skip-verify");

    if (!serverUrl || !token) {
      const message = "Login requires --server and --token.";

      if (json) {
        writeJson(io, { status: "failed", message });
      } else {
        io.stderr(`${message}\n`);
      }

      return 1;
    }

    try {
      const verification = skipVerify ? undefined : await verifyLogin(serverUrl, token, dependencies.fetch);
      const resolvedBaseDomain = baseDomain ?? verification?.baseDomain;

      const result = await saveLoginConfig({
        serverUrl,
        token,
        baseDomain: resolvedBaseDomain,
        configPath
      });

      if (json) {
        writeJson(io, {
          status: "logged_in",
          serverUrl: result.serverUrl,
          configPath: result.configPath,
          baseDomain: resolvedBaseDomain
        });
      } else {
        io.stdout(`Logged in to ${result.serverUrl}\nConfig: ${result.configPath}\n`);
      }

      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed.";

      if (json) {
        writeJson(io, { status: "failed", message });
      } else {
        io.stderr(`${message}\n`);
      }

      return 1;
    }
  }

  if (parsed.command === "link") {
    return runLink(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "env" && parsed.positionals[0] === "pull") {
    return runEnvPull(
      {
        ...parsed,
        positionals: parsed.positionals.slice(1)
      },
      io,
      env,
      dependencies.fetch
    );
  }

  if (parsed.command === "deploy") {
    const prebuilt = flagString(parsed.flags, "prebuilt") ?? parsed.positionals[0];
    const configPath = flagString(parsed.flags, "config") ?? env.SITEFLOW_CONFIG;
    const root = flagString(parsed.flags, "root") ?? env.SITEFLOW_PROJECT_ROOT ?? process.cwd();
    const link = await readProjectLink(root);
    const saved = resolveServerConfig(await readCliConfig(configPath), flagString(parsed.flags, "server") ?? env.SITEFLOW_API_URL ?? link?.serverUrl);
    const serverUrl = saved?.serverUrl;
    const baseDomain = flagString(parsed.flags, "base-domain") ?? env.SITEFLOW_BASE_DOMAIN ?? saved?.config.baseDomain;
    const apiToken = flagString(parsed.flags, "token") ?? env.SITEFLOW_API_TOKEN ?? saved?.config.token;
    const projectSlug = flagString(parsed.flags, "project") ?? link?.projectSlug ?? (prebuilt ? path.basename(path.resolve(prebuilt)) : undefined);
    const entrypoint = flagString(parsed.flags, "entrypoint") ?? "index.html";
    const requestedHostPrefix = flagString(parsed.flags, "host-prefix");

    if (!prebuilt || !serverUrl || !projectSlug) {
      const message = "Deploy requires --prebuilt, --server, and --project. Configure SITEFLOW_BASE_DOMAIN on the server or pass --base-domain when the server has no default.";

      if (json) {
        writeJson(io, { status: "failed", message });
      } else {
        io.stderr(`${message}\n`);
      }

      return 1;
    }

    try {
      const result = await deployPrebuilt({
        directory: prebuilt,
        serverUrl,
        projectSlug,
        baseDomain,
        entrypoint,
        requestedHostPrefix,
        apiToken,
        fetch: dependencies.fetch
      });
      const promotion = flagBoolean(parsed.flags, "prod")
        ? await promoteDeployResult(parsed, env, dependencies.fetch, serverUrl, apiToken, result.deploymentId, result.projectId)
        : undefined;

      if (json) {
        writeJson(io, promotion ? { ...result, production: promotion } : result);
      } else {
        io.stdout(`${formatPrebuiltDeployResult(result)}${promotion ? `\n\nProduction promotion\n${formatCommandResult(promotion)}` : ""}\n`);
      }

      return promotion && promotion.status !== "accepted" ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prebuilt deploy failed.";

      if (json) {
        writeJson(io, { status: "failed", message });
      } else {
        io.stderr(`${message}\n`);
      }

      return 1;
    }
  }

  if (parsed.command === "deployments") {
    return runDeployments(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "inspect") {
    return runInspect(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "promote") {
    return runReleaseCommand("promote", parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "rollback") {
    return runReleaseCommand("rollback", parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "deploy-hook") {
    return runDeployHook(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "logs") {
    return runLogsCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "log-drain") {
    return runLogDrainCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "audit") {
    return runAuditCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "api-token") {
    return runApiTokenCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "firewall") {
    return runFirewallCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "edge-config") {
    return runEdgeConfigCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "blob") {
    return runBlobCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "cache") {
    return runCacheCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "functions") {
    return runFunctionsCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "routing-rules") {
    return runRoutingRulesCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "rolling") {
    return runRollingRelease(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "cron") {
    return runCronCommand(parsed, io, env, dependencies.fetch);
  }

  if (parsed.command === "status") {
    return runStatus(parsed, io);
  }

  if (lifecycleCommands.has(parsed.command)) {
    const message = `${parsed.command} is reserved for the lifecycle implementation phase.`;

    if (json) {
      writeJson(io, { status: "reserved", command: parsed.command, message });
    } else {
      io.stderr(`${message}\n`);
    }

    return 2;
  }

  io.stderr(`Unknown command: ${parsed.command}\n\n${helpText()}\n`);
  return 1;
}
