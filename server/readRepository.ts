import type { Actor, ApiToken, FunctionEntrypoint, FunctionInvocation, LogDrain, ObservabilityLogEntry, OperatorSession, PermissionScope, ReleaseChannelName, RoutingRule, SiteFlowId } from "../src/domain/siteflow.js";
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
  FirewallEvaluationReadModel,
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
} from "../src/domain/readModels.js";
import type {
  AbortRollingReleaseCommand,
  AdvanceRollingReleaseCommand,
  CompleteRollingReleaseCommand,
  DisableRoutingRuleCommand,
  CreateProjectCommand,
  CreateCronJobCommand,
  CreateDeployHookCommand,
  CreateLogDrainCommand,
  DisableCronJobCommand,
  AnalyticsEventCommand,
  DeliverLogDrainCommand,
  DeleteBlobCommand,
  GitWebhookCommand,
  GetBlobCommand,
  GetFunctionRuntimeCommand,
  ListCacheEntriesCommand,
  ListFunctionsCommand,
  ListBlobsCommand,
  ListRoutingRulesCommand,
  LogQueryCommand,
  MatchRoutingRulesCommand,
  CreateApiTokenCommand,
  CreateFirewallRuleCommand,
  CreateOperatorSessionCommand,
  DeleteEdgeConfigCommand,
  PutBlobCommand,
  PurgeCacheCommand,
  PromoteDeploymentCommand,
  RemoveTeamMemberCommand,
  DisableFirewallRuleCommand,
  RevokeDeployHookCommand,
  RevokeAllOperatorSessionsCommand,
  RevokeApiTokenCommand,
  RollbackDeploymentCommand,
  RunCronJobCommand,
  SaveLogQueryCommand,
  StartRollingReleaseCommand,
  TriggerDeployHookCommand,
  UpdateProjectCommand,
  UpsertRoutingRuleCommand,
  UpsertTeamMemberCommand,
  UpsertEdgeConfigCommand,
  UpsertEnvironmentVariableCommand
} from "../src/lib/api/siteflowClient.js";
import type { PrebuiltDeployCommand, PrebuiltDeployResult, PrebuiltImageConfig } from "../src/lib/api/deployContracts.js";

export class SiteFlowNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteFlowNotFoundError";
  }
}

export type SiteFlowAuthPrincipal =
  | {
    kind: "root_api_token";
    scopes: PermissionScope[];
    actor: Actor;
  }
  | {
    kind: "api_token";
    scopes: PermissionScope[];
    token?: ApiToken;
    actor: Actor;
  }
  | {
    kind: "operator_session";
    scopes: PermissionScope[];
    session?: OperatorSession;
    actor: Actor;
  };

export interface OperatorSessionCreateResult extends OperatorSessionCreateReadModel {
  secret: string;
}

export interface OperatorSessionRotateResult extends OperatorSessionRotateReadModel {
  secret: string;
  maxAgeSeconds: number;
}

export interface SiteFlowReadRepository {
  authorizeToken(token: string, permission: PermissionScope, projectId?: SiteFlowId): Promise<boolean>;
  resolveTokenPermissions(token: string, projectId?: SiteFlowId): Promise<PermissionScope[] | undefined>;
  resolveSessionPermissions(token: string, projectId?: SiteFlowId): Promise<PermissionScope[] | undefined>;
  resolveTokenPrincipal?(token: string, projectId?: SiteFlowId): Promise<SiteFlowAuthPrincipal | undefined>;
  resolveSessionPrincipal?(token: string, projectId?: SiteFlowId): Promise<SiteFlowAuthPrincipal | undefined>;
  createOperatorSession(command: CreateOperatorSessionCommand): Promise<OperatorSessionCreateResult>;
  rotateOperatorSession(token: string): Promise<OperatorSessionRotateResult | undefined>;
  revokeOperatorSession(token: string): Promise<OperatorSessionRevokeReadModel>;
  revokeAllOperatorSessions(command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel>;
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
  evaluateFirewall(command: FirewallEvaluationCommand): Promise<FirewallEvaluationReadModel>;
  getEdgeConfig(projectId: SiteFlowId): Promise<EdgeConfigReadModel>;
  upsertEdgeConfig(command: UpsertEdgeConfigCommand): Promise<EdgeConfigMutationReadModel>;
  deleteEdgeConfig(command: DeleteEdgeConfigCommand): Promise<EdgeConfigMutationReadModel>;
  listBlobs(command: ListBlobsCommand): Promise<BlobListReadModel>;
  putBlob(command: PutBlobCommand): Promise<BlobPutReadModel>;
  getBlob(command: GetBlobCommand): Promise<BlobReadModel>;
  deleteBlob(command: DeleteBlobCommand): Promise<BlobDeleteReadModel>;
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
  prepareLogDrainDelivery(command: DeliverLogDrainCommand): Promise<LogDrainDeliveryPlan>;
  recordLogDrainDelivery(command: RecordLogDrainDeliveryCommand): Promise<LogDrainDeliveryReadModel>;
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
  deployPrebuilt(command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult>;
  resolveArtifactRoute(host: string, bucketKey?: string): Promise<ArtifactRoute | undefined>;
  recordFunctionInvocation(invocation: FunctionInvocation): Promise<void>;
}

export interface FirewallEvaluationCommand {
  projectId: SiteFlowId;
  ip?: string;
  path: string;
  method: string;
  headers: Record<string, string | undefined>;
  userAgent?: string;
}

export interface ArtifactRoute {
  host: string;
  projectId?: SiteFlowId;
  deploymentId: SiteFlowId;
  artifactRoot: string;
  entrypoint: string;
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  skipTrailingSlashRedirect?: boolean;
  images?: PrebuiltImageConfig;
  routingRules?: {
    redirects?: RoutingRule[];
    rewrites?: RoutingRule[];
    headers?: RoutingRule[];
  };
  functions?: FunctionEntrypoint[];
  runtimeEnvironment?: Record<string, string>;
  rollingReleaseId?: SiteFlowId;
  trafficTarget?: "current" | "candidate";
}

export interface LogDrainDeliveryPlan {
  deliveryId: SiteFlowId;
  drain: LogDrain;
  signingSecret: string;
  events: ObservabilityLogEntry[];
}

export interface RecordLogDrainDeliveryCommand {
  projectId: SiteFlowId;
  drainId: SiteFlowId;
  deliveryId: SiteFlowId;
  status: "delivered" | "failed";
  responseStatus?: number;
  eventsDelivered: number;
  payloadSha256: string;
  errorMessage?: string;
  attempt?: number;
}

export function assertReleaseChannel(value: string): asserts value is ReleaseChannelName {
  if (value !== "production" && value !== "staging" && value !== "preview") {
    throw new Error(`Invalid release channel: ${value}`);
  }
}

export function releaseConsoleKey(projectId: SiteFlowId, channel: ReleaseChannelName) {
  return `${projectId}:${channel}`;
}

export function logChunkKey(deploymentId: SiteFlowId, cursor?: string) {
  return `${deploymentId}:${cursor ?? "default"}`;
}
