import { createHmac, scryptSync } from "node:crypto";
import http from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Actor, ApiToken, BlobObject, EdgeConfigEntry, FirewallRule, FunctionInvocation, LogDrain, ObservabilityLogEntry, OperatorSession, PermissionScope, ReleaseChannelName, RoutingRule, SiteFlowId, SourceProvider, TeamMember } from "../src/domain/siteflow";
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
} from "../src/domain/readModels";
import type {
  AbortRollingReleaseCommand,
  AdvanceRollingReleaseCommand,
  AnalyticsEventCommand,
  CompleteRollingReleaseCommand,
  CreateApiTokenCommand,
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
  RevokeAllOperatorSessionsCommand,
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
import { bundleWithReleaseEvidenceAttestation, releaseEvidenceBundleAttestationKeyId } from "../scripts/releaseEvidenceBundleCheck";
import { createSiteFlowServer, type DrainFetch, type FunctionModuleLoader, type ReleaseEvidenceEvaluator, type SiteFlowReadinessCheck, type SiteFlowRequestLogEntry, type SiteFlowRuntimeMetricsCollector, type SiteFlowTrustedProxyPolicy } from "./httpServer";
import { createDefaultRequestLogger, createProductionMetricsCollector, createStdoutRequestLogger, defaultAllowSameProcessFunctionRuntime, defaultOperatorSessionIdleTimeoutSeconds, defaultSecureCookies, defaultTrustProxy, gitWebhookSecretsFromEnv, requireProductionApiToken, requireProductionGitWebhookSecrets, requireProductionMetricsToken, resolveDatabaseUrl } from "./index";
import { SiteFlowConflictError, SiteFlowNotFoundError, type ArtifactRoute, type OperatorSessionCreateResult, type OperatorSessionRotateResult, type RecordLogDrainDeliveryCommand, type SiteFlowAuthPrincipal, type SiteFlowReadRepository } from "./readRepository";

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

function releaseEvidenceMetadata(overrides: Record<string, unknown> = {}) {
  return {
    evidencePath: "evidence/release-evidence.json",
    checkedAt: new Date().toISOString(),
    status: "passed" as const,
    payloadDigest: `sha256:${"d".repeat(64)}`,
    commitRef: "abc123def4567890",
    repository: "acme/siteflow",
    branch: "main",
    targetEnvironment: "production",
    releaseTicket: "REL-2026-0608",
    operatorName: "release-operator",
    ...overrides
  };
}

const releaseEvidenceAttestationSigningKey = "release-evidence-test-signing-key-with-enough-entropy";

function releaseEvidenceBundle(overrides: Record<string, unknown> = {}, signingKey = releaseEvidenceAttestationSigningKey) {
  const checkedAt = new Date().toISOString();
  const bundle = {
    schemaVersion: "siteflow.releaseEvidence.v1",
    name: "siteflow-release-evidence-bundle",
    checkedAt,
    targetEnvironment: "production",
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      releaseTicket: "REL-2026-0608",
      operatorName: "release-operator"
    },
    ...overrides
  };

  return bundleWithReleaseEvidenceAttestation(bundle, checkedAt, signingKey ? { attestationSigningKey: signingKey } : {});
}

function releaseEvidenceRequest(overrides: Record<string, unknown> = {}) {
  return {
    evidencePath: "evidence/release-evidence.json",
    bundle: releaseEvidenceBundle(),
    ...overrides
  };
}

function passingReleaseEvidenceEvaluator(calls: Array<{ rawEvidence: unknown; evidencePath: string }> = []): ReleaseEvidenceEvaluator {
  return (rawEvidence, options) => {
    calls.push({ rawEvidence, evidencePath: options.evidencePath });

    return {
      name: "siteflow-release-evidence-bundle-check",
      status: "passed",
      checkedAt: new Date().toISOString(),
      evidencePath: options.evidencePath,
      payloadDigest: `sha256:${"d".repeat(64)}`,
      thresholds: {
        maxEvidenceAgeHours: 168,
        allowHostBuildException: false
      },
      selectedEvidence: {
        releaseCommitRef: "abc123def4567890",
        repository: "acme/siteflow",
        branch: "main",
        releaseGateStatus: "pass",
        dockerBuildRehearsalStatus: "passed",
        postgresRehearsalStatus: "passed",
        artifactEvidenceStatus: "passed",
        releaseImageDigest: `sha256:${"f".repeat(64)}`,
        backupEvidenceStatus: "passed",
        observabilityEvidenceStatus: "passed",
        operatorAccessEvidenceStatus: "passed",
        nonSessionCredentialEvidenceStatus: "passed",
        ingressEvidenceStatus: "passed",
        upgradeRollbackDrillStatus: "passed"
      },
      checks: [
        {
          name: "bundle",
          status: "pass",
          message: "Bundle passed."
        }
      ],
      exitCode: 0
    };
  };
}

function fixtureRepository(): SiteFlowReadRepository {
  const fixture = siteflowFixtures.healthy;
  const tokenScopes: Record<string, PermissionScope[]> = {
    "read-token": ["read"],
    "operator-token": ["read", "write"],
    "admin-token": ["read", "write", "admin"],
    "project-admin-token": ["read", "write", "admin"]
  };
  const tokenActors: Record<string, Actor | undefined> = {
    "read-token": { id: "token-read", name: "Read token", role: "system" },
    "operator-token": { id: "token-operator", name: "Operator token", role: "operator" },
    "project-admin-token": { id: "token-project-admin", name: "Project admin token", role: "operator" }
  };
  const tokenProjectIds: Record<string, SiteFlowId | undefined> = {
    "project-admin-token": "project-acme-dashboard"
  };
  const sessionScopes: Record<string, PermissionScope[] | undefined> = {
    "session-read-token": ["read"],
    "session-admin-token": ["read", "write", "admin"],
    "expired-session-token": undefined
  };
  const sessionProjectIds: Record<string, SiteFlowId[] | undefined> = {
    "session-admin-token": undefined
  };
  const sessionSubjects: Record<string, string | undefined> = {
    "session-admin-token": "ops@example.com",
    "session-read-token": "reader@example.com"
  };
  const sessionActors: Record<string, Actor | undefined> = {
    "session-admin-token": { id: "session-operator", name: "Session Operator", role: "operator" }
  };
  let sessionSequence = 0;
  const canUseToken = (token: string, permission: PermissionScope, projectId?: SiteFlowId) => {
    const tokenProjectId = tokenProjectIds[token];

    if (tokenProjectId && tokenProjectId !== projectId) {
      return false;
    }

    const scopes = tokenScopes[token] ?? [];
    const level = (scope: PermissionScope) => scope === "read" ? 0 : scope === "write" ? 1 : 2;

    return scopes.some((scope) => level(scope) >= level(permission));
  };
  const operatorSession = (
    secret: string,
    subject: string,
    scopes: PermissionScope[],
    projectIds?: SiteFlowId[],
    status: OperatorSession["status"] = "active"
  ): OperatorSession => ({
    id: `session-${secret.replace(/[^a-z0-9]+/gi, "-")}`,
    subject,
    tokenPrefix: secret.slice(0, 12),
    scopes,
    projectIds,
    status,
    createdAt: "2026-06-07T00:00:00.000Z",
    expiresAt: "2026-06-07T01:00:00.000Z",
    revokedAt: status === "revoked" ? "2026-06-07T00:30:00.000Z" : undefined,
    lastUsedAt: "2026-06-07T00:10:00.000Z"
  });
  const apiToken = (token: string, scopes: PermissionScope[]): ApiToken => ({
    id: `token-${token.replace(/[^a-z0-9]+/gi, "-")}`,
    projectId: tokenProjectIds[token],
    name: `${token} fixture`,
    tokenPrefix: token.slice(0, 12),
    scopes,
    status: "active",
    createdBy: tokenActors[token],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    lastUsedAt: "2026-06-07T00:10:00.000Z"
  });
  const fallbackApiTokenActor = (token: ApiToken): Actor => token.createdBy ?? {
    id: `api-token:${token.id}`,
    name: token.name,
    role: "system"
  };
  const fallbackSessionActor = (session: OperatorSession): Actor => session.actor ?? {
    id: `operator-session:${session.id}`,
    name: session.subject,
    role: "operator"
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
    resolveTokenPrincipal: async (token: string, projectId?: SiteFlowId): Promise<SiteFlowAuthPrincipal | undefined> => {
      const tokenProjectId = tokenProjectIds[token];

      if (tokenProjectId && tokenProjectId !== projectId) {
        return undefined;
      }

      const scopes = tokenScopes[token];

      if (!scopes) {
        return undefined;
      }

      const resolvedToken = apiToken(token, scopes);

      return {
        kind: "api_token",
        scopes,
        token: resolvedToken,
        actor: fallbackApiTokenActor(resolvedToken)
      };
    },
    resolveTokenPermissions: async (token: string, projectId?: SiteFlowId): Promise<PermissionScope[] | undefined> =>
      canUseToken(token, "read", projectId) ? tokenScopes[token] : undefined,
    authorizeToken: async (token: string, permission: PermissionScope, projectId?: SiteFlowId): Promise<boolean> => canUseToken(token, permission, projectId),
    resolveSessionPrincipal: async (token: string, projectId?: SiteFlowId): Promise<SiteFlowAuthPrincipal | undefined> => {
      const scopes = sessionScopes[token];

      if (!scopes) {
        return undefined;
      }

      const session = {
        ...operatorSession(token, sessionSubjects[token] ?? "operator", scopes, sessionProjectIds[token]),
        actor: sessionActors[token]
      };
      const scoped = !session.projectIds || (projectId !== undefined && session.projectIds.includes(projectId));

      return {
        kind: "operator_session",
        scopes: scoped ? scopes : [],
        session,
        actor: fallbackSessionActor(session)
      };
    },
    resolveSessionPermissions: async (token: string): Promise<PermissionScope[] | undefined> => sessionScopes[token],
    createOperatorSession: async (command): Promise<OperatorSessionCreateResult> => {
      const secret = `sfs_fixture_session_${++sessionSequence}`;
      const scopes = command.scopes as PermissionScope[];
      sessionScopes[secret] = scopes;
      sessionProjectIds[secret] = command.projectIds;
      sessionSubjects[secret] = command.subject ?? "operator";
      sessionActors[secret] = command.actor;

      return {
        status: "created",
        session: {
          ...operatorSession(secret, command.subject ?? "operator", scopes, command.projectIds),
          actor: command.actor,
          expiresAt: "2026-06-07T01:00:00.000Z"
        },
        secret,
        message: "Operator session created."
      };
    },
    rotateOperatorSession: async (token: string): Promise<OperatorSessionRotateResult | undefined> => {
      const scopes = sessionScopes[token];

      if (!scopes) {
        return undefined;
      }

      const secret = `sfs_fixture_session_${++sessionSequence}`;
      const projectIds = sessionProjectIds[token];
      const subject = sessionSubjects[token] ?? "operator";
      const actor = sessionActors[token];

      delete sessionScopes[token];
      delete sessionProjectIds[token];
      delete sessionSubjects[token];
      delete sessionActors[token];

      sessionScopes[secret] = scopes;
      sessionProjectIds[secret] = projectIds;
      sessionSubjects[secret] = subject;
      sessionActors[secret] = actor;

      return {
        status: "rotated",
        session: {
          ...operatorSession(secret, subject, scopes, projectIds),
          actor,
          expiresAt: "2026-06-07T01:00:00.000Z"
        },
        secret,
        maxAgeSeconds: 900,
        message: "Operator session rotated."
      };
    },
    revokeOperatorSession: async (token: string): Promise<OperatorSessionRevokeReadModel> => {
      const scopes = sessionScopes[token];
      delete sessionScopes[token];
      delete sessionProjectIds[token];
      delete sessionSubjects[token];
      delete sessionActors[token];

      if (!scopes) {
        return {
          status: "not_found",
          message: "Operator session was not found."
        };
      }

      return {
        status: "revoked",
        session: operatorSession(token, "operator", scopes, undefined, "revoked"),
        message: "Operator session revoked."
      };
    },
    revokeAllOperatorSessions: async (command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel> => {
      const scope = command.projectId ? "project" : "global";
      let revokedCount = 0;

      for (const token of Object.keys(sessionScopes)) {
        const scopes = sessionScopes[token];

        if (!scopes) {
          continue;
        }

        const projectIds = sessionProjectIds[token];
        const inScope = command.projectId ? Boolean(projectIds?.includes(command.projectId)) : true;

        if (!inScope) {
          continue;
        }

        delete sessionScopes[token];
        delete sessionProjectIds[token];
        delete sessionSubjects[token];
        delete sessionActors[token];
        revokedCount += 1;
      }

      return {
        status: "revoked",
        scope,
        projectId: command.projectId,
        cutoffId: `sessioncutoff_fixture_${++sessionSequence}`,
        revokedAt: "2026-06-07T00:40:00.000Z",
        revokedCount,
        message: command.projectId
          ? "Project operator sessions were revoked."
          : "All existing operator sessions were revoked."
      };
    },
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
        currentPermissions: ["read", "write", "admin"],
        previewProtectionEnabled: false
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
    addProjectDomain: async (projectId, command): Promise<ProjectMutationReadModel> => {
      const settings = await fixtureRepository().getProjectSettings(projectId);
      const hostname = command.hostname.trim().toLowerCase();

      return {
        status: "updated",
        project: {
          ...settings.project,
          domains: [
            ...settings.project.domains,
            {
              hostname,
              channel: "production",
              verified: false,
              lastCheckedAt: "2026-05-25T00:00:00.000Z"
            }
          ],
          updatedAt: "2026-05-25T00:00:00.000Z"
        },
        message: "Project domain added."
      };
    },
    removeProjectDomain: async (projectId, hostname): Promise<ProjectMutationReadModel> => {
      const settings = await fixtureRepository().getProjectSettings(projectId);
      const normalizedHostname = hostname.trim().toLowerCase();

      return {
        status: "updated",
        project: {
          ...settings.project,
          domains: settings.project.domains.filter((domain) => domain.hostname !== normalizedHostname),
          updatedAt: "2026-05-25T00:00:00.000Z"
        },
        message: "Project domain removed."
      };
    },
    setPreviewProtection: async (projectId, _password, _actor): Promise<ProjectMutationReadModel> => {
      const settings = await fixtureRepository().getProjectSettings(projectId);

      return {
        status: "updated",
        project: {
          ...settings.project,
          updatedAt: "2026-05-25T00:00:00.000Z"
        },
        message: "Preview protection enabled."
      };
    },
    clearPreviewProtection: async (projectId, _actor): Promise<ProjectMutationReadModel> => {
      const settings = await fixtureRepository().getProjectSettings(projectId);

      return {
        status: "updated",
        project: {
          ...settings.project,
          updatedAt: "2026-05-25T00:00:00.000Z"
        },
        message: "Preview protection disabled."
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
    gitWebhookSecrets?: Partial<Record<SourceProvider, string>>;
    maxBodyBytes?: number;
    prebuiltMaxUploadBytes?: number;
    prebuiltMaxFiles?: number;
    rateLimit?: false | {
      maxRequests?: number;
      windowMs?: number;
      now?: () => number;
    };
    functionModuleLoader?: FunctionModuleLoader;
    drainFetch?: DrainFetch;
    requestLogger?: (entry: SiteFlowRequestLogEntry) => void;
    readinessCheck?: SiteFlowReadinessCheck;
    metricsToken?: string;
    runtimeMetricsCollector?: SiteFlowRuntimeMetricsCollector;
    secureCookies?: boolean;
    trustProxy?: SiteFlowTrustedProxyPolicy;
    releaseEvidenceEvaluator?: ReleaseEvidenceEvaluator;
    releaseEvidenceAttestationSigningKey?: string;
    releaseEvidenceRequiredAttestationKeyId?: string;
    productionRuntime?: boolean;
    allowSameProcessFunctionRuntime?: boolean;
  } = {}
) {
  const server = createSiteFlowServer({
    repository,
    version: "0.1.0-test",
    apiToken: options.apiToken,
    metricsToken: options.metricsToken,
    allowedOrigin: options.allowedOrigin,
    baseDomain: options.baseDomain,
    githubWebhookSecret: options.githubWebhookSecret,
    gitWebhookSecrets: options.gitWebhookSecrets,
    maxBodyBytes: options.maxBodyBytes,
    prebuiltMaxUploadBytes: options.prebuiltMaxUploadBytes,
    prebuiltMaxFiles: options.prebuiltMaxFiles,
    rateLimit: options.rateLimit,
    functionModuleLoader: options.functionModuleLoader,
    drainFetch: options.drainFetch,
    requestLogger: options.requestLogger,
    readinessCheck: options.readinessCheck,
    runtimeMetricsCollector: options.runtimeMetricsCollector,
    secureCookies: options.secureCookies,
    trustProxy: options.trustProxy ?? true,
    releaseEvidenceEvaluator: options.releaseEvidenceEvaluator,
    releaseEvidenceAttestationSigningKey: options.releaseEvidenceAttestationSigningKey ?? releaseEvidenceAttestationSigningKey,
    releaseEvidenceRequiredAttestationKeyId: options.releaseEvidenceRequiredAttestationKeyId,
    productionRuntime: options.productionRuntime,
    allowSameProcessFunctionRuntime: options.allowSameProcessFunctionRuntime
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

function gitLabSigningKey(secret: string) {
  return secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : secret;
}

function signGitLabBody(rawBody: string, secret: string, deliveryId: string, timestamp: string) {
  return `v1,${createHmac("sha256", gitLabSigningKey(secret)).update(`${deliveryId}.${timestamp}.${rawBody}`).digest("base64")}`;
}

function currentGitLabWebhookTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function signGiteaBody(rawBody: string, secret: string) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function signSiteFlowBody(rawBody: string, secret: string) {
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
      ssh_url: "git@github.com:acme/docs-portal.git",
      owner: {
        login: "acme"
      }
    },
    sender: {
      login: "octocat"
    }
  };
}

function gitLabPushPayload() {
  return {
    object_kind: "push",
    ref: "refs/heads/main",
    before: "8ac4e0d77a9f",
    after: "7f3a9c2d1b0e",
    user_username: "gitlab-ada",
    project: {
      id: 84,
      name: "docs-portal",
      path_with_namespace: "acme/docs-portal",
      default_branch: "main",
      web_url: "https://gitlab.example.com/acme/docs-portal",
      git_ssh_url: "git@gitlab.example.com:acme/docs-portal.git"
    },
    commits: [
      {
        id: "7f3a9c2d1b0e",
        message: "Ship GitLab docs portal",
        author: {
          name: "Ada GitLab"
        }
      }
    ]
  };
}

function giteaPullRequestPayload() {
  return {
    action: "opened",
    number: 12,
    repository: {
      id: 128,
      name: "docs-portal",
      full_name: "acme/docs-portal",
      default_branch: "main",
      html_url: "https://gitea.example.com/acme/docs-portal",
      ssh_url: "git@gitea.example.com:acme/docs-portal.git",
      owner: {
        login: "acme"
      }
    },
    pull_request: {
      number: 12,
      title: "Ship Gitea docs portal",
      html_url: "https://gitea.example.com/acme/docs-portal/pulls/12",
      head: {
        ref: "feature/docs",
        sha: "9f3a9c2d1b0e"
      },
      user: {
        login: "gitea-ada"
      }
    },
    sender: {
      login: "gitea-ada"
    }
  };
}

function genericPushPayload() {
  return {
    kind: "push",
    ref: "refs/heads/main",
    commitSha: "6f3a9c2d1b0e",
    commitMessage: "Ship generic docs portal",
    commitAuthor: "Generic Ada",
    repository: {
      owner: "acme",
      name: "docs-portal",
      defaultBranch: "main",
      remoteUrl: "ssh://git.example.com/acme/docs-portal.git"
    },
    actor: {
      id: "generic:ada",
      name: "generic-ada"
    }
  };
}

describe("SiteFlow control-plane HTTP server", () => {
  it("serves health and project read models", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
      const projects = await fetch(`${baseUrl}/api/projects`, {
        headers: {
          authorization: "Bearer read-token"
        }
      }).then((response) => response.json());

      expect(health).toEqual({ status: "ok", version: "0.1.0-test" });
      expect(projects.summary.totalProjects).toBe(1);
    }, { apiToken: "deploy-token" });
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

  it("serves readiness as ready by default and includes whitelisted readiness details", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const defaultReady = await fetch(`${baseUrl}/readyz`).then(async (response) => ({
          status: response.status,
          body: await response.json()
        }));
        const headReady = await rawHttpGet(baseUrl, "/readyz", {}, "HEAD");

        expect(defaultReady).toEqual({
          status: 200,
          body: {
            status: "ready",
            details: {}
          }
        });
        expect(headReady.status).toBe(200);
        expect(headReady.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(headReady.headers["content-length"]).toBeUndefined();
        expect(headReady.body.byteLength).toBe(0);
      }
    );

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/readyz`);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
          status: "ready",
          details: {
            database: "ok",
            artifactRoot: "ok"
          }
        });
      },
      {
        readinessCheck: async () => ({
          status: "ready",
          details: {
            database: "ok",
            artifactRoot: "ok",
            unsafe: SITEFLOW_SECRET_CANARY
          }
        })
      }
    );
  });

  it("returns 503 for failed readiness checks without exposing internal errors", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/readyz`);
        const body = await response.json();
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(503);
        expect(Object.keys(body).sort()).toEqual(["details", "status"]);
        expect(body).toEqual({
          status: "not_ready",
          details: {}
        });
        expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
        expect(serialized).not.toContain("database password");
      },
      {
        readinessCheck: async () => {
          throw new Error(`database password ${SITEFLOW_SECRET_CANARY}`);
        }
      }
    );
  });

  it("serves deployment inventory with a project filter", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments?projectId=project-acme-dashboard`, {
        headers: {
          authorization: "Bearer read-token"
        }
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        total: 2,
        projectId: "project-acme-dashboard"
      });
      expect(body.deployments.map((deployment: { id: string }) => deployment.id)).toContain("dep-healthy");
    }, { apiToken: "deploy-token" });
  });

  it("omits JSON bodies for HEAD deployment read endpoints", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const authHeaders = { authorization: "Bearer read-token" };
      const inventory = await rawHttpGet(baseUrl, "/api/deployments?projectId=project-acme-dashboard", authHeaders, "HEAD");
      const deployment = await rawHttpGet(baseUrl, "/api/deployments/dep-healthy", authHeaders, "HEAD");
      const logs = await rawHttpGet(baseUrl, "/api/deployments/dep-healthy/logs", authHeaders, "HEAD");

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
    }, { apiToken: "deploy-token" });
  });

  it("omits JSON bodies for HEAD project read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const authHeaders = { authorization: "Bearer deploy-token" };
        const projects = await rawHttpGet(baseUrl, "/api/projects", authHeaders, "HEAD");
        const project = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard", authHeaders, "HEAD");
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
      const authHeaders = { authorization: "Bearer read-token" };
      const environments = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/environments", authHeaders, "HEAD");
      const analytics = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/analytics", authHeaders, "HEAD");
      const unauthorizedAnalytics = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/analytics", {}, "HEAD");
      const logs = await rawHttpGet(
        baseUrl,
        "/api/projects/project-acme-dashboard/logs?source=build&severity=warning",
        authHeaders,
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
      expect(unauthorizedAnalytics.status).toBe(401);
      expect(unauthorizedAnalytics.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(unauthorizedAnalytics.headers["content-length"]).toBeUndefined();
      expect(unauthorizedAnalytics.body.byteLength).toBe(0);
      expect(logs.status).toBe(200);
      expect(logs.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(logs.headers["content-length"]).toBeUndefined();
      expect(logs.body.byteLength).toBe(0);
    }, { apiToken: "deploy-token" });
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
        const release = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/release/production", authHeaders, "HEAD");
        const rollback = await rawHttpGet(baseUrl, "/api/projects/project-acme-dashboard/rollback/production", authHeaders, "HEAD");
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
      const response = await rawHttpGet(baseUrl, "/api/operations/op-healthy-promote", {
        authorization: "Bearer read-token"
      }, "HEAD");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.body.byteLength).toBe(0);
    }, { apiToken: "deploy-token" });
  });

  it("advertises supported read and mutation methods in CORS allow-method metadata", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const preflight = await rawHttpGet(baseUrl, "/api/projects", {}, "OPTIONS");
        const head = await rawHttpGet(baseUrl, "/api/projects", {
          authorization: "Bearer deploy-token"
        }, "HEAD");

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
          expect(allowedHeaders).toContain("x-siteflow-csrf");
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
      { allowedOrigin: "https://console.example.test", apiToken: "deploy-token" }
    );
  });

  it("maps not-found repository errors to 404", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/missing`, {
        headers: {
          authorization: "Bearer read-token"
        }
      });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.message).toContain("Unknown project");
    }, { apiToken: "deploy-token" });
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

  it("routes project domain add and remove requests through the admin sub-api", async () => {
    let added: { projectId: string; hostname: string } | undefined;
    let removed: { projectId: string; hostname: string } | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      addProjectDomain: async (projectId, command) => {
        added = { projectId, hostname: command.hostname };

        return fixtureRepository().addProjectDomain(projectId, command);
      },
      removeProjectDomain: async (projectId, hostname, actor) => {
        removed = { projectId, hostname };

        return fixtureRepository().removeProjectDomain(projectId, hostname, actor);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const addResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/domains`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            hostname: "Docs.Example.com"
          })
        });
        const removeResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/domains/${encodeURIComponent("docs.example.com")}`, {
          method: "DELETE",
          headers: {
            authorization: "Bearer deploy-token"
          }
        });

        expect(addResponse.status).toBe(201);
        expect(removeResponse.status).toBe(200);
        expect(added).toEqual({
          projectId: "project-acme-dashboard",
          hostname: "Docs.Example.com"
        });
        expect(removed).toEqual({
          projectId: "project-acme-dashboard",
          hostname: "docs.example.com"
        });
      },
      { apiToken: "deploy-token" }
    );
  });

  it("routes preview protection set and clear requests through the admin sub-api", async () => {
    let set: { projectId: string; password: string; actorId: string } | undefined;
    let cleared: { projectId: string; actorId: string } | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      setPreviewProtection: async (projectId, password, actor) => {
        set = { projectId, password, actorId: actor.id };

        return fixtureRepository().setPreviewProtection(projectId, password, actor);
      },
      clearPreviewProtection: async (projectId, actor) => {
        cleared = { projectId, actorId: actor.id };

        return fixtureRepository().clearPreviewProtection(projectId, actor);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const emptyResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/preview-protection`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({ password: "   " })
        });
        const setResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/preview-protection`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({ password: " open sesame " })
        });
        const setBody = await setResponse.json();
        const clearResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/preview-protection`, {
          method: "DELETE",
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const clearBody = await clearResponse.json();

        expect(emptyResponse.status).toBe(400);
        expect(setResponse.status).toBe(200);
        expect(clearResponse.status).toBe(200);
        expect(setBody).toEqual({ enabled: true });
        expect(clearBody).toEqual({ enabled: false });
        expect(set).toEqual({
          projectId: "project-acme-dashboard",
          password: " open sesame ",
          actorId: "siteflow:server"
        });
        expect(cleared).toEqual({
          projectId: "project-acme-dashboard",
          actorId: "siteflow:server"
        });
      },
      { apiToken: "deploy-token" }
    );
  });

  it("returns conflict responses for duplicate project domain hostnames", async () => {
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      addProjectDomain: async () => {
        throw new SiteFlowConflictError("Domain hostname is already bound: docs.example.com.");
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/domains`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            hostname: "docs.example.com"
          })
        });
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body).toEqual({
          message: "Domain hostname is already bound: docs.example.com."
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

  it("protects analytics dashboard reads while allowing privacy-sanitized event ingest without bearer auth", async () => {
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
        const unauthorizedDashboardResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/analytics`);
        const dashboardResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/analytics`, {
          headers: {
            authorization: "Bearer read-token"
          }
        });
        const dashboard = await dashboardResponse.json();

        expect(unauthorizedDashboardResponse.status).toBe(401);
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
        const logsResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/logs?source=build&severity=warning`, {
          headers: {
            authorization: "Bearer read-token"
          }
        });
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

  it("ignores forwarded host and proto for deploy hook URLs when proxy trust is disabled", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const createResponse = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/deploy-hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token",
            "x-forwarded-host": "console.siteflow.test",
            "x-forwarded-proto": "https"
          },
          body: JSON.stringify({
            name: "CMS rebuild",
            branch: "main",
            targetEnvironment: "preview"
          })
        });
        const created = await createResponse.json();

        expect(createResponse.status).toBe(201);
        expect(created.hookUrl).toBe(`${baseUrl}/api/deploy-hooks/sfh_test_token/trigger`);
        expect(created.hookUrl).not.toContain("console.siteflow.test");
      },
      { apiToken: "deploy-token", trustProxy: false }
    );
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
        const sessionHeaders = {
          cookie: "siteflow_session=session-admin-token",
          "x-siteflow-csrf": "same-origin",
          "content-type": "application/json"
        };
        const spoofedActor = {
          id: "client-spoofed-actor",
          name: "Client spoofed actor",
          role: "system"
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
          headers: sessionHeaders,
          body: JSON.stringify({
            name: "Legacy docs",
            kind: "redirect",
            source: "/legacy-docs",
            destination: "/docs",
            statusCode: 308,
            priority: 5,
            actor: spoofedActor
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
          headers: sessionHeaders,
          body: JSON.stringify({
            reason: "Moved to app config.",
            actor: spoofedActor
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
    expect(received.upsert?.actor).toEqual({
      id: "session-operator",
      name: "Session Operator",
      role: "operator"
    });
    expect(received.upsert?.actor?.id).not.toBe("client-spoofed-actor");
    expect(received.disable).toMatchObject({
      projectId: "project-acme-dashboard",
      ruleId: "route_docs",
      reason: "Moved to app config."
    });
    expect(received.disable?.actor).toEqual({
      id: "session-operator",
      name: "Session Operator",
      role: "operator"
    });
    expect(received.disable?.actor?.id).not.toBe("client-spoofed-actor");
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
    const requestLogs: SiteFlowRequestLogEntry[] = [];
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
            idempotencyKey: "cms-42",
            canary: SITEFLOW_SECRET_CANARY
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
      {
        apiToken: "deploy-token",
        requestLogger: (entry) => {
          requestLogs.push(entry);
        }
      }
    );

    expect(triggeredCommand).toMatchObject({
      token: "sfh_test_token",
      branch: "main",
      commitSha: "4f3a9c2d1b0e",
      commitMessage: "CMS published",
      idempotencyKey: "cms-42"
    });
    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]).toMatchObject({
      method: "POST",
      path: "/api/deploy-hooks/[token]/trigger",
      status: 202
    });
    expect(JSON.stringify(requestLogs)).not.toContain("sfh_test_token");
    expect(JSON.stringify(requestLogs)).not.toContain(SITEFLOW_SECRET_CANARY);
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

  it("accepts signed GitLab push webhooks and stores clone metadata", async () => {
    const secret = `whsec_${Buffer.from("gitlab-webhook-secret").toString("base64")}`;
    let receivedCommand: GitWebhookCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => {
        receivedCommand = command;
        return fixtureRepository().ingestGitWebhook(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const deliveryId = "gitlab-delivery-1";
        const timestamp = currentGitLabWebhookTimestamp();
        const rawBody = JSON.stringify(gitLabPushPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/gitlab`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": deliveryId,
            "webhook-timestamp": timestamp,
            "webhook-signature": signGitLabBody(rawBody, secret, deliveryId, timestamp),
            "x-gitlab-event": "Push Hook"
          },
          body: rawBody
        });

        expect(response.status).toBe(202);
      },
      { gitWebhookSecrets: { gitlab: secret } }
    );

    expect(receivedCommand).toMatchObject({
      provider: "gitlab",
      deliveryId: "gitlab-delivery-1",
      event: {
        provider: "gitlab",
        kind: "push",
        branch: "main",
        commitSha: "7f3a9c2d1b0e",
        commitMessage: "Ship GitLab docs portal",
        commitAuthor: "Ada GitLab",
        actor: {
          id: "gitlab:gitlab-ada",
          name: "gitlab-ada"
        },
        repository: {
          provider: "gitlab",
          owner: "acme",
          name: "docs-portal",
          providerPayload: {
            remoteUrl: "git@gitlab.example.com:acme/docs-portal.git"
          }
        }
      }
    });
  });

  it("accepts signed Gitea pull request webhooks", async () => {
    const secret = "gitea-webhook-secret";
    let receivedCommand: GitWebhookCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => {
        receivedCommand = command;
        return fixtureRepository().ingestGitWebhook(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const rawBody = JSON.stringify(giteaPullRequestPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/gitea`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gitea-delivery": "gitea-delivery-1",
            "x-gitea-event": "pull_request",
            "x-gitea-signature": signGiteaBody(rawBody, secret)
          },
          body: rawBody
        });

        expect(response.status).toBe(202);
      },
      { gitWebhookSecrets: { gitea: secret } }
    );

    expect(receivedCommand).toMatchObject({
      provider: "gitea",
      deliveryId: "gitea-delivery-1",
      event: {
        provider: "gitea",
        kind: "pull_request",
        branch: "feature/docs",
        commitSha: "9f3a9c2d1b0e",
        pullRequestNumber: 12,
        repository: {
          provider: "gitea",
          owner: "acme",
          name: "docs-portal",
          providerPayload: {
            remoteUrl: "git@gitea.example.com:acme/docs-portal.git"
          }
        }
      }
    });
  });

  it("accepts Gitea form payload webhooks with GitHub-compatible headers", async () => {
    const secret = "gitea-webhook-secret";
    let receivedCommand: GitWebhookCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => {
        receivedCommand = command;
        return fixtureRepository().ingestGitWebhook(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const rawBody = new URLSearchParams({ payload: JSON.stringify(giteaPullRequestPayload()) }).toString();
        const response = await fetch(`${baseUrl}/api/webhooks/git/gitea`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-github-delivery": "gitea-delivery-form-1",
            "x-github-event": "pull_request",
            "x-hub-signature-256": signGitHubBody(rawBody, secret)
          },
          body: rawBody
        });

        expect(response.status).toBe(202);
      },
      { gitWebhookSecrets: { gitea: secret } }
    );

    expect(receivedCommand).toMatchObject({
      provider: "gitea",
      deliveryId: "gitea-delivery-form-1",
      event: {
        provider: "gitea",
        kind: "pull_request",
        repository: {
          providerPayload: {
            remoteUrl: "git@gitea.example.com:acme/docs-portal.git"
          }
        }
      }
    });
  });

  it("accepts signed generic push webhooks without trusting internal source event shapes", async () => {
    const secret = "generic-webhook-secret";
    let receivedCommand: GitWebhookCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => {
        receivedCommand = command;
        return fixtureRepository().ingestGitWebhook(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const rawBody = JSON.stringify(genericPushPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/generic`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-siteflow-delivery": "generic-delivery-1",
            "x-siteflow-event": "push",
            "x-siteflow-signature": signSiteFlowBody(rawBody, secret)
          },
          body: rawBody
        });

        expect(response.status).toBe(202);
      },
      { gitWebhookSecrets: { generic: secret } }
    );

    expect(receivedCommand).toMatchObject({
      provider: "generic",
      deliveryId: "generic-delivery-1",
      event: {
        provider: "generic",
        kind: "push",
        branch: "main",
        commitSha: "6f3a9c2d1b0e",
        commitMessage: "Ship generic docs portal",
        commitAuthor: "Generic Ada",
        repository: {
          provider: "generic",
          owner: "acme",
          name: "docs-portal",
          providerPayload: {
            remoteUrl: "ssh://git.example.com/acme/docs-portal.git"
          }
        }
      }
    });
  });

  it("rejects build-triggering webhooks that do not include a clone remote URL", async () => {
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
        const payload = githubPushPayload();
        const repositoryPayload = payload.repository as Record<string, unknown>;
        delete repositoryPayload.ssh_url;
        delete repositoryPayload.clone_url;
        delete repositoryPayload.git_url;
        const rawBody = JSON.stringify(payload);
        const response = await fetch(`${baseUrl}/api/webhooks/git/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": "delivery-missing-remote",
            "x-github-event": "push",
            "x-hub-signature-256": signGitHubBody(rawBody, secret)
          },
          body: rawBody
        });
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.message).toMatch(/remoteUrl is required/);
      },
      { githubWebhookSecret: secret }
    );

    expect(ingestCalls).toBe(0);
  });

  it("rejects non-GitHub webhooks with invalid signatures before repository ingest", async () => {
    const secret = "gitlab-webhook-secret";
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
        const deliveryId = "gitlab-delivery-1";
        const timestamp = currentGitLabWebhookTimestamp();
        const rawBody = JSON.stringify(gitLabPushPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/gitlab`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": deliveryId,
            "webhook-timestamp": timestamp,
            "webhook-signature": signGitLabBody(`${rawBody}tampered`, secret, deliveryId, timestamp),
            "x-gitlab-event": "Push Hook"
          },
          body: rawBody
        });
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body.message).toMatch(/signature verification failed/i);
      },
      { gitWebhookSecrets: { gitlab: secret } }
    );

    expect(ingestCalls).toBe(0);
  });

  it("rejects stale GitLab webhook timestamps before repository ingest", async () => {
    const secret = `whsec_${Buffer.from("gitlab-webhook-secret").toString("base64")}`;
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
        const deliveryId = "gitlab-delivery-stale";
        const timestamp = "1700000000";
        const rawBody = JSON.stringify(gitLabPushPayload());
        const response = await fetch(`${baseUrl}/api/webhooks/git/gitlab`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": deliveryId,
            "webhook-timestamp": timestamp,
            "webhook-signature": signGitLabBody(rawBody, secret, deliveryId, timestamp),
            "x-gitlab-event": "Push Hook"
          },
          body: rawBody
        });
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body.message).toMatch(/signature verification failed/i);
      },
      { gitWebhookSecrets: { gitlab: secret } }
    );

    expect(ingestCalls).toBe(0);
  });

  it("fails closed when a provider webhook secret is not configured", async () => {
    let ingestCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      ingestGitWebhook: async (command: GitWebhookCommand): Promise<GitWebhookIngestReadModel> => {
        ingestCalls += 1;
        return fixtureRepository().ingestGitWebhook(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/git/gitlab`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": "gitlab-delivery-1",
          "webhook-timestamp": currentGitLabWebhookTimestamp(),
          "webhook-signature": "v1,invalid",
          "x-gitlab-event": "Push Hook"
        },
        body: JSON.stringify(gitLabPushPayload())
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({ message: "GitLab webhook secret is not configured." });
    });

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

  it("rejects production promotion commands without release evidence metadata", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
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

      expect(response.status).toBe(400);
      expect(body.message).toContain("releaseEvidence");
    }, { apiToken: "deploy-token" });
  });

  it("rejects production promotion commands with metadata-only release evidence", async () => {
    let promoteCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        promoteCalls += 1;
        return fixtureRepository().promoteDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-metadata-only",
          releaseEvidence: releaseEvidenceMetadata()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("release evidence bundle");
    }, { apiToken: "deploy-token" });

    expect(promoteCalls).toBe(0);
  });

  it("rejects production promotion commands when the release evidence bundle checker blocks", async () => {
    let promoteCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        promoteCalls += 1;
        return fixtureRepository().promoteDeployment(command);
      }
    };
    const blockedEvaluator: ReleaseEvidenceEvaluator = (rawEvidence, options) => ({
      ...passingReleaseEvidenceEvaluator()(rawEvidence, options),
      status: "blocked",
      checks: [
        {
          name: "bundle",
          status: "fail",
          message: "Bundle failed."
        }
      ],
      exitCode: 1
    });

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-blocked",
          releaseEvidence: releaseEvidenceRequest()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("did not pass");
      expect(body.message).toContain("bundle");
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: blockedEvaluator });

    expect(promoteCalls).toBe(0);
  });

  it("rejects production promotion commands with a passed bundle that is missing attestation metadata", async () => {
    let promoteCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        promoteCalls += 1;
        return fixtureRepository().promoteDeployment(command);
      }
    };
    const bundle = releaseEvidenceBundle();

    delete (bundle as Record<string, unknown>).attestation;

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-missing-attestation",
          releaseEvidence: {
            evidencePath: "evidence/release-evidence.json",
            bundle
          }
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("attestation");
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() });

    expect(promoteCalls).toBe(0);
  });

  it("rejects production promotion commands when the server has no release evidence signing key", async () => {
    let promoteCalls = 0;
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        promoteCalls += 1;
        return fixtureRepository().promoteDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-missing-signing-key",
          releaseEvidence: releaseEvidenceRequest()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY");
    }, {
      apiToken: "deploy-token",
      releaseEvidenceAttestationSigningKey: "",
      releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls)
    });

    expect(evaluatorCalls).toHaveLength(0);
    expect(promoteCalls).toBe(0);
  });

  it("rejects production promotion commands with a signed bundle that does not verify", async () => {
    let promoteCalls = 0;
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        promoteCalls += 1;
        return fixtureRepository().promoteDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-bad-signature",
          releaseEvidence: {
            evidencePath: "evidence/release-evidence.json",
            bundle: releaseEvidenceBundle({}, "different-release-evidence-signing-key")
          }
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("valid signature");
    }, {
      apiToken: "deploy-token",
      releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls)
    });

    expect(evaluatorCalls).toHaveLength(0);
    expect(promoteCalls).toBe(0);
  });

  it("rejects production promotion commands when the signed bundle key id is not the required key id", async () => {
    let promoteCalls = 0;
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        promoteCalls += 1;
        return fixtureRepository().promoteDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-wrong-key-id",
          releaseEvidence: releaseEvidenceRequest()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("valid signature");
    }, {
      apiToken: "deploy-token",
      releaseEvidenceRequiredAttestationKeyId: releaseEvidenceBundleAttestationKeyId("different-release-evidence-signing-key"),
      releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls)
    });

    expect(evaluatorCalls).toHaveLength(0);
    expect(promoteCalls).toBe(0);
  });

  it("accepts production promotion commands through the HTTP API with a checked release evidence bundle", async () => {
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];

    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-1",
          releaseEvidence: releaseEvidenceRequest()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.status).toBe("accepted");
    }, {
      apiToken: "deploy-token",
      releaseEvidenceRequiredAttestationKeyId: releaseEvidenceBundleAttestationKeyId(releaseEvidenceAttestationSigningKey),
      releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls)
    });

    expect(evaluatorCalls).toHaveLength(1);
    expect(evaluatorCalls[0]).toMatchObject({
      rawEvidence: expect.objectContaining({
        schemaVersion: "siteflow.releaseEvidence.v1",
        name: "siteflow-release-evidence-bundle",
        targetEnvironment: "production"
      }),
      evidencePath: "evidence/release-evidence.json"
    });
  });

  it("rejects production rollback commands without release evidence metadata", async () => {
    let rollbackCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      rollbackDeployment: async (command: RollbackDeploymentCommand): Promise<CommandResultReadModel> => {
        rollbackCalls += 1;
        return fixtureRepository().rollbackDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rollback/production/rollback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          currentDeploymentId: "dep-healthy",
          targetDeploymentId: "dep-acme-20260514-088",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "rollback",
          idempotencyKey: "rollback-no-evidence"
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("releaseEvidence");
    }, { apiToken: "deploy-token" });

    expect(rollbackCalls).toBe(0);
  });

  it("rejects production rollback commands with metadata-only release evidence", async () => {
    let rollbackCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      rollbackDeployment: async (command: RollbackDeploymentCommand): Promise<CommandResultReadModel> => {
        rollbackCalls += 1;
        return fixtureRepository().rollbackDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rollback/production/rollback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          currentDeploymentId: "dep-healthy",
          targetDeploymentId: "dep-acme-20260514-088",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "rollback",
          idempotencyKey: "rollback-metadata-only",
          releaseEvidence: releaseEvidenceMetadata()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("release evidence bundle");
    }, { apiToken: "deploy-token" });

    expect(rollbackCalls).toBe(0);
  });

  it("rejects production rollback commands when the release evidence bundle checker blocks", async () => {
    let rollbackCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      rollbackDeployment: async (command: RollbackDeploymentCommand): Promise<CommandResultReadModel> => {
        rollbackCalls += 1;
        return fixtureRepository().rollbackDeployment(command);
      }
    };
    const blockedEvaluator: ReleaseEvidenceEvaluator = (rawEvidence, options) => ({
      ...passingReleaseEvidenceEvaluator()(rawEvidence, options),
      status: "blocked",
      checks: [
        {
          name: "bundle",
          status: "fail",
          message: "Bundle failed."
        }
      ],
      exitCode: 1
    });

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rollback/production/rollback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          currentDeploymentId: "dep-healthy",
          targetDeploymentId: "dep-acme-20260514-088",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "rollback",
          idempotencyKey: "rollback-blocked",
          releaseEvidence: releaseEvidenceRequest()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("did not pass");
      expect(body.message).toContain("bundle");
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: blockedEvaluator });

    expect(rollbackCalls).toBe(0);
  });

  it("accepts production rollback commands through the HTTP API with a checked release evidence bundle", async () => {
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];
    let receivedCommand: RollbackDeploymentCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      rollbackDeployment: async (command: RollbackDeploymentCommand): Promise<CommandResultReadModel> => {
        receivedCommand = command;
        return fixtureRepository().rollbackDeployment(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rollback/production/rollback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "production",
          currentDeploymentId: "dep-healthy",
          targetDeploymentId: "dep-acme-20260514-088",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "rollback",
          idempotencyKey: "rollback-with-evidence",
          releaseEvidence: releaseEvidenceRequest()
        })
      });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.status).toBe("accepted");
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls) });

    expect(evaluatorCalls).toHaveLength(1);
    expect(receivedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      targetDeploymentId: "dep-acme-20260514-088",
      releaseEvidence: expect.objectContaining({
        evidencePath: "evidence/release-evidence.json",
        status: "passed",
        payloadDigest: `sha256:${"d".repeat(64)}`,
        commitRef: "abc123def4567890",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production"
      })
    });
  });

  it("allows non-production promotion commands without release evidence metadata", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/staging/promote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "staging",
          targetDeploymentId: "dep-healthy",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "stage",
          idempotencyKey: "idem-staging"
        })
      });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.status).toBe("accepted");
    }, { apiToken: "deploy-token" });
  });

  it("strips release evidence bundle requests from non-production promotion commands", async () => {
    let receivedCommand: PromoteDeploymentCommand | undefined;
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        receivedCommand = command;
        return fixtureRepository().promoteDeployment(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/staging/promote`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectId: "project-acme-dashboard",
            channel: "staging",
            targetDeploymentId: "dep-healthy",
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "stage",
            idempotencyKey: "idem-staging-evidence",
            releaseEvidence: releaseEvidenceRequest()
          })
        });

        expect(response.status).toBe(202);
      },
      { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls) }
    );

    expect(evaluatorCalls).toHaveLength(0);
    expect(receivedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "staging",
      targetDeploymentId: "dep-healthy"
    });
    expect(receivedCommand).not.toHaveProperty("releaseEvidence");
  });

  it("allows non-production rollback commands without release evidence metadata", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rollback/staging/rollback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-acme-dashboard",
          channel: "staging",
          currentDeploymentId: "dep-healthy",
          targetDeploymentId: "dep-acme-20260514-088",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "rollback",
          idempotencyKey: "rollback-staging"
        })
      });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.status).toBe("accepted");
    }, { apiToken: "deploy-token" });
  });

  it("strips release evidence bundle requests from non-production rollback commands", async () => {
    let receivedCommand: RollbackDeploymentCommand | undefined;
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      rollbackDeployment: async (command: RollbackDeploymentCommand): Promise<CommandResultReadModel> => {
        receivedCommand = command;
        return fixtureRepository().rollbackDeployment(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rollback/staging/rollback`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            projectId: "project-acme-dashboard",
            channel: "staging",
            currentDeploymentId: "dep-healthy",
            targetDeploymentId: "dep-acme-20260514-088",
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "rollback",
            idempotencyKey: "rollback-staging-evidence",
            releaseEvidence: releaseEvidenceRequest()
          })
        });

        expect(response.status).toBe(202);
      },
      { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls) }
    );

    expect(evaluatorCalls).toHaveLength(0);
    expect(receivedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "staging",
      targetDeploymentId: "dep-acme-20260514-088"
    });
    expect(receivedCommand).not.toHaveProperty("releaseEvidence");
  });

  it("strips release evidence bundle requests from non-production rolling commands", async () => {
    let receivedCommand: StartRollingReleaseCommand | undefined;
    const evaluatorCalls: Array<{ rawEvidence: unknown; evidencePath: string }> = [];
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      startRollingRelease: async (command: StartRollingReleaseCommand): Promise<RollingReleaseCommandReadModel> => {
        receivedCommand = command;
        return fixtureRepository().startRollingRelease(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/staging/start`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            candidateDeploymentId: "dep-canary",
            percentage: 10,
            reason: "canary",
            idempotencyKey: "rollout-staging-start",
            releaseEvidence: releaseEvidenceRequest()
          })
        });

        expect(response.status).toBe(202);
      },
      { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator(evaluatorCalls) }
    );

    expect(evaluatorCalls).toHaveLength(0);
    expect(receivedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "staging",
      candidateDeploymentId: "dep-canary"
    });
    expect(receivedCommand).not.toHaveProperty("releaseEvidence");
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
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectId: "project-other",
          channel: "preview",
          targetDeploymentId: "dep-healthy",
          actor: { id: "client-spoof", name: "Spoofed Client", role: "operator" },
          reason: "ship",
          idempotencyKey: "idem-url-source",
          releaseEvidence: releaseEvidenceRequest()
        })
      });

      expect(response.status).toBe(202);
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() });

    expect(receivedCommand).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      targetDeploymentId: "dep-healthy",
      actor: {
        id: "siteflow:server",
        name: "SiteFlow server",
        role: "system"
      }
    });
    expect(receivedCommand?.actor.id).not.toBe("client-spoof");
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
            idempotencyKey: "rollout-start",
            releaseEvidence: releaseEvidenceRequest()
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
            idempotencyKey: "rollout-advance",
            releaseEvidence: releaseEvidenceRequest()
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
            idempotencyKey: "rollout-complete",
            releaseEvidence: releaseEvidenceRequest()
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
      { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() }
    );

    expect(received.start).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      candidateDeploymentId: "dep-canary",
      percentage: 10,
      releaseEvidence: expect.objectContaining({
        status: "passed",
        commitRef: "abc123def4567890"
      })
    });
    expect(received.advance).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      percentage: 50,
      releaseEvidence: expect.objectContaining({
        status: "passed",
        commitRef: "abc123def4567890"
      })
    });
    expect(received.complete).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      releaseEvidence: expect.objectContaining({
        status: "passed",
        commitRef: "abc123def4567890"
      })
    });
    expect(received.abort).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      reason: "stop",
      releaseEvidenceException: {
        type: "production_rolling_abort_stop_rollout",
        targetEnvironment: "production",
        acceptedWithoutReleaseEvidence: true,
        reason: "stop"
      }
    });
    expect(received.abort).not.toHaveProperty("releaseEvidence");
  });

  it("rejects production rolling release changes without release evidence metadata except abort", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        };
        const start = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/start`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            candidateDeploymentId: "dep-canary",
            percentage: 10,
            reason: "canary",
            idempotencyKey: "rollout-start"
          })
        });
        const complete = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/complete`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            reason: "ship",
            idempotencyKey: "rollout-complete"
          })
        });
        const abort = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/abort`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            reason: "stop",
            idempotencyKey: "rollout-abort"
          })
        });
        const abortWithoutReason = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/abort`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            idempotencyKey: "rollout-abort-no-reason"
          })
        });
        const startBody = await start.json();
        const completeBody = await complete.json();
        const abortWithoutReasonBody = await abortWithoutReason.json();

        expect(start.status).toBe(400);
        expect(startBody.message).toContain("releaseEvidence");
        expect(complete.status).toBe(400);
        expect(completeBody.message).toContain("releaseEvidence");
        expect(abort.status).toBe(202);
        expect(abortWithoutReason.status).toBe(400);
        expect(abortWithoutReasonBody.message).toContain("audit reason");
      },
      { apiToken: "deploy-token" }
    );
  });

  it("rejects production rolling abort requests that include release evidence", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/rolling/production/abort`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
          body: JSON.stringify({
            reason: "stop",
            idempotencyKey: "rollout-abort-with-evidence",
            releaseEvidence: releaseEvidenceRequest()
          })
        });
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.message).toContain("must not include releaseEvidence");
      },
      { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() }
    );
  });

  it("accepts prebuilt deploy uploads through the HTTP API", async () => {
    await withServer(fixtureRepository(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
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
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.previewUrl).toBe("https://abc123.w33d.xyz");
    }, { apiToken: "deploy-token" });
  });

  it("rejects prebuilt deploy uploads that self-declare source without release evidence", async () => {
    let deployPrebuiltCalled = false;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        deployPrebuiltCalled = true;
        return fixtureRepository().deployPrebuilt(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          source: {
            repository: "acme/siteflow",
            branch: "main",
            commitSha: "abc123def4567890"
          },
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

      expect(response.status).toBe(400);
      expect(body.message).toContain("Prebuilt deploy source requires checked releaseEvidence metadata");
    }, { apiToken: "deploy-token" });

    expect(deployPrebuiltCalled).toBe(false);
  });

  it("rejects prebuilt deploy uploads that exceed the configured upload byte budget before repository writes", async () => {
    let deployPrebuiltCalled = false;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        deployPrebuiltCalled = true;
        return fixtureRepository().deployPrebuilt(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
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
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.message).toContain("SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES");
      expect(body.message).toContain("14 > 4");
    }, { apiToken: "deploy-token", prebuiltMaxUploadBytes: 4 });

    expect(deployPrebuiltCalled).toBe(false);
  });

  it("rejects malformed prebuilt deploy upload file sizes as bad requests", async () => {
    let deployPrebuiltCalled = false;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        deployPrebuiltCalled = true;
        return fixtureRepository().deployPrebuilt(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
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
              size: 999,
              sha256: "unused-by-fixture"
            }
          ]
        })
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.message).toContain("size does not match decoded content");
    }, { apiToken: "deploy-token" });

    expect(deployPrebuiltCalled).toBe(false);
  });

  it("validates and forwards release evidence metadata from checked bundles on prebuilt deploy uploads", async () => {
    let receivedCommand: PrebuiltDeployCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        receivedCommand = command;
        return fixtureRepository().deployPrebuilt(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          source: {
            repository: "acme/siteflow",
            branch: "main",
            commitSha: "abc123def4567890"
          },
          releaseEvidence: releaseEvidenceRequest(),
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

      expect(response.status).toBe(201);
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() });

    expect(receivedCommand).toMatchObject({
      projectSlug: "docs",
      source: {
        repository: "acme/siteflow",
        branch: "main",
        commitSha: "abc123def4567890"
      },
      releaseEvidence: expect.objectContaining({
        status: "passed",
        commitRef: "abc123def4567890",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production"
      })
    });
  });

  it("derives prebuilt deploy source from checked release evidence metadata", async () => {
    let receivedCommand: PrebuiltDeployCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        receivedCommand = command;
        return fixtureRepository().deployPrebuilt(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          releaseEvidence: releaseEvidenceRequest(),
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

      expect(response.status).toBe(201);
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() });

    expect(receivedCommand?.source).toEqual({
      repository: "acme/siteflow",
      branch: "main",
      commitSha: "abc123def4567890"
    });
  });

  it("rejects prebuilt deploy source that conflicts with checked release evidence metadata", async () => {
    let deployPrebuiltCalled = false;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        deployPrebuiltCalled = true;
        return fixtureRepository().deployPrebuilt(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          source: {
            repository: "acme/siteflow",
            branch: "main",
            commitSha: "different-commit"
          },
          releaseEvidence: releaseEvidenceRequest(),
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

      expect(response.status).toBe(400);
      expect(body.message).toContain("Prebuilt deploy source must match release evidence metadata: commitSha");
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() });

    expect(deployPrebuiltCalled).toBe(false);
  });

  it("rejects release evidence bundles that fail checking on prebuilt deploy uploads", async () => {
    let deployPrebuiltCalled = false;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        deployPrebuiltCalled = true;
        return fixtureRepository().deployPrebuilt(command);
      }
    };
    const blockedEvaluator: ReleaseEvidenceEvaluator = (rawEvidence, options) => ({
      ...passingReleaseEvidenceEvaluator()(rawEvidence, options),
      status: "blocked",
      checks: [
        {
          name: "bundle_checked_at",
          status: "fail",
          message: "Bundle is stale."
        }
      ],
      exitCode: 1
    });

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deploy-token"
        },
        body: JSON.stringify({
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          releaseEvidence: releaseEvidenceRequest(),
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

      expect(response.status).toBe(400);
      expect(body.message).toContain("did not pass");
      expect(body.message).toContain("bundle_checked_at");
    }, { apiToken: "deploy-token", releaseEvidenceEvaluator: blockedEvaluator });

    expect(deployPrebuiltCalled).toBe(false);
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
          headers: {
            "content-type": "application/json",
            authorization: "Bearer deploy-token"
          },
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
      { baseDomain: "w33d.xyz", apiToken: "deploy-token" }
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

  it("creates operator sessions and accepts cookie auth for sensitive reads", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json",
            "x-forwarded-proto": "https"
          },
          body: JSON.stringify({
            subject: "ops@example.com",
            scopes: ["read"],
            ttlSeconds: 600
          })
        });
        const createdBody = await created.json() as {
          status: "created";
          session: OperatorSession;
          message: string;
          secret?: unknown;
        };
        const setCookie = created.headers.get("set-cookie") ?? "";
        const cookie = setCookie.split(";")[0];
        const cookieSecret = decodeURIComponent(cookie.replace(/^siteflow_session=/, ""));

        expect(created.status).toBe(201);
        expect(createdBody.status).toBe("created");
        expect(createdBody.secret).toBeUndefined();
        expect(cookieSecret).toMatch(/^sfs_/);
        expect(createdBody.session).toMatchObject({
          subject: "ops@example.com",
          tokenPrefix: cookieSecret.slice(0, 12),
          scopes: ["read"],
          status: "active"
        });
        expect(JSON.stringify(createdBody)).not.toContain(cookieSecret);
        expect(JSON.stringify(createdBody)).not.toContain("token_hash");
        expect(setCookie).toContain("siteflow_session=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).toContain("Path=/");
        expect(setCookie).toContain("Max-Age=600");
        expect(setCookie).toContain("Secure");

        const projects = await fetch(`${baseUrl}/api/projects`, {
          headers: { cookie }
        });
        expect(projects.status).toBe(200);

        const deniedWrite = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "Docs",
            slug: "docs"
          })
        });
        const deniedWriteBody = await deniedWrite.json();

        expect(deniedWrite.status).toBe(403);
        expect(deniedWriteBody).toEqual({ message: "SiteFlow operator session does not include admin permission." });
      },
      { apiToken: "deploy-token" }
    );
  });

  it("rotates operator session cookies and rejects the old cookie", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: "rotate@example.com",
            scopes: ["read"],
            ttlSeconds: 900
          })
        });
        const oldCookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
        const oldSecret = decodeURIComponent(oldCookie.replace(/^siteflow_session=/, ""));

        const rotated = await fetch(`${baseUrl}/api/auth/session/rotate`, {
          method: "POST",
          headers: {
            cookie: oldCookie,
            "x-siteflow-csrf": "same-origin"
          }
        });
        const rotatedBody = await rotated.json() as {
          status: "rotated";
          session: OperatorSession;
          message: string;
          secret?: unknown;
        };
        const setCookie = rotated.headers.get("set-cookie") ?? "";
        const newCookie = setCookie.split(";")[0];
        const newSecret = decodeURIComponent(newCookie.replace(/^siteflow_session=/, ""));

        expect(rotated.status).toBe(200);
        expect(rotatedBody.status).toBe("rotated");
        expect(rotatedBody.secret).toBeUndefined();
        expect(rotatedBody.session).toMatchObject({
          subject: "rotate@example.com",
          tokenPrefix: newSecret.slice(0, 12),
          scopes: ["read"],
          status: "active"
        });
        expect(newSecret).toMatch(/^sfs_/);
        expect(newSecret).not.toBe(oldSecret);
        expect(JSON.stringify(rotatedBody)).not.toContain(oldSecret);
        expect(JSON.stringify(rotatedBody)).not.toContain(newSecret);
        expect(JSON.stringify(rotatedBody)).not.toContain("token_hash");
        expect(setCookie).toContain("siteflow_session=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).toContain("Path=/");
        expect(setCookie).toContain("Max-Age=900");

        const withNewCookie = await fetch(`${baseUrl}/api/projects`, {
          headers: { cookie: newCookie }
        });
        const withOldCookie = await fetch(`${baseUrl}/api/projects`, {
          headers: { cookie: oldCookie }
        });

        expect(withNewCookie.status).toBe(200);
        expect(withOldCookie.status).toBe(401);
        expect(await withOldCookie.json()).toEqual({ message: "SiteFlow operator session is invalid or expired." });
      },
      { apiToken: "deploy-token" }
    );
  });

  it("requires CSRF protection before rotating operator sessions", async () => {
    let rotateCalls = 0;
    const baseRepository = fixtureRepository();
    const repository: SiteFlowReadRepository = {
      ...baseRepository,
      rotateOperatorSession: async (token: string) => {
        rotateCalls += 1;
        return baseRepository.rotateOperatorSession(token);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: "csrf-rotate@example.com",
            scopes: ["read"],
            ttlSeconds: 900
          })
        });
        const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
        const response = await fetch(`${baseUrl}/api/auth/session/rotate`, {
          method: "POST",
          headers: { cookie }
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ message: "SiteFlow operator session writes require a same-origin CSRF header." });
        expect(rotateCalls).toBe(0);
      },
      { apiToken: "deploy-token" }
    );
  });

  it("does not rotate operator sessions from bearer-only requests", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/session/rotate`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "x-siteflow-csrf": "same-origin"
          }
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ message: "SiteFlow operator session is required." });
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      },
      { apiToken: "deploy-token" }
    );
  });

  it("forces secure operator session cookies when configured", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: "secure-cookie@example.com",
            scopes: ["read"],
            ttlSeconds: 600
          })
        });
        const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
        const revoked = await fetch(`${baseUrl}/api/auth/session`, {
          method: "DELETE",
          headers: {
            cookie,
            "x-siteflow-csrf": "same-origin"
          }
        });

        expect(created.status).toBe(201);
        expect(created.headers.get("set-cookie")).toContain("Secure");
        expect(revoked.status).toBe(200);
        expect(revoked.headers.get("set-cookie")).toContain("Secure");
      },
      { apiToken: "deploy-token", secureCookies: true }
    );
  });

  it("ignores X-Forwarded-Proto for session cookie security unless trusted proxy mode is enabled", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const untrustedForwardedProto = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json",
            "x-forwarded-proto": "https"
          },
          body: JSON.stringify({
            subject: "untrusted-proxy@example.com",
            scopes: ["read"],
            ttlSeconds: 600
          })
        });
        expect(untrustedForwardedProto.status).toBe(201);
        expect(untrustedForwardedProto.headers.get("set-cookie")).not.toContain("Secure");
      },
      { apiToken: "deploy-token", trustProxy: false }
    );

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json",
            "x-forwarded-proto": "https"
          },
          body: JSON.stringify({
            subject: "trusted-proxy@example.com",
            scopes: ["read"],
            ttlSeconds: 600
          })
        });

        expect(response.status).toBe(201);
        expect(response.headers.get("set-cookie")).toContain("Secure");
      },
      { apiToken: "deploy-token", trustProxy: "loopback" }
    );
  });

  it("limits operator session permissions to configured project ids", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: "scoped@example.com",
            scopes: ["read", "write"],
            projectIds: ["project-acme-dashboard", "project-acme-dashboard"],
            ttlSeconds: 900
          })
        });
        const createdBody = await created.json() as {
          status: "created";
          session: OperatorSession;
          message: string;
          secret?: unknown;
        };
        const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];

        expect(created.status).toBe(201);
        expect(createdBody.secret).toBeUndefined();
        expect(createdBody.session).toMatchObject({
          subject: "scoped@example.com",
          scopes: ["read", "write"],
          projectIds: ["project-acme-dashboard"]
        });

        const allowedProject = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/settings`, {
          headers: { cookie }
        });
        const deniedGlobalProjects = await fetch(`${baseUrl}/api/projects`, {
          headers: { cookie }
        });
        const deniedProject = await fetch(`${baseUrl}/api/projects/project-other/settings`, {
          headers: { cookie }
        });
        const deniedGlobalBody = await deniedGlobalProjects.json();
        const deniedBody = await deniedProject.json();

        expect(allowedProject.status).toBe(200);
        expect(deniedGlobalProjects.status).toBe(403);
        expect(deniedGlobalBody).toEqual({ message: "SiteFlow operator session does not include read permission." });
        expect(deniedProject.status).toBe(403);
        expect(deniedBody).toEqual({ message: "SiteFlow operator session does not include read permission." });
      },
      { apiToken: "deploy-token" }
    );
  });

  it("treats operator sessions without project ids as global sessions for project routes", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: "global@example.com",
            scopes: ["read"],
            ttlSeconds: 900
          })
        });
        const createdBody = await created.json() as {
          status: "created";
          session: OperatorSession;
          message: string;
          secret?: unknown;
        };
        const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
        const settings = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/settings`, {
          headers: { cookie }
        });
        const settingsBody = await settings.json();

        expect(created.status).toBe(201);
        expect(createdBody.secret).toBeUndefined();
        expect(createdBody.session.projectIds).toBeUndefined();
        expect(settings.status).toBe(200);
        expect(settingsBody.currentPermissions).toEqual(["read"]);
        expect(settingsBody.currentPermissions).not.toContain("write");
        expect(settingsBody.currentPermissions).not.toContain("admin");
      },
      { apiToken: "deploy-token" }
    );
  });

  it("requires same-origin CSRF headers for cookie-authenticated writes", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: "ops@example.com",
            scopes: ["read", "write", "admin"],
            ttlSeconds: 900
          })
        });
        const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];

        const rejectedWrite = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "Docs",
            slug: "docs"
          })
        });
        const rejectedBody = await rejectedWrite.json();

        expect(rejectedWrite.status).toBe(403);
        expect(rejectedBody).toEqual({ message: "SiteFlow operator session writes require a same-origin CSRF header." });

        const acceptedWrite = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "x-siteflow-csrf": "same-origin"
          },
          body: JSON.stringify({
            name: "Docs",
            slug: "docs"
          })
        });

        expect(acceptedWrite.status).toBe(201);
      },
      { apiToken: "deploy-token" }
    );
  });

  it("uses operator session actor for cookie-authenticated writes instead of body actor", async () => {
    let receivedCommand: PromoteDeploymentCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        receivedCommand = command;
        return fixtureRepository().promoteDeployment(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/release/production/promote`, {
          method: "POST",
          headers: {
            cookie: "siteflow_session=session-admin-token",
            "content-type": "application/json",
            "x-siteflow-csrf": "same-origin"
          },
          body: JSON.stringify({
            targetDeploymentId: "dep-healthy",
            actor: { id: "client-spoof", name: "Spoofed Client", role: "operator" },
            reason: "ship",
            idempotencyKey: "idem-session-actor",
            releaseEvidence: releaseEvidenceRequest()
          })
        });

        expect(response.status).toBe(202);
      },
      { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() }
    );

    expect(receivedCommand?.actor).toEqual({
      id: "session-operator",
      name: "Session Operator",
      role: "operator"
    });
    expect(receivedCommand?.actor.id).not.toBe("client-spoof");
  });

  it("revokes operator session cookies and rejects expired sessions", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            authorization: "Bearer deploy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: "ops@example.com",
            scopes: ["read", "write", "admin"],
            ttlSeconds: 900
          })
        });
        const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];
        const revoked = await fetch(`${baseUrl}/api/auth/session`, {
          method: "DELETE",
          headers: {
            cookie,
            "x-siteflow-csrf": "same-origin"
          }
        });
        const revokedBody = await revoked.json() as OperatorSessionRevokeReadModel;
        const clearedCookie = revoked.headers.get("set-cookie") ?? "";

        expect(revoked.status).toBe(200);
        expect(revokedBody.status).toBe("revoked");
        expect(clearedCookie).toContain("siteflow_session=");
        expect(clearedCookie).toContain("Max-Age=0");

        const afterRevoke = await fetch(`${baseUrl}/api/projects`, {
          headers: { cookie }
        });
        const expired = await fetch(`${baseUrl}/api/projects`, {
          headers: { cookie: "siteflow_session=expired-session-token" }
        });

        expect(afterRevoke.status).toBe(401);
        expect(await afterRevoke.json()).toEqual({ message: "SiteFlow operator session is invalid or expired." });
        expect(expired.status).toBe(401);
        const expiredBody = await expired.json();
        expect(expiredBody).toEqual({ message: "SiteFlow operator session is invalid or expired." });
        expect(JSON.stringify(expiredBody)).not.toContain("expired-session-token");
      },
      { apiToken: "deploy-token" }
    );
  });

  it("rejects idle-expired operator sessions during auth verification", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            cookie: "siteflow_session=expired-session-token"
          }
        });
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body).toEqual({ message: "SiteFlow operator session is invalid or expired." });
        expect(JSON.stringify(body)).not.toContain("expired-session-token");
      },
      { apiToken: "deploy-token" }
    );
  });

  it("keeps bearer token authorization ahead of operator session cookies", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/routing-rules`, {
          method: "PUT",
          headers: {
            authorization: "Bearer read-token",
            cookie: "siteflow_session=session-admin-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "Legacy docs",
            kind: "redirect",
            source: "/legacy-docs",
            destination: "/docs",
            statusCode: 308
          })
        });
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body).toEqual({ message: "SiteFlow API token does not include admin permission." });
      },
      { apiToken: "deploy-token" }
    );
  });

  it("rejects cookie-only operator session revoke-all requests", async () => {
    let revokeAllCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      revokeAllOperatorSessions: async (command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel> => {
        revokeAllCalls += 1;
        return fixtureRepository().revokeAllOperatorSessions(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/sessions/revoke-all`, {
          method: "POST",
          headers: {
            cookie: "siteflow_session=session-admin-token",
            "content-type": "application/json",
            "x-siteflow-csrf": "same-origin"
          },
          body: JSON.stringify({ reason: "stolen browser cookie" })
        });
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body).toEqual({ message: "SiteFlow API token is required." });
      },
      { apiToken: "deploy-token" }
    );

    expect(revokeAllCalls).toBe(0);
  });

  it("does not fall back to admin cookies when a revoke-all bearer token lacks admin scope", async () => {
    let revokeAllCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      revokeAllOperatorSessions: async (command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel> => {
        revokeAllCalls += 1;
        return fixtureRepository().revokeAllOperatorSessions(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/sessions/revoke-all`, {
          method: "POST",
          headers: {
            authorization: "Bearer read-token",
            cookie: "siteflow_session=session-admin-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({ reason: "bad bearer must win" })
        });
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body).toEqual({ message: "SiteFlow API token does not include admin permission." });
      },
      { apiToken: "deploy-token" }
    );

    expect(revokeAllCalls).toBe(0);
  });

  it("revokes all operator sessions from a global admin bearer token", async () => {
    let receivedCommand: RevokeAllOperatorSessionsCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      revokeAllOperatorSessions: async (command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel> => {
        receivedCommand = command;
        return fixtureRepository().revokeAllOperatorSessions(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/sessions/revoke-all`, {
          method: "POST",
          headers: {
            authorization: "Bearer admin-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            actor: { id: "client-spoof", name: "Spoofed Client", role: "operator" },
            requestedBy: { id: "client-requested-by", name: "Client Requested By", role: "operator" },
            reason: "operator laptop lost"
          })
        });
        const body = await response.json() as OperatorSessionRevokeAllReadModel;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          status: "revoked",
          scope: "global",
          revokedAt: "2026-06-07T00:40:00.000Z",
          message: "All existing operator sessions were revoked."
        });
        expect(body.cutoffId).toMatch(/^sessioncutoff_fixture_/);
      },
      { apiToken: "deploy-token" }
    );

    expect(receivedCommand).toEqual({
      actor: {
        id: "api-token:token-admin-token",
        name: "admin-token fixture",
        role: "system"
      },
      reason: "operator laptop lost"
    });
  });

  it("revokes project operator sessions from a project admin bearer token", async () => {
    let receivedCommand: RevokeAllOperatorSessionsCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      revokeAllOperatorSessions: async (command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel> => {
        receivedCommand = command;
        return fixtureRepository().revokeAllOperatorSessions(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects/project-acme-dashboard/auth/sessions/revoke-all`, {
          method: "POST",
          headers: {
            authorization: "Bearer project-admin-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({ reason: "project incident" })
        });
        const body = await response.json() as OperatorSessionRevokeAllReadModel;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          status: "revoked",
          scope: "project",
          projectId: "project-acme-dashboard",
          revokedAt: "2026-06-07T00:40:00.000Z",
          message: "Project operator sessions were revoked."
        });
        expect(body.cutoffId).toMatch(/^sessioncutoff_fixture_/);
      },
      { apiToken: "deploy-token" }
    );

    expect(receivedCommand).toEqual({
      projectId: "project-acme-dashboard",
      actor: {
        id: "token-project-admin",
        name: "Project admin token",
        role: "operator"
      },
      reason: "project incident"
    });
  });

  it("rejects project-scoped admin bearer tokens for global revoke-all", async () => {
    let revokeAllCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      revokeAllOperatorSessions: async (command: RevokeAllOperatorSessionsCommand): Promise<OperatorSessionRevokeAllReadModel> => {
        revokeAllCalls += 1;
        return fixtureRepository().revokeAllOperatorSessions(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/sessions/revoke-all`, {
          method: "POST",
          headers: {
            authorization: "Bearer project-admin-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({ reason: "global needs global admin" })
        });
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body).toEqual({ message: "SiteFlow API token does not include admin permission." });
      },
      { apiToken: "deploy-token" }
    );

    expect(revokeAllCalls).toBe(0);
  });

  it("fails closed for mutating endpoints when the API token is not configured", async () => {
    let deployCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      deployPrebuilt: async (command: PrebuiltDeployCommand): Promise<PrebuiltDeployResult> => {
        deployCalls += 1;
        return fixtureRepository().deployPrebuilt(command);
      }
    };

    await withServer(repository, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectSlug: "docs",
          baseDomain: "w33d.xyz",
          files: []
        })
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({ message: "SiteFlow API token is not configured." });
    });

    expect(deployCalls).toBe(0);
  });

  it("rejects unauthenticated sensitive read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const paths = [
          "/api/projects",
          "/api/projects/project-acme-dashboard",
          "/api/projects/project-acme-dashboard/release/production",
          "/api/projects/project-acme-dashboard/rollback/production",
          "/api/deployments?projectId=project-acme-dashboard",
          "/api/deployments/dep-healthy",
          "/api/deployments/dep-healthy/logs",
          "/api/operations/op-healthy-promote"
        ];

        for (const path of paths) {
          const response = await fetch(`${baseUrl}${path}`);
          const body = await response.json();

          expect(response.status).toBe(401);
          expect(body).toEqual({ message: "SiteFlow API token is required." });
        }
      },
      { apiToken: "deploy-token" }
    );
  });

  it("allows read-scoped tokens to access sensitive read endpoints", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const headers = { authorization: "Bearer read-token" };
        const paths = [
          "/api/projects",
          "/api/projects/project-acme-dashboard",
          "/api/projects/project-acme-dashboard/environments",
          "/api/projects/project-acme-dashboard/logs?source=build",
          "/api/projects/project-acme-dashboard/release/production",
          "/api/projects/project-acme-dashboard/rollback/production",
          "/api/deployments?projectId=project-acme-dashboard",
          "/api/deployments/dep-healthy",
          "/api/deployments/dep-healthy/logs",
          "/api/operations/op-healthy-promote"
        ];

        for (const path of paths) {
          const response = await fetch(`${baseUrl}${path}`, { headers });

          expect(response.status).toBe(200);
        }
      },
      { apiToken: "deploy-token" }
    );
  });

  it("uses a production stdout request logger that emits NDJSON fields", () => {
    const loggedLines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      loggedLines.push(String(line));
    });

    try {
      expect(createDefaultRequestLogger("2.3.4", { NODE_ENV: "production" })).toEqual(expect.any(Function));
      expect(createDefaultRequestLogger("2.3.4", { NODE_ENV: "test" })).toBeUndefined();

      const logger = createStdoutRequestLogger("2.3.4");

      logger({
        requestId: "req_observability",
        method: "GET",
        path: "/api/projects",
        status: 200,
        durationMs: 7
      });

      logger({
        requestId: "req_observability_error",
        method: "POST",
        path: "/api/deploy-hooks/[token]/trigger",
        status: 503,
        durationMs: 11,
        errorClass: "ExpectedHttpError",
        query: `token=${SITEFLOW_SECRET_CANARY}`,
        headers: { authorization: "Bearer deploy-token" },
        body: { token: SITEFLOW_SECRET_CANARY }
      } as SiteFlowRequestLogEntry & Record<string, unknown>);
    } finally {
      logSpy.mockRestore();
    }

    expect(loggedLines).toHaveLength(2);

    const successLog = JSON.parse(loggedLines[0]) as Record<string, unknown>;
    const errorLog = JSON.parse(loggedLines[1]) as Record<string, unknown>;

    expect(successLog).toEqual({
      event: "siteflow.request",
      service: "siteflow-control-plane",
      version: "2.3.4",
      requestId: "req_observability",
      method: "GET",
      path: "/api/projects",
      status: 200,
      durationMs: 7,
      errorClass: null
    });
    expect(errorLog).toMatchObject({
      event: "siteflow.request",
      service: "siteflow-control-plane",
      version: "2.3.4",
      requestId: "req_observability_error",
      method: "POST",
      path: "/api/deploy-hooks/[token]/trigger",
      status: 503,
      durationMs: 11,
      errorClass: "ExpectedHttpError"
    });
    expect(Object.keys(errorLog).sort()).toEqual([
      "durationMs",
      "errorClass",
      "event",
      "method",
      "path",
      "requestId",
      "service",
      "status",
      "version"
    ]);
    expect(loggedLines.every((line) => JSON.parse(line))).toBe(true);
    expect(loggedLines.join("\n")).not.toContain(SITEFLOW_SECRET_CANARY);
    expect(loggedLines.join("\n")).not.toContain("authorization");
    expect(loggedLines.join("\n")).not.toContain("deploy-token");
  });

  it("defaults secure operator session cookies only for production runtimes", () => {
    expect(defaultSecureCookies({ NODE_ENV: "production" })).toBe(true);
    expect(defaultSecureCookies({ SITEFLOW_ENV: "production" })).toBe(true);
    expect(defaultSecureCookies({ NODE_ENV: "test", SITEFLOW_ENV: "staging" })).toBe(false);
    expect(defaultSecureCookies({})).toBe(false);
  });

  it("enables same-process function runtime only with an explicit production exception", () => {
    expect(defaultAllowSameProcessFunctionRuntime({})).toBe(false);
    expect(defaultAllowSameProcessFunctionRuntime({ SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME: "0" })).toBe(false);
    expect(defaultAllowSameProcessFunctionRuntime({ SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME: "false" })).toBe(false);
    expect(defaultAllowSameProcessFunctionRuntime({ SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME: "1" })).toBe(true);
    expect(defaultAllowSameProcessFunctionRuntime({ SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME: "true" })).toBe(true);
    expect(defaultAllowSameProcessFunctionRuntime({ SITEFLOW_ALLOW_SAME_PROCESS_FUNCTION_RUNTIME: "yes" })).toBe(true);
  });

  it("trusts forwarded proxy headers only when explicitly configured", () => {
    expect(defaultTrustProxy({})).toBeUndefined();
    expect(defaultTrustProxy({ NODE_ENV: "production" })).toBeUndefined();
    expect(defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "1" })).toBe("loopback");
    expect(defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "true" })).toBe("loopback");
    expect(defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "loopback" })).toBe("loopback");
    expect(defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "private" })).toBe("private");
    expect(defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "192.168.1.10" })).toEqual(["192.168.1.10"]);
    expect(defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "10.0.0.0/8,192.168.1.10" })).toEqual(["10.0.0.0/8", "192.168.1.10"]);
    expect(defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "0" })).toBeUndefined();
    expect(() => defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "not-a-cidr" })).toThrow("SITEFLOW_TRUST_PROXY");
    expect(() => defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "10.0.0.0/64" })).toThrow("SITEFLOW_TRUST_PROXY");
    expect(() => defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "0.0.0.0/0" })).toThrow("SITEFLOW_TRUST_PROXY");
    expect(() => defaultTrustProxy({ SITEFLOW_TRUST_PROXY: "::/0" })).toThrow("SITEFLOW_TRUST_PROXY");
  });

  it("parses configured git webhook provider secrets from environment", () => {
    expect(gitWebhookSecretsFromEnv({
      SITEFLOW_GITHUB_WEBHOOK_SECRET: " github-secret ",
      SITEFLOW_GITLAB_WEBHOOK_SECRET: "gitlab-secret",
      SITEFLOW_GITEA_WEBHOOK_SECRET: "gitea-secret",
      SITEFLOW_GENERIC_WEBHOOK_SECRET: "generic-secret"
    })).toEqual({
      github: "github-secret",
      gitlab: "gitlab-secret",
      gitea: "gitea-secret",
      generic: "generic-secret"
    });
    expect(gitWebhookSecretsFromEnv({})).toEqual({
      github: undefined,
      gitlab: undefined,
      gitea: undefined,
      generic: undefined
    });
  });

  it("reads server startup bearer and webhook secrets from *_FILE fallbacks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-server-secret-file-"));

    try {
      const apiTokenPath = path.join(tempDir, "api-token");
      const metricsTokenPath = path.join(tempDir, "metrics-token");
      const githubSecretPath = path.join(tempDir, "github-webhook-secret");
      const gitlabSecretPath = path.join(tempDir, "gitlab-webhook-secret");
      const giteaSecretPath = path.join(tempDir, "gitea-webhook-secret");
      const genericSecretPath = path.join(tempDir, "generic-webhook-secret");
      await writeFile(apiTokenPath, "0123456789abcdef0123456789abcdef\n", "utf8");
      await writeFile(metricsTokenPath, "abcdef0123456789abcdef0123456789\n", "utf8");
      await writeFile(githubSecretPath, "github-file-secret-0123456789abcdef\n", "utf8");
      await writeFile(gitlabSecretPath, "gitlab-file-secret-0123456789abcdef\n", "utf8");
      await writeFile(giteaSecretPath, "gitea-file-secret-0123456789abcdef\n", "utf8");
      await writeFile(genericSecretPath, "generic-file-secret-0123456789abcdef\n", "utf8");

      expect(() =>
        requireProductionApiToken({
          SITEFLOW_ENV: "production",
          SITEFLOW_API_TOKEN_FILE: apiTokenPath
        })
      ).not.toThrow();
      expect(() =>
        requireProductionMetricsToken({
          SITEFLOW_ENV: "production",
          SITEFLOW_METRICS_TOKEN_FILE: metricsTokenPath
        })
      ).not.toThrow();
      expect(gitWebhookSecretsFromEnv({
        SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: githubSecretPath,
        SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE: gitlabSecretPath,
        SITEFLOW_GITEA_WEBHOOK_SECRET_FILE: giteaSecretPath,
        SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE: genericSecretPath
      })).toEqual({
        github: "github-file-secret-0123456789abcdef",
        gitlab: "gitlab-file-secret-0123456789abcdef",
        gitea: "gitea-file-secret-0123456789abcdef",
        generic: "generic-file-secret-0123456789abcdef"
      });
      expect(() =>
        requireProductionGitWebhookSecrets({
          SITEFLOW_ENV: "production",
          SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: githubSecretPath,
          SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE: gitlabSecretPath,
          SITEFLOW_GITEA_WEBHOOK_SECRET_FILE: giteaSecretPath,
          SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE: genericSecretPath
        })
      ).not.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects weak production webhook secret files without exposing file contents", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-server-webhook-secret-file-"));

    try {
      const weakSecretPath = path.join(tempDir, "github-webhook-secret");
      await writeFile(weakSecretPath, "weak-github-webhook-secret\n", "utf8");

      let message = "";

      try {
        requireProductionGitWebhookSecrets({
          SITEFLOW_ENV: "production",
          SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: weakSecretPath
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("SITEFLOW_GITHUB_WEBHOOK_SECRET");
      expect(message).not.toContain("weak-github-webhook-secret");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects SITEFLOW_POSTGRES_PASSWORD_FILE into passwordless server database URLs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-server-postgres-password-"));

    try {
      const passwordPath = path.join(tempDir, "postgres-password");
      await writeFile(passwordPath, "postgres-secret\n", "utf8");

      expect(resolveDatabaseUrl({
        DATABASE_URL: "postgres://siteflow@localhost:5432/siteflow",
        SITEFLOW_POSTGRES_PASSWORD_FILE: passwordPath
      })).toBe("postgres://siteflow:postgres-secret@localhost:5432/siteflow");
      expect(resolveDatabaseUrl({
        DATABASE_URL: "postgres://siteflow:url-secret@localhost:5432/siteflow",
        SITEFLOW_POSTGRES_PASSWORD_FILE: passwordPath
      })).toBe("postgres://siteflow:url-secret@localhost:5432/siteflow");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults and validates operator session idle timeout settings", () => {
    expect(defaultOperatorSessionIdleTimeoutSeconds({})).toBe(1800);
    expect(defaultOperatorSessionIdleTimeoutSeconds({
      SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS: "900"
    })).toBe(900);

    expect(() =>
      defaultOperatorSessionIdleTimeoutSeconds({
        SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS: "59"
      })
    ).toThrow("SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS");

    expect(() =>
      defaultOperatorSessionIdleTimeoutSeconds({
        SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS: "900.5"
      })
    ).toThrow("SITEFLOW_OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS");
  });

  it("requires metrics scrape protection in production unless explicitly bypassed", () => {
    expect(() =>
      requireProductionMetricsToken({
        SITEFLOW_ENV: "production"
      })
    ).toThrow("SITEFLOW_METRICS_TOKEN");

    expect(() =>
      requireProductionMetricsToken({
        SITEFLOW_ENV: "production",
        SITEFLOW_METRICS_TOKEN: "metrics-token"
      })
    ).toThrow(/at least 32 characters/i);

    expect(() =>
      requireProductionMetricsToken({
        SITEFLOW_ENV: "production",
        SITEFLOW_METRICS_TOKEN: "0123456789abcdef0123456789abcdef"
      })
    ).not.toThrow();

    expect(() =>
      requireProductionMetricsToken({
        NODE_ENV: "production",
        SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS: "1"
      })
    ).not.toThrow();

    expect(() =>
      requireProductionMetricsToken({
        NODE_ENV: "test"
      })
    ).not.toThrow();
  });

  it("requires a strong API bearer token in production", () => {
    expect(() =>
      requireProductionApiToken({
        SITEFLOW_ENV: "production"
      })
    ).toThrow("SITEFLOW_API_TOKEN");

    expect(() =>
      requireProductionApiToken({
        SITEFLOW_ENV: "production",
        SITEFLOW_API_TOKEN: "token"
      })
    ).toThrow(/at least 32 characters/i);

    expect(() =>
      requireProductionApiToken({
        SITEFLOW_ENV: "production",
        SITEFLOW_API_TOKEN: "0123456789abcdef0123456789abcdef"
      })
    ).not.toThrow();

    expect(() =>
      requireProductionApiToken({
        NODE_ENV: "test",
        SITEFLOW_API_TOKEN: "token"
      })
    ).not.toThrow();
  });

  it("emits structured request logs without query strings or credentials", async () => {
    const requestLogs: SiteFlowRequestLogEntry[] = [];

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const ok = await fetch(`${baseUrl}/api/projects?token=${SITEFLOW_SECRET_CANARY}`, {
          headers: {
            authorization: "Bearer deploy-token",
            "user-agent": "SiteFlowTest/1.0"
          }
        });
        const unauthorized = await fetch(`${baseUrl}/api/projects?token=${SITEFLOW_SECRET_CANARY}`, {
          headers: {
            "user-agent": "SiteFlowTest/1.0"
          }
        });
        const missingWebhookSecret = await fetch(`${baseUrl}/api/webhooks/git/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({ token: SITEFLOW_SECRET_CANARY })
        });

        expect(ok.status).toBe(200);
        expect(unauthorized.status).toBe(401);
        expect(missingWebhookSecret.status).toBe(503);
      },
      {
        apiToken: "deploy-token",
        requestLogger: (entry) => {
          requestLogs.push(entry);
        }
      }
    );

    expect(requestLogs).toHaveLength(3);
    expect(requestLogs[0]).toMatchObject({
      method: "GET",
      path: "/api/projects",
      status: 200
    });
    expect(requestLogs[1]).toMatchObject({
      method: "GET",
      path: "/api/projects",
      status: 401,
      errorClass: "ExpectedHttpError"
    });
    expect(requestLogs[2]).toMatchObject({
      method: "POST",
      path: "/api/webhooks/git/github",
      status: 503,
      errorClass: "ExpectedHttpError"
    });
    expect(requestLogs[0].requestId).toMatch(/^req_/);
    expect(requestLogs[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(requestLogs)).not.toContain(SITEFLOW_SECRET_CANARY);
    expect(JSON.stringify(requestLogs)).not.toContain("deploy-token");
    expect(JSON.stringify(requestLogs)).not.toContain("authorization");
  });

  it("serves aggregate HTTP metrics without path tokens or request payload data", async () => {
    let now = 2_000_000;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      listProjects: async (): Promise<ProjectListReadModel> => {
        throw new Error(`database password ${SITEFLOW_SECRET_CANARY}`);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const deployHookToken = "sfh_metrics_secret_token";
        const health = await fetch(`${baseUrl}/healthz?token=${SITEFLOW_SECRET_CANARY}`);
        const hook = await fetch(`${baseUrl}/api/deploy-hooks/${deployHookToken}/trigger?token=${SITEFLOW_SECRET_CANARY}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.10"
          },
          body: JSON.stringify({
            branch: "main",
            canary: SITEFLOW_SECRET_CANARY
          })
        });
        const verify = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.20"
          }
        });
        const limited = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.20"
          }
        });
        const failed = await fetch(`${baseUrl}/api/projects`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.30"
          }
        });
        const metrics = await fetch(`${baseUrl}/metrics?token=${SITEFLOW_SECRET_CANARY}`);
        const metricsText = await metrics.text();

        expect(health.status).toBe(200);
        expect(hook.status).toBe(202);
        expect(verify.status).toBe(200);
        expect(limited.status).toBe(429);
        expect(failed.status).toBe(500);
        expect(metrics.status).toBe(200);
        expect(metrics.headers.get("content-type")).toContain("text/plain");
        expect(metricsText).toContain("siteflow_http_requests_total 5");
        expect(metricsText).toContain("siteflow_http_5xx_total 1");
        expect(metricsText).toContain("siteflow_http_429_total 1");
        expect(metricsText).toContain("siteflow_http_request_duration_ms_count 5");
        expect(metricsText).toMatch(/siteflow_http_request_duration_ms_sum \d+/);
        expect(metricsText).toContain("siteflow_runtime_metrics_collection_error 1");
        expect(metricsText).toContain("siteflow_backup_automation_last_success_age_seconds -1");
        expect(metricsText).toContain("siteflow_backup_metrics_collection_error 1");
        expect(metricsText).not.toContain(deployHookToken);
        expect(metricsText).not.toContain(SITEFLOW_SECRET_CANARY);
        expect(metricsText).not.toContain("database password");
        expect(metricsText).not.toContain("authorization");
      },
      {
        apiToken: "deploy-token",
        rateLimit: {
          maxRequests: 1,
          windowMs: 1000,
          now: () => now++
        }
      }
    );
  });

  it("serves runtime queue metrics from the configured collector", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const metrics = await fetch(`${baseUrl}/metrics`);
        const metricsText = await metrics.text();

        expect(metrics.status).toBe(200);
        expect(metricsText).toContain("siteflow_build_jobs_queued 4");
        expect(metricsText).toContain("siteflow_build_jobs_running 2");
        expect(metricsText).toContain("siteflow_build_jobs_stale 1");
        expect(metricsText).toContain("siteflow_build_job_oldest_queued_age_seconds 360");
        expect(metricsText).toContain("siteflow_build_job_oldest_running_heartbeat_age_seconds 45");
        expect(metricsText).toContain("siteflow_runtime_metrics_collection_error 0");
        expect(metricsText).toContain("siteflow_storage_artifact_free_bytes 2048");
        expect(metricsText).toContain("siteflow_storage_evidence_free_bytes 4096");
        expect(metricsText).toContain("siteflow_storage_temp_free_bytes 1024");
        expect(metricsText).toContain("siteflow_storage_missing_paths 0");
        expect(metricsText).toContain("siteflow_storage_metrics_collection_error 0");
        expect(metricsText).toContain("siteflow_backup_automation_last_success_age_seconds -1");
        expect(metricsText).toContain("siteflow_backup_restore_drill_last_success_age_seconds -1");
        expect(metricsText).toContain("siteflow_backup_offload_last_run_failed 0");
        expect(metricsText).toContain("siteflow_backup_metrics_collection_error 1");
      },
      {
        runtimeMetricsCollector: async () => ({
          queuedBuildJobs: 4,
          runningBuildJobs: 2,
          staleBuildJobs: 1,
          oldestQueuedBuildAgeSeconds: 360,
          oldestRunningBuildHeartbeatAgeSeconds: 45,
          storageArtifactFreeBytes: 2048,
          storageEvidenceFreeBytes: 4096,
          storageTempFreeBytes: 1024,
          storageMissingPaths: 0,
          storageMetricsCollectionError: 0
        })
      }
    );
  });

  it("keeps metrics scrape available when runtime metrics collection fails", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const metrics = await fetch(`${baseUrl}/metrics`);
        const metricsText = await metrics.text();

        expect(metrics.status).toBe(200);
        expect(metricsText).toContain("siteflow_http_requests_total");
        expect(metricsText).toContain("siteflow_runtime_metrics_collection_error 1");
        expect(metricsText).not.toContain("database password");
        expect(metricsText).not.toContain(SITEFLOW_SECRET_CANARY);
      },
      {
        runtimeMetricsCollector: async () => {
          throw new Error(`database password ${SITEFLOW_SECRET_CANARY}`);
        }
      }
    );
  });

  it("protects HTTP metrics when a metrics token is configured", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const unauthorized = await fetch(`${baseUrl}/metrics`);
        const forbidden = await fetch(`${baseUrl}/metrics`, {
          headers: {
            authorization: "Bearer wrong-token"
          }
        });
        const authorized = await fetch(`${baseUrl}/metrics?token=${SITEFLOW_SECRET_CANARY}`, {
          headers: {
            authorization: "Bearer metrics-token"
          }
        });
        const headAuthorized = await rawHttpGet(
          baseUrl,
          `/metrics?token=${SITEFLOW_SECRET_CANARY}`,
          { authorization: "Bearer metrics-token" },
          "HEAD"
        );
        const metricsText = await authorized.text();

        expect(unauthorized.status).toBe(401);
        expect(forbidden.status).toBe(403);
        expect(authorized.status).toBe(200);
        expect(headAuthorized.status).toBe(200);
        expect(headAuthorized.body.byteLength).toBe(0);
        expect(metricsText).toContain("siteflow_http_requests_total");
        expect(metricsText).not.toContain(SITEFLOW_SECRET_CANARY);
        expect(metricsText).not.toContain("metrics-token");
      },
      {
        apiToken: "deploy-token",
        metricsToken: "metrics-token"
      }
    );
  });

  it("maps Postgres queue metrics rows into runtime metrics", async () => {
    const queries: string[] = [];
    const collector = createProductionMetricsCollector({
      query: async (sql: string) => {
        queries.push(sql);

        return {
          rows: [
            {
              queued_build_jobs: "5",
              running_build_jobs: 3,
              stale_build_jobs: "1",
              oldest_queued_age_seconds: "720",
              oldest_running_heartbeat_age_seconds: 90
            }
          ]
        };
      }
    });

    await expect(collector()).resolves.toMatchObject({
      queuedBuildJobs: 5,
      runningBuildJobs: 3,
      staleBuildJobs: 1,
      oldestQueuedBuildAgeSeconds: 720,
      oldestRunningBuildHeartbeatAgeSeconds: 90,
      storageTempFreeBytes: expect.any(Number),
      backupAutomationLastSuccessAgeSeconds: -1,
      backupMetricsCollectionError: 1
    });
    expect(queries[0]).toContain("FROM siteflow_build_jobs");
    expect(queries[0]).toContain("locked_until");
    expect(queries[0]).toContain("heartbeat_at");
  });

  it("maps configured storage paths into runtime storage metrics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-storage-runtime-metrics-"));

    try {
      const artifactRoot = path.join(root, "artifacts");
      const evidenceRoot = path.join(root, "evidence");
      const tempRoot = path.join(root, "tmp");

      await mkdir(artifactRoot, { recursive: true });
      await mkdir(evidenceRoot, { recursive: true });
      await mkdir(tempRoot, { recursive: true });

      const collector = createProductionMetricsCollector(
        {
          query: async () => ({
            rows: [
              {
                queued_build_jobs: 0,
                running_build_jobs: 0,
                stale_build_jobs: 0,
                oldest_queued_age_seconds: 0,
                oldest_running_heartbeat_age_seconds: 0
              }
            ]
          })
        },
        {
          artifactRoot,
          evidenceRoot,
          tempRoot
        }
      );
      const metrics = await collector();

      expect(metrics.storageArtifactFreeBytes).toEqual(expect.any(Number));
      expect(metrics.storageEvidenceFreeBytes).toEqual(expect.any(Number));
      expect(metrics.storageTempFreeBytes).toEqual(expect.any(Number));
      expect(metrics.storageArtifactFreeBytes).toBeGreaterThanOrEqual(0);
      expect(metrics.storageEvidenceFreeBytes).toBeGreaterThanOrEqual(0);
      expect(metrics.storageTempFreeBytes).toBeGreaterThanOrEqual(0);
      expect(metrics.storageMissingPaths).toBe(0);
      expect(metrics.storageMetricsCollectionError).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports storage metric collection errors for unreadable or missing paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-storage-runtime-missing-"));

    try {
      const collector = createProductionMetricsCollector(
        {
          query: async () => ({
            rows: [
              {
                queued_build_jobs: 0,
                running_build_jobs: 0,
                stale_build_jobs: 0,
                oldest_queued_age_seconds: 0,
                oldest_running_heartbeat_age_seconds: 0
              }
            ]
          })
        },
        {
          artifactRoot: path.join(root, "missing-artifacts"),
          evidenceRoot: path.join(root, "missing-evidence"),
          tempRoot: path.join(root, "missing-temp")
        }
      );

      await expect(collector()).resolves.toMatchObject({
        storageArtifactFreeBytes: -1,
        storageEvidenceFreeBytes: -1,
        storageTempFreeBytes: -1,
        storageMissingPaths: 3,
        storageMetricsCollectionError: 1
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps backup automation run records into runtime backup metrics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-runtime-metrics-"));

    try {
      const restoreDrillPath = path.join(root, "restore-drill.json");
      const offloadPath = path.join(root, "backup-offload.json");
      const prunePath = path.join(root, "backup-prune.json");
      const runRecordPath = path.join(root, "backup-automation-run.json");

      await writeFile(restoreDrillPath, `${JSON.stringify({
        status: "restore_drilled",
        completedAt: "2026-06-07T11:50:00.000Z"
      })}\n`, "utf8");
      await writeFile(offloadPath, `${JSON.stringify({
        status: "offloaded",
        offloadedAt: "2026-06-07T11:52:00.000Z"
      })}\n`, "utf8");
      await writeFile(prunePath, `${JSON.stringify({
        status: "pruned",
        checkedAt: "2026-06-07T11:55:00.000Z",
        dryRun: false
      })}\n`, "utf8");
      await writeFile(runRecordPath, `${JSON.stringify({
        name: "siteflow-backup-automation-run",
        status: "completed",
        completedAt: "2026-06-07T11:58:00.000Z",
        exitCode: 0,
        evidenceFiles: {
          restoreDrill: restoreDrillPath,
          backupOffload: offloadPath,
          backupPrune: prunePath
        },
        steps: [
          { id: "backup", status: "completed" },
          { id: "backup_verify", status: "completed" },
          { id: "restore_drill", status: "completed" },
          { id: "backup_offload", status: "completed" },
          { id: "backup_prune", status: "completed" }
        ]
      })}\n`, "utf8");

      const collector = createProductionMetricsCollector(
        {
          query: async () => ({
            rows: [
              {
                queued_build_jobs: 0,
                running_build_jobs: 0,
                stale_build_jobs: 0,
                oldest_queued_age_seconds: 0,
                oldest_running_heartbeat_age_seconds: 0
              }
            ]
          })
        },
        {
          backupAutomationRunRecordPath: runRecordPath,
          now: () => new Date("2026-06-07T12:00:00.000Z")
        }
      );

      await expect(collector()).resolves.toMatchObject({
        backupAutomationLastSuccessAgeSeconds: 120,
        backupRestoreDrillLastSuccessAgeSeconds: 600,
        backupOffloadLastSuccessAgeSeconds: 480,
        backupPruneLastSuccessAgeSeconds: 300,
        backupOffloadLastRunFailed: 0,
        backupPruneLastRunFailed: 0,
        backupMetricsCollectionError: 0
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves relative backup automation evidence paths from the run record directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-runtime-relative-metrics-"));

    try {
      const runRecordPath = path.join(root, "backup-automation-run.json");

      await writeFile(path.join(root, "restore-drill.json"), `${JSON.stringify({
        status: "restore_drilled",
        completedAt: "2026-06-07T11:50:00.000Z"
      })}\n`, "utf8");
      await writeFile(path.join(root, "backup-offload.json"), `${JSON.stringify({
        status: "offloaded",
        offloadedAt: "2026-06-07T11:52:00.000Z"
      })}\n`, "utf8");
      await writeFile(path.join(root, "backup-prune.json"), `${JSON.stringify({
        status: "pruned",
        checkedAt: "2026-06-07T11:55:00.000Z",
        dryRun: false
      })}\n`, "utf8");
      await writeFile(runRecordPath, `${JSON.stringify({
        name: "siteflow-backup-automation-run",
        status: "completed",
        completedAt: "2026-06-07T11:58:00.000Z",
        exitCode: 0,
        evidenceFiles: {
          restoreDrill: "restore-drill.json",
          backupOffload: "backup-offload.json",
          backupPrune: "backup-prune.json"
        },
        steps: [
          { id: "backup", status: "completed" },
          { id: "backup_verify", status: "completed" },
          { id: "restore_drill", status: "completed" },
          { id: "backup_offload", status: "completed" },
          { id: "backup_prune", status: "completed" }
        ]
      })}\n`, "utf8");

      const collector = createProductionMetricsCollector(
        {
          query: async () => ({
            rows: [
              {
                queued_build_jobs: 0,
                running_build_jobs: 0,
                stale_build_jobs: 0,
                oldest_queued_age_seconds: 0,
                oldest_running_heartbeat_age_seconds: 0
              }
            ]
          })
        },
        {
          backupAutomationRunRecordPath: runRecordPath,
          now: () => new Date("2026-06-07T12:00:00.000Z")
        }
      );

      await expect(collector()).resolves.toMatchObject({
        backupAutomationLastSuccessAgeSeconds: 120,
        backupRestoreDrillLastSuccessAgeSeconds: 600,
        backupOffloadLastSuccessAgeSeconds: 480,
        backupPruneLastSuccessAgeSeconds: 300,
        backupMetricsCollectionError: 0
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps failed backup automation steps into targeted failure gauges", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-backup-runtime-failures-"));
    const query = async () => ({
      rows: [
        {
          queued_build_jobs: 0,
          running_build_jobs: 0,
          stale_build_jobs: 0,
          oldest_queued_age_seconds: 0,
          oldest_running_heartbeat_age_seconds: 0
        }
      ]
    });

    try {
      const offloadFailurePath = path.join(root, "offload-failed.json");
      const prunePlanFailurePath = path.join(root, "prune-plan-failed.json");
      const pruneFailurePath = path.join(root, "prune-failed.json");

      await writeFile(offloadFailurePath, `${JSON.stringify({
        name: "siteflow-backup-automation-run",
        status: "failed",
        exitCode: 1,
        steps: [
          { id: "backup", status: "completed" },
          { id: "backup_verify", status: "completed" },
          { id: "restore_drill", status: "completed" },
          { id: "backup_offload", status: "failed" }
        ]
      })}\n`, "utf8");
      await writeFile(prunePlanFailurePath, `${JSON.stringify({
        name: "siteflow-backup-automation-run",
        status: "failed",
        exitCode: 1,
        steps: [
          { id: "backup", status: "completed" },
          { id: "backup_verify", status: "completed" },
          { id: "restore_drill", status: "completed" },
          { id: "backup_offload", status: "completed" },
          { id: "backup_prune_plan", status: "failed" }
        ]
      })}\n`, "utf8");
      await writeFile(pruneFailurePath, `${JSON.stringify({
        name: "siteflow-backup-automation-run",
        status: "failed",
        exitCode: 1,
        steps: [
          { id: "backup", status: "completed" },
          { id: "backup_verify", status: "completed" },
          { id: "restore_drill", status: "completed" },
          { id: "backup_offload", status: "completed" },
          { id: "backup_prune_plan", status: "completed" },
          { id: "backup_prune", status: "failed" }
        ]
      })}\n`, "utf8");

      await expect(createProductionMetricsCollector({ query }, { backupAutomationRunRecordPath: offloadFailurePath })()).resolves.toMatchObject({
        backupOffloadLastRunFailed: 1,
        backupPruneLastRunFailed: 0,
        backupMetricsCollectionError: 1
      });
      await expect(createProductionMetricsCollector({ query }, { backupAutomationRunRecordPath: prunePlanFailurePath })()).resolves.toMatchObject({
        backupOffloadLastRunFailed: 0,
        backupPruneLastRunFailed: 0,
        backupMetricsCollectionError: 1
      });
      await expect(createProductionMetricsCollector({ query }, { backupAutomationRunRecordPath: pruneFailurePath })()).resolves.toMatchObject({
        backupOffloadLastRunFailed: 0,
        backupPruneLastRunFailed: 1,
        backupMetricsCollectionError: 1
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let request logger failures affect responses", async () => {
    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.projects).toEqual(expect.any(Array));
      },
      {
        apiToken: "deploy-token",
        requestLogger: () => {
          throw new Error("logger sink unavailable");
        }
      }
    );
  });

  it("does not expose internal error messages for unexpected 500 responses", async () => {
    const requestLogs: SiteFlowRequestLogEntry[] = [];
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      listProjects: async (): Promise<ProjectListReadModel> => {
        throw new Error("database password leaked in stack");
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects`, {
          headers: {
            authorization: "Bearer deploy-token"
          }
        });
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body).toEqual({ message: "Unexpected SiteFlow API error." });
        expect(JSON.stringify(body)).not.toContain("database password");
      },
      {
        apiToken: "deploy-token",
        requestLogger: (entry) => {
          requestLogs.push(entry);
        }
      }
    );

    expect(requestLogs).toHaveLength(1);
    expect(requestLogs[0]).toMatchObject({
      method: "GET",
      path: "/api/projects",
      status: 500,
      errorClass: "Error"
    });
    expect(JSON.stringify(requestLogs)).not.toContain("database password");
  });

  it("rejects oversized JSON request bodies without invoking the handler", async () => {
    let createCalls = 0;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      createProject: async (command: CreateProjectCommand): Promise<ProjectMutationReadModel> => {
        createCalls += 1;
        return fixtureRepository().createProject(command);
      }
    };

    await withServer(
      repository,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers: {
            authorization: "Bearer admin-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            slug: "docs",
            name: "Documentation portal with a payload that exceeds the test body limit"
          })
        });
        const body = await response.json();

        expect(response.status).toBe(413);
        expect(body).toEqual({ message: "Request body is too large." });
      },
      { apiToken: "deploy-token", maxBodyBytes: 32 }
    );

    expect(createCalls).toBe(0);
  });

  it("rate limits control-plane API buckets without trusting client bucket headers", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-rate-limit-static-"));
    let now = 1_000_000;

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "static.w33d.xyz"
            ? {
                host,
                deploymentId: "dep_rate_limit_static",
                artifactRoot,
                entrypoint: "index.html"
              }
            : undefined
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const bucketHeaders = {
            authorization: "Bearer read-token",
            "x-siteflow-bucket-key": "control-plane-rate-limit-test"
          };
          const first = await fetch(`${baseUrl}/api/projects`, { headers: bucketHeaders });
          const limited = await fetch(`${baseUrl}/api/projects`, {
            headers: {
              ...bucketHeaders,
              "x-siteflow-bucket-key": "client-rotated-rate-limit-key"
            }
          });
          const limitedBody = await limited.json();
          const firstHealth = await fetch(`${baseUrl}/healthz`, {
            headers: { "x-siteflow-bucket-key": "control-plane-rate-limit-test" }
          });
          const secondHealth = await fetch(`${baseUrl}/healthz`, {
            headers: { "x-siteflow-bucket-key": "control-plane-rate-limit-test" }
          });
          const firstStatic = await fetch(`${baseUrl}/`, {
            headers: {
              "x-forwarded-host": "static.w33d.xyz",
              "x-siteflow-bucket-key": "control-plane-rate-limit-test"
            }
          });
          const secondStatic = await fetch(`${baseUrl}/`, {
            headers: {
              "x-forwarded-host": "static.w33d.xyz",
              "x-siteflow-bucket-key": "control-plane-rate-limit-test"
            }
          });

          now += 1000;
          const afterWindow = await fetch(`${baseUrl}/api/projects`, { headers: bucketHeaders });

          expect(first.status).toBe(200);
          expect(limited.status).toBe(429);
          expect(limited.headers.get("retry-after")).toBe("1");
          expect(limitedBody).toEqual({ message: "SiteFlow API rate limit exceeded." });
          expect(firstHealth.status).toBe(200);
          expect(secondHealth.status).toBe(200);
          expect(firstStatic.status).toBe(200);
          expect(secondStatic.status).toBe(200);
          expect(await firstStatic.text()).toContain("Static shell");
          expect(await secondStatic.text()).toContain("Static shell");
          expect(afterWindow.status).toBe(200);
        },
        {
          apiToken: "deploy-token",
          rateLimit: {
            maxRequests: 1,
            windowMs: 1000,
            now: () => now
          }
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("ignores spoofed X-Forwarded-For when trusted proxy mode is disabled", async () => {
    let now = 1_100_000;

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.10",
            "user-agent": "siteflow-rate-limit-test"
          }
        });
        const spoofed = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.20",
            "user-agent": "siteflow-rate-limit-test"
          }
        });
        const spoofedBody = await spoofed.json();

        expect(first.status).toBe(200);
        expect(spoofed.status).toBe(429);
        expect(spoofedBody).toEqual({ message: "SiteFlow API rate limit exceeded." });
      },
      {
        apiToken: "deploy-token",
        trustProxy: false,
        rateLimit: {
          maxRequests: 1,
          windowMs: 1000,
          now: () => now++
        }
      }
    );
  });

  it("uses X-Forwarded-For for rate buckets when loopback proxy trust matches the connection", async () => {
    let now = 1_200_000;

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.10",
            "user-agent": "siteflow-rate-limit-test"
          }
        });
        const secondClient = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.20",
            "user-agent": "siteflow-rate-limit-test"
          }
        });
        const limitedFirstClient = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.10",
            "user-agent": "siteflow-rate-limit-test"
          }
        });

        expect(first.status).toBe(200);
        expect(secondClient.status).toBe(200);
        expect(limitedFirstClient.status).toBe(429);
      },
      {
        apiToken: "deploy-token",
        trustProxy: "loopback",
        rateLimit: {
          maxRequests: 1,
          windowMs: 1000,
          now: () => now++
        }
      }
    );
  });

  it("ignores X-Forwarded-For when proxy trust policy does not match the connection", async () => {
    let now = 1_300_000;

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.10",
            "user-agent": "siteflow-rate-limit-test"
          }
        });
        const spoofed = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.20",
            "user-agent": "siteflow-rate-limit-test"
          }
        });

        expect(first.status).toBe(200);
        expect(spoofed.status).toBe(429);
      },
      {
        apiToken: "deploy-token",
        trustProxy: ["203.0.113.0/24"],
        rateLimit: {
          maxRequests: 1,
          windowMs: 1000,
          now: () => now++
        }
      }
    );
  });

  it("uses X-Forwarded-For when explicit proxy CIDR matches the connection", async () => {
    let now = 1_400_000;

    await withServer(
      fixtureRepository(),
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.10",
            "user-agent": "siteflow-rate-limit-test"
          }
        });
        const secondClient = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.20",
            "user-agent": "siteflow-rate-limit-test"
          }
        });
        const limitedFirstClient = await fetch(`${baseUrl}/api/auth/verify`, {
          headers: {
            authorization: "Bearer deploy-token",
            "x-forwarded-for": "198.51.100.10",
            "user-agent": "siteflow-rate-limit-test"
          }
        });

        expect(first.status).toBe(200);
        expect(secondClient.status).toBe(200);
        expect(limitedFirstClient.status).toBe(429);
      },
      {
        apiToken: "deploy-token",
        trustProxy: ["127.0.0.0/8"],
        rateLimit: {
          maxRequests: 1,
          windowMs: 1000,
          now: () => now++
        }
      }
    );
  });

  it("enforces scoped API token permissions for read, write, and admin routes", async () => {
    let receivedPromote: PromoteDeploymentCommand | undefined;
    let receivedCreateToken: CreateApiTokenCommand | undefined;
    const repository: SiteFlowReadRepository = {
      ...fixtureRepository(),
      promoteDeployment: async (command: PromoteDeploymentCommand): Promise<CommandResultReadModel> => {
        receivedPromote = command;
        return fixtureRepository().promoteDeployment(command);
      },
      createApiToken: async (command: CreateApiTokenCommand): Promise<ApiTokenCreateReadModel> => {
        receivedCreateToken = command;
        return fixtureRepository().createApiToken(command);
      }
    };

    await withServer(
      repository,
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
            actor: { id: "client-spoof", name: "Spoofed Client", role: "operator" },
            reason: "ship",
            idempotencyKey: "operator-token-promote",
            releaseEvidence: releaseEvidenceRequest()
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
            scopes: ["read"],
            actor: { id: "client-spoof", name: "Spoofed Client", role: "operator" }
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
      { apiToken: "deploy-token", releaseEvidenceEvaluator: passingReleaseEvidenceEvaluator() }
    );

    expect(receivedPromote?.actor).toEqual({
      id: "token-operator",
      name: "Operator token",
      role: "operator"
    });
    expect(receivedPromote?.actor.id).not.toBe("client-spoof");
    expect(receivedCreateToken?.actor).toEqual({
      id: "api-token:token-admin-token",
      name: "admin-token fixture",
      role: "system"
    });
    expect(receivedCreateToken?.actor?.id).not.toBe("client-spoof");
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

  it("protects only ephemeral preview artifact hosts with Basic auth", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-preview-auth-"));
    const salt = Buffer.from("0123456789abcdef", "utf8");
    const hash = scryptSync("open sesame", salt, 32);
    const protection = { hash, salt };

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Private preview</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> => {
          if (host === "preview-abc.w33d.xyz") {
            return {
              host,
              deploymentId: "dep_preview_auth",
              artifactRoot,
              entrypoint: "index.html",
              isEphemeralPreview: true,
              previewProtection: protection
            };
          }

          if (host === "docs.siteflow.w33d.xyz") {
            return {
              host,
              deploymentId: "dep_preview_auth",
              artifactRoot,
              entrypoint: "index.html",
              isEphemeralPreview: false,
              previewProtection: protection
            };
          }

          if (host === "public-preview.w33d.xyz") {
            return {
              host,
              deploymentId: "dep_public_preview",
              artifactRoot,
              entrypoint: "index.html",
              isEphemeralPreview: true
            };
          }

          return undefined;
        }
      };

      await withServer(repository, async (baseUrl) => {
        const stable = await rawHttpGet(baseUrl, "/", {
          "x-forwarded-host": "docs.siteflow.w33d.xyz"
        });
        const noPasswordPreview = await rawHttpGet(baseUrl, "/", {
          "x-forwarded-host": "public-preview.w33d.xyz"
        });
        const missing = await rawHttpGet(baseUrl, "/", {
          "x-forwarded-host": "preview-abc.w33d.xyz"
        });
        const wrong = await rawHttpGet(baseUrl, "/", {
          "x-forwarded-host": "preview-abc.w33d.xyz",
          authorization: `Basic ${Buffer.from("user:wrong").toString("base64")}`
        });
        const malformed = await rawHttpGet(baseUrl, "/", {
          "x-forwarded-host": "preview-abc.w33d.xyz",
          authorization: "Basic not valid base64"
        });
        const imageMissing = await rawHttpGet(baseUrl, "/_siteflow/image?url=%2Fhero.png&w=320", {
          "x-forwarded-host": "preview-abc.w33d.xyz"
        });
        const correct = await rawHttpGet(baseUrl, "/", {
          "x-forwarded-host": "preview-abc.w33d.xyz",
          authorization: `Basic ${Buffer.from("ignored:open sesame").toString("base64")}`
        });

        expect(stable.status).toBe(200);
        expect(stable.body.toString("utf8")).toContain("Private preview");
        expect(noPasswordPreview.status).toBe(200);
        expect(noPasswordPreview.body.toString("utf8")).toContain("Private preview");

        for (const response of [missing, wrong, malformed, imageMissing]) {
          expect(response.status).toBe(401);
          expect(response.headers["www-authenticate"]).toBe("Basic realm=\"SiteFlow Preview\", charset=\"UTF-8\"");
          expect(response.headers["cache-control"]).toBe("no-store");
          expect(JSON.parse(response.body.toString("utf8"))).toEqual({ message: "Preview authentication required." });
        }
        expect(wrong.body.equals(missing.body)).toBe(true);
        expect(malformed.body.equals(missing.body)).toBe(true);
        expect(imageMissing.body.equals(missing.body)).toBe(true);

        expect(correct.status).toBe(200);
        expect(correct.body.toString("utf8")).toContain("Private preview");
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

  it("does not trust spoofed X-Forwarded-For for firewall evaluation when proxy trust is disabled", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-firewall-untrusted-proxy-"));
    const evaluations: Array<{ path: string; ip?: string }> = [];

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
            ip: command.ip
          });

          return {
            projectId: command.projectId,
            decision: "allow",
            reason: "No firewall rule matched."
          };
        }
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await rawHttpGet(baseUrl, "/", {
            host: "abc123.w33d.xyz",
            "x-forwarded-for": "203.0.113.10",
            "user-agent": "curl/8.0"
          });

          expect(response.status).toBe(200);
        },
        { trustProxy: false }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]).toMatchObject({ path: "/" });
    expect(evaluations[0].ip).not.toBe("203.0.113.10");
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

  it("disables same-process function runtime by default in production", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-production-disabled-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_disabled",
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
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            body: JSON.stringify({ name: "home" })
          });
          const body = await response.json();

          expect(response.status).toBe(503);
          expect(response.headers.get("x-siteflow-function-runtime")).toBe("disabled");
          expect(body.message).toBe("Function runtime is disabled in production.");
        },
        {
          productionRuntime: true,
          functionModuleLoader: async () => {
            throw new Error("Production function gate should prevent same-process module loading.");
          }
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      deploymentId: "dep_function_disabled",
      projectId: "project_docs",
      path: "/api/revalidate",
      method: "POST",
      status: "failed",
      responseStatus: 503
    });
    expect(invocations[0].errorMessage).toContain("Same-process function runtime is disabled in production");
  });

  it("runs isolated-process function artifacts in production without inheriting parent environment", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-production-isolated-"));
    const invocations: FunctionInvocation[] = [];
    const previousParentSecret = process.env.PARENT_ONLY_SECRET;

    try {
      process.env.PARENT_ONLY_SECRET = "parent-secret-20260608";
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      await mkdir(path.join(artifactRoot, ".siteflow", "functions", "api"), { recursive: true });
      await writeFile(
        path.join(artifactRoot, ".siteflow", "functions", "api", "revalidate.js"),
        [
          "export default async function handler(request, context) {",
          "  console.log('runtime secret', process.env.RUNTIME_SECRET);",
          "  return {",
          "    status: 201,",
          "    headers: { 'content-type': 'application/json; charset=utf-8' },",
          "    body: {",
          "      method: request.method,",
          "      payload: await request.json(),",
          "      envSecret: context.env.RUNTIME_SECRET,",
          "      processSecret: process.env.RUNTIME_SECRET,",
          "      parentSecret: process.env.PARENT_ONLY_SECRET ?? null,",
          "      isolation: process.env.SITEFLOW_FUNCTION_RUNTIME_ISOLATION",
          "    }",
          "  };",
          "}"
        ].join("\n"),
        "utf8"
      );

      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_isolated",
                artifactRoot,
                entrypoint: "index.html",
                runtimeEnvironment: {
                  RUNTIME_SECRET: "runtime-secret-20260608"
                },
                functions: [
                  {
                    path: "/api/revalidate",
                    sourcePath: ".siteflow/functions/api/revalidate.js",
                    runtime: "nodejs20.x",
                    runtimeIsolation: "isolated_process",
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
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            body: JSON.stringify({ name: "home" })
          });
          const body = await response.json();

          expect(response.status).toBe(201);
          expect(response.headers.get("x-siteflow-function-runtime")).toBe("isolated_process");
          expect(body).toEqual({
            method: "POST",
            payload: { name: "home" },
            envSecret: "runtime-secret-20260608",
            processSecret: "runtime-secret-20260608",
            parentSecret: null,
            isolation: "isolated_process"
          });
        },
        {
          productionRuntime: true,
          functionModuleLoader: async () => {
            throw new Error("Isolated production functions should not use the same-process module loader.");
          }
        }
      );
    } finally {
      if (previousParentSecret === undefined) {
        delete process.env.PARENT_ONLY_SECRET;
      } else {
        process.env.PARENT_ONLY_SECRET = previousParentSecret;
      }
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      deploymentId: "dep_function_isolated",
      projectId: "project_docs",
      path: "/api/revalidate",
      method: "POST",
      status: "succeeded",
      responseStatus: 201
    });
    expect(invocations[0].logs.join("\n")).toContain("[REDACTED]");
    expect(invocations[0].logs.join("\n")).not.toContain("runtime-secret-20260608");
  });

  it("allows same-process function runtime in production only when explicitly enabled", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-production-enabled-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_enabled",
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
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            body: JSON.stringify({ name: "home" })
          });
          const body = await response.json();

          expect(response.status).toBe(200);
          expect(body).toEqual({ ok: true });
        },
        {
          productionRuntime: true,
          allowSameProcessFunctionRuntime: true,
          functionModuleLoader: async () => ({
            default: async () => ({ body: { ok: true } })
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      deploymentId: "dep_function_enabled",
      status: "succeeded",
      responseStatus: 200
    });
  });

  it("runs Vercel req/res API functions in same-process runtime", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-node-api-same-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_node_same",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/node",
                    sourcePath: ".siteflow/functions/api/node.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    apiStyle: "node"
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
          const response = await fetch(`${baseUrl}/api/node?tag=home&tag=docs&draft=1`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "session=abc; theme=dark",
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            body: JSON.stringify({ name: "home" })
          });
          const body = await response.json();

          expect(response.status).toBe(200);
          expect(response.headers.get("x-node-compat")).toBe("same");
          expect(body).toEqual({
            method: "POST",
            url: "/api/node?tag=home&tag=docs&draft=1",
            query: {
              tag: ["home", "docs"],
              draft: "1"
            },
            cookies: {
              session: "abc",
              theme: "dark"
            },
            body: { name: "home" },
            params: {}
          });
        },
        {
          functionModuleLoader: async () => ({
            default: async (
              req: {
                method: string;
                url: string;
                query: Record<string, string | string[]>;
                cookies: Record<string, string>;
                body: unknown;
                params: Record<string, string>;
              },
              res: {
                setHeader(key: string, value: string): unknown;
                status(code: number): { json(value: unknown): unknown };
              }
            ) => {
              res.setHeader("x-node-compat", "same");
              res.status(200).json({
                method: req.method,
                url: req.url,
                query: req.query,
                cookies: req.cookies,
                body: req.body,
                params: req.params
              });
            }
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      deploymentId: "dep_function_node_same",
      path: "/api/node",
      status: "succeeded",
      responseStatus: 200
    });
  });

  it("resolves the return-form Vercel idiom `return res.status(x).json(...)` (not 200 empty)", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-node-return-"));
    const invocations: FunctionInvocation[] = [];

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_node_return",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/guard",
                    sourcePath: ".siteflow/functions/api/guard.js",
                    runtime: "nodejs20.x",
                    handler: "default",
                    apiStyle: "node"
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
          const response = await fetch(`${baseUrl}/api/guard`, {
            method: "GET",
            headers: { "x-forwarded-host": "abc123.w33d.xyz" }
          });
          const body = await response.json();

          // Before the fix this returned 200 with an empty body because `res.status().json()`
          // returns `res` and the returned value was treated as a Response.
          expect(response.status).toBe(401);
          expect(response.headers.get("content-type")).toContain("application/json");
          expect(body).toEqual({ error: "unauthorized" });
        },
        {
          functionModuleLoader: async () => ({
            default: async (
              _req: unknown,
              res: { status(code: number): { json(value: unknown): unknown } }
            ) => res.status(401).json({ error: "unauthorized" })
          })
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }

    expect(invocations[0]).toMatchObject({
      path: "/api/guard",
      status: "succeeded",
      responseStatus: 401
    });
  });

  it("runs Vercel req/res API functions in isolated-process runtime", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-node-api-isolated-"));

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      await mkdir(path.join(artifactRoot, ".siteflow", "functions", "api"), { recursive: true });
      await writeFile(path.join(artifactRoot, ".siteflow", "functions", "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        path.join(artifactRoot, ".siteflow", "functions", "api", "node.js"),
        [
          "export default function handler(req, res) {",
          "  res.status(200).json({",
          "    method: req.method,",
          "    url: req.url,",
          "    query: req.query,",
          "    cookies: req.cookies,",
          "    body: req.body",
          "  });",
          "}"
        ].join("\n"),
        "utf8"
      );
      const repository: SiteFlowReadRepository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_node_isolated",
                artifactRoot,
                entrypoint: "index.html",
                functions: [
                  {
                    path: "/api/node",
                    sourcePath: ".siteflow/functions/api/node.js",
                    runtime: "nodejs20.x",
                    runtimeIsolation: "isolated_process",
                    handler: "default",
                    apiStyle: "node"
                  }
                ]
              }
            : undefined
      };

      await withServer(
        repository,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/node?tag=home&tag=docs`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "session=abc",
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            body: JSON.stringify({ name: "home" })
          });
          const body = await response.json();

          expect(response.status).toBe(200);
          expect(response.headers.get("x-siteflow-function-runtime")).toBe("isolated_process");
          expect(body).toEqual({
            method: "POST",
            url: "/api/node?tag=home&tag=docs",
            query: {
              tag: ["home", "docs"]
            },
            cookies: {
              session: "abc"
            },
            body: { name: "home" }
          });
        },
        {
          productionRuntime: true,
          functionModuleLoader: async () => {
            throw new Error("Isolated node functions should not use the same-process module loader.");
          }
        }
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
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
          expect(invocations[0].logs.join("\n")).toContain("\"safe\":\"visible\"");
          expect(invocations[0].logs.join("\n")).not.toContain("\"token\":\"t\"");
          expect(invocations[0].logs.join("\n")).not.toContain("\"password\":\"pw\"");
          expect(invocations[0].logs.join("\n")).not.toContain("\"apiKey\":\"k\"");
        },
        {
          functionModuleLoader: async (functionPath) => {
            expect(functionPath).toBe(path.join(artifactRoot, ".siteflow", "functions", "api", "revalidate.js"));

            return {
              default: async (request: Request, context: { deploymentId: string; requestId: string }) => {
                console.log("runtime SITEFLOW_SECRET_CANARY_20260515");
                console.log("runtime object", {
                  token: "t",
                  nested: {
                    password: "pw"
                  },
                  apiKey: "k",
                  safe: "visible"
                });
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

  it("rejects deployed API function bodies over the configured limit before loading the module", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-function-body-limit-"));
    const invocations: FunctionInvocation[] = [];
    let loadCalls = 0;

    try {
      await writeFile(path.join(artifactRoot, "index.html"), "<h1>Static shell</h1>");
      const repository = {
        ...fixtureRepository(),
        resolveArtifactRoute: async (host: string): Promise<ArtifactRoute | undefined> =>
          host === "abc123.w33d.xyz"
            ? {
                host,
                projectId: "project_docs",
                deploymentId: "dep_function_body_limit",
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
              "x-forwarded-host": "abc123.w33d.xyz"
            },
            body: JSON.stringify({
              name: "payload larger than the configured API function body limit"
            })
          });
          const body = await response.json() as { message: string; requestId: string };

          expect(response.status).toBe(413);
          expect(body.message).toBe("Request body is too large.");
          expect(body.requestId).toMatch(/^req_/);
          expect(loadCalls).toBe(0);
          expect(invocations).toHaveLength(1);
          expect(invocations[0]).toMatchObject({
            deploymentId: "dep_function_body_limit",
            path: "/api/revalidate",
            method: "POST",
            responseStatus: 413,
            requestId: body.requestId,
            errorMessage: "Request body is too large."
          });
        },
        {
          maxBodyBytes: 32,
          functionModuleLoader: async () => {
            loadCalls += 1;
            throw new Error("Oversized function body should prevent function loading.");
          }
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
