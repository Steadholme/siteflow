import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { useParams } from "react-router-dom";

import { Button } from "@components/ui/Button";
import { DataTable, type DataTableColumn } from "@components/ui/DataTable";
import { Panel } from "@components/ui/Panel";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";
import { Timeline, type TimelineItem } from "@components/ui/Timeline";

export type PlaceholderPage =
  | "projects"
  | "project-detail"
  | "deployment-detail"
  | "release"
  | "rollback";

interface RoutePlaceholderProps {
  page: PlaceholderPage;
}

interface DeploymentRow {
  id: string;
  target: string;
  environment: string;
  revision: string;
  status: string;
  tone: StatusTone;
  updatedAt: string;
}

const rows: DeploymentRow[] = [
  {
    id: "dep_1029",
    target: "api-gateway",
    environment: "production",
    revision: "r1842",
    status: "Healthy",
    tone: "success",
    updatedAt: "3 min ago"
  },
  {
    id: "dep_1028",
    target: "checkout-web",
    environment: "staging",
    revision: "r1841",
    status: "Verifying",
    tone: "info",
    updatedAt: "11 min ago"
  },
  {
    id: "dep_1027",
    target: "admin-console",
    environment: "preview",
    revision: "r1839",
    status: "Route drift",
    tone: "warning",
    updatedAt: "28 min ago"
  }
];

const columns: Array<DataTableColumn<DeploymentRow>> = [
  {
    key: "target",
    header: "Target",
    width: "28%",
    render: (row) => (
      <span>
        <strong>{row.target}</strong>
        <span className="table-subtext">{row.id}</span>
      </span>
    )
  },
  { key: "environment", header: "Environment", render: (row) => row.environment },
  { key: "revision", header: "Revision", render: (row) => row.revision },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusPill tone={row.tone}>{row.status}</StatusPill>
  },
  { key: "updatedAt", header: "Updated", align: "right", render: (row) => row.updatedAt }
];

const timelineItems: TimelineItem[] = [
  {
    id: "source",
    title: "Source event accepted",
    meta: "main at 7a91c0",
    description: "Build input and actor metadata recorded.",
    tone: "success"
  },
  {
    id: "artifact",
    title: "Artifact verified",
    meta: "sha256:9db1",
    description: "Image digest is pinned for deployment evidence.",
    tone: "success"
  },
  {
    id: "route",
    title: "Route revision pending",
    meta: "edge propagation",
    description: "Traffic switch waits for route health confirmation.",
    tone: "warning"
  }
];

const pageMeta: Record<PlaceholderPage, { eyebrow: string; title: string; status: string; tone: StatusTone }> = {
  projects: {
    eyebrow: "Project inventory",
    title: "Projects",
    status: "Production healthy",
    tone: "success"
  },
  "project-detail": {
    eyebrow: "Project command center",
    title: "Project",
    status: "Route monitored",
    tone: "info"
  },
  "deployment-detail": {
    eyebrow: "Deployment evidence",
    title: "Deployment",
    status: "Evidence locked",
    tone: "success"
  },
  release: {
    eyebrow: "Release control",
    title: "Promote channel",
    status: "Audit required",
    tone: "warning"
  },
  rollback: {
    eyebrow: "Rollback control",
    title: "Rollback channel",
    status: "Safeguarded",
    tone: "warning"
  }
};

export function RoutePlaceholder({ page }: RoutePlaceholderProps) {
  const params = useParams();
  const meta = pageMeta[page];

  const title = useMemo(() => {
    if (page === "project-detail" && params.projectId) {
      return `${meta.title} ${params.projectId}`;
    }

    if (page === "deployment-detail" && params.deploymentId) {
      return `${meta.title} ${params.deploymentId}`;
    }

    if ((page === "release" || page === "rollback") && params.channel) {
      return `${meta.title} ${params.channel}`;
    }

    return meta.title;
  }, [meta.title, page, params.channel, params.deploymentId, params.projectId]);

  return (
    <div className="workspace-stack">
      <section className="page-header" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">{meta.eyebrow}</p>
          <h1 id="page-title" className="page-title">
            {title}
          </h1>
        </div>
        <div className="page-header__actions">
          <StatusPill tone={meta.tone}>{meta.status}</StatusPill>
          <Button variant="secondary" icon={<RefreshCw aria-hidden="true" size={16} />}>
            Refresh
          </Button>
        </div>
      </section>

      <section className="summary-grid" aria-label="Operational summary">
        <Panel className="metric-panel">
          <span className="metric-label">Production routes</span>
          <strong className="metric-value">18</strong>
          <span className="metric-foot">17 healthy, 1 pending</span>
        </Panel>
        <Panel className="metric-panel">
          <span className="metric-label">Verified artifacts</span>
          <strong className="metric-value">42</strong>
          <span className="metric-foot">No secret canaries exposed</span>
        </Panel>
        <Panel className="metric-panel">
          <span className="metric-label">Open audit items</span>
          <strong className="metric-value">3</strong>
          <span className="metric-foot">Release reasons required</span>
        </Panel>
      </section>

      <div className="workspace-grid">
        <Panel
          title="Deployment ledger"
          eyebrow="Latest evidence"
          actions={
            <Button variant="ghost" icon={<ExternalLink aria-hidden="true" size={16} />}>
              Open history
            </Button>
          }
        >
          <DataTable rows={rows} columns={columns} getRowKey={(row) => row.id} ariaLabel="Deployment ledger" />
        </Panel>

        <Panel title="Route lineage" eyebrow="Evidence chain">
          <Timeline items={timelineItems} ariaLabel="Route lineage timeline" />
          <div className="safety-note">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>Promote and rollback controls require fresh checks and an audit reason.</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
