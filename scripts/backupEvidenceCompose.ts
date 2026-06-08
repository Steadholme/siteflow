import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluateBackupEvidence, type BackupEvidenceCheckResult } from "./backupEvidenceCheck.js";

type ComposeStatus = "composed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface BackupEvidenceComposeOptions {
  backupVerifyPath: string;
  restoreDrillPath: string;
  policyPath: string;
  backupOffloadPath?: string;
  backupFetchPath?: string;
  providerSecurityAuditPath?: string;
  backupPrunePath?: string;
  outputPath?: string;
  checkOutputPath?: string;
  operatorName?: string;
  releaseTicket?: string;
  requireOffHost?: boolean;
  check?: boolean;
  maxBackupAgeHours?: number;
  maxRestoreDrillAgeHours?: number;
  now?: () => Date;
}

export interface ComposedBackupEvidence {
  backupVerify: Record<string, unknown>;
  restoreDrill: Record<string, unknown>;
  backupOffload?: Record<string, unknown>;
  backupFetch?: Record<string, unknown>;
  backupProviderSecurityAudit?: Record<string, unknown>;
  backupPrune?: Record<string, unknown>;
  backupPolicy: Record<string, unknown>;
  operatorName: string;
  releaseTicket: string;
}

export interface BackupEvidenceComposeCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface BackupEvidenceComposeResult {
  name: "siteflow-backup-evidence-compose";
  status: ComposeStatus;
  checkedAt: string;
  outputPath?: string;
  checkOutputPath?: string;
  evidence?: ComposedBackupEvidence;
  checkResult?: BackupEvidenceCheckResult;
  checks: BackupEvidenceComposeCheck[];
  exitCode: number;
}

interface ParsedArgs {
  backupVerifyPath?: string;
  restoreDrillPath?: string;
  policyPath?: string;
  backupOffloadPath?: string;
  backupFetchPath?: string;
  providerSecurityAuditPath?: string;
  backupPrunePath?: string;
  outputPath?: string;
  checkOutputPath?: string;
  operatorName?: string;
  releaseTicket?: string;
  requireOffHost: boolean;
  check: boolean;
  maxBackupAgeHours?: number;
  maxRestoreDrillAgeHours?: number;
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

function positiveNumber(value: number | undefined, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return value;
}

async function readJsonObject(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

function addCheck(checks: BackupEvidenceComposeCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function blockedResult(
  options: BackupEvidenceComposeOptions,
  checkedAt: string,
  checks: BackupEvidenceComposeCheck[],
  evidence?: ComposedBackupEvidence,
  checkResult?: BackupEvidenceCheckResult
): BackupEvidenceComposeResult {
  return {
    name: "siteflow-backup-evidence-compose",
    status: "blocked",
    checkedAt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
    ...(evidence ? { evidence } : {}),
    ...(checkResult ? { checkResult } : {}),
    checks,
    exitCode: 1
  };
}

export async function composeBackupEvidence(
  options: BackupEvidenceComposeOptions
): Promise<BackupEvidenceComposeResult> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const operatorName = stringValue(options.operatorName);
  const releaseTicket = stringValue(options.releaseTicket);
  const checks: BackupEvidenceComposeCheck[] = [];

  addCheck(checks, "operator_name", Boolean(operatorName), "Backup evidence compose requires --operator-name.");
  addCheck(checks, "release_ticket", Boolean(releaseTicket), "Backup evidence compose requires --release-ticket or --ticket-id.");
  addCheck(
    checks,
    "off_host_inputs",
    !options.requireOffHost || Boolean(options.backupOffloadPath && options.backupFetchPath && options.providerSecurityAuditPath && options.backupPrunePath),
    "--require-off-host requires --backup-offload, --backup-fetch, --provider-security-audit, and --backup-prune inputs."
  );

  if (checks.some((check) => check.status === "fail")) {
    return blockedResult(options, checkedAt, checks);
  }

  const backupVerify = await readJsonObject(options.backupVerifyPath);
  const restoreDrill = await readJsonObject(options.restoreDrillPath);
  const backupPolicy = await readJsonObject(options.policyPath);
  const backupOffload = options.backupOffloadPath ? await readJsonObject(options.backupOffloadPath) : undefined;
  const backupFetch = options.backupFetchPath ? await readJsonObject(options.backupFetchPath) : undefined;
  const backupProviderSecurityAudit = options.providerSecurityAuditPath ? await readJsonObject(options.providerSecurityAuditPath) : undefined;
  const backupPrune = options.backupPrunePath ? await readJsonObject(options.backupPrunePath) : undefined;
  const evidence: ComposedBackupEvidence = {
    backupVerify,
    restoreDrill,
    ...(backupOffload ? { backupOffload } : {}),
    ...(backupFetch ? { backupFetch } : {}),
    ...(backupProviderSecurityAudit ? { backupProviderSecurityAudit } : {}),
    ...(backupPrune ? { backupPrune } : {}),
    backupPolicy,
    operatorName: operatorName!,
    releaseTicket: releaseTicket!
  };

  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  const shouldCheck = Boolean(options.check || options.checkOutputPath);
  let checkResult: BackupEvidenceCheckResult | undefined;

  if (shouldCheck) {
    checkResult = evaluateBackupEvidence(evidence, {
      evidencePath: options.outputPath ?? "<composed-backup-evidence>",
      maxBackupAgeHours: options.maxBackupAgeHours,
      maxRestoreDrillAgeHours: options.maxRestoreDrillAgeHours,
      requireOffHost: options.requireOffHost,
      now: options.now
    });

    if (options.checkOutputPath) {
      await writeFile(options.checkOutputPath, `${JSON.stringify(checkResult, null, 2)}\n`, "utf8");
    }

    addCheck(checks, "backup_evidence_check", checkResult.status === "passed", "Composed backup evidence must pass backup:evidence checks.");

    if (checkResult.status !== "passed") {
      return blockedResult(options, checkedAt, checks, evidence, checkResult);
    }
  }

  return {
    name: "siteflow-backup-evidence-compose",
    status: "composed",
    checkedAt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
    evidence,
    ...(checkResult ? { checkResult } : {}),
    checks,
    exitCode: 0
  };
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseBackupEvidenceComposeArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    requireOffHost: false,
    check: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--backup-verify") {
      parsed.backupVerifyPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--restore-drill") {
      parsed.restoreDrillPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-offload") {
      parsed.backupOffloadPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-fetch") {
      parsed.backupFetchPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--provider-security-audit" || arg === "--backup-provider-security-audit") {
      parsed.providerSecurityAuditPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-prune") {
      parsed.backupPrunePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--policy" || arg === "--backup-policy") {
      parsed.policyPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--release-ticket" || arg === "--ticket-id") {
      parsed.releaseTicket = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--check-output") {
      parsed.checkOutputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-backup-age-hours") {
      parsed.maxBackupAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--max-restore-drill-age-hours") {
      parsed.maxRestoreDrillAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--require-off-host") {
      parsed.requireOffHost = true;
    } else if (arg === "--check") {
      parsed.check = true;
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
      ["--backup-verify", parsed.backupVerifyPath],
      ["--restore-drill", parsed.restoreDrillPath],
      ["--policy", parsed.policyPath],
      ["--operator-name", parsed.operatorName],
      ["--release-ticket", parsed.releaseTicket]
    ];
    const missing = required.filter(([, value]) => !value).map(([flag]) => flag);

    if (missing.length > 0) {
      throw new Error(`Missing required option(s): ${missing.join(", ")}.`);
    }
  }

  positiveNumber(parsed.maxBackupAgeHours, "--max-backup-age-hours");
  positiveNumber(parsed.maxRestoreDrillAgeHours, "--max-restore-drill-age-hours");

  return parsed;
}

export function backupEvidenceComposeUsage() {
  return [
    "Usage: npm run --silent backup:evidence:compose -- --backup-verify <file> --restore-drill <file> --policy <file> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --backup-offload <file>             Backup offload command JSON output.",
    "  --backup-fetch <file>               Backup fetch command JSON output.",
    "  --provider-security-audit <file>    Provider security audit summary evidence.",
    "  --backup-prune <file>               Backup prune command JSON output.",
    "  --require-off-host                  Require offload, fetch, provider security audit, and non-dry-run prune inputs before composing.",
    "  --check                             Run backup:evidence checks against the composed evidence.",
    "  --check-output <file>               Write backup:evidence checker output for release:evidence:compose.",
    "  --output <file>                     Write raw composed backup evidence.",
    "  --max-backup-age-hours <hours>      Maximum backup/offload/prune evidence age passed to --check.",
    "  --max-restore-drill-age-hours <h>   Maximum restore-drill evidence age passed to --check.",
    "  --ticket-id <id>                    Alias for --release-ticket.",
    "  --json                              Print raw composed evidence when composed; print diagnostics when blocked.",
    "  --help                              Show this help.",
    "",
    "Do not pass raw composed evidence directly to release:evidence:compose. Use --check-output for the checker output expected by release bundles."
  ].join("\n");
}

function writeHumanResult(result: BackupEvidenceComposeResult, io: CliIo) {
  const output = result.status === "composed" ? io.stdout : io.stderr;

  output.write(`SiteFlow backup evidence compose status: ${result.status}\n`);

  if (result.outputPath) {
    output.write(`Output: ${result.outputPath}\n`);
  }

  if (result.checkOutputPath) {
    output.write(`Check output: ${result.checkOutputPath}\n`);
  }

  if (result.status === "blocked") {
    output.write("Checks:\n");
    for (const check of result.checks) {
      output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
    }
  }
}

export async function runBackupEvidenceComposeCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<BackupEvidenceComposeOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseBackupEvidenceComposeArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${backupEvidenceComposeUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${backupEvidenceComposeUsage()}\n`);
    return 0;
  }

  try {
    const result = await composeBackupEvidence({
      ...baseOptions,
      backupVerifyPath: parsed.backupVerifyPath!,
      restoreDrillPath: parsed.restoreDrillPath!,
      backupOffloadPath: parsed.backupOffloadPath,
      backupFetchPath: parsed.backupFetchPath,
      providerSecurityAuditPath: parsed.providerSecurityAuditPath,
      backupPrunePath: parsed.backupPrunePath,
      policyPath: parsed.policyPath!,
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      operatorName: parsed.operatorName,
      releaseTicket: parsed.releaseTicket,
      requireOffHost: parsed.requireOffHost,
      check: parsed.check,
      maxBackupAgeHours: parsed.maxBackupAgeHours,
      maxRestoreDrillAgeHours: parsed.maxRestoreDrillAgeHours
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result.status === "composed" ? result.evidence : result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: BackupEvidenceComposeResult = {
      name: "siteflow-backup-evidence-compose",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      checks: [
        {
          name: "compose",
          status: "fail",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      exitCode: 1
    };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runBackupEvidenceComposeCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
