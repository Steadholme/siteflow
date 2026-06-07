import type { ProjectListReadModel, ProjectDetailReadModel } from "@domain/readModels";
import { Panel } from "@components/ui/Panel";

interface SummaryMetric {
  label: string;
  value: string | number;
  foot: string;
}

function protectedArtifactCount(projects: ProjectListReadModel["projects"]) {
  return projects.filter(
    (item) =>
      item.project.policy.retentionDays > 0 &&
      item.productionDeployment?.artifactVerificationStatus === "verified"
  ).length;
}

function routedRevisionCount(projects: ProjectListReadModel["projects"]) {
  return projects.filter((item) => item.productionDeployment?.routeRevisionStatus === "applied").length;
}

export function ProjectSummaryStrip({ model }: { model: ProjectListReadModel }) {
  const protectedArtifacts = protectedArtifactCount(model.projects);
  const routedRevisions = routedRevisionCount(model.projects);

  const metrics: SummaryMetric[] = [
    {
      label: "Active projects",
      value: model.summary.activeProjects,
      foot: `${model.summary.totalProjects} total in inventory`
    },
    {
      label: "Deployments today",
      value: model.summary.deploymentsToday,
      foot:
        model.summary.activeOperations > 0
          ? `${model.summary.activeOperations} active operation`
          : "No active operations"
    },
    {
      label: "Routing revisions",
      value: routedRevisions,
      foot:
        model.summary.routeDriftCount + model.summary.failedRouteCount > 0
          ? `${model.summary.routeDriftCount} drift, ${model.summary.failedRouteCount} failed`
          : "Current routes applied"
    },
    {
      label: "Protected artifacts",
      value: protectedArtifacts,
      foot: "Verified and inside retention policy"
    }
  ];

  return (
    <section className="summary-grid" aria-label="Project summary">
      {metrics.map((metric) => (
        <Panel key={metric.label} className="metric-panel">
          <span className="metric-label">{metric.label}</span>
          <strong className="metric-value">{metric.value}</strong>
          <span className="metric-foot">{metric.foot}</span>
        </Panel>
      ))}
    </section>
  );
}

export function ProjectDetailSummaryStrip({ model }: { model: ProjectDetailReadModel }) {
  const production = model.channels.find((channel) => channel.channel.name === "production");
  const productionDeployment = production?.currentDeployment;
  const activeRoute = model.routeEvidence.find((evidence) => evidence.routeRevision.status === "applied");

  const metrics: SummaryMetric[] = [
    {
      label: "Production",
      value: productionDeployment?.id ?? "none",
      foot: productionDeployment
        ? `commit ${productionDeployment.commitSha.slice(0, 8)}`
        : "No production deployment"
    },
    {
      label: "Framework",
      value: model.project.framework,
      foot: `Default branch ${model.project.defaultBranch}`
    },
    {
      label: "Routing revisions",
      value: activeRoute?.routeRevision.id ?? "pending",
      foot: activeRoute?.routeRevision.validationSummary ?? "Route evidence not applied yet"
    },
    {
      label: "Protected artifacts",
      value: `${model.project.policy.retentionDays}d`,
      foot: model.project.policy.requirePromotionReason
        ? "Promotion reason required"
        : "Promotion reason optional"
    }
  ];

  return (
    <section className="summary-grid" aria-label="Project detail summary">
      {metrics.map((metric) => (
        <Panel key={metric.label} className="metric-panel">
          <span className="metric-label">{metric.label}</span>
          <strong className="metric-value metric-value--compact">{metric.value}</strong>
          <span className="metric-foot">{metric.foot}</span>
        </Panel>
      ))}
    </section>
  );
}
