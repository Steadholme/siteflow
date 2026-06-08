import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type ArtifactRetentionStatus = "passed" | "blocked";
type ArtifactRetentionCheckStatus = "pass" | "fail";

export interface ArtifactRetentionInventoryArtifact {
  deploymentId: string;
  projectId?: string;
  artifactRoot: string;
  createdAt: string;
  retainedUntil?: string;
  routeChannels?: string[];
  storageStatus?: string;
}

export interface ArtifactRetentionInventory {
  schemaVersion?: "siteflow.artifactRetentionInventory.v1";
  generatedAt?: string;
  artifacts: ArtifactRetentionInventoryArtifact[];
}

export interface ArtifactRetentionPlanOptions {
  artifactRoot?: string;
  inventoryPath?: string;
  inventory?: ArtifactRetentionInventory;
  retentionDays?: number;
  minimumRetainedPerProject?: number;
  graceHours?: number;
  protectedDeploymentIds?: string[];
  outputPath?: string;
  now?: () => Date;
}

export interface ArtifactRetentionCheck {
  name: string;
  status: ArtifactRetentionCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ArtifactRetentionPlanEntry {
  deploymentId: string;
  projectId: string;
  artifactRoot: string;
  relativeArtifactRoot: string;
  createdAt: string;
  retainedUntil: string | null;
  routeChannels: string[];
  storageStatus: string | null;
  reasons: string[];
}

export interface ArtifactRetentionPlanResult {
  name: "siteflow-artifact-retention-plan";
  status: ArtifactRetentionStatus;
  checkedAt: string;
  rootDir: string;
  artifactRoot: string | null;
  inventoryPath?: string;
  outputPath?: string;
  selectedEvidence: {
    totalArtifacts: number;
    retainedCount: number;
    deleteCandidateCount: number;
    protectedCount: number;
    retentionDays: number | null;
    minimumRetainedPerProject: number | null;
    graceHours: number | null;
    dryRun: true;
  };
  checks: ArtifactRetentionCheck[];
  retained: ArtifactRetentionPlanEntry[];
  deleteCandidates: ArtifactRetentionPlanEntry[];
  warnings: string[];
  exitCode: number;
}

interface NormalizedArtifact {
  deploymentId: string;
  projectId: string;
  artifactRoot: string;
  relativeArtifactRoot: string;
  createdAt: Date;
  retainedUntil?: Date;
  routeChannels: string[];
  storageStatus: string | null;
}

interface ParsedArgs {
  artifactRoot?: string;
  inventoryPath?: string;
  retentionDays?: number;
  minimumRetainedPerProject?: number;
  graceHours?: number;
  protectedDeploymentIds: string[];
  outputPath?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultRetentionDays = 30;
const defaultMinimumRetainedPerProject = 3;
const defaultGraceHours = 24;

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseDate(value: string, field: string, problems: string[]) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    problems.push(`${field} must be a valid ISO timestamp.`);
    return undefined;
  }

  return parsed;
}

function pathIsInside(parent: string, child: string) {
  const relative = path.relative(parent, child);

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toPosixPath(value: string) {
  return value.split(path.sep).join("/");
}

function check(name: string, passed: boolean, message: string, details?: Record<string, unknown>): ArtifactRetentionCheck {
  return {
    name,
    status: passed ? "pass" : "fail",
    message,
    ...(details ? { details } : {})
  };
}

function parseInventory(raw: unknown, problems: string[]): ArtifactRetentionInventory {
  if (!isRecord(raw)) {
    problems.push("Inventory must be a JSON object.");
    return { artifacts: [] };
  }

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== "siteflow.artifactRetentionInventory.v1") {
    problems.push("Inventory schemaVersion must be siteflow.artifactRetentionInventory.v1 when present.");
  }

  if (!Array.isArray(raw.artifacts)) {
    problems.push("Inventory artifacts must be an array.");
    return { artifacts: [] };
  }

  return {
    schemaVersion: raw.schemaVersion === "siteflow.artifactRetentionInventory.v1"
      ? raw.schemaVersion
      : undefined,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : undefined,
    artifacts: raw.artifacts.flatMap((entry, index): ArtifactRetentionInventoryArtifact[] => {
      if (!isRecord(entry)) {
        problems.push(`artifacts[${index}] must be an object.`);
        return [];
      }

      const deploymentId = typeof entry.deploymentId === "string" ? entry.deploymentId.trim() : "";
      const artifactRoot = typeof entry.artifactRoot === "string" ? entry.artifactRoot.trim() : "";
      const createdAt = typeof entry.createdAt === "string" ? entry.createdAt.trim() : "";

      if (!deploymentId) {
        problems.push(`artifacts[${index}].deploymentId is required.`);
      }

      if (!artifactRoot) {
        problems.push(`artifacts[${index}].artifactRoot is required.`);
      }

      if (!createdAt) {
        problems.push(`artifacts[${index}].createdAt is required.`);
      }

      return [{
        deploymentId,
        projectId: typeof entry.projectId === "string" && entry.projectId.trim() ? entry.projectId.trim() : undefined,
        artifactRoot,
        createdAt,
        retainedUntil: typeof entry.retainedUntil === "string" && entry.retainedUntil.trim() ? entry.retainedUntil.trim() : undefined,
        routeChannels: Array.isArray(entry.routeChannels)
          ? entry.routeChannels.filter((channel): channel is string => typeof channel === "string" && Boolean(channel.trim())).map((channel) => channel.trim())
          : undefined,
        storageStatus: typeof entry.storageStatus === "string" && entry.storageStatus.trim() ? entry.storageStatus.trim() : undefined
      }];
    })
  };
}

function normalizeArtifacts(
  inventory: ArtifactRetentionInventory,
  artifactRoot: string,
  now: Date,
  problems: string[]
) {
  const seen = new Set<string>();
  const normalized: NormalizedArtifact[] = [];

  if (inventory.artifacts.length === 0) {
    problems.push("Inventory must include at least one artifact.");
  }

  for (const [index, artifact] of inventory.artifacts.entries()) {
    if (seen.has(artifact.deploymentId)) {
      problems.push(`Duplicate deploymentId in inventory: ${artifact.deploymentId}`);
      continue;
    }

    seen.add(artifact.deploymentId);

    const createdAt = parseDate(artifact.createdAt, `artifacts[${index}].createdAt`, problems);
    const retainedUntil = artifact.retainedUntil
      ? parseDate(artifact.retainedUntil, `artifacts[${index}].retainedUntil`, problems)
      : undefined;
    const resolvedArtifactRoot = path.resolve(artifact.artifactRoot);

    if (!pathIsInside(artifactRoot, resolvedArtifactRoot)) {
      problems.push(`Artifact root for ${artifact.deploymentId} must be a child of the configured artifact root.`);
    }

    if (createdAt && createdAt.getTime() > now.getTime()) {
      problems.push(`Artifact ${artifact.deploymentId} createdAt must not be in the future.`);
    }

    if (!createdAt) {
      continue;
    }

    normalized.push({
      deploymentId: artifact.deploymentId,
      projectId: artifact.projectId ?? "unknown",
      artifactRoot: resolvedArtifactRoot,
      relativeArtifactRoot: toPosixPath(path.relative(artifactRoot, resolvedArtifactRoot)),
      createdAt,
      retainedUntil,
      routeChannels: artifact.routeChannels ?? [],
      storageStatus: artifact.storageStatus ?? null
    });
  }

  return normalized;
}

function groupByProject(artifacts: NormalizedArtifact[]) {
  const grouped = new Map<string, NormalizedArtifact[]>();

  for (const artifact of artifacts) {
    grouped.set(artifact.projectId, [...(grouped.get(artifact.projectId) ?? []), artifact]);
  }

  return grouped;
}

function artifactEntry(artifact: NormalizedArtifact, reasons: string[]): ArtifactRetentionPlanEntry {
  return {
    deploymentId: artifact.deploymentId,
    projectId: artifact.projectId,
    artifactRoot: artifact.artifactRoot,
    relativeArtifactRoot: artifact.relativeArtifactRoot,
    createdAt: artifact.createdAt.toISOString(),
    retainedUntil: artifact.retainedUntil?.toISOString() ?? null,
    routeChannels: artifact.routeChannels,
    storageStatus: artifact.storageStatus,
    reasons
  };
}

function planRetention(
  artifacts: NormalizedArtifact[],
  options: {
    now: Date;
    retentionDays: number;
    minimumRetainedPerProject: number;
    graceHours: number;
    protectedDeploymentIds: Set<string>;
  }
) {
  const retentionCutoff = options.now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
  const graceCutoff = options.now.getTime() - options.graceHours * 60 * 60 * 1000;
  const minimumRetained = new Set<string>();

  for (const projectArtifacts of groupByProject(artifacts).values()) {
    for (const artifact of [...projectArtifacts]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, options.minimumRetainedPerProject)) {
      minimumRetained.add(artifact.deploymentId);
    }
  }

  const retained: ArtifactRetentionPlanEntry[] = [];
  const deleteCandidates: ArtifactRetentionPlanEntry[] = [];

  for (const artifact of artifacts.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())) {
    const reasons: string[] = [];

    if (options.protectedDeploymentIds.has(artifact.deploymentId)) {
      reasons.push("explicitly_protected");
    }

    if (artifact.routeChannels.length > 0) {
      reasons.push("active_route");
    }

    if (artifact.retainedUntil && artifact.retainedUntil.getTime() > options.now.getTime()) {
      reasons.push("retained_until_future");
    } else if (artifact.createdAt.getTime() >= retentionCutoff) {
      reasons.push("within_retention_window");
    }

    if (artifact.createdAt.getTime() >= graceCutoff) {
      reasons.push("within_grace_period");
    }

    if (minimumRetained.has(artifact.deploymentId)) {
      reasons.push("minimum_retained_per_project");
    }

    if (reasons.length > 0) {
      retained.push(artifactEntry(artifact, reasons));
    } else {
      deleteCandidates.push(artifactEntry(artifact, ["older_than_retention_policy"]));
    }
  }

  return { retained, deleteCandidates };
}

async function readInventory(options: ArtifactRetentionPlanOptions, problems: string[]) {
  if (options.inventory) {
    return parseInventory(options.inventory, problems);
  }

  if (!options.inventoryPath) {
    problems.push("--inventory is required.");
    return { artifacts: [] };
  }

  try {
    return parseInventory(JSON.parse(await readFile(options.inventoryPath, "utf8")), problems);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return { artifacts: [] };
  }
}

export async function runArtifactRetentionPlan(options: ArtifactRetentionPlanOptions = {}): Promise<ArtifactRetentionPlanResult> {
  const checkedAtDate = options.now?.() ?? new Date();
  const checkedAt = checkedAtDate.toISOString();
  const rootDir = process.cwd();
  const retentionDays = options.retentionDays ?? defaultRetentionDays;
  const minimumRetainedPerProject = options.minimumRetainedPerProject ?? defaultMinimumRetainedPerProject;
  const graceHours = options.graceHours ?? defaultGraceHours;
  const configuredArtifactRoot = options.artifactRoot ? path.resolve(options.artifactRoot) : null;
  const protectedDeploymentIds = new Set(options.protectedDeploymentIds ?? []);
  const checks: ArtifactRetentionCheck[] = [];
  const problems: string[] = [];

  checks.push(check(
    "retention_policy",
    positiveInteger(retentionDays) && positiveInteger(minimumRetainedPerProject) && positiveInteger(graceHours),
    "Artifact retention policy must use positive integer retentionDays, minimumRetainedPerProject, and graceHours.",
    { retentionDays, minimumRetainedPerProject, graceHours }
  ));

  if (!configuredArtifactRoot) {
    problems.push("--artifact-root is required.");
  }

  const inventory = await readInventory(options, problems);
  const normalized = configuredArtifactRoot
    ? normalizeArtifacts(inventory, configuredArtifactRoot, checkedAtDate, problems)
    : [];
  const deploymentIds = new Set(normalized.map((artifact) => artifact.deploymentId));
  const unknownProtectedDeploymentIds = [...protectedDeploymentIds].filter((deploymentId) => !deploymentIds.has(deploymentId));

  if (unknownProtectedDeploymentIds.length > 0) {
    problems.push(`Protected deployment id(s) were not found in inventory: ${unknownProtectedDeploymentIds.join(", ")}`);
  }

  checks.push(check(
    "inventory_shape",
    problems.length === 0,
    problems.length === 0
      ? `Loaded ${normalized.length} artifact inventory entr${normalized.length === 1 ? "y" : "ies"}.`
      : "Artifact retention inventory must be complete, release-safe, and path-safe before pruning.",
    problems.length > 0 ? { problems } : { artifactCount: normalized.length }
  ));

  checks.push(check(
    "protected_deployments",
    normalized.some((artifact) => artifact.routeChannels.length > 0 || protectedDeploymentIds.has(artifact.deploymentId)),
    "Retention planning must protect at least one current route or explicitly protected deployment.",
    {
      explicitProtectedCount: protectedDeploymentIds.size,
      routedArtifactCount: normalized.filter((artifact) => artifact.routeChannels.length > 0).length
    }
  ));

  const invalid = checks.some((entry) => entry.status === "fail");
  const planned = invalid
    ? { retained: [] as ArtifactRetentionPlanEntry[], deleteCandidates: [] as ArtifactRetentionPlanEntry[] }
    : planRetention(normalized, {
        now: checkedAtDate,
        retentionDays,
        minimumRetainedPerProject,
        graceHours,
        protectedDeploymentIds
      });

  checks.push(check(
    "delete_candidates_reviewable",
    !invalid,
    invalid
      ? "Delete candidates are suppressed until the retention policy and inventory pass validation."
      : `Generated a dry-run retention plan with ${planned.deleteCandidates.length} delete candidate(s).`,
    invalid
      ? undefined
      : {
          deleteCandidateCount: planned.deleteCandidates.length,
          dryRun: true
        }
  ));

  const protectedCount = normalized.filter((artifact) =>
    artifact.routeChannels.length > 0 || protectedDeploymentIds.has(artifact.deploymentId)
  ).length;
  const passed = checks.every((entry) => entry.status === "pass");
  const outputPath = options.outputPath ? path.resolve(options.outputPath) : undefined;
  const result: ArtifactRetentionPlanResult = {
    name: "siteflow-artifact-retention-plan",
    status: passed ? "passed" : "blocked",
    checkedAt,
    rootDir,
    artifactRoot: configuredArtifactRoot,
    ...(options.inventoryPath ? { inventoryPath: path.resolve(options.inventoryPath) } : {}),
    ...(outputPath ? { outputPath } : {}),
    selectedEvidence: {
      totalArtifacts: normalized.length,
      retainedCount: planned.retained.length,
      deleteCandidateCount: planned.deleteCandidates.length,
      protectedCount,
      retentionDays: positiveInteger(retentionDays) ? retentionDays : null,
      minimumRetainedPerProject: positiveInteger(minimumRetainedPerProject) ? minimumRetainedPerProject : null,
      graceHours: positiveInteger(graceHours) ? graceHours : null,
      dryRun: true
    },
    checks,
    retained: planned.retained,
    deleteCandidates: planned.deleteCandidates,
    warnings: [
      "This command is dry-run only; it does not delete files or mutate the database.",
      "Review deleteCandidates before wiring any destructive cleanup executor.",
      "Keep current production and rollback route deployment ids in routeChannels or --protect-deployment."
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

function parsePositiveInteger(value: string, flag: string) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer.`);
  }

  return parsed;
}

export function parseArtifactRetentionPlanArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    protectedDeploymentIds: [],
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--artifact-root") {
      parsed.artifactRoot = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--inventory") {
      parsed.inventoryPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--retention-days") {
      parsed.retentionDays = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--minimum-retained-per-project") {
      parsed.minimumRetainedPerProject = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--grace-hours") {
      parsed.graceHours = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--protect-deployment") {
      parsed.protectedDeploymentIds.push(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
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

export function artifactRetentionPlanUsage() {
  return [
    "Usage: npm run --silent release:artifact-retention:plan -- [options]",
    "",
    "Options:",
    "  --artifact-root <dir>                  Artifact storage root containing deployment artifact directories.",
    "  --inventory <file>                     Artifact inventory JSON to evaluate.",
    `  --retention-days <n>                  Retain artifacts for at least n days. Default: ${defaultRetentionDays}.`,
    `  --minimum-retained-per-project <n>    Keep at least n newest artifacts per project. Default: ${defaultMinimumRetainedPerProject}.`,
    `  --grace-hours <n>                     Never prune artifacts created in the last n hours. Default: ${defaultGraceHours}.`,
    "  --protect-deployment <id>             Deployment id to retain. Repeatable.",
    "  --output <file>                       Write the dry-run plan JSON to a file.",
    "  --json                                Emit a single JSON result.",
    "  --help                                Show this help."
  ].join("\n");
}

function writeHumanResult(result: ArtifactRetentionPlanResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow artifact retention plan: ${result.status}\n`);
  output.write(`Artifacts: ${result.selectedEvidence.totalArtifacts}\n`);
  output.write(`Retained: ${result.selectedEvidence.retainedCount}\n`);
  output.write(`Delete candidates: ${result.selectedEvidence.deleteCandidateCount}\n`);
  output.write("Checks:\n");

  for (const entry of result.checks) {
    output.write(`- ${entry.name}: ${entry.status} - ${entry.message}\n`);
  }
}

export async function runArtifactRetentionPlanCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ArtifactRetentionPlanOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseArtifactRetentionPlanArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${artifactRetentionPlanUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${artifactRetentionPlanUsage()}\n`);
    return 0;
  }

  const result = await runArtifactRetentionPlan({
    ...baseOptions,
    artifactRoot: parsed.artifactRoot,
    inventoryPath: parsed.inventoryPath,
    retentionDays: parsed.retentionDays,
    minimumRetainedPerProject: parsed.minimumRetainedPerProject,
    graceHours: parsed.graceHours,
    protectedDeploymentIds: parsed.protectedDeploymentIds,
    outputPath: parsed.outputPath
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
  runArtifactRetentionPlanCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
