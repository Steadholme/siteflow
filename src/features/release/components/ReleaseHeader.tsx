import type { ReleaseChannelName } from "@domain/siteflow";
import type { DeploymentSummaryReadModel } from "@domain/readModels";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";

interface ReleaseHeaderProps {
  mode: "promote" | "rollback";
  projectName: string;
  channel: ReleaseChannelName;
  currentDeployment?: DeploymentSummaryReadModel;
  targetDeployment?: DeploymentSummaryReadModel;
}

function routeTone(deployment?: DeploymentSummaryReadModel): StatusTone {
  if (!deployment) {
    return "warning";
  }

  if (deployment.routeRevisionStatus === "applied") {
    return "success";
  }

  if (deployment.routeRevisionStatus === "failed" || deployment.routeRevisionStatus === "drifted") {
    return "error";
  }

  return "warning";
}

function titleForMode(mode: ReleaseHeaderProps["mode"]) {
  return mode === "promote" ? "Promote deployment" : "Rollback deployment";
}

export function ReleaseHeader({ mode, projectName, channel, currentDeployment, targetDeployment }: ReleaseHeaderProps) {
  const channelLabel = `${projectName} / ${channel}`;
  const targetLabel = targetDeployment?.id ?? "No target selected";
  const currentLabel = currentDeployment?.id ?? "No current deployment";

  return (
    <header className="page-header release-header">
      <div className="release-header__title">
        <p className="eyebrow">{channelLabel}</p>
        <h1 className="page-title">{titleForMode(mode)}</h1>
        <p className="release-header__meta">
          {channel} channel move: <span>{currentLabel}</span> to <span>{targetLabel}</span>
        </p>
      </div>
      <div className="page-header__actions">
        <StatusPill tone={routeTone(currentDeployment)}>current route {currentDeployment?.routeRevisionStatus ?? "missing"}</StatusPill>
        <StatusPill tone={routeTone(targetDeployment)}>target route {targetDeployment?.routeRevisionStatus ?? "pending"}</StatusPill>
      </div>
    </header>
  );
}
