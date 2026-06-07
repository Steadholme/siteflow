import type { ChangeEvent } from "react";

import { Panel } from "@components/ui/Panel";
import type { Actor, ReleaseChannelName } from "@domain/siteflow";

interface AuditReasonFormProps {
  title: "Audit reason" | "Rollback reason";
  label: string;
  value: string;
  onChange: (value: string) => void;
  actor?: Actor;
  idempotencyKey: string;
  channel: ReleaseChannelName;
  currentDeploymentId?: string;
  targetDeploymentId?: string;
  routeConsequence: string;
}

export function AuditReasonForm({
  title,
  label,
  value,
  onChange,
  actor,
  idempotencyKey,
  channel,
  currentDeploymentId,
  targetDeploymentId,
  routeConsequence
}: AuditReasonFormProps) {
  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange(event.target.value);
  }

  return (
    <Panel title={title} eyebrow="Command boundary">
      <div className="release-form-stack">
        <label className="release-field">
          <span>{label}</span>
          <textarea
            value={value}
            onChange={handleChange}
            rows={5}
            placeholder="Explain the operator-visible reason for this traffic move."
          />
        </label>
        <dl className="release-command-list">
          <div>
            <dt>Actor</dt>
            <dd>{actor ? `${actor.name} (${actor.role})` : "Unknown operator"}</dd>
          </div>
          <div>
            <dt>Idempotency key</dt>
            <dd className="release-mono">{idempotencyKey}</dd>
          </div>
          <div>
            <dt>Channel move</dt>
            <dd className="release-mono">
              {channel}: {currentDeploymentId ?? "none"} -&gt; {targetDeploymentId ?? "none"}
            </dd>
          </div>
          <div>
            <dt>Route consequence</dt>
            <dd>{routeConsequence}</dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{value.trim() || "Waiting for operator reason"}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}
