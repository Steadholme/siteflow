import { FixtureSiteFlowClient } from "@lib/api/fixtureClient";
import { fixtureProjectId, siteflowFixtures } from "@lib/fixtures/siteflow.fixtures";
import { siteFlowScenarioNames } from "@lib/fixtures/scenarios";
import { SITEFLOW_SECRET_CANARY } from "@lib/redaction";

const actor = {
  id: "actor-test",
  name: "Test Operator",
  role: "release_manager" as const
};

describe("FixtureSiteFlowClient", () => {
  it("exports every required deterministic scenario", () => {
    expect(Object.keys(siteflowFixtures).sort()).toEqual([...siteFlowScenarioNames].sort());
  });

  it.each(siteFlowScenarioNames)("returns a project list for %s", async (scenario) => {
    const client = new FixtureSiteFlowClient(scenario);
    const projectList = await client.listProjects();

    expect(projectList.summary.updatedAt).toBeTruthy();

    if (scenario === "emptyProjects") {
      expect(projectList.projects).toHaveLength(0);
      expect(projectList.emptyState).toMatch(/no siteflow projects/i);
    } else {
      expect(projectList.projects[0].project.id).toBe(fixtureProjectId);
    }
  });

  it("returns complete read models for project, deployment, release, rollback, logs, and operations", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const list = await client.listProjects();
    const deploymentId = list.projects[0].productionDeployment?.id;

    expect(deploymentId).toBeTruthy();

    const project = await client.getProject(fixtureProjectId);
    const deployments = await client.listDeployments(fixtureProjectId);
    const deployment = await client.getDeployment(deploymentId ?? "");
    const release = await client.getReleaseConsole(fixtureProjectId, "production");
    const rollback = await client.getRollbackConsole(fixtureProjectId, "production");
    const logs = await client.getLogChunk(deploymentId ?? "");

    const promoteResult = await client.promoteDeployment({
      projectId: fixtureProjectId,
      channel: "production",
      targetDeploymentId: release.candidateDeployment?.id ?? deploymentId ?? "",
      actor,
      reason: "Verify fixture command contract.",
      idempotencyKey: "test-promote-idem"
    });

    expect(project.channels[0].channel.name).toBe("production");
    expect(deployments.deployments.map((item) => item.id)).toContain(deploymentId);
    expect(deployment.lineage.artifact.verificationStatus).toBe("verified");
    expect(release.safetyChecks.length).toBeGreaterThan(0);
    expect(rollback.targets[0].eligible).toBe(true);
    expect(logs.chunk.lines.length).toBeGreaterThan(0);
    expect(promoteResult.status).toBe("accepted");

    const operation = await client.pollOperation(promoteResult.operationId ?? "");
    expect(operation.kind).toBe("promotion");
  });

  it("rejects release commands missing actor or audit reason", async () => {
    const client = new FixtureSiteFlowClient("healthy");

    await expect(
      client.promoteDeployment({
        projectId: fixtureProjectId,
        channel: "production",
        targetDeploymentId: "dep-healthy",
        actor,
        reason: " ",
        idempotencyKey: "bad-command"
      })
    ).rejects.toThrow(/actor and audit reason/i);
  });

  it("returns deterministic rolling release command models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const active = await client.getRollingRelease(fixtureProjectId, "production");
    const start = await client.startRollingRelease({
      projectId: fixtureProjectId,
      channel: "production",
      candidateDeploymentId: active.candidateDeployment?.id ?? active.currentDeployment?.id ?? "dep-canary",
      percentage: 10,
      actor,
      reason: "Start canary rollout.",
      idempotencyKey: "test-rollout-start"
    });
    const advance = await client.advanceRollingRelease({
      projectId: fixtureProjectId,
      channel: "production",
      percentage: 50,
      actor,
      reason: "Advance canary rollout.",
      idempotencyKey: "test-rollout-advance"
    });
    const complete = await client.completeRollingRelease({
      projectId: fixtureProjectId,
      channel: "production",
      actor,
      reason: "Complete canary rollout.",
      idempotencyKey: "test-rollout-complete"
    });

    expect(active.rollout?.status).toBe("active");
    expect(start).toMatchObject({
      status: "accepted",
      rollout: {
        percentage: 10,
        status: "active"
      }
    });
    expect(advance.rollout?.percentage).toBe(50);
    expect(complete.rollout).toMatchObject({
      percentage: 100,
      status: "completed"
    });
  });

  it("returns deterministic cron job command models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const created = await client.createCronJob({
      projectId: fixtureProjectId,
      name: "Revalidate homepage",
      path: "/api/revalidate",
      schedule: "0 * * * *",
      actor
    });
    const list = await client.listCronJobs(fixtureProjectId);
    const run = await client.runCronJob({
      projectId: fixtureProjectId,
      jobId: created.job.id,
      reason: "Manual verification.",
      idempotencyKey: "test-cron-run"
    });
    const disabled = await client.disableCronJob({
      projectId: fixtureProjectId,
      jobId: created.job.id,
      reason: "Pause verification.",
      actor
    });

    expect(created).toMatchObject({
      status: "created",
      job: {
        path: "/api/revalidate",
        schedule: "0 * * * *",
        status: "active"
      }
    });
    expect(list.jobs[0].status).toBe("active");
    expect(run.dispatch).toMatchObject({
      targetUrl: "https://dashboard.acme.test/api/revalidate",
      userAgent: "vercel-cron/1.0",
      status: "queued"
    });
    expect(disabled.job.status).toBe("disabled");
  });

  it("returns deterministic observability log queries and log drain command models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const logs = await client.queryLogs({
      projectId: fixtureProjectId,
      source: "build",
      severity: "warning",
      search: SITEFLOW_SECRET_CANARY,
      limit: 10
    });
    const savedQuery = await client.saveLogQuery({
      projectId: fixtureProjectId,
      name: "Build warnings",
      filters: {
        source: "build",
        severity: "warning"
      },
      actor
    });
    const drains = await client.listLogDrains(fixtureProjectId);
    const createdDrain = await client.createLogDrain({
      projectId: fixtureProjectId,
      name: "Observability webhook",
      url: "https://logs.example.test/siteflow",
      sources: ["build", "function"],
      minimumSeverity: "warning",
      signingSecret: SITEFLOW_SECRET_CANARY,
      actor
    });
    const delivered = await client.deliverLogDrain({
      projectId: fixtureProjectId,
      drainId: createdDrain.drain.id,
      reason: "Manual verification.",
      limit: 5
    });
    const serialized = JSON.stringify({ logs, savedQuery, drains, createdDrain, delivered });

    expect(logs.filters).toMatchObject({ source: "build", severity: "warning" });
    expect(savedQuery.query).toMatchObject({
      name: "Build warnings",
      filters: {
        source: "build",
        severity: "warning"
      }
    });
    expect(drains.drains[0].signingSecretPrefix).toBeTruthy();
    expect(createdDrain.drain.signingSecretPrefix).toBe("[REDACTED]");
    expect(delivered).toMatchObject({
      status: "delivered",
      delivery: {
        responseStatus: 202
      }
    });
    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
  });

  it("returns deterministic firewall rules and Edge Config command models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const firewallRules = await client.listFirewallRules(fixtureProjectId);
    const createdRule = await client.createFirewallRule({
      projectId: fixtureProjectId,
      name: "Challenge bots",
      action: "challenge",
      priority: 5,
      conditions: {
        pathPattern: "/api/*",
        userAgent: "curl"
      },
      actor
    });
    const disabledRule = await client.disableFirewallRule({
      projectId: fixtureProjectId,
      ruleId: createdRule.rule.id,
      reason: "Rotate firewall policy.",
      actor
    });
    const edgeConfig = await client.getEdgeConfig(fixtureProjectId);
    const upsertedEdge = await client.upsertEdgeConfig({
      projectId: fixtureProjectId,
      key: "maintenance",
      value: {
        enabled: true,
        message: SITEFLOW_SECRET_CANARY
      },
      actor
    });
    const deletedEdge = await client.deleteEdgeConfig({
      projectId: fixtureProjectId,
      key: "maintenance",
      reason: "Disable banner.",
      actor
    });
    const serialized = JSON.stringify({ firewallRules, createdRule, disabledRule, edgeConfig, upsertedEdge, deletedEdge });

    expect(firewallRules.rules[0]).toMatchObject({
      action: "block",
      conditions: {
        pathPattern: "/admin/*"
      }
    });
    expect(createdRule).toMatchObject({
      status: "created",
      rule: {
        action: "challenge",
        priority: 5,
        status: "active"
      }
    });
    expect(disabledRule.rule.status).toBe("disabled");
    expect(edgeConfig.entries[0]).toMatchObject({
      key: "maintenance",
      value: false,
      valueType: "boolean"
    });
    expect(upsertedEdge.entry).toMatchObject({
      key: "maintenance",
      valueType: "json"
    });
    expect(deletedEdge.status).toBe("deleted");
    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
  });

  it("returns deterministic blob storage command models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const blobs = await client.listBlobs({
      projectId: fixtureProjectId,
      prefix: "assets/"
    });
    const uploaded = await client.putBlob({
      projectId: fixtureProjectId,
      pathname: "assets/config/app.json",
      contentBase64: btoa(`{"secret":"${SITEFLOW_SECRET_CANARY}"}`),
      contentType: "application/json",
      access: "private",
      cacheControlMaxAge: 120,
      actor
    });
    const downloaded = await client.getBlob({
      projectId: fixtureProjectId,
      pathname: "assets/fixture.txt"
    });
    const deleted = await client.deleteBlob({
      projectId: fixtureProjectId,
      pathname: "assets/fixture.txt",
      reason: "Cleanup fixture.",
      actor
    });
    const serialized = JSON.stringify({ blobs, uploaded, downloaded, deleted });

    expect(blobs.blobs[0]).toMatchObject({
      pathname: "assets/fixture.txt",
      access: "public"
    });
    expect(uploaded).toMatchObject({
      status: "uploaded",
      blob: {
        pathname: "assets/config/app.json",
        access: "private",
        contentType: "application/json"
      }
    });
    expect(downloaded.contentBase64).toBeTruthy();
    expect(deleted).toMatchObject({
      status: "deleted",
      blob: {
        pathname: "assets/fixture.txt"
      }
    });
    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
  });

  it("builds deterministic image optimization URLs", () => {
    const client = new FixtureSiteFlowClient("healthy");

    expect(client.imageOptimizationUrl({
      source: "blob:assets/hero.png",
      width: 320,
      quality: 70,
      format: "webp"
    })).toBe("/_siteflow/image?url=blob%3Aassets%2Fhero.png&w=320&q=70&format=webp");
  });

  it("returns deterministic cache inspection and purge models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const entries = await client.listCacheEntries({
      projectId: fixtureProjectId,
      tag: "marketing"
    });
    const purged = await client.purgeCache({
      projectId: fixtureProjectId,
      path: "/pricing",
      reason: "Content changed.",
      actor
    });

    expect(entries.entries.map((entry) => entry.path)).toEqual(["/", "/pricing"]);
    expect(entries.entries[0]).toMatchObject({
      status: "fresh",
      staleWhileRevalidateSeconds: 300
    });
    expect(purged).toMatchObject({
      status: "purged",
      total: 1,
      purged: [
        expect.objectContaining({
          path: "/pricing",
          status: "purged"
        })
      ]
    });
  });

  it("returns deterministic function runtime control models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const functions = await client.listFunctions({
      projectId: fixtureProjectId
    });
    const runtime = await client.getFunctionRuntime({
      projectId: fixtureProjectId,
      path: "/api/revalidate",
      limit: 1
    });

    expect(functions.total).toBe(1);
    expect(functions.functions[0].limits).toEqual({
      timeoutMs: 10000,
      memoryMb: 512,
      concurrency: 50
    });
    expect(functions.functions[0].summary).toMatchObject({
      invocations: 2,
      errors: 1
    });
    expect(runtime.function.function).toMatchObject({
      path: "/api/revalidate",
      runtime: "nodejs20.x"
    });
    expect(runtime.recentInvocations[0]).toMatchObject({
      requestId: "req_success"
    });
  });

  it("returns deterministic routing rule models", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const list = await client.listRoutingRules({
      projectId: fixtureProjectId,
      kind: "redirect"
    });
    const upserted = await client.upsertRoutingRule({
      projectId: fixtureProjectId,
      name: "Legacy docs",
      kind: "redirect",
      source: "/legacy-docs",
      destination: "/docs",
      statusCode: 308,
      actor
    });
    const disabled = await client.disableRoutingRule({
      projectId: fixtureProjectId,
      ruleId: list.rules[0].id,
      actor,
      reason: "Moved to app config."
    });
    const match = await client.matchRoutingRules({
      projectId: fixtureProjectId,
      path: "/blog/hello"
    });

    expect(list.total).toBe(1);
    expect(list.rules[0]).toMatchObject({
      kind: "redirect",
      source: "/docs",
      destination: "/documentation"
    });
    expect(upserted).toMatchObject({
      status: "upserted",
      rule: {
        name: "Legacy docs",
        kind: "redirect",
        source: "/legacy-docs",
        destination: "/docs"
      }
    });
    expect(disabled).toMatchObject({
      status: "disabled",
      rule: {
        status: "disabled"
      }
    });
    expect(match).toMatchObject({
      rewrittenPath: "/posts/hello"
    });
    expect(match.headers[0].headers?.[0]).toEqual({
      key: "x-frame-options",
      value: "DENY"
    });
  });

  it("redacts fixture canaries before returning API data", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const projectList = await client.listProjects();
    const deployment = await client.getDeployment(projectList.projects[0].productionDeployment?.id ?? "");
    const logs = await client.getLogChunk(deployment.deployment.id);

    const serialized = JSON.stringify({
      projectList,
      deployment,
      logs
    });

    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
  });

  it("returns Vercel-style project environment metadata without secret values", async () => {
    const client = new FixtureSiteFlowClient("healthy");
    const settings = await client.getProjectSettings(fixtureProjectId);
    const envResult = await client.upsertEnvironmentVariable({
      projectId: fixtureProjectId,
      key: "SITEFLOW_TOKEN",
      value: SITEFLOW_SECRET_CANARY,
      targetEnvironment: "preview",
      scope: "build",
      actor
    });
    const serialized = JSON.stringify({ settings, envResult });

    expect(settings.environments.map((environment) => environment.name)).toEqual(["local", "preview", "production"]);
    expect(envResult.variable).toMatchObject({
      key: "SITEFLOW_TOKEN",
      targetEnvironment: "preview",
      scope: "build",
      fingerprint: "sha256:redacted"
    });
    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
  });
});
