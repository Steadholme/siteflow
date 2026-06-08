import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSiteFlowBackup,
  fetchSiteFlowBackup,
  offloadSiteFlowBackup,
  pruneSiteFlowBackups,
  redactDatabaseUrl,
  restoreDrillSiteFlowBackup,
  verifySiteFlowBackup,
  type BackupRuntimeDependencies
} from "../cli/backup.js";
import { composeBackupEvidence, type BackupEvidenceComposeResult } from "./backupEvidenceCompose.js";

type AutomationStatus = "completed" | "blocked" | "failed";
type StepStatus = "completed" | "blocked" | "failed" | "skipped";

export interface BackupAutomationRunOptions {
  backupRoot: string;
  databaseUrl: string;
  artifactRoot: string;
  offloadTarget: string;
  offloadKmsKeyRef?: string;
  offloadProviderRetentionMode?: string;
  offloadProviderRetentionDays?: number;
  offloadProviderRetentionContract?: string;
  offloadProviderProof?: boolean;
  providerSecurityAuditPath?: string;
  restoreDrillDatabaseUrl: string;
  restoreDrillArtifactRoot: string;
  restoreDrillConfirmed?: boolean;
  evidenceDir: string;
  policyPath: string;
  runRecordPath?: string;
  runHistoryPath?: string;
  operatorName: string;
  releaseTicket: string;
  retentionDays: number;
  minimumBackups: number;
  version?: string;
  backupName?: string;
  maxBackupAgeHours?: number;
  maxRestoreDrillAgeHours?: number;
  now?: () => Date;
  dependencies?: BackupRuntimeDependencies;
}

export interface BackupAutomationStep {
  id: string;
  status: StepStatus;
  outputPath?: string;
  message: string;
}

export interface BackupAutomationRunResult {
  name: "siteflow-backup-automation-run";
  status: AutomationStatus;
  startedAt: string;
  completedAt: string;
  backupPath?: string;
  evidenceDir: string;
  evidenceFiles: {
    backup?: string;
    backupVerify?: string;
    restoreDrill?: string;
    backupOffload?: string;
    backupFetch?: string;
    backupProviderSecurityAudit?: string;
    backupPrunePlan?: string;
    backupPrune?: string;
    backupPolicy?: string;
    backupEvidenceRaw?: string;
    backupEvidenceCheck?: string;
    backupAutomationRun?: string;
    backupAutomationRunHistory?: string;
  };
  steps: BackupAutomationStep[];
  composeResult?: BackupEvidenceComposeResult;
  message?: string;
  exitCode: number;
}

interface ParsedArgs {
  backupRoot?: string;
  databaseUrl?: string;
  artifactRoot?: string;
  offloadTarget?: string;
  offloadKmsKeyRef?: string;
  offloadProviderRetentionMode?: string;
  offloadProviderRetentionDays?: number;
  offloadProviderRetentionContract?: string;
  offloadProviderProof: boolean;
  providerSecurityAuditPath?: string;
  restoreDrillDatabaseUrl?: string;
  restoreDrillArtifactRoot?: string;
  restoreDrillConfirmed: boolean;
  evidenceDir?: string;
  policyPath?: string;
  runRecordPath?: string;
  runHistoryPath?: string;
  operatorName?: string;
  releaseTicket?: string;
  retentionDays?: number;
  minimumBackups?: number;
  version?: string;
  backupName?: string;
  maxBackupAgeHours?: number;
  maxRestoreDrillAgeHours?: number;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultVersion = "siteflow-backup-automation";
const defaultMaxBackupAgeHours = 24;
const defaultMaxRestoreDrillAgeHours = 168;
const runHistorySchemaVersion = "siteflow.backupAutomationRunHistory.v1";
const maxRunHistoryEntries = 90;

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredValue(value: string | undefined, label: string) {
  const normalized = stringValue(value);

  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function positiveInteger(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function positiveNumber(value: number | undefined, fallback: number, label: string): number {
  const candidate = value ?? fallback;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = stringValue(args[index + 1]);

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "backup";
}

function defaultBackupName(now: Date) {
  return `siteflow-${safeName(now.toISOString())}`;
}

function sameResolvedPath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

function pathContainsOrEquals(rootPath: string, targetPath: string) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));

  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string) {
  return pathContainsOrEquals(left, right) || pathContainsOrEquals(right, left);
}

function postgresTargetKey(databaseUrl: string) {
  const parsed = new URL(databaseUrl);

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Database URL must use postgres:// or postgresql://.");
  }

  return [
    parsed.hostname.toLowerCase(),
    parsed.port || "5432",
    decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
  ].join("|");
}

function samePostgresTarget(left: string, right: string) {
  try {
    return postgresTargetKey(left) === postgresTargetKey(right);
  } catch {
    return left.trim() === right.trim();
  }
}

function filePaths(evidenceDir: string) {
  return {
    backup: path.join(evidenceDir, "backup.json"),
    backupVerify: path.join(evidenceDir, "backup-verify.json"),
    restoreDrill: path.join(evidenceDir, "restore-drill.json"),
    backupOffload: path.join(evidenceDir, "backup-offload.json"),
    backupFetch: path.join(evidenceDir, "backup-fetch.json"),
    fetchedBackups: path.join(evidenceDir, "fetched-backups"),
    backupPrunePlan: path.join(evidenceDir, "backup-prune-plan.json"),
    backupPrune: path.join(evidenceDir, "backup-prune.json"),
    backupEvidenceRaw: path.join(evidenceDir, "backup-evidence-raw.json"),
    backupEvidenceCheck: path.join(evidenceDir, "backup-evidence.json"),
    backupAutomationRun: path.join(evidenceDir, "backup-automation-run.json")
  };
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stepCompleted(steps: BackupAutomationStep[], id: string, outputPath: string, message: string) {
  steps.push({ id, status: "completed", outputPath, message });
}

function stepFailed(steps: BackupAutomationStep[], id: string, message: string) {
  steps.push({ id, status: "failed", message });
}

async function readExistingRunHistory(filePath: string) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

    if (!isObject(parsed)) {
      throw new Error(`${filePath} must contain a JSON object.`);
    }

    if (parsed.name !== "siteflow-backup-automation-run-history" || parsed.schemaVersion !== runHistorySchemaVersion) {
      throw new Error(`${filePath} must contain ${runHistorySchemaVersion} history evidence.`);
    }

    return Array.isArray(parsed.runs) ? parsed.runs.filter(isObject) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function runHistoryEntry(options: BackupAutomationRunOptions, result: BackupAutomationRunResult) {
  const evidenceFiles = result.evidenceFiles;
  const restoreDrillCompleted = result.steps.some((step) => step.id === "restore_drill" && step.status === "completed");
  const composeStatus = result.composeResult?.status;
  const backupEvidenceStatus = result.composeResult?.checkResult?.status;

  return {
    runId: `${safeName(result.completedAt)}-${safeName(path.basename(result.backupPath ?? "blocked-run"))}`,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    exitCode: result.exitCode,
    ...(result.backupPath ? { backupPath: result.backupPath } : {}),
    evidenceDir: result.evidenceDir,
    evidenceFiles: {
      ...(evidenceFiles.backupAutomationRun ? { backupAutomationRun: evidenceFiles.backupAutomationRun } : {}),
      ...(evidenceFiles.backupEvidenceCheck ? { backupEvidenceCheck: evidenceFiles.backupEvidenceCheck } : {}),
      ...(evidenceFiles.restoreDrill ? { restoreDrill: evidenceFiles.restoreDrill } : {}),
      ...(evidenceFiles.backupOffload ? { backupOffload: evidenceFiles.backupOffload } : {}),
      ...(evidenceFiles.backupFetch ? { backupFetch: evidenceFiles.backupFetch } : {}),
      ...(evidenceFiles.backupProviderSecurityAudit ? { backupProviderSecurityAudit: evidenceFiles.backupProviderSecurityAudit } : {}),
      ...(evidenceFiles.backupPrune ? { backupPrune: evidenceFiles.backupPrune } : {})
    },
    steps: result.steps.map((step) => ({
      id: step.id,
      status: step.status,
      ...(step.outputPath ? { outputPath: step.outputPath } : {})
    })),
    restoreDrillCompleted,
    ...(restoreDrillCompleted ? { restoreDrillCompletedAt: result.completedAt } : {}),
    offloadCompleted: result.steps.some((step) => step.id === "backup_offload" && step.status === "completed"),
    fetchCompleted: result.steps.some((step) => step.id === "backup_fetch" && step.status === "completed"),
    pruneCompleted: result.steps.some((step) => step.id === "backup_prune" && step.status === "completed"),
    ...(composeStatus ? { composeStatus } : {}),
    ...(backupEvidenceStatus ? { backupEvidenceStatus } : {}),
    operatorName: options.operatorName,
    releaseTicket: options.releaseTicket
  };
}

async function writeRunHistory(options: BackupAutomationRunOptions, result: BackupAutomationRunResult) {
  if (!options.runHistoryPath) {
    return;
  }

  const existingRuns = await readExistingRunHistory(options.runHistoryPath);
  const runs = [...existingRuns, runHistoryEntry(options, result)]
    .sort((left, right) => Date.parse(String(left.completedAt ?? "")) - Date.parse(String(right.completedAt ?? "")))
    .slice(-maxRunHistoryEntries);

  await writeJson(options.runHistoryPath, {
    schemaVersion: runHistorySchemaVersion,
    name: "siteflow-backup-automation-run-history",
    updatedAt: result.completedAt,
    cadence: {
      restoreDrillMaxGapHours: options.maxRestoreDrillAgeHours ?? defaultMaxRestoreDrillAgeHours,
      minimumSuccessfulRestoreDrills: 2
    },
    maxEntries: maxRunHistoryEntries,
    runs
  });
}

async function writeRunRecord(options: BackupAutomationRunOptions, result: BackupAutomationRunResult) {
  const outputPath = options.runRecordPath ?? filePaths(options.evidenceDir).backupAutomationRun;
  const resultWithRecord: BackupAutomationRunResult = {
    ...result,
    evidenceFiles: {
      ...result.evidenceFiles,
      backupAutomationRun: outputPath,
      ...(options.runHistoryPath ? { backupAutomationRunHistory: options.runHistoryPath } : {})
    },
    steps: [
      ...result.steps,
      {
        id: "backup_automation_run_record",
        status: "completed",
        outputPath,
        message: "Wrote machine-readable backup automation run record."
      },
      ...(options.runHistoryPath
        ? [
            {
              id: "backup_automation_run_history",
              status: "completed" as const,
              outputPath: options.runHistoryPath,
              message: "Appended machine-readable backup automation run history."
            }
          ]
        : [])
    ]
  };

  await writeJson(outputPath, resultWithRecord);
  await writeRunHistory(options, resultWithRecord);

  return resultWithRecord;
}

function blockedResult(
  options: BackupAutomationRunOptions,
  startedAt: string,
  completedAt: string,
  steps: BackupAutomationStep[],
  message: string
): BackupAutomationRunResult {
  return {
    name: "siteflow-backup-automation-run",
    status: "blocked",
    startedAt,
    completedAt,
    evidenceDir: options.evidenceDir,
    evidenceFiles: {},
    steps,
    message,
    exitCode: 2
  };
}

function failedResult(
  options: BackupAutomationRunOptions,
  startedAt: string,
  completedAt: string,
  evidenceFiles: BackupAutomationRunResult["evidenceFiles"],
  steps: BackupAutomationStep[],
  message: string,
  backupPath?: string,
  composeResult?: BackupEvidenceComposeResult
): BackupAutomationRunResult {
  return {
    name: "siteflow-backup-automation-run",
    status: "failed",
    startedAt,
    completedAt,
    ...(backupPath ? { backupPath } : {}),
    evidenceDir: options.evidenceDir,
    evidenceFiles,
    steps,
    ...(composeResult ? { composeResult } : {}),
    message,
    exitCode: 1
  };
}

export async function runBackupAutomation(
  options: BackupAutomationRunOptions
): Promise<BackupAutomationRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const steps: BackupAutomationStep[] = [];
  const evidenceFiles: BackupAutomationRunResult["evidenceFiles"] = {};
  const retentionDays = positiveInteger(options.retentionDays, "--retention-days");
  const minimumBackups = positiveInteger(options.minimumBackups, "--minimum-backups");
  const maxBackupAgeHours = positiveNumber(options.maxBackupAgeHours, defaultMaxBackupAgeHours, "--max-backup-age-hours");
  const maxRestoreDrillAgeHours = positiveNumber(
    options.maxRestoreDrillAgeHours,
    defaultMaxRestoreDrillAgeHours,
    "--max-restore-drill-age-hours"
  );

  requiredValue(options.backupRoot, "--backup-root");
  requiredValue(options.databaseUrl, "--database-url");
  requiredValue(options.artifactRoot, "--artifact-root");
  requiredValue(options.offloadTarget, "--offload-target");
  requiredValue(options.restoreDrillDatabaseUrl, "--restore-drill-database-url");
  requiredValue(options.restoreDrillArtifactRoot, "--restore-drill-artifact-root");
  requiredValue(options.evidenceDir, "--evidence-dir");
  requiredValue(options.policyPath, "--policy");
  requiredValue(options.operatorName, "--operator-name");
  requiredValue(options.releaseTicket, "--release-ticket");

  if (!options.restoreDrillConfirmed) {
    return writeRunRecord(
      options,
      blockedResult(
        options,
        startedAt,
        now().toISOString(),
        steps,
        "Backup automation requires --restore-drill-yes and disposable restore-drill targets."
      )
    );
  }

  if (samePostgresTarget(options.restoreDrillDatabaseUrl, options.databaseUrl)) {
    return writeRunRecord(
      options,
      blockedResult(
        options,
        startedAt,
        now().toISOString(),
        steps,
        "Backup automation requires the restore-drill database URL to differ from the source database URL."
      )
    );
  }

  if (sameResolvedPath(options.restoreDrillArtifactRoot, options.artifactRoot) || pathsOverlap(options.restoreDrillArtifactRoot, options.artifactRoot)) {
    return writeRunRecord(
      options,
      blockedResult(
        options,
        startedAt,
        now().toISOString(),
        steps,
        "Backup automation requires the restore-drill artifact root to be isolated from the source artifact root."
      )
    );
  }

  const paths = filePaths(options.evidenceDir);
  const backupName = safeName(options.backupName ?? defaultBackupName(startedAtDate));
  const backupPath = path.resolve(options.backupRoot, backupName);
  const dependencies: BackupRuntimeDependencies = {
    ...options.dependencies,
    now
  };
  let composeResult: BackupEvidenceComposeResult | undefined;
  let activeStepId = "backup";

  try {
    await mkdir(options.backupRoot, { recursive: true });
    await mkdir(options.evidenceDir, { recursive: true });

    const backup = await createSiteFlowBackup(
      {
        output: backupPath,
        databaseUrl: options.databaseUrl,
        artifactRoot: options.artifactRoot,
        version: options.version ?? defaultVersion
      },
      dependencies
    );
    evidenceFiles.backup = paths.backup;
    await writeJson(paths.backup, backup);
    stepCompleted(steps, "backup", paths.backup, "Created backup and manifest.");

    activeStepId = "backup_verify";
    const backupVerify = await verifySiteFlowBackup({ backup: backupPath });
    evidenceFiles.backupVerify = paths.backupVerify;
    await writeJson(paths.backupVerify, backupVerify);
    stepCompleted(steps, "backup_verify", paths.backupVerify, "Verified backup manifest, dump, and artifact checksums.");

    activeStepId = "backup_offload";
    const backupOffload = await offloadSiteFlowBackup(
      {
        backup: backupPath,
        target: options.offloadTarget,
        kmsKeyRef: options.offloadKmsKeyRef,
        providerRetentionMode: options.offloadProviderRetentionMode,
        providerRetentionDays: options.offloadProviderRetentionDays,
        providerRetentionContract: options.offloadProviderRetentionContract,
        verifyProviderConfig: options.offloadProviderProof
      },
      dependencies
    );
    evidenceFiles.backupOffload = paths.backupOffload;
    await writeJson(paths.backupOffload, backupOffload);
    stepCompleted(steps, "backup_offload", paths.backupOffload, "Offloaded backup and verified target object integrity.");

    let restoreDrillBackupPath = backupPath;

    if (backupOffload.target.provider === "s3") {
      activeStepId = "backup_fetch";
      const backupFetch = await fetchSiteFlowBackup(
        {
          source: backupOffload.target.location,
          output: paths.fetchedBackups,
          expectedTreeSha256: backupOffload.target.treeSha256,
          expectedObjectCount: backupOffload.target.objectCount,
          expectedTotalBytes: backupOffload.target.totalBytes
        },
        dependencies
      );
      evidenceFiles.backupFetch = paths.backupFetch;
      await writeJson(paths.backupFetch, backupFetch);
      restoreDrillBackupPath = backupFetch.backupPath;
      stepCompleted(steps, "backup_fetch", paths.backupFetch, "Fetched off-host backup and verified downloaded object integrity.");
    }

    activeStepId = "restore_drill";
    const restoreDrill = await restoreDrillSiteFlowBackup(
      {
        backup: restoreDrillBackupPath,
        databaseUrl: options.restoreDrillDatabaseUrl,
        artifactRoot: options.restoreDrillArtifactRoot
      },
      dependencies
    );
    evidenceFiles.restoreDrill = paths.restoreDrill;
    await writeJson(paths.restoreDrill, restoreDrill);
    stepCompleted(steps, "restore_drill", paths.restoreDrill, "Completed restore drill against caller-confirmed disposable targets.");

    activeStepId = "backup_prune_plan";
    const backupPrunePlan = await pruneSiteFlowBackups(
      {
        backupRoot: options.backupRoot,
        retentionDays,
        minimumBackups,
        dryRun: true
      },
      dependencies
    );
    evidenceFiles.backupPrunePlan = paths.backupPrunePlan;
    await writeJson(paths.backupPrunePlan, backupPrunePlan);
    stepCompleted(steps, "backup_prune_plan", paths.backupPrunePlan, "Planned retention pruning before destructive execution.");

    activeStepId = "backup_prune";
    const backupPrune = await pruneSiteFlowBackups(
      {
        backupRoot: options.backupRoot,
        retentionDays,
        minimumBackups,
        yes: true
      },
      dependencies
    );
    evidenceFiles.backupPrune = paths.backupPrune;
    await writeJson(paths.backupPrune, backupPrune);
    stepCompleted(steps, "backup_prune", paths.backupPrune, "Executed retention pruning after explicit automation confirmation.");

    evidenceFiles.backupPolicy = options.policyPath;
    stepCompleted(steps, "backup_policy", options.policyPath, "Using operator-provided backup policy evidence.");

    if (options.providerSecurityAuditPath) {
      evidenceFiles.backupProviderSecurityAudit = options.providerSecurityAuditPath;
      stepCompleted(
        steps,
        "backup_provider_security_audit",
        options.providerSecurityAuditPath,
        "Using operator-provided provider security audit summary evidence."
      );
    }

    activeStepId = "backup_evidence";
    composeResult = await composeBackupEvidence({
      backupVerifyPath: paths.backupVerify,
      restoreDrillPath: paths.restoreDrill,
      backupOffloadPath: paths.backupOffload,
      backupFetchPath: evidenceFiles.backupFetch ? paths.backupFetch : undefined,
      providerSecurityAuditPath: options.providerSecurityAuditPath,
      backupPrunePath: paths.backupPrune,
      policyPath: options.policyPath,
      operatorName: options.operatorName,
      releaseTicket: options.releaseTicket,
      requireOffHost: true,
      outputPath: paths.backupEvidenceRaw,
      checkOutputPath: paths.backupEvidenceCheck,
      maxBackupAgeHours,
      maxRestoreDrillAgeHours,
      now
    });

    if (composeResult.evidence) {
      evidenceFiles.backupEvidenceRaw = paths.backupEvidenceRaw;
    }

    if (composeResult.checkResult) {
      evidenceFiles.backupEvidenceCheck = paths.backupEvidenceCheck;
    }

    if (composeResult.status !== "composed") {
      stepFailed(steps, "backup_evidence", "Composed backup evidence did not pass backup:evidence checks.");
      return writeRunRecord(
        options,
        failedResult(
          options,
          startedAt,
          now().toISOString(),
          evidenceFiles,
          steps,
          "Backup automation completed command steps, but backup evidence check failed.",
          backupPath,
          composeResult
        )
      );
    }

    stepCompleted(steps, "backup_evidence", paths.backupEvidenceCheck, "Composed raw backup evidence and wrote passing checker output.");

    return writeRunRecord(options, {
      name: "siteflow-backup-automation-run",
      status: "completed",
      startedAt,
      completedAt: now().toISOString(),
      backupPath,
      evidenceDir: options.evidenceDir,
      evidenceFiles,
      steps,
      composeResult,
      exitCode: 0
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Backup automation failed.";
    const message = redactDatabaseUrl(redactDatabaseUrl(rawMessage, options.databaseUrl), options.restoreDrillDatabaseUrl);

    if (!steps.some((step) => step.status === "failed")) {
      stepFailed(steps, activeStepId, message);
    }

    return writeRunRecord(
      options,
      failedResult(options, startedAt, now().toISOString(), evidenceFiles, steps, message, backupPath, composeResult)
    );
  }
}

export function parseBackupAutomationRunArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    restoreDrillConfirmed: false,
    json: false,
    help: false,
    offloadProviderProof: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--backup-root") {
      parsed.backupRoot = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--database-url") {
      parsed.databaseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--artifact-root") {
      parsed.artifactRoot = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--offload-target") {
      parsed.offloadTarget = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--offload-kms-key-ref") {
      parsed.offloadKmsKeyRef = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--offload-provider-retention-mode") {
      parsed.offloadProviderRetentionMode = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--offload-provider-retention-days") {
      parsed.offloadProviderRetentionDays = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--offload-provider-retention-contract" || arg === "--offload-retention-contract") {
      parsed.offloadProviderRetentionContract = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--offload-provider-proof") {
      parsed.offloadProviderProof = true;
    } else if (arg === "--provider-security-audit" || arg === "--backup-provider-security-audit") {
      parsed.providerSecurityAuditPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--restore-drill-database-url") {
      parsed.restoreDrillDatabaseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--restore-drill-artifact-root") {
      parsed.restoreDrillArtifactRoot = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--restore-drill-yes") {
      parsed.restoreDrillConfirmed = true;
    } else if (arg === "--evidence-dir") {
      parsed.evidenceDir = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--policy" || arg === "--backup-policy") {
      parsed.policyPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--run-record") {
      parsed.runRecordPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--run-history") {
      parsed.runHistoryPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--release-ticket" || arg === "--ticket-id") {
      parsed.releaseTicket = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--retention-days") {
      parsed.retentionDays = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--minimum-backups") {
      parsed.minimumBackups = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--version") {
      parsed.version = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-name") {
      parsed.backupName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-backup-age-hours") {
      parsed.maxBackupAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--max-restore-drill-age-hours") {
      parsed.maxRestoreDrillAgeHours = Number(readArgValue(args, index, arg));
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
    const required = [
      ["--backup-root", parsed.backupRoot],
      ["--database-url", parsed.databaseUrl],
      ["--artifact-root", parsed.artifactRoot],
      ["--offload-target", parsed.offloadTarget],
      ["--restore-drill-database-url", parsed.restoreDrillDatabaseUrl],
      ["--restore-drill-artifact-root", parsed.restoreDrillArtifactRoot],
      ["--evidence-dir", parsed.evidenceDir],
      ["--policy", parsed.policyPath],
      ["--operator-name", parsed.operatorName],
      ["--release-ticket", parsed.releaseTicket],
      ["--retention-days", parsed.retentionDays],
      ["--minimum-backups", parsed.minimumBackups]
    ];
    const missing = required.filter(([, value]) => value === undefined || value === "").map(([flag]) => flag);

    if (missing.length > 0) {
      throw new Error(`Missing required option(s): ${missing.join(", ")}.`);
    }
  }

  return parsed;
}

export function backupAutomationRunUsage() {
  return [
    "Usage: npm run --silent backup:automation -- --backup-root <dir> --database-url <url> --artifact-root <dir> --offload-target file://<dir>|s3://<bucket/prefix> --restore-drill-database-url <url> --restore-drill-artifact-root <dir> --restore-drill-yes --evidence-dir <dir> --operator-name <name> --release-ticket <id> --retention-days <days> --minimum-backups <count> [options]",
    "",
    "Options:",
    "  --policy <file>                    Required backup policy evidence JSON with schedule, retention, RPO/RTO, and alert ownership.",
    "  --run-record <file>                Stable machine-readable automation run record for /metrics collection.",
    "  --run-history <file>               Append backup automation run history for recurring restore-drill evidence.",
    "  --offload-kms-key-ref <ref>        Operator-provided KMS key reference for s3:// offload evidence.",
    "  --offload-provider-retention-mode <mode>  Operator-provided object retention or immutability mode for s3:// offload evidence.",
    "  --offload-provider-retention-days <days>  Operator-provided provider retention window for s3:// offload evidence.",
    "  --offload-provider-retention-contract <id> Operator/provider retention contract, policy, lifecycle rule, or object lock rule id.",
    "  --offload-provider-proof         Verify uploaded S3 manifest object SSE-KMS and Object Lock metadata with AWS s3api.",
    "  --provider-security-audit <file> Provider security audit summary evidence for production off-host backup checks.",
    "  --backup-name <name>               Directory name for the new backup under --backup-root.",
    "  --version <value>                  Version recorded in the backup manifest.",
    `  --max-backup-age-hours <hours>     Backup/offload/prune freshness. Default: ${defaultMaxBackupAgeHours}.`,
    `  --max-restore-drill-age-hours <h>  Restore-drill freshness. Default: ${defaultMaxRestoreDrillAgeHours}.`,
    "  --ticket-id <id>                   Alias for --release-ticket.",
    "  --json                            Print JSON result.",
    "  --help                            Show this help."
  ].join("\n");
}

function writeHumanResult(result: BackupAutomationRunResult, io: CliIo) {
  const output = result.status === "completed" ? io.stdout : io.stderr;

  output.write(`SiteFlow backup automation: ${result.status}\n`);
  output.write(`Evidence: ${result.evidenceDir}\n`);
  if (result.backupPath) {
    output.write(`Backup: ${result.backupPath}\n`);
  }
  if (result.message) {
    output.write(`${result.message}\n`);
  }
}

export async function runBackupAutomationRunCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<BackupAutomationRunOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseBackupAutomationRunArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${backupAutomationRunUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${backupAutomationRunUsage()}\n`);
    return 0;
  }

  const result = await runBackupAutomation({
    ...baseOptions,
    backupRoot: parsed.backupRoot!,
    databaseUrl: parsed.databaseUrl!,
    artifactRoot: parsed.artifactRoot!,
    offloadTarget: parsed.offloadTarget!,
    offloadKmsKeyRef: parsed.offloadKmsKeyRef,
    offloadProviderRetentionMode: parsed.offloadProviderRetentionMode,
    offloadProviderRetentionDays: parsed.offloadProviderRetentionDays,
    offloadProviderRetentionContract: parsed.offloadProviderRetentionContract,
    offloadProviderProof: parsed.offloadProviderProof,
    providerSecurityAuditPath: parsed.providerSecurityAuditPath,
    restoreDrillDatabaseUrl: parsed.restoreDrillDatabaseUrl!,
    restoreDrillArtifactRoot: parsed.restoreDrillArtifactRoot!,
    restoreDrillConfirmed: parsed.restoreDrillConfirmed,
    evidenceDir: parsed.evidenceDir!,
    policyPath: parsed.policyPath!,
    runRecordPath: parsed.runRecordPath,
    runHistoryPath: parsed.runHistoryPath,
    operatorName: parsed.operatorName!,
    releaseTicket: parsed.releaseTicket!,
    retentionDays: parsed.retentionDays!,
    minimumBackups: parsed.minimumBackups!,
    version: parsed.version,
    backupName: parsed.backupName,
    maxBackupAgeHours: parsed.maxBackupAgeHours,
    maxRestoreDrillAgeHours: parsed.maxRestoreDrillAgeHours
  });

  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, io);
  }

  return result.exitCode;
}

if (isEntrypoint()) {
  runBackupAutomationRunCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
