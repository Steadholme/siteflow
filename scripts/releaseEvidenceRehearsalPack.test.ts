import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createReleaseEvidenceRehearsalPack,
  runReleaseEvidenceRehearsalPackCli
} from "./releaseEvidenceRehearsalPack";
import { validateReleaseEvidenceRehearsalPackContract } from "./releaseEvidenceRehearsalPackContract";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function baseOptions(overrides: Partial<Parameters<typeof createReleaseEvidenceRehearsalPack>[0]> = {}) {
  return {
    commitRef: "abc123def4567890",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvFile: "evidence/target.env",
    publicBaseUrl: "https://siteflow.example.com",
    operatorName: "release-operator",
    releaseTicket: "REL-2026-0608",
    observabilityTargetStackApiUrl: "https://observability.example.com/siteflow-proof",
    outputDir: "evidence/release-abc123def456",
    now,
    ...overrides
  };
}

describe("releaseEvidenceRehearsalPack", () => {
  it("creates an offline release evidence rehearsal pack for every production gate", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions());

    expect(() => validateReleaseEvidenceRehearsalPackContract(pack as unknown as Record<string, unknown>)).not.toThrow();
    expect(pack).toMatchObject({
      schemaVersion: "siteflow.releaseEvidenceRehearsalPack.v1",
      name: "siteflow-release-evidence-rehearsal-pack",
      status: "planned",
      generatedAt: "2026-06-08T12:00:00.000Z",
      release: {
        commitRef: "abc123def4567890",
        repository: "acme/siteflow",
        branch: "main",
        sourceProvider: "github",
        targetEnvironment: "production",
        requiredStatusCheck: "Install, test, and build",
        publicBaseUrl: "https://siteflow.example.com"
      }
    });
    expect(pack.steps.map((step) => step.id)).toEqual([
      "release_gate",
      "docker_build_rehearsal",
      "postgres_rehearsal",
      "release_artifact_evidence",
      "release_image_evidence",
      "source_provider_evidence",
      "target_runtime_evidence",
      "backup_evidence",
      "observability_evidence",
      "operator_access_evidence",
      "non_session_credential_evidence",
      "ingress_evidence",
      "upgrade_rollback_evidence"
    ]);
    expect(pack.finalCommands.compose.args).toEqual(
      expect.arrayContaining([
        "--operator-access-evidence",
        pack.evidenceFiles.operatorAccess,
        "--source-provider-evidence",
        pack.evidenceFiles.sourceProvider,
        "--target-runtime-evidence",
        pack.evidenceFiles.targetRuntime,
        "--artifact-evidence",
        pack.evidenceFiles.releaseArtifact,
        "--release-image-evidence",
        pack.evidenceFiles.releaseImage,
        "--non-session-credential-evidence",
        pack.evidenceFiles.nonSessionCredential,
        "--ingress-evidence",
        pack.evidenceFiles.ingress,
        "--upgrade-rollback-evidence",
        pack.evidenceFiles.upgradeRollback,
        "--target-environment",
        "production",
        "--attestation-key-id-env",
        "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID"
      ])
    );
    expect(pack.finalCommands.compose.env).toEqual(expect.arrayContaining([
      "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY",
      "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID"
    ]));
    expect(pack.finalCommands.compose.args).not.toContain("--docker-socket-profile-accepted");
    expect(pack.requiredManualInputs.join("\n")).toContain("Docker socket trusted single-host profile not accepted");
    expect(pack.requiredManualInputs.join("\n")).toContain("SITEFLOW_DOCKER_SOCKET_GID");
    expect(pack.finalCommands.check.args).toEqual(
      expect.arrayContaining([
        "--evidence",
        pack.evidenceFiles.releaseEvidence,
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--attestation-key-id-env",
        "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID"
      ])
    );
    expect(pack.finalCommands.check.env).toEqual(expect.arrayContaining([
      "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY",
      "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID"
    ]));
    expect(pack.steps.find((step) => step.id === "backup_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "--backup-fetch",
        pack.evidenceFiles.backupFetch,
        "--provider-security-audit",
        pack.evidenceFiles.backupProviderSecurityAudit,
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production"
      ])
    );
    expect(pack.steps.find((step) => step.id === "upgrade_rollback_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "--target-environment",
        "production"
      ])
    );
    const upgradeRollbackStep = pack.steps.find((step) => step.id === "upgrade_rollback_evidence")!;
    expect(upgradeRollbackStep.prerequisites.join("\n")).toContain("upgrade-rollback:evidence:template");
    expect(upgradeRollbackStep.prerequisites.join("\n")).toContain(pack.evidenceFiles.upgradeRollbackRaw);
    expect(upgradeRollbackStep.notes.join("\n")).toContain("status=blocked, dryRun=true, and template=true");
    expect(pack.steps.find((step) => step.id === "release_artifact_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "release:artifacts:evidence",
        "--manifest",
        pack.evidenceFiles.releaseArtifactManifest,
        "--deployment-detail",
        "<candidate-deployment-detail-path>",
        "--write-deployment-artifact-manifest",
        pack.evidenceFiles.deploymentArtifactManifest,
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--json"
      ])
    );
    expect(pack.steps.find((step) => step.id === "release_artifact_evidence")?.command.args)
      .not.toContain("--deployment-artifact-manifest");
    const releaseArtifactStep = pack.steps.find((step) => step.id === "release_artifact_evidence")!;
    expect(releaseArtifactStep.prerequisites.join("\n")).toContain("candidate deployment detail");
    expect(releaseArtifactStep.notes.join("\n")).toContain("not uploaded as release evidence");
    expect(pack.steps.find((step) => step.id === "release_image_evidence")?.command).toMatchObject({
      executable: "gh",
      args: [
        "run",
        "download",
        "<release-image-run-id>",
        "--name",
        "release-image-evidence",
        "--dir",
        path.join("evidence", "release-abc123def456")
      ],
      env: ["GH_TOKEN"]
    });
    expect(pack.steps.find((step) => step.id === "operator_access_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "operator-access:evidence:collect",
        "--base-url",
        "https://siteflow.example.com",
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--operator-name",
        "release-operator",
        "--release-ticket",
        "REL-2026-0608",
        "--admin-token-env",
        "SITEFLOW_API_TOKEN",
        "--low-scope-token-env",
        "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN",
        "--project-id",
        "<operator-access-project-id>",
        "--denied-project-id",
        "<operator-access-denied-project-id>",
        "--execute-project-cutoff",
        "--execute-global-cutoff",
        "--i-understand-this-revokes-active-operator-sessions",
        "--browser-token-fallback-disabled",
        "--local-storage-fallback-disabled",
        "--output",
        pack.evidenceFiles.operatorAccessRaw,
        "--check-output",
        pack.evidenceFiles.operatorAccess
      ])
    );
    expect(pack.steps.find((step) => step.id === "operator_access_evidence")?.command.env).toEqual([
      "SITEFLOW_API_TOKEN",
      "SITEFLOW_API_TOKEN_FILE",
      "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN",
      "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN_FILE"
    ]);
    const operatorAccessStep = pack.steps.find((step) => step.id === "operator_access_evidence")!;
    expect(operatorAccessStep.prerequisites.join("\n")).toContain("operator-access:evidence:template");
    expect(operatorAccessStep.prerequisites.join("\n")).toContain(pack.evidenceFiles.operatorAccessRaw);
    expect(operatorAccessStep.prerequisites.join("\n")).toContain("temporary routing rule");
    expect(operatorAccessStep.prerequisites.join("\n")).toContain("cleanup failure blocks");
    expect(operatorAccessStep.notes.join("\n")).toContain("collector writes both the raw operator-access evidence");
    expect(operatorAccessStep.notes.join("\n")).toContain("blocked manual fallback");
    expect(pack.steps.find((step) => step.id === "source_provider_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "source-provider:evidence:collect",
        "--provider",
        "github",
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--operator-name",
        "release-operator",
        "--release-ticket",
        "REL-2026-0608",
        "--webhook-delivery-id",
        "<webhook-delivery-id>",
        "--webhook-signature-verified",
        "--webhook-secret-configured",
        "--deploy-key-path",
        "<deploy-key-path>",
        "--deploy-key-mounted",
        "--host-key-pinned",
        "--known-hosts-path",
        "<known-hosts-path>",
        "--output",
        pack.evidenceFiles.sourceProviderRaw,
        "--check-output",
        pack.evidenceFiles.sourceProvider
      ])
    );
    expect(pack.steps.find((step) => step.id === "source_provider_evidence")?.command.env).toEqual(["GITHUB_TOKEN"]);
    const sourceProviderStep = pack.steps.find((step) => step.id === "source_provider_evidence")!;
    expect(sourceProviderStep.prerequisites.join("\n")).toContain("source-provider:evidence:template");
    expect(sourceProviderStep.prerequisites.join("\n")).toContain(pack.evidenceFiles.sourceProviderRaw);
    expect(sourceProviderStep.prerequisites.join("\n")).toContain("real delivery id");
    expect(sourceProviderStep.prerequisites.join("\n")).toContain("--provider github");
    expect(sourceProviderStep.notes.join("\n")).toContain("collector writes both the raw source-provider evidence");
    expect(sourceProviderStep.notes.join("\n")).toContain("status=blocked, dryRun=true, and template=true");
    expect(pack.steps.find((step) => step.id === "target_runtime_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "release:target-runtime:evidence:collect",
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--env-file",
        "evidence/target.env",
        "--public-base-url",
        "https://siteflow.example.com",
        "--expected-digest",
        "<release-image-digest>",
        "--operator-name",
        "release-operator",
        "--release-ticket",
        "REL-2026-0608",
        "--output",
        pack.evidenceFiles.targetRuntimeRaw,
        "--check-output",
        pack.evidenceFiles.targetRuntime
      ])
    );
    const targetRuntimeStep = pack.steps.find((step) => step.id === "target_runtime_evidence")!;
    expect(targetRuntimeStep.prerequisites.join("\n")).toContain("release:target-runtime:evidence:template");
    expect(targetRuntimeStep.prerequisites.join("\n")).toContain(pack.evidenceFiles.targetRuntimeRaw);
    expect(targetRuntimeStep.prerequisites.join("\n")).toContain("actual target host");
    expect(targetRuntimeStep.prerequisites.join("\n")).toContain("SITEFLOW_DOCKER_SOCKET_GID");
    expect(targetRuntimeStep.prerequisites.join("\n")).toContain("release image evidence artifact");
    expect(targetRuntimeStep.notes.join("\n")).toContain("collector writes both the raw target-runtime evidence");
    expect(targetRuntimeStep.notes.join("\n")).toContain("worker healthcheck");
    expect(targetRuntimeStep.notes.join("\n")).toContain("blocked manual fallback");
    expect(pack.steps.find((step) => step.id === "non_session_credential_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "non-session-credential:evidence:collect",
        "--base-url",
        "https://siteflow.example.com",
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--operator-name",
        "release-operator",
        "--release-ticket",
        "REL-2026-0608",
        "--old-metrics-token-env",
        "SITEFLOW_OLD_METRICS_TOKEN",
        "--new-metrics-token-env",
        "SITEFLOW_METRICS_TOKEN",
        "--old-api-token-env",
        "SITEFLOW_OLD_API_TOKEN",
        "--new-api-token-env",
        "SITEFLOW_API_TOKEN",
        "--old-redacted-identifier",
        "<old-metrics-token-redacted-id>",
        "--new-redacted-identifier",
        "<new-metrics-token-redacted-id>",
        "--old-api-redacted-identifier",
        "<old-root-api-token-redacted-id>",
        "--new-api-redacted-identifier",
        "<new-root-api-token-redacted-id>",
        "--break-glass-source",
        "<break-glass-source>",
        "--break-glass-approver-count",
        "<break-glass-approver-count>",
        "--break-glass-reviewed",
        "--break-glass-time-bounded",
        "--break-glass-revocation-planned",
        "--output",
        pack.evidenceFiles.nonSessionCredentialRaw,
        "--check-output",
        pack.evidenceFiles.nonSessionCredential
      ])
    );
    expect(pack.steps.find((step) => step.id === "non_session_credential_evidence")?.command.env).toEqual([
      "SITEFLOW_OLD_METRICS_TOKEN",
      "SITEFLOW_OLD_METRICS_TOKEN_FILE",
      "SITEFLOW_METRICS_TOKEN",
      "SITEFLOW_METRICS_TOKEN_FILE",
      "SITEFLOW_OLD_API_TOKEN",
      "SITEFLOW_OLD_API_TOKEN_FILE",
      "SITEFLOW_API_TOKEN",
      "SITEFLOW_API_TOKEN_FILE"
    ]);
    const nonSessionCredentialStep = pack.steps.find((step) => step.id === "non_session_credential_evidence")!;
    expect(nonSessionCredentialStep.prerequisites.join("\n")).toContain("non-session-credential:evidence:template");
    expect(nonSessionCredentialStep.prerequisites.join("\n")).toContain(pack.evidenceFiles.nonSessionCredentialRaw);
    expect(nonSessionCredentialStep.prerequisites.join("\n")).toContain("root API token");
    expect(nonSessionCredentialStep.prerequisites.join("\n")).toContain("/api/auth/verify");
    expect(nonSessionCredentialStep.notes.join("\n")).toContain("collector writes both the raw non-session credential evidence");
    expect(nonSessionCredentialStep.notes.join("\n")).toContain("blocked manual fallback");
    expect(pack.steps.find((step) => step.id === "observability_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "observability:evidence:collect",
        "--backup-automation-run",
        pack.evidenceFiles.backupAutomationRun,
        "--backup-automation-history",
        pack.evidenceFiles.backupAutomationHistory,
        "--backup-scheduler-ownership",
        pack.evidenceFiles.backupSchedulerOwnership,
        "--operator-evidence",
        pack.evidenceFiles.operatorObservability,
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--target-stack-api-url",
        "https://observability.example.com/siteflow-proof",
        "--operator-name",
        "release-operator",
        "--release-ticket",
        "REL-2026-0608",
        "--check-output",
        pack.evidenceFiles.observability
      ])
    );
    const observabilityStep = pack.steps.find((step) => step.id === "observability_evidence")!;
    expect(observabilityStep.prerequisites).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Backup scheduler ownership"),
        expect.stringContaining("observability:operator-evidence:template"),
        expect.stringContaining("observabilityTargetStackProof")
      ])
    );
    expect(observabilityStep.prerequisites.join("\n")).toContain(pack.evidenceFiles.operatorObservability);
    expect(observabilityStep.notes.join("\n")).toContain("status=blocked, dryRun=true, and template=true");
    expect(pack.steps.find((step) => step.id === "observability_evidence")?.command.env).toEqual([
      "SITEFLOW_METRICS_TOKEN",
      "SITEFLOW_METRICS_TOKEN_FILE",
      "SITEFLOW_OBSERVABILITY_STACK_TOKEN",
      "SITEFLOW_OBSERVABILITY_STACK_TOKEN_FILE"
    ]);
    expect(pack.steps.find((step) => step.id === "ingress_evidence")?.command.args).toEqual(
      expect.arrayContaining([
        "ingress:evidence:collect",
        "--public-base-url",
        "https://siteflow.example.com",
        "--direct-api-url",
        "<direct-api-url>",
        "--target-environment",
        "production",
        "--api-instance-count",
        "<api-instance-count>",
        "--api-process-count",
        "<api-process-count>",
        "--ingress-count",
        "<ingress-count>",
        "--api-rate-limit-scope",
        "<api-rate-limit-scope>",
        "--api-rate-limit-enforcement-point",
        "<api-rate-limit-enforcement-point>",
        "--operator-evidence",
        pack.evidenceFiles.operatorIngress,
        "--output",
        pack.evidenceFiles.ingressRaw,
        "--check-output",
        pack.evidenceFiles.ingress
      ])
    );
    const ingressStep = pack.steps.find((step) => step.id === "ingress_evidence")!;
    expect(ingressStep.prerequisites.join("\n")).toContain("ingress:operator-evidence:template");
    expect(ingressStep.prerequisites.join("\n")).toContain(pack.evidenceFiles.operatorIngress);
    expect(ingressStep.prerequisites.join("\n")).toContain("--public-base-url https://siteflow.example.com");
    expect(ingressStep.prerequisites.join("\n")).toContain("--trust-proxy-policy '<SITEFLOW_TRUST_PROXY>'");
    expect(ingressStep.notes.join("\n")).toContain("status=blocked, dryRun=true, and template=true");
    expect(pack.blockedProductionClaims.join("\n")).toContain("does not execute GitHub");
    expect(pack.requiredManualInputs.join("\n")).toContain("source-provider:evidence:template");
    expect(pack.requiredManualInputs.join("\n")).toContain("SITEFLOW_DOCKER_SOCKET_GID");
    expect(pack.requiredManualInputs.join("\n")).toContain("target runtime collector run on the target host");
    expect(pack.requiredManualInputs.join("\n")).toContain("API/worker image binding");
    expect(pack.requiredManualInputs.join("\n")).toContain("operator access collector run on the target evidence host");
    expect(pack.requiredManualInputs.join("\n")).toContain("non-session credential collector run after target metrics and root API token rotation");
    expect(pack.requiredManualInputs.join("\n")).toContain("observability:operator-evidence:template");
    expect(pack.requiredManualInputs.join("\n")).toContain("ingress:operator-evidence:template");
    expect(pack.requiredManualInputs.join("\n")).toContain("upgrade-rollback:evidence:template");
    expect(JSON.stringify(pack)).not.toContain("Authorization");
  });

  it("uses a manual template and checker source-provider path for non-GitHub providers", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions({
      sourceProvider: "gitlab"
    }));

    expect(() => validateReleaseEvidenceRehearsalPackContract(pack as unknown as Record<string, unknown>)).not.toThrow();
    expect(pack.release.sourceProvider).toBe("gitlab");
    const sourceProviderStep = pack.steps.find((step) => step.id === "source_provider_evidence")!;

    expect(sourceProviderStep.command).toMatchObject({
      executable: "npm",
      args: [
        "run",
        "--silent",
        "source-provider:evidence",
        "--",
        "--evidence",
        pack.evidenceFiles.sourceProviderRaw,
        "--commit-ref",
        "abc123def4567890",
        "--repo",
        "acme/siteflow",
        "--branch",
        "main",
        "--target-environment",
        "production",
        "--json"
      ],
      captureStdoutTo: pack.evidenceFiles.sourceProvider
    });
    expect(sourceProviderStep.command.env).toBeUndefined();
    expect(sourceProviderStep.command.args).not.toContain("source-provider:evidence:collect");
    expect(sourceProviderStep.prerequisites.join("\n")).toContain("--provider gitlab");
    expect(sourceProviderStep.prerequisites.join("\n")).toContain("GITHUB_TOKEN is not required");
    expect(sourceProviderStep.notes.join("\n")).toContain("completed manual raw source-provider evidence");
    expect(pack.requiredManualInputs.join("\n")).toContain("source provider gitlab raw evidence");

    const wrongNonGithubCollector = createReleaseEvidenceRehearsalPack(baseOptions({
      sourceProvider: "gitlab"
    }));
    const wrongStep = wrongNonGithubCollector.steps.find((step) => step.id === "source_provider_evidence")!;

    wrongStep.command = {
      ...wrongStep.command,
      args: [
        "run",
        "--silent",
        "source-provider:evidence:collect",
        "--",
        "--provider",
        "github",
        "--json"
      ],
      display: "npm run --silent source-provider:evidence:collect -- --provider github --json",
      env: ["GITHUB_TOKEN"]
    };

    expect(() => validateReleaseEvidenceRehearsalPackContract(wrongNonGithubCollector as unknown as Record<string, unknown>))
      .toThrow(/source_provider_evidence command args must run source-provider:evidence with -- separator|source_provider_evidence command env must not include GITHUB_TOKEN/);
  });

  it("includes Docker socket profile acceptance only when explicitly requested", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions({
      dockerSocketProfileAccepted: true
    }));

    expect(() => validateReleaseEvidenceRehearsalPackContract(pack as unknown as Record<string, unknown>)).not.toThrow();
    expect(pack.finalCommands.compose.args).toContain("--docker-socket-profile-accepted");
    expect(pack.requiredManualInputs.join("\n")).toContain("Docker socket trusted single-host profile explicitly accepted");
  });

  it("rejects packs whose command semantics no longer match the rehearsal contract", () => {
    const wrongStepScript = createReleaseEvidenceRehearsalPack(baseOptions());
    const operatorStep = wrongStepScript.steps.find((step) => step.id === "operator_access_evidence")!;

    operatorStep.command = {
      ...operatorStep.command,
      args: ["run", "--silent", "release:evidence", "--", "--json"],
      display: "npm run --silent release:evidence -- --json"
    };

    expect(() => validateReleaseEvidenceRehearsalPackContract(wrongStepScript as unknown as Record<string, unknown>))
      .toThrow(/operator_access_evidence command args must run operator-access:evidence:collect/);

    const wrongFinalCapture = createReleaseEvidenceRehearsalPack(baseOptions());

    wrongFinalCapture.finalCommands.check = {
      ...wrongFinalCapture.finalCommands.check,
      captureStdoutTo: wrongFinalCapture.evidenceFiles.releaseEvidence
    };

    expect(() => validateReleaseEvidenceRehearsalPackContract(wrongFinalCapture as unknown as Record<string, unknown>))
      .toThrow(/finalCommands.check command captureStdoutTo must equal outputPath/);

    const missingProviderAudit = createReleaseEvidenceRehearsalPack(baseOptions());
    const backupStep = missingProviderAudit.steps.find((step) => step.id === "backup_evidence")!;

    backupStep.command = {
      ...backupStep.command,
      args: backupStep.command.args.filter((arg) => arg !== "--provider-security-audit" && arg !== missingProviderAudit.evidenceFiles.backupProviderSecurityAudit)
    };

    expect(() => validateReleaseEvidenceRehearsalPackContract(missingProviderAudit as unknown as Record<string, unknown>))
      .toThrow(/backup_evidence command --provider-security-audit must be/);

    const collectorOutputContracts = [
      {
        id: "source_provider_evidence",
        rawKey: "sourceProviderRaw",
        composeFlag: "--source-provider-evidence"
      },
      {
        id: "target_runtime_evidence",
        rawKey: "targetRuntimeRaw",
        composeFlag: "--target-runtime-evidence"
      },
      {
        id: "operator_access_evidence",
        rawKey: "operatorAccessRaw",
        composeFlag: "--operator-access-evidence"
      },
      {
        id: "non_session_credential_evidence",
        rawKey: "nonSessionCredentialRaw",
        composeFlag: "--non-session-credential-evidence"
      }
    ];

    for (const contract of collectorOutputContracts) {
      const wrongStepOutput = createReleaseEvidenceRehearsalPack(baseOptions());
      const step = wrongStepOutput.steps.find((entry) => entry.id === contract.id)!;

      step.outputPath = wrongStepOutput.evidenceFiles[contract.rawKey];

      expect(() => validateReleaseEvidenceRehearsalPackContract(wrongStepOutput as unknown as Record<string, unknown>))
        .toThrow(`${contract.id} outputPath must equal`);

      const wrongComposeInput = createReleaseEvidenceRehearsalPack(baseOptions());
      const flagIndex = wrongComposeInput.finalCommands.compose.args.indexOf(contract.composeFlag);

      wrongComposeInput.finalCommands.compose.args[flagIndex + 1] = wrongComposeInput.evidenceFiles[contract.rawKey];

      expect(() => validateReleaseEvidenceRehearsalPackContract(wrongComposeInput as unknown as Record<string, unknown>))
        .toThrow(`finalCommands.compose command ${contract.composeFlag} must be`);
    }
  });

  it("rejects non-HTTPS public URLs and URLs that would archive credentials or query strings", () => {
    expect(() => createReleaseEvidenceRehearsalPack(baseOptions({
      publicBaseUrl: "http://siteflow.example.com"
    }))).toThrow(/must use https/);
    expect(() => createReleaseEvidenceRehearsalPack(baseOptions({
      publicBaseUrl: "https://operator:secret@siteflow.example.com"
    }))).toThrow(/must not include credentials/);
    expect(() => createReleaseEvidenceRehearsalPack(baseOptions({
      publicBaseUrl: "https://siteflow.example.com?token=do-not-store"
    }))).toThrow(/must not include credentials/);
  });

  it("requires target-stack proof collection URL for production packs only", () => {
    expect(() => createReleaseEvidenceRehearsalPack(baseOptions({
      observabilityTargetStackApiUrl: undefined
    }))).toThrow(/--observability-target-stack-api-url is required for production/);

    const stagingPack = createReleaseEvidenceRehearsalPack(baseOptions({
      targetEnvironment: "staging",
      observabilityTargetStackApiUrl: undefined
    }));

    expect(() => validateReleaseEvidenceRehearsalPackContract(stagingPack as unknown as Record<string, unknown>)).not.toThrow();
    expect(stagingPack.steps.find((step) => step.id === "observability_evidence")?.command.args).not.toContain("--target-stack-api-url");
  });

  it("rejects production packs whose observability command omits target-stack proof collection", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions());
    const observabilityStep = pack.steps.find((step) => step.id === "observability_evidence")!;
    const index = observabilityStep.command.args.indexOf("--target-stack-api-url");

    observabilityStep.command.args.splice(index, 2);

    expect(() => validateReleaseEvidenceRehearsalPackContract(pack as unknown as Record<string, unknown>))
      .toThrow(/observability_evidence command --target-stack-api-url must be https:\/\/observability\.example\.com\/siteflow-proof/);
  });

  it("quotes PowerShell command displays without changing structured args", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions({
      operatorName: "release operator",
      releaseTicket: "REL 2026 0608",
      outputDir: "evidence/release with spaces"
    }));
    const backupStep = pack.steps.find((step) => step.id === "backup_evidence");
    const releaseGateStep = pack.steps.find((step) => step.id === "release_gate");
    const ingressStep = pack.steps.find((step) => step.id === "ingress_evidence");

    expect(backupStep?.command.args).toEqual(
      expect.arrayContaining([
        "--operator-name",
        "release operator",
        "--release-ticket",
        "REL 2026 0608"
      ])
    );
    expect(backupStep?.command.display).toContain("--operator-name 'release operator'");
    expect(backupStep?.command.display).toContain("--release-ticket 'REL 2026 0608'");
    expect(backupStep?.command.display).toContain("--check-output 'evidence");
    expect(releaseGateStep?.command.display).toContain("> 'evidence");
    expect(ingressStep?.command.args).toEqual(
      expect.arrayContaining([
        "--direct-api-url",
        "<direct-api-url>",
        "--api-instance-count",
        "<api-instance-count>",
        "--api-rate-limit-scope",
        "<api-rate-limit-scope>"
      ])
    );
    expect(ingressStep?.command.display).toContain("--direct-api-url '<direct-api-url>'");
    expect(ingressStep?.command.display).toContain("--api-instance-count '<api-instance-count>'");
    expect(ingressStep?.command.display).toContain("--api-rate-limit-scope '<api-rate-limit-scope>'");
  });

  it("passes target-stack proof collection inputs to the observability step", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions({
      observabilityTargetStackApiUrl: "https://observability.example.com/siteflow-proof",
      observabilityTargetStackTokenEnv: "SITEFLOW_OBSERVABILITY_PROD_TOKEN"
    }));
    const observabilityStep = pack.steps.find((step) => step.id === "observability_evidence");

    expect(observabilityStep?.command.args).toEqual(
      expect.arrayContaining([
        "--target-stack-api-url",
        "https://observability.example.com/siteflow-proof",
        "--target-stack-token-env",
        "SITEFLOW_OBSERVABILITY_PROD_TOKEN",
        "--operator-name",
        "release-operator",
        "--release-ticket",
        "REL-2026-0608"
      ])
    );
    expect(observabilityStep?.command.env).toEqual([
      "SITEFLOW_METRICS_TOKEN",
      "SITEFLOW_METRICS_TOKEN_FILE",
      "SITEFLOW_OBSERVABILITY_PROD_TOKEN",
      "SITEFLOW_OBSERVABILITY_PROD_TOKEN_FILE"
    ]);
  });

  it("prints help from the CLI", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runReleaseEvidenceRehearsalPackCli(["--help"], {
      stdout: { write: (chunk: string) => ((stdout += chunk), true) },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    }, { now });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("release:evidence:rehearsal-pack");
    expect(stdout).toContain("--public-base-url");
    expect(stdout).toContain("--observability-target-stack-api-url");
  });

  it("writes JSON and Markdown pack files from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-pack-"));
    let stdout = "";
    let stderr = "";

    try {
      const outputDir = path.join(root, "evidence");
      const exitCode = await runReleaseEvidenceRehearsalPackCli(
        [
          "--commit-ref",
          "abc123def4567890",
          "--repo",
          "acme/siteflow",
          "--branch",
          "main",
          "--target-env-file",
          path.join(root, "target.env"),
          "--public-base-url",
          "https://siteflow.example.com",
          "--operator-name",
          "release-operator",
          "--release-ticket",
          "REL-2026-0608",
          "--observability-target-stack-api-url",
          "https://observability.example.com/siteflow-proof",
          "--source-provider",
          "gitea",
          "--output-dir",
          outputDir,
          "--checked-at",
          "2026-06-08T12:34:56.000Z",
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { now }
      );
      const printed = JSON.parse(stdout);
      const written = JSON.parse(await readFile(path.join(outputDir, "release-evidence-rehearsal-pack.json"), "utf8"));
      const markdown = await readFile(path.join(outputDir, "release-evidence-rehearsal-pack.md"), "utf8");

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(written).toEqual(printed);
      expect(printed).toMatchObject({
        status: "planned",
        generatedAt: "2026-06-08T12:34:56.000Z",
        release: {
          sourceProvider: "gitea"
        },
        outputDir
      });
      expect(markdown).toContain("release_gate");
      expect(markdown).toContain("source-provider:evidence:template");
      expect(markdown).toContain("GITHUB_TOKEN is not required");
      expect(markdown).toContain("observability:operator-evidence:template");
      expect(markdown).toContain("ingress:evidence:collect");
      expect(markdown).toContain("ingress:operator-evidence:template");
      expect(markdown).toContain("release:evidence:compose");
      expect(markdown).toContain("release:evidence");
      expect(markdown).toContain("## Required Manual Inputs");
      expect(markdown).toContain("target env file reviewed without raw secret archival");
      expect(markdown).toContain("Environment requirements:");
      expect(markdown).toContain("SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL=1");
      expect(markdown).toContain("TEST_DATABASE_URL=<target-or-disposable-postgres-url>");
      expect(markdown).toContain("Prerequisites:");
      expect(markdown).toContain("Raw drill evidence covers API, worker, schema");
      expect(markdown).toContain("Notes:");
      expect(markdown).toContain("The collector actively probes direct API reachability");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a usage error when required release metadata is missing", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runReleaseEvidenceRehearsalPackCli(
      ["--commit-ref", "abc123def4567890", "--json"],
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      },
      { now }
    );

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Missing required option");
    expect(stderr).toContain("--repo");
    expect(stderr).toContain("--release-ticket");
  });
});
