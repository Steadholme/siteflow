import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { DeploymentSummaryReadModel, RouteRevisionEvidenceReadModel } from "@domain/readModels";

interface DeploymentComparisonProps {
  currentDeployment?: DeploymentSummaryReadModel;
  targetDeployment?: DeploymentSummaryReadModel;
  routePreview?: RouteRevisionEvidenceReadModel;
}

function artifactProtected(deployment?: DeploymentSummaryReadModel) {
  return deployment?.artifactVerificationStatus === "verified";
}

export function DeploymentComparison({ currentDeployment, targetDeployment, routePreview }: DeploymentComparisonProps) {
  const protectedArtifact = artifactProtected(targetDeployment);

  return (
    <Panel title="Rollback impact" eyebrow="Current vs selected">
      <div className="release-comparison">
        <div className="release-comparison__item">
          <span className="release-label">Current channel deployment</span>
          <strong className="release-mono" title={currentDeployment?.id}>
            {currentDeployment?.id ?? "No current deployment"}
          </strong>
          <p className="release-muted">{currentDeployment?.version ?? "No current version"}</p>
        </div>
        <div className="release-comparison__item">
          <span className="release-label">Selected rollback target</span>
          <strong className="release-mono" title={targetDeployment?.id}>
            {targetDeployment?.id ?? "No target selected"}
          </strong>
          <p className="release-muted">{targetDeployment?.version ?? "Select a protected deployment"}</p>
        </div>
        <div className="release-comparison__item">
          <span className="release-label">Artifact protection</span>
          <StatusPill tone={protectedArtifact ? "success" : "error"}>{protectedArtifact ? "active" : "blocked"}</StatusPill>
          <p className="release-muted">Rollback uses retained immutable artifact bytes.</p>
        </div>
        <div className="release-comparison__item">
          <span className="release-label">Rebuild required</span>
          <StatusPill tone="success">no</StatusPill>
          <p className="release-muted">No source rebuild is required for a release channel pointer rollback.</p>
        </div>
        <div className="release-comparison__item release-comparison__item--wide">
          <span className="release-label">Route consequence</span>
          <strong>
            {routePreview
              ? `Generate ${routePreview.routeRevision.id} for ${targetDeployment?.id ?? "selected target"} and preserve previous known-good route.`
              : "Generate a new route revision after rollback eligibility passes."}
          </strong>
        </div>
      </div>
    </Panel>
  );
}
