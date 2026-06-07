import { ExternalLink, Filter } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@components/ui/Button";
import { DataTable, type DataTableColumn } from "@components/ui/DataTable";
import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { ProjectListItemReadModel } from "@domain/readModels";
import {
  artifactStatusDescriptor,
  compactId,
  formatDateTime,
  projectStatusDescriptor,
  routeStatusDescriptor,
  trafficStatusDescriptor
} from "../projectPresentation";

interface ProjectInventoryTableProps {
  projects: ProjectListItemReadModel[];
  totalProjects: number;
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
}

function getColumns(): Array<DataTableColumn<ProjectListItemReadModel>> {
  return [
    {
      key: "project",
      header: "Project",
      width: "24%",
      render: (item) => {
        const projectStatus = projectStatusDescriptor(item.project.status);

        return (
          <span className="projects-table__project">
            <Link className="projects-link-strong" to={`/projects/${item.project.id}`}>
              {item.project.name}
            </Link>
            <span className="table-subtext">
              {item.project.repository.provider}/{item.project.repository.owner}/{item.project.repository.name}
            </span>
            <StatusPill tone={projectStatus.tone}>{projectStatus.label}</StatusPill>
          </span>
        );
      }
    },
    {
      key: "production",
      header: "Production",
      render: (item) => {
        const status = trafficStatusDescriptor(item.productionDeployment);

        return <StatusPill tone={status.tone}>{status.label}</StatusPill>;
      }
    },
    {
      key: "deployment",
      header: "Last deployment",
      render: (item) => (
        <span>
          <span className="projects-mono">{compactId(item.productionDeployment?.id)}</span>
          <span className="table-subtext">
            {item.productionDeployment ? formatDateTime(item.productionDeployment.createdAt) : "No deployment yet"}
          </span>
        </span>
      )
    },
    {
      key: "framework",
      header: "Framework",
      render: (item) => (
        <span>
          {item.project.framework}
          <span className="table-subtext">{item.project.defaultBranch}</span>
        </span>
      )
    },
    {
      key: "route",
      header: "Route",
      render: (item) => {
        const status = item.productionDeployment
          ? routeStatusDescriptor(item.productionDeployment.routeRevisionStatus)
          : { label: "Route pending", tone: "info" as const };

        return <StatusPill tone={status.tone}>{status.label}</StatusPill>;
      }
    },
    {
      key: "artifact",
      header: "Artifact",
      render: (item) => {
        const status = item.productionDeployment
          ? artifactStatusDescriptor(item.productionDeployment.artifactVerificationStatus)
          : { label: "No artifact", tone: "info" as const };

        return (
          <span className="projects-status-stack">
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            {item.project.policy.retentionDays > 0 && <StatusPill tone="success">Protected</StatusPill>}
          </span>
        );
      }
    },
    {
      key: "pending",
      header: "Pending",
      align: "right",
      render: (item) => item.pendingDeploymentCount
    },
    {
      key: "action",
      header: "",
      align: "right",
      render: (item) => (
        <Link className="button button--secondary projects-action-link" to={`/projects/${item.project.id}`}>
          <ExternalLink aria-hidden="true" size={15} />
          <span>Open</span>
        </Link>
      )
    }
  ];
}

export function ProjectInventoryTable({
  projects,
  totalProjects,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  onClearFilters,
  hasActiveFilters
}: ProjectInventoryTableProps) {
  const resultSummary = hasActiveFilters
    ? `${projects.length} of ${totalProjects} projects`
    : `${totalProjects} projects`;

  return (
    <Panel
      title="Project inventory"
      eyebrow={resultSummary}
      actions={
        <form className="projects-filter-toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
          <label className="projects-field">
            <span>Search projects</span>
            <input
              className="projects-input"
              name="q"
              autoComplete="off"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Project, repository, deployment..."
              type="search"
              value={search}
            />
          </label>
          <label className="projects-field">
            <span>Status</span>
            <select
              className="projects-select"
              name="status"
              onChange={(event) => onStatusFilterChange(event.target.value)}
              value={statusFilter}
            >
              <option value="all">All statuses</option>
              <option value="healthy">Healthy</option>
              <option value="queued">Build queued</option>
              <option value="drift">Route drift</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <Button variant="ghost" icon={<Filter aria-hidden="true" size={15} />} onClick={onClearFilters} disabled={!hasActiveFilters}>
            Clear
          </Button>
        </form>
      }
    >
      <DataTable
        rows={projects}
        columns={getColumns()}
        getRowKey={(item) => item.project.id}
        ariaLabel="Project inventory"
        emptyState="No projects match the current filters."
      />
    </Panel>
  );
}
