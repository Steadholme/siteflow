import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requiredSiteFlowMetricNames } from "../src/lib/observabilityMetrics.ts";
import { collectObservabilityEvidence, type ObservabilityEvidenceFetch } from "./observabilityEvidenceCollect";
import { evaluateObservabilityEvidence } from "./observabilityEvidenceCheck";
import {
  createObservabilityOperatorEvidenceTemplate,
  parseObservabilityOperatorEvidenceTemplateArgs,
  runObservabilityOperatorEvidenceTemplateCli,
  writeObservabilityOperatorEvidenceTemplate
} from "./observabilityOperatorEvidenceTemplate";

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

function textResponse(status: number, body: string) {
  return {
    status,
    json: async () => JSON.parse(body || "{}"),
    text: async () => body
  };
}

function makeFetch(): ObservabilityEvidenceFetch {
  return async (input) => {
    const url = new URL(input);

    if (url.pathname === "/readyz") {
      return textResponse(200, JSON.stringify({ status: "ready" }));
    }

    if (url.pathname === "/metrics") {
      return textResponse(
        200,
        requiredSiteFlowMetricNames.map((metricName) => `# TYPE ${metricName} counter\n${metricName} 1`).join("\n")
      );
    }

    return textResponse(404, "not found");
  };
}

describe("observabilityOperatorEvidenceTemplate", () => {
  it("creates a blocked dry-run operator-evidence template with safe observability todo sections", () => {
    const template = createObservabilityOperatorEvidenceTemplate(baseOptions);
    const serialized = JSON.stringify(template);

    expect(template).toMatchObject({
      schemaVersion: "siteflow.observabilityOperatorEvidence.v1",
      name: "siteflow-observability-operator-evidence-template",
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      targetEnvironment: "production",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production"
      },
      readinessProbe: expect.objectContaining({
        status: "todo",
        failureStatusCode: null,
        trafficRemovedOnFailure: null
      }),
      observabilityProvisioning: expect.objectContaining({
        schemaVersion: "siteflow.observabilityProvisioning.v1",
        target: {
          metricsPath: "/metrics",
          alertReceiverName: null,
          grafanaDashboardUid: null
        },
        renderedAssets: expect.arrayContaining([
          expect.objectContaining({ kind: "prometheus_scrape", sha256: null }),
          expect.objectContaining({ kind: "prometheus_rules", sha256: null, content: null }),
          expect.objectContaining({ kind: "alertmanager_route", sha256: null }),
          expect.objectContaining({ kind: "grafana_dashboard", sha256: null })
        ])
      }),
      observabilityApplyProof: expect.objectContaining({
        status: "todo",
        dryRun: true,
        template: true,
        operator: "Platform Operator",
        ticket: "CHG-123"
      }),
      observabilityTargetStackProof: expect.objectContaining({
        status: "todo",
        evidenceSource: "target_stack_api",
        dryRun: true,
        template: true,
        operator: "Platform Operator",
        ticket: "CHG-123"
      }),
      alertDelivery: expect.objectContaining({
        status: "todo",
        delivered: null,
        channel: null
      }),
      dashboard: expect.objectContaining({
        status: "todo",
        dashboardUrl: null,
        dashboardUid: null,
        owner: null
      }),
      logPipeline: expect.objectContaining({
        status: "todo",
        retentionDays: null,
        redactionSpotCheckPassed: null
      }),
      operatorName: "Platform Operator",
      ticketId: "CHG-123"
    });
    expect(serialized).not.toMatch(/secret|authorization|token/i);
  });

  it("writes the template to disk and supports CLI JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-operator-template-"));

    try {
      const outputPath = path.join(root, "operator-observability.json");
      const written = await writeObservabilityOperatorEvidenceTemplate({
        ...baseOptions,
        outputPath
      });
      const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));
      let stdout = "";
      let stderr = "";

      const exitCode = await runObservabilityOperatorEvidenceTemplateCli([
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
        observabilityProvisioning: {
          target: {
            metricsPath: "/metrics"
          }
        },
        operatorName: "Platform Operator",
        ticketId: "CHG-123"
      });
      expect(stdout).not.toMatch(/secret|authorization|token/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("documents that the raw template is not direct passing observability evidence", () => {
    const template = createObservabilityOperatorEvidenceTemplate(baseOptions);
    const check = evaluateObservabilityEvidence(template, {
      evidencePath: "operator-observability.json",
      commitRef: "abc123",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(check.status).toBe("blocked");
    expect(check.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "metrics_present", status: "fail" }),
        expect.objectContaining({ name: "backup_automation_run_present", status: "fail" }),
        expect.objectContaining({ name: "observability_apply_proof_non_dry_run", status: "fail" }),
        expect.objectContaining({ name: "observability_target_stack_proof_non_dry_run", status: "fail" }),
        expect.objectContaining({ name: "alert_delivered", status: "fail" }),
        expect.objectContaining({ name: "dashboard_reference", status: "fail" }),
        expect.objectContaining({ name: "log_retention", status: "fail" })
      ])
    );
  });

  it("lets observabilityEvidenceCollect merge template sections while the checker remains blocked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-observability-operator-collect-"));

    try {
      const operatorEvidencePath = path.join(root, "operator-observability.json");

      await writeFile(
        operatorEvidencePath,
        `${JSON.stringify(createObservabilityOperatorEvidenceTemplate(baseOptions), null, 2)}\n`,
        "utf8"
      );

      const result = await collectObservabilityEvidence({
        baseUrl: "https://siteflow.example.com",
        operatorEvidencePath,
        commitRef: "abc123",
        repo: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production",
        privateScrapeException: true,
        check: true,
        fetchImpl: makeFetch(),
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.evidence).toMatchObject({
        readinessProbe: expect.objectContaining({
          status: "passed",
          healthyStatusCode: 200,
          failureStatusCode: null,
          trafficRemovedOnFailure: null
        }),
        observabilityApplyProof: expect.objectContaining({
          status: "todo",
          dryRun: true,
          template: true
        }),
        observabilityTargetStackProof: expect.objectContaining({
          status: "todo",
          dryRun: true,
          template: true
        }),
        alertDelivery: expect.objectContaining({ status: "todo" }),
        dashboard: expect.objectContaining({ status: "todo" }),
        logPipeline: expect.objectContaining({ status: "todo" })
      });
      expect(result.checkResult).toMatchObject({
        status: "blocked",
        selectedEvidence: {
          observabilityApplyProof: expect.objectContaining({
            status: "todo"
          }),
          observabilityTargetStackProof: expect.objectContaining({
            status: "todo"
          })
        }
      });
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "observability_evidence_check",
            status: "fail"
          })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses arguments and reports missing required fields through the CLI", async () => {
    expect(parseObservabilityOperatorEvidenceTemplateArgs([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "operator",
      "--ticket-id", "REL-1",
      "--output", "operator-observability.json",
      "--json"
    ])).toMatchObject({
      commitRef: "abc123",
      ticketId: "REL-1",
      outputPath: "operator-observability.json",
      json: true
    });

    let stderr = "";
    const exitCode = await runObservabilityOperatorEvidenceTemplateCli([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "operator"
    ], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--release-ticket is required.");
  });
});
