import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ArtifactRetentionCheck, ArtifactRetentionPlanEntry, ArtifactRetentionPlanResult } from "./artifactRetentionPlan.js";

type ArtifactRetentionApplyStatus = "passed" | "blocked";
type ArtifactRetentionApplyCheckStatus = "pass" | "fail";
type ArtifactRetentionApplyActionStatus = "planned" | "deleted" | "skipped";

export interface ArtifactRetentionApplyOptions {
  planPath?: string;
  plan?: ArtifactRetentionPlanResult;
  yes?: boolean;
  outputPath?: string;
  now?: () => Date;
}

export interface ArtifactRetentionApplyCheck {
  name: string;
  status: ArtifactRetentionApplyCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ArtifactRetentionApplyAction {
  deploymentId: string;
  projectId: string;
  artifactRoot: string;
  relativeArtifactRoot: string;
  status: ArtifactRetentionApplyActionStatus;
  message: string;
}

export interface ArtifactRetentionApplyResult {
  name: "siteflow-artifact-retention-apply";
  status: ArtifactRetentionApplyStatus;
  checkedAt: string;
  rootDir: string;
  planPath?: string;
  outputPath?: string;
  selectedEvidence: {
    planCheckedAt: string | null;
    artifactRoot: string | null;
    dryRun: boolean;
    plannedDeleteCandidateCount: number;
    deletedCount: number;
    skippedCount: number;
  };
  checks: ArtifactRetentionApplyCheck[];
  planned: ArtifactRetentionApplyAction[];
  deleted: ArtifactRetentionApplyAction[];
  skipped: ArtifactRetentionApplyAction[];
  warnings: string[];
  exitCode: number;
}

interface ParsedArgs {
  planPath?: string;
  outputPath?: string;
  yes: boolean;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function check(
  name: string,
  passed: boolean,
  message: string,
  details?: Record<string, unknown>
): ArtifactRetentionApplyCheck {
  return {
    name,
    status: passed ? "pass" : "fail",
    message,
    ...(details ? { details } : {})
  };
}

function pathIsInside(parent: string, child: string) {
  const relative = path.relative(parent, child);

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizePath(value: string) {
  return path.resolve(value);
}

function toPosixPath(value: string) {
  return value.split(path.sep).join("/");
}

function planCheckHasFailed(planCheck: ArtifactRetentionCheck) {
  return planCheck.status === "fail";
}

function validatePlanShape(plan: ArtifactRetentionPlanResult | unknown, problems: string[]): plan is ArtifactRetentionPlanResult {
  if (!isRecord(plan)) {
    problems.push("Plan must be a JSON object.");
    return false;
  }

  if (plan.name !== "siteflow-artifact-retention-plan") {
    problems.push("Plan name must be siteflow-artifact-retention-plan.");
  }

  if (plan.status !== "passed") {
    problems.push("Plan status must be passed before artifact deletion can be applied.");
  }

  if (typeof plan.checkedAt !== "string" || Number.isNaN(new Date(plan.checkedAt).getTime())) {
    problems.push("Plan checkedAt must be a valid ISO timestamp.");
  }

  if (typeof plan.artifactRoot !== "string" || !plan.artifactRoot.trim()) {
    problems.push("Plan artifactRoot is required.");
  }

  if (!isRecord(plan.selectedEvidence) || plan.selectedEvidence.dryRun !== true) {
    problems.push("Plan selectedEvidence.dryRun must be true.");
  }

  if (!Array.isArray(plan.checks)) {
    problems.push("Plan checks must be an array.");
  } else if (plan.checks.some((entry) => !isRecord(entry) || entry.status !== "pass")) {
    problems.push("All plan checks must pass before artifact deletion can be applied.");
  }

  if (!Array.isArray(plan.retained)) {
    problems.push("Plan retained must be an array.");
  }

  if (!Array.isArray(plan.deleteCandidates)) {
    problems.push("Plan deleteCandidates must be an array.");
  }

  return problems.length === 0;
}

function validatePlanEntries(plan: ArtifactRetentionPlanResult, problems: string[]) {
  const artifactRoot = normalizePath(plan.artifactRoot ?? "");
  const retainedDeploymentIds = new Set<string>();
  const candidateDeploymentIds = new Set<string>();

  for (const retained of plan.retained) {
    retainedDeploymentIds.add(retained.deploymentId);
  }

  for (const [index, candidate] of plan.deleteCandidates.entries()) {
    const label = `deleteCandidates[${index}]`;
    const candidatePath = normalizePath(candidate.artifactRoot);

    if (!candidate.deploymentId.trim()) {
      problems.push(`${label}.deploymentId is required.`);
    }

    if (candidateDeploymentIds.has(candidate.deploymentId)) {
      problems.push(`Duplicate delete candidate deploymentId: ${candidate.deploymentId}`);
    }

    candidateDeploymentIds.add(candidate.deploymentId);

    if (retainedDeploymentIds.has(candidate.deploymentId)) {
      problems.push(`Delete candidate ${candidate.deploymentId} also appears in retained artifacts.`);
    }

    if (!pathIsInside(artifactRoot, candidatePath)) {
      problems.push(`Delete candidate ${candidate.deploymentId} must be a child of the plan artifactRoot.`);
    }

    if (candidatePath === artifactRoot) {
      problems.push(`Delete candidate ${candidate.deploymentId} must not be the artifactRoot itself.`);
    }

    if (candidate.routeChannels.length > 0) {
      problems.push(`Delete candidate ${candidate.deploymentId} must not have active route channels.`);
    }

    if (candidate.reasons.includes("active_route") || candidate.reasons.includes("explicitly_protected")) {
      problems.push(`Delete candidate ${candidate.deploymentId} must not include protected retention reasons.`);
    }
  }
}

async function readPlan(options: ArtifactRetentionApplyOptions, problems: string[]) {
  if (options.plan) {
    return options.plan;
  }

  if (!options.planPath) {
    problems.push("--plan is required.");
    return undefined;
  }

  try {
    return JSON.parse(await readFile(options.planPath, "utf8")) as unknown;
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function actionFor(candidate: ArtifactRetentionPlanEntry, status: ArtifactRetentionApplyActionStatus, message: string) {
  return {
    deploymentId: candidate.deploymentId,
    projectId: candidate.projectId,
    artifactRoot: candidate.artifactRoot,
    relativeArtifactRoot: candidate.relativeArtifactRoot,
    status,
    message
  };
}

async function applyCandidate(candidate: ArtifactRetentionPlanEntry, dryRun: boolean) {
  if (dryRun) {
    return actionFor(candidate, "planned", "Dry-run only; artifact was not deleted.");
  }

  try {
    const stat = await lstat(candidate.artifactRoot);

    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      return actionFor(candidate, "skipped", "Artifact path exists but is not a directory or symbolic link.");
    }
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";

    if (code === "ENOENT") {
      return actionFor(candidate, "skipped", "Artifact path was already absent.");
    }

    throw error;
  }

  await rm(candidate.artifactRoot, { recursive: true, force: false });

  return actionFor(candidate, "deleted", "Artifact path was deleted.");
}

export async function runArtifactRetentionApply(options: ArtifactRetentionApplyOptions = {}): Promise<ArtifactRetentionApplyResult> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const rootDir = process.cwd();
  const dryRun = options.yes !== true;
  const planPath = options.planPath ? path.resolve(options.planPath) : undefined;
  const outputPath = options.outputPath ? path.resolve(options.outputPath) : undefined;
  const checks: ArtifactRetentionApplyCheck[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const rawPlan = await readPlan(options, problems);
  const planShapeProblems: string[] = [];
  const plan = validatePlanShape(rawPlan, planShapeProblems) ? rawPlan : undefined;

  problems.push(...planShapeProblems);

  if (plan) {
    validatePlanEntries(plan, problems);

    if (plan.checks.some(planCheckHasFailed)) {
      problems.push("Plan contains failed checks.");
    }
  }

  checks.push(check(
    "plan_review_gate",
    problems.length === 0,
    problems.length === 0
      ? "Artifact retention plan is passed, dry-run evidence from the planner."
      : "Artifact retention apply is blocked until the plan is passed, reviewed, and path-safe.",
    problems.length > 0 ? { problems } : { planCheckedAt: plan?.checkedAt }
  ));

  checks.push(check(
    "destructive_confirmation",
    dryRun || options.yes === true,
    "Artifact deletion requires --yes; without it this command remains a dry-run.",
    { dryRun }
  ));

  const invalid = checks.some((entry) => entry.status === "fail");
  const planned: ArtifactRetentionApplyAction[] = [];
  const deleted: ArtifactRetentionApplyAction[] = [];
  const skipped: ArtifactRetentionApplyAction[] = [];

  if (!invalid && plan) {
    const normalizedCandidates = plan.deleteCandidates.map((candidate: ArtifactRetentionPlanEntry) => ({
      ...candidate,
      artifactRoot: normalizePath(candidate.artifactRoot),
      relativeArtifactRoot: toPosixPath(path.relative(normalizePath(plan.artifactRoot ?? ""), normalizePath(candidate.artifactRoot)))
    }));

    for (const candidate of normalizedCandidates) {
      const action = await applyCandidate(candidate, dryRun);

      if (action.status === "deleted") {
        deleted.push(action);
      } else if (action.status === "skipped") {
        skipped.push(action);
        warnings.push(`${candidate.deploymentId}: ${action.message}`);
      } else {
        planned.push(action);
      }
    }
  }

  const passed = checks.every((entry) => entry.status === "pass");
  const result: ArtifactRetentionApplyResult = {
    name: "siteflow-artifact-retention-apply",
    status: passed ? "passed" : "blocked",
    checkedAt,
    rootDir,
    ...(planPath ? { planPath } : {}),
    ...(outputPath ? { outputPath } : {}),
    selectedEvidence: {
      planCheckedAt: plan?.checkedAt ?? null,
      artifactRoot: plan?.artifactRoot ? normalizePath(plan.artifactRoot) : null,
      dryRun,
      plannedDeleteCandidateCount: plan?.deleteCandidates.length ?? 0,
      deletedCount: deleted.length,
      skippedCount: skipped.length
    },
    checks,
    planned,
    deleted,
    skipped,
    warnings: [
      ...(dryRun
        ? ["This command ran in dry-run mode; pass --yes only after reviewing the plan output."]
        : ["This command applied only the deleteCandidates from a passed retention plan."]),
      ...warnings
    ],
    exitCode: passed ? 0 : 1
  };

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
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

export function parseArtifactRetentionApplyArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    yes: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--plan") {
      parsed.planPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--yes") {
      parsed.yes = true;
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

export function artifactRetentionApplyUsage() {
  return [
    "Usage: npm run --silent release:artifact-retention:apply -- [options]",
    "",
    "Options:",
    "  --plan <file>       Passed artifact retention plan JSON to apply.",
    "  --output <file>     Write apply evidence JSON to a file.",
    "  --yes               Delete the reviewed plan deleteCandidates. Without this flag, dry-run only.",
    "  --json              Emit a single JSON result.",
    "  --help              Show this help."
  ].join("\n");
}

function writeHumanResult(result: ArtifactRetentionApplyResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow artifact retention apply: ${result.status}\n`);
  output.write(`Mode: ${result.selectedEvidence.dryRun ? "dry-run" : "delete"}\n`);
  output.write(`Planned candidates: ${result.selectedEvidence.plannedDeleteCandidateCount}\n`);
  output.write(`Deleted: ${result.selectedEvidence.deletedCount}\n`);
  output.write(`Skipped: ${result.selectedEvidence.skippedCount}\n`);
  output.write("Checks:\n");

  for (const entry of result.checks) {
    output.write(`- ${entry.name}: ${entry.status} - ${entry.message}\n`);
  }
}

export async function runArtifactRetentionApplyCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ArtifactRetentionApplyOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseArtifactRetentionApplyArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${artifactRetentionApplyUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${artifactRetentionApplyUsage()}\n`);
    return 0;
  }

  const result = await runArtifactRetentionApply({
    ...baseOptions,
    planPath: parsed.planPath,
    outputPath: parsed.outputPath,
    yes: parsed.yes
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
  runArtifactRetentionApplyCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
