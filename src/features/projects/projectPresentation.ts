import type {
  ArtifactVerificationStatus,
  CdnOperationState,
  DeploymentStatus,
  ProjectStatus,
  RouteRevisionStatus
} from "@domain/siteflow";
import type { DeploymentSummaryReadModel } from "@domain/readModels";
import type { StatusTone } from "@components/ui/StatusPill";

export interface StatusDescriptor {
  label: string;
  tone: StatusTone;
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

export function formatDateTime(value?: string) {
  if (!value) {
    return "Not recorded";
  }

  return dateTimeFormatter.format(new Date(value));
}

export function shortCommit(commitSha?: string) {
  return commitSha ? commitSha.slice(0, 8) : "unknown";
}

export function compactId(id?: string) {
  if (!id) {
    return "none";
  }

  if (id.length <= 18) {
    return id;
  }

  return `${id.slice(0, 12)}...${id.slice(-4)}`;
}

export function formatBytes(bytes: number) {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function humanizeStatus(value: string | undefined) {
  if (!value) {
    return "Unknown";
  }

  return value
    .replace(/\./g, " ")
    .split("_")
    .flatMap((part) => part.split(" "))
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function isDeploymentSummary(value: unknown): value is DeploymentSummaryReadModel {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as DeploymentSummaryReadModel).id === "string" &&
    typeof (value as DeploymentSummaryReadModel).status === "string" &&
    typeof (value as DeploymentSummaryReadModel).artifactVerificationStatus === "string" &&
    typeof (value as DeploymentSummaryReadModel).routeRevisionStatus === "string"
  );
}

export function projectStatusDescriptor(status: ProjectStatus): StatusDescriptor {
  if (status === "active") {
    return { label: "Active", tone: "success" };
  }

  if (status === "paused") {
    return { label: "Paused", tone: "warning" };
  }

  return { label: "Archived", tone: "info" };
}

export function deploymentStatusDescriptor(status: DeploymentStatus): StatusDescriptor {
  switch (status) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "queued":
      return { label: "Build queued", tone: "warning" };
    case "building":
      return { label: "Building", tone: "info" };
    case "failed":
      return { label: "Build failed", tone: "error" };
    case "canceled":
      return { label: "Canceled", tone: "warning" };
    default:
      return { label: humanizeStatus(status), tone: "info" };
  }
}

export function artifactStatusDescriptor(status: ArtifactVerificationStatus): StatusDescriptor {
  if (status === "verified") {
    return { label: "Verified", tone: "success" };
  }

  if (status === "pending") {
    return { label: "Verification pending", tone: "info" };
  }

  return { label: "Verification failed", tone: "error" };
}

export function routeStatusDescriptor(status: RouteRevisionStatus): StatusDescriptor {
  switch (status) {
    case "applied":
      return { label: "Routed", tone: "success" };
    case "drifted":
      return { label: "Route drift", tone: "warning" };
    case "failed":
      return { label: "Route failed", tone: "error" };
    case "validating":
      return { label: "Validating", tone: "info" };
    case "pending_apply":
      return { label: "Pending apply", tone: "warning" };
    case "planned":
      return { label: "Route planned", tone: "info" };
    case "superseded":
      return { label: "Superseded", tone: "info" };
    default:
      return { label: humanizeStatus(status), tone: "info" };
  }
}

export function cdnStatusDescriptor(status: CdnOperationState): StatusDescriptor {
  switch (status) {
    case "succeeded":
      return { label: "CDN purged", tone: "success" };
    case "disabled":
      return { label: "CDN disabled", tone: "info" };
    case "skipped":
      return { label: "CDN skipped", tone: "info" };
    case "failed":
      return { label: "CDN failed", tone: "error" };
    case "queued":
      return { label: "CDN queued", tone: "warning" };
    case "purging":
      return { label: "CDN purging", tone: "info" };
    default:
      return { label: humanizeStatus(status), tone: "info" };
  }
}

export function trafficStatusDescriptor(deployment?: DeploymentSummaryReadModel): StatusDescriptor {
  if (!deployment) {
    return { label: "No deployment", tone: "info" };
  }

  if (deployment.status !== "ready") {
    return deploymentStatusDescriptor(deployment.status);
  }

  if (deployment.artifactVerificationStatus !== "verified") {
    return artifactStatusDescriptor(deployment.artifactVerificationStatus);
  }

  if (deployment.routeRevisionStatus !== "applied") {
    return routeStatusDescriptor(deployment.routeRevisionStatus);
  }

  if (deployment.cdnOperationState === "failed") {
    return cdnStatusDescriptor(deployment.cdnOperationState);
  }

  return { label: "Healthy", tone: "success" };
}

export function deploymentHistoryStatus(deployment: DeploymentSummaryReadModel): StatusDescriptor {
  if (deployment.status !== "ready") {
    return deploymentStatusDescriptor(deployment.status);
  }

  if (deployment.routeRevisionStatus === "applied") {
    return routeStatusDescriptor(deployment.routeRevisionStatus);
  }

  return artifactStatusDescriptor(deployment.artifactVerificationStatus);
}
