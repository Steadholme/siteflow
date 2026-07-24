import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Rocket } from "lucide-react";
import { useParams } from "react-router-dom";

import { Button } from "@components/ui/Button";
import { Panel } from "@components/ui/Panel";
import type { ReleaseChannelName } from "@domain/siteflow";
import type { CommandResultReadModel, ReleaseConsoleReadModel } from "@domain/readModels";
import { createSiteFlowClient, getDefaultSiteFlowClientMode, SiteFlowHttpError, type SiteFlowClient } from "@lib/api";
import { AuditReasonForm } from "./components/AuditReasonForm";
import { CandidatePanel } from "./components/CandidatePanel";
import { parseReleaseEvidence, ReleaseEvidenceForm, releaseEvidenceFailure, releaseEvidenceRequest } from "./components/ReleaseEvidenceForm";
import { ReleaseHeader } from "./components/ReleaseHeader";
import { RoutePreview } from "./components/RoutePreview";
import { evaluateSafetyGate, normalizeSafetyChecks, SafetyChecks } from "./components/SafetyChecks";
import { StickyActionBar, type CommandState } from "./components/StickyActionBar";

interface ReleaseConsolePageProps {
  client?: SiteFlowClient;
  projectId?: string;
  channel?: ReleaseChannelName;
  initialReason?: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: ReleaseConsoleReadModel; loadedAt: string }
  | {
      status: "error";
      kind: "unauthorized" | "forbidden" | "api";
      eyebrow: string;
      message: string;
      guidance?: string;
    };

const releaseChannels = ["production", "staging", "preview"] as const;
const defaultFixtureProjectId = "project-acme-dashboard";

function isReleaseChannelName(value: string | undefined): value is ReleaseChannelName {
  return releaseChannels.some((channel) => channel === value);
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown release console error.";
}

function toLoadError(error: unknown): Extract<LoadState, { status: "error" }> {
  if (error instanceof SiteFlowHttpError && error.isUnauthorized) {
    return {
      status: "error",
      kind: "unauthorized",
      eyebrow: "Sign-in required (401)",
      message: error.message,
      guidance: "Your operator session is missing or expired. Sign in again through the gateway, then retry."
    };
  }

  if (error instanceof SiteFlowHttpError && error.isForbidden) {
    return {
      status: "error",
      kind: "forbidden",
      eyebrow: "Access denied (403)",
      message: error.message,
      guidance: "Your gateway identity does not include the required permission for this console."
    };
  }

  return {
    status: "error",
    kind: "api",
    eyebrow: "API error",
    message: toErrorMessage(error)
  };
}

function toCommandErrorMessage(error: unknown) {
  if (error instanceof SiteFlowHttpError && error.isUnauthorized) {
    return `Sign-in required (401): ${error.message}`;
  }

  if (error instanceof SiteFlowHttpError && error.isForbidden) {
    return `Access denied (403): ${error.message}`;
  }

  return toErrorMessage(error);
}

function commandMessage(result: CommandResultReadModel) {
  return result.operationId ? `${result.message} Operation ${result.operationId}.` : result.message;
}

function fixtureProjectIdForRoute(projectId: string) {
  return projectId === "docs-portal" ? defaultFixtureProjectId : projectId;
}

export function ReleaseConsolePage({ client, projectId, channel, initialReason = "" }: ReleaseConsolePageProps) {
  const params = useParams();
  const defaultClientMode = useMemo(() => (client ? "http" : getDefaultSiteFlowClientMode()), [client]);
  const usesDefaultFixtureClient = !client && defaultClientMode === "fixture";
  const resolvedProjectId = projectId ?? params.projectId ?? defaultFixtureProjectId;
  const requestProjectId = usesDefaultFixtureClient ? fixtureProjectIdForRoute(resolvedProjectId) : resolvedProjectId;
  const resolvedChannel = channel ?? (isReleaseChannelName(params.channel) ? params.channel : "production");
  const resolvedClient = useMemo(() => client ?? createSiteFlowClient(), [client]);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [reason, setReason] = useState(initialReason);
  const [releaseEvidencePathValue, setReleaseEvidencePathValue] = useState("");
  const [releaseEvidenceText, setReleaseEvidenceText] = useState("");
  const [commandState, setCommandState] = useState<CommandState>({ status: "idle" });
  const [reloading, setReloading] = useState(false);
  const parsedReleaseEvidence = useMemo(() => parseReleaseEvidence(releaseEvidenceText), [releaseEvidenceText]);

  useEffect(() => {
    let cancelled = false;

    setLoadState({ status: "loading" });
    resolvedClient
      .getReleaseConsole(requestProjectId, resolvedChannel)
      .then((data) => {
        if (!cancelled) {
          setLoadState({ status: "ready", data, loadedAt: new Date().toISOString() });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadState(toLoadError(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestProjectId, resolvedChannel, resolvedClient]);

  async function reloadConsoleState() {
    setReloading(true);
    if (loadState.status === "error") {
      setLoadState({ status: "loading" });
    }

    try {
      const data = await resolvedClient.getReleaseConsole(requestProjectId, resolvedChannel);
      setLoadState({ status: "ready", data, loadedAt: new Date().toISOString() });
    } catch (error: unknown) {
      setLoadState(toLoadError(error));
    } finally {
      setReloading(false);
    }
  }

  if (loadState.status === "loading") {
    return (
      <div className="workspace-stack release-page">
        <header className="page-header release-header">
          <div className="release-header__title">
            <p className="eyebrow">Gate House / Promotion</p>
            <h1 className="page-title">Release console</h1>
          </div>
        </header>
        <Panel title="Release console">
          <p className="release-muted">Loading promote workflow…</p>
        </Panel>
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="workspace-stack release-page">
        <header className="page-header release-header">
          <div className="release-header__title">
            <p className="eyebrow">Gate House / Promotion</p>
            <h1 className="page-title">Promote deployment</h1>
          </div>
        </header>
        <Panel title="Release console" eyebrow={loadState.eyebrow}>
          <div role="alert" className="release-alert release-alert--error">
            <strong>{loadState.eyebrow}</strong>
            <span>{loadState.message}</span>
            {loadState.guidance && <span>{loadState.guidance}</span>}
          </div>
          <div className="release-retry">
            <Button variant="secondary" disabled={reloading} onClick={reloadConsoleState}>
              Retry
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  const { data } = loadState;
  const actor = data.recentChannelEvents[0]?.actor ?? data.auditEvents[0]?.actor;
  const idempotencyKey = `promote-${data.project.id}-${data.channel}-${data.candidateDeployment?.id ?? "pending"}`;
  const safetyChecks = normalizeSafetyChecks(data.safetyChecks, data.routePreview?.checks);
  const staleCandidate = safetyChecks.find((check) => check.id === "check-candidate-freshness" && check.status !== "pass");
  const requiresReleaseEvidence = data.channel === "production";
  const releaseEvidence = requiresReleaseEvidence ? releaseEvidenceRequest(releaseEvidencePathValue, parsedReleaseEvidence) : undefined;
  const gate = evaluateSafetyGate({
    checks: safetyChecks,
    auditReason: reason,
    extraRequirements: [
      {
        label: "Candidate deployment",
        passed: Boolean(data.candidateDeployment),
        failure: "Candidate deployment is required before promotion."
      },
      {
        label: "Current channel target",
        passed: Boolean(data.currentDeployment),
        failure: "Current channel target must remain protected before promotion."
      },
      {
        label: "Route preview",
        passed: Boolean(data.routePreview),
        failure: "Route preview must be generated before promotion."
      },
      ...(requiresReleaseEvidence
        ? [
            {
              label: "Release evidence",
              passed: Boolean(releaseEvidence),
              failure: releaseEvidenceFailure(releaseEvidencePathValue, parsedReleaseEvidence)
            }
          ]
        : [])
    ]
  });
  const routeConsequence = data.routePreview
    ? `Queue route revision ${data.routePreview.routeRevision.id} for ${data.channel}; CDN work remains observable separately.`
    : `Queue a route revision for ${data.channel} after dry-run passes.`;
  const actionLabel = `Promote ${data.channel} from ${data.currentDeployment?.id ?? "none"} to ${
    data.candidateDeployment?.id ?? "none"
  } and queue route apply`;

  async function submitPromotion() {
    if (!data.candidateDeployment || !actor) {
      setCommandState({ status: "validationError", message: "Promotion requires a candidate deployment and actor." });
      return;
    }

    if (!gate.canSubmit) {
      setCommandState({ status: "validationError", message: gate.blockingReasons[0] ?? "Promotion failed validation." });
      return;
    }

    setCommandState({ status: "submitting", message: "Submitting promote command." });

    try {
      const result = await resolvedClient.promoteDeployment({
        projectId: data.project.id,
        channel: data.channel,
        targetDeploymentId: data.candidateDeployment.id,
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
      setCommandState({ status: "apiError", message: toCommandErrorMessage(error) });
    }
  }

  return (
    <div className="workspace-stack release-page">
      <ReleaseHeader
        mode="promote"
        projectName={data.project.name}
        channel={data.channel}
        currentDeployment={data.currentDeployment}
        targetDeployment={data.candidateDeployment}
        loadedAt={loadState.loadedAt}
        reloading={reloading}
        onReload={reloadConsoleState}
      />
      {staleCandidate && (
        <div role="alert" className="release-alert release-alert--error">
          <AlertTriangle size={18} aria-hidden="true" />
          <strong>Stale candidate detected</strong>
          <span>{staleCandidate.summary}</span>
        </div>
      )}
      <div className="release-grid gate-house">
        <section className="release-stack gate-house__facts" aria-label="Promotion facts">
          <CandidatePanel channel={data.channel} currentDeployment={data.currentDeployment} candidateDeployment={data.candidateDeployment} />
          <SafetyChecks checks={safetyChecks} />
          <RoutePreview preview={data.routePreview} />
        </section>
        <aside className="release-stack gate-house__command" aria-label="Promotion command">
          <AuditReasonForm
            title="Audit reason"
            label="Promotion reason"
            value={reason}
            onChange={setReason}
            actor={actor}
            idempotencyKey={idempotencyKey}
            channel={data.channel}
            currentDeploymentId={data.currentDeployment?.id}
            targetDeploymentId={data.candidateDeployment?.id}
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
            actionIcon={<Rocket size={16} aria-hidden="true" />}
            buttonVariant="primary"
            disabled={!gate.canSubmit}
            blockingReasons={gate.blockingReasons}
            commandState={commandState}
            onSubmit={submitPromotion}
          />
        </aside>
      </div>
    </div>
  );
}
