import { Panel } from "@components/ui/Panel";
import { Timeline, type TimelineItem } from "@components/ui/Timeline";
import type { DeploymentDetailReadModel } from "@domain/readModels";
import {
  artifactVerificationLabel,
  artifactVerificationTone,
  buildJobStatusLabel,
  buildJobStatusTone,
  cdnOperationFromDetail,
  cdnOperationStateLabel,
  cdnOperationStateTone,
  formatDateTime,
  routeRevisionStatusLabel,
  routeRevisionStatusTone
} from "../deploymentStatus";

export interface BuildTimelineProps {
  detail: DeploymentDetailReadModel;
}

export function BuildTimeline({ detail }: BuildTimelineProps) {
  const { lineage, routeEvidence } = detail;
  const { sourceEvent, buildJob, artifact, routeRevision } = lineage;
  const cdnOperation = cdnOperationFromDetail(detail);
  const previousKnownGood = routeEvidence?.previousKnownGoodDeploymentId;
  const items: TimelineItem[] = [
    {
      id: "source",
      title: "Webhook accepted",
      meta: formatDateTime(sourceEvent.receivedAt),
      description: `${sourceEvent.providerDeliveryId} / ${sourceEvent.disposition}`,
      tone: sourceEvent.status === "accepted" ? "success" : "error"
    },
    {
      id: "build",
      title: buildJobStatusLabel(buildJob.status),
      meta: formatDateTime(buildJob.finishedAt ?? buildJob.startedAt ?? buildJob.queuedAt),
      description: `${buildJob.installCommand} -> ${buildJob.buildCommand} / ${buildJob.workerId ?? "waiting for worker lease"}`,
      tone: buildJobStatusTone(buildJob.status)
    },
    {
      id: "artifact",
      title: artifactVerificationLabel(artifact.verificationStatus),
      meta: formatDateTime(artifact.verifiedAt ?? artifact.createdAt),
      description: `${artifact.storageStatus} / ${artifact.manifest.fileCount} manifest entries`,
      tone: artifactVerificationTone(artifact.verificationStatus)
    },
    {
      id: "route",
      title: routeRevisionStatusLabel(routeRevision?.status),
      meta: formatDateTime(routeRevision?.appliedAt ?? routeRevision?.createdAt),
      description: routeRevision
        ? `${routeRevision.validationSummary} ${previousKnownGood ? `Previous known-good ${previousKnownGood} preserved.` : ""}`
        : "Route revision waits for a verified artifact.",
      tone: routeRevisionStatusTone(routeRevision?.status)
    },
    {
      id: "cdn",
      title: cdnOperationStateLabel(cdnOperation?.state),
      meta: formatDateTime(cdnOperation?.finishedAt ?? cdnOperation?.requestedAt),
      description: cdnOperation?.message ?? "CDN operation is separate from route application.",
      tone: cdnOperationStateTone(cdnOperation?.state)
    }
  ];

  return (
    <Panel title="Build timeline" eyebrow="Crew log / Source to traffic">
      <Timeline items={items} ariaLabel="Build and routing timeline" />
    </Panel>
  );
}
