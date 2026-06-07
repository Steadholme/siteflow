import { Download, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@components/ui/Button";
import { DataTable, type DataTableColumn } from "@components/ui/DataTable";
import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { DeploymentSummaryReadModel } from "@domain/readModels";
import {
  artifactStatusDescriptor,
  compactId,
  deploymentHistoryStatus,
  formatDateTime,
  isDeploymentSummary,
  routeStatusDescriptor,
  shortCommit
} from "../projectPresentation";

const columns: Array<DataTableColumn<DeploymentSummaryReadModel>> = [
  {
    key: "deployment",
    header: "Deployment",
    width: "22%",
    render: (deployment) => (
      <span>
        <Link className="projects-link-strong projects-mono" to={`/deployments/${deployment.id}`}>
          {compactId(deployment.id)}
        </Link>
        <span className="table-subtext">Version {deployment.version}</span>
      </span>
    )
  },
  {
    key: "source",
    header: "Source",
    render: (deployment) => (
      <span>
        {deployment.branch} - {shortCommit(deployment.commitSha)}
        <span className="table-subtext">{deployment.projectName}</span>
      </span>
    )
  },
  {
    key: "status",
    header: "Status",
    render: (deployment) => {
      const status = deploymentHistoryStatus(deployment);

      return <StatusPill tone={status.tone}>{status.label}</StatusPill>;
    }
  },
  {
    key: "route",
    header: "Route",
    render: (deployment) => {
      const status = routeStatusDescriptor(deployment.routeRevisionStatus);

      return <StatusPill tone={status.tone}>{status.label}</StatusPill>;
    }
  },
  {
    key: "artifact",
    header: "Artifact",
    render: (deployment) => {
      const status = artifactStatusDescriptor(deployment.artifactVerificationStatus);

      return (
        <span className="projects-status-stack">
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
          {deployment.artifactVerificationStatus === "verified" && <StatusPill tone="success">Protected</StatusPill>}
        </span>
      );
    }
  },
  {
    key: "created",
    header: "Created",
    align: "right",
    render: (deployment) => formatDateTime(deployment.createdAt)
  },
  {
    key: "action",
    header: "",
    align: "right",
    render: (deployment) => (
      <Link className="button button--secondary projects-action-link" to={`/deployments/${deployment.id}`}>
        <ExternalLink aria-hidden="true" size={15} />
        <span>Inspect</span>
      </Link>
    )
  }
];

export function DeploymentHistory({ deployments }: { deployments: DeploymentSummaryReadModel[] }) {
  const rows = deployments.filter(isDeploymentSummary);

  return (
    <Panel
      title="Deployment history"
      eyebrow="Build, artifact, and route evidence"
      actions={
        <Button variant="ghost" icon={<Download aria-hidden="true" size={15} />}>
          Export
        </Button>
      }
    >
      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(deployment) => deployment.id}
        ariaLabel="Deployment history"
        emptyState="No deployments have been recorded for this project."
      />
    </Panel>
  );
}
