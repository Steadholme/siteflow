import { createHmac } from "node:crypto";
import http from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiToken, BlobObject, EdgeConfigEntry, FirewallRule, FunctionInvocation, LogDrain, ObservabilityLogEntry, PermissionScope, ReleaseChannelName, RoutingRule, SiteFlowId, TeamMember } from "../src/domain/siteflow";
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
} from "../src/domain/readModels";
import type {
  AbortRollingReleaseCommand,
  AdvanceRollingReleaseCommand,
  AnalyticsEventCommand,
  CompleteRollingReleaseCommand,
  CreateCronJobCommand,
  CreateFirewallRuleCommand,
  CreateLogDrainCommand,
  CreateProjectCommand,
  CreateDeployHookCommand,
  DeleteBlobCommand,
  DeleteEdgeConfigCommand,
  DeliverLogDrainCommand,
  DisableCronJobCommand,
  DisableFirewallRuleCommand,
  DisableRoutingRuleCommand,
  GetBlobCommand,
  GetFunctionRuntimeCommand,
  GitWebhookCommand,
  ListCacheEntriesCommand,
  ListFunctionsCommand,
  ListBlobsCommand,
  ListRoutingRulesCommand,
  LogQueryCommand,
  MatchRoutingRulesCommand,
  PromoteDeploymentCommand,
  PutBlobCommand,
  PurgeCacheCommand,
  RevokeDeployHookCommand,
  RollbackDeploymentCommand,
  RunCronJobCommand,
  SaveLogQueryCommand,
  StartRollingReleaseCommand,
  TriggerDeployHookCommand,
  UpdateProjectCommand,
  UpsertEdgeConfigCommand,
  UpsertEnvironmentVariableCommand,
  UpsertRoutingRuleCommand
} from "../src/lib/api/siteflowClient";
import type { PrebuiltDeployCommand, PrebuiltDeployResult } from "../src/lib/api/deployContracts";
import { normalizeAnalyticsEventInput } from "../src/lib/analytics";
import { siteflowFixtures } from "../src/lib/fixtures/siteflow.fixtures";
import { SITEFLOW_SECRET_CANARY } from "../src/lib/redaction";
import { createSiteFlowServer, type DrainFetch, type FunctionModuleLoader } from "./httpServer";
import { SiteFlowNotFoundError, type ArtifactRoute, type RecordLogDrainDeliveryCommand, type SiteFlowReadRepository } from "./readRepository";

async function rawHttpGet(
  baseUrl: string,
  pathname: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string | Buffer
): Promise<{ status: number; headers: Record<string, string | undefined>; rawHeaders: string[]; body: Buffer }> {
  const url = new URL(pathname, baseUrl);

  return await new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method,
        headers
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])
          ),
          rawHeaders: response.rawHeaders,
          body: Buffer.concat(chunks)
        }));
      }
    );

    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

function rawHeaderValues(rawHeaders: string[], name: string) {
  const values: string[] = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }

  return values;
}

function fixtureRepository(): SiteFlowReadRepository {
  const fixture = siteflowFixtures.healthy;
  const tokenScopes: Record<string, PermissionScope[]> = {
    "read-token": ["read"],
    "operator-token": ["read", "write"],
    "admin-token": ["read", "write", "admin"]
  };
  const canUseToken = (token: string, permission: PermissionScope) => {
    const scopes = tokenScopes[token] ?? [];
    const level = (scope: PermissionScope) => scope === "read" ? 0 : scope === "write" ? 1 : 2;

    return scopes.some((scope) => level(scope) >= level(permission));
  };
  const fixtureBlob = (projectId: SiteFlowId, pathname = "assets/fixture.txt"): BlobObject => ({
    id: `blob_${projectId}_${pathname.replace(/[^a-z0-9]+/gi, "_")}`,
    projectId,
    pathname,
    access: "public",
    contentType: pathname.endsWith(".json") ? "application/json" : "text/plain",
    cacheControlMaxAge: 3600,
    size: Buffer.byteLength("SiteFlow fixture blob"),
    sha256: "d8d9c1b51a05fbd72c1277d9e33276805e3026d5a4b8bb58f49b754019318212",
    etag: "d8d9c1b51a05fbd72c1277d9e33276805e3026d5a4b8bb58f49b754019318212",
    url: `/api/projects/${encodeURIComponent(projectId)}/blobs/${encodeURIComponent(pathname)}`,
    uploadedAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z"
  });

  return {
    resolveTokenPermissions: async (token: string): Promise<PermissionScope[] | undefined> => tokenScopes[token],
    authorizeToken: async (token: string, permission: PermissionScope): Promise<boolean> => canUseToken(token, permission),
    listProjects: async (): Promise<ProjectListReadModel> => fixture.projectList,
    getProject: async (projectId: SiteFlowId): Promise<ProjectDetailReadModel> => {
      const project = fixture.projects[projectId];

      if (!project) {
        throw new SiteFlowNotFoundError(`Unknown project: ${projectId}`);
      }

      return project;
    },
    getProjectSettings: async (projectId: SiteFlowId): Promise<ProjectSettingsReadModel> => {
      const project = fixture.projects[projectId];

      if (!project) {
        throw new SiteFlowNotFoundError(`Unknown project: ${projectId}`);
      }

      return {
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
            branchPattern: project.project.defaultBranch,
            createdAt: project.project.createdAt,
            updatedAt: project.project.updatedAt
          }
        ],
        environmentVariables: [],
        teamMembers: [
          {
            id: "member-owner",
            projectId,
            actor: { id: "actor-owner", name: "Owner", role: "release_manager" },
            role: "owner",
            permissions: ["read", "write", "admin"],
            createdAt: "2026-05-26T00:00:00.000Z",
            updatedAt: "2026-05-26T00:00:00.000Z"
          }
        ],
        apiTokens: [
          {
            id: "token-operator",
            projectId,
            name: "Operator token",
            tokenPrefix: "operator-tok",
            scopes: ["read", "write"],
            status: "active",
            createdAt: "2026-05-26T00:00:00.000Z",
            updatedAt: "2026-05-26T00:00:00.000Z"
          }
        ],
        auditEvents: project.recentEvents.auditEvents,
        currentPermissions: ["read", "write", "admin"]
      };
    },
    createProject: async (command: CreateProjectCommand): Promise<ProjectMutationReadModel> => ({
      status: "created",
      project: {
        id: `project_${command.slug}`,
        slug: command.slug,
        name: command.name,
        status: "active",
        framework: command.framework ?? "Vite",
        defaultBranch: command.defaultBranch ?? "main",
        productionBranch: command.productionBranch ?? command.defaultBranch ?? "main",
        repository: command.repository ?? {
          provider: "generic",
          owner: "local",
          name: command.slug,
          defaultBranch: command.defaultBranch ?? "main"
        },
        buildSettings: {
          installCommand: command.buildSettings?.installCommand ?? "npm install",
          buildCommand: command.buildSettings?.buildCommand ?? "npm run build",
          outputDirectory: command.buildSettings?.outputDirectory ?? "dist",
          framework: command.framework ?? "Vite"
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
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z"
      },
      message: "Project created."
    }),
    updateProject: async (projectId: SiteFlowId, command: UpdateProjectCommand): Promise<ProjectMutationReadModel> => {
      const settings = await fixtureRepository().getProjectSettings(projectId);

      return {
        status: "updated",
        project: {
          ...settings.project,
          name: command.name ?? settings.project.name,
          productionBranch: command.productionBranch ?? settings.project.productionBranch,
          domains: command.domains ?? settings.project.domains,
          updatedAt: "2026-05-25T00:00:00.000Z"
        },
        message: "Project updated."
      };
    },
    archiveProject: async (projectId: SiteFlowId): Promise<ProjectMutationReadModel> => {
      const settings = await fixtureRepository().getProjectSettings(projectId);

      return {
        status: "archived",
        project: {
          ...settings.project,
          status: "archived",
          updatedAt: "2026-05-25T00:00:00.000Z"
        },
        message: "Project archived."
      };
    },
    getProjectEnvironmentSettings: async (projectId: SiteFlowId): Promise<ProjectEnvironmentSettingsReadModel> => {
      const settings = await fixtureRepository().getProjectSettings(projectId);

      return {
        projectId,
        environments: settings.environments,
        environmentVariables: settings.environmentVariables,
        updatedAt: "2026-05-25T00:00:00.000Z"
      };
    },
    upsertEnvironmentVariable: async (command: UpsertEnvironmentVariableCommand): Promise<ProjectEnvironmentVariableUpsertReadModel> => ({
      status: "upserted",
      variable: {
        id: `env_${command.projectId}_${command.targetEnvironment}_${command.key}`,
        projectId: command.projectId,
        key: command.key,
        targetEnvironment: command.targetEnvironment,
        scope: command.scope,
        source: command.source ?? "sealed",
        fingerprint: "sha256:metadata-only",
        updatedAt: "2026-05-25T00:00:00.000Z",
        updatedBy: command.actor
      },
      message: "Environment variable metadata saved."
    }),
    upsertTeamMember: async (command): Promise<TeamMemberMutationReadModel> => ({
      status: "upserted",
      member: {
        id: `member-${command.actor.id}`,
        projectId: command.projectId,
        actor: command.actor,
        role: command.role,
        permissions: command.role === "owner" ? ["read", "write", "admin"] : command.role === "viewer" ? ["read"] : ["read", "write"],
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      } satisfies TeamMember,
      message: "Team member saved."
    }),
    removeTeamMember: async (command): Promise<TeamMemberMutationReadModel> => ({
      status: "removed",
      member: {
        id: command.memberId,
        projectId: command.projectId,
        actor: { id: "actor-removed", name: "Removed", role: "operator" },
        role: "viewer",
        permissions: ["read"],
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      } satisfies TeamMember,
      message: "Team member removed."
    }),
    createApiToken: async (command): Promise<ApiTokenCreateReadModel> => ({
      status: "created",
      token: {
        id: "token-created",
        projectId: command.projectId,
        name: command.name,
        tokenPrefix: "sft_created",
        scopes: command.scopes,
        status: "active",
        createdBy: command.actor,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      } satisfies ApiToken,
      secret: "sft_created_secret",
      message: "API token created. Store the token now; it will not be shown again."
    }),
    revokeApiToken: async (command): Promise<ApiTokenRevokeReadModel> => ({
      status: "revoked",
      token: {
        id: command.tokenId,
        projectId: command.projectId,
        name: "Operator token",
        tokenPrefix: "operator-tok",
        scopes: ["read", "write"],
        status: "revoked",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:01:00.000Z",
        revokedAt: "2026-05-26T00:01:00.000Z"
      } satisfies ApiToken,
      message: "API token revoked."
    }),
    listFirewallRules: async (projectId: SiteFlowId): Promise<FirewallRuleListReadModel> => ({
      projectId,
      rules: [
        {
          id: "fw_fixture_admin",
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
      ],
      total: 1,
      updatedAt: "2026-05-26T00:00:00.000Z"
    }),
    createFirewallRule: async (command: CreateFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> => ({
      status: "created",
      rule: {
        id: "fw_created",
        projectId: command.projectId,
        name: command.name,
        action: command.action,
        priority: command.priority ?? 100,
        status: "active",
        conditions: command.conditions,
        createdBy: command.actor,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      } satisfies FirewallRule,
      message: "Firewall rule created."
    }),
    disableFirewallRule: async (command: DisableFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> => ({
      status: "disabled",
      rule: {
        id: command.ruleId,
        projectId: command.projectId,
        name: "Block admin paths",
        action: "block",
        priority: 10,
        status: "disabled",
        conditions: {
          pathPattern: "/admin/*"
        },
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:01:00.000Z",
        disabledAt: "2026-05-26T00:01:00.000Z"
      } satisfies FirewallRule,
      message: "Firewall rule disabled."
    }),
    evaluateFirewall: async (command): Promise<FirewallEvaluationReadModel> => ({
      projectId: command.projectId,
      decision: "allow",
      reason: "No firewall rule matched."
    }),
    getEdgeConfig: async (projectId: SiteFlowId): Promise<EdgeConfigReadModel> => ({
      projectId,
      entries: [
        {
          id: "edge_maintenance",
          projectId,
          key: "maintenance",
          value: false,
          valueType: "boolean",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z"
        }
      ],
      total: 1,
      updatedAt: "2026-05-26T00:00:00.000Z"
    }),
    upsertEdgeConfig: async (command: UpsertEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> => ({
      status: "upserted",
      entry: {
        id: "edge_maintenance",
        projectId: command.projectId,
        key: command.key,
        value: command.value,
        valueType: typeof command.value === "boolean"
          ? "boolean"
          : typeof command.value === "number"
            ? "number"
            : typeof command.value === "string"
              ? "string"
              : "json",
        createdBy: command.actor,
        updatedBy: command.actor,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:01:00.000Z"
      } satisfies EdgeConfigEntry,
      message: "Edge Config entry saved."
    }),
    deleteEdgeConfig: async (command: DeleteEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> => ({
      status: "deleted",
      message: `Edge Config entry ${command.key} deleted.`
    }),
    listBlobs: async (command: ListBlobsCommand): Promise<BlobListReadModel> => {
      const blobs = [fixtureBlob(command.projectId), fixtureBlob(command.projectId, "assets/config/app.json")]
        .filter((blob) => !command.prefix || blob.pathname.startsWith(command.prefix))
        .filter((blob) => !command.cursor || blob.pathname > command.cursor)
        .slice(0, command.limit ?? 100);

      return {
        projectId: command.projectId,
        blobs,
        total: blobs.length,
        updatedAt: "2026-05-27T00:00:00.000Z"
      };
    },
    putBlob: async (command: PutBlobCommand): Promise<BlobPutReadModel> => ({
      status: "uploaded",
      blob: {
        ...fixtureBlob(command.projectId, command.pathname),
        access: command.access ?? "public",
        contentType: command.contentType ?? "application/octet-stream",
        cacheControlMaxAge: command.cacheControlMaxAge,
        size: Buffer.from(command.contentBase64, "base64").length,
        uploadedBy: command.actor,
        uploadedAt: "2026-05-27T00:01:00.000Z",
        updatedAt: "2026-05-27T00:01:00.000Z"
      },
      message: "Blob uploaded."
    }),
    getBlob: async (command: GetBlobCommand): Promise<BlobReadModel> => ({
      projectId: command.projectId,
      blob: fixtureBlob(command.projectId, command.pathname),
      contentBase64: Buffer.from("SiteFlow fixture blob", "utf8").toString("base64")
    }),
    deleteBlob: async (command: DeleteBlobCommand): Promise<BlobDeleteReadModel> => ({
      status: "deleted",
      blob: fixtureBlob(command.projectId, command.pathname),
      message: "Blob deleted."
    }),
    listCacheEntries: async (command: ListCacheEntriesCommand): Promise<CacheListReadModel> => {
      const entries = [
        {
          id: "cache_home",
          projectId: command.projectId,
          key: "page:/",
          path: "/",
          tags: ["home", "marketing"],
          status: "fresh" as const,
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
          id: "cache_pricing",
          projectId: command.projectId,
          key: "page:/pricing",
          path: "/pricing",
          tags: ["marketing", "pricing"],
          status: "stale" as const,
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
      ]
        .filter((entry) => !command.path || entry.path === command.path)
        .filter((entry) => !command.tag || entry.tags.includes(command.tag))
        .filter((entry) => !command.status || entry.status === command.status)
        .slice(0, command.limit ?? 100);

      return {
        projectId: command.projectId,
        entries,
        total: entries.length,
        updatedAt: "2026-05-27T00:00:00.000Z"
      };
    },
    purgeCache: async (command: PurgeCacheCommand): Promise<CachePurgeReadModel> => {
      const list = await fixtureRepository().listCacheEntries({
        projectId: command.projectId,
        path: command.path,
        tag: command.tag
      });
      const purged = list.entries.map((entry) => ({
        ...entry,
        status: "purged" as const,
        purgedAt: "2026-05-27T00:10:00.000Z",
        updatedAt: "2026-05-27T00:10:00.000Z"
      }));

      return {
        status: "purged",
        projectId: command.projectId,
        purged,
        total: purged.length,
        message: `Purged ${purged.length} cache entr${purged.length === 1 ? "y" : "ies"}.`
      };
    },
    listFunctions: async (command: ListFunctionsCommand): Promise<FunctionRuntimeListReadModel> => {
      const deploymentId = command.deploymentId ?? "dep_function";
      const invocations: FunctionInvocation[] = [
        {
          id: "fninv_ok",
          deploymentId,
          projectId: command.projectId,
          path: "/api/revalidate",
          method: "POST",
          status: "succeeded",
          responseStatus: 200,
          durationMs: 40,
          requestId: "req_ok",
          logs: ["ok"],
          invokedAt: "2026-05-27T00:10:00.000Z"
        },
        {
          id: "fninv_fail",
          deploymentId,
          projectId: command.projectId,
          path: "/api/revalidate",
          method: "POST",
          status: "failed",
          responseStatus: 500,
          durationMs: 180,
          requestId: "req_fail",
          errorMessage: "failed",
          logs: ["failed"],
          invokedAt: "2026-05-27T00:11:00.000Z"
        }
      ];

      return {
        projectId: command.projectId,
        deploymentId,
        functions: [
          {
            projectId: command.projectId,
            deploymentId,
            function: {
              path: "/api/revalidate",
              sourcePath: ".siteflow/functions/api/revalidate.js",
              runtime: "nodejs20.x",
              handler: "default",
              methods: ["POST"],
              timeoutMs: 10000,
              memoryMb: 512,
              concurrency: 50
            },
            limits: {
              timeoutMs: 10000,
              memoryMb: 512,
              concurrency: 50
            },
            summary: {
              invocations: invocations.length,
              errors: 1,
              errorRate: 0.5,
              averageDurationMs: 110,
              p95DurationMs: 180,
              lastInvokedAt: "2026-05-27T00:10:00.000Z"
            }
          }
        ],
        total: 1,
        updatedAt: "2026-05-27T00:12:00.000Z"
      };
    },
    getFunctionRuntime: async (command: GetFunctionRuntimeCommand): Promise<FunctionRuntimeReadModel> => {
      const list = await fixtureRepository().listFunctions({
        projectId: command.projectId,
        deploymentId: command.deploymentId
      });

      return {
        projectId: command.projectId,
        deploymentId: list.deploymentId ?? "dep_function",
        function: list.functions[0],
        recentInvocations: [
          {
            id: "fninv_ok",
            deploymentId: list.deploymentId ?? "dep_function",
            projectId: command.projectId,
            path: command.path,
            method: "POST",
            status: "succeeded",
            responseStatus: 200,
            durationMs: 40,
            requestId: "req_ok",
            logs: ["ok"],
            invokedAt: "2026-05-27T00:10:00.000Z"
          }
        ],
        updatedAt: "2026-05-27T00:12:00.000Z"
      };
    },
    listRoutingRules: async (command: ListRoutingRulesCommand): Promise<RoutingRuleListReadModel> => {
      const rules: RoutingRule[] = [
        {
          id: "route_docs",
          projectId: command.projectId,
          name: "Docs redirect",
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
          id: "route_blog",
          projectId: command.projectId,
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
          id: "route_headers",
          projectId: command.projectId,
          name: "Security headers",
          kind: "header",
          source: "/(.*)",
          headers: [{ key: "x-frame-options", value: "DENY" }],
          priority: 30,
          status: "active",
          createdAt: "2026-05-27T00:00:00.000Z",
          updatedAt: "2026-05-27T00:00:00.000Z"
        }
      ].filter((rule) => !command.kind || rule.kind === command.kind)
        .filter((rule) => !command.status || rule.status === command.status);

      return {
        projectId: command.projectId,
        rules,
        total: rules.length,
        updatedAt: "2026-05-27T00:00:00.000Z"
      };
    },
    upsertRoutingRule: async (command: UpsertRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> => ({
      status: "upserted",
      rule: {
        id: "route_upserted",
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
        createdAt: "2026-05-27T00:00:00.000Z",
        updatedAt: "2026-05-27T00:00:00.000Z"
      },
      message: "Routing rule saved."
    }),
    disableRoutingRule: async (command: DisableRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> => ({
      status: "disabled",
      rule: {
        id: command.ruleId,
        projectId: command.projectId,
        name: "Docs redirect",
        kind: "redirect",
        source: "/docs",
        destination: "/documentation",
        statusCode: 308,
        priority: 10,
        status: "disabled",
        updatedBy: command.actor,
        createdAt: "2026-05-27T00:00:00.000Z",
        updatedAt: "2026-05-27T00:10:00.000Z",
        disabledAt: "2026-05-27T00:10:00.000Z"
      },
      message: "Routing rule disabled."
    }),
    matchRoutingRules: async (command: MatchRoutingRulesCommand): Promise<RoutingRuleMatchReadModel> => {
      const list = await fixtureRepository().listRoutingRules({
        projectId: command.projectId,
        status: "active"
      });
      const redirect = command.path === "/docs" ? list.rules.find((rule) => rule.kind === "redirect") : undefined;
      const rewrite = command.path.startsWith("/blog/") ? list.rules.find((rule) => rule.kind === "rewrite") : undefined;

      return {
        projectId: command.projectId,
        path: command.path,
        redirect,
        rewrite,
        headers: list.rules.filter((rule) => rule.kind === "header"),
        rewrittenPath: rewrite ? command.path.replace(/^\/blog\//, "/posts/") : undefined,
        updatedAt: "2026-05-27T00:00:00.000Z"
      };
    },
    listDeployHooks: async (projectId: SiteFlowId): Promise<DeployHookListReadModel> => ({
      projectId,
      hooks: [
        {
          id: "hook_preview",
          projectId,
          name: "Preview rebuild",
          branch: "main",
          targetEnvironment: "preview",
          tokenPrefix: "sfh_test_tok",
          status: "active",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z"
        }
      ],
      total: 1,
      updatedAt: "2026-05-25T00:00:00.000Z"
    }),
    createDeployHook: async (command: CreateDeployHookCommand): Promise<DeployHookCreateReadModel> => ({
      status: "created",
      hook: {
        id: "hook_preview",
        projectId: command.projectId,
        name: command.name,
        branch: command.branch ?? "main",
        targetEnvironment: command.targetEnvironment ?? "preview",
        tokenPrefix: "sfh_test_tok",
        status: "active",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z"
      },
      token: "sfh_test_token",
      message: "Deploy hook created."
    }),
    revokeDeployHook: async (command: RevokeDeployHookCommand): Promise<DeployHookRevokeReadModel> => ({
      status: "revoked",
      hook: {
        id: command.hookId,
        projectId: command.projectId,
        name: "Preview rebuild",
        branch: "main",
        targetEnvironment: "preview",
        tokenPrefix: "sfh_test_tok",
        status: "revoked",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:01:00.000Z",
        revokedAt: "2026-05-25T00:01:00.000Z"
      },
      message: "Deploy hook revoked."
    }),
    triggerDeployHook: async (command: TriggerDeployHookCommand): Promise<DeployHookTriggerReadModel> => ({
      status: "accepted",
      hook: {
        id: "hook_preview",
        projectId: "project-acme-dashboard",
        name: "Preview rebuild",
        branch: command.branch ?? "main",
        targetEnvironment: "preview",
        tokenPrefix: command.token.slice(0, 12),
        status: "active",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:01:00.000Z",
        lastTriggeredAt: "2026-05-25T00:01:00.000Z"
      },
      sourceEvent: {
        id: "src_hook",
        projectId: "project-acme-dashboard",
        kind: "manual",
        status: "accepted",
        disposition: "build_requested",
        providerDeliveryId: command.idempotencyKey ?? "hook-delivery",
        branch: command.branch ?? "main",
        commitSha: command.commitSha ?? "deploy-hook",
        commitMessage: command.commitMessage ?? "Deploy hook triggered.",
        commitAuthor: command.commitAuthor ?? "SiteFlow",
        receivedAt: "2026-05-25T00:01:00.000Z",
        actor: command.actor ?? {
          id: "deploy-hook:hook_preview",
          name: "Preview rebuild",
          role: "system"
        }
      },
      buildJobId: "build_hook",
      message: "Deploy hook accepted and build job queued."
    }),
    listCronJobs: async (projectId: SiteFlowId): Promise<CronJobListReadModel> => ({
      projectId,
      jobs: [
        {
          id: "cron_revalidate",
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
      updatedAt: "2026-05-26T00:00:00.000Z"
    }),
    createCronJob: async (command: CreateCronJobCommand): Promise<CronJobCreateReadModel> => ({
      status: "created",
      job: {
        id: "cron_revalidate",
        projectId: command.projectId,
        name: command.name,
        path: command.path,
        schedule: command.schedule,
        status: "active",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      },
      message: "Cron job saved."
    }),
    disableCronJob: async (command: DisableCronJobCommand): Promise<CronJobDisableReadModel> => ({
      status: "disabled",
      job: {
        id: command.jobId,
        projectId: command.projectId,
        name: "Revalidate homepage",
        path: "/api/revalidate",
        schedule: "0 * * * *",
        status: "disabled",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:01:00.000Z",
        disabledAt: "2026-05-26T00:01:00.000Z"
      },
      message: "Cron job disabled."
    }),
    runCronJob: async (command: RunCronJobCommand): Promise<CronJobRunReadModel> => ({
      status: "accepted",
      job: {
        id: command.jobId,
        projectId: command.projectId,
        name: "Revalidate homepage",
        path: "/api/revalidate",
        schedule: "0 * * * *",
        status: "active",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:01:00.000Z",
        lastDispatchedAt: "2026-05-26T00:01:00.000Z"
      },
      dispatch: {
        id: "crondispatch_revalidate",
        cronJobId: command.jobId,
        projectId: command.projectId,
        targetUrl: "https://dashboard.acme.test/api/revalidate",
        method: "GET",
        userAgent: "vercel-cron/1.0",
        status: "queued",
        reason: command.reason ?? "Manual cron run requested.",
        scheduledAt: "2026-05-26T00:01:00.000Z",
        dispatchedAt: "2026-05-26T00:01:00.000Z"
      },
      message: "Cron dispatch queued."
    }),
    ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => ({
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
      message: "Git webhook accepted and build job queued."
    }),
    ingestAnalyticsEvent: async (command: AnalyticsEventCommand): Promise<AnalyticsIngestReadModel> => {
      const event = normalizeAnalyticsEventInput(command);

      return {
        status: "accepted",
        event: {
          id: "analytics_fixture_event",
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
          receivedAt: "2026-05-26T00:00:01.000Z"
        },
        message: "Analytics event accepted."
      };
    },
    getAnalyticsDashboard: async (projectId: SiteFlowId): Promise<AnalyticsDashboardReadModel> => ({
      projectId,
      window: "24h",
      totals: {
        pageviews: 42,
        customEvents: 7,
        webVitals: 3,
        uniquePaths: 4
      },
      topPages: [
        { name: "/", count: 24, percentage: 57.1 },
        { name: "/pricing", count: 10, percentage: 23.8 }
      ],
      referrers: [
        { name: "https://vercel.com/templates", count: 8, percentage: 19 }
      ],
      countries: [
        { name: "US", count: 32, percentage: 61.5 }
      ],
      browsers: [
        { name: "Chrome", count: 30, percentage: 57.7 }
      ],
      devices: [
        { name: "desktop", count: 36, percentage: 69.2 }
      ],
      customEvents: [
        { name: "signup_clicked", count: 7, percentage: 100 }
      ],
      webVitals: [
        { name: "LCP", count: 3, p75: 1800, rating: "good" }
      ],
      updatedAt: "2026-05-26T00:00:00.000Z"
    }),
    queryLogs: async (command: LogQueryCommand): Promise<LogQueryReadModel> => {
      const entries: ObservabilityLogEntry[] = [
        {
          id: "log_build_warn",
          projectId: command.projectId,
          source: "build",
          severity: "warning",
          message: "Build warning: deprecated dependency",
          timestamp: "2026-05-26T00:00:00.000Z",
          deploymentId: "dep-healthy",
          buildJobId: "build_healthy"
        },
        {
          id: "log_function_error",
          projectId: command.projectId,
          source: "function",
          severity: "error",
          message: "Function failed with [REDACTED]",
          timestamp: "2026-05-26T00:01:00.000Z",
          deploymentId: "dep-healthy",
          requestId: "req_fixture",
          metadata: {
            authorization: "[REDACTED]"
          }
        },
        {
          id: "log_cron_info",
          projectId: command.projectId,
          source: "cron",
          severity: "info",
          message: "Cron dispatch queued",
          timestamp: "2026-05-26T00:02:00.000Z",
          cronJobId: "cron_revalidate"
        }
      ];
      const severityRank = { info: 0, warning: 1, error: 2 } as const;
      const minimumSeverity = command.severity ? severityRank[command.severity] : undefined;
      const filtered = entries
        .filter((entry) => !command.source || entry.source === command.source)
        .filter((entry) => minimumSeverity === undefined || severityRank[entry.severity] >= minimumSeverity)
        .filter((entry) => !command.search || entry.message.toLowerCase().includes(command.search.toLowerCase()));

      return {
        projectId: command.projectId,
        filters: {
          source: command.source,
          severity: command.severity,
          deploymentId: command.deploymentId,
          search: command.search
        },
        entries: filtered,
        total: filtered.length,
        updatedAt: "2026-05-26T00:00:00.000Z"
      };
    },
    listSavedLogQueries: async (projectId: SiteFlowId): Promise<SavedLogQueryListReadModel> => ({
      projectId,
      queries: [
        {
          id: "logquery_errors",
          projectId,
          name: "Production errors",
          filters: {
            severity: "error",
            source: "function"
          },
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z"
        }
      ],
      total: 1,
      updatedAt: "2026-05-26T00:00:00.000Z"
    }),
    saveLogQuery: async (command: SaveLogQueryCommand): Promise<SavedLogQueryMutationReadModel> => ({
      status: "saved",
      query: {
        id: "logquery_saved",
        projectId: command.projectId,
        name: command.name,
        filters: command.filters,
        createdBy: command.actor,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      },
      message: "Log query saved."
    }),
    listLogDrains: async (projectId: SiteFlowId): Promise<LogDrainListReadModel> => ({
      projectId,
      drains: [
        {
          id: "drain_fixture_observability",
          projectId,
          name: "Observability webhook",
          url: "https://logs.example.test/siteflow",
          sources: ["build", "function", "cron"],
          minimumSeverity: "info",
          status: "active",
          signingSecretPrefix: "sfd_test_sec",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z"
        }
      ],
      total: 1,
      updatedAt: "2026-05-26T00:00:00.000Z"
    }),
    createLogDrain: async (command: CreateLogDrainCommand): Promise<LogDrainCreateReadModel> => ({
      status: "created",
      drain: {
        id: "drain_fixture_observability",
        projectId: command.projectId,
        name: command.name,
        url: command.url,
        sources: command.sources ?? ["build", "runtime", "function", "cron"],
        minimumSeverity: command.minimumSeverity ?? "info",
        status: "active",
        signingSecretPrefix: (command.signingSecret ?? "sfd_test_secret").slice(0, 12),
        createdBy: command.actor,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      },
      message: "Log drain created."
    }),
    prepareLogDrainDelivery: async (command: DeliverLogDrainCommand) => {
      const drain: LogDrain = {
        id: command.drainId,
        projectId: command.projectId,
        name: "Observability webhook",
        url: "https://logs.example.test/siteflow",
        sources: ["build", "function", "cron"],
        minimumSeverity: "info",
        status: "active",
        signingSecretPrefix: "sfd_test_sec",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      };
      const logs = await fixtureRepository().queryLogs({ projectId: command.projectId, limit: command.limit ?? 20 });

      return {
        deliveryId: "delivery_fixture",
        drain,
        signingSecret: "sfd_test_secret",
        events: logs.entries
      };
    },
    recordLogDrainDelivery: async (command: RecordLogDrainDeliveryCommand): Promise<LogDrainDeliveryReadModel> => ({
      status: command.status,
      drain: {
        id: command.drainId,
        projectId: command.projectId,
        name: "Observability webhook",
        url: "https://logs.example.test/siteflow",
        sources: ["build", "function", "cron"],
        minimumSeverity: "info",
        status: "active",
        signingSecretPrefix: "sfd_test_sec",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:01:00.000Z",
        lastDeliveredAt: "2026-05-26T00:01:00.000Z"
      },
      delivery: {
        id: command.deliveryId,
        drainId: command.drainId,
        projectId: command.projectId,
        status: command.status,
        responseStatus: command.responseStatus,
        eventsDelivered: command.eventsDelivered,
        attempt: command.attempt ?? 1,
        payloadSha256: command.payloadSha256,
        errorMessage: command.errorMessage,
        deliveredAt: "2026-05-26T00:01:00.000Z"
      },
      message: command.status === "delivered" ? "Log drain delivered." : "Log drain delivery failed."
    }),
    listDeployments: async (projectId?: SiteFlowId): Promise<DeploymentListReadModel> => {
      const deployments = Object.values(fixture.projects)
        .filter((project) => !projectId || project.project.id === projectId)
        .flatMap((project) => project.deployments);

      return {
        deployments,
        total: deployments.length,
        projectId,
        updatedAt: "2026-05-25T00:00:00.000Z"
      };
    },
    getDeployment: async (deploymentId: SiteFlowId): Promise<DeploymentDetailReadModel> => fixture.deployments[deploymentId],
    getReleaseConsole: async (projectId: SiteFlowId, channel: ReleaseChannelName): Promise<ReleaseConsoleReadModel> =>
      fixture.releaseConsoles[`${projectId}:${channel}`],
    getRollbackConsole: async (projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollbackConsoleReadModel> =>
      fixture.rollbackConsoles[`${projectId}:${channel}`],
    promoteDeployment: async (_command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => fixture.commandResults.promote,
    rollbackDeployment: async (_command: RollbackDeploymentCommand): Promise<CommandResultReadModel> => fixture.commandResults.rollback,
    getRollingRelease: async (projectId: SiteFlowId, channel: ReleaseChannelName): Promise<RollingReleaseReadModel> => {
      const deployments = fixture.projects[projectId]?.deployments ?? [];
      const currentDeployment = deployments[0];
      const candidateDeployment = deployments[1] ?? deployments[0];

      return {
        projectId,
        channel,
        rollout: currentDeployment && candidateDeployment
          ? {
              id: "rollout_preview",
              projectId,
              channel,
              currentDeploymentId: currentDeployment.id,
              candidateDeploymentId: candidateDeployment.id,
              percentage: 25,
              status: "active",
              actor: { id: "actor-1", name: "Ops", role: "operator" },
              reason: "fixture rollout",
              createdAt: "2026-05-25T00:00:00.000Z",
              updatedAt: "2026-05-25T00:00:00.000Z"
            }
          : undefined,
        currentDeployment,
        candidateDeployment,
        safetyChecks: [],
        updatedAt: "2026-05-25T00:00:00.000Z"
      };
    },
    startRollingRelease: async (command: StartRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => ({
      status: "accepted",
      rollout: {
        id: "rollout_preview",
        projectId: command.projectId,
        channel: command.channel,
        currentDeploymentId: "dep-healthy",
        candidateDeploymentId: command.candidateDeploymentId,
        percentage: command.percentage,
        status: "active",
        actor: command.actor,
        reason: command.reason,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z"
      },
      safetyChecks: [],
      message: `Rolling release started at ${command.percentage}%.`
    }),
    advanceRollingRelease: async (command: AdvanceRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => ({
      status: "accepted",
      rollout: {
        id: "rollout_preview",
        projectId: command.projectId,
        channel: command.channel,
        currentDeploymentId: "dep-healthy",
        candidateDeploymentId: "dep-canary",
        percentage: command.percentage,
        status: "active",
        actor: command.actor,
        reason: command.reason,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:01:00.000Z"
      },
      safetyChecks: [],
      message: `Rolling release advanced to ${command.percentage}%.`
    }),
    completeRollingRelease: async (command: CompleteRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => ({
      status: "accepted",
      rollout: {
        id: "rollout_preview",
        projectId: command.projectId,
        channel: command.channel,
        currentDeploymentId: "dep-healthy",
        candidateDeploymentId: "dep-canary",
        percentage: 100,
        status: "completed",
        actor: command.actor,
        reason: command.reason,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:02:00.000Z",
        completedAt: "2026-05-25T00:02:00.000Z"
      },
      safetyChecks: [],
      message: "Rolling release completed."
    }),
    abortRollingRelease: async (command: AbortRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => ({
      status: "accepted",
      rollout: {
        id: "rollout_preview",
        projectId: command.projectId,
        channel: command.channel,
        currentDeploymentId: "dep-healthy",
        candidateDeploymentId: "dep-canary",
        percentage: 25,
        status: "aborted",
        actor: command.actor,
        reason: command.reason,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:02:00.000Z",
        abortedAt: "2026-05-25T00:02:00.000Z"
      },
      safetyChecks: [],
      message: "Rolling release aborted."
    }),
    pollOperation: async (operationId: SiteFlowId): Promise<OperationSnapshotReadModel> => fixture.operations[operationId],
    getLogChunk: async (deploymentId: SiteFlowId): Promise<LogChunkReadModel> => fixture.logs[deploymentId][0],
    deployPrebuilt: async (_command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => ({
      deploymentId: "dep_prebuilt",
      projectId: "project_docs",
      projectSlug: "docs",
      previewHost: "abc123.w33d.xyz",
      previewUrl: "https://abc123.w33d.xyz",
      artifactRoot: "/tmp/siteflow/dep_prebuilt",
      fileCount: 1,
      totalBytes: 12,
      checksum: "sha256"
    }),
    resolveArtifactRoute: async (_host: string): Promise<ArtifactRoute | undefined> => undefined,
    recordFunctionInvocation: async (_invocation: FunctionInvocation): Promise<void> => undefined
  };
}

async function withServer<T>(
  repository: SiteFlowReadRepository,
  test: (baseUrl: string) => Promise<T>,
  options: {
    apiToken?: string;
    allowedOrigin?: string;
    baseDomain?: string;
    githubWebhookSecret?: string;
    functionModuleLoader?: FunctionModuleLoader;
    drainFetch?: DrainFetch;
  } = {}
) {
  const server = createSiteFlowServer({
    repository,
    version: "0.1.0-test",
    apiToken: options.apiToken,
    allowedOrigin: options.allowedOrigin,
    baseDomain: options.baseDomain,
    githubWebhookSecret: options.githubWebhookSecret,
    functionModuleLoader: options.functionModuleLoader,
    drainFetch: options.drainFetch
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  try {
    return await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

function signGitHubBody(rawBody: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function githubPushPayload() {
  return {
    ref: "refs/heads/main",
    before: "8ac4e0d77a9f",
    after: "4f3a9c2d1b0e",
    head_commit: {
      id: "4f3a9c2d1b0e",
      message: "Ship docs portal",
      author: {
        name: "Ada Lovelace",
        email: "ada@example.com"
      }
    },
    repository: {
      id: 42,
      name: "docs-portal",
      full_name: "acme/docs-portal",
      default_branch: "main",
      html_url: "https://github.com/acme/docs-portal",
      owner: {
        login: "acme"
      }
    },
    sender: {
      login: "octocat"
    }
  };
}

describe("SiteFlow control-plane HTTP server", () => {
  it("serves health and project read models", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
      const projects = await fetch(`${baseUrl}/api/projects`).then((response) => response.json());

      expect(health).toEqual({ status: "ok", version: "0.1.0-test" });
      expect(projects.summary.totalProjects).toBe(1);
    });
  });

  it("omits JSON bodies for HEAD read-only control-plane endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const health = await rawHttpGet(baseUrl, "/healthz", {}, "HEAD");
        const verified = await rawHttpGet(baseUrl, "/api/auth/verify", {
          authorization: "Bearer deploy-token"
        }, "HEAD");
        const unauthorized = await rawHttpGet(baseUrl, "/api/auth/verify", {}, "HEAD");

        expect(health.status).toBe(200);
        expect(health.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(health.headers["content-length"]).toBeUndefined();
        expect(health.body.byteLength).toBe(0);
        expect(verified.status).toBe(200);
        expect(verified.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(verified.headers["content-length"]).toBeUndefined();
        expect(verified.body.byteLength).toBe(0);
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(unauthorized.headers["content-length"]).toBeUndefined();
        expect(unauthorized.body.byteLength).toBe(0);
      },
      { apiToken: "deploy-token", baseDomain: "w33d.xyz" }
    );
  });

  it("serves deployment inventory with a project filter", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments?projectId=project-acme-dashboard`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        total: 2,
        projectId: "project-acme-dashboard"
      });
      expect(body.deployments.map((deployment: { id: string }) => deployment.id)).toContain("dep-healthy");
    });
  });

  it("omits JSON bodies for HEAD deployment read endpoints", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const inventory = await rawHttpGet(baseUrl, "/api/deployments?projectId=project-acme-dashboard", {}, "HEAD");
      const deployment = await rawHttpGet(baseUrl, "/api/deployments/dep-healthy", {}, "HEAD");
      const logs = await rawHttpGet(baseUrl, "/api/deployments/dep-healthy/logs", {}, "HEAD");

      expect(inventory.status).toBe(200);
      expect(inventory.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(inventory.headers["content-length"]).toBeUndefined();
      expect(inventory.body.byteLength).toBe(0);
      expect(deployment.status).toBe(200);
      expect(deployment.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(deployment.headers["content-length"]).toBeUndefined();
      expect(deployment.body.byteLength).toBe(0);
      expect(logs.status).toBe(200);
      expect(logs.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(logs.headers["content-length"]).toBeUndefined();
      expect(logs.body.byteLength).toBe(0);
    });
  });

  it("omits JSON bodies for HEAD project read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const projects = await rawHttpGet(baseUrl, "/api/projects", {}, "HEAD");
        const project = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard", {}, "HEAD");
        const settings = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/settings", {
          authorization: "Bearer deploy-token"
        }, "HEAD");
        const unauthorizedSettings = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/settings", {}, "HEAD");

        expect(projects.status).toBe(200);
        expect(projects.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(projects.headers["content-length"]).toBeUndefined();
        expect(projects.body.byteLength).toBe(0);
        expect(project.status).toBe(200);
        expect(project.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(project.headers["content-length"]).toBeUndefined();
        expect(project.body.byteLength).toBe(0);
        expect(settings.status).toBe(200);
        expect(settings.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(settings.headers["content-length"]).toBeUndefined();
        expect(settings.body.byteLength).toBe(0);
        expect(unauthorizedSettings.status).toBe(401);
        expect(unauthorizedSettings.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(unauthorizedSettings.headers["content-length"]).toBeUndefined();
        expect(unauthorizedSettings.body.byteLength).toBe(0);
      },
      { apiToken: "deploy-token" }
    );
  });

  it("omits JSON bodies for HEAD project observability read endpoints", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const environments = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/environments", {}, "HEAD");
      const analytics = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/analytics", {}, "HEAD");
      const logs = await rawHttpGet(
        baseUrl,
        "/api/projects/project-acme-dashboard/logs?source=build&severity=warning",
        {},
        "HEAD"
      );

      expect(environments.status).toBe(200);
      expect(environments.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(environments.headers["content-length"]).toBeUndefined();
      expect(environments.body.byteLength).toBe(0);
      expect(analytics.status).toBe(200);
      expect(analytics.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(analytics.headers["content-length"]).toBeUndefined();
      expect(analytics.body.byteLength).toBe(0);
      expect(logs.status).toBe(200);
      expect(logs.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(logs.headers["content-length"]).toBeUndefined();
      expect(logs.body.byteLength).toBe(0);
    });
  });

  it("omits JSON bodies for HEAD protected project resource read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const authHeaders = { authorization: "Bearer deploy-token" };
        const logQueries = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/log-queries", authHeaders, "HEAD");
        const logDrains = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/log-drains", authHeaders, "HEAD");
        const firewallRules = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/firewall-rules", authHeaders, "HEAD");
        const edgeConfig = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/edge-config", authHeaders, "HEAD");
        const unauthorized = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/edge-config", {}, "HEAD");

        for (const response of [logQueries, logDrains, firewallRules, edgeConfig]) {
          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(response.headers["content-length"]).toBeUndefined();
          expect(response.body.byteLength).toBe(0);
        }

        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(unauthorized.headers["content-length"]).toBeUndefined();
        expect(unauthorized.body.byteLength).toBe(0);
      },
      { apiToken: "deploy-token" }
    );
  });

  it("omits JSON bodies for HEAD blob and cache read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const authHeaders = { authorization: "Bearer deploy-token" };
        const encodedPathname = encodeURIComponent("assets/config/app.json");
        const blobs = await rawHttpGet(
          baseUrl,
          "/api/projects/project-acme-dashboard/blobs?prefix=assets%2Fconfig&limit=1",
          authHeaders,
          "HEAD"
        );
        const blob = await rawHttpGet(
          baseUrl,
          `/api/projects/project-acme-dashboard/blobs/${encodedPathname}`,
          authHeaders,
          "HEAD"
        );
        const cache = await rawHttpGet(
          baseUrl,
          "/api/projects/project-acme-dashboard/cache?tag=marketing&status=stale&limit=5",
          authHeaders,
          "HEAD"
        );
        const unauthorized = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/blobs", {}, "HEAD");

        for (const response of [blobs, blob, cache]) {
          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(response.headers["content-length"]).toBeUndefined();
          expect(response.body.byteLength).toBe(0);
        }

        expect(unauthorized.status).toBe(401);
        expect(unauthorized.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(unauthorized.headers["content-length"]).toBeUndefined();
        expect(unauthorized.body.byteLength).toBe(0);
      },
      { apiToken: "deploy-token" }
    );
  });

  it("omits JSON bodies for HEAD function and routing read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const authHeaders = { authorization: "Bearer deploy-token" };
        const functionPath = encodeURIComponent("/api/revalidate");
        const functions = await rawHttpGet(
          baseUrl,
          "/api/projects/project-acme-dashboard/functions?deploymentId=dep_function",
          authHeaders,
          "HEAD"
        );
        const functionRuntime = await rawHttpGet(
          baseUrl,
          `/api/projects/project-acme-dashboard/functions/${functionPath}?deploymentId=dep_function&limit=1`,
          authHeaders,
          "HEAD"
        );
        const routingRules = await rawHttpGet(
          baseUrl,
          "/api/projects/project-acme-dashboard/routing-rules?kind=redirect",
          authHeaders,
          "HEAD"
        );
        const routeMatch = await rawHttpGet(
          baseUrl,
          "/api/projects/project-acme-dashboard/routing-rules/match?path=/docs",
          authHeaders,
          "HEAD"
        );

        for (const response of [functions, functionRuntime, routingRules, routeMatch]) {
          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(response.headers["content-length"]).toBeUndefined();
          expect(response.body.byteLength).toBe(0);
        }
      },
      { apiToken: "deploy-token" }
    );
  });

  it("omits JSON bodies for HEAD release operations read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const authHeaders = { authorization: "Bearer deploy-token" };
        const deployHooks = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/deploy-hooks", authHeaders, "HEAD");
        const cronJobs = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/cron-jobs", authHeaders, "HEAD");
        const rolling = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/rolling/production", authHeaders, "HEAD");
        const release = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/release/production", {}, "HEAD");
        const rollback = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/rollback/production", {}, "HEAD");
        const unauthorizedHooks = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/deploy-hooks", {}, "HEAD");

        for (const response of [deployHooks, cronJobs, rolling, release, rollback]) {
          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(response.headers["content-length"]).toBeUndefined();
          expect(response.body.byteLength).toBe(0);
        }

        expect(unauthorizedHooks.status).toBe(401);
        expect(unauthorizedHooks.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(unauthorizedHooks.headers["content-length"]).toBeUndefined();
        expect(unauthorizedHooks.body.byteLength).toBe(0);
      },
      { apiToken: "deploy-token" }
    );
  });

  it("omits JSON bodies for HEAD operation polling endpoints", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await rawHttpGet(baseUrl, "/api/operations/op-healthy-promote", {}, "HEAD");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.body.byteLength).toBe(0);
    });
  });

  it("advertises supported read and mutation methods in CORS allow-method metadata", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const preflight = await rawHttpGet(baseUrl, "/api/projects", {}, "OPTIONS");
        const head = await rawHttpGet(baseUrl, "/api/projects", {}, "HEAD");

        for (const response of [preflight, head]) {
          expect(response.headers["access-control-allow-origin"]).toBe("https://console.example.test");
          const methods = response.headers["access-control-allow-methods"]?.split(",").map((method) => method.trim());
          const allowedHeaders = response.headers["access-control-allow-headers"]?.split(",").map((header) => header.trim());
          const exposedHeaders = response.headers["access-control-expose-headers"]?.split(",").map((header) => header.trim());
          const varyHeaders = response.headers.vary?.split(",").map((header) => header.trim().toLowerCase());
          expect(methods).toContain("HEAD");
          expect(methods).toContain("PUT");
          expect(allowedHeaders).toContain("range");
          expect(allowedHeaders).toContain("if-none-match");
          expect(allowedHeaders).toContain("if-modified-since");
          expect(allowedHeaders).toContain("if-match");
          expect(allowedHeaders).toContain("if-unmodified-since");
          expect(allowedHeaders).toContain("if-range");
          expect(exposedHeaders).toContain("etag");
          expect(exposedHeaders).toContain("last-modified");
          expect(exposedHeaders).toContain("content-range");
          expect(exposedHeaders).toContain("accept-ranges");
          expect(exposedHeaders).toContain("location");
          expect(exposedHeaders).toContain("x-siteflow-deployment");
          expect(varyHeaders).toContain("origin");
        }

        expect(preflight.status).toBe(204);
        expect(preflight.headers["access-control-max-age"]).toBe("86400");
        expect(preflight.body.byteLength).toBe(0);
        expect(head.status).toBe(200);
        expect(head.headers["access-control-max-age"]).toBeUndefined();
        expect(head.body.byteLength).toBe(0);
      },
      { allowedOrigin: "https://console.example.test" }
    );
  });

  it("maps not-found repository errors to 404", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/missing`);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.message).toContain("Unknown project");
    });
  });

  it("omits JSON bodies for HEAD not-found responses", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await rawHttpGet(baseUrl, "/missing-route", {}, "HEAD");

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.body.byteLength).toBe(0);
    });
  });

  it("accepts project creation and returns default environment settings", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            slug: "docs-portal",
            name: "Docs Portal",
            framework: "Vite",
            defaultBranch: "main",
            productionBranch: "release",
            domains: [
              {
                hostname: "docs.example.test",
                channel: "production",
                verified: true,
                lastCheckedAt: "2026-05-25T00:00:00.000Z"
              }
            ]
          })
        });
        const body = await created.json();

        expect(created.status).toBe(201);
        expect(body).toMatchObject({
          status: "created",
          project: {
            id: "project_docs-portal",
            slug: "docs-portal",
            productionBranch: "release",
            domains: [
              {
                hostname: "docs.example.test",
                channel: "production",
                verified: true,
                lastCheckedAt: "2026-05-25T00:00:00.000Z"
              }
            ]
          }
        });
      },
      { apiToken: "deploy-token" }
    );
  });

  it("serves project settings and environment variable metadata without secret values", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const settingsResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/settings`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const settings = await settingsResponse.json();

        expect(settingsResponse.status).toBe(200);
        expect(settings.environments.map((environment: { name: string }) => environment.name)).toEqual([
          "local",
          "preview",
          "production"
        ]);

        const upsertResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/environment-variables`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            key: "SITEFLOW_TOKEN",
            value: "sf_live_super_secret_value",
            targetEnvironment: "preview",
            scope: "build",
            actor: { id: "actor-1", name: "Ops", role: "operator" }
          })
        });
        const upsert = await upsertResponse.json();
        const serialized = JSON.stringify(upsert);

        expect(upsertResponse.status).toBe(200);
        expect(upsert).toMatchObject({
          status: "upserted",
          variable: {
            key: "SITEFLOW_TOKEN",
            targetEnvironment: "preview",
            scope: "build",
            fingerprint: "sha256:metadata-only"
          }
        });
        expect(serialized).not.toContain("sf_live_super_secret_value");
      },
      { apiToken: "deploy-token" }
    );
  });

  it("serves analytics dashboard and ingests privacy-sanitized events without bearer auth", async () => {
    let dashboardProjectId: SiteFlowId | undefined;
    let ingestedCommand: AnalyticsEventCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      getAnalyticsDashboard: async (projectId: SiteFlowId): Promise<AnalyticsDashboardReadModel> => {
        dashboardProjectId = projectId;
        return fixtureRepository().getAnalyticsDashboard(projectId);
      },
      ingestAnalyticsEvent: async (command: AnalyticsEventCommand): Promise<AnalyticsIngestReadModel> => {
        ingestedCommand = command;
        return fixtureRepository().ingestAnalyticsEvent(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const dashboardResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/analytics`);
        const dashboard = await dashboardResponse.json();

        expect(dashboardResponse.status).toBe(200);
        expect(dashboard).toMatchObject({
          projectId: "project-acme-dashboard",
          totals: {
            pageviews: 42,
            customEvents: 7,
            webVitals: 3
          },
          topPages: expect.arrayContaining([
            expect.objectContaining({ name: "/pricing", count: 10 })
          ]),
          webVitals: expect.arrayContaining([
            expect.objectContaining({ name: "LCP", rating: "good" })
          ])
        });

        const ingestResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/analytics/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            projectId: "project-other",
            kind: "pageview",
            path: `/pricing?token=${SITEFLOW_SECRET_CANARY}#plan`,
            referrer: `https://vercel.com/templates?token=${SITEFLOW_SECRET_CANARY}#card`,
            browser: `Chrome ${SITEFLOW_SECRET_CANARY}`,
            device: "desktop",
            occurredAt: "2026-05-26T00:00:00.000Z"
          })
        });
        const ingested = await ingestResponse.json();
        const serialized = JSON.stringify(ingested);

        expect(ingestResponse.status).toBe(202);
        expect(ingested).toMatchObject({
          status: "accepted",
          event: {
            projectId: "project-acme-dashboard",
            path: "/pricing",
            referrer: "https://vercel.com/templates",
            browser: expect.stringContaining("[REDACTED]")
          }
        });
        expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
      },
      { apiToken: "deploy-token" }
    );

    expect(dashboardProjectId).toBe("project-acme-dashboard");
    expect(ingestedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      kind: "pageview",
      path: expect.stringContaining(SITEFLOW_SECRET_CANARY)
    });
  });

  it("serves observability logs and delivers signed redacted log drains", async () => {
    const deliveries: Array<{ input: string; headers: Headers; payload: string }> = [];
    const drainFetch: DrainFetch = async (input, init) => {
      deliveries.push({
        input,
        headers: new Headers(init?.headers),
        payload: init?.body?.toString() ?? ""
      });

      return new Response("accepted", { status: 202 });
    };

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const logsResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/logs?source=build&severity=warning`);
        const logs = await logsResponse.json();

        expect(logsResponse.status).toBe(200);
        expect(logs).toMatchObject({
          projectId: "project-acme-dashboard",
          filters: {
            source: "build",
            severity: "warning"
          },
          entries: [
            expect.objectContaining({
              source: "build",
              severity: "warning"
            })
          ]
        });

        const saveQueryResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/log-queries`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectId: "project-other",
            name: "Function errors",
            filters: {
              source: "function",
              severity: "error"
            }
          })
        });
        const savedQuery = await saveQueryResponse.json();

        expect(saveQueryResponse.status).toBe(201);
        expect(savedQuery.query).toMatchObject({
          projectId: "project-acme-dashboard",
          name: "Function errors"
        });

        const createDrainResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/log-drains`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectId: "project-other",
            name: "Datadog intake",
            url: "https://logs.example.test/siteflow",
            sources: ["build", "function"],
            minimumSeverity: "warning",
            signingSecret: "sfd_test_secret"
          })
        });
        const createdDrain = await createDrainResponse.json();

        expect(createDrainResponse.status).toBe(201);
        expect(createdDrain.drain).toMatchObject({
          projectId: "project-acme-dashboard",
          name: "Datadog intake",
          signingSecretPrefix: "sfd_test_sec"
        });
        expect(JSON.stringify(createdDrain)).not.toContain("sfd_test_secret");

        const deliverResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/log-drains/drain_fixture_observability/deliver`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectId: "project-other",
            drainId: "drain-other",
            reason: "manual verification",
            limit: 10
          })
        });
        const delivered = await deliverResponse.json();

        expect(deliverResponse.status).toBe(202);
        expect(delivered).toMatchObject({
          status: "delivered",
          delivery: {
            id: "delivery_fixture",
            drainId: "drain_fixture_observability",
            projectId: "project-acme-dashboard",
            responseStatus: 202
          }
        });
      },
      { apiToken: "deploy-token", drainFetch }
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].input).toBe("https://logs.example.test/siteflow");
    expect(deliveries[0].headers.get("x-siteflow-delivery")).toBe("delivery_fixture");
    expect(deliveries[0].headers.get("x-siteflow-signature")).toMatch(/^sha256=/);
    expect(deliveries[0].payload).not.toContain(SITEFLOW_SECRET_CANARY);
    expect(JSON.parse(deliveries[0].payload)).toMatchObject({
      id: "delivery_fixture",
      projectId: "project-acme-dashboard",
      drainId: "drain_fixture_observability",
      events: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("[REDACTED]")
        })
      ])
    });
  });

  it("creates, lists, and revokes deploy hooks through project routes", async () => {
    let createdCommand: CreateDeployHookCommand | undefined;
    let revokedCommand: RevokeDeployHookCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      createDeployHook: async (command: CreateDeployHookCommand): Promise<DeployHookCreateReadModel> => {
        createdCommand = command;
        return fixtureRepository().createDeployHook(command);
      },
      revokeDeployHook: async (command: RevokeDeployHookCommand): Promise<DeployHookRevokeReadModel> => {
        revokedCommand = command;
        return fixtureRepository().revokeDeployHook(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const createResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/deploy-hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token",
            "x-forwarded-host": "console.siteflow.test, internal.service",
            "x-forwarded-proto": "https, http"
          },
          body: JSON.stringify({
            projectId: "project-other",
            name: "CMS rebuild",
            branch: "main",
            targetEnvironment: "preview",
            actor: { id: "actor-1", name: "Ops", role: "operator" }
          })
        });
        const created = await createResponse.json();

        expect(createResponse.status).toBe(201);
        expect(created).toMatchObject({
          status: "created",
          hook: {
            projectId: "project-acme-dashboard",
            name: "CMS rebuild"
          },
          token: "sfh_test_token"
        });
        expect(created.hookUrl).toBe("https://console.siteflow.test/api/deploy-hooks/sfh_test_token/trigger");

        const listResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/deploy-hooks`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const list = await listResponse.json();

        expect(listResponse.status).toBe(200);
        expect(list.total).toBe(1);
        expect(JSON.stringify(list)).not.toContain("sfh_test_token");

        const revokeResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/deploy-hooks/hook_preview`, {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectId: "project-other",
            hookId: "hook_other",
            reason: "rotated"
          })
        });
        const revoked = await revokeResponse.json();

        expect(revokeResponse.status).toBe(200);
        expect(revoked).toMatchObject({
          status: "revoked",
          hook: {
            id: "hook_preview",
            projectId: "project-acme-dashboard",
            status: "revoked"
          }
        });
      },
      { apiToken: "deploy-token" }
    );

    expect(createdCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      name: "CMS rebuild",
      branch: "main",
      targetEnvironment: "preview"
    });
    expect(revokedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      hookId: "hook_preview",
      reason: "rotated"
    });
  });

  it("manages firewall rules and Edge Config through project routes", async () => {
    const received: {
      firewallCreate?: CreateFirewallRuleCommand;
      firewallDisable?: DisableFirewallRuleCommand;
      edgeUpsert?: UpsertEdgeConfigCommand;
      edgeDelete?: DeleteEdgeConfigCommand;
    } = {};
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      createFirewallRule: async (command: CreateFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> => {
        received.firewallCreate = command;
        return fixtureRepository().createFirewallRule(command);
      },
      disableFirewallRule: async (command: DisableFirewallRuleCommand): Promise<FirewallRuleMutationReadModel> => {
        received.firewallDisable = command;
        return fixtureRepository().disableFirewallRule(command);
      },
      upsertEdgeConfig: async (command: UpsertEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> => {
        received.edgeUpsert = command;
        return fixtureRepository().upsertEdgeConfig(command);
      },
      deleteEdgeConfig: async (command: DeleteEdgeConfigCommand): Promise<EdgeConfigMutationReadModel> => {
        received.edgeDelete = command;
        return fixtureRepository().deleteEdgeConfig(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        };
        const createFirewallResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/firewall-rules`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            name: "Block scrapers",
            action: "block",
            priority: 20,
            conditions: {
              pathPattern: "/admin/*",
              header: {
                name: "x-plan",
                value: "free"
              },
              userAgent: "curl"
            },
            actor: { id: "actor-1", name: "Ops", role: "operator" }
          })
        });
        const createdFirewall = await createFirewallResponse.json();

        expect(createFirewallResponse.status).toBe(201);
        expect(createdFirewall).toMatchObject({
          status: "created",
          rule: {
            projectId: "project-acme-dashboard",
            name: "Block scrapers",
            action: "block"
          }
        });

        const listFirewallResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/firewall-rules`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const firewallList = await listFirewallResponse.json();

        expect(listFirewallResponse.status).toBe(200);
        expect(firewallList).toMatchObject({
          projectId: "project-acme-dashboard",
          total: 1,
          rules: [
            expect.objectContaining({
              id: "fw_fixture_admin",
              status: "active"
            })
          ]
        });

        const disableFirewallResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/firewall-rules/fw_fixture_admin`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            ruleId: "fw_other",
            reason: "rotated"
          })
        });
        const disabledFirewall = await disableFirewallResponse.json();

        expect(disableFirewallResponse.status).toBe(200);
        expect(disabledFirewall).toMatchObject({
          status: "disabled",
          rule: {
            id: "fw_fixture_admin",
            projectId: "project-acme-dashboard",
            status: "disabled"
          }
        });

        const getEdgeConfigResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/edge-config`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const edgeConfig = await getEdgeConfigResponse.json();

        expect(getEdgeConfigResponse.status).toBe(200);
        expect(edgeConfig).toMatchObject({
          projectId: "project-acme-dashboard",
          entries: [
            expect.objectContaining({
              key: "maintenance",
              value: false
            })
          ]
        });

        const upsertEdgeResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/edge-config/maintenance`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            key: "other",
            value: {
              enabled: true,
              banner: "Scheduled maintenance"
            },
            actor: { id: "actor-1", name: "Ops", role: "operator" }
          })
        });
        const upsertedEdge = await upsertEdgeResponse.json();

        expect(upsertEdgeResponse.status).toBe(200);
        expect(upsertedEdge).toMatchObject({
          status: "upserted",
          entry: {
            projectId: "project-acme-dashboard",
            key: "maintenance",
            valueType: "json"
          }
        });

        const deleteEdgeResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/edge-config/maintenance`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            key: "other",
            reason: "cleanup"
          })
        });
        const deletedEdge = await deleteEdgeResponse.json();

        expect(deleteEdgeResponse.status).toBe(200);
        expect(deletedEdge.status).toBe("deleted");
      },
      { apiToken: "deploy-token" }
    );

    expect(received.firewallCreate).toMatchObject({
      projectId: "project-acme-dashboard",
      name: "Block scrapers",
      action: "block",
      conditions: {
        pathPattern: "/admin/*",
        header: {
          name: "x-plan",
          value: "free"
        },
        userAgent: "curl"
      }
    });
    expect(received.firewallDisable).toMatchObject({
      projectId: "project-acme-dashboard",
      ruleId: "fw_fixture_admin",
      reason: "rotated"
    });
    expect(received.edgeUpsert).toMatchObject({
      projectId: "project-acme-dashboard",
      key: "maintenance",
      value: {
        enabled: true,
        banner: "Scheduled maintenance"
      }
    });
    expect(received.edgeDelete).toMatchObject({
      projectId: "project-acme-dashboard",
      key: "maintenance",
      reason: "cleanup"
    });
  });

  it("manages blobs through project routes", async () => {
    const received: {
      list?: ListBlobsCommand;
      put?: PutBlobCommand;
      get?: GetBlobCommand;
      delete?: DeleteBlobCommand;
    } = {};
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      listBlobs: async (command: ListBlobsCommand): Promise<BlobListReadModel> => {
        received.list = command;
        return fixtureRepository().listBlobs(command);
      },
      putBlob: async (command: PutBlobCommand): Promise<BlobPutReadModel> => {
        received.put = command;
        return fixtureRepository().putBlob(command);
      },
      getBlob: async (command: GetBlobCommand): Promise<BlobReadModel> => {
        received.get = command;
        return fixtureRepository().getBlob(command);
      },
      deleteBlob: async (command: DeleteBlobCommand): Promise<BlobDeleteReadModel> => {
        received.delete = command;
        return fixtureRepository().deleteBlob(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        };
        const contentBase64 = Buffer.from("{\"enabled\":true}", "utf8").toString("base64");
        const uploadResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/blobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            pathname: "assets/config/app.json",
            contentBase64,
            contentType: "application/json",
            access: "private",
            cacheControlMaxAge: 120,
            actor: { id: "actor-1", name: "Ops", role: "operator" }
          })
        });
        const uploaded = await uploadResponse.json();

        expect(uploadResponse.status).toBe(201);
        expect(uploaded).toMatchObject({
          status: "uploaded",
          blob: {
            projectId: "project-acme-dashboard",
            pathname: "assets/config/app.json",
            access: "private",
            contentType: "application/json"
          }
        });

        const listResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/blobs?prefix=assets%2Fconfig&limit=1`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const list = await listResponse.json();

        expect(listResponse.status).toBe(200);
        expect(list).toMatchObject({
          projectId: "project-acme-dashboard",
          total: 1,
          blobs: [
            expect.objectContaining({
              pathname: "assets/config/app.json"
            })
          ]
        });

        const encodedPathname = encodeURIComponent("assets/config/app.json");
        const getResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/blobs/${encodedPathname}`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const downloaded = await getResponse.json();

        expect(getResponse.status).toBe(200);
        expect(downloaded).toMatchObject({
          projectId: "project-acme-dashboard",
          blob: {
            pathname: "assets/config/app.json"
          },
          contentBase64: Buffer.from("SiteFlow fixture blob", "utf8").toString("base64")
        });

        const deleteResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/blobs/${encodedPathname}`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            pathname: "assets/other.json",
            reason: "cleanup"
          })
        });
        const deleted = await deleteResponse.json();

        expect(deleteResponse.status).toBe(200);
        expect(deleted).toMatchObject({
          status: "deleted",
          blob: {
            projectId: "project-acme-dashboard",
            pathname: "assets/config/app.json"
          }
        });
      },
      { apiToken: "deploy-token" }
    );

    expect(received.put).toMatchObject({
      projectId: "project-acme-dashboard",
      pathname: "assets/config/app.json",
      contentType: "application/json",
      access: "private",
      cacheControlMaxAge: 120
    });
    expect(received.list).toMatchObject({
      projectId: "project-acme-dashboard",
      prefix: "assets/config",
      limit: 1
    });
    expect(received.get).toMatchObject({
      projectId: "project-acme-dashboard",
      pathname: "assets/config/app.json"
    });
    expect(received.delete).toMatchObject({
      projectId: "project-acme-dashboard",
      pathname: "assets/config/app.json",
      reason: "cleanup"
    });
  });

  it("lists and purges cache entries through project routes", async () => {
    const received: {
      list?: ListCacheEntriesCommand;
      purge?: PurgeCacheCommand;
    } = {};
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      listCacheEntries: async (command: ListCacheEntriesCommand): Promise<CacheListReadModel> => {
        received.list = command;
        return fixtureRepository().listCacheEntries(command);
      },
      purgeCache: async (command: PurgeCacheCommand): Promise<CachePurgeReadModel> => {
        received.purge = command;
        return fixtureRepository().purgeCache(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const listResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/cache?tag=marketing&status=stale&limit=5`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const list = await listResponse.json();

        expect(listResponse.status).toBe(200);
        expect(list).toMatchObject({
          projectId: "project-acme-dashboard",
          total: 1,
          entries: [
            expect.objectContaining({
              path: "/pricing",
              status: "stale",
              staleWhileRevalidateSeconds: 300
            })
          ]
        });

        const purgeResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/cache/purge`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectId: "project-other",
            tag: "marketing",
            reason: "content update",
            actor: { id: "actor-1", name: "Ops", role: "operator" }
          })
        });
        const purged = await purgeResponse.json();

        expect(purgeResponse.status).toBe(200);
        expect(purged).toMatchObject({
          status: "purged",
          projectId: "project-acme-dashboard",
          total: 2,
          purged: [
            expect.objectContaining({
              status: "purged"
            }),
            expect.objectContaining({
              status: "purged"
            })
          ]
        });
      },
      { apiToken: "deploy-token" }
    );

    expect(received.list).toMatchObject({
      projectId: "project-acme-dashboard",
      tag: "marketing",
      status: "stale",
      limit: 5
    });
    expect(received.purge).toMatchObject({
      projectId: "project-acme-dashboard",
      tag: "marketing",
      reason: "content update"
    });
  });

  it("lists and inspects function runtime controls through project routes", async () => {
    const received: {
      list?: ListFunctionsCommand;
      inspect?: GetFunctionRuntimeCommand;
    } = {};
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      listFunctions: async (command: ListFunctionsCommand): Promise<FunctionRuntimeListReadModel> => {
        received.list = command;
        return fixtureRepository().listFunctions(command);
      },
      getFunctionRuntime: async (command: GetFunctionRuntimeCommand): Promise<FunctionRuntimeReadModel> => {
        received.inspect = command;
        return fixtureRepository().getFunctionRuntime(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const listResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/functions?deploymentId=dep_function`, {
          headers: {
            authorization: "Bearer read-token"
          }
        });
        const list = await listResponse.json();

        expect(listResponse.status).toBe(200);
        expect(list.projectId).toBe("project-acme-dashboard");
        expect(list.deploymentId).toBe("dep_function");
        expect(list.total).toBe(1);
        expect(list.functions[0].limits).toEqual({
          timeoutMs: 10000,
          memoryMb: 512,
          concurrency: 50
        });
        expect(list.functions[0].summary).toMatchObject({
          invocations: 2,
          errors: 1,
          errorRate: 0.5
        });

        const inspectResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/functions/${encodeURIComponent("/api/revalidate")}?deploymentId=dep_function&limit=1`, {
          headers: {
            authorization: "Bearer read-token"
          }
        });
        const detail = await inspectResponse.json();

        expect(inspectResponse.status).toBe(200);
        expect(detail.projectId).toBe("project-acme-dashboard");
        expect(detail.deploymentId).toBe("dep_function");
        expect(detail.function.function).toMatchObject({
          path: "/api/revalidate",
          runtime: "nodejs20.x"
        });
        expect(detail.recentInvocations[0]).toMatchObject({
          requestId: "req_ok",
          status: "succeeded"
        });
      },
      { apiToken: "deploy-token" }
    );

    expect(received.list).toMatchObject({
      projectId: "project-acme-dashboard",
      deploymentId: "dep_function"
    });
    expect(received.inspect).toMatchObject({
      projectId: "project-acme-dashboard",
      path: "/api/revalidate",
      deploymentId: "dep_function",
      limit: 1
    });
  });

  it("manages routing rules through project routes", async () => {
    const received: {
      list?: ListRoutingRulesCommand;
      upsert?: UpsertRoutingRuleCommand;
      disable?: DisableRoutingRuleCommand;
    } = {};
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      listRoutingRules: async (command: ListRoutingRulesCommand): Promise<RoutingRuleListReadModel> => {
        received.list = command;
        return fixtureRepository().listRoutingRules(command);
      },
      upsertRoutingRule: async (command: UpsertRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> => {
        received.upsert = command;
        return fixtureRepository().upsertRoutingRule(command);
      },
      disableRoutingRule: async (command: DisableRoutingRuleCommand): Promise<RoutingRuleMutationReadModel> => {
        received.disable = command;
        return fixtureRepository().disableRoutingRule(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const headers = {
          authorization: "Bearer admin-token",
          "content-type": "application/json"
        };
        const listResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/routing-rules?kind=redirect`, {
          headers: {
            authorization: "Bearer read-token"
          }
        });
        const list = await listResponse.json();

        expect(listResponse.status).toBe(200);
        expect(list.total).toBe(1);
        expect(list.rules[0]).toMatchObject({
          id: "route_docs",
          kind: "redirect",
          source: "/docs",
          destination: "/documentation"
        });

        const upsertResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/routing-rules`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            name: "Legacy docs",
            kind: "redirect",
            source: "/legacy-docs",
            destination: "/docs",
            statusCode: 308,
            priority: 5
          })
        });
        const upserted = await upsertResponse.json();

        expect(upsertResponse.status).toBe(200);
        expect(upserted).toMatchObject({
          status: "upserted",
          rule: {
            name: "Legacy docs",
            kind: "redirect",
            source: "/legacy-docs",
            destination: "/docs",
            statusCode: 308
          }
        });

        const disableResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/routing-rules/route_docs`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({
            reason: "Moved to app config."
          })
        });
        const disabled = await disableResponse.json();

        expect(disableResponse.status).toBe(200);
        expect(disabled).toMatchObject({
          status: "disabled",
          rule: {
            id: "route_docs",
            status: "disabled"
          }
        });
      },
      { apiToken: "admin-token" }
    );

    expect(received.list).toMatchObject({
      projectId: "project-acme-dashboard",
      kind: "redirect"
    });
    expect(received.upsert).toMatchObject({
      projectId: "project-acme-dashboard",
      name: "Legacy docs",
      kind: "redirect",
      source: "/legacy-docs",
      destination: "/docs",
      statusCode: 308
    });
    expect(received.disable).toMatchObject({
      projectId: "project-acme-dashboard",
      ruleId: "route_docs",
      reason: "Moved to app config."
    });
  });

  it("creates, lists, disables, and runs cron jobs through project routes", async () => {
    const received: {
      create?: CreateCronJobCommand;
      disable?: DisableCronJobCommand;
      run?: RunCronJobCommand;
    } = {};
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      createCronJob: async (command: CreateCronJobCommand): Promise<CronJobCreateReadModel> => {
        received.create = command;
        return fixtureRepository().createCronJob(command);
      },
      disableCronJob: async (command: DisableCronJobCommand): Promise<CronJobDisableReadModel> => {
        received.disable = command;
        return fixtureRepository().disableCronJob(command);
      },
      runCronJob: async (command: RunCronJobCommand): Promise<CronJobRunReadModel> => {
        received.run = command;
        return fixtureRepository().runCronJob(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        };
        const createResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/cron-jobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            name: "Revalidate homepage",
            path: "/api/revalidate",
            schedule: "0 * * * *",
            actor: { id: "actor-1", name: "Ops", role: "operator" }
          })
        });
        const created = await createResponse.json();

        expect(createResponse.status).toBe(201);
        expect(created).toMatchObject({
          status: "created",
          job: {
            projectId: "project-acme-dashboard",
            path: "/api/revalidate",
            schedule: "0 * * * *"
          }
        });

        const listResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/cron-jobs`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const list = await listResponse.json();

        expect(listResponse.status).toBe(200);
        expect(list.total).toBe(1);

        const runResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate/run`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            jobId: "cron_other",
            reason: "manual",
            idempotencyKey: "cron-run-1"
          })
        });
        const run = await runResponse.json();

        expect(runResponse.status).toBe(202);
        expect(run).toMatchObject({
          status: "accepted",
          dispatch: {
            cronJobId: "cron_revalidate",
            targetUrl: "https://dashboard.acme.test/api/revalidate",
            userAgent: "vercel-cron/1.0"
          }
        });

        const disableResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            jobId: "cron_other",
            reason: "pause"
          })
        });
        const disabled = await disableResponse.json();

        expect(disableResponse.status).toBe(200);
        expect(disabled).toMatchObject({
          status: "disabled",
          job: {
            id: "cron_revalidate",
            status: "disabled"
          }
        });
      },
      { apiToken: "deploy-token" }
    );

    expect(received.create).toMatchObject({
      projectId: "project-acme-dashboard",
      name: "Revalidate homepage",
      path: "/api/revalidate",
      schedule: "0 * * * *"
    });
    expect(received.run).toMatchObject({
      projectId: "project-acme-dashboard",
      jobId: "cron_revalidate",
      reason: "manual",
      idempotencyKey: "cron-run-1"
    });
    expect(received.disable).toMatchObject({
      projectId: "project-acme-dashboard",
      jobId: "cron_revalidate",
      reason: "pause"
    });
  });

  it("triggers deploy hooks without requiring the management bearer token", async () => {
    let triggeredCommand: TriggerDeployHookCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      triggerDeployHook: async (command: TriggerDeployHookCommand): Promise<DeployHookTriggerReadModel> => {
        triggeredCommand = command;
        return fixtureRepository().triggerDeployHook(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/deploy-hooks/sfh_test_token/trigger`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            branch: "main",
            commitSha: "4f3a9c2d1b0e",
            commitMessage: "CMS published",
            idempotencyKey: "cms-42"
          })
        });
        const body = await response.json();

        expect(response.status).toBe(202);
        expect(body).toMatchObject({
          status: "accepted",
          buildJobId: "build_hook",
          sourceEvent: {
            providerDeliveryId: "cms-42",
            branch: "main",
            commitSha: "4f3a9c2d1b0e"
          }
        });
      },
      { apiToken: "deploy-token" }
    );

    expect(triggeredCommand).toMatchObject({
      token: "sfh_test_token",
      branch: "main",
      commitSha: "4f3a9c2d1b0e",
      commitMessage: "CMS published",
      idempotencyKey: "cms-42"
    });
  });

  it("accepts signed GitHub push webhooks and queues a build", async () => {
    const secret = "github-webhook-secret";
    let receivedCommand: GitWebhookCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => {
        receivedCommand = command;

        return {
          status: "accepted",
          sourceEvent: {
            id: `src_${command.deliveryId}`,
            projectId: "project_docs_portal",
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
          buildJobId: "build_delivery-1",
          message: "Git webhook accepted and build job queued."
        };
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const rawBody = JSON.stringify(githubPushPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": "delivery-1",
            "x-github-event": "push",
            "x-hub-signature-256": signGitHubBody(rawBody, secret)
          },
          body: rawBody
        });
        const body = await response.json();

        expect(response.status).toBe(202);
        expect(body).toMatchObject({
          status: "accepted",
          buildJobId: "build_delivery-1"
        });
      },
      { githubWebhookSecret: secret }
    );

    expect(receivedCommand).toMatchObject({
      provider: "github",
      deliveryId: "delivery-1",
      event: {
        provider: "github",
        deliveryId: "delivery-1",
        kind: "push",
        branch: "main",
        commitSha: "4f3a9c2d1b0e",
        commitMessage: "Ship docs portal",
        commitAuthor: "Ada Lovelace",
        actor: {
          id: "github:octocat",
          name: "octocat",
          role: "developer"
        },
        repository: {
          provider: "github",
          owner: "acme",
          name: "docs-portal",
          defaultBranch: "main"
        }
      }
    });
  });

  it("returns duplicate for repeated GitHub delivery ids", async () => {
    const secret = "github-webhook-secret";
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => ({
        status: "duplicate",
        sourceEvent: {
          id: "src_existing",
          projectId: "project_docs_portal",
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
        buildJobId: "build_existing",
        message: "Git webhook delivery was already processed."
      })
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const rawBody = JSON.stringify(githubPushPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": "delivery-1",
            "x-github-event": "push",
            "x-hub-signature-256": signGitHubBody(rawBody, secret)
          },
          body: rawBody
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          status: "duplicate",
          buildJobId: "build_existing"
        });
      },
      { githubWebhookSecret: secret }
    );
  });

  it("rejects GitHub webhooks with invalid signatures before repository ingest", async () => {
    const secret = "github-webhook-secret";
    let ingestCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => {
        ingestCalls += 1;
        return fixtureRepository().ingestGitWebhook(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const rawBody = JSON.stringify(githubPushPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": "delivery-1",
            "x-github-event": "push",
            "x-hub-signature-256": signGitHubBody(`${rawBody}tampered`, secret)
          },
          body: rawBody
        });
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body.message).toMatch(/signature verification failed/i);
      },
      { githubWebhookSecret: secret }
    );

    expect(ingestCalls).toBe(0);
  });

  it("reports the configured wildcard base domain through auth verify", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
          authenticated: true,
          authRequired: true,
          baseDomain: "w33d.xyz"
        });
      },
      { apiToken: "deploy-token", baseDomain: "w33d.xyz" }
    );
  });

  it("accepts promotion commands through the HTTP API", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-1"
        })
      });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.status).toBe("accepted");
    });
  });

  it("uses release route project and channel instead of body values", async () => {
    let receivedCommand: PromoteDeploymentCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        receivedCommand = command;
        return fixtureRepository().promoteDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project-other",
          channel: "preview",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-url-source"
        })
      });

      expect(response.status).toBe(202);
    });

    expect(receivedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      targetDeploymentId: "dep-healthy"
    });
  });

  it("uses rolling route project and channel instead of body values", async () => {
    const received: {
      start?: StartRollingReleaseCommand;
      advance?: AdvanceRollingReleaseCommand;
      complete?: CompleteRollingReleaseCommand;
      abort?: AbortRollingReleaseCommand;
    } = {};
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      startRollingRelease: async (command: StartRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => {
        received.start = command;
        return fixtureRepository().startRollingRelease(command);
      },
      advanceRollingRelease: async (command: AdvanceRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => {
        received.advance = command;
        return fixtureRepository().advanceRollingRelease(command);
      },
      completeRollingRelease: async (command: CompleteRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => {
        received.complete = command;
        return fixtureRepository().completeRollingRelease(command);
      },
      abortRollingRelease: async (command: AbortRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => {
        received.abort = command;
        return fixtureRepository().abortRollingRelease(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        };
        const getResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });

        expect(getResponse.status).toBe(200);

        const start = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/start`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            channel: "preview",
            candidateDeploymentId: "dep-canary",
            percentage: 10,
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "canary",
            idempotencyKey: "rollout-start"
          })
        });
        const advance = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/advance`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            channel: "preview",
            percentage: 50,
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "canary",
            idempotencyKey: "rollout-advance"
          })
        });
        const complete = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/complete`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            channel: "preview",
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "ship",
            idempotencyKey: "rollout-complete"
          })
        });
        const abort = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/abort`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: "project-other",
            channel: "preview",
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "stop",
            idempotencyKey: "rollout-abort"
          })
        });

        expect(start.status).toBe(202);
        expect(advance.status).toBe(202);
        expect(complete.status).toBe(202);
        expect(abort.status).toBe(202);
      },
      { apiToken: "deploy-token" }
    );

    expect(received.start).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      candidateDeploymentId: "dep-canary",
      percentage: 10
    });
    expect(received.advance).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      percentage: 50
    });
    expect(received.complete).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production"
    });
    expect(received.abort).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production"
    });
  });

  it("accepts prebuilt deploy uploads through the HTTP API", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          files: [
            {
              path: "index.html",
              contentBase64: Buffer.from("<h1>Hello</h1>").toString("base64"),
              size: 14,
              sha256: "unused-by-fixture"
            }
          ]
        })
      });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.previewUrl).toBe("https://abc123.w33d.xyz");
    });
  });

  it("accepts prebuilt deploy uploads without baseDomain for server-owned wildcard domains", async () => {
    let receivedCommand: PrebuiltDeployCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        receivedCommand = command;
        const baseDomain = command.baseDomain ?? "w33d.xyz";
        const previewHost = `abc123.${baseDomain}`;

        return {
          deploymentId: "dep_prebuilt",
          projectId: "project_docs",
          projectSlug: command.projectSlug,
          previewHost,
          previewUrl: `https://${previewHost}`,
          artifactRoot: "/tmp/siteflow/dep_prebuilt",
          fileCount: command.files.length,
          totalBytes: command.files.reduce((total, file) => total + file.size, 0),
          checksum: "sha256"
        };
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectSlug: "docs",
            requestedHostPrefix: "abc123",
            routing: {
              redirects: [
                {
                  source: "/docs",
                  destination: "/documentation",
                  statusCode: 308
                }
              ]
            },
            crons: [
              {
                path: "/api/revalidate",
                schedule: "0 * * * *"
              }
            ],
            files: [
              {
                path: "index.html",
                contentBase64: Buffer.from("<h1>Hello</h1>").toString("base64"),
                size: 14,
                sha256: "unused-by-fixture"
              }
            ]
          })
        });
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.previewUrl).toBe("https://abc123.w33d.xyz");
      },
      { baseDomain: "w33d.xyz" }
    );

    expect(receivedCommand).toMatchObject({
      projectSlug: "docs",
      requestedHostPrefix: "abc123",
      routing: {
        redirects: [
          {
            source: "/docs",
            destination: "/documentation",
            statusCode: 308
          }
        ]
      },
      crons: [
        {
          path: "/api/revalidate",
          schedule: "0 * * * *"
        }
      ]
    });
    expect(receivedCommand?.baseDomain).toBeUndefined();
  });

  it("requires a bearer token for mutating endpoints when configured", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const rejected = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectSlug: "docs",
            baseDomain: "w33d.xyz",
            files: []
          })
        });

        expect(rejected.status).toBe(401);

        const verified = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const verifiedBody = await verified.json();

        expect(verified.status).toBe(200);
        expect(verifiedBody).toMatchObject({ authenticated: true, authRequired: true });

        const accepted = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectSlug: "docs",
            baseDomain: "w33d.xyz",
            files: [
              {
                path: "index.html",
                contentBase64: Buffer.from("<h1>Hello</h1>").toString("base64"),
                size: 14,
                sha256: "unused-by-fixture"
              }
            ]
          })
        });

        expect(accepted.status).toBe(201);
      },
      { apiToken: "deploy-token" }
    );
  });

  it("enforces scoped API token permissions for read, write, and admin routes", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const readSettings = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/settings`, {
          headers: {
            authorization: "Bearer read-token"
          }
        });
        const readSettingsBody = await readSettings.json();

        expect(readSettings.status).toBe(200);
        expect(readSettingsBody.currentPermissions).toEqual(["read"]);

        const rejectedWrite = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer read-token"
          },
          body: JSON.stringify({
            targetDeploymentId: "dep-healthy",
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "ship",
            idempotencyKey: "read-token-promote"
          })
        });

        expect(rejectedWrite.status).toBe(403);

        const acceptedWrite = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer operator-token"
          },
          body: JSON.stringify({
            targetDeploymentId: "dep-healthy",
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "ship",
            idempotencyKey: "operator-token-promote"
          })
        });

        expect(acceptedWrite.status).toBe(202);

        const rejectedAdmin = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/api-tokens`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer operator-token"
          },
          body: JSON.stringify({
            name: "Read token",
            scopes: ["read"]
          })
        });

        expect(rejectedAdmin.status).toBe(403);

        const acceptedAdmin = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/api-tokens`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer admin-token"
          },
          body: JSON.stringify({
            name: "Read token",
            scopes: ["read"]
          })
        });
        const adminBody = await acceptedAdmin.json();

        expect(acceptedAdmin.status).toBe(201);
        expect(adminBody.secret).toBe("sft_created_secret");
      },
      { apiToken: "deploy-token" }
    );
  });

  it("serves a deployed artifact by preview host", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>SiteFlow Preview</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_prebuilt",
                artifactRoot,
                entrypoint: "index.html"
              }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz, proxy.internal"
          }
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("x-siteflow-deployment")).toBe("dep_prebuilt");
        expect(body).toContain("SiteFlow Preview");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("applies CORS metadata to static artifact responses", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-static-cors-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>SiteFlow Preview</h1>");
      await writeFile(path.join(artifactRoot, "about.html"), "<h1>About</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_static_cors",
                artifactRoot,
                entrypoint: "index.html",
                cleanUrls: true
              }
            : undefined
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const html = await rawHttpGet(baseUrl, "/", {
            "x-forwarded-host": "abc123.w33d.xyz"
          });
          const head = await rawHttpGet(baseUrl, "/", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");
          const redirect = await rawHttpGet(baseUrl, "/about.html", {
            "x-forwarded-host": "abc123.w33d.xyz"
          });

          for (const response of [html, head, redirect]) {
            expect(response.headers["access-control-allow-origin"]).toBe("https://console.example.test");
            expect(response.headers["access-control-expose-headers"]?.split(",").map((header) => header.trim())).toContain("x-siteflow-deployment");
            expect(response.headers.vary?.split(",").map((header) => header.trim().toLowerCase())).toContain("origin");
          }

          expect(html.status).toBe(200);
          expect(html.headers["x-siteflow-deployment"]).toBe("dep_static_cors");
          expect(html.headers.vary?.split(",").map((header) => header.trim().toLowerCase())).toContain("accept-encoding");
          expect(html.body.toString("utf8")).toContain("SiteFlow Preview");
          expect(head.status).toBe(200);
          expect(head.headers["x-siteflow-deployment"]).toBe("dep_static_cors");
          expect(head.body.byteLength).toBe(0);
          expect(redirect.status).toBe(308);
          expect(redirect.headers.location).toBe("/about");
          expect(redirect.headers["x-siteflow-static-redirect"]).toBe("canonical");
        },
        { allowedOrigin: "https://console.example.test" }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("sets Vercel-like cache headers and ETags for static artifact responses", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-static-cache-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>SiteFlow Preview</h1>");
      await mkdir(path.join(artifactRoot, "assets"), { recursive: true });
      await writeFile(path.join(artifactRoot, "assets", "index-a1b2c3d4.js"), "console.log('immutable');");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
              host,
              deploymentId: "dep_static_cache",
              artifactRoot,
              entrypoint: "index.html",
              cleanUrls: true
            }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const html = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const htmlEtag = html.headers.get("etag");
        const lastModified = html.headers.get("last-modified");
        const cachedHtml = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": htmlEtag ?? ""
          }
        });
        const cachedByStrongFormEtag = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": htmlEtag?.replace(/^W\//, "") ?? ""
          }
        });
        const cachedByAnyEtag = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": `W/"old", ${htmlEtag ?? ""}`
          }
        });
        const cachedByModifiedTime = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-modified-since": lastModified ?? ""
          }
        });
        const invalidIfModifiedSince = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-modified-since": "not-a-date"
          }
        });
        const matchingWeakIfMatch = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": htmlEtag ?? ""
          }
        });
        const multiValueIfMatch = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": `W/"old", ${htmlEtag ?? ""}`
          }
        });
        const existingResourceIfMatch = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": "*"
          }
        });
        const multiValueWildcardIfMatch = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": `W/"old", *`
          }
        });
        const staleIfUnmodifiedSince = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT"
          }
        });
        const invalidIfUnmodifiedSince = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-unmodified-since": "not-a-date"
          }
        });
        const staleWhenEtagDisagrees = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": 'W/"different"',
            "if-modified-since": lastModified ?? ""
          }
        });
        const asset = await fetch(`${baseUrl}/assets/index-a1b2c3d4.js`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const directory = await fetch(`${baseUrl}/assets/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const assetHead = await fetch(`${baseUrl}/assets/index-a1b2c3d4.js`, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const cachedHead = await fetch(`${baseUrl}/`, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": htmlEtag ?? ""
          }
        });
        const failedPreconditionHead = await fetch(`${baseUrl}/`, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT"
          }
        });
        const rejectedMethod = await fetch(`${baseUrl}/assets/index-a1b2c3d4.js`, {
          method: "POST",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });

        expect(html.status).toBe(200);
        expect(html.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(html.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toContain("origin");
        expect(html.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
        expect(html.headers.get("x-content-type-options")).toBe("nosniff");
        expect(html.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
        expect(htmlEtag).toMatch(/^W\/"/);
        expect(lastModified).toBeTruthy();
        expect(cachedHtml.status).toBe(304);
        expect(cachedHtml.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(cachedHtml.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toContain("origin");
        expect(cachedHtml.headers.get("content-length")).toBeNull();
        expect(await cachedHtml.text()).toBe("");
        expect(cachedByStrongFormEtag.status).toBe(304);
        expect(await cachedByStrongFormEtag.text()).toBe("");
        expect(cachedByAnyEtag.status).toBe(304);
        expect(await cachedByAnyEtag.text()).toBe("");
        expect(cachedByModifiedTime.status).toBe(304);
        expect(await cachedByModifiedTime.text()).toBe("");
        expect(invalidIfModifiedSince.status).toBe(200);
        expect(await invalidIfModifiedSince.text()).toContain("SiteFlow Preview");
        expect(matchingWeakIfMatch.status).toBe(412);
        expect(matchingWeakIfMatch.headers.get("content-length")).toBeNull();
        expect(await matchingWeakIfMatch.text()).toBe("");
        expect(multiValueIfMatch.status).toBe(412);
        expect(await multiValueIfMatch.text()).toBe("");
        expect(existingResourceIfMatch.status).toBe(200);
        expect(await existingResourceIfMatch.text()).toContain("SiteFlow Preview");
        expect(multiValueWildcardIfMatch.status).toBe(200);
        expect(await multiValueWildcardIfMatch.text()).toContain("SiteFlow Preview");
        expect(staleIfUnmodifiedSince.status).toBe(412);
        expect(staleIfUnmodifiedSince.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(staleIfUnmodifiedSince.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toContain("origin");
        expect(await staleIfUnmodifiedSince.text()).toBe("");
        expect(invalidIfUnmodifiedSince.status).toBe(200);
        expect(await invalidIfUnmodifiedSince.text()).toContain("SiteFlow Preview");
        expect(staleWhenEtagDisagrees.status).toBe(200);
        expect(await staleWhenEtagDisagrees.text()).toContain("SiteFlow Preview");
        expect(asset.status).toBe(200);
        expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
        expect(asset.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
        expect(asset.headers.get("etag")).toMatch(/^W\/"/);
        expect(await asset.text()).toContain("immutable");
        expect(directory.status).toBe(404);
        expect(await directory.json()).toEqual({
          message: "Artifact route path was not found."
        });
        expect(assetHead.status).toBe(200);
        expect(assetHead.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(await assetHead.text()).toBe("");
        expect(cachedHead.status).toBe(304);
        expect(cachedHead.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(cachedHead.headers.get("etag")).toBe(htmlEtag);
        expect(cachedHead.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
        expect(cachedHead.headers.get("content-length")).toBeNull();
        expect(await cachedHead.text()).toBe("");
        expect(failedPreconditionHead.status).toBe(412);
        expect(failedPreconditionHead.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(failedPreconditionHead.headers.get("etag")).toBe(htmlEtag);
        expect(failedPreconditionHead.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
        expect(failedPreconditionHead.headers.get("content-length")).toBeNull();
        expect(await failedPreconditionHead.text()).toBe("");
        expect(rejectedMethod.status).toBe(405);
        expect(rejectedMethod.headers.get("allow")).toBe("GET, HEAD");
        expect(await rejectedMethod.json()).toEqual({
          message: "Static artifact routes only support GET and HEAD."
        });
      }, { allowedOrigin: "https://console.example.test" });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("does not expose internal function bundle files as static artifacts", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-private-functions-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>SiteFlow Preview</h1>");
      await mkdir(path.join(artifactRoot, ".siteflow", "functions", "api"), { recursive: true });
      await writeFile(
        path.join(artifactRoot, ".siteflow", "functions", "api", "revalidate.js"),
        "export default async function handler() { return new Response('secret'); }"
      );
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_private_functions",
                artifactRoot,
                entrypoint: "index.html"
              }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const internal = await fetch(`${baseUrl}/.siteflow/functions/api/revalidate.js`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const home = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });

        expect(internal.status).toBe(404);
        expect(await internal.json()).toEqual({
          message: "Artifact route path was not found."
        });
        expect(home.status).toBe(200);
        expect(await home.text()).toContain("SiteFlow Preview");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("serves byte ranges for static artifact responses", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-static-ranges-"));

    try {
      await writeFile(path.join(artifactRoot, "video.mp4"), "0123456789abcdef");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_static_ranges",
                artifactRoot,
                entrypoint: "video.mp4"
              }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const full = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const etag = full.headers.get("etag");
        const lastModified = full.headers.get("last-modified");
        const partial = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            range: "bytes=2-5"
          }
        });
        const suffix = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            range: "bytes=-4"
          }
        });
        const invalid = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            range: "bytes=99-120"
          }
        });
        const cachedInvalidRange = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": etag ?? "",
            range: "bytes=99-120"
          }
        });
        const failedPreconditionInvalidRange = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": '"different"',
            range: "bytes=99-120"
          }
        });
        const head = await fetch(`${baseUrl}/video.mp4`, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            range: "bytes=2-5"
          }
        });
        const ifRangeWeakEtag = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-range": etag ?? "",
            range: "bytes=4-7"
          }
        });
        const ifRangeDateMatched = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-range": lastModified ?? "",
            range: "bytes=8-11"
          }
        });
        const ifRangeMismatched = await fetch(`${baseUrl}/video.mp4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-range": 'W/"different"',
            range: "bytes=4-7"
          }
        });

        expect(full.status).toBe(200);
        expect(etag).toMatch(/^W\/"/);
        expect(lastModified).toBeTruthy();
        expect(partial.status).toBe(206);
        expect(partial.headers.get("accept-ranges")).toBe("bytes");
        expect(partial.headers.get("content-range")).toBe("bytes 2-5/16");
        expect(partial.headers.get("content-length")).toBe("4");
        expect(await partial.text()).toBe("2345");
        expect(suffix.status).toBe(206);
        expect(suffix.headers.get("content-range")).toBe("bytes 12-15/16");
        expect(await suffix.text()).toBe("cdef");
        expect(invalid.status).toBe(416);
        expect(invalid.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(invalid.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toContain("origin");
        expect(invalid.headers.get("content-range")).toBe("bytes */16");
        expect(invalid.headers.get("content-length")).toBeNull();
        expect(await invalid.text()).toBe("");
        expect(cachedInvalidRange.status).toBe(304);
        expect(cachedInvalidRange.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(cachedInvalidRange.headers.get("content-range")).toBeNull();
        expect(cachedInvalidRange.headers.get("content-length")).toBeNull();
        expect(await cachedInvalidRange.text()).toBe("");
        expect(failedPreconditionInvalidRange.status).toBe(412);
        expect(failedPreconditionInvalidRange.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(failedPreconditionInvalidRange.headers.get("content-range")).toBeNull();
        expect(failedPreconditionInvalidRange.headers.get("content-length")).toBeNull();
        expect(await failedPreconditionInvalidRange.text()).toBe("");
        expect(head.status).toBe(200);
        expect(head.headers.get("accept-ranges")).toBe("bytes");
        expect(head.headers.get("content-length")).toBe("16");
        expect(await head.text()).toBe("");
        expect(ifRangeWeakEtag.status).toBe(200);
        expect(ifRangeWeakEtag.headers.get("content-range")).toBeNull();
        expect(await ifRangeWeakEtag.text()).toBe("0123456789abcdef");
        expect(ifRangeDateMatched.status).toBe(206);
        expect(ifRangeDateMatched.headers.get("content-range")).toBe("bytes 8-11/16");
        expect(await ifRangeDateMatched.text()).toBe("89ab");
        expect(ifRangeMismatched.status).toBe(200);
        expect(ifRangeMismatched.headers.get("content-range")).toBeNull();
        expect(await ifRangeMismatched.text()).toBe("0123456789abcdef");
      }, { allowedOrigin: "https://console.example.test" });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("serves precompressed static artifacts by Accept-Encoding", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-static-encoding-"));
    const script = "console.log('precompressed asset');";

    try {
      await mkdir(path.join(artifactRoot, "assets"), { recursive: true });
      await writeFile(path.join(artifactRoot, "assets", "index-a1b2c3d4.js"), script);
      await writeFile(path.join(artifactRoot, "assets", "index-a1b2c3d4.js.br"), brotliCompressSync(Buffer.from(script)));
      await writeFile(path.join(artifactRoot, "assets", "index-a1b2c3d4.js.gz"), gzipSync(Buffer.from(script)));
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_static_encoding",
                artifactRoot,
                entrypoint: "assets/index-a1b2c3d4.js"
              }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const brotli = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "gzip, br"
        });
        const cachedBrotli = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "br",
          "if-none-match": brotli.headers.etag ?? ""
        });
        const gzip = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "gzip"
        });
        const gzipPreferred = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "br;q=0.2, gzip;q=1"
        });
        const brotliDisabled = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "br;q=0, gzip;q=0.8"
        });
        const wildcard = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "*;q=0.7"
        });
        const wildcardWithBrotliRefusal = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "*;q=0.7, br;q=0"
        });
        const brotliHead = await fetch(`${baseUrl}/assets/index-a1b2c3d4.js`, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "accept-encoding": "br"
          }
        });
        const ranged = await rawHttpGet(baseUrl, "/assets/index-a1b2c3d4.js", {
          "x-forwarded-host": "abc123.w33d.xyz",
          "accept-encoding": "br",
          range: "bytes=0-6"
        });

        expect(brotli.status).toBe(200);
        expect(brotli.headers["content-encoding"]).toBe("br");
        expect(brotli.headers.vary).toBe("accept-encoding");
        expect(brotli.body).toEqual(brotliCompressSync(Buffer.from(script)));
        expect(cachedBrotli.status).toBe(304);
        expect(cachedBrotli.headers["content-encoding"]).toBe("br");
        expect(cachedBrotli.headers.vary).toBe("accept-encoding");
        expect(cachedBrotli.headers.etag).toBe(brotli.headers.etag);
        expect(cachedBrotli.body.byteLength).toBe(0);
        expect(gzip.status).toBe(200);
        expect(gzip.headers["content-encoding"]).toBe("gzip");
        expect(gzip.body).toEqual(gzipSync(Buffer.from(script)));
        expect(gzipPreferred.status).toBe(200);
        expect(gzipPreferred.headers["content-encoding"]).toBe("gzip");
        expect(gzipPreferred.body).toEqual(gzipSync(Buffer.from(script)));
        expect(brotliDisabled.status).toBe(200);
        expect(brotliDisabled.headers["content-encoding"]).toBe("gzip");
        expect(brotliDisabled.body).toEqual(gzipSync(Buffer.from(script)));
        expect(wildcard.status).toBe(200);
        expect(wildcard.headers["content-encoding"]).toBe("br");
        expect(wildcard.body).toEqual(brotliCompressSync(Buffer.from(script)));
        expect(wildcardWithBrotliRefusal.status).toBe(200);
        expect(wildcardWithBrotliRefusal.headers["content-encoding"]).toBe("gzip");
        expect(wildcardWithBrotliRefusal.body).toEqual(gzipSync(Buffer.from(script)));
        expect(brotliHead.status).toBe(200);
        expect(brotliHead.headers.get("content-encoding")).toBe("br");
        expect(brotliHead.headers.get("content-length")).toBe(String(brotliCompressSync(Buffer.from(script)).byteLength));
        expect(brotliHead.headers.get("vary")).toBe("accept-encoding");
        expect(await brotliHead.text()).toBe("");
        expect(ranged.status).toBe(206);
        expect(ranged.headers["content-encoding"]).toBeUndefined();
        expect(ranged.headers["content-range"]).toBe(`bytes 0-6/${Buffer.byteLength(script)}`);
        expect(ranged.body.toString("utf8")).toBe("console");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("applies clean URL and trailing slash canonical redirects for static artifacts", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-clean-urls-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Home</h1>");
      await writeFile(path.join(artifactRoot, "about.html"), "<h1>About</h1>");
      await mkdir(path.join(artifactRoot, "docs"), { recursive: true });
      await writeFile(path.join(artifactRoot, "docs", "index.html"), "<h1>Docs</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_clean",
                artifactRoot,
                entrypoint: "index.html",
                cleanUrls: true,
                trailingSlash: false
              }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const clean = await fetch(`${baseUrl}/about`, {
          headers: { "x-forwarded-host": "abc123.w33d.xyz" }
        });
        const cleanBody = await clean.text();
        const htmlExtension = await fetch(`${baseUrl}/about.html`, {
          redirect: "manual",
          headers: { "x-forwarded-host": "abc123.w33d.xyz" }
        });
        const slash = await fetch(`${baseUrl}/docs/?ref=dashboard&debug=true`, {
          redirect: "manual",
          headers: { "x-forwarded-host": "abc123.w33d.xyz" }
        });

        expect(clean.status).toBe(200);
        expect(cleanBody).toContain("About");
        expect(htmlExtension.status).toBe(308);
        expect(htmlExtension.headers.get("location")).toBe("/about");
        expect(htmlExtension.headers.get("x-siteflow-static-redirect")).toBe("canonical");
        expect(slash.status).toBe(308);
        expect(slash.headers.get("location")).toBe("/docs?ref=dashboard&debug=true");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("skips trailing slash canonical redirects when configured", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-skip-slash-redirect-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Home</h1>");
      await mkdir(path.join(artifactRoot, "docs"), { recursive: true });
      await writeFile(path.join(artifactRoot, "docs", "index.html"), "<h1>Docs</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_skip_slash",
                artifactRoot,
                entrypoint: "index.html",
                trailingSlash: false,
                skipTrailingSlashRedirect: true
              }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const slash = await fetch(`${baseUrl}/docs/`, {
          redirect: "manual",
          headers: { "x-forwarded-host": "abc123.w33d.xyz" }
        });
        const body = await slash.text();

        expect(slash.status).toBe(200);
        expect(slash.headers.get("x-siteflow-static-redirect")).toBeNull();
        expect(body).toContain("Docs");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("serves optimized image responses from artifact and blob sources", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-image-opt-"));
    const imageBytes = Buffer.from("png-fixture");
    const blobBytes = Buffer.from("webp-fixture");

    try {
      await mkdir(path.join(artifactRoot, "assets"), { recursive: true });
      await writeFile(path.join(artifactRoot, "assets", "hero.png"), imageBytes);
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_prebuilt",
                artifactRoot,
                entrypoint: "index.html",
                images: {
                  sizes: [320, 640],
                  qualities: [75, 80],
                  formats: ["image/webp"],
                  minimumCacheTTL: 120,
                  contentDispositionType: "inline"
                }
              }
            : undefined,
        getBlob: async (command: GetBlobCommand): Promise<BlobReadModel> => ({
          projectId: command.projectId,
          blob: {
            id: "blob_hero",
            projectId: command.projectId,
            pathname: command.pathname,
            access: "public",
            contentType: "image/webp",
            size: blobBytes.length,
            sha256: "sha256:blob-hero",
            etag: "\"blob-hero\"",
            url: `/api/projects/${command.projectId}/blobs/${encodeURIComponent(command.pathname)}`,
            uploadedAt: "2026-05-27T00:00:00.000Z",
            updatedAt: "2026-05-27T00:00:00.000Z"
          },
          contentBase64: blobBytes.toString("base64")
        })
      };

      await withServer(repository, async (baseUrl) => {
        const artifactUrl = `${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/hero.png")}&w=320&q=80&format=webp`;
        const artifactResponse = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz, proxy.internal"
          }
        });
        const repeatResponse = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const artifactHead = await fetch(artifactUrl, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const artifactEtag = artifactResponse.headers.get("etag");
        const artifactLastModified = artifactResponse.headers.get("last-modified");
        const cachedArtifact = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": artifactEtag ?? ""
          }
        });
        const cachedByWeakArtifactEtag = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": `W/${artifactEtag ?? "\"missing\""}`
          }
        });
        const cachedByAnyArtifactEtag = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": `"old-image", ${artifactEtag ?? "\"missing\""}`
          }
        });
        const cachedByWildcardArtifactEtag = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": "*"
          }
        });
        const cachedByModifiedTime = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-modified-since": artifactLastModified ?? ""
          }
        });
        const invalidModifiedTime = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-modified-since": "not-a-date"
          }
        });
        const staleWhenImageEtagDisagrees = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": '"different-image"',
            "if-modified-since": artifactLastModified ?? ""
          }
        });
        const failedImagePrecondition = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": '"different-image"'
          }
        });
        const weakImagePrecondition = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": `W/${artifactEtag ?? "\"missing\""}`
          }
        });
        const failedImagePreconditionWithMatchingCache = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": '"different-image"',
            "if-none-match": artifactEtag ?? ""
          }
        });
        const multiValueImagePrecondition = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": `"old-image", ${artifactEtag ?? "\"missing\""}`
          }
        });
        const multiValueWeakOnlyImagePrecondition = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": `"old-image", W/${artifactEtag ?? "\"missing\""}`
          }
        });
        const staleImagePrecondition = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT"
          }
        });
        const invalidImagePreconditionDate = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-unmodified-since": "not-a-date"
          }
        });
        const imagePreconditionDateIgnoredWhenIfMatchPresent = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": artifactEtag ?? "",
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT"
          }
        });
        const wildcardImagePrecondition = await fetch(artifactUrl, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-match": "*"
          }
        });
        const cachedArtifactHead = await fetch(artifactUrl, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": artifactEtag ?? ""
          }
        });
        const failedImagePreconditionHead = await fetch(artifactUrl, {
          method: "HEAD",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT"
          }
        });
        const artifactBody = Buffer.from(await artifactResponse.arrayBuffer());

        expect(artifactResponse.status).toBe(200);
        expect(artifactBody.equals(imageBytes)).toBe(true);
        expect(artifactResponse.headers.get("content-type")).toBe("image/webp");
        expect(artifactResponse.headers.get("cache-control")).toBe("public, max-age=120");
        expect(artifactEtag).toMatch(/^"img-/);
        expect(artifactLastModified).toBeTruthy();
        expect(artifactResponse.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(artifactResponse.headers.get("content-disposition")).toBe('inline; filename="image"');
        expect(artifactResponse.headers.get("x-siteflow-image-width")).toBe("320");
        expect(artifactResponse.headers.get("x-siteflow-image-quality")).toBe("80");
        expect(artifactResponse.headers.get("x-siteflow-image-format")).toBe("webp");
        expect(artifactResponse.headers.get("x-siteflow-image-source")).toBe("artifact");
        expect(artifactResponse.headers.get("x-siteflow-image-cache-key")).toBe(repeatResponse.headers.get("x-siteflow-image-cache-key"));
        expect(artifactHead.status).toBe(200);
        expect(artifactHead.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(await artifactHead.text()).toBe("");
        expect(cachedArtifact.status).toBe(304);
        expect(cachedArtifact.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(cachedArtifact.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toEqual(expect.arrayContaining(["accept", "origin"]));
        expect(cachedArtifact.headers.get("etag")).toBe(artifactEtag);
        expect(cachedArtifact.headers.get("cache-control")).toBe("public, max-age=120");
        expect(cachedArtifact.headers.get("content-length")).toBeNull();
        expect(await cachedArtifact.text()).toBe("");
        expect(cachedByWeakArtifactEtag.status).toBe(304);
        expect(cachedByWeakArtifactEtag.headers.get("content-length")).toBeNull();
        expect(await cachedByWeakArtifactEtag.text()).toBe("");
        expect(cachedByAnyArtifactEtag.status).toBe(304);
        expect(cachedByAnyArtifactEtag.headers.get("content-length")).toBeNull();
        expect(await cachedByAnyArtifactEtag.text()).toBe("");
        expect(cachedByWildcardArtifactEtag.status).toBe(304);
        expect(cachedByWildcardArtifactEtag.headers.get("content-length")).toBeNull();
        expect(await cachedByWildcardArtifactEtag.text()).toBe("");
        expect(cachedByModifiedTime.status).toBe(304);
        expect(cachedByModifiedTime.headers.get("last-modified")).toBe(artifactLastModified);
        expect(cachedByModifiedTime.headers.get("content-length")).toBeNull();
        expect(await cachedByModifiedTime.text()).toBe("");
        expect(invalidModifiedTime.status).toBe(200);
        expect(invalidModifiedTime.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(await invalidModifiedTime.text()).toBe(imageBytes.toString("utf8"));
        expect(staleWhenImageEtagDisagrees.status).toBe(200);
        expect(staleWhenImageEtagDisagrees.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(await staleWhenImageEtagDisagrees.text()).toBe(imageBytes.toString("utf8"));
        expect(failedImagePrecondition.status).toBe(412);
        expect(failedImagePrecondition.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(failedImagePrecondition.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toEqual(expect.arrayContaining(["accept", "origin"]));
        expect(failedImagePrecondition.headers.get("etag")).toBe(artifactEtag);
        expect(failedImagePrecondition.headers.get("content-length")).toBeNull();
        expect(await failedImagePrecondition.text()).toBe("");
        expect(weakImagePrecondition.status).toBe(412);
        expect(weakImagePrecondition.headers.get("content-length")).toBeNull();
        expect(await weakImagePrecondition.text()).toBe("");
        expect(failedImagePreconditionWithMatchingCache.status).toBe(412);
        expect(failedImagePreconditionWithMatchingCache.headers.get("content-length")).toBeNull();
        expect(await failedImagePreconditionWithMatchingCache.text()).toBe("");
        expect(multiValueImagePrecondition.status).toBe(200);
        expect(multiValueImagePrecondition.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(await multiValueImagePrecondition.text()).toBe(imageBytes.toString("utf8"));
        expect(multiValueWeakOnlyImagePrecondition.status).toBe(412);
        expect(multiValueWeakOnlyImagePrecondition.headers.get("content-length")).toBeNull();
        expect(await multiValueWeakOnlyImagePrecondition.text()).toBe("");
        expect(staleImagePrecondition.status).toBe(412);
        expect(staleImagePrecondition.headers.get("content-length")).toBeNull();
        expect(await staleImagePrecondition.text()).toBe("");
        expect(invalidImagePreconditionDate.status).toBe(200);
        expect(invalidImagePreconditionDate.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(await invalidImagePreconditionDate.text()).toBe(imageBytes.toString("utf8"));
        expect(imagePreconditionDateIgnoredWhenIfMatchPresent.status).toBe(200);
        expect(imagePreconditionDateIgnoredWhenIfMatchPresent.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(await imagePreconditionDateIgnoredWhenIfMatchPresent.text()).toBe(imageBytes.toString("utf8"));
        expect(wildcardImagePrecondition.status).toBe(200);
        expect(wildcardImagePrecondition.headers.get("content-length")).toBe(String(imageBytes.byteLength));
        expect(await wildcardImagePrecondition.text()).toBe(imageBytes.toString("utf8"));
        expect(cachedArtifactHead.status).toBe(304);
        expect(cachedArtifactHead.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(cachedArtifactHead.headers.get("etag")).toBe(artifactEtag);
        expect(cachedArtifactHead.headers.get("content-length")).toBeNull();
        expect(await cachedArtifactHead.text()).toBe("");
        expect(failedImagePreconditionHead.status).toBe(412);
        expect(failedImagePreconditionHead.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(failedImagePreconditionHead.headers.get("etag")).toBe(artifactEtag);
        expect(failedImagePreconditionHead.headers.get("content-length")).toBeNull();
        expect(await failedImagePreconditionHead.text()).toBe("");

        const blobResponse = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("blob:assets/blob-hero.webp")}&w=640`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const blobLastModified = blobResponse.headers.get("last-modified");
        const cachedBlobByModifiedTime = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("blob:assets/blob-hero.webp")}&w=640`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-modified-since": blobLastModified ?? ""
          }
        });
        const staleBlobPrecondition = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("blob:assets/blob-hero.webp")}&w=640`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT"
          }
        });
        const blobBody = Buffer.from(await blobResponse.arrayBuffer());

        expect(blobResponse.status).toBe(200);
        expect(blobBody.equals(blobBytes)).toBe(true);
        expect(blobResponse.headers.get("content-type")).toBe("image/webp");
        expect(blobLastModified).toBe(new Date("2026-05-27T00:00:00.000Z").toUTCString());
        expect(blobResponse.headers.get("x-siteflow-image-source")).toBe("blob");
        expect(blobResponse.headers.get("x-siteflow-image-quality")).toBe("75");
        expect(cachedBlobByModifiedTime.status).toBe(304);
        expect(cachedBlobByModifiedTime.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(cachedBlobByModifiedTime.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toEqual(expect.arrayContaining(["accept", "origin"]));
        expect(cachedBlobByModifiedTime.headers.get("last-modified")).toBe(blobLastModified);
        expect(cachedBlobByModifiedTime.headers.get("content-length")).toBeNull();
        expect(await cachedBlobByModifiedTime.text()).toBe("");
        expect(staleBlobPrecondition.status).toBe(412);
        expect(staleBlobPrecondition.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
        expect(staleBlobPrecondition.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase())).toEqual(expect.arrayContaining(["accept", "origin"]));
        expect(staleBlobPrecondition.headers.get("last-modified")).toBe(blobLastModified);
        expect(staleBlobPrecondition.headers.get("content-length")).toBeNull();
        expect(await staleBlobPrecondition.text()).toBe("");
        for (const response of [artifactResponse, artifactHead, blobResponse]) {
          expect(response.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
          const varyHeaders = response.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase());
          expect(varyHeaders).toContain("accept");
          expect(varyHeaders).toContain("origin");
          const exposedHeaders = response.headers.get("access-control-expose-headers")?.split(",").map((header) => header.trim());
          expect(exposedHeaders).toContain("content-disposition");
          expect(exposedHeaders).toContain("x-siteflow-image-cache-key");
          expect(exposedHeaders).toContain("x-siteflow-image-width");
          expect(exposedHeaders).toContain("x-siteflow-image-quality");
          expect(exposedHeaders).toContain("x-siteflow-image-format");
          expect(exposedHeaders).toContain("x-siteflow-image-source");
        }
      }, { allowedOrigin: "https://console.example.test" });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("enforces artifact image optimization metadata from vercel.json", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-image-config-"));

    try {
      await mkdir(path.join(artifactRoot, "assets"), { recursive: true });
      await writeFile(path.join(artifactRoot, "assets", "hero.png"), "png-fixture");
      await writeFile(path.join(artifactRoot, "assets", "icon.svg"), "<svg></svg>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_prebuilt",
                artifactRoot,
                entrypoint: "index.html",
                images: {
                  sizes: [320],
                  qualities: [80],
                  formats: ["image/webp"],
                  dangerouslyAllowSVG: false,
                  contentSecurityPolicy: "script-src 'none'; sandbox;"
                }
              }
            : host === "svg123.w33d.xyz"
              ? {
                  host,
                  projectId: "project-acme-dashboard",
                  deploymentId: "dep_svg_images",
                  artifactRoot,
                  entrypoint: "index.html",
                  images: {
                    sizes: [320],
                    qualities: [80],
                    formats: ["image/webp"],
                    dangerouslyAllowSVG: true,
                    contentDispositionType: "inline",
                    contentSecurityPolicy: "default-src 'none'; img-src 'self'; sandbox;"
                  }
                }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const headers = {
          "x-forwarded-host": "abc123.w33d.xyz"
        };
        const badWidth = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/hero.png")}&w=640&q=80&format=webp`, { headers });
        const badQuality = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/hero.png")}&w=320&q=70&format=webp`, { headers });
        const badFormat = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/hero.png")}&w=320&q=80&format=avif`, { headers });
        const svg = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/icon.svg")}&w=320&q=80&format=webp`, { headers });
        const valid = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/hero.png")}&w=320&q=80&format=webp`, { headers });
        const allowedSvg = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/icon.svg")}&w=320&q=80`, {
          headers: {
            "x-forwarded-host": "svg123.w33d.xyz"
          }
        });

        expect(badWidth.status).toBe(400);
        expect(await badWidth.json()).toMatchObject({ message: "Image parameter w must be one of: 320." });
        expect(badQuality.status).toBe(400);
        expect(await badQuality.json()).toMatchObject({ message: "Image parameter q must be one of: 80." });
        expect(badFormat.status).toBe(400);
        expect(await badFormat.json()).toMatchObject({ message: "Image parameter format must be one of: webp." });
        expect(svg.status).toBe(400);
        expect(await svg.json()).toMatchObject({ message: "SVG image optimization requires images.dangerouslyAllowSVG." });
        expect(valid.status).toBe(200);
        expect(valid.headers.get("content-security-policy")).toBe("script-src 'none'; sandbox;");
        expect(allowedSvg.status).toBe(200);
        expect(allowedSvg.headers.get("content-type")).toBe("image/svg+xml");
        expect(allowedSvg.headers.get("content-disposition")).toBe('inline; filename="image"');
        expect(allowedSvg.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'; sandbox;");
        expect(await allowedSvg.text()).toBe("<svg></svg>");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe image optimization parameters", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-image-invalid-"));

    try {
      await mkdir(path.join(artifactRoot, "assets"), { recursive: true });
      await writeFile(path.join(artifactRoot, "assets", "hero.png"), "png-fixture");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_prebuilt",
                artifactRoot,
                entrypoint: "index.html"
              }
            : undefined
      };

      await withServer(repository, async (baseUrl) => {
        const external = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("https://example.com/a.png")}&w=320`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const badWidth = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/hero.png")}&w=4`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const secretUrl = await fetch(`${baseUrl}/_siteflow/image?url=${encodeURIComponent("/assets/hero.png?token=secret")}&w=320`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const headBadWidth = await rawHttpGet(
          baseUrl,
          `/_siteflow/image?url=${encodeURIComponent("/assets/hero.png")}&w=4`,
          {
            "x-forwarded-host": "abc123.w33d.xyz"
          },
          "HEAD"
        );

        expect(external.status).toBe(400);
        expect(await external.json()).toMatchObject({
          message: "External image sources are not supported."
        });
        expect(badWidth.status).toBe(400);
        expect(await badWidth.json()).toMatchObject({
          message: "Image parameter w must be an integer from 16 to 3840."
        });
        expect(secretUrl.status).toBe(400);
        expect(await secretUrl.json()).toMatchObject({
          message: "Image source URL must not include secret-bearing query parameters."
        });
        expect(headBadWidth.status).toBe(400);
        expect(headBadWidth.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(headBadWidth.headers["content-length"]).toBeUndefined();
        expect(headBadWidth.body.byteLength).toBe(0);
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("applies firewall decisions before static artifact routing", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-firewall-static-"));
    const matchedRule: FirewallRule = {
      id: "fw_block_admin",
      projectId: "project-acme-dashboard",
      name: "Block admin paths",
      action: "block",
      priority: 1,
      status: "active",
      conditions: {
        pathPattern: "/admin/*"
      },
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    };
    const evaluations: Array<{ path: string; ip?: string; userAgent?: string; header?: string }> = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>SiteFlow Preview</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_prebuilt",
                artifactRoot,
                entrypoint: "index.html"
              }
            : undefined,
        evaluateFirewall: async (command): Promise<FirewallEvaluationReadModel> => {
          evaluations.push({
            path: command.path,
            ip: command.ip,
            userAgent: command.userAgent,
            header: command.headers["x-plan"]
          });

          return {
            projectId: command.projectId,
            decision: command.path.startsWith("/admin") ? "block" : "allow",
            matchedRule: command.path.startsWith("/admin") ? matchedRule : undefined,
            reason: command.path.startsWith("/admin") ? "Matched admin path." : "No firewall rule matched."
          };
        }
      };

      await withServer(repository, async (baseUrl) => {
        const blocked = await fetch(`${baseUrl}/admin/settings`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz",
            "x-forwarded-for": "203.0.113.10",
            "x-plan": "free",
            "user-agent": "curl/8.0"
          }
        });
        const blockedBody = await blocked.json();

        expect(blocked.status).toBe(403);
        expect(blocked.headers.get("x-siteflow-firewall")).toBe("fw_block_admin");
        expect(blockedBody).toEqual({
          message: "Request blocked by SiteFlow firewall.",
          ruleId: "fw_block_admin"
        });

        const allowed = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const allowedBody = await allowed.text();

        expect(allowed.status).toBe(200);
        expect(allowedBody).toContain("SiteFlow Preview");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(evaluations[0]).toMatchObject({
      path: "/admin/settings",
      ip: "203.0.113.10",
      userAgent: "curl/8.0",
      header: "free"
    });
    expect(evaluations[1]).toMatchObject({
      path: "/"
    });
  });

  it("omits JSON bodies for HEAD firewall rejections", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-firewall-head-"));
    const blockRule: FirewallRule = {
      id: "fw_block_admin",
      projectId: "project-acme-dashboard",
      name: "Block admin paths",
      action: "block",
      priority: 1,
      status: "active",
      conditions: {
        pathPattern: "/admin/*"
      },
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    };
    const challengeRule: FirewallRule = {
      id: "fw_challenge_api",
      projectId: "project-acme-dashboard",
      name: "Challenge API paths",
      action: "challenge",
      priority: 2,
      status: "active",
      conditions: {
        pathPattern: "/api/*"
      },
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    };

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>SiteFlow Preview</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_firewall_head",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/revalidate",
                    sourcePath: ".siteflow/functions/api/revalidate.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        evaluateFirewall: async (command): Promise<FirewallEvaluationReadModel> => {
          if (command.path.startsWith("/admin")) {
            return {
              projectId: command.projectId,
              decision: "block",
              matchedRule: blockRule,
              reason: "Matched admin path."
            };
          }

          return {
            projectId: command.projectId,
            decision: "challenge",
            matchedRule: challengeRule,
            reason: "Challenge API path."
          };
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const blocked = await rawHttpGet(baseUrl, "/admin/settings", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");
          const challenged = await rawHttpGet(baseUrl, "/api/revalidate", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");

          expect(blocked.status).toBe(403);
          expect(blocked.headers["x-siteflow-firewall"]).toBe("fw_block_admin");
          expect(blocked.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(blocked.headers["content-length"]).toBeUndefined();
          expect(blocked.body.byteLength).toBe(0);
          expect(challenged.status).toBe(403);
          expect(challenged.headers["x-siteflow-firewall"]).toBe("fw_challenge_api");
          expect(challenged.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(challenged.headers["content-length"]).toBeUndefined();
          expect(challenged.body.byteLength).toBe(0);
        },
        {
          functionModuleLoader: async () => {
            throw new Error("Firewall challenge should prevent function loading.");
          }
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("applies routing redirects, rewrites, and headers before artifact responses", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-routing-rules-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Home</h1>");
      await mkdir(path.join(artifactRoot, "posts"), { recursive: true });
      await writeFile(path.join(artifactRoot, "posts", "hello.html"), "<h1>Hello post</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_prebuilt",
                artifactRoot,
                entrypoint: "index.html"
              }
            : undefined,
        matchRoutingRules: async (command) =>
          command.path === "/docs"
            ? {
                projectId: command.projectId,
                path: command.path,
                redirect: {
                  id: "route_docs",
                  projectId: command.projectId,
                  name: "Docs redirect",
                  kind: "redirect",
                  source: "/docs",
                  destination: "/documentation?target=docs#overview",
                  statusCode: 308,
                  priority: 10,
                  status: "active",
                  createdAt: "2026-05-27T00:00:00.000Z",
                  updatedAt: "2026-05-27T00:00:00.000Z"
                },
                headers: [],
                updatedAt: "2026-05-27T00:00:00.000Z"
              }
            : fixtureRepository().matchRoutingRules(command)
      };

      await withServer(repository, async (baseUrl) => {
        const redirected = await fetch(`${baseUrl}/docs?from=preview`, {
          redirect: "manual",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });

        expect(redirected.status).toBe(308);
        expect(redirected.headers.get("location")).toBe("/documentation?target=docs&from=preview#overview");
        expect(redirected.headers.get("x-siteflow-redirect")).toBe("route_docs");

        const rewritten = await fetch(`${baseUrl}/blog/hello.html`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const body = await rewritten.text();

        expect(rewritten.status).toBe(200);
        expect(rewritten.headers.get("x-siteflow-rewrite")).toBe("route_blog");
        expect(rewritten.headers.get("x-frame-options")).toBe("DENY");
        expect(body).toContain("Hello post");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("applies artifact-local routing metadata before artifact responses", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-routing-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Home</h1>");
      await mkdir(path.join(artifactRoot, "posts"), { recursive: true });
      await writeFile(path.join(artifactRoot, "posts", "hello.html"), "<h1>Hello from artifact metadata</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_source",
                artifactRoot,
                entrypoint: "index.html",
                routingRules: {
                  redirects: [
                    {
                      id: "artifact_redirect_docs",
                      projectId: "project-acme-dashboard",
                      name: "Docs redirect",
                      kind: "redirect",
                      source: "/docs",
                      destination: "/documentation?target=artifact#overview",
                      statusCode: 308,
                      priority: 100,
                      status: "active",
                      createdAt: "2026-05-27T00:00:00.000Z",
                      updatedAt: "2026-05-27T00:00:00.000Z"
                    }
                  ],
                  rewrites: [
                    {
                      id: "artifact_rewrite_blog",
                      projectId: "project-acme-dashboard",
                      name: "Blog rewrite",
                      kind: "rewrite",
                      source: "/blog/:slug",
                      destination: "/posts/:slug.html",
                      priority: 100,
                      status: "active",
                      createdAt: "2026-05-27T00:00:00.000Z",
                      updatedAt: "2026-05-27T00:00:00.000Z"
                    }
                  ],
                  headers: [
                    {
                      id: "artifact_header_all",
                      projectId: "project-acme-dashboard",
                      name: "Artifact headers",
                      kind: "header",
                      source: "/(.*)",
                      headers: [
                        { key: "x-artifact-route", value: "source" },
                        { key: "referrer-policy", value: "no-referrer" },
                        { key: "Vary", value: "x-siteflow-locale, Accept-Encoding" }
                      ],
                      priority: 100,
                      status: "active",
                      createdAt: "2026-05-27T00:00:00.000Z",
                      updatedAt: "2026-05-27T00:00:00.000Z"
                    }
                  ]
                }
              }
            : undefined,
        matchRoutingRules: async () => ({
          projectId: "project-acme-dashboard",
          path: "/",
          headers: [],
          updatedAt: "2026-05-27T00:00:00.000Z"
        })
      };

      await withServer(repository, async (baseUrl) => {
        const redirected = await fetch(`${baseUrl}/docs?from=artifact`, {
          redirect: "manual",
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });

        expect(redirected.status).toBe(308);
        expect(redirected.headers.get("location")).toBe("/documentation?target=artifact&from=artifact#overview");
        expect(redirected.headers.get("x-siteflow-redirect")).toBe("artifact_redirect_docs");

        const rewritten = await fetch(`${baseUrl}/blog/hello`, {
          headers: {
            "x-forwarded-host": "abc123.w33d.xyz"
          }
        });
        const body = await rewritten.text();

        expect(rewritten.status).toBe(200);
        expect(rewritten.headers.get("x-siteflow-rewrite")).toBe("artifact_rewrite_blog");
        expect(rewritten.headers.get("x-artifact-route")).toBe("source");
        expect(rewritten.headers.get("x-content-type-options")).toBe("nosniff");
        expect(rewritten.headers.get("referrer-policy")).toBe("no-referrer");
        expect(rewritten.headers.get("vary")?.toLowerCase().split(",").map((value) => value.trim()).sort()).toEqual([
          "accept-encoding",
          "x-siteflow-locale"
        ]);
        expect(body).toContain("Hello from artifact metadata");
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("returns firewall challenges before function invocation", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-firewall-function-"));
    const matchedRule: FirewallRule = {
      id: "fw_challenge_api",
      projectId: "project-acme-dashboard",
      name: "Challenge API paths",
      action: "challenge",
      priority: 1,
      status: "active",
      conditions: {
        pathPattern: "/api/*"
      },
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    };
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project-acme-dashboard",
                deploymentId: "dep_function",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/revalidate",
                    sourcePath: ".siteflow/functions/api/revalidate.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        evaluateFirewall: async (command): Promise<FirewallEvaluationReadModel> => ({
          projectId: command.projectId,
          decision: "challenge",
          matchedRule,
          reason: "Challenge API path."
        }),
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/revalidate`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            body: JSON.stringify({ name: "home" })
          });
          const body = await response.json();

          expect(response.status).toBe(403);
          expect(response.headers.get("x-siteflow-firewall")).toBe("fw_challenge_api");
          expect(body).toEqual({
            message: "Request requires a SiteFlow firewall challenge.",
            ruleId: "fw_challenge_api"
          });
        },
        {
          functionModuleLoader: async () => {
            throw new Error("Firewall challenge should prevent function loading.");
          }
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(invocations).toHaveLength(0);
  });

  it("routes deployed API functions and records invocation logs", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      await mkdir(path.join(artifactRoot, ".siteflow", "functions", "api"), { recursive: true });
      await writeFile(path.join(artifactRoot, ".siteflow", "functions", "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        path.join(artifactRoot, ".siteflow", "functions", "api", "revalidate.js"),
        [
          "export default async function handler(request, context) {",
          "  console.log('runtime SITEFLOW_SECRET_CANARY_20260515');",
          "  const body = await request.json();",
          "  return {",
          "    status: 202,",
          "    headers: { 'x-runtime-deployment': context.deploymentId },",
          "    body: { ok: true, method: request.method, name: body.name, requestId: context.requestId }",
          "  };",
          "}"
        ].join("\n")
      );

      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/revalidate",
                    sourcePath: ".siteflow/functions/api/revalidate.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/revalidate`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-host": "abc123.w33d.xyz, proxy.internal",
              "x-forwarded-proto": "https, http"
            },
            body: JSON.stringify({ name: "home" })
          });
          const body = await response.json() as { ok: boolean; method: string; name: string; requestId: string; origin: string };
          const rawResponse = await rawHttpGet(
            baseUrl,
            "/api/revalidate",
            {
              "content-type": "application/json",
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            "POST",
            JSON.stringify({ name: "raw" })
          );

          expect(response.status).toBe(202);
          expect(response.headers.get("x-siteflow-deployment")).toBe("dep_function");
          expect(response.headers.get("x-siteflow-function")).toBe("/api/revalidate");
          expect(response.headers.get("x-runtime-deployment")).toBe("dep_function");
          expect(response.headers.get("access-control-allow-origin")).toBe("https://console.example.test");
          const allowHeaders = response.headers.get("access-control-allow-headers")?.split(",").map((header) => header.trim());
          const allowMethods = response.headers.get("access-control-allow-methods")?.split(",").map((method) => method.trim());
          expect(allowHeaders).toContain("x-runtime-request-id");
          expect(allowHeaders).toContain("authorization");
          expect(allowMethods).toContain("TRACE");
          expect(allowMethods).toContain("POST");
          const varyHeaders = response.headers.get("vary")?.split(",").map((header) => header.trim().toLowerCase());
          expect(varyHeaders).toContain("accept-language");
          expect(varyHeaders).toContain("origin");
          const exposedHeaders = response.headers.get("access-control-expose-headers")?.split(",").map((header) => header.trim());
          expect(exposedHeaders).toContain("x-runtime-cache");
          expect(exposedHeaders).toContain("x-siteflow-deployment");
          expect(exposedHeaders).toContain("x-siteflow-function");
          expect(exposedHeaders).toContain("x-siteflow-request-id");
          expect(body).toMatchObject({ ok: true, method: "POST", name: "home" });
          expect(body.origin).toBe("https://abc123.w33d.xyz");
          expect(body.requestId).toMatch(/^req_/);
          expect(rawResponse.status).toBe(202);
          expect(rawHeaderValues(rawResponse.rawHeaders, "set-cookie")).toEqual(["sf_session=primary; Path=/; HttpOnly", "sf_preview=enabled; Path=/"]);
          expect(invocations).toHaveLength(2);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_function",
            projectId: "project_docs",
            path: "/api/revalidate",
            method: "POST",
            status: "succeeded",
            responseStatus: 202,
            requestId: body.requestId
          });
          expect(invocations[0]?.errorMessage).toBeUndefined();
          expect(invocations[0].logs.join("\n")).toContain("[REDACTED]");
          expect(invocations[0].logs.join("\n")).not.toContain("SITEFLOW_SECRET_CANARY_20260515");
        },
        {
          functionModuleLoader: async (functionPath) => {
            expect(functionPath).toBe(path.join(artifactRoot, ".siteflow", "functions", "api", "revalidate.js"));

            return {
              default: async (request: Request, context: { deploymentId: string; requestId: string }) => {
                console.log("runtime SITEFLOW_SECRET_CANARY_20260515");
                const body = await request.json() as { name: string };
                const requestUrl = new URL(request.url);

                return {
                  status: 202,
                  headers: {
                    "x-runtime-deployment": context.deploymentId,
                    "access-control-allow-headers": "x-runtime-request-id",
                    "access-control-allow-methods": "TRACE",
                    "access-control-expose-headers": "x-runtime-cache",
                    "set-cookie": ["sf_session=primary; Path=/; HttpOnly", "sf_preview=enabled; Path=/"],
                    vary: "accept-language"
                  },
                  body: { ok: true, method: request.method, name: body.name, requestId: context.requestId, origin: requestUrl.origin }
                };
              }
            };
          },
          allowedOrigin: "https://console.example.test"
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("omits JSON bodies for HEAD function route errors", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-head-errors-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_function_head_errors",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/revalidate",
                    sourcePath: ".siteflow/functions/api/revalidate.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    methods: ["GET"]
                  }
                ]
              }
            : undefined
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const missing = await rawHttpGet(baseUrl, "/api/missing", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");
          const methodNotAllowed = await rawHttpGet(baseUrl, "/api/revalidate", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");

          expect(missing.status).toBe(404);
          expect(missing.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(missing.headers["content-length"]).toBeUndefined();
          expect(missing.body.byteLength).toBe(0);
          expect(methodNotAllowed.status).toBe(405);
          expect(methodNotAllowed.headers.allow).toBe("GET");
          expect(methodNotAllowed.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(methodNotAllowed.headers["content-length"]).toBeUndefined();
          expect(methodNotAllowed.body.byteLength).toBe(0);
        },
        {
          functionModuleLoader: async () => {
            throw new Error("Function HEAD route errors should not load function modules.");
          }
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("omits bodies for successful HEAD function invocations while recording logs", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-head-success-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_head_success",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/status",
                    sourcePath: ".siteflow/functions/api/status.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await rawHttpGet(baseUrl, "/api/status", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");

          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(response.headers["x-runtime-head"]).toBe("ok");
          expect(response.headers["x-siteflow-deployment"]).toBe("dep_function_head_success");
          expect(response.headers["x-siteflow-function"]).toBe("/api/status");
          expect(response.headers["x-siteflow-request-id"]).toMatch(/^req_/);
          expect(response.headers["content-length"]).toBeUndefined();
          expect(response.body.byteLength).toBe(0);
          expect(invocations).toHaveLength(1);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_function_head_success",
            projectId: "project_docs",
            path: "/api/status",
            method: "HEAD",
            status: "succeeded",
            responseStatus: 200,
            requestId: response.headers["x-siteflow-request-id"]
          });
          expect(invocations[0]?.errorMessage).toBeUndefined();
        },
        {
          functionModuleLoader: async () => ({
            default: async (request: Request, context: { requestId: string }) => ({
              status: 200,
              headers: { "x-runtime-head": "ok" },
              body: { ok: true, method: request.method, requestId: context.requestId }
            })
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("preserves multiple Set-Cookie headers from Web Response function results", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-response-cookies-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_response_cookies",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/session",
                    sourcePath: ".siteflow/functions/api/session.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await rawHttpGet(baseUrl, "/api/session", {
            "x-forwarded-host": "abc123.w33d.xyz"
          });

          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json");
          expect(rawHeaderValues(response.rawHeaders, "set-cookie")).toEqual(["sf_session=response; Path=/; HttpOnly", "sf_theme=dark; Path=/"]);
          expect(response.headers["x-siteflow-deployment"]).toBe("dep_function_response_cookies");
          expect(response.headers["x-siteflow-function"]).toBe("/api/session");
          expect(invocations).toHaveLength(1);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_function_response_cookies",
            projectId: "project_docs",
            path: "/api/session",
            method: "GET",
            status: "succeeded",
            responseStatus: 200,
            requestId: response.headers["x-siteflow-request-id"]
          });
        },
        {
          functionModuleLoader: async () => ({
            default: async () => {
              const headers = new Headers({ "content-type": "application/json" });
              headers.append("set-cookie", "sf_session=response; Path=/; HttpOnly");
              headers.append("set-cookie", "sf_theme=dark; Path=/");

              return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
            }
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("preserves metadata for successful no-content function responses", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-no-content-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_no_content",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/revalidate",
                    sourcePath: ".siteflow/functions/api/revalidate.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await rawHttpGet(baseUrl, "/api/revalidate", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "POST");

          expect(response.status).toBe(204);
          expect(response.headers["x-runtime-revalidated"]).toBe("true");
          expect(response.headers["x-siteflow-deployment"]).toBe("dep_function_no_content");
          expect(response.headers["x-siteflow-function"]).toBe("/api/revalidate");
          expect(response.headers["x-siteflow-request-id"]).toMatch(/^req_/);
          expect(response.headers["content-length"]).toBeUndefined();
          expect(response.body.byteLength).toBe(0);
          expect(invocations).toHaveLength(1);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_function_no_content",
            projectId: "project_docs",
            path: "/api/revalidate",
            method: "POST",
            status: "succeeded",
            responseStatus: 204,
            requestId: response.headers["x-siteflow-request-id"]
          });
        },
        {
          functionModuleLoader: async () => ({
            default: async () => ({
              status: 204,
              headers: { "x-runtime-revalidated": "true" },
              body: { ignored: true }
            })
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("preserves metadata for not-modified function responses", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-not-modified-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_not_modified",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/data",
                    sourcePath: ".siteflow/functions/api/data.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await rawHttpGet(baseUrl, "/api/data", {
            "x-forwarded-host": "abc123.w33d.xyz",
            "if-none-match": '"runtime-data-v1"'
          });

          expect(response.status).toBe(304);
          expect(response.headers.etag).toBe('"runtime-data-v1"');
          expect(response.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
          expect(response.headers["x-siteflow-deployment"]).toBe("dep_function_not_modified");
          expect(response.headers["x-siteflow-function"]).toBe("/api/data");
          expect(response.headers["x-siteflow-request-id"]).toMatch(/^req_/);
          expect(response.headers["content-length"]).toBeUndefined();
          expect(response.body.byteLength).toBe(0);
          expect(invocations).toHaveLength(1);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_function_not_modified",
            projectId: "project_docs",
            path: "/api/data",
            method: "GET",
            status: "succeeded",
            responseStatus: 304,
            requestId: response.headers["x-siteflow-request-id"]
          });
        },
        {
          functionModuleLoader: async () => ({
            default: async () => ({
              status: 304,
              headers: {
                etag: '"runtime-data-v1"',
                "cache-control": "public, max-age=0, must-revalidate"
              }
            })
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("injects runtime environment variables into deployed API functions and redacts logs", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-runtime-env-"));
    const invocations: FunctionInvocation[] = [];
    const previousRuntimeSecret = process.env.RUNTIME_SECRET;

    try {
      delete process.env.RUNTIME_SECRET;
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_runtime_env",
                artifactRoot,
                entrypoint: "index.html",
                runtimeEnvironment: {
                  RUNTIME_SECRET: "runtime-secret-20260527",
                  PUBLIC_RUNTIME_FLAG: "enabled"
                },
                functions: [
                  {
                    path: "/api/env",
                    sourcePath: ".siteflow/functions/api/env.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/env`, {
            headers: {
              "x-forwarded-host": "abc123.w33d.xyz"
            }
          });
          const body = await response.json() as { envSecret: string; processSecret: string; publicFlag: string };

          expect(response.status).toBe(200);
          expect(body).toEqual({
            envSecret: "runtime-secret-20260527",
            processSecret: "runtime-secret-20260527",
            publicFlag: "enabled"
          });
          expect(invocations).toHaveLength(1);
          expect(invocations[0].logs.join("\n")).toContain("runtime secret [REDACTED]");
          expect(invocations[0].logs.join("\n")).not.toContain("runtime-secret-20260527");
        },
        {
          functionModuleLoader: async () => ({
            default: async (_request: Request, context: { env: Record<string, string> }) => {
              console.log("runtime secret", process.env.RUNTIME_SECRET);

              return {
                body: {
                  envSecret: context.env.RUNTIME_SECRET,
                  processSecret: process.env.RUNTIME_SECRET,
                  publicFlag: context.env.PUBLIC_RUNTIME_FLAG
                }
              };
            }
          })
        }
      );

      expect(process.env.RUNTIME_SECRET).toBeUndefined();
    } finally {
      if (previousRuntimeSecret === undefined) {
        delete process.env.RUNTIME_SECRET;
      } else {
        process.env.RUNTIME_SECRET = previousRuntimeSecret;
      }
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("omits JSON bodies for HEAD function invocation errors", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-head-invocation-errors-"));
    const invocations: FunctionInvocation[] = [];
    let releaseLimitedHandler: (() => void) | undefined;
    let resolveLimitedStarted: (() => void) | undefined;
    const limitedStarted = new Promise<void>((resolve) => {
      resolveLimitedStarted = resolve;
    });

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_head_invocation_errors",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/fails",
                    sourcePath: ".siteflow/functions/api/fails.js",
                    runtime: "nodejs20.x",
                    handler: "default"
                  },
                  {
                    path: "/api/limited",
                    sourcePath: ".siteflow/functions/api/limited.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    concurrency: 1
                  },
                  {
                    path: "/api/memory",
                    sourcePath: ".siteflow/functions/api/memory.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    memoryMb: 1
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const failure = await rawHttpGet(baseUrl, "/api/fails", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");
          const firstLimited = fetch(`${baseUrl}/api/limited`, {
            method: "HEAD",
            headers: {
              "x-forwarded-host": "abc123.w33d.xyz"
            }
          });

          await limitedStarted;
          const limited = await rawHttpGet(baseUrl, "/api/limited", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");
          releaseLimitedHandler?.();
          await firstLimited;
          const memory = await rawHttpGet(baseUrl, "/api/memory", {
            "x-forwarded-host": "abc123.w33d.xyz"
          }, "HEAD");

          expect(failure.status).toBe(500);
          expect(failure.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(failure.headers["content-length"]).toBeUndefined();
          expect(failure.body.byteLength).toBe(0);
          expect(limited.status).toBe(429);
          expect(limited.headers["retry-after"]).toBe("1");
          expect(limited.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(limited.headers["content-length"]).toBeUndefined();
          expect(limited.body.byteLength).toBe(0);
          expect(memory.status).toBe(507);
          expect(memory.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(memory.headers["content-length"]).toBeUndefined();
          expect(memory.body.byteLength).toBe(0);
          expect(invocations.map((invocation) => invocation.responseStatus).sort((left, right) => left - right)).toEqual([
            200,
            429,
            500,
            507
          ]);
          expect(invocations.every((invocation) => invocation.method === "HEAD")).toBe(true);
        },
        {
          functionModuleLoader: async (functionPath) => {
            if (functionPath.endsWith(path.join(".siteflow", "functions", "api", "fails.js"))) {
              return {
                default: async () => {
                  throw new Error("Function failed before producing a response.");
                }
              };
            }

            if (functionPath.endsWith(path.join(".siteflow", "functions", "api", "limited.js"))) {
              return {
                default: async () => {
                  resolveLimitedStarted?.();
                  await new Promise<void>((resolve) => {
                    releaseLimitedHandler = resolve;
                  });
                  return { body: { ok: true } };
                }
              };
            }

            throw new Error("Memory guard rejection should not load function modules.");
          }
        }
      );
    } finally {
      releaseLimitedHandler?.();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("times out API functions according to runtime limits", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-timeout-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_timeout",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/slow",
                    sourcePath: ".siteflow/functions/api/slow.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    timeoutMs: 10
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/slow`, {
            headers: {
              "x-forwarded-host": "abc123.w33d.xyz"
            }
          });
          const body = await response.json() as { message: string; requestId: string };

          expect(response.status).toBe(504);
          expect(body.message).toBe("Function invocation timed out.");
          expect(invocations).toHaveLength(1);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_timeout",
            path: "/api/slow",
            status: "failed",
            responseStatus: 504,
            requestId: body.requestId
          });
          expect(invocations[0].logs.join("\n")).toContain("timed out");
        },
        {
          functionModuleLoader: async () => ({
            default: async () => {
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { body: { ok: true } };
            }
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects API function invocations over the configured concurrency limit", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-concurrency-"));
    const invocations: FunctionInvocation[] = [];
    let releaseHandler: (() => void) | undefined;

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_concurrency",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/limited",
                    sourcePath: ".siteflow/functions/api/limited.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    concurrency: 1
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const request = () => fetch(`${baseUrl}/api/limited`, {
            headers: {
              "x-forwarded-host": "abc123.w33d.xyz"
            }
          });
          const first = request();

          await new Promise((resolve) => setTimeout(resolve, 5));
          const second = await request();
          const secondBody = await second.json() as { message: string; requestId: string };

          expect(second.status).toBe(429);
          expect(second.headers.get("retry-after")).toBe("1");
          expect(secondBody.message).toBe("Function concurrency limit exceeded.");
          releaseHandler?.();
          const firstResponse = await first;

          expect(firstResponse.status).toBe(200);
          expect(await firstResponse.json()).toEqual({ ok: true });
          expect(invocations.map((invocation) => invocation.responseStatus).sort()).toEqual([200, 429]);
        },
        {
          functionModuleLoader: async () => ({
            default: async () => {
              await new Promise<void>((resolve) => {
                releaseHandler = resolve;
              });
              return { body: { ok: true } };
            }
          })
        }
      );
    } finally {
      releaseHandler?.();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects API function invocations when the process is over the configured memory limit", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-memory-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_memory",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/memory",
                    sourcePath: ".siteflow/functions/api/memory.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    memoryMb: 1
                  }
                ]
              }
            : undefined,
        recordFunctionInvocation: async (invocation: FunctionInvocation): Promise<void> => {
          invocations.push(invocation);
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/memory`, {
            headers: {
              "x-forwarded-host": "abc123.w33d.xyz"
            }
          });
          const body = await response.json() as { message: string; requestId: string };

          expect(response.status).toBe(507);
          expect(body.message).toBe("Function memory limit exceeded.");
          expect(invocations).toHaveLength(1);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_memory",
            path: "/api/memory",
            status: "failed",
            responseStatus: 507,
            requestId: body.requestId
          });
          expect(invocations[0].logs.join("\n")).toContain("memory limit exceeded");
        },
        {
          functionModuleLoader: async () => {
            throw new Error("Function module should not load after memory guard rejection.");
          }
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("serves rolling artifact routes with deterministic bucket headers", async () => {
    const currentRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-current-"));
    const candidateRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-candidate-"));
    let seenBucketKey: string | undefined;

    try {
      await writeFile(path.join(currentRoot, "index.html"), "<h1>Current</h1>");
      await writeFile(path.join(candidateRoot, "index.html"), "<h1>Candidate</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string, bucketKey?: string): Promise<ArtifactRoute | undefined> => {
          seenBucketKey = bucketKey;

          if (host !== "dashboard.acme.test") {
            return undefined;
          }

          return {
            host,
            deploymentId: bucketKey === "user-canary" ? "dep-canary" : "dep-current",
            artifactRoot: bucketKey === "user-canary" ? candidateRoot : currentRoot,
            entrypoint: "index.html",
            rollingReleaseId: "rollout_preview",
            trafficTarget: bucketKey === "user-canary" ? "candidate" : "current"
          };
        }
      };

      await withServer(repository, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/`, {
          headers: {
            "x-forwarded-host": "dashboard.acme.test",
            "x-siteflow-bucket-key": "user-canary"
          }
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(seenBucketKey).toBe("user-canary");
        expect(response.headers.get("x-siteflow-deployment")).toBe("dep-canary");
        expect(response.headers.get("x-siteflow-rollout")).toBe("rollout_preview");
        expect(response.headers.get("x-siteflow-traffic-target")).toBe("candidate");
        expect(body).toContain("Candidate");
      });
    } finally {
      await rm(currentRoot, { recursive: true, force: true });
      await rm(candidateRoot, { recursive: true, force: true });
    }
  });
});
