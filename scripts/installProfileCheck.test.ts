import {
  evaluateInstallProfileAssets,
  parseInstallProfileCheckArgs,
  renderReferenceInstallProfile,
  runInstallProfileCheck
} from "./installProfileCheck";

function withContent(asset: ReturnType<typeof renderReferenceInstallProfile>[keyof ReturnType<typeof renderReferenceInstallProfile>], content: string) {
  return {
    ...asset,
    content
  };
}

describe("installProfileCheck", () => {
  it("passes the reference single-host install profile", () => {
    const result = runInstallProfileCheck({
      now: () => new Date("2026-06-08T12:00:00.000Z")
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checkedAt).toBe("2026-06-08T12:00:00.000Z");
    expect(result.selectedEvidence).toMatchObject({
      checksPassed: 17,
      checksTotal: 17,
      composePath: "/opt/siteflow/compose.yaml",
      nginxPath: "/etc/nginx/sites-available/siteflow.conf"
    });
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("blocks install env profiles that enable trusted proxy by default", () => {
    const assets = renderReferenceInstallProfile();
    const env = assets.env.content.replace("SITEFLOW_TRUST_PROXY=\n", "SITEFLOW_TRUST_PROXY=loopback\n");
    const result = evaluateInstallProfileAssets({
      ...assets,
      env: withContent(assets.env, env)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_env_trusted_proxy_opt_in",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Nginx profiles that trust inbound forwarded headers", () => {
    const assets = renderReferenceInstallProfile();
    const nginx = assets.nginx.content.replace(
      "proxy_set_header X-Forwarded-For $remote_addr;",
      "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
    );
    const result = evaluateInstallProfileAssets({
      ...assets,
      nginx: withContent(assets.nginx, nginx)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_nginx_forwarded_headers_overwrite",
          status: "fail"
        })
      ])
    );
  });

  it("blocks wildcard preview hosts that expose readiness routes", () => {
    const assets = renderReferenceInstallProfile();
    const nginx = assets.nginx.content.replace(
      "    location = /readyz {\n        return 404;\n    }\n\n",
      ""
    );
    const result = evaluateInstallProfileAssets({
      ...assets,
      nginx: withContent(assets.nginx, nginx)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_nginx_wildcard_runtime_routes_blocked",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles that expose the API on a public interface", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content.replace(
      '- "127.0.0.1:8787:8787"',
      '- "0.0.0.0:8787:8787"'
    );
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_api_loopback_port",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles that do not require metrics token secret files", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace("      SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token\n", "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_metrics_token_required",
          status: "fail"
        }),
        expect.objectContaining({
          name: "install_compose_secret_files",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles that omit release evidence signing key secret files", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace("      SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE: /run/secrets/siteflow_release_evidence_signing_key\n", "")
      .replace("      - siteflow_release_evidence_signing_key\n", "")
      .replace("  siteflow_release_evidence_signing_key:\n    file: /etc/siteflow/secrets/release-evidence-signing-key.secret\n", "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_secret_files",
          status: "fail"
        })
      ])
    );
  });

  it("blocks profiles that omit explicit build and git timeouts", () => {
    const assets = renderReferenceInstallProfile();
    const env = assets.env.content
      .replace("SITEFLOW_BUILD_STEP_TIMEOUT_MS=900000\n", "")
      .replace("SITEFLOW_GIT_TIMEOUT_MS=300000\n", "");
    const compose = assets.compose.content
      .replace('      SITEFLOW_BUILD_STEP_TIMEOUT_MS: "900000"\n', "")
      .replace('      SITEFLOW_GIT_TIMEOUT_MS: "300000"\n', "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      env: withContent(assets.env, env),
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_env_non_secret_runtime",
          status: "fail"
        }),
        expect.objectContaining({
          name: "install_compose_worker_docker_runner",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose worker profiles without private Git credential path wiring", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace('      SITEFLOW_GIT_SSH_KEY_PATH: "${SITEFLOW_GIT_SSH_KEY_PATH:-}"\n', "")
      .replace('      SITEFLOW_GIT_KNOWN_HOSTS_PATH: "${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}"\n', "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_worker_docker_runner",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles that omit git webhook secret file references", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace("      SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE: /run/secrets/siteflow_generic_webhook_secret\n", "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_secret_files",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles that export Docker secret values into process env", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content.replace(
      "        exec node dist-worker/worker/index.js\n",
      "        export SITEFLOW_APP_SECRET=\"$(cat /run/secrets/siteflow_app_secret)\"\n        exec node dist-worker/worker/index.js\n"
    );
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_secret_files",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles without production readiness gates", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replaceAll("        condition: service_healthy\n", "")
      .replace("    healthcheck:\n      test: [\"CMD-SHELL\", \"node -e \\\"fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\\\"\"]\n      interval: 30s\n      timeout: 5s\n      retries: 5\n      start_period: 30s\n", "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_service_readiness",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles without production container hardening", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replaceAll("    init: true\n", "")
      .replaceAll("    read_only: true\n", "")
      .replaceAll("    cap_drop:\n      - ALL\n", "")
      .replaceAll("    security_opt:\n      - no-new-privileges:true\n", "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_container_hardening",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles that weaken dropped capabilities", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content.replaceAll("      - ALL\n", "      - NET_RAW\n");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_container_hardening",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose worker profiles without Docker runner proof", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace("        if ! docker info >/dev/null 2>&1; then\n          echo \"SITEFLOW_BUILD_RUNNER=docker requires access to the trusted single-host Docker socket.\" >&2\n          exit 1\n        fi\n", "")
      .replace("      - /var/run/docker.sock:/var/run/docker.sock\n", "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_worker_docker_runner",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose worker profiles without Docker socket user and group posture", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace('    user: "${SITEFLOW_WORKER_USER:-1000:1000}"\n', "")
      .replace('    group_add:\n      - "${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"\n', "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_worker_docker_runner",
          status: "fail"
        }),
        expect.objectContaining({
          name: "install_compose_container_hardening",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles without digest-pinned runtime images", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace(/image: ghcr\.io\/siteflow\/siteflow@sha256:[a-f0-9]{64}/g, "image: ghcr.io/siteflow/siteflow:0.1.0-test")
      .replace(/image: postgres@sha256:[a-f0-9]{64}/, "image: postgres:16-alpine")
      .replace(/SITEFLOW_BUILD_IMAGE: "node:20-bookworm-slim@sha256:[a-f0-9]{64}"/, 'SITEFLOW_BUILD_IMAGE: "node:20-bookworm-slim"');
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_digest_pinned_images",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose worker profiles without the runtime healthcheck", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content.replace(
      "    healthcheck:\n      test: [\"CMD\", \"node\", \"dist-worker/worker/index.js\", \"--healthcheck\"]\n      interval: 30s\n      timeout: 10s\n      retries: 5\n      start_period: 30s\n",
      ""
    );
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_worker_healthcheck",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose worker profiles with a shorter runtime healthcheck timeout", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content.replace("      timeout: 10s\n", "      timeout: 5s\n");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_worker_healthcheck",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Compose profiles without backup evidence mount", () => {
    const assets = renderReferenceInstallProfile();
    const compose = assets.compose.content
      .replace('      SITEFLOW_EVIDENCE_ROOT: "/var/lib/siteflow/evidence"\n', "")
      .replace('      SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD: "/var/lib/siteflow/evidence/backup-automation-run.json"\n', "")
      .replace("      - /var/lib/siteflow/evidence:/var/lib/siteflow/evidence:ro\n", "");
    const result = evaluateInstallProfileAssets({
      ...assets,
      compose: withContent(assets.compose, compose)
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "install_compose_backup_evidence_mount",
          status: "fail"
        })
      ])
    );
  });

  it("parses CLI args", () => {
    expect(parseInstallProfileCheckArgs(["--json"])).toEqual({
      json: true,
      help: false
    });
    expect(() => parseInstallProfileCheckArgs(["--unknown"])).toThrow("Unknown argument");
  });
});
