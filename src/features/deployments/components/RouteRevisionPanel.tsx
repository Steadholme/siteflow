import { Route } from "lucide-react";

import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { CdnOperation, RouteRevision } from "@domain/siteflow";
import { redactRouteConfig } from "@lib/redaction";
import {
  cdnOperationStateLabel,
  cdnOperationStateTone,
  formatDateTime,
  routeRevisionStatusLabel,
  routeRevisionStatusTone
} from "../deploymentStatus";

export interface RouteRevisionPanelProps {
  routeRevision?: RouteRevision;
  cdnOperation?: CdnOperation;
}

export function RouteRevisionPanel({ routeRevision, cdnOperation }: RouteRevisionPanelProps) {
  const generatedConfig = routeRevision ? redactRouteConfig(routeRevision.generatedConfig) : "";

  return (
    <Panel title="Route revision" eyebrow="Traffic boundary" className="deployment-route-panel">
      {routeRevision ? (
        <div className="deployment-route">
          <div className="deployment-route__status">
            <Route aria-hidden="true" size={18} />
            <StatusPill tone={routeRevisionStatusTone(routeRevision.status)}>{routeRevisionStatusLabel(routeRevision.status)}</StatusPill>
            <StatusPill tone={cdnOperationStateTone(cdnOperation?.state)}>{cdnOperationStateLabel(cdnOperation?.state)}</StatusPill>
          </div>
          <dl className="deployment-proof__list">
            <div>
              <dt>Channel</dt>
              <dd>{routeRevision.channel}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd className="deployment-mono">{routeRevision.id}</dd>
            </div>
            <div>
              <dt>Previous known-good</dt>
              <dd>{routeRevision.previousDeploymentId ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Applied at</dt>
              <dd>{formatDateTime(routeRevision.appliedAt)}</dd>
            </div>
            <div>
              <dt>CDN operation</dt>
              <dd>{cdnOperation?.message ?? "No CDN operation recorded"}</dd>
            </div>
          </dl>
          {routeRevision.failedReason && <p className="deployment-route__failure">{routeRevision.failedReason}</p>}
          <pre className="deployment-route__config" aria-label="Generated route config">
            {generatedConfig}
          </pre>
        </div>
      ) : (
        <p className="deployment-empty">No route revision has been created for this deployment.</p>
      )}
    </Panel>
  );
}
