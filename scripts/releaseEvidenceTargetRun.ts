import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sensitiveOutputReasons } from "./evidenceSecretScan.js";
import { createReleaseEvidenceGapReport, type ReleaseEvidenceGapReportResult } from "./releaseEvidenceGapReport.js";
import { validateReleaseEvidenceRehearsalPackContract } from "./releaseEvidenceRehearsalPackContract.js";

type RunStatus = "planned" | "running" | "completed" | "blocked" | "failed";
type StepStatus = "completed" | "blocked" | "failed" | "skipped" | "planned";
type StepKind = "evidence" | "final_compose" | "final_check";

interface PackCommand {
  executable?: unknown;
  args?: unknown;
  display?: unknown;
  env?: unknown;
  captureStdoutTo?: unknown;
}

interface PackStep {
  id?: unknown;
  title?: unknown;
  outputPath?: unknown;
  command?: PackCommand;
}

interface RunItem {
  id: string;
  title: string;
  kind: StepKind;
  outputPath?: string;
  command: PackCommand;
}

interface EnvReplacementReference {
  key: string;
  envName: string;
}

interface CommandRunOptions {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReleaseEvidenceCommandRunner = (options: CommandRunOptions) => Promise<CommandRunResult>;

export interface ReleaseEvidenceTargetRunOptions {
  packPath: string;
  confirmTargetEnvironment: string;
  runRecordPath?: string;
  gapReportDir?: string;
  replacements?: Record<string, string>;
  resolvedReplacements?: Record<string, string>;
  envReplacements?: Record<string, string>;
  continueOnError?: boolean;
  planOnly?: boolean;
  failOnGaps?: boolean;
  maxEvidenceAgeHours?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  commandRunner?: ReleaseEvidenceCommandRunner;
}

export interface ReleaseEvidenceTargetRunStep {
  id: string;
  title: string;
  kind: StepKind;
  status: StepStatus;
  outputPath?: string;
  commandDisplay: string;
  replacementKeys: string[];
  envReplacementKeys: EnvReplacementReference[];
  envRequirements: Array<{
    name: string;
    kind: "present" | "literal" | "operator_value";
    status: "satisfied" | "missing" | "mismatch";
    message?: string;
  }>;
  placeholders: string[];
  executableRequirement?: {
    name: string;
    status: "satisfied" | "missing";
    resolvedPath?: string;
    message?: string;
  };
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  stdoutCapturedTo?: string;
  stdoutDiscardedReason?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stderrPreview?: string;
  stderrSensitiveReasons?: string[];
  message: string;
}

export interface ReleaseEvidenceTargetRunGapSnapshot {
  id: string;
  path: string;
  status: ReleaseEvidenceGapReportResult["status"];
  summary: ReleaseEvidenceGapReportResult["summary"];
}

export interface ReleaseEvidenceTargetRunResult {
  name: "siteflow-release-evidence-target-run";
  status: RunStatus;
  startedAt: string;
  completedAt: string;
  packPath: string;
  runRecordPath: string;
  gapReportDir: string;
  release: {
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    targetEnvironment: string | null;
  };
  confirmTargetEnvironment: string;
  planOnly?: boolean;
  envReplacements: EnvReplacementReference[];
  steps: ReleaseEvidenceTargetRunStep[];
  gapReports: ReleaseEvidenceTargetRunGapSnapshot[];
  blockedProductionClaims: string[];
  commandsExecuted: number;
  productionEvidenceGenerated: boolean;
  failOnGaps?: boolean;
  initialGapReportStatus?: ReleaseEvidenceGapReportResult["status"];
  finalGapReportStatus?: ReleaseEvidenceGapReportResult["status"];
  message: string;
  exitCode: number;
}

interface ParsedArgs {
  packPath?: string;
  confirmTargetEnvironment?: string;
  runRecordPath?: string;
  gapReportDir?: string;
  replacements: Record<string, string>;
  envReplacements: Record<string, string>;
  continueOnError: boolean;
  planOnly: boolean;
  failOnGaps: boolean;
  maxEvidenceAgeHours?: number;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function requiredValue(value: string | undefined, label: string) {
  const normalized = stringValue(value);

  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function positiveNumber(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

function nestedObject(root: Record<string, unknown>, key: string) {
  return isObject(root[key]) ? root[key] : undefined;
}

async function readJsonObject(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

function packSteps(pack: Record<string, unknown>) {
  const steps = pack.steps;

  if (!Array.isArray(steps)) {
    throw new Error("Release evidence rehearsal pack must include steps.");
  }

  return steps.filter(isObject) as PackStep[];
}

function commandArgs(command: PackCommand) {
  return stringArray(command.args);
}

function commandEnvSpecs(command: PackCommand) {
  return stringArray(command.env);
}

function commandDisplay(command: PackCommand) {
  return stringValue(command.display) ?? [stringValue(command.executable), ...commandArgs(command)]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
}

function collectRunItems(pack: Record<string, unknown>) {
  const items: RunItem[] = packSteps(pack).map((step) => ({
    id: stringValue(step.id) ?? "unknown_step",
    title: stringValue(step.title) ?? stringValue(step.id) ?? "Unknown step",
    kind: "evidence",
    outputPath: stringValue(step.outputPath),
    command: isObject(step.command) ? step.command : {}
  }));
  const finalCommands = nestedObject(pack, "finalCommands");
  const compose = finalCommands && isObject(finalCommands.compose) ? finalCommands.compose : undefined;
  const check = finalCommands && isObject(finalCommands.check) ? finalCommands.check : undefined;

  if (compose) {
    items.push({
      id: "release_evidence_bundle",
      title: "Compose final release evidence bundle",
      kind: "final_compose",
      outputPath: stringValue(nestedObject(pack, "evidenceFiles")?.releaseEvidence),
      command: compose
    });
  }

  if (check) {
    items.push({
      id: "release_evidence_check",
      title: "Run final release evidence bundle check",
      kind: "final_check",
      outputPath: stringValue(check.captureStdoutTo) ?? stringValue(nestedObject(pack, "evidenceFiles")?.releaseEvidenceCheck),
      command: check
    });
  }

  return items;
}

function envNameAndExpected(spec: string) {
  const separatorIndex = spec.indexOf("=");

  if (separatorIndex === -1) {
    return {
      name: spec.trim()
    };
  }

  return {
    name: spec.slice(0, separatorIndex).trim(),
    expected: spec.slice(separatorIndex + 1).trim()
  };
}

function placeholderNames(value: string) {
  return [...value.matchAll(/<([^<>]+)>/g)].map((match) => match[1]);
}

function applyReplacements(args: string[], replacements: Record<string, string>) {
  return args.map((arg) => {
    let next = arg;

    for (const [key, value] of Object.entries(replacements)) {
      next = next.replaceAll(`<${key}>`, value);
    }

    return next;
  });
}

function remainingPlaceholders(args: string[]) {
  return [...new Set(args.flatMap(placeholderNames))].sort();
}

function validateReplacements(replacements: Record<string, string>) {
  for (const [key, value] of Object.entries(replacements)) {
    validateReplacementKey(key);

    if (!stringValue(value)) {
      throw new Error(`Replacement ${key} requires a non-empty value.`);
    }
  }
}

function validateReplacementKey(key: string) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(key)) {
    throw new Error(`Replacement key ${key} must contain only letters, numbers, dot, underscore, colon, or dash.`);
  }
}

function validateEnvReplacementName(envName: string, key: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(envName)) {
    throw new Error(`--set-env ${key} requires an environment variable name containing only letters, numbers, or underscore and not starting with a number.`);
  }
}

function validateEnvReplacements(envReplacements: Record<string, string>) {
  for (const [key, envName] of Object.entries(envReplacements)) {
    validateReplacementKey(key);

    if (!stringValue(envName)) {
      throw new Error(`--set-env ${key} requires an environment variable name.`);
    }

    validateEnvReplacementName(envName, key);
  }
}

function envReplacementReferences(envReplacements: Record<string, string> | undefined): EnvReplacementReference[] {
  return Object.entries(envReplacements ?? {}).map(([key, envName]) => ({ key, envName }));
}

function resolveReplacementsFromEnv(
  replacements: Record<string, string>,
  envReplacements: Record<string, string>,
  env: NodeJS.ProcessEnv
) {
  validateReplacements(replacements);
  validateEnvReplacements(envReplacements);

  const resolved = { ...replacements };

  for (const [key, envName] of Object.entries(envReplacements)) {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      throw new Error(`Replacement ${key} cannot be supplied by both --set and --set-env.`);
    }

    const value = stringValue(env[envName]);

    if (!value) {
      throw new Error(`--set-env ${key} requires environment variable ${envName} to be set to a non-empty value.`);
    }

    resolved[key] = value;
  }

  return resolved;
}

function outputPreview(value: string, maxBytes = 1024) {
  if (!value.trim()) {
    return undefined;
  }

  return value.length > maxBytes ? `${value.slice(0, maxBytes)}...[truncated]` : value;
}

async function envRequirements(command: PackCommand, env: NodeJS.ProcessEnv, cwd: string | undefined) {
  const requirements = commandEnvSpecs(command).map((spec) => {
    const { name, expected } = envNameAndExpected(spec);
    const configured = name ? env[name] : undefined;
    const placeholder = Boolean(expected && expected.includes("<") && expected.includes(">"));

    if (!expected) {
      return {
        name,
        kind: "present" as const,
        status: configured ? "satisfied" as const : "missing" as const
      };
    }

    if (placeholder) {
      return {
        name,
        kind: "operator_value" as const,
        status: configured ? "satisfied" as const : "missing" as const
      };
    }

    return {
      name,
      kind: "literal" as const,
      status: configured === undefined || configured === expected ? "satisfied" as const : "mismatch" as const
    };
  }).filter((entry) => entry.name);

  return Promise.all(requirements.map((requirement) => fileSecretRequirement(requirement, env, cwd)));
}

async function fileSecretRequirement(
  requirement: ReleaseEvidenceTargetRunStep["envRequirements"][number],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined
) {
  if (requirement.kind !== "present" ||
    requirement.status !== "satisfied" ||
    !requirement.name.endsWith("_FILE")) {
    return requirement;
  }

  const rawPath = stringValue(env[requirement.name]);
  const resolvedPath = rawPath && path.isAbsolute(rawPath)
    ? rawPath
    : rawPath
      ? path.resolve(cwd ?? process.cwd(), rawPath)
      : undefined;

  if (!resolvedPath) {
    return requirement;
  }

  try {
    const contents = await readFile(resolvedPath, "utf8");

    if (!contents.trim()) {
      return {
        ...requirement,
        status: "mismatch" as const,
        message: `${requirement.name} points to an empty file.`
      };
    }

    return requirement;
  } catch {
    return {
      ...requirement,
      status: "mismatch" as const,
      message: `${requirement.name} points to a file that cannot be read.`
    };
  }
}

function executionEnv(command: PackCommand, baseEnv: NodeJS.ProcessEnv) {
  const env = { ...baseEnv };

  for (const spec of commandEnvSpecs(command)) {
    const { name, expected } = envNameAndExpected(spec);
    const placeholder = Boolean(expected && expected.includes("<") && expected.includes(">"));

    if (name && expected && !placeholder) {
      env[name] = expected;
    }
  }

  return env;
}

function gapReportEnv(items: RunItem[], baseEnv: NodeJS.ProcessEnv) {
  const env = { ...baseEnv };

  for (const item of items) {
    for (const spec of commandEnvSpecs(item.command)) {
      const { name, expected } = envNameAndExpected(spec);
      const placeholder = Boolean(expected && expected.includes("<") && expected.includes(">"));

      if (name && expected && !placeholder) {
        env[name] = expected;
      }
    }
  }

  return env;
}

function envBlocked(requirements: ReleaseEvidenceTargetRunStep["envRequirements"]) {
  return requirements.filter((entry) => entry.status !== "satisfied" && !hasSatisfiedFileSecretAlternate(entry, requirements));
}

function hasSatisfiedFileSecretAlternate(
  requirement: ReleaseEvidenceTargetRunStep["envRequirements"][number],
  requirements: ReleaseEvidenceTargetRunStep["envRequirements"]
) {
  if (requirement.kind !== "present" || requirement.status !== "missing") {
    return false;
  }

  const alternate = requirement.name.endsWith("_FILE")
    ? requirement.name.slice(0, -"_FILE".length)
    : `${requirement.name}_FILE`;

  return requirements.some((entry) =>
    entry.kind === "present" &&
    entry.name === alternate &&
    entry.status === "satisfied"
  );
}

export function targetRunCommandExecutable(executable: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32" || path.extname(executable)) {
    return executable;
  }

  if (["npm", "npx", "pnpm", "yarn"].includes(executable.toLowerCase())) {
    return `${executable}.cmd`;
  }

  return executable;
}

function pathEnvironmentValue(env: NodeJS.ProcessEnv) {
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === "path");

  return key ? env[key] : undefined;
}

function pathEntries(env: NodeJS.ProcessEnv) {
  return (pathEnvironmentValue(env) ?? "").split(path.delimiter).filter(Boolean);
}

function pathExtensions(env: NodeJS.ProcessEnv) {
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasPathSeparator(value: string) {
  return value.includes("/") || value.includes("\\");
}

function uniqueExecutableCandidates(values: string[]) {
  return [...new Set(values)];
}

function executableNames(executable: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform !== "win32" || path.extname(executable)) {
    return [targetRunCommandExecutable(executable, platform)];
  }

  const mapped = targetRunCommandExecutable(executable, platform);
  const extensions = pathExtensions(env);

  return uniqueExecutableCandidates([
    mapped,
    executable,
    ...extensions.map((extension) => `${executable}${extension.toLowerCase()}`),
    ...extensions.map((extension) => `${executable}${extension.toUpperCase()}`)
  ]);
}

function executableCandidates(executable: string, env: NodeJS.ProcessEnv, cwd: string | undefined, platform: NodeJS.Platform) {
  if (path.isAbsolute(executable) || hasPathSeparator(executable)) {
    const resolved = path.isAbsolute(executable) ? executable : path.resolve(cwd ?? process.cwd(), executable);

    return executableNames(resolved, env, platform);
  }

  return pathEntries(env).flatMap((entry) =>
    executableNames(executable, env, platform).map((name) => path.join(entry, name))
  );
}

async function resolveExecutableRequirement(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform
): Promise<NonNullable<ReleaseEvidenceTargetRunStep["executableRequirement"]>> {
  for (const candidate of executableCandidates(executable, env, cwd, platform)) {
    try {
      await access(candidate, fsConstants.X_OK);

      return {
        name: executable,
        status: "satisfied",
        resolvedPath: candidate
      };
    } catch {
      // Try the next candidate.
    }
  }

  return {
    name: executable,
    status: "missing",
    message: `Executable ${executable} was not found on PATH.`
  };
}

async function actualCommandRunner(options: CommandRunOptions) {
  return new Promise<CommandRunResult>((resolve) => {
    const child = spawn(targetRunCommandExecutable(options.executable), options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message
      });
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function writeJson(filePath: string, value: unknown) {
  const serialized = JSON.stringify(value, null, 2);
  const sensitiveReasons = sensitiveOutputReasons(serialized);

  if (sensitiveReasons.length > 0) {
    throw new Error(`Run record matched sensitive output patterns before writing: ${sensitiveReasons.join(", ")}.`);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${serialized}\n`, "utf8");
}

function releaseInfo(pack: Record<string, unknown>) {
  const release = nestedObject(pack, "release") ?? {};

  return {
    commitRef: stringValue(release.commitRef) ?? null,
    repository: stringValue(release.repository) ?? null,
    branch: stringValue(release.branch) ?? null,
    targetEnvironment: stringValue(release.targetEnvironment) ?? null
  };
}

function blockedProductionClaims(pack: Record<string, unknown>) {
  return stringArray(pack.blockedProductionClaims);
}

function currentResult(
  options: ReleaseEvidenceTargetRunOptions,
  startedAt: string,
  completedAt: string,
  pack: Record<string, unknown>,
  steps: ReleaseEvidenceTargetRunStep[],
  gapReports: ReleaseEvidenceTargetRunGapSnapshot[],
  message: string,
  statusOverride?: RunStatus
): ReleaseEvidenceTargetRunResult {
  const failed = steps.some((step) => step.status === "failed");
  const blocked = steps.some((step) => step.status === "blocked" || step.status === "skipped");
  const planned = steps.some((step) => step.status === "planned");
  const status: RunStatus = statusOverride ?? (failed ? "failed" : blocked ? "blocked" : planned ? "planned" : steps.length === 0 ? "running" : "completed");
  const commandsExecuted = steps.filter((step) => step.exitCode !== undefined).length;
  const initialGapReportStatus = gapReports[0]?.status;
  const finalGapReportStatus = gapReports.at(-1)?.status;

  return {
    name: "siteflow-release-evidence-target-run",
    status,
    startedAt,
    completedAt,
    packPath: options.packPath,
    runRecordPath: options.runRecordPath!,
    gapReportDir: options.gapReportDir!,
    release: releaseInfo(pack),
    confirmTargetEnvironment: options.confirmTargetEnvironment,
    ...(options.planOnly ? { planOnly: true } : {}),
    envReplacements: envReplacementReferences(options.envReplacements),
    steps,
    gapReports,
    blockedProductionClaims: blockedProductionClaims(pack),
    commandsExecuted,
    productionEvidenceGenerated: !options.planOnly && status === "completed",
    ...(options.failOnGaps ? { failOnGaps: true } : {}),
    ...(initialGapReportStatus ? { initialGapReportStatus } : {}),
    ...(finalGapReportStatus ? { finalGapReportStatus } : {}),
    message,
    exitCode: status === "completed" || status === "planned" ? 0 : status === "blocked" || status === "running" ? 2 : 1
  };
}

async function writeGapReportSnapshot(
  options: ReleaseEvidenceTargetRunOptions,
  id: string,
  env: NodeJS.ProcessEnv
) {
  const report = await createReleaseEvidenceGapReport({
    packPath: options.packPath,
    maxEvidenceAgeHours: options.maxEvidenceAgeHours,
    replacements: options.replacements,
    envReplacements: options.envReplacements,
    env,
    now: options.now
  });
  const outputPath = path.join(options.gapReportDir!, `${id}.json`);
  const serializedReport = JSON.stringify(report, null, 2);
  const sensitiveReasons = sensitiveOutputReasons(serializedReport);

  if (sensitiveReasons.length > 0) {
    throw new Error(`Gap report snapshot ${id} matched sensitive output patterns before evidence capture: ${sensitiveReasons.join(", ")}.`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${serializedReport}\n`, "utf8");

  return {
    id,
    path: outputPath,
    status: report.status,
    summary: report.summary
  };
}

async function persistRunRecord(
  options: ReleaseEvidenceTargetRunOptions,
  startedAt: string,
  pack: Record<string, unknown>,
  steps: ReleaseEvidenceTargetRunStep[],
  gapReports: ReleaseEvidenceTargetRunGapSnapshot[],
  message: string,
  statusOverride?: RunStatus
) {
  const result = currentResult(
    options,
    startedAt,
    (options.now?.() ?? new Date()).toISOString(),
    pack,
    steps,
    gapReports,
    message,
    statusOverride
  );

  await writeJson(options.runRecordPath!, result);

  return result;
}

function skippedStep(item: RunItem, reason: string): ReleaseEvidenceTargetRunStep {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: "skipped",
    outputPath: item.outputPath,
    commandDisplay: commandDisplay(item.command),
    replacementKeys: [],
    envReplacementKeys: [],
    envRequirements: [],
    placeholders: [],
    message: reason
  };
}

async function commandPlanStep(
  item: RunItem,
  options: ReleaseEvidenceTargetRunOptions,
  env: NodeJS.ProcessEnv
): Promise<ReleaseEvidenceTargetRunStep> {
  const command = item.command;
  const executable = stringValue(command.executable);
  const originalArgs = commandArgs(command);
  const resolvedReplacements = options.resolvedReplacements ?? options.replacements ?? {};
  const args = applyReplacements(originalArgs, resolvedReplacements);
  const placeholders = remainingPlaceholders(args);
  const requirements = await envRequirements(command, env, options.cwd);
  const blockedRequirements = envBlocked(requirements);
  const replacementKeys = Object.keys(resolvedReplacements).filter((key) =>
    originalArgs.some((arg) => arg.includes(`<${key}>`))
  );
  const envReplacementKeys = envReplacementReferences(options.envReplacements).filter((replacement) =>
    originalArgs.some((arg) => arg.includes(`<${replacement.key}>`))
  );

  if (!executable) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      message: "Command executable is missing from the rehearsal pack."
    };
  }

  if (placeholders.length > 0) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      message: `Command still contains unresolved operator placeholder(s): ${placeholders.join(", ")}.`
    };
  }

  if (blockedRequirements.length > 0) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      message: `Command environment requirements are not satisfied: ${blockedRequirements.map((entry) => entry.name).join(", ")}.`
    };
  }

  const executableRequirement = await resolveExecutableRequirement(executable, env, options.cwd);

  if (executableRequirement.status !== "satisfied") {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      executableRequirement,
      message: executableRequirement.message ?? `Command executable ${executable} is unavailable.`
    };
  }

  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: "planned",
    outputPath: item.outputPath,
    commandDisplay: commandDisplay(command),
    replacementKeys,
    envReplacementKeys,
    envRequirements: requirements,
    placeholders,
    executableRequirement,
    message: "Plan-only mode: command was validated but not executed."
  };
}

async function executeItem(
  item: RunItem,
  options: ReleaseEvidenceTargetRunOptions,
  env: NodeJS.ProcessEnv
): Promise<ReleaseEvidenceTargetRunStep> {
  const command = item.command;
  const executable = stringValue(command.executable);
  const originalArgs = commandArgs(command);
  const resolvedReplacements = options.resolvedReplacements ?? options.replacements ?? {};
  const args = applyReplacements(originalArgs, resolvedReplacements);
  const placeholders = remainingPlaceholders(args);
  const requirements = await envRequirements(command, env, options.cwd);
  const blockedRequirements = envBlocked(requirements);
  const replacementKeys = Object.keys(resolvedReplacements).filter((key) =>
    originalArgs.some((arg) => arg.includes(`<${key}>`))
  );
  const envReplacementKeys = envReplacementReferences(options.envReplacements).filter((replacement) =>
    originalArgs.some((arg) => arg.includes(`<${replacement.key}>`))
  );
  const startedAt = (options.now?.() ?? new Date()).toISOString();

  if (!executable) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      startedAt,
      completedAt: (options.now?.() ?? new Date()).toISOString(),
      message: "Command executable is missing from the rehearsal pack."
    };
  }

  if (placeholders.length > 0) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      startedAt,
      completedAt: (options.now?.() ?? new Date()).toISOString(),
      message: `Command still contains unresolved operator placeholder(s): ${placeholders.join(", ")}.`
    };
  }

  if (blockedRequirements.length > 0) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      startedAt,
      completedAt: (options.now?.() ?? new Date()).toISOString(),
      message: `Command environment requirements are not satisfied: ${blockedRequirements.map((entry) => entry.name).join(", ")}.`
    };
  }

  const executableRequirement = options.commandRunner
    ? undefined
    : await resolveExecutableRequirement(executable, env, options.cwd);

  if (executableRequirement && executableRequirement.status !== "satisfied") {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "blocked",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      executableRequirement,
      startedAt,
      completedAt: (options.now?.() ?? new Date()).toISOString(),
      message: executableRequirement.message ?? `Command executable ${executable} is unavailable.`
    };
  }

  const runner = options.commandRunner ?? actualCommandRunner;
  const result = await runner({
    executable,
    args,
    env: executionEnv(command, env),
    cwd: options.cwd
  });
  const captureStdoutTo = stringValue(command.captureStdoutTo);
  const sensitiveReasons = captureStdoutTo ? sensitiveOutputReasons(result.stdout) : [];
  const stderrSensitiveReasons = result.exitCode === 0 ? [] : sensitiveOutputReasons(result.stderr);
  const stderrPreview = result.exitCode === 0 || stderrSensitiveReasons.length > 0 ? undefined : outputPreview(result.stderr);

  if (captureStdoutTo && sensitiveReasons.length === 0 && result.exitCode === 0) {
    await writeJsonCompatibleText(captureStdoutTo, result.stdout);
  }

  if (sensitiveReasons.length > 0) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: "failed",
      outputPath: item.outputPath,
      commandDisplay: commandDisplay(command),
      replacementKeys,
      envReplacementKeys,
      envRequirements: requirements,
      placeholders,
      ...(executableRequirement ? { executableRequirement } : {}),
      startedAt,
      completedAt: (options.now?.() ?? new Date()).toISOString(),
      exitCode: 1,
      stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      ...(stderrPreview ? { stderrPreview } : {}),
      ...(stderrSensitiveReasons.length > 0 ? { stderrSensitiveReasons } : {}),
      message: `Command stdout matched sensitive output patterns before evidence capture: ${sensitiveReasons.join(", ")}.`
    };
  }

  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: result.exitCode === 0 ? "completed" : "failed",
    outputPath: item.outputPath,
    commandDisplay: commandDisplay(command),
    replacementKeys,
    envReplacementKeys,
    envRequirements: requirements,
    placeholders,
    ...(executableRequirement ? { executableRequirement } : {}),
    startedAt,
    completedAt: (options.now?.() ?? new Date()).toISOString(),
    exitCode: result.exitCode,
    ...(captureStdoutTo && result.exitCode === 0 ? { stdoutCapturedTo: captureStdoutTo } : {}),
    ...(captureStdoutTo && result.exitCode !== 0 ? { stdoutDiscardedReason: "Command exited non-zero; stdout was not written to the evidence output path." } : {}),
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stderrSensitiveReasons.length > 0 ? { stderrSensitiveReasons } : {}),
    message: result.exitCode === 0 ? "Command completed." : `Command exited with code ${result.exitCode}.`
  };
}

async function writeJsonCompatibleText(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export async function runReleaseEvidenceTargetRun(
  rawOptions: ReleaseEvidenceTargetRunOptions
): Promise<ReleaseEvidenceTargetRunResult> {
  const pack = await readJsonObject(rawOptions.packPath);

  if (pack.schemaVersion !== "siteflow.releaseEvidenceRehearsalPack.v1" ||
    pack.name !== "siteflow-release-evidence-rehearsal-pack") {
    throw new Error(`${rawOptions.packPath} must be a siteflow-release-evidence-rehearsal-pack JSON file.`);
  }

  validateReleaseEvidenceRehearsalPackContract(pack);

  const release = releaseInfo(pack);
  const outputDir = stringValue(pack.outputDir) ?? path.dirname(rawOptions.packPath);
  const baseEnv = { ...(rawOptions.env ?? process.env) };
  const envReplacements = rawOptions.envReplacements ?? {};
  const replacements = resolveReplacementsFromEnv(rawOptions.replacements ?? {}, envReplacements, baseEnv);
  const options: ReleaseEvidenceTargetRunOptions = {
    ...rawOptions,
    runRecordPath: rawOptions.runRecordPath ?? path.join(outputDir, "release-evidence-target-run.json"),
    gapReportDir: rawOptions.gapReportDir ?? path.join(outputDir, "gap-reports"),
    replacements: rawOptions.replacements ?? {},
    resolvedReplacements: replacements,
    envReplacements,
    planOnly: rawOptions.planOnly ?? false,
    failOnGaps: rawOptions.failOnGaps ?? false,
    env: baseEnv,
    maxEvidenceAgeHours: positiveNumber(rawOptions.maxEvidenceAgeHours, 168, "maxEvidenceAgeHours")
  };
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const steps: ReleaseEvidenceTargetRunStep[] = [];
  const gapReports: ReleaseEvidenceTargetRunGapSnapshot[] = [];
  const items = collectRunItems(pack);
  const reportEnv = gapReportEnv(items, baseEnv);

  await mkdir(path.dirname(options.runRecordPath!), { recursive: true });
  await mkdir(options.gapReportDir!, { recursive: true });

  if (release.targetEnvironment !== options.confirmTargetEnvironment) {
    for (const item of items) {
      steps.push(skippedStep(item, "Target run was skipped because --confirm-target-environment did not match the pack release target environment."));
    }

    return persistRunRecord(
      options,
      startedAt,
      pack,
      steps,
      gapReports,
      `Confirmed target environment ${options.confirmTargetEnvironment} does not match pack target ${release.targetEnvironment ?? "unknown"}.`,
      "blocked"
    );
  }

  gapReports.push(await writeGapReportSnapshot(options, "000-initial", reportEnv));
  await persistRunRecord(options, startedAt, pack, steps, gapReports, "Target evidence run started.", "running");

  if (options.planOnly) {
    for (const item of items) {
      steps.push(await commandPlanStep(item, options, baseEnv));
    }

    const planBlocked = steps.some((step) => step.status === "blocked");
    const initialGapBlocked = gapReports[0]?.status === "blocked";
    const failOnInitialGaps = Boolean(options.failOnGaps && initialGapBlocked);
    const blockedStatus = planBlocked || failOnInitialGaps;
    const blockedMessage = planBlocked && failOnInitialGaps
      ? "Plan-only target evidence run found unresolved command prerequisites and blocked release:evidence:gaps in the initial gap report. No target commands were executed."
      : planBlocked
        ? "Plan-only target evidence run found unresolved command prerequisites. No target commands were executed."
        : "Plan-only target evidence run found blocked release:evidence:gaps in the initial gap report. No target commands were executed.";

    return persistRunRecord(
      options,
      startedAt,
      pack,
      steps,
      gapReports,
      blockedStatus
        ? blockedMessage
        : "Plan-only target evidence run planned target commands. No target commands were executed and no production evidence was generated.",
      blockedStatus ? "blocked" : "planned"
    );
  }

  let stopped = false;

  for (const [index, item] of items.entries()) {
    if (stopped) {
      steps.push(skippedStep(item, "Skipped because an earlier step did not complete."));
      continue;
    }

    const step = await executeItem(item, options, baseEnv);

    steps.push(step);

    const snapshotId = `${String(index + 1).padStart(3, "0")}-${item.id}`;

    gapReports.push(await writeGapReportSnapshot(options, snapshotId, reportEnv));

    if (step.status !== "completed" && !options.continueOnError) {
      stopped = true;
    }

    await persistRunRecord(
      options,
      startedAt,
      pack,
      steps,
      gapReports,
      stopped ? `Target evidence run stopped at ${item.id}: ${step.message}` : "Target evidence run in progress.",
      stopped ? undefined : "running"
    );
  }

  const commandsCompleted = steps.every((step) => step.status === "completed");
  const finalGapReport = gapReports.at(-1);
  const finalGapsPassed = finalGapReport?.status === "passed";
  const finalMessage = commandsCompleted && finalGapsPassed
    ? "Target evidence commands completed and release:evidence:gaps reports no remaining gaps. Final release:evidence output remains the production gate."
    : commandsCompleted
      ? "Target evidence commands completed, but release:evidence:gaps still reports gaps."
      : "Target evidence run has incomplete, blocked, failed, or skipped steps.";

  return persistRunRecord(
    options,
    startedAt,
    pack,
    steps,
    gapReports,
    finalMessage,
    commandsCompleted && !finalGapsPassed ? "failed" : undefined
  );
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!stringValue(value) || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parseReplacement(raw: string) {
  const separator = raw.indexOf("=");

  if (separator <= 0) {
    throw new Error("--set requires KEY=value.");
  }

  return {
    key: raw.slice(0, separator),
    value: raw.slice(separator + 1)
  };
}

function parseEnvReplacement(raw: string) {
  const separator = raw.indexOf("=");

  if (separator <= 0) {
    throw new Error("--set-env requires KEY=ENV_NAME.");
  }

  return {
    key: raw.slice(0, separator),
    envName: raw.slice(separator + 1)
  };
}

export function parseReleaseEvidenceTargetRunArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    replacements: {},
    envReplacements: {},
    continueOnError: false,
    planOnly: false,
    failOnGaps: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--pack") {
      parsed.packPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--confirm-target-environment") {
      parsed.confirmTargetEnvironment = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--run-record") {
      parsed.runRecordPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--gap-report-dir") {
      parsed.gapReportDir = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--set") {
      const replacement = parseReplacement(readArgValue(args, index, arg));
      parsed.replacements[replacement.key] = replacement.value;
      index += 1;
    } else if (arg === "--set-env") {
      const replacement = parseEnvReplacement(readArgValue(args, index, arg));
      parsed.envReplacements[replacement.key] = replacement.envName;
      index += 1;
    } else if (arg === "--continue-on-error") {
      parsed.continueOnError = true;
    } else if (arg === "--plan-only") {
      parsed.planOnly = true;
    } else if (arg === "--fail-on-gaps") {
      parsed.failOnGaps = true;
    } else if (arg === "--max-evidence-age-hours") {
      parsed.maxEvidenceAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help) {
    requiredValue(parsed.packPath, "--pack");
    requiredValue(parsed.confirmTargetEnvironment, "--confirm-target-environment");
  }

  positiveNumber(parsed.maxEvidenceAgeHours, 168, "--max-evidence-age-hours");
  validateReplacements(parsed.replacements);
  validateEnvReplacements(parsed.envReplacements);

  return parsed;
}

export function releaseEvidenceTargetRunUsage() {
  return [
    "Usage: npm run --silent release:evidence:target-run -- --pack <release-evidence-rehearsal-pack.json> --confirm-target-environment <name> [options]",
    "",
    "Options:",
    "  --run-record <file>                 Write target run record. Default: <pack-output-dir>/release-evidence-target-run.json.",
    "  --gap-report-dir <dir>              Directory for release:evidence:gaps snapshots. Default: <pack-output-dir>/gap-reports.",
    "  --set <placeholder=value>           Replace a pack placeholder such as <direct-api-url> before executing commands. Repeatable.",
    "  --set-env <placeholder=ENV_NAME>    Read a placeholder replacement from ENV_NAME; records only the key and env name. Repeatable.",
    "  --continue-on-error                 Continue after blocked or failed steps. Default: stop at first incomplete step.",
    "  --plan-only                         Validate command placeholders, environment requirements, and executables without executing target commands.",
    "  --fail-on-gaps                      In plan-only mode, return blocked when the initial release:evidence:gaps snapshot is blocked.",
    "  --max-evidence-age-hours <hours>    Maximum age passed to gap report snapshots.",
    "  --json                              Print machine-readable target run record.",
    "  --help                              Show this help.",
    "",
    "The target runner executes rehearsal-pack commands and records gap snapshots. It does not make a release production-ready; the final release:evidence output is still the promotion gate."
  ].join("\n");
}

function writeHumanResult(result: ReleaseEvidenceTargetRunResult, io: CliIo) {
  const output = result.status === "completed" || result.status === "planned" ? io.stdout : io.stderr;

  output.write(`SiteFlow release evidence target run: ${result.status}\n`);
  output.write(`Run record: ${result.runRecordPath}\n`);
  output.write(`Gap reports: ${result.gapReportDir}\n`);
  output.write(`${result.message}\n`);

  for (const step of result.steps.filter((entry) => entry.status !== "completed" && entry.status !== "planned")) {
    output.write(`- ${step.id}: ${step.status} - ${step.message}\n`);
  }
}

export async function runReleaseEvidenceTargetRunCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseEvidenceTargetRunOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseEvidenceTargetRunArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseEvidenceTargetRunUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseEvidenceTargetRunUsage()}\n`);
    return 0;
  }

  try {
    const result = await runReleaseEvidenceTargetRun({
      ...baseOptions,
      packPath: parsed.packPath!,
      confirmTargetEnvironment: parsed.confirmTargetEnvironment!,
      runRecordPath: parsed.runRecordPath,
      gapReportDir: parsed.gapReportDir,
      replacements: parsed.replacements,
      envReplacements: parsed.envReplacements,
      continueOnError: parsed.continueOnError,
      planOnly: parsed.planOnly,
      failOnGaps: parsed.failOnGaps,
      maxEvidenceAgeHours: parsed.maxEvidenceAgeHours
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result = {
      name: "siteflow-release-evidence-target-run",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      message: error instanceof Error ? error.message : String(error),
      exitCode: 2
    };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stderr.write(`${result.message}\n`);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runReleaseEvidenceTargetRunCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
