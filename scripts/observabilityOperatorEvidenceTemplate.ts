import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ObservabilityOperatorEvidenceTemplateOptions {
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

const assetKinds = [
  "prometheus_scrape",
  "prometheus_rules",
  "alertmanager_route",
  "grafana_dashboard"
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

function todoSection(checkedAt: string, note: string, fields: Record<string, unknown>) {
  return {
    status: "todo",
    checkedAt,
    note,
    ...fields
  };
}

function renderedAssets() {
  return assetKinds.map((kind) => ({
    path: null,
    kind,
    sha256: null,
    ...(kind === "prometheus_rules" ? { content: null } : {})
  }));
}

function releaseIdentity(commitRef: string, repository: string, branch: string, targetEnvironment: string) {
  return {
    commitRef,
    repository,
    branch,
    targetEnvironment
  };
}

export function createObservabilityOperatorEvidenceTemplate(options: ObservabilityOperatorEvidenceTemplateOptions) {
  const checkedAt = options.checkedAt ? validIsoTimestamp(options.checkedAt) : (options.now?.() ?? new Date()).toISOString();
  const targetEnvironment = requiredValue(options.targetEnvironment, "--target-environment");
  const commitRef = requiredValue(options.commitRef, "--commit-ref");
  const repository = requiredValue(options.repo, "--repo");
  const branch = requiredValue(options.branch, "--branch");
  const operatorName = requiredValue(options.operatorName, "--operator-name");
  const ticketId = requiredValue(options.ticketId, "--release-ticket");
  const release = releaseIdentity(commitRef, repository, branch, targetEnvironment);

  return {
    schemaVersion: "siteflow.observabilityOperatorEvidence.v1",
    name: "siteflow-observability-operator-evidence-template",
    status: "blocked",
    dryRun: true,
    template: true,
    checkedAt,
    targetEnvironment,
    release,
    instructions: [
      "Use this raw JSON as observability:evidence:collect --operator-evidence after replacing todo/null fields with target operator observations.",
      "The collector still performs live /readyz and /metrics probes and reads backup automation evidence from its dedicated inputs.",
      "Keep this template blocked and dry-run until every todo/null field below is replaced with real target proof.",
      "Do not paste credentials, cookies, or sensitive request headers into this file."
    ],
    readinessProbe: todoSection(checkedAt, "Prove the target load balancer removes traffic when /readyz fails.", {
      failureStatusCode: null,
      trafficRemovedOnFailure: null,
      evidenceLocation: null
    }),
    observabilityProvisioning: {
      schemaVersion: "siteflow.observabilityProvisioning.v1",
      name: "siteflow-observability-provisioning-plan",
      generatedAt: null,
      target: {
        metricsPath: "/metrics",
        alertReceiverName: null,
        grafanaDashboardUid: null
      },
      renderedAssets: renderedAssets()
    },
    observabilityApplyProof: {
      schemaVersion: "siteflow.observabilityApplyProof.v1",
      name: "siteflow-observability-apply-proof",
      status: "todo",
      appliedAt: null,
      evidenceSource: null,
      operator: operatorName,
      ticket: ticketId,
      dryRun: true,
      template: true,
      provisioningPlan: {
        schemaVersion: "siteflow.observabilityProvisioning.v1",
        target: {
          metricsPath: "/metrics",
          alertReceiverName: null,
          grafanaDashboardUid: null
        }
      },
      appliedAssets: renderedAssets().map(({ content: _content, ...asset }) => asset)
    },
    observabilityTargetStackProof: {
      schemaVersion: "siteflow.observabilityTargetStackProof.v1",
      name: "siteflow-observability-target-stack-proof",
      status: "todo",
      checkedAt: null,
      evidenceSource: "target_stack_api",
      operator: operatorName,
      ticket: ticketId,
      dryRun: true,
      template: true,
      release,
      prometheusRules: {
        status: "todo",
        apiUrl: null,
        renderedAssetKind: "prometheus_rules",
        renderedAssetSha256: null,
        matchedAlertNames: [],
        missingAlertNames: [],
        rulesHealth: null
      },
      grafanaDashboard: {
        status: "todo",
        apiUrl: null,
        dashboardUid: null,
        dashboardUrl: null,
        renderedAssetKind: "grafana_dashboard",
        renderedAssetSha256: null,
        observedTitle: null,
        matchedMetricNames: []
      },
      alertmanagerReceiver: {
        status: "todo",
        alertmanagerApiUrl: null,
        receiverName: null,
        proofId: null,
        sentAt: null,
        deliveredAt: null,
        receiverReceiptSha256: null
      }
    },
    alertDelivery: todoSection(checkedAt, "Record the target alert receiver test delivery.", {
      deliveredAt: null,
      delivered: null,
      channel: null,
      target: null,
      evidenceLocation: null
    }),
    dashboard: todoSection(checkedAt, "Record the target operations dashboard reference and owner.", {
      dashboardUrl: null,
      dashboardUid: null,
      owner: null,
      evidenceLocation: null
    }),
    logPipeline: todoSection(checkedAt, "Record target log retention and redaction spot-check evidence.", {
      retentionDays: null,
      redactionSpotCheckPassed: null,
      evidenceLocation: null
    }),
    operatorName,
    ticketId
  };
}

export async function writeObservabilityOperatorEvidenceTemplate(options: ObservabilityOperatorEvidenceTemplateOptions) {
  const template = createObservabilityOperatorEvidenceTemplate(options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }

  return template;
}

export function parseObservabilityOperatorEvidenceTemplateArgs(args: string[]): ParsedArgs {
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
    } else if (arg === "--target-environment" || arg === "--environment") {
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

export function observabilityOperatorEvidenceTemplateUsage() {
  return [
    "Usage: npm run --silent observability:operator-evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --output <file>          Write the raw operator evidence template JSON.",
    "  --checked-at <iso>       Use a fixed template timestamp.",
    "  --json                   Print the template JSON.",
    "  --help                   Show this help."
  ].join("\n");
}

export async function runObservabilityOperatorEvidenceTemplateCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ObservabilityOperatorEvidenceTemplateOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseObservabilityOperatorEvidenceTemplateArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${observabilityOperatorEvidenceTemplateUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${observabilityOperatorEvidenceTemplateUsage()}\n`);
    return 0;
  }

  try {
    const template = await writeObservabilityOperatorEvidenceTemplate({
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
      io.stdout.write(`Observability operator evidence template written to ${parsed.outputPath}.\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runObservabilityOperatorEvidenceTemplateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
