import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findForbiddenTrackedReleasePaths,
  releaseSourceTreePolicyDetails,
  type ForbiddenTrackedReleasePathFinding
} from "../cli/releaseSourceTreePolicy.js";

type ReleaseSourceTreeStatus = "passed" | "blocked" | "manual_required";
type ReleaseSourceTreeCheckStatus = "pass" | "fail" | "manual_required";

export interface ReleaseSourceTreeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReleaseSourceTreeCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<ReleaseSourceTreeCommandResult>;

export interface ReleaseSourceTreeCheckOptions {
  rootDir?: string;
  commandRunner?: ReleaseSourceTreeCommandRunner;
  maxFindings?: number;
  now?: () => Date;
}

export interface ReleaseSourceTreeCheck {
  name: string;
  status: ReleaseSourceTreeCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReleaseSourceTreeCheckResult {
  name: "siteflow-release-source-tree-check";
  status: ReleaseSourceTreeStatus;
  checkedAt: string;
  rootDir: string;
  selectedEvidence: {
    trackedPathCount: number | null;
    forbiddenPathCount: number | null;
  };
  checks: ReleaseSourceTreeCheck[];
  exitCode: number;
}

interface ParsedArgs {
  rootDir?: string;
  json: boolean;
  help: boolean;
  maxFindings?: number;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMaxFindings = 50;

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

export const defaultReleaseSourceTreeCommandRunner: ReleaseSourceTreeCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options?.cwd, timeout: 10_000 }, (error, stdout, stderr) => {
      const commandError = error as NodeJS.ErrnoException | null;
      const exitCode = typeof commandError?.code === "number" ? Number(commandError.code) : commandError ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parsePositiveInteger(value: string, flag: string) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer.`);
  }

  return parsed;
}

function splitTrackedPaths(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function limitedFindings(findings: ForbiddenTrackedReleasePathFinding[], maxFindings: number) {
  return {
    forbiddenPaths: findings.slice(0, maxFindings),
    truncated: findings.length > maxFindings,
    total: findings.length
  };
}

export async function runReleaseSourceTreeCheck(
  options: ReleaseSourceTreeCheckOptions = {}
): Promise<ReleaseSourceTreeCheckResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const runner = options.commandRunner ?? defaultReleaseSourceTreeCommandRunner;
  const maxFindings = options.maxFindings ?? defaultMaxFindings;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const result = await runner("git", ["ls-files"], { cwd: rootDir });
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (result.exitCode !== 0) {
    return {
      name: "siteflow-release-source-tree-check",
      status: "manual_required",
      checkedAt,
      rootDir,
      selectedEvidence: {
        trackedPathCount: null,
        forbiddenPathCount: null
      },
      checks: [
        {
          name: "tracked_release_source_paths",
          status: "manual_required",
          message: output || `git ls-files exited with ${result.exitCode}; tracked source policy could not be verified.`,
          details: {
            exitCode: result.exitCode
          }
        }
      ],
      exitCode: 1
    };
  }

  const trackedPaths = splitTrackedPaths(result.stdout);
  const findings = findForbiddenTrackedReleasePaths(trackedPaths);

  if (findings.length > 0) {
    return {
      name: "siteflow-release-source-tree-check",
      status: "blocked",
      checkedAt,
      rootDir,
      selectedEvidence: {
        trackedPathCount: trackedPaths.length,
        forbiddenPathCount: findings.length
      },
      checks: [
        {
          name: "tracked_release_source_paths",
          status: "fail",
          message: `Release source tracks ${findings.length} generated, dependency, secret, or scratch path(s).`,
          details: {
            ...limitedFindings(findings, maxFindings),
            policy: releaseSourceTreePolicyDetails()
          }
        }
      ],
      exitCode: 1
    };
  }

  return {
    name: "siteflow-release-source-tree-check",
    status: "passed",
    checkedAt,
    rootDir,
    selectedEvidence: {
      trackedPathCount: trackedPaths.length,
      forbiddenPathCount: 0
    },
    checks: [
      {
        name: "tracked_release_source_paths",
        status: "pass",
        message: "Release source does not track generated build output, dependency directories, env files, or workflow scratch paths.",
        details: {
          policy: releaseSourceTreePolicyDetails()
        }
      }
    ],
    exitCode: 0
  };
}

export function parseReleaseSourceTreeCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root") {
      parsed.rootDir = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-findings") {
      parsed.maxFindings = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function releaseSourceTreeCheckUsage() {
  return [
    "Usage: npm run --silent release:source:check -- [options]",
    "",
    "Options:",
    "  --root <dir>             Repository root. Default: current working directory.",
    `  --max-findings <count>   Maximum forbidden paths to include in details. Default: ${defaultMaxFindings}.`,
    "  --json                   Emit a single JSON result.",
    "  --help                   Show this help."
  ].join("\n");
}

function writeHumanResult(result: ReleaseSourceTreeCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;
  const check = result.checks[0];
  const details = check.details as { forbiddenPaths?: ForbiddenTrackedReleasePathFinding[]; truncated?: boolean } | undefined;

  output.write(`SiteFlow release source tree status: ${result.status}\n`);
  output.write(`Tracked paths: ${result.selectedEvidence.trackedPathCount ?? "unknown"}\n`);
  output.write(`Forbidden paths: ${result.selectedEvidence.forbiddenPathCount ?? "unknown"}\n`);
  output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);

  if (details?.forbiddenPaths?.length) {
    for (const finding of details.forbiddenPaths) {
      output.write(`  - ${finding.path}: ${finding.reason}\n`);
    }

    if (details.truncated) {
      output.write("  - Additional forbidden paths omitted; rerun with --json or a higher --max-findings to inspect more.\n");
    }
  }
}

export async function runReleaseSourceTreeCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseSourceTreeCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseSourceTreeCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseSourceTreeCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseSourceTreeCheckUsage()}\n`);
    return 0;
  }

  const result = await runReleaseSourceTreeCheck({
    ...baseOptions,
    rootDir: parsed.rootDir,
    maxFindings: parsed.maxFindings
  });

  if (parsed.json) {
    const output = result.status === "passed" ? io.stdout : io.stderr;
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, io);
  }

  return result.exitCode;
}

if (isEntrypoint()) {
  runReleaseSourceTreeCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
