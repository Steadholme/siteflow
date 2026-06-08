import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateSourceProviderEvidence } from "./sourceProviderEvidenceCheck";
import {
  createSourceProviderEvidenceTemplate,
  parseSourceProviderEvidenceTemplateArgs,
  runSourceProviderEvidenceTemplateCli,
  writeSourceProviderEvidenceTemplate
} from "./sourceProviderEvidenceTemplate";

const now = () => new Date("2026-06-08T12:00:00.000Z");

const baseOptions = {
  commitRef: "abc123",
  repo: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production",
  provider: "github",
  operatorName: "Platform Operator",
  ticketId: "CHG-123",
  now
};

function valuesForKey(value: unknown, targetKey: string): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => valuesForKey(entry, targetKey));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    ...(key === targetKey ? [entry] : []),
    ...valuesForKey(entry, targetKey)
  ]);
}

describe("sourceProviderEvidenceTemplate", () => {
  it("creates a blocked dry-run template with the checker skeleton", () => {
    const template = createSourceProviderEvidenceTemplate(baseOptions);

    expect(template).toMatchObject({
      schemaVersion: "siteflow.sourceProviderEvidence.v1",
      name: "siteflow-source-provider-evidence",
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      targetEnvironment: "production",
      provider: "github",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main"
      },
      repository: {
        provider: "github",
        fullName: "acme/siteflow",
        remoteUrl: null,
        visibility: null,
        urlEmbeddedCredentials: null
      },
      checkout: expect.objectContaining({
        status: "todo",
        commitRef: "abc123",
        headSha: null,
        exactCommitVerified: null
      }),
      webhook: expect.objectContaining({
        status: "todo",
        deliveryId: null,
        signatureVerified: null,
        secretConfigured: null,
        rawSecretArchived: false
      }),
      deployKey: expect.objectContaining({
        status: "todo",
        required: null,
        mounted: null,
        mode: null,
        path: null,
        rawCredentialArchived: false
      }),
      hostKey: expect.objectContaining({
        status: "todo",
        pinned: null,
        knownHostsConfigured: null,
        acceptedBlindly: null
      }),
      releaseProvenance: expect.objectContaining({
        status: "todo",
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main"
      }),
      negativeEvidence: expect.objectContaining({
        rawCredentialArchived: false,
        rawSecretArchived: false,
        urlEmbeddedCredentials: false,
        requestAuthHeadersArchived: false,
        secretMaterialArchived: false
      }),
      operatorName: "Platform Operator",
      ticketId: "CHG-123"
    });

    const check = evaluateSourceProviderEvidence(template, {
      evidencePath: "source-provider-evidence-raw.json",
      commitRef: "abc123",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(check.status).toBe("blocked");
    expect(check.exitCode).toBe(1);
    expect(check.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "evidence_status", status: "fail" }),
        expect.objectContaining({ name: "non_dry_run", status: "fail" }),
        expect.objectContaining({ name: "repository_binding", status: "fail" }),
        expect.objectContaining({ name: "exact_commit_checkout", status: "fail" }),
        expect.objectContaining({ name: "signed_webhook_verified", status: "fail" }),
        expect.objectContaining({ name: "release_provenance_recorded", status: "fail" })
      ])
    );
  });

  it("does not include raw token, private key, or Authorization material", () => {
    const template = createSourceProviderEvidenceTemplate(baseOptions);
    const serialized = JSON.stringify(template);

    expect(valuesForKey(template, "rawToken")).toEqual([]);
    expect(valuesForKey(template, "rawAccessToken")).toEqual([]);
    expect(valuesForKey(template, "privateKey")).toEqual([]);
    expect(valuesForKey(template, "authorizationHeader")).toEqual([]);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("-----BEGIN");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("REPLACE_WITH_SECRET");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("password=");
  });

  it("writes the template to disk and supports CLI JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-source-provider-template-"));

    try {
      const outputPath = path.join(root, "source-provider-evidence-raw.json");
      const written = await writeSourceProviderEvidenceTemplate({
        ...baseOptions,
        outputPath
      });
      const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));
      let stdout = "";
      let stderr = "";

      const exitCode = await runSourceProviderEvidenceTemplateCli([
        "--commit-ref", "abc123",
        "--repo", "acme/siteflow",
        "--branch", "main",
        "--target-environment", "production",
        "--provider", "github",
        "--operator-name", "Platform Operator",
        "--release-ticket", "CHG-123",
        "--checked-at", "2026-06-08T12:00:00.000Z",
        "--json"
      ], {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      });
      const printed = JSON.parse(stdout);

      expect(written).toMatchObject({ status: "blocked", dryRun: true, template: true });
      expect(fromDisk).toMatchObject({ status: "blocked", dryRun: true, template: true });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toMatchObject({
        checkedAt: "2026-06-08T12:00:00.000Z",
        provider: "github",
        operatorName: "Platform Operator"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses arguments and reports invalid provider values", async () => {
    expect(parseSourceProviderEvidenceTemplateArgs([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--provider", "gitlab",
      "--operator-name", "operator",
      "--ticket-id", "REL-1",
      "--output", "source-provider-evidence-raw.json",
      "--json"
    ])).toMatchObject({
      commitRef: "abc123",
      provider: "gitlab",
      ticketId: "REL-1",
      json: true
    });

    let stderr = "";
    const exitCode = await runSourceProviderEvidenceTemplateCli([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--provider", "bitbucket",
      "--operator-name", "operator",
      "--release-ticket", "REL-1"
    ], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--provider must be one of github, gitlab, gitea, or generic");
  });
});
