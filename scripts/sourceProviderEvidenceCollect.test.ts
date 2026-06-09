import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectSourceProviderEvidence,
  parseSourceProviderEvidenceCollectArgs,
  runSourceProviderEvidenceCollectCli,
  type SourceProviderEvidenceFetch
} from "./sourceProviderEvidenceCollect";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function githubRepo(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "acme/siteflow",
    clone_url: "https://github.com/acme/siteflow.git",
    ssh_url: "git@github.com:acme/siteflow.git",
    private: false,
    visibility: "public",
    default_branch: "main",
    ...overrides
  };
}

function githubBranch(sha = "abc123def4567890") {
  return {
    name: "main",
    commit: {
      sha
    }
  };
}

function makeFetch(options: { repo?: Record<string, unknown>; branchSha?: string; deployKeys?: unknown[] } = {}) {
  const calls: Array<{ input: string; init?: { method?: string; headers?: Record<string, string> } }> = [];
  const fetchImpl: SourceProviderEvidenceFetch = async (input, init) => {
    calls.push({ input, init });
    const url = new URL(input);

    if (url.pathname === "/repos/acme/siteflow") {
      return jsonResponse(200, options.repo ?? githubRepo());
    }

    if (url.pathname === "/repos/acme/siteflow/branches/main") {
      return jsonResponse(200, githubBranch(options.branchSha));
    }

    if (url.pathname === "/repos/acme/siteflow/keys") {
      return jsonResponse(200, options.deployKeys ?? []);
    }

    return jsonResponse(404, { message: "not found" });
  };

  return { fetchImpl, calls };
}

function baseOptions(overrides: Partial<Parameters<typeof collectSourceProviderEvidence>[0]> = {}) {
  return {
    provider: "github",
    repo: "acme/siteflow",
    branch: "main",
    commitRef: "abc123def4567890",
    targetEnvironment: "production",
    operatorName: "Platform Operator",
    ticketId: "REL-2026-0608",
    webhookDeliveryId: "delivery-123",
    webhookEvent: "push",
    webhookSignatureVerified: true,
    webhookSecretConfigured: true,
    fetchImpl: makeFetch().fetchImpl,
    now,
    ...overrides
  };
}

describe("sourceProviderEvidenceCollect", () => {
  it("collects public GitHub source provider evidence and writes checker output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-source-provider-collect-"));

    try {
      const outputPath = path.join(root, "source-provider-evidence-raw.json");
      const checkOutputPath = path.join(root, "source-provider-evidence.json");
      const result = await collectSourceProviderEvidence(baseOptions({
        outputPath,
        checkOutputPath
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(result.status).toBe("collected");
      expect(result.exitCode).toBe(0);
      expect(raw).toMatchObject({
        schemaVersion: "siteflow.sourceProviderEvidence.v1",
        name: "siteflow-source-provider-evidence",
        status: "passed",
        dryRun: false,
        targetEnvironment: "production",
        repository: {
          provider: "github",
          fullName: "acme/siteflow",
          remoteUrl: "https://github.com/acme/siteflow.git",
          visibility: "public",
          private: false,
          urlEmbeddedCredentials: false
        },
        checkout: {
          status: "passed",
          commitRef: "abc123def4567890",
          headSha: "abc123def4567890",
          exactCommitVerified: true
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
          required: false
        },
        hostKey: {
          status: "passed",
          required: false,
          pinned: true
        },
        releaseProvenance: {
          status: "passed",
          commitRef: "abc123def4567890",
          repository: "acme/siteflow",
          branch: "main"
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-source-provider-evidence-check",
        status: "passed",
        exitCode: 0
      });
      expect(JSON.stringify(raw)).not.toContain("Authorization");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when GitHub branch matches but target signed webhook proof is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-source-provider-blocked-"));

    try {
      const outputPath = path.join(root, "source-provider-evidence-raw.json");
      const checkOutputPath = path.join(root, "source-provider-evidence.json");
      const result = await collectSourceProviderEvidence(baseOptions({
        webhookDeliveryId: undefined,
        webhookSignatureVerified: false,
        webhookSecretConfigured: false,
        outputPath,
        checkOutputPath
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(1);
      expect(raw.status).toBe("blocked");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "github_repository_collected", status: "pass" }),
          expect.objectContaining({ name: "exact_commit_verified", status: "pass" }),
          expect.objectContaining({ name: "signed_webhook_verified", status: "fail" }),
          expect.objectContaining({ name: "source_provider_evidence_check", status: "fail" })
        ])
      );
      expect(check.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "signed_webhook_verified", status: "fail" })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects private repository deploy-key evidence without archiving key material", async () => {
    const { fetchImpl } = makeFetch({
      repo: githubRepo({
        private: true,
        visibility: "private"
      }),
      deployKeys: [
        {
          id: 42,
          title: "siteflow-read-only",
          read_only: true,
          verified: true,
          key: "ssh-ed25519 omitted-from-evidence",
          created_at: "2026-06-01T00:00:00Z"
        }
      ]
    });
    const result = await collectSourceProviderEvidence(baseOptions({
      fetchImpl,
      env: {
        GITHUB_TOKEN: "unit-test-token"
      },
      deployKeyPath: "/run/secrets/siteflow_git_ssh_key",
      deployKeyMode: "read_only",
      deployKeyMounted: true
    }));
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("collected");
    expect(result.checkResult).toMatchObject({
      status: "passed",
      exitCode: 0
    });
    expect(result.evidence).toMatchObject({
      repository: {
        private: true,
        visibility: "private"
      },
      deployKey: {
        status: "passed",
        required: true,
        mounted: true,
        available: true,
        mode: "read_only",
        path: "/run/secrets/siteflow_git_ssh_key",
        keyId: 42,
        privateKeyArchived: false,
        rawCredentialArchived: false
      }
    });
    expect(serialized).not.toContain("unit-test-token");
    expect(serialized).not.toContain("ssh-ed25519");
  });

  it("runs the CLI with a GitHub token header and does not print the token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-source-provider-cli-"));
    const { fetchImpl, calls } = makeFetch();
    let stdout = "";
    let stderr = "";

    try {
      const outputPath = path.join(root, "source-provider-evidence-raw.json");
      const checkOutputPath = path.join(root, "source-provider-evidence.json");
      const exitCode = await runSourceProviderEvidenceCollectCli(
        [
          "--provider", "github",
          "--repo", "acme/siteflow",
          "--branch", "main",
          "--commit-ref", "abc123def4567890",
          "--target-environment", "production",
          "--operator-name", "Platform Operator",
          "--release-ticket", "REL-2026-0608",
          "--webhook-delivery-id", "delivery-123",
          "--webhook-event", "push",
          "--webhook-signature-verified",
          "--webhook-secret-configured",
          "--output", outputPath,
          "--check-output", checkOutputPath,
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          fetchImpl,
          env: {
            GITHUB_TOKEN: "unit-test-token"
          },
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
      expect(calls.every((call) => call.init?.headers?.authorization === "Bearer unit-test-token")).toBe(true);
      expect(stdout).not.toContain("unit-test-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns usage errors for missing required options and unsafe remotes", () => {
    expect(parseSourceProviderEvidenceCollectArgs([
      "--provider", "github",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--commit-ref", "abc123def4567890",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608",
      "--webhook-signature-verified",
      "--webhook-secret-configured"
    ])).toMatchObject({
      provider: "github",
      repo: "acme/siteflow",
      branch: "main",
      webhookSignatureVerified: true,
      webhookSecretConfigured: true
    });
    expect(() => parseSourceProviderEvidenceCollectArgs([])).toThrow("--provider <provider> is required");
    expect(() => parseSourceProviderEvidenceCollectArgs([
      "--provider", "github",
      "--repo", "siteflow",
      "--branch", "main",
      "--commit-ref", "abc123def4567890",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608"
    ])).toThrow("--repo must use owner/repo format");
    expect(() => parseSourceProviderEvidenceCollectArgs([
      "--provider", "github",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--commit-ref", "abc123def4567890",
      "--target-environment", "production",
      "--operator-name", "Platform Operator",
      "--release-ticket", "REL-2026-0608",
      "--checkout-remote-url", "https://token:secret@github.com/acme/siteflow.git"
    ])).toThrow("--checkout-remote-url must be a credential-free HTTPS or SSH remote");
  });
});
