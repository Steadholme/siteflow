import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type EvidenceStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface OperatorAccessEvidenceCheckOptions {
  evidencePath: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  maxAgeHours?: number;
  now?: () => Date;
}

export interface OperatorAccessEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface OperatorAccessEvidenceSummary {
  status?: string;
  timestamp?: string;
}

export interface OperatorAccessEvidenceCheckResult {
  name: "siteflow-operator-access-evidence-check";
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
    sessionCreate: OperatorAccessEvidenceSummary | null;
    projectScope: OperatorAccessEvidenceSummary | null;
    sessionRotation: OperatorAccessEvidenceSummary | null;
    sessionRevoke: OperatorAccessEvidenceSummary | null;
    csrf: OperatorAccessEvidenceSummary | null;
    bearerPrecedence: OperatorAccessEvidenceSummary | null;
    actorAttribution: OperatorAccessEvidenceSummary | null;
    emergencyCutoff: OperatorAccessEvidenceSummary | null;
    browserTokenFallback: OperatorAccessEvidenceSummary | null;
  };
  checks: OperatorAccessEvidenceCheck[];
  exitCode: number;
}

export const requiredOperatorAccessEvidenceCheckNames = [
  "non_dry_run",
  "not_template",
  "status_final",
  "evidence_age",
  "release_identity",
  "target_facts",
  "environment",
  "public_base_url",
  "session_create_present",
  "session_create_status",
  "session_create_age",
  "session_cookie_flags",
  "session_secret_not_returned",
  "session_policy_present",
  "session_policy_enforced",
  "session_policy_age",
  "project_scope_present",
  "project_scope_enforced",
  "project_scope_age",
  "session_rotation_present",
  "session_rotation_status",
  "session_rotation_cookie_flags",
  "session_rotation_secret_not_returned",
  "session_rotation_csrf_enforced",
  "session_rotation_old_cookie_rejected",
  "session_rotation_age",
  "session_revoke_present",
  "session_revoke_status",
  "session_revoke_age",
  "csrf_present",
  "csrf_enforced",
  "csrf_age",
  "bearer_precedence_present",
  "bearer_precedence_enforced",
  "bearer_precedence_age",
  "actor_attribution_present",
  "actor_attribution_enforced",
  "actor_attribution_age",
  "browser_token_fallback_present",
  "browser_token_fallback_posture",
  "browser_token_fallback_exception_documented",
  "browser_token_fallback_local_storage_disabled",
  "browser_token_fallback_age",
  "emergency_cutoff_present",
  "emergency_cutoff_global",
  "emergency_cutoff_project",
  "emergency_cutoff_cookie_only_rejected",
  "emergency_cutoff_low_scope_bearer",
  "emergency_cutoff_old_cookie_rejected",
  "emergency_cutoff_age",
  "negative_evidence_present",
  "no_raw_secrets_stored",
  "no_sensitive_evidence_values",
  "non_goals_not_claimed",
  "operator",
  "ticket"
] as const;

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
const expectedSchemaVersion = "siteflow.operatorAccessEvidence.v1";
const expectedName = "siteflow-operator-access-evidence";
const passStatuses = new Set(["pass", "passed", "ok", "verified", "revoked", "rejected", "enforced"]);

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

function addCheck(checks: OperatorAccessEvidenceCheck[], name: string, condition: boolean, message: string) {
  checks.push({
    name,
    status: condition ? "pass" : "fail",
    message
  });
}

function isPassingStatus(value: unknown) {
  const normalized = statusValue(value);

  return Boolean(normalized && passStatuses.has(normalized));
}

function section(root: Record<string, unknown> | undefined, key: string, aliases: string[] = []) {
  return [key, ...aliases].map((candidate) => nestedObject(root, candidate)).find(Boolean);
}

function selectedTimestamp(candidate: Record<string, unknown> | undefined) {
  return timestampValue(candidate?.checkedAt) ??
    timestampValue(candidate?.completedAt) ??
    timestampValue(candidate?.verifiedAt) ??
    timestampValue(candidate?.timestamp) ??
    timestampValue(candidate?.createdAt);
}

function summarizeEvidence(candidate: Record<string, unknown> | undefined) {
  if (!candidate) {
    return null;
  }

  return {
    status: stringValue(candidate.status),
    timestamp: selectedTimestamp(candidate)
  };
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

function targetFactsMatch(root: Record<string, unknown> | undefined) {
  const target = targetObject(root);
  const targetCommitRef = targetReleaseCommit(target);
  const targetRepository = targetReleaseRepository(target);
  const targetBranch = targetReleaseBranch(target);

  return Boolean(
    target &&
      targetEnvironmentName(target) &&
      targetEnvironmentName(target) === environmentName(root) &&
      targetPublicBaseUrl(target) &&
      targetPublicBaseUrl(target) === publicBaseUrl(root) &&
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
    stringValue(root?.releaseTicket) ??
    stringValue(nestedValue(root, ["ticket", "id"]));
}

function releaseObject(root: Record<string, unknown> | undefined) {
  return nestedObject(root, "release") ?? root;
}

function releaseCommit(root: Record<string, unknown> | undefined) {
  const release = releaseObject(root);

  return stringValue(release?.commitRef) ?? stringValue(release?.commitSha);
}

function releaseRepository(root: Record<string, unknown> | undefined) {
  return stringValue(releaseObject(root)?.repository);
}

function releaseBranch(root: Record<string, unknown> | undefined) {
  return stringValue(releaseObject(root)?.branch);
}

function evidenceTimestamp(root: Record<string, unknown> | undefined) {
  return timestampValue(root?.checkedAt) ?? timestampValue(root?.completedAt) ?? timestampValue(root?.timestamp);
}

function validHttpsUrl(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function statusCode(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function statusCodeIn(candidate: Record<string, unknown> | undefined, keys: string[], expected: number[]) {
  return keys.some((key) => {
    const value = statusCode(candidate?.[key]);

    return value !== undefined && expected.includes(value);
  });
}

function freshSection(candidate: Record<string, unknown> | undefined, now: Date, maxAgeHours: number) {
  return freshTimestamp(selectedTimestamp(candidate), now, maxAgeHours);
}

function hasBooleanField(candidate: Record<string, unknown> | undefined, keys: string[], expected: boolean) {
  return Boolean(candidate && keys.some((key) => candidate[key] === expected));
}

const browserFallbackEnabledAliasKeys = [
  "productionFallbackEnabled",
  "browserTokenFallbackEnabled",
  "viteSiteflowAllowBrowserTokenFallback",
  "allowBrowserTokenFallback",
  "siteflowAllowBrowserTokenFallback",
  "browserStorageTokenFallbackEnabled",
  "productionBrowserTokenFallbackEnabled"
];

const browserFallbackDisabledProofKeys = [
  "browserTokenFallbackDisabled",
  "productionFallbackDisabled",
  "productionBrowserTokenFallbackDisabled"
];

const localStorageFallbackEnabledAliasKeys = [
  "localStorageFallbackEnabled",
  "localStorageTokenFallbackEnabled",
  "browserLocalStorageFallbackEnabled",
  "localStorageTokenFallbackAllowed",
  "viteSiteflowAllowLocalStorageTokenFallback"
];

const localStorageFallbackDisabledProofKeys = [
  "localStorageFallbackDisabled",
  "localStorageIgnored",
  "localStorageTokenFallbackDisabled",
  "browserLocalStorageFallbackDisabled"
];

export function evaluateOperatorAccessEvidence(
  rawEvidence: unknown,
  options: OperatorAccessEvidenceCheckOptions
): OperatorAccessEvidenceCheckResult {
  const now = options.now?.() ?? new Date();
  const maxAgeHours = positiveNumber(options.maxAgeHours, defaultMaxAgeHours, "maxAgeHours");
  const root = isObject(rawEvidence) ? rawEvidence : undefined;
  const sessionCreate = section(root, "sessionCreate", ["operatorSessionCreate"]);
  const projectScope = section(root, "projectScope", ["sessionProjectScope"]);
  const sessionRotation = section(root, "sessionRotation", ["operatorSessionRotation"]);
  const sessionRevoke = section(root, "sessionRevoke", ["currentSessionRevoke"]);
  const csrf = section(root, "csrf", ["csrfProtection"]);
  const bearerPrecedence = section(root, "bearerPrecedence", ["authorizationPrecedence"]);
  const actorAttribution = section(root, "actorAttribution", ["serverDerivedActor"]);
  const emergencyCutoff = section(root, "emergencyCutoff", ["revokeAll", "sessionCutoff"]);
  const browserTokenFallback = section(root, "browserTokenFallback", ["browserStorageTokenFallback"]);
  const sessionPolicy = section(root, "sessionPolicy", ["idleTimeout"]);
  const negativeEvidence = section(root, "negativeEvidence", ["secretHygiene"]);
  const globalCutoff = nestedObject(emergencyCutoff, "global");
  const projectCutoff = nestedObject(emergencyCutoff, "project");
  const cookieOnlyCutoff = nestedObject(emergencyCutoff, "cookieOnly") ?? nestedObject(emergencyCutoff, "cookieOnlyRejected");
  const lowScopeCutoff = nestedObject(emergencyCutoff, "lowScopeBearer") ?? nestedObject(emergencyCutoff, "lowScopeBearerWithAdminCookie");
  const sessionCreateResponse = nestedObject(sessionCreate, "response");
  const sessionCreateCookie = nestedObject(sessionCreate, "cookie");
  const sessionRotationResponse = nestedObject(sessionRotation, "response");
  const sessionRotationCookie = nestedObject(sessionRotation, "cookie");
  const sessionRotationCsrf = nestedObject(sessionRotation, "csrf");
  const csrfWithoutHeader = nestedObject(csrf, "cookieWriteWithoutHeader");
  const csrfWithHeader = nestedObject(csrf, "cookieWriteWithHeader");
  const browserFallbackExplicitlyEnabled = hasBooleanField(browserTokenFallback, browserFallbackEnabledAliasKeys, true);
  const browserFallbackDisabled = !browserFallbackExplicitlyEnabled &&
    (
      hasBooleanField(browserTokenFallback, browserFallbackEnabledAliasKeys, false) ||
      hasBooleanField(browserTokenFallback, browserFallbackDisabledProofKeys, true)
    );
  const localStorageFallbackExplicitlyEnabled = hasBooleanField(browserTokenFallback, localStorageFallbackEnabledAliasKeys, true);
  const localStorageFallbackDisabled = !localStorageFallbackExplicitlyEnabled &&
    (
      hasBooleanField(browserTokenFallback, localStorageFallbackDisabledProofKeys, true) ||
      hasBooleanField(browserTokenFallback, localStorageFallbackEnabledAliasKeys, false)
    );
  const browserFallbackException = browserTokenFallback?.explicitTransitionException === true &&
    Boolean(stringValue(browserTokenFallback?.exceptionReason)) &&
    Boolean(stringValue(browserTokenFallback?.exceptionTicket ?? ticketId(root))) &&
    localStorageFallbackDisabled;
  const commitRef = releaseCommit(root);
  const repository = releaseRepository(root);
  const branch = releaseBranch(root);
  const secretFindings = scanEvidenceForRawSecrets(rawEvidence);
  const checks: OperatorAccessEvidenceCheck[] = [];

  addCheck(checks, "evidence_shape", Boolean(root), "Operator access evidence must be a JSON object.");
  addCheck(
    checks,
    "schema_version",
    root?.schemaVersion === expectedSchemaVersion,
    `Operator access evidence schemaVersion must be ${expectedSchemaVersion}.`
  );
  addCheck(
    checks,
    "evidence_name",
    root?.name === expectedName,
    `Operator access evidence name must be ${expectedName}.`
  );
  addCheck(
    checks,
    "evidence_status",
    statusValue(root?.status) === "passed",
    "Operator access evidence status must be passed."
  );
  addCheck(
    checks,
    "status_final",
    statusValue(root?.status) === "passed",
    "Operator access evidence status must be exactly passed for final production evidence."
  );
  addCheck(
    checks,
    "non_dry_run",
    root?.dryRun === false,
    "Operator access evidence must be collected from a non-dry-run target-equivalent workflow."
  );
  addCheck(
    checks,
    "not_template",
    root?.template !== true,
    "Operator access evidence must be final target evidence, not a template skeleton."
  );
  addCheck(
    checks,
    "evidence_age",
    freshTimestamp(evidenceTimestamp(root), now, maxAgeHours),
    `Operator access evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "release_identity",
    Boolean(
      commitRef &&
        repository &&
        branch &&
        (!options.commitRef || options.commitRef === commitRef) &&
        (!options.repo || options.repo === repository) &&
        (!options.branch || options.branch === branch)
    ),
    "Operator access evidence must include release commit, repository, and branch matching requested values."
  );
  addCheck(
    checks,
    "target_facts",
    targetFactsMatch(root),
    "Operator access evidence must include target environment, public base URL, and release identity facts matching the final evidence."
  );
  addCheck(
    checks,
    "environment",
    Boolean(environmentName(root) && (!options.targetEnvironment || environmentName(root) === options.targetEnvironment)),
    "Operator access evidence must include the target environment and match the requested target environment when provided."
  );
  addCheck(checks, "public_base_url", validHttpsUrl(publicBaseUrl(root)), "Operator access evidence must include an HTTPS public base URL.");

  addCheck(checks, "session_create_present", Boolean(sessionCreate), "Operator session creation evidence must be present.");
  addCheck(
    checks,
    "session_create_status",
    isPassingStatus(sessionCreate?.status) &&
      (statusCodeIn(sessionCreate, ["statusCode", "httpStatus"], [200, 201]) ||
        statusCodeIn(sessionCreateResponse, ["statusCode", "httpStatus"], [200, 201])),
    "Operator session creation must pass and return 200 or 201."
  );
  addCheck(
    checks,
    "session_create_age",
    freshSection(sessionCreate, now, maxAgeHours),
    `Operator session creation evidence must be no older than ${maxAgeHours} hours.`
  );
  addCheck(
    checks,
    "session_cookie_flags",
    (sessionCreate?.cookieHttpOnly === true || sessionCreateCookie?.httpOnly === true) &&
      (sessionCreate?.cookieSecure === true || sessionCreateCookie?.secure === true) &&
      (statusValue(sessionCreate?.cookieSameSite) === "lax" || statusValue(sessionCreateCookie?.sameSite) === "lax") &&
      (sessionCreate?.cookiePath === "/" || sessionCreate?.path === "/" || sessionCreateCookie?.path === "/"),
    "Created operator session cookie must be HttpOnly, Secure, SameSite=Lax, and Path=/."
  );
  addCheck(
    checks,
    "session_secret_not_returned",
    sessionCreate?.secretReturnedInJson === false ||
      sessionCreate?.jsonIncludesSecret === false ||
      sessionCreateResponse?.rawSecretReturnedInJson === false,
    "Operator session create response must not return the raw session secret in JSON."
  );

  addCheck(checks, "session_policy_present", Boolean(sessionPolicy), "Operator session TTL and idle-timeout policy evidence must be present.");
  addCheck(
    checks,
    "session_policy_enforced",
    isPassingStatus(sessionPolicy?.status) &&
      typeof sessionPolicy?.idleTimeoutSeconds === "number" &&
      sessionPolicy.idleTimeoutSeconds >= 60 &&
      sessionPolicy.idleTimeoutSeconds <= 86_400 &&
      sessionPolicy?.absoluteTtlEnforced === true &&
      sessionPolicy?.expiredOrRevokedSessionRejected === true,
    "Operator sessions must have an idle timeout from 60 to 86400 seconds, absolute TTL enforcement, and expired/revoked rejection evidence."
  );
  addCheck(
    checks,
    "session_policy_age",
    freshSection(sessionPolicy, now, maxAgeHours),
    `Operator session policy evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "project_scope_present", Boolean(projectScope), "Project-scoped operator session evidence must be present.");
  addCheck(
    checks,
    "project_scope_enforced",
    isPassingStatus(projectScope?.status) &&
      (
        statusCodeIn(projectScope, ["allowedProjectStatusCode", "allowedStatusCode"], [200]) ||
        projectScope?.projectScopedSessionAllowedOnMatchingProject === true
      ) &&
      (
        statusCodeIn(projectScope, ["deniedProjectStatusCode", "nonMatchingProjectStatusCode"], [403]) ||
        projectScope?.projectScopedSessionDeniedOnOtherProject === true
      ) &&
      (
        statusCodeIn(projectScope, ["deniedGlobalStatusCode", "globalRouteStatusCode"], [403]) ||
        projectScope?.projectScopedSessionDeniedOnGlobalRoute === true
      ),
    "Project-scoped sessions must work for matching project routes and be denied for non-matching/global routes."
  );
  addCheck(
    checks,
    "project_scope_age",
    freshSection(projectScope, now, maxAgeHours),
    `Project-scope evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "session_rotation_present", Boolean(sessionRotation), "Operator session rotation evidence must be present.");
  addCheck(
    checks,
    "session_rotation_status",
    isPassingStatus(sessionRotation?.status) &&
      statusCodeIn(sessionRotation, ["statusCode", "httpStatus"], [200]) &&
      (
        statusCodeIn(sessionRotation, ["newCookieStatusCode", "afterRotateStatusCode"], [200]) ||
        sessionRotation?.newCookieAccepted === true
      ),
    "Operator session rotation must pass and the rotated cookie must be accepted."
  );
  addCheck(
    checks,
    "session_rotation_cookie_flags",
    (sessionRotation?.cookieHttpOnly === true || sessionRotationCookie?.httpOnly === true) &&
      (sessionRotation?.cookieSecure === true || sessionRotationCookie?.secure === true) &&
      (statusValue(sessionRotation?.cookieSameSite) === "lax" || statusValue(sessionRotationCookie?.sameSite) === "lax") &&
      (sessionRotation?.cookiePath === "/" || sessionRotation?.path === "/" || sessionRotationCookie?.path === "/"),
    "Rotated operator session cookie must be HttpOnly, Secure, SameSite=Lax, and Path=/."
  );
  addCheck(
    checks,
    "session_rotation_secret_not_returned",
    sessionRotation?.secretReturnedInJson === false ||
      sessionRotation?.jsonIncludesSecret === false ||
      sessionRotationResponse?.rawSecretReturnedInJson === false,
    "Operator session rotate response must not return the raw session secret in JSON."
  );
  addCheck(
    checks,
    "session_rotation_csrf_enforced",
    statusCodeIn(sessionRotation, ["missingCsrfStatusCode", "withoutCsrfStatusCode"], [403]) ||
      statusCodeIn(sessionRotationCsrf, ["missingHeaderStatusCode", "withoutHeaderStatusCode", "statusCode"], [403]),
    "Operator session rotation must require X-SiteFlow-CSRF: same-origin."
  );
  addCheck(
    checks,
    "session_rotation_old_cookie_rejected",
    statusCodeIn(sessionRotation, ["oldCookieStatusCode", "afterRotateOldCookieStatusCode"], [401]) ||
      sessionRotation?.oldCookieRejectedAfterRotation === true,
    "Operator session rotation must reject the old cookie after the rotated cookie is issued."
  );
  addCheck(
    checks,
    "session_rotation_age",
    freshSection(sessionRotation, now, maxAgeHours),
    `Operator session rotation evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "session_revoke_present", Boolean(sessionRevoke), "Current operator session revoke evidence must be present.");
  addCheck(
    checks,
    "session_revoke_status",
    isPassingStatus(sessionRevoke?.status) &&
      statusCodeIn(sessionRevoke, ["statusCode", "httpStatus"], [200]) &&
      (sessionRevoke?.cookieCleared === true || sessionRevoke?.clearsCookie === true) &&
      (
        statusCodeIn(sessionRevoke, ["oldCookieStatusCode", "afterRevokeStatusCode"], [401]) ||
        sessionRevoke?.oldCookieRejectedAfterRevoke === true
      ),
    "Current operator session revoke must clear the cookie and reject the old cookie."
  );
  addCheck(
    checks,
    "session_revoke_age",
    freshSection(sessionRevoke, now, maxAgeHours),
    `Current session revoke evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "csrf_present", Boolean(csrf), "CSRF evidence for cookie-authenticated writes must be present.");
  addCheck(
    checks,
    "csrf_enforced",
    isPassingStatus(csrf?.status) &&
      (statusCodeIn(csrf, ["missingHeaderStatusCode", "withoutHeaderStatusCode"], [403]) ||
        statusCodeIn(csrfWithoutHeader, ["statusCode"], [403])) &&
      (statusCodeIn(csrf, ["sameOriginHeaderStatusCode", "withHeaderStatusCode"], [200, 201, 202]) ||
        csrfWithHeader?.accepted === true ||
        statusCodeIn(csrfWithHeader, ["statusCode"], [200, 201, 202])) &&
      csrf?.bearerWriteRequiresCsrf !== true,
    "Cookie-authenticated mutating requests must require X-SiteFlow-CSRF: same-origin."
  );
  addCheck(checks, "csrf_age", freshSection(csrf, now, maxAgeHours), `CSRF evidence must be no older than ${maxAgeHours} hours.`);

  addCheck(checks, "bearer_precedence_present", Boolean(bearerPrecedence), "Bearer precedence evidence must be present.");
  addCheck(
    checks,
    "bearer_precedence_enforced",
    (isPassingStatus(bearerPrecedence?.status) || bearerPrecedence?.bearerAndCookiePresentUsesBearer === true) &&
      (statusCodeIn(bearerPrecedence, ["lowScopeBearerWithAdminCookieStatusCode", "statusCode", "observedDeniedStatusCode"], [403]) ||
        bearerPrecedence?.lowScopeBearerDoesNotFallBackToAdminCookie === true) &&
      bearerPrecedence?.fallbackToCookie !== true,
    "Low-scope Bearer tokens must not fall back to admin cookies."
  );
  addCheck(
    checks,
    "bearer_precedence_age",
    freshSection(bearerPrecedence, now, maxAgeHours),
    `Bearer precedence evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "actor_attribution_present", Boolean(actorAttribution), "Server-derived actor attribution evidence must be present.");
  addCheck(
    checks,
    "actor_attribution_enforced",
    isPassingStatus(actorAttribution?.status) &&
      (actorAttribution?.bodyActorIgnored === true || actorAttribution?.clientActorSpoofIgnored === true) &&
      (
        actorAttribution?.serverActorRecorded === true ||
        actorAttribution?.serverDerivedActorForBearerWrites === true ||
        actorAttribution?.serverDerivedActorForCookieSessionWrites === true
      ),
    "Control-plane writes must derive the executing actor from auth and ignore spoofed body actors."
  );
  addCheck(
    checks,
    "actor_attribution_age",
    freshSection(actorAttribution, now, maxAgeHours),
    `Actor attribution evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "emergency_cutoff_present", Boolean(emergencyCutoff), "Operator session emergency cutoff evidence must be present.");
  addCheck(
    checks,
    "emergency_cutoff_global",
    isPassingStatus(globalCutoff?.status) &&
      statusCodeIn(globalCutoff, ["statusCode", "httpStatus"], [200]) &&
      globalCutoff?.scope === "global" &&
      Boolean(stringValue(globalCutoff?.cutoffId)) &&
      Boolean(timestampValue(globalCutoff?.revokedAt)),
    "Global emergency cutoff must pass and return scope, cutoffId, and revokedAt."
  );
  addCheck(
    checks,
    "emergency_cutoff_project",
    isPassingStatus(projectCutoff?.status) &&
      statusCodeIn(projectCutoff, ["statusCode", "httpStatus"], [200]) &&
      projectCutoff?.scope === "project" &&
      Boolean(stringValue(projectCutoff?.projectId)) &&
      Boolean(stringValue(projectCutoff?.cutoffId)) &&
      Boolean(timestampValue(projectCutoff?.revokedAt)),
    "Project emergency cutoff must pass and return project scope, projectId, cutoffId, and revokedAt."
  );
  addCheck(
    checks,
    "emergency_cutoff_cookie_only_rejected",
    statusCodeIn(cookieOnlyCutoff, ["statusCode", "httpStatus"], [401, 403]) ||
      globalCutoff?.cookieOnlyRejected === true,
    "Cookie-only emergency cutoff requests must be rejected."
  );
  addCheck(
    checks,
    "emergency_cutoff_low_scope_bearer",
    statusCodeIn(lowScopeCutoff, ["statusCode", "httpStatus"], [403]) &&
      lowScopeCutoff?.fallbackToCookie === false,
    "Low-scope Bearer emergency cutoff requests must not fall back to admin cookies."
  );
  addCheck(
    checks,
    "emergency_cutoff_old_cookie_rejected",
    statusCodeIn(globalCutoff, ["oldCookieStatusCode", "afterCutoffCookieStatusCode"], [401]) ||
      statusCodeIn(projectCutoff, ["oldCookieStatusCode", "afterCutoffCookieStatusCode"], [401]) ||
      globalCutoff?.oldCookieRejectedAfterCutoff === true ||
      projectCutoff?.oldCookieRejectedAfterCutoff === true,
    "A cookie minted before emergency cutoff must be rejected after cutoff."
  );
  addCheck(
    checks,
    "emergency_cutoff_age",
    freshSection(emergencyCutoff, now, maxAgeHours),
    `Emergency cutoff evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "browser_token_fallback_present", Boolean(browserTokenFallback), "Browser token fallback posture evidence must be present.");
  addCheck(
    checks,
    "browser_token_fallback_posture",
    isPassingStatus(browserTokenFallback?.status) && browserFallbackDisabled,
    "Production browser token storage fallback must be disabled without conflicting enabled aliases."
  );
  addCheck(
    checks,
    "browser_token_fallback_exception_documented",
    browserFallbackDisabled || browserFallbackException,
    "If production browser token fallback is enabled, evidence must include an explicit transition exception, reason, ticket, and localStorage disabled proof."
  );
  addCheck(
    checks,
    "browser_token_fallback_local_storage_disabled",
    localStorageFallbackDisabled,
    "Browser token fallback evidence must prove localStorage token fallback is disabled without conflicting enabled aliases."
  );
  addCheck(
    checks,
    "browser_token_fallback_age",
    freshSection(browserTokenFallback, now, maxAgeHours),
    `Browser token fallback evidence must be no older than ${maxAgeHours} hours.`
  );

  addCheck(checks, "negative_evidence_present", Boolean(negativeEvidence), "Secret hygiene and non-goal evidence must be present.");
  addCheck(
    checks,
    "no_raw_secrets_stored",
    negativeEvidence?.noRawBearerTokensStored === true &&
      negativeEvidence?.noRawSessionSecretsStored === true &&
      negativeEvidence?.noAuthorizationHeadersStored === true,
    "Operator access evidence must not store raw bearer tokens, raw session secrets, or authorization headers."
  );
  addCheck(
    checks,
    "no_sensitive_evidence_values",
    secretFindings.length === 0,
    secretFindings.length === 0
      ? "Operator access evidence must not include raw secret-like values."
      : `Operator access evidence includes raw secret-like values: ${evidenceSecretFindingSummary(secretFindings)}.`
  );
  addCheck(
    checks,
    "non_goals_not_claimed",
    negativeEvidence?.notClaimingLoginIdpMfa === true &&
      negativeEvidence?.credentialedCorsNotExposedAsReady === true &&
      negativeEvidence?.nonSessionCredentialRotationOutOfScope === true,
    "Operator access evidence must not claim login/IdP/MFA, credentialed CORS, or non-session credential rotation are complete."
  );

  addCheck(checks, "operator", Boolean(operatorName(root)), "Operator access evidence must include the operator name.");
  addCheck(checks, "ticket", Boolean(ticketId(root)), "Operator access evidence must include a release, change, or incident ticket id.");

  const passed = checks.every((check) => check.status === "pass");

  return {
    name: "siteflow-operator-access-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt: now.toISOString(),
    evidencePath: options.evidencePath,
    thresholds: {
      maxAgeHours
    },
    selectedEvidence: {
      environment: environmentName(root) ?? null,
      publicBaseUrl: publicBaseUrl(root) ?? null,
      commitRef: commitRef ?? null,
      repository: repository ?? null,
      branch: branch ?? null,
      sessionCreate: summarizeEvidence(sessionCreate),
      projectScope: summarizeEvidence(projectScope),
      sessionRotation: summarizeEvidence(sessionRotation),
      sessionRevoke: summarizeEvidence(sessionRevoke),
      csrf: summarizeEvidence(csrf),
      bearerPrecedence: summarizeEvidence(bearerPrecedence),
      actorAttribution: summarizeEvidence(actorAttribution),
      emergencyCutoff: summarizeEvidence(emergencyCutoff),
      browserTokenFallback: summarizeEvidence(browserTokenFallback)
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

export async function runOperatorAccessEvidenceCheck(
  options: OperatorAccessEvidenceCheckOptions
): Promise<OperatorAccessEvidenceCheckResult> {
  const raw = JSON.parse(await readFile(options.evidencePath, "utf8")) as unknown;

  return evaluateOperatorAccessEvidence(raw, options);
}

export function parseOperatorAccessEvidenceArgs(args: string[]): ParsedArgs {
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
    throw new Error("Missing required option: --evidence.");
  }

  return parsed;
}

export function operatorAccessEvidenceUsage() {
  return [
    "Usage: npm run --silent operator-access:evidence -- --evidence <operator-access-evidence.json> [options]",
    "",
    "Options:",
    "  --commit-ref <sha>       Expected release commit.",
    "  --repo <owner/repo>      Expected repository.",
    "  --branch <branch>        Expected branch.",
    "  --target-environment <name> Expected target environment.",
    `  --max-age-hours <hours>  Maximum evidence age. Default: ${defaultMaxAgeHours}.`,
    "  --json                   Print JSON result.",
    "  --help                   Show this help."
  ].join("\n");
}

function writeHumanResult(result: OperatorAccessEvidenceCheckResult, io: CliIo) {
  io.stdout.write(`SiteFlow operator access evidence check: ${result.status}\n`);

  for (const check of result.checks) {
    io.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}\n`);
  }
}

export async function runOperatorAccessEvidenceCheckCli(args: string[], io: CliIo = process): Promise<number> {
  try {
    const parsed = parseOperatorAccessEvidenceArgs(args);

    if (parsed.help) {
      io.stdout.write(`${operatorAccessEvidenceUsage()}\n`);
      return 0;
    }

    const result = await runOperatorAccessEvidenceCheck({
      evidencePath: parsed.evidencePath as string,
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
    const message = error instanceof Error ? error.message : "Unknown operator access evidence check failure.";
    io.stderr.write(`operator-access:evidence failed: ${message}\n`);
    return 1;
  }
}

if (isEntrypoint()) {
  const exitCode = await runOperatorAccessEvidenceCheckCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
