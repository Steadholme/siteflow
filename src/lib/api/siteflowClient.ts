import type {
  Actor,
  AnalyticsEventKind,
  BlobAccess,
  EnvironmentVariableScope,
  FirewallRuleAction,
  FirewallRuleCondition,
  ImageOptimizationFormat,
  ObservabilityLogSeverity,
  ObservabilityLogSource,
  ReleaseChannelName,
  RedirectStatusCode,
  RoutingHeader,
  RoutingRuleKind,
  SiteFlowId,
  SourceEventInput,
  WebVitalName
} from "../../domain/siteflow.js";
import type {
  AnalyticsDashboardReadModel,
  AnalyticsIngestReadModel,
  BlobDeleteReadModel,
  BlobListReadModel,
  BlobPutReadModel,
  BlobReadModel,
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
  EdgeConfigMutationReadModel,
  EdgeConfigReadModel,
  FirewallRuleListReadModel,
  FirewallRuleMutationReadModel,
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
  ProjectDetailReadModel,
  ProjectEnvironmentSettingsReadModel,
  ProjectEnvironmentVariableUpsertReadModel,
  ProjectListReadModel,
  ProjectMutationReadModel,
  ProjectCommandBase,
  ProjectSettingsReadModel,
  ReleaseConsoleReadModel,
  RollingReleaseCommandReadModel,
  RollingReleaseReadModel,
  RollbackConsoleReadModel,
  RoutingRuleListReadModel,
  RoutingRuleMatchReadModel,
  RoutingRuleMutationReadModel,
  SavedLogQueryListReadModel,
  SavedLogQueryMutationReadModel,
  TeamMemberMutationReadModel
} from "../../domain/readModels.js";

export interface ReleaseCommandBase {
  projectId: SiteFlowId;
  channel: ReleaseChannelName;
  targetDeploymentId: SiteFlowId;
  actor: Actor;
  reason: string;
  idempotencyKey: string;
}

export interface PromoteDeploymentCommand extends ReleaseCommandBase {
  dryRun?: boolean;
}

export interface RollbackDeploymentCommand extends ReleaseCommandBase {
  currentDeploymentId?: SiteFlowId;
  dryRun?: boolean;
}

export interface CreateDeployHookCommand {
  projectId: SiteFlowId;
  name: string;
  branch?: string;
  targetEnvironment?: string;
  actor?: Actor;
}

export interface RevokeDeployHookCommand {
  projectId: SiteFlowId;
  hookId: SiteFlowId;
  actor?: Actor;
  reason?: string;
}

export interface TriggerDeployHookCommand {
  token: string;
  ref?: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
  actor?: Actor;
  idempotencyKey?: string;
}

export interface CreateCronJobCommand {
  projectId: SiteFlowId;
  name: string;
  path: string;
  schedule: string;
  actor?: Actor;
}

export interface DisableCronJobCommand {
  projectId: SiteFlowId;
  jobId: SiteFlowId;
  actor?: Actor;
  reason?: string;
}

export interface RunCronJobCommand {
  projectId: SiteFlowId;
  jobId: SiteFlowId;
  actor?: Actor;
  reason?: string;
  idempotencyKey?: string;
}

export interface RollingReleaseCommandBase {
  projectId: SiteFlowId;
  channel: ReleaseChannelName;
  actor: Actor;
  reason: string;
  idempotencyKey: string;
}

export interface StartRollingReleaseCommand extends RollingReleaseCommandBase {
  candidateDeploymentId: SiteFlowId;
  percentage: number;
}

export interface AdvanceRollingReleaseCommand extends RollingReleaseCommandBase {
  percentage: number;
}

export interface CompleteRollingReleaseCommand extends RollingReleaseCommandBase {}

export interface AbortRollingReleaseCommand extends RollingReleaseCommandBase {}

export interface CreateProjectCommand extends ProjectCommandBase {}

export interface UpdateProjectCommand extends Partial<Omit<ProjectCommandBase, "slug">> {
  slug?: string;
}

export interface UpsertEnvironmentVariableCommand {
  projectId: SiteFlowId;
  key: string;
  value?: string;
  targetEnvironment: string;
  scope: EnvironmentVariableScope;
  source?: "sealed" | "external";
  actor?: Actor;
}

export interface UpsertTeamMemberCommand {
  projectId: SiteFlowId;
  actor: Actor;
  role: "owner" | "member" | "developer" | "viewer";
  requestedBy?: Actor;
}

export interface RemoveTeamMemberCommand {
  projectId: SiteFlowId;
  memberId: SiteFlowId;
  requestedBy?: Actor;
  reason?: string;
}

export interface CreateApiTokenCommand {
  projectId?: SiteFlowId;
  name: string;
  scopes: Array<"read" | "write" | "admin">;
  actor?: Actor;
}

export interface RevokeApiTokenCommand {
  projectId?: SiteFlowId;
  tokenId: SiteFlowId;
  actor?: Actor;
  reason?: string;
}

export interface CreateFirewallRuleCommand {
  projectId: SiteFlowId;
  name: string;
  action: FirewallRuleAction;
  priority?: number;
  conditions: FirewallRuleCondition;
  actor?: Actor;
}

export interface DisableFirewallRuleCommand {
  projectId: SiteFlowId;
  ruleId: SiteFlowId;
  actor?: Actor;
  reason?: string;
}

export interface UpsertEdgeConfigCommand {
  projectId: SiteFlowId;
  key: string;
  value: unknown;
  actor?: Actor;
}

export interface DeleteEdgeConfigCommand {
  projectId: SiteFlowId;
  key: string;
  actor?: Actor;
  reason?: string;
}

export interface ListBlobsCommand {
  projectId: SiteFlowId;
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface PutBlobCommand {
  projectId: SiteFlowId;
  pathname: string;
  contentBase64: string;
  contentType?: string;
  access?: BlobAccess;
  cacheControlMaxAge?: number;
  actor?: Actor;
}

export interface GetBlobCommand {
  projectId: SiteFlowId;
  pathname: string;
}

export interface DeleteBlobCommand {
  projectId: SiteFlowId;
  pathname: string;
  actor?: Actor;
  reason?: string;
}

export interface ImageOptimizationUrlCommand {
  source: string;
  width: number;
  quality?: number;
  format?: ImageOptimizationFormat;
}

export interface ListCacheEntriesCommand {
  projectId: SiteFlowId;
  path?: string;
  tag?: string;
  status?: "fresh" | "stale" | "purged";
  limit?: number;
}

export interface PurgeCacheCommand {
  projectId: SiteFlowId;
  path?: string;
  tag?: string;
  actor?: Actor;
  reason?: string;
}

export interface ListFunctionsCommand {
  projectId: SiteFlowId;
  deploymentId?: SiteFlowId;
}

export interface GetFunctionRuntimeCommand {
  projectId: SiteFlowId;
  path: string;
  deploymentId?: SiteFlowId;
  limit?: number;
}

export interface ListRoutingRulesCommand {
  projectId: SiteFlowId;
  kind?: RoutingRuleKind;
  status?: "active" | "disabled";
}

export interface UpsertRoutingRuleCommand {
  projectId: SiteFlowId;
  name: string;
  kind: RoutingRuleKind;
  source: string;
  destination?: string;
  statusCode?: RedirectStatusCode;
  headers?: RoutingHeader[];
  priority?: number;
  actor?: Actor;
}

export interface DisableRoutingRuleCommand {
  projectId: SiteFlowId;
  ruleId: SiteFlowId;
  actor?: Actor;
  reason?: string;
}

export interface MatchRoutingRulesCommand {
  projectId: SiteFlowId;
  path: string;
}

export interface GitWebhookCommand {
  provider: "github";
  deliveryId: string;
  event: SourceEventInput;
}

export interface AnalyticsEventCommand {
  projectId: SiteFlowId;
  kind: AnalyticsEventKind;
  path: string;
  referrer?: string;
  country?: string;
  browser?: string;
  device?: string;
  eventName?: string;
  vitalName?: WebVitalName;
  vitalValue?: number;
  occurredAt?: string;
}

export interface LogQueryCommand {
  projectId: SiteFlowId;
  source?: ObservabilityLogSource;
  severity?: ObservabilityLogSeverity;
  deploymentId?: SiteFlowId;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface SaveLogQueryCommand {
  projectId: SiteFlowId;
  name: string;
  filters: Omit<LogQueryCommand, "projectId" | "limit" | "cursor">;
  actor?: Actor;
}

export interface CreateLogDrainCommand {
  projectId: SiteFlowId;
  name: string;
  url: string;
  sources?: ObservabilityLogSource[];
  minimumSeverity?: ObservabilityLogSeverity;
  signingSecret?: string;
  actor?: Actor;
}

export interface DeliverLogDrainCommand {
  projectId: SiteFlowId;
  drainId: SiteFlowId;
  reason?: string;
  limit?: number;
}

export interface SiteFlowClient {
  listProjects(): Promise<ProjectListReadModel>;
  getProject(projectId: SiteFlowId): Promise<ProjectDetailReadModel>;
  getProjectSettings(projectId: SiteFlowId): Promise<ProjectSettingsReadModel>;
  createProject(command: CreateProjectCommand): Promise<ProjectMutationReadModel>;
  updateProject(projectId: SiteFlowId, command: UpdateProjectCommand): Promise<ProjectMutationReadModel>;
  archiveProject(projectId: SiteFlowId): Promise<ProjectMutationReadModel>;
  getProjectEnvironmentSettings(projectId: SiteFlowId): Promise<ProjectEnvironmentSettingsReadModel>;
  upsertEnvironmentVariable(command: UpsertEnvironmentVariableCommand): Promise<ProjectEnvironmentVariableUpsertReadModel>;
  upsertTeamMember(command: UpsertTeamMemberCommand): Promise<TeamMemberMutationReadModel>;
  removeTeamMember(command: RemoveTeamMemberCommand): Promise<TeamMemberMutationReadModel>;
  createApiToken(command: CreateApiTokenCommand): Promise<ApiTokenCreateReadModel>;
  revokeApiToken(command: RevokeApiTokenCommand): Promise<ApiTokenRevokeReadModel>;
  listFirewallRules(projectId: SiteFlowId): Promise<FirewallRuleListReadModel>;
  createFirewallRule(command: CreateFirewallRuleCommand): Promise<FirewallRuleMutationReadModel>;
  disableFirewallRule(command: DisableFirewallRuleCommand): Promise<FirewallRuleMutationReadModel>;
  getEdgeConfig(projectId: SiteFlowId): Promise<EdgeConfigReadModel>;
  upsertEdgeConfig(command: UpsertEdgeConfigCommand): Promise<EdgeConfigMutationReadModel>;
  deleteEdgeConfig(command: DeleteEdgeConfigCommand): Promise<EdgeConfigMutationReadModel>;
  listBlobs(command: ListBlobsCommand): Promise<BlobListReadModel>;
  putBlob(command: PutBlobCommand): Promise<BlobPutReadModel>;
  getBlob(command: GetBlobCommand): Promise<BlobReadModel>;
  deleteBlob(command: DeleteBlobCommand): Promise<BlobDeleteReadModel>;
  imageOptimizationUrl(command: ImageOptimizationUrlCommand): string;
  listCacheEntries(command: ListCacheEntriesCommand): Promise<CacheListReadModel>;
  purgeCache(command: PurgeCacheCommand): Promise<CachePurgeReadModel>;
  listFunctions(command: ListFunctionsCommand): Promise<FunctionRuntimeListReadModel>;
  getFunctionRuntime(command: GetFunctionRuntimeCommand): Promise<FunctionRuntimeReadModel>;
  listRoutingRules(command: ListRoutingRulesCommand): Promise<RoutingRuleListReadModel>;
  upsertRoutingRule(command: UpsertRoutingRuleCommand): Promise<RoutingRuleMutationReadModel>;
  disableRoutingRule(command: DisableRoutingRuleCommand): Promise<RoutingRuleMutationReadModel>;
  matchRoutingRules(command: MatchRoutingRulesCommand): Promise<RoutingRuleMatchReadModel>;
  listDeployHooks(projectId: SiteFlowId): Promise<DeployHookListReadModel>;
  createDeployHook(command: CreateDeployHookCommand): Promise<DeployHookCreateReadModel>;
  revokeDeployHook(command: RevokeDeployHookCommand): Promise<DeployHookRevokeReadModel>;
  triggerDeployHook(command: TriggerDeployHookCommand): Promise<DeployHookTriggerReadModel>;
  listCronJobs(projectId: SiteFlowId): Promise<CronJobListReadModel>;
  createCronJob(command: CreateCronJobCommand): Promise<CronJobCreateReadModel>;
  disableCronJob(command: DisableCronJobCommand): Promise<CronJobDisableReadModel>;
  runCronJob(command: RunCronJobCommand): Promise<CronJobRunReadModel>;
  ingestGitWebhook(command: GitWebhookCommand): Promise<GitWebhookIngestReadModel>;
  ingestAnalyticsEvent(command: AnalyticsEventCommand): Promise<AnalyticsIngestReadModel>;
  getAnalyticsDashboard(projectId: SiteFlowId): Promise<AnalyticsDashboardReadModel>;
  queryLogs(command: LogQueryCommand): Promise<LogQueryReadModel>;
  listSavedLogQueries(projectId: SiteFlowId): Promise<SavedLogQueryListReadModel>;
  saveLogQuery(command: SaveLogQueryCommand): Promise<SavedLogQueryMutationReadModel>;
  listLogDrains(projectId: SiteFlowId): Promise<LogDrainListReadModel>;
  createLogDrain(command: CreateLogDrainCommand): Promise<LogDrainCreateReadModel>;
  deliverLogDrain(command: DeliverLogDrainCommand): Promise<LogDrainDeliveryReadModel>;
  listDeployments(projectId?: SiteFlowId): Promise<DeploymentListReadModel>;
  getDeployment(deploymentId: SiteFlowId): Promise<DeploymentDetailReadModel>;
  getReleaseConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<ReleaseConsoleReadModel>;
  getRollbackConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollbackConsoleReadModel>;
  promoteDeployment(command: PromoteDeploymentCommand): Promise<CommandResultReadModel>;
  rollbackDeployment(command: RollbackDeploymentCommand): Promise<CommandResultReadModel>;
  getRollingRelease(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollingReleaseReadModel>;
  startRollingRelease(command: StartRollingReleaseCommand): Promise<RollingReleaseCommandReadModel>;
  advanceRollingRelease(command: AdvanceRollingReleaseCommand): Promise<RollingReleaseCommandReadModel>;
  completeRollingRelease(command: CompleteRollingReleaseCommand): Promise<RollingReleaseCommandReadModel>;
  abortRollingRelease(command: AbortRollingReleaseCommand): Promise<RollingReleaseCommandReadModel>;
  pollOperation(operationId: SiteFlowId): Promise<OperationSnapshotReadModel>;
  getLogChunk(deploymentId: SiteFlowId, cursor?: string): Promise<LogChunkReadModel>;
}
