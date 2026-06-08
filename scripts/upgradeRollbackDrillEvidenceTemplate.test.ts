import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateUpgradeRollbackDrillEvidence } from "./upgradeRollbackDrillEvidenceCheck";
import {
  createUpgradeRollbackDrillEvidenceTemplate,
  parseUpgradeRollbackDrillEvidenceTemplateArgs,
  runUpgradeRollbackDrillEvidenceTemplateCli,
  writeUpgradeRollbackDrillEvidenceTemplate
} from "./upgradeRollbackDrillEvidenceTemplate";

const now = () => new Date("2026-06-08T12:00:00.000Z");

const baseOptions = {
  commitRef: "abc123",
  repo: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production",
  operatorName: "Platform Operator",
  ticketId: "CHG-123",
  fromVersion: "0.1.0",
  toVersion: "0.1.1",
  now
};

describe("upgradeRollbackDrillEvidenceTemplate", () => {
  it("creates a blocked dry-run template with the checker skeleton", () => {
    const template = createUpgradeRollbackDrillEvidenceTemplate(baseOptions);

    expect(template).toMatchObject({
      schemaVersion: "siteflow.upgradeRollbackDrill.v1",
      name: "siteflow-upgrade-rollback-drill",
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      startedAt: null,
      completedAt: null,
      targetEnvironment: "production",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production",
        fromVersion: "0.1.0",
        toVersion: "0.1.1",
        rollbackVersion: "0.1.0",
        operatorName: "Platform Operator",
        releaseTicket: "CHG-123"
      },
      services: {
        api: {
          before: expect.objectContaining({ status: "todo", imageDigest: null }),
          after: expect.objectContaining({ status: "todo", imageDigest: null }),
          rollback: expect.objectContaining({ status: "todo", imageDigest: null })
        },
        worker: {
          before: expect.objectContaining({ status: "todo", imageDigest: null }),
          after: expect.objectContaining({ status: "todo", imageDigest: null }),
          rollback: expect.objectContaining({ status: "todo", imageDigest: null })
        }
      },
      migrations: expect.objectContaining({
        before: expect.objectContaining({ status: "todo", currentVersion: null }),
        after: expect.objectContaining({ status: "todo", currentVersion: null }),
        rollback: expect.objectContaining({ status: "todo", currentVersion: null }),
        rollbackCompatibilityVerified: null
      }),
      backupEvidence: expect.objectContaining({ status: "todo", evidence: null }),
      operations: {
        upgrade: expect.objectContaining({ operationId: null, status: "todo", dryRun: true, completedAt: null }),
        rollback: expect.objectContaining({ operationId: null, status: "todo", dryRun: true, completedAt: null })
      },
      route: {
        before: expect.objectContaining({ deploymentId: null, artifactChecksum: null }),
        after: expect.objectContaining({ deploymentId: null, artifactChecksum: null }),
        rollback: expect.objectContaining({ deploymentId: null, artifactChecksum: null })
      },
      readiness: expect.objectContaining({
        before: expect.objectContaining({ statusCode: null }),
        after: expect.objectContaining({ statusCode: null }),
        rollback: expect.objectContaining({ statusCode: null }),
        trafficRemovedDuringUpgrade: null
      }),
      observability: {
        metrics: expect.objectContaining({ status: "todo", rollbackObserved: null }),
        logs: expect.objectContaining({ status: "todo", rollbackOperationId: null }),
        alertDelivery: expect.objectContaining({ status: "todo", channel: null })
      }
    });

    const check = evaluateUpgradeRollbackDrillEvidence(template, {
      evidencePath: "upgrade-rollback-evidence-raw.json",
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
        expect.objectContaining({ name: "drill_status", status: "fail" }),
        expect.objectContaining({ name: "non_dry_run", status: "fail" }),
        expect.objectContaining({ name: "backup_evidence_passed", status: "fail" }),
        expect.objectContaining({ name: "release_operations", status: "fail" })
      ])
    );
  });

  it("writes the template to disk and supports CLI JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-upgrade-rollback-template-"));

    try {
      const outputPath = path.join(root, "upgrade-rollback-evidence-raw.json");
      const written = await writeUpgradeRollbackDrillEvidenceTemplate({
        ...baseOptions,
        outputPath
      });
      const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));
      let stdout = "";
      let stderr = "";

      const exitCode = await runUpgradeRollbackDrillEvidenceTemplateCli([
        "--commit-ref", "abc123",
        "--repo", "acme/siteflow",
        "--branch", "main",
        "--target-environment", "production",
        "--operator-name", "Platform Operator",
        "--release-ticket", "CHG-123",
        "--from-version", "0.1.0",
        "--to-version", "0.1.1",
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
        release: {
          rollbackVersion: "0.1.0"
        },
        operatorName: "Platform Operator"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses optional versions and rejects invalid timestamps", async () => {
    expect(parseUpgradeRollbackDrillEvidenceTemplateArgs([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "operator",
      "--ticket-id", "REL-1",
      "--from-version", "0.1.0",
      "--to-version", "0.1.1",
      "--rollback-version", "0.1.0",
      "--output", "upgrade-rollback-evidence-raw.json",
      "--json"
    ])).toMatchObject({
      commitRef: "abc123",
      ticketId: "REL-1",
      fromVersion: "0.1.0",
      toVersion: "0.1.1",
      rollbackVersion: "0.1.0",
      json: true
    });

    let stderr = "";
    const exitCode = await runUpgradeRollbackDrillEvidenceTemplateCli([
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
