import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectNonSessionCredentialEvidence,
  parseNonSessionCredentialEvidenceCollectArgs,
  runNonSessionCredentialEvidenceCollectCli,
  type NonSessionCredentialEvidenceFetch
} from "./nonSessionCredentialEvidenceCollect";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const oldMetricsToken = "old-metrics-token-0123456789abcdef";
const newMetricsToken = "new-metrics-token-0123456789abcdef";
const oldApiToken = "old-api-token-0123456789abcdef0123";
const newApiToken = "new-api-token-0123456789abcdef0123";

function response(status: number) {
  return { status };
}

function makeFetch(options: { oldStatus?: number; newStatus?: number; oldApiStatus?: number; newApiStatus?: number } = {}) {
  const calls: Array<{ input: string; init?: { method?: string; headers?: Record<string, string> } }> = [];
  const fetchImpl: NonSessionCredentialEvidenceFetch = async (input, init) => {
    calls.push({ input, init });

    if (input === "https://siteflow.example.com/metrics") {
      const authorization = init?.headers?.authorization;

      if (authorization === `Bearer ${oldMetricsToken}`) {
        return response(options.oldStatus ?? 403);
      }

      if (authorization === `Bearer ${newMetricsToken}`) {
        return response(options.newStatus ?? 200);
      }
    }

    if (input === "https://siteflow.example.com/api/auth/verify") {
      const authorization = init?.headers?.authorization;

      if (authorization === `Bearer ${oldApiToken}`) {
        return response(options.oldApiStatus ?? 403);
      }

      if (authorization === `Bearer ${newApiToken}`) {
        return response(options.newApiStatus ?? 200);
      }
    }

    return response(401);
  };

  return { fetchImpl, calls };
}

function baseOptions(overrides: Partial<Parameters<typeof collectNonSessionCredentialEvidence>[0]> = {}) {
  return {
    baseUrl: "https://siteflow.example.com",
    commitRef: "abc123def4567890",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvironment: "production",
    operatorName: "Platform Operator",
    ticketId: "REL-2026-0608",
    env: {
      SITEFLOW_OLD_METRICS_TOKEN: oldMetricsToken,
      SITEFLOW_METRICS_TOKEN: newMetricsToken
    },
    fetchImpl: makeFetch().fetchImpl,
    breakGlassSource: "vault",
    breakGlassApproverCount: 2,
    breakGlassLeastPrivilegeReviewed: true,
    breakGlassTimeBoundedAccess: true,
    breakGlassPostIncidentRevocationPlanned: true,
    now,
    ...overrides
  };
}

describe("nonSessionCredentialEvidenceCollect", () => {
  it("collects metrics token cutover evidence and writes checker output without archiving tokens", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-non-session-credential-collect-"));
    const { fetchImpl, calls } = makeFetch();

    try {
      const outputPath = path.join(root, "non-session-credential-evidence-raw.json");
      const checkOutputPath = path.join(root, "non-session-credential-evidence.json");
      const result = await collectNonSessionCredentialEvidence(baseOptions({
        fetchImpl,
        outputPath,
        checkOutputPath,
        oldRedactedIdentifier: "metrics-token-old-20260608",
        newRedactedIdentifier: "metrics-token-new-20260608",
        newPrefix: "mtk_new"
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));
      const serialized = JSON.stringify({ result, raw, check });

      expect(result.status).toBe("collected");
      expect(result.exitCode).toBe(0);
      expect(raw).toMatchObject({
        schemaVersion: "siteflow.nonSessionCredentialEvidence.v1",
        name: "siteflow-non-session-credential-evidence",
        status: "passed",
        dryRun: false,
        template: false,
        targetEnvironment: "production",
        release: {
          commitRef: "abc123def4567890",
          repository: "acme/siteflow",
          branch: "main"
        },
        credentials: [
          {
            type: "metrics_token",
            status: "passed",
            oldCredential: {
              redactedIdentifier: "metrics-token-old-20260608",
              oldCredentialRejected: true,
              metricsProbe: {
                status: "rejected",
                observedStatusCode: 403,
                authorizationHeaderArchived: false,
                responseBodyArchived: false
              }
            },
            newCredential: {
              redactedIdentifier: "metrics-token-new-20260608",
              prefix: "mtk_new",
              newCredentialAccepted: true,
              metricsProbe: {
                status: "accepted",
                observedStatusCode: 200,
                authorizationHeaderArchived: false,
                responseBodyArchived: false
              }
            },
            strengthStatus: "pass",
            secretStoreUpdated: true,
            serviceReloaded: true,
            rawSecretArchived: false,
            rawCredentialArchived: false,
            authorizationHeaderArchived: false
          }
        ],
        breakGlass: {
          status: "passed",
          emergencyCredentialSource: "vault",
          approverCount: 2,
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
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-non-session-credential-evidence-check",
        status: "passed",
        exitCode: 0,
        selectedEvidence: {
          environment: "production",
          credentialTypes: ["metrics_token"],
          credentialCount: 1
        }
      });
      expect(calls.map((call) => call.init?.headers?.authorization)).toEqual(
        expect.arrayContaining([`Bearer ${oldMetricsToken}`, `Bearer ${newMetricsToken}`])
      );
      expect(serialized).not.toContain(oldMetricsToken);
      expect(serialized).not.toContain(newMetricsToken);
      expect(serialized).not.toContain("Authorization");
      expect(serialized).not.toContain("Bearer ");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects root API token cutover evidence when old API token input is present", async () => {
    const { fetchImpl, calls } = makeFetch();
    const result = await collectNonSessionCredentialEvidence(baseOptions({
      env: {
        SITEFLOW_OLD_METRICS_TOKEN: oldMetricsToken,
        SITEFLOW_METRICS_TOKEN: newMetricsToken,
        SITEFLOW_OLD_API_TOKEN: oldApiToken,
        SITEFLOW_API_TOKEN: newApiToken
      },
      fetchImpl,
      oldApiRedactedIdentifier: "api-token-old-20260608",
      newApiRedactedIdentifier: "api-token-new-20260608",
      newApiPrefix: "api_new"
    }));
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("collected");
    expect(result.exitCode).toBe(0);
    expect(result.evidence?.credentials).toEqual([
      expect.objectContaining({ type: "metrics_token", status: "passed" }),
      expect.objectContaining({
        type: "root_api_token",
        status: "passed",
        oldCredential: expect.objectContaining({
          redactedIdentifier: "api-token-old-20260608",
          oldCredentialRejected: true,
          apiVerifyProbe: expect.objectContaining({
            endpoint: "/api/auth/verify",
            status: "rejected",
            observedStatusCode: 403,
            authorizationHeaderArchived: false,
            responseBodyArchived: false
          })
        }),
        newCredential: expect.objectContaining({
          redactedIdentifier: "api-token-new-20260608",
          prefix: "api_new",
          newCredentialAccepted: true,
          apiVerifyProbe: expect.objectContaining({
            endpoint: "/api/auth/verify",
            status: "accepted",
            observedStatusCode: 200,
            authorizationHeaderArchived: false,
            responseBodyArchived: false
          })
        }),
        strengthStatus: "pass",
        secretStoreUpdated: true,
        serviceReloaded: true
      })
    ]);
    expect(result.checkResult).toMatchObject({
      status: "passed",
      selectedEvidence: {
        credentialTypes: ["metrics_token", "root_api_token"],
        credentialCount: 2
      }
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "old_root_api_token_rejected", status: "pass" }),
        expect.objectContaining({ name: "new_root_api_token_accepted", status: "pass" }),
        expect.objectContaining({ name: "new_root_api_token_strength", status: "pass" })
      ])
    );
    expect(calls.map((call) => call.init?.headers?.authorization)).toEqual(
      expect.arrayContaining([
        `Bearer ${oldMetricsToken}`,
        `Bearer ${newMetricsToken}`,
        `Bearer ${oldApiToken}`,
        `Bearer ${newApiToken}`
      ])
    );
    expect(serialized).not.toContain(oldApiToken);
    expect(serialized).not.toContain(newApiToken);
    expect(serialized).not.toContain("Bearer ");
  });

  it("blocks root API token evidence when old API token is accepted or new API token is rejected", async () => {
    const { fetchImpl } = makeFetch({ oldApiStatus: 200, newApiStatus: 403 });
    const result = await collectNonSessionCredentialEvidence(baseOptions({
      env: {
        SITEFLOW_OLD_METRICS_TOKEN: oldMetricsToken,
        SITEFLOW_METRICS_TOKEN: newMetricsToken,
        SITEFLOW_OLD_API_TOKEN: oldApiToken,
        SITEFLOW_API_TOKEN: newApiToken
      },
      fetchImpl
    }));

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.evidence?.credentials).toEqual([
      expect.objectContaining({ type: "metrics_token", status: "passed" }),
      expect.objectContaining({
        type: "root_api_token",
        status: "blocked",
        oldCredential: expect.objectContaining({
          oldCredentialRejected: false,
          apiVerifyProbe: expect.objectContaining({
            status: "blocked",
            observedStatusCode: 200
          })
        }),
        newCredential: expect.objectContaining({
          newCredentialAccepted: false,
          apiVerifyProbe: expect.objectContaining({
            status: "blocked",
            observedStatusCode: 403
          })
        })
      })
    ]);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "old_root_api_token_rejected", status: "fail" }),
        expect.objectContaining({ name: "new_root_api_token_accepted", status: "fail" }),
        expect.objectContaining({ name: "non_session_credential_evidence_check", status: "fail" })
      ])
    );
  });

  it("blocks when the old token is still accepted or the new token is rejected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-non-session-credential-blocked-"));
    const { fetchImpl } = makeFetch({ oldStatus: 200, newStatus: 403 });

    try {
      const outputPath = path.join(root, "non-session-credential-evidence-raw.json");
      const checkOutputPath = path.join(root, "non-session-credential-evidence.json");
      const result = await collectNonSessionCredentialEvidence(baseOptions({
        fetchImpl,
        outputPath,
        checkOutputPath
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(1);
      expect(raw).toMatchObject({
        status: "blocked",
        credentials: [
          {
            status: "blocked",
            oldCredential: {
              oldCredentialRejected: false,
              metricsProbe: {
                status: "blocked",
                observedStatusCode: 200
              }
            },
            newCredential: {
              newCredentialAccepted: false,
              metricsProbe: {
                status: "blocked",
                observedStatusCode: 403
              }
            }
          }
        ]
      });
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "old_metrics_token_rejected", status: "fail" }),
          expect.objectContaining({ name: "new_metrics_token_accepted", status: "fail" }),
          expect.objectContaining({ name: "non_session_credential_evidence_check", status: "fail" })
        ])
      );
      expect(check.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "old_credentials_rejected", status: "fail" }),
          expect.objectContaining({ name: "new_credentials_accepted", status: "fail" })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads old and new metrics and root API tokens from *_FILE without storing file contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-non-session-credential-token-file-"));
    const { fetchImpl, calls } = makeFetch();

    try {
      const oldTokenPath = path.join(root, "old-metrics-token.secret");
      const newTokenPath = path.join(root, "new-metrics-token.secret");
      const oldApiTokenPath = path.join(root, "old-api-token.secret");
      const newApiTokenPath = path.join(root, "new-api-token.secret");
      await writeFile(oldTokenPath, `${oldMetricsToken}\n`, "utf8");
      await writeFile(newTokenPath, `${newMetricsToken}\n`, "utf8");
      await writeFile(oldApiTokenPath, `${oldApiToken}\n`, "utf8");
      await writeFile(newApiTokenPath, `${newApiToken}\n`, "utf8");

      const result = await collectNonSessionCredentialEvidence(baseOptions({
        env: {
          SITEFLOW_OLD_METRICS_TOKEN_FILE: oldTokenPath,
          SITEFLOW_METRICS_TOKEN_FILE: newTokenPath,
          SITEFLOW_OLD_API_TOKEN_FILE: oldApiTokenPath,
          SITEFLOW_API_TOKEN_FILE: newApiTokenPath
        },
        fetchImpl
      }));
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("collected");
      expect(calls.map((call) => call.init?.headers?.authorization)).toEqual(
        expect.arrayContaining([
          `Bearer ${oldMetricsToken}`,
          `Bearer ${newMetricsToken}`,
          `Bearer ${oldApiToken}`,
          `Bearer ${newApiToken}`
        ])
      );
      expect(result.evidence?.credentials).toEqual([
        expect.objectContaining({
          type: "metrics_token",
          oldCredential: expect.objectContaining({
            metricsProbe: expect.objectContaining({ tokenEnv: "SITEFLOW_OLD_METRICS_TOKEN_FILE" })
          }),
          newCredential: expect.objectContaining({
            metricsProbe: expect.objectContaining({ tokenEnv: "SITEFLOW_METRICS_TOKEN_FILE" })
          })
        }),
        expect.objectContaining({
          type: "root_api_token",
          oldCredential: expect.objectContaining({
            apiVerifyProbe: expect.objectContaining({ tokenEnv: "SITEFLOW_OLD_API_TOKEN_FILE" })
          }),
          newCredential: expect.objectContaining({
            apiVerifyProbe: expect.objectContaining({ tokenEnv: "SITEFLOW_API_TOKEN_FILE" })
          })
        })
      ]);
      expect(serialized).not.toContain(oldMetricsToken);
      expect(serialized).not.toContain(newMetricsToken);
      expect(serialized).not.toContain(oldApiToken);
      expect(serialized).not.toContain(newApiToken);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the CLI and prints collected evidence without leaking token values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-non-session-credential-cli-"));
    const { fetchImpl } = makeFetch();
    let stdout = "";
    let stderr = "";

    try {
      const outputPath = path.join(root, "non-session-credential-evidence-raw.json");
      const checkOutputPath = path.join(root, "non-session-credential-evidence.json");
      const exitCode = await runNonSessionCredentialEvidenceCollectCli(
        [
          "--base-url", "https://siteflow.example.com",
          "--commit-ref", "abc123def4567890",
          "--repo", "acme/siteflow",
          "--branch", "main",
          "--target-environment", "production",
          "--operator-name", "Platform Operator",
          "--release-ticket", "REL-2026-0608",
          "--break-glass-source", "vault",
          "--break-glass-approver-count", "2",
          "--break-glass-reviewed",
          "--break-glass-time-bounded",
          "--break-glass-revocation-planned",
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
            SITEFLOW_OLD_METRICS_TOKEN: oldMetricsToken,
            SITEFLOW_METRICS_TOKEN: newMetricsToken
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
      expect(stdout).not.toContain(oldMetricsToken);
      expect(stdout).not.toContain(newMetricsToken);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns usage errors for missing required options and unsafe base URLs", () => {
    expect(parseNonSessionCredentialEvidenceCollectArgs([
      "--base-url", "https://siteflow.example.com",
      "--commit-ref", "abc123def4567890",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608",
      "--old-api-token-env", "SITEFLOW_PREVIOUS_API_TOKEN",
      "--new-api-token-env", "SITEFLOW_CURRENT_API_TOKEN",
      "--break-glass-reviewed"
    ])).toMatchObject({
      baseUrl: "https://siteflow.example.com",
      oldMetricsTokenEnv: "SITEFLOW_OLD_METRICS_TOKEN",
      newMetricsTokenEnv: "SITEFLOW_METRICS_TOKEN",
      oldApiTokenEnv: "SITEFLOW_PREVIOUS_API_TOKEN",
      newApiTokenEnv: "SITEFLOW_CURRENT_API_TOKEN",
      breakGlassLeastPrivilegeReviewed: true
    });
    expect(() => parseNonSessionCredentialEvidenceCollectArgs([])).toThrow("--base-url <url> is required");
    expect(() => parseNonSessionCredentialEvidenceCollectArgs([
      "--base-url", "https://siteflow.example.com?token=secret",
      "--commit-ref", "abc123def4567890",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608"
    ])).toThrow("--base-url must not include credentials");
    expect(() => parseNonSessionCredentialEvidenceCollectArgs([
      "--base-url", "http://siteflow.example.com",
      "--commit-ref", "abc123def4567890",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608"
    ])).toThrow("--base-url must use https outside localhost tests");
    expect(parseNonSessionCredentialEvidenceCollectArgs([
      "--base-url", "http://localhost:3000",
      "--commit-ref", "abc123def4567890",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "local",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608"
    ])).toMatchObject({
      baseUrl: "http://localhost:3000"
    });
    expect(() => parseNonSessionCredentialEvidenceCollectArgs([
      "--base-url", "https://siteflow.example.com",
      "--commit-ref", "abc123def4567890",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608",
      "--break-glass-approver-count", "1.5"
    ])).toThrow("--break-glass-approver-count must be a non-negative integer");
  });
});
