import { isArtifactVerified, isCdnOperationSatisfied, isCdnOperationTerminal, isDeploymentReady, isRouteRevisionApplied, isRouteRevisionAttention, summarizeDeliveryState } from "@domain/status";
describe("status helpers", () => {
    it("keeps deployment, artifact verification, route revision, and CDN states distinct", () => {
        const summary = summarizeDeliveryState({
            deploymentStatus: "ready",
            artifactVerificationStatus: "verified",
            routeRevisionStatus: "pending_apply",
            cdnOperationState: "succeeded"
        });
        expect(summary.deploymentReady).toBe(true);
        expect(summary.artifactVerified).toBe(true);
        expect(summary.routeApplied).toBe(false);
        expect(summary.cdnSatisfied).toBe(true);
        expect(summary.trafficReady).toBe(false);
    });
    it("treats disabled CDN as terminal without implying route success", () => {
        const summary = summarizeDeliveryState({
            deploymentStatus: "ready",
            artifactVerificationStatus: "verified",
            routeRevisionStatus: "drifted",
            cdnOperationState: "disabled"
        });
        expect(isDeploymentReady(summary.deploymentStatus)).toBe(true);
        expect(isArtifactVerified(summary.artifactVerificationStatus)).toBe(true);
        expect(isRouteRevisionApplied(summary.routeRevisionStatus)).toBe(false);
        expect(isRouteRevisionAttention(summary.routeRevisionStatus)).toBe(true);
        expect(isCdnOperationTerminal(summary.cdnOperationState)).toBe(true);
        expect(isCdnOperationSatisfied(summary.cdnOperationState)).toBe(true);
        expect(summary.trafficReady).toBe(false);
    });
});
