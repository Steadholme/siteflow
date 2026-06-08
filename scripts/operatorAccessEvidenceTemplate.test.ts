import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateOperatorAccessEvidence } from "./operatorAccessEvidenceCheck";
import {
  createOperatorAccessEvidenceTemplate,
  parseOperatorAccessEvidenceTemplateArgs,
  runOperatorAccessEvidenceTemplateCli,
  writeOperatorAccessEvidenceTemplate
} from "./operatorAccessEvidenceTemplate";

const now = () => new Date("2026-06-08T12:00:00.000Z");

const baseOptions = {
  commitRef: "abc123",
  repo: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production",
  publicBaseUrl: "https://siteflow.example.com",
  operatorName: "Platform Operator",
  ticketId: "CHG-123",
  now
};

describe("operatorAccessEvidenceTemplate", () => {
  it("creates a blocked dry-run template with all checker sections", () => {
    const template = createOperatorAccessEvidenceTemplate(baseOptions);

    expect(template).toMatchObject({
      schemaVersion: "siteflow.operatorAccessEvidence.v1",
      name: "siteflow-operator-access-evidence",
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main"
      },
      sessionCreate: expect.objectContaining({ status: "todo" }),
      sessionPolicy: expect.objectContaining({ status: "todo" }),
      projectScope: expect.objectContaining({ status: "todo" }),
      sessionRotation: expect.objectContaining({ status: "todo" }),
      sessionRevoke: expect.objectContaining({ status: "todo" }),
      csrf: expect.objectContaining({ status: "todo" }),
      bearerPrecedence: expect.objectContaining({ status: "todo" }),
      actorAttribution: expect.objectContaining({ status: "todo" }),
      browserTokenFallback: expect.objectContaining({
        status: "todo",
        productionFallbackEnabled: null,
        localStorageFallbackDisabled: null
      }),
      emergencyCutoff: expect.objectContaining({ status: "todo" }),
      negativeEvidence: expect.objectContaining({
        notClaimingLoginIdpMfa: true,
        credentialedCorsNotExposedAsReady: true,
        nonSessionCredentialRotationOutOfScope: true
      })
    });

    const check = evaluateOperatorAccessEvidence(template, {
      evidencePath: "operator-access-evidence-raw.json",
      commitRef: "abc123",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(check.status).toBe("blocked");
    expect(check.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "evidence_status", status: "fail" }),
        expect.objectContaining({ name: "non_dry_run", status: "fail" }),
        expect.objectContaining({ name: "session_create_status", status: "fail" })
      ])
    );
  });

  it("writes the template to disk and supports CLI JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-operator-access-template-"));

    try {
      const outputPath = path.join(root, "operator-access-evidence-raw.json");
      const written = await writeOperatorAccessEvidenceTemplate({
        ...baseOptions,
        outputPath
      });
      const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));
      let stdout = "";
      let stderr = "";

      const exitCode = await runOperatorAccessEvidenceTemplateCli([
        "--commit-ref", "abc123",
        "--repo", "acme/siteflow",
        "--branch", "main",
        "--target-environment", "production",
        "--public-base-url", "https://siteflow.example.com",
        "--operator-name", "Platform Operator",
        "--release-ticket", "CHG-123",
        "--checked-at", "2026-06-08T12:00:00.000Z",
        "--json"
      ], {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      });
      const printed = JSON.parse(stdout);

      expect(written).toMatchObject({ status: "blocked", dryRun: true });
      expect(fromDisk).toMatchObject({ status: "blocked", dryRun: true });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toMatchObject({
        checkedAt: "2026-06-08T12:00:00.000Z",
        operatorName: "Platform Operator"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe public URLs and parses arguments", async () => {
    expect(parseOperatorAccessEvidenceTemplateArgs([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--public-base-url", "https://siteflow.example.com",
      "--operator-name", "operator",
      "--ticket-id", "REL-1",
      "--output", "operator-access-evidence-raw.json",
      "--json"
    ])).toMatchObject({
      commitRef: "abc123",
      ticketId: "REL-1",
      json: true
    });

    let stderr = "";
    const exitCode = await runOperatorAccessEvidenceTemplateCli([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--public-base-url", "https://operator:secret@siteflow.example.com",
      "--operator-name", "operator",
      "--release-ticket", "REL-1"
    ], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("must not include credentials");
  });
});
