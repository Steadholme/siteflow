import type { ReleaseChannelName, SiteFlowId } from "@domain/siteflow";
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
} from "@domain/readModels";
import type {
  AbortRollingReleaseCommand,
  AdvanceRollingReleaseCommand,
  AnalyticsEventCommand,
  CompleteRollingReleaseCommand,
  CreateApiTokenCommand,
  CreateFirewallRuleCommand,
  CreateProjectCommand,
  CreateCronJobCommand,
  CreateDeployHookCommand,
  CreateLogDrainCommand,
  DisableCronJobCommand,
  DeliverLogDrainCommand,
  DeleteBlobCommand,
  DeleteEdgeConfigCommand,
  DisableFirewallRuleCommand,
  GetBlobCommand,
  GetFunctionRuntimeCommand,
  ImageOptimizationUrlCommand,
  GitWebhookCommand,
  DisableRoutingRuleCommand,
  ListCacheEntriesCommand,
  ListFunctionsCommand,
  ListBlobsCommand,
  ListRoutingRulesCommand,
  LogQueryCommand,
  MatchRoutingRulesCommand,
  PromoteDeploymentCommand,
  PurgeCacheCommand,
  PutBlobCommand,
  RemoveTeamMemberCommand,
  RevokeDeployHookCommand,
  RevokeApiTokenCommand,
  RollbackDeploymentCommand,
  RunCronJobCommand,
  SaveLogQueryCommand,
  SiteFlowClient,
  StartRollingReleaseCommand,
  TriggerDeployHookCommand,
  UpdateProjectCommand,
  UpsertEdgeConfigCommand,
  UpsertRoutingRuleCommand,
  UpsertTeamMemberCommand,
  UpsertEnvironmentVariableCommand
} from "./siteflowClient";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpSiteFlowClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
}

export class SiteFlowHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string
  ) {
    super(message);
    this.name = "SiteFlowHttpError";
  }
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

function endpoint(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

async function responseMessage(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => undefined)) as { message?: string; error?: string } | undefined;
    return body?.message ?? body?.error ?? response.statusText;
  }

  const body = await response.text().catch(() => "");
  return body || response.statusText;
}

export class HttpSiteFlowClient implements SiteFlowClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpSiteFlowClientOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error("SiteFlow API base URL is required.");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  listProjects(): Promise<ProjectListReadModel> {
    return this.request("/api/projects");
  }

  getProject(projectId: SiteFlowId): Promise<ProjectDetailReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}`);
  }

  getProjectSettings(projectId: SiteFlowId): Promise<ProjectSettingsReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/settings`);
  }

  createProject(command: CreateProjectCommand): Promise<ProjectMutationReadModel> {
    return this.request("/api/projects", {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  updateProject(projectId: SiteFlowId, command: UpdateProjectCommand): Promise<ProjectMutationReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(command)
    });
  }

  archiveProject(projectId: SiteFlowId): Promise<ProjectMutationReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}`, {
      method: "DELETE"
    });
  }

  getProjectEnvironmentSettings(projectId: SiteFlowId): Promise<ProjectEnvironmentSettingsReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/environments`);
  }

  upsertEnvironmentVariable(command: UpsertEnvironmentVariableCommand): Promise<ProjectEnvironmentVariableUpsertReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/environment-variables`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  upsertTeamMember(command: UpsertTeamMemberCommand): Promise<TeamMemberMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/team-members`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  removeTeamMember(command: RemoveTeamMemberCommand): Promise<TeamMemberMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/team-members/${encodePath(command.memberId)}`, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  createApiToken(command: CreateApiTokenCommand): Promise<ApiTokenCreateReadModel> {
    const path = command.projectId
      ? `/api/projects/${encodePath(command.projectId)}/api-tokens`
      : "/api/api-tokens";

    return this.request(path, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  revokeApiToken(command: RevokeApiTokenCommand): Promise<ApiTokenRevokeReadModel> {
    const path = command.projectId
      ? `/api/projects/${encodePath(command.projectId)}/api-tokens/${encodePath(command.tokenId)}`
      : `/api/api-tokens/${encodePath(command.tokenId)}`;

    return this.request(path, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  listFirewallRules(projectId: SiteFlowId): Promise<FirewallRuleListReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/firewall-rules`);
  }

  createFirewallRule(command: CreateFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/firewall-rules`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  disableFirewallRule(command: DisableFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/firewall-rules/${encodePath(command.ruleId)}`, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  getEdgeConfig(projectId: SiteFlowId): Promise<EdgeConfigReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/edge-config`);
  }

  upsertEdgeConfig(command: UpsertEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/edge-config/${encodePath(command.key)}`, {
      method: "PUT",
      body: JSON.stringify(command)
    });
  }

  deleteEdgeConfig(command: DeleteEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/edge-config/${encodePath(command.key)}`, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  listBlobs(command: ListBlobsCommand): Promise<BlobListReadModel> {
    const params = new URLSearchParams();

    if (command.prefix) {
      params.set("prefix", command.prefix);
    }

    if (command.limit) {
      params.set("limit", String(command.limit));
    }

    if (command.cursor) {
      params.set("cursor", command.cursor);
    }

    const query = params.toString();
    return this.request(`/api/projects/${encodePath(command.projectId)}/blobs${query ? `?${query}` : ""}`);
  }

  putBlob(command: PutBlobCommand): Promise<BlobPutReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/blobs`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  getBlob(command: GetBlobCommand): Promise<BlobReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/blobs/${encodePath(command.pathname)}`);
  }

  deleteBlob(command: DeleteBlobCommand): Promise<BlobDeleteReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/blobs/${encodePath(command.pathname)}`, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  imageOptimizationUrl(command: ImageOptimizationUrlCommand): string {
    const params = new URLSearchParams({
      url: command.source,
      w: String(command.width)
    });

    if (command.quality !== undefined) {
      params.set("q", String(command.quality));
    }

    if (command.format) {
      params.set("format", command.format);
    }

    return `${this.baseUrl}/_siteflow/image?${params.toString()}`;
  }

  listCacheEntries(command: ListCacheEntriesCommand): Promise<CacheListReadModel> {
    const params = new URLSearchParams();

    if (command.path) {
      params.set("path", command.path);
    }

    if (command.tag) {
      params.set("tag", command.tag);
    }

    if (command.status) {
      params.set("status", command.status);
    }

    if (command.limit) {
      params.set("limit", String(command.limit));
    }

    const query = params.toString();
    return this.request(`/api/projects/${encodePath(command.projectId)}/cache${query ? `?${query}` : ""}`);
  }

  purgeCache(command: PurgeCacheCommand): Promise<CachePurgeReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/cache/purge`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  listFunctions(command: ListFunctionsCommand): Promise<FunctionRuntimeListReadModel> {
    const params = new URLSearchParams();

    if (command.deploymentId) {
      params.set("deploymentId", command.deploymentId);
    }

    const query = params.toString();
    return this.request(`/api/projects/${encodePath(command.projectId)}/functions${query ? `?${query}` : ""}`);
  }

  getFunctionRuntime(command: GetFunctionRuntimeCommand): Promise<FunctionRuntimeReadModel> {
    const params = new URLSearchParams();

    if (command.deploymentId) {
      params.set("deploymentId", command.deploymentId);
    }

    if (command.limit) {
      params.set("limit", String(command.limit));
    }

    const query = params.toString();
    return this.request(`/api/projects/${encodePath(command.projectId)}/functions/${encodePath(command.path)}${query ? `?${query}` : ""}`);
  }

  listRoutingRules(command: ListRoutingRulesCommand): Promise<RoutingRuleListReadModel> {
    const params = new URLSearchParams();

    if (command.kind) {
      params.set("kind", command.kind);
    }

    if (command.status) {
      params.set("status", command.status);
    }

    const query = params.toString();
    return this.request(`/api/projects/${encodePath(command.projectId)}/routing-rules${query ? `?${query}` : ""}`);
  }

  upsertRoutingRule(command: UpsertRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/routing-rules`, {
      method: "PUT",
      body: JSON.stringify(command)
    });
  }

  disableRoutingRule(command: DisableRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/routing-rules/${encodePath(command.ruleId)}`, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  matchRoutingRules(command: MatchRoutingRulesCommand): Promise<RoutingRuleMatchReadModel> {
    const params = new URLSearchParams({
      path: command.path
    });

    return this.request(`/api/projects/${encodePath(command.projectId)}/routing-rules/match?${params.toString()}`);
  }

  listDeployHooks(projectId: SiteFlowId): Promise<DeployHookListReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/deploy-hooks`);
  }

  createDeployHook(command: CreateDeployHookCommand): Promise<DeployHookCreateReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/deploy-hooks`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  revokeDeployHook(command: RevokeDeployHookCommand): Promise<DeployHookRevokeReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/deploy-hooks/${encodePath(command.hookId)}`, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  triggerDeployHook(command: TriggerDeployHookCommand): Promise<DeployHookTriggerReadModel> {
    const { token, ...body } = command;

    return this.request(`/api/deploy-hooks/${encodePath(command.token)}/trigger`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  listCronJobs(projectId: SiteFlowId): Promise<CronJobListReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/cron-jobs`);
  }

  createCronJob(command: CreateCronJobCommand): Promise<CronJobCreateReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/cron-jobs`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  disableCronJob(command: DisableCronJobCommand): Promise<CronJobDisableReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/cron-jobs/${encodePath(command.jobId)}`, {
      method: "DELETE",
      body: JSON.stringify(command)
    });
  }

  runCronJob(command: RunCronJobCommand): Promise<CronJobRunReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/cron-jobs/${encodePath(command.jobId)}/run`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  ingestGitWebhook(command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> {
    return this.request(`/api/webhooks/git/${encodePath(command.provider)}`, {
      method: "POST",
      headers: {
        "x-siteflow-delivery": command.deliveryId
      },
      body: JSON.stringify(command.event)
    });
  }

  ingestAnalyticsEvent(command: AnalyticsEventCommand): Promise<AnalyticsIngestReadModel> {
    const { projectId, ...body } = command;

    return this.request(`/api/projects/${encodePath(projectId)}/analytics/events`, {
      method: "POST",
      body: JSON.stringify(body),
      credentials: "omit"
    });
  }

  getAnalyticsDashboard(projectId: SiteFlowId): Promise<AnalyticsDashboardReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/analytics`);
  }

  queryLogs(command: LogQueryCommand): Promise<LogQueryReadModel> {
    const params = new URLSearchParams();

    if (command.source) {
      params.set("source", command.source);
    }

    if (command.severity) {
      params.set("severity", command.severity);
    }

    if (command.deploymentId) {
      params.set("deploymentId", command.deploymentId);
    }

    if (command.search) {
      params.set("search", command.search);
    }

    if (command.limit) {
      params.set("limit", String(command.limit));
    }

    if (command.cursor) {
      params.set("cursor", command.cursor);
    }

    const query = params.toString();
    return this.request(`/api/projects/${encodePath(command.projectId)}/logs${query ? `?${query}` : ""}`);
  }

  listSavedLogQueries(projectId: SiteFlowId): Promise<SavedLogQueryListReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/log-queries`);
  }

  saveLogQuery(command: SaveLogQueryCommand): Promise<SavedLogQueryMutationReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/log-queries`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  listLogDrains(projectId: SiteFlowId): Promise<LogDrainListReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/log-drains`);
  }

  createLogDrain(command: CreateLogDrainCommand): Promise<LogDrainCreateReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/log-drains`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  deliverLogDrain(command: DeliverLogDrainCommand): Promise<LogDrainDeliveryReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/log-drains/${encodePath(command.drainId)}/deliver`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  listDeployments(projectId?: SiteFlowId): Promise<DeploymentListReadModel> {
    const params = new URLSearchParams();

    if (projectId) {
      params.set("projectId", projectId);
    }

    const query = params.toString();
    return this.request(`/api/deployments${query ? `?${query}` : ""}`);
  }

  getDeployment(deploymentId: SiteFlowId): Promise<DeploymentDetailReadModel> {
    return this.request(`/api/deployments/${encodePath(deploymentId)}`);
  }

  getReleaseConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<ReleaseConsoleReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/release/${encodePath(channel)}`);
  }

  getRollbackConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollbackConsoleReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/rollback/${encodePath(channel)}`);
  }

  promoteDeployment(command: PromoteDeploymentCommand): Promise<CommandResultReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/release/${encodePath(command.channel)}/promote`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  rollbackDeployment(command: RollbackDeploymentCommand): Promise<CommandResultReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/rollback/${encodePath(command.channel)}/rollback`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  getRollingRelease(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollingReleaseReadModel> {
    return this.request(`/api/projects/${encodePath(projectId)}/rolling/${encodePath(channel)}`);
  }

  startRollingRelease(command: StartRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/rolling/${encodePath(command.channel)}/start`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  advanceRollingRelease(command: AdvanceRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/rolling/${encodePath(command.channel)}/advance`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  completeRollingRelease(command: CompleteRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/rolling/${encodePath(command.channel)}/complete`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  abortRollingRelease(command: AbortRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    return this.request(`/api/projects/${encodePath(command.projectId)}/rolling/${encodePath(command.channel)}/abort`, {
      method: "POST",
      body: JSON.stringify(command)
    });
  }

  pollOperation(operationId: SiteFlowId): Promise<OperationSnapshotReadModel> {
    return this.request(`/api/operations/${encodePath(operationId)}`);
  }

  getLogChunk(deploymentId: SiteFlowId, cursor?: string): Promise<LogChunkReadModel> {
    const params = new URLSearchParams();

    if (cursor) {
      params.set("cursor", cursor);
    }

    const query = params.toString();
    return this.request(`/api/deployments/${encodePath(deploymentId)}/logs${query ? `?${query}` : ""}`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(endpoint(path), `${this.baseUrl}/`);
    const headers = new Headers(init.headers);

    headers.set("accept", "application/json");

    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await this.fetchImpl(url, {
      ...init,
      headers,
      credentials: init.credentials ?? "same-origin"
    });

    if (!response.ok) {
      throw new SiteFlowHttpError(response.status, url.pathname, await responseMessage(response));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
