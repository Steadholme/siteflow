import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReleaseSourceCleanupPlanArgs,
  runReleaseSourceCleanupPlan,
  runReleaseSourceCleanupPlanCli,
  type ReleaseSourceCleanupPlanCommandRunner
} from "./releaseSourceCleanupPlan";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function runner(files: string[]): ReleaseSourceCleanupPlanCommandRunner {
  return async (command, args) => {
    expect(command).toBe("git");
    expect(args).toEqual(["ls-files"]);

    return {
      exitCode: 0,
      stdout: files.join("\n"),
      stderr: ""
    };
  };
}

describe("releaseSourceCleanupPlan", () => {
  it("reports blocked forbidden tracked paths and recommends reviewed index-only cleanup", async () => {
    const result = await runReleaseSourceCleanupPlan({
      commandRunner: runner([
        "src/main.tsx",
        "node_modules/react/index.js",
        "dist\\index.html",
        ".workflow/session.json",
        "test-results/release.zip"
      ]),
      now
    });

    expect(result).toMatchObject({
      name: "siteflow-release-source-cleanup-plan",
      status: "blocked",
      checkedAt: "2026-06-08T12:00:00.000Z",
      trackedPathCount: 5,
      forbiddenPathCount: 4,
      errors: [],
      exitCode: 0
    });
    expect(result.forbiddenRoots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        root: "node_modules",
        count: 1,
        samplePaths: ["node_modules/react/index.js"]
      }),
      expect.objectContaining({
        root: "dist",
        count: 1,
        samplePaths: ["dist/index.html"]
      }),
      expect.objectContaining({
        root: ".workflow",
        count: 1
      })
    ]));
    expect(result.forbiddenPaths).toMatchObject({
      total: 4,
      returned: 4,
      truncated: false
    });
    expect(result.recommendedCommands.map((command) => command.display)).toContain(
      "git rm --cached -r -- .workflow dist dist-cli dist-server dist-worker node_modules test-results"
    );
    expect(result.recommendedCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "matched-forbidden-paths",
        modifiesGitIndex: true,
        removesWorkingTreeFiles: false,
        requiresReview: true
      })
    ]));
    expect(result.warnings.join("\n")).toContain("human review");
    expect(result.warnings.join("\n")).toContain("working tree files");
  });

  it("reports pass when no forbidden path is tracked", async () => {
    const result = await runReleaseSourceCleanupPlan({
      commandRunner: runner(["package.json", "src/main.tsx"]),
      now
    });

    expect(result.status).toBe("pass");
    expect(result.trackedPathCount).toBe(2);
    expect(result.forbiddenPathCount).toBe(0);
    expect(result.forbiddenRoots).toEqual([]);
    expect(result.forbiddenPaths).toMatchObject({
      total: 0,
      returned: 0,
      truncated: false,
      paths: []
    });
    expect(result.recommendedCommands).toEqual([]);
  });

  it("does not recommend destructive working-tree delete commands", async () => {
    const result = await runReleaseSourceCleanupPlan({
      commandRunner: runner(["dist/index.html", "node_modules/react/index.js"]),
      now
    });
    const serializedCommands = JSON.stringify(result.recommendedCommands);

    expect(serializedCommands).not.toMatch(/\bgit clean\b/);
    expect(serializedCommands).not.toMatch(/\bgit reset\b/);
    expect(serializedCommands).not.toMatch(/\bgit checkout\b/);
    expect(serializedCommands).not.toMatch(/\brm -rf\b/);
    expect(serializedCommands).not.toMatch(/\bRemove-Item\b/);
    for (const command of result.recommendedCommands) {
      expect(command.removesWorkingTreeFiles).toBe(false);
      expect(command.args).toContain("--cached");
    }
  });

  it("truncates max-findings output while retaining total counts", async () => {
    const result = await runReleaseSourceCleanupPlan({
      commandRunner: runner([
        "dist/a.js",
        "dist/b.js",
        "dist/c.js",
        "test-results/a.zip"
      ]),
      maxFindings: 2,
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.forbiddenPathCount).toBe(4);
    expect(result.forbiddenPaths).toMatchObject({
      total: 4,
      returned: 2,
      truncated: true,
      paths: [
        { path: "dist/a.js" },
        { path: "dist/b.js" }
      ]
    });
    expect(result.forbiddenRoots.find((root) => root.root === "dist")).toMatchObject({
      count: 3,
      samplePaths: ["dist/a.js", "dist/b.js"]
    });
  });

  it("writes the cleanup plan to an output file when explicitly requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-cleanup-plan-"));

    try {
      const result = await runReleaseSourceCleanupPlan({
        rootDir: root,
        outputPath: "cleanup-plan.json",
        commandRunner: runner(["dist/index.html"]),
        now
      });
      const output = JSON.parse(await readFile(path.join(root, "cleanup-plan.json"), "utf8"));

      expect(result.outputPath).toBe(path.join(root, "cleanup-plan.json"));
      expect(output).toMatchObject({
        name: "siteflow-release-source-cleanup-plan",
        status: "blocked",
        forbiddenPathCount: 1
      });
      expect(output.recommendedCommands).toEqual(expect.arrayContaining([
        expect.objectContaining(
          {
            display: "git rm --cached -r -- .workflow dist dist-cli dist-server dist-worker node_modules test-results",
            removesWorkingTreeFiles: false
          }
        )
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses CLI arguments and returns usage errors", async () => {
    expect(parseReleaseSourceCleanupPlanArgs([
      "--root", "repo",
      "--output", "cleanup.json",
      "--max-findings", "2",
      "--json"
    ])).toEqual({
      rootDir: "repo",
      outputPath: "cleanup.json",
      maxFindings: 2,
      json: true,
      help: false
    });

    let stderr = "";
    const exitCode = await runReleaseSourceCleanupPlanCli(["--max-findings", "0"], {
      stdout: { write: () => true },
      stderr: { write: (value: string) => { stderr += value; return true; } }
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--max-findings requires a positive integer");
    expect(stderr).toContain("release:source:cleanup-plan");
  });
});
