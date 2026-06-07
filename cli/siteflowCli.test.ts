import { runSiteFlowCli, type CliIo } from "./siteflowCli";
import type { SiteFlowCommandRunner } from "./doctor";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function createIo() {
  const output = {
    stdout: "",
    stderr: ""
  };
  const io: CliIo = {
    stdout: (message) => {
      output.stdout += message;
    },
    stderr: (message) => {
      output.stderr += message;
    }
  };

  return { io, output };
}

const passingRunner: SiteFlowCommandRunner = async (command) => ({
  exitCode: 0,
  stdout: `${command} ok`,
  stderr: ""
});

function projectSettingsResponse() {
  return {
    project: {
      id: "project-acme-dashboard",
      slug: "acme-dashboard",
      name: "Acme Dashboard"
    },
    environmentVariables: [
      {
        key: "SITEFLOW_TOKEN",
        targetEnvironment: "preview",
        scope: "build",
        source: "sealed",
        fingerprint: "sha256:redacted"
      },
      {
        key: "API_URL",
        targetEnvironment: "production",
        scope: "runtime",
        source: "external",
        fingerprint: "external"
      }
    ],
    apiTokens: [
      {
        id: "token_ci",
        projectId: "project-acme-dashboard",
        name: "CI deploy",
        tokenPrefix: "sft_ci_tok",
        scopes: ["read", "write"],
        status: "active",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    auditEvents: [
      {
        id: "audit_promote",
        action: "deployment.promoted",
        actor: {
          name: "Acme Dev"
        },
        targetType: "deployment",
        targetId: "dep_123",
        summary: "Promotion route applied.",
        createdAt: "2026-05-26T00:00:00.000Z"
      }
    ]
  };
}

function acceptedPromotionResponse() {
  return {
    status: "accepted",
    operationId: "op_promote",
    message: "Promotion route applied.",
    routeRevision: {
      id: "route_promote",
      status: "applied",
      channel: "production",
      deploymentId: "dep_123"
    },
    safetyChecks: [
      {
        label: "Target deployment ready",
        status: "pass",
        summary: "Deployment dep_123 is ready."
      }
    ]
  };
}

function deployHookListResponse() {
  return {
    projectId: "project-acme-dashboard",
    hooks: [
      {
        id: "hook_preview",
        projectId: "project-acme-dashboard",
        name: "CMS rebuild",
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
  };
}

function deployHookCreateResponse() {
  return {
    status: "created",
    hook: deployHookListResponse().hooks[0],
    token: "sfh_test_token",
    hookUrl: "https://siteflow.example.com/api/deploy-hooks/sfh_test_token/trigger",
    message: "Deploy hook created."
  };
}

function deployHookRevokeResponse() {
  return {
    status: "revoked",
    hook: {
      ...deployHookListResponse().hooks[0],
      status: "revoked",
      updatedAt: "2026-05-25T00:01:00.000Z",
      revokedAt: "2026-05-25T00:01:00.000Z"
    },
    message: "Deploy hook revoked."
  };
}

function rollingCommandResponse(percentage = 10, status = "active") {
  return {
    status: "accepted",
    message: status === "completed"
      ? "Rolling release completed."
      : status === "aborted"
        ? "Rolling release aborted."
        : `Rolling release updated to ${percentage}%.`,
    rollout: {
      id: "rollout_preview",
      projectId: "project-acme-dashboard",
      channel: "production",
      currentDeploymentId: "dep-current",
      candidateDeploymentId: "dep-canary",
      percentage,
      status,
      actor: {
        id: "user_1",
        name: "Acme Dev",
        role: "developer"
      },
      reason: "canary",
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:01:00.000Z"
    },
    safetyChecks: []
  };
}

function cronJobListResponse() {
  return {
    projectId: "project-acme-dashboard",
    jobs: [
      {
        id: "cron_revalidate",
        projectId: "project-acme-dashboard",
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
  };
}

function cronJobCreateResponse() {
  return {
    status: "created",
    job: cronJobListResponse().jobs[0],
    message: "Cron job saved."
  };
}

function cronJobDisableResponse() {
  return {
    status: "disabled",
    job: {
      ...cronJobListResponse().jobs[0],
      status: "disabled",
      updatedAt: "2026-05-26T00:01:00.000Z",
      disabledAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Cron job disabled."
  };
}

function cronJobRunResponse() {
  return {
    status: "accepted",
    job: {
      ...cronJobListResponse().jobs[0],
      lastDispatchedAt: "2026-05-26T00:01:00.000Z"
    },
    dispatch: {
      id: "crondispatch_revalidate",
      cronJobId: "cron_revalidate",
      projectId: "project-acme-dashboard",
      targetUrl: "https://dashboard.acme.test/api/revalidate",
      method: "GET",
      userAgent: "vercel-cron/1.0",
      status: "queued",
      reason: "manual",
      scheduledAt: "2026-05-26T00:01:00.000Z",
      dispatchedAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Cron dispatch queued."
  };
}

function logQueryResponse() {
  return {
    projectId: "project-acme-dashboard",
    filters: {
      source: "build",
      severity: "warning",
      search: "deploy"
    },
    entries: [
      {
        id: "log_build_warn",
        projectId: "project-acme-dashboard",
        source: "build",
        severity: "warning",
        message: "Build warning: deprecated dependency",
        timestamp: "2026-05-26T00:00:00.000Z",
        deploymentId: "dep_123",
        buildJobId: "build_123"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function logDrainListResponse() {
  return {
    projectId: "project-acme-dashboard",
    drains: [
      {
        id: "drain_datadog",
        projectId: "project-acme-dashboard",
        name: "Datadog",
        url: "https://logs.example.test/siteflow",
        sources: ["build", "function"],
        minimumSeverity: "warning",
        status: "active",
        signingSecretPrefix: "sfd_test_sec",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function logDrainCreateResponse() {
  return {
    status: "created",
    drain: logDrainListResponse().drains[0],
    message: "Log drain created."
  };
}

function logDrainDeliveryResponse() {
  return {
    status: "delivered",
    drain: {
      ...logDrainListResponse().drains[0],
      lastDeliveredAt: "2026-05-26T00:01:00.000Z"
    },
    delivery: {
      id: "delivery_1",
      drainId: "drain_datadog",
      projectId: "project-acme-dashboard",
      status: "delivered",
      responseStatus: 202,
      eventsDelivered: 1,
      attempt: 1,
      payloadSha256: "sha256:payload",
      deliveredAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Log drain delivered."
  };
}

function firewallRuleListResponse() {
  return {
    projectId: "project-acme-dashboard",
    rules: [
      {
        id: "fw_block_admin",
        projectId: "project-acme-dashboard",
        name: "Block admin",
        action: "block",
        priority: 10,
        status: "active",
        conditions: {
          pathPattern: "/admin/*",
          header: {
            name: "x-plan",
            value: "free"
          }
        },
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function firewallRuleCreateResponse() {
  return {
    status: "created",
    rule: firewallRuleListResponse().rules[0],
    message: "Firewall rule created."
  };
}

function firewallRuleDisableResponse() {
  return {
    status: "disabled",
    rule: {
      ...firewallRuleListResponse().rules[0],
      status: "disabled",
      updatedAt: "2026-05-26T00:01:00.000Z",
      disabledAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Firewall rule disabled."
  };
}

function routingRuleListResponse() {
  return {
    projectId: "project-acme-dashboard",
    rules: [
      {
        id: "route_docs",
        projectId: "project-acme-dashboard",
        name: "Docs redirect",
        kind: "redirect",
        source: "/docs",
        destination: "/documentation",
        statusCode: 308,
        priority: 10,
        status: "active",
        createdAt: "2026-05-27T00:00:00.000Z",
        updatedAt: "2026-05-27T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function routingRuleUpsertResponse() {
  return {
    status: "upserted",
    rule: routingRuleListResponse().rules[0],
    message: "Routing rule saved."
  };
}

function routingRuleDisableResponse() {
  return {
    status: "disabled",
    rule: {
      ...routingRuleListResponse().rules[0],
      status: "disabled",
      updatedAt: "2026-05-27T00:01:00.000Z",
      disabledAt: "2026-05-27T00:01:00.000Z"
    },
    message: "Routing rule disabled."
  };
}

function edgeConfigResponse() {
  return {
    projectId: "project-acme-dashboard",
    entries: [
      {
        id: "edge_maintenance",
        projectId: "project-acme-dashboard",
        key: "maintenance",
        value: false,
        valueType: "boolean",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ],
    total: 1,
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}

function edgeConfigUpsertResponse() {
  return {
    status: "upserted",
    entry: {
      id: "edge_maintenance",
      projectId: "project-acme-dashboard",
      key: "maintenance",
      value: {
        enabled: true
      },
      valueType: "json",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:01:00.000Z"
    },
    message: "Edge Config entry saved."
  };
}

function edgeConfigDeleteResponse() {
  return {
    status: "deleted",
    message: "Edge Config entry maintenance deleted."
  };
}

function blobFixture(pathname = "assets/config/app.json") {
  return {
    id: "blob_config_app",
    projectId: "project-acme-dashboard",
    pathname,
    access: "private",
    contentType: "application/json",
    cacheControlMaxAge: 120,
    size: 16,
    sha256: "d8d9c1b51a05fbd72c1277d9e33276805e3026d5a4b8bb58f49b754019318212",
    etag: "\"fixture\"",
    url: `/api/projects/project-acme-dashboard/blobs/${encodeURIComponent(pathname)}`,
    uploadedAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function blobListResponse() {
  return {
    projectId: "project-acme-dashboard",
    blobs: [blobFixture()],
    total: 1,
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function blobPutResponse() {
  return {
    status: "uploaded",
    blob: blobFixture(),
    message: "Blob uploaded."
  };
}

function blobReadResponse() {
  return {
    projectId: "project-acme-dashboard",
    blob: blobFixture(),
    contentBase64: Buffer.from("{\"enabled\":true}", "utf8").toString("base64")
  };
}

function blobDeleteResponse() {
  return {
    status: "deleted",
    blob: blobFixture(),
    message: "Blob deleted."
  };
}

function cacheEntryFixture(pathname = "/pricing", status = "stale") {
  return {
    id: `cache_${pathname.replace(/[^a-z0-9]+/gi, "_")}`,
    projectId: "project-acme-dashboard",
    key: `page:${pathname}`,
    path: pathname,
    tags: ["marketing", pathname === "/" ? "home" : "pricing"],
    status,
    contentType: "text/html; charset=utf-8",
    size: 4096,
    etag: `"cache-${pathname}"`,
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 300,
    lastGeneratedAt: "2026-05-27T00:00:00.000Z",
    expiresAt: "2026-05-27T00:01:00.000Z",
    staleAt: "2026-05-27T00:06:00.000Z",
    updatedAt: "2026-05-27T00:06:00.000Z"
  };
}

function cacheListResponse() {
  return {
    projectId: "project-acme-dashboard",
    entries: [cacheEntryFixture()],
    total: 1,
    updatedAt: "2026-05-27T00:00:00.000Z"
  };
}

function cachePurgeResponse() {
  return {
    status: "purged",
    projectId: "project-acme-dashboard",
    purged: [
      {
        ...cacheEntryFixture("/pricing", "purged"),
        purgedAt: "2026-05-27T00:10:00.000Z",
        updatedAt: "2026-05-27T00:10:00.000Z"
      }
    ],
    total: 1,
    message: "Purged 1 cache entry."
  };
}

function functionRuntimeEntry() {
  return {
    projectId: "project-acme-dashboard",
    deploymentId: "dep_function",
    function: {
      path: "/api/revalidate",
      sourcePath: ".siteflow/functions/api/revalidate.js",
      runtime: "nodejs20.x",
      handler: "default",
      methods: ["POST"]
    },
    limits: {
      timeoutMs: 10000,
      memoryMb: 512,
      concurrency: 50
    },
    summary: {
      invocations: 2,
      errors: 1,
      errorRate: 0.5,
      averageDurationMs: 110,
      p95DurationMs: 180,
      lastInvokedAt: "2026-05-27T00:10:00.000Z"
    }
  };
}

function functionListResponse() {
  return {
    projectId: "project-acme-dashboard",
    deploymentId: "dep_function",
    functions: [functionRuntimeEntry()],
    total: 1,
    updatedAt: "2026-05-27T00:12:00.000Z"
  };
}

function functionRuntimeResponse() {
  return {
    projectId: "project-acme-dashboard",
    deploymentId: "dep_function",
    function: functionRuntimeEntry(),
    recentInvocations: [
      {
        id: "fninv_ok",
        path: "/api/revalidate",
        method: "POST",
        status: "succeeded",
        responseStatus: 200,
        durationMs: 40,
        requestId: "req_ok",
        invokedAt: "2026-05-27T00:10:00.000Z"
      }
    ],
    updatedAt: "2026-05-27T00:12:00.000Z"
  };
}

describe("siteflow CLI", () => {
  it("prints help", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(["--help"], io);

    expect(code).toBe(0);
    expect(output.stdout).toContain("siteflow install");
  });

  it("runs doctor with JSON output", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(["doctor", "--json"], io, {
      doctor: {
        platform: "linux",
        arch: "x64",
        runner: passingRunner
      }
    });

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "pass"
    });
  });

  it("prints a single-host install dry-run plan", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(["install", "--topology", "single", "--domain", "siteflow.example.com", "--dry-run", "--json"], io, {
      version: "0.1.0-test"
    });
    const plan = JSON.parse(output.stdout);

    expect(code).toBe(0);
    expect(plan).toMatchObject({
      topology: "single",
      dryRun: true,
      installState: {
        siteflowVersion: "0.1.0-test",
        router: {
          controlPlaneHost: "siteflow.example.com",
          wildcardBaseDomain: "siteflow.example.com",
          previewHostPattern: "*.siteflow.example.com"
        },
        tls: {
          domains: ["siteflow.example.com", "*.siteflow.example.com"]
        }
      },
      runtimeEnv: {
        SITEFLOW_BASE_DOMAIN: "siteflow.example.com"
      }
    });
    expect(plan.renderedAssets.env.content).toContain("SITEFLOW_BASE_DOMAIN=siteflow.example.com");
    expect(plan.renderedAssets.nginx.content).toContain("server_name *.siteflow.example.com;");
    expect(plan.steps.map((step: { id: string }) => step.id)).toContain("router");
  });

  it("renders an explicit wildcard base domain separately from the control-plane domain", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "install",
        "--topology",
        "single",
        "--domain",
        "siteflow.w33d.xyz",
        "--base-domain",
        "w33d.xyz",
        "--dry-run",
        "--json"
      ],
      io,
      {
        version: "0.1.0-test"
      }
    );
    const plan = JSON.parse(output.stdout);

    expect(code).toBe(0);
    expect(plan.installState.router).toMatchObject({
      controlPlaneHost: "siteflow.w33d.xyz",
      wildcardBaseDomain: "w33d.xyz",
      previewHostPattern: "*.w33d.xyz"
    });
    expect(plan.installState.tls.domains).toEqual(["siteflow.w33d.xyz", "*.w33d.xyz"]);
    expect(plan.runtimeEnv.SITEFLOW_BASE_DOMAIN).toBe("w33d.xyz");
    expect(plan.renderedAssets.nginx.content).toContain("server_name siteflow.w33d.xyz;");
    expect(plan.renderedAssets.nginx.content).toContain("server_name *.w33d.xyz;");
    expect(plan.renderedAssets.nginx.content).toContain("location ^~ /api/");
  });

  it("requires explicit confirmation before install apply", async () => {
    const { io, output } = createIo();
    const code = await runSiteFlowCli(["install"], io);

    expect(code).toBe(2);
    expect(output.stderr).toContain("requires --yes");
  });

  it("applies install assets when explicitly confirmed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-install-cli-"));
    const commands: string[] = [];
    const healthRequests: string[] = [];
    const { io, output } = createIo();

    try {
      const code = await runSiteFlowCli(
        [
          "install",
          "--topology",
          "single",
          "--domain",
          "siteflow.w33d.xyz",
          "--base-domain",
          "w33d.xyz",
          "--yes",
          "--json"
        ],
        io,
        {
          version: "0.1.0-test",
          install: {
            root,
            linkStrategy: "copy",
            runner: async (command, args) => {
              commands.push([command, ...args].join(" "));
              return {
                exitCode: 0,
                stdout: "ok",
                stderr: ""
              };
            },
            fetch: async (input) => {
              healthRequests.push(input.toString());
              return new Response(JSON.stringify({ status: "ok" }), {
                status: 200,
                headers: { "content-type": "application/json" }
              });
            }
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result).toMatchObject({
        status: "installed",
        doctor: {
          status: "pass"
        },
        router: {
          wildcardBaseDomain: "w33d.xyz",
          previewHostPattern: "*.w33d.xyz"
        }
      });
      expect(commands).toEqual([
        "systemctl daemon-reload",
        "systemctl enable --now siteflow.service",
        "nginx -t",
        "nginx -s reload",
        "systemctl is-active siteflow.service"
      ]);
      expect(healthRequests).toEqual(["http://127.0.0.1:8787/healthz"]);
      expect(await readFile(path.join(root, "etc/siteflow/siteflow.env"), "utf8")).toContain("SITEFLOW_BASE_DOMAIN=w33d.xyz");
      expect(await readFile(path.join(root, "opt/siteflow/compose.yaml"), "utf8")).toContain("ghcr.io/siteflow/siteflow:0.1.0-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads a prebuilt directory and prints the preview URL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteflow-prebuilt-"));

    try {
      await writeFile(path.join(directory, "index.html"), "<h1>Hello SiteFlow</h1>");
      await writeFile(path.join(directory, "vercel.json"), JSON.stringify({
        redirects: [
          {
            source: "/docs",
            destination: "/documentation",
            permanent: true
          }
        ],
        rewrites: [
          {
            source: "/blog/:slug",
            destination: "/posts/:slug"
          }
        ],
        headers: [
          {
            source: "/(.*)",
            headers: [
              {
                key: "x-frame-options",
                value: "DENY"
              }
            ]
          }
        ],
        cleanUrls: true,
        trailingSlash: false,
        skipTrailingSlashRedirect: true,
        public: true,
        fluid: true,
        images: {
          sizes: [320, 640],
          qualities: [70, 80],
          formats: ["image/webp"],
          minimumCacheTTL: 120,
          dangerouslyAllowSVG: true,
          contentSecurityPolicy: "script-src 'none'; sandbox;",
          contentDispositionType: "inline"
        },
        crons: [
          {
            path: "/api/revalidate",
            schedule: "0 * * * *"
          }
        ]
      }));
      const requests: unknown[] = [];
      const authHeaders: Array<string | null> = [];
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          directory,
          "--server",
          "https://siteflow.example.com",
          "--project",
          "docs",
          "--base-domain",
          "w33d.xyz",
          "--token",
          "secret-token",
          "--host-prefix",
          "abc123",
          "--json"
        ],
        io,
        {
          fetch: async (_input, init) => {
            authHeaders.push(new Headers(init?.headers).get("authorization"));
            requests.push(JSON.parse(init?.body?.toString() ?? "{}"));
            return new Response(
              JSON.stringify({
                deploymentId: "dep_prebuilt",
                projectId: "project_docs",
                projectSlug: "docs",
                previewHost: "abc123.w33d.xyz",
                previewUrl: "https://abc123.w33d.xyz",
                artifactRoot: "/var/lib/siteflow/artifacts/dep_prebuilt",
                fileCount: 1,
                totalBytes: 23,
                checksum: "abc"
              }),
              { status: 201, headers: { "content-type": "application/json" } }
            );
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result.previewUrl).toBe("https://abc123.w33d.xyz");
      expect(authHeaders).toEqual(["Bearer secret-token"]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        projectSlug: "docs",
        baseDomain: "w33d.xyz",
        requestedHostPrefix: "abc123",
        public: true,
        fluid: true,
        images: {
          sizes: [320, 640],
          qualities: [70, 80],
          formats: ["image/webp"],
          minimumCacheTTL: 120,
          dangerouslyAllowSVG: true,
          contentSecurityPolicy: "script-src 'none'; sandbox;",
          contentDispositionType: "inline"
        },
        routing: {
          redirects: [
            {
              source: "/docs",
              destination: "/documentation",
              statusCode: 308
            }
          ],
          rewrites: [
            {
              source: "/blog/:slug",
              destination: "/posts/:slug"
            }
          ],
          headers: [
            {
              source: "/(.*)",
              headers: [
                {
                  key: "x-frame-options",
                  value: "DENY"
                }
              ]
            }
          ],
          cleanUrls: true,
          trailingSlash: false,
          skipTrailingSlashRedirect: true
        },
        crons: [
          {
            path: "/api/revalidate",
            schedule: "0 * * * *"
          }
        ]
      });
      const uploadedFiles = (requests[0] as { files: Array<{ path: string; contentBase64: string; size: number }> }).files;
      const uploadedByPath = new Map(uploadedFiles.map((file) => [file.path, file]));

      expect(uploadedFiles).toEqual([
        expect.objectContaining({
          path: "index.html",
          size: 23
        }),
        expect.objectContaining({
          path: "index.html.br"
        }),
        expect.objectContaining({
          path: "index.html.gz"
        }),
        expect.objectContaining({
          path: "vercel.json"
        }),
        expect.objectContaining({
          path: "vercel.json.br"
        }),
        expect.objectContaining({
          path: "vercel.json.gz"
        })
      ]);
      expect(brotliDecompressSync(Buffer.from(uploadedByPath.get("index.html.br")?.contentBase64 ?? "", "base64")).toString("utf8"))
        .toBe("<h1>Hello SiteFlow</h1>");
      expect(gunzipSync(Buffer.from(uploadedByPath.get("index.html.gz")?.contentBase64 ?? "", "base64")).toString("utf8"))
        .toBe("<h1>Hello SiteFlow</h1>");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets prebuilt deploy omit baseDomain when the server owns the wildcard domain", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteflow-prebuilt-default-domain-"));

    try {
      await writeFile(path.join(directory, "index.html"), "<h1>Hello Default Domain</h1>");
      const requests: Array<Record<string, unknown>> = [];
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          directory,
          "--server",
          "https://siteflow.example.com",
          "--project",
          "docs",
          "--token",
          "secret-token",
          "--host-prefix",
          "abc123",
          "--json"
        ],
        io,
        {
          fetch: async (_input, init) => {
            requests.push(JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                deploymentId: "dep_prebuilt",
                projectId: "project_docs",
                projectSlug: "docs",
                previewHost: "abc123.w33d.xyz",
                previewUrl: "https://abc123.w33d.xyz",
                artifactRoot: "/var/lib/siteflow/artifacts/dep_prebuilt",
                fileCount: 1,
                totalBytes: 29,
                checksum: "abc"
              }),
              { status: 201, headers: { "content-type": "application/json" } }
            );
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(result.previewUrl).toBe("https://abc123.w33d.xyz");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        projectSlug: "docs",
        requestedHostPrefix: "abc123"
      });
      expect(Object.prototype.hasOwnProperty.call(requests[0], "baseDomain")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs in and stores the server-reported base domain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-login-server-domain-"));
    const configPath = path.join(root, "config.json");

    try {
      const seen = {
        url: "",
        authorization: ""
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "login",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "saved-token",
          "--config",
          configPath,
          "--json"
        ],
        io,
        {
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            return new Response(
              JSON.stringify({
                authenticated: true,
                authRequired: true,
                baseDomain: "w33d.xyz"
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
        }
      );

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/auth/verify");
      expect(seen.authorization).toBe("Bearer saved-token");
      expect(JSON.parse(output.stdout)).toMatchObject({
        status: "logged_in",
        baseDomain: "w33d.xyz"
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultServer: "https://siteflow.example.com",
        servers: {
          "https://siteflow.example.com": {
            token: "saved-token",
            baseDomain: "w33d.xyz"
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs in, stores config, and lets deploy reuse saved server settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-login-"));
    const configPath = path.join(root, "config.json");
    const site = path.join(root, "dist");

    try {
      await import("node:fs/promises").then((fs) => fs.mkdir(site, { recursive: true }));
      await writeFile(path.join(site, "index.html"), "<h1>Saved Config</h1>");

      const loginIo = createIo();
      const loginCode = await runSiteFlowCli(
        [
          "login",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "saved-token",
          "--base-domain",
          "w33d.xyz",
          "--config",
          configPath,
          "--json"
        ],
        loginIo.io,
        {
          fetch: async () => new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { "content-type": "application/json" } })
        }
      );

      expect(loginCode).toBe(0);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultServer: "https://siteflow.example.com",
        servers: {
          "https://siteflow.example.com": {
            token: "saved-token",
            baseDomain: "w33d.xyz"
          }
        }
      });

      const deployIo = createIo();
      const seen = {
        url: "",
        authorization: ""
      };
      const deployCode = await runSiteFlowCli(["deploy", "--prebuilt", site, "--project", "docs", "--config", configPath, "--json"], deployIo.io, {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              deploymentId: "dep_saved",
              projectId: "project_docs",
              projectSlug: "docs",
              previewHost: "saved.w33d.xyz",
              previewUrl: "https://saved.w33d.xyz",
              artifactRoot: "/var/lib/siteflow/artifacts/dep_saved",
              fileCount: 1,
              totalBytes: 21,
              checksum: "saved"
            }),
            { status: 201, headers: { "content-type": "application/json" } }
          );
        }
      });

      expect(deployCode).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/deployments/prebuilt");
      expect(seen.authorization).toBe("Bearer saved-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links the current directory to a project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-link-"));

    try {
      const seen = {
        url: "",
        authorization: ""
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "link",
          "--project",
          "project-acme-dashboard",
          "--server",
          "https://siteflow.example.com",
          "--token",
          "secret-token",
          "--root",
          root,
          "--json"
        ],
        io,
        {
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            return new Response(JSON.stringify(projectSettingsResponse()), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );
      const result = JSON.parse(output.stdout);
      const storedLink = JSON.parse(await readFile(path.join(root, ".siteflow", "project.json"), "utf8"));

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/settings");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(result).toMatchObject({
        status: "linked",
        projectId: "project-acme-dashboard",
        projectSlug: "acme-dashboard",
        projectName: "Acme Dashboard",
        serverUrl: "https://siteflow.example.com"
      });
      expect(storedLink).toMatchObject({
        projectId: "project-acme-dashboard",
        projectSlug: "acme-dashboard",
        projectName: "Acme Dashboard",
        serverUrl: "https://siteflow.example.com"
      });
      expect(storedLink.linkedAt).toEqual(expect.any(String));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pulls metadata-only env placeholders from a linked project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-env-pull-"));

    try {
      await mkdir(path.join(root, ".siteflow"), { recursive: true });
      await writeFile(
        path.join(root, ".siteflow", "project.json"),
        `${JSON.stringify({
          projectId: "project-acme-dashboard",
          projectSlug: "acme-dashboard",
          projectName: "Acme Dashboard",
          serverUrl: "https://siteflow.example.com",
          linkedAt: "2026-05-25T12:00:00.000Z"
        })}\n`
      );

      const seen = {
        url: "",
        authorization: ""
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "env",
          "pull",
          "--root",
          root,
          "--output",
          ".env.local",
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_API_TOKEN: "secret-token"
          },
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            return new Response(JSON.stringify(projectSettingsResponse()), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );
      const result = JSON.parse(output.stdout);
      const envFile = await readFile(path.join(root, ".env.local"), "utf8");

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/settings");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(result).toMatchObject({
        status: "pulled",
        projectId: "project-acme-dashboard",
        targetEnvironment: "preview",
        variables: 1,
        metadataOnly: true
      });
      expect(envFile).toContain("# SiteFlow env pull writes metadata-only placeholders.");
      expect(envFile).toContain("# Secret values are not returned by the control plane.");
      expect(envFile).toContain("# Project: Acme Dashboard (project-acme-dashboard)");
      expect(envFile).toContain("# SITEFLOW_TOKEN scope=build source=sealed fingerprint=sha256:redacted");
      expect(envFile).toContain("# SITEFLOW_TOKEN=");
      expect(envFile).not.toContain("secret-token");
      expect(envFile).not.toContain("API_URL=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes a prebuilt deploy when --prod is requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-prod-deploy-"));
    const configPath = path.join(root, "config.json");
    const site = path.join(root, "dist");

    try {
      await mkdir(site, { recursive: true });
      await writeFile(path.join(site, "index.html"), "<h1>Production</h1>");
      await writeFile(
        configPath,
        `${JSON.stringify({
          defaultServer: "https://siteflow.example.com",
          servers: {
            "https://siteflow.example.com": {
              token: "saved-token",
              baseDomain: "w33d.xyz"
            }
          }
        })}\n`
      );

      const calls: Array<{
        url: string;
        method?: string;
        authorization: string;
        body: Record<string, unknown>;
      }> = [];
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy",
          "--prebuilt",
          site,
          "--project",
          "docs",
          "--prod",
          "--config",
          configPath,
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev",
            SITEFLOW_ACTOR_EMAIL: "dev@example.com"
          },
          fetch: async (input, init) => {
            calls.push({
              url: input.toString(),
              method: init?.method,
              authorization: new Headers(init?.headers).get("authorization") ?? "",
              body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
            });

            if (input.toString().endsWith("/api/deployments/prebuilt")) {
              return new Response(
                JSON.stringify({
                  deploymentId: "dep_prebuilt",
                  projectId: "project_docs",
                  projectSlug: "docs",
                  previewHost: "preview.w33d.xyz",
                  previewUrl: "https://preview.w33d.xyz",
                  artifactRoot: "/var/lib/siteflow/artifacts/dep_prebuilt",
                  fileCount: 1,
                  totalBytes: 19,
                  checksum: "prod"
                }),
                { status: 201, headers: { "content-type": "application/json" } }
              );
            }

            return new Response(
              JSON.stringify({
                ...acceptedPromotionResponse(),
                routeRevision: {
                  id: "route_promote",
                  status: "applied",
                  channel: "production",
                  deploymentId: "dep_prebuilt"
                }
              }),
              { status: 202, headers: { "content-type": "application/json" } }
            );
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        url: "https://siteflow.example.com/api/deployments/prebuilt",
        method: "POST",
        authorization: "Bearer saved-token",
        body: {
          projectSlug: "docs",
          baseDomain: "w33d.xyz"
        }
      });
      expect(calls[1]).toMatchObject({
        url: "https://siteflow.example.com/api/projects/project_docs/release/production/promote",
        method: "POST",
        authorization: "Bearer saved-token",
        body: {
          projectId: "project_docs",
          channel: "production",
          targetDeploymentId: "dep_prebuilt",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            email: "dev@example.com",
            role: "developer"
          },
          idempotencyKey: "promote:dep_prebuilt:production",
          dryRun: false
        }
      });
      expect(result).toMatchObject({
        deploymentId: "dep_prebuilt",
        production: {
          status: "accepted"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes a deployment through the release API", async () => {
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "promote",
        "dep_123",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--reason",
        "ship",
        "--json"
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev",
          SITEFLOW_ACTOR_EMAIL: "dev@example.com"
        },
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
          return new Response(JSON.stringify(acceptedPromotionResponse()), {
            status: 202,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/release/production/promote");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(seen.body).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      targetDeploymentId: "dep_123",
      actor: {
        id: "user_1",
        name: "Acme Dev",
        email: "dev@example.com",
        role: "developer"
      },
      reason: "ship",
      idempotencyKey: "promote:dep_123:production",
      dryRun: false
    });
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "accepted"
    });
  });

  it("rolls a release channel back to a known deployment", async () => {
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "rollback",
        "dep_123",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--current-deployment",
        "dep_current",
        "--json"
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              ...acceptedPromotionResponse(),
              message: "Rollback route applied."
            }),
            { status: 202, headers: { "content-type": "application/json" } }
          );
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/rollback/production/rollback");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(seen.body).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      targetDeploymentId: "dep_123",
      currentDeploymentId: "dep_current",
      actor: {
        id: "user_1",
        name: "Acme Dev",
        role: "developer"
      },
      idempotencyKey: "rollback:dep_123:production",
      dryRun: false
    });
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "accepted"
    });
  });

  it("creates a deploy hook for a linked project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-hook-create-"));

    try {
      await mkdir(path.join(root, ".siteflow"), { recursive: true });
      await writeFile(
        path.join(root, ".siteflow", "project.json"),
        `${JSON.stringify({
          projectId: "project-acme-dashboard",
          projectSlug: "acme-dashboard",
          projectName: "Acme Dashboard",
          serverUrl: "https://siteflow.example.com",
          linkedAt: "2026-05-25T12:00:00.000Z"
        })}\n`
      );

      const seen = {
        url: "",
        authorization: "",
        body: {} as Record<string, unknown>
      };
      const { io, output } = createIo();
      const code = await runSiteFlowCli(
        [
          "deploy-hook",
          "create",
          "CMS rebuild",
          "--root",
          root,
          "--branch",
          "main",
          "--environment",
          "preview",
          "--json"
        ],
        io,
        {
          env: {
            SITEFLOW_API_TOKEN: "secret-token",
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev"
          },
          fetch: async (input, init) => {
            seen.url = input.toString();
            seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
            seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
            return new Response(JSON.stringify(deployHookCreateResponse()), {
              status: 201,
              headers: { "content-type": "application/json" }
            });
          }
        }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/deploy-hooks");
      expect(seen.authorization).toBe("Bearer secret-token");
      expect(seen.body).toMatchObject({
        projectId: "project-acme-dashboard",
        name: "CMS rebuild",
        branch: "main",
        targetEnvironment: "preview",
        actor: {
          id: "user_1",
          name: "Acme Dev",
          role: "developer"
        }
      });
      expect(result).toMatchObject({
        status: "created",
        token: "sfh_test_token",
        hookUrl: "https://siteflow.example.com/api/deploy-hooks/sfh_test_token/trigger",
        hook: {
          id: "hook_preview",
          projectId: "project-acme-dashboard"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists deploy hooks without exposing full hook tokens", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "deploy-hook",
        "list",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(JSON.stringify(deployHookListResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );
    const result = JSON.parse(output.stdout);
    const serialized = JSON.stringify(result);

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/deploy-hooks");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(result).toMatchObject({
      total: 1,
      hooks: [
        {
          id: "hook_preview",
          tokenPrefix: "sfh_test_tok"
        }
      ]
    });
    expect(serialized).not.toContain("sfh_test_token");
  });

  it("revokes a deploy hook through the management API", async () => {
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "deploy-hook",
        "revoke",
        "hook_preview",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--reason",
        "rotated",
        "--json"
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
          return new Response(JSON.stringify(deployHookRevokeResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/deploy-hooks/hook_preview");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(seen.body).toMatchObject({
      projectId: "project-acme-dashboard",
      hookId: "hook_preview",
      reason: "rotated",
      actor: {
        id: "user_1",
        name: "Acme Dev",
        role: "developer"
      }
    });
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "revoked",
      hook: {
        id: "hook_preview",
        status: "revoked"
      }
    });
  });

  it("starts a rolling release through the management API", async () => {
    const seen = {
      url: "",
      authorization: "",
      body: {} as Record<string, unknown>
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "rolling",
        "start",
        "dep-canary",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--percentage",
        "10",
        "--json"
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          seen.body = JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>;
          return new Response(JSON.stringify(rollingCommandResponse(10)), {
            status: 202,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/start");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(seen.body).toMatchObject({
      projectId: "project-acme-dashboard",
      channel: "production",
      candidateDeploymentId: "dep-canary",
      percentage: 10,
      idempotencyKey: "rolling:start:dep-canary:production",
      actor: {
        id: "user_1",
        name: "Acme Dev",
        role: "developer"
      }
    });
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "accepted",
      rollout: {
        id: "rollout_preview",
        percentage: 10
      }
    });
  });

  it("advances, completes, and aborts rolling releases", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { io } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
      });
      const action = input.toString().split("/").pop();
      const response = action === "complete"
        ? rollingCommandResponse(100, "completed")
        : action === "abort"
          ? rollingCommandResponse(25, "aborted")
          : rollingCommandResponse(50);

      return new Response(JSON.stringify(response), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];
    const advanceCode = await runSiteFlowCli(["rolling", "advance", "--percentage", "50", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const completeCode = await runSiteFlowCli(["rolling", "complete", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const abortCode = await runSiteFlowCli(["rolling", "abort", "--reason", "stop canary", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([advanceCode, completeCode, abortCode]).toEqual([0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/advance",
        body: expect.objectContaining({
          percentage: 50,
          idempotencyKey: "rolling:advance:active:production"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/complete",
        body: expect.objectContaining({
          idempotencyKey: "rolling:complete:active:production"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/abort",
        body: expect.objectContaining({
          reason: "stop canary",
          idempotencyKey: "rolling:abort:active:production"
        })
      }
    ]);
  });

  it("creates and lists cron jobs through the management API", async () => {
    const requests: Array<{ url: string; authorization: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "cron",
        "create",
        "Revalidate homepage",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--path",
        "/api/revalidate",
        "--schedule",
        "0 * * * *",
        "--json"
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch: async (input, init) => {
          requests.push({
            url: input.toString(),
            authorization: new Headers(init?.headers).get("authorization") ?? "",
            body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
          });
          return new Response(JSON.stringify(cronJobCreateResponse()), {
            status: 201,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );
    const listCode = await runSiteFlowCli(
      [
        "cron",
        "list",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          requests.push({
            url: input.toString(),
            authorization: new Headers(init?.headers).get("authorization") ?? ""
          });
          return new Response(JSON.stringify(cronJobListResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect([code, listCode]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs",
        authorization: "Bearer secret-token",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Revalidate homepage",
          path: "/api/revalidate",
          schedule: "0 * * * *",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs",
        authorization: "Bearer secret-token"
      }
    ]);
    expect(JSON.parse(output.stdout.split("\n}\n")[0] + "\n}")).toMatchObject({
      status: "created",
      job: {
        id: "cron_revalidate"
      }
    });
  });

  it("runs and disables cron jobs through the management API", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { io } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        body: JSON.parse(init?.body?.toString() ?? "{}") as Record<string, unknown>
      });
      const response = input.toString().endsWith("/run") ? cronJobRunResponse() : cronJobDisableResponse();

      return new Response(JSON.stringify(response), {
        status: input.toString().endsWith("/run") ? 202 : 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];
    const runCode = await runSiteFlowCli(["cron", "run", "cron_revalidate", "--reason", "manual", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const disableCode = await runSiteFlowCli(["cron", "disable", "cron_revalidate", "--reason", "pause", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([runCode, disableCode]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate/run",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          jobId: "cron_revalidate",
          reason: "manual",
          idempotencyKey: "cron:run:cron_revalidate:project-acme-dashboard"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          jobId: "cron_revalidate",
          reason: "pause"
        })
      }
    ]);
  });

  it("queries project logs through the observability API", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "logs",
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--source",
        "build",
        "--severity",
        "warning",
        "--search",
        "deploy",
        "--limit",
        "25",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(JSON.stringify(logQueryResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/projects/project-acme-dashboard/logs?source=build&severity=warning&search=deploy&limit=25");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(JSON.parse(output.stdout)).toMatchObject({
      total: 1,
      entries: [
        {
          source: "build",
          severity: "warning"
        }
      ]
    });
  });

  it("creates, lists, and delivers log drains through the management API", async () => {
    const requests: Array<{ url: string; authorization: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });
      const url = input.toString();
      const response = url.endsWith("/deliver")
        ? logDrainDeliveryResponse()
        : init?.method === "POST"
          ? logDrainCreateResponse()
          : logDrainListResponse();

      return new Response(JSON.stringify(response), {
        status: init?.method === "POST" ? 202 : 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];
    const createCode = await runSiteFlowCli(
      [
        "log-drain",
        "create",
        "Datadog",
        "--url",
        "https://logs.example.test/siteflow",
        "--sources",
        "build,function",
        "--severity",
        "warning",
        "--signing-secret",
        "sfd_super_secret",
        ...common
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch
      }
    );
    const listCode = await runSiteFlowCli(["log-drain", "list", ...common], io, { fetch });
    const deliverCode = await runSiteFlowCli(["log-drain", "deliver", "drain_datadog", "--reason", "manual", ...common], io, { fetch });
    const serialized = output.stdout;

    expect([createCode, listCode, deliverCode]).toEqual([0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains",
        authorization: "Bearer secret-token",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Datadog",
          url: "https://logs.example.test/siteflow",
          sources: ["build", "function"],
          minimumSeverity: "warning",
          signingSecret: "sfd_super_secret",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains",
        authorization: "Bearer secret-token",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains/drain_datadog/deliver",
        authorization: "Bearer secret-token",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          drainId: "drain_datadog",
          reason: "manual"
        })
      }
    ]);
    expect(serialized).toContain("drain_datadog");
    expect(serialized).not.toContain("sfd_super_secret");
  });

  it("lists audit events and manages scoped API tokens", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });

      if (url.endsWith("/api-tokens") && init?.method === "POST") {
        return new Response(JSON.stringify({
          status: "created",
          token: {
            id: "token_created",
            projectId: "project-acme-dashboard",
            name: "CI deploy",
            tokenPrefix: "sft_created",
            scopes: ["read", "write"],
            status: "active",
            createdAt: "2026-05-26T00:00:00.000Z",
            updatedAt: "2026-05-26T00:00:00.000Z"
          },
          secret: "sft_created_secret",
          message: "API token created."
        }), { status: 201, headers: { "content-type": "application/json" } });
      }

      if (url.includes("/api-tokens/token_ci") && init?.method === "DELETE") {
        return new Response(JSON.stringify({
          status: "revoked",
          token: {
            ...projectSettingsResponse().apiTokens[0],
            status: "revoked",
            revokedAt: "2026-05-26T00:01:00.000Z"
          },
          message: "API token revoked."
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response(JSON.stringify(projectSettingsResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const auditCode = await runSiteFlowCli(["audit", "list", ...common], io, { fetch });
    const listCode = await runSiteFlowCli(["api-token", "list", ...common], io, { fetch });
    const createCode = await runSiteFlowCli(["api-token", "create", "CI deploy", "--scopes", "read,write", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const revokeCode = await runSiteFlowCli(["api-token", "revoke", "token_ci", "--reason", "rotated", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([auditCode, listCode, createCode, revokeCode]).toEqual([0, 0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/api-tokens",
        authorization: "Bearer secret-token",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "CI deploy",
          scopes: ["read", "write"],
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/settings",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/api-tokens/token_ci",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          tokenId: "token_ci",
          reason: "rotated"
        })
      }
    ]);
    expect(output.stdout).toContain("auditEvents");
    expect(output.stdout).toContain("apiTokens");
    expect(output.stdout).toContain("token_created");
    expect(output.stdout).toContain("token_ci");
  });

  it("manages firewall rules and Edge Config through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });

      if (url.endsWith("/firewall-rules") && init?.method === "POST") {
        return new Response(JSON.stringify(firewallRuleCreateResponse()), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.includes("/firewall-rules/fw_block_admin") && init?.method === "DELETE") {
        return new Response(JSON.stringify(firewallRuleDisableResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/edge-config/maintenance") && init?.method === "PUT") {
        return new Response(JSON.stringify(edgeConfigUpsertResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/edge-config/maintenance") && init?.method === "DELETE") {
        return new Response(JSON.stringify(edgeConfigDeleteResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/firewall-rules")) {
        return new Response(JSON.stringify(firewallRuleListResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(edgeConfigResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const firewallCreate = await runSiteFlowCli(
      [
        "firewall",
        "create",
        "Block admin",
        "--action",
        "block",
        "--path",
        "/admin/*",
        "--ip",
        "203.0.113.*",
        "--header",
        "x-plan=free",
        "--user-agent",
        "curl",
        "--priority",
        "10",
        ...common
      ],
      io,
      {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch
      }
    );
    const firewallList = await runSiteFlowCli(["firewall", "list", ...common], io, { fetch });
    const firewallDisable = await runSiteFlowCli(["firewall", "disable", "fw_block_admin", "--reason", "rotated", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const edgeList = await runSiteFlowCli(["edge-config", "list", ...common], io, { fetch });
    const edgeSet = await runSiteFlowCli(["edge-config", "set", "maintenance", "{\"enabled\":true}", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const edgeDelete = await runSiteFlowCli(["edge-config", "delete", "maintenance", "--reason", "cleanup", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([firewallCreate, firewallList, firewallDisable, edgeList, edgeSet, edgeDelete]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules",
        authorization: "Bearer secret-token",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Block admin",
          action: "block",
          priority: 10,
          conditions: {
            ipRanges: ["203.0.113.*"],
            pathPattern: "/admin/*",
            header: {
              name: "x-plan",
              value: "free"
            },
            userAgent: "curl"
          },
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules/fw_block_admin",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          ruleId: "fw_block_admin",
          reason: "rotated"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config/maintenance",
        authorization: "Bearer secret-token",
        method: "PUT",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          key: "maintenance",
          value: {
            enabled: true
          },
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config/maintenance",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          key: "maintenance",
          reason: "cleanup"
        })
      }
    ]);
    expect(output.stdout).toContain("fw_block_admin");
    expect(output.stdout).toContain("maintenance");
  });

  it("manages blobs through project APIs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-blob-cli-"));

    try {
      const localPath = path.join(root, "config.json");
      const outputPath = path.join(root, "download", "config.json");
      await writeFile(localPath, "{\"enabled\":true}");

      const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
      const { io, output } = createIo();
      const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
        });

        if (url.endsWith("/blobs") && init?.method === "POST") {
          return new Response(JSON.stringify(blobPutResponse()), {
            status: 201,
            headers: { "content-type": "application/json" }
          });
        }

        if (url.includes("/blobs/assets%2Fconfig%2Fapp.json") && init?.method === "DELETE") {
          return new Response(JSON.stringify(blobDeleteResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (url.includes("/blobs/assets%2Fconfig%2Fapp.json")) {
          return new Response(JSON.stringify(blobReadResponse()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        return new Response(JSON.stringify(blobListResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };
      const common = [
        "--project",
        "project-acme-dashboard",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--root",
        root,
        "--json"
      ];

      const put = await runSiteFlowCli(
        [
          "blob",
          "put",
          "config.json",
          "--pathname",
          "assets/config/app.json",
          "--content-type",
          "application/json",
          "--access",
          "private",
          "--cache-max-age",
          "120",
          ...common
        ],
        io,
        {
          env: {
            SITEFLOW_ACTOR_ID: "user_1",
            SITEFLOW_ACTOR_NAME: "Acme Dev"
          },
          fetch
        }
      );
      const list = await runSiteFlowCli(["blob", "list", "--prefix", "assets/", ...common], io, { fetch });
      const get = await runSiteFlowCli(["blob", "get", "assets/config/app.json", "--output", "download/config.json", ...common], io, {
        fetch
      });
      const deleted = await runSiteFlowCli(["blob", "delete", "assets/config/app.json", "--reason", "cleanup", ...common], io, {
        env: {
          SITEFLOW_ACTOR_ID: "user_1",
          SITEFLOW_ACTOR_NAME: "Acme Dev"
        },
        fetch
      });

      expect([put, list, get, deleted]).toEqual([0, 0, 0, 0]);
      expect(await readFile(outputPath, "utf8")).toBe("{\"enabled\":true}");
      expect(requests).toEqual([
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs",
          authorization: "Bearer secret-token",
          method: "POST",
          body: expect.objectContaining({
            projectId: "project-acme-dashboard",
            pathname: "assets/config/app.json",
            contentBase64: Buffer.from("{\"enabled\":true}", "utf8").toString("base64"),
            contentType: "application/json",
            access: "private",
            cacheControlMaxAge: 120,
            actor: {
              id: "user_1",
              name: "Acme Dev",
              role: "developer"
            }
          })
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs?prefix=assets%2F",
          authorization: "Bearer secret-token",
          method: "GET",
          body: undefined
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs/assets%2Fconfig%2Fapp.json",
          authorization: "Bearer secret-token",
          method: "GET",
          body: undefined
        },
        {
          url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs/assets%2Fconfig%2Fapp.json",
          authorization: "Bearer secret-token",
          method: "DELETE",
          body: expect.objectContaining({
            projectId: "project-acme-dashboard",
            pathname: "assets/config/app.json",
            reason: "cleanup"
          })
        }
      ]);
      expect(output.stdout).toContain("assets/config/app.json");
      expect(output.stdout).toContain("downloaded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inspects and purges cache through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: Record<string, unknown> }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) as Record<string, unknown> : undefined
      });

      if (url.endsWith("/cache/purge")) {
        return new Response(JSON.stringify(cachePurgeResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(cacheListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const list = await runSiteFlowCli(["cache", "list", "--tag", "marketing", "--status", "stale", ...common], io, { fetch });
    const purge = await runSiteFlowCli(["cache", "purge", "--tag", "marketing", "--reason", "content update", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([list, purge]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cache?tag=marketing&status=stale",
        authorization: "Bearer secret-token",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cache/purge",
        authorization: "Bearer secret-token",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          tag: "marketing",
          reason: "content update",
          actor: {
            id: "user_1",
            name: "Acme Dev",
            role: "developer"
          }
        })
      }
    ]);
    expect(output.stdout).toContain("entries");
    expect(output.stdout).toContain("purged");
  });

  it("inspects deployed function runtime controls through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET"
      });

      if (url.includes("/functions/%2Fapi%2Frevalidate")) {
        return new Response(JSON.stringify(functionRuntimeResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(functionListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--deployment",
      "dep_function",
      "--json"
    ];

    const list = await runSiteFlowCli(["functions", "list", ...common], io, { fetch });
    const inspect = await runSiteFlowCli(["functions", "inspect", "/api/revalidate", "--limit", "1", ...common], io, { fetch });

    expect([list, inspect]).toEqual([0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/functions?deploymentId=dep_function",
        authorization: "Bearer secret-token",
        method: "GET"
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/functions/%2Fapi%2Frevalidate?deploymentId=dep_function&limit=1",
        authorization: "Bearer secret-token",
        method: "GET"
      }
    ]);
    expect(output.stdout).toContain("/api/revalidate");
    expect(output.stdout).toContain("recentInvocations");
  });

  it("manages routing rules through project APIs", async () => {
    const requests: Array<{ url: string; authorization: string; method: string; body?: unknown }> = [];
    const { io, output } = createIo();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body.toString()) : undefined
      });

      if (init?.method === "PUT") {
        return new Response(JSON.stringify(routingRuleUpsertResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (init?.method === "DELETE") {
        return new Response(JSON.stringify(routingRuleDisableResponse()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify(routingRuleListResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const common = [
      "--project",
      "project-acme-dashboard",
      "--server",
      "https://siteflow.example.com",
      "--token",
      "secret-token",
      "--json"
    ];

    const list = await runSiteFlowCli(["routing-rules", "list", "--kind", "redirect", ...common], io, { fetch });
    const upsert = await runSiteFlowCli([
      "routing-rules",
      "upsert",
      "Docs redirect",
      "--kind",
      "redirect",
      "--source",
      "/docs",
      "--destination",
      "/documentation",
      "--status-code",
      "308",
      "--priority",
      "10",
      ...common
    ], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });
    const disable = await runSiteFlowCli(["routing-rules", "disable", "route_docs", "--reason", "cleanup", ...common], io, {
      env: {
        SITEFLOW_ACTOR_ID: "user_1",
        SITEFLOW_ACTOR_NAME: "Acme Dev"
      },
      fetch
    });

    expect([list, upsert, disable]).toEqual([0, 0, 0]);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules?kind=redirect",
        authorization: "Bearer secret-token",
        method: "GET"
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules",
        authorization: "Bearer secret-token",
        method: "PUT",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Docs redirect",
          kind: "redirect",
          source: "/docs",
          destination: "/documentation",
          statusCode: 308,
          priority: 10
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules/route_docs",
        authorization: "Bearer secret-token",
        method: "DELETE",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          ruleId: "route_docs",
          reason: "cleanup"
        })
      }
    ]);
    expect(output.stdout).toContain("route_docs");
    expect(output.stdout).toContain("disabled");
  });

  it("lists deployments from the management API", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "deployments",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token",
        "--project",
        "project-acme-dashboard",
        "--json"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              deployments: [
                {
                  id: "dep_123",
                  projectId: "project-acme-dashboard",
                  projectName: "Acme Dashboard",
                  version: "2026.05.25.1200",
                  commitSha: "4f3a9c2d1b0e",
                  branch: "main",
                  status: "ready",
                  routeRevisionStatus: "applied",
                  createdAt: "2026-05-25T12:00:00.000Z"
                }
              ],
              total: 1,
              projectId: "project-acme-dashboard",
              updatedAt: "2026-05-25T12:01:00.000Z"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
    );
    const result = JSON.parse(output.stdout);

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/deployments?projectId=project-acme-dashboard");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(result).toMatchObject({
      total: 1,
      deployments: [
        {
          id: "dep_123",
          status: "ready",
          routeRevisionStatus: "applied"
        }
      ]
    });
  });

  it("inspects a deployment and prints source, artifact, and route evidence", async () => {
    const seen = {
      url: "",
      authorization: ""
    };
    const { io, output } = createIo();
    const code = await runSiteFlowCli(
      [
        "inspect",
        "dep_123",
        "--server",
        "https://siteflow.example.com",
        "--token",
        "secret-token"
      ],
      io,
      {
        fetch: async (input, init) => {
          seen.url = input.toString();
          seen.authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              project: {
                name: "Acme Dashboard"
              },
              deployment: {
                id: "dep_123",
                status: "ready",
                environment: "production",
                version: "2026.05.25.1200",
                readyAt: "2026-05-25T12:00:00.000Z"
              },
              lineage: {
                sourceEvent: {
                  branch: "main",
                  commitSha: "4f3a9c2d1b0e"
                },
                buildJob: {
                  status: "succeeded"
                },
                artifact: {
                  verificationStatus: "verified",
                  manifest: {
                    fileCount: 128,
                    totalBytes: 4821108,
                    checksum: "sha256:abc"
                  }
                },
                routeRevision: {
                  id: "route_123",
                  status: "applied"
                }
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
    );

    expect(code).toBe(0);
    expect(seen.url).toBe("https://siteflow.example.com/api/deployments/dep_123");
    expect(seen.authorization).toBe("Bearer secret-token");
    expect(output.stdout).toContain("Deployment dep_123");
    expect(output.stdout).toContain("Source:     main@4f3a9c2d");
    expect(output.stdout).toContain("Route:      route_123 / applied");
  });
});
