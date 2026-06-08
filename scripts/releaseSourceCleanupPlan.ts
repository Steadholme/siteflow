import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findForbiddenTrackedReleasePaths,
  forbiddenTrackedReleasePathFiles,
  forbiddenTrackedReleasePathPatterns,
  forbiddenTrackedReleasePathPrefixes,
  suggestedIndexOnlyReleaseSourceCleanupCommand,
  normalizeTrackedReleasePath,
  releaseSourceTreePolicyDetails,
  type ForbiddenTrackedReleasePathFinding,
  type IndexOnlyReleaseSourceCleanupCommand
} from "../cli/releaseSourceTreePolicy.js";

type CleanupPlanStatus = "blocked" | "pass";

export interface ReleaseSourceCleanupPlanCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReleaseSourceCleanupPlanCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<ReleaseSourceCleanupPlanCommandResult>;

export interface ReleaseSourceCleanupPlanOptions {
  rootDir?: string;
  outputPath?: string;
  maxFindings?: number;
  commandRunner?: ReleaseSourceCleanupPlanCommandRunner;
  now?: () => Date;
}

export interface ReleaseSourceCleanupRootSummary {
  root: string;
  reason: string;
  count: number;
  samplePaths: string[];
}

export interface ReleaseSourceCleanupPathSummary {
  total: number;
  returned: number;
  truncated: boolean;
  paths: ForbiddenTrackedReleasePathFinding[];
}

export interface ReleaseSourceCleanupRecommendedCommand {
  id: string;
  description: string;
  command: "git";
  args: string[];
  display: string;
  pathspecs: string[];
  modifiesGitIndex: true;
  removesWorkingTreeFiles: false;
  requiresReview: true;
  notes: string[];
}

export interface ReleaseSourceCleanupPlanResult {
  name: "siteflow-release-source-cleanup-plan";
  status: CleanupPlanStatus;
  checkedAt: string;
  rootDir: string;
  outputPath?: string;
  trackedPathCount: number | null;
  forbiddenPathCount: number | null;
  forbiddenRoots: ReleaseSourceCleanupRootSummary[];
  forbiddenPaths: ReleaseSourceCleanupPathSummary;
  recommendedCommands: ReleaseSourceCleanupRecommendedCommand[];
  warnings: string[];
  policy: ReturnType<typeof releaseSourceTreePolicyDetails>;
  errors: string[];
  exitCode: number;
}

interface ParsedArgs {
  rootDir?: string;
  outputPath?: string;
  maxFindings?: number;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface PathClassification {
  label: string;
  reason: string;
}

const defaultMaxFindings = 50;
const commonIndexCleanupRootOrder = [
  ".workflow",
  "dist",
  "dist-cli",
  "dist-server",
  "dist-worker",
  "node_modules",
  "test-results"
];

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

export const defaultReleaseSourceCleanupPlanCommandRunner: ReleaseSourceCleanupPlanCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options?.cwd, timeout: 10_000 }, (error, stdout, stderr) => {
      const commandError = error as NodeJS.ErrnoException | null;
      const exitCode = typeof commandError?.code === "number" ? Number(commandError.code) : commandError ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });

function splitTrackedPaths(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => normalizeTrackedReleasePath(line))
    .filter(Boolean);
}

function shellQuotePathspec(pathspec: string) {
  if (/^[A-Za-z0-9._/@:-]+$/.test(pathspec)) {
    return pathspec;
  }

  return `"${pathspec.replace(/(["`$\\])/g, "\\$1")}"`;
}

function classifyForbiddenPath(filePath: string): PathClassification {
  const normalized = normalizeTrackedReleasePath(filePath);
  const prefix = forbiddenTrackedReleasePathPrefixes.find((entry) => normalized.startsWith(entry.prefix));

  if (prefix) {
    return {
      label: prefix.prefix.replace(/\/$/, ""),
      reason: prefix.reason
    };
  }

  const exact = forbiddenTrackedReleasePathFiles.find((entry) => normalized === entry.path);

  if (exact) {
    return {
      label: exact.path,
      reason: exact.reason
    };
  }

  const pattern = forbiddenTrackedReleasePathPatterns.find((entry) => entry.pattern.test(normalized));

  if (pattern) {
    return {
      label: pattern.label,
      reason: pattern.reason
    };
  }

  return {
    label: "unclassified",
    reason: "Release source policy found this path, but no cleanup group matched."
  };
}

function summarizeForbiddenRoots(findings: ForbiddenTrackedReleasePathFinding[], maxFindings: number) {
  const roots = new Map<string, ReleaseSourceCleanupRootSummary>();

  for (const finding of findings) {
    const classification = classifyForbiddenPath(finding.path);
    const root = roots.get(classification.label) ?? {
      root: classification.label,
      reason: classification.reason,
      count: 0,
      samplePaths: []
    };

    root.count += 1;

    if (root.samplePaths.length < maxFindings) {
      root.samplePaths.push(finding.path);
    }

    roots.set(classification.label, root);
  }

  return [...roots.values()].sort((left, right) => right.count - left.count || left.root.localeCompare(right.root));
}

function summarizeForbiddenPaths(findings: ForbiddenTrackedReleasePathFinding[], maxFindings: number) {
  const paths = findings.slice(0, maxFindings);

  return {
    total: findings.length,
    returned: paths.length,
    truncated: findings.length > maxFindings,
    paths
  };
}

function policyBackedCommonRootPathspecs() {
  const policyPathspecs = new Set(forbiddenTrackedReleasePathPrefixes.map((entry) => entry.prefix.replace(/\/$/, "")));
  return commonIndexCleanupRootOrder.filter((pathspec) => policyPathspecs.has(pathspec));
}

function recommendedCommandFromPathspecs(
  id: string,
  description: string,
  pathspecs: string[]
): ReleaseSourceCleanupRecommendedCommand | null {
  if (pathspecs.length === 0) {
    return null;
  }

  const args = ["rm", "--cached", "-r", "--", ...pathspecs];

  return {
    id,
    description,
    command: "git",
    args,
    display: ["git", ...args.map(shellQuotePathspec)].join(" "),
    pathspecs,
    modifiesGitIndex: true,
    removesWorkingTreeFiles: false,
    requiresReview: true,
    notes: [
      "Review the JSON plan before running this command.",
      "This is an index-only cleanup command; --cached keeps working tree files on disk.",
      "Run release:source:check after the reviewed cleanup commit."
    ]
  };
}

function normalizeSuggestedCommand(
  command: IndexOnlyReleaseSourceCleanupCommand | null
): ReleaseSourceCleanupRecommendedCommand | null {
  if (!command) {
    return null;
  }

  return {
    id: "matched-forbidden-paths",
    description: "Removes the forbidden tracked paths found in this Git index from tracking only.",
    ...command
  };
}

function buildRecommendedCommands(findings: ForbiddenTrackedReleasePathFinding[]) {
  if (findings.length === 0) {
    return [];
  }

  const commands = [
    recommendedCommandFromPathspecs(
      "common-forbidden-roots",
      "Review and remove common generated, dependency, scratch, and test-output roots from Git tracking only.",
      policyBackedCommonRootPathspecs()
    ),
    normalizeSuggestedCommand(suggestedIndexOnlyReleaseSourceCleanupCommand(findings))
  ].filter((command): command is ReleaseSourceCleanupRecommendedCommand => Boolean(command));
  const displays = new Set<string>();

  return commands.filter((command) => {
    if (displays.has(command.display)) {
      return false;
    }

    displays.add(command.display);
    return true;
  });
}

function cleanupWarnings(findingsCount: number) {
  const warnings = [
    "This tool is read-only for Git: it only inspects git ls-files and never modifies the Git index.",
    "Recommended commands require explicit human review before execution.",
    "Recommended git rm commands use --cached and are intended to remove paths from Git tracking only, not delete working tree files.",
    "Do not run filesystem delete commands, git reset, git checkout, or broad staging as part of reviewing this plan."
  ];

  if (findingsCount > 0) {
    warnings.push("Cleanup should be committed separately after the path list is reviewed.");
  }

  return warnings;
}

export async function runReleaseSourceCleanupPlan(
  options: ReleaseSourceCleanupPlanOptions = {}
): Promise<ReleaseSourceCleanupPlanResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const runner = options.commandRunner ?? defaultReleaseSourceCleanupPlanCommandRunner;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const maxFindings = options.maxFindings ?? defaultMaxFindings;
  const listed = await runner("git", ["ls-files"], { cwd: rootDir });
  const policy = releaseSourceTreePolicyDetails();
  const outputPath = options.outputPath ? path.resolve(rootDir, options.outputPath) : undefined;

  if (listed.exitCode !== 0) {
    const message = `${listed.stdout}\n${listed.stderr}`.trim() || `git ls-files exited with ${listed.exitCode}.`;
    const result: ReleaseSourceCleanupPlanResult = {
      name: "siteflow-release-source-cleanup-plan",
      status: "blocked",
      checkedAt,
      rootDir,
      ...(outputPath ? { outputPath } : {}),
      trackedPathCount: null,
      forbiddenPathCount: null,
      forbiddenRoots: [],
      forbiddenPaths: {
        total: 0,
        returned: 0,
        truncated: false,
        paths: []
      },
      recommendedCommands: [],
      warnings: cleanupWarnings(0),
      policy,
      errors: [message],
      exitCode: 1
    };

    if (outputPath) {
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }

    return result;
  }

  const trackedPaths = splitTrackedPaths(listed.stdout);
  const findings = findForbiddenTrackedReleasePaths(trackedPaths);
  const result: ReleaseSourceCleanupPlanResult = {
    name: "siteflow-release-source-cleanup-plan",
    status: findings.length > 0 ? "blocked" : "pass",
    checkedAt,
    rootDir,
    ...(outputPath ? { outputPath } : {}),
    trackedPathCount: trackedPaths.length,
    forbiddenPathCount: findings.length,
    forbiddenRoots: summarizeForbiddenRoots(findings, maxFindings),
    forbiddenPaths: summarizeForbiddenPaths(findings, maxFindings),
    recommendedCommands: buildRecommendedCommands(findings),
    warnings: cleanupWarnings(findings.length),
    policy,
    errors: [],
    exitCode: 0
  };

  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  return result;
}

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

export function parseReleaseSourceCleanupPlanArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root") {
      parsed.rootDir = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
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

export function releaseSourceCleanupPlanUsage() {
  return [
    "Usage: npm run --silent release:source:cleanup-plan -- [options]",
    "",
    "Options:",
    "  --root <dir>            Repository root. Default: current working directory.",
    "  --output <file>         Write the cleanup plan JSON to a file.",
    `  --max-findings <n>      Maximum forbidden paths and samples to include. Default: ${defaultMaxFindings}.`,
    "  --json                  Emit a single JSON result.",
    "  --help                  Show this help."
  ].join("\n");
}

function writeHumanResult(result: ReleaseSourceCleanupPlanResult, io: CliIo) {
  const output = result.errors.length > 0 ? io.stderr : io.stdout;

  output.write(`SiteFlow release source cleanup plan: ${result.status}\n`);
  output.write(`Tracked paths: ${result.trackedPathCount ?? "unknown"}\n`);
  output.write(`Forbidden paths: ${result.forbiddenPathCount ?? "unknown"}\n`);

  for (const root of result.forbiddenRoots) {
    output.write(`- ${root.root}: ${root.count} path(s) - ${root.reason}\n`);
    for (const sample of root.samplePaths) {
      output.write(`  - ${sample}\n`);
    }
  }

  if (result.forbiddenPaths.truncated) {
    output.write(`Additional forbidden paths omitted: ${result.forbiddenPaths.total - result.forbiddenPaths.returned}\n`);
  }

  if (result.recommendedCommands.length > 0) {
    output.write("Recommended index-only cleanup commands after review:\n");
    for (const command of result.recommendedCommands) {
      output.write(`  ${command.display}\n`);
    }
  }

  for (const warning of result.warnings) {
    output.write(`Warning: ${warning}\n`);
  }
}

export async function runReleaseSourceCleanupPlanCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseSourceCleanupPlanOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseSourceCleanupPlanArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseSourceCleanupPlanUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseSourceCleanupPlanUsage()}\n`);
    return 0;
  }

  const result = await runReleaseSourceCleanupPlan({
    ...baseOptions,
    rootDir: parsed.rootDir,
    outputPath: parsed.outputPath,
    maxFindings: parsed.maxFindings
  });

  if (parsed.json) {
    const output = result.errors.length > 0 ? io.stderr : io.stdout;
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, io);
  }

  return result.exitCode;
}

if (isEntrypoint()) {
  runReleaseSourceCleanupPlanCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
