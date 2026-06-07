import type {
  Actor,
  Artifact,
  ArtifactVerificationStatus,
  AuditEvent,
  BuildJob,
  BuildJobStatus,
  CdnOperation,
  CdnOperationState,
  ChannelEvent,
  ChannelEventStatus,
  Deployment,
  DeploymentStatus,
  Project,
  ReleaseChannel,
  ReleaseChannelName,
  RouteRevision,
  RouteRevisionStatus,
  SafetyCheck,
  SourceEvent
} from "@domain/siteflow";
import type {
  CommandResultReadModel,
  DeploymentDetailReadModel,
  DeploymentSummaryReadModel,
  EventFeedReadModel,
  LogChunkReadModel,
  OperationSnapshotReadModel,
  ProjectDetailReadModel,
  ProjectListReadModel,
  ReleaseConsoleReadModel,
  RollbackConsoleReadModel,
  RollbackTargetReadModel
} from "@domain/readModels";
import { SITEFLOW_SECRET_CANARY } from "@lib/redaction";
import type { SiteFlowScenarioName } from "./scenarios";

export interface FixtureScenarioData {
  projectList: ProjectListReadModel;
  projects: Record<string, ProjectDetailReadModel>;
  deployments: Record<string, DeploymentDetailReadModel>;
  releaseConsoles: Record<string, ReleaseConsoleReadModel>;
  rollbackConsoles: Record<string, RollbackConsoleReadModel>;
  operations: Record<string, OperationSnapshotReadModel>;
  logs: Record<string, LogChunkReadModel[]>;
  commandResults: {
    promote: CommandResultReadModel;
    rollback: CommandResultReadModel;
  };
}

export const fixtureProjectId = "project-acme-dashboard";
export const fixtureChannel: ReleaseChannelName = "production";

export function fixtureConsoleKey(projectId: string, channel: ReleaseChannelName) {
  return `${projectId}:${channel}`;
}

const now = "2026-05-15T01:40:00.000Z";
const currentDeploymentId = "dep-acme-20260515-101";
const previousDeploymentId = "dep-acme-20260514-088";

const operator: Actor = {
  id: "actor-maya",
  name: "Maya Chen",
  email: "maya@example.test",
  role: "release_manager"
};

function createProject(cdnEnabled = true): Project {
  return {
    id: fixtureProjectId,
    slug: "acme-dashboard",
    name: "Acme Dashboard",
    status: "active",
    framework: "Vite",
    defaultBranch: "main",
    repository: {
      provider: "github",
      owner: "acme",
      name: "dashboard",
      defaultBranch: "main",
      installationId: "gh-install-742",
      webhookSecretRef: "secret://siteflow/projects/acme-dashboard/webhook",
      providerPayload: {
        deliverySecret: SITEFLOW_SECRET_CANARY,
        lastDeliveryId: "gh-delivery-20260515-01"
      }
    },
    domains: [
      {
        hostname: "dashboard.acme.test",
        channel: "production",
        verified: true,
        lastCheckedAt: now
      }
    ],
    policy: {
      requiredChecks: ["artifact_verified", "route_dry_run", "retained_artifact"],
      retentionDays: 21,
      previewDeploymentsEnabled: false,
      cdnEnabled,
      requirePromotionReason: true
    },
    secrets: [
      {
        key: "GITHUB_WEBHOOK_SECRET",
        scope: "webhook",
        source: "sealed",
        fingerprint: "sha256:2e6b...c7a1",
        updatedAt: "2026-05-10T13:00:00.000Z"
      },
      {
        key: "PUBLIC_API_TOKEN",
        scope: "build",
        source: "external",
        fingerprint: "sha256:93aa...40db",
        updatedAt: "2026-05-12T08:30:00.000Z"
      }
    ],
    createdAt: "2026-04-21T10:00:00.000Z",
    updatedAt: now
  };
}

function createSourceEvent(id: string, commitSha: string): SourceEvent {
  return {
    id,
    projectId: fixtureProjectId,
    kind: "push",
    status: "accepted",
    disposition: "build_requested",
    providerDeliveryId: `gh-delivery-${id}`,
    branch: "main",
    commitSha,
    commitMessage: "Tighten deployment evidence ledger",
    commitAuthor: "Jordan Rivera",
    receivedAt: "2026-05-15T01:18:00.000Z",
    actor: operator
  };
}

function createBuildJob(id: string, sourceEventId: string, status: BuildJobStatus): BuildJob {
  const running = status === "running";
  const finished = status === "succeeded" || status === "failed" || status === "canceled" || status === "timed_out" || status === "skipped";

  return {
    id,
    projectId: fixtureProjectId,
    sourceEventId,
    status,
    framework: "vite",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    queuedAt: "2026-05-15T01:19:00.000Z",
    startedAt: running || finished ? "2026-05-15T01:20:00.000Z" : undefined,
    finishedAt: finished ? "2026-05-15T01:23:45.000Z" : undefined,
    workerId: running || finished ? "worker-build-03" : undefined,
    events: [
      {
        id: `${id}-event-1`,
        buildJobId: id,
        level: "info",
        message: "Build job accepted by SiteFlow worker",
        occurredAt: "2026-05-15T01:19:02.000Z"
      },
      {
        id: `${id}-event-2`,
        buildJobId: id,
        level: status === "failed" ? "error" : "info",
        message: status === "queued" ? "Waiting for worker lease" : "Static output prepared for artifact publishing",
        occurredAt: "2026-05-15T01:23:20.000Z"
      }
    ]
  };
}

function createArtifact(id: string, buildJobId: string, verificationStatus: ArtifactVerificationStatus): Artifact {
  return {
    id,
    projectId: fixtureProjectId,
    buildJobId,
    storageUri: `s3://siteflow-artifacts/${fixtureProjectId}/${id}.tar.zst`,
    manifest: {
      entrypoint: "index.html",
      fileCount: verificationStatus === "pending" ? 0 : 128,
      totalBytes: verificationStatus === "pending" ? 0 : 4_821_108,
      checksum: verificationStatus === "verified" ? "sha256:9f1c1d3c2d9a4b7db8e8c61af3c42f3f" : "pending",
      generatedAt: "2026-05-15T01:24:00.000Z",
      metadata: {
        framework: "vite",
        publicPath: "/",
        buildSecretEcho: SITEFLOW_SECRET_CANARY
      }
    },
    storageStatus: verificationStatus === "pending" ? "pending_upload" : "retained",
    verificationStatus,
    retainedUntil: "2026-06-05T01:24:00.000Z",
    immutable: true,
    createdAt: "2026-05-15T01:24:00.000Z",
    verifiedAt: verificationStatus === "verified" ? "2026-05-15T01:24:18.000Z" : undefined
  };
}

function createDeployment(id: string, sourceEventId: string, buildJobId: string, artifactId: string, status: DeploymentStatus): Deployment {
  return {
    id,
    projectId: fixtureProjectId,
    sourceEventId,
    buildJobId,
    artifactId,
    status,
    version: id === previousDeploymentId ? "2026.05.14.88" : "2026.05.15.101",
    environment: fixtureChannel,
    createdAt: "2026-05-15T01:24:25.000Z",
    readyAt: status === "ready" ? "2026-05-15T01:24:40.000Z" : undefined,
    failedReason: status === "failed" ? "Build output failed artifact verification" : undefined
  };
}

function createCdnOperation(routeRevisionId: string, state: CdnOperationState): CdnOperation {
  return {
    id: `cdn-${routeRevisionId}`,
    projectId: fixtureProjectId,
    routeRevisionId,
    provider: state === "disabled" ? "none" : "cloudflare",
    state,
    requestedAt: "2026-05-15T01:25:08.000Z",
    finishedAt: state === "succeeded" || state === "failed" || state === "skipped" ? "2026-05-15T01:25:22.000Z" : undefined,
    message: state === "disabled" ? "CDN integration disabled by project policy" : "Cache purge follows route apply"
  };
}

function createRouteRevision(
  id: string,
  deploymentId: string,
  status: RouteRevisionStatus,
  cdnOperationState: CdnOperationState
): RouteRevision {
  return {
    id,
    projectId: fixtureProjectId,
    channel: fixtureChannel,
    deploymentId,
    previousDeploymentId,
    status,
    generatedConfig: [
      "server {",
      "  server_name dashboard.acme.test;",
      `  proxy_set_header Authorization Bearer ${SITEFLOW_SECRET_CANARY};`,
      `  root /var/lib/siteflow/artifacts/${deploymentId};`,
      "}"
    ].join("\n"),
    validationSummary:
      status === "failed"
        ? "Nginx validation failed; previous known-good config preserved."
        : "Nginx config dry-run completed against previous known-good route.",
    createdAt: "2026-05-15T01:25:00.000Z",
    appliedAt: status === "applied" ? "2026-05-15T01:25:12.000Z" : undefined,
    failedReason: status === "failed" ? "Upstream root path does not exist on routing host." : undefined,
    cdnOperation: createCdnOperation(id, cdnOperationState)
  };
}

function createSummary(
  project: Project,
  deployment: Deployment,
  sourceEvent: SourceEvent,
  artifact: Artifact,
  routeRevision: RouteRevision
): DeploymentSummaryReadModel {
  return {
    id: deployment.id,
    projectId: project.id,
    projectName: project.name,
    version: deployment.version,
    commitSha: sourceEvent.commitSha,
    branch: sourceEvent.branch,
    status: deployment.status,
    artifactVerificationStatus: artifact.verificationStatus,
    routeRevisionStatus: routeRevision.status,
    cdnOperationState: routeRevision.cdnOperation?.state ?? "skipped",
    createdAt: deployment.createdAt,
    readyAt: deployment.readyAt
  };
}

function createSafetyChecks(
  artifact: Artifact,
  routeRevision: RouteRevision,
  staleCandidate: boolean,
  rollbackEligible: boolean
): SafetyCheck[] {
  return [
    {
      id: "check-artifact-verified",
      label: "Artifact checksum verified",
      status: artifact.verificationStatus === "verified" ? "pass" : "fail",
      summary:
        artifact.verificationStatus === "verified"
          ? "Manifest checksum matches immutable artifact bytes."
          : "Artifact cannot be routed before checksum verification completes."
    },
    {
      id: "check-route-dry-run",
      label: "Route dry-run",
      status: routeRevision.status === "failed" ? "fail" : routeRevision.status === "drifted" ? "warning" : "pass",
      summary:
        routeRevision.status === "failed"
          ? "Route config validation failed before apply."
          : "Route config can preserve previous known-good revision."
    },
    {
      id: "check-candidate-freshness",
      label: "Candidate freshness",
      status: staleCandidate ? "fail" : "pass",
      summary: staleCandidate ? "Candidate is older than the current production deployment." : "Candidate is newer than production."
    },
    {
      id: "check-retained-artifact",
      label: "Rollback artifact retained",
      status: rollbackEligible ? "pass" : "fail",
      summary: rollbackEligible ? "Target artifact is protected by the rollback retention window." : "Target artifact is expired or delete-pending."
    }
  ];
}

function createEventFeed(sourceEvent: SourceEvent, channelEvent: ChannelEvent, auditEvents: AuditEvent[]): EventFeedReadModel {
  return {
    sourceEvents: [sourceEvent],
    channelEvents: [channelEvent],
    auditEvents
  };
}

interface ScenarioOptions {
  deploymentStatus?: DeploymentStatus;
  buildStatus?: BuildJobStatus;
  artifactVerificationStatus?: ArtifactVerificationStatus;
  routeRevisionStatus?: RouteRevisionStatus;
  cdnOperationState?: CdnOperationState;
  cdnEnabled?: boolean;
  staleCandidate?: boolean;
  rollbackEligible?: boolean;
}

function channelEventStatus(routeRevisionStatus: RouteRevisionStatus): ChannelEventStatus {
  if (routeRevisionStatus === "failed" || routeRevisionStatus === "drifted") {
    return "failed";
  }

  if (routeRevisionStatus === "applied") {
    return "succeeded";
  }

  return "pending";
}

function operationState(routeRevisionStatus: RouteRevisionStatus) {
  if (routeRevisionStatus === "applied") {
    return "succeeded" as const;
  }

  if (routeRevisionStatus === "failed" || routeRevisionStatus === "drifted") {
    return "failed" as const;
  }

  return "running" as const;
}

function createScenario(name: SiteFlowScenarioName, options: ScenarioOptions = {}): FixtureScenarioData {
  const buildStatus = options.buildStatus ?? "succeeded";
  const artifactVerificationStatus = options.artifactVerificationStatus ?? "verified";
  const deploymentStatus = options.deploymentStatus ?? "ready";
  const routeRevisionStatus = options.routeRevisionStatus ?? "applied";
  const cdnEnabled = options.cdnEnabled ?? true;
  const cdnOperationState = options.cdnOperationState ?? (cdnEnabled ? "succeeded" : "disabled");
  const staleCandidate = options.staleCandidate ?? false;
  const rollbackEligible = options.rollbackEligible ?? true;

  const project = createProject(cdnEnabled);
  const sourceEvent = createSourceEvent(`src-${name}`, "4f3a9c2d1b0e");
  const buildJob = createBuildJob(`build-${name}`, sourceEvent.id, buildStatus);
  const artifact = createArtifact(`artifact-${name}`, buildJob.id, artifactVerificationStatus);
  const deployment = createDeployment(`dep-${name}`, sourceEvent.id, buildJob.id, artifact.id, deploymentStatus);
  const routeRevision = createRouteRevision(`route-${name}`, deployment.id, routeRevisionStatus, cdnOperationState);
  const deploymentSummary = createSummary(project, deployment, sourceEvent, artifact, routeRevision);
  const safetyChecks = createSafetyChecks(artifact, routeRevision, staleCandidate, rollbackEligible);

  const previousSource = createSourceEvent("src-previous", "8ac4e0d77a9f");
  const previousBuild = createBuildJob("build-previous", previousSource.id, "succeeded");
  const previousArtifact = createArtifact("artifact-previous", previousBuild.id, rollbackEligible ? "verified" : "failed");
  const previousDeployment = createDeployment(previousDeploymentId, previousSource.id, previousBuild.id, previousArtifact.id, "ready");
  const previousRouteRevision = createRouteRevision("route-previous", previousDeployment.id, "applied", cdnEnabled ? "succeeded" : "disabled");
  const previousSummary = createSummary(project, previousDeployment, previousSource, previousArtifact, previousRouteRevision);

  const releaseChannel: ReleaseChannel = {
    id: `channel-${name}`,
    projectId: project.id,
    name: fixtureChannel,
    currentDeploymentId: deployment.id,
    pendingDeploymentId: routeRevisionStatus === "pending_apply" || routeRevisionStatus === "validating" ? deployment.id : undefined,
    routeRevisionId: routeRevision.id,
    updatedAt: now,
    updatedBy: operator
  };

  const channelEvent: ChannelEvent = {
    id: `event-${name}`,
    projectId: project.id,
    channel: fixtureChannel,
    action: "promote",
    status: channelEventStatus(routeRevisionStatus),
    previousDeploymentId,
    nextDeploymentId: deployment.id,
    routeRevisionId: routeRevision.id,
    actor: operator,
    reason: "Promote verified dashboard build after route dry-run.",
    idempotencyKey: `idem-${name}`,
    createdAt: "2026-05-15T01:25:00.000Z",
    completedAt: routeRevisionStatus === "applied" ? "2026-05-15T01:25:24.000Z" : undefined,
    safetyChecks
  };

  const auditEvents: AuditEvent[] = [
    {
      id: `audit-${name}-artifact`,
      projectId: project.id,
      action: "artifact.verified",
      actor: operator,
      targetType: "artifact",
      targetId: artifact.id,
      summary: "Artifact manifest recorded in control-plane database.",
      createdAt: "2026-05-15T01:24:18.000Z",
      metadata: {
        checksum: artifact.manifest.checksum,
        secretProbe: SITEFLOW_SECRET_CANARY
      }
    },
    {
      id: `audit-${name}-route`,
      projectId: project.id,
      action: routeRevisionStatus === "failed" ? "route.failed" : "route.applied",
      actor: operator,
      targetType: "route_revision",
      targetId: routeRevision.id,
      summary: routeRevision.validationSummary,
      reason: channelEvent.reason,
      createdAt: "2026-05-15T01:25:25.000Z"
    }
  ];

  const eventFeed = createEventFeed(sourceEvent, channelEvent, auditEvents);
  const routeEvidence = {
    routeRevision,
    checks: safetyChecks,
    previousKnownGoodDeploymentId: previousDeployment.id
  };

  const logChunk: LogChunkReadModel = {
    deploymentId: deployment.id,
    chunk: {
      deploymentId: deployment.id,
      buildJobId: buildJob.id,
      cursor: "0",
      lines: [
        "01:20:01 Installing dependencies with npm ci",
        `01:21:44 Loaded provider token ${SITEFLOW_SECRET_CANARY}`,
        "01:23:20 Static output prepared for artifact publishing"
      ],
      complete: true,
      fetchedAt: now
    },
    hasMore: false
  };

  const rollbackTarget: RollbackTargetReadModel = {
    deployment: previousSummary,
    eligible: rollbackEligible,
    disabledReason: rollbackEligible ? undefined : "Artifact is not verified and cannot be selected as a known-good target.",
    safetyChecks: createSafetyChecks(previousArtifact, previousRouteRevision, false, rollbackEligible)
  };

  const releaseConsole: ReleaseConsoleReadModel = {
    project,
    channel: fixtureChannel,
    currentDeployment: previousSummary,
    candidateDeployment: deploymentSummary,
    routePreview: routeEvidence,
    safetyChecks,
    recentChannelEvents: [channelEvent],
    auditEvents
  };

  const rollbackConsole: RollbackConsoleReadModel = {
    project,
    channel: fixtureChannel,
    currentDeployment: deploymentSummary,
    targets: [rollbackTarget],
    selectedTargetId: previousDeployment.id,
    routePreview: {
      routeRevision: previousRouteRevision,
      checks: rollbackTarget.safetyChecks,
      previousKnownGoodDeploymentId: deployment.id
    },
    recentChannelEvents: [channelEvent],
    auditEvents
  };

  const projectDetail: ProjectDetailReadModel = {
    project,
    channels: [
      {
        channel: releaseChannel,
        currentDeployment: deploymentSummary,
        routeRevision,
        cdnOperation: routeRevision.cdnOperation
      }
    ],
    deployments: [deploymentSummary, previousSummary],
    recentEvents: eventFeed,
    routeEvidence: [routeEvidence]
  };

  const deploymentDetail: DeploymentDetailReadModel = {
    project,
    deployment,
    lineage: {
      sourceEvent,
      buildJob,
      artifact,
      deployment,
      routeRevision,
      cdnOperation: routeRevision.cdnOperation
    },
    evidence: [
      {
        id: "evidence-source",
        label: "Source event accepted",
        status: sourceEvent.status === "accepted" ? "pass" : "fail",
        summary: sourceEvent.disposition
      },
      {
        id: "evidence-artifact",
        label: "Artifact verification",
        status: artifact.verificationStatus === "verified" ? "pass" : artifact.verificationStatus === "pending" ? "pending" : "fail",
        summary: artifact.verificationStatus
      },
      {
        id: "evidence-route",
        label: "Route revision",
        status: routeRevision.status === "applied" ? "pass" : routeRevision.status === "failed" ? "fail" : "warning",
        summary: routeRevision.validationSummary
      }
    ],
    routeEvidence,
    logs: logChunk,
    auditEvents
  };

  const promoteRejected = safetyChecks.some((check) => check.status === "fail");
  const rollbackRejected = rollbackTarget.safetyChecks.some((check) => check.status === "fail");

  const promoteResult: CommandResultReadModel = {
    status: promoteRejected ? "rejected" : "accepted",
    operationId: promoteRejected ? undefined : `op-${name}-promote`,
    channelEvent,
    routeRevision,
    safetyChecks,
    message: promoteRejected ? "Promotion rejected by safety checks." : "Promotion accepted and route operation queued."
  };

  const rollbackEvent: ChannelEvent = {
    ...channelEvent,
    id: `rollback-${name}`,
    action: "rollback",
    previousDeploymentId: deployment.id,
    nextDeploymentId: previousDeployment.id,
    safetyChecks: rollbackTarget.safetyChecks,
    reason: "Rollback to the previous known-good deployment."
  };

  const rollbackResult: CommandResultReadModel = {
    status: rollbackRejected ? "rejected" : "accepted",
    operationId: rollbackRejected ? undefined : `op-${name}-rollback`,
    channelEvent: rollbackEvent,
    routeRevision: previousRouteRevision,
    safetyChecks: rollbackTarget.safetyChecks,
    message: rollbackRejected ? "Rollback rejected by safety checks." : "Rollback accepted and route operation queued."
  };

  const operation: OperationSnapshotReadModel = {
    operationId: `op-${name}-promote`,
    projectId: project.id,
    state: operationState(routeRevisionStatus),
    kind: "promotion",
    channel: fixtureChannel,
    targetDeploymentId: deployment.id,
    routeRevision,
    cdnOperation: routeRevision.cdnOperation,
    updatedAt: now,
    message: routeRevision.validationSummary
  };

  const rollbackOperation: OperationSnapshotReadModel = {
    operationId: `op-${name}-rollback`,
    projectId: project.id,
    state: rollbackRejected ? "failed" : "succeeded",
    kind: "rollback",
    channel: fixtureChannel,
    targetDeploymentId: previousDeployment.id,
    routeRevision: previousRouteRevision,
    cdnOperation: previousRouteRevision.cdnOperation,
    updatedAt: now,
    message: rollbackRejected ? "Rollback target failed eligibility checks." : "Rollback route revision applied."
  };

  return {
    projectList: {
      summary: {
        totalProjects: 1,
        activeProjects: 1,
        deploymentsToday: 1,
        activeOperations: operation.state === "running" ? 1 : 0,
        routeDriftCount: routeRevision.status === "drifted" ? 1 : 0,
        failedRouteCount: routeRevision.status === "failed" ? 1 : 0,
        failedBuildCount: buildJob.status === "failed" ? 1 : 0,
        updatedAt: now
      },
      projects: [
        {
          project,
          productionDeployment: deploymentSummary,
          pendingDeploymentCount: deployment.status === "queued" || deployment.status === "building" ? 1 : 0,
          lastSourceEvent: sourceEvent,
          lastAuditEvent: auditEvents[0]
        }
      ],
      recentEvents: eventFeed
    },
    projects: {
      [project.id]: projectDetail
    },
    deployments: {
      [deployment.id]: deploymentDetail,
      [previousDeployment.id]: {
        ...deploymentDetail,
        deployment: previousDeployment,
        lineage: {
          sourceEvent: previousSource,
          buildJob: previousBuild,
          artifact: previousArtifact,
          deployment: previousDeployment,
          routeRevision: previousRouteRevision,
          cdnOperation: previousRouteRevision.cdnOperation
        },
        logs: {
          ...logChunk,
          deploymentId: previousDeployment.id,
          chunk: {
            ...logChunk.chunk,
            deploymentId: previousDeployment.id,
            buildJobId: previousBuild.id
          }
        }
      }
    },
    releaseConsoles: {
      [fixtureConsoleKey(project.id, fixtureChannel)]: releaseConsole
    },
    rollbackConsoles: {
      [fixtureConsoleKey(project.id, fixtureChannel)]: rollbackConsole
    },
    operations: {
      [operation.operationId]: operation,
      [rollbackOperation.operationId]: rollbackOperation
    },
    logs: {
      [deployment.id]: [logChunk],
      [previousDeployment.id]: [
        {
          ...logChunk,
          deploymentId: previousDeployment.id,
          chunk: {
            ...logChunk.chunk,
            deploymentId: previousDeployment.id,
            buildJobId: previousBuild.id
          }
        }
      ]
    },
    commandResults: {
      promote: promoteResult,
      rollback: rollbackResult
    }
  };
}

const emptyProjects: FixtureScenarioData = {
  projectList: {
    summary: {
      totalProjects: 0,
      activeProjects: 0,
      deploymentsToday: 0,
      activeOperations: 0,
      routeDriftCount: 0,
      failedRouteCount: 0,
      failedBuildCount: 0,
      updatedAt: now
    },
    projects: [],
    recentEvents: {
      sourceEvents: [],
      channelEvents: [],
      auditEvents: []
    },
    emptyState: "No SiteFlow projects have been created yet."
  },
  projects: {},
  deployments: {},
  releaseConsoles: {},
  rollbackConsoles: {},
  operations: {},
  logs: {},
  commandResults: {
    promote: {
      status: "rejected",
      safetyChecks: [],
      message: "No project is available for promotion."
    },
    rollback: {
      status: "rejected",
      safetyChecks: [],
      message: "No project is available for rollback."
    }
  }
};

export const siteflowFixtures = {
  healthy: createScenario("healthy"),
  queued: createScenario("queued", {
    buildStatus: "queued",
    deploymentStatus: "queued",
    artifactVerificationStatus: "pending",
    routeRevisionStatus: "planned",
    cdnOperationState: "queued"
  }),
  routeDrift: createScenario("routeDrift", {
    routeRevisionStatus: "drifted"
  }),
  routePending: createScenario("routePending", {
    routeRevisionStatus: "pending_apply",
    cdnOperationState: "queued"
  }),
  routeFailed: createScenario("routeFailed", {
    routeRevisionStatus: "failed",
    cdnOperationState: "failed"
  }),
  cdnDisabled: createScenario("cdnDisabled", {
    cdnEnabled: false,
    cdnOperationState: "disabled"
  }),
  rollbackIneligible: createScenario("rollbackIneligible", {
    rollbackEligible: false
  }),
  staleCandidate: createScenario("staleCandidate", {
    staleCandidate: true
  }),
  emptyProjects
} satisfies Record<SiteFlowScenarioName, FixtureScenarioData>;
