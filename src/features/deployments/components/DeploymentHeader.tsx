import { RefreshCw } from "lucide-react";

import { Button } from "@components/ui/Button";
import { StatusPill } from "@components/ui/StatusPill";
import type { DeploymentDetailReadModel } from "@domain/readModels";
import {
  cdnOperationFromDetail,
  cdnOperationStateLabel,
  cdnOperationStateTone,
  deploymentStatusLabel,
  deploymentStatusTone,
  formatDateTime,
  latestDeploymentTimestamp,
  pollingBoundaryCopy,
  routeRevisionStatusLabel,
  routeRevisionStatusTone
} from "../deploymentStatus";

export interface DeploymentHeaderProps {
  detail: DeploymentDetailReadModel;
  onRefresh?: () => void;
}

export function DeploymentHeader({ detail, onRefresh }: DeploymentHeaderProps) {
  const { project, deployment, lineage } = detail;
  const routeRevision = lineage.routeRevision;
  const cdnOperation = cdnOperationFromDetail(detail);

  return (
    <section className="page-header deployment-header" aria-labelledby="deployment-title">
      <div className="deployment-header__copy">
        <p className="eyebrow">Switchyard / Consist ticket</p>
        <h1 id="deployment-title" className="page-title">
          {deployment.version}
        </h1>
        <p className="deployment-header__summary">
          {project.name} / {deployment.id} / {lineage.sourceEvent.branch}@{lineage.sourceEvent.commitSha.slice(0, 8)}
        </p>
        <p className="deployment-header__freshness">
          Last updated {formatDateTime(latestDeploymentTimestamp(detail))}. {pollingBoundaryCopy(detail)}
        </p>
      </div>

      <div className="deployment-header__aside">
        <div className="deployment-header__statuses" aria-label="Deployment delivery status">
          <StatusPill tone={deploymentStatusTone(deployment.status)}>{deploymentStatusLabel(deployment.status)}</StatusPill>
          <StatusPill tone={routeRevisionStatusTone(routeRevision?.status)}>{routeRevisionStatusLabel(routeRevision?.status)}</StatusPill>
          <StatusPill tone={cdnOperationStateTone(cdnOperation?.state)}>{cdnOperationStateLabel(cdnOperation?.state)}</StatusPill>
        </div>
        <div className="page-header__actions">
          <Button variant="primary" icon={<RefreshCw aria-hidden="true" size={16} />} onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </div>
    </section>
  );
}
