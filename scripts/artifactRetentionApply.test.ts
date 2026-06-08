import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runArtifactRetentionPlan, type ArtifactRetentionInventory, type ArtifactRetentionPlanResult } from "./artifactRetentionPlan";
import {
  parseArtifactRetentionApplyArgs,
  runArtifactRetentionApply
} from "./artifactRetentionApply";

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
      }
    ]
  };
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeArtifactDirs(artifactRoot: string) {
  await mkdir(path.join(artifactRoot, "dep_old", "site"), { recursive: true });
  await mkdir(path.join(artifactRoot, "dep_rollback", "site"), { recursive: true });
  await mkdir(path.join(artifactRoot, "dep_current", "site"), { recursive: true });
  await mkdir(path.join(artifactRoot, "dep_recent", "site"), { recursive: true });
}

async function retentionPlan(artifactRoot: string) {
  return runArtifactRetentionPlan({
    artifactRoot,
    inventory: inventory(artifactRoot),
    protectedDeploymentIds: ["dep_rollback"],
    retentionDays: 30,
    minimumRetainedPerProject: 1,
    graceHours: 24,
    now
  });
}

describe("artifactRetentionApply", () => {
  it("defaults to dry-run and does not delete reviewed candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-apply-dry-run-"));
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeArtifactDirs(artifactRoot);
      const plan = await retentionPlan(artifactRoot);
      const result = await runArtifactRetentionApply({ plan, now });

      expect(result.status).toBe("passed");
      expect(result.selectedEvidence).toMatchObject({
        dryRun: true,
        plannedDeleteCandidateCount: 1,
        deletedCount: 0,
        skippedCount: 0
      });
      expect(result.planned).toHaveLength(1);
      expect(result.planned[0]).toMatchObject({
        deploymentId: "dep_old",
        status: "planned"
      });
      await expect(access(path.join(artifactRoot, "dep_old"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes only plan delete candidates when --yes is set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-apply-yes-"));
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeArtifactDirs(artifactRoot);
      const plan = await retentionPlan(artifactRoot);
      const result = await runArtifactRetentionApply({ plan, yes: true, now });

      expect(result.status).toBe("passed");
      expect(result.selectedEvidence).toMatchObject({
        dryRun: false,
        plannedDeleteCandidateCount: 1,
        deletedCount: 1,
        skippedCount: 0
      });
      expect(await exists(path.join(artifactRoot, "dep_old"))).toBe(false);
      expect(await exists(path.join(artifactRoot, "dep_rollback"))).toBe(true);
      expect(await exists(path.join(artifactRoot, "dep_current"))).toBe(true);
      expect(await exists(path.join(artifactRoot, "dep_recent"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks non-passed plans and does not delete candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-apply-blocked-"));
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeArtifactDirs(artifactRoot);
      const plan = await retentionPlan(artifactRoot);
      const blockedPlan: ArtifactRetentionPlanResult = {
        ...plan,
        status: "blocked",
        exitCode: 1
      };
      const result = await runArtifactRetentionApply({ plan: blockedPlan, yes: true, now });

      expect(result.status).toBe("blocked");
      expect(result.deleted).toEqual([]);
      expect(await exists(path.join(artifactRoot, "dep_old"))).toBe(true);
      expect(JSON.stringify(result.checks)).toContain("Plan status must be passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks delete candidates outside the plan artifact root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-apply-escape-"));
    const artifactRoot = path.join(root, "artifacts");
    const outside = path.join(root, "outside");

    try {
      await writeArtifactDirs(artifactRoot);
      await mkdir(outside, { recursive: true });
      const plan = await retentionPlan(artifactRoot);
      const unsafePlan: ArtifactRetentionPlanResult = {
        ...plan,
        deleteCandidates: [
          {
            ...plan.deleteCandidates[0],
            artifactRoot: outside,
            relativeArtifactRoot: "../outside"
          }
        ]
      };
      const result = await runArtifactRetentionApply({ plan: unsafePlan, yes: true, now });

      expect(result.status).toBe("blocked");
      expect(result.deleted).toEqual([]);
      expect(await exists(outside)).toBe(true);
      expect(JSON.stringify(result.checks)).toContain("must be a child of the plan artifactRoot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a delete candidate that points at the artifact root itself", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-apply-root-"));
    const artifactRoot = path.join(root, "artifacts");

    try {
      await writeArtifactDirs(artifactRoot);
      const plan = await retentionPlan(artifactRoot);
      const unsafePlan: ArtifactRetentionPlanResult = {
        ...plan,
        deleteCandidates: [
          {
            ...plan.deleteCandidates[0],
            artifactRoot,
            relativeArtifactRoot: "."
          }
        ]
      };
      const result = await runArtifactRetentionApply({ plan: unsafePlan, yes: true, now });

      expect(result.status).toBe("blocked");
      expect(result.deleted).toEqual([]);
      expect(await exists(artifactRoot)).toBe(true);
      expect(JSON.stringify(result.checks)).toContain("must not be the artifactRoot itself");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes apply evidence to a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-artifact-apply-output-"));
    const artifactRoot = path.join(root, "artifacts");
    const outputPath = path.join(root, "apply.json");

    try {
      await writeArtifactDirs(artifactRoot);
      const plan = await retentionPlan(artifactRoot);
      const result = await runArtifactRetentionApply({ plan, outputPath, now });
      const written = JSON.parse(await readFile(outputPath, "utf8"));

      expect(result.status).toBe("passed");
      expect(written.name).toBe("siteflow-artifact-retention-apply");
      expect(written.selectedEvidence.dryRun).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses apply CLI arguments", () => {
    expect(parseArtifactRetentionApplyArgs([
      "--plan",
      "artifact-retention-plan.json",
      "--output",
      "artifact-retention-apply.json",
      "--yes",
      "--json"
    ])).toEqual({
      planPath: "artifact-retention-plan.json",
      outputPath: "artifact-retention-apply.json",
      yes: true,
      json: true,
      help: false
    });
  });
});
