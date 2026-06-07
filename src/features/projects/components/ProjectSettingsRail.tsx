import { Database, Globe2, History, KeyRound, ShieldCheck, UserCog } from "lucide-react";

import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { ProjectDetailReadModel, ProjectSettingsReadModel } from "@domain/readModels";
import { formatDateTime, humanizeStatus } from "../projectPresentation";

function canManage(settings: ProjectSettingsReadModel | undefined) {
  return settings?.currentPermissions.includes("admin") ?? false;
}

export function ProjectSettingsRail({
  model,
  settings,
  settingsError
}: {
  model: ProjectDetailReadModel;
  settings?: ProjectSettingsReadModel;
  settingsError?: string;
}) {
  const { project } = model;
  const canManageAccess = canManage(settings);

  return (
    <aside className="projects-settings-rail" aria-label="Project settings">
      <Panel
        title="Repository"
        actions={<Database aria-hidden="true" className="projects-panel-icon" size={17} />}
      >
        <dl className="projects-description-list">
          <div>
            <dt>Provider</dt>
            <dd>{humanizeStatus(project.repository.provider)}</dd>
          </div>
          <div>
            <dt>Repository</dt>
            <dd>
              {project.repository.owner}/{project.repository.name}
            </dd>
          </div>
          <div>
            <dt>Default branch</dt>
            <dd className="projects-mono">{project.repository.defaultBranch}</dd>
          </div>
          <div>
            <dt>Installation</dt>
            <dd>{project.repository.installationId ?? "Not linked"}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Domains" actions={<Globe2 aria-hidden="true" className="projects-panel-icon" size={17} />}>
        <div className="projects-stack">
          {project.domains.map((domain) => (
            <div key={`${domain.hostname}-${domain.channel}`} className="projects-row-card">
              <div>
                <strong>{domain.hostname}</strong>
                <span className="table-subtext">
                  {humanizeStatus(domain.channel)} - checked {formatDateTime(domain.lastCheckedAt)}
                </span>
              </div>
              <StatusPill tone={domain.verified ? "success" : "warning"}>
                {domain.verified ? "Verified" : "Needs check"}
              </StatusPill>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Team access"
        eyebrow={canManageAccess ? "Admin controls enabled" : "Read-only view"}
        actions={<UserCog aria-hidden="true" className="projects-panel-icon" size={17} />}
      >
        <div className="projects-stack">
          {settingsError && <p className="projects-error-text">{settingsError}</p>}
          {(settings?.teamMembers ?? []).map((member) => (
            <div key={member.id} className="projects-row-card">
              <div>
                <strong>{member.actor.name}</strong>
                <span className="table-subtext">
                  {humanizeStatus(member.role)} - {member.permissions.join(", ")}
                </span>
                <span className="table-subtext">Updated {formatDateTime(member.updatedAt)}</span>
              </div>
              <StatusPill tone={member.permissions.includes("admin") ? "success" : "info"}>
                {member.permissions.includes("admin") ? "Admin" : "Scoped"}
              </StatusPill>
            </div>
          ))}
          {settings && settings.teamMembers.length === 0 && (
            <p className="projects-empty-note">No project team members have been recorded.</p>
          )}
          <button className="button button--secondary" type="button" disabled={!canManageAccess}>
            <span>Manage access</span>
          </button>
        </div>
      </Panel>

      <Panel
        title="Scoped API tokens"
        eyebrow="Prefix only"
        actions={<KeyRound aria-hidden="true" className="projects-panel-icon" size={17} />}
      >
        <div className="projects-stack">
          {(settings?.apiTokens ?? []).map((token) => (
            <div key={token.id} className="projects-row-card">
              <div>
                <strong>{token.name}</strong>
                <span className="table-subtext">
                  {token.tokenPrefix} - {token.scopes.join(", ")}
                </span>
                <span className="table-subtext">Updated {formatDateTime(token.updatedAt)}</span>
              </div>
              <StatusPill tone={token.status === "active" ? "success" : "warning"}>{humanizeStatus(token.status)}</StatusPill>
            </div>
          ))}
          {settings && settings.apiTokens.length === 0 && (
            <p className="projects-empty-note">No scoped API tokens have been created.</p>
          )}
          <button className="button button--secondary" type="button" disabled={!canManageAccess}>
            <span>Create token</span>
          </button>
        </div>
      </Panel>

      <Panel
        title="Secret policy"
        eyebrow="Redacted metadata only"
        actions={<KeyRound aria-hidden="true" className="projects-panel-icon" size={17} />}
      >
        <div className="projects-stack">
          <div className="projects-security-note">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>Secret values and provider payloads are redacted before this page renders.</span>
          </div>
          {project.secrets.map((secret) => (
            <div key={`${secret.scope}-${secret.key}`} className="projects-row-card">
              <div>
                <strong>{secret.key}</strong>
                <span className="table-subtext">
                  {secret.scope} - {secret.source} - {secret.fingerprint}
                </span>
                <span className="table-subtext">Updated {formatDateTime(secret.updatedAt)}</span>
              </div>
              <StatusPill tone="success">Protected</StatusPill>
            </div>
          ))}
          <dl className="projects-description-list projects-description-list--compact">
            <div>
              <dt>Required checks</dt>
              <dd>{project.policy.requiredChecks.map(humanizeStatus).join(", ")}</dd>
            </div>
            <div>
              <dt>Retention</dt>
              <dd>{project.policy.retentionDays} days</dd>
            </div>
            <div>
              <dt>CDN</dt>
              <dd>{project.policy.cdnEnabled ? "Enabled" : "Disabled"}</dd>
            </div>
          </dl>
        </div>
      </Panel>

      <Panel title="Audit history" actions={<History aria-hidden="true" className="projects-panel-icon" size={17} />}>
        <div className="projects-stack">
          {(settings?.auditEvents ?? model.recentEvents.auditEvents).slice(0, 5).map((event) => (
            <div key={event.id} className="projects-row-card">
              <div>
                <strong>{humanizeStatus(event.action.replace(".", " "))}</strong>
                <span className="table-subtext">{event.summary}</span>
                <span className="table-subtext">
                  {event.actor.name} - {formatDateTime(event.createdAt)}
                </span>
              </div>
              <StatusPill tone={event.action.includes("failed") ? "error" : "info"}>{humanizeStatus(event.targetType)}</StatusPill>
            </div>
          ))}
        </div>
      </Panel>
    </aside>
  );
}
