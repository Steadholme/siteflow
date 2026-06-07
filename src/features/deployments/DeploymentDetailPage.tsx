import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { Panel } from "@components/ui/Panel";
import type { Deployment } from "@domain/siteflow";
import type { DeploymentDetailReadModel } from "@domain/readModels";
import { createSiteFlowClient, getDefaultSiteFlowClientMode, type SiteFlowClient } from "@lib/api";
import { ArtifactProof } from "./components/ArtifactProof";
import { BuildTimeline } from "./components/BuildTimeline";
import { DeploymentHeader } from "./components/DeploymentHeader";
import { EvidenceTable } from "./components/EvidenceTable";
import { LineageChain } from "./components/LineageChain";
import { LogPanel } from "./components/LogPanel";
import { RouteRevisionPanel } from "./components/RouteRevisionPanel";
import { cdnOperationFromDetail } from "./deploymentStatus";
import "./deployments.css";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; detail: DeploymentDetailReadModel }
  | { status: "error"; message: string };

type SiteFlowScenarioName = "healthy" | "emptyProjects" | "queued" | "routeDrift" | "staleCandidate" | "routeFailed" | "rollbackIneligible";

const fixtureScenarioNames: SiteFlowScenarioName[] = [
  "healthy",
  "emptyProjects",
  "queued",
  "routeDrift",
  "staleCandidate",
  "routeFailed",
  "rollbackIneligible"
];

function isSiteFlowScenarioName(value: string): value is SiteFlowScenarioName {
  return fixtureScenarioNames.some((scenario) => scenario === value);
}

function scenarioFromDeploymentId(deploymentId?: string): SiteFlowScenarioName {
  const candidate = deploymentId?.startsWith("dep-") ? deploymentId.slice(4) : deploymentId;

  if (candidate && candidate !== "emptyProjects" && isSiteFlowScenarioName(candidate)) {
    return candidate;
  }

  return "healthy";
}

function fixtureDeploymentId(deploymentId: string | undefined, scenario: SiteFlowScenarioName) {
  if (deploymentId?.startsWith("dep-")) {
    return deploymentId;
  }

  return `dep-${scenario}`;
}

export interface DeploymentDetailWorkspaceProps {
  detail: DeploymentDetailReadModel;
  onRefresh?: () => void;
}

export interface DeploymentDetailPageProps {
  client?: SiteFlowClient;
}

function isDeployment(value: unknown): value is Deployment {
  return Boolean(value && typeof value === "object" && typeof (value as Deployment).id === "string");
}

function normalizedLineage(detail: DeploymentDetailReadModel) {
  return isDeployment(detail.lineage.deployment)
    ? detail.lineage
    : {
        ...detail.lineage,
        deployment: detail.deployment
      };
}

export function DeploymentDetailWorkspace({ detail, onRefresh }: DeploymentDetailWorkspaceProps) {
  return (
    <div className="deployment-detail workspace-stack">
      <DeploymentHeader detail={detail} onRefresh={onRefresh} />
      <LineageChain lineage={normalizedLineage(detail)} />

      <div className="deployment-detail__grid">
        <div className="deployment-detail__main">
          <BuildTimeline detail={detail} />
          <EvidenceTable detail={detail} />
          <LogPanel logs={detail.logs} />
        </div>
        <aside className="deployment-detail__aside" aria-label="Deployment proof and route state">
          <ArtifactProof artifact={detail.lineage.artifact} />
          <RouteRevisionPanel routeRevision={detail.lineage.routeRevision} cdnOperation={cdnOperationFromDetail(detail)} />
        </aside>
      </div>
    </div>
  );
}

export function DeploymentDetailPage({ client: providedClient }: DeploymentDetailPageProps = {}) {
  const { deploymentId } = useParams();
  const defaultClientMode = useMemo(() => (providedClient ? "http" : getDefaultSiteFlowClientMode()), [providedClient]);
  const usesDefaultFixtureClient = !providedClient && defaultClientMode === "fixture";
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let mounted = true;
    const scenario = usesDefaultFixtureClient ? scenarioFromDeploymentId(deploymentId) : undefined;
    const resolvedDeploymentId = usesDefaultFixtureClient ? fixtureDeploymentId(deploymentId, scenario ?? "healthy") : deploymentId;
    const client = providedClient ?? createSiteFlowClient({ fixtureScenario: scenario });

    setLoadState({ status: "loading" });

    if (!resolvedDeploymentId) {
      setLoadState({ status: "error", message: "Deployment id is required." });
      return () => {
        mounted = false;
      };
    }

    client
      .getDeployment(resolvedDeploymentId)
      .then((detail) => {
        if (mounted) {
          setLoadState({ status: "ready", detail });
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : "Deployment could not be loaded."
          });
        }
      });

    return () => {
      mounted = false;
    };
  }, [deploymentId, providedClient, refreshKey, usesDefaultFixtureClient]);

  if (loadState.status === "loading") {
    return (
      <Panel title="Deployment evidence" eyebrow="Loading">
        <p className="deployment-empty">Loading deployment detail workspace…</p>
      </Panel>
    );
  }

  if (loadState.status === "error") {
    return (
      <Panel title="Deployment evidence" eyebrow="Unavailable">
        <p className="deployment-error">{loadState.message}</p>
      </Panel>
    );
  }

  return <DeploymentDetailWorkspace detail={loadState.detail} onRefresh={() => setRefreshKey((value) => value + 1)} />;
}
