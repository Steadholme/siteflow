import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface IngressEvidenceCheckOptions {
  evidencePath: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours?: number;
  now?: () => Date;
}

export interface IngressEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface IngressEvidenceSummary {
  status?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface IngressEvidenceCheckResult {
  name: "siteflow-ingress-evidence-check";
  status: EvidenceStatus;
  checkedAt: string;
  evidencePath: string;
  thresholds: {
    maxAgeHours: number;
  };
  selectedEvidence: {
    environment: string | null;
    publicBaseUrl: string | null;
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    trustProxyPolicy: string | null;
    deploymentTopology: Record<string, unknown> | null;
    directApiPort: IngressEvidenceSummary | null;
    forwardedHeaders: IngressEvidenceSummary | null;
    apiRateLimit: IngressEvidenceSummary | null;
    unthrottledRoutes: IngressEvidenceSummary | null;
    metricsAccessControl: IngressEvidenceSummary | null;
  };
  checks: IngressEvidenceCheck[];
  exitCode: number;
}

interface ParsedArgs {
  evidencePath?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours: number;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultMaxAgeHours = 168;
const expectedSchemaVersion = "siteflow.ingressEvidence.v1";
const expectedName = "siteflow-ingress-evidence";
const passStatuses = new Set(["pass", "passed", "ok", "healthy", "verified"]);
const blockedStatuses = new Set([...passStatuses, "blocked"]);
const limitedStatuses = new Set([...passStatuses, "limited"]);
const validTrustProxyPolicies = new Set(["loopback", "private"]);
const validMetricsPrivateScrapeProtections = new Set([
  "private_network",
  "localhost_sidecar",
  "reverse_proxy_allowlist"
]);
export const requiredIngressEvidenceCheckNames = [
  "non_dry_run",
  "not_template",
  "status_final",
  "evidence_age",
  "release_identity",
  "target_facts",
  "environment",
  "no_sensitive_evidence_values",
  "public_base_url",
  "deployment_topology_present",
  "direct_api_port_present",
  "direct_api_port_blocked",
  "direct_api_port_age",
  "forwarded_headers_present",
  "forwarded_headers_overwritten",
  "forwarded_headers_age",
  "proxy_source_policy_present",
  "proxy_source_policy_allowed",
  "proxy_source_policy_matches",
  "api_rate_limit_present",
  "api_rate_limit_status",
  "api_rate_limit_age",
  "api_rate_limit_429",
  "api_rate_limit_bucket",
  "api_rate_limit_topology",
  "unthrottled_routes_present",
  "unthrottled_routes_age",
  "unthrottled_routes_not_limited",
  "operator",
  "ticket"
];
const apiInstanceCountKeys = ["apiInstanceCount", "apiInstances", "instanceCount", "instances", "replicas"];
const apiProcessCountKeys = ["apiProcessCount", "apiProcesses", "processCount", "processes"];
const ingressCountKeys = ["ingressCount", "ingresses"];
const topologyMultiFlagKeys = ["multiInstance", "multiProcess", "multiIngress"];

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

function statusValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function timestampValue(value: unknown) {
  const raw = stringValue(value);

  if (!raw || Number.isNaN(Date.parse(raw))) {
    return undefined;
  }

  return raw;
}

function nestedObject(candidate: Record<string, unknown> | undefined, key: string) {
  return candidate && isObject(candidate[key]) ? candidate[key] : undefined;
}

function nestedValue(candidate: Record<string, unknown> | undefined, path: string[]) {
  let current: unknown = candidate;

  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function positiveNumber(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

function ageHours(timestamp: string, now: Date) {
  return (now.getTime() - Date.parse(timestamp)) / (60 * 60 * 1000);
}

function freshTimestamp(timestamp: string | undefined, now: Date, maxAgeHours: number) {
  return Boolean(timestamp && ageHours(timestamp, now) >= 0 && ageHours(timestamp, now) <= maxAgeHours);
}

function addCheck(checks: IngressEvidenceCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function collectObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjects(item));
  }

  if (!isObject(value)) {
    return [];
  }

  return [
    value,
    ...Object.values(value).flatMap((item) => collectObjects(item))
  ];
}

function firstCandidate(root: Record<string, unknown> | undefined, keys: string[]) {
  if (!root) {
    return undefined;
  }

  for (const key of keys) {
    if (isObject(root[key])) {
      return root[key];
    }
  }

  return undefined;
}

function firstTimestamp(candidate: Record<string, unknown> | undefined, keys: string[]) {
  if (!candidate) {
    return undefined;
  }

  for (const key of keys) {
    const timestamp = timestampValue(candidate[key]);

    if (timestamp) {
      return timestamp;
    }
  }

  return undefined;
}

function selectedTimestamp(candidate: Record<string, unknown> | undefined) {
  return firstTimestamp(candidate, ["checkedAt", "completedAt", "verifiedAt", "timestamp", "createdAt"]);
}

function latestByTimestamp(candidates: Record<string, unknown>[], timestampKeys: string[]) {
  return candidates
    .map((candidate) => ({
      candidate,
      timestamp: firstTimestamp(candidate, timestampKeys)
    }))
    .sort((left, right) => Date.parse(right.timestamp ?? "") - Date.parse(left.timestamp ?? ""))[0]?.candidate;
}

function kindValue(candidate: Record<string, unknown>) {
  return statusValue(candidate.kind) ?? statusValue(candidate.type) ?? statusValue(candidate.evidenceType);
}

function selectEvidence(root: Record<string, unknown> | undefined, directKeys: string[], kinds: string[]) {
  const direct = firstCandidate(root, directKeys);

  if (direct) {
    return direct;
  }

  return latestByTimestamp(
    collectObjects(root).filter((candidate) => {
      const kind = kindValue(candidate);

      return Boolean(kind && kinds.includes(kind));
    }),
    ["checkedAt", "completedAt", "verifiedAt", "timestamp", "createdAt"]
  );
}

function summarizeEvidence(candidate: Record<string, unknown> | undefined, extraKeys: string[] = []) {
  if (!candidate) {
    return null;
  }

  const summary: IngressEvidenceSummary = {
    status: stringValue(candidate.status),
    timestamp: selectedTimestamp(candidate)
  };

  for (const key of extraKeys) {
    if (candidate[key] !== undefined) {
      summary[key] = candidate[key];
    }
  }

  return summary;
}

function booleanField(candidate: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    if (typeof candidate?.[key] === "boolean") {
      return candidate[key];
    }
  }

  return undefined;
}

function isPassingStatus(value: unknown) {
  const normalized = statusValue(value);

  return Boolean(normalized && passStatuses.has(normalized));
}

function isBlockedStatus(value: unknown) {
  const normalized = statusValue(value);

  return Boolean(normalized && blockedStatuses.has(normalized));
}

function isLimitedStatus(value: unknown) {
  const normalized = statusValue(value);

  return Boolean(normalized && limitedStatuses.has(normalized));
}

function publicBaseUrl(root: Record<string, unknown> | undefined) {
  return stringValue(root?.publicBaseUrl) ??
    stringValue(root?.baseUrl) ??
    stringValue(nestedValue(root, ["target", "publicBaseUrl"]));
}

function targetObject(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "target");
}

function targetEnvironmentName(target: Record<string, unknown> | undefined) {
  return stringValue(target?.environment) ?? stringValue(target?.targetEnvironment);
}

function targetPublicBaseUrl(target: Record<string, unknown> | undefined) {
  return stringValue(target?.publicBaseUrl) ?? stringValue(target?.baseUrl);
}

function targetDirectApiUrl(target: Record<string, unknown> | undefined) {
  return stringValue(target?.directApiUrl) ?? stringValue(target?.directApiBaseUrl);
}

function targetReleaseObject(target: Record<string, unknown> | undefined) {
  return nestedObject(target, "release") ?? target;
}

function targetReleaseCommit(target: Record<string, unknown> | undefined) {
  const release = targetReleaseObject(target);

  return stringValue(release?.commitRef) ?? stringValue(release?.commitSha);
}

function targetReleaseRepository(target: Record<string, unknown> | undefined) {
  return stringValue(targetReleaseObject(target)?.repository);
}

function targetReleaseBranch(target: Record<string, unknown> | undefined) {
  return stringValue(targetReleaseObject(target)?.branch);
}

function targetFactsMatch(
  root: Record<string, unknown> | undefined,
  directApiPort: Record<string, unknown> | undefined
) {
  const target = targetObject(root);
  const targetCommitRef = targetReleaseCommit(target);
  const targetRepository = targetReleaseRepository(target);
  const targetBranch = targetReleaseBranch(target);
  const directApiTarget = stringValue(directApiPort?.target) ?? stringValue(directApiPort?.url);

  return Boolean(
    target &&
      targetEnvironmentName(target) &&
      targetEnvironmentName(target) === environmentName(root) &&
      targetPublicBaseUrl(target) &&
      targetPublicBaseUrl(target) === publicBaseUrl(root) &&
      targetDirectApiUrl(target) &&
      targetDirectApiUrl(target) === directApiTarget &&
      targetCommitRef &&
      targetCommitRef === releaseCommit(root) &&
      targetRepository &&
      targetRepository === releaseRepository(root) &&
      targetBranch &&
      targetBranch === releaseBranch(root)
  );
}

function environmentName(root: Record<string, unknown> | undefined) {
  return stringValue(root?.environment) ??
    stringValue(root?.targetEnvironment) ??
    stringValue(nestedValue(root, ["target", "environment"]));
}

function operatorName(root: Record<string, unknown> | undefined) {
  return stringValue(root?.operator) ??
    stringValue(root?.operatorName) ??
    stringValue(nestedValue(root, ["operator", "name"]));
}

function ticketId(root: Record<string, unknown> | undefined) {
  return stringValue(root?.ticket) ??
    stringValue(root?.ticketId) ??
    stringValue(root?.changeId) ??
    stringValue(root?.changeTicket) ??
    stringValue(nestedValue(root, ["ticket", "id"]));
}

function releaseMetadata(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "release") ?? root;
}

function releaseCommit(root: Record<string, unknown> | undefined) {
  const release = releaseMetadata(root);

  return stringValue(release?.commitRef) ?? stringValue(release?.commitSha);
}

function releaseRepository(root: Record<string, unknown> | undefined) {
  return stringValue(releaseMetadata(root)?.repository);
}

function releaseBranch(root: Record<string, unknown> | undefined) {
  return stringValue(releaseMetadata(root)?.branch);
}

function releaseIdentityValues(root: Record<string, unknown> | undefined, options: IngressEvidenceCheckOptions) {
  return {
    commitRef: options.commitRef ?? releaseCommit(root),
    repository: options.repo ?? releaseRepository(root),
    branch: options.branch ?? releaseBranch(root)
  };
}

function releaseIdentityMatches(root: Record<string, unknown> | undefined, options: IngressEvidenceCheckOptions) {
  const commitRef = releaseCommit(root);
  const repository = releaseRepository(root);
  const branch = releaseBranch(root);

  return Boolean(
    commitRef &&
      repository &&
      branch &&
      (!options.commitRef || commitRef === options.commitRef) &&
      (!options.repo || repository === options.repo) &&
      (!options.branch || branch === options.branch)
  );
}

function trustProxyPolicy(root: Record<string, unknown> | undefined, proxySource: Record<string, unknown> | undefined) {
  return stringValue(proxySource?.configured) ??
    stringValue(proxySource?.policy) ??
    stringValue(proxySource?.trustProxyPolicy) ??
    stringValue(root?.trustProxyPolicy) ??
    stringValue(root?.siteflowTrustProxy) ??
    stringValue(nestedValue(root, ["runtimeEnv", "SITEFLOW_TRUST_PROXY"]));
}

function isIpOrCidrList(value: string) {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);

  return entries.length > 0 && entries.every((entry) => {
    const parts = entry.split("/");

    if (parts.length > 2) {
      return false;
    }

    const [address, prefix] = parts;
    const ipVersion = isIP(address);

    if (!ipVersion) {
      return false;
    }

    if (prefix === undefined) {
      return true;
    }

    const prefixLength = Number(prefix);
    const maxPrefixLength = ipVersion === 4 ? 32 : 128;

    return Number.isInteger(prefixLength) && prefixLength > 0 && prefixLength <= maxPrefixLength;
  });
}

function trustProxyPolicyAllowed(value: string | undefined) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();

  return validTrustProxyPolicies.has(normalized) || isIpOrCidrList(value);
}

function allRouteChecksPresent(routes: Record<string, unknown> | undefined) {
  if (!routes) {
    return false;
  }

  return routeCheckPassed(nestedObject(routes, "healthz"), "application") &&
    routeCheckPassed(nestedObject(routes, "readyz"), "application") &&
    routeCheckPassed(nestedObject(routes, "metrics"), "metrics") &&
    routeCheckPassed(nestedObject(routes, "preview"), "application") &&
    routeCheckPassed(nestedObject(routes, "static"), "application");
}

function routeCheckPassed(route: Record<string, unknown> | undefined, type: "application" | "metrics") {
  const statusCode = Number(route?.statusCode);

  if (!route || route.rateLimited !== false || !Number.isInteger(statusCode)) {
    return false;
  }

  if (type === "metrics") {
    return statusCode === 200 || statusCode === 401 || statusCode === 403;
  }

  return statusCode >= 200 && statusCode <= 299;
}

function isHttpsUrl(value: string | undefined) {
  return Boolean(value && /^https:\/\//i.test(value));
}

function numberValue(value: unknown) {
  const candidate = typeof value === "number" ? value : Number(value);

  return Number.isFinite(candidate) ? candidate : undefined;
}

function normalizedToken(value: unknown) {
  return stringValue(value)?.toLowerCase().replace(/[\s-]+/g, "_");
}

function metricsScrapePath(value: Record<string, unknown> | undefined) {
  return stringValue(value?.scrapePath) ?? stringValue(value?.path) ?? stringValue(value?.endpoint);
}

function metricsPrivateScrapeProtectionAllowed(value: Record<string, unknown> | undefined) {
  const protection = normalizedToken(value?.protection) ??
    normalizedToken(value?.accessControl) ??
    normalizedToken(value?.networkProtection);

  return Boolean(protection && validMetricsPrivateScrapeProtections.has(protection));
}

function metricsPublicAccessBlocked(value: Record<string, unknown> | undefined) {
  return booleanField(value, [
    "publicAccessBlocked",
    "noPublicUnauthenticatedAccess",
    "publicUnauthenticatedAccessBlocked"
  ]) === true;
}

function deploymentTopology(root: Record<string, unknown> | undefined) {
  return selectEvidence(root, ["deploymentTopology", "topology"], ["deployment_topology", "topology"]);
}

function topologyPositiveIntegerCount(topology: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = numberValue(topology[key]);

    if (value !== undefined && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

function topologyHasCompleteCounts(topology: Record<string, unknown>) {
  return Boolean(
    topologyPositiveIntegerCount(topology, apiInstanceCountKeys) &&
      topologyPositiveIntegerCount(topology, apiProcessCountKeys) &&
      topologyPositiveIntegerCount(topology, ingressCountKeys)
  );
}

function topologyHasCompleteMultiFlags(topology: Record<string, unknown>) {
  return topologyMultiFlagKeys.every((key) => typeof topology[key] === "boolean");
}

function topologyHasDeclaredShape(topology: Record<string, unknown> | undefined) {
  return Boolean(topology && (topologyHasCompleteCounts(topology) || topologyHasCompleteMultiFlags(topology)));
}

function topologyClaimsMultipleExecutionContexts(topology: Record<string, unknown> | undefined) {
  if (!topology) {
    return false;
  }

  return (
    topologyHasCompleteMultiFlags(topology) &&
      (topology.multiInstance === true || topology.multiProcess === true || topology.multiIngress === true)
  ) ||
    (
      topologyHasCompleteCounts(topology) &&
        (
          Number(topologyPositiveIntegerCount(topology, apiInstanceCountKeys)) > 1 ||
            Number(topologyPositiveIntegerCount(topology, apiProcessCountKeys)) > 1 ||
            Number(topologyPositiveIntegerCount(topology, ingressCountKeys)) > 1
        )
    );
}

function rateLimitSharedOrEdgeEnforced(rateLimit: Record<string, unknown> | undefined) {
  if (!rateLimit) {
    return false;
  }

  const limiterScope = normalizedToken(rateLimit.limiterScope) ?? normalizedToken(rateLimit.scope);
  const limiterType = normalizedToken(rateLimit.limiterType) ?? normalizedToken(rateLimit.type);
  const enforcementPoint = normalizedToken(rateLimit.enforcementPoint) ?? normalizedToken(rateLimit.enforcedAt);

  return rateLimit.edgeEnforced === true ||
    rateLimit.sharedAcrossInstances === true ||
    ["edge", "shared", "global", "distributed"].includes(limiterScope ?? "") ||
    ["edge", "shared", "global", "distributed"].includes(limiterType ?? "") ||
    ["edge", "proxy", "load_balancer", "gateway", "ingress", "cdn"].includes(enforcementPoint ?? "");
}

function rateLimitProcessLocalOnly(rateLimit: Record<string, unknown> | undefined) {
  if (!rateLimit) {
    return false;
  }

  const limiterScope = normalizedToken(rateLimit.limiterScope) ?? normalizedToken(rateLimit.scope);
  const limiterType = normalizedToken(rateLimit.limiterType) ?? normalizedToken(rateLimit.type);

  return !rateLimitSharedOrEdgeEnforced(rateLimit) &&
    (
      rateLimit.processLocalOnly === true ||
      rateLimit.processLocal === true ||
      rateLimit.processLocalLimiter === true ||
      ["process_local", "process", "local", "memory", "in_memory"].includes(limiterScope ?? "") ||
      ["process_local", "process", "local", "memory", "in_memory"].includes(limiterType ?? "")
    );
}

function topologyRateLimitEvidencePassed(
  topology: Record<string, unknown> | undefined,
  rateLimit: Record<string, unknown> | undefined
) {
  const topologyDeclared = topologyHasDeclaredShape(topology);
  const multipleExecutionContexts = topologyClaimsMultipleExecutionContexts(topology);
  const sharedOrEdgeLimiter = rateLimitSharedOrEdgeEnforced(rateLimit);
  const processLocalOnlyLimiter = rateLimitProcessLocalOnly(rateLimit);

  return topologyDeclared &&
    (!multipleExecutionContexts || sharedOrEdgeLimiter) &&
    !(multipleExecutionContexts && processLocalOnlyLimiter);
}

export function evaluateIngressEvidence(
  rawEvidence: unknown,
  options: IngressEvidenceCheckOptions
): IngressEvidenceCheckResult {
  const now = options.now?.() ?? new Date();
  const maxAgeHours = positiveNumber(options.maxAgeHours, defaultMaxAgeHours, "maxAgeHours");
  const root = isObject(rawEvidence) ? rawEvidence : undefined;
  const directApiPort = selectEvidence(root, ["directApiPort", "directApiPortCheck", "apiPortExposure"], ["direct_api_port", "direct-api-port"]);
  const forwardedHeaders = selectEvidence(root, ["forwardedHeaders", "forwardedHeaderSanitization"], ["forwarded_headers", "forwarded-header-sanitization"]);
  const proxySource = selectEvidence(root, ["proxySourcePolicy", "trustedProxyPolicy"], ["proxy_source_policy", "trusted-proxy-policy"]);
  const apiRateLimit = selectEvidence(root, ["apiRateLimit", "edgeRateLimit", "sharedRateLimit"], ["api_rate_limit", "edge-rate-limit", "shared-rate-limit"]);
  const unthrottledRoutes = selectEvidence(root, ["unthrottledRoutes", "nonApiRoutes"], ["unthrottled_routes", "non-api-routes"]);
  const metricsAccessControl = selectEvidence(
    root,
    ["metricsAccessControl", "metricsPrivateScrape", "metricsPrivateScrapeException"],
    ["metrics_access_control", "metrics-private-scrape", "metrics_private_scrape", "metrics_private_scrape_exception"]
  );
  const topology = deploymentTopology(root);
  const policy = trustProxyPolicy(root, proxySource);
  const releaseIdentity = releaseIdentityValues(root, options);
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const checks: IngressEvidenceCheck[] = [];

  addCheck(checks, "evidence_shape", Boolean(root), "Ingress evidence must be a JSON object.");
  addCheck(checks, "schema_version", root?.schemaVersion === expectedSchemaVersion, `schemaVersion must be ${expectedSchemaVersion}.`);
  addCheck(checks, "evidence_name", root?.name === expectedName, `name must be ${expectedName}.`);
  addCheck(checks, "evidence_status", Boolean(root && isPassingStatus(root.status)), "Ingress evidence status must be passing.");
  addCheck(checks, "status_final", statusValue(root?.status) === "passed", "Ingress evidence status must be exactly passed for final production evidence.");
  addCheck(checks, "non_dry_run", root?.dryRun === false, "Ingress evidence must come from a non-dry-run target or target-equivalent check.");
  addCheck(checks, "not_template", root?.template !== true, "Ingress evidence must be final target evidence, not a template skeleton.");
  addCheck(checks, "evidence_age", freshTimestamp(selectedTimestamp(root), now, maxAgeHours), `Ingress evidence must be no older than ${maxAgeHours} hours.`);
  addCheck(checks, "release_identity", releaseIdentityMatches(root, options), "Ingress evidence must be bound to the requested release commit, repository, and branch.");
  addCheck(
    checks,
    "target_facts",
    targetFactsMatch(root, directApiPort),
    "Ingress evidence must include target environment, public URL, direct API probe URL, and release identity facts matching the final evidence."
  );
  addCheck(
    checks,
    "environment",
    Boolean(environmentName(root) && (!options.targetEnvironment || environmentName(root) === options.targetEnvironment)),
    "Ingress evidence must include the target environment and match the requested target environment when provided."
  );
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Ingress evidence must not include raw secret-like values."
      : `Ingress evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );
  addCheck(checks, "public_base_url", isHttpsUrl(publicBaseUrl(root)), "Ingress evidence must include an https publicBaseUrl.");
  addCheck(
    checks,
    "deployment_topology_present",
    topologyHasDeclaredShape(topology),
    "Ingress evidence must declare deploymentTopology/topology with API instance/process and ingress counts or explicit multi-* flags."
  );

  addCheck(checks, "direct_api_port_present", Boolean(directApiPort), "Direct API port exposure evidence must be present.");
  addCheck(
    checks,
    "direct_api_port_blocked",
    Boolean(directApiPort && directApiPort.reachable === false && directApiPort.checked === true && isBlockedStatus(directApiPort.status)),
    "Direct API port evidence must prove the API port was checked and is not reachable outside the trusted ingress."
  );
  addCheck(checks, "direct_api_port_age", freshTimestamp(selectedTimestamp(directApiPort), now, maxAgeHours), `Direct API port evidence must be no older than ${maxAgeHours} hours.`);

  addCheck(checks, "forwarded_headers_present", Boolean(forwardedHeaders), "Forwarded header sanitization evidence must be present.");
  addCheck(
    checks,
    "forwarded_headers_overwritten",
    forwardedHeaders?.xForwardedForOverwritten === true &&
      forwardedHeaders?.xForwardedHostOverwritten === true &&
      forwardedHeaders?.xForwardedProtoOverwritten === true &&
      forwardedHeaders?.proxyAddXForwardedForUsed === false,
    "Forwarded header evidence must prove host, proto, and client IP headers are overwritten and proxy_add_x_forwarded_for is not used."
  );
  addCheck(checks, "forwarded_headers_age", freshTimestamp(selectedTimestamp(forwardedHeaders), now, maxAgeHours), `Forwarded header evidence must be no older than ${maxAgeHours} hours.`);

  addCheck(checks, "proxy_source_policy_present", Boolean(proxySource || policy), "Trusted proxy source policy evidence must be present.");
  addCheck(
    checks,
    "proxy_source_policy_allowed",
    trustProxyPolicyAllowed(policy),
    "Trusted proxy policy must be loopback, private, or explicit IP/CIDR entries, never all-source trust."
  );
  addCheck(
    checks,
    "proxy_source_policy_matches",
    proxySource?.finalHopMatched === true && proxySource?.allSourcesTrusted === false,
    "Trusted proxy evidence must prove the configured policy matches the final ingress hop and does not trust all sources."
  );

  addCheck(checks, "api_rate_limit_present", Boolean(apiRateLimit), "API edge/shared rate-limit evidence must be present.");
  addCheck(
    checks,
    "api_rate_limit_status",
    Boolean(apiRateLimit && isLimitedStatus(apiRateLimit.status)),
    "API rate-limit evidence status must be passing."
  );
  addCheck(checks, "api_rate_limit_age", freshTimestamp(selectedTimestamp(apiRateLimit), now, maxAgeHours), `API rate-limit evidence must be no older than ${maxAgeHours} hours.`);
  addCheck(
    checks,
    "api_rate_limit_429",
    apiRateLimit?.rateLimitedStatusCode === 429 || apiRateLimit?.statusCode === 429,
    "API rate-limit evidence must prove abusive /api traffic returns 429."
  );
  addCheck(
    checks,
    "api_rate_limit_bucket",
    apiRateLimit?.clientIpBucketed === true || rateLimitSharedOrEdgeEnforced(apiRateLimit),
    "API rate-limit evidence must prove the limiter keys by sanitized client IP or is shared/edge enforced before API instances."
  );
  addCheck(
    checks,
    "api_rate_limit_topology",
    topologyRateLimitEvidencePassed(topology, apiRateLimit),
    "Multi-instance, multi-process, or multi-ingress topology must prove API rate limiting is edge-enforced or shared across instances; process-local-only limiting is not sufficient."
  );

  addCheck(checks, "unthrottled_routes_present", Boolean(unthrottledRoutes), "Non-API route evidence must be present.");
  addCheck(checks, "unthrottled_routes_age", freshTimestamp(selectedTimestamp(unthrottledRoutes), now, maxAgeHours), `Non-API route evidence must be no older than ${maxAgeHours} hours.`);
  addCheck(
    checks,
    "unthrottled_routes_not_limited",
    allRouteChecksPresent(unthrottledRoutes),
    "Health, readiness, metrics, preview, and static routes must be checked and not return 429 from the API edge limiter."
  );
  addCheck(
    checks,
    "metrics_access_control_optional",
    !metricsAccessControl || isPassingStatus(metricsAccessControl.status),
    "Metrics private-scrape access-control evidence is optional, but when present its status must be passing."
  );
  addCheck(
    checks,
    "metrics_access_control_age",
    !metricsAccessControl || freshTimestamp(selectedTimestamp(metricsAccessControl), now, maxAgeHours),
    `Metrics private-scrape access-control evidence must be no older than ${maxAgeHours} hours when provided.`
  );
  addCheck(
    checks,
    "metrics_access_control_private_scrape",
    !metricsAccessControl ||
      (
        metricsAccessControl.privateScrapeException === true &&
        metricsScrapePath(metricsAccessControl) === "/metrics" &&
        metricsPrivateScrapeProtectionAllowed(metricsAccessControl) &&
        metricsPublicAccessBlocked(metricsAccessControl)
      ),
    "Metrics private-scrape evidence must prove /metrics is private-network, localhost-sidecar, or reverse-proxy-allowlist protected and not publicly unauthenticated."
  );
  addCheck(checks, "operator", Boolean(operatorName(root)), "Ingress evidence must include the operator name.");
  addCheck(checks, "ticket", Boolean(ticketId(root)), "Ingress evidence must include a release, change, or incident ticket id.");

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-ingress-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxAgeHours
    },
    selectedEvidence: {
      environment: environmentName(root) ?? null,
      publicBaseUrl: publicBaseUrl(root) ?? null,
      commitRef: releaseIdentity.commitRef ?? null,
      repository: releaseIdentity.repository ?? null,
      branch: releaseIdentity.branch ?? null,
      trustProxyPolicy: policy ?? null,
      deploymentTopology: topology ?? null,
      directApiPort: summarizeEvidence(directApiPort),
      forwardedHeaders: summarizeEvidence(forwardedHeaders),
      apiRateLimit: summarizeEvidence(apiRateLimit, [
        "edgeEnforced",
        "sharedAcrossInstances",
        "processLocalOnly",
        "processLocal",
        "processLocalLimiter",
        "limiterScope",
        "scope",
        "limiterType",
        "type",
        "enforcementPoint",
        "enforcedAt",
        "clientIpBucketed"
      ]),
      unthrottledRoutes: summarizeEvidence(unthrottledRoutes),
      metricsAccessControl: summarizeEvidence(metricsAccessControl, [
        "privateScrapeException",
        "scrapePath",
        "path",
        "endpoint",
        "protection",
        "accessControl",
        "networkProtection",
        "publicAccessBlocked",
        "noPublicUnauthenticatedAccess",
        "publicUnauthenticatedAccessBlocked"
      ])
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runIngressEvidenceCheck(
  options: IngressEvidenceCheckOptions
): Promise<IngressEvidenceCheckResult> {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateIngressEvidence(raw, options);
}

export function parseIngressEvidenceCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    maxAgeHours: defaultMaxAgeHours,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--evidence") {
      parsed.evidencePath = args[++index];
    } else if (arg === "--commit-ref") {
      parsed.commitRef = args[++index];
    } else if (arg === "--repo") {
      parsed.repo = args[++index];
    } else if (arg === "--branch") {
      parsed.branch = args[++index];
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = args[++index];
    } else if (arg === "--max-age-hours") {
      parsed.maxAgeHours = Number(args[++index]);
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help && !parsed.evidencePath) {
    throw new Error("--evidence <file> is required.");
  }

  return parsed;
}

export function ingressEvidenceCheckUsage() {
  return [
    "Usage: npm run --silent ingress:evidence -- --evidence <file> [--json]",
    "",
    "Options:",
    "  --evidence <file>        Evidence JSON from target ingress verification.",
    "  --commit-ref <sha>       Expected release commit.",
    "  --repo <owner/name>      Expected release repository.",
    "  --branch <branch>        Expected release branch.",
    "  --target-environment <name> Expected target environment.",
    `  --max-age-hours <hours>  Maximum evidence age. Default: ${defaultMaxAgeHours}.`,
    "  --json                   Print machine-readable result.",
    "  --help                   Show this help."
  ].join("\n");
}

function writeHumanResult(result: IngressEvidenceCheckResult, io: CliIo) {
  io.stdout.write(`SiteFlow ingress evidence status: ${result.status}\n`);
  io.stdout.write(`Evidence: ${result.evidencePath}\n`);

  for (const check of result.checks) {
    io.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}\n`);
  }
}

export async function runIngressEvidenceCheckCli(
  args: string[] = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr }
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseIngressEvidenceCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr.write(`${ingressEvidenceCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${ingressEvidenceCheckUsage()}\n`);
    return 0;
  }

  try {
    const result = await runIngressEvidenceCheck({
      evidencePath: parsed.evidencePath!,
      commitRef: parsed.commitRef,
      repo: parsed.repo,
      branch: parsed.branch,
      targetEnvironment: parsed.targetEnvironment,
      maxAgeHours: parsed.maxAgeHours
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: IngressEvidenceCheckResult = {
      name: "siteflow-ingress-evidence-check",
      status: "blocked",
      checkedAt: new Date().toISOString(),
      evidencePath: parsed.evidencePath!,
      thresholds: {
        maxAgeHours: parsed.maxAgeHours
      },
      selectedEvidence: {
        environment: null,
        publicBaseUrl: null,
        commitRef: null,
        repository: null,
        branch: null,
        trustProxyPolicy: null,
        deploymentTopology: null,
        directApiPort: null,
        forwardedHeaders: null,
        apiRateLimit: null,
        unthrottledRoutes: null,
        metricsAccessControl: null
      },
      checks: [
        {
          name: "evidence_file",
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

    return 1;
  }
}

if (isEntrypoint()) {
  runIngressEvidenceCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
