import { GitBranch, Route, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";

import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { ProjectDetailReadModel, ReleaseChannelReadModel } from "@domain/readModels";
import {
  artifactStatusDescriptor,
  cdnStatusDescriptor,
  compactId,
  formatDateTime,
  isDeploymentSummary,
  routeStatusDescriptor,
  trafficStatusDescriptor
} from "../projectPresentation";

interface EnvironmentCard {
  name: "Production" | "Staging" | "Previews";
  statusLabel: string;
  tone: "success" | "warning" | "error" | "info";
  deploymentId: string;
  deploymentTitle?: string;
  summary: string;
  facts: string[];
  action?: {
    label: string;
    to: string;
  };
}

function findChannel(model: ProjectDetailReadModel, name: string): ReleaseChannelReadModel | undefined {
  return model.channels.find((channel) => channel.channel.name === name);
}

function buildEnvironmentCards(model: ProjectDetailReadModel): EnvironmentCard[] {
  const production = findChannel(model, "production");
  const productionStatus = trafficStatusDescriptor(production?.currentDeployment);
  const deployments = model.deployments.filter(isDeploymentSummary);
  const stagingCandidate = deployments.find((deployment) => deployment.id !== production?.currentDeployment?.id);
  const stagingStatus = stagingCandidate
    ? artifactStatusDescriptor(stagingCandidate.artifactVerificationStatus)
    : { label: "No candidate", tone: "info" as const };
  const previewTone = model.project.policy.previewDeploymentsEnabled ? "success" : "info";

  return [
    {
      name: "Production",
      statusLabel: productionStatus.label,
      tone: productionStatus.tone,
      deploymentId: compactId(production?.currentDeployment?.id),
      deploymentTitle: production?.currentDeployment?.id,
      summary: production?.routeRevision?.validationSummary ?? "No production route revision is active.",
      facts: [
        `Route ${production?.routeRevision ? routeStatusDescriptor(production.routeRevision.status).label : "not configured"}`,
        `Artifact ${production?.currentDeployment ? artifactStatusDescriptor(production.currentDeployment.artifactVerificationStatus).label : "not available"}`,
        `CDN ${production?.cdnOperation ? cdnStatusDescriptor(production.cdnOperation.state).label : "not attached"}`
      ],
      action: {
        label: "Promote to production",
        to: `/projects/${encodeURIComponent(model.project.id)}/release/production`
      }
    },
    {
      name: "Staging",
      statusLabel: stagingStatus.label === "Verified" ? "Verified candidate" : stagingStatus.label,
      tone: stagingStatus.tone,
      deploymentId: compactId(stagingCandidate?.id),
      deploymentTitle: stagingCandidate?.id,
      summary: stagingCandidate
        ? `Candidate from ${stagingCandidate.branch} at ${stagingCandidate.commitSha.slice(0, 8)}.`
        : "No staging candidate has been recorded for this project.",
      facts: [
        `Deployment ${stagingCandidate?.status ? stagingCandidate.status : "none"}`,
        `Created ${formatDateTime(stagingCandidate?.createdAt)}`,
        "Promotion requires a fresh audit reason"
      ],
      action: stagingCandidate
        ? {
            label: "Open deployment",
            to: `/deployments/${encodeURIComponent(stagingCandidate.id)}`
          }
        : undefined
    },
    {
      name: "Previews",
      statusLabel: model.project.policy.previewDeploymentsEnabled ? "Preview policy enabled" : "Preview policy disabled",
      tone: previewTone,
      deploymentId: model.project.policy.previewDeploymentsEnabled ? "PR routes" : "P1 compatible",
      summary: model.project.policy.previewDeploymentsEnabled
        ? "Preview deployments can bind pull request routes when source events arrive."
        : "Preview read models are supported, but this fixture keeps preview routes disabled by policy.",
      facts: [
        `Retention ${model.project.policy.retentionDays} days`,
        `Required checks ${model.project.policy.requiredChecks.length}`,
        model.project.policy.cdnEnabled ? "CDN policy enabled" : "CDN policy disabled"
      ]
    }
  ];
}

export function EnvironmentMatrix({ model }: { model: ProjectDetailReadModel }) {
  const cards = buildEnvironmentCards(model);

  return (
    <section className="projects-environment-grid" aria-label="Environment matrix">
      {cards.map((card) => (
        <Panel
          key={card.name}
          className="projects-environment-card"
          eyebrow={`Track / ${card.name}`}
          title={card.name}
          actions={<StatusPill tone={card.tone}>{card.statusLabel}</StatusPill>}
        >
          <div className="projects-environment-card__body">
            <div className="projects-environment-card__headline">
              <span className="projects-mono" title={card.deploymentTitle}>
                {card.deploymentId}
              </span>
              {card.name === "Production" && <Route aria-hidden="true" size={18} />}
              {card.name === "Staging" && <GitBranch aria-hidden="true" size={18} />}
              {card.name === "Previews" && <ShieldCheck aria-hidden="true" size={18} />}
            </div>
            <p>{card.summary}</p>
            <dl className="projects-fact-list">
              {card.facts.map((fact) => (
                <div key={fact}>
                  <dt>{fact.split(" ")[0]}</dt>
                  <dd>{fact}</dd>
                </div>
              ))}
            </dl>
            {card.action ? (
              <Link className="button button--secondary projects-action-link" to={card.action.to}>
                {card.action.label}
              </Link>
            ) : null}
          </div>
        </Panel>
      ))}
    </section>
  );
}
