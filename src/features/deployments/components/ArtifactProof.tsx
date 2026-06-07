import { FileJson, ShieldCheck } from "lucide-react";

import { Button } from "@components/ui/Button";
import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { Artifact } from "@domain/siteflow";
import { redactManifest } from "@lib/redaction";
import {
  artifactVerificationLabel,
  artifactVerificationTone,
  formatBytes,
  formatDateTime,
  shortenSha
} from "../deploymentStatus";

export interface ArtifactProofProps {
  artifact: Artifact;
}

export function ArtifactProof({ artifact }: ArtifactProofProps) {
  const manifestMetadata = redactManifest(artifact.manifest.metadata);

  return (
    <Panel
      title="Artifact proof"
      eyebrow="Immutable bytes"
      actions={
        <Button variant="ghost" icon={<FileJson aria-hidden="true" size={16} />}>
          Open manifest
        </Button>
      }
    >
      <div className="deployment-proof">
        <div className="deployment-proof__status">
          <ShieldCheck aria-hidden="true" size={18} />
          <StatusPill tone={artifactVerificationTone(artifact.verificationStatus)}>
            {artifactVerificationLabel(artifact.verificationStatus)}
          </StatusPill>
        </div>
        <dl className="deployment-proof__list">
          <div>
            <dt>Checksum</dt>
            <dd className="deployment-mono">{shortenSha(artifact.manifest.checksum, 34)}</dd>
          </div>
          <div>
            <dt>Manifest</dt>
            <dd>
              {artifact.manifest.fileCount} files / {formatBytes(artifact.manifest.totalBytes)} / {artifact.manifest.entrypoint}
            </dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>{artifact.storageStatus}</dd>
          </div>
          <div>
            <dt>Retained until</dt>
            <dd>{formatDateTime(artifact.retainedUntil)}</dd>
          </div>
          <div>
            <dt>Immutable</dt>
            <dd>{artifact.immutable ? "yes" : "no"}</dd>
          </div>
        </dl>
        <pre className="deployment-proof__manifest" aria-label="Artifact manifest metadata">
          {JSON.stringify(manifestMetadata, null, 2)}
        </pre>
      </div>
    </Panel>
  );
}
