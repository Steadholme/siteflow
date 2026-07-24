import { useMemo } from "react";

import { Panel } from "@components/ui/Panel";
import type { LogChunkReadModel } from "@domain/readModels";
import { redactLogLines } from "@lib/redaction";
import { formatDateTime } from "../deploymentStatus";

export interface LogPanelProps {
  logs: LogChunkReadModel;
}

export function LogPanel({ logs }: LogPanelProps) {
  const redactedLines = useMemo(() => redactLogLines(logs.chunk.lines), [logs.chunk.lines]);
  const lineRange = redactedLines.length > 0 ? `1-${redactedLines.length}` : "empty";

  return (
    <Panel title="Build log" eyebrow="Crew log / Redacted stream" className="deployment-log-panel">
      <div className="deployment-log__metadata" aria-label="Build log metadata">
        <span>Cursor {logs.chunk.cursor}</span>
        <span>Range {lineRange}</span>
        <span>{logs.hasMore ? "More chunks available" : "End of stream"}</span>
        <span>Fetched {formatDateTime(logs.chunk.fetchedAt)}</span>
      </div>
      <pre className="deployment-log" aria-label="Build log output">
        {redactedLines.join("\n")}
      </pre>
    </Panel>
  );
}
