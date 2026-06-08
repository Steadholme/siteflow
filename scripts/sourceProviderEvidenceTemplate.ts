import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface SourceProviderEvidenceTemplateOptions {
  commitRef: string;
  repo: string;
  branch: string;
  targetEnvironment: string;
  provider: string;
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
  provider?: string;
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

const supportedProviders = new Set(["github", "gitlab", "gitea", "generic"]);

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

function normalizedProvider(value: string | undefined) {
  const provider = requiredValue(value, "--provider").toLowerCase();

  if (!supportedProviders.has(provider)) {
    throw new Error("--provider must be one of github, gitlab, gitea, or generic.");
  }

  return provider;
}

function todoSection(checkedAt: string, note: string, fields: Record<string, unknown>) {
  return {
    status: "todo",
    checkedAt,
    note,
    ...fields
  };
}

export function createSourceProviderEvidenceTemplate(options: SourceProviderEvidenceTemplateOptions) {
  const checkedAt = options.checkedAt ? validIsoTimestamp(options.checkedAt) : (options.now?.() ?? new Date()).toISOString();
  const provider = normalizedProvider(options.provider);
  const commitRef = requiredValue(options.commitRef, "--commit-ref");
  const repository = requiredValue(options.repo, "--repo");
  const branch = requiredValue(options.branch, "--branch");

  return {
    schemaVersion: "siteflow.sourceProviderEvidence.v1",
    name: "siteflow-source-provider-evidence",
    status: "blocked",
    dryRun: true,
    template: true,
    checkedAt,
    targetEnvironment: requiredValue(options.targetEnvironment, "--target-environment"),
    provider,
    release: {
      commitRef,
      repository,
      branch
    },
    instructions: [
      "Replace every todo/null field with observations from the target or target-equivalent source provider run.",
      "Set dryRun=false and status=passed only after checkout, webhook, deploy key, host key, and provenance sections reflect real non-dry-run evidence.",
      "Archive only redacted identifiers, fingerprints, and booleans. Omit secret material and request auth headers."
    ],
    repository: {
      provider,
      fullName: repository,
      remoteUrl: null,
      visibility: null,
      urlEmbeddedCredentials: null
    },
    checkout: todoSection(checkedAt, "Record the provider checkout used for the release build.", {
      commitRef,
      headSha: null,
      exactCommitVerified: null,
      headMatchesCommit: null,
      remoteUrl: null
    }),
    webhook: todoSection(checkedAt, "Record the signed webhook delivery selected for this release.", {
      deliveryId: null,
      event: null,
      signatureVerified: null,
      secretConfigured: null,
      rawSecretArchived: false,
      signatureHeaderArchived: false
    }),
    deployKey: todoSection(checkedAt, "Record repository access policy and mounted deploy-key proof when a private checkout is required.", {
      required: null,
      mounted: null,
      available: null,
      mode: null,
      path: null,
      fingerprint: null,
      rawCredentialArchived: false
    }),
    hostKey: todoSection(checkedAt, "Record pinned host-key policy for SSH remotes.", {
      pinned: null,
      knownHostsConfigured: null,
      fingerprint: null,
      acceptedBlindly: null,
      rawSecretArchived: false
    }),
    releaseProvenance: todoSection(checkedAt, "Record the release provenance binding emitted after provider checkout.", {
      commitRef,
      repository,
      branch,
      generatedAt: null,
      artifactId: null
    }),
    negativeEvidence: {
      rawCredentialArchived: false,
      rawSecretArchived: false,
      urlEmbeddedCredentials: false,
      requestAuthHeadersArchived: false,
      secretMaterialArchived: false
    },
    rawCredentialArchived: false,
    rawSecretArchived: false,
    operatorName: requiredValue(options.operatorName, "--operator-name"),
    ticketId: requiredValue(options.ticketId, "--release-ticket")
  };
}

export async function writeSourceProviderEvidenceTemplate(options: SourceProviderEvidenceTemplateOptions) {
  const template = createSourceProviderEvidenceTemplate(options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }

  return template;
}

export function parseSourceProviderEvidenceTemplateArgs(args: string[]): ParsedArgs {
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
    } else if (arg === "--provider") {
      parsed.provider = readArgValue(args, index, arg);
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

export function sourceProviderEvidenceTemplateUsage() {
  return [
    "Usage: npm run --silent source-provider:evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --provider <provider> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --provider <provider>     One of github, gitlab, gitea, or generic.",
    "  --output <file>           Write the raw evidence template JSON.",
    "  --checked-at <iso>        Use a fixed template timestamp.",
    "  --json                    Print the template JSON.",
    "  --help                    Show this help."
  ].join("\n");
}

export async function runSourceProviderEvidenceTemplateCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<SourceProviderEvidenceTemplateOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseSourceProviderEvidenceTemplateArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${sourceProviderEvidenceTemplateUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${sourceProviderEvidenceTemplateUsage()}\n`);
    return 0;
  }

  try {
    const template = await writeSourceProviderEvidenceTemplate({
      ...baseOptions,
      commitRef: requiredValue(parsed.commitRef ?? baseOptions.commitRef, "--commit-ref"),
      repo: requiredValue(parsed.repo ?? baseOptions.repo, "--repo"),
      branch: requiredValue(parsed.branch ?? baseOptions.branch, "--branch"),
      targetEnvironment: requiredValue(parsed.targetEnvironment ?? baseOptions.targetEnvironment, "--target-environment"),
      provider: requiredValue(parsed.provider ?? baseOptions.provider, "--provider"),
      operatorName: requiredValue(parsed.operatorName ?? baseOptions.operatorName, "--operator-name"),
      ticketId: requiredValue(parsed.ticketId ?? baseOptions.ticketId, "--release-ticket"),
      outputPath: parsed.outputPath ?? baseOptions.outputPath,
      checkedAt: parsed.checkedAt ?? baseOptions.checkedAt
    });

    if (parsed.json || !parsed.outputPath) {
      io.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    } else {
      io.stdout.write(`Source provider evidence template written to ${parsed.outputPath}.\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runSourceProviderEvidenceTemplateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
