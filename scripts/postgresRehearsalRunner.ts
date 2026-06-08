import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PrerequisiteStatus = "passed" | "failed" | "skipped";
type RehearsalStatus = "blocked" | "dry_run" | "passed" | "failed";
type CommandStdio = "inherit" | "pipe";
type ScenarioStatus = "passed" | "failed";
type ScenarioScalar = string | number | boolean | null;

export interface CommandRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: CommandStdio;
}

export interface CommandRunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions
) => Promise<CommandRunResult>;

export interface PostgresRehearsalOptions {
  dryRun?: boolean;
  json?: boolean;
  checkDocker?: boolean;
  requireDocker?: boolean;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  now?: () => Date;
}

export interface PrerequisiteCheck {
  name: string;
  required: boolean;
  status: PrerequisiteStatus;
  message: string;
}

export interface RehearsalCommand {
  executable: string;
  args: string[];
  display: string;
}

export interface TargetDatabaseEvidence {
  redactedUrl: string;
  host?: string;
  port?: string;
  database?: string;
  sslMode?: string;
  parseStatus: "passed" | "failed";
}

export interface PostgresRehearsalReleaseEvidence {
  commitRef?: string;
  repository?: string;
  branch?: string;
  targetEnvironment?: string;
}

export interface PostgresRehearsalScenarioResult {
  scope: string;
  status: ScenarioStatus;
  recordedAt?: string;
  assertions?: Record<string, ScenarioScalar>;
  metrics?: Record<string, ScenarioScalar>;
  message?: string;
}

export interface PostgresRehearsalScenarioValidation {
  status: "passed" | "failed";
  requiredScopes: string[];
  missingScopes: string[];
  failedScopes: string[];
  message: string;
}

export interface PostgresRehearsalResult {
  name: "siteflow-postgres-rehearsal";
  status: RehearsalStatus;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  release?: PostgresRehearsalReleaseEvidence;
  targetDatabase?: TargetDatabaseEvidence;
  rehearsalScope: string[];
  scenarioResults?: PostgresRehearsalScenarioResult[];
  scenarioValidation?: PostgresRehearsalScenarioValidation;
  prerequisites: PrerequisiteCheck[];
  command: RehearsalCommand;
  exitCode: number;
  commandResult?: CommandRunResult;
}

interface ParsedArgs {
  dryRun: boolean;
  json: boolean;
  checkDocker: boolean;
  requireDocker: boolean;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const rehearsalTestPath = "worker/postgresRehearsal.integration.test.ts";
const postgresRehearsalScope = [
  "migration_advisory_lock",
  "migration_checksum_drift",
  "concurrent_migration_startup",
  "skip_locked_claim",
  "concurrent_worker_claim",
  "lease_heartbeat",
  "stale_lease_recovery",
  "exhausted_lease_failure"
];

function hasValue(value: string | undefined) {
  return Boolean(value?.trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeOptional(value: string | undefined) {
  return hasValue(value) ? value!.trim() : undefined;
}

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function npxExecutable(platform = process.platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

function makeRehearsalCommand(): RehearsalCommand {
  const args = ["vitest", "run", rehearsalTestPath];

  return {
    executable: npxExecutable(),
    args,
    display: `npx ${args.join(" ")}`
  };
}

function safeSearch(searchParams: URLSearchParams) {
  const safeParams = new URLSearchParams();

  for (const [key, value] of searchParams.entries()) {
    safeParams.set(key, /password|passwd|pwd|token|secret|key/i.test(key) ? "[REDACTED]" : value);
  }

  const serialized = safeParams.toString();
  return serialized ? `?${serialized}` : "";
}

function targetDatabaseEvidence(databaseUrl: string | undefined): TargetDatabaseEvidence | undefined {
  if (!hasValue(databaseUrl)) {
    return undefined;
  }

  try {
    const parsed = new URL(databaseUrl!);
    const database = parsed.pathname.replace(/^\//, "") || undefined;
    const sslMode = parsed.searchParams.get("sslmode") ?? undefined;

    return {
      redactedUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}${safeSearch(parsed.searchParams)}`,
      host: parsed.hostname || undefined,
      port: parsed.port || undefined,
      database,
      sslMode,
      parseStatus: parsed.protocol === "postgres:" || parsed.protocol === "postgresql:" ? "passed" : "failed"
    };
  } catch {
    return {
      redactedUrl: "<invalid-postgres-url>",
      parseStatus: "failed"
    };
  }
}

function releaseEvidence(options: PostgresRehearsalOptions): PostgresRehearsalReleaseEvidence | undefined {
  const release: PostgresRehearsalReleaseEvidence = {
    commitRef: normalizeOptional(options.commitRef),
    repository: normalizeOptional(options.repo),
    branch: normalizeOptional(options.branch),
    targetEnvironment: normalizeOptional(options.targetEnvironment)
  };
  const present = Object.fromEntries(
    Object.entries(release).filter(([, value]) => value !== undefined)
  ) as PostgresRehearsalReleaseEvidence;

  return Object.keys(present).length > 0 ? present : undefined;
}

function requiredOptionValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!hasValue(value) || value?.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parsePostgresRehearsalArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    json: false,
    checkDocker: false,
    requireDocker: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--check-docker") {
      parsed.checkDocker = true;
    } else if (arg === "--require-docker") {
      parsed.requireDocker = true;
      parsed.checkDocker = true;
    } else if (arg === "--commit-ref") {
      parsed.commitRef = requiredOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = requiredOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = requiredOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = requiredOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

export function postgresRehearsalUsage() {
  return [
    "Usage: npm run --silent rehearsal:postgres -- [--dry-run] [--json] [--check-docker|--require-docker] [--commit-ref <sha> --repo <owner/repo> --branch <branch>]",
    "",
    "Required environment:",
    "  SITEFLOW_RUN_POSTGRES_INTEGRATION=1",
    "  TEST_DATABASE_URL=<target-or-disposable-postgres-url>",
    "",
    "Options:",
    "  --dry-run          Check prerequisites and print the command without running Vitest.",
    "  --json             Emit a single JSON evidence object.",
    "  --check-docker     Check Docker CLI availability without making it required.",
    "  --require-docker   Fail before Vitest if Docker CLI is unavailable.",
    "  --commit-ref <sha> Bind evidence to a release commit.",
    "  --repo <owner/repo> Bind evidence to a release repository.",
    "  --branch <branch>  Bind evidence to a release branch.",
    "  --target-environment <name> Bind evidence to a target environment label.",
    "  --help             Show this help."
  ].join("\n");
}

export async function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandRunOptions
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    if (options.stdio === "pipe") {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr,
        errorMessage: error.message
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: options.stdio === "pipe" ? stdout : undefined,
        stderr: options.stdio === "pipe" ? stderr : undefined
      });
    });
  });
}

async function checkDockerAvailability(
  runner: CommandRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
  required: boolean
): Promise<PrerequisiteCheck> {
  const result = await runner("docker", ["--version"], { cwd, env, stdio: "pipe" });

  if (result.exitCode === 0) {
    return {
      name: "docker",
      required,
      status: "passed",
      message: "Docker CLI is available."
    };
  }

  return {
    name: "docker",
    required,
    status: required ? "failed" : "skipped",
    message: required
      ? "Docker CLI is required for this rehearsal but is not available."
      : "Docker CLI is not available; continuing because external Postgres rehearsal does not require local Docker."
  };
}

async function evaluatePrerequisites(
  options: Required<Pick<PostgresRehearsalOptions, "checkDocker" | "requireDocker">> & {
    cwd: string;
    env: NodeJS.ProcessEnv;
    commandRunner: CommandRunner;
  }
) {
  const checks: PrerequisiteCheck[] = [];

  checks.push({
    name: "SITEFLOW_RUN_POSTGRES_INTEGRATION",
    required: true,
    status: options.env.SITEFLOW_RUN_POSTGRES_INTEGRATION === "1" ? "passed" : "failed",
    message:
      options.env.SITEFLOW_RUN_POSTGRES_INTEGRATION === "1"
        ? "SITEFLOW_RUN_POSTGRES_INTEGRATION is set to 1."
        : 'SITEFLOW_RUN_POSTGRES_INTEGRATION must be set to "1" to opt in to the real Postgres rehearsal.'
  });

  checks.push({
    name: "TEST_DATABASE_URL",
    required: true,
    status: hasValue(options.env.TEST_DATABASE_URL) ? "passed" : "failed",
    message: hasValue(options.env.TEST_DATABASE_URL)
      ? "TEST_DATABASE_URL is present."
      : "TEST_DATABASE_URL is required and must point at a target-equivalent or disposable Postgres database."
  });

  const targetDatabase = targetDatabaseEvidence(options.env.TEST_DATABASE_URL);
  checks.push({
    name: "TEST_DATABASE_URL_FORMAT",
    required: true,
    status: targetDatabase ? targetDatabase.parseStatus : "skipped",
    message: targetDatabase?.parseStatus === "passed"
      ? "TEST_DATABASE_URL parses as a Postgres connection URL."
      : "TEST_DATABASE_URL must parse as a postgres:// or postgresql:// connection URL."
  });

  if (options.checkDocker || options.requireDocker) {
    checks.push(
      await checkDockerAvailability(options.commandRunner, options.cwd, options.env, options.requireDocker)
    );
  } else {
    checks.push({
      name: "docker",
      required: false,
      status: "skipped",
      message: "Docker CLI was not checked. Use --check-docker or --require-docker for local Docker rehearsal evidence."
    });
  }

  return checks;
}

function hasBlockingPrerequisite(checks: PrerequisiteCheck[]) {
  return checks.some((check) => check.required && check.status === "failed");
}

function scalarRecord(value: unknown): Record<string, ScenarioScalar> | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, ScenarioScalar] => (
    typeof entry[0] === "string" && (
      typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean" ||
        entry[1] === null
    )
  ));

  return Object.fromEntries(entries);
}

function scenarioResult(value: unknown): PostgresRehearsalScenarioResult | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const scope = typeof value.scope === "string" && value.scope.trim() ? value.scope.trim() : undefined;
  const status = value.status === "passed" || value.status === "failed" ? value.status : undefined;

  if (!scope || !status) {
    return undefined;
  }

  return {
    scope,
    status,
    ...(typeof value.recordedAt === "string" && value.recordedAt.trim() ? { recordedAt: value.recordedAt.trim() } : {}),
    ...(scalarRecord(value.assertions) ? { assertions: scalarRecord(value.assertions) } : {}),
    ...(scalarRecord(value.metrics) ? { metrics: scalarRecord(value.metrics) } : {}),
    ...(typeof value.message === "string" && value.message.trim() ? { message: value.message.trim() } : {})
  };
}

async function readScenarioResults(evidencePath: string): Promise<PostgresRehearsalScenarioResult[]> {
  const raw = await readFile(evidencePath, "utf8");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const results: PostgresRehearsalScenarioResult[] = [];

  for (const line of lines) {
    const parsed = scenarioResult(JSON.parse(line));

    if (!parsed) {
      throw new Error("Scenario evidence contains an invalid result entry.");
    }

    results.push(parsed);
  }

  return results;
}

function validateScenarioResults(results: PostgresRehearsalScenarioResult[]): PostgresRehearsalScenarioValidation {
  const passedScopes = new Set(
    results
      .filter((result) => result.status === "passed")
      .map((result) => result.scope)
  );
  const failedScopes = [
    ...new Set(
      results
        .filter((result) => result.status === "failed")
        .map((result) => result.scope)
    )
  ].filter((scope) => postgresRehearsalScope.includes(scope));
  const missingScopes = postgresRehearsalScope.filter((scope) => !passedScopes.has(scope));
  const passed = missingScopes.length === 0 && failedScopes.length === 0;

  return {
    status: passed ? "passed" : "failed",
    requiredScopes: postgresRehearsalScope,
    missingScopes,
    failedScopes,
    message: passed
      ? "All required Postgres rehearsal scenarios recorded passed evidence."
      : "Postgres rehearsal scenario evidence is missing required passed scenarios or contains failed scenarios."
  };
}

export async function runPostgresRehearsal(
  options: PostgresRehearsalOptions = {}
): Promise<PostgresRehearsalResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const command = makeRehearsalCommand();
  const dryRun = Boolean(options.dryRun);
  const targetDatabase = targetDatabaseEvidence(env.TEST_DATABASE_URL);
  const release = releaseEvidence(options);
  const prerequisites = await evaluatePrerequisites({
    checkDocker: Boolean(options.checkDocker),
    requireDocker: Boolean(options.requireDocker),
    cwd,
    env,
    commandRunner
  });

  if (hasBlockingPrerequisite(prerequisites)) {
    return {
      name: "siteflow-postgres-rehearsal",
      status: "blocked",
      dryRun,
      startedAt,
      completedAt: now().toISOString(),
      ...(release ? { release } : {}),
      targetDatabase,
      rehearsalScope: postgresRehearsalScope,
      prerequisites,
      command,
      exitCode: 1
    };
  }

  if (dryRun) {
    return {
      name: "siteflow-postgres-rehearsal",
      status: "dry_run",
      dryRun,
      startedAt,
      completedAt: now().toISOString(),
      ...(release ? { release } : {}),
      targetDatabase,
      rehearsalScope: postgresRehearsalScope,
      prerequisites,
      command,
      exitCode: 0
    };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-rehearsal-"));
  const scenarioEvidencePath = path.join(tempDir, "scenario-results.jsonl");

  try {
    const commandResult = await commandRunner(command.executable, command.args, {
      cwd,
      env: {
        ...env,
        SITEFLOW_POSTGRES_REHEARSAL_EVIDENCE_PATH: scenarioEvidencePath
      },
      stdio: options.json ? "pipe" : "inherit"
    });
    let scenarioResults: PostgresRehearsalScenarioResult[] | undefined;
    let scenarioValidation: PostgresRehearsalScenarioValidation | undefined;

    try {
      scenarioResults = await readScenarioResults(scenarioEvidencePath);
      scenarioValidation = validateScenarioResults(scenarioResults);
    } catch (error) {
      if (commandResult.exitCode === 0) {
        scenarioResults = [];
        scenarioValidation = {
          status: "failed",
          requiredScopes: postgresRehearsalScope,
          missingScopes: postgresRehearsalScope,
          failedScopes: [],
          message: error instanceof Error
            ? `Postgres rehearsal scenario evidence could not be read: ${error.message}`
            : "Postgres rehearsal scenario evidence could not be read."
        };
      }
    }

    const commandExitCode = commandResult.exitCode === 0 ? 0 : commandResult.exitCode || 1;
    const exitCode = commandExitCode === 0 && scenarioValidation?.status !== "passed" ? 1 : commandExitCode;

    return {
      name: "siteflow-postgres-rehearsal",
      status: exitCode === 0 ? "passed" : "failed",
      dryRun,
      startedAt,
      completedAt: now().toISOString(),
      ...(release ? { release } : {}),
      targetDatabase,
      rehearsalScope: postgresRehearsalScope,
      ...(scenarioResults ? { scenarioResults } : {}),
      ...(scenarioValidation ? { scenarioValidation } : {}),
      prerequisites,
      command,
      exitCode,
      commandResult
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function writeHumanResult(result: PostgresRehearsalResult, io: CliIo) {
  const output = result.status === "blocked" || result.status === "failed" ? io.stderr : io.stdout;

  output.write(`SiteFlow Postgres rehearsal status: ${result.status}\n`);
  output.write("Prerequisites:\n");

  for (const check of result.prerequisites) {
    output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
  }

  output.write(`Command: ${result.command.display}\n`);

  if (result.status === "dry_run") {
    output.write("Dry run only; Vitest was not executed.\n");
  } else if (result.status === "blocked") {
    output.write("Rehearsal was not executed because required prerequisites failed.\n");
  } else if (result.status === "failed") {
    output.write(`Rehearsal command exited with ${result.exitCode}.\n`);
  }
}

export async function runPostgresRehearsalCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: PostgresRehearsalOptions = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parsePostgresRehearsalArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${postgresRehearsalUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${postgresRehearsalUsage()}\n`);
    return 0;
  }

  const result = await runPostgresRehearsal({
    ...baseOptions,
    dryRun: parsed.dryRun,
    json: parsed.json,
    checkDocker: parsed.checkDocker,
    requireDocker: parsed.requireDocker,
    commitRef: parsed.commitRef,
    repo: parsed.repo,
    branch: parsed.branch,
    targetEnvironment: parsed.targetEnvironment
  });

  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, io);
  }

  return result.exitCode;
}

if (isEntrypoint()) {
  runPostgresRehearsalCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
