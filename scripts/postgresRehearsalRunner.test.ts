import { appendFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  runPostgresRehearsal,
  runPostgresRehearsalCli
} from "./postgresRehearsalRunner";

function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SITEFLOW_RUN_POSTGRES_INTEGRATION: "1",
    TEST_DATABASE_URL: "postgres://siteflow:super-secret-password@localhost:5432/siteflow_rehearsal?sslmode=require&password=leaked",
    ...overrides
  };
}

function makeRunner(exitCode = 0) {
  return vi.fn<CommandRunner>(async () => ({ exitCode, stdout: "", stderr: "" }));
}

const postgresScenarioScopes = [
  "migration_advisory_lock",
  "migration_checksum_drift",
  "concurrent_migration_startup",
  "skip_locked_claim",
  "concurrent_worker_claim",
  "lease_heartbeat",
  "stale_lease_recovery",
  "exhausted_lease_failure"
];

function makeScenarioRunner(scopes = postgresScenarioScopes, exitCode = 0) {
  return vi.fn<CommandRunner>(async (_command, _args, options) => {
    const evidencePath = options.env.SITEFLOW_POSTGRES_REHEARSAL_EVIDENCE_PATH;

    if (evidencePath) {
      for (const scope of scopes) {
        await appendFile(
          evidencePath,
          `${JSON.stringify({
            scope,
            status: "passed",
            recordedAt: "2026-06-08T11:30:00.000Z",
            assertions: {
              exercised: true
            },
            metrics: {
              durationMs: 1
            }
          })}\n`,
          "utf8"
        );
      }
    }

    return { exitCode, stdout: "", stderr: "" };
  });
}

describe("postgresRehearsalRunner", () => {
  it("blocks without the opt-in environment and database URL", async () => {
    const commandRunner = makeRunner();

    const result = await runPostgresRehearsal({
      env: {},
      commandRunner
    });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "SITEFLOW_RUN_POSTGRES_INTEGRATION",
          status: "failed"
        }),
        expect.objectContaining({
          name: "TEST_DATABASE_URL",
          status: "failed"
        })
      ])
    );
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("checks prerequisites but does not invoke Vitest during dry run", async () => {
    const commandRunner = makeRunner();

    const result = await runPostgresRehearsal({
      dryRun: true,
      env: makeEnv(),
      commandRunner,
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production"
    });

    expect(result.status).toBe("dry_run");
    expect(result.exitCode).toBe(0);
    expect(result.release).toEqual({
      commitRef: "abc123def456",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production"
    });
    expect(result.targetDatabase).toMatchObject({
      redactedUrl: "postgres://localhost:5432/siteflow_rehearsal?sslmode=require&password=%5BREDACTED%5D",
      host: "localhost",
      port: "5432",
      database: "siteflow_rehearsal",
      sslMode: "require",
      parseStatus: "passed"
    });
    expect(result.rehearsalScope).toEqual(
      expect.arrayContaining([
        "migration_advisory_lock",
        "migration_checksum_drift",
        "concurrent_migration_startup",
        "skip_locked_claim",
        "concurrent_worker_claim",
        "lease_heartbeat",
        "stale_lease_recovery",
        "exhausted_lease_failure"
      ])
    );
    expect(result.command.display).toBe("npx vitest run worker/postgresRehearsal.integration.test.ts");
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("emits a single JSON evidence object for dry runs", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runPostgresRehearsalCli(
      [
        "--dry-run",
        "--json",
        "--commit-ref", "abc123def456",
        "--repo", "acme/siteflow",
        "--branch", "main",
        "--target-environment", "production"
      ],
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      },
      {
        env: makeEnv(),
        commandRunner: makeRunner()
      }
    );

    const parsed = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(parsed).toMatchObject({
      name: "siteflow-postgres-rehearsal",
      status: "dry_run",
      dryRun: true,
      exitCode: 0,
      release: {
        commitRef: "abc123def456",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production"
      },
      command: {
        display: "npx vitest run worker/postgresRehearsal.integration.test.ts"
      },
      targetDatabase: {
        redactedUrl: "postgres://localhost:5432/siteflow_rehearsal?sslmode=require&password=%5BREDACTED%5D"
      }
    });
    expect(stdout).not.toContain("super-secret-password");
    expect(stdout).not.toContain("leaked");
    expect(parsed.prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "TEST_DATABASE_URL",
          status: "passed"
        }),
        expect.objectContaining({
          name: "TEST_DATABASE_URL_FORMAT",
          status: "passed"
        })
      ])
    );
  });

  it("invokes the existing Postgres rehearsal Vitest file when prerequisites pass", async () => {
    const commandRunner = makeScenarioRunner();

    const result = await runPostgresRehearsal({
      env: makeEnv(),
      commandRunner
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.scenarioResults).toHaveLength(8);
    expect(result.scenarioValidation).toMatchObject({
      status: "passed",
      missingScopes: [],
      failedScopes: []
    });
    expect(commandRunner).toHaveBeenCalledOnce();
    expect(commandRunner).toHaveBeenCalledWith(
      expect.stringMatching(/^npx(\.cmd)?$/),
      ["vitest", "run", "worker/postgresRehearsal.integration.test.ts"],
      expect.objectContaining({
        env: expect.objectContaining({
          SITEFLOW_POSTGRES_REHEARSAL_EVIDENCE_PATH: expect.stringContaining("scenario-results.jsonl")
        }),
        stdio: "inherit"
      })
    );
  });

  it("fails when Vitest passes but scenario evidence is incomplete", async () => {
    const commandRunner = makeScenarioRunner(postgresScenarioScopes.slice(0, -1));

    const result = await runPostgresRehearsal({
      env: makeEnv(),
      commandRunner
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.commandResult?.exitCode).toBe(0);
    expect(result.scenarioValidation).toMatchObject({
      status: "failed",
      missingScopes: ["exhausted_lease_failure"]
    });
  });

  it("fails before Vitest when Docker is required but unavailable", async () => {
    const commandRunner = vi.fn<CommandRunner>(async (command) => ({
      exitCode: command === "docker" ? 1 : 0,
      stderr: command === "docker" ? "docker not found" : "",
      stdout: ""
    }));

    const result = await runPostgresRehearsal({
      requireDocker: true,
      env: makeEnv(),
      commandRunner
    });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBe(1);
    expect(result.prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker",
          required: true,
          status: "failed"
        })
      ])
    );
    expect(commandRunner).toHaveBeenCalledOnce();
    expect(commandRunner).toHaveBeenCalledWith(
      "docker",
      ["--version"],
      expect.objectContaining({ stdio: "pipe" })
    );
  });
});
