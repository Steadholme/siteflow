import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface OperatorAccessEvidenceTemplateOptions {
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

export function createOperatorAccessEvidenceTemplate(options: OperatorAccessEvidenceTemplateOptions) {
  const checkedAt = options.checkedAt ? validIsoTimestamp(options.checkedAt) : (options.now?.() ?? new Date()).toISOString();
  const publicBaseUrl = normalizedHttpsUrl(requiredValue(options.publicBaseUrl, "--public-base-url"));

  return {
    schemaVersion: "siteflow.operatorAccessEvidence.v1",
    name: "siteflow-operator-access-evidence",
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
    target: {
      environment: requiredValue(options.targetEnvironment, "--target-environment"),
      publicBaseUrl,
      release: {
        commitRef: requiredValue(options.commitRef, "--commit-ref"),
        repository: requiredValue(options.repo, "--repo"),
        branch: requiredValue(options.branch, "--branch")
      }
    },
    instructions: [
      "Replace every todo/null field with observations from the target or target-equivalent operator access run.",
      "Set dryRun=false and status=passed only after every section reflects real non-dry-run evidence.",
      "Do not archive raw bearer tokens, raw session secrets, Set-Cookie values, or Authorization headers."
    ],
    sessionCreate: todoSection(checkedAt, "Create an operator session through the target API with Bearer admin auth.", {
      statusCode: null,
      cookieHttpOnly: null,
      cookieSecure: null,
      cookieSameSite: null,
      cookiePath: null,
      secretReturnedInJson: null
    }),
    sessionPolicy: todoSection(checkedAt, "Record configured session idle timeout, absolute TTL, and expired/revoked rejection proof.", {
      idleTimeoutSeconds: null,
      absoluteTtlEnforced: null,
      expiredOrRevokedSessionRejected: null
    }),
    projectScope: todoSection(checkedAt, "Verify a project-scoped session on matching, non-matching, and global routes.", {
      allowedProjectStatusCode: null,
      deniedProjectStatusCode: null,
      deniedGlobalStatusCode: null
    }),
    sessionRotation: todoSection(checkedAt, "Rotate a cookie session with X-SiteFlow-CSRF: same-origin and verify old-cookie rejection.", {
      statusCode: null,
      newCookieStatusCode: null,
      oldCookieStatusCode: null,
      missingCsrfStatusCode: null,
      cookieHttpOnly: null,
      cookieSecure: null,
      cookieSameSite: null,
      cookiePath: null,
      secretReturnedInJson: null
    }),
    sessionRevoke: todoSection(checkedAt, "Revoke the current cookie session and verify the old cookie is rejected.", {
      statusCode: null,
      cookieCleared: null,
      oldCookieStatusCode: null
    }),
    csrf: todoSection(checkedAt, "Verify cookie-authenticated mutating requests require X-SiteFlow-CSRF: same-origin.", {
      missingHeaderStatusCode: null,
      sameOriginHeaderStatusCode: null,
      bearerWriteRequiresCsrf: null
    }),
    bearerPrecedence: todoSection(checkedAt, "Send low-scope Bearer plus admin cookie and verify Bearer denial wins.", {
      lowScopeBearerWithAdminCookieStatusCode: null,
      fallbackToCookie: null
    }),
    actorAttribution: todoSection(checkedAt, "Verify server-derived actor attribution ignores body/client actor spoofing.", {
      bodyActorIgnored: null,
      serverActorRecorded: null
    }),
    browserTokenFallback: todoSection(checkedAt, "Verify production browser storage token fallback is disabled, or document an explicit transition exception.", {
      productionFallbackEnabled: null,
      viteSiteflowAllowBrowserTokenFallback: null,
      explicitTransitionException: null,
      exceptionReason: null,
      exceptionTicket: null,
      localStorageFallbackDisabled: null
    }),
    emergencyCutoff: {
      status: "todo",
      checkedAt,
      note: "Run global and project emergency cutoff flows with Bearer admin auth.",
      global: {
        status: "todo",
        statusCode: null,
        scope: "global",
        cutoffId: null,
        revokedAt: null,
        oldCookieStatusCode: null
      },
      project: {
        status: "todo",
        statusCode: null,
        scope: "project",
        projectId: null,
        cutoffId: null,
        revokedAt: null,
        oldCookieStatusCode: null
      },
      cookieOnly: {
        statusCode: null
      },
      lowScopeBearer: {
        statusCode: null,
        fallbackToCookie: null
      }
    },
    negativeEvidence: {
      noRawBearerTokensStored: null,
      noRawSessionSecretsStored: null,
      noAuthorizationHeadersStored: null,
      notClaimingLoginIdpMfa: true,
      credentialedCorsNotExposedAsReady: true,
      nonSessionCredentialRotationOutOfScope: true
    },
    operatorName: requiredValue(options.operatorName, "--operator-name"),
    ticketId: requiredValue(options.ticketId, "--release-ticket")
  };
}

export async function writeOperatorAccessEvidenceTemplate(options: OperatorAccessEvidenceTemplateOptions) {
  const template = createOperatorAccessEvidenceTemplate(options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }

  return template;
}

export function parseOperatorAccessEvidenceTemplateArgs(args: string[]): ParsedArgs {
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

export function operatorAccessEvidenceTemplateUsage() {
  return [
    "Usage: npm run --silent operator-access:evidence:template -- --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-environment <name> --public-base-url <https-url> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  --output <file>          Write the raw evidence template JSON.",
    "  --checked-at <iso>       Use a fixed template timestamp.",
    "  --json                   Print the template JSON.",
    "  --help                   Show this help."
  ].join("\n");
}

export async function runOperatorAccessEvidenceTemplateCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<OperatorAccessEvidenceTemplateOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseOperatorAccessEvidenceTemplateArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${operatorAccessEvidenceTemplateUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${operatorAccessEvidenceTemplateUsage()}\n`);
    return 0;
  }

  try {
    const template = await writeOperatorAccessEvidenceTemplate({
      ...baseOptions,
      commitRef: requiredValue(parsed.commitRef ?? baseOptions.commitRef, "--commit-ref"),
      repo: requiredValue(parsed.repo ?? baseOptions.repo, "--repo"),
      branch: requiredValue(parsed.branch ?? baseOptions.branch, "--branch"),
      targetEnvironment: requiredValue(parsed.targetEnvironment ?? baseOptions.targetEnvironment, "--target-environment"),
      publicBaseUrl: requiredValue(parsed.publicBaseUrl ?? baseOptions.publicBaseUrl, "--public-base-url"),
      operatorName: requiredValue(parsed.operatorName ?? baseOptions.operatorName, "--operator-name"),
      ticketId: requiredValue(parsed.ticketId ?? baseOptions.ticketId, "--release-ticket"),
      outputPath: parsed.outputPath ?? baseOptions.outputPath,
      checkedAt: parsed.checkedAt ?? baseOptions.checkedAt
    });

    if (parsed.json || !parsed.outputPath) {
      io.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    } else {
      io.stdout.write(`Operator access evidence template written to ${parsed.outputPath}.\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  runOperatorAccessEvidenceTemplateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
