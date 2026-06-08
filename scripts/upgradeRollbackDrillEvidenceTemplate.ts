import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface UpgradeRollbackDrillEvidenceTemplateOptions {
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  operatorName: string;
  ticketId: string;
  fromVersion?: string | null;
  toVersion?: string | null;
  rollbackVersion?: string | null;
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
  fromVersion?: string;
  toVersion?: string;
  rollbackVersion?: string;
  outputPath?: string;
  checkedAt?: string;
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableString(value: unknown) {
  return stringValue(value) ?? null;
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

function todoSection(checkedAt: string, note: string, fields: Record<string, unknown>) {
  return {
    status: "todo",
    checkedAt,
    note,
    ...fields
  };
}

function todoPhase(checkedAt: string, note: string, fields: Record<string, unknown>) {
  return todoSection(checkedAt, note, fields);
}

export function createUpgradeRollbackDrillEvidenceTemplate(options: UpgradeRollbackDrillEvidenceTemplateOptions) {
  const checkedAt = options.checkedAt ? validIsoTimestamp(options.checkedAt) : (options.now?.() ?? new Date()).toISOString();
  const targetEnvironment = requiredValue(options.targetEnvironment, "--target-environment");
  const fromVersion = nullableString(options.fromVersion);
  const toVersion = nullableString(options.toVersion);
  const rollbackVersion = nullableString(options.rollbackVersion) ?? fromVersion;

  return {
    schemaVersion: "siteflow.upgradeRollbackDrill.v1",
    name: "siteflow-upgrade-rollback-drill",
    status: "blocked",
    dryRun: true,
    template: true,
    checkedAt,
    startedAt: null,
    completedAt: null,
    targetEnvironment,
    release: {
      commitRef: requiredValue(options.commitRef, "--commit-ref"),
      repository: requiredValue(options.repo, "--repo"),
      branch: requiredValue(options.branch, "--branch"),
      targetEnvironment,
      fromVersion,
      toVersion,
      rollbackVersion,
      operatorName: requiredValue(options.operatorName, "--operator-name"),
      releaseTicket: requiredValue(options.ticketId, "--release-ticket")
    },
    instructions: [
      "Replace every todo/null field with observations from the target or target-equivalent upgrade/rollback drill.",
      "Paste the passed backup:evidence checker output into backupEvidence after the real backup/restore/off-host drill completes.",
      "Set dryRun=false and status=passed only after upgrade and rollback were both executed as non-dry-run operations.",
      "Do not claim down-migration support unless it exists and was separately drilled; schema rollback evidence may be forward-compatible rollback proof."
    ],
    services: {
      api: {
        before: todoPhase(checkedAt, "Record the API image digest before upgrade.", {
          imageDigest: null
        }),
        after: todoPhase(checkedAt, "Record the API image digest after upgrade.", {
          imageDigest: null
        }),
        rollback: todoPhase(checkedAt, "Record the API image digest after rollback; it must match before.", {
          imageDigest: null
        })
      },
      worker: {
        before: todoPhase(checkedAt, "Record the worker image digest before upgrade.", {
          imageDigest: null
        }),
        after: todoPhase(checkedAt, "Record the worker image digest after upgrade.", {
          imageDigest: null
        }),
        rollback: todoPhase(checkedAt, "Record the worker image digest after rollback; it must match before.", {
          imageDigest: null
        })
      }
    },
    migrations: {
      before: todoPhase(checkedAt, "Record schema/migration version before upgrade.", {
        currentVersion: null
      }),
      after: todoPhase(checkedAt, "Record schema/migration version after upgrade.", {
        currentVersion: null
      }),
      rollback: todoPhase(checkedAt, "Record schema/migration version observed while the app is rolled back.", {
        currentVersion: null
      }),
      rollbackCompatibilityVerified: null,
      note: "For forward-only migrations, prove the rolled-back app is compatible with the post-upgrade schema."
    },
    backupEvidence: {
      status: "todo",
      checkedAt,
      note: "Paste output from npm run --silent backup:evidence -- --require-off-host --json for the same target drill window.",
      evidence: null
    },
    operations: {
      upgrade: todoPhase(checkedAt, "Record the successful non-dry-run upgrade operation.", {
        operationId: null,
        status: "todo",
        dryRun: true,
        completedAt: null
      }),
      rollback: todoPhase(checkedAt, "Record the successful non-dry-run rollback operation.", {
        operationId: null,
        status: "todo",
        dryRun: true,
        completedAt: null
      })
    },
    route: {
      before: todoPhase(checkedAt, "Record route/deployment/artifact state before upgrade.", {
        deploymentId: null,
        routeRevisionId: null,
        artifactChecksum: null
      }),
      after: todoPhase(checkedAt, "Record route/deployment/artifact state after upgrade.", {
        deploymentId: null,
        routeRevisionId: null,
        artifactChecksum: null
      }),
      rollback: todoPhase(checkedAt, "Record restored route/deployment/artifact state after rollback.", {
        deploymentId: null,
        routeRevisionId: null,
        artifactChecksum: null
      })
    },
    httpVerification: {
      rollback: todoPhase(checkedAt, "Verify the rolled-back public route returns the restored deployment and artifact.", {
        statusCode: null,
        deploymentId: null,
        artifactChecksum: null
      })
    },
    readiness: {
      before: todoPhase(checkedAt, "Record ready probe before upgrade.", {
        statusCode: null
      }),
      after: todoPhase(checkedAt, "Record ready probe after upgrade.", {
        statusCode: null
      }),
      rollback: todoPhase(checkedAt, "Record ready probe after rollback.", {
        statusCode: null
      }),
      trafficRemovedDuringUpgrade: null
    },
    observability: {
      metrics: todoSection(checkedAt, "Record rollback-correlated metrics after rollback completion.", {
        rollbackObserved: null,
        rollbackOperationId: null,
        scrapedAt: null
      }),
      logs: todoSection(checkedAt, "Record rollback operation logs after rollback completion.", {
        rollbackOperationId: null,
        queriedAt: null
      }),
      alertDelivery: todoSection(checkedAt, "Record rollback drill alert delivery or routing.", {
        channel: null,
        deliveredAt: null
      })
    },
    operatorName: requiredValue(options.operatorName, "--operator-name"),
    ticketId: requiredValue(options.ticketId, "--release-ticket")
  };
}

export async function writeUpgradeRollbackDrillEvidenceTemplate(options: UpgradeRollbackDrillEvidenceTemplateOptions) {
  const template = createUpgradeRollbackDrillEvidenceTemplate(options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }

  return template;
}

export function parseUpgradeRollbackDrillEvidenceTemplateArgs(args: string[]): ParsedArgs {
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
    } else if (arg === "--from-version") {
      parsed.fromVersion = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--to-version") {
      parsed.toVersion = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--rollback-version") {
      parsed.rollbackVersion = readArgValue(args, index, arg);
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

export function upgradeRollbackDrillEvidenceTemplateUsage() {
  return [
    "Usage: npm run --silent upgrade-rollback:evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --from-version <version>       Pre-fill the version before upgrade.",
    "  --to-version <version>         Pre-fill the version after upgrade.",
    "  --rollback-version <version>   Pre-fill the expected rollback version. Defaults to --from-version when provided.",
    "  --output <file>                Write the raw evidence template JSON.",
    "  --checked-at <iso>             Use a fixed template timestamp.",
    "  --json                         Print the template JSON.",
    "  --help                         Show this help."
  ].join("\n");
}

export async function runUpgradeRollbackDrillEvidenceTemplateCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<UpgradeRollbackDrillEvidenceTemplateOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseUpgradeRollbackDrillEvidenceTemplateArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${upgradeRollbackDrillEvidenceTemplateUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${upgradeRollbackDrillEvidenceTemplateUsage()}\n`);
    return 0;
  }

  try {
    const template = await writeUpgradeRollbackDrillEvidenceTemplate({
      ...baseOptions,
      commitRef: requiredValue(parsed.commitRef ?? baseOptions.commitRef, "--commit-ref"),
      repo: requiredValue(parsed.repo ?? baseOptions.repo, "--repo"),
      branch: requiredValue(parsed.branch ?? baseOptions.branch, "--branch"),
      targetEnvironment: requiredValue(parsed.targetEnvironment ?? baseOptions.targetEnvironment, "--target-environment"),
      operatorName: requiredValue(parsed.operatorName ?? baseOptions.operatorName, "--operator-name"),
      ticketId: requiredValue(parsed.ticketId ?? baseOptions.ticketId, "--release-ticket"),
      fromVersion: parsed.fromVersion ?? baseOptions.fromVersion,
      toVersion: parsed.toVersion ?? baseOptions.toVersion,
      rollbackVersion: parsed.rollbackVersion ?? baseOptions.rollbackVersion,
      outputPath: parsed.outputPath ?? baseOptions.outputPath,
      checkedAt: parsed.checkedAt ?? baseOptions.checkedAt
    });

    if (parsed.json || !parsed.outputPath) {
      io.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    } else {
      io.stdout.write(`Upgrade/rollback drill evidence template written to ${parsed.outputPath}.\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runUpgradeRollbackDrillEvidenceTemplateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
