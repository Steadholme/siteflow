import { siteflowFixtures } from "@lib/fixtures/siteflow.fixtures";
import { REDACTION_PLACEHOLDER, SITEFLOW_SECRET_CANARY } from "@lib/redaction";
import { HttpSiteFlowClient, SiteFlowHttpError } from "./httpClient";

const releaseEvidenceRequest = {
  evidencePath: "evidence/release-evidence.json",
  bundle: {
    schemaVersion: "siteflow.releaseEvidence.v1",
    name: "siteflow-release-evidence-bundle",
    targetEnvironment: "production"
  }
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
}

describe("HttpSiteFlowClient", () => {
  it("loads project inventory from the production API", async () => {
    const requests: string[] = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      fetch: async (input) => {
        requests.push(input.toString());
        return jsonResponse(siteflowFixtures.healthy.projectList);
      }
    });

    const data = await client.listProjects();

    expect(data.summary.totalProjects).toBe(1);
    expect(requests).toEqual(["https://siteflow.example.com/api/projects"]);
  });

  it("adds a Bearer authorization header when an auth token is configured", async () => {
    const authorizationHeaders: Array<string | null> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      authToken: " sf_live_operator_console_token ",
      fetch: async (_input, init) => {
        authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse(siteflowFixtures.healthy.projectList);
      }
    });

    await client.listProjects();

    expect(authorizationHeaders).toEqual(["Bearer sf_live_operator_console_token"]);
  });

  it("loads Bearer authorization from a token provider", async () => {
    const authorizationHeaders: Array<string | null> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      getAuthToken: async () => "sf_test_operator_console_token",
      fetch: async (_input, init) => {
        authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse(siteflowFixtures.healthy.projectList);
      }
    });

    await client.listProjects();

    expect(authorizationHeaders).toEqual(["Bearer sf_test_operator_console_token"]);
  });

  it("does not add an authorization header when no token is configured", async () => {
    const authorizationHeaders: Array<string | null> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      fetch: async (_input, init) => {
        authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse(siteflowFixtures.healthy.projectList);
      }
    });

    await client.listProjects();

    expect(authorizationHeaders).toEqual([null]);
  });

  it("adds a same-origin CSRF header for cookie-backed mutation requests", async () => {
    const requests: Array<{ authorization: string | null; csrf: string | null; credentials?: RequestCredentials }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("authorization"),
          csrf: headers.get("x-siteflow-csrf"),
          credentials: init?.credentials
        });
        return jsonResponse({ status: "created", project: siteflowFixtures.healthy.projectList.projects[0] });
      }
    });

    await client.createProject({
      name: "Docs",
      slug: "docs"
    });

    expect(requests).toEqual([
      {
        authorization: null,
        csrf: "same-origin",
        credentials: "same-origin"
      }
    ]);
  });

  it("does not add CSRF headers to bearer or credentialless mutation requests", async () => {
    const csrfHeaders: Array<string | null> = [];
    const bearerClient = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      authToken: "sf_live_operator_console_token",
      fetch: async (_input, init) => {
        csrfHeaders.push(new Headers(init?.headers).get("x-siteflow-csrf"));
        return jsonResponse({ status: "created", project: siteflowFixtures.healthy.projectList.projects[0] });
      }
    });
    const publicClient = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      fetch: async (_input, init) => {
        csrfHeaders.push(new Headers(init?.headers).get("x-siteflow-csrf"));
        return jsonResponse({
          status: "accepted",
          event: {
            id: "analytics_pageview_docs",
            projectId: "project-acme-dashboard",
            kind: "pageview",
            path: "/docs",
            receivedAt: "2026-05-26T00:00:01.000Z"
          },
          message: "Analytics event accepted."
        });
      }
    });

    await bearerClient.createProject({
      name: "Docs",
      slug: "docs"
    });
    await publicClient.ingestAnalyticsEvent({
      projectId: "project-acme-dashboard",
      kind: "pageview",
      path: "/docs"
    });

    expect(csrfHeaders).toEqual([null, null]);
  });

  it("posts normalized git webhook commands to the selected provider path", async () => {
    const requests: Array<{ url: string; delivery: string | null; body: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          delivery: new Headers(init?.headers).get("x-siteflow-delivery"),
          body: JSON.parse(init?.body?.toString() ?? "{}")
        });
        return jsonResponse({
          status: "accepted",
          buildJobId: "build_gitlab_1",
          message: "Git webhook accepted and build job queued."
        });
      }
    });

    await client.ingestGitWebhook({
      provider: "gitlab",
      deliveryId: "delivery-gitlab-1",
      event: {
        provider: "gitlab",
        deliveryId: "delivery-gitlab-1",
        kind: "push",
        repository: {
          provider: "gitlab",
          owner: "acme",
          name: "docs",
          defaultBranch: "main"
        },
        branch: "main",
        commitSha: "abc123def456",
        commitMessage: "Ship",
        commitAuthor: "Ada",
        receivedAt: "2026-06-08T00:00:00.000Z",
        actor: {
          id: "gitlab:ada",
          name: "ada",
          role: "developer"
        }
      }
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/webhooks/git/gitlab",
        delivery: "delivery-gitlab-1",
        body: expect.objectContaining({
          provider: "gitlab",
          deliveryId: "delivery-gitlab-1",
          kind: "push"
        })
      }
    ]);
  });

  it("loads deployment inventory with an optional project filter", async () => {
    const requests: string[] = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      fetch: async (input) => {
        requests.push(input.toString());
        return jsonResponse({
          deployments: [siteflowFixtures.healthy.projectList.projects[0].productionDeployment],
          total: 1,
          projectId: "project-acme-dashboard",
          updatedAt: "2026-05-25T00:00:00.000Z"
        });
      }
    });

    const data = await client.listDeployments("project-acme-dashboard");

    expect(data.total).toBe(1);
    expect(requests).toEqual(["https://siteflow.example.com/api/deployments?projectId=project-acme-dashboard"]);
  });

  it("posts release commands as JSON", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          body: JSON.parse(init?.body?.toString() ?? "{}")
        });
        return jsonResponse(siteflowFixtures.healthy.commandResults.promote);
      }
    });

    await client.promoteDeployment({
      projectId: "project-acme-dashboard",
      channel: "production",
      targetDeploymentId: "dep-healthy",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "ship",
      idempotencyKey: "idem-1",
      releaseEvidence: releaseEvidenceRequest
    });
    await client.rollbackDeployment({
      projectId: "project-acme-dashboard",
      channel: "production",
      targetDeploymentId: "dep-previous",
      currentDeploymentId: "dep-healthy",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "rollback",
      idempotencyKey: "idem-rollback"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/release/production/promote",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          targetDeploymentId: "dep-healthy",
          idempotencyKey: "idem-1",
          releaseEvidence: releaseEvidenceRequest
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rollback/production/rollback",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          targetDeploymentId: "dep-previous",
          currentDeploymentId: "dep-healthy",
          idempotencyKey: "idem-rollback"
        })
      }
    ]);
  });

  it("uses rolling release management routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "accepted",
          rollout: {
            id: "rollout_preview",
            projectId: "project-acme-dashboard",
            channel: "production",
            currentDeploymentId: "dep-healthy",
            candidateDeploymentId: "dep-canary",
            percentage: 10,
            status: "active",
            actor: { id: "actor-1", name: "Ops", role: "operator" },
            reason: "canary",
            createdAt: "2026-05-25T00:00:00.000Z",
            updatedAt: "2026-05-25T00:00:00.000Z"
          },
          safetyChecks: [],
          message: "Rolling release accepted."
        });
      }
    });

    await client.getRollingRelease("project-acme-dashboard", "production");
    await client.startRollingRelease({
      projectId: "project-acme-dashboard",
      channel: "production",
      candidateDeploymentId: "dep-canary",
      percentage: 10,
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "canary",
      idempotencyKey: "rollout-start",
      releaseEvidence: releaseEvidenceRequest
    });
    await client.advanceRollingRelease({
      projectId: "project-acme-dashboard",
      channel: "production",
      percentage: 50,
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "advance",
      idempotencyKey: "rollout-advance",
      releaseEvidence: releaseEvidenceRequest
    });
    await client.completeRollingRelease({
      projectId: "project-acme-dashboard",
      channel: "production",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "complete",
      idempotencyKey: "rollout-complete",
      releaseEvidence: releaseEvidenceRequest
    });
    await client.abortRollingRelease({
      projectId: "project-acme-dashboard",
      channel: "production",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "abort",
      idempotencyKey: "rollout-abort"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/start",
        method: "POST",
        body: expect.objectContaining({
          candidateDeploymentId: "dep-canary",
          percentage: 10,
          idempotencyKey: "rollout-start",
          releaseEvidence: releaseEvidenceRequest
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/advance",
        method: "POST",
        body: expect.objectContaining({
          percentage: 50,
          idempotencyKey: "rollout-advance",
          releaseEvidence: releaseEvidenceRequest
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/complete",
        method: "POST",
        body: expect.objectContaining({
          idempotencyKey: "rollout-complete",
          releaseEvidence: releaseEvidenceRequest
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/rolling/production/abort",
        method: "POST",
        body: expect.objectContaining({
          idempotencyKey: "rollout-abort"
        })
      }
    ]);
  });

  it("uses cron job management routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "accepted",
          job: {
            id: "cron_revalidate",
            projectId: "project-acme-dashboard",
            name: "Revalidate homepage",
            path: "/api/revalidate",
            schedule: "0 * * * *",
            status: "active",
            createdAt: "2026-05-26T00:00:00.000Z",
            updatedAt: "2026-05-26T00:00:00.000Z"
          },
          dispatch: {
            id: "crondispatch_1",
            cronJobId: "cron_revalidate",
            projectId: "project-acme-dashboard",
            targetUrl: "https://dashboard.acme.test/api/revalidate",
            method: "GET",
            userAgent: "vercel-cron/1.0",
            status: "queued",
            reason: "manual",
            scheduledAt: "2026-05-26T00:00:00.000Z",
            dispatchedAt: "2026-05-26T00:00:00.000Z"
          },
          message: "Cron dispatch queued."
        });
      }
    });

    await client.listCronJobs("project-acme-dashboard");
    await client.createCronJob({
      projectId: "project-acme-dashboard",
      name: "Revalidate homepage",
      path: "/api/revalidate",
      schedule: "0 * * * *",
      actor: { id: "actor-1", name: "Ops", role: "operator" }
    });
    await client.disableCronJob({
      projectId: "project-acme-dashboard",
      jobId: "cron_revalidate",
      reason: "pause"
    });
    await client.runCronJob({
      projectId: "project-acme-dashboard",
      jobId: "cron_revalidate",
      reason: "manual",
      idempotencyKey: "cron-run-1"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs",
        method: "POST",
        body: expect.objectContaining({
          name: "Revalidate homepage",
          path: "/api/revalidate",
          schedule: "0 * * * *"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate",
        method: "DELETE",
        body: expect.objectContaining({
          jobId: "cron_revalidate",
          reason: "pause"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cron-jobs/cron_revalidate/run",
        method: "POST",
        body: expect.objectContaining({
          jobId: "cron_revalidate",
          idempotencyKey: "cron-run-1"
        })
      }
    ]);
  });

  it("uses analytics dashboard and privacy-preserving ingestion routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; credentials?: RequestCredentials }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined,
          credentials: init?.credentials
        });

        if (input.toString().endsWith("/analytics/events")) {
          return jsonResponse({
            status: "accepted",
            event: {
              id: "analytics_pageview_pricing",
              projectId: "project-acme-dashboard",
              kind: "pageview",
              path: "/pricing",
              referrer: "https://vercel.com/templates",
              country: "US",
              browser: "Chrome",
              device: "desktop",
              occurredAt: "2026-05-26T00:00:00.000Z",
              receivedAt: "2026-05-26T00:00:01.000Z"
            },
            message: "Analytics event accepted."
          });
        }

        return jsonResponse({
          projectId: "project-acme-dashboard",
          window: "24h",
          totals: {
            pageviews: 42,
            customEvents: 7,
            webVitals: 3,
            uniquePaths: 5
          },
          topPages: [{ name: "/pricing", count: 10, percentage: 23.8 }],
          referrers: [{ name: "https://vercel.com/templates", count: 4, percentage: 9.5 }],
          countries: [{ name: "US", count: 40, percentage: 95.2 }],
          browsers: [{ name: "Chrome", count: 35, percentage: 83.3 }],
          devices: [{ name: "desktop", count: 34, percentage: 81 }],
          customEvents: [{ name: "signup_clicked", count: 7, percentage: 100 }],
          webVitals: [{ name: "LCP", count: 3, p75: 1840, rating: "good" }],
          updatedAt: "2026-05-26T00:00:02.000Z"
        });
      }
    });

    const dashboard = await client.getAnalyticsDashboard("project-acme-dashboard");
    const ingested = await client.ingestAnalyticsEvent({
      projectId: "project-acme-dashboard",
      kind: "pageview",
      path: `/pricing?token=${SITEFLOW_SECRET_CANARY}#plan`,
      referrer: `https://vercel.com/templates?token=${SITEFLOW_SECRET_CANARY}#card`,
      country: "US",
      browser: "Chrome",
      device: "desktop",
      occurredAt: "2026-05-26T00:00:00.000Z"
    });

    expect(dashboard.topPages[0]).toMatchObject({ name: "/pricing", count: 10 });
    expect(ingested.event).toMatchObject({ projectId: "project-acme-dashboard", path: "/pricing" });
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/analytics",
        method: "GET",
        body: undefined,
        credentials: "same-origin"
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/analytics/events",
        method: "POST",
        body: expect.objectContaining({
          kind: "pageview",
          path: expect.stringContaining(SITEFLOW_SECRET_CANARY),
          referrer: expect.stringContaining(SITEFLOW_SECRET_CANARY)
        }),
        credentials: "omit"
      }
    ]);
    expect(requests[1].body).not.toMatchObject({
      projectId: expect.any(String)
    });
  });

  it("uses observability log query and log drain routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        if (input.toString().includes("/logs?")) {
          return jsonResponse({
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
                message: "Build warning",
                timestamp: "2026-05-26T00:00:00.000Z"
              }
            ],
            total: 1,
            updatedAt: "2026-05-26T00:00:00.000Z"
          });
        }

        if (input.toString().endsWith("/log-queries")) {
          return jsonResponse({
            status: "saved",
            query: {
              id: "logquery_errors",
              projectId: "project-acme-dashboard",
              name: "Function errors",
              filters: { source: "function", severity: "error" },
              createdAt: "2026-05-26T00:00:00.000Z",
              updatedAt: "2026-05-26T00:00:00.000Z"
            },
            message: "Log query saved."
          }, { status: init?.method === "POST" ? 201 : 200 });
        }

        if (input.toString().endsWith("/deliver")) {
          return jsonResponse({
            status: "delivered",
            drain: {
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
          });
        }

        return jsonResponse({
          status: "created",
          drain: {
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
          },
          message: "Log drain created."
        });
      }
    });

    const logs = await client.queryLogs({
      projectId: "project-acme-dashboard",
      source: "build",
      severity: "warning",
      search: "deploy",
      limit: 25,
      cursor: "50"
    });
    const saved = await client.saveLogQuery({
      projectId: "project-acme-dashboard",
      name: "Function errors",
      filters: { source: "function", severity: "error" }
    });
    const drain = await client.createLogDrain({
      projectId: "project-acme-dashboard",
      name: "Datadog",
      url: "https://logs.example.test/siteflow",
      sources: ["build", "function"],
      minimumSeverity: "warning",
      signingSecret: "sfd_test_secret"
    });
    const delivered = await client.deliverLogDrain({
      projectId: "project-acme-dashboard",
      drainId: "drain_datadog",
      reason: "manual",
      limit: 10
    });

    expect(logs.entries[0]).toMatchObject({ source: "build", severity: "warning" });
    expect(saved.query.name).toBe("Function errors");
    expect(drain.drain.signingSecretPrefix).toBe("sfd_test_sec");
    expect(delivered.delivery.responseStatus).toBe(202);
    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/logs?source=build&severity=warning&search=deploy&limit=25&cursor=50",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-queries",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "Function errors"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains",
        method: "POST",
        body: expect.objectContaining({
          name: "Datadog",
          signingSecret: "sfd_test_secret"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/log-drains/drain_datadog/deliver",
        method: "POST",
        body: expect.objectContaining({
          drainId: "drain_datadog",
          reason: "manual"
        })
      }
    ]);
  });

  it("supports project and environment settings endpoints", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "created",
          project: siteflowFixtures.healthy.projectList.projects[0].project,
          message: "Project created."
        });
      }
    });

    await client.createProject({
      slug: "docs-portal",
      name: "Docs Portal",
      framework: "Vite",
      productionBranch: "release"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects",
        method: "POST",
        body: expect.objectContaining({
          slug: "docs-portal",
          productionBranch: "release"
        })
      }
    ]);
  });

  it("posts environment variables without requiring callers to handle raw routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "upserted",
          variable: {
            id: "env_1",
            projectId: "project-acme-dashboard",
            key: "SITEFLOW_TOKEN",
            targetEnvironment: "preview",
            scope: "build",
            source: "sealed",
            fingerprint: "sha256:redacted",
            updatedAt: "2026-05-25T00:00:00.000Z"
          },
          message: "Environment variable metadata saved."
        });
      }
    });

    await client.upsertEnvironmentVariable({
      projectId: "project-acme-dashboard",
      key: "SITEFLOW_TOKEN",
      value: "sf_live_secret_value",
      targetEnvironment: "preview",
      scope: "build"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/environment-variables",
        method: "POST",
        body: expect.objectContaining({
          key: "SITEFLOW_TOKEN",
          targetEnvironment: "preview",
          scope: "build"
        })
      }
    ]);
  });

  it("uses team member and scoped API token management routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "created",
          token: {
            id: "token_ci",
            projectId: "project-acme-dashboard",
            name: "CI read",
            tokenPrefix: "sft_ci_read",
            scopes: ["read"],
            status: "active",
            createdAt: "2026-05-26T00:00:00.000Z",
            updatedAt: "2026-05-26T00:00:00.000Z"
          },
          secret: "sft_ci_read_secret",
          message: "API token created."
        });
      }
    });

    await client.upsertTeamMember({
      projectId: "project-acme-dashboard",
      actor: { id: "actor-viewer", name: "Viewer", role: "operator" },
      role: "viewer"
    });
    await client.removeTeamMember({
      projectId: "project-acme-dashboard",
      memberId: "member-viewer",
      reason: "offboard"
    });
    await client.createApiToken({
      projectId: "project-acme-dashboard",
      name: "CI read",
      scopes: ["read"]
    });
    await client.revokeApiToken({
      projectId: "project-acme-dashboard",
      tokenId: "token_ci",
      reason: "rotate"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/team-members",
        method: "POST",
        body: expect.objectContaining({
          actor: expect.objectContaining({ id: "actor-viewer" }),
          role: "viewer"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/team-members/member-viewer",
        method: "DELETE",
        body: expect.objectContaining({
          reason: "offboard"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/api-tokens",
        method: "POST",
        body: expect.objectContaining({
          name: "CI read",
          scopes: ["read"]
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/api-tokens/token_ci",
        method: "DELETE",
        body: expect.objectContaining({
          reason: "rotate"
        })
      }
    ]);
  });

  it("uses firewall rule and Edge Config management routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "created",
          rule: {
            id: "fw_block_admin",
            projectId: "project-acme-dashboard",
            name: "Block admin",
            action: "block",
            priority: 10,
            status: "active",
            conditions: {
              pathPattern: "/admin/*"
            },
            createdAt: "2026-05-26T00:00:00.000Z",
            updatedAt: "2026-05-26T00:00:00.000Z"
          },
          message: "Firewall rule created."
        });
      }
    });

    await client.listFirewallRules("project-acme-dashboard");
    await client.createFirewallRule({
      projectId: "project-acme-dashboard",
      name: "Block admin",
      action: "block",
      priority: 10,
      conditions: {
        pathPattern: "/admin/*"
      }
    });
    await client.disableFirewallRule({
      projectId: "project-acme-dashboard",
      ruleId: "fw_block_admin",
      reason: "rotate"
    });
    await client.getEdgeConfig("project-acme-dashboard");
    await client.upsertEdgeConfig({
      projectId: "project-acme-dashboard",
      key: "maintenance",
      value: {
        enabled: true
      }
    });
    await client.deleteEdgeConfig({
      projectId: "project-acme-dashboard",
      key: "maintenance",
      reason: "cleanup"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules",
        method: "POST",
        body: expect.objectContaining({
          name: "Block admin",
          action: "block",
          conditions: {
            pathPattern: "/admin/*"
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/firewall-rules/fw_block_admin",
        method: "DELETE",
        body: expect.objectContaining({
          reason: "rotate"
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config/maintenance",
        method: "PUT",
        body: expect.objectContaining({
          value: {
            enabled: true
          }
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/edge-config/maintenance",
        method: "DELETE",
        body: expect.objectContaining({
          reason: "cleanup"
        })
      }
    ]);
  });

  it("uses blob storage routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "uploaded",
          projectId: "project-acme-dashboard",
          blobs: [],
          total: 0,
          updatedAt: "2026-05-27T00:00:00.000Z",
          blob: {
            id: "blob_fixture",
            projectId: "project-acme-dashboard",
            pathname: "assets/config/app.json",
            access: "private",
            contentType: "application/json",
            size: 16,
            sha256: "sha256:fixture",
            etag: "\"fixture\"",
            url: "/api/projects/project-acme-dashboard/blobs/assets%2Fconfig%2Fapp.json",
            uploadedAt: "2026-05-27T00:00:00.000Z",
            updatedAt: "2026-05-27T00:00:00.000Z"
          },
          contentBase64: "eyJlbmFibGVkIjp0cnVlfQ==",
          message: "Blob uploaded."
        });
      }
    });

    await client.listBlobs({
      projectId: "project-acme-dashboard",
      prefix: "assets/",
      limit: 25,
      cursor: "assets/a.txt"
    });
    await client.putBlob({
      projectId: "project-acme-dashboard",
      pathname: "assets/config/app.json",
      contentBase64: "eyJlbmFibGVkIjp0cnVlfQ==",
      contentType: "application/json",
      access: "private",
      cacheControlMaxAge: 120
    });
    await client.getBlob({
      projectId: "project-acme-dashboard",
      pathname: "assets/config/app.json"
    });
    await client.deleteBlob({
      projectId: "project-acme-dashboard",
      pathname: "assets/config/app.json",
      reason: "cleanup"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs?prefix=assets%2F&limit=25&cursor=assets%2Fa.txt",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs",
        method: "POST",
        body: expect.objectContaining({
          pathname: "assets/config/app.json",
          contentBase64: "eyJlbmFibGVkIjp0cnVlfQ==",
          contentType: "application/json",
          access: "private",
          cacheControlMaxAge: 120
        })
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs/assets%2Fconfig%2Fapp.json",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/blobs/assets%2Fconfig%2Fapp.json",
        method: "DELETE",
        body: expect.objectContaining({
          pathname: "assets/config/app.json",
          reason: "cleanup"
        })
      }
    ]);
  });

  it("builds image optimization URLs", () => {
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com/",
      fetch: async () => jsonResponse({})
    });

    expect(client.imageOptimizationUrl({
      source: "/assets/hero.png",
      width: 640,
      quality: 80,
      format: "webp"
    })).toBe("https://siteflow.example.com/_siteflow/image?url=%2Fassets%2Fhero.png&w=640&q=80&format=webp");
  });

  it("uses cache inspection and purge routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          status: "purged",
          projectId: "project-acme-dashboard",
          entries: [],
          purged: [],
          total: 0,
          updatedAt: "2026-05-27T00:00:00.000Z",
          message: "Purged 0 cache entries."
        });
      }
    });

    await client.listCacheEntries({
      projectId: "project-acme-dashboard",
      tag: "marketing",
      status: "stale",
      limit: 25
    });
    await client.purgeCache({
      projectId: "project-acme-dashboard",
      path: "/pricing",
      reason: "content update"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cache?tag=marketing&status=stale&limit=25",
        method: "GET",
        body: undefined
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/cache/purge",
        method: "POST",
        body: expect.objectContaining({
          path: "/pricing",
          reason: "content update"
        })
      }
    ]);
  });

  it("uses function runtime inspection routes", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET"
        });

        return jsonResponse({
          projectId: "project-acme-dashboard",
          deploymentId: "dep_function",
          functions: [],
          total: 0,
          updatedAt: "2026-05-27T00:00:00.000Z",
          function: {
            projectId: "project-acme-dashboard",
            deploymentId: "dep_function",
            function: {
              path: "/api/revalidate",
              sourcePath: ".siteflow/functions/api/revalidate.js",
              runtime: "nodejs20.x",
              handler: "default"
            },
            limits: {
              timeoutMs: 10000,
              memoryMb: 512,
              concurrency: 50
            },
            summary: {
              invocations: 0,
              errors: 0,
              errorRate: 0,
              averageDurationMs: 0,
              p95DurationMs: 0
            }
          },
          recentInvocations: []
        });
      }
    });

    await client.listFunctions({
      projectId: "project-acme-dashboard",
      deploymentId: "dep_function"
    });
    await client.getFunctionRuntime({
      projectId: "project-acme-dashboard",
      path: "/api/revalidate",
      deploymentId: "dep_function",
      limit: 10
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/functions?deploymentId=dep_function",
        method: "GET"
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/functions/%2Fapi%2Frevalidate?deploymentId=dep_function&limit=10",
        method: "GET"
      }
    ]);
  });

  it("uses routing rule management routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        return jsonResponse({
          projectId: "project-acme-dashboard",
          rules: [],
          total: 0,
          updatedAt: "2026-05-27T00:00:00.000Z",
          status: "upserted",
          rule: {
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
          },
          headers: [],
          message: "Routing rule saved."
        });
      }
    });

    await client.listRoutingRules({
      projectId: "project-acme-dashboard",
      kind: "redirect",
      status: "active"
    });
    await client.upsertRoutingRule({
      projectId: "project-acme-dashboard",
      name: "Docs redirect",
      kind: "redirect",
      source: "/docs",
      destination: "/documentation",
      statusCode: 308
    });
    await client.disableRoutingRule({
      projectId: "project-acme-dashboard",
      ruleId: "route_docs",
      reason: "Moved."
    });
    await client.matchRoutingRules({
      projectId: "project-acme-dashboard",
      path: "/docs"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules?kind=redirect&status=active",
        method: "GET"
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules",
        method: "PUT",
        body: {
          projectId: "project-acme-dashboard",
          name: "Docs redirect",
          kind: "redirect",
          source: "/docs",
          destination: "/documentation",
          statusCode: 308
        }
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules/route_docs",
        method: "DELETE",
        body: {
          projectId: "project-acme-dashboard",
          ruleId: "route_docs",
          reason: "Moved."
        }
      },
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules/match?path=%2Fdocs",
        method: "GET"
      }
    ]);
  });

  it("uses deploy hook management and trigger routes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async (input, init) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body.toString()) : undefined
        });

        if (input.toString().endsWith("/deploy-hooks/sfh_test_token/trigger")) {
          return jsonResponse({
            status: "accepted",
            hook: {
              id: "hook_preview",
              projectId: "project-acme-dashboard",
              name: "CMS rebuild",
              branch: "main",
              targetEnvironment: "preview",
              tokenPrefix: "sfh_test_tok",
              status: "active",
              createdAt: "2026-05-25T00:00:00.000Z",
              updatedAt: "2026-05-25T00:01:00.000Z",
              lastTriggeredAt: "2026-05-25T00:01:00.000Z"
            },
            sourceEvent: {
              id: "src_hook",
              projectId: "project-acme-dashboard",
              kind: "manual",
              status: "accepted",
              disposition: "build_requested",
              providerDeliveryId: "cms-42",
              branch: "main",
              commitSha: "4f3a9c2d1b0e",
              commitMessage: "CMS published",
              commitAuthor: "CMS",
              receivedAt: "2026-05-25T00:01:00.000Z",
              actor: { id: "deploy-hook:hook_preview", name: "CMS rebuild", role: "system" }
            },
            buildJobId: "build_hook",
            message: "Deploy hook accepted and build job queued."
          });
        }

        return jsonResponse({
          status: "created",
          hook: {
            id: "hook_preview",
            projectId: "project-acme-dashboard",
            name: "CMS rebuild",
            branch: "main",
            targetEnvironment: "preview",
            tokenPrefix: "sfh_test_tok",
            status: "active",
            createdAt: "2026-05-25T00:00:00.000Z",
            updatedAt: "2026-05-25T00:00:00.000Z"
          },
          token: "sfh_test_token",
          hookUrl: "https://siteflow.example.com/api/deploy-hooks/sfh_test_token/trigger",
          message: "Deploy hook created."
        });
      }
    });

    await client.createDeployHook({
      projectId: "project-acme-dashboard",
      name: "CMS rebuild",
      branch: "main",
      targetEnvironment: "preview"
    });
    await client.triggerDeployHook({
      token: "sfh_test_token",
      branch: "main",
      commitSha: "4f3a9c2d1b0e",
      idempotencyKey: "cms-42"
    });

    expect(requests).toEqual([
      {
        url: "https://siteflow.example.com/api/projects/project-acme-dashboard/deploy-hooks",
        method: "POST",
        body: expect.objectContaining({
          projectId: "project-acme-dashboard",
          name: "CMS rebuild",
          targetEnvironment: "preview"
        })
      },
      {
        url: "https://siteflow.example.com/api/deploy-hooks/sfh_test_token/trigger",
        method: "POST",
        body: expect.objectContaining({
          branch: "main",
          commitSha: "4f3a9c2d1b0e",
          idempotencyKey: "cms-42"
        })
      }
    ]);
    expect(requests[1].body).not.toMatchObject({
      token: expect.any(String)
    });
  });

  it("throws a typed error with the API message", async () => {
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async () => jsonResponse({ message: "Project not found." }, { status: 404, statusText: "Not Found" })
    });

    await expect(client.getProject("missing")).rejects.toMatchObject({
      name: "SiteFlowHttpError",
      status: 404,
      message: "Project not found."
    });
  });

  it("redacts secret values from HTTP error messages while preserving status and path", async () => {
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async () => jsonResponse(
        { message: `Unauthorized Bearer ${SITEFLOW_SECRET_CANARY}` },
        { status: 401, statusText: "Unauthorized" }
      )
    });

    await expect(client.getProject("secret-project")).rejects.toMatchObject({
      name: "SiteFlowHttpError",
      status: 401,
      path: "/api/projects/secret-project",
      isUnauthorized: true,
      isForbidden: false,
      message: `Unauthorized Bearer ${REDACTION_PLACEHOLDER}`
    });
  });

  it("marks forbidden HTTP errors as identifiable", async () => {
    const client = new HttpSiteFlowClient({
      baseUrl: "https://siteflow.example.com",
      fetch: async () => jsonResponse({ error: "Operator token is missing required scope." }, { status: 403, statusText: "Forbidden" })
    });

    await expect(client.listProjects()).rejects.toMatchObject({
      name: "SiteFlowHttpError",
      status: 403,
      isUnauthorized: false,
      isForbidden: true,
      message: "Operator token is missing required scope."
    });
  });
});
