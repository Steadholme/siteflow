import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface NonSessionCredentialEvidenceTemplateOptions {
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  operatorName: string;
  ticketId: string;
  outputPath?: string;
  checkedAt?: string;
  now?: () => Date;
}

interface ParsedArgs {
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  operatorName?: string;
  ticketId?: string;
  outputPath?: string;
  checkedAt?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const supportedProviderManagedCredentialTypes = [
  "database",
  "webhook_secret",
  "ssh_deploy_key",
  "log_drain_signing_secret",
  "deploy_hook_token"
];

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

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function validIsoTimestamp(value: string) {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error("--checked-at must be an ISO timestamp.");
  }

  return new Date(value).toISOString();
}

function redactedPair() {
  return {
    oldCredential: {
      redactedIdentifier: null,
      prefix: null,
      oldCredentialRejected: null
    },
    newCredential: {
      redactedIdentifier: null,
      prefix: null,
      newCredentialAccepted: null
    }
  };
}

function noRawArchiveFlags() {
  return {
    rawSecretArchived: false,
    rawCredentialArchived: false,
    authorizationHeaderArchived: false,
    databaseUrlPasswordArchived: false
  };
}

function baseCredential(type: string, checkedAt: string, note: string) {
  return {
    type,
    status: "todo",
    checkedAt,
    owner: null,
    ticketId: null,
    note,
    ...redactedPair(),
    ...noRawArchiveFlags()
  };
}

function scopedApiTokenCredential(checkedAt: string) {
  return {
    ...baseCredential("scoped_api_token", checkedAt, "Fill with a scoped API token rotation or cutover record."),
    createEvidencePresent: null,
    revokeEvidencePresent: null,
    auditEventsPresent: null,
    consumerCutoverVerified: null,
    leastPrivilegeReviewed: null,
    newCredential: {
      ...redactedPair().newCredential,
      scopes: []
    }
  };
}

function runtimeTokenCredential(type: "root_api_token" | "metrics_token", checkedAt: string) {
  return {
    ...baseCredential(type, checkedAt, `Fill with ${type} strength, secret-store update, reload, and acceptance/rejection proof.`),
    strengthStatus: null,
    secretStoreUpdated: null,
    serviceReloaded: null,
    scraperReloaded: null
  };
}

function appSealingSecretCredential(checkedAt: string) {
  return {
    ...baseCredential("app_sealing_secret", checkedAt, "Fill with app/sealing secret backup, reseal, rollback, and spot-check evidence."),
    backupCompleted: null,
    reSealPlanPresent: null,
    rollbackPlanPresent: null,
    spotCheckPassed: null,
    riskAccepted: null,
    automaticRotationClaimed: false
  };
}

function providerManagedCredential(type: string, checkedAt: string) {
  return {
    ...baseCredential(type, checkedAt, `Fill with provider-managed ${type} rotation proof and dependent service verification.`),
    providerRotationProofPresent: null,
    dependentServiceVerified: null
  };
}

export function createNonSessionCredentialEvidenceTemplate(options: NonSessionCredentialEvidenceTemplateOptions) {
  const checkedAt = options.checkedAt ? validIsoTimestamp(options.checkedAt) : (options.now?.() ?? new Date()).toISOString();

  return {
    schemaVersion: "siteflow.nonSessionCredentialEvidence.v1",
    name: "siteflow-non-session-credential-evidence",
    status: "blocked",
    dryRun: true,
    template: true,
    checkedAt,
    targetEnvironment: requiredValue(options.targetEnvironment, "--target-environment"),
    release: {
      commitRef: requiredValue(options.commitRef, "--commit-ref"),
      repository: requiredValue(options.repo, "--repo"),
      branch: requiredValue(options.branch, "--branch")
    },
    instructions: [
      "Replace every todo/null field with observations from the target or target-equivalent credential rotation run.",
      "Set dryRun=false and status=passed only after every credential and break-glass section reflects real non-dry-run evidence.",
      "Archive only redacted identifiers or prefixes. Do not paste raw tokens, passwords, Authorization headers, database URLs, private keys, webhook secrets, or session secrets into this file."
    ],
    operatorName: requiredValue(options.operatorName, "--operator-name"),
    ticketId: requiredValue(options.ticketId, "--release-ticket"),
    credentials: [
      scopedApiTokenCredential(checkedAt),
      runtimeTokenCredential("root_api_token", checkedAt),
      runtimeTokenCredential("metrics_token", checkedAt),
      appSealingSecretCredential(checkedAt),
      ...supportedProviderManagedCredentialTypes.map((type) => providerManagedCredential(type, checkedAt))
    ],
    breakGlass: {
      status: "todo",
      checkedAt,
      incidentTicket: null,
      approverCount: null,
      approvalExceptionAccepted: null,
      emergencyCredentialSource: null,
      leastPrivilegeReviewed: null,
      timeBoundedAccess: null,
      postIncidentRevocationPlanned: null,
      rawCredentialArchived: false
    },
    limitations: {
      automaticRotationClaimed: false,
      siteflowRotatedExternalSecrets: false,
      notes: [
        "SiteFlow does not automatically rotate external or non-session credentials.",
        "This template is a handoff aid only; it is not passing evidence."
      ]
    }
  };
}

export async function writeNonSessionCredentialEvidenceTemplate(options: NonSessionCredentialEvidenceTemplateOptions) {
  const template = createNonSessionCredentialEvidenceTemplate(options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }

  return template;
}

export function parseNonSessionCredentialEvidenceTemplateArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--commit-ref") {
      parsed.commitRef = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--ticket-id" || arg === "--release-ticket") {
      parsed.ticketId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--checked-at") {
      parsed.checkedAt = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function nonSessionCredentialEvidenceTemplateUsage() {
  return [
    "Usage: npm run --silent non-session-credential:evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --output <file>          Write the raw evidence template JSON.",
    "  --checked-at <iso>       Use a fixed template timestamp.",
    "  --json                   Print the template JSON.",
    "  --help                   Show this help."
  ].join("\n");
}

export async function runNonSessionCredentialEvidenceTemplateCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<NonSessionCredentialEvidenceTemplateOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseNonSessionCredentialEvidenceTemplateArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${nonSessionCredentialEvidenceTemplateUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${nonSessionCredentialEvidenceTemplateUsage()}\n`);
    return 0;
  }

  try {
    const template = await writeNonSessionCredentialEvidenceTemplate({
      ...baseOptions,
      commitRef: requiredValue(parsed.commitRef ?? baseOptions.commitRef, "--commit-ref"),
      repo: requiredValue(parsed.repo ?? baseOptions.repo, "--repo"),
      branch: requiredValue(parsed.branch ?? baseOptions.branch, "--branch"),
      targetEnvironment: requiredValue(parsed.targetEnvironment ?? baseOptions.targetEnvironment, "--target-environment"),
      operatorName: requiredValue(parsed.operatorName ?? baseOptions.operatorName, "--operator-name"),
      ticketId: requiredValue(parsed.ticketId ?? baseOptions.ticketId, "--release-ticket"),
      outputPath: parsed.outputPath ?? baseOptions.outputPath,
      checkedAt: parsed.checkedAt ?? baseOptions.checkedAt
    });

    if (parsed.json || !parsed.outputPath) {
      io.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    } else {
      io.stdout.write(`Non-session credential evidence template written to ${parsed.outputPath}.\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runNonSessionCredentialEvidenceTemplateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
