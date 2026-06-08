import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyInstallPlan } from "./installApply";
import { createSingleHostInstallPlan } from "./installPlan";
import type { SiteFlowCommandRunner } from "./doctor";

const runtimeImage = `ghcr.io/siteflow/siteflow@sha256:${"a".repeat(64)}`;
const postgresImage = `postgres@sha256:${"b".repeat(64)}`;
const buildImage = `node:20-bookworm-slim@sha256:${"c".repeat(64)}`;

function mapped(root: string, absolutePath: string) {
  return path.join(root, absolutePath.replace(/^[/\\]+/, ""));
}

function productionPlanInput() {
  return {
    domain: "siteflow.w33d.xyz",
    baseDomain: "w33d.xyz",
    dryRun: false,
    version: "0.1.0-test",
    image: runtimeImage,
    postgresImage,
    buildImage
  };
}

describe("install apply", () => {
  it("writes env, Nginx files, validates, reloads, and persists install state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-install-apply-"));
    const commands: string[] = [];
    const healthRequests: string[] = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push([command, ...args].join(" "));
      return {
        exitCode: 0,
        stdout: `${command} ${args.join(" ")} ok`,
        stderr: ""
      };
    };

    try {
      const plan = createSingleHostInstallPlan(productionPlanInput());
      const result = await applyInstallPlan(plan, {
        root,
        runner,
        linkStrategy: "copy",
        fetch: async (input) => {
          healthRequests.push(input.toString());
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      });

      expect(result.status).toBe("installed");
      expect(result.doctor.status).toBe("pass");
      expect(commands).toEqual([
        "systemctl daemon-reload",
        "systemctl enable --now siteflow.service",
        "nginx -t",
        "nginx -s reload",
        "systemctl is-active siteflow.service"
      ]);
      expect(healthRequests).toEqual(["http://127.0.0.1:8787/readyz"]);
      expect(result.steps.map((step) => step.id)).toContain("api.health");
      expect(result.steps.map((step) => step.id)).toContain("install.doctor");
      expect(result.doctor.checks.map((check) => check.id)).toEqual(
        expect.arrayContaining(["service.active", "asset.env", "asset.compose", "asset.systemd", "storage.artifactRoot", "router.nginxActive"])
      );
      const envFile = await readFile(mapped(root, "/etc/siteflow/siteflow.env"), "utf8");
      const composeFile = await readFile(mapped(root, "/opt/siteflow/compose.yaml"), "utf8");
      expect(envFile).toContain("SITEFLOW_BASE_DOMAIN=w33d.xyz");
      expect(envFile).toContain("SITEFLOW_TRUST_PROXY=loopback");
      expect(envFile).toContain(`SITEFLOW_IMAGE=${runtimeImage}`);
      expect(envFile).toContain(`SITEFLOW_BUILD_IMAGE=${buildImage}`);
      expect(envFile).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
      expect(envFile).toContain("SITEFLOW_BUILD_MAX_ARTIFACT_BYTES=536870912");
      expect(envFile).toContain("SITEFLOW_BUILD_MIN_FREE_BYTES=1073741824");
      expect(envFile).toContain("SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES=536870912");
      expect(composeFile).toContain("SITEFLOW_API_TOKEN_FILE");
      expect(composeFile).toContain("SITEFLOW_METRICS_TOKEN_FILE");
      expect(composeFile).toContain('SITEFLOW_TRUST_PROXY: "loopback"');
      expect(composeFile).toContain(`image: ${runtimeImage}`);
      expect(composeFile).toContain(`image: ${postgresImage}`);
      expect(composeFile).toContain(`SITEFLOW_BUILD_IMAGE: "${buildImage}"`);
      expect(composeFile).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
      expect(composeFile).toContain('DATABASE_URL: "postgres://siteflow@postgres:5432/siteflow"');
      expect(composeFile).toContain('SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD: "/var/lib/siteflow/evidence/backup-automation-run.json"');
      expect(composeFile).toContain("- /var/lib/siteflow/evidence:/var/lib/siteflow/evidence:ro");
      expect(composeFile).toContain('    user: "1000:1000"');
      expect(composeFile).toContain('    user: "${SITEFLOW_WORKER_USER:-0:0}"');
      expect(composeFile).toContain("    group_add:");
      expect(composeFile).toContain('      - "${SITEFLOW_DOCKER_SOCKET_GID:-0}"');
      expect(composeFile.match(/init: true/g)).toHaveLength(2);
      expect(composeFile.match(/read_only: true/g)).toHaveLength(2);
      expect(composeFile.match(/no-new-privileges:true/g)).toHaveLength(2);
      expect(composeFile.match(/condition: service_healthy/g)).toHaveLength(3);
      expect(composeFile).toContain("fetch('http://127.0.0.1:8787/readyz')");
      expect(composeFile).not.toContain("export SITEFLOW_");
      expect(composeFile).not.toContain("$(cat /run/secrets/");
      expect(composeFile).toContain("  worker:");
      expect(await readFile(mapped(root, "/etc/systemd/system/siteflow.service"), "utf8")).toContain("docker compose -f /opt/siteflow/compose.yaml up -d");
      expect(await readFile(mapped(root, "/etc/siteflow/secrets/api-token.secret"), "utf8")).toMatch(/^[A-Za-z0-9_-]+\n$/);
      expect(await readFile(mapped(root, "/etc/siteflow/secrets/metrics-token.secret"), "utf8")).toMatch(/^[A-Za-z0-9_-]+\n$/);
      expect(await readFile(mapped(root, "/etc/siteflow/secrets/github-webhook.secret"), "utf8")).toMatch(/^[A-Za-z0-9_-]+\n$/);
      expect(await readFile(mapped(root, "/etc/siteflow/secrets/gitlab-webhook.secret"), "utf8")).toMatch(/^[A-Za-z0-9_-]+\n$/);
      expect(await readFile(mapped(root, "/etc/siteflow/secrets/gitea-webhook.secret"), "utf8")).toMatch(/^[A-Za-z0-9_-]+\n$/);
      expect(await readFile(mapped(root, "/etc/siteflow/secrets/generic-webhook.secret"), "utf8")).toMatch(/^[A-Za-z0-9_-]+\n$/);
      expect(await readFile(mapped(root, "/etc/siteflow/nginx/siteflow.conf"), "utf8")).toContain("server_name *.w33d.xyz;");
      expect(await readFile(mapped(root, "/etc/nginx/sites-available/siteflow.conf"), "utf8")).toContain("server_name siteflow.w33d.xyz;");
      const activeNginx = await readFile(mapped(root, "/etc/nginx/sites-enabled/siteflow.conf"), "utf8");
      expect(activeNginx).toContain("server_name *.w33d.xyz;");
      expect(activeNginx).toContain("limit_req_zone $binary_remote_addr zone=siteflow_api:10m rate=120r/m;");
      expect(activeNginx).toContain("limit_req zone=siteflow_api burst=60 nodelay;");
      expect(activeNginx).toContain("limit_req_status 429;");
      expect(activeNginx).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
      expect(activeNginx).not.toContain("$proxy_add_x_forwarded_for");

      const state = JSON.parse(await readFile(mapped(root, "/etc/siteflow/install-state.json"), "utf8"));

      expect(state.lastOperation).toMatchObject({
        type: "install",
        status: "succeeded"
      });
      expect(state.router).toMatchObject({
        wildcardBaseDomain: "w33d.xyz",
        previewHostPattern: "*.w33d.xyz"
      });
      expect(state.worker).toMatchObject({
        buildRunner: "docker",
        buildImage,
        buildImageAllowlist: [],
        buildNetwork: "none",
        pollIntervalMs: 5000
      });
      expect(state.secrets.metricsTokenRef).toBe("/etc/siteflow/secrets/metrics-token.secret");
      expect(state.router.activeRevision).toMatch(/^nginx-rev-[a-f0-9]{12}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist install state when the final doctor fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-install-doctor-"));
    const commands: string[] = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push([command, ...args].join(" "));

      if (command === "systemctl" && args[0] === "is-active") {
        return {
          exitCode: 3,
          stdout: "",
          stderr: "inactive"
        };
      }

      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      const plan = createSingleHostInstallPlan(productionPlanInput());

      await expect(
        applyInstallPlan(plan, {
          root,
          runner,
          linkStrategy: "copy",
          fetch: async () =>
            new Response(JSON.stringify({ status: "ok" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
        })
      ).rejects.toThrow("install doctor check(s) failed");

      expect(commands).toContain("systemctl is-active siteflow.service");
      await expect(readFile(mapped(root, "/etc/siteflow/install-state.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores previous Nginx files when validation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-install-rollback-"));
    const availablePath = mapped(root, "/etc/nginx/sites-available/siteflow.conf");
    const enabledPath = mapped(root, "/etc/nginx/sites-enabled/siteflow.conf");
    const runner: SiteFlowCommandRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "nginx: configuration file test failed"
    });

    try {
      await mkdir(path.dirname(availablePath), { recursive: true });
      await mkdir(path.dirname(enabledPath), { recursive: true });
      await writeFile(availablePath, "previous available config\n");
      await writeFile(enabledPath, "previous enabled config\n");

      const plan = createSingleHostInstallPlan(productionPlanInput());

      await expect(
        applyInstallPlan(plan, {
          root,
          runner,
          linkStrategy: "copy",
          startServices: false
        })
      ).rejects.toThrow("Nginx validation failed");

      expect(await readFile(availablePath, "utf8")).toBe("previous available config\n");
      expect(await readFile(enabledPath, "utf8")).toBe("previous enabled config\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before Nginx apply when API health never becomes ready", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-install-health-"));
    const commands: string[] = [];
    const runner: SiteFlowCommandRunner = async (command, args) => {
      commands.push([command, ...args].join(" "));
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: ""
      };
    };

    try {
      const plan = createSingleHostInstallPlan(productionPlanInput());

      await expect(
        applyInstallPlan(plan, {
          root,
          runner,
          linkStrategy: "copy",
          healthAttempts: 2,
          healthIntervalMs: 0,
          fetch: async () =>
            new Response(JSON.stringify({ status: "starting" }), {
              status: 503,
              headers: { "content-type": "application/json" }
            })
        })
      ).rejects.toThrow("did not become healthy");

      expect(commands).toEqual(["systemctl daemon-reload", "systemctl enable --now siteflow.service"]);
      await expect(readFile(mapped(root, "/etc/nginx/sites-available/siteflow.conf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(mapped(root, "/etc/siteflow/install-state.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
