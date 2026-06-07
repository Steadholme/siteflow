import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@components/ui/Button";
import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { ProjectListItemReadModel, ProjectListReadModel } from "@domain/readModels";
import { createSiteFlowClient, type SiteFlowClient } from "@lib/api";
import { ProjectActivity } from "./components/ProjectActivity";
import { ProjectInventoryTable } from "./components/ProjectInventoryTable";
import { ProjectSummaryStrip } from "./components/ProjectSummaryStrip";
import {
  compactId,
  formatDateTime,
  routeStatusDescriptor,
  trafficStatusDescriptor
} from "./projectPresentation";

type LoadState =
  | { status: "loading" }
  | { status: "success"; data: ProjectListReadModel; loadedAt: string }
  | { status: "error"; error: Error };

export interface ProjectListPageProps {
  client?: SiteFlowClient;
}

function getDefaultClient() {
  return createSiteFlowClient();
}

function matchesStatusFilter(item: ProjectListItemReadModel, statusFilter: string) {
  const traffic = trafficStatusDescriptor(item.productionDeployment).label.toLowerCase();
  const route = item.productionDeployment?.routeRevisionStatus;

  if (statusFilter === "all") {
    return true;
  }

  if (statusFilter === "paused") {
    return item.project.status === "paused";
  }

  if (statusFilter === "healthy") {
    return traffic === "healthy";
  }

  if (statusFilter === "queued") {
    return traffic.includes("queued");
  }

  if (statusFilter === "drift") {
    return route === "drifted";
  }

  return true;
}

function filterProjects(projects: ProjectListItemReadModel[], search: string, statusFilter: string) {
  const query = search.trim().toLowerCase();

  return projects.filter((item) => {
    const searchable = [
      item.project.name,
      item.project.slug,
      item.project.framework,
      item.project.repository.owner,
      item.project.repository.name,
      item.productionDeployment?.id,
      item.productionDeployment?.commitSha
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (!query || searchable.includes(query)) && matchesStatusFilter(item, statusFilter);
  });
}

function ProjectOperationsBoard({ projects }: { projects: ProjectListItemReadModel[] }) {
  const productionRows = projects.slice(0, 4);
  const stagingRows = projects.filter((item) => item.pendingDeploymentCount > 0).slice(0, 4);
  const previewRows = projects.filter((item) => item.project.policy.previewDeploymentsEnabled).slice(0, 4);

  const lanes = [
    {
      title: "Production",
      status: `${productionRows.length} tracked`,
      rows: productionRows,
      empty: "No production channels are tracked."
    },
    {
      title: "Staging",
      status: `${stagingRows.length} candidates`,
      rows: stagingRows,
      empty: "No queued staging candidates."
    },
    {
      title: "Previews",
      status: `${previewRows.length} policies`,
      rows: previewRows,
      empty: "Preview routes are disabled for these fixtures."
    }
  ];

  return (
    <section className="projects-board-lanes" aria-label="Operations board">
      {lanes.map((lane) => (
        <Panel key={lane.title} title={lane.title} actions={<StatusPill tone="info">{lane.status}</StatusPill>}>
          <div className="projects-stack">
            {lane.rows.length > 0 ? (
              lane.rows.map((item) => {
                const traffic = trafficStatusDescriptor(item.productionDeployment);
                const route = item.productionDeployment
                  ? routeStatusDescriptor(item.productionDeployment.routeRevisionStatus)
                  : { label: "Route pending", tone: "info" as const };

                return (
                  <div key={`${lane.title}-${item.project.id}`} className="projects-row-card">
                    <div>
                      <strong>{item.project.name}</strong>
                      <span className="table-subtext">
                        {lane.title.toLowerCase()} - {compactId(item.productionDeployment?.id)}
                      </span>
                    </div>
                    <span className="projects-status-stack">
                      <StatusPill tone={traffic.tone}>{traffic.label}</StatusPill>
                      {lane.title === "Production" && <StatusPill tone={route.tone}>{route.label}</StatusPill>}
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="projects-empty-note">{lane.empty}</p>
            )}
          </div>
        </Panel>
      ))}
    </section>
  );
}

export function ProjectListPage({ client: providedClient }: ProjectListPageProps) {
  const client = useMemo(() => providedClient ?? getDefaultClient(), [providedClient]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const search = searchParams.get("q") ?? "";
  const statusFilter = searchParams.get("status") ?? "all";

  const updateFilterState = useCallback(
    (next: { search?: string; status?: string }) => {
      const params = new URLSearchParams(searchParams);
      const nextSearch = next.search ?? search;
      const nextStatus = next.status ?? statusFilter;

      if (nextSearch.trim()) {
        params.set("q", nextSearch);
      } else {
        params.delete("q");
      }

      if (nextStatus !== "all") {
        params.set("status", nextStatus);
      } else {
        params.delete("status");
      }

      setSearchParams(params, { replace: true });
    },
    [search, searchParams, setSearchParams, statusFilter]
  );

  const loadProjects = useCallback(() => {
    let canceled = false;

    setState({ status: "loading" });

    client
      .listProjects()
      .then((data) => {
        if (!canceled) {
          setState({ status: "success", data, loadedAt: new Date().toISOString() });
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setState({ status: "error", error: error instanceof Error ? error : new Error("Project inventory failed to load.") });
        }
      });

    return () => {
      canceled = true;
    };
  }, [client]);

  useEffect(() => loadProjects(), [loadProjects]);

  if (state.status === "loading") {
    return (
      <div className="workspace-stack projects-page">
        <Panel title="Project inventory">
          <p className="projects-empty-note">Loading project inventory…</p>
        </Panel>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="workspace-stack projects-page">
        <section className="page-header" aria-labelledby="projects-title">
          <div>
            <p className="eyebrow">Project inventory</p>
            <h1 id="projects-title" className="page-title">
              Projects
            </h1>
          </div>
          <Button variant="secondary" icon={<RefreshCw aria-hidden="true" size={16} />} onClick={loadProjects}>
            Retry
          </Button>
        </section>
        <Panel title="Project inventory unavailable">
          <p className="projects-error-text">{state.error.message}</p>
        </Panel>
      </div>
    );
  }

  const { data } = state;
  const filteredProjects = filterProjects(data.projects, search, statusFilter);
  const hasActiveFilters = search.trim().length > 0 || statusFilter !== "all";

  return (
    <div className="workspace-stack projects-page">
      <section className="page-header" aria-labelledby="projects-title">
        <div>
          <p className="eyebrow">Control plane / Projects</p>
          <h1 id="projects-title" className="page-title">
            Projects
          </h1>
        </div>
        <div className="page-header__actions">
          <StatusPill tone={data.summary.routeDriftCount > 0 || data.summary.failedRouteCount > 0 ? "warning" : "success"}>
            {data.summary.routeDriftCount > 0 ? "Route drift" : "Live inventory"}
          </StatusPill>
          <Button variant="secondary" icon={<RefreshCw aria-hidden="true" size={16} />} onClick={loadProjects}>
            Refresh
          </Button>
        </div>
      </section>

      <ProjectSummaryStrip model={data} />

      <div className="projects-state-banner" role="status">
        <strong>Stale data guard</strong>
        <span>
          Snapshot loaded {formatDateTime(state.loadedAt)} from read models updated {formatDateTime(data.summary.updatedAt)}.
          Recheck project detail before release actions.
        </span>
      </div>

      {data.projects.length === 0 ? (
        <Panel title="No projects">
          <p className="projects-empty-note">{data.emptyState ?? "No SiteFlow projects have been created yet."}</p>
        </Panel>
      ) : (
        <>
          <ProjectInventoryTable
            projects={filteredProjects}
            totalProjects={data.projects.length}
            search={search}
            onSearchChange={(value) => updateFilterState({ search: value })}
            statusFilter={statusFilter}
            onStatusFilterChange={(value) => updateFilterState({ status: value })}
            onClearFilters={() => updateFilterState({ search: "", status: "all" })}
            hasActiveFilters={hasActiveFilters}
          />

          <div className="projects-board-grid">
            <ProjectOperationsBoard projects={data.projects} />
            <ProjectActivity events={data.recentEvents} title="Recent control-plane events" />
          </div>
        </>
      )}
    </div>
  );
}
