import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateNonSessionCredentialEvidence,
  runNonSessionCredentialEvidenceCheckCli
} from "./nonSessionCredentialEvidenceCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function validCredential(overrides: Record<string, unknown> = {}) {
  return {
    type: "scoped_api_token",
    status: "passed",
    checkedAt: "2026-06-08T11:40:00.000Z",
    owner: "deploy automation",
    ticketId: "CHG-123",
    oldCredential: {
      id: "token_old",
      prefix: "sft_old",
      oldCredentialRejected: true
    },
    newCredential: {
      id: "token_new",
      prefix: "sft_new",
      scopes: ["read", "write"],
      newCredentialAccepted: true
    },
    createEvidencePresent: true,
    revokeEvidencePresent: true,
    auditEventsPresent: true,
    consumerCutoverVerified: true,
    leastPrivilegeReviewed: true,
    rawSecretArchived: false,
    rawCredentialArchived: false,
    authorizationHeaderArchived: false,
    databaseUrlPasswordArchived: false,
    ...overrides
  };
}

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.nonSessionCredentialEvidence.v1",
    name: "siteflow-non-session-credential-evidence",
    status: "passed",
    dryRun: false,
    checkedAt: "2026-06-08T11:30:00.000Z",
    targetEnvironment: "production",
    release: {
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main"
    },
    operatorName: "Platform Operator",
    ticketId: "CHG-123",
    credentials: [validCredential()],
    breakGlass: {
      status: "passed",
      checkedAt: "2026-06-08T11:45:00.000Z",
      incidentTicket: "INC-123",
      approverCount: 2,
      emergencyCredentialSource: "vault",
      leastPrivilegeReviewed: true,
      timeBoundedAccess: true,
      postIncidentRevocationPlanned: true,
      rawSecretArchived: false,
      rawCredentialArchived: false,
      authorizationHeaderArchived: false,
      databaseUrlPasswordArchived: false
    },
    limitations: {
      automaticRotationClaimed: false,
      siteflowRotatedExternalSecrets: false
    },
    ...overrides
  };
}

describe("nonSessionCredentialEvidenceCheck", () => {
  it("passes complete non-session credential evidence", () => {
    const result = evaluateNonSessionCredentialEvidence(validEvidence(), {
      evidencePath: "credential-evidence.json",
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
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main",
      credentialTypes: ["scoped_api_token"],
      credentialCount: 1,
      breakGlass: {
        status: "passed",
        ticket: "INC-123"
      }
    });
  });

  it("passes runtime token, app secret, and provider-managed credential evidence", () => {
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        credentials: [
          validCredential({
            type: "metrics_token",
            strengthStatus: "pass",
            secretStoreUpdated: true,
            scraperReloaded: true
          }),
          validCredential({
            type: "app_sealing_secret",
            backupCompleted: true,
            reSealPlanPresent: true,
            rollbackPlanPresent: true,
            spotCheckPassed: true,
            riskAccepted: true,
            automaticRotationClaimed: false
          }),
          validCredential({
            type: "database",
            providerRotationProofPresent: true,
            dependentServiceVerified: true
          })
        ]
      }),
      {
        evidencePath: "credential-evidence.json",
        now
      }
    );

    expect(result.status).toBe("passed");
    expect(result.selectedEvidence.credentialTypes).toEqual(["metrics_token", "app_sealing_secret", "database"]);
  });

  it("blocks stale evidence and release identity mismatch", () => {
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        checkedAt: "2026-06-01T11:30:00.000Z"
      }),
      {
        evidencePath: "credential-evidence.json",
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
    const result = evaluateNonSessionCredentialEvidence(validEvidence({ template: true }), {
      evidencePath: "credential-evidence.json",
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
    const result = evaluateNonSessionCredentialEvidence(validEvidence({ status: "verified" }), {
      evidencePath: "credential-evidence.json",
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
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        targetEnvironment: "staging"
      }),
      {
        evidencePath: "credential-evidence.json",
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

  it("blocks raw credential archival and missing old/new verification", () => {
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        credentials: [
          validCredential({
            rawSecretArchived: true,
            oldCredential: {
              id: "token_old",
              prefix: "sft_old",
              oldCredentialRejected: false
            }
          })
        ]
      }),
      {
        evidencePath: "credential-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "no_raw_credentials_archived", status: "fail" }),
        expect.objectContaining({ name: "old_credentials_rejected", status: "fail" }),
        expect.objectContaining({ name: "credential_specific_evidence", status: "fail" })
      ])
    );
  });

  it("blocks stale or failed credential entries even when root evidence is fresh", () => {
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        credentials: [
          validCredential({
            status: "failed",
            checkedAt: "2026-06-01T11:40:00.000Z"
          })
        ]
      }),
      {
        evidencePath: "credential-evidence.json",
        maxAgeHours: 24,
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "evidence_age", status: "pass" }),
        expect.objectContaining({ name: "credential_status", status: "fail" }),
        expect.objectContaining({ name: "credential_age", status: "fail" })
      ])
    );
  });

  it("blocks stale or failed break-glass evidence even when root evidence is fresh", () => {
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        breakGlass: {
          ...(validEvidence().breakGlass as Record<string, unknown>),
          status: "failed",
          checkedAt: "2026-06-01T11:45:00.000Z"
        }
      }),
      {
        evidencePath: "credential-evidence.json",
        maxAgeHours: 24,
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "evidence_age", status: "pass" }),
        expect.objectContaining({ name: "break_glass_status", status: "fail" }),
        expect.objectContaining({ name: "break_glass_age", status: "fail" }),
        expect.objectContaining({ name: "break_glass_controls", status: "fail" })
      ])
    );
  });

  it("blocks credential evidence when no-raw archive flags are missing", () => {
    const credential = validCredential();
    delete (credential as Record<string, unknown>).authorizationHeaderArchived;

    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        credentials: [credential]
      }),
      {
        evidencePath: "credential-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "no_raw_credentials_archived", status: "fail" })
      ])
    );
  });

  it("blocks break-glass evidence when no-raw archive flags are missing", () => {
    const evidence = validEvidence();
    const breakGlass = evidence.breakGlass as Record<string, unknown>;
    delete breakGlass.databaseUrlPasswordArchived;

    const result = evaluateNonSessionCredentialEvidence(evidence, {
      evidencePath: "credential-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "break_glass_controls", status: "fail" })
      ])
    );
  });

  it("blocks raw secret-like values even when raw archive flags claim safety", () => {
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        credentials: [
          validCredential({
            rawSecretArchived: false,
            rawCredentialArchived: false,
            newCredential: {
              id: "token_new",
              prefix: "sft_new",
              scopes: ["read", "write"],
              newCredentialAccepted: true,
              token: "sf_live_abcdefghijklmnop"
            }
          })
        ]
      }),
      {
        evidencePath: "credential-evidence.json",
        now
      }
    );
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "no_raw_credentials_archived", status: "pass" }),
        expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
      ])
    );
    expect(serialized).not.toContain("sf_live_abcdefghijklmnop");
  });

  it("blocks weak break-glass and automatic rotation claims", () => {
    const result = evaluateNonSessionCredentialEvidence(
      validEvidence({
        breakGlass: {
          status: "passed",
          incidentTicket: "INC-123",
          approverCount: 1,
          emergencyCredentialSource: "vault",
          leastPrivilegeReviewed: false,
          postIncidentRevocationPlanned: true,
          rawCredentialArchived: false
        },
        limitations: {
          automaticRotationClaimed: true,
          siteflowRotatedExternalSecrets: false
        }
      }),
      {
        evidencePath: "credential-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "break_glass_controls", status: "fail" }),
        expect.objectContaining({ name: "automation_not_claimed", status: "fail" })
      ])
    );
  });

  it("blocks break-glass evidence without explicit time bounds", () => {
    const evidence = validEvidence();
    const breakGlass = evidence.breakGlass as Record<string, unknown>;
    delete breakGlass.timeBoundedAccess;

    const result = evaluateNonSessionCredentialEvidence(evidence, {
      evidencePath: "credential-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "break_glass_controls", status: "fail" })
      ])
    );
  });

  it("prints JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-non-session-credential-evidence-"));
    let stdout = "";
    let stderr = "";

    try {
      const checkedAt = new Date().toISOString();
      const evidencePath = path.join(root, "credential.json");
      const baseEvidence = validEvidence();
      const cliEvidence = {
        ...baseEvidence,
        checkedAt,
        credentials: (baseEvidence.credentials as Record<string, unknown>[]).map((credential) => ({
          ...credential,
          checkedAt
        })),
        breakGlass: {
          ...(baseEvidence.breakGlass as Record<string, unknown>),
          checkedAt
        }
      };
      await writeFile(evidencePath, `${JSON.stringify(cliEvidence)}\n`, "utf8");

      const exitCode = await runNonSessionCredentialEvidenceCheckCli(
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
        name: "siteflow-non-session-credential-evidence-check",
        status: "passed",
        selectedEvidence: {
          commitRef: "abc123",
          repository: "acme/siteflow",
          branch: "main",
          credentialTypes: ["scoped_api_token"]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
