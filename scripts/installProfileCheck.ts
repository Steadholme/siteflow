import { pathToFileURL } from "node:url";
import {
  type RenderedInstallAsset,
  renderComposeFile,
  renderManagedNginxConfig,
  renderSiteFlowEnvFile,
  renderSystemdUnit
} from "../cli/installAssets.js";

type CheckStatus = "pass" | "fail";
type InstallProfileStatus = "passed" | "blocked";

export interface InstallProfileCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface InstallProfileAssets {
  env: RenderedInstallAsset;
  compose: RenderedInstallAsset;
  systemd: RenderedInstallAsset;
  nginx: RenderedInstallAsset;
}

export interface InstallProfileCheckResult {
  name: "siteflow-install-profile-check";
  status: InstallProfileStatus;
  checkedAt: string;
  selectedEvidence: {
    envPath: string;
    composePath: string;
    systemdPath: string;
    nginxPath: string;
    checksPassed: number;
    checksTotal: number;
  };
  checks: InstallProfileCheck[];
  exitCode: number;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface ParsedArgs {
  json: boolean;
  help: boolean;
}

const apiPort = 8787;
const artifactRoot = "/var/lib/siteflow/artifacts";
const dataDir = "/var/lib/siteflow";
const configDir = "/etc/siteflow";
const image = `ghcr.io/siteflow/siteflow@sha256:${"a".repeat(64)}`;
const postgresImage = `postgres@sha256:${"b".repeat(64)}`;
const buildImage = `node:20-bookworm-slim@sha256:${"c".repeat(64)}`;
const version = "0.1.0-test";
const baseDomain = "w33d.xyz";
const controlPlaneHost = "siteflow.w33d.xyz";
const workerUser = "1000:1000";
const dockerSocketGid = "998";

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function check(name: string, passed: boolean, message: string, details?: Record<string, unknown>): InstallProfileCheck {
  return {
    name,
    status: passed ? "pass" : "fail",
    message,
    ...(details ? { details } : {})
  };
}

function containsAll(content: string, values: string[]) {
  return values.every((value) => content.includes(value));
}

function absentAll(content: string, values: string[]) {
  return values.every((value) => !content.includes(value));
}

function countOf(content: string, value: string) {
  return content.split(value).length - 1;
}

function composeServiceBlock(content: string, serviceName: string) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);

  if (start === -1) {
    return "";
  }

  const end = lines.findIndex((line, index) => index > start && /^(?:  [a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+):\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function nginxServerBlock(content: string, serverName: string) {
  const lines = content.split("\n");
  const serverNameLine = lines.findIndex((line) => line.trim() === `server_name ${serverName};`);

  if (serverNameLine === -1) {
    return "";
  }

  let start = serverNameLine;

  while (start >= 0 && lines[start].trim() !== "server {") {
    start -= 1;
  }

  if (start < 0) {
    return "";
  }

  let depth = 0;
  const block: string[] = [];

  for (const line of lines.slice(start)) {
    block.push(line);

    if (line.trim().endsWith("{")) {
      depth += 1;
    }

    if (line.trim() === "}") {
      depth -= 1;

      if (depth === 0) {
        break;
      }
    }
  }

  return block.join("\n");
}

export function renderReferenceInstallProfile(): InstallProfileAssets {
  return {
    env: renderSiteFlowEnvFile({
      apiPort,
      artifactRoot,
      publicScheme: "https",
      version,
      image,
      buildImage,
      workerUser,
      dockerSocketGid,
      baseDomain
    }),
    compose: renderComposeFile({
      apiPort,
      artifactRoot,
      publicScheme: "https",
      version,
      image,
      buildImage,
      workerUser,
      dockerSocketGid,
      baseDomain,
      dataDir,
      configDir,
      postgresImage
    }),
    systemd: renderSystemdUnit({
      composeFile: "/opt/siteflow/compose.yaml",
      envFile: "/etc/siteflow/siteflow.env",
      workingDirectory: "/opt/siteflow",
      unitName: "siteflow.service"
    }),
    nginx: renderManagedNginxConfig({
      controlPlaneHost,
      wildcardBaseDomain: baseDomain,
      apiPort
    })
  };
}

export function evaluateInstallProfileAssets(
  assets: InstallProfileAssets,
  options: { now?: () => Date } = {}
): InstallProfileCheckResult {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const checks: InstallProfileCheck[] = [];
  const env = assets.env.content;
  const compose = assets.compose.content;
  const systemd = assets.systemd.content;
  const nginx = assets.nginx.content;
  const postgresCompose = composeServiceBlock(compose, "postgres");
  const apiCompose = composeServiceBlock(compose, "api");
  const workerCompose = composeServiceBlock(compose, "worker");
  const wildcardNginx = nginxServerBlock(nginx, "*.w33d.xyz");

  checks.push(check(
    "install_profile_rendered_assets",
    containsAll(assets.env.checksum, ["sha256:"]) &&
      containsAll(assets.compose.checksum, ["sha256:"]) &&
      containsAll(assets.systemd.checksum, ["sha256:"]) &&
      containsAll(assets.nginx.checksum, ["sha256:"]),
    "Install profile assets must be rendered with checksums.",
    {
      envPath: assets.env.path,
      composePath: assets.compose.path,
      systemdPath: assets.systemd.path,
      nginxPath: assets.nginx.path
    }
  ));

  checks.push(check(
    "install_env_non_secret_runtime",
    containsAll(env, [
      "SITEFLOW_ENV=production",
      `SITEFLOW_API_PORT=${apiPort}`,
      "SITEFLOW_TRUST_PROXY=",
      `SITEFLOW_WORKER_USER=${workerUser}`,
      `SITEFLOW_DOCKER_SOCKET_GID=${dockerSocketGid}`,
      "SITEFLOW_BUILD_RUNNER=docker",
      "SITEFLOW_BUILD_NETWORK=none",
      "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912",
      "SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000",
      "SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824",
      "SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000",
      "SITEFLOW_GIT_TIMEOUT_MS=300000",
      "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912",
      "SITEFLOW_PREBUILT_MAX_FILES=20000",
      `SITEFLOW_BUILD_IMAGE=${buildImage}`
    ]) && absentAll(env, ["TOKEN", "SECRET", "WEBHOOK"]),
    "Non-secret env file must set production runtime posture without raw token, secret, webhook values, or default trusted proxy opt-in."
  ));

  checks.push(check(
    "install_env_trusted_proxy_opt_in",
    env.includes("SITEFLOW_TRUST_PROXY=") && !env.includes("SITEFLOW_TRUST_PROXY=loopback"),
    "Install env must leave SITEFLOW_TRUST_PROXY disabled by default; operators opt in only with target ingress evidence."
  ));

  checks.push(check(
    "install_nginx_loopback_upstream",
    nginx.includes(`server 127.0.0.1:${apiPort};`) && !nginx.includes(`server 0.0.0.0:${apiPort}`),
    "Managed Nginx must proxy only to the loopback API upstream."
  ));

  checks.push(check(
    "install_nginx_forwarded_headers_overwrite",
    containsAll(nginx, [
      "proxy_set_header Host $host;",
      "proxy_set_header X-Forwarded-Host $host;",
      "proxy_set_header X-Forwarded-Proto $scheme;",
      "proxy_set_header X-Forwarded-For $remote_addr;",
      "proxy_set_header X-Real-IP $remote_addr;"
    ]) && absentAll(nginx, ["$proxy_add_x_forwarded_for", "$http_x_forwarded_for", "$http_x_real_ip"]),
    "Managed Nginx must overwrite forwarded client headers instead of trusting inbound values."
  ));

  checks.push(check(
    "install_nginx_api_rate_limit",
    containsAll(nginx, [
      "limit_req_zone $binary_remote_addr zone=siteflow_api:10m rate=120r/m;",
      "location = /api",
      "location ^~ /api/",
      "limit_req zone=siteflow_api burst=60 nodelay;",
      "limit_req_status 429;"
    ]),
    "Managed Nginx must apply a rate limit to /api routes."
  ));

  checks.push(check(
    "install_nginx_wildcard_runtime_routes_blocked",
    containsAll(wildcardNginx, [
      "server_name *.w33d.xyz;",
      "location = /healthz",
      "location = /readyz",
      "return 404;"
    ]),
    "Wildcard preview hosts must not expose API health or readiness routes."
  ));

  checks.push(check(
    "install_compose_api_loopback_port",
    apiCompose.includes(`- "127.0.0.1:${apiPort}:${apiPort}"`) &&
      absentAll(apiCompose, [`- "${apiPort}:${apiPort}"`, `- "0.0.0.0:${apiPort}:${apiPort}"`]),
    "Compose API service must publish the API port on loopback only."
  ));

  checks.push(check(
    "install_compose_service_readiness",
    containsAll(postgresCompose, [
      "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}",
      "healthcheck:"
    ]) &&
      containsAll(apiCompose, [
        "depends_on:",
        "postgres:",
        "condition: service_healthy",
        "healthcheck:",
        "fetch('http://127.0.0.1:8787/readyz')"
      ]) &&
      containsAll(workerCompose, [
        "depends_on:",
        "postgres:",
        "api:",
        "condition: service_healthy"
      ]) &&
      countOf(compose, "condition: service_healthy") >= 3,
    "Compose services must gate startup on Postgres/API readiness and expose an API /readyz healthcheck."
  ));

  checks.push(check(
    "install_compose_container_hardening",
    containsAll(apiCompose, [
      'user: "1000:1000"',
      "init: true",
      "read_only: true",
      "cap_drop:",
      "- ALL",
      "no-new-privileges:true",
      "/tmp:rw,noexec,nosuid,nodev,size=64m"
    ]) &&
      containsAll(workerCompose, [
        'user: "${SITEFLOW_WORKER_USER:-1000:1000}"',
        "group_add:",
        '"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"',
        "init: true",
        "read_only: true",
        "cap_drop:",
        "- ALL",
        "no-new-privileges:true",
        "/tmp:rw,noexec,nosuid,nodev,size=512m"
      ]) &&
      countOf(compose, "init: true") >= 2 &&
      countOf(compose, "read_only: true") >= 2 &&
      countOf(compose, "cap_drop:") >= 2 &&
      countOf(compose, "- ALL") >= 2 &&
      countOf(compose, "no-new-privileges:true") >= 2,
    "Compose API and worker services must run with the production hardening posture."
  ));

  checks.push(check(
    "install_compose_secret_files",
    containsAll(apiCompose, [
      'DATABASE_URL: "postgres://siteflow@postgres:5432/siteflow"',
      "SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret",
      "SITEFLOW_API_TOKEN_FILE: /run/secrets/siteflow_api_token",
      "SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token",
      "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE: /run/secrets/siteflow_release_evidence_signing_key",
      "SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password",
      "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_github_webhook_secret",
      "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitlab_webhook_secret",
      "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitea_webhook_secret",
      "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_generic_webhook_secret"
    ]) &&
      containsAll(workerCompose, [
        'DATABASE_URL: "postgres://siteflow@postgres:5432/siteflow"',
        "SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret",
        "SITEFLOW_POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password"
      ]) &&
      containsAll(compose, [
        "- siteflow_release_evidence_signing_key",
        "file: /etc/siteflow/secrets/app-secret.secret",
        "file: /etc/siteflow/secrets/api-token.secret",
        "file: /etc/siteflow/secrets/metrics-token.secret",
        "file: /etc/siteflow/secrets/release-evidence-signing-key.secret",
        "file: /etc/siteflow/secrets/postgres-password.secret",
        "file: /etc/siteflow/secrets/github-webhook.secret",
        "file: /etc/siteflow/secrets/gitlab-webhook.secret",
        "file: /etc/siteflow/secrets/gitea-webhook.secret",
        "file: /etc/siteflow/secrets/generic-webhook.secret"
      ]) && absentAll(compose, ["export SITEFLOW_", "$(cat /run/secrets/"]),
    "Compose profile must expose Docker secret file paths to the application without exporting secret values into the process environment."
  ));

  checks.push(check(
    "install_compose_metrics_token_required",
    apiCompose.includes("SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token") &&
      !compose.includes("export SITEFLOW_METRICS_TOKEN=") &&
      !compose.includes("SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS"),
    "Compose profile must require metrics token file injection and must not enable unauthenticated metrics."
  ));

  checks.push(check(
    "install_compose_digest_pinned_images",
    containsAll(compose, [
      `image: ${image}`,
      `image: ${postgresImage}`,
      `SITEFLOW_BUILD_IMAGE: "${buildImage}"`
    ]) && absentAll(compose, ["build:", "siteflow-console:production", "postgres:16-alpine"]),
    "Compose profile must use digest-pinned runtime, Postgres, and build images without local build defaults."
  ));

  checks.push(check(
    "install_compose_worker_docker_runner",
    containsAll(workerCompose, [
      'user: "${SITEFLOW_WORKER_USER:-1000:1000}"',
      "group_add:",
      '"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"',
      'SITEFLOW_BUILD_RUNNER: "docker"',
      'SITEFLOW_BUILD_NETWORK: "none"',
      'SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "536870912"',
      'SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "20000"',
      'SITEFLOW_BUILD_STEP_TIMEOUT_MS: "900000"',
      'SITEFLOW_GIT_TIMEOUT_MS: "300000"',
      'SITEFLOW_GIT_SSH_KEY_PATH: "${SITEFLOW_GIT_SSH_KEY_PATH:-}"',
      'SITEFLOW_GIT_KNOWN_HOSTS_PATH: "${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}"',
      `SITEFLOW_BUILD_IMAGE: "${buildImage}"`,
      "command -v docker",
      "docker info",
      "/var/run/docker.sock:/var/run/docker.sock",
      "requires access to the trusted single-host Docker socket",
      "Trusted single-host operator profile",
      "not a multi-tenant sandbox boundary",
      "exec node dist-worker/worker/index.js"
    ]),
    "Compose worker must use the Docker build runner with network disabled and explicit socket-risk messaging."
  ));

  checks.push(check(
    "install_compose_worker_healthcheck",
    containsAll(workerCompose, [
      'test: ["CMD", "node", "dist-worker/worker/index.js", "--healthcheck"]',
      "interval: 30s",
      "timeout: 10s",
      "retries: 5",
      "start_period: 30s"
    ]),
    "Compose worker must expose the SiteFlow worker healthcheck so Docker socket and production runtime posture failures surface after startup."
  ));

  checks.push(check(
    "install_compose_backup_evidence_mount",
    containsAll(apiCompose, [
      'SITEFLOW_EVIDENCE_ROOT: "/var/lib/siteflow/evidence"',
      'SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD: "/var/lib/siteflow/evidence/backup-automation-run.json"',
      "- /var/lib/siteflow/evidence:/var/lib/siteflow/evidence:ro"
    ]),
    "Compose API service must read the backup automation evidence record from a read-only evidence mount."
  ));

  checks.push(check(
    "install_systemd_compose_unit",
    containsAll(systemd, [
      "Requires=docker.service",
      "After=docker.service network-online.target",
      "ExecStart=/usr/bin/docker compose --env-file /etc/siteflow/siteflow.env -f /opt/siteflow/compose.yaml up -d",
      "ExecStop=/usr/bin/docker compose --env-file /etc/siteflow/siteflow.env -f /opt/siteflow/compose.yaml down",
      "WantedBy=multi-user.target"
    ]),
    "Systemd unit must manage the Compose stack and require Docker."
  ));

  const passedCount = checks.filter((entry) => entry.status === "pass").length;
  const passed = passedCount === checks.length;

  return {
    name: "siteflow-install-profile-check",
    status: passed ? "passed" : "blocked",
    checkedAt,
    selectedEvidence: {
      envPath: assets.env.path,
      composePath: assets.compose.path,
      systemdPath: assets.systemd.path,
      nginxPath: assets.nginx.path,
      checksPassed: passedCount,
      checksTotal: checks.length
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export function runInstallProfileCheck(options: { now?: () => Date } = {}) {
  return evaluateInstallProfileAssets(renderReferenceInstallProfile(), options);
}

export function parseInstallProfileCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false
  };

  for (const arg of args) {
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function installProfileCheckUsage() {
  return [
    "Usage: npm run --silent release:install-profile:check -- [options]",
    "",
    "Options:",
    "  --json    Emit a single JSON result.",
    "  --help    Show this help."
  ].join("\n");
}

function writeHumanResult(result: InstallProfileCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow install profile status: ${result.status}\n`);

  for (const entry of result.checks) {
    output.write(`- ${entry.name}: ${entry.status} - ${entry.message}\n`);
  }
}

export async function runInstallProfileCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr }
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseInstallProfileCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${installProfileCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${installProfileCheckUsage()}\n`);
    return 0;
  }

  const result = runInstallProfileCheck();

  if (parsed.json) {
    const output = result.status === "passed" ? io.stdout : io.stderr;
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, io);
  }

  return result.exitCode;
}

if (isEntrypoint()) {
  runInstallProfileCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
