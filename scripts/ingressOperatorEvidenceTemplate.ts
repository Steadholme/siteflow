import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface IngressOperatorEvidenceTemplateOptions {
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  operatorName: string;
  ticketId: string;
  publicBaseUrl?: string;
  trustProxyPolicy?: string;
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
  publicBaseUrl?: string;
  trustProxyPolicy?: string;
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

export function createIngressOperatorEvidenceTemplate(options: IngressOperatorEvidenceTemplateOptions) {
  const checkedAt = options.checkedAt ? validIsoTimestamp(options.checkedAt) : (options.now?.() ?? new Date()).toISOString();
  const publicBaseUrl = options.publicBaseUrl ? normalizedHttpsUrl(options.publicBaseUrl) : null;
  const operatorName = requiredValue(options.operatorName, "--operator-name");
  const ticketId = requiredValue(options.ticketId, "--release-ticket");

  return {
    schemaVersion: "siteflow.ingressOperatorEvidence.v1",
    name: "siteflow-ingress-operator-evidence-template",
    status: "blocked",
    dryRun: true,
    template: true,
    checkedAt,
    environment: requiredValue(options.targetEnvironment, "--target-environment"),
    publicBaseUrl,
    release: {
      commitRef: requiredValue(options.commitRef, "--commit-ref"),
      repository: requiredValue(options.repo, "--repo"),
      branch: requiredValue(options.branch, "--branch")
    },
    instructions: [
      "Use this raw JSON as ingress:evidence:collect --operator-evidence after replacing todo/null fields with target operator observations.",
      "The collector combines these operator-only sections with active direct-port, API rate-limit, and non-API route probes.",
      "Keep this template blocked and dry-run until every todo/null field below is replaced with real target proof.",
      "Do not paste credentials, cookies, or sensitive request headers into this file."
    ],
    forwardedHeaders: todoSection(checkedAt, "Prove the trusted ingress overwrites client-supplied X-Forwarded-* values before requests reach the API.", {
      xForwardedForOverwritten: null,
      xForwardedHostOverwritten: null,
      xForwardedProtoOverwritten: null,
      proxyAddXForwardedForUsed: null,
      observationSource: null,
      evidenceLocation: null
    }),
    proxySourcePolicy: todoSection(checkedAt, "Prove the configured proxy source policy matches the final ingress hop and does not trust every source.", {
      configured: nullableString(options.trustProxyPolicy),
      finalHopMatched: null,
      allSourcesTrusted: null,
      finalHopSource: null,
      evidenceLocation: null
    }),
    deploymentTopology: todoSection(checkedAt, "Record the API instance, process, and ingress shape used by this release.", {
      apiInstanceCount: null,
      apiProcessCount: null,
      ingressCount: null,
      multiInstance: null,
      multiProcess: null,
      multiIngress: null,
      mode: null,
      evidenceLocation: null
    }),
    apiRateLimit: todoSection(checkedAt, "Prove the API limiter is enforced at the edge/shared layer for the declared topology.", {
      edgeEnforced: null,
      sharedAcrossInstances: null,
      processLocalOnly: null,
      limiterScope: null,
      limiterType: null,
      enforcementPoint: null,
      evidenceLocation: null
    }),
    operator: todoSection(checkedAt, "Record the operator and ticket that own the target ingress proof.", {
      name: operatorName,
      ticketId,
      ticketUrl: null,
      reviewedBy: null
    }),
    operatorName,
    ticketId
  };
}

export async function writeIngressOperatorEvidenceTemplate(options: IngressOperatorEvidenceTemplateOptions) {
  const template = createIngressOperatorEvidenceTemplate(options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }

  return template;
}

export function parseIngressOperatorEvidenceTemplateArgs(args: string[]): ParsedArgs {
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
    } else if (arg === "--public-base-url") {
      parsed.publicBaseUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--trust-proxy-policy") {
      parsed.trustProxyPolicy = readArgValue(args, index, arg);
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

export function ingressOperatorEvidenceTemplateUsage() {
  return [
    "Usage: node scripts/runCompiledScript.mjs ingressOperatorEvidenceTemplate.js -- --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --public-base-url <url>       Include the HTTPS public target URL.",
    "  --trust-proxy-policy <policy> Pre-fill the expected trusted proxy policy.",
    "  --output <file>               Write the raw operator evidence template JSON.",
    "  --checked-at <iso>            Use a fixed template timestamp.",
    "  --json                        Print the template JSON.",
    "  --help                        Show this help."
  ].join("\n");
}

export async function runIngressOperatorEvidenceTemplateCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<IngressOperatorEvidenceTemplateOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseIngressOperatorEvidenceTemplateArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${ingressOperatorEvidenceTemplateUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${ingressOperatorEvidenceTemplateUsage()}\n`);
    return 0;
  }

  try {
    const template = await writeIngressOperatorEvidenceTemplate({
      ...baseOptions,
      commitRef: requiredValue(parsed.commitRef ?? baseOptions.commitRef, "--commit-ref"),
      repo: requiredValue(parsed.repo ?? baseOptions.repo, "--repo"),
      branch: requiredValue(parsed.branch ?? baseOptions.branch, "--branch"),
      targetEnvironment: requiredValue(parsed.targetEnvironment ?? baseOptions.targetEnvironment, "--target-environment"),
      operatorName: requiredValue(parsed.operatorName ?? baseOptions.operatorName, "--operator-name"),
      ticketId: requiredValue(parsed.ticketId ?? baseOptions.ticketId, "--release-ticket"),
      publicBaseUrl: parsed.publicBaseUrl ?? baseOptions.publicBaseUrl,
      trustProxyPolicy: parsed.trustProxyPolicy ?? baseOptions.trustProxyPolicy,
      outputPath: parsed.outputPath ?? baseOptions.outputPath,
      checkedAt: parsed.checkedAt ?? baseOptions.checkedAt
    });

    if (parsed.json || !parsed.outputPath) {
      io.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    } else {
      io.stdout.write(`Ingress operator evidence template written to ${parsed.outputPath}.\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runIngressOperatorEvidenceTemplateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
