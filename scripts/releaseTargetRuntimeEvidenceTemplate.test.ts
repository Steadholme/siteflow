import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createReleaseTargetRuntimeEvidenceTemplate,
  runReleaseTargetRuntimeEvidenceTemplateCli,
  writeReleaseTargetRuntimeEvidenceTemplate
} from "./releaseTargetRuntimeEvidenceTemplate";

const now = () => new Date("2026-06-08T12:00:00.000Z");

const baseOptions = {
  commitRef: "abc123",
  repo: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production",
  publicBaseUrl: "https://siteflow.example.com/",
  operatorName: "Platform Operator",
  ticketId: "CHG-123",
  now
};

describe("releaseTargetRuntimeEvidenceTemplate", () => {
  it("creates a blocked dry-run template with todo runtime evidence sections", () => {
    const template = createReleaseTargetRuntimeEvidenceTemplate(baseOptions);

    expect(template).toMatchObject({
      schemaVersion: "siteflow.targetRuntimeEvidence.v1",
      name: "siteflow-target-runtime-evidence",
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      targetEnvironment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main"
      },
      composeConfig: expect.objectContaining({ status: "todo", checkedAt: "2026-06-08T12:00:00.000Z" }),
      startup: expect.objectContaining({ status: "todo", checkedAt: "2026-06-08T12:00:00.000Z" }),
      serviceHealth: expect.objectContaining({ status: "todo", checkedAt: "2026-06-08T12:00:00.000Z" }),
      readiness: expect.objectContaining({ status: "todo", checkedAt: "2026-06-08T12:00:00.000Z" }),
      imageBinding: expect.objectContaining({ status: "todo", checkedAt: "2026-06-08T12:00:00.000Z" }),
      restartSmoke: expect.objectContaining({ status: "todo", checkedAt: "2026-06-08T12:00:00.000Z" }),
      logSanity: expect.objectContaining({ status: "todo", checkedAt: "2026-06-08T12:00:00.000Z" }),
      operatorName: "Platform Operator",
      ticketId: "CHG-123"
    });
    expect(template.composeConfig).toMatchObject({
      command: "docker compose --env-file <target.env> -f docker-compose.production.yml config",
      source: "target_host_docker_compose_config",
      composeProject: null
    });
    expect(template.serviceHealth).toMatchObject({
      command: "docker compose --env-file <target.env> -f docker-compose.production.yml ps --format json",
      workerHealthy: null,
      workerQueueProbePassed: null,
      workerHeartbeatFresh: null
    });
    expect(template.imageBinding).toMatchObject({
      command: expect.stringContaining("docker image inspect"),
      apiContainerId: null,
      workerContainerId: null,
      apiImageId: null,
      workerImageId: null
    });
    expect(template.restartSmoke).toMatchObject({
      workerHealthAfterRestart: null
    });
  });

  it("writes the template to the requested output file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-target-runtime-template-"));

    try {
      const outputPath = path.join(root, "nested", "target-runtime-evidence-raw.json");
      const written = await writeReleaseTargetRuntimeEvidenceTemplate({
        ...baseOptions,
        outputPath
      });
      const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));

      expect(written).toMatchObject({ status: "blocked", dryRun: true, template: true });
      expect(fromDisk).toMatchObject({
        status: "blocked",
        dryRun: true,
        template: true,
        publicBaseUrl: "https://siteflow.example.com"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports CLI JSON output", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runReleaseTargetRuntimeEvidenceTemplateCli([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--public-base-url", "https://siteflow.example.com/",
      "--operator-name", "Platform Operator",
      "--release-ticket", "CHG-123",
      "--checked-at", "2026-06-08T12:00:00.000Z",
      "--json"
    ], {
      stdout: { write: (chunk: string) => ((stdout += chunk), true) },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });
    const printed = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).toBe("");
    expect(printed).toMatchObject({
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      publicBaseUrl: "https://siteflow.example.com",
      operatorName: "Platform Operator"
    });
  });

  it.each([
    ["http URL", "http://siteflow.example.com", "must use https"],
    ["URL with query", "https://siteflow.example.com?token=raw", "must not include credentials"]
  ])("rejects unsafe public base URL from CLI: %s", async (_label, publicBaseUrl, expectedMessage) => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runReleaseTargetRuntimeEvidenceTemplateCli([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--public-base-url", publicBaseUrl,
      "--operator-name", "Platform Operator",
      "--release-ticket", "CHG-123",
      "--json"
    ], {
      stdout: { write: (chunk: string) => ((stdout += chunk), true) },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain(expectedMessage);
  });
});
