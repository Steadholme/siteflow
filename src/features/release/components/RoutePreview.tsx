import { Panel } from "@components/ui/Panel";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";
import type { CdnOperationState, RouteRevisionStatus } from "@domain/siteflow";
import type { RouteRevisionEvidenceReadModel } from "@domain/readModels";

interface RoutePreviewProps {
  preview?: RouteRevisionEvidenceReadModel;
}

function routeTone(status?: RouteRevisionStatus): StatusTone {
  if (status === "applied") {
    return "success";
  }

  if (status === "failed" || status === "drifted") {
    return "error";
  }

  return status ? "warning" : "info";
}

function cdnTone(state?: CdnOperationState): StatusTone {
  if (state === "succeeded" || state === "skipped" || state === "disabled") {
    return "success";
  }

  if (state === "failed") {
    return "error";
  }

  return state ? "warning" : "info";
}

export function RoutePreview({ preview }: RoutePreviewProps) {
  if (!preview) {
    return (
      <Panel title="Route preview" eyebrow="Dry-run">
        <p className="release-muted">No route dry-run has been generated for this command.</p>
      </Panel>
    );
  }

  const routeRevision = preview.routeRevision;
  const cdnOperation = routeRevision.cdnOperation;
  const routeFailed = routeRevision.status === "failed";

  return (
    <Panel
      title="Route preview"
      eyebrow="Dry-run"
      actions={<StatusPill tone={routeTone(routeRevision.status)}>{routeRevision.status}</StatusPill>}
    >
      <div className="release-fact-grid">
        <div>
          <span className="release-label">Route revision</span>
          <strong>{routeRevision.id}</strong>
          <p className="release-muted">{routeRevision.validationSummary}</p>
        </div>
        <div>
          <span className="release-label">Previous known-good</span>
          <strong className="release-mono">{preview.previousKnownGoodDeploymentId ?? routeRevision.previousDeploymentId ?? "None"}</strong>
          <p className="release-muted">Previous route evidence remains protected until apply succeeds.</p>
        </div>
        <div>
          <span className="release-label">CDN status</span>
          <StatusPill tone={cdnTone(cdnOperation?.state)}>{cdnOperation?.state ?? "not requested"}</StatusPill>
          <p className="release-muted">{cdnOperation?.message ?? "CDN work is separate from the channel transaction."}</p>
        </div>
      </div>
      {routeFailed && (
        <div role="alert" className="release-alert release-alert--error">
          <strong>Route apply failed</strong>
          <span>
            {routeRevision.failedReason
              ? `${routeRevision.failedReason} Previous known-good route remains active.`
              : "Previous known-good route remains active."}
          </span>
        </div>
      )}
      <pre className="release-code" aria-label="Generated route config preview">
        {routeRevision.generatedConfig}
      </pre>
    </Panel>
  );
}
