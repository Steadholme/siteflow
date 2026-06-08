import {
  parseReleaseSourceTreeCheckArgs,
  runReleaseSourceTreeCheck,
  runReleaseSourceTreeCheckCli,
  type ReleaseSourceTreeCommandRunner
} from "./releaseSourceTreeCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function runner(stdout: string, exitCode = 0): ReleaseSourceTreeCommandRunner {
  return async (command, args) => {
    expect(command).toBe("git");
    expect(args).toEqual(["ls-files"]);

    return {
      exitCode,
      stdout,
      stderr: exitCode === 0 ? "" : "not a git repository"
    };
  };
}

describe("releaseSourceTreeCheck", () => {
  it("passes when tracked source excludes generated, dependency, secret, and scratch paths", async () => {
    const result = await runReleaseSourceTreeCheck({
      commandRunner: runner([
        "package.json",
        ".env.example",
        "src/main.tsx",
        "server/index.ts",
        "worker/index.ts"
      ].join("\n")),
      now
    });

    expect(result).toMatchObject({
      name: "siteflow-release-source-tree-check",
      status: "passed",
      checkedAt: "2026-06-08T12:00:00.000Z",
      selectedEvidence: {
        trackedPathCount: 5,
        forbiddenPathCount: 0
      },
      exitCode: 0
    });
    expect(result.checks[0]).toMatchObject({
      name: "tracked_release_source_paths",
      status: "pass"
    });
  });

  it("blocks tracked generated, dependency, env, manifest, and workflow scratch paths", async () => {
    const result = await runReleaseSourceTreeCheck({
      commandRunner: runner([
        "src/main.tsx",
        "node_modules/react/index.js",
        "dist/index.html",
        "dist-cli/cli/index.js",
        "dist-server/server/index.js",
        "dist-worker/worker/index.js",
        ".env.production",
        "release-artifact-manifest.local.json",
        "release-image-evidence.json",
        "release-evidence.json",
        "release-post-promotion-evidence.json",
        "release-source-cleanup-plan.json",
        "release-commit-readiness-plan.json",
        "evidence/release-abc/release-evidence.json",
        ".vite/deps/react.js",
        "npm-debug.log.1",
        ".workflow/session.json"
      ].join("\n")),
      maxFindings: 3,
      now
    });
    const details = result.checks[0].details as {
      forbiddenPaths: Array<{ path: string; reason: string }>;
      truncated: boolean;
      total: number;
    };

    expect(result.status).toBe("blocked");
    expect(result.selectedEvidence.forbiddenPathCount).toBe(16);
    expect(result.exitCode).toBe(1);
    expect(details.forbiddenPaths).toHaveLength(3);
    expect(details.forbiddenPaths[0]).toMatchObject({
      path: "node_modules/react/index.js",
      reason: "dependency installs must be reconstructed by npm ci"
    });
    expect(details.truncated).toBe(true);
    expect(details.total).toBe(16);
  });

  it("allows the documented env example while blocking real env files", async () => {
    const result = await runReleaseSourceTreeCheck({
      commandRunner: runner([
        ".env.example",
        ".env.local",
        ".env.production"
      ].join("\n")),
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.selectedEvidence).toMatchObject({
      trackedPathCount: 3,
      forbiddenPathCount: 2
    });
    expect(result.checks[0].details).toMatchObject({
      forbiddenPaths: [
        expect.objectContaining({ path: ".env.local" }),
        expect.objectContaining({ path: ".env.production" })
      ]
    });
  });

  it("requires manual verification when git ls-files cannot run", async () => {
    const result = await runReleaseSourceTreeCheck({
      commandRunner: runner("", 128),
      now
    });

    expect(result.status).toBe("manual_required");
    expect(result.selectedEvidence).toMatchObject({
      trackedPathCount: null,
      forbiddenPathCount: null
    });
    expect(result.checks[0]).toMatchObject({
      status: "manual_required",
      message: "not a git repository"
    });
    expect(result.exitCode).toBe(1);
  });

  it("parses CLI arguments", () => {
    expect(parseReleaseSourceTreeCheckArgs(["--root", "repo", "--max-findings", "5", "--json"])).toEqual({
      rootDir: "repo",
      maxFindings: 5,
      json: true,
      help: false
    });
  });

  it("returns usage errors for invalid CLI arguments", async () => {
    let stderr = "";
    const exitCode = await runReleaseSourceTreeCheckCli(
      ["--max-findings", "0"],
      {
        stdout: { write: () => true },
        stderr: { write: (value: string) => { stderr += value; return true; } }
      },
      { commandRunner: runner("") }
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--max-findings requires a positive integer");
    expect(stderr).toContain("release:source:check");
  });
});
