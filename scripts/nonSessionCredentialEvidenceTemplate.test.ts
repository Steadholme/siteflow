import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateNonSessionCredentialEvidence } from "./nonSessionCredentialEvidenceCheck";
import {
  createNonSessionCredentialEvidenceTemplate,
  parseNonSessionCredentialEvidenceTemplateArgs,
  runNonSessionCredentialEvidenceTemplateCli,
  writeNonSessionCredentialEvidenceTemplate
} from "./nonSessionCredentialEvidenceTemplate";

const now = () => new Date("2026-06-08T12:00:00.000Z");

const baseOptions = {
  commitRef: "abc123",
  repo: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production",
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

describe("nonSessionCredentialEvidenceTemplate", () => {
  it("creates a blocked dry-run template with the checker skeleton", () => {
    const template = createNonSessionCredentialEvidenceTemplate(baseOptions);

    expect(template).toMatchObject({
      schemaVersion: "siteflow.nonSessionCredentialEvidence.v1",
      name: "siteflow-non-session-credential-evidence",
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      targetEnvironment: "production",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main"
      },
      operatorName: "Platform Operator",
      ticketId: "CHG-123",
      breakGlass: expect.objectContaining({
        status: "todo",
        rawCredentialArchived: false
      }),
      limitations: expect.objectContaining({
        automaticRotationClaimed: false,
        siteflowRotatedExternalSecrets: false
      })
    });
    expect(template.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "scoped_api_token", status: "todo" }),
        expect.objectContaining({ type: "root_api_token", status: "todo" }),
        expect.objectContaining({ type: "metrics_token", status: "todo" }),
        expect.objectContaining({ type: "app_sealing_secret", status: "todo" }),
        expect.objectContaining({ type: "database", status: "todo" }),
        expect.objectContaining({ type: "webhook_secret", status: "todo" }),
        expect.objectContaining({ type: "ssh_deploy_key", status: "todo" }),
        expect.objectContaining({ type: "log_drain_signing_secret", status: "todo" }),
        expect.objectContaining({ type: "deploy_hook_token", status: "todo" })
      ])
    );

    const check = evaluateNonSessionCredentialEvidence(template, {
      evidencePath: "non-session-credential-evidence-raw.json",
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
        expect.objectContaining({ name: "credential_redacted_identifiers", status: "fail" }),
        expect.objectContaining({ name: "credential_specific_evidence", status: "fail" }),
        expect.objectContaining({ name: "break_glass_controls", status: "fail" })
      ])
    );
  });

  it("does not include raw credential values or raw secret fields", () => {
    const template = createNonSessionCredentialEvidenceTemplate(baseOptions);
    const serialized = JSON.stringify(template);

    expect(valuesForKey(template, "rawSecret")).toEqual([]);
    expect(valuesForKey(template, "rawCredential")).toEqual([]);
    expect(valuesForKey(template, "authorizationHeader")).toEqual([]);
    expect(valuesForKey(template, "databaseUrl")).toEqual([]);
    expect(valuesForKey(template, "privateKey")).toEqual([]);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("-----BEGIN");
    expect(serialized).not.toContain("password=");
    expect(serialized).not.toContain("REPLACE_WITH_SECRET");
  });

  it("writes the template to disk and supports CLI JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-non-session-credential-template-"));

    try {
      const outputPath = path.join(root, "non-session-credential-evidence-raw.json");
      const written = await writeNonSessionCredentialEvidenceTemplate({
        ...baseOptions,
        outputPath
      });
      const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));
      let stdout = "";
      let stderr = "";

      const exitCode = await runNonSessionCredentialEvidenceTemplateCli([
        "--commit-ref", "abc123",
        "--repo", "acme/siteflow",
        "--branch", "main",
        "--target-environment", "production",
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
        operatorName: "Platform Operator"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses arguments and reports invalid timestamps", async () => {
    expect(parseNonSessionCredentialEvidenceTemplateArgs([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "operator",
      "--ticket-id", "REL-1",
      "--output", "non-session-credential-evidence-raw.json",
      "--json"
    ])).toMatchObject({
      commitRef: "abc123",
      ticketId: "REL-1",
      json: true
    });

    let stderr = "";
    const exitCode = await runNonSessionCredentialEvidenceTemplateCli([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "operator",
      "--release-ticket", "REL-1",
      "--checked-at", "not-a-date"
    ], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--checked-at must be an ISO timestamp");
  });
});
