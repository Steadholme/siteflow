import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";
import { evaluateSourceProviderEvidence, type SourceProviderEvidenceCheckResult } from "./sourceProviderEvidenceCheck.js";

type CollectStatus = "collected" | "blocked";
type CheckStatus = "pass" | "fail";

interface FetchResponseLike {
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type SourceProviderEvidenceFetch = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface SourceProviderEvidenceCollectOptions {
  provider: string;
  repo: string;
  branch: string;
  commitRef: string;
  targetEnvironment: string;
  operatorName: string;
  ticketId: string;
  outputPath?: string;
  checkOutputPath?: string;
  githubTokenEnv?: string;
  apiUrl?: string;
  checkoutRemoteUrl?: string;
  webhookDeliveryId?: string;
  webhookEvent?: string;
  webhookSignatureVerified?: boolean;
  webhookSecretConfigured?: boolean;
  deployKeyPath?: string;
  deployKeyMode?: string;
  deployKeyMounted?: boolean;
  hostKeyPinned?: boolean;
  knownHostsPath?: string;
  timeoutMs?: number;
  maxAgeHours?: number;
  checkedAt?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: SourceProviderEvidenceFetch;
}

export interface SourceProviderEvidenceCollectCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface SourceProviderEvidenceCollectResult {
  name: "siteflow-source-provider-evidence-collect";
  status: CollectStatus;
  checkedAt: string;
  outputPath?: string;
  checkOutputPath?: string;
  evidence?: Record<string, unknown>;
  checkResult?: SourceProviderEvidenceCheckResult;
  checks: SourceProviderEvidenceCollectCheck[];
  exitCode: number;
}

interface ParsedArgs {
  provider?: string;
  repo?: string;
  branch?: string;
  commitRef?: string;
  targetEnvironment?: string;
  operatorName?: string;
  ticketId?: string;
  outputPath?: string;
  checkOutputPath?: string;
  githubTokenEnv: string;
  apiUrl?: string;
  checkoutRemoteUrl?: string;
  webhookDeliveryId?: string;
  webhookEvent?: string;
  webhookSignatureVerified: boolean;
  webhookSecretConfigured: boolean;
  deployKeyPath?: string;
  deployKeyMode?: string;
  deployKeyMounted: boolean;
  hostKeyPinned: boolean;
  knownHostsPath?: string;
  timeoutMs: number;
  maxAgeHours?: number;
  checkedAt?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultGithubTokenEnv = "GITHUB_TOKEN";
const defaultGithubApiUrl = "https://api.github.com";
const defaultTimeoutMs = 5000;

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

function statusPass(value: boolean) {
  return value ? "passed" : "blocked";
}

function requiredString(value: string | undefined, label: string) {
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

function validIsoTimestamp(value: string | undefined, fallback: string) {
  if (!value) {
    return fallback;
  }

  if (!stringValue(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("--checked-at must be a valid ISO timestamp.");
  }

  return new Date(value).toISOString();
}

function parseRepo(value: string) {
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);

  if (!match) {
    throw new Error("--repo must use owner/repo format.");
  }

  return {
    owner: match[1],
    name: match[2]
  };
}

function normalizeApiUrl(raw: string | undefined) {
  const candidate = raw ?? defaultGithubApiUrl;
  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("--api-url must be a valid URL.");
  }

  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("--api-url must use https outside localhost tests.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--api-url must not include credentials, query strings, or fragments.");
  }

  return parsed.toString().replace(/\/$/, "");
}

function remoteUrlSafe(value: string | undefined) {
  if (!value) {
    return false;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch {
      return false;
    }
  }

  return /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^:]+$/.test(value);
}

function isSshRemote(value: string | undefined) {
  return Boolean(value && (/^ssh:\/\//i.test(value) || /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^:]+$/.test(value)));
}

function globalFetch(): SourceProviderEvidenceFetch {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node.js runtime.");
  }

  return fetch as unknown as SourceProviderEvidenceFetch;
}

async function fetchWithTimeout(
  fetchImpl: SourceProviderEvidenceFetch,
  url: string,
  init: FetchInitLike,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(
  fetchImpl: SourceProviderEvidenceFetch,
  url: string,
  init: FetchInitLike,
  timeoutMs: number
) {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);

    if (response.status < 200 || response.status >= 300) {
      return {
        status: response.status,
        body: undefined,
        error: `GitHub API returned HTTP ${response.status}.`
      };
    }

    return {
      status: response.status,
      body: await response.json(),
      error: undefined
    };
  } catch {
    return {
      status: 0,
      body: undefined,
      error: "GitHub API request failed."
    };
  }
}

function addCheck(checks: SourceProviderEvidenceCollectCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function headerOptions(token: string | undefined) {
  return {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  };
}

function repoVisibility(repo: Record<string, unknown> | undefined) {
  const visibility = stringValue(repo?.visibility);

  if (visibility) {
    return visibility;
  }

  return repo?.private === true ? "private" : "public";
}

function repoRemoteUrl(repo: Record<string, unknown> | undefined, checkoutRemoteUrl: string | undefined) {
  return stringValue(checkoutRemoteUrl) ?? stringValue(repo?.clone_url) ?? stringValue(repo?.ssh_url);
}

function branchHeadSha(branch: Record<string, unknown> | undefined) {
  const commit = isObject(branch?.commit) ? branch.commit : undefined;

  return stringValue(commit?.sha);
}

function deployKeySummary(keys: unknown) {
  if (!Array.isArray(keys)) {
    return [];
  }

  return keys.filter(isObject).map((key) => ({
    id: key.id,
    title: stringValue(key.title) ?? null,
    readOnly: key.read_only === true,
    verified: key.verified === true,
    createdAt: stringValue(key.created_at) ?? null
  }));
}

function passingChecks(result: SourceProviderEvidenceCheckResult) {
  return new Map(result.checks.map((check) => [check.name, check.status === "pass"]));
}

function finalizeEvidence(evidenceBase: Record<string, unknown>, options: SourceProviderEvidenceCollectOptions) {
  const provisionalEvidence = {
    ...evidenceBase,
    status: "passed"
  };
  const provisionalCheck = evaluateSourceProviderEvidence(provisionalEvidence, {
    evidencePath: options.outputPath ?? "<collected-source-provider-evidence>",
    commitRef: options.commitRef,
    repo: options.repo,
    branch: options.branch,
    targetEnvironment: options.targetEnvironment,
    maxAgeHours: options.maxAgeHours,
    now: options.now
  });
  const finalEvidence = {
    ...provisionalEvidence,
    status: provisionalCheck.status === "passed" ? "passed" : "blocked"
  };
  const checkResult = evaluateSourceProviderEvidence(finalEvidence, {
    evidencePath: options.outputPath ?? "<collected-source-provider-evidence>",
    commitRef: options.commitRef,
    repo: options.repo,
    branch: options.branch,
    targetEnvironment: options.targetEnvironment,
    maxAgeHours: options.maxAgeHours,
    now: options.now
  });

  return { evidence: finalEvidence, checkResult };
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function collectSourceProviderEvidence(
  options: SourceProviderEvidenceCollectOptions
): Promise<SourceProviderEvidenceCollectResult> {
  const checkedAt = validIsoTimestamp(options.checkedAt, (options.now?.() ?? new Date()).toISOString());
  const provider = requiredString(options.provider, "--provider").toLowerCase();

  if (provider !== "github") {
    throw new Error("source-provider:evidence:collect currently supports --provider github.");
  }

  const repo = requiredString(options.repo, "--repo");
  const branch = requiredString(options.branch, "--branch");
  const commitRef = requiredString(options.commitRef, "--commit-ref");
  const targetEnvironment = requiredString(options.targetEnvironment, "--target-environment");
  const operatorName = requiredString(options.operatorName, "--operator-name");
  const ticketId = requiredString(options.ticketId, "--release-ticket");
  const parsedRepo = parseRepo(repo);
  const apiUrl = normalizeApiUrl(options.apiUrl);
  const timeoutMs = positiveNumber(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const fetchImpl = options.fetchImpl ?? globalFetch();
  const env = options.env ?? process.env;
  const githubTokenEnv = options.githubTokenEnv ?? defaultGithubTokenEnv;
  const githubToken = stringValue(env[githubTokenEnv]);
  const requestInit = headerOptions(githubToken);
  const repoApiPath = `/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.name)}`;
  const repoResult = await fetchJson(fetchImpl, `${apiUrl}${repoApiPath}`, requestInit, timeoutMs);
  const branchResult = await fetchJson(
    fetchImpl,
    `${apiUrl}${repoApiPath}/branches/${encodeURIComponent(branch)}`,
    requestInit,
    timeoutMs
  );
  const deployKeysResult = githubToken
    ? await fetchJson(fetchImpl, `${apiUrl}${repoApiPath}/keys?per_page=100`, requestInit, timeoutMs)
    : { status: 0, body: undefined, error: `${githubTokenEnv} was not set; deploy-key API collection skipped.` };
  const repoBody = isObject(repoResult.body) ? repoResult.body : undefined;
  const branchBody = isObject(branchResult.body) ? branchResult.body : undefined;
  const deployKeys = deployKeySummary(deployKeysResult.body);
  const remoteUrl = repoRemoteUrl(repoBody, options.checkoutRemoteUrl);
  const remoteSafe = remoteUrlSafe(remoteUrl);
  const headSha = branchHeadSha(branchBody);
  const exactCommitVerified = Boolean(headSha && headSha === commitRef);
  const privateRepo = repoBody?.private === true || repoVisibility(repoBody) === "private";
  const readOnlyDeployKey = deployKeys.find((key) => key.readOnly);
  const deployKeyRequired = privateRepo;
  const deployKeyPath = stringValue(options.deployKeyPath);
  const deployKeyPassed = deployKeyRequired
    ? Boolean(readOnlyDeployKey && deployKeyPath && (options.deployKeyMounted === true || readOnlyDeployKey.readOnly))
    : true;
  const sshRemote = isSshRemote(remoteUrl);
  const hostKeyPassed = !sshRemote || options.hostKeyPinned === true;
  const deliveryId = stringValue(options.webhookDeliveryId);
  const webhookEvent = stringValue(options.webhookEvent) ?? "push";
  const webhookPassed = Boolean(
    deliveryId &&
      webhookEvent &&
      options.webhookSignatureVerified === true &&
      options.webhookSecretConfigured === true
  );
  const diagnostics = [
    ...(repoResult.error ? [{ name: "github_repository", status: "blocked", message: repoResult.error }] : []),
    ...(branchResult.error ? [{ name: "github_branch", status: "blocked", message: branchResult.error }] : []),
    ...(deployKeysResult.error ? [{ name: "github_deploy_keys", status: "blocked", message: deployKeysResult.error }] : []),
    ...(!githubToken ? [{ name: "github_token", status: "blocked", message: `${githubTokenEnv} was not available to collect protected repository metadata.` }] : []),
    ...(!webhookPassed ? [{ name: "signed_webhook", status: "blocked", message: "GitHub API metadata alone does not prove target-side webhook signature verification; provide a delivery id plus target verification flags." }] : []),
    ...(sshRemote && !hostKeyPassed ? [{ name: "host_key", status: "blocked", message: "SSH remote evidence requires --host-key-pinned and a sanitized known_hosts path." }] : [])
  ];
  const evidenceBase: Record<string, unknown> = {
    schemaVersion: "siteflow.sourceProviderEvidence.v1",
    name: "siteflow-source-provider-evidence",
    dryRun: false,
    checkedAt,
    targetEnvironment,
    provider,
    release: {
      commitRef,
      repository: repo,
      branch
    },
    repository: {
      provider,
      fullName: stringValue(repoBody?.full_name) ?? repo,
      remoteUrl: remoteUrl ?? null,
      visibility: repoVisibility(repoBody),
      private: privateRepo,
      defaultBranch: stringValue(repoBody?.default_branch) ?? null,
      urlEmbeddedCredentials: remoteSafe ? false : null
    },
    checkout: {
      status: statusPass(exactCommitVerified && remoteSafe),
      checkedAt,
      commitRef,
      headSha: headSha ?? null,
      exactCommitVerified,
      headMatchesCommit: exactCommitVerified,
      remoteUrl: remoteUrl ?? null,
      source: "github-branches-api"
    },
    webhook: {
      status: statusPass(webhookPassed),
      checkedAt,
      deliveryId: deliveryId ?? null,
      event: webhookEvent,
      signatureVerified: options.webhookSignatureVerified === true,
      secretConfigured: options.webhookSecretConfigured === true,
      rawSecretArchived: false,
      signatureHeaderArchived: false,
      source: deliveryId ? "target-webhook-verification" : "missing-target-webhook-verification"
    },
    deployKey: {
      status: statusPass(deployKeyPassed),
      checkedAt,
      required: deployKeyRequired,
      mounted: options.deployKeyMounted === true,
      available: Boolean(readOnlyDeployKey),
      mode: stringValue(options.deployKeyMode) ?? (readOnlyDeployKey?.readOnly ? "read_only" : (deployKeyRequired ? "required" : "not_required")),
      path: deployKeyPath ?? null,
      keyId: readOnlyDeployKey?.id ?? null,
      title: readOnlyDeployKey?.title ?? null,
      privateKeyArchived: false,
      rawCredentialArchived: false,
      configuredDeployKeyCount: deployKeys.length
    },
    hostKey: {
      status: statusPass(hostKeyPassed),
      checkedAt,
      required: sshRemote,
      pinned: sshRemote ? options.hostKeyPinned === true : true,
      knownHostsConfigured: sshRemote ? Boolean(options.knownHostsPath) : true,
      path: stringValue(options.knownHostsPath) ?? null,
      acceptedBlindly: false,
      rawSecretArchived: false
    },
    releaseProvenance: {
      status: statusPass(exactCommitVerified),
      checkedAt,
      commitRef,
      repository: repo,
      branch,
      generatedAt: checkedAt,
      source: "source-provider-collector"
    },
    diagnostics,
    negativeEvidence: {
      rawCredentialArchived: false,
      rawSecretArchived: false,
      urlEmbeddedCredentials: remoteSafe ? false : null,
      requestAuthHeadersArchived: false,
      secretMaterialArchived: false
    },
    rawCredentialArchived: false,
    rawSecretArchived: false,
    authorizationHeaderArchived: false,
    operatorName,
    ticketId
  };
  const { evidence, checkResult } = finalizeEvidence(evidenceBase, options);
  const checks: SourceProviderEvidenceCollectCheck[] = [];
  const checkMap = passingChecks(checkResult);
  const secretFindings = scanEvidenceForRawSecrets(evidence);

  addCheck(checks, "github_repository_collected", Boolean(repoBody), "Collector must read GitHub repository metadata.");
  addCheck(checks, "github_branch_collected", Boolean(branchBody), "Collector must read the target branch head from GitHub.");
  addCheck(checks, "exact_commit_verified", checkMap.get("exact_commit_checkout") === true, "Collector must prove the branch head matches the release commit.");
  addCheck(checks, "signed_webhook_verified", checkMap.get("signed_webhook_verified") === true, "Collector must include target-side signed webhook verification proof.");
  addCheck(checks, "source_provider_evidence_check", checkResult.status === "passed", "Collected source-provider evidence must pass source-provider:evidence checks.");
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Collector output must not include raw secret-like values."
      : `Collector output includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );

  if (secretFindings.length > 0) {
    return {
      name: "siteflow-source-provider-evidence-collect",
      status: "blocked",
      checkedAt,
      ...(options.outputPath ? { outputPath: options.outputPath } : {}),
      ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
      checks,
      exitCode: 1
    };
  }

  if (options.outputPath) {
    await writeJson(options.outputPath, evidence);
  }

  if (options.checkOutputPath) {
    await writeJson(options.checkOutputPath, checkResult);
  }

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-source-provider-evidence-collect",
    status: passed ? "collected" : "blocked",
    checkedAt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.checkOutputPath ? { checkOutputPath: options.checkOutputPath } : {}),
    evidence,
    checkResult,
    checks,
    exitCode: passed ? 0 : 1
  };
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseSourceProviderEvidenceCollectArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    githubTokenEnv: defaultGithubTokenEnv,
    webhookSignatureVerified: false,
    webhookSecretConfigured: false,
    deployKeyMounted: false,
    hostKeyPinned: false,
    timeoutMs: defaultTimeoutMs,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--provider") {
      parsed.provider = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--commit-ref") {
      parsed.commitRef = readArgValue(args, index, arg);
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
    } else if (arg === "--github-token-env") {
      parsed.githubTokenEnv = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--api-url") {
      parsed.apiUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--checkout-remote-url") {
      parsed.checkoutRemoteUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--webhook-delivery-id") {
      parsed.webhookDeliveryId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--webhook-event") {
      parsed.webhookEvent = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--webhook-signature-verified") {
      parsed.webhookSignatureVerified = true;
    } else if (arg === "--webhook-secret-configured") {
      parsed.webhookSecretConfigured = true;
    } else if (arg === "--deploy-key-path") {
      parsed.deployKeyPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deploy-key-mode") {
      parsed.deployKeyMode = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deploy-key-mounted") {
      parsed.deployKeyMounted = true;
    } else if (arg === "--host-key-pinned") {
      parsed.hostKeyPinned = true;
    } else if (arg === "--known-hosts-path") {
      parsed.knownHostsPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--output") {
      parsed.outputPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--check-output") {
      parsed.checkOutputPath = readArgValue(args, index, arg);
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

  if (!parsed.help) {
    requiredString(parsed.provider, "--provider <provider>");
    requiredString(parsed.repo, "--repo <owner/name>");
    requiredString(parsed.branch, "--branch <name>");
    requiredString(parsed.commitRef, "--commit-ref <sha>");
    requiredString(parsed.targetEnvironment, "--target-environment <name>");
    requiredString(parsed.operatorName, "--operator-name <name>");
    requiredString(parsed.ticketId, "--release-ticket <id>");
    parseRepo(parsed.repo!);
    normalizeApiUrl(parsed.apiUrl);

    if (parsed.checkoutRemoteUrl && !remoteUrlSafe(parsed.checkoutRemoteUrl)) {
      throw new Error("--checkout-remote-url must be a credential-free HTTPS or SSH remote.");
    }
  }

  positiveNumber(parsed.timeoutMs, defaultTimeoutMs, "--timeout-ms");
  positiveNumber(parsed.maxAgeHours, 168, "--max-age-hours");
  validIsoTimestamp(parsed.checkedAt, new Date().toISOString());

  return parsed;
}

export function sourceProviderEvidenceCollectUsage() {
  return [
    "Usage: npm run --silent source-provider:evidence:collect -- --provider github --repo <owner/repo> --branch <branch> --commit-ref <sha> --target-environment <name> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    `  --github-token-env <name>          Environment variable containing a GitHub token. Default: ${defaultGithubTokenEnv}.`,
    "  --api-url <url>                    GitHub API base URL. Default: https://api.github.com.",
    "  --checkout-remote-url <url>        Credential-free checkout remote URL when it differs from GitHub clone_url.",
    "  --webhook-delivery-id <id>         Sanitized delivery id selected from target webhook verification evidence.",
    "  --webhook-event <event>            Webhook event name. Default: push.",
    "  --webhook-signature-verified       Operator-confirmed target verification of the webhook signature.",
    "  --webhook-secret-configured        Operator-confirmed target webhook secret is configured.",
    "  --deploy-key-path <path>           Sanitized target path for the mounted deploy key when private checkout is required.",
    "  --deploy-key-mode <mode>           Deploy key mode, such as read_only.",
    "  --deploy-key-mounted               Operator-confirmed deploy key is mounted for target checkout.",
    "  --host-key-pinned                  Operator-confirmed SSH host key is pinned.",
    "  --known-hosts-path <path>          Sanitized target known_hosts path.",
    "  --output <file>                    Write raw collected source-provider evidence.",
    "  --check-output <file>              Write source-provider:evidence checker output for release:evidence:compose.",
    "  --timeout-ms <ms>                  HTTP request timeout. Default: 5000.",
    "  --max-age-hours <hours>            Maximum evidence age passed to checker output.",
    "  --checked-at <iso>                 Use a fixed collection timestamp.",
    "  --json                             Print raw evidence when collected; print diagnostics when blocked.",
    "  --help                             Show this help.",
    "",
    "The collector reads GitHub repository and branch metadata. It still requires target-side signed webhook verification evidence before production can pass."
  ].join("\n");
}

function writeHumanResult(result: SourceProviderEvidenceCollectResult, io: CliIo) {
  const output = result.status === "collected" ? io.stdout : io.stderr;

  output.write(`SiteFlow source provider evidence collect status: ${result.status}\n`);

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

export async function runSourceProviderEvidenceCollectCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<SourceProviderEvidenceCollectOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseSourceProviderEvidenceCollectArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${sourceProviderEvidenceCollectUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${sourceProviderEvidenceCollectUsage()}\n`);
    return 0;
  }

  try {
    const result = await collectSourceProviderEvidence({
      ...baseOptions,
      provider: parsed.provider!,
      repo: parsed.repo!,
      branch: parsed.branch!,
      commitRef: parsed.commitRef!,
      targetEnvironment: parsed.targetEnvironment!,
      operatorName: parsed.operatorName!,
      ticketId: parsed.ticketId!,
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      githubTokenEnv: parsed.githubTokenEnv,
      apiUrl: parsed.apiUrl,
      checkoutRemoteUrl: parsed.checkoutRemoteUrl,
      webhookDeliveryId: parsed.webhookDeliveryId,
      webhookEvent: parsed.webhookEvent,
      webhookSignatureVerified: parsed.webhookSignatureVerified,
      webhookSecretConfigured: parsed.webhookSecretConfigured,
      deployKeyPath: parsed.deployKeyPath,
      deployKeyMode: parsed.deployKeyMode,
      deployKeyMounted: parsed.deployKeyMounted,
      hostKeyPinned: parsed.hostKeyPinned,
      knownHostsPath: parsed.knownHostsPath,
      timeoutMs: parsed.timeoutMs,
      maxAgeHours: parsed.maxAgeHours,
      checkedAt: parsed.checkedAt
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result.status === "collected" ? result.evidence : result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: SourceProviderEvidenceCollectResult = {
      name: "siteflow-source-provider-evidence-collect",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      outputPath: parsed.outputPath,
      checkOutputPath: parsed.checkOutputPath,
      checks: [
        {
          name: "collect",
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
  runSourceProviderEvidenceCollectCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
