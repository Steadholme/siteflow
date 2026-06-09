import { describe, expect, it } from "vitest";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets, sensitiveOutputReasons } from "./evidenceSecretScan";

describe("evidenceSecretScan", () => {
  it("detects raw secret-like evidence values without returning secret values", () => {
    const findings = scanEvidenceForRawSecrets({
      webhook: {
        authorization: "Bearer abcdefghijklmnop",
        deliverySecret: "SITEFLOW_SECRET_CANARY_20260515"
      },
      database: {
        redactedUrl: "postgres://user:password@postgres.internal:5432/siteflow"
      },
      source: {
        token: "ghp_abcdefghijklmnopqrstuvwxyz",
        privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
      }
    });
    const summary = evidenceSecretFindingSummary(findings);

    expect(findings.map((finding) => finding.reason)).toEqual(expect.arrayContaining([
      "authorization field",
      "secret canary",
      "URL credentials",
      "GitHub token",
      "private key block"
    ]));
    expect(summary).toContain("$.webhook.authorization");
    expect(summary).not.toContain("abcdefghijklmnop");
    expect(summary).not.toContain("password@postgres");
    expect(summary).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  it("allows redacted identifiers, hashes, and environment variable names", () => {
    const findings = scanEvidenceForRawSecrets({
      appSecretSource: "SITEFLOW_APP_SECRET",
      metricsTokenEnvVar: "SITEFLOW_METRICS_TOKEN",
      oldCredential: {
        id: "token_old",
        prefix: "sft_old"
      },
      newCredential: {
        redactedIdentifier: "[REDACTED]",
        fingerprint: "sha256:abcdef1234567890"
      },
      targetDatabase: {
        redactedUrl: "postgres://postgres.internal:5432/siteflow_rehearsal?sslmode=require"
      }
    });

    expect(findings).toEqual([]);
  });

  it("detects sensitive JSON fields in string output", () => {
    expect(sensitiveOutputReasons(JSON.stringify({
      token: "abcdefgh12345678",
      nested: {
        password: "secret-password-value"
      }
    }))).toEqual(expect.arrayContaining([
      "token field",
      "password field"
    ]));
  });

  it("detects sensitive fields inside JSON-string encoded output", () => {
    const encodedEvidence = JSON.stringify(JSON.stringify({
      rawSecret: "super-secret-value",
      nested: {
        authorization: "Bearer abcdefghijklmnop"
      }
    }));

    expect(sensitiveOutputReasons(encodedEvidence)).toEqual(expect.arrayContaining([
      "raw credential field",
      "authorization field"
    ]));
  });

  it("flags uppercase raw values under high-risk credential keys while allowing explicit env var references", () => {
    const findings = scanEvidenceForRawSecrets({
      token: "ABCDEF1234567890",
      appSecretSource: "SITEFLOW_APP_SECRET",
      metricsTokenEnvVar: "SITEFLOW_METRICS_TOKEN",
      fingerprint: "sha256:abcdef1234567890"
    });

    expect(findings).toEqual([
      expect.objectContaining({
        path: "$.token",
        reason: "token field"
      })
    ]);
  });

  it("detects common secret patterns in command output without flagging descriptive bearer text", () => {
    expect(sensitiveOutputReasons([
      "Authorization: Bearer abcdefghijklmnop",
      "postgres://siteflow:secret-password@db.internal/siteflow",
      "https://example.com/callback?token=abcdef123456",
      "sf_live_abcdef123456",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "AKIAABCDEFGHIJKLMNOP",
      "Bearer precedence remains documented"
    ].join("\n"))).toEqual(expect.arrayContaining([
      "authorization bearer token",
      "Postgres URL password",
      "URL password query parameter",
      "SiteFlow token",
      "OpenAI token",
      "AWS access key"
    ]));
    expect(sensitiveOutputReasons("Bearer precedence remains documented")).toEqual([]);
  });
});
