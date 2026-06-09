import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectOperatorAccessEvidence,
  parseOperatorAccessEvidenceCollectArgs,
  runOperatorAccessEvidenceCollectCli,
  type OperatorAccessEvidenceFetch
} from "./operatorAccessEvidenceCollect";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const adminToken = "admin-token-0123456789abcdef";
const lowScopeToken = "read-token-0123456789abcdef";

function headers(setCookie?: string) {
  return {
    get: (name: string) => (name.toLowerCase() === "set-cookie" ? setCookie ?? null : null)
  };
}

function jsonResponse(status: number, body: Record<string, unknown> = {}, setCookie?: string) {
  return {
    status,
    headers: headers(setCookie),
    json: async () => body
  };
}

function bearer(init?: { headers?: Record<string, string> }) {
  const header = init?.headers?.authorization ?? "";

  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function cookieSecret(init?: { headers?: Record<string, string> }) {
  const header = init?.headers?.cookie ?? "";
  const match = header.match(/(?:^|;\s*)siteflow_session=([^;]+)/);

  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function setCookie(secret: string, maxAge = 900) {
  return `siteflow_session=${encodeURIComponent(secret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearedCookie() {
  return "siteflow_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}

function makeFetch(options: { actorSpoofReturned?: boolean; cleanupStatus?: number } = {}) {
  const calls: Array<{ input: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const sessions = new Map<string, { scopes: string[]; projectIds?: string[]; actor: { id: string; name: string; role: "operator" } }>();
  let sessionId = 0;
  let cutoffId = 0;
  const createSession = (scopes: string[], projectIds?: string[]) => {
    sessionId += 1;
    const secret = `sfs_unit_session_${sessionId}`;
    sessions.set(secret, {
      scopes,
      projectIds,
      actor: {
        id: `operator-session-${sessionId}`,
        name: "Release operator session",
        role: "operator"
      }
    });

    return secret;
  };
  const canUseSession = (secret: string | undefined, permission: string, projectId?: string) => {
    if (!secret) {
      return "missing";
    }

    const session = sessions.get(secret);

    if (!session) {
      return "invalid";
    }

    if (session.projectIds && (!projectId || !session.projectIds.includes(projectId))) {
      return "forbidden";
    }

    if (permission === "read" && session.scopes.includes("read")) {
      return "allowed";
    }

    if (permission === "admin" && session.scopes.includes("admin")) {
      return "allowed";
    }

    return "forbidden";
  };
  const sessionActor = (secret: string | undefined) => secret ? sessions.get(secret)?.actor : undefined;
  const fetchImpl: OperatorAccessEvidenceFetch = async (input, init) => {
    calls.push({ input, init });
    const url = new URL(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.pathname === "/api/auth/session") {
      if (bearer(init) !== adminToken) {
        return jsonResponse(403, { message: "admin token required" });
      }

      const body = init?.body ? JSON.parse(init.body) as { scopes?: string[]; projectIds?: string[]; ttlSeconds?: number } : {};
      const secret = createSession(body.scopes ?? ["read"], body.projectIds);

      return jsonResponse(
        201,
        {
          status: "created",
          session: {
            subject: "operator",
            tokenPrefix: secret.slice(0, 12),
            scopes: body.scopes,
            status: "active"
          },
          message: "Operator session created."
        },
        setCookie(secret, body.ttlSeconds ?? 900)
      );
    }

    if (method === "GET" && url.pathname === "/api/projects") {
      const decision = canUseSession(cookieSecret(init), "read");

      if (decision === "allowed") {
        return jsonResponse(200, { projects: [] });
      }

      return jsonResponse(decision === "invalid" ? 401 : 403, { message: "project list denied" });
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);

    if (method === "GET" && projectMatch) {
      const decision = canUseSession(cookieSecret(init), "read", decodeURIComponent(projectMatch[1]));

      if (decision === "allowed") {
        return jsonResponse(200, { project: { id: decodeURIComponent(projectMatch[1]) } });
      }

      return jsonResponse(decision === "invalid" ? 401 : 403, { message: "project denied" });
    }

    if (method === "POST" && url.pathname === "/api/auth/session/rotate") {
      if (init?.headers?.["x-siteflow-csrf"] !== "same-origin") {
        return jsonResponse(403, { message: "SiteFlow operator session writes require a same-origin CSRF header." });
      }

      const oldSecret = cookieSecret(init);
      const session = oldSecret ? sessions.get(oldSecret) : undefined;

      if (!oldSecret || !session) {
        return jsonResponse(401, { message: "SiteFlow operator session is invalid or expired." }, clearedCookie());
      }

      sessions.delete(oldSecret);
      const newSecret = createSession(session.scopes, session.projectIds);

      return jsonResponse(
        200,
        {
          status: "rotated",
          session: {
            tokenPrefix: newSecret.slice(0, 12),
            scopes: session.scopes,
            status: "active"
          },
          message: "Operator session rotated."
        },
        setCookie(newSecret)
      );
    }

    if (method === "DELETE" && url.pathname === "/api/auth/session") {
      if (init?.headers?.["x-siteflow-csrf"] !== "same-origin") {
        return jsonResponse(403, { message: "SiteFlow operator session writes require a same-origin CSRF header." });
      }

      const secret = cookieSecret(init);

      if (!secret || !sessions.has(secret)) {
        return jsonResponse(401, { message: "SiteFlow operator session is invalid or expired." }, clearedCookie());
      }

      sessions.delete(secret);

      return jsonResponse(200, { status: "revoked", message: "Operator session revoked." }, clearedCookie());
    }

    const routingRuleMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/routing-rules$/);

    if (method === "PUT" && routingRuleMatch) {
      if (bearer(init) === lowScopeToken) {
        return jsonResponse(403, { message: "SiteFlow API token does not include admin permission." });
      }

      if (init?.headers?.["x-siteflow-csrf"] !== "same-origin") {
        return jsonResponse(403, { message: "SiteFlow operator session writes require a same-origin CSRF header." });
      }

      const secret = cookieSecret(init);
      const decision = canUseSession(secret, "admin", decodeURIComponent(routingRuleMatch[1]));

      if (decision !== "allowed") {
        return jsonResponse(decision === "invalid" ? 401 : 403, { message: "routing rule denied" });
      }

      const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
      const spoofedActor = body.actor as Record<string, unknown> | undefined;
      const actor = options.actorSpoofReturned
        ? {
            id: String(spoofedActor?.id ?? "client-spoofed-actor"),
            name: String(spoofedActor?.name ?? "Client spoofed actor"),
            role: "system"
          }
        : sessionActor(secret);

      return jsonResponse(200, {
        status: "upserted",
        rule: {
          id: "route_operator_actor_probe",
          projectId: decodeURIComponent(routingRuleMatch[1]),
          name: body.name,
          kind: body.kind,
          source: body.source,
          destination: body.destination,
          statusCode: body.statusCode,
          priority: body.priority,
          status: "active",
          createdBy: actor,
          updatedBy: actor
        }
      });
    }

    const routingRuleDeleteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/routing-rules\/([^/]+)$/);

    if (method === "DELETE" && routingRuleDeleteMatch) {
      if (init?.headers?.["x-siteflow-csrf"] !== "same-origin") {
        return jsonResponse(403, { message: "SiteFlow operator session writes require a same-origin CSRF header." });
      }

      const secret = cookieSecret(init);
      const decision = canUseSession(secret, "admin", decodeURIComponent(routingRuleDeleteMatch[1]));

      if (decision !== "allowed") {
        return jsonResponse(decision === "invalid" ? 401 : 403, { message: "routing rule cleanup denied" });
      }

      const status = options.cleanupStatus ?? 200;

      return jsonResponse(status, {
        status: status === 200 ? "disabled" : "blocked",
        rule: {
          id: decodeURIComponent(routingRuleDeleteMatch[2]),
          projectId: decodeURIComponent(routingRuleDeleteMatch[1]),
          status: status === 200 ? "disabled" : "active",
          updatedBy: sessionActor(secret)
        }
      });
    }

    if (method === "POST" && url.pathname === "/api/auth/sessions/revoke-all") {
      const token = bearer(init);

      if (!token) {
        return jsonResponse(401, { message: "SiteFlow API token is required." });
      }

      if (token === lowScopeToken) {
        return jsonResponse(403, { message: "SiteFlow API token does not include admin permission." });
      }

      cutoffId += 1;
      sessions.clear();

      return jsonResponse(200, {
        status: "revoked",
        scope: "global",
        cutoffId: `sessioncutoff_${cutoffId}`,
        revokedAt: "2026-06-08T12:00:01.000Z",
        revokedCount: 1
      });
    }

    const projectCutoffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/auth\/sessions\/revoke-all$/);

    if (method === "POST" && projectCutoffMatch) {
      if (bearer(init) !== adminToken) {
        return jsonResponse(403, { message: "SiteFlow API token does not include admin permission." });
      }

      const projectId = decodeURIComponent(projectCutoffMatch[1]);

      cutoffId += 1;
      for (const [secret, session] of sessions) {
        if (session.projectIds?.includes(projectId)) {
          sessions.delete(secret);
        }
      }

      return jsonResponse(200, {
        status: "revoked",
        scope: "project",
        projectId,
        cutoffId: `sessioncutoff_${cutoffId}`,
        revokedAt: "2026-06-08T12:00:02.000Z",
        revokedCount: 1
      });
    }

    if (method === "GET" && url.pathname === "/api/auth/verify") {
      return jsonResponse(canUseSession(cookieSecret(init), "read") === "allowed" ? 200 : 401, { authenticated: true });
    }

    return jsonResponse(404, { message: "not found" });
  };

  return { fetchImpl, calls };
}

function baseOptions(overrides: Partial<Parameters<typeof collectOperatorAccessEvidence>[0]> = {}) {
  return {
    baseUrl: "https://siteflow.example.com",
    commitRef: "abc123def4567890",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvironment: "production",
    operatorName: "Platform Operator",
    ticketId: "REL-2026-0608",
    projectId: "project-acme-dashboard",
    deniedProjectId: "project-other",
    env: {
      SITEFLOW_API_TOKEN: adminToken,
      SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN: lowScopeToken
    },
    fetchImpl: makeFetch().fetchImpl,
    executeProjectCutoff: true,
    executeGlobalCutoff: true,
    confirmGlobalCutoff: true,
    browserTokenFallbackDisabled: true,
    localStorageFallbackDisabled: true,
    now,
    ...overrides
  };
}

describe("operatorAccessEvidenceCollect", () => {
  it("collects operator session access evidence and writes checker output without raw tokens or cookies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-operator-access-collect-"));
    const { fetchImpl, calls } = makeFetch();

    try {
      const outputPath = path.join(root, "operator-access-evidence-raw.json");
      const checkOutputPath = path.join(root, "operator-access-evidence.json");
      const result = await collectOperatorAccessEvidence(baseOptions({
        fetchImpl,
        outputPath,
        checkOutputPath
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));
      const serialized = JSON.stringify({ result, raw, check });

      expect(result.status).toBe("collected");
      expect(result.exitCode).toBe(0);
      expect(raw).toMatchObject({
        schemaVersion: "siteflow.operatorAccessEvidence.v1",
        name: "siteflow-operator-access-evidence",
        status: "passed",
        dryRun: false,
        template: false,
        environment: "production",
        publicBaseUrl: "https://siteflow.example.com",
        sessionCreate: {
          status: "passed",
          statusCode: 201,
          verifyStatusCode: 200,
          cookieHttpOnly: true,
          cookieSecure: true,
          cookieSameSite: "Lax",
          cookiePath: "/",
          secretReturnedInJson: false
        },
        projectScope: {
          status: "passed",
          allowedProjectStatusCode: 200,
          deniedProjectStatusCode: 403,
          deniedGlobalStatusCode: 403
        },
        sessionRotation: {
          status: "passed",
          statusCode: 200,
          newCookieStatusCode: 200,
          oldCookieStatusCode: 401,
          missingCsrfStatusCode: 403
        },
        sessionRevoke: {
          status: "revoked",
          statusCode: 200,
          cookieCleared: true,
          oldCookieStatusCode: 401
        },
        csrf: {
          status: "enforced",
          missingHeaderStatusCode: 403,
          sameOriginHeaderStatusCode: 200
        },
        bearerPrecedence: {
          status: "passed",
          lowScopeBearerWithAdminCookieStatusCode: 403,
          fallbackToCookie: false
        },
        actorAttribution: {
          status: "passed",
          bodyActorIgnored: true,
          clientActorSpoofIgnored: true,
          serverActorRecorded: true,
          serverDerivedActorForCookieSessionWrites: true,
          source: "routing_rule_cookie_session_probe",
          ruleId: "route_operator_actor_probe",
          upsertStatusCode: 200,
          cleanupStatusCode: 200,
          cleanupCompleted: true
        },
        browserTokenFallback: {
          status: "passed",
          productionFallbackEnabled: false,
          browserTokenFallbackDisabled: true,
          localStorageFallbackDisabled: true,
          localStorageIgnored: true,
          sessionStorageFallbackObserved: true,
          getAuthTokenGatedByFallbackFlag: true,
          runtimeConfigProductionDefaultOff: true,
          source: "client_factory_static_probe"
        },
        emergencyCutoff: {
          status: "passed",
          global: expect.objectContaining({
            status: "passed",
            statusCode: 200,
            scope: "global",
            oldCookieStatusCode: 401
          }),
          project: expect.objectContaining({
            status: "passed",
            statusCode: 200,
            scope: "project",
            projectId: "project-acme-dashboard"
          }),
          cookieOnly: {
            statusCode: 401
          },
          lowScopeBearer: {
            statusCode: 403,
            fallbackToCookie: false
          }
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-operator-access-evidence-check",
        status: "passed",
        exitCode: 0
      });
      expect(calls.some((call) => call.input === "https://siteflow.example.com/api/auth/session")).toBe(true);
      expect(calls.some((call) =>
        call.input === "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules" &&
          call.init?.method === "PUT" &&
          call.init?.headers?.cookie
      )).toBe(true);
      expect(calls.some((call) =>
        call.input === "https://siteflow.example.com/api/projects/project-acme-dashboard/routing-rules/route_operator_actor_probe" &&
          call.init?.method === "DELETE" &&
          call.init?.headers?.cookie
      )).toBe(true);
      expect(serialized).not.toContain(adminToken);
      expect(serialized).not.toContain(lowScopeToken);
      expect(serialized).not.toContain("sfs_unit_session_");
      expect(serialized).not.toContain("authorization\":\"Bearer");
      expect(serialized).not.toContain("Set-Cookie");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects browser fallback posture without operator-supplied fallback flags", async () => {
    const { fetchImpl } = makeFetch();
    const result = await collectOperatorAccessEvidence(baseOptions({
      fetchImpl,
      browserTokenFallbackDisabled: false,
      localStorageFallbackDisabled: false
    }));

    expect(result.status).toBe("collected");
    expect(result.exitCode).toBe(0);
    expect(result.evidence?.browserTokenFallback).toMatchObject({
      status: "passed",
      productionFallbackEnabled: false,
      browserTokenFallbackDisabled: true,
      localStorageFallbackDisabled: true,
      localStorageIgnored: true,
      source: "client_factory_static_probe",
      browserFallbackSource: "runtime_config_production_default_off"
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_collected", status: "pass" })
      ])
    );
  });

  it("blocks when the target env explicitly enables browser token fallback", async () => {
    const { fetchImpl } = makeFetch();
    const result = await collectOperatorAccessEvidence(baseOptions({
      fetchImpl,
      browserTokenFallbackDisabled: false,
      localStorageFallbackDisabled: false,
      env: {
        SITEFLOW_API_TOKEN: adminToken,
        SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN: lowScopeToken,
        VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK: "1"
      }
    }));

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.evidence?.browserTokenFallback).toMatchObject({
      status: "blocked",
      productionFallbackEnabled: true,
      browserTokenFallbackDisabled: false,
      localStorageFallbackDisabled: true,
      localStorageIgnored: true,
      browserFallbackSource: "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK"
    });
    expect(result.checkResult?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_posture", status: "fail" }),
        expect.objectContaining({ name: "browser_token_fallback_local_storage_disabled", status: "pass" })
      ])
    );
  });

  it("blocks without destructive cutoff confirmation", async () => {
    const { fetchImpl } = makeFetch();
    const result = await collectOperatorAccessEvidence(baseOptions({
      fetchImpl,
      executeProjectCutoff: false,
      executeGlobalCutoff: false,
      confirmGlobalCutoff: false,
      browserTokenFallbackDisabled: false,
      localStorageFallbackDisabled: false
    }));

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "actor_attribution_collected", status: "pass" }),
        expect.objectContaining({ name: "emergency_cutoff_collected", status: "fail" }),
        expect.objectContaining({ name: "operator_access_evidence_check", status: "fail" })
      ])
    );
    expect(result.checkResult?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "actor_attribution_enforced", status: "pass" }),
        expect.objectContaining({ name: "emergency_cutoff_global", status: "fail" })
      ])
    );
    expect(result.checkResult?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_posture", status: "pass" }),
        expect.objectContaining({ name: "browser_token_fallback_local_storage_disabled", status: "pass" })
      ])
    );
  });

  it("blocks when the actor attribution probe returns the spoofed client actor", async () => {
    const { fetchImpl } = makeFetch({ actorSpoofReturned: true });
    const result = await collectOperatorAccessEvidence(baseOptions({
      fetchImpl
    }));

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.evidence?.actorAttribution).toMatchObject({
      status: "blocked",
      bodyActorIgnored: false,
      clientActorSpoofIgnored: false,
      serverActorRecorded: true,
      cleanupCompleted: true,
      serverActorId: "client-spoofed-actor"
    });
    expect(result.checkResult?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "actor_attribution_enforced", status: "fail" })
      ])
    );
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "actor_attribution_collected", status: "fail" })
      ])
    );
  });

  it("blocks when the actor attribution probe cannot clean up its temporary routing rule", async () => {
    const { fetchImpl } = makeFetch({ cleanupStatus: 500 });
    const result = await collectOperatorAccessEvidence(baseOptions({
      fetchImpl
    }));

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.evidence?.actorAttribution).toMatchObject({
      status: "blocked",
      bodyActorIgnored: true,
      serverActorRecorded: true,
      cleanupStatusCode: 500,
      cleanupCompleted: false
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "actor_attribution_collected", status: "fail" })
      ])
    );
  });

  it("runs the CLI and prints collected evidence without leaking auth material", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-operator-access-cli-"));
    const { fetchImpl } = makeFetch();
    let stdout = "";
    let stderr = "";

    try {
      const outputPath = path.join(root, "operator-access-evidence-raw.json");
      const checkOutputPath = path.join(root, "operator-access-evidence.json");
      const exitCode = await runOperatorAccessEvidenceCollectCli(
        [
          "--base-url", "https://siteflow.example.com",
          "--commit-ref", "abc123def4567890",
          "--repo", "acme/siteflow",
          "--branch", "main",
          "--target-environment", "production",
          "--operator-name", "Platform Operator",
          "--release-ticket", "REL-2026-0608",
          "--project-id", "project-acme-dashboard",
          "--denied-project-id", "project-other",
          "--execute-project-cutoff",
          "--execute-global-cutoff",
          "--i-understand-this-revokes-active-operator-sessions",
          "--browser-token-fallback-disabled",
          "--local-storage-fallback-disabled",
          "--output", outputPath,
          "--check-output", checkOutputPath,
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          env: {
            SITEFLOW_API_TOKEN: adminToken,
            SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN: lowScopeToken
          },
          fetchImpl,
          now
        }
      );
      const printed = JSON.parse(stdout);
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toEqual(raw);
      expect(check).toMatchObject({
        status: "passed",
        exitCode: 0
      });
      expect(stdout).not.toContain(adminToken);
      expect(stdout).not.toContain(lowScopeToken);
      expect(stdout).not.toContain("siteflow_session=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns usage errors for unsafe URLs and global cutoff without confirmation", () => {
    const validArgs = [
      "--base-url", "https://siteflow.example.com",
      "--commit-ref", "abc123def4567890",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608",
      "--project-id", "project-acme-dashboard",
      "--denied-project-id", "project-other"
    ];

    expect(parseOperatorAccessEvidenceCollectArgs(validArgs)).toMatchObject({
      baseUrl: "https://siteflow.example.com",
      projectId: "project-acme-dashboard"
    });
    expect(() => parseOperatorAccessEvidenceCollectArgs([])).toThrow("--base-url <url> is required");
    expect(() => parseOperatorAccessEvidenceCollectArgs([
      ...validArgs.slice(0, 1),
      "http://siteflow.example.com",
      ...validArgs.slice(2)
    ])).toThrow("--base-url must use https");
    expect(() => parseOperatorAccessEvidenceCollectArgs([
      ...validArgs,
      "--execute-global-cutoff"
    ])).toThrow("--execute-global-cutoff requires --i-understand-this-revokes-active-operator-sessions");
  });
});
