import { type ChangeEvent } from "react";

import { Panel } from "@components/ui/Panel";
import type { ReleaseEvidenceBundleRequest } from "@lib/api";
import { redactString } from "@lib/redaction";

export type ParsedReleaseEvidence =
  | { status: "empty" }
  | { status: "valid"; bundle: Record<string, unknown>; evidencePath?: string }
  | { status: "invalid"; message: string };

const releaseEvidenceBundleName = "siteflow-release-evidence-bundle";
const releaseEvidenceCheckName = "siteflow-release-evidence-bundle-check";
const requiredReleaseEvidenceStatusFields = [
  ["releaseGateStatus", "release gate"],
  ["dockerBuildRehearsalStatus", "Docker build rehearsal"],
  ["postgresRehearsalStatus", "Postgres rehearsal"],
  ["artifactEvidenceStatus", "artifact evidence"],
  ["sourceProviderEvidenceStatus", "source provider evidence"],
  ["backupEvidenceStatus", "backup evidence"],
  ["observabilityEvidenceStatus", "observability evidence"],
  ["operatorAccessEvidenceStatus", "operator access evidence"],
  ["nonSessionCredentialEvidenceStatus", "non-session credential evidence"],
  ["ingressEvidenceStatus", "ingress evidence"],
  ["upgradeRollbackDrillStatus", "upgrade/rollback drill"]
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function releaseEvidenceTargetEnvironment(bundle: Record<string, unknown>) {
  const release = isRecord(bundle.release) ? bundle.release : undefined;
  return stringValue(bundle.targetEnvironment) ?? stringValue(release?.targetEnvironment);
}

function releaseEvidenceBundleCandidate(parsed: Record<string, unknown>) {
  if (isRecord(parsed.bundle)) {
    return parsed.bundle;
  }

  if (isRecord(parsed.evidence)) {
    return parsed.evidence;
  }

  return parsed.name === releaseEvidenceBundleName ? parsed : undefined;
}

function releaseEvidenceCheckCandidate(parsed: Record<string, unknown>) {
  const candidates = [
    parsed,
    isRecord(parsed.check) ? parsed.check : undefined,
    isRecord(parsed.releaseEvidenceCheck) ? parsed.releaseEvidenceCheck : undefined,
    isRecord(parsed.releaseEvidenceResult) ? parsed.releaseEvidenceResult : undefined,
    isRecord(parsed.result) ? parsed.result : undefined
  ];

  return candidates.find((candidate) => candidate?.name === releaseEvidenceCheckName);
}

function isPassingEvidenceStatus(value: unknown) {
  const status = stringValue(value);
  return status === "pass" || status === "passed";
}

function releaseEvidenceSelectedEvidenceFailure(check: Record<string, unknown>) {
  const selectedEvidence = isRecord(check.selectedEvidence) ? check.selectedEvidence : undefined;

  if (!selectedEvidence) {
    return "Release evidence checker result must include selected evidence summary.";
  }

  if (
    !stringValue(selectedEvidence.releaseCommitRef) ||
    !stringValue(selectedEvidence.repository) ||
    !stringValue(selectedEvidence.branch)
  ) {
    return "Release evidence checker result must include release commit, repository, and branch.";
  }

  if (!stringValue(selectedEvidence.releaseImageDigest)) {
    return "Release evidence checker result must include release image digest.";
  }

  const missingPassedEvidence = requiredReleaseEvidenceStatusFields
    .filter(([field]) => !isPassingEvidenceStatus(selectedEvidence[field]))
    .map(([, label]) => label)
    .slice(0, 5);

  if (missingPassedEvidence.length > 0) {
    return `Release evidence checker selected evidence must show passed ${missingPassedEvidence.join(", ")}.`;
  }

  return undefined;
}

function releaseEvidenceBundleIdentity(bundle: Record<string, unknown>) {
  const release = isRecord(bundle.release) ? bundle.release : undefined;

  return {
    commitRef: stringValue(release?.commitRef) ?? stringValue(release?.commitSha) ?? stringValue(bundle.commitRef) ?? stringValue(bundle.commitSha),
    repository: stringValue(release?.repository) ?? stringValue(bundle.repository),
    branch: stringValue(release?.branch) ?? stringValue(bundle.branch),
    targetEnvironment: releaseEvidenceTargetEnvironment(bundle),
    channel: stringValue(release?.channel) ?? stringValue(bundle.channel) ?? stringValue(bundle.releaseChannel),
    deploymentId:
      stringValue(release?.deploymentId) ??
      stringValue(release?.targetDeploymentId) ??
      stringValue(bundle.deploymentId) ??
      stringValue(bundle.targetDeploymentId)
  };
}

function releaseEvidenceSelectedIdentity(selectedEvidence: Record<string, unknown>) {
  return {
    commitRef: stringValue(selectedEvidence.releaseCommitRef) ?? stringValue(selectedEvidence.commitRef) ?? stringValue(selectedEvidence.commitSha),
    repository: stringValue(selectedEvidence.repository),
    branch: stringValue(selectedEvidence.branch),
    targetEnvironment: stringValue(selectedEvidence.targetEnvironment) ?? stringValue(selectedEvidence.environment),
    channel: stringValue(selectedEvidence.channel) ?? stringValue(selectedEvidence.releaseChannel),
    deploymentId:
      stringValue(selectedEvidence.deploymentId) ??
      stringValue(selectedEvidence.targetDeploymentId) ??
      stringValue(selectedEvidence.releaseDeploymentId)
  };
}

function releaseEvidenceIdentityFailure(bundle: Record<string, unknown>, check: Record<string, unknown> | undefined) {
  const selectedEvidence = isRecord(check?.selectedEvidence) ? check.selectedEvidence : undefined;

  if (!selectedEvidence) {
    return undefined;
  }

  const bundleIdentity = releaseEvidenceBundleIdentity(bundle);
  const selectedIdentity = releaseEvidenceSelectedIdentity(selectedEvidence);

  if (!bundleIdentity.commitRef || !bundleIdentity.repository || !bundleIdentity.branch) {
    return "Release evidence bundle must include release commit, repository, and branch.";
  }

  const mismatches = [
    bundleIdentity.commitRef !== selectedIdentity.commitRef ? "release commit" : undefined,
    bundleIdentity.repository !== selectedIdentity.repository ? "repository" : undefined,
    bundleIdentity.branch !== selectedIdentity.branch ? "branch" : undefined,
    selectedIdentity.targetEnvironment && bundleIdentity.targetEnvironment !== selectedIdentity.targetEnvironment ? "target environment" : undefined,
    bundleIdentity.channel && selectedIdentity.channel && bundleIdentity.channel !== selectedIdentity.channel ? "channel" : undefined,
    bundleIdentity.deploymentId && selectedIdentity.deploymentId && bundleIdentity.deploymentId !== selectedIdentity.deploymentId
      ? "deployment"
      : undefined
  ].filter((field): field is string => Boolean(field));

  if (mismatches.length > 0) {
    return `Release evidence checker selected evidence must match bundle ${mismatches.join(", ")}.`;
  }

  return undefined;
}

function releaseEvidenceCheckFailure(check: Record<string, unknown> | undefined) {
  if (!check) {
    return "Release evidence requires a passing release:evidence checker result.";
  }

  if (check.status !== "passed") {
    return "Release evidence checker result status must be passed.";
  }

  if (check.exitCode !== 0) {
    return "Release evidence checker result exitCode must be 0.";
  }

  if (!Array.isArray(check.checks) || check.checks.length === 0) {
    return "Release evidence checker result must include at least one check.";
  }

  const failedChecks = check.checks
    .filter((entry) => !isRecord(entry) || entry.status !== "pass")
    .map((entry) => (isRecord(entry) ? stringValue(entry.name) : undefined) ?? "unknown")
    .slice(0, 5);

  if (failedChecks.length > 0) {
    return `Release evidence checker result must have only passing checks: ${failedChecks.join(", ")}.`;
  }

  return releaseEvidenceSelectedEvidenceFailure(check);
}

function releaseEvidenceCheckPath(parsed: Record<string, unknown>, check: Record<string, unknown> | undefined) {
  return stringValue(parsed.evidencePath) ?? stringValue(parsed.sourcePath) ?? stringValue(check?.evidencePath);
}

export function parseReleaseEvidence(value: string): ParsedReleaseEvidence {
  if (!value.trim()) {
    return { status: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (!isRecord(parsed)) {
      return { status: "invalid", message: "Release evidence bundle JSON must be an object." };
    }

    const bundle = releaseEvidenceBundleCandidate(parsed);

    if (!bundle) {
      return { status: "invalid", message: "Release evidence JSON must include a release evidence bundle object." };
    }

    if (bundle.schemaVersion !== "siteflow.releaseEvidence.v1") {
      return { status: "invalid", message: "Release evidence bundle schemaVersion must be siteflow.releaseEvidence.v1." };
    }

    if (bundle.name !== releaseEvidenceBundleName) {
      return { status: "invalid", message: "Release evidence bundle name must be siteflow-release-evidence-bundle." };
    }

    if (releaseEvidenceTargetEnvironment(bundle) !== "production") {
      return { status: "invalid", message: "Release evidence bundle targetEnvironment must be production." };
    }

    const check = releaseEvidenceCheckCandidate(parsed);
    const checkFailure = releaseEvidenceCheckFailure(check);

    if (checkFailure) {
      return { status: "invalid", message: checkFailure };
    }

    const identityFailure = releaseEvidenceIdentityFailure(bundle, check);

    if (identityFailure) {
      return { status: "invalid", message: identityFailure };
    }

    return {
      status: "valid",
      bundle,
      evidencePath: releaseEvidenceCheckPath(parsed, check)
    };
  } catch {
    return { status: "invalid", message: "Release evidence bundle JSON must be valid JSON." };
  }
}

function releaseEvidencePath(pathValue: string, parsed: ParsedReleaseEvidence) {
  return pathValue.trim() || (parsed.status === "valid" ? parsed.evidencePath : undefined);
}

export function releaseEvidenceFailure(pathValue: string, parsed: ParsedReleaseEvidence, operation = "promotion") {
  if (!releaseEvidencePath(pathValue, parsed)) {
    return `Production ${operation} requires a release evidence path.`;
  }

  if (parsed.status === "empty") {
    return `Production ${operation} requires release evidence bundle JSON.`;
  }

  if (parsed.status === "invalid") {
    return parsed.message;
  }

  return `Production ${operation} requires a passing release evidence bundle.`;
}

export function releaseEvidenceRequest(pathValue: string, parsed: ParsedReleaseEvidence): ReleaseEvidenceBundleRequest | undefined {
  const evidencePath = releaseEvidencePath(pathValue, parsed);

  if (!evidencePath || parsed.status !== "valid") {
    return undefined;
  }

  return {
    evidencePath,
    bundle: parsed.bundle
  };
}

function releaseEvidenceTicketValue(bundle: Record<string, unknown>, field: string) {
  const release = isRecord(bundle.release) ? bundle.release : undefined;
  return stringValue(release?.[field]) ?? stringValue(bundle[field]);
}

function releaseEvidenceTicketBand(bundle: Record<string, unknown>) {
  const identity = releaseEvidenceBundleIdentity(bundle);
  const statusTickets = requiredReleaseEvidenceStatusFields.map(([field, label]) => {
    const value = releaseEvidenceTicketValue(bundle, field);

    return {
      field,
      label,
      value: value && isPassingEvidenceStatus(value) ? "passed" : "Not recorded as passed"
    };
  });
  const identityTickets = [
    ["commitRef", "Release commit", identity.commitRef],
    ["repository", "Repository", identity.repository],
    ["branch", "Branch", identity.branch],
    ["targetEnvironment", "Target environment", identity.targetEnvironment],
    ["releaseImageDigest", "Release image digest", releaseEvidenceTicketValue(bundle, "releaseImageDigest")]
  ] as const;

  return (
    <section className="ticket-band" role="region" aria-label="Release evidence ticket band">
      <h3 className="ticket-band__title">Ticket band</h3>
      <dl className="ticket-band__list">
        {statusTickets.map((ticket) => (
          <div key={ticket.field} className="ticket-band__ticket" data-evidence-field={ticket.field}>
            <dt>{ticket.label}</dt>
            <dd>{ticket.value}</dd>
          </div>
        ))}
        {identityTickets.map(([field, label, value]) => (
          <div key={field} className="ticket-band__ticket" data-evidence-field={field}>
            <dt>{label}</dt>
            <dd className="release-mono">{value ? redactString(value) : "Not recorded in bundle"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface ReleaseEvidenceFormProps {
  required: boolean;
  evidencePath: string;
  evidenceText: string;
  parsedEvidence: ParsedReleaseEvidence;
  onEvidencePathChange: (value: string) => void;
  onEvidenceTextChange: (value: string) => void;
}

export function ReleaseEvidenceForm({
  required,
  evidencePath,
  evidenceText,
  parsedEvidence,
  onEvidencePathChange,
  onEvidenceTextChange
}: ReleaseEvidenceFormProps) {
  if (!required) {
    return null;
  }

  function handlePathChange(event: ChangeEvent<HTMLInputElement>) {
    onEvidencePathChange(event.target.value);
  }

  function handleEvidenceChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onEvidenceTextChange(event.target.value);
  }

  const effectivePath = releaseEvidencePath(evidencePath, parsedEvidence);
  const status =
    parsedEvidence.status === "valid"
      ? "Checker passed"
      : parsedEvidence.status === "invalid"
        ? "Invalid bundle"
        : "Waiting for bundle";

  return (
    <Panel title="Release evidence" eyebrow="Ticket band">
      <div className="release-form-stack">
        <label className="release-field">
          <span>Release evidence path</span>
          <input value={evidencePath} onChange={handlePathChange} placeholder="release-evidence.json" autoComplete="off" />
        </label>
        <label className="release-field">
          <span>Release evidence bundle JSON</span>
          <textarea value={evidenceText} onChange={handleEvidenceChange} rows={8} spellCheck={false} placeholder="{}" />
        </label>
        {parsedEvidence.status === "invalid" && (
          <div role="alert" className="release-field-error">
            {parsedEvidence.message}
          </div>
        )}
        <dl className="release-command-list">
          <div>
            <dt>Evidence path</dt>
            <dd className="release-mono">{effectivePath ?? "Not selected"}</dd>
          </div>
          <div>
            <dt>Bundle status</dt>
            <dd>{status}</dd>
          </div>
        </dl>
        {parsedEvidence.status === "valid" && releaseEvidenceTicketBand(parsedEvidence.bundle)}
      </div>
    </Panel>
  );
}
