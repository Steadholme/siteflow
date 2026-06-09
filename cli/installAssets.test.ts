import { renderComposeFile, renderManagedNginxConfig, renderSiteFlowEnvFile, renderSystemdUnit } from "./installAssets";

const runtimeImage = `ghcr.io/siteflow/siteflow@sha256:${"a".repeat(64)}`;
const postgresImage = `postgres@sha256:${"b".repeat(64)}`;
const buildImage = `node:20-bookworm-slim@sha256:${"c".repeat(64)}`;

describe("install asset renderers", () => {
  it("renders managed Nginx config for control-plane and wildcard preview hosts", () => {
    const config = renderManagedNginxConfig({
      controlPlaneHost: "siteflow.w33d.xyz",
      wildcardBaseDomain: "w33d.xyz",
      apiPort: 8787
    });

    expect(config.previewHostPattern).toBe("*.w33d.xyz");
    expect(config.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(config.content).toContain("server_name siteflow.w33d.xyz;");
    expect(config.content).toContain("server_name *.w33d.xyz;");
    expect(config.content).toContain("server 127.0.0.1:8787;");
    expect(config.content).toContain("limit_req_zone $binary_remote_addr zone=siteflow_api:10m rate=120r/m;");
    expect(config.content).toContain("location = /api");
    expect(config.content).toContain("limit_req zone=siteflow_api burst=60 nodelay;");
    expect(config.content).toContain("limit_req_status 429;");
    expect(config.content).toContain("proxy_set_header X-Forwarded-Host $host;");
    expect(config.content).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(config.content).toContain("proxy_set_header X-Real-IP $remote_addr;");
    expect(config.content).not.toContain("$proxy_add_x_forwarded_for");
    expect(config.content).toContain("location ^~ /api/");
    expect(config.content).toContain("location = /readyz");
    expect(config.content).toContain("return 404;");
  });

  it("renders SITEFLOW_BASE_DOMAIN into the non-secret env file", () => {
    const env = renderSiteFlowEnvFile({
      apiPort: 8787,
      artifactRoot: "/var/lib/siteflow/artifacts",
      publicScheme: "https",
      version: "0.1.0-test",
      image: runtimeImage,
      dockerSocketGid: "998",
      buildImage,
      baseDomain: "w33d.xyz"
    });

    expect(env.content).toContain("SITEFLOW_ENV=production");
    expect(env.content).toContain("SITEFLOW_VERSION=0.1.0-test");
    expect(env.content).toContain(`SITEFLOW_IMAGE=${runtimeImage}`);
    expect(env.content).toContain("SITEFLOW_API_PORT=8787");
    expect(env.content).toContain("SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts");
    expect(env.content).toContain("SITEFLOW_PUBLIC_SCHEME=https");
    expect(env.content).toContain("SITEFLOW_TRUST_PROXY=");
    expect(env.content).not.toContain("SITEFLOW_TRUST_PROXY=loopback");
    expect(env.content).toContain("SITEFLOW_WORKER_USER=1000:1000");
    expect(env.content).toContain("SITEFLOW_DOCKER_SOCKET_GID=998");
    expect(env.content).toContain("SITEFLOW_WORKER_POLL_INTERVAL_MS=5000");
    expect(env.content).toContain("SITEFLOW_BUILD_RUNNER=docker");
    expect(env.content).toContain("SITEFLOW_BUILD_NETWORK=none");
    expect(env.content).toContain("SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912");
    expect(env.content).toContain("SITEFLOW_BUILD_MAX_ARTIFACT_FILES=20000");
    expect(env.content).toContain("SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824");
    expect(env.content).toContain("SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000");
    expect(env.content).toContain("SITEFLOW_GIT_TIMEOUT_MS=300000");
    expect(env.content).toContain("SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912");
    expect(env.content).toContain("SITEFLOW_PREBUILT_MAX_FILES=20000");
    expect(env.content).toContain(`SITEFLOW_BUILD_IMAGE=${buildImage}`);
    expect(env.content).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
    expect(env.content).toContain("SITEFLOW_BASE_DOMAIN=w33d.xyz");
    expect(env.content).not.toContain("TOKEN");
    expect(env.content).not.toContain("SECRET");
    expect(env.content).not.toContain("WEBHOOK");
  });

  it("rejects invalid DNS names", () => {
    expect(() =>
      renderManagedNginxConfig({
        controlPlaneHost: "https://siteflow.w33d.xyz",
        wildcardBaseDomain: "w33d.xyz"
      })
    ).toThrow("DNS name");
  });

  it("renders a single-host Compose file with secret file references", () => {
    const compose = renderComposeFile({
      apiPort: 8787,
      artifactRoot: "/var/lib/siteflow/artifacts",
      publicScheme: "https",
      version: "0.1.0-test",
      image: runtimeImage,
      buildImage,
      postgresImage,
      baseDomain: "w33d.xyz",
      dataDir: "/var/lib/siteflow",
      configDir: "/etc/siteflow"
    });

    expect(compose.content).toContain(`image: ${postgresImage}`);
    expect(compose.content).toContain("pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}");
    expect(compose.content).toContain(`image: ${runtimeImage}`);
    expect(compose.content).not.toContain("build:");
    expect(compose.content).not.toContain("siteflow-console:production");
    expect(compose.content).not.toContain("postgres:16-alpine");
    expect(compose.content).toContain("  worker:");
    expect(compose.content).toContain('    user: "1000:1000"');
    expect(compose.content).toContain('    user: "${SITEFLOW_WORKER_USER:-1000:1000}"');
    expect(compose.content).toContain("    group_add:");
    expect(compose.content).toContain('      - "${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"');
    expect(compose.content.match(/init: true/g)).toHaveLength(2);
    expect(compose.content.match(/read_only: true/g)).toHaveLength(2);
    expect(compose.content.match(/cap_drop:/g)).toHaveLength(2);
    expect(compose.content.match(/no-new-privileges:true/g)).toHaveLength(2);
    expect(compose.content).toContain("      api:");
    expect(compose.content.match(/condition: service_healthy/g)).toHaveLength(3);
    expect(compose.content).toContain("fetch('http://127.0.0.1:8787/readyz')");
    expect(compose.content).toContain("- /tmp:rw,noexec,nosuid,nodev,size=64m");
    expect(compose.content).toContain("- /tmp:rw,noexec,nosuid,nodev,size=512m");
    expect(compose.content).toContain('SITEFLOW_ENV: "production"');
    expect(compose.content).toContain('SITEFLOW_TRUST_PROXY: ""');
    expect(compose.content).not.toContain('SITEFLOW_TRUST_PROXY: "loopback"');
    expect(compose.content).toContain('SITEFLOW_BUILD_RUNNER: "docker"');
    expect(compose.content).toContain('SITEFLOW_BUILD_NETWORK: "none"');
    expect(compose.content).toContain('SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "536870912"');
    expect(compose.content).toContain('SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "20000"');
    expect(compose.content).toContain('SITEFLOW_BUILD_MIN_FREE_BYTES: "1073741824"');
    expect(compose.content).toContain('SITEFLOW_BUILD_STEP_TIMEOUT_MS: "900000"');
    expect(compose.content).toContain('SITEFLOW_GIT_TIMEOUT_MS: "300000"');
    expect(compose.content).toContain('SITEFLOW_GIT_SSH_KEY_PATH: "${SITEFLOW_GIT_SSH_KEY_PATH:-}"');
    expect(compose.content).toContain('SITEFLOW_GIT_KNOWN_HOSTS_PATH: "${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}"');
    expect(compose.content).toContain(`SITEFLOW_BUILD_IMAGE: "${buildImage}"`);
    expect(compose.content).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
    expect(compose.content).toContain('SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "536870912"');
    expect(compose.content).toContain('SITEFLOW_PREBUILT_MAX_FILES: "20000"');
    expect(compose.content).toContain('SITEFLOW_EVIDENCE_ROOT: "/var/lib/siteflow/evidence"');
    expect(compose.content).toContain('SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD: "/var/lib/siteflow/evidence/backup-automation-run.json"');
    expect(compose.content).toContain("- /var/lib/siteflow/evidence:/var/lib/siteflow/evidence:ro");
    expect(compose.content).toContain('TMPDIR: "/var/lib/siteflow/artifacts"');
    expect(compose.content).toContain('SITEFLOW_WORKER_POLL_INTERVAL_MS: "5000"');
    expect(compose.content).toContain('SITEFLOW_BASE_DOMAIN: "w33d.xyz"');
    expect(compose.content).toContain('DATABASE_URL: "postgres://siteflow@postgres:5432/siteflow"');
    expect(compose.content).toContain("SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret");
    expect(compose.content).toContain("POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password");
    expect(compose.content).toContain("SITEFLOW_API_TOKEN_FILE: /run/secrets/siteflow_api_token");
    expect(compose.content).toContain("SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token");
    expect(compose.content).toContain("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE: /run/secrets/siteflow_release_evidence_signing_key");
    expect(compose.content).toContain("SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_github_webhook_secret");
    expect(compose.content).toContain("SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitlab_webhook_secret");
    expect(compose.content).toContain("SITEFLOW_GITEA_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_gitea_webhook_secret");
    expect(compose.content).toContain("SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_generic_webhook_secret");
    expect(compose.content).not.toContain("export SITEFLOW_");
    expect(compose.content).not.toContain("$(cat /run/secrets/");
    expect(compose.content.match(/- siteflow_app_secret/g)).toHaveLength(2);
    expect(compose.content.match(/- siteflow_metrics_token/g)).toHaveLength(1);
    expect(compose.content.match(/- siteflow_release_evidence_signing_key/g)).toHaveLength(1);
    expect(compose.content.match(/- siteflow_github_webhook_secret/g)).toHaveLength(1);
    expect(compose.content.match(/- siteflow_gitlab_webhook_secret/g)).toHaveLength(1);
    expect(compose.content.match(/- siteflow_gitea_webhook_secret/g)).toHaveLength(1);
    expect(compose.content.match(/- siteflow_generic_webhook_secret/g)).toHaveLength(1);
    expect(compose.content).toContain("exec node dist-worker/worker/index.js");
    expect(compose.content).toContain('test: ["CMD", "node", "dist-worker/worker/index.js", "--healthcheck"]');
    expect(compose.content).toContain("      timeout: 10s");
    expect(compose.content).toContain('$${SITEFLOW_BASE_DOMAIN:?SITEFLOW_BASE_DOMAIN is required for worker preview routes}');
    expect(compose.content).not.toContain(': "${SITEFLOW_BASE_DOMAIN:?SITEFLOW_BASE_DOMAIN is required for worker preview routes}"');
    expect(compose.content).toContain("command -v docker");
    expect(compose.content).toContain("docker info");
    expect(compose.content).toContain("requires access to the trusted single-host Docker socket");
    expect(compose.content).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(compose.content).toContain("Trusted single-host operator profile");
    expect(compose.content).toContain("not a multi-tenant sandbox boundary");
    expect(compose.content).toContain("/etc/siteflow/secrets/app-secret.secret");
    expect(compose.content).toContain("/etc/siteflow/secrets/api-token.secret");
    expect(compose.content).toContain("/etc/siteflow/secrets/metrics-token.secret");
    expect(compose.content).toContain("/etc/siteflow/secrets/release-evidence-signing-key.secret");
    expect(compose.content).toContain("/etc/siteflow/secrets/github-webhook.secret");
    expect(compose.content).toContain("/etc/siteflow/secrets/gitlab-webhook.secret");
    expect(compose.content).toContain("/etc/siteflow/secrets/gitea-webhook.secret");
    expect(compose.content).toContain("/etc/siteflow/secrets/generic-webhook.secret");
    expect(compose.content).not.toContain("secret-token");
  });

  it("renders a systemd unit that manages the Compose stack", () => {
    const unit = renderSystemdUnit({
      composeFile: "/opt/siteflow/compose.yaml",
      envFile: "/etc/siteflow/siteflow.env",
      workingDirectory: "/opt/siteflow",
      unitName: "siteflow.service"
    });

    expect(unit.path).toBe("/etc/systemd/system/siteflow.service");
    expect(unit.content).toContain("Requires=docker.service");
    expect(unit.content).toContain("ExecStart=/usr/bin/docker compose --env-file /etc/siteflow/siteflow.env -f /opt/siteflow/compose.yaml up -d");
    expect(unit.content).toContain("ExecStop=/usr/bin/docker compose --env-file /etc/siteflow/siteflow.env -f /opt/siteflow/compose.yaml down");
  });
});
