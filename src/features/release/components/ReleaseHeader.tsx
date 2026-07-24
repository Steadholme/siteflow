import type { ReleaseChannelName } from "@domain/siteflow";
import type { DeploymentSummaryReadModel } from "@domain/readModels";
import { RefreshCw } from "lucide-react";
import { Button } from "@components/ui/Button";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";

interface ReleaseHeaderProps {
  mode: "promote" | "rollback";
  projectName: string;
  channel: ReleaseChannelName;
  currentDeployment?: DeploymentSummaryReadModel;
  targetDeployment?: DeploymentSummaryReadModel;
  loadedAt: string;
  reloading: boolean;
  onReload: () => void;
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

export function ReleaseHeader({
  mode,
  projectName,
  channel,
  currentDeployment,
  targetDeployment,
  loadedAt,
  reloading,
  onReload
}: ReleaseHeaderProps) {
  const channelLabel = `${projectName} / ${channel}`;
  const targetLabel = targetDeployment?.id ?? "No target selected";
  const currentLabel = currentDeployment?.id ?? "No current deployment";
  const loadedAtLabel = new Date(loadedAt).toLocaleString();

  return (
    <header className="page-header release-header">
      <div className="release-header__title">
        <p className="eyebrow">{mode === "promote" ? "Gate House / Promotion" : "Gate House / Rollback"}</p>
        <h1 className="page-title">{titleForMode(mode)}</h1>
        <p className="release-header__meta">
          <span>{channelLabel}</span> · channel move: <span title={currentLabel}>{currentLabel}</span> to{" "}
          <span title={targetLabel}>{targetLabel}</span>
        </p>
        <p className="release-header__snapshot" role="status">
          Console snapshot loaded <time dateTime={loadedAt}>{loadedAtLabel}</time>. Reload before submitting a command.
        </p>
      </div>
      <div className="page-header__actions">
        <div className="release-header__signals" aria-label="Route state">
          <StatusPill tone={routeTone(currentDeployment)}>current route {currentDeployment?.routeRevisionStatus ?? "missing"}</StatusPill>
          <StatusPill tone={routeTone(targetDeployment)}>target route {targetDeployment?.routeRevisionStatus ?? "pending"}</StatusPill>
        </div>
        <Button variant="secondary" icon={<RefreshCw size={16} aria-hidden="true" />} disabled={reloading} onClick={onReload}>
          Reload console state
        </Button>
      </div>
    </header>
  );
}
