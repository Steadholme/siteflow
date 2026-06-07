import { renderComposeFile, renderManagedNginxConfig, renderSiteFlowEnvFile, renderSystemdUnit } from "./installAssets";

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
    expect(config.content).toContain("proxy_set_header X-Forwarded-Host $host;");
    expect(config.content).toContain("location ^~ /api/");
    expect(config.content).toContain("return 404;");
  });

  it("renders SITEFLOW_BASE_DOMAIN into the non-secret env file", () => {
    const env = renderSiteFlowEnvFile({
      apiPort: 8787,
      artifactRoot: "/var/lib/siteflow/artifacts",
      publicScheme: "https",
      version: "0.1.0-test",
      image: "ghcr.io/siteflow/siteflow:0.1.0-test",
      baseDomain: "w33d.xyz"
    });

    expect(env.content).toContain("SITEFLOW_VERSION=0.1.0-test");
    expect(env.content).toContain("SITEFLOW_IMAGE=ghcr.io/siteflow/siteflow:0.1.0-test");
    expect(env.content).toContain("SITEFLOW_API_PORT=8787");
    expect(env.content).toContain("SITEFLOW_ARTIFACT_ROOT=/var/lib/siteflow/artifacts");
    expect(env.content).toContain("SITEFLOW_PUBLIC_SCHEME=https");
    expect(env.content).toContain("SITEFLOW_BASE_DOMAIN=w33d.xyz");
    expect(env.content).not.toContain("TOKEN");
    expect(env.content).not.toContain("SECRET");
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
      image: "ghcr.io/siteflow/siteflow:0.1.0-test",
      baseDomain: "w33d.xyz",
      dataDir: "/var/lib/siteflow",
      configDir: "/etc/siteflow"
    });

    expect(compose.content).toContain("postgres:16-alpine");
    expect(compose.content).toContain("image: ghcr.io/siteflow/siteflow:0.1.0-test");
    expect(compose.content).toContain("POSTGRES_PASSWORD_FILE: /run/secrets/siteflow_postgres_password");
    expect(compose.content).toContain("SITEFLOW_API_TOKEN_FILE: /run/secrets/siteflow_api_token");
    expect(compose.content).toContain("DATABASE_URL=");
    expect(compose.content).toContain("/etc/siteflow/secrets/api-token.secret");
    expect(compose.content).not.toContain("secret-token");
  });

  it("renders a systemd unit that manages the Compose stack", () => {
    const unit = renderSystemdUnit({
      composeFile: "/opt/siteflow/compose.yaml",
      workingDirectory: "/opt/siteflow",
      unitName: "siteflow.service"
    });

    expect(unit.path).toBe("/etc/systemd/system/siteflow.service");
    expect(unit.content).toContain("Requires=docker.service");
    expect(unit.content).toContain("ExecStart=/usr/bin/docker compose -f /opt/siteflow/compose.yaml up -d");
    expect(unit.content).toContain("ExecStop=/usr/bin/docker compose -f /opt/siteflow/compose.yaml down");
  });
});
