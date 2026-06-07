import { RefreshCw, Rocket, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "@components/ui/Button";
import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { AnalyticsDashboardReadModel, ProjectDetailReadModel, ProjectSettingsReadModel } from "@domain/readModels";
import { createSiteFlowClient, getDefaultSiteFlowClientMode, type SiteFlowClient } from "@lib/api";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { DeploymentHistory } from "./components/DeploymentHistory";
import { EnvironmentMatrix } from "./components/EnvironmentMatrix";
import { ProjectActivity } from "./components/ProjectActivity";
import { ProjectDetailSummaryStrip } from "./components/ProjectSummaryStrip";
import { ProjectSettingsRail } from "./components/ProjectSettingsRail";
import { formatDateTime, projectStatusDescriptor, trafficStatusDescriptor } from "./projectPresentation";

type LoadState =
  | { status: "loading" }
  | {
      status: "success";
      data: ProjectDetailReadModel;
      settings?: ProjectSettingsReadModel;
      settingsError?: string;
      analytics?: AnalyticsDashboardReadModel;
      analyticsError?: string;
      loadedAt: string;
    }
  | { status: "error"; error: Error };

export interface ProjectDetailPageProps {
  client?: SiteFlowClient;
}

const defaultFixtureProjectId = "project-acme-dashboard";

function getDefaultClient() {
  return createSiteFlowClient();
}

function fixtureProjectIdForRoute(projectId: string) {
  return projectId === "docs-portal" ? defaultFixtureProjectId : projectId;
}

export function ProjectDetailPage({ client: providedClient }: ProjectDetailPageProps) {
  const { projectId } = useParams();
  const client = useMemo(() => providedClient ?? getDefaultClient(), [providedClient]);
  const defaultClientMode = useMemo(() => (providedClient ? "http" : getDefaultSiteFlowClientMode()), [providedClient]);
  const usesDefaultFixtureClient = !providedClient && defaultClientMode === "fixture";
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const loadProject = useCallback(() => {
    let canceled = false;

    if (!projectId) {
      setState({ status: "error", error: new Error("Project id is required.") });

      return () => {
        canceled = true;
      };
    }

    setState({ status: "loading" });

    const requestProjectId = usesDefaultFixtureClient ? fixtureProjectIdForRoute(projectId) : projectId;

    client
      .getProject(requestProjectId)
      .then(async (data) => {
        const [analyticsResult, settingsResult] = await Promise.all([
          client
            .getAnalyticsDashboard(requestProjectId)
            .then((analytics) => ({ analytics }))
            .catch((error: unknown) => ({
              analyticsError: error instanceof Error ? error.message : "Analytics summary failed to load."
            })),
          client
            .getProjectSettings(requestProjectId)
            .then((settings) => ({ settings }))
            .catch((error: unknown) => ({
              settingsError: error instanceof Error ? error.message : "Project settings failed to load."
            }))
        ]);

        if (!canceled) {
          setState({ status: "success", data, ...analyticsResult, ...settingsResult, loadedAt: new Date().toISOString() });
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setState({ status: "error", error: error instanceof Error ? error : new Error("Project failed to load.") });
        }
      });

    return () => {
      canceled = true;
    };
  }, [client, projectId, usesDefaultFixtureClient]);

  useEffect(() => loadProject(), [loadProject]);

  if (state.status === "loading") {
    return (
      <div className="workspace-stack projects-page">
        <Panel title="Project detail">
          <p className="projects-empty-note">Loading project detail…</p>
        </Panel>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="workspace-stack projects-page">
        <section className="page-header" aria-labelledby="project-detail-title">
          <div>
            <p className="eyebrow">Projects / Detail</p>
            <h1 id="project-detail-title" className="page-title">
              Project detail
            </h1>
          </div>
          <Button variant="secondary" icon={<RefreshCw aria-hidden="true" size={16} />} onClick={loadProject}>
            Retry
          </Button>
        </section>
        <Panel title="Project unavailable">
          <p className="projects-error-text">{state.error.message}</p>
        </Panel>
      </div>
    );
  }

  const { data } = state;
  const projectStatus = projectStatusDescriptor(data.project.status);
  const production = data.channels.find((channel) => channel.channel.name === "production");
  const trafficStatus = trafficStatusDescriptor(production?.currentDeployment);

  return (
    <div className="workspace-stack projects-page">
      <section className="page-header" aria-labelledby="project-detail-title">
        <div>
          <p className="eyebrow">Projects / {data.project.slug}</p>
          <h1 id="project-detail-title" className="page-title">
            {data.project.name}
          </h1>
          <p className="projects-page-subtitle">
            {data.project.repository.provider}/{data.project.repository.owner}/{data.project.repository.name} -
            default branch {data.project.defaultBranch}
          </p>
        </div>
        <div className="page-header__actions">
          <StatusPill tone={projectStatus.tone}>{projectStatus.label}</StatusPill>
          <StatusPill tone={trafficStatus.tone}>{trafficStatus.label}</StatusPill>
          <Button variant="secondary" icon={<Settings aria-hidden="true" size={16} />}>
            Settings
          </Button>
          <Link className="button button--primary projects-action-link" to={`/projects/${data.project.id}/release/production`}>
            <Rocket aria-hidden="true" size={16} />
            <span>Promote</span>
          </Link>
        </div>
      </section>

      <ProjectDetailSummaryStrip model={data} />

      <div className="projects-state-banner" role="status">
        <strong>Stale data guard</strong>
        <span>
          Detail snapshot loaded {formatDateTime(state.loadedAt)}. Deployment, route, and event reads should be refreshed
          before changing a channel.
        </span>
      </div>

      <EnvironmentMatrix model={data} />

      <section className="projects-detail-grid">
        <div className="workspace-stack">
          <AnalyticsPanel analytics={state.analytics} error={state.analyticsError} />
          <DeploymentHistory deployments={data.deployments} />
          <ProjectActivity events={data.recentEvents} />
        </div>
        <ProjectSettingsRail model={data} settings={state.settings} settingsError={state.settingsError} />
      </section>
    </div>
  );
}
