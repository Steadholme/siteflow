import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  evaluateReleaseEvidenceBundle,
  type ReleaseEvidenceBundleResult
} from "./releaseEvidenceBundleCheck.js";
import { strictIsoTimestampValue } from "./isoTimestamp.js";
import { evidenceSecretFindingSummary, scanEvidenceForRawSecrets } from "./evidenceSecretScan.js";

type PostPromotionStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface ReleasePostPromotionEvidenceCheckOptions {
  releaseEvidencePath: string;
  deploymentDetailPath?: string;
  deploymentDetail?: unknown;
  serverUrl?: string;
  apiToken?: string;
  deploymentId?: string;
  projectId?: string;
  channel?: string;
  expectedEvidencePath?: string;
  readinessProbe?: unknown;
  metricsProbe?: unknown;
  productionExceptionEvidence?: unknown;
  productionBreakGlassEvidence?: unknown;
  evaluateBundle?: typeof evaluateReleaseEvidenceBundle;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ReleasePostPromotionEvidenceCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReleasePostPromotionEvidenceCheckResult {
  name: "siteflow-release-post-promotion-evidence-check";
  status: PostPromotionStatus;
  checkedAt: string;
  releaseEvidencePath: string;
  selectedEvidence: {
    deploymentId: string | null;
    projectId: string | null;
    channel: string | null;
    releaseCommitRef: string | null;
    repository: string | null;
    branch: string | null;
    targetEnvironment: string | null;
    routeRevisionId: string | null;
    routeEvidenceStatus: string | null;
    routeEvidenceCheckedAt: string | null;
    routeEvidencePayloadDigest: string | null;
  };
  checks: ReleasePostPromotionEvidenceCheck[];
  exitCode: number;
}

interface ParsedArgs {
  releaseEvidencePath?: string;
  deploymentDetailPath?: string;
  serverUrl?: string;
  apiToken?: string;
  deploymentId?: string;
  projectId?: string;
  channel?: string;
  expectedEvidencePath?: string;
  readinessPath?: string;
  metricsPath?: string;
  productionExceptionPath?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface ReleaseIdentity {
  commitRef?: string;
  repository?: string;
  branch?: string;
  targetEnvironment?: string;
}

interface ProductionProbeExceptionContext {
  channel: string;
  checkedAt: string;
  release: ReleaseIdentity;
  deploymentId?: string;
  projectId?: string;
}

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

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function checksumValue(value: unknown) {
  const raw = stringValue(value);

  return raw && sha256DigestPattern.test(raw) ? raw : undefined;
}

function timestampValue(value: unknown) {
  return strictIsoTimestampValue(value);
}

function timestampNotAfter(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && new Date(left).getTime() <= new Date(right).getTime());
}

function nestedObject(candidate: unknown, path: string[]) {
  let current = candidate;

  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return isObject(current) ? current : undefined;
}

function nestedValue(candidate: unknown, path: string[]) {
  let current = candidate;

  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function objectValues(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter(isObject);
  }

  if (isObject(value)) {
    return Object.values(value).filter(isObject);
  }

  return [];
}

function runtimeIsolationValue(candidate: Record<string, unknown> | undefined) {
  const raw = stringValue(candidate?.runtimeIsolation) ??
    stringValue(candidate?.functionRuntimeIsolation) ??
    stringValue(nestedValue(candidate, ["runtime", "isolation"])) ??
    stringValue(nestedValue(candidate, ["runtime", "isolationMode"])) ??
    stringValue(nestedValue(candidate, ["functionRuntime", "isolation"])) ??
    stringValue(nestedValue(candidate, ["functionRuntime", "runtimeIsolation"]));

  return raw?.toLowerCase().replace(/-/g, "_");
}

const allowedFunctionRuntimeIsolationValues = new Set([
  "isolated_process",
  "separate_process",
  "dedicated_process",
  "external",
  "container",
  "sandboxed",
  "worker",
  "edge",
  "v8_isolate",
  "isolate"
]);
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;
const postPromotionProbeMaxAgeMs = 60 * 60 * 1000;

function runtimeIsolationIsAllowed(value: string | undefined) {
  return Boolean(value && allowedFunctionRuntimeIsolationValues.has(value));
}

async function readJsonFile(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

function check(
  name: string,
  passed: boolean,
  passMessage: string,
  failMessage: string,
  details?: Record<string, unknown>
): ReleasePostPromotionEvidenceCheck {
  return {
    name,
    status: passed ? "pass" : "fail",
    message: passed ? passMessage : failMessage,
    ...(details ? { details } : {})
  };
}

function releaseIdentity(rawEvidence: unknown, bundleCheck: ReleaseEvidenceBundleResult): ReleaseIdentity {
  const release = nestedObject(rawEvidence, ["release"]);

  return {
    commitRef: stringValue(bundleCheck.selectedEvidence.releaseCommitRef),
    repository: stringValue(bundleCheck.selectedEvidence.repository),
    branch: stringValue(bundleCheck.selectedEvidence.branch),
    targetEnvironment:
      stringValue(nestedValue(rawEvidence, ["targetEnvironment"])) ??
      stringValue(release?.targetEnvironment)
  };
}

function artifactEvidence(rawEvidence: unknown) {
  return nestedObject(rawEvidence, ["artifactEvidence", "evidence"]) ??
    nestedObject(rawEvidence, ["releaseArtifactEvidence", "evidence"]) ??
    nestedObject(rawEvidence, ["artifact", "evidence"]);
}

function deploymentArtifactManifest(deploymentDetail: unknown) {
  return nestedObject(deploymentDetail, ["lineage", "artifact", "manifest"]);
}

function deploymentFunctionRuntimeIsolationSummary(deploymentDetail: unknown) {
  const manifest = deploymentArtifactManifest(deploymentDetail);
  const functionEntries = objectValues(manifest?.functions);
  const manifestRuntimeIsolationValues = [
    manifest,
    nestedObject(manifest, ["runtime"]),
    nestedObject(manifest, ["functionRuntime"])
  ].map(runtimeIsolationValue);
  const manifestRuntimeIsolation = manifestRuntimeIsolationValues.find(Boolean);
  const manifestBlocked = manifestRuntimeIsolationValues.includes("same_process");
  const blockedFunctions = functionEntries.flatMap((entry) => {
    const functionPath = stringValue(entry.path) ?? "unknown";
    const runtimeIsolation = runtimeIsolationValue(entry) ?? manifestRuntimeIsolation;

    if (runtimeIsolationIsAllowed(runtimeIsolation)) {
      return [];
    }

    return [{
      path: functionPath,
      runtimeIsolation: runtimeIsolation ?? null,
      reason: runtimeIsolation === undefined ? "missing runtime isolation" : "unsupported runtime isolation"
    }];
  });

  return {
    functionCount: functionEntries.length,
    manifestRuntimeIsolation: manifestRuntimeIsolation ?? null,
    manifestBlocked,
    blockedFunctions,
    passed: !manifestBlocked && blockedFunctions.length === 0
  };
}

function releaseArtifactSelectedEvidence(rawEvidence: unknown) {
  return nestedObject(artifactEvidence(rawEvidence), ["selectedEvidence"]);
}

function deploymentRouteRevision(deploymentDetail: unknown) {
  return nestedObject(deploymentDetail, ["lineage", "routeRevision"]);
}

function deploymentReleaseEvidence(deploymentDetail: unknown) {
  return nestedObject(deploymentRouteRevision(deploymentDetail), ["releaseEvidence"]);
}

function expectedDeploymentDetailUrl(serverUrl: string, deploymentId: string) {
  const base = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;

  return `${base}/api/deployments/${encodeURIComponent(deploymentId)}`;
}

async function fetchDeploymentDetail(options: ReleasePostPromotionEvidenceCheckOptions) {
  if (options.deploymentDetail) {
    return options.deploymentDetail;
  }

  if (options.deploymentDetailPath) {
    return readJsonFile(options.deploymentDetailPath);
  }

  if (!options.serverUrl || !options.deploymentId) {
    throw new Error("Pass --deployment-detail, or pass --server and --deployment to fetch deployment detail.");
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(expectedDeploymentDetailUrl(options.serverUrl, options.deploymentId), {
    headers: {
      accept: "application/json",
      ...(options.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {})
    }
  });

  if (!response.ok) {
    throw new Error(`Deployment detail request failed with HTTP ${response.status}.`);
  }

  const parsed = await response.json() as unknown;

  if (!isObject(parsed)) {
    throw new Error("Deployment detail response must be a JSON object.");
  }

  return parsed;
}

function probeEndpointPath(probe: unknown) {
  const raw =
    stringValue(nestedValue(probe, ["endpoint"])) ??
    stringValue(nestedValue(probe, ["path"])) ??
    stringValue(nestedValue(probe, ["pathname"])) ??
    stringValue(nestedValue(probe, ["url"]));

  if (!raw) {
    return undefined;
  }

  try {
    return raw.includes("://") ? new URL(raw).pathname : raw;
  } catch {
    return raw;
  }
}

function probeCheckedAt(probe: unknown) {
  return timestampValue(nestedValue(probe, ["checkedAt"])) ??
    timestampValue(nestedValue(probe, ["timestamp"])) ??
    timestampValue(nestedValue(probe, ["probedAt"])) ??
    timestampValue(nestedValue(probe, ["observedAt"]));
}

function probeTimestampFresh(checkedAt: string | undefined, now: Date) {
  if (!checkedAt) {
    return false;
  }

  const checkedTime = Date.parse(checkedAt);
  const nowTime = now.getTime();

  return Number.isFinite(checkedTime) &&
    checkedTime <= nowTime &&
    nowTime - checkedTime <= postPromotionProbeMaxAgeMs;
}

function probeStatus(probe: unknown, kind: "readiness" | "metrics", now: Date) {
  const status = stringValue(nestedValue(probe, ["status"])) ?? stringValue(nestedValue(probe, ["state"]));
  const httpStatus = numberValue(nestedValue(probe, ["statusCode"])) ??
    numberValue(nestedValue(probe, ["httpStatus"])) ??
    numberValue(nestedValue(probe, ["httpStatusCode"]));
  const endpoint = probeEndpointPath(probe);
  const checkedAt = probeCheckedAt(probe);
  const expectedEndpoint = kind === "readiness" ? "/readyz" : "/metrics";
  const endpointMatches = endpoint === expectedEndpoint;
  const timestampFresh = probeTimestampFresh(checkedAt, now);
  const statusCodePassed = kind === "readiness"
    ? httpStatus === 200
    : httpStatus === 200 || httpStatus === 401 || httpStatus === 403;

  return {
    status,
    httpStatus,
    endpoint: endpoint ?? null,
    expectedEndpoint,
    checkedAt: checkedAt ?? null,
    endpointMatches,
    timestampFresh,
    passed: endpointMatches && timestampFresh && statusCodePassed
  };
}

const acceptedProductionExceptionStatuses = new Set([
  "accepted",
  "approved",
  "break_glass",
  "break-glass",
  "passed",
  "pass",
  "waived"
]);

function firstStringFromCandidates(candidates: unknown[], paths: string[][]) {
  for (const candidate of candidates) {
    for (const path of paths) {
      const value = path.length === 0 ? candidate : nestedValue(candidate, path);
      const result = stringValue(value);

      if (result) {
        return result;
      }
    }
  }

  return undefined;
}

function productionExceptionReleaseIdentity(evidence: Record<string, unknown> | undefined, root: Record<string, unknown> | undefined): ReleaseIdentity {
  const candidates = [
    evidence,
    nestedObject(evidence, ["release"]),
    nestedObject(evidence, ["releaseIdentity"]),
    nestedObject(evidence, ["releaseEvidence"]),
    nestedObject(evidence, ["selectedEvidence"]),
    root,
    nestedObject(root, ["release"]),
    nestedObject(root, ["releaseIdentity"]),
    nestedObject(root, ["releaseEvidence"]),
    nestedObject(root, ["selectedEvidence"])
  ];

  return {
    commitRef: firstStringFromCandidates(candidates, [["commitRef"], ["releaseCommitRef"], ["commitSha"], ["commit"]]),
    repository: firstStringFromCandidates(candidates, [["repository"], ["releaseRepository"], ["repo"], ["repositorySlug"], ["repoSlug"]]),
    branch: firstStringFromCandidates(candidates, [["branch"], ["branchName"], ["releaseBranch"]]),
    targetEnvironment: firstStringFromCandidates(candidates, [["targetEnvironment"], ["environment"]])
  };
}

function productionExceptionDeploymentIdentity(evidence: Record<string, unknown> | undefined, root: Record<string, unknown> | undefined) {
  const deploymentCandidates = [
    nestedObject(evidence, ["deployment"]),
    nestedObject(evidence, ["deploymentIdentity"]),
    nestedObject(evidence, ["targetDeployment"]),
    nestedObject(evidence, ["selectedEvidence"]),
    nestedObject(root, ["deployment"]),
    nestedObject(root, ["deploymentIdentity"]),
    nestedObject(root, ["targetDeployment"]),
    nestedObject(root, ["selectedEvidence"])
  ];
  const projectCandidates = [
    nestedObject(evidence, ["project"]),
    nestedObject(evidence, ["projectIdentity"]),
    nestedObject(root, ["project"]),
    nestedObject(root, ["projectIdentity"]),
    ...deploymentCandidates
  ];
  const channelCandidates = [
    evidence,
    root,
    nestedObject(evidence, ["routeRevision"]),
    nestedObject(evidence, ["route"]),
    nestedObject(root, ["routeRevision"]),
    nestedObject(root, ["route"]),
    ...deploymentCandidates
  ];

  return {
    deploymentId:
      firstStringFromCandidates([evidence, root], [["deploymentId"]]) ??
      firstStringFromCandidates(deploymentCandidates, [["deploymentId"], ["id"]]),
    projectId:
      firstStringFromCandidates([evidence, root], [["projectId"]]) ??
      firstStringFromCandidates(projectCandidates, [["projectId"], ["id"]]),
    channel:
      firstStringFromCandidates(channelCandidates, [["channel"], ["routeChannel"], ["environment"], ["deploymentEnvironment"]])
  };
}

function productionProbeExceptionStatus(rawEvidence: unknown, context: ProductionProbeExceptionContext) {
  const root = isObject(rawEvidence) ? rawEvidence : undefined;
  const evidence = root
    ? nestedObject(root, ["productionProbeException"]) ??
      nestedObject(root, ["productionException"]) ??
      nestedObject(root, ["breakGlass"]) ??
      nestedObject(root, ["breakglass"]) ??
      root
    : undefined;
  const status = statusValue(evidence?.status);
  const targetEnvironment =
    stringValue(evidence?.targetEnvironment) ??
    stringValue(evidence?.environment) ??
    stringValue(nestedValue(evidence, ["release", "targetEnvironment"])) ??
    stringValue(root?.targetEnvironment) ??
    stringValue(root?.environment);
  const ticket =
    stringValue(evidence?.ticket) ??
    stringValue(evidence?.ticketId) ??
    stringValue(evidence?.incidentTicket) ??
    stringValue(evidence?.exceptionTicket) ??
    stringValue(root?.ticket) ??
    stringValue(root?.ticketId) ??
    stringValue(root?.incidentTicket) ??
    stringValue(root?.exceptionTicket);
  const reason =
    stringValue(evidence?.reason) ??
    stringValue(evidence?.exceptionReason) ??
    stringValue(evidence?.justification) ??
    stringValue(root?.reason) ??
    stringValue(root?.exceptionReason) ??
    stringValue(root?.justification);
  const expiresAt =
    timestampValue(evidence?.expiresAt) ??
    timestampValue(evidence?.validUntil) ??
    timestampValue(evidence?.timeBoundedUntil) ??
    timestampValue(root?.expiresAt) ??
    timestampValue(root?.validUntil) ??
    timestampValue(root?.timeBoundedUntil);
  const approverCountFromList = Array.isArray(evidence?.approvers)
    ? evidence.approvers.filter((entry) => typeof entry === "string" && entry.trim()).length
    : undefined;
  const approverCount = numberValue(evidence?.approverCount) ?? approverCountFromList;
  const approvedBy =
    stringValue(evidence?.approvedBy) ??
    stringValue(evidence?.approver) ??
    stringValue(evidence?.approvedByOperator) ??
    stringValue(evidence?.approverName) ??
    stringValue(root?.approvedBy) ??
    stringValue(root?.approver);
  const accepted =
    Boolean(status && acceptedProductionExceptionStatuses.has(status)) ||
    evidence?.accepted === true ||
    evidence?.exceptionAccepted === true ||
    evidence?.breakGlassAccepted === true ||
    evidence?.approvalExceptionAccepted === true ||
    root?.accepted === true ||
    root?.exceptionAccepted === true ||
    root?.breakGlassAccepted === true ||
    root?.approvalExceptionAccepted === true;
  const approved = Boolean(approvedBy || (typeof approverCount === "number" && approverCount > 0));
  const environmentMatches = targetEnvironment?.toLowerCase() === "production" && context.channel.toLowerCase() === "production";
  const unexpired = Boolean(expiresAt && Date.parse(expiresAt) >= Date.parse(context.checkedAt));
  const timeBounded = evidence?.timeBoundedAccess === true || root?.timeBoundedAccess === true || Boolean(expiresAt);
  const exceptionRelease = productionExceptionReleaseIdentity(evidence, root);
  const exceptionDeployment = productionExceptionDeploymentIdentity(evidence, root);
  const releaseMatches = Boolean(
    context.release.commitRef &&
      context.release.repository &&
      context.release.branch &&
      exceptionRelease.commitRef === context.release.commitRef &&
      exceptionRelease.repository === context.release.repository &&
      exceptionRelease.branch === context.release.branch
  );
  const deploymentMatches = Boolean(context.deploymentId && exceptionDeployment.deploymentId === context.deploymentId);
  const projectMatches = Boolean(context.projectId && exceptionDeployment.projectId === context.projectId);
  const channelMatches = exceptionDeployment.channel?.toLowerCase() === context.channel.toLowerCase();
  const identityBound = releaseMatches && deploymentMatches && projectMatches && channelMatches;
  const passed = Boolean(root && accepted && environmentMatches && ticket && reason && approved && timeBounded && unexpired && identityBound);

  return {
    present: Boolean(root),
    passed,
    status: status ?? null,
    targetEnvironment: targetEnvironment ?? null,
    ticket: ticket ?? null,
    reason: reason ?? null,
    approved,
    timeBounded,
    expiresAt: expiresAt ?? null,
    unexpired,
    identityBound,
    releaseMatches,
    deploymentMatches,
    projectMatches,
    channelMatches,
    expectedRelease: {
      commitRef: context.release.commitRef ?? null,
      repository: context.release.repository ?? null,
      branch: context.release.branch ?? null
    },
    actualRelease: {
      commitRef: exceptionRelease.commitRef ?? null,
      repository: exceptionRelease.repository ?? null,
      branch: exceptionRelease.branch ?? null
    },
    expectedDeployment: {
      deploymentId: context.deploymentId ?? null,
      projectId: context.projectId ?? null,
      channel: context.channel
    },
    actualDeployment: {
      deploymentId: exceptionDeployment.deploymentId ?? null,
      projectId: exceptionDeployment.projectId ?? null,
      channel: exceptionDeployment.channel ?? null
    }
  };
}

function postPromotionAttachmentSecretFindings(
  deploymentDetail: unknown,
  options: ReleasePostPromotionEvidenceCheckOptions
) {
  const attachedEvidence: Record<string, unknown> = { deploymentDetail };

  if (options.readinessProbe !== undefined) {
    attachedEvidence.readinessProbe = options.readinessProbe;
  }

  if (options.metricsProbe !== undefined) {
    attachedEvidence.metricsProbe = options.metricsProbe;
  }

  if (options.productionExceptionEvidence !== undefined) {
    attachedEvidence.productionExceptionEvidence = options.productionExceptionEvidence;
  }

  if (options.productionBreakGlassEvidence !== undefined) {
    attachedEvidence.productionBreakGlassEvidence = options.productionBreakGlassEvidence;
  }

  return scanEvidenceForRawSecrets(attachedEvidence);
}

function artifactManifestMatches(rawEvidence: unknown, deploymentDetail: unknown) {
  const selected = releaseArtifactSelectedEvidence(rawEvidence);
  const manifest = deploymentArtifactManifest(deploymentDetail);
  const expectedFileCount = numberValue(selected?.fileCount);
  const expectedTotalBytes = numberValue(selected?.totalBytes);
  const expectedChecksum = checksumValue(selected?.checksum);
  const actualFileCount = numberValue(manifest?.fileCount);
  const actualTotalBytes = numberValue(manifest?.totalBytes);
  const actualChecksum = checksumValue(manifest?.checksum);

  return {
    expectedFileCount,
    expectedTotalBytes,
    expectedChecksum: expectedChecksum ?? null,
    actualFileCount,
    actualTotalBytes,
    actualChecksum: actualChecksum ?? null,
    passed:
      typeof expectedFileCount === "number" &&
      typeof expectedTotalBytes === "number" &&
      Boolean(expectedChecksum) &&
      actualFileCount === expectedFileCount &&
      actualTotalBytes === expectedTotalBytes &&
      actualChecksum === expectedChecksum
  };
}

export async function runReleasePostPromotionEvidenceCheck(
  options: ReleasePostPromotionEvidenceCheckOptions
): Promise<ReleasePostPromotionEvidenceCheckResult> {
  const channel = options.channel ?? "production";
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const rawEvidence = await readJsonFile(options.releaseEvidencePath);
  const bundleCheck = (options.evaluateBundle ?? evaluateReleaseEvidenceBundle)(rawEvidence, {
    evidencePath: options.releaseEvidencePath,
    targetEnvironment: channel,
    now: options.now
  });
  const deploymentDetail = await fetchDeploymentDetail(options);
  const routeRevision = deploymentRouteRevision(deploymentDetail);
  const releaseEvidence = deploymentReleaseEvidence(deploymentDetail);
  const release = releaseIdentity(rawEvidence, bundleCheck);
  const deploymentId = stringValue(nestedValue(deploymentDetail, ["deployment", "id"]));
  const projectId = stringValue(nestedValue(deploymentDetail, ["project", "id"]));
  const deploymentStatus = stringValue(nestedValue(deploymentDetail, ["deployment", "status"]));
  const deploymentEnvironment = stringValue(nestedValue(deploymentDetail, ["deployment", "environment"]));
  const routeDeploymentId = stringValue(routeRevision?.deploymentId);
  const routeChannel = stringValue(routeRevision?.channel);
  const routeStatus = stringValue(routeRevision?.status);
  const releaseEvidenceCheckedAt = timestampValue(nestedValue(rawEvidence, ["checkedAt"]));
  const routeReleaseEvidenceCheckedAt = timestampValue(releaseEvidence?.checkedAt);
  const bundlePayloadDigest = stringValue(bundleCheck.payloadDigest);
  const routeReleaseEvidencePayloadDigest = stringValue(releaseEvidence?.payloadDigest);
  const readiness = options.readinessProbe !== undefined ? probeStatus(options.readinessProbe, "readiness", new Date(checkedAt)) : undefined;
  const metrics = options.metricsProbe !== undefined ? probeStatus(options.metricsProbe, "metrics", new Date(checkedAt)) : undefined;
  const attachmentSecretFindings = postPromotionAttachmentSecretFindings(deploymentDetail, options);
  const productionProbeException = productionProbeExceptionStatus(options.productionExceptionEvidence ?? options.productionBreakGlassEvidence, {
    channel,
    checkedAt,
    release,
    deploymentId,
    projectId
  });
  const isProduction = channel.toLowerCase() === "production";
  const productionProbeExceptionApplies = isProduction && productionProbeException.passed;
  const expectedRouteEvidencePath = options.expectedEvidencePath ?? (isProduction ? options.releaseEvidencePath : undefined);
  const artifactManifest = artifactManifestMatches(rawEvidence, deploymentDetail);
  const functionRuntimeIsolation = deploymentFunctionRuntimeIsolationSummary(deploymentDetail);
  const checks: ReleasePostPromotionEvidenceCheck[] = [
    check(
      "release_evidence_bundle_passed",
      bundleCheck.status === "passed",
      "Release evidence bundle still passes the final release:evidence checker.",
      "Release evidence bundle no longer passes the final release:evidence checker.",
      { failedChecks: bundleCheck.checks.filter((entry) => entry.status !== "pass").map((entry) => entry.name) }
    ),
    check(
      "post_promotion_attached_evidence_no_raw_secrets",
      attachmentSecretFindings.length === 0,
      "Post-promotion deployment detail, readiness, metrics, and exception evidence do not include raw secret-like values.",
      attachmentSecretFindings.length === 0
        ? "Post-promotion attached evidence must not include raw secret-like values."
        : `Post-promotion attached evidence includes raw secret-like values: ${evidenceSecretFindingSummary(attachmentSecretFindings)}.`,
      {
        findingCount: attachmentSecretFindings.length,
        findings: evidenceSecretFindingSummary(attachmentSecretFindings)
      }
    ),
    check(
      "deployment_identity",
      Boolean(deploymentId && (!options.deploymentId || deploymentId === options.deploymentId)),
      "Deployment detail identifies the expected deployment.",
      "Deployment detail is missing or does not match the expected deployment id.",
      { expectedDeploymentId: options.deploymentId ?? null, actualDeploymentId: deploymentId ?? null }
    ),
    check(
      "project_identity",
      Boolean(projectId && (!options.projectId || projectId === options.projectId)),
      "Deployment detail identifies the expected project.",
      "Deployment detail is missing or does not match the expected project id.",
      { expectedProjectId: options.projectId ?? null, actualProjectId: projectId ?? null }
    ),
    check(
      "deployment_ready",
      deploymentStatus === "ready",
      "Deployment is ready.",
      "Deployment is not ready.",
      { deploymentStatus: deploymentStatus ?? null }
    ),
    check(
      "deployment_channel",
      deploymentEnvironment === channel,
      "Deployment environment matches the promoted channel.",
      "Deployment environment does not match the promoted channel.",
      { expectedChannel: channel, actualEnvironment: deploymentEnvironment ?? null }
    ),
    check(
      "route_revision_present",
      Boolean(routeRevision),
      "Deployment detail includes the route revision that served the promotion.",
      "Deployment detail does not include a route revision."
    ),
    check(
      "route_revision_applied",
      routeStatus === "applied",
      "Route revision is applied.",
      "Route revision is not applied.",
      { routeStatus: routeStatus ?? null }
    ),
    check(
      "route_targets_deployment",
      Boolean(routeDeploymentId && deploymentId && routeDeploymentId === deploymentId),
      "Route revision targets the inspected deployment.",
      "Route revision does not target the inspected deployment.",
      { routeDeploymentId: routeDeploymentId ?? null, deploymentId: deploymentId ?? null }
    ),
    check(
      "route_channel",
      routeChannel === channel,
      "Route revision channel matches the promoted channel.",
      "Route revision channel does not match the promoted channel.",
      { expectedChannel: channel, actualChannel: routeChannel ?? null }
    ),
    check(
      "route_release_evidence_present",
      Boolean(releaseEvidence),
      "Route revision stores release evidence metadata.",
      "Route revision does not store release evidence metadata."
    ),
    check(
      "route_release_evidence_status",
      stringValue(releaseEvidence?.status) === "passed",
      "Route release evidence metadata records a passed bundle.",
      "Route release evidence metadata does not record a passed bundle.",
      { status: stringValue(releaseEvidence?.status) ?? null }
    ),
    check(
      "route_release_evidence_timestamp",
      Boolean(
        routeReleaseEvidenceCheckedAt &&
          timestampNotAfter(releaseEvidenceCheckedAt, routeReleaseEvidenceCheckedAt) &&
          timestampNotAfter(routeReleaseEvidenceCheckedAt, checkedAt)
      ),
      "Route release evidence metadata records a bounded checkedAt timestamp.",
      "Route release evidence metadata must include an ISO checkedAt timestamp after the release bundle check and not in the future.",
      {
        releaseEvidenceCheckedAt: releaseEvidenceCheckedAt ?? null,
        routeReleaseEvidenceCheckedAt: routeReleaseEvidenceCheckedAt ?? null,
        checkedAt
      }
    ),
    check(
      "route_release_evidence_identity",
      Boolean(
        releaseEvidence &&
          stringValue(releaseEvidence.commitRef) === release.commitRef &&
          stringValue(releaseEvidence.repository) === release.repository &&
          stringValue(releaseEvidence.branch) === release.branch &&
          stringValue(releaseEvidence.targetEnvironment) === release.targetEnvironment
      ),
      "Route release evidence identity matches the release bundle.",
      "Route release evidence identity does not match the release bundle.",
      {
        expected: release,
        actual: {
          commitRef: stringValue(releaseEvidence?.commitRef) ?? null,
          repository: stringValue(releaseEvidence?.repository) ?? null,
          branch: stringValue(releaseEvidence?.branch) ?? null,
          targetEnvironment: stringValue(releaseEvidence?.targetEnvironment) ?? null
        }
      }
    ),
    check(
      "route_release_evidence_path",
      Boolean(
        stringValue(releaseEvidence?.evidencePath) &&
          (!expectedRouteEvidencePath || stringValue(releaseEvidence?.evidencePath) === expectedRouteEvidencePath)
      ),
      "Route release evidence metadata records the expected evidence path.",
      "Route release evidence metadata is missing or has the wrong evidence path.",
      {
        expectedEvidencePath: expectedRouteEvidencePath ?? null,
        actualEvidencePath: stringValue(releaseEvidence?.evidencePath) ?? null
      }
    ),
    check(
      "route_release_evidence_payload_digest",
      Boolean(bundlePayloadDigest && routeReleaseEvidencePayloadDigest && routeReleaseEvidencePayloadDigest === bundlePayloadDigest),
      "Route release evidence metadata records the checked bundle payload digest.",
      "Route release evidence metadata must include the checked bundle payloadDigest.",
      {
        expectedPayloadDigest: bundlePayloadDigest ?? null,
        actualPayloadDigest: routeReleaseEvidencePayloadDigest ?? null
      }
    ),
    check(
      "artifact_manifest_matches_release_evidence",
      artifactManifest.passed,
      "Deployment artifact manifest file count, byte count, and checksum match release artifact evidence.",
      "Deployment artifact manifest does not match release artifact evidence file count, byte count, and checksum.",
      artifactManifest
    ),
    check(
      "artifact_function_runtime_isolation",
      functionRuntimeIsolation.passed,
      "Deployment artifact functions do not require same-process runtime isolation.",
      "Deployment artifact functions must declare isolated runtime isolation; missing, unknown, or same_process runtime isolation is blocked.",
      functionRuntimeIsolation
    )
  ];

  if (isProduction) {
    checks.push(
      check(
        "production_readiness_probe_required",
        Boolean(readiness) || productionProbeExceptionApplies,
        "Production post-promotion evidence includes readiness probe evidence or an accepted production exception.",
        "Production post-promotion evidence must include readiness probe evidence unless accepted production break-glass/exception evidence is provided.",
        {
          readinessProbePresent: Boolean(readiness),
          productionExceptionAccepted: productionProbeExceptionApplies
        }
      ),
      check(
        "production_metrics_probe_required",
        Boolean(metrics) || productionProbeExceptionApplies,
        "Production post-promotion evidence includes metrics probe evidence or an accepted production exception.",
        "Production post-promotion evidence must include metrics probe evidence unless accepted production break-glass/exception evidence is provided.",
        {
          metricsProbePresent: Boolean(metrics),
          productionExceptionAccepted: productionProbeExceptionApplies
        }
      )
    );
  }

  if (readiness) {
    checks.push(check(
      "readiness_probe_passed",
      readiness.passed || productionProbeExceptionApplies,
      productionProbeExceptionApplies
        ? "Readiness probe evidence is covered by an accepted production exception."
        : "Readiness probe evidence is passing.",
      "Readiness probe evidence must target /readyz, return HTTP 200, and include a fresh ISO timestamp.",
      readiness
    ));
  }

  if (metrics) {
    checks.push(check(
      "metrics_probe_passed",
      metrics.passed || productionProbeExceptionApplies,
      productionProbeExceptionApplies
        ? "Metrics probe evidence is covered by an accepted production exception."
        : "Metrics probe evidence is passing.",
      "Metrics probe evidence must target /metrics, return HTTP 200, 401, or 403, and include a fresh ISO timestamp.",
      metrics
    ));
  }

  if (
    isProduction &&
    (
      productionProbeException.present ||
        !readiness ||
        !metrics ||
        !readiness.passed ||
        !metrics.passed
    )
  ) {
    checks.push(check(
      "production_probe_exception",
      productionProbeException.passed,
      "Production break-glass/exception evidence explicitly waives missing or failing post-promotion probes.",
      "Production break-glass/exception evidence must be production-scoped, accepted, ticketed, reasoned, approved, time-bounded, unexpired, and bound to the release and deployment identity.",
      productionProbeException
    ));
  }

  const passed = checks.every((entry) => entry.status === "pass");

  return {
    name: "siteflow-release-post-promotion-evidence-check",
    status: passed ? "passed" : "blocked",
    checkedAt,
    releaseEvidencePath: options.releaseEvidencePath,
    selectedEvidence: {
      deploymentId: deploymentId ?? null,
      projectId: projectId ?? null,
      channel,
      releaseCommitRef: release.commitRef ?? null,
      repository: release.repository ?? null,
      branch: release.branch ?? null,
      targetEnvironment: release.targetEnvironment ?? null,
      routeRevisionId: stringValue(routeRevision?.id) ?? null,
      routeEvidenceStatus: stringValue(releaseEvidence?.status) ?? null,
      routeEvidenceCheckedAt: routeReleaseEvidenceCheckedAt ?? null,
      routeEvidencePayloadDigest: routeReleaseEvidencePayloadDigest ?? null
    },
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

export function parseReleasePostPromotionEvidenceCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--release-evidence") {
      parsed.releaseEvidencePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deployment-detail") {
      parsed.deploymentDetailPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--server") {
      parsed.serverUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--token") {
      parsed.apiToken = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deployment") {
      parsed.deploymentId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--project" || arg === "--project-id") {
      parsed.projectId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--channel") {
      parsed.channel = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--expected-evidence-path") {
      parsed.expectedEvidencePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--readiness") {
      parsed.readinessPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--metrics") {
      parsed.metricsPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--production-exception" || arg === "--break-glass" || arg === "--break-glass-evidence") {
      parsed.productionExceptionPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function releasePostPromotionEvidenceCheckUsage() {
  return [
    "Usage: npm run --silent release:evidence:post-promote -- --release-evidence <release-evidence.json> (--deployment-detail <deployment-detail.json> | --server <url> --deployment <id>) [options]",
    "",
    "Options:",
    "  --release-evidence <file>       Final release evidence bundle JSON.",
    "  --deployment-detail <file>      Deployment detail JSON from siteflow deployments inspect --json.",
    "  --server <url>                  SiteFlow API base URL used to fetch deployment detail.",
    "  --token <token>                 API token for --server.",
    "  --deployment <id>               Deployment id to fetch or verify.",
    "  --project, --project-id <id>    Expected project id.",
    "  --channel <name>                Expected channel. Default: production.",
    "  --expected-evidence-path <path> Expected release evidence path recorded on the route.",
    "  --readiness <file>              Readiness probe JSON with endpoint/path /readyz, statusCode 200, and checkedAt/timestamp. Required for production unless waived.",
    "  --metrics <file>                Metrics probe JSON with endpoint/path /metrics, statusCode 200/401/403, and checkedAt/timestamp. Required for production unless waived.",
    "  --production-exception <file>   Production break-glass/exception JSON waiving missing or failing probes.",
    "  --json                         Emit a single JSON result.",
    "  --help                         Show this help."
  ].join("\n");
}

function writeHumanResult(result: ReleasePostPromotionEvidenceCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow post-promotion evidence status: ${result.status}\n`);
  output.write(`Deployment: ${result.selectedEvidence.deploymentId ?? "unknown"}\n`);
  output.write(`Release: ${result.selectedEvidence.repository ?? "unknown"}@${result.selectedEvidence.branch ?? "unknown"}@${result.selectedEvidence.releaseCommitRef ?? "unknown"}\n`);
  output.write("Checks:\n");

  for (const entry of result.checks) {
    output.write(`- ${entry.name}: ${entry.status} - ${entry.message}\n`);
  }
}

export async function runReleasePostPromotionEvidenceCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleasePostPromotionEvidenceCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleasePostPromotionEvidenceCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releasePostPromotionEvidenceCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releasePostPromotionEvidenceCheckUsage()}\n`);
    return 0;
  }

  if (!parsed.releaseEvidencePath) {
    io.stderr.write(`--release-evidence is required.\n\n${releasePostPromotionEvidenceCheckUsage()}\n`);
    return 2;
  }

  try {
    const result = await runReleasePostPromotionEvidenceCheck({
      ...baseOptions,
      releaseEvidencePath: parsed.releaseEvidencePath,
      deploymentDetailPath: parsed.deploymentDetailPath,
      serverUrl: parsed.serverUrl,
      apiToken: parsed.apiToken,
      deploymentId: parsed.deploymentId,
      projectId: parsed.projectId,
      channel: parsed.channel,
      expectedEvidencePath: parsed.expectedEvidencePath,
      readinessProbe: parsed.readinessPath ? await readJsonFile(parsed.readinessPath) : baseOptions.readinessProbe,
      metricsProbe: parsed.metricsPath ? await readJsonFile(parsed.metricsPath) : baseOptions.metricsProbe,
      productionExceptionEvidence: parsed.productionExceptionPath
        ? await readJsonFile(parsed.productionExceptionPath)
        : baseOptions.productionExceptionEvidence,
      productionBreakGlassEvidence: baseOptions.productionBreakGlassEvidence
    });

    if (parsed.json) {
      const output = result.status === "passed" ? io.stdout : io.stderr;
      output.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  } catch (error) {
    const result: ReleasePostPromotionEvidenceCheckResult = {
      name: "siteflow-release-post-promotion-evidence-check",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      releaseEvidencePath: parsed.releaseEvidencePath,
      selectedEvidence: {
        deploymentId: parsed.deploymentId ?? null,
        projectId: parsed.projectId ?? null,
        channel: parsed.channel ?? "production",
        releaseCommitRef: null,
        repository: null,
        branch: null,
        targetEnvironment: null,
        routeRevisionId: null,
        routeEvidenceStatus: null,
        routeEvidenceCheckedAt: null,
        routeEvidencePayloadDigest: null
      },
      checks: [
        {
          name: "post_promotion_inputs",
          status: "fail",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      exitCode: 1
    };

    if (parsed.json) {
      io.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeHumanResult(result, io);
    }

    return result.exitCode;
  }
}

if (isEntrypoint()) {
  runReleasePostPromotionEvidenceCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
