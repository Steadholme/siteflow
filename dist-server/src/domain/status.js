export const deploymentTerminalStatuses = ["ready", "failed", "canceled"];
export const artifactVerificationTerminalStatuses = ["verified", "failed"];
export const routeRevisionTerminalStatuses = ["applied", "failed", "drifted", "superseded"];
export const cdnOperationTerminalStates = ["disabled", "succeeded", "failed", "skipped"];
function hasStatus(statuses, status) {
    return statuses.includes(status);
}
export function isDeploymentTerminal(status) {
    return hasStatus(deploymentTerminalStatuses, status);
}
export function isDeploymentReady(status) {
    return status === "ready";
}
export function isArtifactVerificationTerminal(status) {
    return hasStatus(artifactVerificationTerminalStatuses, status);
}
export function isArtifactVerified(status) {
    return status === "verified";
}
export function isRouteRevisionTerminal(status) {
    return hasStatus(routeRevisionTerminalStatuses, status);
}
export function isRouteRevisionApplied(status) {
    return status === "applied";
}
export function isRouteRevisionAttention(status) {
    return status === "failed" || status === "drifted";
}
export function isCdnOperationTerminal(state) {
    return hasStatus(cdnOperationTerminalStates, state);
}
export function isCdnOperationSatisfied(state) {
    return state === "succeeded" || state === "skipped" || state === "disabled";
}
export function summarizeDeliveryState(snapshot) {
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
