import { DataTable, type DataTableColumn } from "@components/ui/DataTable";
import { Panel } from "@components/ui/Panel";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";
import type { RollbackTargetReadModel } from "@domain/readModels";

interface RollbackTimelineProps {
  targets: RollbackTargetReadModel[];
  selectedTargetId?: string;
  onSelectTarget: (deploymentId: string) => void;
}

function targetTone(target: RollbackTargetReadModel): StatusTone {
  if (!isRollbackTargetSelectable(target)) {
    return "error";
  }

  return target.safetyChecks.some((check) => check.status === "warning") ? "warning" : "success";
}

export function isRollbackTargetSelectable(target?: RollbackTargetReadModel) {
  if (!target) {
    return false;
  }

  return (
    target.eligible &&
    target.deployment.status === "ready" &&
    target.deployment.artifactVerificationStatus === "verified" &&
    target.safetyChecks.every((check) => check.status === "pass")
  );
}

function disabledReason(target: RollbackTargetReadModel) {
  if (target.disabledReason) {
    return target.disabledReason;
  }

  if (target.deployment.status !== "ready") {
    return "Deployment is not ready.";
  }

  if (target.deployment.artifactVerificationStatus !== "verified") {
    return "Artifact is unverified.";
  }

  const failedCheck = target.safetyChecks.find((check) => check.status !== "pass");
  return failedCheck ? failedCheck.summary : undefined;
}

export function RollbackTimeline({ targets, selectedTargetId, onSelectTarget }: RollbackTimelineProps) {
  const columns: Array<DataTableColumn<RollbackTargetReadModel>> = [
    {
      key: "select",
      header: "Select",
      width: "88px",
      render: (target) => (
        <input
          type="radio"
          name="rollback-target"
          aria-label={`Select rollback target ${target.deployment.id}`}
          checked={selectedTargetId === target.deployment.id}
          disabled={!isRollbackTargetSelectable(target)}
          onChange={() => onSelectTarget(target.deployment.id)}
        />
      )
    },
    {
      key: "deployment",
      header: "Deployment",
      render: (target) => (
        <span>
          <strong className="release-mono" title={target.deployment.id}>
            {target.deployment.id}
          </strong>
          <span className="table-subtext">{target.deployment.version}</span>
        </span>
      )
    },
    {
      key: "artifact",
      header: "Artifact protection",
      render: (target) => (
        <span>
          <StatusPill tone={targetTone(target)}>{isRollbackTargetSelectable(target) ? "protected" : "disabled"}</StatusPill>
          {disabledReason(target) && <span className="table-subtext">{disabledReason(target)}</span>}
        </span>
      )
    },
    {
      key: "checks",
      header: "Checks",
      render: (target) => `${target.safetyChecks.filter((check) => check.status === "pass").length}/${target.safetyChecks.length} pass`
    }
  ];

  return (
    <Panel title="Known-good deployments" eyebrow="Rollback selector" actions={<StatusPill tone="info">protected only</StatusPill>}>
      <div className="release-target-group" role="radiogroup" aria-label="Known-good rollback deployments" tabIndex={0}>
        <DataTable
          rows={targets}
          columns={columns}
          getRowKey={(target) => target.deployment.id}
          ariaLabel="Known-good rollback deployments"
          emptyState="No protected rollback targets are available."
        />
      </div>
      <p className="release-muted release-table-note">
        Expired, failed, unverified, or deleted-artifact deployments remain disabled until backend eligibility passes again.
      </p>
    </Panel>
  );
}
