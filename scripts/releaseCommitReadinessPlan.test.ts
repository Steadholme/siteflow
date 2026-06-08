import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReleaseCommitReadinessPlanArgs,
  runReleaseCommitReadinessPlan,
  runReleaseCommitReadinessPlanCli,
  type ReleaseCommitReadinessCommandRunner
} from "./releaseCommitReadinessPlan";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function runner(tracked: string[], status: string[]): ReleaseCommitReadinessCommandRunner {
  return async (command, args) => {
    expect(command).toBe("git");

    if (args.join(" ") === "ls-files") {
      return {
        exitCode: 0,
        stdout: tracked.join("\n"),
        stderr: ""
      };
    }

    if (args.join(" ") === "status --porcelain --untracked-files=all") {
      return {
        exitCode: 0,
        stdout: status.join("\n"),
        stderr: ""
      };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

describe("releaseCommitReadinessPlan", () => {
  it("reports forbidden tracked paths and critical untracked release files", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(
        ["src/main.tsx", "node_modules/react/index.js", ".workflow/session.json", "dist/index.html"],
        [
          "?? .github/workflows/release-preflight.yml",
          "?? .github/workflows/release-image.yml",
          "?? Dockerfile",
          "?? docker-compose.production.yml",
          "?? PRODUCTION.md",
          "?? scripts/releaseEvidenceGapReport.ts",
          "?? scripts/artifactRetentionPlan.ts",
          "?? scripts/installProfileCheck.ts",
          "?? scripts/evidenceSecretScan.ts",
          "?? scripts/assertBrowserBuildEnv.ts",
          "?? scripts/browserProductionBoundary.test.ts",
          "?? docs/production-readiness.md",
          "?? docs/deployment/production-single-host.md",
          "?? evidence/release-abc/raw.json",
          "?? notes/scratch.md"
        ]
      ),
      now
    });

    expect(result).toMatchObject({
      name: "siteflow-release-commit-readiness-plan",
      status: "blocked",
      checkedAt: "2026-06-08T12:00:00.000Z",
      trackedPathCount: 4,
      forbiddenPathCount: 3,
      errors: [],
      exitCode: 0
    });
    expect(result.forbiddenRoots).toEqual(expect.arrayContaining([
      expect.objectContaining({ root: "node_modules", count: 1 }),
      expect.objectContaining({ root: ".workflow", count: 1 }),
      expect.objectContaining({ root: "dist", count: 1 })
    ]));
    expect(result.criticalUntracked).toMatchObject({
      total: 13,
      returned: 13,
      truncated: false
    });
    expect(result.criticalUntracked.paths.map((finding) => finding.path)).toEqual(expect.arrayContaining([
      ".github/workflows/release-preflight.yml",
      ".github/workflows/release-image.yml",
      "Dockerfile",
      "docker-compose.production.yml",
      "PRODUCTION.md",
      "scripts/releaseEvidenceGapReport.ts",
      "scripts/artifactRetentionPlan.ts",
      "scripts/installProfileCheck.ts",
      "scripts/evidenceSecretScan.ts",
      "scripts/assertBrowserBuildEnv.ts",
      "scripts/browserProductionBoundary.test.ts",
      "docs/production-readiness.md",
      "docs/deployment/production-single-host.md"
    ]));
    expect(result.criticalUntracked.paths.map((finding) => finding.path)).not.toContain("notes/scratch.md");
    expect(result.criticalUntracked.paths.map((finding) => finding.path)).not.toContain("evidence/release-abc/raw.json");
    expect(result.recommendedCommands.map((command) => command.display)).toContain(
      "npm run --silent release:source:cleanup-plan -- --json"
    );
    expect(result.suggestedStagingGroups.map((group) => group.id)).toEqual(expect.arrayContaining([
      "workflow",
      "container",
      "release_scripts",
      "production_docs"
    ]));
  });

  it("passes when there are no forbidden tracked, critical untracked, untracked source, or tracked dirty paths", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(["package.json", "src/main.tsx"], ["?? notes/scratch.md"]),
      now
    });

    expect(result.status).toBe("pass");
    expect(result.forbiddenPathCount).toBe(0);
    expect(result.criticalUntracked).toMatchObject({
      total: 0,
      paths: []
    });
    expect(result.untrackedSource).toMatchObject({
      total: 0,
      paths: []
    });
    expect(result.trackedDirtySource).toMatchObject({
      total: 0,
      paths: []
    });
    expect(result.suggestedStagingGroups).toEqual([]);
  });

  it("reports ordinary untracked source files and recommends explicit staging", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(
        ["package.json"],
        [
          "?? cli/backup.ts",
          "?? worker/gitSourceResolver.ts",
          "?? src/lib/observabilityMetrics.ts",
          "?? node_modules/react/index.js",
          "?? dist/index.html",
          "?? evidence/release-abc/raw.json",
          "?? notes/scratch.md"
        ]
      ),
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.criticalUntracked.total).toBe(0);
    expect(result.untrackedSource).toMatchObject({
      total: 3,
      returned: 3,
      truncated: false
    });
    expect(result.untrackedSource.paths).toEqual([
      expect.objectContaining({ path: "cli/backup.ts", category: "cli", blockingReleaseCommit: true }),
      expect.objectContaining({ path: "src/lib/observabilityMetrics.ts", category: "frontend", blockingReleaseCommit: true }),
      expect.objectContaining({ path: "worker/gitSourceResolver.ts", category: "worker", blockingReleaseCommit: true })
    ]);
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("node_modules/react/index.js");
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("dist/index.html");
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("evidence/release-abc/raw.json");
    expect(result.suggestedStagingGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cli",
        pathspecs: ["cli/backup.ts"]
      }),
      expect.objectContaining({
        id: "frontend",
        pathspecs: ["src/lib/observabilityMetrics.ts"]
      }),
      expect.objectContaining({
        id: "worker",
        pathspecs: ["worker/gitSourceResolver.ts"]
      })
    ]));
  });

  it("reports tracked dirty source files and recommends explicit staging", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(
        ["src/main.tsx", "docs/production-readiness.md", "PRODUCTION.md", "worker/index.ts", "dist/index.html", "evidence/release-abc/raw.json", ".vite/deps/react.js"],
        [
          " M package.json",
          " M package-lock.json",
          " M tsconfig.server.json",
          " M vite.config.ts",
          " M cli/deploy.ts",
          " M server/index.ts",
          " M src/main.tsx",
          " M tests/e2e/release-safeguards.spec.ts",
          "M  docs/production-readiness.md",
          " M PRODUCTION.md",
          " D worker/index.ts",
          " M dist/index.html",
          " M evidence/release-abc/raw.json",
          " M .vite/deps/react.js",
          "?? notes/scratch.md"
        ]
      ),
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.trackedDirtySource).toMatchObject({
      total: 11,
      returned: 11,
      truncated: false
    });
    expect(result.trackedDirtySource.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "cli/deploy.ts", status: " M", category: "cli" }),
      expect.objectContaining({ path: "docs/production-readiness.md", status: "M ", category: "production_docs" }),
      expect.objectContaining({ path: "package-lock.json", status: " M", category: "package_manifest" }),
      expect.objectContaining({ path: "package.json", status: " M", category: "package_manifest" }),
      expect.objectContaining({ path: "PRODUCTION.md", status: " M", category: "production_docs" }),
      expect.objectContaining({ path: "server/index.ts", status: " M", category: "server" }),
      expect.objectContaining({ path: "src/main.tsx", status: " M", category: "frontend" }),
      expect.objectContaining({ path: "tests/e2e/release-safeguards.spec.ts", status: " M", category: "tests" }),
      expect.objectContaining({ path: "tsconfig.server.json", status: " M", category: "config" }),
      expect.objectContaining({ path: "vite.config.ts", status: " M", category: "config" }),
      expect.objectContaining({ path: "worker/index.ts", status: " D", category: "worker" })
    ]));
    expect(result.trackedDirtySource.paths.map((finding) => finding.path)).not.toContain("dist/index.html");
    expect(result.trackedDirtySource.paths.map((finding) => finding.path)).not.toContain("evidence/release-abc/raw.json");
    expect(result.trackedDirtySource.paths.map((finding) => finding.path)).not.toContain(".vite/deps/react.js");
    expect(result.suggestedStagingGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "production_docs",
        pathspecs: ["docs/production-readiness.md", "PRODUCTION.md"]
      }),
      expect.objectContaining({
        id: "package_manifest",
        pathspecs: ["package-lock.json", "package.json"]
      }),
      expect.objectContaining({
        id: "config",
        pathspecs: ["tsconfig.server.json", "vite.config.ts"]
      }),
      expect.objectContaining({
        id: "cli",
        pathspecs: ["cli/deploy.ts"]
      }),
      expect.objectContaining({
        id: "server",
        pathspecs: ["server/index.ts"]
      }),
      expect.objectContaining({
        id: "frontend",
        pathspecs: ["src/main.tsx"]
      }),
      expect.objectContaining({
        id: "tests",
        pathspecs: ["tests/e2e/release-safeguards.spec.ts"]
      }),
      expect.objectContaining({
        id: "worker",
        pathspecs: ["worker/index.ts"]
      })
    ]));
    expect(result.recommendedCommands.map((command) => command.display)).toEqual(expect.arrayContaining([
      "git add -- package-lock.json package.json",
      "git add -- tsconfig.server.json vite.config.ts",
      "git add -- worker/index.ts"
    ]));
  });

  it("does not recommend broad staging or destructive cleanup commands", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner([], ["?? scripts/releaseEvidenceBundleCompose.ts", "?? .gitignore"]),
      now
    });
    const serialized = JSON.stringify(result.recommendedCommands);

    expect(serialized).not.toContain("git add .");
    expect(serialized).not.toMatch(/\bgit clean\b/);
    expect(serialized).not.toMatch(/\bgit reset\b/);
    expect(serialized).not.toMatch(/\bgit checkout\b/);
    expect(serialized).not.toMatch(/\brm -rf\b/);
    expect(serialized).not.toMatch(/\bRemove-Item\b/);
    expect(result.recommendedCommands.every((command) => command.removesWorkingTreeFiles === false)).toBe(true);
    expect(result.suggestedStagingGroups.every((group) => group.command.args[0] === "add")).toBe(true);
    expect(result.suggestedStagingGroups.every((group) => group.command.args.includes("."))).toBe(false);
    expect(result.excludedFromStaging).toEqual(expect.arrayContaining([
      "evidence/",
      ".vite/",
      "release-commit-readiness-plan*.json",
      "npm-debug.log*"
    ]));
  });

  it("truncates findings while preserving totals", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(
        ["dist/a.js", "dist/b.js", "dist/c.js"],
        [
          "?? scripts/releaseA.ts",
          "?? scripts/releaseB.ts",
          "?? scripts/releaseC.ts",
          "?? docs/operations-runbook.md",
          "?? cli/a.ts",
          "?? cli/b.ts",
          "?? worker/c.ts"
        ]
      ),
      maxFindings: 2,
      now
    });

    expect(result.forbiddenPaths).toMatchObject({
      total: 3,
      returned: 2,
      truncated: true
    });
    expect(result.criticalUntracked).toMatchObject({
      total: 4,
      returned: 2,
      truncated: true
    });
    expect(result.untrackedSource).toMatchObject({
      total: 3,
      returned: 2,
      truncated: true
    });
  });

  it("writes the commit readiness plan to an output file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-commit-plan-"));

    try {
      const result = await runReleaseCommitReadinessPlan({
        rootDir: root,
        outputPath: "commit-plan.json",
        commandRunner: runner(["node_modules/react/index.js"], ["?? .github/workflows/ci.yml"]),
        now
      });
      const output = JSON.parse(await readFile(path.join(root, "commit-plan.json"), "utf8"));

      expect(result.outputPath).toBe(path.join(root, "commit-plan.json"));
      expect(output).toMatchObject({
        name: "siteflow-release-commit-readiness-plan",
        status: "blocked",
        forbiddenPathCount: 1
      });
      expect(output.untrackedSource).toMatchObject({
        total: 0,
        paths: []
      });
      expect(output.criticalUntracked.paths).toEqual([
        expect.objectContaining({ path: ".github/workflows/ci.yml" })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses CLI arguments and reports usage errors", async () => {
    expect(parseReleaseCommitReadinessPlanArgs([
      "--root", "repo",
      "--output", "commit-plan.json",
      "--max-findings", "2",
      "--fail-on-blocked",
      "--json"
    ])).toEqual({
      rootDir: "repo",
      outputPath: "commit-plan.json",
      maxFindings: 2,
      json: true,
      failOnBlocked: true,
      help: false
    });

    let stderr = "";
    const exitCode = await runReleaseCommitReadinessPlanCli(["--max-findings", "0"], {
      stdout: { write: () => true },
      stderr: { write: (value: string) => { stderr += value; return true; } }
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--max-findings requires a positive integer");
    expect(stderr).toContain("release:commit:plan");
  });

  it("keeps blocked plans advisory by default for CLI exit codes", async () => {
    const exitCode = await runReleaseCommitReadinessPlanCli([], {
      stdout: { write: () => true },
      stderr: { write: () => true }
    }, {
      commandRunner: runner(["package.json"], ["?? scripts/releaseEvidenceBundleCompose.ts"]),
      now
    });

    expect(exitCode).toBe(0);
  });

  it("returns a failing CLI exit code for blocked plans when requested", async () => {
    const exitCode = await runReleaseCommitReadinessPlanCli(["--fail-on-blocked"], {
      stdout: { write: () => true },
      stderr: { write: () => true }
    }, {
      commandRunner: runner(["package.json"], ["?? scripts/releaseEvidenceBundleCompose.ts"]),
      now
    });

    expect(exitCode).toBe(1);
  });
});
