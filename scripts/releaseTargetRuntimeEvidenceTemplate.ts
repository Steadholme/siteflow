import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ReleaseTargetRuntimeEvidenceTemplateOptions {
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  publicBaseUrl: string;
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
  publicBaseUrl?: string;
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

function normalizedHttpsUrl(value: string) {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--public-base-url must be a valid URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("--public-base-url must use https.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--public-base-url must not include credentials, query strings, or fragments.");
  }

  return parsed.toString().replace(/\/$/, "");
}

function todoSection(checkedAt: string, note: string, fields: Record<string, unknown>) {
  return {
    status: "todo",
    checkedAt,
    note,
    ...fields
  };
}

export function createReleaseTargetRuntimeEvidenceTemplate(options: ReleaseTargetRuntimeEvidenceTemplateOptions) {
  const checkedAt = options.checkedAt ? validIsoTimestamp(options.checkedAt) : (options.now?.() ?? new Date()).toISOString();
  const publicBaseUrl = normalizedHttpsUrl(requiredValue(options.publicBaseUrl, "--public-base-url"));

  return {
    schemaVersion: "siteflow.targetRuntimeEvidence.v1",
    name: "siteflow-target-runtime-evidence",
    status: "blocked",
    dryRun: true,
    template: true,
    checkedAt,
    targetEnvironment: requiredValue(options.targetEnvironment, "--target-environment"),
    publicBaseUrl,
    release: {
      commitRef: requiredValue(options.commitRef, "--commit-ref"),
      repository: requiredValue(options.repo, "--repo"),
      branch: requiredValue(options.branch, "--branch")
    },
    instructions: [
      "Replace every todo/null field with observations collected on the target host after the production Compose profile is started.",
      "Set dryRun=false, template=false, and status=passed only after every section contains real target evidence.",
      "Do not archive expanded env files, raw docker compose config, raw secrets, Authorization headers, Set-Cookie values, or full unredacted logs."
    ],
    composeConfig: todoSection(checkedAt, "Run docker compose --env-file <target.env> -f docker-compose.production.yml config on the target host and record only sanitized summaries.", {
      command: "docker compose --env-file <target.env> -f docker-compose.production.yml config",
      source: "target_host_docker_compose_config",
      composeProject: null,
      services: [],
      secrets: [],
      healthchecks: [],
      images: {
        postgres: null,
        api: null,
        worker: null
      },
      imagePolicy: {
        postgresDigestPinned: null,
        apiDigestPinned: null,
        workerDigestPinned: null,
        noBuildFallback: null
      },
      buildServices: [],
      buildFallbacks: [],
      noBuildFallback: null,
      configSha256: null,
      sanitized: null,
      rawConfigArchived: null
    }),
    startup: todoSection(checkedAt, "Start or restart the target service with systemd or docker compose and record active/enabled state.", {
      command: null,
      systemdActive: null,
      systemdEnabled: null,
      composeUpExitCode: null
    }),
    serviceHealth: todoSection(checkedAt, "Record docker compose ps/health summaries after startup.", {
      command: "docker compose --env-file <target.env> -f docker-compose.production.yml ps --format json",
      composeProject: null,
      postgresHealthy: null,
      apiHealthy: null,
      workerRunning: null,
      workerHealthy: null,
      workerQueueProbePassed: null,
      workerHeartbeatFresh: null,
      restartLoopDetected: null,
      services: []
    }),
    readiness: todoSection(checkedAt, "Probe /readyz from target loopback and public ingress after startup.", {
      loopbackStatusCode: null,
      publicStatusCode: null,
      loopbackBodyStatus: null,
      publicBodyStatus: null
    }),
    imageBinding: todoSection(checkedAt, "Bind running API and worker containers to the published release image digest.", {
      command: "docker compose --env-file <target.env> -f docker-compose.production.yml ps --format json && docker image inspect <api-image> <worker-image>",
      expectedDigest: null,
      apiImageDigest: null,
      workerImageDigest: null,
      apiContainerId: null,
      workerContainerId: null,
      apiImageId: null,
      workerImageId: null,
      apiMatchesReleaseImage: null,
      workerMatchesReleaseImage: null
    }),
    restartSmoke: todoSection(checkedAt, "Restart the target service and re-check service health/readiness.", {
      restartCommand: null,
      restarted: null,
      serviceHealthAfterRestart: null,
      workerHealthAfterRestart: null,
      readinessAfterRestart: null
    }),
    logSanity: todoSection(checkedAt, "Record redacted startup-window log summary for API, worker, and Postgres.", {
      fatalErrors: null,
      workerPreflightFailures: null,
      secretLeakFindings: null,
      rawLogsArchived: null
    }),
    negativeEvidence: {
      noRawComposeConfigArchived: null,
      noRawEnvArchived: null,
      noRawSecretsArchived: null,
      noUnredactedLogsArchived: null
    },
    operatorName: requiredValue(options.operatorName, "--operator-name"),
    ticketId: requiredValue(options.ticketId, "--release-ticket")
  };
}

export async function writeReleaseTargetRuntimeEvidenceTemplate(options: ReleaseTargetRuntimeEvidenceTemplateOptions) {
  const evidence = createReleaseTargetRuntimeEvidenceTemplate(options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  return evidence;
}

export function parseReleaseTargetRuntimeEvidenceTemplateArgs(args: string[]): ParsedArgs {
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
    } else if (arg === "--public-base-url") {
      parsed.publicBaseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--release-ticket" || arg === "--ticket-id") {
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
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

export function releaseTargetRuntimeEvidenceTemplateUsage() {
  return [
    "Usage: npm run --silent release:target-runtime:evidence:template -- --commit-ref <sha> --repo <owner/name> --branch <branch> --target-environment <env> --public-base-url <url> --operator-name <name> --release-ticket <id> --output <file> [--json]",
    "",
    "Writes a blocked target runtime evidence template. Replace todo fields with target-host Compose, startup, health, readiness, image binding, restart, and log evidence before running release:target-runtime:evidence."
  ].join("\n");
}

export async function runReleaseTargetRuntimeEvidenceTemplateCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseTargetRuntimeEvidenceTemplateOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseTargetRuntimeEvidenceTemplateArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${releaseTargetRuntimeEvidenceTemplateUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseTargetRuntimeEvidenceTemplateUsage()}\n`);
    return 0;
  }

  try {
    const evidence = await writeReleaseTargetRuntimeEvidenceTemplate({
      ...baseOptions,
      commitRef: parsed.commitRef!,
      repo: parsed.repo!,
      branch: parsed.branch!,
      targetEnvironment: parsed.targetEnvironment!,
      publicBaseUrl: parsed.publicBaseUrl!,
      operatorName: parsed.operatorName!,
      ticketId: parsed.ticketId!,
      outputPath: parsed.outputPath,
      checkedAt: parsed.checkedAt
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } else {
      io.stdout.write(`Target runtime evidence template written${parsed.outputPath ? ` to ${parsed.outputPath}` : ""}.\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runReleaseTargetRuntimeEvidenceTemplateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
