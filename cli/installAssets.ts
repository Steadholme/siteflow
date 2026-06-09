import { createHash } from "node:crypto";

export interface RenderedInstallAsset {
  path: string;
  checksum: string;
  content: string;
}

export interface ManagedNginxConfigOptions {
  controlPlaneHost?: string;
  wildcardBaseDomain?: string;
  apiPort?: number;
  path?: string;
  clientMaxBodySize?: string;
}

export interface ManagedNginxConfig extends RenderedInstallAsset {
  controlPlaneHost?: string;
  wildcardBaseDomain?: string;
  previewHostPattern?: string;
  apiPort: number;
}

export interface SiteFlowEnvFileOptions {
  apiPort: number;
  artifactRoot: string;
  publicScheme: "http" | "https";
  version: string;
  image: string;
  baseDomain?: string;
  siteflowEnv?: "development" | "production";
  workerUser?: string;
  dockerSocketGid?: string;
  workerPollIntervalMs?: number;
  buildImage?: string;
  buildImageAllowlist?: string[];
  path?: string;
}

export interface ComposeFileOptions extends SiteFlowEnvFileOptions {
  dataDir: string;
  configDir: string;
  databaseName?: string;
  databaseUser?: string;
  postgresImage?: string;
  path?: string;
}

export interface SystemdUnitOptions {
  composeFile: string;
  workingDirectory: string;
  envFile?: string;
  unitName?: string;
  path?: string;
}

function checksum(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function renderedAsset(path: string, content: string): RenderedInstallAsset {
  return {
    path,
    checksum: checksum(content),
    content
  };
}

export function normalizeDnsName(value: string, label = "Domain") {
  const normalized = value.trim().toLowerCase().replace(/^\*\./, "");

  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  if (!/^[a-z0-9.-]+$/.test(normalized) || !normalized.includes(".")) {
    throw new Error(`${label} must be a DNS name such as w33d.xyz.`);
  }

  const labels = normalized.split(".");

  for (const part of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) {
      throw new Error(`${label} contains an invalid DNS label: ${part || "<empty>"}.`);
    }
  }

  const tld = labels[labels.length - 1];

  if (!/^[a-z]{2,63}$/.test(tld)) {
    throw new Error(`${label} must end with a public DNS suffix such as .xyz.`);
  }

  return normalized;
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

export const defaultWorkerUser = "1000:1000";
export const defaultProductionBuildImage = "node:20-bookworm-slim";
export const defaultBuildMaxArtifactBytes = "536870912";
export const defaultBuildMaxArtifactFiles = "20000";
export const defaultBuildMinFreeBytes = "1073741824";
export const defaultBuildStepTimeoutMs = "900000";
export const defaultGitTimeoutMs = "300000";
export const defaultPrebuiltMaxUploadBytes = "536870912";
export const defaultPrebuiltMaxFiles = "20000";

export function normalizeWorkerUser(value: string | undefined) {
  const normalized = (value ?? defaultWorkerUser).trim();

  if (!/^[1-9]\d*(?::[1-9]\d*)?$/.test(normalized)) {
    throw new Error("SITEFLOW_WORKER_USER must be a non-root numeric user or user:group value.");
  }

  return normalized;
}

export function normalizeDockerSocketGid(value: string | undefined) {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error("SITEFLOW_DOCKER_SOCKET_GID is required and must match /var/run/docker.sock group id.");
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error("SITEFLOW_DOCKER_SOCKET_GID must be a numeric group id.");
  }

  return normalized;
}

function hasDockerDigest(image: string) {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}

function normalizeDockerImageReference(value: string | undefined, label: string) {
  const normalized = (value ?? "").trim();

  if (
    !normalized
    || normalized.length > 255
    || normalized.startsWith("-")
    || /[\s\x00-\x1f\x7f]/.test(normalized)
    || normalized.includes("://")
    || normalized.includes("..")
    || normalized.includes("//")
  ) {
    throw new Error(`${label} must be a valid Docker image reference.`);
  }

  return normalized;
}

export function normalizeProductionImage(value: string | undefined, label: string) {
  const normalized = normalizeDockerImageReference(value, label);

  if (!hasDockerDigest(normalized)) {
    throw new Error(`${label} must be pinned by sha256 digest for production.`);
  }

  return normalized;
}

function imageTag(image: string) {
  if (hasDockerDigest(image)) {
    return undefined;
  }

  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");

  if (lastColon <= lastSlash) {
    return undefined;
  }

  return image.slice(lastColon + 1);
}

export function normalizeBuildImage(value: string | undefined) {
  const normalized = normalizeDockerImageReference(value ?? defaultProductionBuildImage, "SITEFLOW_BUILD_IMAGE");
  const tag = imageTag(normalized);

  if (!hasDockerDigest(normalized) && tag === undefined) {
    throw new Error("SITEFLOW_BUILD_IMAGE must include an explicit tag or sha256 digest.");
  }

  if (tag?.toLowerCase() === "latest") {
    throw new Error("SITEFLOW_BUILD_IMAGE must not use the mutable latest tag.");
  }

  return normalized;
}

export function normalizeBuildImageAllowlist(value: string[] | undefined, buildImage: string) {
  const entries = value?.map((entry) => entry.trim()).filter(Boolean) ?? [];

  if (entries.some((entry) => entry.startsWith("-") || /\s/.test(entry))) {
    throw new Error("SITEFLOW_BUILD_IMAGE_ALLOWLIST must contain comma-separated Docker image references or prefix* entries.");
  }

  if (entries.length > 0 || hasDockerDigest(buildImage)) {
    return entries;
  }

  return [buildImage];
}

function buildImageEnvLines(buildImage: string, buildImageAllowlist: string[], indent = "") {
  const lines = [`${indent}SITEFLOW_BUILD_IMAGE${indent ? ": " : "="}${indent ? `"${buildImage}"` : buildImage}`];

  if (buildImageAllowlist.length > 0) {
    const value = buildImageAllowlist.join(",");
    lines.push(`${indent}SITEFLOW_BUILD_IMAGE_ALLOWLIST${indent ? ": " : "="}${indent ? `"${value}"` : value}`);
  }

  return lines;
}

function proxyHeaders() {
  return [
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Forwarded-Host $host;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_set_header X-Forwarded-For $remote_addr;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header Connection \"\";"
  ].join("\n");
}

function proxyLocation() {
  return [
    "    location / {",
    "        proxy_pass http://siteflow_api;",
    proxyHeaders(),
    "    }"
  ].join("\n");
}

function apiProxyLocation(match: string) {
  return [
    `    location ${match} {`,
    "        limit_req zone=siteflow_api burst=60 nodelay;",
    "        limit_req_status 429;",
    "        proxy_pass http://siteflow_api;",
    proxyHeaders(),
    "    }"
  ].join("\n");
}

export function renderManagedNginxConfig(options: ManagedNginxConfigOptions): ManagedNginxConfig {
  const controlPlaneHost = options.controlPlaneHost ? normalizeDnsName(options.controlPlaneHost, "Control-plane domain") : undefined;
  const wildcardBaseDomain = options.wildcardBaseDomain ? normalizeDnsName(options.wildcardBaseDomain, "Wildcard base domain") : undefined;
  const apiPort = normalizeApiPort(options.apiPort);
  const clientMaxBodySize = options.clientMaxBodySize ?? "128m";

  if (!controlPlaneHost && !wildcardBaseDomain) {
    throw new Error("Managed Nginx requires a control-plane domain or wildcard base domain.");
  }

  const blocks = [
    "# Generated by SiteFlow. Do not edit manually.",
    "# Source: siteflow install render-config",
    "",
    "upstream siteflow_api {",
    `    server 127.0.0.1:${apiPort};`,
    "    keepalive 32;",
    "}",
    "",
    "limit_req_zone $binary_remote_addr zone=siteflow_api:10m rate=120r/m;"
  ];

  if (controlPlaneHost) {
    blocks.push(
      "",
      "server {",
      "    listen 80;",
      `    server_name ${controlPlaneHost};`,
      "",
      `    client_max_body_size ${clientMaxBodySize};`,
      "",
      apiProxyLocation("= /api"),
      "",
      apiProxyLocation("^~ /api/"),
      "",
      proxyLocation(),
      "}"
    );
  }

  if (wildcardBaseDomain) {
    blocks.push(
      "",
      "server {",
      "    listen 80;",
      `    server_name *.${wildcardBaseDomain};`,
      "",
      `    client_max_body_size ${clientMaxBodySize};`,
      "",
      "    location = /api {",
      "        return 404;",
      "    }",
      "",
      "    location ^~ /api/ {",
      "        return 404;",
      "    }",
      "",
      "    location = /healthz {",
      "        return 404;",
      "    }",
      "",
      "    location = /readyz {",
      "        return 404;",
      "    }",
      "",
      proxyLocation(),
      "}"
    );
  }

  const content = `${blocks.join("\n")}\n`;

  return {
    ...renderedAsset(options.path ?? "/etc/nginx/sites-available/siteflow.conf", content),
    controlPlaneHost,
    wildcardBaseDomain,
    previewHostPattern: wildcardBaseDomain ? `*.${wildcardBaseDomain}` : undefined,
    apiPort
  };
}

export function renderSiteFlowEnvFile(options: SiteFlowEnvFileOptions): RenderedInstallAsset {
  const runtimeImage = options.siteflowEnv === "development"
    ? normalizeDockerImageReference(options.image, "SITEFLOW_IMAGE")
    : normalizeProductionImage(options.image, "SITEFLOW_IMAGE");
  const buildImage = normalizeBuildImage(options.buildImage);
  const buildImageAllowlist = normalizeBuildImageAllowlist(options.buildImageAllowlist, buildImage);
  const workerUser = normalizeWorkerUser(options.workerUser);
  const dockerSocketGid = normalizeDockerSocketGid(options.dockerSocketGid);
  const lines = [
    `SITEFLOW_ENV=${options.siteflowEnv ?? "production"}`,
    `SITEFLOW_VERSION=${options.version}`,
    `SITEFLOW_IMAGE=${runtimeImage}`,
    `SITEFLOW_API_PORT=${options.apiPort}`,
    `SITEFLOW_ARTIFACT_ROOT=${options.artifactRoot}`,
    `SITEFLOW_PUBLIC_SCHEME=${options.publicScheme}`,
    "SITEFLOW_TRUST_PROXY=",
    `SITEFLOW_WORKER_USER=${workerUser}`,
    `SITEFLOW_DOCKER_SOCKET_GID=${dockerSocketGid}`,
    `SITEFLOW_WORKER_POLL_INTERVAL_MS=${normalizeWorkerPollIntervalMs(options.workerPollIntervalMs)}`,
    "SITEFLOW_BUILD_RUNNER=docker",
    "SITEFLOW_BUILD_NETWORK=none",
    `SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=${defaultBuildMaxArtifactBytes}`,
    `SITEFLOW_BUILD_MAX_ARTIFACT_FILES=${defaultBuildMaxArtifactFiles}`,
    `SITEFLOW_BUILD_MIN_FREE_BYTES=${defaultBuildMinFreeBytes}`,
    `SITEFLOW_BUILD_STEP_TIMEOUT_MS=${defaultBuildStepTimeoutMs}`,
    `SITEFLOW_GIT_TIMEOUT_MS=${defaultGitTimeoutMs}`,
    `SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=${defaultPrebuiltMaxUploadBytes}`,
    `SITEFLOW_PREBUILT_MAX_FILES=${defaultPrebuiltMaxFiles}`,
    ...buildImageEnvLines(buildImage, buildImageAllowlist)
  ];

  if (options.baseDomain) {
    lines.push(`SITEFLOW_BASE_DOMAIN=${normalizeDnsName(options.baseDomain, "Wildcard base domain")}`);
  }

  return renderedAsset(options.path ?? "/etc/siteflow/siteflow.env", `${lines.join("\n")}\n`);
}

export function renderComposeFile(options: ComposeFileOptions): RenderedInstallAsset {
  const databaseName = options.databaseName ?? "siteflow";
  const databaseUser = options.databaseUser ?? "siteflow";
  const productionProfile = options.siteflowEnv !== "development";
  const runtimeImage = productionProfile
    ? normalizeProductionImage(options.image, "SITEFLOW_IMAGE")
    : normalizeDockerImageReference(options.image, "SITEFLOW_IMAGE");
  const postgresImage = productionProfile
    ? normalizeProductionImage(options.postgresImage, "SITEFLOW_POSTGRES_IMAGE")
    : normalizeDockerImageReference(options.postgresImage ?? "postgres:16-alpine", "SITEFLOW_POSTGRES_IMAGE");
  const postgresData = `${options.dataDir}/postgres`;
  const evidenceRoot = `${options.dataDir}/evidence`;
  const backupAutomationRunRecord = `${evidenceRoot}/backup-automation-run.json`;
  const apiPort = normalizeApiPort(options.apiPort);
  const workerPollIntervalMs = normalizeWorkerPollIntervalMs(options.workerPollIntervalMs);
  const buildImage = normalizeBuildImage(options.buildImage);
  const buildImageAllowlist = normalizeBuildImageAllowlist(options.buildImageAllowlist, buildImage);
  const workerUser = normalizeWorkerUser(options.workerUser);
  const sharedEnvLines = [
    `      SITEFLOW_ENV: "${options.siteflowEnv ?? "production"}"`,
    `      SITEFLOW_ARTIFACT_ROOT: "${options.artifactRoot}"`,
    `      SITEFLOW_PUBLIC_SCHEME: "${options.publicScheme}"`,
    '      SITEFLOW_TRUST_PROXY: ""'
  ];
  const apiEnvLines = [
    ...sharedEnvLines,
    `      DATABASE_URL: "postgres://${databaseUser}@postgres:5432/${databaseName}"`,
    `      SITEFLOW_API_PORT: "${apiPort}"`,
    `      SITEFLOW_EVIDENCE_ROOT: "${evidenceRoot}"`,
    `      SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "${defaultPrebuiltMaxUploadBytes}"`,
    `      SITEFLOW_PREBUILT_MAX_FILES: "${defaultPrebuiltMaxFiles}"`,
    `      SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD: "${backupAutomationRunRecord}"`
  ];
  const workerEnvLines = [
    ...sharedEnvLines,
    `      DATABASE_URL: "postgres://${databaseUser}@postgres:5432/${databaseName}"`,
    `      SITEFLOW_BUILD_RUNNER: "docker"`,
    `      SITEFLOW_BUILD_NETWORK: "none"`,
    `      SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "${defaultBuildMaxArtifactBytes}"`,
    `      SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "${defaultBuildMaxArtifactFiles}"`,
    `      SITEFLOW_BUILD_MIN_FREE_BYTES: "${defaultBuildMinFreeBytes}"`,
    `      SITEFLOW_BUILD_STEP_TIMEOUT_MS: "${defaultBuildStepTimeoutMs}"`,
    `      SITEFLOW_GIT_TIMEOUT_MS: "${defaultGitTimeoutMs}"`,
    '      SITEFLOW_GIT_SSH_KEY_PATH: "${SITEFLOW_GIT_SSH_KEY_PATH:-}"',
    '      SITEFLOW_GIT_KNOWN_HOSTS_PATH: "${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}"',
    ...buildImageEnvLines(buildImage, buildImageAllowlist, "      "),
    `      TMPDIR: "${options.artifactRoot}"`,
    `      SITEFLOW_WORKER_POLL_INTERVAL_MS: "${workerPollIntervalMs}"`
  ];

  if (options.baseDomain) {
    const baseDomain = `      SITEFLOW_BASE_DOMAIN: "${normalizeDnsName(options.baseDomain, "Wildcard base domain")}"`;

    apiEnvLines.push(baseDomain);
    workerEnvLines.push(baseDomain);
  }

  const content = [
    "# Generated by SiteFlow. Do not edit manually.",
    "services:",
    "  postgres:",
    `    image: ${postgresImage}`,
    "    restart: unless-stopped",
    "    environment:",
    `      POSTGRES_DB: ${databaseName}`,
    `      POSTGRES_USER: ${databaseUser}`,
    "      POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
    "    volumes:",
    `      - ${postgresData}:/var/lib/postgresql/data`,
    "    secrets:",
    "      - siteflow_postgres_password",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]',
    "      interval: 10s",
    "      timeout: 5s",
    "      retries: 6",
    "",
    "  api:",
    `    image: ${runtimeImage}`,
    "    restart: unless-stopped",
    '    user: "1000:1000"',
    "    init: true",
    "    read_only: true",
    "    cap_drop:",
    "      - ALL",
    "    security_opt:",
    "      - no-new-privileges:true",
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    environment:",
    ...apiEnvLines,
    "      SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret",
    "      SITEFLOW_API_TOKEN_FILE: /run/secrets/siteflow_api_token",
    "      SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token",
    "      SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE: /run/secrets/siteflow_release_evidence_signing_key",
    "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
    "      SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_github_webhook_secret",
    "      SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitlab_webhook_secret",
    "      SITEFLOW_GITEA_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitea_webhook_secret",
    "      SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_generic_webhook_secret",
    "    ports:",
    `      - \"127.0.0.1:${apiPort}:${apiPort}\"`,
    "    volumes:",
    `      - ${options.artifactRoot}:${options.artifactRoot}`,
    `      - ${evidenceRoot}:${evidenceRoot}:ro`,
    "    tmpfs:",
    "      - /tmp:rw,noexec,nosuid,nodev,size=64m",
    "    secrets:",
    "      - siteflow_app_secret",
    "      - siteflow_api_token",
    "      - siteflow_metrics_token",
    "      - siteflow_release_evidence_signing_key",
    "      - siteflow_postgres_password",
    "      - siteflow_github_webhook_secret",
    "      - siteflow_gitlab_webhook_secret",
    "      - siteflow_gitea_webhook_secret",
    "      - siteflow_generic_webhook_secret",
    "    healthcheck:",
    `      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${apiPort}/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]`,
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 5",
    "      start_period: 30s",
    "",
    "  worker:",
    `    image: ${runtimeImage}`,
    "    restart: unless-stopped",
    `    user: "\${SITEFLOW_WORKER_USER:-${workerUser}}"`,
    "    group_add:",
    '      - "${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"',
    "    init: true",
    "    read_only: true",
    "    cap_drop:",
    "      - ALL",
    "    security_opt:",
    "      - no-new-privileges:true",
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "      api:",
    "        condition: service_healthy",
    "    environment:",
    ...workerEnvLines,
    "      SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret",
    "      SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
    "    command:",
    "      - sh",
    "      - -ec",
    "      - |",
    "        : \"$${SITEFLOW_BASE_DOMAIN:?SITEFLOW_BASE_DOMAIN is required for worker preview routes}\"",
    "        if ! command -v docker >/dev/null 2>&1; then",
    "          echo \"SITEFLOW_BUILD_RUNNER=docker requires the Docker CLI inside the worker image.\" >&2",
    "          exit 1",
    "        fi",
    "        if ! docker info >/dev/null 2>&1; then",
    "          echo \"SITEFLOW_BUILD_RUNNER=docker requires access to the trusted single-host Docker socket.\" >&2",
    "          exit 1",
    "        fi",
    "        exec node dist-worker/worker/index.js",
    "    volumes:",
    `      - ${options.artifactRoot}:${options.artifactRoot}`,
    "      - /var/run/docker.sock:/var/run/docker.sock",
    "    tmpfs:",
    "      - /tmp:rw,noexec,nosuid,nodev,size=512m",
    "    secrets:",
    "      - siteflow_app_secret",
    "      - siteflow_postgres_password",
    "    healthcheck:",
    '      test: ["CMD", "node", "dist-worker/worker/index.js", "--healthcheck"]',
    "      interval: 30s",
    "      timeout: 10s",
    "      retries: 5",
    "      start_period: 30s",
    "    # Trusted single-host operator profile: the socket-mounted worker controls",
    "    # the host Docker daemon and is not a multi-tenant sandbox boundary.",
    "",
    "secrets:",
    "  siteflow_app_secret:",
    `    file: ${options.configDir}/secrets/app-secret.secret`,
    "  siteflow_api_token:",
    `    file: ${options.configDir}/secrets/api-token.secret`,
    "  siteflow_metrics_token:",
    `    file: ${options.configDir}/secrets/metrics-token.secret`,
    "  siteflow_release_evidence_signing_key:",
    `    file: ${options.configDir}/secrets/release-evidence-signing-key.secret`,
    "  siteflow_postgres_password:",
    `    file: ${options.configDir}/secrets/postgres-password.secret`,
    "  siteflow_github_webhook_secret:",
    `    file: ${options.configDir}/secrets/github-webhook.secret`,
    "  siteflow_gitlab_webhook_secret:",
    `    file: ${options.configDir}/secrets/gitlab-webhook.secret`,
    "  siteflow_gitea_webhook_secret:",
    `    file: ${options.configDir}/secrets/gitea-webhook.secret`,
    "  siteflow_generic_webhook_secret:",
    `    file: ${options.configDir}/secrets/generic-webhook.secret`
  ].join("\n");

  return renderedAsset(options.path ?? "/opt/siteflow/compose.yaml", `${content}\n`);
}

export function renderSystemdUnit(options: SystemdUnitOptions): RenderedInstallAsset {
  const unitName = options.unitName ?? "siteflow.service";
  const envFileArgs = options.envFile ? `--env-file ${options.envFile} ` : "";
  const content = [
    "# Generated by SiteFlow. Do not edit manually.",
    "[Unit]",
    "Description=SiteFlow single-host stack",
    "Requires=docker.service",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `WorkingDirectory=${options.workingDirectory}`,
    `ExecStart=/usr/bin/docker compose ${envFileArgs}-f ${options.composeFile} up -d`,
    `ExecStop=/usr/bin/docker compose ${envFileArgs}-f ${options.composeFile} down`,
    "TimeoutStartSec=0",
    "",
    "[Install]",
    "WantedBy=multi-user.target"
  ].join("\n");

  return renderedAsset(options.path ?? `/etc/systemd/system/${unitName}`, `${content}\n`);
}
