import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useParams } from "react-router-dom";

import { Panel } from "@components/ui/Panel";
import type { ReleaseChannelName } from "@domain/siteflow";
import type { CommandResultReadModel, RollbackConsoleReadModel } from "@domain/readModels";
import { createSiteFlowClient, getDefaultSiteFlowClientMode, type SiteFlowClient } from "@lib/api";
import { AuditReasonForm } from "./components/AuditReasonForm";
import { DeploymentComparison } from "./components/DeploymentComparison";
import { parseReleaseEvidence, ReleaseEvidenceForm, releaseEvidenceFailure, releaseEvidenceRequest } from "./components/ReleaseEvidenceForm";
import { ReleaseHeader } from "./components/ReleaseHeader";
import { RoutePreview } from "./components/RoutePreview";
import { RollbackTimeline, isRollbackTargetSelectable } from "./components/RollbackTimeline";
import { evaluateSafetyGate, normalizeSafetyChecks, SafetyChecks } from "./components/SafetyChecks";
import { StickyActionBar, type CommandState } from "./components/StickyActionBar";

interface RollbackConsolePageProps {
  client?: SiteFlowClient;
  projectId?: string;
  channel?: ReleaseChannelName;
  initialReason?: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: RollbackConsoleReadModel }
  | { status: "error"; message: string };

const releaseChannels = ["production", "staging", "preview"] as const;
const defaultFixtureProjectId = "project-acme-dashboard";

function isReleaseChannelName(value: string | undefined): value is ReleaseChannelName {
  return releaseChannels.some((channel) => channel === value);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown rollback console error.";
}

function commandMessage(result: CommandResultReadModel) {
  return result.operationId ? `${result.message} Operation ${result.operationId}.` : result.message;
}

function fixtureProjectIdForRoute(projectId: string) {
  return projectId === "docs-portal" ? defaultFixtureProjectId : projectId;
}

export function RollbackConsolePage({ client, projectId, channel, initialReason = "" }: RollbackConsolePageProps) {
  const params = useParams();
  const defaultClientMode = useMemo(() => (client ? "http" : getDefaultSiteFlowClientMode()), [client]);
  const usesDefaultFixtureClient = !client && defaultClientMode === "fixture";
  const resolvedProjectId = projectId ?? params.projectId ?? defaultFixtureProjectId;
  const requestProjectId = usesDefaultFixtureClient ? fixtureProjectIdForRoute(resolvedProjectId) : resolvedProjectId;
  const resolvedChannel = channel ?? (isReleaseChannelName(params.channel) ? params.channel : "production");
  const resolvedClient = useMemo(() => client ?? createSiteFlowClient(), [client]);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [selectedTargetId, setSelectedTargetId] = useState<string | undefined>();
  const [reason, setReason] = useState(initialReason);
  const [releaseEvidencePathValue, setReleaseEvidencePathValue] = useState("");
  const [releaseEvidenceText, setReleaseEvidenceText] = useState("");
  const [commandState, setCommandState] = useState<CommandState>({ status: "idle" });
  const parsedReleaseEvidence = useMemo(() => parseReleaseEvidence(releaseEvidenceText), [releaseEvidenceText]);

  useEffect(() => {
    let cancelled = false;

    setLoadState({ status: "loading" });
    resolvedClient
      .getRollbackConsole(requestProjectId, resolvedChannel)
      .then((data) => {
        if (!cancelled) {
          setSelectedTargetId(data.selectedTargetId ?? data.targets[0]?.deployment.id);
          setLoadState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadState({ status: "error", message: toErrorMessage(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestProjectId, resolvedChannel, resolvedClient]);

  if (loadState.status === "loading") {
    return (
      <div className="workspace-stack release-page">
        <Panel title="Rollback console">
          <p className="release-muted">Loading rollback workflow…</p>
        </Panel>
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="workspace-stack release-page">
        <Panel title="Rollback console">
          <div role="alert" className="release-alert release-alert--error">
            <strong>API error</strong>
            <span>{loadState.message}</span>
          </div>
        </Panel>
      </div>
    );
  }

  const { data } = loadState;
  const selectedTarget = data.targets.find((target) => target.deployment.id === selectedTargetId);
  const actor = data.recentChannelEvents[0]?.actor ?? data.auditEvents[0]?.actor;
  const idempotencyKey = `rollback-${data.project.id}-${data.channel}-${selectedTarget?.deployment.id ?? "pending"}`;
  const targetSelectable = isRollbackTargetSelectable(selectedTarget);
  const selectedSafetyChecks = normalizeSafetyChecks(selectedTarget?.safetyChecks);
  const requiresReleaseEvidence = data.channel === "production";
  const releaseEvidence = requiresReleaseEvidence ? releaseEvidenceRequest(releaseEvidencePathValue, parsedReleaseEvidence) : undefined;
  const gate = evaluateSafetyGate({
    checks: selectedSafetyChecks,
    auditReason: reason,
    extraRequirements: [
      {
        label: "Rollback target",
        passed: Boolean(selectedTarget),
        failure: "Select a rollback target."
      },
      {
        label: "Rollback target eligibility",
        passed: targetSelectable,
        failure: selectedTarget?.disabledReason ?? "Rollback target is not eligible."
      },
      {
        label: "Current target protection",
        passed: Boolean(data.currentDeployment && data.routePreview?.previousKnownGoodDeploymentId),
        failure: "Current target must remain protected before rollback."
      },
      ...(requiresReleaseEvidence
        ? [
            {
              label: "Release evidence",
              passed: Boolean(releaseEvidence),
              failure: releaseEvidenceFailure(releaseEvidencePathValue, parsedReleaseEvidence, "rollback")
            }
          ]
        : [])
    ]
  });
  const routeConsequence = data.routePreview
    ? `Queue route revision ${data.routePreview.routeRevision.id} for ${data.channel} and preserve current deployment ${data.currentDeployment?.id ?? "unknown"}.`
    : `Queue a rollback route revision for ${data.channel}.`;
  const actionLabel = `Rollback ${data.channel} from ${data.currentDeployment?.id ?? "none"} to ${
    selectedTarget?.deployment.id ?? "none"
  } without rebuild and queue route apply`;

  async function submitRollback() {
    if (!selectedTarget || !actor) {
      setCommandState({ status: "validationError", message: "Rollback requires a selected target and actor." });
      return;
    }

    if (!gate.canSubmit) {
      setCommandState({ status: "validationError", message: gate.blockingReasons[0] ?? "Rollback failed validation." });
      return;
    }

    setCommandState({ status: "submitting", message: "Submitting rollback command." });

    try {
      const result = await resolvedClient.rollbackDeployment({
        projectId: data.project.id,
        channel: data.channel,
        currentDeploymentId: data.currentDeployment?.id,
        targetDeploymentId: selectedTarget.deployment.id,
        actor,
        reason: reason.trim(),
        idempotencyKey,
        ...(releaseEvidence ? { releaseEvidence } : {})
      });

      setCommandState(
        result.status === "accepted"
          ? { status: "success", message: commandMessage(result), operationId: result.operationId }
          : { status: "validationError", message: result.message }
      );
      if (result.status === "accepted") {
        setReleaseEvidenceText("");
      }
    } catch (error: unknown) {
      setCommandState({ status: "apiError", message: toErrorMessage(error) });
    }
  }

  return (
    <div className="workspace-stack release-page">
      <ReleaseHeader
        mode="rollback"
        projectName={data.project.name}
        channel={data.channel}
        currentDeployment={data.currentDeployment}
        targetDeployment={selectedTarget?.deployment}
      />
      {selectedTarget && !targetSelectable && (
        <div role="alert" className="release-alert release-alert--error">
          <AlertTriangle size={18} aria-hidden="true" />
          <strong>Rollback target ineligible</strong>
          <span>{selectedTarget.disabledReason ?? "The selected deployment failed rollback safety checks."}</span>
        </div>
      )}
      <main className="release-grid">
        <section className="release-stack">
          <RollbackTimeline targets={data.targets} selectedTargetId={selectedTargetId} onSelectTarget={setSelectedTargetId} />
          <DeploymentComparison
            currentDeployment={data.currentDeployment}
            targetDeployment={selectedTarget?.deployment}
            routePreview={data.routePreview}
          />
          <RoutePreview preview={data.routePreview} />
        </section>
        <aside className="release-stack">
          <SafetyChecks checks={selectedSafetyChecks} />
          <AuditReasonForm
            title="Rollback reason"
            label="Rollback reason"
            value={reason}
            onChange={setReason}
            actor={actor}
            idempotencyKey={idempotencyKey}
            channel={data.channel}
            currentDeploymentId={data.currentDeployment?.id}
            targetDeploymentId={selectedTarget?.deployment.id}
            routeConsequence={routeConsequence}
          />
          <ReleaseEvidenceForm
            required={requiresReleaseEvidence}
            evidencePath={releaseEvidencePathValue}
            evidenceText={releaseEvidenceText}
            parsedEvidence={parsedReleaseEvidence}
            onEvidencePathChange={setReleaseEvidencePathValue}
            onEvidenceTextChange={setReleaseEvidenceText}
          />
          <StickyActionBar
            actionLabel={actionLabel}
            actionIcon={<RotateCcw size={16} aria-hidden="true" />}
            buttonVariant="danger"
            disabled={!gate.canSubmit}
            blockingReasons={gate.blockingReasons}
            commandState={commandState}
            onSubmit={submitRollback}
          />
        </aside>
      </main>
    </div>
  );
}
