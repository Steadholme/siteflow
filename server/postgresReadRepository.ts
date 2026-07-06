import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import type {
  Actor,
  AnalyticsEvent,
  Artifact,
  ArtifactManifest,
  BlobAccess,
  BlobObject,
  BuildJob,
  CacheEntry,
  ChannelEvent,
  CronDispatch,
  CronJob,
  DeployHook,
  Deployment,
  DeploymentStatus,
  DomainBinding,
  EdgeConfigEntry,
  EnvironmentVariableMetadata,
  FirewallRule,
  FirewallRuleAction,
  FirewallRuleCondition,
  FunctionEntrypoint,
  FunctionInvocation,
  LogDrain,
  LogDrainDelivery,
  ObservabilityLogEntry,
  ObservabilityLogSeverity,
  ObservabilityLogSource,
  ApiToken,
  AuditEvent,
  OperatorSession,
  PermissionScope,
  Project,
  ProjectBuildSettings,
  ProjectEnvironment,
  ProjectPolicy,
  ReleaseChannel,
  ReleaseChannelName,
  ReleaseEvidenceMetadata,
  RepositoryBinding,
  RedirectStatusCode,
  RoutingHeader,
  RoutingRule,
  RoutingRuleKind,
  RouteRevision,
  RollingRelease,
  SafetyCheck,
  SavedLogQuery,
  SecretMetadata,
  SiteFlowId,
  SourceEvent,
  TeamMember,
  TeamRole,
  WebVitalName
} from "../src/domain/siteflow.js";
import { deploymentEnvironmentForBranch } from "../src/lib/environmentTarget.js";
import { sealSecretValue, unsealSecretValue } from "../src/lib/sealedSecrets.js";
import type {
  AnalyticsDashboardReadModel,
  AnalyticsDimensionReadModel,
  AnalyticsIngestReadModel,
  AnalyticsWebVitalReadModel,
  BlobDeleteReadModel,
  BlobListReadModel,
  BlobPutReadModel,
  BlobReadModel,
  BuildJobLogChunkReadModel,
  CacheListReadModel,
  CachePurgeReadModel,
  CommandResultReadModel,
  CronJobCreateReadModel,
  CronJobDisableReadModel,
  CronJobListReadModel,
  CronJobRunReadModel,
  DeployHookCreateReadModel,
  DeployHookListReadModel,
  DeployHookRevokeReadModel,
  DeployHookTriggerReadModel,
  DeploymentDetailReadModel,
  DeploymentListReadModel,
  DeploymentSummaryReadModel,
  EdgeConfigMutationReadModel,
  EdgeConfigReadModel,
  EventFeedReadModel,
  EvidenceItemReadModel,
  FirewallEvaluationReadModel,
  FirewallRuleListReadModel,
  FirewallRuleMutationReadModel,
  FunctionRuntimeItem,
  FunctionRuntimeListReadModel,
  FunctionRuntimeReadModel,
  GitWebhookIngestReadModel,
  LogDrainCreateReadModel,
  LogDrainDeliveryReadModel,
  LogDrainListReadModel,
  LogChunkReadModel,
  LogQueryReadModel,
  OperationSnapshotReadModel,
  ApiTokenCreateReadModel,
  ApiTokenRevokeReadModel,
  OperatorSessionCreateReadModel,
  OperatorSessionRotateReadModel,
  OperatorSessionRevokeAllReadModel,
  OperatorSessionRevokeReadModel,
  ProjectDetailReadModel,
  ProjectEnvironmentSettingsReadModel,
  ProjectEnvironmentVariableUpsertReadModel,
  ProjectListReadModel,
  ProjectMutationReadModel,
  ProjectSettingsReadModel,
  ReleaseChannelReadModel,
  ReleaseConsoleReadModel,
  RollingReleaseCommandReadModel,
  RollingReleaseReadModel,
  RollbackTargetReadModel,
  RouteRevisionEvidenceReadModel,
  RollbackConsoleReadModel,
  RoutingRuleListReadModel,
  RoutingRuleMatchReadModel,
  RoutingRuleMutationReadModel,
  SavedLogQueryListReadModel,
  SavedLogQueryMutationReadModel,
  TeamMemberMutationReadModel
} from "../src/domain/readModels.js";
import type {
  AbortRollingReleaseCommand,
  AdvanceRollingReleaseCommand,
  CompleteRollingReleaseCommand,
  CreateFirewallRuleCommand,
  CreateLogDrainCommand,
  CreateCronJobCommand,
  CreateProjectCommand,
  CreateDeployHookCommand,
  DeliverLogDrainCommand,
  DeleteBlobCommand,
  DeleteEdgeConfigCommand,
  DisableRoutingRuleCommand,
  DisableCronJobCommand,
  DisableFirewallRuleCommand,
  AnalyticsEventCommand,
  GetBlobCommand,
  GetFunctionRuntimeCommand,
  GitWebhookCommand,
  ListCacheEntriesCommand,
  ListFunctionsCommand,
  ListBlobsCommand,
  ListRoutingRulesCommand,
  LogQueryCommand,
  MatchRoutingRulesCommand,
  CreateApiTokenCommand,
  CreateOperatorSessionCommand,
  PutBlobCommand,
  PurgeCacheCommand,
  PromoteDeploymentCommand,
  RemoveTeamMemberCommand,
  RevokeDeployHookCommand,
  RevokeAllOperatorSessionsCommand,
  RevokeApiTokenCommand,
  RollbackDeploymentCommand,
  RunCronJobCommand,
  SaveLogQueryCommand,
  StartRollingReleaseCommand,
  TriggerDeployHookCommand,
  UpdateProjectCommand,
  UpsertEdgeConfigCommand,
  UpsertRoutingRuleCommand,
  UpsertTeamMemberCommand,
  UpsertEnvironmentVariableCommand
} from "../src/lib/api/siteflowClient.js";
import {
  assertPrebuiltUploadBudget,
  defaultPrebuiltMaxUploadBytes,
  defaultPrebuiltMaxUploadFiles,
  type PrebuiltDeployCommand,
  type PrebuiltDeployFile,
  type PrebuiltDeployResult,
  type PrebuiltImageConfig,
  type PrebuiltUploadBudget
} from "../src/lib/api/deployContracts.js";
import { analyticsWebVitalRating, normalizeAnalyticsEventInput } from "../src/lib/analytics.js";
import { redactLogLine, redactSecrets } from "../src/lib/redaction.js";
import {
  logChunkKey,
  releaseConsoleKey,
  SiteFlowConflictError,
  SiteFlowInputError,
  SiteFlowNotFoundError,
  type AddProjectDomainCommand,
  type ArtifactRoute,
  type FirewallEvaluationCommand,
  type LogDrainDeliveryPlan,
  type OperatorSessionCreateResult,
  type OperatorSessionRotateResult,
  type RecordLogDrainDeliveryCommand,
  type SiteFlowAuthPrincipal,
  type SiteFlowReadRepository
} from "./readRepository.js";

type ReleaseAction = "promote" | "rollback";
type RollingCommand =
  | StartRollingReleaseCommand
  | AdvanceRollingReleaseCommand
  | CompleteRollingReleaseCommand
  | AbortRollingReleaseCommand;
type RollingAction = "advance" | "complete" | "abort";

interface Queryable {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface ReleaseCommandRow {
  idempotency_key: string;
  operation_id: string;
  action: ReleaseAction;
  project_id: string;
  channel: ReleaseChannelName;
  current_deployment_id: string | null;
  target_deployment_id: string;
  state: "pending" | "running" | "succeeded" | "failed";
  actor: Actor;
  reason: string;
  message: string;
  route_revision_id: string | null;
  release_evidence: ReleaseEvidenceMetadata | null;
  created_at: Date;
  updated_at: Date;
}

interface ReleaseCommandInsertInput {
  idempotencyKey: string;
  operationId: string;
  action: ReleaseAction;
  projectId: SiteFlowId;
  channel: ReleaseChannelName;
  currentDeploymentId: SiteFlowId | null;
  targetDeploymentId: SiteFlowId;
  actor: Actor;
  reason: string;
  state: ReleaseCommandRow["state"];
  message: string;
  routeRevisionId?: SiteFlowId | null;
  releaseEvidenceJson?: string | null;
}

interface ReleaseCommandInsertResult {
  row: ReleaseCommandRow;
  inserted: boolean;
}

interface ArtifactRouteRow {
  host: string;
  project_id: string;
  production_branch: string | null;
  route_channel: ReleaseChannelName | null;
  source_branch: string | null;
  deployment_id: string;
  preview_host: string;
  preview_password_hash: Buffer | null;
  preview_password_salt: Buffer | null;
  artifact_root: string;
  entrypoint: string;
  artifact_manifest: Partial<ArtifactManifest> | Record<string, never>;
}

interface RollingArtifactRouteRow extends ArtifactRouteRow {
  rolling_release_id: string | null;
  candidate_project_id: string | null;
  candidate_source_branch: string | null;
  candidate_deployment_id: string | null;
  candidate_artifact_root: string | null;
  candidate_entrypoint: string | null;
  candidate_artifact_manifest: Partial<ArtifactManifest> | Record<string, never> | null;
  percentage: number | null;
}

interface DeploymentRouteRow {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  source_type: string;
  source_branch: string | null;
  source_commit_sha: string | null;
  source_repository: string | null;
  project_repository: RepositoryBinding | Record<string, never>;
  artifact_root: string;
  entrypoint: string;
  preview_host: string;
  artifact_manifest: Partial<ArtifactManifest> | Record<string, never>;
}

interface DeploymentBuildRow {
  build_job_id: string | null;
}

interface BuildJobLogStatusRow {
  status: BuildJob["status"];
}

interface LatestBuildJobLogStatusRow {
  id: string;
  status: BuildJob["status"];
}

interface DomainRow {
  project_id: string;
  hostname: string;
  channel: ReleaseChannelName;
  verified: boolean;
  last_checked_at: Date;
}

interface ReleaseChannelRow {
  project_id: string;
  name: ReleaseChannelName;
  current_deployment_id: string | null;
  pending_deployment_id: string | null;
  route_revision_id: string | null;
  updated_by: Actor;
  updated_at: Date;
}

interface RollingReleaseRow {
  id: string;
  project_id: string;
  channel: ReleaseChannelName;
  current_deployment_id: string;
  candidate_deployment_id: string;
  percentage: number;
  status: RollingRelease["status"];
  actor: Actor;
  reason: string;
  route_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  aborted_at: Date | null;
}

interface RouteRevisionRow {
  id: string;
  project_id: string;
  channel: ReleaseChannelName;
  deployment_id: string;
  previous_deployment_id: string | null;
  status: RouteRevision["status"];
  generated_config: string;
  validation_summary: string;
  release_evidence: ReleaseEvidenceMetadata | null;
  created_at: Date;
  applied_at: Date | null;
  failed_reason: string | null;
}

interface BuildLogRow {
  id: string;
  line: string;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  status: Project["status"];
  framework: string;
  default_branch: string;
  production_branch: string;
  repository: RepositoryBinding | Record<string, never>;
  build_settings: ProjectBuildSettings | Record<string, never>;
  created_at: Date;
  updated_at: Date;
}

interface EnvironmentRow {
  project_id: string;
  name: string;
  type: ProjectEnvironment["type"];
  branch_pattern: string | null;
  created_at: Date;
  updated_at: Date;
}

interface EnvironmentVariableRow {
  id: string;
  project_id: string;
  key: string;
  target_environment: string;
  scope: EnvironmentVariableMetadata["scope"];
  source: SecretMetadata["source"];
  fingerprint: string;
  updated_by: EnvironmentVariableMetadata["updatedBy"] | null;
  updated_at: Date;
}

interface DeployHookRow {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  target_environment: string;
  token_prefix: string;
  status: DeployHook["status"];
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  last_triggered_at: Date | null;
}

interface CronJobRow {
  id: string;
  project_id: string;
  name: string;
  path: string;
  schedule: string;
  status: CronJob["status"];
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
  last_dispatched_at: Date | null;
}

interface CronDispatchRow {
  id: string;
  cron_job_id: string;
  project_id: string;
  target_url: string;
  method: CronDispatch["method"];
  user_agent: string;
  status: CronDispatch["status"];
  reason: string;
  scheduled_at: Date;
  dispatched_at: Date;
  response_status: number | null;
  error_message: string | null;
}

interface AnalyticsEventRow {
  id: string;
  project_id: string;
  kind: AnalyticsEvent["kind"];
  path: string;
  referrer: string | null;
  country: string | null;
  browser: string | null;
  device: string | null;
  event_name: string | null;
  vital_name: WebVitalName | null;
  vital_value: string | number | null;
  occurred_at: Date;
  received_at: Date;
}

interface AnalyticsTotalsRow {
  pageviews: string | number;
  custom_events: string | number;
  web_vitals: string | number;
  unique_paths: string | number;
}

interface AnalyticsDimensionRow {
  name: string;
  count: string | number;
}

interface AnalyticsWebVitalRow {
  name: WebVitalName;
  count: string | number;
  p75: string | number;
}

interface ObservabilityLogRow {
  id: string;
  project_id: string;
  source: ObservabilityLogSource;
  severity: ObservabilityLogSeverity;
  message: string;
  occurred_at: Date;
  deployment_id: string | null;
  build_job_id: string | null;
  cron_job_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown> | null;
  total_count?: string | number;
}

interface SavedLogQueryRow {
  id: string;
  project_id: string;
  name: string;
  filters: SavedLogQuery["filters"] | Record<string, unknown>;
  created_by: Actor | null;
  created_at: Date;
  updated_at: Date;
}

interface LogDrainRow {
  id: string;
  project_id: string;
  name: string;
  url: string;
  sources: ObservabilityLogSource[];
  minimum_severity: ObservabilityLogSeverity;
  status: LogDrain["status"];
  signing_secret: string;
  signing_secret_prefix: string;
  created_by: Actor | null;
  created_at: Date;
  updated_at: Date;
  last_delivered_at: Date | null;
}

interface LogDrainDeliveryRow {
  id: string;
  drain_id: string;
  project_id: string;
  status: LogDrainDelivery["status"];
  response_status: number | null;
  events_delivered: number;
  attempt: number;
  payload_sha256: string;
  error_message: string | null;
  delivered_at: Date;
}

interface TeamMemberRow {
  id: string;
  project_id: string;
  actor: Actor;
  role: TeamRole;
  permissions: PermissionScope[];
  created_at: Date;
  updated_at: Date;
}

interface ApiTokenRow {
  id: string;
  project_id: string | null;
  name: string;
  token_prefix: string;
  scopes: PermissionScope[];
  status: ApiToken["status"];
  created_by: Actor | null;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

interface OperatorSessionRow {
  id: string;
  subject: string;
  actor: Actor | null;
  token_prefix: string;
  scopes: PermissionScope[];
  project_ids: string[] | null;
  status: OperatorSession["status"];
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

interface OperatorSessionRotateRow extends OperatorSessionRow {
  max_age_seconds: number;
}

interface AuditEventRow {
  id: string;
  project_id: string;
  action: AuditEvent["action"];
  actor: Actor;
  target_type: AuditEvent["targetType"];
  target_id: string;
  summary: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface FirewallRuleRow {
  id: string;
  project_id: string;
  name: string;
  action: FirewallRuleAction;
  priority: number;
  status: FirewallRule["status"];
  conditions: FirewallRuleCondition | Record<string, unknown>;
  created_by: Actor | null;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
}

interface EdgeConfigRow {
  id: string;
  project_id: string;
  key: string;
  value: unknown;
  value_type: EdgeConfigEntry["valueType"];
  created_by: Actor | null;
  updated_by: Actor | null;
  created_at: Date;
  updated_at: Date;
}

interface RoutingRuleRow {
  id: string;
  project_id: string;
  name: string;
  kind: RoutingRuleKind;
  source: string;
  destination: string | null;
  status_code: RedirectStatusCode | null;
  headers: RoutingHeader[] | Record<string, unknown>[];
  priority: number;
  status: RoutingRule["status"];
  created_by: Actor | null;
  updated_by: Actor | null;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
}

interface BlobRow {
  id: string;
  project_id: string;
  pathname: string;
  access: BlobAccess;
  content_type: string;
  cache_control_max_age: number | null;
  size_bytes: string | number;
  sha256: string;
  etag: string;
  url: string;
  content?: Buffer;
  uploaded_by: Actor | null;
  uploaded_at: Date;
  updated_at: Date;
}

interface CacheEntryRow {
  id: string;
  project_id: string;
  cache_key: string;
  path: string;
  tags: string[];
  status: CacheEntry["status"];
  content_type: string;
  size_bytes: string | number;
  etag: string;
  max_age_seconds: number;
  stale_while_revalidate_seconds: number;
  last_generated_at: Date;
  expires_at: Date;
  stale_at: Date;
  purged_at: Date | null;
  updated_at: Date;
}

interface FunctionInvocationRow {
  id: string;
  deployment_id: string;
  project_id: string;
  path: string;
  method: string;
  status: FunctionInvocation["status"];
  response_status: number;
  duration_ms: number;
  request_id: string;
  logs: string[];
  error_message: string | null;
  invoked_at: Date;
}

interface SourceEventRow {
  id: string;
  project_id: string;
  kind: SourceEvent["kind"];
  status: SourceEvent["status"];
  disposition: SourceEvent["disposition"];
  provider_delivery_id: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  commit_author: string;
  pull_request_number: number | null;
  received_at: Date;
  actor: SourceEvent["actor"];
}

interface DeploymentSummaryRow {
  id: string;
  project_id: string;
  project_name: string;
  source_branch: string | null;
  source_commit_sha: string | null;
  preview_host: string;
  status: DeploymentStatus;
  checksum: string;
  file_count: number;
  total_bytes: string | number;
  artifact_manifest: Partial<ArtifactManifest> | Record<string, never>;
  created_at: Date;
  route_revision_id: string | null;
  route_revision_status: RouteRevision["status"] | null;
}

interface DeploymentInspectRow {
  id: string;
  project_id: string;
  source_branch: string | null;
  source_commit_sha: string | null;
  source_event_id: string | null;
  build_job_id: string | null;
  deployment_status: DeploymentStatus;
  artifact_root: string;
  checksum: string;
  file_count: number;
  total_bytes: string | number;
  preview_host: string;
  artifact_manifest: Partial<ArtifactManifest> | Record<string, never>;
  deployment_created_at: Date;
  project_slug: string;
  project_name: string;
  project_status: Project["status"];
  project_framework: string;
  project_default_branch: string;
  project_production_branch: string;
  project_repository: RepositoryBinding | Record<string, never>;
  project_build_settings: ProjectBuildSettings | Record<string, never>;
  project_created_at: Date;
  project_updated_at: Date;
  source_kind: SourceEvent["kind"] | null;
  source_status: SourceEvent["status"] | null;
  source_disposition: SourceEvent["disposition"] | null;
  provider_delivery_id: string | null;
  source_branch_name: string | null;
  source_commit_message: string | null;
  source_commit_author: string | null;
  source_received_at: Date | null;
  source_actor: SourceEvent["actor"] | null;
  build_status: BuildJob["status"] | null;
  build_framework: string | null;
  install_command: string | null;
  build_command: string | null;
  output_directory: string | null;
  queued_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  worker_id: string | null;
  route_revision_id: string | null;
  route_channel: ReleaseChannelName | null;
  route_previous_deployment_id: string | null;
  route_status: RouteRevision["status"] | null;
  route_generated_config: string | null;
  route_validation_summary: string | null;
  route_release_evidence: ReleaseEvidenceMetadata | null;
  route_created_at: Date | null;
  route_applied_at: Date | null;
  route_failed_reason: string | null;
}

export interface PostgresSiteFlowReadRepositoryOptions {
  artifactRoot: string;
  publicScheme?: "http" | "https";
  baseDomain?: string;
  operatorSessionIdleTimeoutSeconds?: number;
  prebuiltMaxUploadBytes?: number;
  prebuiltMaxFiles?: number;
}

function operationIdFor(idempotencyKey: string) {
  return `op_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20)}`;
}

const releaseCommandLockNamespace = "siteflow:release-command";
const releaseChannelLockNamespace = "siteflow:release-channel";

function positiveIntegerOption(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function permissionLevel(permission: PermissionScope) {
  return permission === "read" ? 0 : permission === "write" ? 1 : 2;
}

function rolePermissions(role: TeamRole): PermissionScope[] {
  switch (role) {
    case "owner":
      return ["read", "write", "admin"];
    case "member":
    case "developer":
      return ["read", "write"];
    case "viewer":
      return ["read"];
  }
}

function normalizePermissionScopes(scopes: PermissionScope[]) {
  const normalized = Array.from(new Set(scopes)).sort((left, right) => permissionLevel(left) - permissionLevel(right));

  if (normalized.length === 0 || normalized.some((scope) => !["read", "write", "admin"].includes(scope))) {
    throw new Error("API token scopes must include read, write, or admin.");
  }

  return normalized;
}

function hasPermission(scopes: PermissionScope[], required: PermissionScope) {
  return scopes.some((scope) => permissionLevel(scope) >= permissionLevel(required));
}

function apiTokenSecret() {
  return `sft_${randomBytes(24).toString("base64url")}`;
}

function apiTokenHash(token: string) {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function operatorSessionSecret() {
  return `sfs_${randomBytes(32).toString("base64url")}`;
}

function operatorSessionHash(token: string) {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function normalizeOperatorSessionSubject(value: string | undefined) {
  const subject = (value ?? "operator").trim();

  if (!subject || subject.length > 120) {
    throw new Error("Operator session subject is required and must be 120 characters or fewer.");
  }

  return subject;
}

function normalizeOperatorSessionTtlSeconds(value: number | undefined) {
  const ttlSeconds = value ?? 3600;

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
    throw new Error("Operator session ttlSeconds must be an integer from 60 to 86400.");
  }

  return ttlSeconds;
}

function normalizeOperatorSessionIdleTimeoutSeconds(value: number | undefined) {
  const idleTimeoutSeconds = value ?? 1800;

  if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 60 || idleTimeoutSeconds > 86_400) {
    throw new Error("Operator session idle timeout seconds must be an integer from 60 to 86400.");
  }

  return idleTimeoutSeconds;
}

function normalizeOperatorSessionProjectIds(value: SiteFlowId[] | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Operator session projectIds must include at least one project id when provided.");
  }

  const projectIds = Array.from(new Set(value.map((entry) => entry.trim())));

  if (projectIds.some((entry) => !entry || entry.length > 120)) {
    throw new Error("Operator session projectIds must be non-empty project ids 120 characters or fewer.");
  }

  return projectIds;
}

function normalizeFirewallRuleName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Firewall rule name is required and must be 80 characters or fewer.");
  }

  return name;
}

function normalizeFirewallAction(value: FirewallRuleAction): FirewallRuleAction {
  if (value !== "allow" && value !== "block" && value !== "challenge") {
    throw new Error(`Invalid firewall action: ${String(value)}`);
  }

  return value;
}

function normalizeFirewallPriority(value: number | undefined) {
  if (value === undefined) {
    return 100;
  }

  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new Error("Firewall priority must be an integer from 0 to 10000.");
  }

  return value;
}

function normalizeFirewallConditions(conditions: FirewallRuleCondition): FirewallRuleCondition {
  const normalized: FirewallRuleCondition = {};

  if (conditions.ipRanges?.length) {
    normalized.ipRanges = Array.from(new Set(conditions.ipRanges.map((entry) => entry.trim()).filter(Boolean)));
  }

  if (conditions.pathPattern?.trim()) {
    const pathPattern = conditions.pathPattern.trim();

    if (!pathPattern.startsWith("/") || pathPattern.includes("..")) {
      throw new Error("Firewall path pattern must start with / and must not contain parent directory segments.");
    }

    normalized.pathPattern = pathPattern;
  }

  if (conditions.header?.name.trim()) {
    normalized.header = {
      name: conditions.header.name.trim().toLowerCase(),
      value: conditions.header.value?.trim() || undefined
    };
  }

  if (conditions.userAgent?.trim()) {
    normalized.userAgent = conditions.userAgent.trim();
  }

  if (!normalized.ipRanges?.length && !normalized.pathPattern && !normalized.header && !normalized.userAgent) {
    throw new Error("Firewall rule requires at least one condition.");
  }

  return normalized;
}

function normalizeEdgeConfigKey(value: string) {
  const key = value.trim();

  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
    throw new Error("Edge Config key must be 1-128 characters and use letters, numbers, _, ., :, or -.");
  }

  return key;
}

function normalizeRoutingRuleName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Routing rule name is required and must be 80 characters or fewer.");
  }

  return name;
}

function normalizeRoutingRuleKind(value: RoutingRuleKind): RoutingRuleKind {
  if (value !== "redirect" && value !== "rewrite" && value !== "header") {
    throw new Error(`Invalid routing rule kind: ${String(value)}`);
  }

  return value;
}

function normalizeRoutingPath(value: string, field: string) {
  const pathName = value.trim();

  if (!pathName.startsWith("/") || pathName.includes("..")) {
    throw new Error(`Routing rule ${field} must start with / and must not contain parent directory segments.`);
  }

  return pathName;
}

function normalizeRedirectStatusCode(value: RedirectStatusCode | undefined) {
  if (value === undefined) {
    return 308;
  }

  if (value !== 301 && value !== 302 && value !== 307 && value !== 308) {
    throw new Error("Redirect status code must be 301, 302, 307, or 308.");
  }

  return value;
}

function normalizeRoutingHeaders(headers: RoutingHeader[] | undefined) {
  const normalized = (headers ?? [])
    .map((header) => ({
      key: header.key.trim().toLowerCase(),
      value: header.value.trim()
    }))
    .filter((header) => header.key && header.value);

  if (normalized.some((header) => !/^[a-z0-9-]+$/.test(header.key))) {
    throw new Error("Routing rule header keys must use HTTP token characters.");
  }

  return normalized;
}

function normalizeRoutingPriority(value: number | undefined) {
  if (value === undefined) {
    return 100;
  }

  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new Error("Routing rule priority must be an integer from 0 to 10000.");
  }

  return value;
}

function normalizeRoutingStatus(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new Error("Routing rule status must be active or disabled.");
}

function normalizeRoutingRuleInput(command: UpsertRoutingRuleCommand) {
  const kind = normalizeRoutingRuleKind(command.kind);
  const source = normalizeRoutingPath(command.source, "source");
  const destination = command.destination ? normalizeRoutingPath(command.destination, "destination") : undefined;
  const headers = normalizeRoutingHeaders(command.headers);

  if ((kind === "redirect" || kind === "rewrite") && !destination) {
    throw new Error("Redirect and rewrite routing rules require a destination.");
  }

  if (kind === "header" && headers.length === 0) {
    throw new Error("Header routing rules require at least one header.");
  }

  return {
    name: normalizeRoutingRuleName(command.name),
    kind,
    source,
    destination,
    statusCode: kind === "redirect" ? normalizeRedirectStatusCode(command.statusCode) : undefined,
    headers: kind === "header" ? headers : [],
    priority: normalizeRoutingPriority(command.priority)
  };
}

function prebuiltRoutingCommands(projectId: SiteFlowId, routing: PrebuiltDeployCommand["routing"] | undefined): UpsertRoutingRuleCommand[] {
  const commands: UpsertRoutingRuleCommand[] = [];

  for (const [kind, rules] of [
    ["redirect", routing?.redirects],
    ["rewrite", routing?.rewrites],
    ["header", routing?.headers]
  ] as const) {
    for (const [index, rule] of (rules ?? []).entries()) {
      commands.push({
        projectId,
        name: rule.name ?? `vercel:${kind}:${index + 1}:${rule.source}`,
        kind,
        source: rule.source,
        destination: rule.destination,
        statusCode: rule.statusCode,
        headers: rule.headers,
        priority: (index + 1) * 10,
        actor: {
          id: "siteflow:prebuilt",
          name: "Prebuilt deploy",
          role: "system"
        }
      });
    }
  }

  return commands;
}

const prebuiltActor: Actor = {
  id: "siteflow:prebuilt",
  name: "Prebuilt deploy",
  role: "system"
};

function prebuiltCronJobName(pathName: string) {
  const normalizedPath = pathName.trim().replace(/\s+/g, " ");
  const baseName = `vercel:${normalizedPath}`;

  if (baseName.length <= 80) {
    return baseName;
  }

  const digest = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 12);
  return `vercel:${normalizedPath.slice(0, 60)}:${digest}`;
}

function prebuiltCronCommands(projectId: SiteFlowId, crons: PrebuiltDeployCommand["crons"] | undefined): CreateCronJobCommand[] {
  return (crons ?? []).map((cron) => ({
    projectId,
    name: prebuiltCronJobName(cron.path),
    path: cron.path,
    schedule: cron.schedule,
    actor: prebuiltActor
  }));
}

function edgeConfigValueType(value: unknown): EdgeConfigEntry["valueType"] {
  if (typeof value === "boolean") {
    return "boolean";
  }

  if (typeof value === "number") {
    return "number";
  }

  if (typeof value === "string") {
    return "string";
  }

  return "json";
}

function normalizeBlobPathname(value: string) {
  const pathname = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");

  if (!pathname || pathname === "." || pathname.length > 1024 || pathname.includes("\0")) {
    throw new Error("Blob pathname is required and must be 1-1024 characters.");
  }

  if (pathname.startsWith("../") || pathname.includes("/../") || pathname.endsWith("/..") || pathname === "..") {
    throw new Error("Blob pathname must not contain parent directory segments.");
  }

  return pathname;
}

function normalizeBlobPrefix(value: string | undefined) {
  if (!value?.trim()) {
    return undefined;
  }

  return normalizeBlobPathname(value);
}

function normalizeBlobAccess(value: BlobAccess | undefined): BlobAccess {
  if (value === undefined) {
    return "public";
  }

  if (value !== "public" && value !== "private") {
    throw new Error("Blob access must be public or private.");
  }

  return value;
}

function normalizeBlobContentType(value: string | undefined) {
  const contentType = value?.trim() || "application/octet-stream";

  if (contentType.length > 160 || /[\r\n]/.test(contentType)) {
    throw new Error("Blob content type must be 160 characters or fewer.");
  }

  return contentType;
}

function normalizeBlobCacheControlMaxAge(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0 || value > 31536000) {
    throw new Error("Blob cache max age must be an integer from 0 to 31536000.");
  }

  return value;
}

function normalizeBlobLimit(value: number | undefined) {
  if (value === undefined) {
    return 100;
  }

  if (!Number.isFinite(value)) {
    return 100;
  }

  return Math.min(Math.max(Math.floor(value), 1), 1000);
}

function decodeBlobContentBase64(value: string) {
  if (typeof value !== "string") {
    throw new Error("Blob contentBase64 must be a base64 string.");
  }

  const normalized = value.trim();
  const content = Buffer.from(normalized, "base64");
  const compactInput = normalized.replace(/=+$/, "");
  const compactOutput = content.toString("base64").replace(/=+$/, "");

  if (compactInput !== compactOutput) {
    throw new Error("Blob contentBase64 must be valid base64.");
  }

  return content;
}

function blobUrl(projectId: SiteFlowId, pathname: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/blobs/${encodeURIComponent(pathname)}`;
}

function normalizeCachePath(value: string) {
  const pathName = value.trim();

  if (!pathName.startsWith("/") || pathName.includes("\0") || pathName.includes("..") || pathName.length > 1024) {
    throw new Error("Cache path must start with / and must not contain parent directory segments.");
  }

  return pathName;
}

function normalizeCacheTag(value: string | undefined) {
  if (!value?.trim()) {
    return undefined;
  }

  const tag = value.trim();

  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tag)) {
    throw new Error("Cache tag must be 1-128 characters and use letters, numbers, _, ., :, or -.");
  }

  return tag;
}

function normalizeCacheStatus(value: string | undefined): CacheEntry["status"] | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "fresh" || value === "stale" || value === "purged") {
    return value;
  }

  throw new Error("Cache status must be fresh, stale, or purged.");
}

function normalizeCacheLimit(value: number | undefined) {
  if (value === undefined) {
    return 100;
  }

  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error("Cache limit must be an integer from 1 to 1000.");
  }

  return value;
}

function pathMatchesPattern(pathName: string, pattern: string) {
  if (pattern === "/(.*)" || pattern === "/:path*" || pattern === "/:path*?") {
    return pathName.startsWith("/");
  }

  if (pattern.endsWith("*")) {
    return pathName.startsWith(pattern.slice(0, -1));
  }

  if (pattern.includes(":")) {
    const pathSegments = pathName.split("/").filter(Boolean);
    const patternSegments = pattern.split("/").filter(Boolean);

    for (let index = 0; index < patternSegments.length; index += 1) {
      const segment = patternSegments[index];
      const pathSegment = pathSegments[index];

      if (segment.startsWith(":") && segment.endsWith("*")) {
        return true;
      }

      if (pathSegment === undefined) {
        return false;
      }

      if (segment.startsWith(":")) {
        continue;
      }

      if (segment !== pathSegment) {
        return false;
      }
    }

    return pathSegments.length === patternSegments.length;
  }

  return pathName === pattern;
}

function routingParams(pathName: string, pattern: string) {
  const params = new Map<string, string>();
  const pathSegments = pathName.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);

  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];

    if (!segment.startsWith(":")) {
      continue;
    }

    if (segment.endsWith("*")) {
      params.set(segment.slice(1, -1), pathSegments.slice(index).join("/"));
      break;
    }

    params.set(segment.slice(1), pathSegments[index] ?? "");
  }

  return params;
}

function applyRoutingDestination(pathName: string, source: string, destination: string | undefined) {
  if (!destination) {
    return undefined;
  }

  const params = routingParams(pathName, source);
  let nextPath = destination;

  for (const [key, value] of params) {
    nextPath = nextPath.replaceAll(`:${key}*`, value).replaceAll(`:${key}`, value);
  }

  return nextPath;
}

function ipv4ToNumber(value: string) {
  const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
  const parts = normalized.split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) => Number(part));

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }

  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipMatchesCidr(ip: string, cidr: string) {
  const [network, prefixRaw] = cidr.split("/", 2);
  const prefix = Number(prefixRaw);
  const ipValue = ipv4ToNumber(ip);
  const networkValue = ipv4ToNumber(network);

  if (ipValue === undefined || networkValue === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;

  return (ipValue & mask) === (networkValue & mask);
}

function ipMatches(ip: string | undefined, ranges: string[] | undefined) {
  if (!ranges?.length) {
    return true;
  }

  if (!ip) {
    return false;
  }

  return ranges.some((range) => {
    const normalized = range.trim();

    if (normalized.endsWith("*")) {
      return ip.startsWith(normalized.slice(0, -1));
    }

    if (normalized.includes("/")) {
      return ipMatchesCidr(ip, normalized);
    }

    return ip === normalized;
  });
}

function firewallConditionMatches(rule: FirewallRule, request: FirewallEvaluationCommand) {
  const conditions = rule.conditions;

  if (!ipMatches(request.ip, conditions.ipRanges)) {
    return false;
  }

  if (conditions.pathPattern && !pathMatchesPattern(request.path, conditions.pathPattern)) {
    return false;
  }

  if (conditions.header) {
    const headerValue = request.headers[conditions.header.name.toLowerCase()];

    if (!headerValue) {
      return false;
    }

    if (conditions.header.value && headerValue !== conditions.header.value) {
      return false;
    }
  }

  if (conditions.userAgent && !request.userAgent?.toLowerCase().includes(conditions.userAgent.toLowerCase())) {
    return false;
  }

  return true;
}

function assertReleaseCommand(command: PromoteDeploymentCommand | RollbackDeploymentCommand) {
  if (!command.projectId || !command.channel || !command.targetDeploymentId || !command.idempotencyKey) {
    throw new Error("Release command requires project, channel, target deployment, and idempotency key.");
  }

  if (!command.actor?.id || !command.reason.trim()) {
    throw new Error("Release command requires actor and audit reason.");
  }
}

function operationKind(action: ReleaseAction): OperationSnapshotReadModel["kind"] {
  return action === "promote" ? "promotion" : "rollback";
}

function normalizeSlug(value: string) {
  const slug = value.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
    throw new Error("Project slug must be 3-63 characters of lowercase letters, numbers, and hyphens.");
  }

  return slug;
}

function normalizeName(value: string) {
  const name = value.trim();

  if (!name || name.length > 120) {
    throw new Error("Project name is required and must be 120 characters or fewer.");
  }

  return name;
}

function normalizeBranch(value: string | undefined, fallback = "main") {
  const branch = (value ?? fallback).trim();

  if (!branch || branch.length > 180 || branch.includes("..")) {
    throw new Error("Project branch must be a valid branch name.");
  }

  return branch;
}

function normalizeEnvironmentName(value: string) {
  const name = value.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
    throw new Error("Environment name must be DNS-safe and 1-63 characters.");
  }

  return name;
}

function normalizeDeployHookName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Deploy hook name is required and must be 80 characters or fewer.");
  }

  return name;
}

function normalizeCronJobName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Cron job name is required and must be 80 characters or fewer.");
  }

  return name;
}

function normalizeCronPath(value: string) {
  const pathName = value.trim();

  if (!pathName.startsWith("/") || pathName.includes("://") || pathName.includes("..") || pathName.length > 512) {
    throw new Error("Cron job path must start with / and must not contain protocol or parent directory segments.");
  }

  return pathName;
}

function normalizeCronSchedule(value: string) {
  const schedule = value.trim().replace(/\s+/g, " ");
  const fields = schedule.split(" ");

  if (fields.length !== 5) {
    throw new Error("Cron schedule must contain five fields: minute hour day-of-month month day-of-week.");
  }

  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7]
  ] as const;

  fields.forEach((field, index) => {
    if (!isCronField(field, ranges[index][0], ranges[index][1])) {
      throw new Error(`Cron schedule field ${index + 1} is invalid: ${field}.`);
    }
  });

  return schedule;
}

function isCronField(field: string, min: number, max: number) {
  return field.split(",").every((part) => isCronPart(part, min, max));
}

function isCronPart(part: string, min: number, max: number) {
  const [rangePart, stepPart] = part.split("/", 2);

  if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1 || Number(stepPart) > max)) {
    return false;
  }

  if (rangePart === "*") {
    return true;
  }

  if (rangePart.includes("-")) {
    const [left, right] = rangePart.split("-", 2).map(Number);
    return Number.isInteger(left) && Number.isInteger(right) && left >= min && right <= max && left <= right;
  }

  if (!/^\d+$/.test(rangePart)) {
    return false;
  }

  const value = Number(rangePart);
  return value >= min && value <= max;
}

function normalizeEnvironmentVariableKey(value: string) {
  const key = value.trim();

  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) {
    throw new Error("Environment variable key must use uppercase letters, numbers, and underscores.");
  }

  return key;
}

function assertReleaseChannelName(value: ReleaseChannelName) {
  if (value !== "production" && value !== "staging" && value !== "preview") {
    throw new Error(`Invalid release channel: ${value}`);
  }
}

function normalizeHostname(value: string) {
  let hostname = value.trim().toLowerCase();

  if (hostname.includes("://")) {
    const parsed = new URL(hostname);

    if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
      throw new Error("Domain hostname must not include a path, query, or hash.");
    }

    hostname = parsed.hostname;
  }

  hostname = hostname.replace(/\.$/, "");

  if (!hostname || hostname.includes("/") || hostname.includes("?") || hostname.includes("#") || hostname.includes(":")) {
    throw new Error("Domain hostname must be a DNS hostname without protocol or path.");
  }

  if (hostname.length > 253) {
    throw new Error("Domain hostname must be 253 characters or fewer.");
  }

  const labels = hostname.split(".");

  if (labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Domain hostname must be DNS-safe.");
  }

  return hostname;
}

function normalizeProjectDomains(domains: DomainBinding[], defaultChannel: ReleaseChannelName = "production"): DomainBinding[] {
  const seen = new Set<string>();

  return domains.map((domain) => {
    const hostname = normalizeHostname(domain.hostname);
    const channel = domain.channel ?? defaultChannel;
    assertReleaseChannelName(channel);

    if (seen.has(hostname)) {
      throw new Error(`Duplicate domain hostname: ${hostname}`);
    }

    seen.add(hostname);

    return {
      hostname,
      channel,
      verified: domain.verified ?? true,
      lastCheckedAt: domain.lastCheckedAt ?? new Date().toISOString()
    };
  });
}

function normalizeProjectDomainHostname(value: string) {
  try {
    return normalizeHostname(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new SiteFlowInputError(error.message);
    }

    throw error;
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function projectDomainAutoVerifyEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.SITEFLOW_DOMAIN_AUTOVERIFY?.trim().toLowerCase();

  // SITEFLOW_DOMAIN_AUTOVERIFY is a single-tenant escape hatch; default off keeps public API domain adds unverified.
  return value === "1" || value === "true" || value === "yes";
}

const dnsLabelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function canonicalProjectHost(project: Pick<Project, "slug">, baseDomain: string | undefined) {
  return baseDomain ? `${project.slug}.${normalizeBaseDomain(baseDomain)}` : undefined;
}

function vanityBaseSubdomainLabel(hostname: string, baseDomain: string | undefined) {
  if (!baseDomain) {
    return undefined;
  }

  const normalizedBaseDomain = normalizeBaseDomain(baseDomain);
  const suffix = `.${normalizedBaseDomain}`;

  if (hostname === normalizedBaseDomain || !hostname.endsWith(suffix)) {
    return undefined;
  }

  const label = hostname.slice(0, -suffix.length);

  if (!label || label.includes(".") || !dnsLabelPattern.test(label)) {
    return undefined;
  }

  return label;
}

export function isVanityBaseSubdomain(hostname: string, baseDomain: string | undefined): boolean {
  return vanityBaseSubdomainLabel(hostname, baseDomain) !== undefined;
}

function assertProjectDomainHostAllowed(hostname: string, project: Pick<Project, "slug">, baseDomain: string | undefined) {
  const canonicalHost = canonicalProjectHost(project, baseDomain);

  if (!canonicalHost) {
    return;
  }

  const normalizedBaseDomain = normalizeBaseDomain(baseDomain ?? "");

  if (hostname === canonicalHost || isVanityBaseSubdomain(hostname, normalizedBaseDomain)) {
    return;
  }

  if (hostname === normalizedBaseDomain || hostname.endsWith(`.${normalizedBaseDomain}`)) {
    throw new SiteFlowInputError(`Domain hostname must not use the SiteFlow base domain; use ${canonicalHost} for this project.`);
  }
}

function projectIdForSlug(slug: string) {
  return `project_${slug.replace(/-/g, "_")}`;
}

function defaultRepository(slug: string, defaultBranch: string): RepositoryBinding {
  return {
    provider: "generic",
    owner: "local",
    name: slug,
    defaultBranch
  };
}

function defaultBuildSettings(framework: string, overrides?: Partial<ProjectBuildSettings>): ProjectBuildSettings {
  return {
    installCommand: overrides?.installCommand ?? "npm install",
    buildCommand: overrides?.buildCommand ?? "npm run build",
    outputDirectory: overrides?.outputDirectory ?? "dist",
    rootDirectory: overrides?.rootDirectory,
    framework: overrides?.framework ?? framework,
    ignoreCommand: overrides?.ignoreCommand
  };
}

function defaultPolicy(): ProjectPolicy {
  return {
    requiredChecks: [],
    retentionDays: 30,
    previewDeploymentsEnabled: true,
    cdnEnabled: false,
    requirePromotionReason: true
  };
}

function projectFromRow(row: ProjectRow): Project {
  const repository = Object.keys(row.repository).length > 0
    ? row.repository as RepositoryBinding
    : defaultRepository(row.slug, row.default_branch);
  const buildSettings = Object.keys(row.build_settings).length > 0
    ? row.build_settings as ProjectBuildSettings
    : defaultBuildSettings(row.framework);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    framework: row.framework,
    defaultBranch: row.default_branch,
    productionBranch: row.production_branch,
    repository,
    buildSettings,
    domains: [],
    policy: defaultPolicy(),
    secrets: [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mergeRepositoryBinding(current: RepositoryBinding, incoming: RepositoryBinding): RepositoryBinding {
  const currentPayload = isRecord(current.providerPayload) ? current.providerPayload : {};
  const incomingPayload = isRecord(incoming.providerPayload) ? incoming.providerPayload : {};

  return {
    ...current,
    installationId: incoming.installationId ?? current.installationId,
    webhookSecretRef: incoming.webhookSecretRef ?? current.webhookSecretRef,
    providerPayload: {
      ...currentPayload,
      ...incomingPayload
    }
  };
}

function environmentFromRow(row: EnvironmentRow): ProjectEnvironment {
  return {
    projectId: row.project_id,
    name: row.name,
    type: row.type,
    branchPattern: row.branch_pattern ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function variableFromRow(row: EnvironmentVariableRow): EnvironmentVariableMetadata {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    targetEnvironment: row.target_environment,
    scope: row.scope,
    source: row.source,
    fingerprint: row.fingerprint,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by ?? undefined
  };
}

function domainFromRow(row: DomainRow): DomainBinding {
  return {
    hostname: row.hostname,
    channel: row.channel,
    verified: row.verified,
    lastCheckedAt: row.last_checked_at.toISOString()
  };
}

function previewProtectionFromRouteRow(row: ArtifactRouteRow): ArtifactRoute["previewProtection"] {
  if (!row.preview_password_hash || !row.preview_password_salt) {
    return undefined;
  }

  return {
    hash: row.preview_password_hash,
    salt: row.preview_password_salt
  };
}

function routeRevisionFromRow(row: RouteRevisionRow): RouteRevision {
  return {
    id: row.id,
    projectId: row.project_id,
    channel: row.channel,
    deploymentId: row.deployment_id,
    previousDeploymentId: row.previous_deployment_id ?? undefined,
    status: row.status,
    generatedConfig: row.generated_config,
    validationSummary: row.validation_summary,
    releaseEvidence: row.release_evidence ?? undefined,
    createdAt: row.created_at.toISOString(),
    appliedAt: row.applied_at?.toISOString(),
    failedReason: row.failed_reason ?? undefined
  };
}

function releaseChannelFromRow(row: ReleaseChannelRow): ReleaseChannel {
  return {
    id: `${row.project_id}:${row.name}`,
    projectId: row.project_id,
    name: row.name,
    currentDeploymentId: row.current_deployment_id ?? undefined,
    pendingDeploymentId: row.pending_deployment_id ?? undefined,
    routeRevisionId: row.route_revision_id ?? undefined,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by
  };
}

function rollingReleaseFromRow(row: RollingReleaseRow): RollingRelease {
  return {
    id: row.id,
    projectId: row.project_id,
    channel: row.channel,
    currentDeploymentId: row.current_deployment_id,
    candidateDeploymentId: row.candidate_deployment_id,
    percentage: row.percentage,
    status: row.status,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    abortedAt: row.aborted_at?.toISOString()
  };
}

function normalizeRolloutPercentage(value: number, allowComplete = false) {
  if (!Number.isInteger(value) || value < 1 || value > (allowComplete ? 100 : 99)) {
    throw new Error(`Rolling release percentage must be an integer from 1 to ${allowComplete ? 100 : 99}.`);
  }

  return value;
}

function rolloutBucketPercent(value: string) {
  const digest = createHash("sha256").update(value).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

function assertRollingCommand(
  command: StartRollingReleaseCommand | AdvanceRollingReleaseCommand | CompleteRollingReleaseCommand | AbortRollingReleaseCommand
) {
  if (!command.projectId || !command.channel || !command.idempotencyKey) {
    throw new Error("Rolling release command requires project, channel, and idempotency key.");
  }

  if (!command.actor?.id || !command.reason.trim()) {
    throw new Error("Rolling release command requires actor and audit reason.");
  }
}

function rollingGeneratedConfig(
  rolloutId: SiteFlowId,
  projectId: SiteFlowId,
  channel: ReleaseChannelName,
  currentDeploymentId: SiteFlowId,
  candidateDeploymentId: SiteFlowId,
  percentage: number,
  domains: DomainBinding[],
  releaseEvidenceException?: AbortRollingReleaseCommand["releaseEvidenceException"]
) {
  return [
    `rolling_release=${rolloutId}`,
    `project=${projectId}`,
    `channel=${channel}`,
    `current_deployment=${currentDeploymentId}`,
    `candidate_deployment=${candidateDeploymentId}`,
    `candidate_percentage=${percentage}`,
    ...(releaseEvidenceException
      ? [
          `release_evidence_exception=${releaseEvidenceException.type}`,
          `release_evidence_exception_target_environment=${releaseEvidenceException.targetEnvironment}`,
          `release_evidence_exception_reason=${releaseEvidenceException.reason.replace(/\s+/g, " ").trim()}`
        ]
      : []),
    ...domains.map((domain) => `host=${domain.hostname}`)
  ].join("\n");
}

function normalizeBaseDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/^\*\./, "");

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new Error("Base domain must be a valid public DNS suffix, for example w33d.xyz.");
  }

  return domain;
}

function resolveBaseDomain(commandBaseDomain: string | undefined, defaultBaseDomain: string | undefined) {
  const baseDomain = commandBaseDomain ?? defaultBaseDomain;

  if (!baseDomain) {
    throw new Error("Base domain is required. Configure SITEFLOW_BASE_DOMAIN on the server or pass baseDomain in the deploy request.");
  }

  return normalizeBaseDomain(baseDomain);
}

function normalizeHostPrefix(value?: string) {
  const prefix = value?.trim().toLowerCase() || randomUUID().replace(/-/g, "").slice(0, 12);

  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(prefix)) {
    throw new Error("Preview host prefix must be DNS-safe.");
  }

  return prefix;
}

function safeArtifactPath(filePath: string) {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid artifact file path: ${filePath}`);
  }

  return normalized;
}

async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function removeDirectoryBestEffort(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // Cleanup must not mask the original deploy failure.
  }
}

function verifyFile(file: PrebuiltDeployFile) {
  const bytes = Buffer.from(file.contentBase64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (sha256 !== file.sha256) {
    throw new Error(`Artifact checksum mismatch for ${file.path}`);
  }

  if (bytes.byteLength !== file.size) {
    throw new Error(`Artifact size mismatch for ${file.path}`);
  }

  return bytes;
}

const precompressibleExtensions = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".txt",
  ".xml",
  ".webmanifest"
]);

function isPrecompressibleBasePath(filePath: string) {
  if (filePath.startsWith(".siteflow/functions/")) {
    return false;
  }

  if (filePath.endsWith(".br") || filePath.endsWith(".gz")) {
    return false;
  }

  return precompressibleExtensions.has(path.posix.extname(filePath).toLowerCase());
}

function precompressedStats(files: PrebuiltDeployFile[]) {
  const paths = new Set(files.map((file) => safeArtifactPath(file.path)));
  const stats = {
    br: 0,
    gzip: 0
  };

  for (const filePath of paths) {
    if (filePath.endsWith(".br")) {
      const basePath = filePath.slice(0, -".br".length);

      if (paths.has(basePath) && isPrecompressibleBasePath(basePath)) {
        stats.br += 1;
      }
      continue;
    }

    if (filePath.endsWith(".gz")) {
      const basePath = filePath.slice(0, -".gz".length);

      if (paths.has(basePath) && isPrecompressibleBasePath(basePath)) {
        stats.gzip += 1;
      }
    }
  }

  return stats;
}

function fingerprintSecret(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function deployHookToken() {
  return `sfh_${randomBytes(24).toString("base64url")}`;
}

function deployHookTokenHash(token: string) {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function branchFromRef(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}

function deployHookFromRow(row: DeployHookRow): DeployHook {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branch: row.branch,
    targetEnvironment: row.target_environment,
    tokenPrefix: row.token_prefix,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
    lastTriggeredAt: row.last_triggered_at?.toISOString()
  };
}

function cronJobFromRow(row: CronJobRow): CronJob {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    path: row.path,
    schedule: row.schedule,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString(),
    lastDispatchedAt: row.last_dispatched_at?.toISOString()
  };
}

function cronDispatchFromRow(row: CronDispatchRow): CronDispatch {
  return {
    id: row.id,
    cronJobId: row.cron_job_id,
    projectId: row.project_id,
    targetUrl: row.target_url,
    method: row.method,
    userAgent: row.user_agent,
    status: row.status,
    reason: row.reason,
    scheduledAt: row.scheduled_at.toISOString(),
    dispatchedAt: row.dispatched_at.toISOString(),
    responseStatus: row.response_status ?? undefined,
    errorMessage: row.error_message ?? undefined
  };
}

function analyticsEventFromRow(row: AnalyticsEventRow): AnalyticsEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    path: row.path,
    referrer: row.referrer ?? undefined,
    country: row.country ?? undefined,
    browser: row.browser ?? undefined,
    device: row.device ?? undefined,
    eventName: row.event_name ?? undefined,
    vitalName: row.vital_name ?? undefined,
    vitalValue: row.vital_value === null ? undefined : pgNumber(row.vital_value),
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString()
  };
}

function analyticsDimensionsFromRows(rows: AnalyticsDimensionRow[], total: number): AnalyticsDimensionReadModel[] {
  return rows.map((row) => {
    const count = pgNumber(row.count);

    return {
      name: row.name,
      count,
      percentage: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0
    };
  });
}

function analyticsWebVitalsFromRows(rows: AnalyticsWebVitalRow[]): AnalyticsWebVitalReadModel[] {
  return rows.map((row) => {
    const p75 = pgNumber(row.p75);

    return {
      name: row.name,
      count: pgNumber(row.count),
      p75,
      rating: analyticsWebVitalRating(row.name, p75)
    };
  });
}

const observabilityLogSources = new Set<ObservabilityLogSource>(["build", "runtime", "function", "cron"]);
const observabilityLogSeverities = new Set<ObservabilityLogSeverity>(["info", "warning", "error"]);
const observabilitySeverityRank: Record<ObservabilityLogSeverity, number> = { info: 0, warning: 1, error: 2 };

function normalizeLogSource(value: unknown): ObservabilityLogSource | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "string" && observabilityLogSources.has(value as ObservabilityLogSource)) {
    return value as ObservabilityLogSource;
  }

  throw new Error(`Invalid observability log source: ${String(value)}`);
}

function normalizeLogSeverity(value: unknown): ObservabilityLogSeverity | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "string" && observabilityLogSeverities.has(value as ObservabilityLogSeverity)) {
    return value as ObservabilityLogSeverity;
  }

  throw new Error(`Invalid observability log severity: ${String(value)}`);
}

function normalizeLogLimit(value: number | undefined) {
  if (value === undefined) {
    return 50;
  }

  return Math.min(Math.max(Math.floor(value), 1), 100);
}

function normalizeLogCursor(value: string | undefined) {
  if (!value) {
    return 0;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("Log cursor must be a numeric offset.");
  }

  return Number.parseInt(value, 10);
}

function normalizeLogSearch(value: string | undefined) {
  const search = value?.trim();
  return search ? search.slice(0, 200) : undefined;
}

function normalizeLogQueryName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Saved log query name is required and must be 80 characters or fewer.");
  }

  return name;
}

function normalizeLogDrainName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Log drain name is required and must be 80 characters or fewer.");
  }

  return name;
}

function normalizeLogDrainUrl(value: string) {
  const parsed = new URL(value.trim());

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Log drain URL must use http or https.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Log drain URL must not include credentials.");
  }

  return parsed.toString();
}

function normalizeLogDrainSources(values: ObservabilityLogSource[] | undefined): ObservabilityLogSource[] {
  const sources = values && values.length > 0 ? values : ["build", "runtime", "function", "cron"];
  const unique = Array.from(new Set(sources.map((source) => normalizeLogSource(source) as ObservabilityLogSource)));

  if (unique.length === 0) {
    throw new Error("Log drain requires at least one log source.");
  }

  return unique;
}

function generateLogDrainSigningSecret() {
  return `sfd_${randomBytes(24).toString("base64url")}`;
}

function logDrainSigningSecretPrefix(secret: string) {
  return secret.slice(0, 12);
}

function logFiltersFromCommand(command: LogQueryCommand): LogQueryReadModel["filters"] {
  return {
    source: normalizeLogSource(command.source),
    severity: normalizeLogSeverity(command.severity),
    deploymentId: command.deploymentId?.trim() || undefined,
    search: normalizeLogSearch(command.search)
  };
}

function logFiltersFromSaved(filters: SaveLogQueryCommand["filters"]): SavedLogQuery["filters"] {
  return {
    source: normalizeLogSource(filters.source),
    severity: normalizeLogSeverity(filters.severity),
    deploymentId: filters.deploymentId?.trim() || undefined,
    search: normalizeLogSearch(filters.search)
  };
}

function savedLogQueryFromRow(row: SavedLogQueryRow): SavedLogQuery {
  const filters = row.filters as SavedLogQuery["filters"];

  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    filters: {
      source: normalizeLogSource(filters.source),
      severity: normalizeLogSeverity(filters.severity),
      deploymentId: filters.deploymentId?.trim() || undefined,
      search: normalizeLogSearch(filters.search)
    },
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function logDrainFromRow(row: LogDrainRow): LogDrain {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    url: row.url,
    sources: normalizeLogDrainSources(row.sources),
    minimumSeverity: normalizeLogSeverity(row.minimum_severity) ?? "info",
    status: row.status,
    signingSecretPrefix: row.signing_secret_prefix,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastDeliveredAt: row.last_delivered_at?.toISOString()
  };
}

function logDrainDeliveryFromRow(row: LogDrainDeliveryRow): LogDrainDelivery {
  return {
    id: row.id,
    drainId: row.drain_id,
    projectId: row.project_id,
    status: row.status,
    responseStatus: row.response_status ?? undefined,
    eventsDelivered: row.events_delivered,
    attempt: row.attempt,
    payloadSha256: row.payload_sha256,
    errorMessage: row.error_message ?? undefined,
    deliveredAt: row.delivered_at.toISOString()
  };
}

function teamMemberFromRow(row: TeamMemberRow): TeamMember {
  return {
    id: row.id,
    projectId: row.project_id,
    actor: row.actor,
    role: row.role,
    permissions: row.permissions,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function apiTokenFromRow(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    status: row.status,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString()
  };
}

function operatorSessionFromRow(row: OperatorSessionRow): OperatorSession {
  return {
    id: row.id,
    subject: row.subject,
    actor: row.actor ?? undefined,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    projectIds: row.project_ids ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString()
  };
}

function fallbackTokenActor(token: ApiToken): Actor {
  return {
    id: `api-token:${token.id}`,
    name: token.name,
    role: "system"
  };
}

function fallbackSessionActor(session: OperatorSession): Actor {
  return {
    id: `operator-session:${session.id}`,
    name: session.subject,
    role: "operator"
  };
}

function auditEventFromRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    action: row.action,
    actor: row.actor,
    targetType: row.target_type,
    targetId: row.target_id,
    summary: row.summary,
    reason: row.reason ?? undefined,
    createdAt: row.created_at.toISOString(),
    metadata: row.metadata
  };
}

function firewallRuleFromRow(row: FirewallRuleRow): FirewallRule {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    action: row.action,
    priority: row.priority,
    status: row.status,
    conditions: normalizeFirewallConditions(row.conditions as FirewallRuleCondition),
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString()
  };
}

function edgeConfigFromRow(row: EdgeConfigRow): EdgeConfigEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    value: redactSecrets(row.value),
    valueType: row.value_type,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function routingRuleFromRow(row: RoutingRuleRow): RoutingRule {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    source: row.source,
    destination: row.destination ?? undefined,
    statusCode: row.status_code ?? undefined,
    headers: normalizeRoutingHeaders(row.headers as RoutingHeader[]),
    priority: row.priority,
    status: row.status,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString()
  };
}

function blobFromRow(row: BlobRow): BlobObject {
  return {
    id: row.id,
    projectId: row.project_id,
    pathname: row.pathname,
    access: row.access,
    contentType: row.content_type,
    cacheControlMaxAge: row.cache_control_max_age ?? undefined,
    size: pgNumber(row.size_bytes),
    sha256: row.sha256,
    etag: row.etag,
    url: row.url,
    uploadedBy: row.uploaded_by ?? undefined,
    uploadedAt: row.uploaded_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function cacheEntryFromRow(row: CacheEntryRow): CacheEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.cache_key,
    path: row.path,
    tags: row.tags,
    status: row.status,
    contentType: row.content_type,
    size: pgNumber(row.size_bytes),
    etag: row.etag,
    maxAgeSeconds: row.max_age_seconds,
    staleWhileRevalidateSeconds: row.stale_while_revalidate_seconds,
    lastGeneratedAt: row.last_generated_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    staleAt: row.stale_at.toISOString(),
    purgedAt: row.purged_at?.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function functionInvocationFromRow(row: FunctionInvocationRow): FunctionInvocation {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    projectId: row.project_id,
    path: row.path,
    method: row.method,
    status: row.status,
    responseStatus: row.response_status,
    durationMs: row.duration_ms,
    requestId: row.request_id,
    errorMessage: row.error_message ?? undefined,
    logs: Array.isArray(row.logs) ? row.logs.map(String) : [],
    invokedAt: row.invoked_at.toISOString()
  };
}

function runtimeSummary(invocations: FunctionInvocation[]) {
  const durations = invocations.map((invocation) => invocation.durationMs).sort((left, right) => left - right);
  const errors = invocations.filter((invocation) => invocation.status === "failed").length;
  const p95Index = durations.length ? Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1) : 0;

  return {
    invocations: invocations.length,
    errors,
    errorRate: invocations.length ? Number((errors / invocations.length).toFixed(3)) : 0,
    averageDurationMs: invocations.length
      ? Math.round(invocations.reduce((total, invocation) => total + invocation.durationMs, 0) / invocations.length)
      : 0,
    p95DurationMs: durations[p95Index] ?? 0,
    lastInvokedAt: invocations[0]?.invokedAt
  };
}

function functionRuntimeItem(projectId: SiteFlowId, deploymentId: SiteFlowId, entry: FunctionEntrypoint, invocations: FunctionInvocation[]): FunctionRuntimeItem {
  return {
    projectId,
    deploymentId,
    function: entry,
    limits: {
      timeoutMs: entry.timeoutMs ?? 10000,
      memoryMb: entry.memoryMb ?? 512,
      concurrency: entry.concurrency ?? 50
    },
    summary: runtimeSummary(invocations.filter((invocation) => invocation.path === entry.path))
  };
}

function observabilityLogEntryFromRow(row: ObservabilityLogRow): ObservabilityLogEntry {
  const metadata = redactSecrets(row.metadata ?? {});

  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    severity: row.severity,
    message: redactLogLine(row.message),
    timestamp: row.occurred_at.toISOString(),
    deploymentId: row.deployment_id ?? undefined,
    buildJobId: row.build_job_id ?? undefined,
    cronJobId: row.cron_job_id ?? undefined,
    requestId: row.request_id ?? undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  };
}

async function insertDeployHookEvent(
  client: Queryable,
  input: {
    hookId: SiteFlowId;
    projectId: SiteFlowId;
    action: "created" | "triggered" | "revoked";
    actor?: Actor;
    summary: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  }
) {
  const eventId = stableId(
    "hookevent",
    input.idempotencyKey ?? `${input.hookId}:${input.action}:${randomUUID()}`
  );

  await client.query(
    `
      INSERT INTO siteflow_deploy_hook_events (
        id,
        hook_id,
        project_id,
        action,
        actor,
        summary,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      eventId,
      input.hookId,
      input.projectId,
      input.action,
      input.actor ? JSON.stringify(input.actor) : null,
      input.summary,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

async function insertAuditEvent(
  client: Queryable,
  event: {
    projectId: SiteFlowId;
    action: AuditEvent["action"];
    actor?: Actor;
    targetType: AuditEvent["targetType"];
    targetId: SiteFlowId;
    summary: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const actor = event.actor ?? {
    id: "system:siteflow",
    name: "SiteFlow",
    role: "system"
  };

  await client.query(
    `
      INSERT INTO siteflow_audit_events (
        id,
        project_id,
        action,
        actor,
        target_type,
        target_id,
        summary,
        reason,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb)
    `,
    [
      stableId("audit", `${event.projectId}:${event.action}:${event.targetType}:${event.targetId}:${randomUUID()}`),
      event.projectId,
      event.action,
      JSON.stringify(actor),
      event.targetType,
      event.targetId,
      event.summary,
      event.reason?.trim() || null,
      JSON.stringify(event.metadata ?? {})
    ]
  );
}

function sourceEventFromRow(row: SourceEventRow): SourceEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    disposition: row.disposition,
    providerDeliveryId: row.provider_delivery_id,
    branch: row.branch,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    commitAuthor: row.commit_author,
    receivedAt: row.received_at.toISOString(),
    actor: row.actor
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pgNumber(value: string | number) {
  return typeof value === "number" ? value : Number(value);
}

function functionEntrypointsFromManifest(manifest: Record<string, unknown>): FunctionEntrypoint[] {
  const value = manifest.functions;

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): FunctionEntrypoint[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const functionPath = typeof entry.path === "string" ? entry.path : undefined;
    const sourcePath = typeof entry.sourcePath === "string" ? entry.sourcePath : undefined;
    const runtime = entry.runtime === "nodejs20.x" ? entry.runtime : undefined;
    const runtimeIsolation = entry.runtimeIsolation === "same_process" || entry.runtimeIsolation === "isolated_process"
      ? entry.runtimeIsolation
      : undefined;
    const apiStyle = entry.apiStyle === "node" || entry.apiStyle === "fetch" ? entry.apiStyle : undefined;
    const handler = entry.handler === "handler" ? "handler" : entry.handler === "default" ? "default" : undefined;
    const methods = Array.isArray(entry.methods)
      ? entry.methods.filter((method): method is string => typeof method === "string")
      : undefined;
    const timeoutMs = typeof entry.timeoutMs === "number" ? entry.timeoutMs : undefined;
    const memoryMb = typeof entry.memoryMb === "number" ? entry.memoryMb : undefined;
    const concurrency = typeof entry.concurrency === "number" ? entry.concurrency : undefined;
    const regions = Array.isArray(entry.regions)
      ? entry.regions.filter((region): region is string => typeof region === "string")
      : undefined;
    const failoverRegions = Array.isArray(entry.failoverRegions)
      ? entry.failoverRegions.filter((region): region is string => typeof region === "string")
      : undefined;

    if (!functionPath || !sourcePath || !runtime || !handler) {
      return [];
    }

    return [
      {
        path: functionPath,
        sourcePath,
        runtime,
        runtimeIsolation,
        handler,
        apiStyle: apiStyle ?? "fetch",
        methods: methods && methods.length > 0 ? methods : undefined,
        timeoutMs,
        memoryMb,
        concurrency,
        regions: regions && regions.length > 0 ? regions : undefined,
        failoverRegions: failoverRegions && failoverRegions.length > 0 ? failoverRegions : undefined
      }
    ];
  });
}

function deploymentVersion(createdAt: Date) {
  const iso = createdAt.toISOString();
  return `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}.${iso.slice(11, 16).replace(":", "")}`;
}

function retainedUntil(createdAt: Date) {
  const retained = new Date(createdAt);
  retained.setUTCDate(retained.getUTCDate() + 30);
  return retained.toISOString();
}

function verificationStatusForDeployment(status: DeploymentStatus): Artifact["verificationStatus"] {
  if (status === "ready") {
    return "verified";
  }

  if (status === "failed" || status === "canceled") {
    return "failed";
  }

  return "pending";
}

function isFinishedBuildStatus(status: BuildJob["status"]) {
  return status === "succeeded"
    || status === "failed"
    || status === "canceled"
    || status === "timed_out"
    || status === "skipped";
}

function isTerminalBuildLogStatus(status: BuildJob["status"]) {
  return status === "succeeded"
    || status === "failed"
    || status === "canceled"
    || status === "timed_out";
}

function evidenceStatusForBuild(status: BuildJob["status"]): EvidenceItemReadModel["status"] {
  if (status === "succeeded" || status === "skipped") {
    return "pass";
  }

  if (status === "failed" || status === "canceled" || status === "timed_out") {
    return "fail";
  }

  return "pending";
}

function evidenceStatusForRoute(status?: RouteRevision["status"]): EvidenceItemReadModel["status"] {
  if (!status || status === "planned" || status === "validating" || status === "pending_apply") {
    return "pending";
  }

  if (status === "applied" || status === "superseded") {
    return "pass";
  }

  return status === "failed" ? "fail" : "warning";
}

function artifactManifestFromRow(
  row: Pick<DeploymentSummaryRow, "checksum" | "file_count" | "total_bytes" | "artifact_manifest">,
  createdAt: Date
): ArtifactManifest {
  const manifest = isRecord(row.artifact_manifest) ? row.artifact_manifest : {};
  const checksum = typeof manifest.checksum === "string" && manifest.checksum
    ? manifest.checksum
    : row.checksum.startsWith("sha256:")
      ? row.checksum
      : `sha256:${row.checksum}`;

  return {
    entrypoint: typeof manifest.entrypoint === "string" && manifest.entrypoint ? manifest.entrypoint : "index.html",
    fileCount: typeof manifest.fileCount === "number" ? manifest.fileCount : row.file_count,
    totalBytes: typeof manifest.totalBytes === "number" ? manifest.totalBytes : pgNumber(row.total_bytes),
    checksum,
    generatedAt: typeof manifest.generatedAt === "string" && manifest.generatedAt ? manifest.generatedAt : createdAt.toISOString(),
    functions: functionEntrypointsFromManifest(manifest),
    metadata: isRecord(manifest.metadata) ? manifest.metadata : {}
  };
}

function functionsFromArtifactManifest(value: Partial<ArtifactManifest> | Record<string, never> | null | undefined) {
  return isRecord(value) ? functionEntrypointsFromManifest(value) : [];
}

function artifactManifestRoutingConfig(value: Partial<ArtifactManifest> | Record<string, never> | null | undefined) {
  const metadata = isRecord(value) && isRecord(value.metadata) ? value.metadata : {};
  const routing = isRecord(metadata.routing) ? metadata.routing : {};

  return {
    cleanUrls: typeof routing.cleanUrls === "boolean" ? routing.cleanUrls : undefined,
    trailingSlash: typeof routing.trailingSlash === "boolean" ? routing.trailingSlash : undefined,
    skipTrailingSlashRedirect: typeof routing.skipTrailingSlashRedirect === "boolean" ? routing.skipTrailingSlashRedirect : undefined,
    redirects: artifactRoutingRules("redirect", routing.redirects),
    rewrites: artifactRoutingRules("rewrite", routing.rewrites),
    headers: artifactRoutingRules("header", routing.headers)
  };
}

function artifactManifestImageConfig(value: Partial<ArtifactManifest> | Record<string, never> | null | undefined): PrebuiltImageConfig | undefined {
  const metadata = isRecord(value) && isRecord(value.metadata) ? value.metadata : {};
  const images = isRecord(metadata.images) ? metadata.images : undefined;

  if (!images) {
    return undefined;
  }

  const config: PrebuiltImageConfig = {
    sizes: Array.isArray(images.sizes)
      ? images.sizes.filter((entry): entry is number => Number.isInteger(entry) && entry > 0)
      : undefined,
    qualities: Array.isArray(images.qualities)
      ? images.qualities.filter((entry): entry is number => Number.isInteger(entry) && entry > 0)
      : undefined,
    formats: Array.isArray(images.formats)
      ? images.formats.filter((entry): entry is "image/avif" | "image/webp" => entry === "image/avif" || entry === "image/webp")
      : undefined,
    minimumCacheTTL: Number.isInteger(images.minimumCacheTTL) && typeof images.minimumCacheTTL === "number" && images.minimumCacheTTL >= 0
      ? images.minimumCacheTTL
      : undefined,
    dangerouslyAllowSVG: typeof images.dangerouslyAllowSVG === "boolean" ? images.dangerouslyAllowSVG : undefined,
    contentSecurityPolicy: typeof images.contentSecurityPolicy === "string" ? images.contentSecurityPolicy : undefined,
    contentDispositionType: images.contentDispositionType === "inline" || images.contentDispositionType === "attachment"
      ? images.contentDispositionType
      : undefined
  };

  return Object.values(config).some((entry) => entry !== undefined) ? config : undefined;
}

function artifactManifestRuntimeEnvironment(value: Partial<ArtifactManifest> | Record<string, never> | null | undefined) {
  const metadata = isRecord(value) && isRecord(value.metadata) ? value.metadata : {};
  const sealedRuntimeEnv = isRecord(metadata.sealedRuntimeEnv) ? metadata.sealedRuntimeEnv : undefined;

  if (!sealedRuntimeEnv) {
    return {};
  }

  return unsealEnvironmentVariables(
    Object.fromEntries(
      Object.entries(sealedRuntimeEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    )
  );
}

function artifactRoutingRules(kind: RoutingRuleKind, value: unknown): RoutingRule[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const now = new Date(0).toISOString();
  const rules = value.flatMap((entry, index): RoutingRule[] => {
    if (!isRecord(entry) || typeof entry.source !== "string") {
      return [];
    }

    const destination = typeof entry.destination === "string" ? entry.destination : undefined;
    const headers = Array.isArray(entry.headers)
      ? normalizeRoutingHeaders(entry.headers as RoutingHeader[])
      : [];

    if ((kind === "redirect" || kind === "rewrite") && !destination) {
      return [];
    }

    if (kind === "header" && headers.length === 0) {
      return [];
    }

    return [
      {
        id: `artifact_${kind}_${index}`,
        projectId: "artifact",
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `artifact-${kind}-${index + 1}`,
        kind,
        source: entry.source,
        destination,
        statusCode: kind === "redirect" && typeof entry.statusCode === "number" ? normalizeRedirectStatusCode(entry.statusCode as RedirectStatusCode) : undefined,
        headers: kind === "header" ? headers : [],
        priority: 100 + index,
        status: "active",
        createdAt: now,
        updatedAt: now
      }
    ];
  });

  return rules.length ? rules : undefined;
}

function unsealEnvironmentVariables(values: Record<string, string> | null | undefined) {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [key, unsealSecretValue(value)])
  );
}

function deploymentSummaryFromRow(row: DeploymentSummaryRow, publicScheme: "http" | "https"): DeploymentSummaryReadModel {
  const manifest = artifactManifestFromRow(row, row.created_at);
  const verificationStatus = verificationStatusForDeployment(row.status);

  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    version: deploymentVersion(row.created_at),
    commitSha: row.source_commit_sha ?? "prebuilt",
    branch: row.source_branch ?? "manual",
    previewHost: row.preview_host,
    previewUrl: row.preview_host ? `${publicScheme}://${row.preview_host}` : "",
    status: row.status,
    artifactVerificationStatus: verificationStatus,
    routeRevisionStatus: row.route_revision_status ?? "planned",
    cdnOperationState: "skipped",
    createdAt: row.created_at.toISOString(),
    readyAt: row.status === "ready" ? row.created_at.toISOString() : undefined
  };
}

function projectFromInspectRow(row: DeploymentInspectRow): Project {
  return projectFromRow({
    id: row.project_id,
    slug: row.project_slug,
    name: row.project_name,
    status: row.project_status,
    framework: row.project_framework,
    default_branch: row.project_default_branch,
    production_branch: row.project_production_branch,
    repository: row.project_repository,
    build_settings: row.project_build_settings,
    created_at: row.project_created_at,
    updated_at: row.project_updated_at
  });
}

function sourceEventFromInspectRow(row: DeploymentInspectRow): SourceEvent {
  return {
    id: row.source_event_id ?? `src_${row.id}`,
    projectId: row.project_id,
    kind: row.source_kind ?? "manual",
    status: row.source_status ?? "accepted",
    disposition: row.source_disposition ?? "build_requested",
    providerDeliveryId: row.provider_delivery_id ?? `prebuilt:${row.id}`,
    branch: row.source_branch_name ?? row.source_branch ?? "manual",
    commitSha: row.source_commit_sha ?? "prebuilt",
    commitMessage: row.source_commit_message ?? "Prebuilt artifact uploaded through SiteFlow CLI.",
    commitAuthor: row.source_commit_author ?? "SiteFlow CLI",
    receivedAt: (row.source_received_at ?? row.deployment_created_at).toISOString(),
    actor: row.source_actor ?? {
      id: "siteflow:cli",
      name: "SiteFlow CLI",
      role: "developer"
    }
  };
}

function buildJobFromInspectRow(
  row: DeploymentInspectRow,
  sourceEvent: SourceEvent,
  project: Project
): BuildJob {
  const buildSettings = project.buildSettings ?? defaultBuildSettings(project.framework);
  const fallbackStatus: BuildJob["status"] = row.deployment_status === "failed" ? "failed" : "succeeded";
  const status = row.build_status ?? fallbackStatus;
  const finishedAt = row.finished_at ?? (isFinishedBuildStatus(status)
    ? row.deployment_created_at
    : null);

  return {
    id: row.build_job_id ?? `build_${row.id}`,
    projectId: row.project_id,
    sourceEventId: sourceEvent.id,
    status,
    framework: row.build_framework ?? buildSettings.framework ?? project.framework,
    installCommand: row.install_command ?? "prebuilt artifact",
    buildCommand: row.build_command ?? "upload artifact",
    outputDirectory: row.output_directory ?? buildSettings.outputDirectory ?? ".",
    queuedAt: (row.queued_at ?? row.deployment_created_at).toISOString(),
    startedAt: (row.started_at ?? row.queued_at ?? row.deployment_created_at).toISOString(),
    finishedAt: finishedAt?.toISOString(),
    workerId: row.worker_id ?? (row.build_job_id ? undefined : "siteflow-prebuilt"),
    events: []
  };
}

function deploymentFromInspectRow(row: DeploymentInspectRow, sourceEvent: SourceEvent, buildJob: BuildJob): Deployment {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceEventId: sourceEvent.id,
    buildJobId: buildJob.id,
    artifactId: `artifact_${row.id}`,
    status: row.deployment_status,
    version: deploymentVersion(row.deployment_created_at),
    environment: row.route_channel ?? "preview",
    createdAt: row.deployment_created_at.toISOString(),
    readyAt: row.deployment_status === "ready" ? row.deployment_created_at.toISOString() : undefined,
    failedReason: row.deployment_status === "failed" ? "Deployment failed before artifact routing." : undefined
  };
}

function artifactFromInspectRow(row: DeploymentInspectRow, buildJob: BuildJob): Artifact {
  const manifest = artifactManifestFromRow(
    {
      checksum: row.checksum,
      file_count: row.file_count,
      total_bytes: row.total_bytes,
      artifact_manifest: row.artifact_manifest
    },
    row.deployment_created_at
  );
  const verificationStatus = verificationStatusForDeployment(row.deployment_status);

  return {
    id: `artifact_${row.id}`,
    projectId: row.project_id,
    buildJobId: buildJob.id,
    storageUri: `file://${row.artifact_root}`,
    manifest,
    storageStatus: verificationStatus === "verified" ? "retained" : verificationStatus === "failed" ? "delete_pending" : "pending_upload",
    verificationStatus,
    retainedUntil: retainedUntil(row.deployment_created_at),
    immutable: true,
    createdAt: row.deployment_created_at.toISOString(),
    verifiedAt: verificationStatus === "verified" ? row.deployment_created_at.toISOString() : undefined
  };
}

function routeRevisionFromInspectRow(row: DeploymentInspectRow): RouteRevision | undefined {
  if (!row.route_revision_id || !row.route_channel || !row.route_status || !row.route_generated_config || !row.route_validation_summary || !row.route_created_at) {
    return undefined;
  }

  return {
    id: row.route_revision_id,
    projectId: row.project_id,
    channel: row.route_channel,
    deploymentId: row.id,
    previousDeploymentId: row.route_previous_deployment_id ?? undefined,
    status: row.route_status,
    generatedConfig: row.route_generated_config,
    validationSummary: row.route_validation_summary,
    releaseEvidence: row.route_release_evidence ?? undefined,
    createdAt: row.route_created_at.toISOString(),
    appliedAt: row.route_applied_at?.toISOString(),
    failedReason: row.route_failed_reason ?? undefined
  };
}

function detailEvidence(
  sourceEvent: SourceEvent,
  buildJob: BuildJob,
  artifact: Artifact,
  deployment: Deployment,
  routeRevision?: RouteRevision
): EvidenceItemReadModel[] {
  return [
    {
      id: "evidence-source",
      label: "Source event accepted",
      status: sourceEvent.status === "accepted" ? "pass" : sourceEvent.status === "rejected" ? "fail" : "warning",
      summary: sourceEvent.disposition,
      evidence: `${sourceEvent.branch}@${sourceEvent.commitSha}`
    },
    {
      id: "evidence-build",
      label: "Build job",
      status: evidenceStatusForBuild(buildJob.status),
      summary: buildJob.status,
      evidence: buildJob.id
    },
    {
      id: "evidence-artifact",
      label: "Artifact verification",
      status: artifact.verificationStatus === "verified" ? "pass" : artifact.verificationStatus === "failed" ? "fail" : "pending",
      summary: artifact.verificationStatus,
      evidence: artifact.manifest.checksum
    },
    {
      id: "evidence-deployment",
      label: "Deployment state",
      status: deployment.status === "ready" ? "pass" : deployment.status === "failed" || deployment.status === "canceled" ? "fail" : "pending",
      summary: deployment.status,
      evidence: deployment.id
    },
    {
      id: "evidence-route",
      label: "Route revision",
      status: evidenceStatusForRoute(routeRevision?.status),
      summary: routeRevision?.validationSummary ?? "No release channel route has been applied yet.",
      evidence: routeRevision?.id
    }
  ];
}

function routeEvidenceForDetail(routeRevision: RouteRevision | undefined, deployment: Deployment): RouteRevisionEvidenceReadModel | undefined {
  if (!routeRevision) {
    return undefined;
  }

  return {
    routeRevision,
    checks: [
      {
        id: "check-route-target-deployment",
        label: "Route target deployment",
        status: routeRevision.deploymentId === deployment.id ? "pass" : "fail",
        summary: routeRevision.deploymentId === deployment.id
          ? `Route revision targets ${deployment.id}.`
          : "Route revision target does not match this deployment."
      },
      {
        id: "check-route-state",
        label: "Route state",
        status: routeRevision.status === "failed" ? "fail" : routeRevision.status === "applied" ? "pass" : "warning",
        summary: routeRevision.validationSummary
      }
    ],
    previousKnownGoodDeploymentId: routeRevision.previousDeploymentId
  };
}

function routeEvidenceForSummary(
  routeRevision: RouteRevision,
  deployment: DeploymentSummaryReadModel | undefined
): RouteRevisionEvidenceReadModel {
  return {
    routeRevision,
    checks: [
      {
        id: "check-route-target-deployment",
        label: "Route target deployment",
        status: deployment && routeRevision.deploymentId === deployment.id ? "pass" : "fail",
        summary: deployment
          ? routeRevision.deploymentId === deployment.id
            ? `Route revision targets ${deployment.id}.`
            : "Route revision target does not match this deployment."
          : "Route revision target deployment could not be loaded."
      },
      {
        id: "check-route-state",
        label: "Route state",
        status: routeRevision.status === "failed" ? "fail" : routeRevision.status === "applied" ? "pass" : "warning",
        summary: routeRevision.validationSummary
      }
    ],
    previousKnownGoodDeploymentId: routeRevision.previousDeploymentId
  };
}

function emptyLogChunk(deploymentId: SiteFlowId, buildJobId: SiteFlowId, cursor?: string): LogChunkReadModel {
  return {
    deploymentId,
    chunk: {
      deploymentId,
      buildJobId,
      cursor: cursor ?? "0",
      lines: [],
      complete: true,
      fetchedAt: new Date().toISOString()
    },
    hasMore: false
  };
}

function releaseVerb(action: ReleaseAction) {
  return action === "promote" ? "Promotion" : "Rollback";
}

function releaseEventStatus(routeRevision: RouteRevision): ChannelEvent["status"] {
  return routeRevision.status === "applied" ? "succeeded" : routeRevision.status === "failed" ? "failed" : "pending";
}

function repositoryBindingName(value: RepositoryBinding | Record<string, never> | null | undefined) {
  if (!value || !isRecord(value)) {
    return undefined;
  }

  const binding = value as Record<string, unknown>;
  const owner = typeof binding.owner === "string" ? binding.owner.trim() : "";
  const name = typeof binding.name === "string" ? binding.name.trim() : "";

  return owner && name ? `${owner}/${name}` : undefined;
}

function deploymentRepositoryName(deployment: DeploymentRouteRow | undefined) {
  return deployment?.source_repository?.trim() || repositoryBindingName(deployment?.project_repository);
}

function releaseEvidenceMetadataFromArtifactManifest(
  manifest: Partial<ArtifactManifest> | Record<string, never> | null | undefined
): ReleaseEvidenceMetadata | undefined {
  const metadata = isRecord(manifest) && isRecord(manifest.metadata) ? manifest.metadata : undefined;
  const releaseEvidence = metadata && isRecord(metadata.releaseEvidence) ? metadata.releaseEvidence : undefined;
  const evidencePath = typeof releaseEvidence?.evidencePath === "string" ? releaseEvidence.evidencePath : undefined;
  const checkedAt = typeof releaseEvidence?.checkedAt === "string" ? releaseEvidence.checkedAt : undefined;
  const commitRef = typeof releaseEvidence?.commitRef === "string" ? releaseEvidence.commitRef : undefined;
  const repository = typeof releaseEvidence?.repository === "string" ? releaseEvidence.repository : undefined;
  const branch = typeof releaseEvidence?.branch === "string" ? releaseEvidence.branch : undefined;
  const targetEnvironment = typeof releaseEvidence?.targetEnvironment === "string" ? releaseEvidence.targetEnvironment : undefined;
  const payloadDigest = typeof releaseEvidence?.payloadDigest === "string" ? releaseEvidence.payloadDigest : undefined;

  if (
    releaseEvidence?.status !== "passed" ||
    !evidencePath ||
    !checkedAt ||
    !commitRef ||
    !repository ||
    !branch ||
    !targetEnvironment
  ) {
    return undefined;
  }

  return {
    evidencePath,
    checkedAt,
    status: "passed",
    commitRef,
    repository,
    branch,
    targetEnvironment,
    ...(payloadDigest ? { payloadDigest } : {}),
    ...(typeof releaseEvidence.releaseTicket === "string" ? { releaseTicket: releaseEvidence.releaseTicket } : {}),
    ...(typeof releaseEvidence.operatorName === "string" ? { operatorName: releaseEvidence.operatorName } : {})
  };
}

function releaseEvidenceCoreIdentity(evidence: ReleaseEvidenceMetadata) {
  return `${evidence.repository}@${evidence.branch}@${evidence.commitRef}#${evidence.targetEnvironment}`;
}

function releaseEvidenceAuditMetadata(evidence: ReleaseEvidenceMetadata | undefined) {
  if (!evidence) {
    return null;
  }

  return {
    evidencePath: evidence.evidencePath,
    checkedAt: evidence.checkedAt,
    ...(evidence.payloadDigest ? { payloadDigest: evidence.payloadDigest } : {}),
    status: evidence.status,
    commitRef: evidence.commitRef,
    repository: evidence.repository,
    branch: evidence.branch,
    targetEnvironment: evidence.targetEnvironment,
    identity: releaseEvidenceCoreIdentity(evidence)
  };
}

function releaseEvidenceCoreIdentityMatches(left: ReleaseEvidenceMetadata, right: ReleaseEvidenceMetadata) {
  return left.status === "passed" &&
    right.status === "passed" &&
    left.repository === right.repository &&
    left.branch === right.branch &&
    left.commitRef === right.commitRef &&
    left.targetEnvironment === right.targetEnvironment;
}

function releaseEvidenceIdentityCheck(
  deployment: DeploymentRouteRow | undefined,
  evidence: ReleaseEvidenceMetadata | undefined,
  channel: ReleaseChannelName
): SafetyCheck[] {
  if (channel !== "production") {
    return [];
  }

  if (!evidence) {
    return [
      {
        id: "check-release-evidence-target-identity",
        label: "Release evidence target identity",
        status: "fail",
        summary: "Production release requires release evidence metadata bound to the target deployment."
      }
    ];
  }

  const evidenceProductionTarget = evidence.status === "passed" && evidence.targetEnvironment === "production";
  const evidenceCoreIdentity = releaseEvidenceCoreIdentity(evidence);
  const checks: SafetyCheck[] = [
    {
      id: "check-release-evidence-production-target",
      label: "Release evidence production target",
      status: evidenceProductionTarget ? "pass" : "fail",
      summary: evidenceProductionTarget
        ? `Release evidence is passed for production: ${evidenceCoreIdentity}.`
        : `Production release evidence must be passed for production, found status=${String(evidence.status)} targetEnvironment=${evidence.targetEnvironment}.`,
      evidence: evidenceCoreIdentity
    }
  ];

  if (!deployment) {
    return checks;
  }

  const repository = deploymentRepositoryName(deployment);
  const deploymentIdentity = [
    repository ?? "unknown-repository",
    deployment.source_branch ?? "unknown-branch",
    deployment.source_commit_sha ?? "unknown-commit"
  ].join("@");
  const evidenceIdentity = `${evidence.repository}@${evidence.branch}@${evidence.commitRef}`;
  const matches = repository === evidence.repository
    && deployment.source_branch === evidence.branch
    && deployment.source_commit_sha === evidence.commitRef;

  checks.push({
    id: "check-release-evidence-target-identity",
    label: "Release evidence target identity",
    status: matches ? "pass" : "fail",
    summary: matches
      ? `Release evidence matches ${evidence.repository} ${evidence.branch}@${evidence.commitRef}.`
      : `Release evidence targets ${evidenceIdentity}, but deployment source is ${deploymentIdentity}.`,
    evidence: evidenceIdentity
  });

  if (deployment.source_type !== "prebuilt") {
    return checks;
  }

  const manifestEvidence = releaseEvidenceMetadataFromArtifactManifest(deployment.artifact_manifest);

  if (!manifestEvidence) {
    return [
      ...checks,
      {
        id: "check-release-evidence-prebuilt-origin",
        label: "Prebuilt artifact release evidence",
        status: "fail",
        summary: "Production prebuilt target must include checked release evidence metadata in its artifact manifest."
      }
    ];
  }

  const manifestMatches = releaseEvidenceCoreIdentityMatches(manifestEvidence, evidence);

  return [
    ...checks,
    {
      id: "check-release-evidence-prebuilt-origin",
      label: "Prebuilt artifact release evidence",
      status: manifestMatches ? "pass" : "fail",
      summary: manifestMatches
        ? `Prebuilt artifact manifest release evidence matches ${releaseEvidenceCoreIdentity(evidence)}.`
        : `Prebuilt artifact manifest release evidence targets ${releaseEvidenceCoreIdentity(manifestEvidence)}, but release evidence targets ${releaseEvidenceCoreIdentity(evidence)}.`,
      evidence: releaseEvidenceCoreIdentity(manifestEvidence)
    }
  ];
}

function releaseEvidenceMetadataForStorage(
  evidence: PromoteDeploymentCommand["releaseEvidence"] | RollingCommand["releaseEvidence"] | PrebuiltDeployCommand["releaseEvidence"] | undefined
): ReleaseEvidenceMetadata | undefined {
  if (!evidence) {
    return undefined;
  }

  if ("bundle" in evidence) {
    throw new Error("Repository received unnormalized release evidence bundle request.");
  }

  return evidence;
}

function normalizePrebuiltSourceForReleaseEvidence(
  source: PrebuiltDeployCommand["source"] | undefined,
  releaseEvidence: ReleaseEvidenceMetadata | undefined
): PrebuiltDeployCommand["source"] | undefined {
  if (!releaseEvidence) {
    if (source) {
      throw new Error("Prebuilt deploy source requires checked release evidence metadata.");
    }

    return source;
  }

  const mismatches = [
    source?.repository && source.repository !== releaseEvidence.repository ? "repository" : undefined,
    source?.branch && source.branch !== releaseEvidence.branch ? "branch" : undefined,
    source?.commitSha && source.commitSha !== releaseEvidence.commitRef ? "commitSha" : undefined
  ].filter((entry): entry is string => Boolean(entry));

  if (mismatches.length > 0) {
    throw new Error(`Prebuilt deploy source must match release evidence metadata: ${mismatches.join(", ")}.`);
  }

  return {
    ...source,
    repository: releaseEvidence.repository,
    branch: releaseEvidence.branch,
    commitSha: releaseEvidence.commitRef
  };
}

function productionRollingAbortReleaseEvidenceExceptionCheck(
  action: RollingAction,
  command: AdvanceRollingReleaseCommand | CompleteRollingReleaseCommand | AbortRollingReleaseCommand
): SafetyCheck[] {
  if (action !== "abort" || command.channel !== "production") {
    return [];
  }

  const reason = command.reason.trim();
  const releaseEvidenceException = "releaseEvidenceException" in command
    ? command.releaseEvidenceException
    : undefined;
  const matches = releaseEvidenceException?.type === "production_rolling_abort_stop_rollout" &&
    releaseEvidenceException.targetEnvironment === "production" &&
    releaseEvidenceException.acceptedWithoutReleaseEvidence === true &&
    releaseEvidenceException.reason.trim() === reason;
  const releaseEvidenceOmitted = command.releaseEvidence === undefined;

  return [
    {
      id: "check-release-evidence-exception",
      label: "Release evidence exception",
      status: matches ? "pass" : "fail",
      summary: matches
        ? "Production rolling abort records a stop-rollout release evidence exception."
        : "Production rolling abort must record a stop-rollout release evidence exception with acceptedWithoutReleaseEvidence=true and matching reason."
    },
    {
      id: "check-release-evidence-omitted",
      label: "Release evidence omitted",
      status: releaseEvidenceOmitted ? "pass" : "fail",
      summary: releaseEvidenceOmitted
        ? "Production rolling abort omits release evidence and records only the stop-rollout exception."
        : "Production rolling abort must omit release evidence and record only the stop-rollout exception."
    }
  ];
}

function safetyChecksForRoute(
  projectId: SiteFlowId,
  deployment: DeploymentRouteRow | undefined,
  domains: DomainBinding[],
  channel: ReleaseChannelName
): SafetyCheck[] {
  const projectMatches = deployment?.project_id === projectId;

  return [
    {
      id: "check-target-deployment-ready",
      label: "Target deployment ready",
      status: deployment?.status === "ready" ? "pass" : "fail",
      summary: deployment
        ? `Deployment ${deployment.id} is ${deployment.status}.`
        : "Target deployment does not exist."
    },
    {
      id: "check-target-project-match",
      label: "Target belongs to project",
      status: projectMatches ? "pass" : "fail",
      summary: projectMatches
        ? `Deployment belongs to project ${projectId}.`
        : "Deployment ownership could not be verified."
    },
    {
      id: "check-verified-domain",
      label: "Verified channel domain",
      status: domains.length > 0 ? "pass" : "fail",
      summary: domains.length > 0
        ? `${domains.length} verified ${channel} domain${domains.length === 1 ? "" : "s"} ready for routing.`
        : `No verified ${channel} domains are configured.`
    }
  ];
}

function routeGeneratedConfig(projectId: SiteFlowId, channel: ReleaseChannelName, deployment: DeploymentRouteRow, domains: DomainBinding[]) {
  return [
    `project=${projectId}`,
    `channel=${channel}`,
    `deployment=${deployment.id}`,
    `artifact_root=${deployment.artifact_root}`,
    `entrypoint=${deployment.entrypoint}`,
    ...domains.map((domain) => `host=${domain.hostname}`)
  ].join("\n");
}

function channelEventForRoute(
  action: ReleaseAction,
  command: PromoteDeploymentCommand | RollbackDeploymentCommand,
  routeRevision: RouteRevision,
  safetyChecks: SafetyCheck[]
): ChannelEvent {
  return {
    id: stableId("event", `${command.idempotencyKey}:${action}`),
    projectId: command.projectId,
    channel: command.channel,
    action,
    status: releaseEventStatus(routeRevision),
    previousDeploymentId: routeRevision.previousDeploymentId,
    nextDeploymentId: routeRevision.deploymentId,
    routeRevisionId: routeRevision.id,
    actor: command.actor,
    reason: command.reason.trim(),
    idempotencyKey: command.idempotencyKey,
    createdAt: routeRevision.createdAt,
    completedAt: routeRevision.appliedAt,
    safetyChecks
  };
}

export class PostgresSiteFlowReadRepository implements SiteFlowReadRepository {
  private readonly artifactRoot: string;
  private readonly publicScheme: "http" | "https";
  private readonly baseDomain?: string;
  private readonly operatorSessionIdleTimeoutSeconds: number;
  private readonly prebuiltUploadBudget: Required<PrebuiltUploadBudget>;

  constructor(
    private readonly pool: Pool,
    options: PostgresSiteFlowReadRepositoryOptions
  ) {
    this.artifactRoot = options.artifactRoot;
    this.publicScheme = options.publicScheme ?? "https";
    this.baseDomain = options.baseDomain;
    this.operatorSessionIdleTimeoutSeconds = normalizeOperatorSessionIdleTimeoutSeconds(options.operatorSessionIdleTimeoutSeconds);
    this.prebuiltUploadBudget = {
      maxUploadBytes: positiveIntegerOption(options.prebuiltMaxUploadBytes, defaultPrebuiltMaxUploadBytes),
      maxFiles: positiveIntegerOption(options.prebuiltMaxFiles, defaultPrebuiltMaxUploadFiles)
    };
  }

  async resolveTokenPrincipal(token: string, projectId?: SiteFlowId): Promise<SiteFlowAuthPrincipal | undefined> {
    const tokenHash = apiTokenHash(token.trim());
    const result = await this.pool.query<ApiTokenRow>(
      `
        UPDATE siteflow_api_tokens
        SET last_used_at = now()
        WHERE token_hash = $1
          AND status = 'active'
          AND (project_id IS NULL OR project_id = $2)
        RETURNING id, project_id, name, token_prefix, scopes, status, created_by,
                  created_at, updated_at, revoked_at, last_used_at
      `,
      [tokenHash, projectId ?? null]
    );
    const row = result.rows[0];

    if (!row) {
      return undefined;
    }

    const resolvedToken = apiTokenFromRow(row);

    return {
      kind: "api_token",
      scopes: resolvedToken.scopes,
      token: resolvedToken,
      actor: resolvedToken.createdBy ?? fallbackTokenActor(resolvedToken)
    };
  }

  async resolveTokenPermissions(token: string, projectId?: SiteFlowId): Promise<PermissionScope[] | undefined> {
    const principal = await this.resolveTokenPrincipal(token, projectId);

    return principal?.scopes;
  }

  async authorizeToken(token: string, permission: PermissionScope, projectId?: SiteFlowId): Promise<boolean> {
    const scopes = await this.resolveTokenPermissions(token, projectId);

    return scopes ? hasPermission(scopes, permission) : false;
  }

  async resolveSessionPrincipal(token: string, projectId?: SiteFlowId): Promise<SiteFlowAuthPrincipal | undefined> {
    const sessionHash = operatorSessionHash(token.trim());
    const result = await this.pool.query<OperatorSessionRow>(
      `
        UPDATE siteflow_operator_sessions
        SET last_used_at = now()
        WHERE token_hash = $1
          AND status = 'active'
          AND expires_at > now()
          AND COALESCE(last_used_at, created_at) > now() - ($2::integer * interval '1 second')
          AND created_at > COALESCE((
            SELECT max(created_at)
            FROM siteflow_operator_session_cutoffs
            WHERE project_id IS NULL
          ), '-infinity'::timestamptz)
          AND (
            $3::text IS NULL
            OR project_ids IS NULL
            OR NOT (project_ids @> ARRAY[$3::text]::text[])
            OR created_at > COALESCE((
              SELECT max(created_at)
              FROM siteflow_operator_session_cutoffs
              WHERE project_id = $3::text
            ), '-infinity'::timestamptz)
          )
        RETURNING id, subject, actor, token_prefix, scopes, project_ids, status,
                  created_at, expires_at, revoked_at, last_used_at
      `,
      [sessionHash, this.operatorSessionIdleTimeoutSeconds, projectId ?? null]
    );
    const row = result.rows[0];

    if (!row) {
      return undefined;
    }

    const session = operatorSessionFromRow(row);
    const inProjectScope = !session.projectIds || (projectId !== undefined && session.projectIds.includes(projectId));
    const scopes = inProjectScope ? session.scopes : [];

    return {
      kind: "operator_session",
      scopes,
      session,
      actor: session.actor ?? fallbackSessionActor(session)
    };
  }

  async resolveSessionPermissions(token: string, projectId?: SiteFlowId): Promise<PermissionScope[] | undefined> {
    const principal = await this.resolveSessionPrincipal(token, projectId);

    return principal?.scopes;
  }

  async createOperatorSession(command: CreateOperatorSessionCommand): Promise<OperatorSessionCreateResult> {
    const subject = normalizeOperatorSessionSubject(command.subject);
    const scopes = normalizePermissionScopes(command.scopes);
    const projectIds = normalizeOperatorSessionProjectIds(command.projectIds);
    const ttlSeconds = normalizeOperatorSessionTtlSeconds(command.ttlSeconds);
    const secret = operatorSessionSecret();
    const sessionId = stableId("session", `${subject}:${randomUUID()}`);
    const result = await this.pool.query<OperatorSessionRow>(
      `
        INSERT INTO siteflow_operator_sessions (
          id,
          subject,
          actor,
          token_hash,
          token_prefix,
          scopes,
          project_ids,
          expires_at
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::text[], now() + ($8::integer * interval '1 second'))
        RETURNING id, subject, actor, token_prefix, scopes, project_ids, status,
                  created_at, expires_at, revoked_at, last_used_at
      `,
      [
        sessionId,
        subject,
        command.actor ? JSON.stringify(command.actor) : null,
        operatorSessionHash(secret),
        secret.slice(0, 12),
        scopes,
        projectIds ?? null,
        ttlSeconds
      ]
    );
    const session = operatorSessionFromRow(result.rows[0]);

    return {
      status: "created",
      session,
      secret,
      message: "Operator session created."
    };
  }

  async rotateOperatorSession(token: string): Promise<OperatorSessionRotateResult | undefined> {
    const client = await this.pool.connect();
    const oldSessionHash = operatorSessionHash(token.trim());
    const secret = operatorSessionSecret();
    const sessionId = stableId("session", `rotate:${randomUUID()}`);

    try {
      await client.query("BEGIN");
      const currentResult = await client.query<OperatorSessionRow>(
        `
          SELECT id, subject, actor, token_prefix, scopes, project_ids, status,
                 created_at, expires_at, revoked_at, last_used_at
          FROM siteflow_operator_sessions s
          WHERE token_hash = $1
            AND status = 'active'
            AND expires_at > now()
            AND COALESCE(last_used_at, created_at) > now() - ($2::integer * interval '1 second')
            AND created_at > COALESCE((
              SELECT max(created_at)
              FROM siteflow_operator_session_cutoffs
              WHERE project_id IS NULL
            ), '-infinity'::timestamptz)
            AND (
              project_ids IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM siteflow_operator_session_cutoffs cutoff
                WHERE cutoff.project_id IS NOT NULL
                  AND project_ids @> ARRAY[cutoff.project_id]::text[]
                  AND cutoff.created_at >= s.created_at
              )
            )
          FOR UPDATE
        `,
        [oldSessionHash, this.operatorSessionIdleTimeoutSeconds]
      );
      const current = currentResult.rows[0];

      if (!current) {
        await client.query("ROLLBACK");
        return undefined;
      }

      await client.query(
        `
          UPDATE siteflow_operator_sessions
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, now())
          WHERE id = $1
        `,
        [current.id]
      );

      const rotatedResult = await client.query<OperatorSessionRotateRow>(
        `
          INSERT INTO siteflow_operator_sessions (
            id,
            subject,
            actor,
            token_hash,
            token_prefix,
            scopes,
            project_ids,
            expires_at
          )
          VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::text[], $8)
          RETURNING id, subject, actor, token_prefix, scopes, project_ids, status,
                    created_at, expires_at, revoked_at, last_used_at,
                    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::integer AS max_age_seconds
        `,
        [
          sessionId,
          current.subject,
          current.actor ? JSON.stringify(current.actor) : null,
          operatorSessionHash(secret),
          secret.slice(0, 12),
          current.scopes,
          current.project_ids ?? null,
          current.expires_at
        ]
      );
      const rotated = rotatedResult.rows[0];

      await client.query("COMMIT");

      return {
        status: "rotated",
        session: operatorSessionFromRow(rotated),
        secret,
        maxAgeSeconds: rotated.max_age_seconds,
        message: "Operator session rotated."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeOperatorSession(token: string): Promise<OperatorSessionRevokeReadModel> {
    const sessionHash = operatorSessionHash(token.trim());
    const result = await this.pool.query<OperatorSessionRow>(
      `
        UPDATE siteflow_operator_sessions
        SET status = 'revoked',
            revoked_at = COALESCE(revoked_at, now())
        WHERE token_hash = $1
        RETURNING id, subject, actor, token_prefix, scopes, project_ids, status,
                  created_at, expires_at, revoked_at, last_used_at
      `,
      [sessionHash]
    );
    const row = result.rows[0];

    if (!row) {
      return {
        status: "not_found",
        message: "Operator session was not found."
      };
    }

    return {
      status: "revoked",
      session: operatorSessionFromRow(row),
      message: "Operator session revoked."
    };
  }

  async revokeAllOperatorSessions(command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel> {
    const client = await this.pool.connect();
    const projectId = command.projectId?.trim() || undefined;
    const cutoffId = stableId("sessioncutoff", `${projectId ?? "global"}:${randomUUID()}`);
    const reason = command.reason?.trim() || undefined;

    try {
      await client.query("BEGIN");
      const revokeSql = projectId
        ? `
          UPDATE siteflow_operator_sessions
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, now())
          WHERE status = 'active'
            AND created_at <= now()
            AND project_ids @> ARRAY[$1]::text[]
          RETURNING id
        `
        : `
          UPDATE siteflow_operator_sessions
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, now())
          WHERE status = 'active'
            AND created_at <= now()
          RETURNING id
        `;
      const revokedResult = await client.query<{ id: string }>(
        revokeSql,
        projectId ? [projectId] : []
      );
      const cutoffResult = await client.query<{ created_at: Date }>(
        `
          INSERT INTO siteflow_operator_session_cutoffs (
            id,
            project_id,
            actor,
            reason,
            revoked_count
          )
          VALUES ($1, $2, $3::jsonb, $4, $5)
          RETURNING created_at
        `,
        [
          cutoffId,
          projectId ?? null,
          JSON.stringify(command.actor),
          reason ?? null,
          revokedResult.rows.length
        ]
      );
      const revokedAt = cutoffResult.rows[0]?.created_at ?? new Date();

      await client.query("COMMIT");

      return {
        status: "revoked",
        scope: projectId ? "project" : "global",
        projectId,
        cutoffId,
        revokedAt: revokedAt.toISOString(),
        revokedCount: revokedResult.rows.length,
        message: projectId
          ? "Project operator sessions were revoked."
          : "All existing operator sessions were revoked."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listProjects(): Promise<ProjectListReadModel> {
    const cached = await this.tryReadModel<ProjectListReadModel>("project-list", "default");

    if (cached) {
      return cached;
    }

    return this.buildProjectList();
  }

  async getProject(projectId: SiteFlowId): Promise<ProjectDetailReadModel> {
    const cached = await this.tryReadModel<ProjectDetailReadModel>("project-detail", projectId);

    if (cached) {
      return cached;
    }

    return this.buildProjectDetail(projectId);
  }

  async getProjectSettings(projectId: SiteFlowId): Promise<ProjectSettingsReadModel> {
    const project = await this.readProject(projectId);
    const previewProtection = await this.pool.query<{ enabled: boolean }>(
      `
        SELECT preview_password_hash IS NOT NULL AS enabled
        FROM siteflow_projects
        WHERE id = $1
      `,
      [project.id]
    );

    const settings: ProjectSettingsReadModel & { previewProtectionEnabled: boolean } = {
      project,
      environments: await this.listProjectEnvironments(project.id),
      environmentVariables: await this.listEnvironmentVariables(project.id),
      teamMembers: await this.listTeamMembers(project.id),
      apiTokens: await this.listApiTokens(project.id),
      auditEvents: await this.listAuditEvents(project.id),
      currentPermissions: ["read", "write", "admin"],
      previewProtectionEnabled: previewProtection.rows[0]?.enabled ?? false
    };

    return settings;
  }

  async createProject(command: CreateProjectCommand): Promise<ProjectMutationReadModel> {
    const slug = normalizeSlug(command.slug);
    const name = normalizeName(command.name);
    const defaultBranch = normalizeBranch(command.defaultBranch);
    const productionBranch = normalizeBranch(command.productionBranch, defaultBranch);
    const framework = command.framework?.trim() || command.buildSettings?.framework?.trim() || "static";
    const repository = command.repository ?? defaultRepository(slug, defaultBranch);
    const buildSettings = defaultBuildSettings(framework, command.buildSettings);
    const projectId = projectIdForSlug(slug);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO siteflow_projects (
            id,
            slug,
            name,
            status,
            framework,
            default_branch,
            production_branch,
            repository,
            build_settings
          )
          VALUES ($1, $2, $3, 'active', $4, $5, $6, $7::jsonb, $8::jsonb)
          ON CONFLICT (id) DO UPDATE
          SET slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              status = 'active',
              framework = EXCLUDED.framework,
              default_branch = EXCLUDED.default_branch,
              production_branch = EXCLUDED.production_branch,
              repository = EXCLUDED.repository,
              build_settings = EXCLUDED.build_settings,
              updated_at = now()
        `,
        [
          projectId,
          slug,
          name,
          framework,
          defaultBranch,
          productionBranch,
          JSON.stringify(repository),
          JSON.stringify(buildSettings)
        ]
      );

      await this.ensureDefaultEnvironments(client, projectId, productionBranch);
      if (command.domains) {
        await this.replaceProjectDomains(client, projectId, command.domains);
      }
      await insertAuditEvent(client, {
        projectId,
        action: "project.created",
        actor: command.actor,
        targetType: "project",
        targetId: projectId,
        summary: `Project ${name} created.`
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "created",
      project: await this.readProject(projectId),
      message: "Project created."
    };
  }

  async updateProject(projectId: SiteFlowId, command: UpdateProjectCommand): Promise<ProjectMutationReadModel> {
    const current = await this.readProject(projectId);
    const slug = command.slug ? normalizeSlug(command.slug) : current.slug;
    const name = command.name ? normalizeName(command.name) : current.name;
    const defaultBranch = normalizeBranch(command.defaultBranch, current.defaultBranch);
    const productionBranch = normalizeBranch(command.productionBranch, current.productionBranch ?? defaultBranch);
    const framework = command.framework?.trim() || current.framework;
    const repository = command.repository ?? current.repository;
    const buildSettings = {
      ...current.buildSettings,
      ...command.buildSettings
    };
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE siteflow_projects
          SET slug = $2,
              name = $3,
              framework = $4,
              default_branch = $5,
              production_branch = $6,
              repository = $7::jsonb,
              build_settings = $8::jsonb,
              updated_at = now()
          WHERE id = $1
        `,
        [
          projectId,
          slug,
          name,
          framework,
          defaultBranch,
          productionBranch,
          JSON.stringify(repository),
          JSON.stringify(buildSettings)
        ]
      );

      if (command.domains) {
        await this.replaceProjectDomains(client, projectId, command.domains);
      }

      await insertAuditEvent(client, {
        projectId,
        action: "project.updated",
        actor: command.actor,
        targetType: "project",
        targetId: projectId,
        summary: `Project ${name} settings updated.`
      });

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "updated",
      project: await this.readProject(projectId),
      message: "Project updated."
    };
  }

  async addProjectDomain(projectId: SiteFlowId, command: AddProjectDomainCommand): Promise<ProjectMutationReadModel> {
    const project = await this.readProject(projectId);
    const hostname = normalizeProjectDomainHostname(command.hostname);
    const vanityLabel = vanityBaseSubdomainLabel(hostname, this.baseDomain);
    const vanity = vanityLabel !== undefined;
    const verified = vanity ? true : projectDomainAutoVerifyEnabled();
    const canonicalHost = canonicalProjectHost(project, this.baseDomain);

    assertProjectDomainHostAllowed(hostname, project, this.baseDomain);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      if (vanity && vanityLabel !== project.slug) {
        const slugConflict = await client.query(
          `
            SELECT 1
            FROM siteflow_projects
            WHERE slug = $1
            LIMIT 1
          `,
          [vanityLabel]
        );

        if (slugConflict.rows.length > 0) {
          throw new SiteFlowInputError(`Vanity subdomain ${hostname} conflicts with the canonical host for project slug ${vanityLabel}.`);
        }
      }

      await client.query(
        `
          INSERT INTO siteflow_project_domains (
            project_id,
            hostname,
            channel,
            verified,
            last_checked_at
          )
          VALUES ($1, $2, 'production', $3, now())
        `,
        [projectId, hostname, verified]
      );

      if (verified && canonicalHost) {
        const currentRoute = await client.query<{ deployment_id: string; artifact_root: string; entrypoint: string }>(
          `
            SELECT deployment_id, artifact_root, entrypoint
            FROM siteflow_artifact_routes
            WHERE host = $1
          `,
          [canonicalHost]
        );
        const route = currentRoute.rows[0];

        if (route) {
          await client.query(
            `
              INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (host) DO UPDATE
              SET deployment_id = EXCLUDED.deployment_id,
                  artifact_root = EXCLUDED.artifact_root,
                  entrypoint = EXCLUDED.entrypoint
            `,
            [hostname, route.deployment_id, route.artifact_root, route.entrypoint]
          );
        }
      }

      await insertAuditEvent(client, {
        projectId,
        action: "project.updated",
        actor: command.actor,
        targetType: "project",
        targetId: hostname,
        summary: `Project domain ${hostname} added.`
      });

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");

      if (isUniqueViolation(error)) {
        throw new SiteFlowConflictError(`Domain hostname is already bound: ${hostname}.`);
      }

      throw error;
    } finally {
      client.release();
    }

    return {
      status: "updated",
      project: await this.readProject(projectId),
      message: "Project domain added."
    };
  }

  async removeProjectDomain(projectId: SiteFlowId, hostname: string, actor: Actor): Promise<ProjectMutationReadModel> {
    await this.readProject(projectId);
    const normalizedHostname = normalizeProjectDomainHostname(hostname);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const domainDelete = await client.query(
        `
          DELETE FROM siteflow_project_domains
          WHERE project_id = $1
            AND hostname = $2
        `,
        [projectId, normalizedHostname]
      );
      // Only tear down the artifact route when the host WAS a registered custom domain of THIS
      // project (rowCount>0). Scope the delete to this project's own deployments as a second guard.
      // This prevents cross-tenant route deletion and protects the auto-managed canonical host
      // ({slug}.{baseDomain}) — which has no siteflow_project_domains row, so this is skipped for it.
      if ((domainDelete.rowCount ?? 0) > 0) {
        await client.query(
          `
            DELETE FROM siteflow_artifact_routes
            WHERE host = $1
              AND deployment_id IN (
                SELECT id FROM siteflow_deployments WHERE project_id = $2
              )
          `,
          [normalizedHostname, projectId]
        );
      }
      await insertAuditEvent(client, {
        projectId,
        action: "project.updated",
        actor,
        targetType: "project",
        targetId: normalizedHostname,
        summary: `Project domain ${normalizedHostname} removed.`
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "updated",
      project: await this.readProject(projectId),
      message: "Project domain removed."
    };
  }

  async setPreviewProtection(projectId: SiteFlowId, password: string, actor: Actor): Promise<ProjectMutationReadModel> {
    await this.readProject(projectId);

    if (!password.trim()) {
      throw new SiteFlowInputError("Preview protection password is required.");
    }

    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE siteflow_projects
          SET preview_password_hash = $2,
              preview_password_salt = $3,
              updated_at = now()
          WHERE id = $1
        `,
        [projectId, hash, salt]
      );
      await insertAuditEvent(client, {
        projectId,
        action: "project.updated",
        actor,
        targetType: "project",
        targetId: projectId,
        summary: "Project preview protection enabled."
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "updated",
      project: await this.readProject(projectId),
      message: "Preview protection enabled."
    };
  }

  async clearPreviewProtection(projectId: SiteFlowId, actor: Actor): Promise<ProjectMutationReadModel> {
    await this.readProject(projectId);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE siteflow_projects
          SET preview_password_hash = NULL,
              preview_password_salt = NULL,
              updated_at = now()
          WHERE id = $1
        `,
        [projectId]
      );
      await insertAuditEvent(client, {
        projectId,
        action: "project.updated",
        actor,
        targetType: "project",
        targetId: projectId,
        summary: "Project preview protection disabled."
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "updated",
      project: await this.readProject(projectId),
      message: "Preview protection disabled."
    };
  }

  async archiveProject(projectId: SiteFlowId): Promise<ProjectMutationReadModel> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE siteflow_projects
          SET status = 'archived',
              updated_at = now()
          WHERE id = $1
        `,
        [projectId]
      );
      await insertAuditEvent(client, {
        projectId,
        action: "project.archived",
        targetType: "project",
        targetId: projectId,
        summary: `Project ${projectId} archived.`
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "archived",
      project: await this.readProject(projectId),
      message: "Project archived."
    };
  }

  async getProjectEnvironmentSettings(projectId: SiteFlowId): Promise<ProjectEnvironmentSettingsReadModel> {
    await this.readProject(projectId);

    return {
      projectId,
      environments: await this.listProjectEnvironments(projectId),
      environmentVariables: await this.listEnvironmentVariables(projectId),
      updatedAt: new Date().toISOString()
    };
  }

  async upsertEnvironmentVariable(command: UpsertEnvironmentVariableCommand): Promise<ProjectEnvironmentVariableUpsertReadModel> {
    await this.readProject(command.projectId);

    const key = normalizeEnvironmentVariableKey(command.key);
    const targetEnvironment = normalizeEnvironmentName(command.targetEnvironment);
    const id = `env_${createHash("sha256")
      .update(`${command.projectId}:${targetEnvironment}:${command.scope}:${key}`)
      .digest("hex")
      .slice(0, 24)}`;
    const source = command.source ?? "sealed";
    const sealedValue = source === "sealed" && command.value !== undefined ? sealSecretValue(command.value) : null;
    const fingerprint = source === "external" && !command.value ? "external" : fingerprintSecret(command.value ?? "");

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO siteflow_environment_variables (
            id,
            project_id,
            key,
            target_environment,
            scope,
            source,
            sealed_value,
            fingerprint,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          ON CONFLICT (project_id, key, target_environment, scope) DO UPDATE
          SET source = EXCLUDED.source,
              sealed_value = EXCLUDED.sealed_value,
              fingerprint = EXCLUDED.fingerprint,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
        `,
        [
          id,
          command.projectId,
          key,
          targetEnvironment,
          command.scope,
          source,
          sealedValue,
          fingerprint,
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "environment_variable.upserted",
        actor: command.actor,
        targetType: "environment_variable",
        targetId: id,
        summary: `Environment variable ${key} updated for ${targetEnvironment}.`,
        metadata: {
          key,
          targetEnvironment,
          scope: command.scope,
          source
        }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const variable = (await this.listEnvironmentVariables(command.projectId)).find(
      (candidate) =>
        candidate.key === key &&
        candidate.targetEnvironment === targetEnvironment &&
        candidate.scope === command.scope
    );

    if (!variable) {
      throw new SiteFlowNotFoundError(`Unknown environment variable: ${key}`);
    }

    return {
      status: "upserted",
      variable,
      message: "Environment variable metadata saved."
    };
  }

  async upsertTeamMember(command: UpsertTeamMemberCommand): Promise<TeamMemberMutationReadModel> {
    await this.readProject(command.projectId);

    const role = command.role;
    const permissions = rolePermissions(role);
    const memberId = stableId("member", `${command.projectId}:${command.actor.id}`);
    const result = await this.pool.query<TeamMemberRow>(
      `
        WITH upserted AS (
          INSERT INTO siteflow_team_members (
            id,
            project_id,
            actor_id,
            actor,
            role,
            permissions
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6)
          ON CONFLICT (project_id, actor_id) DO UPDATE
          SET actor = EXCLUDED.actor,
              role = EXCLUDED.role,
              permissions = EXCLUDED.permissions,
              updated_at = now()
          RETURNING id, project_id, actor, role, permissions, created_at, updated_at
        ), audit AS (
          INSERT INTO siteflow_audit_events (
            id,
            project_id,
            action,
            actor,
            target_type,
            target_id,
            summary,
            metadata
          )
          SELECT $7, $2, 'team.member_updated', $8::jsonb, 'team_member', id,
                 'Team member ' || ($4::jsonb->>'name') || ' assigned ' || $5 || ' role.',
                 jsonb_build_object('role', $5, 'permissions', $6::text[])
          FROM upserted
        )
        SELECT id, project_id, actor, role, permissions, created_at, updated_at
        FROM upserted
      `,
      [
        memberId,
        command.projectId,
        command.actor.id,
        JSON.stringify(command.actor),
        role,
        permissions,
        stableId("audit", `${command.projectId}:team:${memberId}:${randomUUID()}`),
        JSON.stringify(command.requestedBy ?? command.actor)
      ]
    );

    return {
      status: "upserted",
      member: teamMemberFromRow(result.rows[0]),
      message: "Team member saved."
    };
  }

  async removeTeamMember(command: RemoveTeamMemberCommand): Promise<TeamMemberMutationReadModel> {
    await this.readProject(command.projectId);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<TeamMemberRow>(
        `
          DELETE FROM siteflow_team_members
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, actor, role, permissions, created_at, updated_at
        `,
        [command.projectId, command.memberId]
      );
      const row = result.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown team member: ${command.memberId}`);
      }

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "team.member_removed",
        actor: command.requestedBy,
        targetType: "team_member",
        targetId: command.memberId,
        summary: `Team member ${row.actor.name} removed.`,
        reason: command.reason,
        metadata: {
          role: row.role
        }
      });
      await client.query("COMMIT");

      return {
        status: "removed",
        member: teamMemberFromRow(row),
        message: "Team member removed."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createApiToken(command: CreateApiTokenCommand): Promise<ApiTokenCreateReadModel> {
    if (command.projectId) {
      await this.readProject(command.projectId);
    }

    const name = normalizeName(command.name);
    const scopes = normalizePermissionScopes(command.scopes);
    const secret = apiTokenSecret();
    const tokenId = stableId("token", `${command.projectId ?? "global"}:${name}:${randomUUID()}`);
    const result = await this.pool.query<ApiTokenRow>(
      `
        INSERT INTO siteflow_api_tokens (
          id,
          project_id,
          name,
          token_hash,
          token_prefix,
          scopes,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        RETURNING id, project_id, name, token_prefix, scopes, status, created_by,
                  created_at, updated_at, revoked_at, last_used_at
      `,
      [
        tokenId,
        command.projectId ?? null,
        name,
        apiTokenHash(secret),
        secret.slice(0, 12),
        scopes,
        command.actor ? JSON.stringify(command.actor) : null
      ]
    );
    const token = apiTokenFromRow(result.rows[0]);

    if (command.projectId) {
      await insertAuditEvent(this.pool, {
        projectId: command.projectId,
        action: "api_token.created",
        actor: command.actor,
        targetType: "api_token",
        targetId: token.id,
        summary: `API token ${token.name} created.`,
        metadata: {
          scopes: token.scopes,
          tokenPrefix: token.tokenPrefix
        }
      });
    }

    return {
      status: "created",
      token,
      secret,
      message: "API token created. Store the token now; it will not be shown again."
    };
  }

  async revokeApiToken(command: RevokeApiTokenCommand): Promise<ApiTokenRevokeReadModel> {
    const result = await this.pool.query<ApiTokenRow>(
      `
        UPDATE siteflow_api_tokens
        SET status = 'revoked',
            revoked_at = COALESCE(revoked_at, now()),
            updated_at = now()
        WHERE id = $1
          AND ($2::text IS NULL OR project_id = $2)
        RETURNING id, project_id, name, token_prefix, scopes, status, created_by,
                  created_at, updated_at, revoked_at, last_used_at
      `,
      [command.tokenId, command.projectId ?? null]
    );
    const row = result.rows[0];

    if (!row) {
      throw new SiteFlowNotFoundError(`Unknown API token: ${command.tokenId}`);
    }

    const token = apiTokenFromRow(row);

    if (token.projectId) {
      await insertAuditEvent(this.pool, {
        projectId: token.projectId,
        action: "api_token.revoked",
        actor: command.actor,
        targetType: "api_token",
        targetId: token.id,
        summary: `API token ${token.name} revoked.`,
        reason: command.reason,
        metadata: {
          scopes: token.scopes,
          tokenPrefix: token.tokenPrefix
        }
      });
    }

    return {
      status: "revoked",
      token,
      message: "API token revoked."
    };
  }

  async listFirewallRules(projectId: SiteFlowId): Promise<FirewallRuleListReadModel> {
    await this.readProject(projectId);

    const result = await this.pool.query<FirewallRuleRow>(
      `
        SELECT id, project_id, name, action, priority, status, conditions, created_by,
               created_at, updated_at, disabled_at
        FROM siteflow_firewall_rules
        WHERE project_id = $1
        ORDER BY priority ASC, updated_at DESC
      `,
      [projectId]
    );

    return {
      projectId,
      rules: result.rows.map(firewallRuleFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async createFirewallRule(command: CreateFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> {
    await this.readProject(command.projectId);

    const name = normalizeFirewallRuleName(command.name);
    const action = normalizeFirewallAction(command.action);
    const priority = normalizeFirewallPriority(command.priority);
    const conditions = normalizeFirewallConditions(command.conditions);
    const ruleId = stableId("fw", `${command.projectId}:${name}`);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<FirewallRuleRow>(
        `
          INSERT INTO siteflow_firewall_rules (
            id,
            project_id,
            name,
            action,
            priority,
            conditions,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET action = EXCLUDED.action,
              priority = EXCLUDED.priority,
              status = 'active',
              conditions = EXCLUDED.conditions,
              created_by = EXCLUDED.created_by,
              disabled_at = NULL,
              updated_at = now()
          RETURNING id, project_id, name, action, priority, status, conditions, created_by,
                    created_at, updated_at, disabled_at
        `,
        [
          ruleId,
          command.projectId,
          name,
          action,
          priority,
          JSON.stringify(conditions),
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      const rule = firewallRuleFromRow(result.rows[0]);

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "firewall_rule.created",
        actor: command.actor,
        targetType: "firewall_rule",
        targetId: rule.id,
        summary: `Firewall rule ${rule.name} ${rule.action}s matching requests.`,
        metadata: {
          action: rule.action,
          priority: rule.priority,
          conditions: rule.conditions
        }
      });
      await client.query("COMMIT");

      return {
        status: "created",
        rule,
        message: "Firewall rule created."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async disableFirewallRule(command: DisableFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> {
    await this.readProject(command.projectId);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<FirewallRuleRow>(
        `
          UPDATE siteflow_firewall_rules
          SET status = 'disabled',
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, action, priority, status, conditions, created_by,
                    created_at, updated_at, disabled_at
        `,
        [command.projectId, command.ruleId]
      );
      const row = result.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown firewall rule: ${command.ruleId}`);
      }

      const rule = firewallRuleFromRow(row);

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "firewall_rule.disabled",
        actor: command.actor,
        targetType: "firewall_rule",
        targetId: rule.id,
        summary: `Firewall rule ${rule.name} disabled.`,
        reason: command.reason
      });
      await client.query("COMMIT");

      return {
        status: "disabled",
        rule,
        message: "Firewall rule disabled."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async evaluateFirewall(command: FirewallEvaluationCommand): Promise<FirewallEvaluationReadModel> {
    const rules = await this.listFirewallRules(command.projectId);
    const matchedRule = rules.rules.find((rule) => rule.status === "active" && firewallConditionMatches(rule, command));

    if (!matchedRule) {
      return {
        projectId: command.projectId,
        decision: "allow",
        reason: "No firewall rule matched."
      };
    }

    return {
      projectId: command.projectId,
      decision: matchedRule.action,
      matchedRule,
      reason: `Firewall rule ${matchedRule.name} matched.`
    };
  }

  async listRoutingRules(command: ListRoutingRulesCommand): Promise<RoutingRuleListReadModel> {
    await this.readProject(command.projectId);

    const kind = command.kind ? normalizeRoutingRuleKind(command.kind) : undefined;
    const status = normalizeRoutingStatus(command.status);
    const result = await this.pool.query<RoutingRuleRow>(
      `
        SELECT id, project_id, name, kind, source, destination, status_code, headers,
               priority, status, created_by, updated_by, created_at, updated_at, disabled_at
        FROM siteflow_routing_rules
        WHERE project_id = $1
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY priority ASC, updated_at DESC
      `,
      [command.projectId, kind ?? null, status ?? null]
    );

    return {
      projectId: command.projectId,
      rules: result.rows.map(routingRuleFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async upsertRoutingRule(command: UpsertRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> {
    await this.readProject(command.projectId);

    const input = normalizeRoutingRuleInput(command);
    const ruleId = stableId("route", `${command.projectId}:${input.name}`);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<RoutingRuleRow>(
        `
          INSERT INTO siteflow_routing_rules (
            id,
            project_id,
            name,
            kind,
            source,
            destination,
            status_code,
            headers,
            priority,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET kind = EXCLUDED.kind,
              source = EXCLUDED.source,
              destination = EXCLUDED.destination,
              status_code = EXCLUDED.status_code,
              headers = EXCLUDED.headers,
              priority = EXCLUDED.priority,
              status = 'active',
              updated_by = EXCLUDED.updated_by,
              disabled_at = NULL,
              updated_at = now()
          RETURNING id, project_id, name, kind, source, destination, status_code, headers,
                    priority, status, created_by, updated_by, created_at, updated_at, disabled_at
        `,
        [
          ruleId,
          command.projectId,
          input.name,
          input.kind,
          input.source,
          input.destination ?? null,
          input.statusCode ?? null,
          JSON.stringify(input.headers),
          input.priority,
          command.actor ? JSON.stringify(command.actor) : null,
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      const rule = routingRuleFromRow(result.rows[0]);

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "routing_rule.upserted",
        actor: command.actor,
        targetType: "routing_rule",
        targetId: rule.id,
        summary: `Routing rule ${rule.name} saved.`,
        metadata: {
          kind: rule.kind,
          source: rule.source,
          destination: rule.destination,
          headers: rule.headers,
          priority: rule.priority
        }
      });
      await client.query("COMMIT");

      return {
        status: "upserted",
        rule,
        message: "Routing rule saved."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async disableRoutingRule(command: DisableRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> {
    await this.readProject(command.projectId);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<RoutingRuleRow>(
        `
          UPDATE siteflow_routing_rules
          SET status = 'disabled',
              updated_by = $3::jsonb,
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, kind, source, destination, status_code, headers,
                    priority, status, created_by, updated_by, created_at, updated_at, disabled_at
        `,
        [command.projectId, command.ruleId, command.actor ? JSON.stringify(command.actor) : null]
      );
      const row = result.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown routing rule: ${command.ruleId}`);
      }

      const rule = routingRuleFromRow(row);

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "routing_rule.disabled",
        actor: command.actor,
        targetType: "routing_rule",
        targetId: rule.id,
        summary: `Routing rule ${rule.name} disabled.`,
        reason: command.reason
      });
      await client.query("COMMIT");

      return {
        status: "disabled",
        rule,
        message: "Routing rule disabled."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async matchRoutingRules(command: MatchRoutingRulesCommand): Promise<RoutingRuleMatchReadModel> {
    const rules = await this.listRoutingRules({
      projectId: command.projectId,
      status: "active"
    });
    const pathName = normalizeRoutingPath(command.path, "path");
    const redirect = rules.rules.find((rule) => rule.kind === "redirect" && pathMatchesPattern(pathName, rule.source));
    const rewrite = redirect ? undefined : rules.rules.find((rule) => rule.kind === "rewrite" && pathMatchesPattern(pathName, rule.source));
    const headers = rules.rules.filter((rule) => rule.kind === "header" && pathMatchesPattern(pathName, rule.source));

    return {
      projectId: command.projectId,
      path: pathName,
      redirect,
      rewrite,
      headers,
      rewrittenPath: rewrite ? applyRoutingDestination(pathName, rewrite.source, rewrite.destination) : undefined,
      updatedAt: new Date().toISOString()
    };
  }

  async getEdgeConfig(projectId: SiteFlowId): Promise<EdgeConfigReadModel> {
    await this.readProject(projectId);

    const result = await this.pool.query<EdgeConfigRow>(
      `
        SELECT id, project_id, key, value, value_type, created_by, updated_by, created_at, updated_at
        FROM siteflow_edge_config
        WHERE project_id = $1
        ORDER BY key ASC
      `,
      [projectId]
    );

    return {
      projectId,
      entries: result.rows.map(edgeConfigFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async upsertEdgeConfig(command: UpsertEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> {
    await this.readProject(command.projectId);

    const key = normalizeEdgeConfigKey(command.key);
    const valueType = edgeConfigValueType(command.value);
    const entryId = stableId("edge", `${command.projectId}:${key}`);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<EdgeConfigRow>(
        `
          INSERT INTO siteflow_edge_config (
            id,
            project_id,
            key,
            value,
            value_type,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb)
          ON CONFLICT (project_id, key) DO UPDATE
          SET value = EXCLUDED.value,
              value_type = EXCLUDED.value_type,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          RETURNING id, project_id, key, value, value_type, created_by, updated_by, created_at, updated_at
        `,
        [
          entryId,
          command.projectId,
          key,
          JSON.stringify(command.value),
          valueType,
          command.actor ? JSON.stringify(command.actor) : null,
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      const entry = edgeConfigFromRow(result.rows[0]);

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "edge_config.upserted",
        actor: command.actor,
        targetType: "edge_config",
        targetId: entry.id,
        summary: `Edge Config ${entry.key} saved.`,
        metadata: {
          key: entry.key,
          valueType: entry.valueType
        }
      });
      await client.query("COMMIT");

      return {
        status: "upserted",
        entry,
        message: "Edge Config entry saved."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteEdgeConfig(command: DeleteEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> {
    await this.readProject(command.projectId);

    const key = normalizeEdgeConfigKey(command.key);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<EdgeConfigRow>(
        `
          DELETE FROM siteflow_edge_config
          WHERE project_id = $1 AND key = $2
          RETURNING id, project_id, key, value, value_type, created_by, updated_by, created_at, updated_at
        `,
        [command.projectId, key]
      );
      const row = result.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown Edge Config entry: ${key}`);
      }

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "edge_config.deleted",
        actor: command.actor,
        targetType: "edge_config",
        targetId: row.id,
        summary: `Edge Config ${key} deleted.`,
        reason: command.reason,
        metadata: {
          key
        }
      });
      await client.query("COMMIT");

      return {
        status: "deleted",
        message: "Edge Config entry deleted."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listBlobs(command: ListBlobsCommand): Promise<BlobListReadModel> {
    await this.readProject(command.projectId);

    const prefix = normalizeBlobPrefix(command.prefix);
    const cursor = command.cursor ? normalizeBlobPathname(command.cursor) : undefined;
    const limit = normalizeBlobLimit(command.limit);
    const result = await this.pool.query<BlobRow>(
      `
        SELECT id, project_id, pathname, access, content_type, cache_control_max_age,
               size_bytes, sha256, etag, url, uploaded_by, uploaded_at, updated_at
        FROM siteflow_blobs
        WHERE project_id = $1
          AND ($2::text IS NULL OR pathname LIKE $2 || '%')
          AND ($3::text IS NULL OR pathname > $3)
        ORDER BY pathname ASC
        LIMIT $4
      `,
      [command.projectId, prefix ?? null, cursor ?? null, limit]
    );

    return {
      projectId: command.projectId,
      blobs: result.rows.map(blobFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async putBlob(command: PutBlobCommand): Promise<BlobPutReadModel> {
    await this.readProject(command.projectId);

    const pathname = normalizeBlobPathname(command.pathname);
    const content = decodeBlobContentBase64(command.contentBase64);
    const access = normalizeBlobAccess(command.access);
    const contentType = normalizeBlobContentType(command.contentType);
    const cacheControlMaxAge = normalizeBlobCacheControlMaxAge(command.cacheControlMaxAge);
    const digest = createHash("sha256").update(content).digest("hex");
    const sha256 = `sha256:${digest}`;
    const etag = `"${digest}"`;
    const url = blobUrl(command.projectId, pathname);
    const blobId = stableId("blob", `${command.projectId}:${pathname}`);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<BlobRow>(
        `
          INSERT INTO siteflow_blobs (
            id,
            project_id,
            pathname,
            access,
            content_type,
            cache_control_max_age,
            size_bytes,
            sha256,
            etag,
            url,
            content,
            uploaded_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          ON CONFLICT (project_id, pathname) DO UPDATE
          SET access = EXCLUDED.access,
              content_type = EXCLUDED.content_type,
              cache_control_max_age = EXCLUDED.cache_control_max_age,
              size_bytes = EXCLUDED.size_bytes,
              sha256 = EXCLUDED.sha256,
              etag = EXCLUDED.etag,
              url = EXCLUDED.url,
              content = EXCLUDED.content,
              uploaded_by = EXCLUDED.uploaded_by,
              updated_at = now()
          RETURNING id, project_id, pathname, access, content_type, cache_control_max_age,
                    size_bytes, sha256, etag, url, uploaded_by, uploaded_at, updated_at
        `,
        [
          blobId,
          command.projectId,
          pathname,
          access,
          contentType,
          cacheControlMaxAge ?? null,
          content.byteLength,
          sha256,
          etag,
          url,
          content,
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      const blob = blobFromRow(result.rows[0]);

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "blob.uploaded",
        actor: command.actor,
        targetType: "blob",
        targetId: blob.id,
        summary: `Blob ${blob.pathname} uploaded.`,
        metadata: {
          pathname: blob.pathname,
          access: blob.access,
          contentType: blob.contentType,
          size: blob.size,
          sha256: blob.sha256
        }
      });
      await client.query("COMMIT");

      return {
        status: "uploaded",
        blob,
        message: "Blob uploaded."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBlob(command: GetBlobCommand): Promise<BlobReadModel> {
    await this.readProject(command.projectId);

    const pathname = normalizeBlobPathname(command.pathname);
    const result = await this.pool.query<BlobRow>(
      `
        SELECT id, project_id, pathname, access, content_type, cache_control_max_age,
               size_bytes, sha256, etag, url, content, uploaded_by, uploaded_at, updated_at
        FROM siteflow_blobs
        WHERE project_id = $1 AND pathname = $2
      `,
      [command.projectId, pathname]
    );
    const row = result.rows[0];

    if (!row?.content) {
      throw new SiteFlowNotFoundError(`Unknown blob: ${pathname}`);
    }

    return {
      projectId: command.projectId,
      blob: blobFromRow(row),
      contentBase64: row.content.toString("base64")
    };
  }

  async deleteBlob(command: DeleteBlobCommand): Promise<BlobDeleteReadModel> {
    await this.readProject(command.projectId);

    const pathname = normalizeBlobPathname(command.pathname);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<BlobRow>(
        `
          DELETE FROM siteflow_blobs
          WHERE project_id = $1 AND pathname = $2
          RETURNING id, project_id, pathname, access, content_type, cache_control_max_age,
                    size_bytes, sha256, etag, url, uploaded_by, uploaded_at, updated_at
        `,
        [command.projectId, pathname]
      );
      const row = result.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown blob: ${pathname}`);
      }

      const blob = blobFromRow(row);

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "blob.deleted",
        actor: command.actor,
        targetType: "blob",
        targetId: blob.id,
        summary: `Blob ${blob.pathname} deleted.`,
        reason: command.reason,
        metadata: {
          pathname: blob.pathname,
          sha256: blob.sha256
        }
      });
      await client.query("COMMIT");

      return {
        status: "deleted",
        blob,
        message: "Blob deleted."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listCacheEntries(command: ListCacheEntriesCommand): Promise<CacheListReadModel> {
    await this.readProject(command.projectId);

    const pathName = command.path ? normalizeCachePath(command.path) : undefined;
    const tag = normalizeCacheTag(command.tag);
    const status = normalizeCacheStatus(command.status);
    const limit = normalizeCacheLimit(command.limit);
    const result = await this.pool.query<CacheEntryRow>(
      `
        SELECT id, project_id, cache_key, path, tags, status, content_type, size_bytes, etag,
               max_age_seconds, stale_while_revalidate_seconds, last_generated_at, expires_at,
               stale_at, purged_at, updated_at
        FROM siteflow_cache_entries
        WHERE project_id = $1
          AND ($2::text IS NULL OR path = $2)
          AND ($3::text IS NULL OR $3 = ANY(tags))
          AND ($4::text IS NULL OR status = $4)
        ORDER BY updated_at DESC, path ASC
        LIMIT $5
      `,
      [command.projectId, pathName ?? null, tag ?? null, status ?? null, limit]
    );

    return {
      projectId: command.projectId,
      entries: result.rows.map(cacheEntryFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async purgeCache(command: PurgeCacheCommand): Promise<CachePurgeReadModel> {
    await this.readProject(command.projectId);

    const pathName = command.path ? normalizeCachePath(command.path) : undefined;
    const tag = normalizeCacheTag(command.tag);

    if (!pathName && !tag) {
      throw new Error("Cache purge requires path or tag.");
    }

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<CacheEntryRow>(
        `
          UPDATE siteflow_cache_entries
          SET status = 'purged',
              purged_at = now(),
              updated_at = now()
          WHERE project_id = $1
            AND ($2::text IS NULL OR path = $2)
            AND ($3::text IS NULL OR $3 = ANY(tags))
          RETURNING id, project_id, cache_key, path, tags, status, content_type, size_bytes, etag,
                    max_age_seconds, stale_while_revalidate_seconds, last_generated_at, expires_at,
                    stale_at, purged_at, updated_at
        `,
        [command.projectId, pathName ?? null, tag ?? null]
      );
      const purged = result.rows.map(cacheEntryFromRow);
      const targetId = pathName ?? tag ?? "cache";

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "cache.purged",
        actor: command.actor,
        targetType: "cache",
        targetId: stableId("cache", `${command.projectId}:${targetId}`),
        summary: `Purged ${purged.length} cache entr${purged.length === 1 ? "y" : "ies"}.`,
        reason: command.reason,
        metadata: {
          path: pathName,
          tag,
          total: purged.length,
          cacheKeys: purged.map((entry) => entry.key)
        }
      });
      await client.query("COMMIT");

      return {
        status: "purged",
        projectId: command.projectId,
        purged,
        total: purged.length,
        message: `Purged ${purged.length} cache entr${purged.length === 1 ? "y" : "ies"}.`
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listFunctions(command: ListFunctionsCommand): Promise<FunctionRuntimeListReadModel> {
    await this.readProject(command.projectId);

    const deploymentResult = await this.pool.query<Pick<DeploymentSummaryRow, "id" | "project_id" | "artifact_manifest" | "created_at" | "checksum" | "file_count" | "total_bytes">>(
      `
        SELECT id, project_id, artifact_manifest, created_at, checksum, file_count, total_bytes
        FROM siteflow_deployments
        WHERE project_id = $1
          AND status = 'ready'
          AND ($2::text IS NULL OR id = $2)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [command.projectId, command.deploymentId ?? null]
    );
    const deployment = deploymentResult.rows[0];

    if (!deployment) {
      throw new SiteFlowNotFoundError(`Unknown ready deployment for project: ${command.projectId}`);
    }

    const functions = functionsFromArtifactManifest(deployment.artifact_manifest);
    const invocationResult = await this.pool.query<FunctionInvocationRow>(
      `
        SELECT id, deployment_id, project_id, path, method, status, response_status,
               duration_ms, request_id, logs, error_message, invoked_at
        FROM siteflow_function_invocations
        WHERE project_id = $1 AND deployment_id = $2
        ORDER BY invoked_at DESC
      `,
      [command.projectId, deployment.id]
    );
    const invocations = invocationResult.rows.map(functionInvocationFromRow);
    const items = functions.map((entry) => functionRuntimeItem(command.projectId, deployment.id, entry, invocations));

    return {
      projectId: command.projectId,
      deploymentId: deployment.id,
      functions: items,
      total: items.length,
      updatedAt: new Date().toISOString()
    };
  }

  async getFunctionRuntime(command: GetFunctionRuntimeCommand): Promise<FunctionRuntimeReadModel> {
    const list = await this.listFunctions({
      projectId: command.projectId,
      deploymentId: command.deploymentId
    });
    const functionPath = command.path.startsWith("/") ? command.path : `/${command.path}`;
    const item = list.functions.find((entry) => entry.function.path === functionPath);

    if (!item) {
      throw new SiteFlowNotFoundError(`Unknown function: ${functionPath}`);
    }

    const limit = normalizeCacheLimit(command.limit);
    const invocationResult = await this.pool.query<FunctionInvocationRow>(
      `
        SELECT id, deployment_id, project_id, path, method, status, response_status,
               duration_ms, request_id, logs, error_message, invoked_at
        FROM siteflow_function_invocations
        WHERE project_id = $1
          AND deployment_id = $2
          AND path = $3
        ORDER BY invoked_at DESC
        LIMIT $4
      `,
      [command.projectId, item.deploymentId, functionPath, limit]
    );

    return {
      projectId: command.projectId,
      deploymentId: item.deploymentId,
      function: item,
      recentInvocations: invocationResult.rows.map(functionInvocationFromRow),
      updatedAt: new Date().toISOString()
    };
  }

  async listDeployHooks(projectId: SiteFlowId): Promise<DeployHookListReadModel> {
    await this.readProject(projectId);

    const result = await this.pool.query<DeployHookRow>(
      `
        SELECT id, project_id, name, branch, target_environment, token_prefix, status,
               created_at, updated_at, revoked_at, last_triggered_at
        FROM siteflow_deploy_hooks
        WHERE project_id = $1
        ORDER BY created_at DESC
      `,
      [projectId]
    );

    return {
      projectId,
      hooks: result.rows.map(deployHookFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async createDeployHook(command: CreateDeployHookCommand): Promise<DeployHookCreateReadModel> {
    const project = await this.readProject(command.projectId);
    const name = normalizeDeployHookName(command.name);
    const branch = normalizeBranch(command.branch, project.productionBranch ?? project.defaultBranch);
    const targetEnvironment = normalizeEnvironmentName(command.targetEnvironment ?? "preview");
    const token = deployHookToken();
    const tokenHash = deployHookTokenHash(token);
    const hookId = stableId("hook", `${project.id}:${name}:${branch}:${targetEnvironment}:${randomUUID()}`);
    const tokenPrefix = token.slice(0, 12);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<DeployHookRow>(
        `
          INSERT INTO siteflow_deploy_hooks (
            id,
            project_id,
            name,
            branch,
            target_environment,
            token_hash,
            token_prefix,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          RETURNING id, project_id, name, branch, target_environment, token_prefix, status,
                    created_at, updated_at, revoked_at, last_triggered_at
        `,
        [
          hookId,
          project.id,
          name,
          branch,
          targetEnvironment,
          tokenHash,
          tokenPrefix,
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      const hook = deployHookFromRow(result.rows[0]);

      await insertDeployHookEvent(client, {
        hookId: hook.id,
        projectId: hook.projectId,
        action: "created",
        actor: command.actor,
        summary: `Deploy hook ${hook.name} created for ${hook.branch}:${hook.targetEnvironment}.`,
        metadata: {
          tokenPrefix: hook.tokenPrefix
        }
      });
      await insertAuditEvent(client, {
        projectId: hook.projectId,
        action: "deploy_hook.created",
        actor: command.actor,
        targetType: "deploy_hook",
        targetId: hook.id,
        summary: `Deploy hook ${hook.name} created.`,
        metadata: {
          branch: hook.branch,
          targetEnvironment: hook.targetEnvironment,
          tokenPrefix: hook.tokenPrefix
        }
      });
      await client.query("COMMIT");

      return {
        status: "created",
        hook,
        token,
        message: "Deploy hook created. Store the token now; it will not be shown again."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeDeployHook(command: RevokeDeployHookCommand): Promise<DeployHookRevokeReadModel> {
    await this.readProject(command.projectId);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<DeployHookRow>(
        `
          UPDATE siteflow_deploy_hooks
          SET status = 'revoked',
              revoked_by = $3::jsonb,
              revoke_reason = $4,
              revoked_at = COALESCE(revoked_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, branch, target_environment, token_prefix, status,
                    created_at, updated_at, revoked_at, last_triggered_at
        `,
        [
          command.projectId,
          command.hookId,
          command.actor ? JSON.stringify(command.actor) : null,
          command.reason?.trim() || null
        ]
      );
      const row = result.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown deploy hook: ${command.hookId}`);
      }

      const hook = deployHookFromRow(row);

      await insertDeployHookEvent(client, {
        hookId: hook.id,
        projectId: hook.projectId,
        action: "revoked",
        actor: command.actor,
        summary: `Deploy hook ${hook.name} revoked.`,
        metadata: {
          reason: command.reason?.trim() || undefined
        }
      });
      await insertAuditEvent(client, {
        projectId: hook.projectId,
        action: "deploy_hook.revoked",
        actor: command.actor,
        targetType: "deploy_hook",
        targetId: hook.id,
        summary: `Deploy hook ${hook.name} revoked.`,
        reason: command.reason,
        metadata: {
          tokenPrefix: hook.tokenPrefix
        }
      });
      await client.query("COMMIT");

      return {
        status: "revoked",
        hook,
        message: "Deploy hook revoked."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async triggerDeployHook(command: TriggerDeployHookCommand): Promise<DeployHookTriggerReadModel> {
    const token = command.token.trim();

    if (!token) {
      throw new Error("Deploy hook token is required.");
    }

    const tokenHash = deployHookTokenHash(token);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const hookResult = await client.query<DeployHookRow>(
        `
          SELECT id, project_id, name, branch, target_environment, token_prefix, status,
                 created_at, updated_at, revoked_at, last_triggered_at
          FROM siteflow_deploy_hooks
          WHERE token_hash = $1 AND status = 'active'
          FOR UPDATE
        `,
        [tokenHash]
      );
      const hookRow = hookResult.rows[0];

      if (!hookRow) {
        throw new SiteFlowNotFoundError("Deploy hook token is invalid or revoked.");
      }

      const deliveryKey = command.idempotencyKey?.trim() || randomUUID();
      const deliveryId = `deploy-hook:${hookRow.id}:${deliveryKey}`;
      const sourceEventId = stableId("src", `generic:${deliveryId}`);
      const buildJobId = stableId("build", sourceEventId);

      const projectResult = await client.query<ProjectRow>(
        `
          SELECT id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
          FROM siteflow_projects
          WHERE id = $1
        `,
        [hookRow.project_id]
      );
      const projectRow = projectResult.rows[0];

      if (!projectRow) {
        throw new SiteFlowNotFoundError(`Unknown project: ${hookRow.project_id}`);
      }

      const project = projectFromRow(projectRow);
      const buildSettings = defaultBuildSettings(project.framework, project.buildSettings);
      const branch = normalizeBranch(command.branch ?? branchFromRef(command.ref), hookRow.branch);
      const commitSha = command.commitSha?.trim() || `deploy-hook-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const actor: Actor = command.actor ?? {
        id: `deploy-hook:${hookRow.id}`,
        name: hookRow.name,
        role: "system"
      };
      const commitAuthor = command.commitAuthor?.trim() || actor.name;
      const commitMessage = command.commitMessage?.trim() || `Deploy hook ${hookRow.name} triggered.`;

      await client.query(
        `
          INSERT INTO siteflow_source_events (
            id,
            project_id,
            provider,
            provider_delivery_id,
            kind,
            status,
            disposition,
            branch,
            commit_sha,
            commit_message,
            commit_author,
            pull_request_number,
            actor,
            provider_payload,
            received_at
          )
          VALUES ($1, $2, 'generic', $3, 'manual', 'accepted', 'build_requested', $4, $5, $6, $7, NULL, $8::jsonb, $9::jsonb, now())
          ON CONFLICT (provider, provider_delivery_id) DO NOTHING
        `,
        [
          sourceEventId,
          project.id,
          deliveryId,
          branch,
          commitSha,
          commitMessage,
          commitAuthor,
          JSON.stringify(actor),
          JSON.stringify({
            event: "deploy_hook",
            ref: command.ref,
            deployHook: {
              id: hookRow.id,
              name: hookRow.name,
              targetEnvironment: hookRow.target_environment
            }
          })
        ]
      );

      await client.query(
        `
          INSERT INTO siteflow_build_jobs (
            id,
            project_id,
            source_event_id,
            status,
            framework,
            install_command,
            build_command,
            output_directory
          )
          VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
          ON CONFLICT (source_event_id) DO NOTHING
        `,
        [
          buildJobId,
          project.id,
          sourceEventId,
          buildSettings.framework ?? project.framework,
          buildSettings.installCommand,
          buildSettings.buildCommand,
          buildSettings.outputDirectory
        ]
      );

      await client.query(
        `
          UPDATE siteflow_deploy_hooks
          SET last_triggered_at = now(),
              updated_at = now()
          WHERE id = $1
        `,
        [hookRow.id]
      );

      const sourceResult = await client.query<SourceEventRow>(
        `
          SELECT id, project_id, kind, status, disposition, provider_delivery_id, branch, commit_sha, commit_message, commit_author,
                 pull_request_number, received_at, actor
          FROM siteflow_source_events
          WHERE provider = 'generic' AND provider_delivery_id = $1
        `,
        [deliveryId]
      );
      const sourceEvent = sourceResult.rows[0] ? sourceEventFromRow(sourceResult.rows[0]) : undefined;
      const queuedBuild = await client.query<{ id: string }>(
        "SELECT id FROM siteflow_build_jobs WHERE source_event_id = $1",
        [sourceEventId]
      );
      const updatedHook = await client.query<DeployHookRow>(
        `
          SELECT id, project_id, name, branch, target_environment, token_prefix, status,
                 created_at, updated_at, revoked_at, last_triggered_at
          FROM siteflow_deploy_hooks
          WHERE id = $1
        `,
        [hookRow.id]
      );

      if (!sourceEvent || !queuedBuild.rows[0] || !updatedHook.rows[0]) {
        throw new SiteFlowNotFoundError("Deploy hook trigger could not be materialized.");
      }

      await insertDeployHookEvent(client, {
        hookId: hookRow.id,
        projectId: hookRow.project_id,
        action: "triggered",
        actor,
        summary: `Deploy hook ${hookRow.name} queued build ${queuedBuild.rows[0].id}.`,
        metadata: {
          sourceEventId: sourceEvent.id,
          buildJobId: queuedBuild.rows[0].id,
          branch,
          commitSha,
          deliveryId
        },
        idempotencyKey: deliveryId
      });

      await client.query("COMMIT");

      return {
        status: "accepted",
        hook: deployHookFromRow(updatedHook.rows[0]),
        sourceEvent,
        buildJobId: queuedBuild.rows[0].id,
        message: "Deploy hook accepted and build job queued."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listCronJobs(projectId: SiteFlowId): Promise<CronJobListReadModel> {
    await this.readProject(projectId);

    const result = await this.pool.query<CronJobRow>(
      `
        SELECT id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
        FROM siteflow_cron_jobs
        WHERE project_id = $1
        ORDER BY created_at DESC
      `,
      [projectId]
    );

    return {
      projectId,
      jobs: result.rows.map(cronJobFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async createCronJob(command: CreateCronJobCommand): Promise<CronJobCreateReadModel> {
    await this.readProject(command.projectId);

    const name = normalizeCronJobName(command.name);
    const pathName = normalizeCronPath(command.path);
    const schedule = normalizeCronSchedule(command.schedule);
    const jobId = stableId("cron", `${command.projectId}:${name}`);
    const client = await this.pool.connect();
    let row: CronJobRow;

    try {
      await client.query("BEGIN");
      const result = await client.query<CronJobRow>(
        `
          INSERT INTO siteflow_cron_jobs (
            id,
            project_id,
            name,
            path,
            schedule,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET path = EXCLUDED.path,
              schedule = EXCLUDED.schedule,
              status = 'active',
              disabled_by = NULL,
              disable_reason = NULL,
              disabled_at = NULL,
              updated_at = now()
          RETURNING id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
        `,
        [
          jobId,
          command.projectId,
          name,
          pathName,
          schedule,
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      row = result.rows[0];
      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "cron_job.created",
        actor: command.actor,
        targetType: "cron_job",
        targetId: row.id,
        summary: `Cron job ${row.name} saved.`,
        metadata: {
          path: row.path,
          schedule: row.schedule
        }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "created",
      job: cronJobFromRow(row),
      message: "Cron job saved."
    };
  }

  async disableCronJob(command: DisableCronJobCommand): Promise<CronJobDisableReadModel> {
    await this.readProject(command.projectId);

    const client = await this.pool.connect();
    let row: CronJobRow | undefined;

    try {
      await client.query("BEGIN");
      const result = await client.query<CronJobRow>(
        `
          UPDATE siteflow_cron_jobs
          SET status = 'disabled',
              disabled_by = $3::jsonb,
              disable_reason = $4,
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
        `,
        [
          command.projectId,
          command.jobId,
          command.actor ? JSON.stringify(command.actor) : null,
          command.reason?.trim() || null
        ]
      );
      row = result.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown cron job: ${command.jobId}`);
      }

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "cron_job.disabled",
        actor: command.actor,
        targetType: "cron_job",
        targetId: row.id,
        summary: `Cron job ${row.name} disabled.`,
        reason: command.reason
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "disabled",
      job: cronJobFromRow(row),
      message: "Cron job disabled."
    };
  }

  async runCronJob(command: RunCronJobCommand): Promise<CronJobRunReadModel> {
    await this.readProject(command.projectId);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const jobResult = await client.query<CronJobRow>(
        `
          SELECT id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
          FROM siteflow_cron_jobs
          WHERE project_id = $1 AND id = $2
          FOR UPDATE
        `,
        [command.projectId, command.jobId]
      );
      const row = jobResult.rows[0];

      if (!row) {
        throw new SiteFlowNotFoundError(`Unknown cron job: ${command.jobId}`);
      }

      const job = cronJobFromRow(row);

      if (job.status !== "active") {
        await client.query("COMMIT");
        return {
          status: "rejected",
          job,
          message: "Cron job is disabled."
        };
      }

      const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, "production");
      const domain = domains[0];

      if (!domain) {
        await client.query("COMMIT");
        return {
          status: "rejected",
          job,
          message: "Cron job rejected: no verified production domain is configured."
        };
      }

      const normalizedPath = job.path.startsWith("/") ? job.path : `/${job.path}`;
      const targetUrl = `${this.publicScheme}://${domain.hostname}${normalizedPath}`;
      const idempotencyKey = command.idempotencyKey?.trim() || `cron:${job.id}:${new Date().toISOString()}`;
      const dispatchId = stableId("crondispatch", idempotencyKey);
      const result = await client.query<CronDispatchRow>(
        `
          INSERT INTO siteflow_cron_dispatches (
            id,
            cron_job_id,
            project_id,
            target_url,
            method,
            user_agent,
            status,
            reason,
            scheduled_at,
            idempotency_key
          )
          VALUES ($1, $2, $3, $4, 'GET', 'vercel-cron/1.0', 'queued', $5, now(), $6)
          ON CONFLICT (idempotency_key) DO UPDATE
          SET idempotency_key = EXCLUDED.idempotency_key
          RETURNING id, cron_job_id, project_id, target_url, method, user_agent, status, reason,
                    scheduled_at, dispatched_at, response_status, error_message
        `,
        [
          dispatchId,
          job.id,
          command.projectId,
          targetUrl,
          command.reason?.trim() || "Manual cron run requested.",
          idempotencyKey
        ]
      );

      await client.query(
        `
          UPDATE siteflow_cron_jobs
          SET last_dispatched_at = now(),
              updated_at = now()
          WHERE id = $1
        `,
        [job.id]
      );

      const updated = await client.query<CronJobRow>(
        `
          SELECT id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
          FROM siteflow_cron_jobs
          WHERE id = $1
        `,
        [job.id]
      );
      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "cron_job.run",
        actor: command.actor,
        targetType: "cron_job",
        targetId: job.id,
        summary: `Cron job ${job.name} queued manual dispatch.`,
        reason: command.reason,
        metadata: {
          dispatchId,
          targetUrl
        }
      });

      await client.query("COMMIT");

      return {
        status: "accepted",
        job: cronJobFromRow(updated.rows[0] ?? row),
        dispatch: cronDispatchFromRow(result.rows[0]),
        message: "Cron dispatch queued."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ingestGitWebhook(command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> {
    const event = command.event;
    const deliveryId = command.deliveryId.trim();

    if (!deliveryId) {
      throw new Error("Git webhook delivery id is required.");
    }

    if (command.provider !== event.provider) {
      throw new Error("Git webhook provider mismatch.");
    }

    const project = await this.findOrCreateProjectForSourceEvent(command);
    const existing = await this.readSourceEventByDelivery(command.provider, deliveryId);

    if (existing) {
      const buildJobId = await this.readBuildJobIdForSource(existing.id);

      return {
        status: "duplicate",
        sourceEvent: existing,
        buildJobId,
        message: "Git webhook delivery was already processed."
      };
    }

    const sourceEventId = stableId("src", `${command.provider}:${deliveryId}`);
    const buildJobId = stableId("build", sourceEventId);
    const buildSettings = defaultBuildSettings(project.framework, project.buildSettings);

    await this.pool.query(
      `
        INSERT INTO siteflow_source_events (
          id,
          project_id,
          provider,
          provider_delivery_id,
          kind,
          status,
          disposition,
          branch,
          commit_sha,
          commit_message,
          commit_author,
          pull_request_number,
          actor,
          provider_payload,
          received_at
        )
        VALUES ($1, $2, $3, $4, $5, 'accepted', 'build_requested', $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
      `,
      [
        sourceEventId,
        project.id,
        command.provider,
        deliveryId,
        event.kind,
        event.branch,
        event.commitSha,
        event.commitMessage,
        event.commitAuthor,
        event.pullRequestNumber ?? null,
        JSON.stringify(event.actor),
        JSON.stringify(event.providerPayload ?? {}),
        event.receivedAt
      ]
    );

    await this.pool.query(
      `
        INSERT INTO siteflow_build_jobs (
          id,
          project_id,
          source_event_id,
          status,
          framework,
          install_command,
          build_command,
          output_directory
        )
        VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
        ON CONFLICT (source_event_id) DO NOTHING
      `,
      [
        buildJobId,
        project.id,
        sourceEventId,
        buildSettings.framework ?? project.framework,
        buildSettings.installCommand,
        buildSettings.buildCommand,
        buildSettings.outputDirectory
      ]
    );

    const sourceEvent = await this.readSourceEventByDelivery(command.provider, deliveryId);

    if (!sourceEvent) {
      throw new SiteFlowNotFoundError(`Unknown source event delivery: ${deliveryId}`);
    }

    return {
      status: "accepted",
      sourceEvent,
      buildJobId,
      message: "Git webhook accepted and build job queued."
    };
  }

  async ingestAnalyticsEvent(command: AnalyticsEventCommand): Promise<AnalyticsIngestReadModel> {
    await this.readProject(command.projectId);

    const event = normalizeAnalyticsEventInput(command);
    const eventId = stableId("analytics", `${event.projectId}:${event.kind}:${event.path}:${event.occurredAt}:${randomUUID()}`);
    const result = await this.pool.query<AnalyticsEventRow>(
      `
        INSERT INTO siteflow_analytics_events (
          id,
          project_id,
          kind,
          path,
          referrer,
          country,
          browser,
          device,
          event_name,
          vital_name,
          vital_value,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, project_id, kind, path, referrer, country, browser, device, event_name,
                  vital_name, vital_value, occurred_at, received_at
      `,
      [
        eventId,
        event.projectId,
        event.kind,
        event.path,
        event.referrer ?? null,
        event.country ?? null,
        event.browser ?? null,
        event.device ?? null,
        event.eventName ?? null,
        event.vitalName ?? null,
        event.vitalValue ?? null,
        event.occurredAt
      ]
    );

    return {
      status: "accepted",
      event: analyticsEventFromRow(result.rows[0]),
      message: "Analytics event accepted."
    };
  }

  async getAnalyticsDashboard(projectId: SiteFlowId): Promise<AnalyticsDashboardReadModel> {
    const fixtureModel = await this.tryReadModel<AnalyticsDashboardReadModel>("analytics-dashboard", projectId);

    if (fixtureModel) {
      return fixtureModel;
    }

    await this.readProject(projectId);

    const totals = await this.pool.query<AnalyticsTotalsRow>(
      `
        SELECT
          COUNT(*) FILTER (WHERE kind = 'pageview') AS pageviews,
          COUNT(*) FILTER (WHERE kind = 'custom') AS custom_events,
          COUNT(*) FILTER (WHERE kind = 'web_vital') AS web_vitals,
          COUNT(DISTINCT path) FILTER (WHERE kind = 'pageview') AS unique_paths
        FROM siteflow_analytics_events
        WHERE project_id = $1 AND received_at >= now() - interval '24 hours'
      `,
      [projectId]
    );
    const totalRow = totals.rows[0] ?? { pageviews: 0, custom_events: 0, web_vitals: 0, unique_paths: 0 };
    const pageviews = pgNumber(totalRow.pageviews);
    const customEvents = pgNumber(totalRow.custom_events);
    const webVitalsCount = pgNumber(totalRow.web_vitals);
    const eventTotal = pageviews + customEvents + webVitalsCount;

    const [topPages, referrers, countries, browsers, devices, customEventRows, webVitals] = await Promise.all([
      this.pool.query<AnalyticsDimensionRow>(
        `
          SELECT path AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND kind = 'pageview' AND received_at >= now() - interval '24 hours'
          GROUP BY path
          ORDER BY count DESC, path ASC
          LIMIT 5
        `,
        [projectId]
      ),
      this.pool.query<AnalyticsDimensionRow>(
        `
          SELECT referrer AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND kind = 'pageview' AND referrer IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY referrer
          ORDER BY count DESC, referrer ASC
          LIMIT 5
        `,
        [projectId]
      ),
      this.pool.query<AnalyticsDimensionRow>(
        `
          SELECT country AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND country IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY country
          ORDER BY count DESC, country ASC
          LIMIT 5
        `,
        [projectId]
      ),
      this.pool.query<AnalyticsDimensionRow>(
        `
          SELECT browser AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND browser IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY browser
          ORDER BY count DESC, browser ASC
          LIMIT 5
        `,
        [projectId]
      ),
      this.pool.query<AnalyticsDimensionRow>(
        `
          SELECT device AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND device IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY device
          ORDER BY count DESC, device ASC
          LIMIT 5
        `,
        [projectId]
      ),
      this.pool.query<AnalyticsDimensionRow>(
        `
          SELECT event_name AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND kind = 'custom' AND event_name IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY event_name
          ORDER BY count DESC, event_name ASC
          LIMIT 5
        `,
        [projectId]
      ),
      this.pool.query<AnalyticsWebVitalRow>(
        `
          SELECT
            vital_name AS name,
            COUNT(*) AS count,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY vital_value) AS p75
          FROM siteflow_analytics_events
          WHERE project_id = $1
            AND kind = 'web_vital'
            AND vital_name IS NOT NULL
            AND vital_value IS NOT NULL
            AND received_at >= now() - interval '24 hours'
          GROUP BY vital_name
          ORDER BY vital_name ASC
        `,
        [projectId]
      )
    ]);

    return {
      projectId,
      window: "24h",
      totals: {
        pageviews,
        customEvents,
        webVitals: webVitalsCount,
        uniquePaths: pgNumber(totalRow.unique_paths)
      },
      topPages: analyticsDimensionsFromRows(topPages.rows, pageviews),
      referrers: analyticsDimensionsFromRows(referrers.rows, pageviews),
      countries: analyticsDimensionsFromRows(countries.rows, eventTotal),
      browsers: analyticsDimensionsFromRows(browsers.rows, eventTotal),
      devices: analyticsDimensionsFromRows(devices.rows, eventTotal),
      customEvents: analyticsDimensionsFromRows(customEventRows.rows, customEvents),
      webVitals: analyticsWebVitalsFromRows(webVitals.rows),
      updatedAt: new Date().toISOString()
    };
  }

  async queryLogs(command: LogQueryCommand): Promise<LogQueryReadModel> {
    await this.readProject(command.projectId);

    const filters = logFiltersFromCommand(command);
    const result = await this.queryObservabilityLogEntries({
      projectId: command.projectId,
      source: filters.source,
      severity: filters.severity,
      deploymentId: filters.deploymentId,
      search: filters.search,
      limit: command.limit,
      cursor: command.cursor
    });

    return {
      projectId: command.projectId,
      filters,
      entries: result.entries,
      total: result.total,
      nextCursor: result.nextCursor,
      updatedAt: new Date().toISOString()
    };
  }

  async listSavedLogQueries(projectId: SiteFlowId): Promise<SavedLogQueryListReadModel> {
    await this.readProject(projectId);

    const result = await this.pool.query<SavedLogQueryRow>(
      `
        SELECT id, project_id, name, filters, created_by, created_at, updated_at
        FROM siteflow_saved_log_queries
        WHERE project_id = $1
        ORDER BY updated_at DESC, name ASC
      `,
      [projectId]
    );

    return {
      projectId,
      queries: result.rows.map(savedLogQueryFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async saveLogQuery(command: SaveLogQueryCommand): Promise<SavedLogQueryMutationReadModel> {
    await this.readProject(command.projectId);

    const name = normalizeLogQueryName(command.name);
    const filters = logFiltersFromSaved(command.filters);
    const queryId = stableId("logquery", `${command.projectId}:${name}`);
    const client = await this.pool.connect();
    let row: SavedLogQueryRow;

    try {
      await client.query("BEGIN");
      const result = await client.query<SavedLogQueryRow>(
        `
          INSERT INTO siteflow_saved_log_queries (
            id,
            project_id,
            name,
            filters,
            created_by
          )
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET filters = EXCLUDED.filters,
              created_by = EXCLUDED.created_by,
              updated_at = now()
          RETURNING id, project_id, name, filters, created_by, created_at, updated_at
        `,
        [
          queryId,
          command.projectId,
          name,
          JSON.stringify(filters),
          command.actor ? JSON.stringify(command.actor) : null
        ]
      );
      row = result.rows[0];
      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "log_query.saved",
        actor: command.actor,
        targetType: "log_query",
        targetId: row.id,
        summary: `Saved log query ${row.name}.`,
        metadata: {
          filters
        }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "saved",
      query: savedLogQueryFromRow(row),
      message: "Log query saved."
    };
  }

  async listLogDrains(projectId: SiteFlowId): Promise<LogDrainListReadModel> {
    await this.readProject(projectId);

    const result = await this.pool.query<LogDrainRow>(
      `
        SELECT id, project_id, name, url, sources, minimum_severity, status, signing_secret,
               signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        FROM siteflow_log_drains
        WHERE project_id = $1
        ORDER BY created_at DESC, name ASC
      `,
      [projectId]
    );

    return {
      projectId,
      drains: result.rows.map(logDrainFromRow),
      total: result.rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  async createLogDrain(command: CreateLogDrainCommand): Promise<LogDrainCreateReadModel> {
    await this.readProject(command.projectId);

    const name = normalizeLogDrainName(command.name);
    const url = normalizeLogDrainUrl(command.url);
    const sources = normalizeLogDrainSources(command.sources);
    const minimumSeverity = normalizeLogSeverity(command.minimumSeverity) ?? "info";
    const signingSecret = command.signingSecret?.trim() || generateLogDrainSigningSecret();
    const secretWasProvided = Boolean(command.signingSecret?.trim());
    const drainId = stableId("drain", `${command.projectId}:${name}`);
    const client = await this.pool.connect();
    let row: LogDrainRow;

    try {
      await client.query("BEGIN");
      const result = await client.query<LogDrainRow>(
        `
          INSERT INTO siteflow_log_drains (
            id,
            project_id,
            name,
            url,
            sources,
            minimum_severity,
            signing_secret,
            signing_secret_prefix,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET url = EXCLUDED.url,
              sources = EXCLUDED.sources,
              minimum_severity = EXCLUDED.minimum_severity,
              status = 'active',
              signing_secret = CASE WHEN $10 THEN EXCLUDED.signing_secret ELSE siteflow_log_drains.signing_secret END,
              signing_secret_prefix = CASE WHEN $10 THEN EXCLUDED.signing_secret_prefix ELSE siteflow_log_drains.signing_secret_prefix END,
              created_by = EXCLUDED.created_by,
              updated_at = now()
          RETURNING id, project_id, name, url, sources, minimum_severity, status, signing_secret,
                    signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        `,
        [
          drainId,
          command.projectId,
          name,
          url,
          sources,
          minimumSeverity,
          signingSecret,
          logDrainSigningSecretPrefix(signingSecret),
          command.actor ? JSON.stringify(command.actor) : null,
          secretWasProvided
        ]
      );
      row = result.rows[0];
      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "log_drain.created",
        actor: command.actor,
        targetType: "log_drain",
        targetId: row.id,
        summary: `Log drain ${row.name} saved.`,
        metadata: {
          sources: row.sources,
          minimumSeverity: row.minimum_severity,
          signingSecretPrefix: row.signing_secret_prefix
        }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      status: "created",
      drain: logDrainFromRow(row),
      message: "Log drain created."
    };
  }

  async prepareLogDrainDelivery(command: DeliverLogDrainCommand): Promise<LogDrainDeliveryPlan> {
    await this.readProject(command.projectId);

    const result = await this.pool.query<LogDrainRow>(
      `
        SELECT id, project_id, name, url, sources, minimum_severity, status, signing_secret,
               signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        FROM siteflow_log_drains
        WHERE project_id = $1 AND id = $2 AND status = 'active'
      `,
      [command.projectId, command.drainId]
    );
    const row = result.rows[0];

    if (!row) {
      throw new SiteFlowNotFoundError(`Unknown active log drain: ${command.drainId}`);
    }

    const logs = await this.queryObservabilityLogEntries({
      projectId: command.projectId,
      sources: normalizeLogDrainSources(row.sources),
      severity: normalizeLogSeverity(row.minimum_severity),
      limit: command.limit ?? 100
    });

    return {
      deliveryId: stableId("delivery", `${command.projectId}:${command.drainId}:${randomUUID()}`),
      drain: logDrainFromRow(row),
      signingSecret: row.signing_secret,
      events: logs.entries
    };
  }

  async recordLogDrainDelivery(command: RecordLogDrainDeliveryCommand): Promise<LogDrainDeliveryReadModel> {
    await this.readProject(command.projectId);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const drainResult = await client.query<LogDrainRow>(
        `
          SELECT id, project_id, name, url, sources, minimum_severity, status, signing_secret,
                 signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
          FROM siteflow_log_drains
          WHERE project_id = $1 AND id = $2
          FOR UPDATE
        `,
        [command.projectId, command.drainId]
      );
      const drainRow = drainResult.rows[0];

      if (!drainRow) {
        throw new SiteFlowNotFoundError(`Unknown log drain: ${command.drainId}`);
      }

      const attempt = command.attempt ?? (await this.nextLogDrainDeliveryAttempt(client, command.drainId));
      const deliveryResult = await client.query<LogDrainDeliveryRow>(
        `
          INSERT INTO siteflow_log_drain_deliveries (
            id,
            drain_id,
            project_id,
            status,
            response_status,
            events_delivered,
            attempt,
            payload_sha256,
            error_message
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE
          SET status = EXCLUDED.status,
              response_status = EXCLUDED.response_status,
              events_delivered = EXCLUDED.events_delivered,
              attempt = EXCLUDED.attempt,
              payload_sha256 = EXCLUDED.payload_sha256,
              error_message = EXCLUDED.error_message,
              delivered_at = now()
          RETURNING id, drain_id, project_id, status, response_status, events_delivered,
                    attempt, payload_sha256, error_message, delivered_at
        `,
        [
          command.deliveryId,
          command.drainId,
          command.projectId,
          command.status,
          command.responseStatus ?? null,
          command.eventsDelivered,
          attempt,
          command.payloadSha256,
          command.errorMessage ?? null
        ]
      );

      const updatedDrain = await client.query<LogDrainRow>(
        `
          UPDATE siteflow_log_drains
          SET last_delivered_at = now(),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, url, sources, minimum_severity, status, signing_secret,
                    signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        `,
        [command.projectId, command.drainId]
      );
      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "log_drain.delivered",
        targetType: "log_drain",
        targetId: command.drainId,
        summary: `Log drain delivery ${command.status}.`,
        metadata: {
          deliveryId: command.deliveryId,
          status: command.status,
          eventsDelivered: command.eventsDelivered,
          responseStatus: command.responseStatus
        }
      });

      await client.query("COMMIT");

      return {
        status: command.status,
        drain: logDrainFromRow(updatedDrain.rows[0] ?? drainRow),
        delivery: logDrainDeliveryFromRow(deliveryResult.rows[0]),
        message: command.status === "delivered" ? "Log drain delivered." : "Log drain delivery failed."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listDeployments(projectId?: SiteFlowId): Promise<DeploymentListReadModel> {
    const fixtureModel = await this.tryReadModel<DeploymentListReadModel>("deployment-list", projectId ?? "default");

    if (fixtureModel) {
      return fixtureModel;
    }

    const values = projectId ? [projectId] : [];
    const where = projectId ? "WHERE deployment.project_id = $1" : "";
    const result = await this.pool.query<DeploymentSummaryRow>(
      `
        SELECT
          deployment.id,
          deployment.project_id,
          project.name AS project_name,
          deployment.source_branch,
          deployment.source_commit_sha,
          deployment.preview_host,
          deployment.status,
          deployment.checksum,
          deployment.file_count,
          deployment.total_bytes,
          deployment.artifact_manifest,
          deployment.created_at,
          route.id AS route_revision_id,
          route.status AS route_revision_status
        FROM siteflow_deployments deployment
        JOIN siteflow_projects project ON project.id = deployment.project_id
        LEFT JOIN LATERAL (
          SELECT id, status
          FROM siteflow_route_revisions
          WHERE deployment_id = deployment.id
          ORDER BY created_at DESC
          LIMIT 1
        ) route ON true
        ${where}
        ORDER BY deployment.created_at DESC
      `,
      values
    );

    return {
      deployments: result.rows.map((row) => deploymentSummaryFromRow(row, this.publicScheme)),
      total: result.rows.length,
      projectId,
      updatedAt: new Date().toISOString()
    };
  }

  async getDeployment(deploymentId: SiteFlowId): Promise<DeploymentDetailReadModel> {
    const fixtureModel = await this.tryReadModel<DeploymentDetailReadModel>("deployment-detail", deploymentId);

    if (fixtureModel) {
      return fixtureModel;
    }

    return this.readDeploymentDetail(deploymentId);
  }

  async getReleaseConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<ReleaseConsoleReadModel> {
    assertReleaseChannelName(channel);

    const cached = await this.tryReadModel<ReleaseConsoleReadModel>("release-console", releaseConsoleKey(projectId, channel));

    if (cached) {
      return cached;
    }

    return this.buildReleaseConsole(projectId, channel);
  }

  async getRollbackConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollbackConsoleReadModel> {
    assertReleaseChannelName(channel);

    const cached = await this.tryReadModel<RollbackConsoleReadModel>("rollback-console", releaseConsoleKey(projectId, channel));

    if (cached) {
      return cached;
    }

    return this.buildRollbackConsole(projectId, channel);
  }

  async promoteDeployment(command: PromoteDeploymentCommand): Promise<CommandResultReadModel> {
    return this.recordReleaseCommand("promote", command);
  }

  async rollbackDeployment(command: RollbackDeploymentCommand): Promise<CommandResultReadModel> {
    return this.recordReleaseCommand("rollback", command);
  }

  async getRollingRelease(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollingReleaseReadModel> {
    assertReleaseChannelName(channel);
    await this.readProject(projectId);

    const rollout = await this.readActiveRollingRelease(this.pool, projectId, channel);

    return {
      projectId,
      channel,
      rollout: rollout ? rollingReleaseFromRow(rollout) : undefined,
      currentDeployment: rollout ? await this.readDeploymentSummary(rollout.current_deployment_id).catch(() => undefined) : undefined,
      candidateDeployment: rollout ? await this.readDeploymentSummary(rollout.candidate_deployment_id).catch(() => undefined) : undefined,
      safetyChecks: rollout
        ? [
            {
              id: "check-rollout-active",
              label: "Rolling release active",
              status: "pass",
              summary: `Candidate ${rollout.candidate_deployment_id} receives ${rollout.percentage}% of traffic.`
            }
          ]
        : [],
      updatedAt: new Date().toISOString()
    };
  }

  async startRollingRelease(command: StartRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    assertRollingCommand(command);
    assertReleaseChannelName(command.channel);

    const percentage = normalizeRolloutPercentage(command.percentage);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await this.ensureProjectExists(client, command.projectId);

      const existing = await this.readActiveRollingRelease(client, command.projectId, command.channel);

      if (existing) {
        await client.query("COMMIT");
        return {
          status: "rejected",
          safetyChecks: [
            {
              id: "check-no-active-rollout",
              label: "No active rollout",
              status: "fail",
              summary: `Rolling release ${existing.id} is already active.`
            }
          ],
          message: "Rolling release rejected: another rollout is already active."
        };
      }

      const channel = await this.readReleaseChannel(client, command.projectId, command.channel);
      const currentDeploymentId = channel?.current_deployment_id;
      const current = currentDeploymentId ? await this.readDeploymentForRoute(client, currentDeploymentId) : undefined;
      const candidate = await this.readDeploymentForRoute(client, command.candidateDeploymentId);
      const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, command.channel);
      const releaseEvidence = releaseEvidenceMetadataForStorage(command.releaseEvidence);
      const safetyChecks = [
        {
          id: "check-current-deployment-ready",
          label: "Current deployment ready",
          status: current?.status === "ready" ? "pass" as const : "fail" as const,
          summary: current ? `Current deployment ${current.id} is ${current.status}.` : "Release channel has no current deployment."
        },
        ...safetyChecksForRoute(command.projectId, candidate, domains, command.channel),
        ...releaseEvidenceIdentityCheck(candidate, releaseEvidence, command.channel)
      ];
      const failedCheck = safetyChecks.find((check) => check.status === "fail");

      if (failedCheck || !current || !candidate) {
        await client.query("COMMIT");
        return {
          status: "rejected",
          safetyChecks,
          message: `Rolling release rejected: ${failedCheck?.summary ?? "current or candidate deployment could not be routed"}`
        };
      }

      const rolloutId = stableId("rollout", command.idempotencyKey);
      const routeRevision = await this.insertRollingRouteRevision(
        client,
        rolloutId,
        command,
        current.id,
        candidate.id,
        percentage,
        domains,
        "Rolling release started."
      );
      const result = await client.query<RollingReleaseRow>(
        `
          INSERT INTO siteflow_rolling_releases (
            id,
            project_id,
            channel,
            current_deployment_id,
            candidate_deployment_id,
            percentage,
            status,
            actor,
            reason,
            idempotency_key,
            route_revision_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, $8, $9, $10)
          RETURNING id, project_id, channel, current_deployment_id, candidate_deployment_id, percentage,
                    status, actor, reason, route_revision_id, created_at, updated_at, completed_at, aborted_at
        `,
        [
          rolloutId,
          command.projectId,
          command.channel,
          current.id,
          candidate.id,
          percentage,
          JSON.stringify(command.actor),
          command.reason.trim(),
          command.idempotencyKey,
          routeRevision.id
        ]
      );

      await insertAuditEvent(client, {
        projectId: command.projectId,
        action: "rolling_release.started",
        actor: command.actor,
        targetType: "route_revision",
        targetId: routeRevision.id,
        summary: `Rolling release started at ${percentage}%.`,
        reason: command.reason,
        metadata: {
          channel: command.channel,
          rolloutId,
          routeRevisionId: routeRevision.id,
          currentDeploymentId: current.id,
          candidateDeploymentId: candidate.id,
          percentage,
          releaseEvidence: releaseEvidenceAuditMetadata(releaseEvidence)
        }
      });

      await client.query("COMMIT");

      return {
        status: "accepted",
        rollout: rollingReleaseFromRow(result.rows[0]),
        routeRevision,
        safetyChecks,
        message: `Rolling release started at ${percentage}%.`
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async advanceRollingRelease(command: AdvanceRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    return this.updateRollingRelease("advance", command);
  }

  async completeRollingRelease(command: CompleteRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    return this.updateRollingRelease("complete", command);
  }

  async abortRollingRelease(command: AbortRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    return this.updateRollingRelease("abort", command);
  }

  async pollOperation(operationId: SiteFlowId): Promise<OperationSnapshotReadModel> {
    const snapshot = await this.tryReadModel<OperationSnapshotReadModel>("operation", operationId);

    if (snapshot) {
      return snapshot;
    }

    const result = await this.pool.query<ReleaseCommandRow>(
      `
        SELECT operation_id, action, project_id, channel, target_deployment_id, state, message, route_revision_id,
               release_evidence, updated_at
        FROM siteflow_release_commands
        WHERE operation_id = $1
      `,
      [operationId]
    );

    const row = result.rows[0];

    if (!row) {
      throw new SiteFlowNotFoundError(`Unknown SiteFlow operation: ${operationId}`);
    }

    return {
      operationId: row.operation_id,
      projectId: row.project_id,
      state: row.state,
      kind: operationKind(row.action),
      channel: row.channel,
      targetDeploymentId: row.target_deployment_id,
      releaseEvidence: row.release_evidence ?? undefined,
      routeRevision: row.route_revision_id ? await this.readRouteRevision(this.pool, row.route_revision_id) : undefined,
      updatedAt: row.updated_at.toISOString(),
      message: row.message
    };
  }

  async getLogChunk(deploymentId: SiteFlowId, cursor?: string): Promise<LogChunkReadModel> {
    const fixtureModel = await this.tryReadModel<LogChunkReadModel>("log-chunk", logChunkKey(deploymentId, cursor));

    if (fixtureModel) {
      return fixtureModel;
    }

    return this.readBuildLogChunk(deploymentId, cursor);
  }

  async getBuildJobLogChunk(buildJobId: SiteFlowId, cursor?: string): Promise<BuildJobLogChunkReadModel> {
    const buildJob = await this.pool.query<BuildJobLogStatusRow>(
      "SELECT status FROM siteflow_build_jobs WHERE id = $1",
      [buildJobId]
    );
    const status = buildJob.rows[0]?.status;

    if (!status) {
      throw new SiteFlowNotFoundError(`Unknown SiteFlow build job: ${buildJobId}`);
    }

    const tail = await this.readBuildLogTail(buildJobId, cursor);

    return {
      buildJobId,
      status,
      lines: tail.rows.map((row) => row.line),
      nextCursor: tail.nextCursor,
      hasMore: tail.hasMore,
      complete: !tail.hasMore && isTerminalBuildLogStatus(status)
    };
  }

  async getLatestBuildJobLogChunk(projectId: SiteFlowId, cursor?: string): Promise<BuildJobLogChunkReadModel> {
    const project = await this.pool.query(
      "SELECT 1 FROM siteflow_projects WHERE id = $1",
      [projectId]
    );

    if (!project.rows[0]) {
      throw new SiteFlowNotFoundError(`Unknown SiteFlow project: ${projectId}`);
    }

    const buildJob = await this.pool.query<LatestBuildJobLogStatusRow>(
      "SELECT id, status FROM siteflow_build_jobs WHERE project_id = $1 ORDER BY queued_at DESC LIMIT 1",
      [projectId]
    );
    const latest = buildJob.rows[0];

    if (!latest) {
      return {
        buildJobId: "",
        status: "none",
        lines: [],
        nextCursor: cursor ?? "0",
        hasMore: false,
        complete: true
      };
    }

    const tail = await this.readBuildLogTail(latest.id, cursor);

    return {
      buildJobId: latest.id,
      status: latest.status,
      lines: tail.rows.map((row) => row.line),
      nextCursor: tail.nextCursor,
      hasMore: tail.hasMore,
      complete: !tail.hasMore && isTerminalBuildLogStatus(latest.status)
    };
  }

  async deployPrebuilt(command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> {
    if (!Array.isArray(command.files)) {
      throw new Error("Prebuilt deploy requires a files array.");
    }

    assertPrebuiltUploadBudget(command.files, this.prebuiltUploadBudget, "Prebuilt deploy");

    const projectSlug = normalizeSlug(command.projectSlug);
    const baseDomain = resolveBaseDomain(command.baseDomain, this.baseDomain);
    const hostPrefix = normalizeHostPrefix(command.requestedHostPrefix);
    const previewHost = `${hostPrefix}.${baseDomain}`;
    const deploymentId = `dep_${randomUUID().replace(/-/g, "")}`;
    const projectId = `project_${projectSlug}`;
    const artifactBaseRoot = path.resolve(this.artifactRoot);
    const artifactRoot = path.join(artifactBaseRoot, deploymentId);
    const artifactStagingRoot = path.join(artifactBaseRoot, `.publish-${deploymentId}-${randomUUID().replace(/-/g, "")}`);
    const entrypoint = safeArtifactPath(command.entrypoint ?? "index.html");
    const releaseEvidence = releaseEvidenceMetadataForStorage(command.releaseEvidence);
    const source = normalizePrebuiltSourceForReleaseEvidence(command.source, releaseEvidence);
    const artifactManifest: ArtifactManifest = {
      entrypoint,
      fileCount: command.files.length,
      totalBytes: 0,
      checksum: "",
      generatedAt: new Date().toISOString(),
      metadata: {
        ...(command.public !== undefined ? { public: command.public } : {}),
        ...(command.fluid !== undefined ? { fluid: command.fluid } : {}),
        ...(command.images !== undefined ? { images: command.images } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(releaseEvidence !== undefined ? { releaseEvidence } : {}),
        precompressed: precompressedStats(command.files),
        routing: {
          ...(command.routing?.cleanUrls !== undefined ? { cleanUrls: command.routing.cleanUrls } : {}),
          ...(command.routing?.trailingSlash !== undefined ? { trailingSlash: command.routing.trailingSlash } : {}),
          ...(command.routing?.skipTrailingSlashRedirect !== undefined ? { skipTrailingSlashRedirect: command.routing.skipTrailingSlashRedirect } : {})
        }
      }
    };
    const checksum = createHash("sha256");
    let totalBytes = 0;
    let stagingCreated = false;
    let artifactPromoted = false;
    let committed = false;
    let client: PoolClient | undefined;

    if (command.files.length === 0) {
      throw new Error("Prebuilt deploy requires at least one file.");
    }

    try {
      await mkdir(artifactBaseRoot, { recursive: true });

      if (await pathExists(artifactRoot)) {
        throw new Error(`Prebuilt artifact target already exists: ${artifactRoot}.`);
      }

      await mkdir(artifactStagingRoot);
      stagingCreated = true;

      for (const file of command.files) {
        const relativePath = safeArtifactPath(file.path);
        const bytes = verifyFile(file);
        const targetPath = path.resolve(artifactStagingRoot, ...relativePath.split("/"));

        if (!targetPath.startsWith(`${artifactStagingRoot}${path.sep}`)) {
          throw new Error(`Artifact file escapes deployment root: ${file.path}`);
        }

        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, bytes);

        checksum.update(relativePath);
        checksum.update("\0");
        checksum.update(bytes);
        totalBytes += bytes.byteLength;
      }

      const digest = checksum.digest("hex");
      artifactManifest.totalBytes = totalBytes;
      artifactManifest.checksum = `sha256:${digest}`;

      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO siteflow_projects (id, slug, name)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE
          SET slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              updated_at = now()
        `,
        [projectId, projectSlug, projectSlug]
      );

      await client.query(
        `
          INSERT INTO siteflow_deployments (
            id,
            project_id,
            source_type,
            source_branch,
            source_commit_sha,
            status,
            artifact_root,
            checksum,
            file_count,
            total_bytes,
            preview_host,
            artifact_manifest
          )
          VALUES ($1, $2, 'prebuilt', $3, $4, 'ready', $5, $6, $7, $8, $9, $10::jsonb)
        `,
        [
          deploymentId,
          projectId,
          source?.branch ?? null,
          source?.commitSha ?? null,
          artifactRoot,
          digest,
          command.files.length,
          totalBytes,
          previewHost,
          JSON.stringify(artifactManifest)
        ]
      );

      await client.query(
        `
          INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
          VALUES ($1, $2, $3, $4)
        `,
        [previewHost, deploymentId, artifactRoot, entrypoint]
      );

      for (const routingCommand of prebuiltRoutingCommands(projectId, command.routing)) {
        const input = normalizeRoutingRuleInput(routingCommand);
        const ruleId = stableId("route", `${projectId}:${input.name}`);

        await client.query(
          `
            INSERT INTO siteflow_routing_rules (
              id,
              project_id,
              name,
              kind,
              source,
              destination,
              status_code,
              headers,
              priority,
              created_by,
              updated_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET kind = EXCLUDED.kind,
                source = EXCLUDED.source,
                destination = EXCLUDED.destination,
                status_code = EXCLUDED.status_code,
                headers = EXCLUDED.headers,
                priority = EXCLUDED.priority,
                status = 'active',
                updated_by = EXCLUDED.updated_by,
                disabled_at = NULL,
                updated_at = now()
          `,
          [
            ruleId,
            projectId,
            input.name,
            input.kind,
            input.source,
            input.destination ?? null,
            input.statusCode ?? null,
            JSON.stringify(input.headers),
            input.priority,
            routingCommand.actor ? JSON.stringify(routingCommand.actor) : null,
            routingCommand.actor ? JSON.stringify(routingCommand.actor) : null
          ]
        );
      }

      for (const cronCommand of prebuiltCronCommands(projectId, command.crons)) {
        const name = normalizeCronJobName(cronCommand.name);
        const pathName = normalizeCronPath(cronCommand.path);
        const schedule = normalizeCronSchedule(cronCommand.schedule);
        const jobId = stableId("cron", `${projectId}:${name}`);

        await client.query(
          `
            INSERT INTO siteflow_cron_jobs (
              id,
              project_id,
              name,
              path,
              schedule,
              created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET path = EXCLUDED.path,
                schedule = EXCLUDED.schedule,
                status = 'active',
                disabled_by = NULL,
                disable_reason = NULL,
                disabled_at = NULL,
                updated_at = now()
          `,
          [
            jobId,
            projectId,
            name,
            pathName,
            schedule,
            cronCommand.actor ? JSON.stringify(cronCommand.actor) : null
          ]
        );
      }

      if (await pathExists(artifactRoot)) {
        throw new Error(`Prebuilt artifact target already exists: ${artifactRoot}.`);
      }

      await rename(artifactStagingRoot, artifactRoot);
      artifactPromoted = true;
      await client.query("COMMIT");
      committed = true;

      return {
        deploymentId,
        projectId,
        projectSlug,
        previewHost,
        previewUrl: `${this.publicScheme}://${previewHost}`,
        artifactRoot,
        fileCount: command.files.length,
        totalBytes,
        checksum: digest
      };
    } catch (error) {
      if (client && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original deploy failure.
        }
      }

      if (!artifactPromoted && stagingCreated) {
        await removeDirectoryBestEffort(artifactStagingRoot);
      }

      throw error;
    } finally {
      client?.release();
    }
  }

  async resolveArtifactRoute(host: string, bucketKey?: string): Promise<ArtifactRoute | undefined> {
    const normalizedHost = host.toLowerCase().split(":")[0];
    const result = await this.pool.query<RollingArtifactRouteRow>(
      `
        SELECT
          route.host,
          deployment.project_id,
          project.production_branch,
          domain.channel AS route_channel,
          deployment.source_branch,
          route.deployment_id,
          deployment.preview_host,
          project.preview_password_hash,
          project.preview_password_salt,
          route.artifact_root,
          route.entrypoint,
          deployment.artifact_manifest,
          rollout.id AS rolling_release_id,
          candidate.project_id AS candidate_project_id,
          candidate.source_branch AS candidate_source_branch,
          rollout.candidate_deployment_id,
          candidate.artifact_root AS candidate_artifact_root,
          candidate.artifact_manifest AS candidate_artifact_manifest,
          COALESCE(candidate_route.entrypoint, candidate.artifact_manifest->>'entrypoint', 'index.html') AS candidate_entrypoint,
          rollout.percentage
        FROM siteflow_artifact_routes route
        JOIN siteflow_deployments deployment
          ON deployment.id = route.deployment_id
         AND deployment.status = 'ready'
        JOIN siteflow_projects project
          ON project.id = deployment.project_id
        LEFT JOIN siteflow_project_domains domain
          ON domain.hostname = route.host
        LEFT JOIN siteflow_rolling_releases rollout
          ON rollout.project_id = domain.project_id
         AND rollout.channel = domain.channel
         AND rollout.status = 'active'
        LEFT JOIN siteflow_deployments candidate
          ON candidate.id = rollout.candidate_deployment_id
         AND candidate.status = 'ready'
        LEFT JOIN siteflow_artifact_routes candidate_route
          ON candidate_route.deployment_id = candidate.id
         AND candidate_route.host = candidate.preview_host
        WHERE route.host = $1
        LIMIT 1
      `,
      [normalizedHost]
    );
    const row = result.rows[0];

    if (!row) {
      return undefined;
    }

    const rolloutPercentage = typeof row.percentage === "number" ? row.percentage : undefined;
    const hasCandidate = row.rolling_release_id
      && row.candidate_deployment_id
      && row.candidate_artifact_root
      && row.candidate_entrypoint
      && rolloutPercentage !== undefined;
    const useCandidate = Boolean(
      hasCandidate
        && rolloutBucketPercent(`${row.rolling_release_id}:${bucketKey ?? normalizedHost}`) < rolloutPercentage
    );
    const runtimeEnvironment = async (
      projectId: string | undefined | null,
      branch: string | undefined | null,
      artifactManifest: Partial<ArtifactManifest> | Record<string, never> | null | undefined
    ) => {
      const artifactRuntimeEnvironment = artifactManifestRuntimeEnvironment(artifactManifest);

      if (!projectId) {
        return artifactRuntimeEnvironment;
      }

      const targetEnvironment = row.route_channel ?? deploymentEnvironmentForBranch(branch ?? undefined, row.production_branch ?? undefined);
      const variables = await this.pool.query<{ key: string; sealed_value: string }>(
        `
          SELECT key, sealed_value
          FROM siteflow_environment_variables
          WHERE project_id = $1
            AND target_environment = $2
            AND scope = 'runtime'
            AND source = 'sealed'
            AND sealed_value IS NOT NULL
        `,
        [projectId, targetEnvironment]
      );

      return {
        ...artifactRuntimeEnvironment,
        ...unsealEnvironmentVariables(Object.fromEntries(variables.rows.map((variable) => [variable.key, variable.sealed_value])))
      };
    };

    if (useCandidate && row.rolling_release_id && row.candidate_deployment_id && row.candidate_artifact_root && row.candidate_entrypoint) {
      const candidateRouting = artifactManifestRoutingConfig(row.candidate_artifact_manifest);
      const candidateImages = artifactManifestImageConfig(row.candidate_artifact_manifest);
      return {
        host: row.host,
        projectId: row.candidate_project_id ?? undefined,
        deploymentId: row.candidate_deployment_id,
        artifactRoot: row.candidate_artifact_root,
        entrypoint: row.candidate_entrypoint,
        cleanUrls: candidateRouting.cleanUrls,
        trailingSlash: candidateRouting.trailingSlash,
        skipTrailingSlashRedirect: candidateRouting.skipTrailingSlashRedirect,
        images: candidateImages,
        routingRules: {
          redirects: candidateRouting.redirects,
          rewrites: candidateRouting.rewrites,
          headers: candidateRouting.headers
        },
        functions: functionsFromArtifactManifest(row.candidate_artifact_manifest),
        runtimeEnvironment: await runtimeEnvironment(row.candidate_project_id, row.candidate_source_branch, row.candidate_artifact_manifest),
        rollingReleaseId: row.rolling_release_id,
        trafficTarget: "candidate",
        isEphemeralPreview: row.host === row.preview_host,
        previewProtection: previewProtectionFromRouteRow(row)
      };
    }

    const routing = artifactManifestRoutingConfig(row.artifact_manifest);
    const images = artifactManifestImageConfig(row.artifact_manifest);

    return {
      host: row.host,
      projectId: row.project_id,
      deploymentId: row.deployment_id,
      artifactRoot: row.artifact_root,
      entrypoint: row.entrypoint,
      cleanUrls: routing.cleanUrls,
      trailingSlash: routing.trailingSlash,
      skipTrailingSlashRedirect: routing.skipTrailingSlashRedirect,
      images,
      routingRules: {
        redirects: routing.redirects,
        rewrites: routing.rewrites,
        headers: routing.headers
      },
      functions: functionsFromArtifactManifest(row.artifact_manifest),
      runtimeEnvironment: await runtimeEnvironment(row.project_id, row.source_branch, row.artifact_manifest),
      rollingReleaseId: row.rolling_release_id ?? undefined,
      trafficTarget: row.rolling_release_id ? "current" : undefined,
      isEphemeralPreview: row.host === row.preview_host,
      previewProtection: previewProtectionFromRouteRow(row)
    };
  }

  async recordFunctionInvocation(invocation: FunctionInvocation): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO siteflow_function_invocations (
          id,
          deployment_id,
          project_id,
          path,
          method,
          status,
          response_status,
          duration_ms,
          request_id,
          logs,
          error_message,
          invoked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
        ON CONFLICT (request_id) DO NOTHING
      `,
      [
        invocation.id,
        invocation.deploymentId,
        invocation.projectId,
        invocation.path,
        invocation.method,
        invocation.status,
        invocation.responseStatus,
        invocation.durationMs,
        invocation.requestId,
        JSON.stringify(invocation.logs),
        invocation.errorMessage ?? null,
        invocation.invokedAt
      ]
    );
  }

  private async readModel<T>(kind: string, key: string): Promise<T> {
    const model = await this.tryReadModel<T>(kind, key);

    if (!model) {
      throw new SiteFlowNotFoundError(`Unknown SiteFlow ${kind}: ${key}`);
    }

    return model;
  }

  private async tryReadModel<T>(kind: string, key: string): Promise<T | undefined> {
    const result = await this.pool.query<{ payload: T }>(
      "SELECT payload FROM siteflow_read_models WHERE kind = $1 AND key = $2",
      [kind, key]
    );

    return result.rows[0]?.payload;
  }

  private async buildProjectList(): Promise<ProjectListReadModel> {
    const [projects, deploymentList, sourceEvents, auditEvents, activeOperations] = await Promise.all([
      this.listProjectsFromTables(),
      this.listDeployments(),
      this.listRecentSourceEvents(undefined, 20),
      this.listRecentAuditEvents(undefined, 20),
      this.activeReleaseOperationCount()
    ]);
    const items: ProjectListReadModel["projects"] = [];

    for (const project of projects) {
      const productionChannel = await this.readReleaseChannel(this.pool, project.id, "production", false).catch(() => undefined);
      const productionDeployment = await this.deploymentSummaryFromListOrRead(
        deploymentList.deployments,
        productionChannel?.current_deployment_id
      );
      const projectDeployments = deploymentList.deployments.filter((deployment) => deployment.projectId === project.id);

      items.push({
        project,
        productionDeployment,
        pendingDeploymentCount: projectDeployments.filter((deployment) =>
          deployment.status === "queued" || deployment.status === "building"
        ).length,
        lastSourceEvent: sourceEvents.find((event) => event.projectId === project.id),
        lastAuditEvent: auditEvents.find((event) => event.projectId === project.id)
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const deploymentsToday = deploymentList.deployments.filter((deployment) => deployment.createdAt.slice(0, 10) === today).length;

    return {
      summary: {
        totalProjects: projects.length,
        activeProjects: projects.filter((project) => project.status === "active").length,
        deploymentsToday,
        activeOperations,
        routeDriftCount: deploymentList.deployments.filter((deployment) => deployment.routeRevisionStatus === "drifted").length,
        failedRouteCount: deploymentList.deployments.filter((deployment) => deployment.routeRevisionStatus === "failed").length,
        failedBuildCount: deploymentList.deployments.filter((deployment) => deployment.status === "failed").length,
        updatedAt: new Date().toISOString()
      },
      projects: items,
      recentEvents: {
        sourceEvents,
        channelEvents: [],
        auditEvents
      },
      emptyState: items.length === 0 ? "No SiteFlow projects have been created yet." : undefined
    };
  }

  private async buildProjectDetail(projectId: SiteFlowId): Promise<ProjectDetailReadModel> {
    const project = await this.readProject(projectId);
    const [deploymentList, channels, sourceEvents, auditEvents] = await Promise.all([
      this.listDeployments(project.id),
      this.listReleaseChannels(project.id),
      this.listRecentSourceEvents(project.id, 20),
      this.listAuditEvents(project.id, 20)
    ]);
    const channelModels: ReleaseChannelReadModel[] = [];
    const routeEvidence: RouteRevisionEvidenceReadModel[] = [];

    for (const row of channels) {
      const currentDeployment = await this.deploymentSummaryFromListOrRead(deploymentList.deployments, row.current_deployment_id);
      const routeRevision = row.route_revision_id
        ? await this.readRouteRevision(this.pool, row.route_revision_id)
        : undefined;

      channelModels.push({
        channel: releaseChannelFromRow(row),
        currentDeployment,
        routeRevision
      });

      if (routeRevision) {
        routeEvidence.push(routeEvidenceForSummary(routeRevision, currentDeployment));
      }
    }

    const channelEvents = (await Promise.all(
      channels.map((row) => this.listRecentReleaseChannelEvents(project.id, row.name, 5))
    )).flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 20);

    return {
      project,
      channels: channelModels,
      deployments: deploymentList.deployments,
      recentEvents: {
        sourceEvents,
        channelEvents,
        auditEvents
      },
      routeEvidence
    };
  }

  private async listProjectsFromTables(): Promise<Project[]> {
    const result = await this.pool.query<ProjectRow>(
      `
        SELECT id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
        FROM siteflow_projects
        ORDER BY updated_at DESC, name ASC
      `
    );
    const projects: Project[] = [];

    for (const row of result.rows) {
      const project = projectFromRow(row);
      project.domains = await this.listProjectDomains(project.id);
      projects.push(project);
    }

    return projects;
  }

  private async listReleaseChannels(projectId: SiteFlowId): Promise<ReleaseChannelRow[]> {
    const result = await this.pool.query<ReleaseChannelRow>(
      `
        SELECT project_id, name, current_deployment_id, pending_deployment_id, route_revision_id, updated_by, updated_at
        FROM siteflow_release_channels
        WHERE project_id = $1
        ORDER BY
          CASE name
            WHEN 'production' THEN 1
            WHEN 'staging' THEN 2
            WHEN 'preview' THEN 3
            ELSE 4
          END
      `,
      [projectId]
    );

    return result.rows;
  }

  private async listRecentSourceEvents(projectId?: SiteFlowId, limit = 20): Promise<SourceEvent[]> {
    const values = projectId ? [projectId, limit] : [limit];
    const result = await this.pool.query<SourceEventRow>(
      `
        SELECT id, project_id, kind, status, disposition, provider_delivery_id, branch, commit_sha,
               commit_message, commit_author, pull_request_number, received_at, actor
        FROM siteflow_source_events
        ${projectId ? "WHERE project_id = $1" : ""}
        ORDER BY received_at DESC
        LIMIT $${projectId ? 2 : 1}
      `,
      values
    );

    return result.rows.map(sourceEventFromRow);
  }

  private async listRecentAuditEvents(projectId?: SiteFlowId, limit = 20): Promise<AuditEvent[]> {
    const values = projectId ? [projectId, limit] : [limit];
    const result = await this.pool.query<AuditEventRow>(
      `
        SELECT id, project_id, action, actor, target_type, target_id, summary, reason, metadata, created_at
        FROM siteflow_audit_events
        ${projectId ? "WHERE project_id = $1" : ""}
        ORDER BY created_at DESC
        LIMIT $${projectId ? 2 : 1}
      `,
      values
    );

    return result.rows.map(auditEventFromRow);
  }

  private async activeReleaseOperationCount(): Promise<number> {
    const result = await this.pool.query<{ count: string | number }>(
      `
        SELECT count(*) AS count
        FROM siteflow_release_commands
        WHERE state IN ('pending', 'running')
      `
    );

    return pgNumber(result.rows[0]?.count ?? 0);
  }

  private async buildReleaseConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<ReleaseConsoleReadModel> {
    const project = await this.readProject(projectId);
    const [releaseChannel, deployments, domains, recentChannelEvents, auditEvents] = await Promise.all([
      this.readReleaseChannel(this.pool, projectId, channel, false),
      this.listDeployments(projectId),
      this.listVerifiedDomainsForChannel(this.pool, projectId, channel),
      this.listRecentReleaseChannelEvents(projectId, channel),
      this.listAuditEvents(projectId)
    ]);
    const currentDeployment = await this.deploymentSummaryFromListOrRead(
      deployments.deployments,
      releaseChannel?.current_deployment_id
    );
    const candidateDeployment = releaseChannel?.pending_deployment_id
      ? await this.deploymentSummaryFromListOrRead(deployments.deployments, releaseChannel.pending_deployment_id)
      : deployments.deployments.find((deployment) =>
          deployment.status === "ready" && deployment.id !== currentDeployment?.id
        );
    const candidateRoute = candidateDeployment
      ? await this.readDeploymentForRoute(this.pool, candidateDeployment.id).catch(() => undefined)
      : undefined;
    const safetyChecks = safetyChecksForRoute(projectId, candidateRoute, domains, channel);
    const routePreview = candidateRoute
      ? this.routePreviewFor(candidateRoute, channel, domains, currentDeployment?.id, "Promotion")
      : undefined;

    return {
      project,
      channel,
      currentDeployment,
      candidateDeployment,
      routePreview,
      safetyChecks,
      recentChannelEvents,
      auditEvents
    };
  }

  private async buildRollbackConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollbackConsoleReadModel> {
    const project = await this.readProject(projectId);
    const [releaseChannel, deployments, domains, recentChannelEvents, auditEvents] = await Promise.all([
      this.readReleaseChannel(this.pool, projectId, channel, false),
      this.listDeployments(projectId),
      this.listVerifiedDomainsForChannel(this.pool, projectId, channel),
      this.listRecentReleaseChannelEvents(projectId, channel),
      this.listAuditEvents(projectId)
    ]);
    const currentDeployment = await this.deploymentSummaryFromListOrRead(
      deployments.deployments,
      releaseChannel?.current_deployment_id
    );
    const targetEntries: Array<{ target: RollbackTargetReadModel; route?: DeploymentRouteRow }> = [];

    for (const deployment of deployments.deployments.filter((item) => item.id !== currentDeployment?.id).slice(0, 10)) {
      const route = await this.readDeploymentForRoute(this.pool, deployment.id).catch(() => undefined);
      const safetyChecks = [
        ...safetyChecksForRoute(projectId, route, domains, channel),
        {
          id: "check-rollback-target-distinct",
          label: "Rollback target is not current",
          status: deployment.id !== currentDeployment?.id ? "pass" : "fail",
          summary: deployment.id !== currentDeployment?.id
            ? `Rollback target ${deployment.id} is distinct from the current channel target.`
            : "Rollback target is already the current channel target."
        } satisfies SafetyCheck
      ];
      const failedCheck = safetyChecks.find((check) => check.status !== "pass");

      targetEntries.push({
        route,
        target: {
          deployment,
          eligible: !failedCheck,
          disabledReason: failedCheck?.summary,
          safetyChecks
        }
      });
    }

    const selectedEntry = targetEntries.find((entry) => entry.target.eligible) ?? targetEntries[0];
    const routePreview = selectedEntry?.route && currentDeployment
      ? this.routePreviewFor(selectedEntry.route, channel, domains, currentDeployment.id, "Rollback")
      : undefined;

    return {
      project,
      channel,
      currentDeployment,
      targets: targetEntries.map((entry) => entry.target),
      selectedTargetId: selectedEntry?.target.deployment.id,
      routePreview,
      recentChannelEvents,
      auditEvents
    };
  }

  private async deploymentSummaryFromListOrRead(
    deployments: DeploymentSummaryReadModel[],
    deploymentId: SiteFlowId | null | undefined
  ): Promise<DeploymentSummaryReadModel | undefined> {
    if (!deploymentId) {
      return undefined;
    }

    return deployments.find((deployment) => deployment.id === deploymentId)
      ?? this.readDeploymentSummary(deploymentId).catch(() => undefined);
  }

  private routePreviewFor(
    deployment: DeploymentRouteRow,
    channel: ReleaseChannelName,
    domains: DomainBinding[],
    previousDeploymentId: SiteFlowId | undefined,
    action: "Promotion" | "Rollback"
  ): RouteRevisionEvidenceReadModel {
    const routeRevision: RouteRevision = {
      id: stableId("route", `preview:${action}:${deployment.project_id}:${channel}:${deployment.id}:${previousDeploymentId ?? "none"}`),
      projectId: deployment.project_id,
      channel,
      deploymentId: deployment.id,
      previousDeploymentId,
      status: "planned",
      generatedConfig: routeGeneratedConfig(deployment.project_id, channel, deployment, domains),
      validationSummary: `${action} route preview for ${domains.length} verified domain${domains.length === 1 ? "" : "s"}.`,
      createdAt: new Date().toISOString()
    };

    return {
      routeRevision,
      checks: safetyChecksForRoute(deployment.project_id, deployment, domains, channel),
      previousKnownGoodDeploymentId: previousDeploymentId
    };
  }

  private async listRecentReleaseChannelEvents(
    projectId: SiteFlowId,
    channel: ReleaseChannelName,
    limit = 10
  ): Promise<ChannelEvent[]> {
    const result = await this.pool.query<ReleaseCommandRow>(
      `
        SELECT idempotency_key, operation_id, action, project_id, channel, current_deployment_id,
               target_deployment_id, state, actor, reason, message, route_revision_id, release_evidence,
               created_at, updated_at
        FROM siteflow_release_commands
        WHERE project_id = $1
          AND channel = $2
          AND route_revision_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $3
      `,
      [projectId, channel, limit]
    );
    const events: ChannelEvent[] = [];

    for (const row of result.rows) {
      const routeRevision = row.route_revision_id
        ? await this.readRouteRevision(this.pool, row.route_revision_id)
        : undefined;

      if (!routeRevision) {
        continue;
      }

      const command = row.action === "rollback"
        ? {
            projectId: row.project_id,
            channel: row.channel,
            currentDeploymentId: row.current_deployment_id ?? undefined,
            targetDeploymentId: row.target_deployment_id,
            actor: row.actor,
            reason: row.reason,
            idempotencyKey: row.idempotency_key
          }
        : {
            projectId: row.project_id,
            channel: row.channel,
            targetDeploymentId: row.target_deployment_id,
            actor: row.actor,
            reason: row.reason,
            idempotencyKey: row.idempotency_key
          };

      events.push(channelEventForRoute(row.action, command, routeRevision, []));
    }

    return events;
  }

  private async readDeploymentDetail(deploymentId: SiteFlowId): Promise<DeploymentDetailReadModel> {
    const result = await this.pool.query<DeploymentInspectRow>(
      `
        SELECT
          deployment.id,
          deployment.project_id,
          deployment.source_branch,
          deployment.source_commit_sha,
          deployment.source_event_id,
          deployment.build_job_id,
          deployment.status AS deployment_status,
          deployment.artifact_root,
          deployment.checksum,
          deployment.file_count,
          deployment.total_bytes,
          deployment.preview_host,
          deployment.artifact_manifest,
          deployment.created_at AS deployment_created_at,
          project.slug AS project_slug,
          project.name AS project_name,
          project.status AS project_status,
          project.framework AS project_framework,
          project.default_branch AS project_default_branch,
          project.production_branch AS project_production_branch,
          project.repository AS project_repository,
          project.build_settings AS project_build_settings,
          project.created_at AS project_created_at,
          project.updated_at AS project_updated_at,
          source.kind AS source_kind,
          source.status AS source_status,
          source.disposition AS source_disposition,
          source.provider_delivery_id,
          source.branch AS source_branch_name,
          source.commit_message AS source_commit_message,
          source.commit_author AS source_commit_author,
          source.received_at AS source_received_at,
          source.actor AS source_actor,
          build.status AS build_status,
          build.framework AS build_framework,
          build.install_command,
          build.build_command,
          build.output_directory,
          build.queued_at,
          build.started_at,
          build.finished_at,
          build.worker_id,
          route.id AS route_revision_id,
          route.channel AS route_channel,
          route.previous_deployment_id AS route_previous_deployment_id,
          route.status AS route_status,
          route.generated_config AS route_generated_config,
          route.validation_summary AS route_validation_summary,
          route.release_evidence AS route_release_evidence,
          route.created_at AS route_created_at,
          route.applied_at AS route_applied_at,
          route.failed_reason AS route_failed_reason
        FROM siteflow_deployments deployment
        JOIN siteflow_projects project ON project.id = deployment.project_id
        LEFT JOIN siteflow_source_events source ON source.id = deployment.source_event_id
        LEFT JOIN siteflow_build_jobs build ON build.id = deployment.build_job_id
        LEFT JOIN LATERAL (
          SELECT id, channel, previous_deployment_id, status, generated_config, validation_summary, release_evidence,
                 created_at, applied_at, failed_reason
          FROM siteflow_route_revisions
          WHERE deployment_id = deployment.id
          ORDER BY created_at DESC
          LIMIT 1
        ) route ON true
        WHERE deployment.id = $1
      `,
      [deploymentId]
    );
    const row = result.rows[0];

    if (!row) {
      throw new SiteFlowNotFoundError(`Unknown SiteFlow deployment-detail: ${deploymentId}`);
    }

    const project = projectFromInspectRow(row);
    project.domains = await this.listProjectDomains(project.id);

    const sourceEvent = sourceEventFromInspectRow(row);
    const buildJob = buildJobFromInspectRow(row, sourceEvent, project);
    const artifact = artifactFromInspectRow(row, buildJob);
    const deployment = deploymentFromInspectRow(row, sourceEvent, buildJob);
    const routeRevision = routeRevisionFromInspectRow(row);
    const routeEvidence = routeEvidenceForDetail(routeRevision, deployment);
    const logs = row.build_job_id
      ? await this.readBuildLogChunk(deployment.id).catch(() => emptyLogChunk(deployment.id, buildJob.id))
      : emptyLogChunk(deployment.id, buildJob.id);

    return {
      project,
      deployment,
      lineage: {
        sourceEvent,
        buildJob,
        artifact,
        deployment,
        routeRevision
      },
      evidence: detailEvidence(sourceEvent, buildJob, artifact, deployment, routeRevision),
      routeEvidence,
      logs,
      auditEvents: []
    };
  }

  private async readProject(projectId: SiteFlowId): Promise<Project> {
    const result = await this.pool.query<ProjectRow>(
      `
        SELECT id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
        FROM siteflow_projects
        WHERE id = $1
      `,
      [projectId]
    );
    const row = result.rows[0];

    if (!row) {
      throw new SiteFlowNotFoundError(`Unknown project: ${projectId}`);
    }

    const project = projectFromRow(row);
    project.domains = await this.listProjectDomains(project.id);

    return project;
  }

  private async listProjectEnvironments(projectId: SiteFlowId): Promise<ProjectEnvironment[]> {
    const result = await this.pool.query<EnvironmentRow>(
      `
        SELECT project_id, name, type, branch_pattern, created_at, updated_at
        FROM siteflow_project_environments
        WHERE project_id = $1
        ORDER BY
          CASE type
            WHEN 'local' THEN 1
            WHEN 'preview' THEN 2
            WHEN 'production' THEN 3
            ELSE 4
          END,
          name
      `,
      [projectId]
    );

    return result.rows.map(environmentFromRow);
  }

  private async listEnvironmentVariables(projectId: SiteFlowId): Promise<EnvironmentVariableMetadata[]> {
    const result = await this.pool.query<EnvironmentVariableRow>(
      `
        SELECT id, project_id, key, target_environment, scope, source, fingerprint, updated_by, updated_at
        FROM siteflow_environment_variables
        WHERE project_id = $1
        ORDER BY target_environment, key, scope
      `,
      [projectId]
    );

    return result.rows.map(variableFromRow);
  }

  private async listTeamMembers(projectId: SiteFlowId): Promise<TeamMember[]> {
    const result = await this.pool.query<TeamMemberRow>(
      `
        SELECT id, project_id, actor, role, permissions, created_at, updated_at
        FROM siteflow_team_members
        WHERE project_id = $1
        ORDER BY
          CASE role
            WHEN 'owner' THEN 1
            WHEN 'member' THEN 2
            WHEN 'developer' THEN 3
            ELSE 4
          END,
          updated_at DESC
      `,
      [projectId]
    );

    return result.rows.map(teamMemberFromRow);
  }

  private async listApiTokens(projectId: SiteFlowId): Promise<ApiToken[]> {
    const result = await this.pool.query<ApiTokenRow>(
      `
        SELECT id, project_id, name, token_prefix, scopes, status, created_by,
               created_at, updated_at, revoked_at, last_used_at
        FROM siteflow_api_tokens
        WHERE project_id = $1 OR project_id IS NULL
        ORDER BY status, updated_at DESC
      `,
      [projectId]
    );

    return result.rows.map(apiTokenFromRow);
  }

  private async listAuditEvents(projectId: SiteFlowId, limit = 50): Promise<AuditEvent[]> {
    const result = await this.pool.query<AuditEventRow>(
      `
        SELECT id, project_id, action, actor, target_type, target_id, summary, reason, metadata, created_at
        FROM siteflow_audit_events
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [projectId, limit]
    );

    return result.rows.map(auditEventFromRow);
  }

  private async listProjectDomains(projectId: SiteFlowId): Promise<DomainBinding[]> {
    const result = await this.pool.query<DomainRow>(
      `
        SELECT project_id, hostname, channel, verified, last_checked_at
        FROM siteflow_project_domains
        WHERE project_id = $1
        ORDER BY
          CASE channel
            WHEN 'production' THEN 1
            WHEN 'staging' THEN 2
            WHEN 'preview' THEN 3
            ELSE 4
          END,
          hostname
      `,
      [projectId]
    );

    return result.rows.map(domainFromRow);
  }

  private async replaceProjectDomains(client: Queryable, projectId: SiteFlowId, domains: DomainBinding[]) {
    const normalizedDomains = normalizeProjectDomains(domains);

    await client.query("DELETE FROM siteflow_project_domains WHERE project_id = $1", [projectId]);

    for (const domain of normalizedDomains) {
      await client.query(
        `
          INSERT INTO siteflow_project_domains (
            project_id,
            hostname,
            channel,
            verified,
            last_checked_at
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (project_id, hostname) DO UPDATE
          SET channel = EXCLUDED.channel,
              verified = EXCLUDED.verified,
              last_checked_at = EXCLUDED.last_checked_at,
              updated_at = now()
        `,
        [projectId, domain.hostname, domain.channel, domain.verified, domain.lastCheckedAt]
      );
    }
  }

  private async findOrCreateProjectForSourceEvent(command: GitWebhookCommand): Promise<Project> {
    const repository = command.event.repository;
    const result = await this.pool.query<ProjectRow>(
      `
        SELECT id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
        FROM siteflow_projects
        WHERE repository->>'provider' = $1
          AND repository->>'owner' = $2
          AND repository->>'name' = $3
          AND status = 'active'
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [repository.provider, repository.owner, repository.name]
    );

    if (result.rows[0]) {
      const project = projectFromRow(result.rows[0]);
      const mergedRepository = mergeRepositoryBinding(project.repository, repository);
      const updated = await this.pool.query<ProjectRow>(
        `
          UPDATE siteflow_projects
          SET repository = $2::jsonb,
              updated_at = now()
          WHERE id = $1
          RETURNING id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
        `,
        [project.id, JSON.stringify(mergedRepository)]
      );

      return projectFromRow(updated.rows[0] ?? result.rows[0]);
    }

    return (await this.createProject({
      slug: repository.name,
      name: repository.name,
      framework: "static",
      defaultBranch: repository.defaultBranch,
      productionBranch: repository.defaultBranch,
      repository
    })).project;
  }

  private async readSourceEventByDelivery(provider: string, deliveryId: string): Promise<SourceEvent | undefined> {
    const result = await this.pool.query<SourceEventRow>(
      `
        SELECT id, project_id, kind, status, disposition, provider_delivery_id, branch, commit_sha, commit_message, commit_author,
               pull_request_number, received_at, actor
        FROM siteflow_source_events
        WHERE provider = $1 AND provider_delivery_id = $2
      `,
      [provider, deliveryId]
    );
    const row = result.rows[0];

    return row ? sourceEventFromRow(row) : undefined;
  }

  private async readBuildJobIdForSource(sourceEventId: SiteFlowId): Promise<SiteFlowId | undefined> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM siteflow_build_jobs WHERE source_event_id = $1",
      [sourceEventId]
    );

    return result.rows[0]?.id;
  }

  private async queryObservabilityLogEntries(command: {
    projectId: SiteFlowId;
    source?: ObservabilityLogSource;
    sources?: ObservabilityLogSource[];
    severity?: ObservabilityLogSeverity;
    deploymentId?: SiteFlowId;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ entries: ObservabilityLogEntry[]; total: number; nextCursor?: string }> {
    const limit = normalizeLogLimit(command.limit);
    const offset = normalizeLogCursor(command.cursor);
    const source = normalizeLogSource(command.source);
    const sources = command.sources?.map((entry) => normalizeLogSource(entry) as ObservabilityLogSource);
    const severity = normalizeLogSeverity(command.severity);
    const severityRank = severity === undefined ? undefined : observabilitySeverityRank[severity];
    const search = normalizeLogSearch(command.search);
    const result = await this.pool.query<ObservabilityLogRow>(
      `
        WITH entries AS (
          SELECT
            ('buildlog_' || build_log.id::text) AS id,
            build.project_id,
            'build'::text AS source,
            CASE
              WHEN build_log.line ~* '(error|failed|exception)' OR build.status IN ('failed', 'timed_out', 'canceled') THEN 'error'
              WHEN build_log.line ~* '(warn|warning|deprecated)' THEN 'warning'
              ELSE 'info'
            END AS severity,
            build_log.line AS message,
            build_log.created_at AS occurred_at,
            deployment.id AS deployment_id,
            build.id AS build_job_id,
            NULL::text AS cron_job_id,
            NULL::text AS request_id,
            jsonb_build_object('buildStatus', build.status, 'buildLogId', build_log.id) AS metadata
          FROM siteflow_build_logs build_log
          JOIN siteflow_build_jobs build ON build.id = build_log.build_job_id
          LEFT JOIN siteflow_deployments deployment ON deployment.build_job_id = build.id
          WHERE build.project_id = $1

          UNION ALL

          SELECT
            invocation.id,
            invocation.project_id,
            'function'::text AS source,
            CASE WHEN invocation.status = 'failed' OR invocation.response_status >= 500 THEN 'error' ELSE 'info' END AS severity,
            CONCAT(invocation.method, ' ', invocation.path, ' completed with status ', invocation.response_status) AS message,
            invocation.invoked_at AS occurred_at,
            invocation.deployment_id,
            NULL::text AS build_job_id,
            NULL::text AS cron_job_id,
            invocation.request_id,
            jsonb_build_object(
              'durationMs', invocation.duration_ms,
              'errorMessage', invocation.error_message,
              'logs', invocation.logs
            ) AS metadata
          FROM siteflow_function_invocations invocation
          WHERE invocation.project_id = $1

          UNION ALL

          SELECT
            ('functionlog_' || invocation.id || '_' || log_line.ordinality::text) AS id,
            invocation.project_id,
            'function'::text AS source,
            CASE
              WHEN invocation.status = 'failed' OR invocation.response_status >= 500 OR log_line.value ~* '(error|failed|exception)' THEN 'error'
              WHEN log_line.value ~* '(warn|warning|deprecated)' THEN 'warning'
              ELSE 'info'
            END AS severity,
            log_line.value AS message,
            invocation.invoked_at AS occurred_at,
            invocation.deployment_id,
            NULL::text AS build_job_id,
            NULL::text AS cron_job_id,
            invocation.request_id,
            jsonb_build_object('responseStatus', invocation.response_status, 'durationMs', invocation.duration_ms) AS metadata
          FROM siteflow_function_invocations invocation
          CROSS JOIN LATERAL jsonb_array_elements_text(invocation.logs) WITH ORDINALITY AS log_line(value, ordinality)
          WHERE invocation.project_id = $1

          UNION ALL

          SELECT
            dispatch.id,
            dispatch.project_id,
            'cron'::text AS source,
            CASE WHEN dispatch.status = 'failed' OR dispatch.error_message IS NOT NULL THEN 'error' ELSE 'info' END AS severity,
            CASE
              WHEN dispatch.error_message IS NOT NULL THEN CONCAT('Cron dispatch failed for ', dispatch.target_url, ': ', dispatch.error_message)
              ELSE CONCAT('Cron dispatch ', dispatch.status, ' for ', dispatch.target_url)
            END AS message,
            dispatch.dispatched_at AS occurred_at,
            NULL::text AS deployment_id,
            NULL::text AS build_job_id,
            dispatch.cron_job_id,
            NULL::text AS request_id,
            jsonb_build_object(
              'responseStatus', dispatch.response_status,
              'reason', dispatch.reason,
              'userAgent', dispatch.user_agent
            ) AS metadata
          FROM siteflow_cron_dispatches dispatch
          WHERE dispatch.project_id = $1
        ),
        filtered AS (
          SELECT *
          FROM entries
          WHERE ($2::text IS NULL OR source = $2)
            AND ($3::text[] IS NULL OR source = ANY($3))
            AND ($4::integer IS NULL OR CASE severity
                  WHEN 'info' THEN 0
                  WHEN 'warning' THEN 1
                  ELSE 2
                END >= $4)
            AND ($5::text IS NULL OR deployment_id = $5)
            AND ($6::text IS NULL OR message ILIKE ('%' || $6 || '%'))
        )
        SELECT
          id,
          project_id,
          source,
          severity,
          message,
          occurred_at,
          deployment_id,
          build_job_id,
          cron_job_id,
          request_id,
          metadata,
          COUNT(*) OVER() AS total_count
        FROM filtered
        ORDER BY occurred_at DESC, id DESC
        OFFSET $7
        LIMIT $8
      `,
      [
        command.projectId,
        source ?? null,
        sources && sources.length > 0 ? sources : null,
        severityRank ?? null,
        command.deploymentId ?? null,
        search ?? null,
        offset,
        limit + 1
      ]
    );
    const rows = result.rows.slice(0, limit);
    const total = result.rows[0]?.total_count === undefined ? offset + rows.length : pgNumber(result.rows[0].total_count);

    return {
      entries: rows.map(observabilityLogEntryFromRow),
      total,
      nextCursor: result.rows.length > limit ? String(offset + limit) : undefined
    };
  }

  private async nextLogDrainDeliveryAttempt(client: Queryable, drainId: SiteFlowId) {
    const result = await client.query<{ attempt: string | number | null }>(
      "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM siteflow_log_drain_deliveries WHERE drain_id = $1",
      [drainId]
    );

    return pgNumber(result.rows[0]?.attempt ?? 1);
  }

  private async readBuildLogChunk(deploymentId: SiteFlowId, cursor?: string): Promise<LogChunkReadModel> {
    const deployment = await this.pool.query<DeploymentBuildRow>(
      "SELECT build_job_id FROM siteflow_deployments WHERE id = $1",
      [deploymentId]
    );
    const buildJobId = deployment.rows[0]?.build_job_id;

    if (!deployment.rows[0]) {
      throw new SiteFlowNotFoundError(`Unknown SiteFlow log-chunk: ${logChunkKey(deploymentId, cursor)}`);
    }

    if (!buildJobId) {
      throw new SiteFlowNotFoundError(`Deployment has no build log stream: ${deploymentId}`);
    }

    const tail = await this.readBuildLogTail(buildJobId, cursor);
    const nextCursor = tail.hasMore ? tail.nextCursor : undefined;

    return {
      deploymentId,
      chunk: {
        deploymentId,
        buildJobId,
        cursor: cursor ?? "0",
        lines: tail.rows.map((row) => row.line),
        nextCursor,
        complete: !tail.hasMore,
        fetchedAt: new Date().toISOString()
      },
      nextCursor,
      hasMore: tail.hasMore
    };
  }

  private async readBuildLogTail(buildJobId: SiteFlowId, cursor?: string): Promise<{ rows: BuildLogRow[]; nextCursor: string; hasMore: boolean }> {
    const cursorId = cursor && /^\d+$/.test(cursor) ? cursor : "0";
    const pageSize = 100;
    const result = await this.pool.query<BuildLogRow>(
      `
        SELECT id::text, line
        FROM siteflow_build_logs
        WHERE build_job_id = $1 AND id > $2::bigint
        ORDER BY id ASC
        LIMIT $3
      `,
      [buildJobId, cursorId, pageSize + 1]
    );
    const rows = result.rows.slice(0, pageSize);
    const hasMore = result.rows.length > pageSize;
    const nextCursor = rows[rows.length - 1]?.id ?? cursorId;

    return { rows, nextCursor, hasMore };
  }

  private async ensureDefaultEnvironments(client: Queryable, projectId: SiteFlowId, productionBranch: string) {
    const environments = [
      ["local", "local", null],
      ["preview", "preview", "*"],
      ["production", "production", productionBranch]
    ];

    for (const [name, type, branchPattern] of environments) {
      await client.query(
        `
          INSERT INTO siteflow_project_environments (project_id, name, type, branch_pattern)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (project_id, name) DO UPDATE
          SET type = EXCLUDED.type,
              branch_pattern = EXCLUDED.branch_pattern,
              updated_at = now()
        `,
        [projectId, name, type, branchPattern]
      );
    }
  }

  private async ensureProjectExists(client: Queryable, projectId: SiteFlowId) {
    const result = await client.query<{ id: string }>(
      "SELECT id FROM siteflow_projects WHERE id = $1",
      [projectId]
    );

    if (!result.rows[0]) {
      throw new SiteFlowNotFoundError(`Unknown project: ${projectId}`);
    }
  }

  private async readReleaseCommandByIdempotencyKey(client: Queryable, idempotencyKey: string) {
    const result = await client.query<ReleaseCommandRow>(
      `
        SELECT idempotency_key, operation_id, action, project_id, channel, current_deployment_id,
               target_deployment_id, state, actor, reason, message, route_revision_id, release_evidence,
               created_at, updated_at
        FROM siteflow_release_commands
        WHERE idempotency_key = $1
        FOR UPDATE
      `,
      [idempotencyKey]
    );

    return result.rows[0];
  }

  private async insertReleaseCommand(
    client: Queryable,
    input: ReleaseCommandInsertInput
  ): Promise<ReleaseCommandInsertResult> {
    const result = await client.query<ReleaseCommandRow>(
      `
        INSERT INTO siteflow_release_commands (
          idempotency_key,
          operation_id,
          action,
          project_id,
          channel,
          current_deployment_id,
          target_deployment_id,
          actor,
          reason,
          state,
          message,
          route_revision_id,
          release_evidence
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key, operation_id, action, project_id, channel, current_deployment_id,
                  target_deployment_id, state, actor, reason, message, route_revision_id, release_evidence,
                  created_at, updated_at
      `,
      [
        input.idempotencyKey,
        input.operationId,
        input.action,
        input.projectId,
        input.channel,
        input.currentDeploymentId,
        input.targetDeploymentId,
        JSON.stringify(input.actor),
        input.reason,
        input.state,
        input.message,
        input.routeRevisionId ?? null,
        input.releaseEvidenceJson ?? null
      ]
    );
    const inserted = result.rows[0];

    if (inserted) {
      return { row: inserted, inserted: true };
    }

    const existing = await this.readReleaseCommandByIdempotencyKey(client, input.idempotencyKey);

    if (!existing) {
      throw new Error(`Release command idempotency key ${input.idempotencyKey} conflicted but no command row could be read.`);
    }

    return { row: existing, inserted: false };
  }

  private async lockReleaseCommandIdempotencyKey(client: Queryable, idempotencyKey: string) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [releaseCommandLockNamespace, idempotencyKey]
    );
  }

  private async lockReleaseChannelScope(client: Queryable, projectId: SiteFlowId, channel: ReleaseChannelName) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [releaseChannelLockNamespace, `${projectId}:${channel}`]
    );
  }

  private async readRouteRevision(client: Queryable, routeRevisionId: SiteFlowId): Promise<RouteRevision | undefined> {
    const result = await client.query<RouteRevisionRow>(
      `
        SELECT id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
               validation_summary, release_evidence, created_at, applied_at, failed_reason
        FROM siteflow_route_revisions
        WHERE id = $1
      `,
      [routeRevisionId]
    );
    const row = result.rows[0];

    return row ? routeRevisionFromRow(row) : undefined;
  }

  private async readRouteRevisionByIdempotencyKey(client: Queryable, idempotencyKey: string): Promise<RouteRevision | undefined> {
    const result = await client.query<RouteRevisionRow>(
      `
        SELECT id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
               validation_summary, release_evidence, created_at, applied_at, failed_reason
        FROM siteflow_route_revisions
        WHERE idempotency_key = $1
      `,
      [idempotencyKey]
    );
    const row = result.rows[0];

    return row ? routeRevisionFromRow(row) : undefined;
  }

  private async readActiveRollingRelease(
    client: Queryable,
    projectId: SiteFlowId,
    channel: ReleaseChannelName,
    lock = false
  ): Promise<RollingReleaseRow | undefined> {
    const result = await client.query<RollingReleaseRow>(
      `
        SELECT id, project_id, channel, current_deployment_id, candidate_deployment_id, percentage,
               status, actor, reason, route_revision_id, created_at, updated_at, completed_at, aborted_at
        FROM siteflow_rolling_releases
        WHERE project_id = $1
          AND channel = $2
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
        ${lock ? "FOR UPDATE" : ""}
      `,
      [projectId, channel]
    );

    return result.rows[0];
  }

  private async readDeploymentSummary(deploymentId: SiteFlowId): Promise<DeploymentSummaryReadModel> {
    const result = await this.pool.query<DeploymentSummaryRow>(
      `
        SELECT
          deployment.id,
          deployment.project_id,
          project.name AS project_name,
          deployment.source_branch,
          deployment.source_commit_sha,
          deployment.preview_host,
          deployment.status,
          deployment.checksum,
          deployment.file_count,
          deployment.total_bytes,
          deployment.artifact_manifest,
          deployment.created_at,
          route.id AS route_revision_id,
          route.status AS route_revision_status
        FROM siteflow_deployments deployment
        JOIN siteflow_projects project ON project.id = deployment.project_id
        LEFT JOIN LATERAL (
          SELECT id, status
          FROM siteflow_route_revisions
          WHERE deployment_id = deployment.id
          ORDER BY created_at DESC
          LIMIT 1
        ) route ON true
        WHERE deployment.id = $1
      `,
      [deploymentId]
    );
    const row = result.rows[0];

    if (!row) {
      throw new SiteFlowNotFoundError(`Unknown SiteFlow deployment: ${deploymentId}`);
    }

    return deploymentSummaryFromRow(row, this.publicScheme);
  }

  private async insertRollingRouteRevision(
    client: Queryable,
    rolloutId: SiteFlowId,
    command: RollingCommand,
    currentDeploymentId: SiteFlowId,
    candidateDeploymentId: SiteFlowId,
    percentage: number,
    domains: DomainBinding[],
    summary: string,
    routeDeploymentId = candidateDeploymentId
  ): Promise<RouteRevision> {
    const routeRevisionId = stableId("route", `${command.idempotencyKey}:rolling:${rolloutId}:${percentage}`);
    const idempotencyKey = `${command.idempotencyKey}:rolling:${rolloutId}:${percentage}`;
    const releaseEvidence = "releaseEvidenceException" in command
      ? undefined
      : releaseEvidenceMetadataForStorage(command.releaseEvidence);
    const releaseEvidenceException = "releaseEvidenceException" in command
      ? command.releaseEvidenceException
      : undefined;
    const result = await client.query<RouteRevisionRow>(
      `
        INSERT INTO siteflow_route_revisions (
          id,
          project_id,
          channel,
          deployment_id,
          previous_deployment_id,
          status,
          generated_config,
          validation_summary,
          actor,
          reason,
          release_evidence,
          idempotency_key,
          applied_at
        )
        VALUES ($1, $2, $3, $4, $5, 'applied', $6, $7, $8::jsonb, $9, $10::jsonb, $11, now())
        ON CONFLICT (idempotency_key) DO UPDATE
        SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
                  validation_summary, release_evidence, created_at, applied_at, failed_reason
      `,
      [
        routeRevisionId,
        command.projectId,
        command.channel,
        routeDeploymentId,
        currentDeploymentId,
        rollingGeneratedConfig(
          rolloutId,
          command.projectId,
          command.channel,
          currentDeploymentId,
          candidateDeploymentId,
          percentage,
          domains,
          releaseEvidenceException
        ),
        summary,
        JSON.stringify(command.actor),
        command.reason.trim(),
        releaseEvidence ? JSON.stringify(releaseEvidence) : null,
        idempotencyKey
      ]
    );

    return routeRevisionFromRow(result.rows[0]);
  }

  private async readDeploymentForRoute(client: Queryable, deploymentId: SiteFlowId) {
    const result = await client.query<DeploymentRouteRow>(
      `
        SELECT
          deployment.id,
          deployment.project_id,
          deployment.status,
          deployment.source_type,
          deployment.source_branch,
          deployment.source_commit_sha,
          deployment.artifact_manifest->'metadata'->'source'->>'repository' AS source_repository,
          project.repository AS project_repository,
          deployment.artifact_root,
          COALESCE(route.entrypoint, deployment.artifact_manifest->>'entrypoint', 'index.html') AS entrypoint,
          deployment.preview_host,
          deployment.artifact_manifest
        FROM siteflow_deployments deployment
        JOIN siteflow_projects project
          ON project.id = deployment.project_id
        LEFT JOIN siteflow_artifact_routes route
          ON route.deployment_id = deployment.id
         AND route.host = deployment.preview_host
        WHERE deployment.id = $1
        LIMIT 1
      `,
      [deploymentId]
    );

    return result.rows[0];
  }

  private async readReleaseChannel(client: Queryable, projectId: SiteFlowId, channel: ReleaseChannelName, lock = true) {
    const result = await client.query<ReleaseChannelRow>(
      `
        SELECT project_id, name, current_deployment_id, pending_deployment_id, route_revision_id, updated_by, updated_at
        FROM siteflow_release_channels
        WHERE project_id = $1 AND name = $2
        ${lock ? "FOR UPDATE" : ""}
      `,
      [projectId, channel]
    );

    return result.rows[0];
  }

  private async listVerifiedDomainsForChannel(client: Queryable, projectId: SiteFlowId, channel: ReleaseChannelName) {
    const result = await client.query<DomainRow>(
      `
        SELECT project_id, hostname, channel, verified, last_checked_at
        FROM siteflow_project_domains
        WHERE project_id = $1
          AND channel = $2
          AND verified = true
        ORDER BY hostname
      `,
      [projectId, channel]
    );

    return result.rows.map(domainFromRow);
  }

  private async updateRollingRelease(
    action: RollingAction,
    command: AdvanceRollingReleaseCommand | CompleteRollingReleaseCommand | AbortRollingReleaseCommand
  ): Promise<RollingReleaseCommandReadModel> {
    assertRollingCommand(command);
    assertReleaseChannelName(command.channel);

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await this.ensureProjectExists(client, command.projectId);

      const rollout = await this.readActiveRollingRelease(client, command.projectId, command.channel, true);

      if (!rollout) {
        await client.query("COMMIT");
        return {
          status: "rejected",
          safetyChecks: [
            {
              id: "check-active-rollout",
              label: "Active rollout",
              status: "fail",
              summary: "No active rolling release exists for this channel."
            }
          ],
          message: "Rolling release rejected: no active rollout."
        };
      }

      const nextPercentage = action === "advance"
        ? normalizeRolloutPercentage((command as AdvanceRollingReleaseCommand).percentage)
        : action === "complete"
          ? 100
          : rollout.percentage;

      if (action === "advance" && nextPercentage <= rollout.percentage) {
        await client.query("COMMIT");
        return {
          status: "rejected",
          rollout: rollingReleaseFromRow(rollout),
          safetyChecks: [
            {
              id: "check-rollout-increase",
              label: "Rollout percentage increases",
              status: "fail",
              summary: `Rolling release is already at ${rollout.percentage}%.`
            }
          ],
          message: "Rolling release rejected: percentage must increase."
        };
      }

      const current = await this.readDeploymentForRoute(client, rollout.current_deployment_id);
      const candidate = await this.readDeploymentForRoute(client, rollout.candidate_deployment_id);
      const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, command.channel);
      const releaseEvidence = action === "abort"
        ? undefined
        : releaseEvidenceMetadataForStorage(command.releaseEvidence);
      const releaseEvidenceException = "releaseEvidenceException" in command
        ? command.releaseEvidenceException
        : undefined;
      const safetyChecks: SafetyCheck[] = [
        {
          id: "check-active-rollout",
          label: "Active rollout",
          status: "pass",
          summary: `Rolling release ${rollout.id} is active.`
        },
        {
          id: "check-current-deployment-ready",
          label: "Current deployment ready",
          status: current?.status === "ready" ? "pass" : "fail",
          summary: current ? `Current deployment ${current.id} is ${current.status}.` : "Current deployment does not exist."
        },
        ...safetyChecksForRoute(command.projectId, candidate, domains, command.channel),
        ...(action === "abort" ? [] : releaseEvidenceIdentityCheck(candidate, releaseEvidence, command.channel)),
        ...productionRollingAbortReleaseEvidenceExceptionCheck(action, command)
      ];
      const failedCheck = safetyChecks.find((check) => check.status === "fail");

      if (failedCheck || !current || !candidate) {
        await client.query("COMMIT");
        return {
          status: "rejected",
          rollout: rollingReleaseFromRow(rollout),
          safetyChecks,
          message: `Rolling release rejected: ${failedCheck?.summary ?? "current or candidate deployment could not be routed"}`
        };
      }

      const routeRevision = await this.insertRollingRouteRevision(
        client,
        rollout.id,
        command,
        current.id,
        candidate.id,
        nextPercentage,
        domains,
        action === "advance"
          ? `Rolling release advanced to ${nextPercentage}%.`
          : action === "complete"
            ? "Rolling release completed and production route applied."
            : "Rolling release aborted; current route preserved.",
        action === "abort" ? current.id : candidate.id
      );

      if (action === "complete") {
        for (const domain of domains) {
          await client.query(
            `
              INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (host) DO UPDATE
              SET deployment_id = EXCLUDED.deployment_id,
                  artifact_root = EXCLUDED.artifact_root,
                  entrypoint = EXCLUDED.entrypoint
            `,
            [domain.hostname, candidate.id, candidate.artifact_root, candidate.entrypoint]
          );
        }

        await client.query(
          `
            INSERT INTO siteflow_release_channels (
              project_id,
              name,
              current_deployment_id,
              pending_deployment_id,
              route_revision_id,
              updated_by
            )
            VALUES ($1, $2, $3, NULL, $4, $5::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET current_deployment_id = EXCLUDED.current_deployment_id,
                pending_deployment_id = NULL,
                route_revision_id = EXCLUDED.route_revision_id,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
          `,
          [command.projectId, command.channel, candidate.id, routeRevision.id, JSON.stringify(command.actor)]
        );
      }

      const updated = await client.query<RollingReleaseRow>(
        `
          UPDATE siteflow_rolling_releases
          SET percentage = $2,
              status = $3,
              actor = $4::jsonb,
              reason = $5,
              route_revision_id = $6,
              updated_at = now(),
              completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
              aborted_at = CASE WHEN $3 = 'aborted' THEN now() ELSE aborted_at END
          WHERE id = $1
          RETURNING id, project_id, channel, current_deployment_id, candidate_deployment_id, percentage,
                    status, actor, reason, route_revision_id, created_at, updated_at, completed_at, aborted_at
        `,
        [
          rollout.id,
          nextPercentage,
          action === "complete" ? "completed" : action === "abort" ? "aborted" : "active",
          JSON.stringify(command.actor),
          command.reason.trim(),
          routeRevision.id
        ]
      );

      if (action === "abort") {
        await insertAuditEvent(client, {
          projectId: command.projectId,
          action: "rolling_release.aborted",
          actor: command.actor,
          targetType: "route_revision",
          targetId: routeRevision.id,
          summary: "Rolling release aborted; current route preserved.",
          reason: command.reason,
          metadata: {
            channel: command.channel,
            rolloutId: rollout.id,
            routeRevisionId: routeRevision.id,
            currentDeploymentId: current.id,
            candidateDeploymentId: candidate.id,
            ...(releaseEvidenceException ? { releaseEvidenceException } : {})
          }
        });
      } else {
        await insertAuditEvent(client, {
          projectId: command.projectId,
          action: action === "advance" ? "rolling_release.advanced" : "rolling_release.completed",
          actor: command.actor,
          targetType: "route_revision",
          targetId: routeRevision.id,
          summary: action === "advance"
            ? `Rolling release advanced to ${nextPercentage}%.`
            : "Rolling release completed and production route applied.",
          reason: command.reason,
          metadata: {
            channel: command.channel,
            rolloutId: rollout.id,
            routeRevisionId: routeRevision.id,
            currentDeploymentId: current.id,
            candidateDeploymentId: candidate.id,
            percentage: nextPercentage,
            releaseEvidence: releaseEvidenceAuditMetadata(releaseEvidence)
          }
        });
      }

      await client.query("COMMIT");

      return {
        status: "accepted",
        rollout: rollingReleaseFromRow(updated.rows[0]),
        routeRevision,
        safetyChecks,
        message: action === "advance"
          ? `Rolling release advanced to ${nextPercentage}%.`
          : action === "complete"
            ? "Rolling release completed."
            : "Rolling release aborted."
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async releaseCommandResultFromRow(
    client: Queryable,
    row: ReleaseCommandRow
  ): Promise<CommandResultReadModel> {
    const routeRevision = row.route_revision_id ? await this.readRouteRevision(client, row.route_revision_id) : undefined;
    const command = {
      projectId: row.project_id,
      channel: row.channel,
      targetDeploymentId: row.target_deployment_id,
      actor: row.actor,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
      currentDeploymentId: row.current_deployment_id ?? undefined
    };

    return {
      status: row.state === "failed" ? "rejected" : "accepted",
      operationId: row.operation_id,
      channelEvent: routeRevision ? channelEventForRoute(row.action, command, routeRevision, []) : undefined,
      routeRevision,
      safetyChecks: [],
      message: row.message
    };
  }

  private async recordReleaseCommand(
    action: ReleaseAction,
    command: PromoteDeploymentCommand | RollbackDeploymentCommand
  ): Promise<CommandResultReadModel> {
    assertReleaseCommand(command);
    assertReleaseChannelName(command.channel);

    const operationId = operationIdFor(command.idempotencyKey);
    const currentDeploymentId = "currentDeploymentId" in command ? command.currentDeploymentId ?? null : null;
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await this.lockReleaseCommandIdempotencyKey(client, command.idempotencyKey);

      const existing = await this.readReleaseCommandByIdempotencyKey(client, command.idempotencyKey);

      if (existing) {
        const existingResult = await this.releaseCommandResultFromRow(client, existing);
        await client.query("COMMIT");
        return existingResult;
      }

      await this.ensureProjectExists(client, command.projectId);
      await this.lockReleaseChannelScope(client, command.projectId, command.channel);

      const deployment = await this.readDeploymentForRoute(client, command.targetDeploymentId);
      const channel = await this.readReleaseChannel(client, command.projectId, command.channel);
      const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, command.channel);
      const releaseEvidence = releaseEvidenceMetadataForStorage(command.releaseEvidence);
      const safetyChecks = [
        ...safetyChecksForRoute(command.projectId, deployment, domains, command.channel),
        ...releaseEvidenceIdentityCheck(deployment, releaseEvidence, command.channel),
        ...(action === "rollback" && command.channel === "production" && !currentDeploymentId
          ? [
              {
                id: "check-current-deployment-present",
                label: "Current deployment present",
                status: "fail" as const,
                summary: "Production rollback requires currentDeploymentId to guard against channel drift."
              }
            ]
          : [])
      ];
      const previousDeploymentId = channel?.current_deployment_id ?? null;
      const releaseEvidenceJson = releaseEvidence ? JSON.stringify(releaseEvidence) : null;

      if (currentDeploymentId && channel?.current_deployment_id && currentDeploymentId !== channel.current_deployment_id) {
        safetyChecks.push({
          id: "check-current-deployment-match",
          label: "Current deployment match",
          status: "fail",
          summary: `Channel currently points to ${channel.current_deployment_id}, not ${currentDeploymentId}.`
        });
      }

      const failedCheck = safetyChecks.find((check) => check.status === "fail");

      if (failedCheck || !deployment) {
        const message = `${releaseVerb(action)} rejected: ${failedCheck?.summary ?? "target deployment could not be routed"}`;

        const insertedCommand = await this.insertReleaseCommand(client, {
          idempotencyKey: command.idempotencyKey,
          operationId,
          action,
          projectId: command.projectId,
          channel: command.channel,
          currentDeploymentId,
          targetDeploymentId: command.targetDeploymentId,
          actor: command.actor,
          reason: command.reason.trim(),
          state: "failed",
          message,
          releaseEvidenceJson
        });

        if (!insertedCommand.inserted) {
          const existingResult = await this.releaseCommandResultFromRow(client, insertedCommand.row);
          await client.query("COMMIT");
          return existingResult;
        }

        await client.query("COMMIT");

        return {
          status: "rejected",
          operationId,
          safetyChecks,
          message
        };
      }

      const dryRun = Boolean(command.dryRun);
      const routeRevisionId = stableId("route", command.idempotencyKey);
      const routeStatus: RouteRevision["status"] = dryRun ? "planned" : "applied";
      const generatedConfig = routeGeneratedConfig(command.projectId, command.channel, deployment, domains);
      const validationSummary = dryRun
        ? `${releaseVerb(action)} route validated for ${domains.length} domain${domains.length === 1 ? "" : "s"}; no route was applied.`
        : `${releaseVerb(action)} route applied to ${domains.length} domain${domains.length === 1 ? "" : "s"}.`;
      const routeRevisionResult = await client.query<RouteRevisionRow>(
        `
          INSERT INTO siteflow_route_revisions (
            id,
            project_id,
            channel,
            deployment_id,
            previous_deployment_id,
            status,
            generated_config,
            validation_summary,
            actor,
            reason,
            release_evidence,
            idempotency_key,
            applied_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12, CASE WHEN $13 THEN NULL ELSE now() END)
          ON CONFLICT (idempotency_key) DO UPDATE
          SET idempotency_key = EXCLUDED.idempotency_key
          RETURNING id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
                    validation_summary, release_evidence, created_at, applied_at, failed_reason
        `,
        [
          routeRevisionId,
          command.projectId,
          command.channel,
          deployment.id,
          previousDeploymentId,
          routeStatus,
          generatedConfig,
          validationSummary,
          JSON.stringify(command.actor),
          command.reason.trim(),
          releaseEvidenceJson,
          command.idempotencyKey,
          dryRun
        ]
      );
      const routeRevision = routeRevisionFromRow(routeRevisionResult.rows[0]);

      if (!dryRun) {
        for (const domain of domains) {
          await client.query(
            `
              INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (host) DO UPDATE
              SET deployment_id = EXCLUDED.deployment_id,
                  artifact_root = EXCLUDED.artifact_root,
                  entrypoint = EXCLUDED.entrypoint
            `,
            [domain.hostname, deployment.id, deployment.artifact_root, deployment.entrypoint]
          );
        }

        await client.query(
          `
            INSERT INTO siteflow_release_channels (
              project_id,
              name,
              current_deployment_id,
              pending_deployment_id,
              route_revision_id,
              updated_by
            )
            VALUES ($1, $2, $3, NULL, $4, $5::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET current_deployment_id = EXCLUDED.current_deployment_id,
                pending_deployment_id = NULL,
                route_revision_id = EXCLUDED.route_revision_id,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
          `,
          [command.projectId, command.channel, deployment.id, routeRevision.id, JSON.stringify(command.actor)]
        );
      }

      const message = dryRun
        ? `${releaseVerb(action)} dry run completed.`
        : `${releaseVerb(action)} route applied.`;

      const insertedCommand = await this.insertReleaseCommand(client, {
        idempotencyKey: command.idempotencyKey,
        operationId,
        action,
        projectId: command.projectId,
        channel: command.channel,
        currentDeploymentId: previousDeploymentId,
        targetDeploymentId: command.targetDeploymentId,
        actor: command.actor,
        reason: command.reason.trim(),
        state: "succeeded",
        message,
        routeRevisionId: routeRevision.id,
        releaseEvidenceJson
      });

      if (!insertedCommand.inserted) {
        const existingResult = await this.releaseCommandResultFromRow(client, insertedCommand.row);
        await client.query("COMMIT");
        return existingResult;
      }

      if (!dryRun) {
        await insertAuditEvent(client, {
          projectId: command.projectId,
          action: action === "promote" ? "deployment.promoted" : "deployment.rolled_back",
          actor: command.actor,
          targetType: "route_revision",
          targetId: routeRevision.id,
          summary: action === "promote"
            ? `Deployment ${deployment.id} promoted to ${command.channel}.`
            : `Deployment ${deployment.id} rolled back to ${command.channel}.`,
          reason: command.reason,
          metadata: {
            channel: command.channel,
            routeRevisionId: routeRevision.id,
            previousDeploymentId,
            targetDeploymentId: deployment.id,
            releaseEvidence: releaseEvidenceAuditMetadata(releaseEvidence)
          }
        });
      }

      await client.query("COMMIT");

      return {
        status: "accepted",
        operationId,
        channelEvent: channelEventForRoute(action, command, routeRevision, safetyChecks),
        routeRevision,
        safetyChecks,
        message
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
