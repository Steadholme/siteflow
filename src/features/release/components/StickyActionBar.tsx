import type { ReactNode } from "react";

import { Button, type ButtonVariant } from "@components/ui/Button";

export type CommandState =
  | { status: "idle" }
  | { status: "submitting"; message: string }
  | { status: "success"; message: string; operationId?: string }
  | { status: "validationError"; message: string }
  | { status: "apiError"; message: string };

interface StickyActionBarProps {
  actionLabel: string;
  actionIcon: ReactNode;
  buttonVariant: ButtonVariant;
  disabled: boolean;
  blockingReasons: string[];
  commandState: CommandState;
  onSubmit: () => void;
}

function stateRole(state: CommandState["status"]) {
  return state === "validationError" || state === "apiError" ? "alert" : "status";
}

export function StickyActionBar({
  actionLabel,
  actionIcon,
  buttonVariant,
  disabled,
  blockingReasons,
  commandState,
  onSubmit
}: StickyActionBarProps) {
  const submitting = commandState.status === "submitting";

  return (
    <section className="release-sticky-actions" aria-label="Command submission">
      <div className="release-action-copy">
        <strong>Safeguard status</strong>
        {blockingReasons.length > 0 ? (
          <ul>
            {blockingReasons.slice(0, 3).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p>All required checks and audit fields are ready.</p>
        )}
      </div>
      <Button variant={buttonVariant} icon={actionIcon} disabled={disabled || submitting} onClick={onSubmit}>
        {submitting ? "Submitting command" : actionLabel}
      </Button>
      {commandState.status !== "idle" && (
        <div role={stateRole(commandState.status)} className={`release-command-state release-command-state--${commandState.status}`}>
          <strong>{commandState.status === "success" ? "Command accepted" : "Command state"}</strong>
          <span>{commandState.message}</span>
          {commandState.status === "success" && commandState.operationId && (
            <span className="release-mono">operation {commandState.operationId}</span>
          )}
        </div>
      )}
    </section>
  );
}
