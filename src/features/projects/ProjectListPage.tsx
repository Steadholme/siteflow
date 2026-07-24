import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@components/ui/Button";
import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { ProjectListItemReadModel, ProjectListReadModel } from "@domain/readModels";
import { createSiteFlowClient, SiteFlowHttpError, type SiteFlowClient } from "@lib/api";
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

function projectAccessError(error: Error) {
  if (error instanceof SiteFlowHttpError && error.isUnauthorized) {
    return {
      eyebrow: "Sign-in required (401)",
      guidance: "Your operator session is missing or expired. Sign in again through the gateway, then retry."
    };
  }

  if (error instanceof SiteFlowHttpError && error.isForbidden) {
    return {
      eyebrow: "Access denied (403)",
      guidance: "Your gateway identity does not include the required permission for this console."
    };
  }

  return {
    eyebrow: "API error",
    guidance: "Retry after the control-plane read becomes available."
  };
}

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
      kind: "production" as const,
      title: "Production",
      status: `${productionRows.length} tracked`,
      rows: productionRows,
      empty: "No production channels are tracked."
    },
    {
      kind: "staging" as const,
      title: "Staging",
      status: `${stagingRows.length} candidates`,
      rows: stagingRows,
      empty: "No queued staging candidates."
    },
    {
      kind: "previews" as const,
      title: "Previews",
      status: `${previewRows.length} policies`,
      rows: previewRows,
      empty: "Preview routes are disabled for these fixtures."
    }
  ];

  return (
    <section className="projects-board-lanes" aria-label="Operations board">
      {lanes.map((lane) => (
        <Panel
          key={lane.title}
          eyebrow={`Track / ${lane.title}`}
          title={lane.title}
          actions={<StatusPill tone="info">{lane.status}</StatusPill>}
        >
          <div className="projects-stack">
            {lane.rows.length > 0 ? (
              lane.rows.map((item) => {
                const traffic = trafficStatusDescriptor(item.productionDeployment);
                const route = item.productionDeployment
                  ? routeStatusDescriptor(item.productionDeployment.routeRevisionStatus)
                  : { label: "Route pending", tone: "info" as const };
                const consist =
                  lane.kind === "production"
                    ? compactId(item.productionDeployment?.id)
                    : lane.kind === "staging"
                      ? `${item.pendingDeploymentCount} pending`
                      : "PR route policy";
                const primarySignal =
                  lane.kind === "production"
                    ? traffic
                    : lane.kind === "staging"
                      ? {
                          label: `${item.pendingDeploymentCount} candidate${item.pendingDeploymentCount === 1 ? "" : "s"}`,
                          tone: item.pendingDeploymentCount > 0 ? ("warning" as const) : ("info" as const)
                        }
                      : {
                          label: item.project.policy.previewDeploymentsEnabled ? "Policy enabled" : "Policy disabled",
                          tone: item.project.policy.previewDeploymentsEnabled ? ("success" as const) : ("info" as const)
                        };

                return (
                  <div key={`${lane.title}-${item.project.id}`} className="projects-row-card">
                    <div>
                      <strong>{item.project.name}</strong>
                      <span
                        className="table-subtext"
                        title={lane.kind === "production" ? item.productionDeployment?.id : undefined}
                      >
                        {lane.title.toLowerCase()} — {consist}
                      </span>
                    </div>
                    <span className="projects-status-stack">
                      <StatusPill tone={primarySignal.tone}>{primarySignal.label}</StatusPill>
                      {lane.kind === "production" ? <StatusPill tone={route.tone}>{route.label}</StatusPill> : null}
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
    const accessError = projectAccessError(state.error);

    return (
      <div className="workspace-stack projects-page">
        <section className="page-header" aria-labelledby="projects-title">
          <div>
            <p className="eyebrow">{accessError.eyebrow}</p>
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
          <p className="projects-error-guidance">{accessError.guidance}</p>
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
          <p className="eyebrow">Switchyard / Yard inventory</p>
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
