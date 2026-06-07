import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyInstallPlan } from "./installApply";
import { createSingleHostInstallPlan } from "./installPlan";
import type { SiteFlowCommandRunner } from "./doctor";

function mapped(root: string, absolutePath: string) {
  return path.join(root, absolutePath.replace(/^[/\\]+/, ""));
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
      const plan = createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        dryRun: false,
        version: "0.1.0-test"
      });
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
      expect(healthRequests).toEqual(["http://127.0.0.1:8787/healthz"]);
      expect(result.steps.map((step) => step.id)).toContain("api.health");
      expect(result.steps.map((step) => step.id)).toContain("install.doctor");
      expect(result.doctor.checks.map((check) => check.id)).toEqual(
        expect.arrayContaining(["service.active", "asset.env", "asset.compose", "asset.systemd", "storage.artifactRoot", "router.nginxActive"])
      );
      expect(await readFile(mapped(root, "/etc/siteflow/siteflow.env"), "utf8")).toContain("SITEFLOW_BASE_DOMAIN=w33d.xyz");
      expect(await readFile(mapped(root, "/opt/siteflow/compose.yaml"), "utf8")).toContain("SITEFLOW_API_TOKEN_FILE");
      expect(await readFile(mapped(root, "/etc/systemd/system/siteflow.service"), "utf8")).toContain("docker compose -f /opt/siteflow/compose.yaml up -d");
      expect(await readFile(mapped(root, "/etc/siteflow/secrets/api-token.secret"), "utf8")).toMatch(/^[A-Za-z0-9_-]+\n$/);
      expect(await readFile(mapped(root, "/etc/siteflow/nginx/siteflow.conf"), "utf8")).toContain("server_name *.w33d.xyz;");
      expect(await readFile(mapped(root, "/etc/nginx/sites-available/siteflow.conf"), "utf8")).toContain("server_name siteflow.w33d.xyz;");
      expect(await readFile(mapped(root, "/etc/nginx/sites-enabled/siteflow.conf"), "utf8")).toContain("server_name *.w33d.xyz;");

      const state = JSON.parse(await readFile(mapped(root, "/etc/siteflow/install-state.json"), "utf8"));

      expect(state.lastOperation).toMatchObject({
        type: "install",
        status: "succeeded"
      });
      expect(state.router).toMatchObject({
        wildcardBaseDomain: "w33d.xyz",
        previewHostPattern: "*.w33d.xyz"
      });
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
      const plan = createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        dryRun: false,
        version: "0.1.0-test"
      });

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

      const plan = createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        dryRun: false,
        version: "0.1.0-test"
      });

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
      const plan = createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        dryRun: false,
        version: "0.1.0-test"
      });

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
