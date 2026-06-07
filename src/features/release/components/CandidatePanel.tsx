import { Panel } from "@components/ui/Panel";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";
import type { ReleaseChannelName } from "@domain/siteflow";
import type { DeploymentSummaryReadModel } from "@domain/readModels";

interface CandidatePanelProps {
  channel: ReleaseChannelName;
  currentDeployment?: DeploymentSummaryReadModel;
  candidateDeployment?: DeploymentSummaryReadModel;
}

function deploymentTone(deployment?: DeploymentSummaryReadModel): StatusTone {
  if (!deployment) {
    return "warning";
  }

  if (deployment.status === "ready" && deployment.artifactVerificationStatus === "verified") {
    return "success";
  }

  if (deployment.status === "failed" || deployment.status === "canceled" || deployment.artifactVerificationStatus === "failed") {
    return "error";
  }

  return "warning";
}

function shortSha(deployment?: DeploymentSummaryReadModel) {
  return deployment?.commitSha.slice(0, 8) ?? "unknown";
}

function summaryLine(deployment?: DeploymentSummaryReadModel) {
  if (!deployment) {
    return "No deployment is currently attached to this channel.";
  }

  return `${deployment.branch} / ${shortSha(deployment)} / ${deployment.version}`;
}

export function CandidatePanel({ channel, currentDeployment, candidateDeployment }: CandidatePanelProps) {
  const candidateStatus = candidateDeployment?.status ?? "missing";
  const artifactDelta =
    currentDeployment && candidateDeployment
      ? `${currentDeployment.id} -> ${candidateDeployment.id}`
      : "Waiting for comparable deployments";

  return (
    <Panel
      title="Candidate deployment"
      eyebrow="Current-vs-next delta"
      actions={<StatusPill tone={deploymentTone(candidateDeployment)}>{candidateStatus}</StatusPill>}
    >
      <div className="release-metric-grid">
        <div className="release-metric">
          <span className="release-label">Candidate deployment</span>
          <strong className="release-mono">{candidateDeployment?.id ?? "No candidate"}</strong>
          <span className="release-muted">{summaryLine(candidateDeployment)}</span>
        </div>
        <div className="release-metric">
          <span className="release-label">Current production or current channel</span>
          <strong className="release-mono">{currentDeployment?.id ?? "No current target"}</strong>
          <span className="release-muted">
            {channel} / {summaryLine(currentDeployment)}
          </span>
        </div>
        <div className="release-metric">
          <span className="release-label">Artifact delta</span>
          <strong>{artifactDelta}</strong>
          <span className="release-muted">
            Candidate artifact {candidateDeployment?.artifactVerificationStatus ?? "unknown"}; route state{" "}
            {candidateDeployment?.routeRevisionStatus ?? "not generated"}.
          </span>
        </div>
      </div>
    </Panel>
  );
}
