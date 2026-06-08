import type {
  BlobObject,
  CacheEntry,
  LogDrain,
  EdgeConfigEntry,
  FirewallRule,
  FunctionEntrypoint,
  FunctionInvocation,
  ObservabilityLogEntry,
  ObservabilityLogSeverity,
  ApiToken,
  ReleaseChannelName,
  RoutingRule,
  RouteRevision,
  SavedLogQuery,
  SiteFlowId,
  TeamMember
} from "@domain/siteflow";
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
  DeploymentSummaryReadModel,
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
import { redactSecrets, type RedactionOptions } from "@lib/redaction";
import { normalizeAnalyticsEventInput } from "@lib/analytics";
import {
  fixtureConsoleKey,
  siteflowFixtures,
  type FixtureScenarioData
} from "@lib/fixtures/siteflow.fixtures";
import { isSiteFlowScenarioName, type SiteFlowScenarioName } from "./scenarioContracts";
import type {
  AbortRollingReleaseCommand,
  AdvanceRollingReleaseCommand,
  AnalyticsEventCommand,
  CompleteRollingReleaseCommand,
  CreateApiTokenCommand,
  CreateCronJobCommand,
  CreateProjectCommand,
  CreateDeployHookCommand,
  CreateFirewallRuleCommand,
  CreateLogDrainCommand,
  DeleteBlobCommand,
  DeleteEdgeConfigCommand,
  DisableCronJobCommand,
  DisableFirewallRuleCommand,
  DeliverLogDrainCommand,
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

export interface FixtureSiteFlowClientOptions {
  scenario?: SiteFlowScenarioName;
  redaction?: RedactionOptions;
}

function assertReleaseCommand(command: PromoteDeploymentCommand | RollbackDeploymentCommand) {
  if (!command.projectId || !command.channel || !command.targetDeploymentId || !command.idempotencyKey) {
    throw new Error("Release command requires project, channel, target deployment, and idempotency key.");
  }

  if (!command.actor?.id || !command.reason.trim()) {
    throw new Error("Release command requires actor and audit reason.");
  }
}

function assertRollingCommand(command: StartRollingReleaseCommand | AdvanceRollingReleaseCommand | CompleteRollingReleaseCommand | AbortRollingReleaseCommand) {
  if (!command.projectId || !command.channel || !command.idempotencyKey) {
    throw new Error("Rolling release command requires project, channel, and idempotency key.");
  }

  if (!command.actor?.id || !command.reason.trim()) {
    throw new Error("Rolling release command requires actor and audit reason.");
  }
}

function buildSettingsFor(
  project: { framework: string; buildSettings?: ProjectSettingsReadModel["project"]["buildSettings"] },
  overrides?: UpdateProjectCommand["buildSettings"]
) {
  return {
    installCommand: overrides?.installCommand ?? project.buildSettings?.installCommand ?? "npm install",
    buildCommand: overrides?.buildCommand ?? project.buildSettings?.buildCommand ?? "npm run build",
    outputDirectory: overrides?.outputDirectory ?? project.buildSettings?.outputDirectory ?? "dist",
    rootDirectory: overrides?.rootDirectory ?? project.buildSettings?.rootDirectory,
    framework: overrides?.framework ?? project.buildSettings?.framework ?? project.framework
  };
}

function uniqueDeployments(deployments: DeploymentSummaryReadModel[]) {
  const seen = new Set<string>();

  return deployments.filter((deployment) => {
    if (seen.has(deployment.id)) {
      return false;
    }

    seen.add(deployment.id);
    return true;
  });
}

function assertFixtureRolloutPercentage(value: number, allowComplete = false) {
  if (!Number.isInteger(value) || value < 1 || value > (allowComplete ? 100 : 99)) {
    throw new Error(`Rolling release percentage must be an integer from 1 to ${allowComplete ? 100 : 99}.`);
  }
}

function fixtureLogSeverity(line: string): ObservabilityLogSeverity {
  if (/error|failed|exception/i.test(line)) {
    return "error";
  }

  return /warn|retry/i.test(line) ? "warning" : "info";
}

function fixtureId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "default";
}

function fixtureTeamMembers(projectId: SiteFlowId): TeamMember[] {
  return [
    {
      id: `member_${fixtureId(projectId)}_owner`,
      projectId,
      actor: {
        id: "actor-maya",
        name: "Maya Chen",
        email: "maya@example.test",
        role: "release_manager"
      },
      role: "owner",
      permissions: ["read", "write", "admin"],
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    },
    {
      id: `member_${fixtureId(projectId)}_viewer`,
      projectId,
      actor: {
        id: "actor-viewer",
        name: "Read Only",
        email: "viewer@example.test",
        role: "operator"
      },
      role: "viewer",
      permissions: ["read"],
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    }
  ];
}

function fixtureApiTokens(projectId: SiteFlowId): ApiToken[] {
  return [
    {
      id: `token_${fixtureId(projectId)}_operator`,
      projectId,
      name: "Operator automation",
      tokenPrefix: "sft_fixture",
      scopes: ["read", "write"],
      status: "active",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    }
  ];
}

function fixtureFirewallRules(projectId: SiteFlowId): FirewallRule[] {
  return [
    {
      id: "fw_fixture_block_admin",
      projectId,
      name: "Block admin paths",
      action: "block",
      priority: 10,
      status: "active",
      conditions: {
        pathPattern: "/admin/*"
      },
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    }
  ];
}

function fixtureRoutingRules(projectId: SiteFlowId): RoutingRule[] {
  return [
    {
      id: `route_${fixtureId(projectId)}_docs_redirect`,
      projectId,
      name: "Docs moved",
      kind: "redirect",
      source: "/docs",
      destination: "/documentation",
      statusCode: 308,
      priority: 10,
      status: "active",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z"
    },
    {
      id: `route_${fixtureId(projectId)}_blog_rewrite`,
      projectId,
      name: "Blog rewrite",
      kind: "rewrite",
      source: "/blog/:slug",
      destination: "/posts/:slug",
      priority: 20,
      status: "active",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z"
    },
    {
      id: `route_${fixtureId(projectId)}_security_headers`,
      projectId,
      name: "Security headers",
      kind: "header",
      source: "/(.*)",
      headers: [
        {
          key: "x-frame-options",
          value: "DENY"
        }
      ],
      priority: 30,
      status: "active",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z"
    }
  ];
}

function fixtureEdgeConfig(projectId: SiteFlowId): EdgeConfigEntry[] {
  return [
    {
      id: `edge_${fixtureId(projectId)}_maintenance`,
      projectId,
      key: "maintenance",
      value: false,
      valueType: "boolean",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    }
  ];
}

function fixtureBlobContent() {
  return btoa("SiteFlow fixture blob");
}

function fixtureBlobs(projectId: SiteFlowId): BlobObject[] {
  return [
    {
      id: `blob_${fixtureId(projectId)}_assets_fixture_txt`,
      projectId,
      pathname: "assets/fixture.txt",
      access: "public",
      contentType: "text/plain",
      cacheControlMaxAge: 3600,
      size: atob(fixtureBlobContent()).length,
      sha256: "sha256:fixture",
      etag: "\"fixture\"",
      url: `/api/projects/${encodeURIComponent(projectId)}/blobs/${encodeURIComponent("assets/fixture.txt")}`,
      uploadedAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    }
  ];
}

function fixtureCacheEntries(projectId: SiteFlowId): CacheEntry[] {
  return [
    {
      id: `cache_${fixtureId(projectId)}_home`,
      projectId,
      key: "page:/",
      path: "/",
      tags: ["home", "marketing"],
      status: "fresh",
      contentType: "text/html; charset=utf-8",
      size: 4096,
      etag: "\"cache-home\"",
      maxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 300,
      lastGeneratedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2026-05-27T00:01:00.000Z",
      staleAt: "2026-05-27T00:06:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z"
    },
    {
      id: `cache_${fixtureId(projectId)}_pricing`,
      projectId,
      key: "page:/pricing",
      path: "/pricing",
      tags: ["marketing", "pricing"],
      status: "stale",
      contentType: "text/html; charset=utf-8",
      size: 8192,
      etag: "\"cache-pricing\"",
      maxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 300,
      lastGeneratedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2026-05-27T00:01:00.000Z",
      staleAt: "2026-05-27T00:06:00.000Z",
      updatedAt: "2026-05-27T00:06:00.000Z"
    }
  ];
}

function fixtureFunctions(): FunctionEntrypoint[] {
  return [
    {
      path: "/api/revalidate",
      sourcePath: ".siteflow/functions/api/revalidate.js",
      runtime: "nodejs20.x",
      handler: "default",
      methods: ["POST"],
      timeoutMs: 10000,
      memoryMb: 512,
      concurrency: 50
    }
  ];
}

function fixtureFunctionInvocations(projectId: SiteFlowId, deploymentId: SiteFlowId): FunctionInvocation[] {
  return [
    {
      id: "fninv_success",
      deploymentId,
      projectId,
      path: "/api/revalidate",
      method: "POST",
      status: "succeeded",
      responseStatus: 200,
      durationMs: 42,
      requestId: "req_success",
      logs: ["Revalidated home"],
      invokedAt: "2026-05-27T00:10:00.000Z"
    },
    {
      id: "fninv_failed",
      deploymentId,
      projectId,
      path: "/api/revalidate",
      method: "POST",
      status: "failed",
      responseStatus: 500,
      durationMs: 180,
      requestId: "req_failed",
      errorMessage: "Revalidate failed.",
      logs: ["Revalidate failed."],
      invokedAt: "2026-05-27T00:11:00.000Z"
    }
  ];
}

function functionSummary(invocations: FunctionInvocation[]) {
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

function edgeValueType(value: unknown): EdgeConfigEntry["valueType"] {
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

export class FixtureSiteFlowClient implements SiteFlowClient {
  private readonly fixture: FixtureScenarioData;
  private readonly redaction?: RedactionOptions;

  constructor(options: SiteFlowScenarioName | FixtureSiteFlowClientOptions = {}) {
    const scenario = typeof options === "string" ? options : options.scenario ?? "healthy";

    if (!isSiteFlowScenarioName(scenario)) {
      throw new Error(`Unknown SiteFlow fixture scenario: ${scenario}`);
    }

    this.fixture = siteflowFixtures[scenario];
    this.redaction = typeof options === "string" ? undefined : options.redaction;
  }

  async listProjects(): Promise<ProjectListReadModel> {
    return this.fromFixture(this.fixture.projectList);
  }

  async getProject(projectId: SiteFlowId): Promise<ProjectDetailReadModel> {
    return this.fromFixture(this.findById(this.fixture.projects, projectId, "project"));
  }

  async getProjectSettings(projectId: SiteFlowId): Promise<ProjectSettingsReadModel> {
    const project = await this.getProject(projectId);
    return this.fromFixture({
      project: project.project,
      environments: [
        {
          projectId,
          name: "local",
          type: "local",
          createdAt: project.project.createdAt,
          updatedAt: project.project.updatedAt
        },
        {
          projectId,
          name: "preview",
          type: "preview",
          branchPattern: "*",
          createdAt: project.project.createdAt,
          updatedAt: project.project.updatedAt
        },
        {
          projectId,
          name: "production",
          type: "production",
          branchPattern: project.project.productionBranch ?? project.project.defaultBranch,
          createdAt: project.project.createdAt,
          updatedAt: project.project.updatedAt
        }
      ],
      environmentVariables: [],
      teamMembers: fixtureTeamMembers(projectId),
      apiTokens: fixtureApiTokens(projectId),
      auditEvents: project.recentEvents.auditEvents,
      currentPermissions: ["read", "write", "admin"]
    });
  }

  async createProject(command: CreateProjectCommand): Promise<ProjectMutationReadModel> {
    const now = new Date().toISOString();
    const project = {
      id: `project_${command.slug}`,
      slug: command.slug,
      name: command.name,
      status: "active" as const,
      framework: command.framework ?? command.buildSettings?.framework ?? "static",
      defaultBranch: command.defaultBranch ?? "main",
      productionBranch: command.productionBranch ?? command.defaultBranch ?? "main",
      repository: command.repository ?? {
        provider: "generic" as const,
        owner: "local",
        name: command.slug,
        defaultBranch: command.defaultBranch ?? "main"
      },
      buildSettings: {
        installCommand: command.buildSettings?.installCommand ?? "npm install",
        buildCommand: command.buildSettings?.buildCommand ?? "npm run build",
        outputDirectory: command.buildSettings?.outputDirectory ?? "dist",
        framework: command.buildSettings?.framework ?? command.framework ?? "static",
        rootDirectory: command.buildSettings?.rootDirectory
      },
      domains: command.domains ?? [],
      policy: {
        requiredChecks: [],
        retentionDays: 30,
        previewDeploymentsEnabled: true,
        cdnEnabled: false,
        requirePromotionReason: true
      },
      secrets: [],
      createdAt: now,
      updatedAt: now
    };

    return this.fromFixture({
      status: "created",
      project,
      message: "Project created."
    });
  }

  async updateProject(projectId: SiteFlowId, command: UpdateProjectCommand): Promise<ProjectMutationReadModel> {
    const project = (await this.getProjectSettings(projectId)).project;
    const updatedProject = {
      ...project,
      slug: command.slug ?? project.slug,
      name: command.name ?? project.name,
      framework: command.framework ?? project.framework,
      defaultBranch: command.defaultBranch ?? project.defaultBranch,
      productionBranch: command.productionBranch ?? project.productionBranch,
      repository: command.repository ?? project.repository,
      buildSettings: buildSettingsFor(project, command.buildSettings),
      domains: command.domains ?? project.domains,
      updatedAt: new Date().toISOString()
    };

    return this.fromFixture({
      status: "updated",
      project: updatedProject,
      message: "Project updated."
    });
  }

  async archiveProject(projectId: SiteFlowId): Promise<ProjectMutationReadModel> {
    const project = (await this.getProjectSettings(projectId)).project;
    return this.fromFixture({
      status: "archived",
      project: {
        ...project,
        status: "archived",
        updatedAt: new Date().toISOString()
      },
      message: "Project archived."
    });
  }

  async getProjectEnvironmentSettings(projectId: SiteFlowId): Promise<ProjectEnvironmentSettingsReadModel> {
    const settings = await this.getProjectSettings(projectId);
    return this.fromFixture({
      projectId,
      environments: settings.environments,
      environmentVariables: settings.environmentVariables,
      updatedAt: new Date().toISOString()
    });
  }

  async upsertEnvironmentVariable(command: UpsertEnvironmentVariableCommand): Promise<ProjectEnvironmentVariableUpsertReadModel> {
    return this.fromFixture({
      status: "upserted",
      variable: {
        id: `env_${command.projectId}_${command.targetEnvironment}_${command.key}`,
        projectId: command.projectId,
        key: command.key,
        targetEnvironment: command.targetEnvironment,
        scope: command.scope,
        source: command.source ?? "sealed",
        fingerprint: "sha256:redacted",
        updatedAt: new Date().toISOString(),
        updatedBy: command.actor
      },
      message: "Environment variable metadata saved."
    });
  }

  async upsertTeamMember(command: UpsertTeamMemberCommand): Promise<TeamMemberMutationReadModel> {
    const now = new Date().toISOString();
    const permissions = command.role === "owner"
      ? ["read", "write", "admin"] as const
      : command.role === "viewer"
        ? ["read"] as const
        : ["read", "write"] as const;

    return this.fromFixture({
      status: "upserted",
      member: {
        id: `member_${fixtureId(`${command.projectId}_${command.actor.id}`)}`,
        projectId: command.projectId,
        actor: command.actor,
        role: command.role,
        permissions: [...permissions],
        createdAt: now,
        updatedAt: now
      },
      message: "Team member saved."
    });
  }

  async removeTeamMember(command: RemoveTeamMemberCommand): Promise<TeamMemberMutationReadModel> {
    const existing = fixtureTeamMembers(command.projectId).find((member) => member.id === command.memberId);

    return this.fromFixture({
      status: "removed",
      member: existing,
      message: "Team member removed."
    });
  }

  async createApiToken(command: CreateApiTokenCommand): Promise<ApiTokenCreateReadModel> {
    const now = new Date().toISOString();
    const secret = "sft_fixture_secret";

    return this.fromFixture({
      status: "created",
      token: {
        id: `token_${fixtureId(`${command.projectId ?? "global"}_${command.name}`)}`,
        projectId: command.projectId,
        name: command.name,
        tokenPrefix: secret.slice(0, 12),
        scopes: command.scopes,
        status: "active",
        createdBy: command.actor,
        createdAt: now,
        updatedAt: now
      },
      secret,
      message: "API token created. Store the token now; it will not be shown again."
    });
  }

  async revokeApiToken(command: RevokeApiTokenCommand): Promise<ApiTokenRevokeReadModel> {
    const now = new Date().toISOString();

    return this.fromFixture({
      status: "revoked",
      token: {
        id: command.tokenId,
        projectId: command.projectId,
        name: "Operator automation",
        tokenPrefix: "sft_fixture",
        scopes: ["read", "write"],
        status: "revoked",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: now,
        revokedAt: now
      },
      message: "API token revoked."
    });
  }

  async listFirewallRules(projectId: SiteFlowId): Promise<FirewallRuleListReadModel> {
    return this.fromFixture({
      projectId,
      rules: fixtureFirewallRules(projectId),
      total: fixtureFirewallRules(projectId).length,
      updatedAt: new Date().toISOString()
    });
  }

  async createFirewallRule(command: CreateFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> {
    const now = new Date().toISOString();
    const rule: FirewallRule = {
      id: `fw_${fixtureId(`${command.projectId}_${command.name}`)}`,
      projectId: command.projectId,
      name: command.name,
      action: command.action,
      priority: command.priority ?? 100,
      status: "active",
      conditions: command.conditions,
      createdBy: command.actor,
      createdAt: now,
      updatedAt: now
    };

    return this.fromFixture({
      status: "created",
      rule,
      message: "Firewall rule created."
    });
  }

  async disableFirewallRule(command: DisableFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> {
    const now = new Date().toISOString();
    const rule = fixtureFirewallRules(command.projectId).find((candidate) => candidate.id === command.ruleId) ?? {
      id: command.ruleId,
      projectId: command.projectId,
      name: "Firewall rule",
      action: "block" as const,
      priority: 100,
      status: "active" as const,
      conditions: {},
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    };

    return this.fromFixture({
      status: "disabled",
      rule: {
        ...rule,
        status: "disabled",
        updatedAt: now,
        disabledAt: now
      },
      message: "Firewall rule disabled."
    });
  }

  async getEdgeConfig(projectId: SiteFlowId): Promise<EdgeConfigReadModel> {
    const entries = fixtureEdgeConfig(projectId);

    return this.fromFixture({
      projectId,
      entries,
      total: entries.length,
      updatedAt: new Date().toISOString()
    });
  }

  async upsertEdgeConfig(command: UpsertEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> {
    const now = new Date().toISOString();
    const entry: EdgeConfigEntry = {
      id: `edge_${fixtureId(`${command.projectId}_${command.key}`)}`,
      projectId: command.projectId,
      key: command.key,
      value: command.value,
      valueType: edgeValueType(command.value),
      createdBy: command.actor,
      updatedBy: command.actor,
      createdAt: now,
      updatedAt: now
    };

    return this.fromFixture({
      status: "upserted",
      entry,
      message: "Edge Config entry saved."
    });
  }

  async deleteEdgeConfig(command: DeleteEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> {
    return this.fromFixture({
      status: "deleted",
      message: `Edge Config entry ${command.key} deleted.`
    });
  }

  async listBlobs(command: ListBlobsCommand): Promise<BlobListReadModel> {
    await this.getProject(command.projectId);

    const limit = Math.min(Math.max(command.limit ?? 100, 1), 1000);
    const blobs = fixtureBlobs(command.projectId)
      .filter((blob) => !command.prefix || blob.pathname.startsWith(command.prefix))
      .filter((blob) => !command.cursor || blob.pathname > command.cursor)
      .slice(0, limit);

    return this.fromFixture({
      projectId: command.projectId,
      blobs,
      total: blobs.length,
      updatedAt: new Date().toISOString()
    });
  }

  async putBlob(command: PutBlobCommand): Promise<BlobPutReadModel> {
    await this.getProject(command.projectId);

    const now = new Date().toISOString();
    const blob: BlobObject = {
      id: `blob_${fixtureId(`${command.projectId}_${command.pathname}`)}`,
      projectId: command.projectId,
      pathname: command.pathname.replace(/^\/+/, ""),
      access: command.access ?? "public",
      contentType: command.contentType ?? "application/octet-stream",
      cacheControlMaxAge: command.cacheControlMaxAge,
      size: atob(command.contentBase64).length,
      sha256: "sha256:fixture",
      etag: "\"fixture\"",
      url: `/api/projects/${encodeURIComponent(command.projectId)}/blobs/${encodeURIComponent(command.pathname)}`,
      uploadedBy: command.actor,
      uploadedAt: now,
      updatedAt: now
    };

    return this.fromFixture({
      status: "uploaded",
      blob,
      message: "Blob uploaded."
    });
  }

  async getBlob(command: GetBlobCommand): Promise<BlobReadModel> {
    await this.getProject(command.projectId);

    const blob = fixtureBlobs(command.projectId).find((candidate) => candidate.pathname === command.pathname) ?? {
      ...fixtureBlobs(command.projectId)[0],
      id: `blob_${fixtureId(`${command.projectId}_${command.pathname}`)}`,
      pathname: command.pathname,
      url: `/api/projects/${encodeURIComponent(command.projectId)}/blobs/${encodeURIComponent(command.pathname)}`
    };

    return this.fromFixture({
      projectId: command.projectId,
      blob,
      contentBase64: fixtureBlobContent()
    });
  }

  async deleteBlob(command: DeleteBlobCommand): Promise<BlobDeleteReadModel> {
    await this.getProject(command.projectId);

    const blob = fixtureBlobs(command.projectId).find((candidate) => candidate.pathname === command.pathname) ?? {
      ...fixtureBlobs(command.projectId)[0],
      id: `blob_${fixtureId(`${command.projectId}_${command.pathname}`)}`,
      pathname: command.pathname,
      url: `/api/projects/${encodeURIComponent(command.projectId)}/blobs/${encodeURIComponent(command.pathname)}`
    };

    return this.fromFixture({
      status: "deleted",
      blob,
      message: "Blob deleted."
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

    return `/_siteflow/image?${params.toString()}`;
  }

  async listCacheEntries(command: ListCacheEntriesCommand): Promise<CacheListReadModel> {
    await this.getProject(command.projectId);

    const limit = Math.min(Math.max(command.limit ?? 100, 1), 1000);
    const entries = fixtureCacheEntries(command.projectId)
      .filter((entry) => !command.path || entry.path === command.path)
      .filter((entry) => !command.tag || entry.tags.includes(command.tag))
      .filter((entry) => !command.status || entry.status === command.status)
      .slice(0, limit);

    return this.fromFixture({
      projectId: command.projectId,
      entries,
      total: entries.length,
      updatedAt: new Date().toISOString()
    });
  }

  async purgeCache(command: PurgeCacheCommand): Promise<CachePurgeReadModel> {
    await this.getProject(command.projectId);

    if (!command.path && !command.tag) {
      throw new Error("Cache purge requires path or tag.");
    }

    const purgedAt = new Date().toISOString();
    const purged = fixtureCacheEntries(command.projectId)
      .filter((entry) => !command.path || entry.path === command.path)
      .filter((entry) => !command.tag || entry.tags.includes(command.tag))
      .map((entry) => ({
        ...entry,
        status: "purged" as const,
        purgedAt,
        updatedAt: purgedAt
      }));

    return this.fromFixture({
      status: "purged",
      projectId: command.projectId,
      purged,
      total: purged.length,
      message: `Purged ${purged.length} cache entr${purged.length === 1 ? "y" : "ies"}.`
    });
  }

  async listFunctions(command: ListFunctionsCommand): Promise<FunctionRuntimeListReadModel> {
    const project = await this.getProject(command.projectId);
    const productionDeployment = project.channels.find((channel) => channel.channel.name === "production")?.currentDeployment;
    const deploymentId = command.deploymentId ?? productionDeployment?.id ?? project.deployments[0]?.id ?? "dep-healthy";
    const functions = fixtureFunctions().map((entry) => {
      const invocations = fixtureFunctionInvocations(command.projectId, deploymentId).filter((invocation) => invocation.path === entry.path);

      return {
        projectId: command.projectId,
        deploymentId,
        function: entry,
        limits: {
          timeoutMs: entry.timeoutMs ?? 10000,
          memoryMb: entry.memoryMb ?? 512,
          concurrency: entry.concurrency ?? 50
        },
        summary: functionSummary(invocations)
      };
    });

    return this.fromFixture({
      projectId: command.projectId,
      deploymentId,
      functions,
      total: functions.length,
      updatedAt: new Date().toISOString()
    });
  }

  async getFunctionRuntime(command: GetFunctionRuntimeCommand): Promise<FunctionRuntimeReadModel> {
    const list = await this.listFunctions({
      projectId: command.projectId,
      deploymentId: command.deploymentId
    });
    const item = list.functions.find((entry) => entry.function.path === command.path);

    if (!item) {
      throw new Error(`Unknown function: ${command.path}`);
    }

    const limit = Math.min(Math.max(command.limit ?? 20, 1), 100);
    const recentInvocations = fixtureFunctionInvocations(command.projectId, item.deploymentId)
      .filter((invocation) => invocation.path === command.path)
      .slice(0, limit);

    return this.fromFixture({
      projectId: command.projectId,
      deploymentId: item.deploymentId,
      function: item,
      recentInvocations,
      updatedAt: new Date().toISOString()
    });
  }

  async listRoutingRules(command: ListRoutingRulesCommand): Promise<RoutingRuleListReadModel> {
    await this.getProject(command.projectId);

    const rules = fixtureRoutingRules(command.projectId)
      .filter((rule) => !command.kind || rule.kind === command.kind)
      .filter((rule) => !command.status || rule.status === command.status);

    return this.fromFixture({
      projectId: command.projectId,
      rules,
      total: rules.length,
      updatedAt: new Date().toISOString()
    });
  }

  async upsertRoutingRule(command: UpsertRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> {
    await this.getProject(command.projectId);

    const now = new Date().toISOString();
    const rule: RoutingRule = {
      id: `route_${fixtureId(`${command.projectId}_${command.name}`)}`,
      projectId: command.projectId,
      name: command.name,
      kind: command.kind,
      source: command.source,
      destination: command.destination,
      statusCode: command.statusCode,
      headers: command.headers,
      priority: command.priority ?? 100,
      status: "active",
      createdBy: command.actor,
      updatedBy: command.actor,
      createdAt: now,
      updatedAt: now
    };

    return this.fromFixture({
      status: "upserted",
      rule,
      message: "Routing rule saved."
    });
  }

  async disableRoutingRule(command: DisableRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> {
    await this.getProject(command.projectId);

    const now = new Date().toISOString();
    const rule = fixtureRoutingRules(command.projectId).find((candidate) => candidate.id === command.ruleId) ?? {
      id: command.ruleId,
      projectId: command.projectId,
      name: "Routing rule",
      kind: "redirect" as const,
      source: "/old",
      destination: "/new",
      statusCode: 308 as const,
      priority: 100,
      status: "active" as const,
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z"
    };

    return this.fromFixture({
      status: "disabled",
      rule: {
        ...rule,
        status: "disabled",
        updatedBy: command.actor,
        updatedAt: now,
        disabledAt: now
      },
      message: "Routing rule disabled."
    });
  }

  async matchRoutingRules(command: MatchRoutingRulesCommand): Promise<RoutingRuleMatchReadModel> {
    await this.getProject(command.projectId);

    const active = fixtureRoutingRules(command.projectId).filter((rule) => rule.status === "active");

    return this.fromFixture({
      projectId: command.projectId,
      path: command.path,
      redirect: command.path === "/docs" ? active.find((rule) => rule.kind === "redirect") : undefined,
      rewrite: command.path.startsWith("/blog/") ? active.find((rule) => rule.kind === "rewrite") : undefined,
      headers: active.filter((rule) => rule.kind === "header"),
      rewrittenPath: command.path.startsWith("/blog/") ? command.path.replace(/^\/blog\//, "/posts/") : undefined,
      updatedAt: new Date().toISOString()
    });
  }

  async listDeployHooks(projectId: SiteFlowId): Promise<DeployHookListReadModel> {
    return this.fromFixture({
      projectId,
      hooks: [
        {
          id: "hook_fixture_preview",
          projectId,
          name: "Preview rebuild",
          branch: "main",
          targetEnvironment: "preview",
          tokenPrefix: "sfh_fixture",
          status: "active",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z"
        }
      ],
      total: 1,
      updatedAt: new Date().toISOString()
    });
  }

  async createDeployHook(command: CreateDeployHookCommand): Promise<DeployHookCreateReadModel> {
    const token = "sfh_fixture_token";

    return this.fromFixture({
      status: "created",
      hook: {
        id: "hook_fixture_preview",
        projectId: command.projectId,
        name: command.name,
        branch: command.branch ?? "main",
        targetEnvironment: command.targetEnvironment ?? "preview",
        tokenPrefix: token.slice(0, 12),
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      token,
      hookUrl: `https://siteflow.example.com/api/deploy-hooks/${token}/trigger`,
      message: "Deploy hook created."
    });
  }

  async revokeDeployHook(command: RevokeDeployHookCommand): Promise<DeployHookRevokeReadModel> {
    return this.fromFixture({
      status: "revoked",
      hook: {
        id: command.hookId,
        projectId: command.projectId,
        name: "Preview rebuild",
        branch: "main",
        targetEnvironment: "preview",
        tokenPrefix: "sfh_fixture",
        status: "revoked",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
        revokedAt: new Date().toISOString()
      },
      message: "Deploy hook revoked."
    });
  }

  async triggerDeployHook(command: TriggerDeployHookCommand): Promise<DeployHookTriggerReadModel> {
    const now = new Date().toISOString();

    return this.fromFixture({
      status: "accepted",
      hook: {
        id: "hook_fixture_preview",
        projectId: "project-acme-dashboard",
        name: "Preview rebuild",
        branch: command.branch ?? "main",
        targetEnvironment: "preview",
        tokenPrefix: command.token.slice(0, 12),
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastTriggeredAt: now
      },
      sourceEvent: {
        id: "src_fixture_hook",
        projectId: "project-acme-dashboard",
        kind: "manual",
        status: "accepted",
        disposition: "build_requested",
        providerDeliveryId: command.idempotencyKey ?? "fixture-hook",
        branch: command.branch ?? "main",
        commitSha: command.commitSha ?? "deploy-hook-fixture",
        commitMessage: command.commitMessage ?? "Deploy hook triggered.",
        commitAuthor: command.commitAuthor ?? "SiteFlow",
        receivedAt: now,
        actor: command.actor ?? {
          id: "deploy-hook:fixture",
          name: "Preview rebuild",
          role: "system"
        }
      },
      buildJobId: "build_fixture_hook",
      message: "Deploy hook accepted and build job queued."
    });
  }

  async listCronJobs(projectId: SiteFlowId): Promise<CronJobListReadModel> {
    return this.fromFixture({
      projectId,
      jobs: [
        {
          id: "cron_fixture_revalidate",
          projectId,
          name: "Revalidate homepage",
          path: "/api/revalidate",
          schedule: "0 * * * *",
          status: "active",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z"
        }
      ],
      total: 1,
      updatedAt: new Date().toISOString()
    });
  }

  async createCronJob(command: CreateCronJobCommand): Promise<CronJobCreateReadModel> {
    const now = new Date().toISOString();

    return this.fromFixture({
      status: "created",
      job: {
        id: `cron_${command.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "job"}`,
        projectId: command.projectId,
        name: command.name,
        path: command.path,
        schedule: command.schedule,
        status: "active",
        createdAt: now,
        updatedAt: now
      },
      message: "Cron job saved."
    });
  }

  async disableCronJob(command: DisableCronJobCommand): Promise<CronJobDisableReadModel> {
    const now = new Date().toISOString();

    return this.fromFixture({
      status: "disabled",
      job: {
        id: command.jobId,
        projectId: command.projectId,
        name: "Revalidate homepage",
        path: "/api/revalidate",
        schedule: "0 * * * *",
        status: "disabled",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: now,
        disabledAt: now
      },
      message: "Cron job disabled."
    });
  }

  async runCronJob(command: RunCronJobCommand): Promise<CronJobRunReadModel> {
    const now = new Date().toISOString();

    return this.fromFixture({
      status: "accepted",
      job: {
        id: command.jobId,
        projectId: command.projectId,
        name: "Revalidate homepage",
        path: "/api/revalidate",
        schedule: "0 * * * *",
        status: "active",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: now,
        lastDispatchedAt: now
      },
      dispatch: {
        id: "crondispatch_fixture",
        cronJobId: command.jobId,
        projectId: command.projectId,
        targetUrl: "https://dashboard.acme.test/api/revalidate",
        method: "GET",
        userAgent: "vercel-cron/1.0",
        status: "queued",
        reason: command.reason ?? "Manual cron run requested.",
        scheduledAt: now,
        dispatchedAt: now
      },
      message: "Cron dispatch queued."
    });
  }

  async ingestGitWebhook(command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> {
    return this.fromFixture({
      status: "accepted",
      sourceEvent: {
        id: `src_${command.deliveryId}`,
        projectId: `project_${command.event.repository.name}`,
        kind: command.event.kind,
        status: "accepted",
        disposition: "build_requested",
        providerDeliveryId: command.deliveryId,
        branch: command.event.branch,
        commitSha: command.event.commitSha,
        commitMessage: command.event.commitMessage,
        commitAuthor: command.event.commitAuthor,
        receivedAt: command.event.receivedAt,
        actor: command.event.actor
      },
      buildJobId: `build_${command.deliveryId}`,
      message: "Git webhook accepted."
    });
  }

  async ingestAnalyticsEvent(command: AnalyticsEventCommand): Promise<AnalyticsIngestReadModel> {
    const event = normalizeAnalyticsEventInput(command);
    const now = new Date().toISOString();

    return this.fromFixture({
      status: "accepted",
      event: {
        id: `analytics_${event.kind}_${event.path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "root"}`,
        projectId: event.projectId,
        kind: event.kind,
        path: event.path,
        referrer: event.referrer,
        country: event.country,
        browser: event.browser,
        device: event.device,
        eventName: event.eventName,
        vitalName: event.vitalName,
        vitalValue: event.vitalValue,
        occurredAt: event.occurredAt,
        receivedAt: now
      },
      message: "Analytics event accepted."
    });
  }

  async getAnalyticsDashboard(projectId: SiteFlowId): Promise<AnalyticsDashboardReadModel> {
    await this.getProject(projectId);

    return this.fromFixture({
      projectId,
      window: "24h",
      totals: {
        pageviews: 4280,
        customEvents: 312,
        webVitals: 840,
        uniquePaths: 24
      },
      topPages: [
        { name: "/", count: 1680, percentage: 39.3 },
        { name: "/pricing", count: 920, percentage: 21.5 },
        { name: "/docs", count: 640, percentage: 15 }
      ],
      referrers: [
        { name: "https://vercel.com/templates", count: 640, percentage: 15 },
        { name: "https://github.com/acme/dashboard", count: 320, percentage: 7.5 }
      ],
      countries: [
        { name: "US", count: 2140, percentage: 39.4 },
        { name: "DE", count: 760, percentage: 14 }
      ],
      browsers: [
        { name: "Chrome", count: 3420, percentage: 62.9 },
        { name: "Safari", count: 1180, percentage: 21.7 }
      ],
      devices: [
        { name: "desktop", count: 3840, percentage: 70.7 },
        { name: "mobile", count: 1220, percentage: 22.5 }
      ],
      customEvents: [
        { name: "signup_clicked", count: 184, percentage: 59 },
        { name: "docs_search", count: 96, percentage: 30.8 }
      ],
      webVitals: [
        { name: "LCP", count: 320, p75: 1840, rating: "good" },
        { name: "INP", count: 300, p75: 180, rating: "good" },
        { name: "CLS", count: 220, p75: 0.08, rating: "good" }
      ],
      updatedAt: new Date().toISOString()
    });
  }

  async queryLogs(command: LogQueryCommand): Promise<LogQueryReadModel> {
    await this.getProject(command.projectId);

    const deploymentIds = command.deploymentId
      ? [command.deploymentId]
      : Object.values(this.fixture.projects)
        .filter((project) => project.project.id === command.projectId)
        .flatMap((project) => project.deployments.map((deployment) => deployment.id));
    const entries: ObservabilityLogEntry[] = deploymentIds.flatMap((deploymentId) => {
      const detail = this.fixture.deployments[deploymentId];
      const chunks = this.fixture.logs[deploymentId] ?? [];

      return chunks.flatMap((chunk) => chunk.chunk.lines.map((line, index): ObservabilityLogEntry => ({
        id: `log_${fixtureId(deploymentId)}_${index}`,
        projectId: command.projectId,
        source: "build",
        severity: fixtureLogSeverity(line),
        message: line,
        timestamp: chunk.chunk.fetchedAt,
        deploymentId,
        buildJobId: chunk.chunk.buildJobId,
        metadata: {
          deploymentStatus: detail?.deployment.status,
          cursor: chunk.chunk.cursor
        }
      })));
    });

    entries.push(
      {
        id: "log_fixture_function",
        projectId: command.projectId,
        source: "function",
        severity: "info",
        message: "GET /api/revalidate completed with status 200",
        timestamp: new Date().toISOString(),
        deploymentId: deploymentIds[0],
        requestId: "req_fixture"
      },
      {
        id: "log_fixture_cron",
        projectId: command.projectId,
        source: "cron",
        severity: "info",
        message: "Cron dispatch queued for /api/revalidate",
        timestamp: new Date().toISOString(),
        cronJobId: "cron_fixture_revalidate"
      }
    );

    const severityRank: Record<ObservabilityLogSeverity, number> = { info: 0, warning: 1, error: 2 };
    const minimumSeverity = command.severity ? severityRank[command.severity] : undefined;
    const filtered = entries
      .filter((entry) => !command.source || entry.source === command.source)
      .filter((entry) => minimumSeverity === undefined || severityRank[entry.severity] >= minimumSeverity)
      .filter((entry) => !command.deploymentId || entry.deploymentId === command.deploymentId)
      .filter((entry) => !command.search || entry.message.toLowerCase().includes(command.search.toLowerCase()))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    const offset = command.cursor ? Number(command.cursor) : 0;
    const limit = Math.min(Math.max(command.limit ?? 50, 1), 100);
    const page = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined;

    return this.fromFixture({
      projectId: command.projectId,
      filters: {
        source: command.source,
        severity: command.severity,
        deploymentId: command.deploymentId,
        search: command.search
      },
      entries: page,
      total: filtered.length,
      nextCursor,
      updatedAt: new Date().toISOString()
    });
  }

  async listSavedLogQueries(projectId: SiteFlowId): Promise<SavedLogQueryListReadModel> {
    await this.getProject(projectId);

    const query: SavedLogQuery = {
      id: "logquery_errors",
      projectId,
      name: "Production errors",
      filters: {
        severity: "error",
        source: "function"
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return this.fromFixture({
      projectId,
      queries: [query],
      total: 1,
      updatedAt: new Date().toISOString()
    });
  }

  async saveLogQuery(command: SaveLogQueryCommand): Promise<SavedLogQueryMutationReadModel> {
    const now = new Date().toISOString();
    const query: SavedLogQuery = {
      id: `logquery_${fixtureId(`${command.projectId}_${command.name}`)}`,
      projectId: command.projectId,
      name: command.name.trim(),
      filters: command.filters,
      createdBy: command.actor,
      createdAt: now,
      updatedAt: now
    };

    return this.fromFixture({
      status: "saved",
      query,
      message: "Log query saved."
    });
  }

  async listLogDrains(projectId: SiteFlowId): Promise<LogDrainListReadModel> {
    await this.getProject(projectId);

    const drain: LogDrain = {
      id: "drain_fixture_observability",
      projectId,
      name: "Observability webhook",
      url: "https://logs.example.test/siteflow",
      sources: ["build", "function", "cron"],
      minimumSeverity: "info",
      status: "active",
      signingSecretPrefix: "sfd_fixture",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return this.fromFixture({
      projectId,
      drains: [drain],
      total: 1,
      updatedAt: new Date().toISOString()
    });
  }

  async createLogDrain(command: CreateLogDrainCommand): Promise<LogDrainCreateReadModel> {
    const now = new Date().toISOString();
    const drain: LogDrain = {
      id: `drain_${fixtureId(`${command.projectId}_${command.name}`)}`,
      projectId: command.projectId,
      name: command.name.trim(),
      url: command.url,
      sources: command.sources && command.sources.length > 0 ? command.sources : ["build", "runtime", "function", "cron"],
      minimumSeverity: command.minimumSeverity ?? "info",
      status: "active",
      signingSecretPrefix: (command.signingSecret ?? "sfd_fixture_secret").slice(0, 12),
      createdBy: command.actor,
      createdAt: now,
      updatedAt: now
    };

    return this.fromFixture({
      status: "created",
      drain,
      message: "Log drain created."
    });
  }

  async deliverLogDrain(command: DeliverLogDrainCommand): Promise<LogDrainDeliveryReadModel> {
    const drain = (await this.listLogDrains(command.projectId)).drains.find((candidate) => candidate.id === command.drainId)
      ?? (await this.createLogDrain({
        projectId: command.projectId,
        name: command.drainId,
        url: "https://logs.example.test/siteflow"
      })).drain;
    const logs = await this.queryLogs({ projectId: command.projectId, limit: command.limit ?? 20 });
    const now = new Date().toISOString();

    return this.fromFixture({
      status: "delivered",
      drain: {
        ...drain,
        lastDeliveredAt: now
      },
      delivery: {
        id: `delivery_${fixtureId(`${drain.id}_${now}`)}`,
        drainId: drain.id,
        projectId: command.projectId,
        status: "delivered",
        responseStatus: 202,
        eventsDelivered: logs.entries.length,
        attempt: 1,
        payloadSha256: "sha256:fixture",
        deliveredAt: now
      },
      message: "Log drain delivered."
    });
  }

  async listDeployments(projectId?: SiteFlowId): Promise<DeploymentListReadModel> {
    const fromProjectDetails = Object.values(this.fixture.projects)
      .filter((project) => !projectId || project.project.id === projectId)
      .flatMap((project) => project.deployments);
    const fromProjectList = this.fixture.projectList.projects
      .filter((project) => !projectId || project.project.id === projectId)
      .flatMap((project) => project.productionDeployment ? [project.productionDeployment] : []);
    const deployments = uniqueDeployments([...fromProjectDetails, ...fromProjectList])
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return this.fromFixture({
      deployments,
      total: deployments.length,
      projectId,
      updatedAt: new Date().toISOString()
    });
  }

  async getDeployment(deploymentId: SiteFlowId): Promise<DeploymentDetailReadModel> {
    return this.fromFixture(this.findById(this.fixture.deployments, deploymentId, "deployment"));
  }

  async getReleaseConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<ReleaseConsoleReadModel> {
    return this.fromFixture(this.findById(this.fixture.releaseConsoles, fixtureConsoleKey(projectId, channel), "release console"));
  }

  async getRollbackConsole(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollbackConsoleReadModel> {
    return this.fromFixture(this.findById(this.fixture.rollbackConsoles, fixtureConsoleKey(projectId, channel), "rollback console"));
  }

  async promoteDeployment(command: PromoteDeploymentCommand): Promise<CommandResultReadModel> {
    assertReleaseCommand(command);
    return this.fromFixture(this.fixture.commandResults.promote);
  }

  async rollbackDeployment(command: RollbackDeploymentCommand): Promise<CommandResultReadModel> {
    assertReleaseCommand(command);
    return this.fromFixture(this.fixture.commandResults.rollback);
  }

  async getRollingRelease(projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollingReleaseReadModel> {
    const deployments = await this.listDeployments(projectId);
    const currentDeployment = this.fixture.projectList.projects.find((project) => project.project.id === projectId)?.productionDeployment
      ?? deployments.deployments[0];
    const candidateDeployment = deployments.deployments.find((deployment) => deployment.id !== currentDeployment?.id)
      ?? deployments.deployments[0];
    const now = new Date().toISOString();

    return this.fromFixture({
      projectId,
      channel,
      rollout: currentDeployment && candidateDeployment
        ? {
            id: "rollout_fixture",
            projectId,
            channel,
            currentDeploymentId: currentDeployment.id,
            candidateDeploymentId: candidateDeployment.id,
            percentage: 25,
            status: "active",
            actor: {
              id: "fixture:siteflow",
              name: "SiteFlow Fixture",
              role: "system"
            },
            reason: "Fixture rolling release.",
            createdAt: now,
            updatedAt: now
          }
        : undefined,
      currentDeployment,
      candidateDeployment,
      safetyChecks: currentDeployment && candidateDeployment
        ? [
            {
              id: "check-rollout-fixture",
              label: "Fixture rollout",
              status: "pass",
              summary: `Candidate ${candidateDeployment.id} receives 25% of traffic.`
            }
          ]
        : [],
      updatedAt: now
    });
  }

  async startRollingRelease(command: StartRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    assertRollingCommand(command);
    assertFixtureRolloutPercentage(command.percentage);

    const currentDeployment = this.fixture.projectList.projects.find((project) => project.project.id === command.projectId)?.productionDeployment
      ?? (await this.listDeployments(command.projectId)).deployments[0];
    const candidateDeployment = (await this.listDeployments(command.projectId)).deployments.find((deployment) => deployment.id === command.candidateDeploymentId);
    const routeRevision = this.fixtureRollingRouteRevision(command, command.candidateDeploymentId, currentDeployment?.id, command.percentage, "applied");

    return this.fromFixture({
      status: currentDeployment && candidateDeployment ? "accepted" : "rejected",
      rollout: currentDeployment && candidateDeployment
        ? {
            id: "rollout_fixture",
            projectId: command.projectId,
            channel: command.channel,
            currentDeploymentId: currentDeployment.id,
            candidateDeploymentId: candidateDeployment.id,
            percentage: command.percentage,
            status: "active",
            actor: command.actor,
            reason: command.reason.trim(),
            createdAt: routeRevision.createdAt,
            updatedAt: routeRevision.createdAt
          }
        : undefined,
      routeRevision: currentDeployment && candidateDeployment ? routeRevision : undefined,
      safetyChecks: [
        {
          id: "check-fixture-rollout-targets",
          label: "Fixture rollout targets",
          status: currentDeployment && candidateDeployment ? "pass" : "fail",
          summary: currentDeployment && candidateDeployment
            ? `Rolling release can route from ${currentDeployment.id} to ${candidateDeployment.id}.`
            : "Fixture current or candidate deployment was not found."
        }
      ],
      message: currentDeployment && candidateDeployment
        ? `Rolling release started at ${command.percentage}%.`
        : "Rolling release rejected: fixture current or candidate deployment was not found."
    });
  }

  async advanceRollingRelease(command: AdvanceRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    assertRollingCommand(command);
    assertFixtureRolloutPercentage(command.percentage);

    return this.fixtureRollingCommand(command, "active", command.percentage, `Rolling release advanced to ${command.percentage}%.`);
  }

  async completeRollingRelease(command: CompleteRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    assertRollingCommand(command);
    return this.fixtureRollingCommand(command, "completed", 100, "Rolling release completed.");
  }

  async abortRollingRelease(command: AbortRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> {
    assertRollingCommand(command);
    return this.fixtureRollingCommand(command, "aborted", 25, "Rolling release aborted.");
  }

  async pollOperation(operationId: SiteFlowId): Promise<OperationSnapshotReadModel> {
    return this.fromFixture(this.findById(this.fixture.operations, operationId, "operation"));
  }

  async getLogChunk(deploymentId: SiteFlowId, cursor?: string): Promise<LogChunkReadModel> {
    const chunks = this.fixture.logs[deploymentId];

    if (!chunks || chunks.length === 0) {
      throw new Error(`Unknown log stream: ${deploymentId}`);
    }

    const chunk = cursor ? chunks.find((candidate) => candidate.chunk.cursor === cursor) : chunks[0];

    if (!chunk) {
      throw new Error(`Unknown log cursor: ${cursor}`);
    }

    return this.fromFixture(chunk);
  }

  private findById<T>(items: Record<string, T>, id: string, label: string) {
    const item = items[id];

    if (!item) {
      throw new Error(`Unknown SiteFlow ${label}: ${id}`);
    }

    return item;
  }

  private fixtureRollingRouteRevision(
    command: StartRollingReleaseCommand | AdvanceRollingReleaseCommand | CompleteRollingReleaseCommand | AbortRollingReleaseCommand,
    deploymentId: SiteFlowId,
    previousDeploymentId: SiteFlowId | undefined,
    percentage: number,
    status: RouteRevision["status"]
  ): RouteRevision {
    const now = new Date().toISOString();

    return {
      id: `route_${command.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      projectId: command.projectId,
      channel: command.channel,
      deploymentId,
      previousDeploymentId,
      status,
      generatedConfig: [
        `project=${command.projectId}`,
        `channel=${command.channel}`,
        `candidate_percentage=${percentage}`,
        ...("releaseEvidenceException" in command && command.releaseEvidenceException
          ? [
              `release_evidence_exception=${command.releaseEvidenceException.type}`,
              `release_evidence_exception_target_environment=${command.releaseEvidenceException.targetEnvironment}`,
              `release_evidence_exception_reason=${command.releaseEvidenceException.reason.replace(/\s+/g, " ").trim()}`
            ]
          : [])
      ].join("\n"),
      validationSummary: `Fixture rolling route prepared at ${percentage}%.`,
      createdAt: now,
      appliedAt: status === "applied" ? now : undefined
    };
  }

  private async fixtureRollingCommand(
    command: AdvanceRollingReleaseCommand | CompleteRollingReleaseCommand | AbortRollingReleaseCommand,
    status: "active" | "completed" | "aborted",
    percentage: number,
    message: string
  ): Promise<RollingReleaseCommandReadModel> {
    const active = await this.getRollingRelease(command.projectId, command.channel);
    const currentDeploymentId = active.rollout?.currentDeploymentId ?? active.currentDeployment?.id;
    const candidateDeploymentId = active.rollout?.candidateDeploymentId ?? active.candidateDeployment?.id;
    const routeRevision = candidateDeploymentId
      ? this.fixtureRollingRouteRevision(command, candidateDeploymentId, currentDeploymentId, percentage, "applied")
      : undefined;

    return this.fromFixture({
      status: candidateDeploymentId ? "accepted" : "rejected",
      rollout: candidateDeploymentId && currentDeploymentId
        ? {
            id: active.rollout?.id ?? "rollout_fixture",
            projectId: command.projectId,
            channel: command.channel,
            currentDeploymentId,
            candidateDeploymentId,
            percentage,
            status,
            actor: command.actor,
            reason: command.reason.trim(),
            createdAt: active.rollout?.createdAt ?? new Date().toISOString(),
            updatedAt: routeRevision?.createdAt ?? new Date().toISOString(),
            completedAt: status === "completed" ? routeRevision?.appliedAt : undefined,
            abortedAt: status === "aborted" ? routeRevision?.appliedAt : undefined
          }
        : undefined,
      routeRevision,
      safetyChecks: active.safetyChecks,
      message: candidateDeploymentId ? message : "Rolling release rejected: no fixture rollout is active."
    });
  }

  private fromFixture<T>(value: T): T {
    return redactSecrets(value, this.redaction);
  }
}

export function createFixtureSiteFlowClient(options?: SiteFlowScenarioName | FixtureSiteFlowClientOptions): SiteFlowClient {
  return new FixtureSiteFlowClient(options);
}
