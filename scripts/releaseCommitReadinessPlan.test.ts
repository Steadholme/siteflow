import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatReleaseCommitReviewChecklist,
  parseReleaseCommitReadinessPlanArgs,
  runReleaseCommitReadinessPlan,
  runReleaseCommitReadinessPlanCli,
  type ReleaseCommitReadinessCommandRunner
} from "./releaseCommitReadinessPlan";
import {
  releaseSourceTreeForbiddenPathspecs,
  releaseSourceTreePolicyDetails
} from "../cli/releaseSourceTreePolicy";

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
          "?? scripts/productionRuntimeProfileContract.test.ts",
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
      total: 14,
      returned: 14,
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
      "scripts/productionRuntimeProfileContract.test.ts",
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
      "release_evidence_pack_scripts",
      "release_artifact_runtime_scripts",
      "release_support_scripts",
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
    expect(result.recommendedCommands).toEqual([]);
  });

  it("reports ordinary untracked source files and recommends explicit staging", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(
        ["package.json"],
        [
          "?? cli/backup.ts",
          "?? server/httpServer.ts",
          "?? worker/gitSourceResolver.ts",
          "?? src/lib/observabilityMetrics.ts",
          "?? tests/e2e/release-extra.spec.ts",
          "?? vite.config.ts",
          "?? node_modules/react/index.js",
          "?? dist/index.html",
          "?? evidence/release-abc/raw.json",
          "?? release-commit-readiness-plan.local.json",
          "?? npm-debug.log.1",
          "?? .vite/deps/react.js",
          "?? notes/scratch.md"
        ]
      ),
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.criticalUntracked.total).toBe(0);
    expect(result.untrackedSource).toMatchObject({
      total: 6,
      returned: 6,
      truncated: false
    });
    expect(result.untrackedSource.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "cli/backup.ts", category: "cli", blockingReleaseCommit: true }),
      expect.objectContaining({ path: "server/httpServer.ts", category: "server", blockingReleaseCommit: true }),
      expect.objectContaining({ path: "src/lib/observabilityMetrics.ts", category: "frontend", blockingReleaseCommit: true }),
      expect.objectContaining({ path: "tests/e2e/release-extra.spec.ts", category: "tests", blockingReleaseCommit: true }),
      expect.objectContaining({ path: "vite.config.ts", category: "config", blockingReleaseCommit: true }),
      expect.objectContaining({ path: "worker/gitSourceResolver.ts", category: "worker", blockingReleaseCommit: true })
    ]));
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("node_modules/react/index.js");
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("dist/index.html");
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("evidence/release-abc/raw.json");
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("release-commit-readiness-plan.local.json");
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain("npm-debug.log.1");
    expect(result.untrackedSource.paths.map((finding) => finding.path)).not.toContain(".vite/deps/react.js");
    expect(result.suggestedStagingGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cli",
        pathspecs: ["cli/backup.ts"]
      }),
      expect.objectContaining({
        id: "server",
        pathspecs: ["server/httpServer.ts"]
      }),
      expect.objectContaining({
        id: "frontend",
        pathspecs: ["src/lib/observabilityMetrics.ts"]
      }),
      expect.objectContaining({
        id: "tests",
        pathspecs: ["tests/e2e/release-extra.spec.ts"]
      }),
      expect.objectContaining({
        id: "config",
        pathspecs: ["vite.config.ts"]
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

    const checklist = formatReleaseCommitReviewChecklist(result);
    expect(checklist).not.toMatch(/Stage only after review:\n```sh\ngit add \./);
    expect(checklist).not.toMatch(/`git clean\b/);
    expect(checklist).not.toMatch(/`git reset\b/);
    expect(checklist).not.toMatch(/`git checkout\b/);
    expect(checklist).not.toMatch(/`rm -rf\b/);
    expect(checklist).not.toMatch(/`Remove-Item\b/);
  });

  it("keeps staging coverage complete when displayed findings are truncated", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(
        [
          "package.json",
          "cli/releaseGate.ts",
          "docs/production-readiness.md",
          "server/index.ts",
          "dist/index.html"
        ],
        [
          "?? scripts/releaseEvidencePackContractCheck.ts",
          "?? scripts/releaseEvidencePackContractCheck.test.ts",
          "?? scripts/sourceProviderEvidenceCollect.ts",
          "?? cli/newReleaseCommand.ts",
          "?? server/newReleaseHandler.ts",
          "?? worker/newReleaseWorker.ts",
          " M package.json",
          " M cli/releaseGate.ts",
          " M docs/production-readiness.md",
          " M server/index.ts",
          " M dist/index.html",
          "?? evidence/release-abc/raw.json",
          "?? .env.local",
          "?? release-commit-readiness-plan.local.json"
        ]
      ),
      maxFindings: 2,
      now
    });
    const suggestedPathspecs = result.suggestedStagingGroups.flatMap((group) => group.pathspecs);

    expect(result.status).toBe("blocked");
    expect(result.criticalUntracked).toMatchObject({
      total: 3,
      returned: 2,
      truncated: true
    });
    expect(result.untrackedSource).toMatchObject({
      total: 3,
      returned: 2,
      truncated: true
    });
    expect(result.trackedDirtySource).toMatchObject({
      total: 4,
      returned: 2,
      truncated: true
    });
    expect(result.stagingCoverage).toEqual({
      covered: true,
      requiredPathCount: 10,
      coveredRequiredPathCount: 10,
      suggestedPathspecCount: 10,
      missingRequiredPaths: [],
      excludedSuggestedPathspecs: []
    });
    expect(suggestedPathspecs).toEqual(expect.arrayContaining([
      "scripts/releaseEvidencePackContractCheck.ts",
      "scripts/releaseEvidencePackContractCheck.test.ts",
      "scripts/sourceProviderEvidenceCollect.ts",
      "cli/newReleaseCommand.ts",
      "server/newReleaseHandler.ts",
      "worker/newReleaseWorker.ts",
      "package.json",
      "cli/releaseGate.ts",
      "docs/production-readiness.md",
      "server/index.ts"
    ]));
    expect(suggestedPathspecs).not.toEqual(expect.arrayContaining([
      "dist/index.html",
      "evidence/release-abc/raw.json",
      ".env.local",
      "release-commit-readiness-plan.local.json"
    ]));

    const checklist = formatReleaseCommitReviewChecklist(result);
    expect(checklist).toContain("Required paths covered by suggested pathspecs: yes (10/10)");
    expect(checklist).toContain("Path count: 2");
    expect(checklist).toContain("Review diff stats:\n```sh\ngit diff --stat -- scripts/releaseEvidencePackContractCheck.test.ts scripts/releaseEvidencePackContractCheck.ts\n```");
    expect(checklist).toContain("Review full tracked diffs:\n```sh\ngit diff -- scripts/releaseEvidencePackContractCheck.test.ts scripts/releaseEvidencePackContractCheck.ts\n```");
    expect(checklist).toContain("Review diff stats:\n```sh\ngit diff --stat -- scripts/sourceProviderEvidenceCollect.ts\n```");
    expect(checklist).not.toContain("git \"diff\"");
    expect(checklist).not.toContain("git diff \"--stat\"");
    expect(checklist).toContain("`scripts/sourceProviderEvidenceCollect.ts`");
    expect(checklist).toContain("`worker/newReleaseWorker.ts`");
    expect(checklist).toContain("For untracked paths, open the file contents directly before staging");
    expect(checklist).toContain("After creating the release-readiness commit on a clean checkout");
  });

  it("keeps generated release source policy pathspecs aligned with readiness exclusions and ignore files", async () => {
    const result = await runReleaseCommitReadinessPlan({
      commandRunner: runner(["package.json"], []),
      now
    });
    const gitignore = await readFile(path.resolve(process.cwd(), ".gitignore"), "utf8");
    const dockerignore = await readFile(path.resolve(process.cwd(), ".dockerignore"), "utf8");
    const gitignoreLines = gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const dockerignoreLines = dockerignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const generatedPathspecs = [
      "evidence/",
      ".vite/",
      "release-commit-readiness-plan*.json",
      "npm-debug.log*"
    ];

    expect(result.excludedFromStaging).toEqual(releaseSourceTreeForbiddenPathspecs());
    expect(result.policy).toEqual(releaseSourceTreePolicyDetails());
    expect(result.excludedFromStaging).toEqual(expect.arrayContaining(generatedPathspecs));
    expect(gitignoreLines).toEqual(expect.arrayContaining(generatedPathspecs));
    expect(dockerignoreLines).toEqual(expect.arrayContaining([
      "evidence",
      ".vite",
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
      reviewChecklist: false,
      maxFindings: 2,
      json: true,
      failOnBlocked: true,
      help: false
    });

    expect(parseReleaseCommitReadinessPlanArgs([
      "--review-checklist",
      "--review-checklist-output", "review.md"
    ])).toEqual({
      reviewChecklist: true,
      reviewChecklistOutputPath: "review.md",
      json: false,
      failOnBlocked: false,
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

  it("emits a Markdown review checklist without staging files", async () => {
    let stdout = "";
    const exitCode = await runReleaseCommitReadinessPlanCli(["--review-checklist"], {
      stdout: { write: (value: string) => { stdout += value; return true; } },
      stderr: { write: () => true }
    }, {
      commandRunner: runner(["package.json"], ["?? scripts/releaseEvidenceBundleCompose.ts"]),
      now
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("# SiteFlow Release Commit Review Checklist");
    expect(stdout).toContain("This checklist is read-only");
    expect(stdout).toContain("Review diff stats:\n```sh\ngit diff --stat -- scripts/releaseEvidenceBundleCompose.ts\n```");
    expect(stdout).toContain("Stage only after review:\n```sh\ngit add -- scripts/releaseEvidenceBundleCompose.ts\n```");
  });

  it("rejects JSON stdout mixed with a review checklist unless an output file is provided", async () => {
    let stderr = "";
    const exitCode = await runReleaseCommitReadinessPlanCli(["--json", "--review-checklist"], {
      stdout: { write: () => true },
      stderr: { write: (value: string) => { stderr += value; return true; } }
    }, {
      commandRunner: runner(["package.json"], ["?? scripts/releaseEvidenceBundleCompose.ts"]),
      now
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--review-checklist cannot be combined with --json");
    expect(stderr).toContain("--review-checklist-output");
  });

  it("keeps JSON stdout parseable when writing a review checklist to a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-review-checklist-"));

    try {
      let stdout = "";
      const exitCode = await runReleaseCommitReadinessPlanCli([
        "--root", root,
        "--json",
        "--review-checklist-output", "review.md"
      ], {
        stdout: { write: (value: string) => { stdout += value; return true; } },
        stderr: { write: () => true }
      }, {
        commandRunner: runner(["package.json"], ["?? scripts/releaseEvidenceBundleCompose.ts"]),
        now
      });
      const json = JSON.parse(stdout);
      const checklist = await readFile(path.join(root, "review.md"), "utf8");

      expect(exitCode).toBe(0);
      expect(json).toMatchObject({
        name: "siteflow-release-commit-readiness-plan",
        status: "blocked"
      });
      expect(stdout).not.toContain("# SiteFlow Release Commit Review Checklist");
      expect(checklist).toContain("# SiteFlow Release Commit Review Checklist");
      expect(checklist).toContain("Review diff stats:\n```sh\ngit diff --stat -- scripts/releaseEvidenceBundleCompose.ts\n```");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
