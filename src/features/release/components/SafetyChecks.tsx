import { Panel } from "@components/ui/Panel";
import { StatusPill, type StatusTone } from "@components/ui/StatusPill";
import type { SafetyCheck } from "@domain/siteflow";

export interface SafetyRequirement {
  label: string;
  passed: boolean;
  failure: string;
}

export interface SafetyGate {
  canSubmit: boolean;
  blockingReasons: string[];
  reasonValid: boolean;
  allChecksPassed: boolean;
}

export interface SafetyGateInput {
  checks: SafetyCheck[];
  auditReason: string;
  extraRequirements?: SafetyRequirement[];
}

function toneForSafety(status: SafetyCheck["status"]): StatusTone {
  if (status === "pass") {
    return "success";
  }

  return status === "warning" ? "warning" : "error";
}

export function normalizeSafetyChecks(primary: unknown, fallback: unknown = []): SafetyCheck[] {
  if (Array.isArray(primary)) {
    return primary as SafetyCheck[];
  }

  return Array.isArray(fallback) ? (fallback as SafetyCheck[]) : [];
}

export function evaluateSafetyGate({ checks, auditReason, extraRequirements = [] }: SafetyGateInput): SafetyGate {
  const blockingChecks = checks.filter((check) => check.status !== "pass");
  const failedRequirements = extraRequirements.filter((requirement) => !requirement.passed);
  const reasonValid = auditReason.trim().length > 0;
  const blockingReasons = [
    ...blockingChecks.map((check) => `${check.label}: ${check.summary}`),
    ...failedRequirements.map((requirement) => requirement.failure),
    ...(reasonValid ? [] : ["Audit reason must be non-empty."])
  ];

  return {
    canSubmit: blockingReasons.length === 0,
    blockingReasons,
    reasonValid,
    allChecksPassed: blockingChecks.length === 0 && failedRequirements.length === 0
  };
}

export function SafetyChecks({ checks }: { checks: SafetyCheck[] }) {
  const normalizedChecks = normalizeSafetyChecks(checks);

  return (
    <Panel title="Safety checks" eyebrow="Release gate">
      <div className="release-check-list">
        {normalizedChecks.map((check) => (
          <div key={check.id} className="release-check">
            <div>
              <strong>{check.label}</strong>
              <p>{check.summary}</p>
              {check.evidence && <span className="release-muted">{check.evidence}</span>}
            </div>
            <StatusPill tone={toneForSafety(check.status)}>{check.status}</StatusPill>
          </div>
        ))}
      </div>
    </Panel>
  );
}
