import { GitBranch, GitCommit, PackageCheck, Rocket, Route } from "lucide-react";
import type { ReactNode } from "react";

import { Panel } from "@components/ui/Panel";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";
import type { DeploymentLineageReadModel } from "@domain/readModels";
import {
  artifactVerificationLabel,
  artifactVerificationTone,
  buildJobStatusLabel,
  buildJobStatusTone,
  deploymentStatusLabel,
  deploymentStatusTone,
  formatBytes,
  formatDuration,
  routeRevisionStatusLabel,
  routeRevisionStatusTone,
  shortenSha
} from "../deploymentStatus";

interface LineageStep {
  id: string;
  station: string;
  label: string;
  title: string;
  meta: string;
  status: string;
  tone: StatusTone;
  icon: ReactNode;
}

export interface LineageChainProps {
  lineage: DeploymentLineageReadModel;
}

export function LineageChain({ lineage }: LineageChainProps) {
  const { sourceEvent, buildJob, artifact, deployment, routeRevision } = lineage;
  const steps: LineageStep[] = [
    {
      id: "source_event",
      station: "Station 1",
      label: "Source event",
      title: sourceEvent.kind,
      meta: `${sourceEvent.branch} ${shortenSha(sourceEvent.commitSha)} / delivery ${sourceEvent.providerDeliveryId}`,
      status: sourceEvent.status === "accepted" ? "Accepted" : sourceEvent.status,
      tone: sourceEvent.status === "accepted" ? "success" : "error",
      icon: <GitCommit aria-hidden="true" size={18} />
    },
    {
      id: "build_job",
      station: "Station 2",
      label: "Build job",
      title: buildJob.id,
      meta: `${buildJob.framework} / ${formatDuration(buildJob.startedAt, buildJob.finishedAt)}`,
      status: buildJobStatusLabel(buildJob.status),
      tone: buildJobStatusTone(buildJob.status),
      icon: <GitBranch aria-hidden="true" size={18} />
    },
    {
      id: "artifact",
      station: "Station 3",
      label: "Artifact",
      title: shortenSha(artifact.manifest.checksum, 16),
      meta: `${artifact.manifest.fileCount} files / ${formatBytes(artifact.manifest.totalBytes)}`,
      status: artifactVerificationLabel(artifact.verificationStatus),
      tone: artifactVerificationTone(artifact.verificationStatus),
      icon: <PackageCheck aria-hidden="true" size={18} />
    },
    {
      id: "deployment",
      station: "Station 4",
      label: "Deployment",
      title: deployment.id,
      meta: `${deployment.environment} / ${formatDuration(deployment.createdAt, deployment.readyAt)}`,
      status: deploymentStatusLabel(deployment.status),
      tone: deploymentStatusTone(deployment.status),
      icon: <Rocket aria-hidden="true" size={18} />
    },
    {
      id: "route_revision",
      station: "Station 5",
      label: "Route revision",
      title: routeRevision?.id ?? "Not created",
      meta: routeRevision ? `${routeRevision.channel} / previous ${routeRevision.previousDeploymentId ?? "none"}` : "Waiting for route planner",
      status: routeRevisionStatusLabel(routeRevision?.status),
      tone: routeRevisionStatusTone(routeRevision?.status),
      icon: <Route aria-hidden="true" size={18} />
    }
  ];

  return (
    <Panel title="Deployment lineage" eyebrow="Movement line" className="deployment-lineage-panel">
      <div
        className="deployment-lineage__scroll"
        role="region"
        aria-label="Scrollable deployment lineage"
        tabIndex={0}
      >
        <ol className="deployment-lineage" aria-label="Deployment lineage">
          {steps.map((step) => (
            <li key={step.id} className="deployment-lineage__step" data-lineage-id={step.id}>
              <div className="deployment-lineage__station-marker">{step.icon}</div>
              <div>
                <span className="deployment-lineage__station">{step.station}</span>
                <span className="deployment-lineage__label">{step.label}</span>
                <strong className="deployment-lineage__title">{step.title}</strong>
                <span className="deployment-lineage__meta">{step.meta}</span>
              </div>
              <StatusPill tone={step.tone}>{step.status}</StatusPill>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
