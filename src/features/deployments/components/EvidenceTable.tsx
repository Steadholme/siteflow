import { DataTable, type DataTableColumn } from "@components/ui/DataTable";
import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { DeploymentDetailReadModel } from "@domain/readModels";
import type { EvidenceStatus } from "../deploymentStatus";
import {
  cdnOperationFromDetail,
  cdnOperationStateLabel,
  evidenceStatusLabel,
  evidenceStatusTone,
  formatBytes,
  routeRevisionStatusLabel,
  shortenSha
} from "../deploymentStatus";

interface EvidenceRow {
  id: string;
  check: string;
  expected: string;
  observed: string;
  status: EvidenceStatus;
}

function getRouteEvidenceStatus(detail: DeploymentDetailReadModel): EvidenceStatus {
  const status = detail.lineage.routeRevision?.status;

  if (status === "applied" || status === "superseded") {
    return "pass";
  }

  if (status === "failed") {
    return "fail";
  }

  if (status === "drifted") {
    return "stale";
  }

  return "pending";
}

function getCdnEvidenceStatus(detail: DeploymentDetailReadModel): EvidenceStatus {
  const state = cdnOperationFromDetail(detail)?.state;

  if (state === "disabled" || state === "skipped") {
    return "skipped";
  }

  if (state === "succeeded") {
    return "pass";
  }

  if (state === "failed") {
    return "fail";
  }

  return "pending";
}

function buildRows(detail: DeploymentDetailReadModel): EvidenceRow[] {
  const { project, lineage, routeEvidence } = detail;
  const { buildJob, artifact, routeRevision } = lineage;
  const cdnOperation = cdnOperationFromDetail(detail);
  const checksumObserved =
    artifact.verificationStatus === "verified" ? shortenSha(artifact.manifest.checksum, 22) : artifact.verificationStatus;

  return [
    {
      id: "framework-preset",
      check: "Framework preset",
      expected: project.framework,
      observed: buildJob.framework,
      status: buildJob.framework ? "pass" : "pending"
    },
    {
      id: "output-directory",
      check: "Output directory",
      expected: buildJob.outputDirectory,
      observed: `${artifact.manifest.fileCount} files / ${formatBytes(artifact.manifest.totalBytes)}`,
      status: artifact.manifest.fileCount > 0 ? "pass" : "pending"
    },
    {
      id: "manifest-checksum",
      check: "Manifest/checksum",
      expected: "Immutable manifest checksum",
      observed: checksumObserved,
      status:
        artifact.verificationStatus === "verified" ? "pass" : artifact.verificationStatus === "failed" ? "fail" : "pending"
    },
    {
      id: "route-validation",
      check: "Route validation",
      expected: "Nginx dry-run and apply",
      observed: routeRevision ? routeRevision.validationSummary : "No route revision has been planned.",
      status: getRouteEvidenceStatus(detail)
    },
    {
      id: "cdn-operation",
      check: "CDN operation",
      expected: project.policy.cdnEnabled ? "Purge changed paths" : "Adapter disabled by policy",
      observed: cdnOperationStateLabel(cdnOperation?.state),
      status: getCdnEvidenceStatus(detail)
    },
    {
      id: "rollback-protection",
      check: "Rollback protection",
      expected: "Previous known-good preserved",
      observed: routeEvidence?.previousKnownGoodDeploymentId ?? "No previous deployment recorded",
      status: routeEvidence?.previousKnownGoodDeploymentId ? "pass" : "fail"
    },
    ...detail.evidence.map((item): EvidenceRow => ({
      id: item.id,
      check: item.label,
      expected: "Control-plane evidence",
      observed: item.evidence ?? item.summary,
      status: item.status === "fail" ? "fail" : item.status
    }))
  ];
}

const columns: Array<DataTableColumn<EvidenceRow>> = [
  {
    key: "check",
    header: "Check",
    width: "22%",
    render: (row) => <strong>{row.check}</strong>
  },
  {
    key: "expected",
    header: "Expected",
    width: "24%",
    render: (row) => row.expected
  },
  {
    key: "observed",
    header: "Observed",
    render: (row) => <span className="deployment-evidence__observed">{row.observed}</span>
  },
  {
    key: "status",
    header: "Status",
    width: "120px",
    render: (row) => <StatusPill tone={evidenceStatusTone(row.status)}>{evidenceStatusLabel(row.status)}</StatusPill>
  }
];

export interface EvidenceTableProps {
  detail: DeploymentDetailReadModel;
}

export function EvidenceTable({ detail }: EvidenceTableProps) {
  return (
    <Panel title="Evidence table" eyebrow="Ticket band / Verification checks" className="deployment-evidence-panel">
      <DataTable rows={buildRows(detail)} columns={columns} getRowKey={(row) => row.id} ariaLabel="Evidence table" />
    </Panel>
  );
}
