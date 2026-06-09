export type IsoTimestamp = string;
export type SiteFlowId = string;

export type ProjectStatus = "active" | "paused" | "archived";
export type ReleaseChannelName = "production" | "staging" | "preview";
export type ProjectEnvironmentType = "local" | "preview" | "production" | "custom";
export type EnvironmentVariableScope = "build" | "runtime";

export type SourceEventKind = "push" | "pull_request" | "manual";
export type SourceEventStatus = "accepted" | "rejected" | "ignored";
export type SourceEventDisposition = "build_requested" | "duplicate" | "signature_failed" | "policy_rejected";
export type SourceProvider = RepositoryBinding["provider"];

export type BuildJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "timed_out" | "skipped";
export type BuildEventLevel = "info" | "warning" | "error";

export type ArtifactStorageStatus = "pending_upload" | "stored" | "retained" | "expired" | "delete_pending" | "deleted";
export type ArtifactVerificationStatus = "pending" | "verified" | "failed";

export type DeploymentStatus = "queued" | "building" | "ready" | "failed" | "canceled";
export type DeployHookStatus = "active" | "revoked";
export type CronJobStatus = "active" | "disabled";
export type CronDispatchStatus = "queued" | "succeeded" | "failed";
export type FunctionRuntime = "nodejs20.x";
export type FunctionRuntimeIsolation = "same_process" | "isolated_process";
export type FunctionInvocationStatus = "succeeded" | "failed";
export type AnalyticsEventKind = "pageview" | "custom" | "web_vital";
export type WebVitalName = "CLS" | "FCP" | "FID" | "INP" | "LCP" | "TTFB";
export type ObservabilityLogSource = "build" | "runtime" | "function" | "cron";
export type ObservabilityLogSeverity = "info" | "warning" | "error";
export type LogDrainStatus = "active" | "disabled";
export type LogDrainDeliveryStatus = "delivered" | "failed";
export type TeamRole = "owner" | "member" | "developer" | "viewer";
export type PermissionScope = "read" | "write" | "admin";
export type ApiTokenStatus = "active" | "revoked";
export type OperatorSessionStatus = "active" | "revoked" | "expired";
export type FirewallRuleAction = "allow" | "block" | "challenge";
export type FirewallRuleStatus = "active" | "disabled";
export type FirewallDecision = "allow" | "block" | "challenge";
export type RoutingRuleKind = "redirect" | "rewrite" | "header";
export type RoutingRuleStatus = "active" | "disabled";
export type RedirectStatusCode = 301 | 302 | 307 | 308;
export type BlobAccess = "public" | "private";
export type ImageOptimizationFormat = "auto" | "avif" | "webp" | "png" | "jpeg";
export type CacheEntryStatus = "fresh" | "stale" | "purged";

export type RouteRevisionStatus = "planned" | "validating" | "pending_apply" | "applied" | "failed" | "drifted" | "superseded";
export type CdnOperationState = "disabled" | "queued" | "purging" | "succeeded" | "failed" | "skipped";
export type RollingReleaseStatus = "active" | "completed" | "aborted";

export type ChannelEventAction = "promote" | "rollback" | "repair_route" | "sync_cdn";
export type ChannelEventStatus = "pending" | "succeeded" | "failed";
export type AuditEventAction =
  | "project.created"
  | "project.updated"
  | "project.archived"
  | "environment_variable.upserted"
  | "source.received"
  | "build.queued"
  | "artifact.verified"
  | "deployment.promoted"
  | "deployment.rolled_back"
  | "deploy_hook.created"
  | "deploy_hook.revoked"
  | "cron_job.created"
  | "cron_job.disabled"
  | "cron_job.run"
  | "log_query.saved"
  | "log_drain.created"
  | "log_drain.delivered"
  | "rolling_release.started"
  | "rolling_release.advanced"
  | "rolling_release.completed"
  | "rolling_release.aborted"
  | "route.applied"
  | "route.failed"
  | "cdn.purged"
  | "team.member_added"
  | "team.member_updated"
  | "team.member_removed"
  | "api_token.created"
  | "api_token.revoked"
  | "firewall_rule.created"
  | "firewall_rule.disabled"
  | "routing_rule.upserted"
  | "routing_rule.disabled"
  | "edge_config.upserted"
  | "edge_config.deleted"
  | "blob.uploaded"
  | "blob.deleted"
  | "cache.purged";

export type SafetyCheckStatus = "pass" | "warning" | "fail";

export interface Actor {
  id: SiteFlowId;
  name: string;
  email?: string;
  role: "system" | "operator" | "release_manager" | "developer";
}

export interface RepositoryBinding {
  provider: "github" | "gitlab" | "gitea" | "generic";
  owner: string;
  name: string;
  defaultBranch: string;
  installationId?: string;
  webhookSecretRef?: string;
  providerPayload?: Record<string, unknown>;
}

export interface DomainBinding {
  hostname: string;
  channel: ReleaseChannelName;
  verified: boolean;
  lastCheckedAt: IsoTimestamp;
}

export interface SecretMetadata {
  key: string;
  scope: "build" | "runtime" | "webhook" | "provider";
  source: "sealed" | "external";
  fingerprint: string;
  updatedAt: IsoTimestamp;
}

export interface ProjectPolicy {
  requiredChecks: string[];
  retentionDays: number;
  previewDeploymentsEnabled: boolean;
  cdnEnabled: boolean;
  requirePromotionReason: boolean;
}

export interface ProjectBuildSettings {
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  rootDirectory?: string;
  framework?: string;
  ignoreCommand?: string;
}

export interface ProjectEnvironment {
  projectId: SiteFlowId;
  name: string;
  type: ProjectEnvironmentType;
  branchPattern?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface EnvironmentVariableMetadata {
  id: SiteFlowId;
  projectId: SiteFlowId;
  key: string;
  targetEnvironment: string;
  scope: EnvironmentVariableScope;
  source: SecretMetadata["source"];
  fingerprint: string;
  updatedAt: IsoTimestamp;
  updatedBy?: Actor;
}

export interface Project {
  id: SiteFlowId;
  slug: string;
  name: string;
  status: ProjectStatus;
  framework: string;
  defaultBranch: string;
  productionBranch?: string;
  repository: RepositoryBinding;
  buildSettings?: ProjectBuildSettings;
  domains: DomainBinding[];
  policy: ProjectPolicy;
  secrets: SecretMetadata[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SourceEvent {
  id: SiteFlowId;
  projectId: SiteFlowId;
  kind: SourceEventKind;
  status: SourceEventStatus;
  disposition: SourceEventDisposition;
  providerDeliveryId: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  receivedAt: IsoTimestamp;
  actor: Actor;
  rejectionReason?: string;
}

export interface SourceEventInput {
  provider: SourceProvider;
  deliveryId: string;
  kind: SourceEventKind;
  repository: RepositoryBinding;
  branch: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  pullRequestNumber?: number;
  receivedAt: IsoTimestamp;
  actor: Actor;
  providerPayload?: Record<string, unknown>;
}

export interface BuildEvent {
  id: SiteFlowId;
  buildJobId: SiteFlowId;
  level: BuildEventLevel;
  message: string;
  occurredAt: IsoTimestamp;
}

export interface BuildJob {
  id: SiteFlowId;
  projectId: SiteFlowId;
  sourceEventId: SiteFlowId;
  status: BuildJobStatus;
  framework: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  queuedAt: IsoTimestamp;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  workerId?: string;
  events: BuildEvent[];
}

export interface ArtifactManifest {
  entrypoint: string;
  fileCount: number;
  totalBytes: number;
  checksum: string;
  generatedAt: IsoTimestamp;
  functions?: FunctionEntrypoint[];
  metadata: Record<string, unknown>;
}

export interface Artifact {
  id: SiteFlowId;
  projectId: SiteFlowId;
  buildJobId: SiteFlowId;
  storageUri: string;
  manifest: ArtifactManifest;
  storageStatus: ArtifactStorageStatus;
  verificationStatus: ArtifactVerificationStatus;
  retainedUntil: IsoTimestamp;
  immutable: true;
  createdAt: IsoTimestamp;
  verifiedAt?: IsoTimestamp;
}

export interface Deployment {
  id: SiteFlowId;
  projectId: SiteFlowId;
  sourceEventId: SiteFlowId;
  buildJobId: SiteFlowId;
  artifactId: SiteFlowId;
  status: DeploymentStatus;
  version: string;
  environment: ReleaseChannelName;
  createdAt: IsoTimestamp;
  readyAt?: IsoTimestamp;
  failedReason?: string;
}

export interface CdnOperation {
  id: SiteFlowId;
  projectId: SiteFlowId;
  routeRevisionId: SiteFlowId;
  provider: "cloudflare" | "fastly" | "none";
  state: CdnOperationState;
  requestedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  message?: string;
}

export interface ReleaseEvidenceMetadata {
  evidencePath: string;
  checkedAt: IsoTimestamp;
  payloadDigest?: string;
  status: "passed";
  commitRef: string;
  repository: string;
  branch: string;
  targetEnvironment: string;
  releaseTicket?: string;
  operatorName?: string;
}

export interface RouteRevision {
  id: SiteFlowId;
  projectId: SiteFlowId;
  channel: ReleaseChannelName;
  deploymentId: SiteFlowId;
  status: RouteRevisionStatus;
  previousDeploymentId?: SiteFlowId;
  generatedConfig: string;
  validationSummary: string;
  releaseEvidence?: ReleaseEvidenceMetadata;
  createdAt: IsoTimestamp;
  appliedAt?: IsoTimestamp;
  failedReason?: string;
  cdnOperation?: CdnOperation;
}

export interface ReleaseChannel {
  id: SiteFlowId;
  projectId: SiteFlowId;
  name: ReleaseChannelName;
  currentDeploymentId?: SiteFlowId;
  pendingDeploymentId?: SiteFlowId;
  routeRevisionId?: SiteFlowId;
  updatedAt: IsoTimestamp;
  updatedBy: Actor;
}

export interface RollingRelease {
  id: SiteFlowId;
  projectId: SiteFlowId;
  channel: ReleaseChannelName;
  currentDeploymentId: SiteFlowId;
  candidateDeploymentId: SiteFlowId;
  percentage: number;
  status: RollingReleaseStatus;
  actor: Actor;
  reason: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
  abortedAt?: IsoTimestamp;
}

export interface PreviewDeployment {
  id: SiteFlowId;
  projectId: SiteFlowId;
  deploymentId: SiteFlowId;
  pullRequestNumber: number;
  url: string;
  expiresAt: IsoTimestamp;
}

export interface DeployHook {
  id: SiteFlowId;
  projectId: SiteFlowId;
  name: string;
  branch: string;
  targetEnvironment: string;
  tokenPrefix: string;
  status: DeployHookStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  revokedAt?: IsoTimestamp;
  lastTriggeredAt?: IsoTimestamp;
}

export interface CronJob {
  id: SiteFlowId;
  projectId: SiteFlowId;
  name: string;
  path: string;
  schedule: string;
  status: CronJobStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  disabledAt?: IsoTimestamp;
  lastDispatchedAt?: IsoTimestamp;
}

export interface CronDispatch {
  id: SiteFlowId;
  cronJobId: SiteFlowId;
  projectId: SiteFlowId;
  targetUrl: string;
  method: "GET";
  userAgent: string;
  status: CronDispatchStatus;
  reason: string;
  scheduledAt: IsoTimestamp;
  dispatchedAt: IsoTimestamp;
  responseStatus?: number;
  errorMessage?: string;
}

export interface FunctionEntrypoint {
  path: string;
  sourcePath: string;
  runtime: FunctionRuntime;
  runtimeIsolation?: FunctionRuntimeIsolation;
  handler: "default" | "handler";
  methods?: string[];
  timeoutMs?: number;
  memoryMb?: number;
  concurrency?: number;
  regions?: string[];
  failoverRegions?: string[];
}

export interface FunctionInvocation {
  id: SiteFlowId;
  deploymentId: SiteFlowId;
  projectId: SiteFlowId;
  path: string;
  method: string;
  status: FunctionInvocationStatus;
  responseStatus: number;
  durationMs: number;
  requestId: string;
  errorMessage?: string;
  logs: string[];
  invokedAt: IsoTimestamp;
}

export interface AnalyticsEvent {
  id: SiteFlowId;
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
  occurredAt: IsoTimestamp;
  receivedAt: IsoTimestamp;
}

export interface ObservabilityLogEntry {
  id: SiteFlowId;
  projectId: SiteFlowId;
  source: ObservabilityLogSource;
  severity: ObservabilityLogSeverity;
  message: string;
  timestamp: IsoTimestamp;
  deploymentId?: SiteFlowId;
  buildJobId?: SiteFlowId;
  cronJobId?: SiteFlowId;
  requestId?: SiteFlowId;
  metadata?: Record<string, unknown>;
}

export interface SavedLogQuery {
  id: SiteFlowId;
  projectId: SiteFlowId;
  name: string;
  filters: {
    source?: ObservabilityLogSource;
    severity?: ObservabilityLogSeverity;
    deploymentId?: SiteFlowId;
    search?: string;
  };
  createdBy?: Actor;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface LogDrain {
  id: SiteFlowId;
  projectId: SiteFlowId;
  name: string;
  url: string;
  sources: ObservabilityLogSource[];
  minimumSeverity: ObservabilityLogSeverity;
  status: LogDrainStatus;
  signingSecretPrefix: string;
  createdBy?: Actor;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  lastDeliveredAt?: IsoTimestamp;
}

export interface LogDrainDelivery {
  id: SiteFlowId;
  drainId: SiteFlowId;
  projectId: SiteFlowId;
  status: LogDrainDeliveryStatus;
  responseStatus?: number;
  eventsDelivered: number;
  attempt: number;
  payloadSha256: string;
  errorMessage?: string;
  deliveredAt: IsoTimestamp;
}

export interface TeamMember {
  id: SiteFlowId;
  projectId: SiteFlowId;
  actor: Actor;
  role: TeamRole;
  permissions: PermissionScope[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ApiToken {
  id: SiteFlowId;
  projectId?: SiteFlowId;
  name: string;
  tokenPrefix: string;
  scopes: PermissionScope[];
  status: ApiTokenStatus;
  createdBy?: Actor;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  revokedAt?: IsoTimestamp;
  lastUsedAt?: IsoTimestamp;
}

export interface OperatorSession {
  id: SiteFlowId;
  subject: string;
  actor?: Actor;
  tokenPrefix: string;
  scopes: PermissionScope[];
  projectIds?: SiteFlowId[];
  status: OperatorSessionStatus;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  revokedAt?: IsoTimestamp;
  lastUsedAt?: IsoTimestamp;
}

export interface FirewallRuleCondition {
  ipRanges?: string[];
  pathPattern?: string;
  header?: {
    name: string;
    value?: string;
  };
  userAgent?: string;
}

export interface FirewallRule {
  id: SiteFlowId;
  projectId: SiteFlowId;
  name: string;
  action: FirewallRuleAction;
  priority: number;
  status: FirewallRuleStatus;
  conditions: FirewallRuleCondition;
  createdBy?: Actor;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  disabledAt?: IsoTimestamp;
}

export interface EdgeConfigEntry {
  id: SiteFlowId;
  projectId: SiteFlowId;
  key: string;
  value: unknown;
  valueType: "boolean" | "number" | "string" | "json";
  createdBy?: Actor;
  updatedBy?: Actor;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface RoutingHeader {
  key: string;
  value: string;
}

export interface RoutingRule {
  id: SiteFlowId;
  projectId: SiteFlowId;
  name: string;
  kind: RoutingRuleKind;
  source: string;
  destination?: string;
  statusCode?: RedirectStatusCode;
  headers?: RoutingHeader[];
  priority: number;
  status: RoutingRuleStatus;
  createdBy?: Actor;
  updatedBy?: Actor;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  disabledAt?: IsoTimestamp;
}

export interface BlobObject {
  id: SiteFlowId;
  projectId: SiteFlowId;
  pathname: string;
  access: BlobAccess;
  contentType: string;
  cacheControlMaxAge?: number;
  size: number;
  sha256: string;
  etag: string;
  url: string;
  uploadedBy?: Actor;
  uploadedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface CacheEntry {
  id: SiteFlowId;
  projectId: SiteFlowId;
  key: string;
  path: string;
  tags: string[];
  status: CacheEntryStatus;
  contentType: string;
  size: number;
  etag: string;
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
  lastGeneratedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  staleAt: IsoTimestamp;
  purgedAt?: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SafetyCheck {
  id: SiteFlowId;
  label: string;
  status: SafetyCheckStatus;
  summary: string;
  evidence?: string;
}

export interface ChannelEvent {
  id: SiteFlowId;
  projectId: SiteFlowId;
  channel: ReleaseChannelName;
  action: ChannelEventAction;
  status: ChannelEventStatus;
  previousDeploymentId?: SiteFlowId;
  nextDeploymentId?: SiteFlowId;
  routeRevisionId?: SiteFlowId;
  actor: Actor;
  reason: string;
  idempotencyKey: string;
  createdAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
  safetyChecks: SafetyCheck[];
}

export interface AuditEvent {
  id: SiteFlowId;
  projectId: SiteFlowId;
  action: AuditEventAction;
  actor: Actor;
  targetType:
    | "project"
    | "source_event"
    | "build_job"
    | "artifact"
    | "deployment"
    | "release_channel"
    | "route_revision"
    | "deploy_hook"
    | "cron_job"
    | "environment_variable"
    | "log_query"
    | "log_drain"
    | "team_member"
    | "api_token"
    | "firewall_rule"
    | "routing_rule"
    | "edge_config"
    | "blob"
    | "cache";
  targetId: SiteFlowId;
  summary: string;
  reason?: string;
  createdAt: IsoTimestamp;
  metadata?: Record<string, unknown>;
}

export interface LogChunk {
  deploymentId: SiteFlowId;
  buildJobId: SiteFlowId;
  cursor: string;
  lines: string[];
  nextCursor?: string;
  complete: boolean;
  fetchedAt: IsoTimestamp;
}
