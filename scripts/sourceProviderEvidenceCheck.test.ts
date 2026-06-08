import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateSourceProviderEvidence,
  runSourceProviderEvidenceCheckCli
} from "./sourceProviderEvidenceCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.sourceProviderEvidence.v1",
    name: "siteflow-source-provider-evidence",
    status: "passed",
    dryRun: false,
    checkedAt: "2026-06-08T11:30:00.000Z",
    targetEnvironment: "production",
    provider: "github",
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main"
    },
    repository: {
      provider: "github",
      fullName: "acme/siteflow",
      remoteUrl: "git@github.com:acme/siteflow.git",
      visibility: "private",
      urlEmbeddedCredentials: false
    },
    checkout: {
      status: "passed",
      commitRef: "abc123def4567890",
      headSha: "abc123def4567890",
      exactCommitVerified: true,
      remoteUrl: "git@github.com:acme/siteflow.git"
    },
    webhook: {
      status: "passed",
      deliveryId: "delivery-123",
      event: "push",
      signatureVerified: true,
      secretConfigured: true,
      rawSecretArchived: false,
      signatureHeaderArchived: false
    },
    deployKey: {
      status: "passed",
      required: true,
      mounted: true,
      mode: "read_only",
      path: "/run/secrets/siteflow_git_ssh_key",
      privateKeyArchived: false
    },
    hostKey: {
      status: "passed",
      pinned: true,
      knownHostsConfigured: true,
      acceptedBlindly: false
    },
    releaseProvenance: {
      status: "passed",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main"
    },
    operatorName: "Platform Operator",
    ticketId: "REL-2026-0608",
    rawCredentialArchived: false,
    ...overrides
  };
}

describe("sourceProviderEvidenceCheck", () => {
  it("passes complete source provider evidence", () => {
    const result = evaluateSourceProviderEvidence(validEvidence(), {
      evidencePath: "source-provider-evidence.json",
      commitRef: "abc123def4567890",
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
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      provider: "github",
      webhookDeliveryId: "delivery-123",
      deployKeyMode: "read_only"
    });
  });

  it("blocks release identity mismatch", () => {
    const result = evaluateSourceProviderEvidence(validEvidence(), {
      evidencePath: "source-provider-evidence.json",
      commitRef: "different",
      repo: "acme/siteflow",
      branch: "main",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "release_identity", status: "fail" })
      ])
    );
  });

  it("blocks template evidence explicitly", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({ template: true }), {
      evidencePath: "source-provider-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "not_template", status: "fail" })
      ])
    );
  });

  it("requires final passed status instead of passing aliases", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({ status: "verified" }), {
      evidencePath: "source-provider-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "evidence_status", status: "pass" }),
        expect.objectContaining({ name: "status_final", status: "fail" })
      ])
    );
  });

  it("blocks unsigned or missing webhook evidence", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({
      webhook: {
        status: "failed",
        deliveryId: "delivery-123",
        event: "push",
        signatureVerified: false,
        secretConfigured: true,
        rawSecretArchived: false
      }
    }), {
      evidencePath: "source-provider-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "signed_webhook_verified", status: "fail" })
      ])
    );
  });

  it("blocks credentialed clone URLs", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({
      repository: {
        provider: "github",
        fullName: "acme/siteflow",
        remoteUrl: "https://token:secret@github.com/acme/siteflow.git",
        visibility: "private",
        urlEmbeddedCredentials: true
      }
    }), {
      evidencePath: "source-provider-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "remote_url_hygiene", status: "fail" })
      ])
    );
  });

  it("blocks private repository evidence without deploy key and host key proof", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({
      deployKey: {
        status: "missing",
        required: true,
        mounted: false,
        privateKeyArchived: false
      },
      hostKey: {
        status: "missing",
        pinned: false,
        acceptedBlindly: true
      }
    }), {
      evidencePath: "source-provider-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "deploy_key_policy", status: "fail" }),
        expect.objectContaining({ name: "host_key_policy", status: "fail" })
      ])
    );
  });

  it("blocks generic SSH repository evidence without host key proof", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({
      provider: "generic",
      repository: {
        provider: "generic",
        fullName: "acme/siteflow",
        remoteUrl: "ssh://git@example.internal/acme/siteflow.git",
        visibility: "private",
        urlEmbeddedCredentials: false
      },
      checkout: {
        status: "passed",
        commitRef: "abc123def4567890",
        headSha: "abc123def4567890",
        exactCommitVerified: true,
        remoteUrl: "ssh://git@example.internal/acme/siteflow.git"
      },
      hostKey: undefined
    }), {
      evidencePath: "source-provider-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "provider_supported", status: "pass" }),
        expect.objectContaining({ name: "host_key_policy", status: "fail" })
      ])
    );
  });

  it("allows generic HTTPS repository evidence without host key proof", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({
      provider: "generic",
      repository: {
        provider: "generic",
        fullName: "acme/siteflow",
        remoteUrl: "https://example.internal/acme/siteflow.git",
        visibility: "private",
        urlEmbeddedCredentials: false
      },
      checkout: {
        status: "passed",
        commitRef: "abc123def4567890",
        headSha: "abc123def4567890",
        exactCommitVerified: true,
        remoteUrl: "https://example.internal/acme/siteflow.git"
      },
      hostKey: undefined
    }), {
      evidencePath: "source-provider-evidence.json",
      now
    });

    expect(result.status).toBe("passed");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "provider_supported", status: "pass" }),
        expect.objectContaining({ name: "host_key_policy", status: "pass" })
      ])
    );
  });

  it("blocks stale evidence, wrong environment, and raw secret archival", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({
      checkedAt: "2026-06-01T11:30:00.000Z",
      targetEnvironment: "staging",
      webhook: {
        status: "passed",
        deliveryId: "delivery-123",
        event: "push",
        signatureVerified: true,
        secretConfigured: true,
        rawSecretArchived: true
      },
      rawCredentialArchived: true
    }), {
      evidencePath: "source-provider-evidence.json",
      targetEnvironment: "production",
      maxAgeHours: 24,
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "environment", status: "fail" }),
        expect.objectContaining({ name: "evidence_age", status: "fail" }),
        expect.objectContaining({ name: "webhook_secret_hygiene", status: "fail" }),
        expect.objectContaining({ name: "no_raw_credentials_archived", status: "fail" })
      ])
    );
  });

  it("blocks raw secret-like values even when archive flags claim safety", () => {
    const result = evaluateSourceProviderEvidence(validEvidence({
      webhook: {
        status: "passed",
        deliveryId: "delivery-123",
        event: "push",
        signatureVerified: true,
        secretConfigured: true,
        rawSecretArchived: false,
        signatureHeaderArchived: false,
        authorizationHeader: "Bearer abcdefghijklmnop"
      },
      rawCredentialArchived: false
    }), {
      evidencePath: "source-provider-evidence.json",
      now
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "no_raw_credentials_archived", status: "pass" }),
        expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
      ])
    );
    expect(serialized).not.toContain("abcdefghijklmnop");
  });

  it("prints JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-source-provider-evidence-"));
    const evidencePath = path.join(root, "source-provider-evidence.json");
    const output = { stdout: "", stderr: "" };

    try {
      await writeFile(evidencePath, `${JSON.stringify(validEvidence())}\n`, "utf8");

      const code = await runSourceProviderEvidenceCheckCli(
        ["--evidence", evidencePath, "--commit-ref", "abc123def4567890", "--repo", "acme/siteflow", "--branch", "main", "--target-environment", "production", "--json"],
        {
          stdout: { write: (value: string) => { output.stdout += value; return true; } },
          stderr: { write: (value: string) => { output.stderr += value; return true; } }
        },
        { now }
      );
      const result = JSON.parse(output.stdout);

      expect(code).toBe(0);
      expect(output.stderr).toBe("");
      expect(result).toMatchObject({
        name: "siteflow-source-provider-evidence-check",
        status: "passed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
