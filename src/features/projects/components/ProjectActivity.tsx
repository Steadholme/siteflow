import { Bell } from "lucide-react";

import { Button } from "@components/ui/Button";
import { Panel } from "@components/ui/Panel";
import { Timeline, type TimelineItem } from "@components/ui/Timeline";
import type { AuditEvent, ChannelEvent, SourceEvent } from "@domain/siteflow";
import type { EventFeedReadModel } from "@domain/readModels";
import { formatDateTime, humanizeStatus, shortCommit } from "../projectPresentation";

function hasStringId(value: unknown): value is { id: string } {
  return value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

function isSourceEvent(value: unknown): value is SourceEvent {
  return hasStringId(value) && typeof (value as SourceEvent).status === "string" && typeof (value as SourceEvent).disposition === "string";
}

function isChannelEvent(value: unknown): value is ChannelEvent {
  return hasStringId(value) && typeof (value as ChannelEvent).action === "string" && typeof (value as ChannelEvent).channel === "string";
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return hasStringId(value) && typeof (value as AuditEvent).action === "string" && typeof (value as AuditEvent).summary === "string";
}

function buildTimelineItems(events: EventFeedReadModel): TimelineItem[] {
  const sourceItems: TimelineItem[] = events.sourceEvents.filter(isSourceEvent).map((event) => ({
    id: event.id,
    title: `Source event ${humanizeStatus(event.status)}`,
    meta: `${event.branch} at ${shortCommit(event.commitSha)}`,
    description: `${event.disposition.replace(/_/g, " ")} by ${event.actor.name} - ${formatDateTime(event.receivedAt)}`,
    tone: event.status === "accepted" ? "success" : event.status === "ignored" ? "info" : "error"
  }));

  const channelItems: TimelineItem[] = events.channelEvents.filter(isChannelEvent).map((event) => ({
    id: event.id,
    title: `${humanizeStatus(event.action)} ${humanizeStatus(event.channel)}`,
    meta: humanizeStatus(event.status),
    description: `${event.reason} - ${formatDateTime(event.createdAt)}`,
    tone: event.status === "succeeded" ? "success" : event.status === "failed" ? "error" : "warning"
  }));

  const auditItems: TimelineItem[] = events.auditEvents.filter(isAuditEvent).map((event) => ({
    id: event.id,
    title: humanizeStatus(event.action.replace(".", " ")),
    meta: event.actor.name,
    description: `${event.summary} - ${formatDateTime(event.createdAt)}`,
    tone: event.action.includes("failed") ? "error" : "info"
  }));

  return [...sourceItems, ...channelItems, ...auditItems];
}

export function ProjectActivity({ events, title = "Recent events" }: { events: EventFeedReadModel; title?: string }) {
  const timelineItems = buildTimelineItems(events);

  return (
    <Panel
      title={title}
      eyebrow="Control-plane activity"
      actions={
        <Button variant="ghost" icon={<Bell aria-hidden="true" size={15} />}>
          Watch
        </Button>
      }
    >
      {timelineItems.length > 0 ? (
        <Timeline items={timelineItems} ariaLabel={title} />
      ) : (
        <p className="projects-empty-note">No control-plane events have been recorded yet.</p>
      )}
    </Panel>
  );
}
