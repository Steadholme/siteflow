import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArtifactRetentionPlanArgs,
  runArtifactRetentionPlan,
  type ArtifactRetentionInventory
} from "./artifactRetentionPlan";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function inventory(artifactRoot: string): ArtifactRetentionInventory {
  return {
    schemaVersion: "siteflow.artifactRetentionInventory.v1",
    generatedAt: "2026-06-08T11:59:00.000Z",
    artifacts: [
      {
        deploymentId: "dep_old",
        projectId: "project_a",
        artifactRoot: path.join(artifactRoot, "dep_old"),
        createdAt: "2026-03-01T00:00:00.000Z",
        storageStatus: "retained"
      },
      {
        deploymentId: "dep_rollback",
        projectId: "project_a",
        artifactRoot: path.join(artifactRoot, "dep_rollback"),
        createdAt: "2026-04-01T00:00:00.000Z",
        storageStatus: "retained"
      },
      {
        deploymentId: "dep_current",
        projectId: "project_a",
        artifactRoot: path.join(artifactRoot, "dep_current"),
        createdAt: "2026-05-01T00:00:00.000Z",
        routeChannels: ["production"],
        storageStatus: "retained"
      },
      {
        deploymentId: "dep_recent",
        projectId: "project_a",
        artifactRoot: path.join(artifactRoot, "dep_recent"),
        createdAt: "2026-06-07T00:00:00.000Z",
        storageStatus: "retained"
      },
      {
        deploymentId: "dep_other_project_only",
        projectId: "project_b",
        artifactRoot: path.join(artifactRoot, "dep_other_project_only"),
        createdAt: "2026-02-01T00:00:00.000Z",
        storageStatus: "retained"
      }
    ]
  };
}

describe("artifactRetentionPlan", () => {
  it("keeps protected, routed, recent, and minimum-retained artifacts while planning old delete candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-retention-"));
    const artifactRoot = path.join(root, "artifacts");

    try {
      const result = await runArtifactRetentionPlan({
        artifactRoot,
        inventory: inventory(artifactRoot),
        protectedDeploymentIds: ["dep_rollback"],
        retentionDays: 30,
        minimumRetainedPerProject: 1,
        graceHours: 24,
        now
      });

      expect(result.status).toBe("passed");
      expect(result.exitCode).toBe(0);
      expect(result.selectedEvidence).toMatchObject({
        totalArtifacts: 5,
        retainedCount: 4,
        deleteCandidateCount: 1,
        protectedCount: 2,
        dryRun: true
      });
      expect(result.retained.find((entry) => entry.deploymentId === "dep_current")?.reasons).toContain("active_route");
      expect(result.retained.find((entry) => entry.deploymentId === "dep_rollback")?.reasons).toContain("explicitly_protected");
      expect(result.retained.find((entry) => entry.deploymentId === "dep_recent")?.reasons).toContain("within_retention_window");
      expect(result.retained.find((entry) => entry.deploymentId === "dep_other_project_only")?.reasons).toContain("minimum_retained_per_project");
      expect(result.deleteCandidates).toHaveLength(1);
      expect(result.deleteCandidates[0]).toMatchObject({
        deploymentId: "dep_old",
        relativeArtifactRoot: "dep_old",
        reasons: ["older_than_retention_policy"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unsafe artifact roots and suppresses delete candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-retention-unsafe-"));
    const artifactRoot = path.join(root, "artifacts");

    try {
      const result = await runArtifactRetentionPlan({
        artifactRoot,
        inventory: {
          artifacts: [
            {
              deploymentId: "dep_current",
              projectId: "project_a",
              artifactRoot: path.join(artifactRoot, "dep_current"),
              createdAt: "2026-05-01T00:00:00.000Z",
              routeChannels: ["production"]
            },
            {
              deploymentId: "dep_escape",
              projectId: "project_a",
              artifactRoot: path.join(root, "outside"),
              createdAt: "2026-03-01T00:00:00.000Z"
            }
          ]
        },
        now
      });

      expect(result.status).toBe("blocked");
      expect(result.deleteCandidates).toEqual([]);
      expect(result.checks.find((check) => check.name === "inventory_shape")).toMatchObject({
        status: "fail"
      });
      expect(JSON.stringify(result.checks)).toContain("must be a child of the configured artifact root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unknown protected deployment ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-retention-protect-"));
    const artifactRoot = path.join(root, "artifacts");

    try {
      const result = await runArtifactRetentionPlan({
        artifactRoot,
        inventory: inventory(artifactRoot),
        protectedDeploymentIds: ["dep_missing"],
        now
      });

      expect(result.status).toBe("blocked");
      expect(JSON.stringify(result.checks)).toContain("dep_missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a dry-run plan output file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-retention-output-"));
    const artifactRoot = path.join(root, "artifacts");
    const inventoryPath = path.join(root, "inventory.json");
    const outputPath = path.join(root, "retention-plan.json");

    try {
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(inventoryPath, `${JSON.stringify(inventory(artifactRoot), null, 2)}\n`, "utf8");

      const result = await runArtifactRetentionPlan({
        artifactRoot,
        inventoryPath,
        outputPath,
        protectedDeploymentIds: ["dep_rollback"],
        now
      });
      const written = JSON.parse(await readFile(outputPath, "utf8"));

      expect(result.status).toBe("passed");
      expect(written.name).toBe("siteflow-artifact-retention-plan");
      expect(written.selectedEvidence.dryRun).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses retention CLI arguments", () => {
    expect(parseArtifactRetentionPlanArgs([
      "--artifact-root",
      "/var/lib/siteflow/artifacts",
      "--inventory",
      "artifact-inventory.json",
      "--retention-days",
      "45",
      "--minimum-retained-per-project",
      "4",
      "--grace-hours",
      "12",
      "--protect-deployment",
      "dep_current",
      "--protect-deployment",
      "dep_rollback",
      "--output",
      "retention-plan.json",
      "--json"
    ])).toEqual({
      artifactRoot: "/var/lib/siteflow/artifacts",
      inventoryPath: "artifact-inventory.json",
      retentionDays: 45,
      minimumRetainedPerProject: 4,
      graceHours: 12,
      protectedDeploymentIds: ["dep_current", "dep_rollback"],
      outputPath: "retention-plan.json",
      json: true,
      help: false
    });
  });
});
