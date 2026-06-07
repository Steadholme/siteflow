import type {
  ArtifactVerificationStatus,
  BuildJobStatus,
  CdnOperation,
  CdnOperationState,
  DeploymentStatus,
  RouteRevisionStatus
} from "@domain/siteflow";
import type { DeploymentDetailReadModel } from "@domain/readModels";
import type { StatusTone } from "@components/ui/StatusPill";

export type EvidenceStatus = "pass" | "warning" | "fail" | "pending" | "skipped" | "stale";

export function formatDateTime(value?: string) {
  if (!value) {
    return "Not recorded";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatBytes(bytes: number) {
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDuration(start?: string, end?: string) {
  if (!start || !end) {
    return "in progress";
  }

  const milliseconds = new Date(end).getTime() - new Date(start).getTime();

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "under 1s";
  }

  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function shortenSha(value: string, length = 8) {
  return value.length > length ? value.slice(0, length) : value;
}

export function deploymentStatusLabel(status: DeploymentStatus) {
  const labels: Record<DeploymentStatus, string> = {
    queued: "Deployment queued",
    building: "Deployment building",
    ready: "Deployment ready",
    failed: "Deployment failed",
    canceled: "Deployment canceled"
  };

  return labels[status];
}

export function buildJobStatusLabel(status: BuildJobStatus) {
  const labels: Record<BuildJobStatus, string> = {
    queued: "Build queued",
    running: "Build running",
    succeeded: "Build succeeded",
    failed: "Build failed",
    canceled: "Build canceled",
    timed_out: "Build timed out",
    skipped: "Build skipped"
  };

  return labels[status];
}

export function artifactVerificationLabel(status: ArtifactVerificationStatus) {
  const labels: Record<ArtifactVerificationStatus, string> = {
    pending: "Artifact pending",
    verified: "Artifact verified",
    failed: "Artifact failed"
  };

  return labels[status];
}

export function routeRevisionStatusLabel(status?: RouteRevisionStatus) {
  if (!status) {
    return "Route not planned";
  }

  const labels: Record<RouteRevisionStatus, string> = {
    planned: "Route planned",
    validating: "Route validating",
    pending_apply: "Route pending apply",
    applied: "Route applied",
    failed: "Route failed",
    drifted: "Route drift",
    superseded: "Route superseded"
  };

  return labels[status];
}

export function cdnOperationStateLabel(state?: CdnOperationState) {
  if (!state) {
    return "CDN not requested";
  }

  const labels: Record<CdnOperationState, string> = {
    disabled: "CDN disabled",
    queued: "CDN queued",
    purging: "CDN purge running",
    succeeded: "CDN synced",
    failed: "CDN failed",
    skipped: "CDN skipped"
  };

  return labels[state];
}

export function deploymentStatusTone(status: DeploymentStatus): StatusTone {
  if (status === "ready") {
    return "success";
  }

  if (status === "failed" || status === "canceled") {
    return "error";
  }

  return status === "building" ? "info" : "warning";
}

export function buildJobStatusTone(status: BuildJobStatus): StatusTone {
  if (status === "succeeded" || status === "skipped") {
    return "success";
  }

  if (status === "failed" || status === "canceled" || status === "timed_out") {
    return "error";
  }

  return status === "running" ? "info" : "warning";
}

export function artifactVerificationTone(status: ArtifactVerificationStatus): StatusTone {
  if (status === "verified") {
    return "success";
  }

  return status === "failed" ? "error" : "warning";
}

export function routeRevisionStatusTone(status?: RouteRevisionStatus): StatusTone {
  if (status === "applied") {
    return "success";
  }

  if (status === "failed" || status === "drifted") {
    return "error";
  }

  return status === "validating" || status === "pending_apply" ? "warning" : "info";
}

export function cdnOperationStateTone(state?: CdnOperationState): StatusTone {
  if (state === "succeeded" || state === "disabled" || state === "skipped") {
    return "success";
  }

  if (state === "failed") {
    return "error";
  }

  return state === "purging" ? "info" : "warning";
}

export function evidenceStatusLabel(status: EvidenceStatus) {
  return status === "fail" ? "failed" : status;
}

export function evidenceStatusTone(status: EvidenceStatus): StatusTone {
  if (status === "pass" || status === "skipped") {
    return "success";
  }

  if (status === "fail") {
    return "error";
  }

  return status === "pending" ? "info" : "warning";
}

export function latestDeploymentTimestamp(detail: DeploymentDetailReadModel) {
  const cdnOperation = cdnOperationFromDetail(detail);
  const timestamps = [
    detail.deployment.readyAt,
    detail.deployment.createdAt,
    detail.lineage.buildJob.finishedAt,
    detail.lineage.buildJob.startedAt,
    detail.lineage.artifact.verifiedAt,
    detail.lineage.routeRevision?.appliedAt,
    detail.lineage.routeRevision?.createdAt,
    cdnOperation?.finishedAt,
    cdnOperation?.requestedAt,
    detail.logs.chunk.fetchedAt
  ].filter((value): value is string => Boolean(value));

  return timestamps.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
}

function isCdnOperation(value: unknown): value is CdnOperation {
  return Boolean(value && typeof value === "object" && "state" in value && "requestedAt" in value);
}

export function cdnOperationFromDetail(detail: DeploymentDetailReadModel) {
  if (isCdnOperation(detail.lineage.cdnOperation)) {
    return detail.lineage.cdnOperation;
  }

  if (isCdnOperation(detail.lineage.routeRevision?.cdnOperation)) {
    return detail.lineage.routeRevision.cdnOperation;
  }

  return undefined;
}

export function pollingBoundaryCopy(detail: DeploymentDetailReadModel) {
  const activeBoundaries: string[] = [];
  const buildStatus = detail.lineage.buildJob.status;
  const routeStatus = detail.lineage.routeRevision?.status;
  const cdnState = cdnOperationFromDetail(detail)?.state;

  if (buildStatus === "queued" || buildStatus === "running") {
    activeBoundaries.push("build");
  }

  if (routeStatus === "planned" || routeStatus === "validating" || routeStatus === "pending_apply") {
    activeBoundaries.push("route");
  }

  if (cdnState === "queued" || cdnState === "purging") {
    activeBoundaries.push("CDN");
  }

  if (detail.logs.hasMore || !detail.logs.chunk.complete) {
    activeBoundaries.push("logs");
  }

  if (routeStatus === "drifted") {
    return "Stale route evidence: route drift was detected after the last applied revision.";
  }

  if (activeBoundaries.length > 0) {
    return `Polling active ${activeBoundaries.join(", ")} updates separately from deployment status.`;
  }

  return "Snapshot settled: build, artifact, route, CDN, and log streams are terminal.";
}
