import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QueuedBuildJob } from "./buildWorker";
import { LocalSourceResolver } from "./localSourceResolver";

function queuedJob(overrides: Partial<QueuedBuildJob> = {}): QueuedBuildJob {
  const base: QueuedBuildJob = {
    id: "build_local_1",
    projectId: "project_docs",
    projectSlug: "docs",
    productionBranch: "main",
    sourceEventId: "src_local_1",
    sourceEvent: {
      id: "src_local_1",
      projectId: "project_docs",
      kind: "push",
      status: "accepted",
      disposition: "build_requested",
      providerDeliveryId: "delivery-local",
      branch: "main",
      commitSha: "abc1234",
      commitMessage: "Local source",
      commitAuthor: "Ada",
      receivedAt: "2026-06-07T00:00:00.000Z",
      actor: {
        id: "local:ada",
        name: "Ada",
        role: "developer"
      }
    },
    repository: {
      provider: "local",
      owner: "acme",
      name: "docs",
      defaultBranch: "main",
      providerPayload: {
        localPath: "docs"
      }
    },
    buildSettings: {
      framework: "static",
      installCommand: "",
      buildCommand: "npm run build",
      outputDirectory: "dist"
    }
  };

  return {
    ...base,
    ...overrides,
    sourceEvent: {
      ...base.sourceEvent,
      ...overrides.sourceEvent
    },
    repository: {
      ...base.repository,
      ...overrides.repository
    },
    buildSettings: {
      ...base.buildSettings,
      ...overrides.buildSettings
    }
  };
}

describe("LocalSourceResolver", () => {
  it("copies local source into a safe job workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-local-resolver-"));
    const sourceRoot = path.join(root, "sources");
    const workspaceRoot = path.join(root, "workspace");

    try {
      await mkdir(path.join(sourceRoot, "docs"), { recursive: true });
      await writeFile(path.join(sourceRoot, "docs", "index.html"), "<h1>Docs</h1>", "utf8");

      const checkout = await new LocalSourceResolver({ sourceRoot }).checkout(queuedJob(), workspaceRoot);

      expect(checkout.sourceDirectory).toBe(path.join(workspaceRoot, "build_local_1", "source"));
      expect(await readFile(path.join(checkout.sourceDirectory, "index.html"), "utf8")).toBe("<h1>Docs</h1>");

      await checkout.cleanup?.();
      await expect(readFile(path.join(checkout.sourceDirectory, "index.html"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe checkout job ids before copying source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-local-unsafe-job-"));
    const sourceRoot = path.join(root, "sources");
    const workspaceRoot = path.join(root, "workspace");

    try {
      await mkdir(path.join(sourceRoot, "docs"), { recursive: true });
      await writeFile(path.join(sourceRoot, "docs", "index.html"), "<h1>Docs</h1>", "utf8");

      await expect(new LocalSourceResolver({ sourceRoot }).checkout(queuedJob({
        id: "../escape"
      }), workspaceRoot)).rejects.toThrow(/safe path segment/i);
      await expect(readFile(path.join(root, "escape", "source", "index.html"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the job workspace when copying source fails after checkout preparation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-local-copy-fail-"));
    const workspaceRoot = path.join(root, "workspace");
    const checkoutRoot = path.join(workspaceRoot, "build_local_1", "source");

    try {
      await mkdir(checkoutRoot, { recursive: true });
      await writeFile(path.join(checkoutRoot, "index.html"), "<h1>Source</h1>", "utf8");

      await expect(new LocalSourceResolver().checkout(queuedJob({
        repository: {
          provider: "local",
          owner: "acme",
          name: "docs",
          defaultBranch: "main",
          providerPayload: {
            localPath: checkoutRoot
          }
        }
      }), workspaceRoot)).rejects.toThrow();
      await expect(stat(path.join(workspaceRoot, "build_local_1"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
