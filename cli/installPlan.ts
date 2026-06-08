import {
  defaultBuildMaxArtifactBytes,
  defaultBuildMaxArtifactFiles,
  defaultBuildMinFreeBytes,
  defaultPrebuiltMaxFiles,
  defaultPrebuiltMaxUploadBytes,
  normalizeBuildImage,
  normalizeBuildImageAllowlist,
  normalizeDnsName,
  normalizeProductionImage,
  renderComposeFile,
  renderManagedNginxConfig,
  renderSiteFlowEnvFile,
  renderSystemdUnit,
  type RenderedInstallAsset
} from "./installAssets.js";
import { createInitialInstallState, type InstallState, type SiteFlowTopology } from "./installState.js";

export interface InstallPlanStep {
  id: string;
  title: string;
  action: "validate" | "create" | "render" | "start" | "migrate" | "apply" | "verify" | "write";
  summary: string;
}

export interface InstallPlan {
  topology: SiteFlowTopology;
  dryRun: boolean;
  installState: InstallState;
  runtimeEnv: Record<string, string>;
  secrets: InstallSecretSpec[];
  renderedAssets: {
    env: RenderedInstallAsset;
    compose: RenderedInstallAsset;
    systemd: RenderedInstallAsset;
    nginx?: RenderedInstallAsset;
  };
  steps: InstallPlanStep[];
}

export interface InstallSecretSpec {
  id: string;
  path: string;
  description: string;
  byteLength: number;
}

export interface CreateInstallPlanInput {
  topology?: SiteFlowTopology;
  domain?: string;
  baseDomain?: string;
  apiPort?: number;
  publicScheme?: "http" | "https";
  image?: string;
  postgresImage?: string;
  dryRun?: boolean;
  workerPollIntervalMs?: number;
  buildImage?: string;
  buildImageAllowlist?: string[];
  version: string;
}

function normalizeOptionalDomain(value: string | undefined, label: string) {
  return value ? normalizeDnsName(value, label) : undefined;
}

function normalizeApiPort(value: number | undefined) {
  const port = value ?? 8787;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API port must be an integer between 1 and 65535.");
  }

  return port;
}

function normalizeWorkerPollIntervalMs(value: number | undefined) {
  const intervalMs = value ?? 5000;

  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Worker poll interval must be a positive integer.");
  }

  return intervalMs;
}

export function createSingleHostInstallPlan(input: CreateInstallPlanInput): InstallPlan {
  const topology = input.topology ?? "single";

  if (topology !== "single") {
    throw new Error(`Topology ${topology} is not implemented in the MVP installer.`);
  }

  const controlPlaneHost = normalizeOptionalDomain(input.domain, "Control-plane domain");
  const wildcardBaseDomain = normalizeOptionalDomain(input.baseDomain, "Wildcard base domain") ?? controlPlaneHost;
  const apiPort = normalizeApiPort(input.apiPort);
  const workerPollIntervalMs = normalizeWorkerPollIntervalMs(input.workerPollIntervalMs);
  const buildImage = normalizeBuildImage(input.buildImage);
  normalizeProductionImage(buildImage, "SITEFLOW_BUILD_IMAGE");
  const buildImageAllowlist = normalizeBuildImageAllowlist(input.buildImageAllowlist, buildImage);
  const publicScheme = input.publicScheme ?? (controlPlaneHost || wildcardBaseDomain ? "https" : "http");
  const image = normalizeProductionImage(input.image, "SITEFLOW_IMAGE");
  const postgresImage = normalizeProductionImage(input.postgresImage, "SITEFLOW_POSTGRES_IMAGE");
  const installState = createInitialInstallState({
    siteflowVersion: input.version,
    topology,
    domain: controlPlaneHost,
    baseDomain: wildcardBaseDomain,
    workerPollIntervalMs,
    buildImage,
    buildImageAllowlist
  });
  const runtimeEnv = {
    SITEFLOW_ENV: "production",
    SITEFLOW_VERSION: input.version,
    SITEFLOW_IMAGE: image,
    SITEFLOW_POSTGRES_IMAGE: postgresImage,
    SITEFLOW_API_PORT: String(apiPort),
    SITEFLOW_ARTIFACT_ROOT: installState.storage.artifactRoot ?? `${installState.paths.dataDir}/artifacts`,
    SITEFLOW_PUBLIC_SCHEME: publicScheme,
    SITEFLOW_TRUST_PROXY: "loopback",
    SITEFLOW_WORKER_POLL_INTERVAL_MS: String(workerPollIntervalMs),
    SITEFLOW_BUILD_RUNNER: "docker",
    SITEFLOW_BUILD_NETWORK: "none",
    SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: defaultBuildMaxArtifactBytes,
    SITEFLOW_BUILD_MAX_ARTIFACT_FILES: defaultBuildMaxArtifactFiles,
    SITEFLOW_BUILD_MIN_FREE_BYTES: defaultBuildMinFreeBytes,
    SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: defaultPrebuiltMaxUploadBytes,
    SITEFLOW_PREBUILT_MAX_FILES: defaultPrebuiltMaxFiles,
    SITEFLOW_BUILD_IMAGE: buildImage,
    ...(buildImageAllowlist.length > 0 ? { SITEFLOW_BUILD_IMAGE_ALLOWLIST: buildImageAllowlist.join(",") } : {}),
    ...(wildcardBaseDomain ? { SITEFLOW_BASE_DOMAIN: wildcardBaseDomain } : {})
  };
  const env = renderSiteFlowEnvFile({
    path: `${installState.paths.configDir}/siteflow.env`,
    apiPort,
    artifactRoot: runtimeEnv.SITEFLOW_ARTIFACT_ROOT,
    publicScheme,
    version: input.version,
    image,
    baseDomain: wildcardBaseDomain,
    siteflowEnv: "production",
    workerPollIntervalMs,
    buildImage,
    buildImageAllowlist
  });
  const compose = renderComposeFile({
    path: installState.services.composeFile,
    apiPort,
    artifactRoot: runtimeEnv.SITEFLOW_ARTIFACT_ROOT,
    publicScheme,
    version: input.version,
    image,
    postgresImage,
    baseDomain: wildcardBaseDomain,
    siteflowEnv: "production",
    workerPollIntervalMs,
    buildImage,
    buildImageAllowlist,
    dataDir: installState.paths.dataDir,
    configDir: installState.paths.configDir
  });
  const systemd = renderSystemdUnit({
    path: installState.services.unitPath,
    unitName: installState.services.unit,
    composeFile: installState.services.composeFile,
    workingDirectory: installState.paths.installDir
  });
  const secrets: InstallSecretSpec[] = [
    {
      id: "api-token",
      path: installState.secrets.apiTokenRef,
      description: "Bearer token used by CLI clients and deployment automation.",
      byteLength: 32
    },
    {
      id: "metrics-token",
      path: installState.secrets.metricsTokenRef,
      description: "Bearer token required to scrape production /metrics.",
      byteLength: 32
    },
    {
      id: "postgres-password",
      path: installState.secrets.postgresPasswordRef,
      description: "Password for the bundled Postgres siteflow user.",
      byteLength: 32
    },
    {
      id: "app-secret",
      path: installState.secrets.appSecretRef,
      description: "Internal application signing secret reserved for auth/session hardening.",
      byteLength: 32
    },
    {
      id: "worker-token",
      path: installState.secrets.workerTokenRef,
      description: "Internal worker registration token reserved for local build worker rollout.",
      byteLength: 32
    },
    {
      id: "github-webhook",
      path: installState.secrets.githubWebhookSecretRef ?? `${installState.paths.configDir}/secrets/github-webhook.secret`,
      description: "GitHub webhook signing secret used to verify inbound repository events.",
      byteLength: 32
    },
    {
      id: "gitlab-webhook",
      path: installState.secrets.gitlabWebhookSecretRef ?? `${installState.paths.configDir}/secrets/gitlab-webhook.secret`,
      description: "GitLab webhook signing secret used to verify inbound repository events.",
      byteLength: 32
    },
    {
      id: "gitea-webhook",
      path: installState.secrets.giteaWebhookSecretRef ?? `${installState.paths.configDir}/secrets/gitea-webhook.secret`,
      description: "Gitea webhook signing secret used to verify inbound repository events.",
      byteLength: 32
    },
    {
      id: "generic-webhook",
      path: installState.secrets.genericWebhookSecretRef ?? `${installState.paths.configDir}/secrets/generic-webhook.secret`,
      description: "Generic SiteFlow webhook signing secret used to verify inbound repository events.",
      byteLength: 32
    }
  ];
  const nginx =
    controlPlaneHost || wildcardBaseDomain
      ? renderManagedNginxConfig({
          path: installState.router.nginxConfigPath,
          controlPlaneHost,
          wildcardBaseDomain,
          apiPort
        })
      : undefined;

  installState.checksums = {
    env: env.checksum,
    compose: compose.checksum,
    systemd: systemd.checksum,
    ...(nginx ? { nginx: nginx.checksum } : {})
  };

  return {
    topology,
    dryRun: input.dryRun ?? true,
    installState,
    runtimeEnv,
    secrets,
    renderedAssets: {
      env,
      compose,
      systemd,
      ...(nginx ? { nginx } : {})
    },
    steps: [
      {
        id: "preflight",
        title: "Host preflight",
        action: "validate",
        summary: "Validate OS, CPU architecture, Docker, Nginx, ports, disk, clock, DNS, and TLS inputs."
      },
      {
        id: "directories",
        title: "Create directories and service user",
        action: "create",
        summary: "Create /opt/siteflow, /etc/siteflow, /var/lib/siteflow, /var/log/siteflow, and /var/backups/siteflow."
      },
      {
        id: "secrets",
        title: "Generate secret files",
        action: "create",
        summary: "Generate app, session, worker, webhook, bundled Postgres, and admin bootstrap secrets without printing raw values."
      },
      {
        id: "render-config",
        title: "Render service configuration",
        action: "render",
        summary: `Render Compose, env, systemd, and Nginx files to staging paths with checksums.${wildcardBaseDomain ? ` Preview hosts use *.${wildcardBaseDomain}.` : ""}`
      },
      {
        id: "database",
        title: "Start Postgres and run migrations",
        action: "migrate",
        summary: "Start bundled Postgres, acquire migration lock, and apply control-plane migrations."
      },
      {
        id: "services",
        title: "Start API and worker",
        action: "start",
        summary: "Start SiteFlow API and a separate local Docker build worker service, leaving a dedicated boundary for a future hardened runner."
      },
      {
        id: "artifacts",
        title: "Validate local artifact store",
        action: "verify",
        summary: "Write, read, and checksum a local artifact probe under /var/lib/siteflow/artifacts."
      },
      {
        id: "router",
        title: "Apply managed Nginx",
        action: "apply",
        summary: nginx
          ? `Validate generated Nginx config for ${[controlPlaneHost, nginx.previewHostPattern].filter(Boolean).join(" and ")}, swap it into sites-enabled, reload, and keep previous known-good config.`
          : "Validate generated Nginx config, swap it into sites-enabled, reload, and keep previous known-good config."
      },
      {
        id: "tls",
        title: "Configure TLS",
        action: "apply",
        summary: wildcardBaseDomain
          ? "Issue or validate TLS for the control-plane host and wildcard preview host. Wildcard Let's Encrypt requires DNS-01 support."
          : "Issue Let's Encrypt certificate or validate provided certificate paths when TLS is enabled."
      },
      {
        id: "doctor",
        title: "Run final doctor",
        action: "verify",
        summary: "Run critical host, service, DB, storage, route, TLS, and secret-permission checks."
      },
      {
        id: "state",
        title: "Write install state",
        action: "write",
        summary: "Persist /etc/siteflow/install-state.json only after critical checks pass."
      }
    ]
  };
}

export function formatInstallPlan(plan: InstallPlan): string {
  const lines = [`SiteFlow install plan (${plan.topology}, dry-run)`];

  for (const [index, step] of plan.steps.entries()) {
    lines.push(`${index + 1}. ${step.title} [${step.action}]`);
    lines.push(`   ${step.summary}`);
  }

  return lines.join("\n");
}
