import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateOperatorAccessEvidence,
  runOperatorAccessEvidenceCheckCli
} from "./operatorAccessEvidenceCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.operatorAccessEvidence.v1",
    name: "siteflow-operator-access-evidence",
    status: "passed",
    dryRun: false,
    checkedAt: "2026-06-08T11:30:00.000Z",
    environment: "production",
    publicBaseUrl: "https://siteflow.example.com",
    release: {
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main"
    },
    sessionCreate: {
      status: "passed",
      checkedAt: "2026-06-08T11:31:00.000Z",
      statusCode: 201,
      cookieHttpOnly: true,
      cookieSecure: true,
      cookieSameSite: "Lax",
      cookiePath: "/",
      secretReturnedInJson: false
    },
    sessionPolicy: {
      status: "passed",
      checkedAt: "2026-06-08T11:32:00.000Z",
      idleTimeoutSeconds: 1800,
      absoluteTtlEnforced: true,
      expiredOrRevokedSessionRejected: true
    },
    projectScope: {
      status: "passed",
      checkedAt: "2026-06-08T11:33:00.000Z",
      allowedProjectStatusCode: 200,
      deniedProjectStatusCode: 403,
      deniedGlobalStatusCode: 403
    },
    sessionRotation: {
      status: "passed",
      checkedAt: "2026-06-08T11:33:30.000Z",
      statusCode: 200,
      newCookieStatusCode: 200,
      oldCookieStatusCode: 401,
      missingCsrfStatusCode: 403,
      cookieHttpOnly: true,
      cookieSecure: true,
      cookieSameSite: "Lax",
      cookiePath: "/",
      secretReturnedInJson: false
    },
    sessionRevoke: {
      status: "revoked",
      checkedAt: "2026-06-08T11:34:00.000Z",
      statusCode: 200,
      cookieCleared: true,
      oldCookieStatusCode: 401
    },
    csrf: {
      status: "enforced",
      checkedAt: "2026-06-08T11:35:00.000Z",
      missingHeaderStatusCode: 403,
      sameOriginHeaderStatusCode: 201
    },
    bearerPrecedence: {
      status: "passed",
      checkedAt: "2026-06-08T11:36:00.000Z",
      lowScopeBearerWithAdminCookieStatusCode: 403,
      fallbackToCookie: false
    },
    actorAttribution: {
      status: "passed",
      checkedAt: "2026-06-08T11:37:00.000Z",
      bodyActorIgnored: true,
      serverActorRecorded: true
    },
    browserTokenFallback: {
      status: "passed",
      checkedAt: "2026-06-08T11:37:30.000Z",
      productionFallbackEnabled: false,
      viteSiteflowAllowBrowserTokenFallback: false,
      explicitTransitionException: false,
      localStorageFallbackDisabled: true
    },
    emergencyCutoff: {
      status: "passed",
      checkedAt: "2026-06-08T11:38:00.000Z",
      global: {
        status: "revoked",
        statusCode: 200,
        scope: "global",
        cutoffId: "sessioncutoff_global",
        revokedAt: "2026-06-08T11:38:10.000Z",
        revokedCount: 2,
        oldCookieStatusCode: 401
      },
      project: {
        status: "revoked",
        statusCode: 200,
        scope: "project",
        projectId: "project-acme-dashboard",
        cutoffId: "sessioncutoff_project",
        revokedAt: "2026-06-08T11:38:20.000Z",
        revokedCount: 1
      },
      cookieOnly: {
        statusCode: 401
      },
      lowScopeBearer: {
        statusCode: 403,
        fallbackToCookie: false
      }
    },
    negativeEvidence: {
      noRawBearerTokensStored: true,
      noRawSessionSecretsStored: true,
      noAuthorizationHeadersStored: true,
      notClaimingLoginIdpMfa: true,
      credentialedCorsNotExposedAsReady: true,
      nonSessionCredentialRotationOutOfScope: true
    },
    operatorName: "Platform Operator",
    ticketId: "CHG-123",
    ...overrides
  };
}

describe("operatorAccessEvidenceCheck", () => {
  it("passes complete operator access evidence", () => {
    const result = evaluateOperatorAccessEvidence(validEvidence(), {
      evidencePath: "operator-access-evidence.json",
      commitRef: "abc123",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(result.selectedEvidence).toMatchObject({
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main",
      sessionRotation: {
        status: "passed",
        timestamp: "2026-06-08T11:33:30.000Z"
      },
      browserTokenFallback: {
        status: "passed",
        timestamp: "2026-06-08T11:37:30.000Z"
      }
    });
  });

  it("blocks release identity mismatch and stale evidence", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        checkedAt: "2026-06-01T11:30:00.000Z"
      }),
      {
        evidencePath: "operator-access-evidence.json",
        commitRef: "different",
        repo: "acme/siteflow",
        branch: "main",
        maxAgeHours: 24,
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "evidence_age", status: "fail" }),
        expect.objectContaining({ name: "release_identity", status: "fail" })
      ])
    );
  });

  it("blocks template evidence explicitly", () => {
    const result = evaluateOperatorAccessEvidence(validEvidence({ template: true }), {
      evidencePath: "operator-access-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "not_template", status: "fail" })
      ])
    );
  });

  it("requires final passed status", () => {
    const result = evaluateOperatorAccessEvidence(validEvidence({ status: "verified" }), {
      evidencePath: "operator-access-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "status_final", status: "fail" })
      ])
    );
  });

  it("blocks evidence from a different target environment", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        environment: "staging"
      }),
      {
        evidencePath: "operator-access-evidence.json",
        targetEnvironment: "production",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "environment", status: "fail" })
      ])
    );
  });

  it("blocks missing secure cookie and raw secret hygiene evidence", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        sessionCreate: {
          status: "passed",
          checkedAt: "2026-06-08T11:31:00.000Z",
          statusCode: 201,
          cookieHttpOnly: true,
          cookieSecure: false,
          cookieSameSite: "Lax",
          cookiePath: "/",
          secretReturnedInJson: true
        },
        negativeEvidence: {
          noRawBearerTokensStored: true,
          noRawSessionSecretsStored: false,
          noAuthorizationHeadersStored: true,
          notClaimingLoginIdpMfa: true,
          credentialedCorsNotExposedAsReady: true,
          nonSessionCredentialRotationOutOfScope: true
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "session_cookie_flags", status: "fail" }),
        expect.objectContaining({ name: "session_secret_not_returned", status: "fail" }),
        expect.objectContaining({ name: "no_raw_secrets_stored", status: "fail" })
      ])
    );
  });

  it("blocks raw secret-like values even when negative evidence flags claim safety", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        sessionCreate: {
          ...(validEvidence().sessionCreate as Record<string, unknown>),
          response: {
            rawSecretReturnedInJson: false,
            authorization: "Bearer abcdefghijklmnop"
          }
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "no_raw_secrets_stored", status: "pass" }),
        expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
      ])
    );
    expect(serialized).not.toContain("abcdefghijklmnop");
  });

  it("blocks project scope, csrf, and actor attribution regressions", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        projectScope: {
          status: "passed",
          checkedAt: "2026-06-08T11:33:00.000Z",
          allowedProjectStatusCode: 200,
          deniedProjectStatusCode: 200,
          deniedGlobalStatusCode: 403
        },
        csrf: {
          status: "enforced",
          checkedAt: "2026-06-08T11:35:00.000Z",
          missingHeaderStatusCode: 200,
          sameOriginHeaderStatusCode: 201
        },
        actorAttribution: {
          status: "passed",
          checkedAt: "2026-06-08T11:37:00.000Z",
          bodyActorIgnored: false,
          serverActorRecorded: true
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "project_scope_enforced", status: "fail" }),
        expect.objectContaining({ name: "csrf_enforced", status: "fail" }),
        expect.objectContaining({ name: "actor_attribution_enforced", status: "fail" })
      ])
    );
  });

  it("blocks operator session rotation regressions", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        sessionRotation: {
          status: "passed",
          checkedAt: "2026-06-08T11:33:30.000Z",
          statusCode: 200,
          newCookieStatusCode: 200,
          oldCookieStatusCode: 200,
          missingCsrfStatusCode: 200,
          cookieHttpOnly: true,
          cookieSecure: false,
          cookieSameSite: "Lax",
          cookiePath: "/",
          secretReturnedInJson: true
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "session_rotation_cookie_flags", status: "fail" }),
        expect.objectContaining({ name: "session_rotation_secret_not_returned", status: "fail" }),
        expect.objectContaining({ name: "session_rotation_csrf_enforced", status: "fail" }),
        expect.objectContaining({ name: "session_rotation_old_cookie_rejected", status: "fail" })
      ])
    );
  });

  it("blocks revoke-all paths that are not bearer-only", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        emergencyCutoff: {
          status: "passed",
          checkedAt: "2026-06-08T11:38:00.000Z",
          global: {
            status: "revoked",
            statusCode: 200,
            scope: "global",
            cutoffId: "sessioncutoff_global",
            revokedAt: "2026-06-08T11:38:10.000Z",
            oldCookieStatusCode: 200
          },
          project: {
            status: "revoked",
            statusCode: 200,
            scope: "global",
            projectId: "project-acme-dashboard",
            cutoffId: "sessioncutoff_project",
            revokedAt: "2026-06-08T11:38:20.000Z"
          },
          cookieOnly: {
            statusCode: 200
          },
          lowScopeBearer: {
            statusCode: 200,
            fallbackToCookie: true
          }
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "emergency_cutoff_project", status: "fail" }),
        expect.objectContaining({ name: "emergency_cutoff_cookie_only_rejected", status: "fail" }),
        expect.objectContaining({ name: "emergency_cutoff_low_scope_bearer", status: "fail" }),
        expect.objectContaining({ name: "emergency_cutoff_old_cookie_rejected", status: "fail" })
      ])
    );
  });

  it("blocks missing browser token fallback posture evidence", () => {
    const evidence = validEvidence();
    delete (evidence as Record<string, unknown>).browserTokenFallback;

    const result = evaluateOperatorAccessEvidence(evidence, {
      evidencePath: "operator-access-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_present", status: "fail" }),
        expect.objectContaining({ name: "browser_token_fallback_posture", status: "fail" }),
        expect.objectContaining({ name: "browser_token_fallback_local_storage_disabled", status: "fail" })
      ])
    );
  });

  it("blocks production browser token fallback unless disabled or explicitly excepted", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        browserTokenFallback: {
          status: "passed",
          checkedAt: "2026-06-08T11:37:30.000Z",
          productionFallbackEnabled: true,
          viteSiteflowAllowBrowserTokenFallback: true,
          explicitTransitionException: false,
          localStorageFallbackDisabled: true
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_posture", status: "fail" }),
        expect.objectContaining({ name: "browser_token_fallback_exception_documented", status: "fail" }),
        expect.objectContaining({ name: "browser_token_fallback_local_storage_disabled", status: "pass" })
      ])
    );
  });

  it("blocks browser token fallback when disabled proof conflicts with enabled aliases", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        browserTokenFallback: {
          status: "passed",
          checkedAt: "2026-06-08T11:37:30.000Z",
          productionFallbackEnabled: false,
          browserTokenFallbackEnabled: true,
          viteSiteflowAllowBrowserTokenFallback: false,
          explicitTransitionException: false,
          localStorageFallbackDisabled: true
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_posture", status: "fail" }),
        expect.objectContaining({ name: "browser_token_fallback_local_storage_disabled", status: "pass" })
      ])
    );
  });

  it("blocks localStorage fallback when disabled proof conflicts with enabled aliases", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        browserTokenFallback: {
          status: "passed",
          checkedAt: "2026-06-08T11:37:30.000Z",
          productionFallbackEnabled: false,
          viteSiteflowAllowBrowserTokenFallback: false,
          explicitTransitionException: false,
          localStorageFallbackDisabled: true,
          localStorageFallbackEnabled: true
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_posture", status: "pass" }),
        expect.objectContaining({ name: "browser_token_fallback_local_storage_disabled", status: "fail" })
      ])
    );
  });

  it("documents transition exceptions but blocks enabled browser token fallback aliases", () => {
    const result = evaluateOperatorAccessEvidence(
      validEvidence({
        browserTokenFallback: {
          status: "passed",
          checkedAt: "2026-06-08T11:37:30.000Z",
          productionFallbackEnabled: true,
          viteSiteflowAllowBrowserTokenFallback: true,
          explicitTransitionException: true,
          exceptionReason: "temporary operator console transition",
          exceptionTicket: "CHG-123",
          localStorageFallbackDisabled: true
        }
      }),
      {
        evidencePath: "operator-access-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_token_fallback_posture", status: "fail" }),
        expect.objectContaining({ name: "browser_token_fallback_exception_documented", status: "pass" }),
        expect.objectContaining({ name: "browser_token_fallback_local_storage_disabled", status: "pass" })
      ])
    );
  });

  it("prints JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-operator-access-evidence-"));
    let stdout = "";
    let stderr = "";

    try {
      const checkedAt = new Date().toISOString();
      const baseEvidence = validEvidence();
      const cliEvidence = {
        ...baseEvidence,
        checkedAt,
        sessionCreate: { ...(baseEvidence.sessionCreate as Record<string, unknown>), checkedAt },
        sessionPolicy: { ...(baseEvidence.sessionPolicy as Record<string, unknown>), checkedAt },
        projectScope: { ...(baseEvidence.projectScope as Record<string, unknown>), checkedAt },
        sessionRotation: { ...(baseEvidence.sessionRotation as Record<string, unknown>), checkedAt },
        sessionRevoke: { ...(baseEvidence.sessionRevoke as Record<string, unknown>), checkedAt },
        csrf: { ...(baseEvidence.csrf as Record<string, unknown>), checkedAt },
        bearerPrecedence: { ...(baseEvidence.bearerPrecedence as Record<string, unknown>), checkedAt },
        actorAttribution: { ...(baseEvidence.actorAttribution as Record<string, unknown>), checkedAt },
        browserTokenFallback: { ...(baseEvidence.browserTokenFallback as Record<string, unknown>), checkedAt },
        emergencyCutoff: { ...(baseEvidence.emergencyCutoff as Record<string, unknown>), checkedAt }
      };
      const evidencePath = path.join(root, "operator-access.json");
      await writeFile(evidencePath, `${JSON.stringify(cliEvidence)}\n`, "utf8");

      const exitCode = await runOperatorAccessEvidenceCheckCli(
        [
          "--evidence",
          evidencePath,
          "--commit-ref",
          "abc123",
          "--repo",
          "acme/siteflow",
          "--branch",
          "main",
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
          stderr: { write: (chunk: string) => { stderr += chunk; return true; } }
        }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        name: "siteflow-operator-access-evidence-check",
        status: "passed",
        selectedEvidence: {
          commitRef: "abc123",
          repository: "acme/siteflow",
          branch: "main"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
