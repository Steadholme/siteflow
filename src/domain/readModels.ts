import type {
  Artifact,
  ArtifactVerificationStatus,
  Actor,
  AnalyticsEvent,
  AuditEvent,
  BlobObject,
  BuildJob,
  CacheEntry,
  CdnOperation,
  CdnOperationState,
  ChannelEvent,
  CronDispatch,
  CronJob,
  DeployHook,
  Deployment,
  DeploymentStatus,
  EnvironmentVariableMetadata,
  EdgeConfigEntry,
  FirewallRule,
  FirewallDecision,
  FunctionEntrypoint,
  FunctionInvocation,
  LogChunk,
  LogDrain,
  LogDrainDelivery,
  ObservabilityLogEntry,
  ObservabilityLogSeverity,
  ObservabilityLogSource,
  ApiToken,
  OperatorSession,
  Project,
  ProjectBuildSettings,
  ProjectEnvironment,
  DomainBinding,
  PermissionScope,
  ReleaseChannel,
  ReleaseChannelName,
  ReleaseEvidenceMetadata,
  RepositoryBinding,
  RoutingRule,
  RouteRevision,
  RouteRevisionStatus,
  RollingRelease,
  SafetyCheck,
  SavedLogQuery,
  SiteFlowId,
  SourceEvent,
  TeamMember,
  WebVitalName
} from "./siteflow.js";

export interface GlobalSummaryReadModel {
  totalProjects: number;
  activeProjects: number;
  deploymentsToday: number;
  activeOperations: number;
  routeDriftCount: number;
  failedRouteCount: number;
  failedBuildCount: number;
  updatedAt: string;
}

export interface DeploymentSummaryReadModel {
  id: SiteFlowId;
  projectId: SiteFlowId;
  projectName: string;
  version: string;
  commitSha: string;
  branch: string;
  status: DeploymentStatus;
  artifactVerificationStatus: ArtifactVerificationStatus;
  routeRevisionStatus: RouteRevisionStatus;
  cdnOperationState: CdnOperationState;
  createdAt: string;
  readyAt?: string;
}

export interface DeploymentListReadModel {
  deployments: DeploymentSummaryReadModel[];
  total: number;
  projectId?: SiteFlowId;
  updatedAt: string;
}

export interface RouteRevisionEvidenceReadModel {
  routeRevision: RouteRevision;
  checks: SafetyCheck[];
  previousKnownGoodDeploymentId?: SiteFlowId;
}

export interface ProjectListItemReadModel {
  project: Project;
  productionDeployment?: DeploymentSummaryReadModel;
  pendingDeploymentCount: number;
  lastSourceEvent?: SourceEvent;
  lastAuditEvent?: AuditEvent;
}

export interface ProjectListReadModel {
  summary: GlobalSummaryReadModel;
  projects: ProjectListItemReadModel[];
  recentEvents: EventFeedReadModel;
  emptyState?: string;
}

export interface ReleaseChannelReadModel {
  channel: ReleaseChannel;
  currentDeployment?: DeploymentSummaryReadModel;
  routeRevision?: RouteRevision;
  cdnOperation?: CdnOperation;
}

export interface ProjectDetailReadModel {
  project: Project;
  channels: ReleaseChannelReadModel[];
  deployments: DeploymentSummaryReadModel[];
  recentEvents: EventFeedReadModel;
  routeEvidence: RouteRevisionEvidenceReadModel[];
}

export interface DeploymentLineageReadModel {
  sourceEvent: SourceEvent;
  buildJob: BuildJob;
  artifact: Artifact;
  deployment: Deployment;
  routeRevision?: RouteRevision;
  cdnOperation?: CdnOperation;
}

export interface EvidenceItemReadModel {
  id: SiteFlowId;
  label: string;
  status: "pass" | "warning" | "fail" | "pending";
  summary: string;
  evidence?: string;
}

export interface DeploymentDetailReadModel {
  project: Project;
  deployment: Deployment;
  lineage: DeploymentLineageReadModel;
  evidence: EvidenceItemReadModel[];
  routeEvidence?: RouteRevisionEvidenceReadModel;
  logs: LogChunkReadModel;
  auditEvents: AuditEvent[];
}

export interface ReleaseConsoleReadModel {
  project: Project;
  channel: ReleaseChannelName;
  currentDeployment?: DeploymentSummaryReadModel;
  candidateDeployment?: DeploymentSummaryReadModel;
  routePreview?: RouteRevisionEvidenceReadModel;
  safetyChecks: SafetyCheck[];
  recentChannelEvents: ChannelEvent[];
  auditEvents: AuditEvent[];
}

export interface RollbackTargetReadModel {
  deployment: DeploymentSummaryReadModel;
  eligible: boolean;
  disabledReason?: string;
  safetyChecks: SafetyCheck[];
}

export interface RollbackConsoleReadModel {
  project: Project;
  channel: ReleaseChannelName;
  currentDeployment?: DeploymentSummaryReadModel;
  targets: RollbackTargetReadModel[];
  selectedTargetId?: SiteFlowId;
  routePreview?: RouteRevisionEvidenceReadModel;
  recentChannelEvents: ChannelEvent[];
  auditEvents: AuditEvent[];
}

export interface EventFeedReadModel {
  sourceEvents: SourceEvent[];
  channelEvents: ChannelEvent[];
  auditEvents: AuditEvent[];
}

export interface LogChunkReadModel {
  deploymentId: SiteFlowId;
  chunk: LogChunk;
  nextCursor?: string;
  hasMore: boolean;
}

export interface LogQueryReadModel {
  projectId: SiteFlowId;
  filters: {
    source?: ObservabilityLogSource;
    severity?: ObservabilityLogSeverity;
    deploymentId?: SiteFlowId;
    search?: string;
  };
  entries: ObservabilityLogEntry[];
  total: number;
  nextCursor?: string;
  updatedAt: string;
}

export interface SavedLogQueryListReadModel {
  projectId: SiteFlowId;
  queries: SavedLogQuery[];
  total: number;
  updatedAt: string;
}

export interface SavedLogQueryMutationReadModel {
  status: "saved";
  query: SavedLogQuery;
  message: string;
}

export interface LogDrainListReadModel {
  projectId: SiteFlowId;
  drains: LogDrain[];
  total: number;
  updatedAt: string;
}

export interface LogDrainCreateReadModel {
  status: "created";
  drain: LogDrain;
  message: string;
}

export interface LogDrainDeliveryReadModel {
  status: LogDrainDelivery["status"];
  drain: LogDrain;
  delivery: LogDrainDelivery;
  message: string;
}

export interface AnalyticsIngestReadModel {
  status: "accepted";
  event: AnalyticsEvent;
  message: string;
}

export interface AnalyticsDimensionReadModel {
  name: string;
  count: number;
  percentage: number;
}

export interface AnalyticsWebVitalReadModel {
  name: WebVitalName;
  count: number;
  p75: number;
  rating: "good" | "needs_improvement" | "poor";
}

export interface AnalyticsDashboardReadModel {
  projectId: SiteFlowId;
  window: "24h";
  totals: {
    pageviews: number;
    customEvents: number;
    webVitals: number;
    uniquePaths: number;
  };
  topPages: AnalyticsDimensionReadModel[];
  referrers: AnalyticsDimensionReadModel[];
  countries: AnalyticsDimensionReadModel[];
  browsers: AnalyticsDimensionReadModel[];
  devices: AnalyticsDimensionReadModel[];
  customEvents: AnalyticsDimensionReadModel[];
  webVitals: AnalyticsWebVitalReadModel[];
  updatedAt: string;
}

export interface ProjectSettingsReadModel {
  project: Project;
  environments: ProjectEnvironment[];
  environmentVariables: EnvironmentVariableMetadata[];
  teamMembers: TeamMember[];
  apiTokens: ApiToken[];
  auditEvents: AuditEvent[];
  currentPermissions: PermissionScope[];
}

export interface ProjectEnvironmentSettingsReadModel {
  projectId: SiteFlowId;
  environments: ProjectEnvironment[];
  environmentVariables: EnvironmentVariableMetadata[];
  updatedAt: string;
}

export interface ProjectMutationReadModel {
  status: "created" | "updated" | "archived";
  project: Project;
  message: string;
}

export interface ProjectCommandBase {
  slug: string;
  name: string;
  framework?: string;
  defaultBranch?: string;
  productionBranch?: string;
  repository?: RepositoryBinding;
  buildSettings?: Partial<ProjectBuildSettings>;
  domains?: DomainBinding[];
  actor?: Actor;
}

export interface ProjectEnvironmentVariableUpsertReadModel {
  status: "upserted";
  variable: EnvironmentVariableMetadata;
  message: string;
}

export interface TeamMemberMutationReadModel {
  status: "upserted" | "removed";
  member?: TeamMember;
  message: string;
}

export interface ApiTokenCreateReadModel {
  status: "created";
  token: ApiToken;
  secret: string;
  message: string;
}

export interface ApiTokenRevokeReadModel {
  status: "revoked";
  token: ApiToken;
  message: string;
}

export interface OperatorSessionCreateReadModel {
  status: "created";
  session: OperatorSession;
  message: string;
}

export interface OperatorSessionRotateReadModel {
  status: "rotated";
  session: OperatorSession;
  message: string;
}

export interface OperatorSessionRevokeReadModel {
  status: "revoked" | "not_found";
  session?: OperatorSession;
  message: string;
}

export interface OperatorSessionRevokeAllReadModel {
  status: "revoked";
  scope: "global" | "project";
  projectId?: SiteFlowId;
  cutoffId: SiteFlowId;
  revokedAt: string;
  revokedCount: number;
  message: string;
}

export interface FirewallRuleListReadModel {
  projectId: SiteFlowId;
  rules: FirewallRule[];
  total: number;
  updatedAt: string;
}

export interface FirewallRuleMutationReadModel {
  status: "created" | "disabled";
  rule: FirewallRule;
  message: string;
}

export interface FirewallEvaluationReadModel {
  projectId: SiteFlowId;
  decision: FirewallDecision;
  matchedRule?: FirewallRule;
  reason: string;
}

export interface EdgeConfigReadModel {
  projectId: SiteFlowId;
  entries: EdgeConfigEntry[];
  total: number;
  updatedAt: string;
}

export interface EdgeConfigMutationReadModel {
  status: "upserted" | "deleted";
  entry?: EdgeConfigEntry;
  message: string;
}

export interface BlobListReadModel {
  projectId: SiteFlowId;
  blobs: BlobObject[];
  total: number;
  updatedAt: string;
}

export interface BlobReadModel {
  projectId: SiteFlowId;
  blob: BlobObject;
  contentBase64: string;
}

export interface BlobPutReadModel {
  status: "uploaded";
  blob: BlobObject;
  message: string;
}

export interface BlobDeleteReadModel {
  status: "deleted";
  blob: BlobObject;
  message: string;
}

export interface CacheListReadModel {
  projectId: SiteFlowId;
  entries: CacheEntry[];
  total: number;
  updatedAt: string;
}

export interface CachePurgeReadModel {
  status: "purged";
  projectId: SiteFlowId;
  purged: CacheEntry[];
  total: number;
  message: string;
}

export interface DeployHookListReadModel {
  projectId: SiteFlowId;
  hooks: DeployHook[];
  total: number;
  updatedAt: string;
}

export interface DeployHookCreateReadModel {
  status: "created";
  hook: DeployHook;
  token: string;
  hookUrl?: string;
  message: string;
}

export interface DeployHookRevokeReadModel {
  status: "revoked";
  hook: DeployHook;
  message: string;
}

export interface DeployHookTriggerReadModel {
  status: "accepted";
  hook: DeployHook;
  sourceEvent: SourceEvent;
  buildJobId: SiteFlowId;
  message: string;
}

export interface CronJobListReadModel {
  projectId: SiteFlowId;
  jobs: CronJob[];
  total: number;
  updatedAt: string;
}

export interface CronJobCreateReadModel {
  status: "created";
  job: CronJob;
  message: string;
}

export interface CronJobDisableReadModel {
  status: "disabled";
  job: CronJob;
  message: string;
}

export interface CronJobRunReadModel {
  status: "accepted" | "rejected";
  job?: CronJob;
  dispatch?: CronDispatch;
  message: string;
}

export interface RollingReleaseReadModel {
  projectId: SiteFlowId;
  channel: ReleaseChannelName;
  rollout?: RollingRelease;
  currentDeployment?: DeploymentSummaryReadModel;
  candidateDeployment?: DeploymentSummaryReadModel;
  safetyChecks: SafetyCheck[];
  updatedAt: string;
}

export interface RollingReleaseCommandReadModel {
  status: CommandResultStatus;
  rollout?: RollingRelease;
  routeRevision?: RouteRevision;
  safetyChecks: SafetyCheck[];
  message: string;
}

export interface FunctionRuntimeSummary {
  invocations: number;
  errors: number;
  errorRate: number;
  averageDurationMs: number;
  p95DurationMs: number;
  lastInvokedAt?: string;
}

export interface FunctionRuntimeItem {
  projectId: SiteFlowId;
  deploymentId: SiteFlowId;
  function: FunctionEntrypoint;
  limits: {
    timeoutMs: number;
    memoryMb: number;
    concurrency: number;
  };
  summary: FunctionRuntimeSummary;
}

export interface FunctionRuntimeListReadModel {
  projectId: SiteFlowId;
  deploymentId?: SiteFlowId;
  functions: FunctionRuntimeItem[];
  total: number;
  updatedAt: string;
}

export interface FunctionRuntimeReadModel {
  projectId: SiteFlowId;
  deploymentId: SiteFlowId;
  function: FunctionRuntimeItem;
  recentInvocations: FunctionInvocation[];
  updatedAt: string;
}

export interface RoutingRuleListReadModel {
  projectId: SiteFlowId;
  rules: RoutingRule[];
  total: number;
  updatedAt: string;
}

export interface RoutingRuleMutationReadModel {
  status: "upserted" | "disabled";
  rule: RoutingRule;
  message: string;
}

export interface RoutingRuleMatchReadModel {
  projectId: SiteFlowId;
  path: string;
  redirect?: RoutingRule;
  rewrite?: RoutingRule;
  headers: RoutingRule[];
  rewrittenPath?: string;
  updatedAt: string;
}

export interface GitWebhookIngestReadModel {
  status: "accepted" | "duplicate" | "ignored";
  sourceEvent: SourceEvent;
  buildJobId?: SiteFlowId;
  message: string;
}

export type CommandResultStatus = "accepted" | "rejected";
export type OperationState = "pending" | "running" | "succeeded" | "failed";

export interface CommandResultReadModel {
  status: CommandResultStatus;
  operationId?: SiteFlowId;
  channelEvent?: ChannelEvent;
  routeRevision?: RouteRevision;
  safetyChecks: SafetyCheck[];
  message: string;
}

export interface OperationSnapshotReadModel {
  operationId: SiteFlowId;
  projectId: SiteFlowId;
  state: OperationState;
  kind: "promotion" | "rollback" | "route_apply" | "cdn_purge";
  channel?: ReleaseChannelName;
  targetDeploymentId?: SiteFlowId;
  releaseEvidence?: ReleaseEvidenceMetadata;
  routeRevision?: RouteRevision;
  cdnOperation?: CdnOperation;
  updatedAt: string;
  message: string;
}
