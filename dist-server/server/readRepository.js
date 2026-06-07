export class SiteFlowNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = "SiteFlowNotFoundError";
    }
}
export function assertReleaseChannel(value) {
    if (value !== "production" && value !== "staging" && value !== "preview") {
        throw new Error(`Invalid release channel: ${value}`);
    }
}
export function releaseConsoleKey(projectId, channel) {
    return `${projectId}:${channel}`;
}
export function logChunkKey(deploymentId, cursor) {
    return `${deploymentId}:${cursor ?? "default"}`;
}
