import type {
  ArtifactVerificationStatus,
  CdnOperationState,
  DeploymentStatus,
  RouteRevisionStatus
} from "@domain/siteflow";

export const deploymentTerminalStatuses = ["ready", "failed", "canceled"] as const satisfies readonly DeploymentStatus[];
export const artifactVerificationTerminalStatuses = ["verified", "failed"] as const satisfies readonly ArtifactVerificationStatus[];
export const routeRevisionTerminalStatuses = ["applied", "failed", "drifted", "superseded"] as const satisfies readonly RouteRevisionStatus[];
export const cdnOperationTerminalStates = ["disabled", "succeeded", "failed", "skipped"] as const satisfies readonly CdnOperationState[];

export interface DeliveryStateSnapshot {
  deploymentStatus: DeploymentStatus;
  artifactVerificationStatus: ArtifactVerificationStatus;
  routeRevisionStatus: RouteRevisionStatus;
  cdnOperationState: CdnOperationState;
}

export interface DeliveryStateSummary extends DeliveryStateSnapshot {
  deploymentTerminal: boolean;
  artifactTerminal: boolean;
  routeTerminal: boolean;
  cdnTerminal: boolean;
  deploymentReady: boolean;
  artifactVerified: boolean;
  routeApplied: boolean;
  cdnSatisfied: boolean;
  trafficReady: boolean;
}

function hasStatus<T extends string>(statuses: readonly T[], status: T) {
  return statuses.includes(status);
}

export function isDeploymentTerminal(status: DeploymentStatus) {
  return hasStatus(deploymentTerminalStatuses, status);
}

export function isDeploymentReady(status: DeploymentStatus) {
  return status === "ready";
}

export function isArtifactVerificationTerminal(status: ArtifactVerificationStatus) {
  return hasStatus(artifactVerificationTerminalStatuses, status);
}

export function isArtifactVerified(status: ArtifactVerificationStatus) {
  return status === "verified";
}

export function isRouteRevisionTerminal(status: RouteRevisionStatus) {
  return hasStatus(routeRevisionTerminalStatuses, status);
}

export function isRouteRevisionApplied(status: RouteRevisionStatus) {
  return status === "applied";
}

export function isRouteRevisionAttention(status: RouteRevisionStatus) {
  return status === "failed" || status === "drifted";
}

export function isCdnOperationTerminal(state: CdnOperationState) {
  return hasStatus(cdnOperationTerminalStates, state);
}

export function isCdnOperationSatisfied(state: CdnOperationState) {
  return state === "succeeded" || state === "skipped" || state === "disabled";
}

export function summarizeDeliveryState(snapshot: DeliveryStateSnapshot): DeliveryStateSummary {
  const deploymentReady = isDeploymentReady(snapshot.deploymentStatus);
  const artifactVerified = isArtifactVerified(snapshot.artifactVerificationStatus);
  const routeApplied = isRouteRevisionApplied(snapshot.routeRevisionStatus);
  const cdnSatisfied = isCdnOperationSatisfied(snapshot.cdnOperationState);

  return {
    ...snapshot,
    deploymentTerminal: isDeploymentTerminal(snapshot.deploymentStatus),
    artifactTerminal: isArtifactVerificationTerminal(snapshot.artifactVerificationStatus),
    routeTerminal: isRouteRevisionTerminal(snapshot.routeRevisionStatus),
    cdnTerminal: isCdnOperationTerminal(snapshot.cdnOperationState),
    deploymentReady,
    artifactVerified,
    routeApplied,
    cdnSatisfied,
    trafficReady: deploymentReady && artifactVerified && routeApplied && cdnSatisfied
  };
}
