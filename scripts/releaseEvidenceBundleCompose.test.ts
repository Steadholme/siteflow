import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeReleaseEvidenceBundle, runReleaseEvidenceBundleComposeCli } from "./releaseEvidenceBundleCompose";
import { evaluateReleaseEvidenceBundle } from "./releaseEvidenceBundleCheck";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck";

const now = () => new Date("2026-06-07T12:00:00.000Z");
const commitRef = "abc123def456";
const repository = "acme/siteflow";
const branch = "main";
const requiredStatusCheck = "Install, test, and build";
const buildImage = "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const backupKmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";
const requiredNonSessionCredentialEvidenceCheckNames = [
  "non_dry_run",
  "not_template",
  "status_final",
  "release_identity",
  "environment",
  "operator",
  "ticket",
  "credentials_present",
  "credential_types_supported",
  "credential_owners_and_tickets",
  "credential_status",
  "credential_age",
  "credential_redacted_identifiers",
  "no_raw_credentials_archived",
  "no_sensitive_evidence_values",
  "old_credentials_rejected",
  "new_credentials_accepted",
  "credential_specific_evidence",
  "break_glass_present",
  "break_glass_status",
  "break_glass_age",
  "break_glass_controls",
  "automation_not_claimed"
];

function passingCheck(name: string) {
  return {
    name,
    status: "pass",
    message: `${name} passed.`
  };
}

function backupProviderSecurityAuditEvidence(checkedAt = "2026-06-07T10:26:45.000Z") {
  return {
    status: "passed",
    timestamp: checkedAt,
    schemaVersion: "siteflow.backupProviderSecurityAudit.v1",
    name: "siteflow-backup-provider-security-audit",
    evidenceSource: "provider_security_audit",
    operator: "release-operator",
    ticket: "REL-2026-0607",
    kmsKeyPolicy: {
      status: "passed",
      kmsKeyRef: backupKmsKeyRef,
      policySha256: "c".repeat(64),
      backupRoleEncryptDecryptAllowed: true,
      restoreRoleDecryptAllowed: true,
      crossAccountRestoreRoleAllowed: true,
      publicAccessDenied: true
    },
    bucketPolicy: {
      status: "passed",
      policySha256: "d".repeat(64),
      publicAccessBlocked: true,
      insecureTransportDenied: true,
      unencryptedUploadsDenied: true,
      backupRoleWriteAllowed: true,
      restoreRoleReadAllowed: true
    },
    lifecyclePolicy: {
      status: "passed",
      ruleId: "retain-siteflow-prod-backups",
      enabled: true,
      versioningEnabled: true,
      retentionDays: 30
    },
    crossAccountRestore: {
      status: "passed",
      sourceAccountId: "111122223333",
      restoreAccountId: "444455556666",
      restoreRoleArn: "arn:aws:iam::444455556666:role/siteflow-restore",
      s3GetObjectTest: { status: "passed" },
      kmsDecryptTest: { status: "passed" }
    },
    crossAccountRestoreDrill: {
      status: "passed",
      restoreDrill: true,
      completedAt: "2026-06-07T10:27:30.000Z",
      restoreAccountId: "444455556666",
      restoreRoleArn: "arn:aws:iam::444455556666:role/siteflow-restore",
      backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260607"
    }
  };
}

function releaseGateEvidence() {
  return {
    status: "pass",
    checkedAt: "2026-06-07T10:09:00.000Z",
    promotionEvidence: {
      gateStatus: "pass",
      checkedAt: "2026-06-07T10:09:00.000Z",
      promotion: true,
      commitRef,
      repository,
      branch,
      requiredStatusCheck,
      branchProtection: {
        status: "pass",
        repository,
        branch,
        requiredStatusCheck,
        requiredStatusChecks: [requiredStatusCheck]
      },
      protectedBranchCommit: {
        status: "pass",
        repository,
        branch,
        commitRef,
        branchHeadSha: commitRef
      },
      commitStatus: {
        status: "pass",
        repository,
        commitRef,
        requiredStatusCheck,
        checkRun: {
          name: requiredStatusCheck,
          status: "completed",
          conclusion: "success"
        }
      },
      manualRequired: false,
      manualRequiredCheckIds: [],
      runtimeEnv: {
        status: "pass",
        metricsTokenConfigured: true,
        unauthenticatedMetricsAllowed: false,
        browserTokenFallbackEnabled: false,
        browserTokenFallbackStatus: "pass",
        browserTokenFallbackEnvValue: null,
        apiTokenStrengthStatus: "pass",
        metricsTokenStrengthStatus: "pass",
        appSecretStrengthStatus: "pass",
        appSecretSource: "SITEFLOW_APP_SECRET",
        sourceBuildPostureStatus: "pass",
        buildRunner: "docker",
        hostBuildException: false,
        buildImage,
        buildImageDigestPinned: true,
        buildImageAllowlistConfigured: false,
        buildImageAllowedByAllowlist: false,
        buildImageTaggedTrustedExceptionAccepted: false,
        buildImagePolicyStatus: "pass",
        buildImagePolicy: "digest",
        buildMaxArtifactBytesStatus: "pass",
        buildMaxArtifactBytes: 536870912,
        buildMaxArtifactFilesStatus: "pass",
        buildMaxArtifactFiles: 20000,
        buildMinFreeBytesStatus: "pass",
        buildMinFreeBytes: 1073741824,
        prebuiltMaxUploadBytesStatus: "pass",
        prebuiltMaxUploadBytes: 536870912,
        prebuiltMaxFilesStatus: "pass",
        prebuiltMaxFiles: 20000,
        buildStepTimeoutStatus: "pass",
        buildStepTimeoutMs: 900000,
        gitTimeoutStatus: "pass",
        gitTimeoutMs: 300000,
        buildNetworkStatus: "pass",
        buildNetwork: "none"
      },
      dirtyWorktree: {
        status: "pass",
        dirty: false,
        entries: [],
        summary: "Git worktree is clean."
      }
    }
  };
}

function hostBuildExceptionReleaseGateEvidence() {
  const evidence = releaseGateEvidence();

  evidence.promotionEvidence.runtimeEnv = {
    ...evidence.promotionEvidence.runtimeEnv,
    buildRunner: "host",
    hostBuildException: true,
    buildImagePolicyStatus: "blocked",
    buildImagePolicy: "host_exception"
  };

  return evidence;
}

function dockerBuildEvidence() {
  return {
    name: "siteflow-docker-build-rehearsal",
    status: "passed",
    dryRun: false,
    startedAt: "2026-06-07T10:11:00.000Z",
    completedAt: "2026-06-07T10:18:00.000Z",
    releaseCommit: commitRef,
    repository,
    branch,
    buildRunner: "docker",
    docker: {
      image: buildImage,
      imageDigestPinned: true,
      imageAllowlistConfigured: false,
      imageAllowedByAllowlist: false,
      network: "none",
      memory: "1g",
      cpus: "2",
      pidsLimit: 256,
      user: "1000:1000",
      dockerVersion: "Docker version 27.0.0",
      dockerInfoAvailable: true
    },
    prerequisites: [
      { name: "SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL", required: true, status: "passed" },
      { name: "SITEFLOW_BUILD_IMAGE", required: true, status: "passed" },
      { name: "docker_cli", required: true, status: "passed" },
      { name: "docker_daemon", required: true, status: "passed" }
    ],
    buildCommands: ["npm ci", "npm run build"],
    artifact: {
      entrypoint: "index.html",
      fileCount: 3,
      totalBytes: 512,
      checksum: "sha256:docker-rehearsal"
    },
    artifactLimits: {
      maxArtifactBytes: 536870912,
      maxArtifactFiles: 20000
    },
    redactionVerified: true,
    exitCode: 0
  };
}

function postgresEvidence() {
  const rehearsalScope = [
    "migration_advisory_lock",
    "migration_checksum_drift",
    "concurrent_migration_startup",
    "skip_locked_claim",
    "concurrent_worker_claim",
    "lease_heartbeat",
    "stale_lease_recovery",
    "exhausted_lease_failure"
  ];

  return {
    name: "siteflow-postgres-rehearsal",
    status: "passed",
    dryRun: false,
    startedAt: "2026-06-07T10:00:00.000Z",
    completedAt: "2026-06-07T10:05:00.000Z",
    release: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production"
    },
    targetDatabase: {
      redactedUrl: "postgres://postgres.internal:5432/siteflow_rehearsal?sslmode=require",
      host: "postgres.internal",
      port: "5432",
      database: "siteflow_rehearsal",
      sslMode: "require",
      parseStatus: "passed"
    },
    rehearsalScope,
    scenarioResults: rehearsalScope.map((scope) => ({
      scope,
      status: "passed",
      recordedAt: "2026-06-07T10:04:00.000Z",
      assertions: {
        exercised: true
      },
      metrics: {
        durationMs: 1
      }
    })),
    prerequisites: [
      { name: "SITEFLOW_RUN_POSTGRES_INTEGRATION", required: true, status: "passed" },
      { name: "TEST_DATABASE_URL", required: true, status: "passed" },
      { name: "TEST_DATABASE_URL_FORMAT", required: true, status: "passed" }
    ],
    command: {
      executable: "npx",
      args: ["vitest", "run", "worker/postgresRehearsal.integration.test.ts"],
      display: "npx vitest run worker/postgresRehearsal.integration.test.ts"
    },
    exitCode: 0
  };
}

function artifactEvidence() {
  const artifacts = [
    { path: "dist/index.html", sizeBytes: 512, sha256: "a".repeat(64) },
    { path: "dist/assets/index.js", sizeBytes: 1024, sha256: "b".repeat(64) },
    { path: "dist-cli/cli/index.js", sizeBytes: 2048, sha256: "c".repeat(64) },
    { path: "dist-server/server/index.js", sizeBytes: 2048, sha256: "d".repeat(64) },
    { path: "dist-worker/worker/index.js", sizeBytes: 2048, sha256: "e".repeat(64) }
  ];

  return {
    name: "siteflow-release-artifact-check",
    status: "passed",
    checkedAt: "2026-06-07T10:19:30.000Z",
    rootDir: "/repo/siteflow",
    artifactDirs: ["dist", "dist-cli", "dist-server", "dist-worker"],
    selectedEvidence: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production",
      fileCount: artifacts.length,
      totalBytes: artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0),
      packageBinSiteflow: "./dist-cli/cli/index.js",
      auditExitCode: 0
    },
    manifest: {
      schemaVersion: "siteflow.releaseArtifactManifest.v1",
      name: "siteflow-release-artifact-manifest",
      generatedAt: "2026-06-07T10:19:20.000Z",
      rootDir: "/repo/siteflow",
      artifacts
    },
    artifactManifest: {
      functions: []
    },
    checks: requiredReleaseArtifactCheckNames.map(passingCheck),
    exitCode: 0
  };
}

function releaseImageEvidence() {
  return {
    schemaVersion: "siteflow.releaseImageEvidence.v1",
    name: "siteflow-release-image-evidence",
    image: {
      name: "ghcr.io/siteflow/siteflow",
      versionTag: "ghcr.io/siteflow/siteflow:0.1.0",
      commitTag: `ghcr.io/siteflow/siteflow:sha-${commitRef}`,
      digest: `sha256:${"f".repeat(64)}`
    },
    source: {
      repository,
      commitRef,
      refName: "v0.1.0"
    },
    github: {
      runId: "123456789",
      runAttempt: "1"
    },
    attestations: {
      mode: "registry",
      subjectDigest: `sha256:${"f".repeat(64)}`,
      inspector: "docker buildx imagetools inspect --raw",
      inspectedAt: "2026-06-07T10:19:50.000Z",
      provenance: {
        requested: true,
        present: true,
        predicateType: "https://slsa.dev/provenance/v1",
        manifestDigest: `sha256:${"e".repeat(64)}`
      },
      sbom: {
        requested: true,
        present: true,
        predicateType: "https://spdx.dev/Document",
        manifestDigest: `sha256:${"d".repeat(64)}`
      }
    },
    checkedAt: "2026-06-07T10:19:45.000Z"
  };
}

function targetRuntimeEvidence() {
  const digest = `sha256:${"f".repeat(64)}`;

  return {
    name: "siteflow-target-runtime-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T10:20:30.000Z",
    exitCode: 0,
    selectedEvidence: {
      targetEnvironment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef,
      repository,
      branch,
      composeConfig: { status: "passed", timestamp: "2026-06-07T10:20:00.000Z" },
      startup: { status: "passed", timestamp: "2026-06-07T10:20:05.000Z" },
      serviceHealth: { status: "passed", timestamp: "2026-06-07T10:20:10.000Z" },
      readiness: { status: "passed", timestamp: "2026-06-07T10:20:15.000Z" },
      imageBinding: { status: "passed", timestamp: "2026-06-07T10:20:20.000Z" },
      restartSmoke: { status: "passed", timestamp: "2026-06-07T10:20:25.000Z" },
      logSanity: { status: "passed", timestamp: "2026-06-07T10:20:28.000Z" }
    },
    checks: requiredTargetRuntimeEvidenceCheckNames.map(passingCheck),
    targetRuntimeSummary: {
      expectedDigest: digest,
      apiImageDigest: digest,
      workerImageDigest: digest
    }
  };
}

function sourceProviderEvidence() {
  return {
    name: "siteflow-source-provider-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T10:20:00.000Z",
    thresholds: {
      maxAgeHours: 168
    },
    selectedEvidence: {
      environment: "production",
      commitRef,
      repository,
      branch,
      provider: "github",
      webhookDeliveryId: "delivery-123",
      deployKeyMode: "not_required"
    },
    checks: [
      passingCheck("evidence_shape"),
      ...requiredSourceProviderEvidenceCheckNames.map(passingCheck)
    ],
    exitCode: 0
  };
}

function backupEvidence() {
  return {
    name: "siteflow-backup-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T10:30:00.000Z",
    thresholds: {
      maxBackupAgeHours: 24,
      maxRestoreDrillAgeHours: 168,
      requireOffHost: true
    },
    selectedEvidence: {
      backupVerify: {
        status: "verified",
        timestamp: "2026-06-07T10:15:00.000Z",
        backupPath: "/backups/siteflow-20260607",
        offHostLocation: "s3://siteflow-prod-backups/2026-06-07",
        provider: "s3"
      },
      restoreDrill: { status: "restore_drilled", restoreDrill: true, timestamp: "2026-06-07T10:25:00.000Z" },
      backupOffload: {
        status: "offloaded",
        timestamp: "2026-06-07T10:26:00.000Z",
        backupPath: "/backups/siteflow-20260607",
        offHostLocation: "s3://siteflow-prod-backups/2026-06-07",
        provider: "s3",
        encrypted: true,
        kmsKeyRef: backupKmsKeyRef,
        providerKmsProof: true,
        providerRetentionProof: true,
        providerRetentionDays: 30,
        providerRetentionMode: "compliance",
        retentionContract: "s3-object-lock-siteflow-prod"
      },
      backupFetch: {
        status: "fetched",
        timestamp: "2026-06-07T10:26:30.000Z",
        backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260607",
        offHostLocation: "s3://siteflow-prod-backups/2026-06-07",
        provider: "s3"
      },
      backupProviderSecurityAudit: backupProviderSecurityAuditEvidence(),
      backupPrune: {
        status: "pruned",
        timestamp: "2026-06-07T10:27:00.000Z",
        retentionDays: 30,
        minimumBackups: 8,
        dryRun: false
      }
    },
    checks: [
      passingCheck("backup_verify_present"),
      passingCheck("backup_verify_status"),
      passingCheck("backup_age"),
      passingCheck("backup_identifier"),
      passingCheck("backup_database_checksum"),
      passingCheck("backup_artifact_integrity"),
      passingCheck("restore_drill_present"),
      passingCheck("restore_drill_flag"),
      passingCheck("restore_drill_status"),
      passingCheck("restore_drill_age"),
      passingCheck("restore_drill_duration"),
      passingCheck("restore_drill_database_target"),
      passingCheck("restore_drill_artifact_target"),
      passingCheck("restore_drill_artifact_mode"),
      passingCheck("restore_drill_artifact_integrity"),
      passingCheck("operator"),
      passingCheck("ticket"),
      ...requiredOffHostBackupEvidenceCheckNames.map(passingCheck),
      passingCheck("backup_schedule"),
      passingCheck("backup_retention"),
      passingCheck("backup_objectives"),
      passingCheck("backup_monitoring")
    ],
    exitCode: 0
  };
}

function backupAutomationRun() {
  return {
    name: "siteflow-backup-automation-run",
    status: "completed",
    startedAt: "2026-06-07T10:12:00.000Z",
    completedAt: "2026-06-07T10:29:00.000Z",
    backupPath: "/backups/siteflow-20260607",
    evidenceDir: "evidence/backups/2026-06-07",
    evidenceFiles: {
      backup: "evidence/backups/2026-06-07/backup.json",
      backupVerify: "evidence/backups/2026-06-07/backup-verify.json",
      restoreDrill: "evidence/backups/2026-06-07/restore-drill.json",
      backupOffload: "evidence/backups/2026-06-07/backup-offload.json",
      backupFetch: "evidence/backups/2026-06-07/backup-fetch.json",
      backupProviderSecurityAudit: "evidence/backups/2026-06-07/backup-provider-security-audit.json",
      backupPrunePlan: "evidence/backups/2026-06-07/backup-prune-plan.json",
      backupPrune: "evidence/backups/2026-06-07/backup-prune.json",
      backupEvidenceRaw: "evidence/backups/2026-06-07/backup-evidence-raw.json",
      backupEvidenceCheck: "evidence/backups/2026-06-07/backup-evidence.json",
      backupAutomationRun: "evidence/backups/2026-06-07/backup-automation-run.json"
    },
    steps: [
      { id: "backup", status: "completed", outputPath: "evidence/backups/2026-06-07/backup.json" },
      { id: "backup_verify", status: "completed", outputPath: "evidence/backups/2026-06-07/backup-verify.json" },
      { id: "restore_drill", status: "completed", outputPath: "evidence/backups/2026-06-07/restore-drill.json" },
      { id: "backup_offload", status: "completed", outputPath: "evidence/backups/2026-06-07/backup-offload.json" },
      { id: "backup_fetch", status: "completed", outputPath: "evidence/backups/2026-06-07/backup-fetch.json" },
      { id: "backup_provider_security_audit", status: "completed", outputPath: "evidence/backups/2026-06-07/backup-provider-security-audit.json" },
      { id: "backup_prune_plan", status: "completed", outputPath: "evidence/backups/2026-06-07/backup-prune-plan.json" },
      { id: "backup_prune", status: "completed", outputPath: "evidence/backups/2026-06-07/backup-prune.json" },
      { id: "backup_evidence", status: "completed", outputPath: "evidence/backups/2026-06-07/backup-evidence.json" }
    ],
    composeResult: {
      status: "composed",
      checkResult: {
        status: "passed"
      }
    },
    exitCode: 0
  };
}

function observabilityEvidence() {
  return {
    name: "siteflow-observability-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T11:00:00.000Z",
    thresholds: {
      maxAgeHours: 24
    },
    selectedEvidence: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production",
      readinessProbe: { status: "passed", timestamp: "2026-06-07T10:45:00.000Z" },
      metricsScrape: { status: "scraped", timestamp: "2026-06-07T10:46:00.000Z" },
      backupAutomationRun: backupAutomationRun(),
      backupAutomationRunHistory: { status: "completed", timestamp: "2026-06-07T10:46:30.000Z" },
      backupSchedulerOwnership: { status: "applied", timestamp: "2026-06-07T10:46:40.000Z" },
      observabilityApplyProof: { status: "applied", timestamp: "2026-06-07T10:46:30.000Z" },
      observabilityTargetStackProof: { status: "passed", timestamp: "2026-06-07T10:46:45.000Z" },
      alertDelivery: { status: "delivered", timestamp: "2026-06-07T10:47:00.000Z" },
      dashboard: { status: "available", timestamp: "2026-06-07T10:48:00.000Z" },
      logPipeline: { status: "passed", timestamp: "2026-06-07T10:49:00.000Z" }
    },
    checks: [
      passingCheck("release_identity"),
      passingCheck("target_environment"),
      passingCheck("readiness_present"),
      passingCheck("readiness_status"),
      passingCheck("readiness_age"),
      passingCheck("readiness_status_codes"),
      passingCheck("readiness_traffic_removed"),
      passingCheck("metrics_present"),
      passingCheck("metrics_status"),
      passingCheck("metrics_age"),
      passingCheck("metrics_access_control"),
      passingCheck("metrics_expected_names"),
      passingCheck("backup_automation_run_present"),
      passingCheck("backup_automation_run_identity"),
      passingCheck("backup_automation_run_status"),
      passingCheck("backup_automation_run_age"),
      passingCheck("backup_automation_run_steps"),
      passingCheck("backup_automation_checker_output"),
      passingCheck("backup_automation_history_present"),
      passingCheck("backup_automation_history_identity"),
      passingCheck("backup_automation_history_latest_run"),
      passingCheck("backup_automation_history_latest_status"),
      passingCheck("backup_restore_drill_cadence_count"),
      passingCheck("backup_restore_drill_cadence_gap"),
      passingCheck("backup_history_checker_output"),
      passingCheck("backup_scheduler_ownership_present"),
      passingCheck("backup_scheduler_ownership_status"),
      passingCheck("backup_scheduler_ownership_age"),
      passingCheck("backup_scheduler_ownership_schema"),
      passingCheck("backup_scheduler_ownership_source"),
      passingCheck("backup_scheduler_ownership_target_environment"),
      passingCheck("backup_scheduler_ownership_enabled"),
      passingCheck("backup_scheduler_ownership_schedule"),
      passingCheck("backup_scheduler_ownership_command"),
      passingCheck("backup_scheduler_ownership_run_links"),
      passingCheck("backup_scheduler_ownership_owner"),
      passingCheck("observability_apply_proof_present"),
      passingCheck("observability_apply_proof_status"),
      passingCheck("observability_apply_proof_age"),
      passingCheck("observability_apply_proof_schema"),
      passingCheck("observability_apply_proof_source"),
      passingCheck("observability_apply_proof_plan_schema"),
      passingCheck("observability_apply_proof_assets"),
      passingCheck("observability_target_stack_proof_present"),
      passingCheck("observability_target_stack_proof_status"),
      passingCheck("observability_target_stack_proof_age"),
      passingCheck("observability_target_stack_proof_schema"),
      passingCheck("observability_target_stack_proof_source"),
      passingCheck("observability_target_stack_proof_release_identity"),
      passingCheck("observability_target_stack_proof_target_environment"),
      passingCheck("observability_target_stack_prometheus_rules"),
      passingCheck("observability_target_stack_grafana_dashboard"),
      passingCheck("observability_target_stack_alertmanager_receiver"),
      passingCheck("alert_present"),
      passingCheck("alert_status"),
      passingCheck("alert_age"),
      passingCheck("alert_delivered"),
      passingCheck("dashboard_present"),
      passingCheck("dashboard_status"),
      passingCheck("dashboard_age"),
      passingCheck("dashboard_reference"),
      passingCheck("dashboard_owner"),
      passingCheck("log_pipeline_present"),
      passingCheck("log_pipeline_status"),
      passingCheck("log_pipeline_age"),
      passingCheck("log_retention"),
      passingCheck("log_redaction_spot_check"),
      passingCheck("no_sensitive_evidence_values")
    ],
    exitCode: 0
  };
}

function operatorAccessEvidence() {
  return {
    name: "siteflow-operator-access-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T11:03:00.000Z",
    thresholds: {
      maxAgeHours: 168
    },
    selectedEvidence: {
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef,
      repository,
      branch,
      sessionCreate: {
        status: "passed",
        timestamp: "2026-06-07T10:50:00.000Z"
      },
      projectScope: {
        status: "passed",
        timestamp: "2026-06-07T10:51:00.000Z"
      },
      sessionRotation: {
        status: "passed",
        timestamp: "2026-06-07T10:51:30.000Z"
      },
      sessionRevoke: {
        status: "revoked",
        timestamp: "2026-06-07T10:52:00.000Z"
      },
      csrf: {
        status: "enforced",
        timestamp: "2026-06-07T10:53:00.000Z"
      },
      bearerPrecedence: {
        status: "passed",
        timestamp: "2026-06-07T10:54:00.000Z"
      },
      actorAttribution: {
        status: "passed",
        timestamp: "2026-06-07T10:55:00.000Z"
      },
      emergencyCutoff: {
        status: "passed",
        timestamp: "2026-06-07T10:56:00.000Z"
      },
      browserTokenFallback: {
        status: "passed",
        timestamp: "2026-06-07T10:57:00.000Z",
        productionFallbackEnabled: false,
        localStorageFallbackDisabled: true
      }
    },
    checks: [
      passingCheck("evidence_shape"),
      passingCheck("schema_version"),
      passingCheck("evidence_name"),
      passingCheck("evidence_status"),
      passingCheck("non_dry_run"),
      passingCheck("not_template"),
      passingCheck("status_final"),
      passingCheck("evidence_age"),
      passingCheck("release_identity"),
      passingCheck("environment"),
      passingCheck("public_base_url"),
      passingCheck("session_create_present"),
      passingCheck("session_create_status"),
      passingCheck("session_create_age"),
      passingCheck("session_cookie_flags"),
      passingCheck("session_secret_not_returned"),
      passingCheck("session_policy_present"),
      passingCheck("session_policy_enforced"),
      passingCheck("session_policy_age"),
      passingCheck("project_scope_present"),
      passingCheck("project_scope_enforced"),
      passingCheck("project_scope_age"),
      passingCheck("session_rotation_present"),
      passingCheck("session_rotation_status"),
      passingCheck("session_rotation_cookie_flags"),
      passingCheck("session_rotation_secret_not_returned"),
      passingCheck("session_rotation_csrf_enforced"),
      passingCheck("session_rotation_old_cookie_rejected"),
      passingCheck("session_rotation_age"),
      passingCheck("session_revoke_present"),
      passingCheck("session_revoke_status"),
      passingCheck("session_revoke_age"),
      passingCheck("csrf_present"),
      passingCheck("csrf_enforced"),
      passingCheck("csrf_age"),
      passingCheck("bearer_precedence_present"),
      passingCheck("bearer_precedence_enforced"),
      passingCheck("bearer_precedence_age"),
      passingCheck("actor_attribution_present"),
      passingCheck("actor_attribution_enforced"),
      passingCheck("actor_attribution_age"),
      passingCheck("emergency_cutoff_present"),
      passingCheck("emergency_cutoff_global"),
      passingCheck("emergency_cutoff_project"),
      passingCheck("emergency_cutoff_cookie_only_rejected"),
      passingCheck("emergency_cutoff_low_scope_bearer"),
      passingCheck("emergency_cutoff_old_cookie_rejected"),
      passingCheck("emergency_cutoff_age"),
      passingCheck("browser_token_fallback_present"),
      passingCheck("browser_token_fallback_posture"),
      passingCheck("browser_token_fallback_exception_documented"),
      passingCheck("browser_token_fallback_local_storage_disabled"),
      passingCheck("browser_token_fallback_age"),
      passingCheck("negative_evidence_present"),
      passingCheck("no_raw_secrets_stored"),
      passingCheck("no_sensitive_evidence_values"),
      passingCheck("non_goals_not_claimed"),
      passingCheck("operator"),
      passingCheck("ticket")
    ],
    exitCode: 0
  };
}

function nonSessionCredentialEvidence() {
  return {
    name: "siteflow-non-session-credential-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T11:02:00.000Z",
    thresholds: {
      maxAgeHours: 168
    },
    selectedEvidence: {
      environment: "production",
      commitRef,
      repository,
      branch,
      credentialTypes: ["scoped_api_token"],
      credentialCount: 1,
      breakGlass: {
        status: "passed",
        ticket: "INC-123"
      }
    },
    checks: [
      passingCheck("evidence_shape"),
      passingCheck("schema_version"),
      passingCheck("evidence_name"),
      passingCheck("evidence_status"),
      passingCheck("evidence_age"),
      ...requiredNonSessionCredentialEvidenceCheckNames.map(passingCheck)
    ],
    exitCode: 0
  };
}

function upgradeRollbackEvidence() {
  return {
    name: "siteflow-upgrade-rollback-drill-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T11:10:00.000Z",
    thresholds: {
      maxAgeHours: 168
    },
    selectedEvidence: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production",
      fromVersion: "0.1.0",
      toVersion: "0.1.1",
      rollbackVersion: "0.1.0",
      upgradeOperationId: "op_upgrade_1",
      rollbackOperationId: "op_rollback_1"
    },
    checks: [
      passingCheck("evidence_shape"),
      passingCheck("schema_version"),
      passingCheck("evidence_name"),
      passingCheck("drill_status"),
      passingCheck("non_dry_run"),
      passingCheck("not_template"),
      passingCheck("status_final"),
      passingCheck("no_sensitive_evidence_values"),
      passingCheck("drill_age"),
      passingCheck("drill_time_order"),
      passingCheck("target_environment"),
      passingCheck("version_pair"),
      passingCheck("rollback_version"),
      passingCheck("release_identity"),
      passingCheck("api_image_digests"),
      passingCheck("worker_image_digests"),
      passingCheck("service_rollback_digest"),
      passingCheck("migration_versions"),
      passingCheck("schema_rollback_compatibility"),
      passingCheck("backup_evidence_passed"),
      passingCheck("release_operations"),
      passingCheck("route_upgrade"),
      passingCheck("route_rollback_restores_previous_artifact"),
      passingCheck("http_rollback_verification"),
      passingCheck("readiness_evidence"),
      passingCheck("metrics_evidence"),
      passingCheck("logs_evidence"),
      passingCheck("alert_evidence"),
      passingCheck("operator"),
      passingCheck("ticket")
    ],
    exitCode: 0
  };
}

function ingressEvidence() {
  return {
    name: "siteflow-ingress-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T11:05:00.000Z",
    thresholds: {
      maxAgeHours: 168
    },
    selectedEvidence: {
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef,
      repository,
      branch,
      trustProxyPolicy: "loopback",
      deploymentTopology: {
        apiInstanceCount: 2,
        apiProcessCount: 2,
        ingressCount: 1
      },
      directApiPort: {
        status: "blocked",
        timestamp: "2026-06-07T10:55:00.000Z"
      },
      forwardedHeaders: {
        status: "passed",
        timestamp: "2026-06-07T10:56:00.000Z"
      },
      apiRateLimit: {
        status: "limited",
        timestamp: "2026-06-07T10:57:00.000Z",
        edgeEnforced: true
      },
      unthrottledRoutes: {
        status: "passed",
        timestamp: "2026-06-07T10:58:00.000Z"
      }
    },
    checks: [
      passingCheck("evidence_shape"),
      passingCheck("schema_version"),
      passingCheck("evidence_name"),
      passingCheck("evidence_status"),
      ...requiredIngressEvidenceCheckNames.map(passingCheck)
    ],
    exitCode: 0
  };
}

async function writeEvidenceSet(root: string) {
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot, { recursive: true });

  const paths = {
    releaseGate: path.join(evidenceRoot, "release-gate.json"),
    dockerBuild: path.join(evidenceRoot, "docker-build.json"),
    postgres: path.join(evidenceRoot, "postgres.json"),
    artifact: path.join(evidenceRoot, "release-artifact.json"),
    releaseImage: path.join(evidenceRoot, "release-image-evidence.json"),
    targetRuntime: path.join(evidenceRoot, "target-runtime-evidence.json"),
    sourceProvider: path.join(evidenceRoot, "source-provider.json"),
    backup: path.join(evidenceRoot, "backup.json"),
    observability: path.join(evidenceRoot, "observability.json"),
    operatorAccess: path.join(evidenceRoot, "operator-access.json"),
    nonSessionCredential: path.join(evidenceRoot, "non-session-credential.json"),
    ingress: path.join(evidenceRoot, "ingress.json"),
    upgradeRollback: path.join(evidenceRoot, "upgrade-rollback.json")
  };

  await writeFile(paths.releaseGate, `${JSON.stringify(releaseGateEvidence())}\n`, "utf8");
  await writeFile(paths.dockerBuild, `${JSON.stringify(dockerBuildEvidence())}\n`, "utf8");
  await writeFile(paths.postgres, `${JSON.stringify(postgresEvidence())}\n`, "utf8");
  await writeFile(paths.artifact, `${JSON.stringify(artifactEvidence())}\n`, "utf8");
  await writeFile(paths.releaseImage, `${JSON.stringify(releaseImageEvidence())}\n`, "utf8");
  await writeFile(paths.targetRuntime, `${JSON.stringify(targetRuntimeEvidence())}\n`, "utf8");
  await writeFile(paths.sourceProvider, `${JSON.stringify(sourceProviderEvidence())}\n`, "utf8");
  await writeFile(paths.backup, `${JSON.stringify(backupEvidence())}\n`, "utf8");
  await writeFile(paths.observability, `${JSON.stringify(observabilityEvidence())}\n`, "utf8");
  await writeFile(paths.operatorAccess, `${JSON.stringify(operatorAccessEvidence())}\n`, "utf8");
  await writeFile(paths.nonSessionCredential, `${JSON.stringify(nonSessionCredentialEvidence())}\n`, "utf8");
  await writeFile(paths.ingress, `${JSON.stringify(ingressEvidence())}\n`, "utf8");
  await writeFile(paths.upgradeRollback, `${JSON.stringify(upgradeRollbackEvidence())}\n`, "utf8");

  return paths;
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeHostBuildExceptionEvidenceSet(root: string) {
  const paths = await writeEvidenceSet(root);
  await writeFile(paths.releaseGate, `${JSON.stringify(hostBuildExceptionReleaseGateEvidence())}\n`, "utf8");
  return paths;
}

describe("releaseEvidenceBundleCompose", () => {
  it("composes a release evidence bundle that passes the bundle checker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-"));

    try {
      const paths = await writeEvidenceSet(root);
      const result = await composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      });

      expect(result.status).toBe("composed");
      expect(result.bundle).toMatchObject({
        schemaVersion: "siteflow.releaseEvidence.v1",
        name: "siteflow-release-evidence-bundle",
        checkedAt: "2026-06-07T12:00:00.000Z",
        release: {
          commitRef,
          repository,
          branch,
          requiredStatusCheck,
          operatorName: "release-operator",
          releaseTicket: "REL-2026-0607",
          dockerSocketProfileAccepted: true
        },
        dockerBuildRehearsal: {
          sourcePath: paths.dockerBuild,
          releaseCommit: commitRef
        },
        sourceProviderEvidence: {
          sourcePath: paths.sourceProvider,
          releaseCommit: commitRef
        },
        artifactEvidence: {
          sourcePath: paths.artifact,
          releaseCommit: commitRef
        },
        releaseImageEvidence: {
          sourcePath: paths.releaseImage,
          releaseCommit: commitRef
        },
        upgradeRollbackEvidence: {
          sourcePath: paths.upgradeRollback,
          releaseCommit: commitRef
        },
        ingressEvidence: {
          sourcePath: paths.ingress,
          releaseCommit: commitRef
        },
        operatorAccessEvidence: {
          sourcePath: paths.operatorAccess,
          releaseCommit: commitRef
        },
        nonSessionCredentialEvidence: {
          sourcePath: paths.nonSessionCredential,
          releaseCommit: commitRef
        }
      });

      const check = evaluateReleaseEvidenceBundle(result.bundle, {
        evidencePath: "release-evidence.json",
        commitRef,
        repo: repository,
        branch,
        now
      });

      expect(check.checks.filter((entry) => entry.status === "fail")).toEqual([]);
      expect(check.status).toBe("passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["source provider", "sourceProvider", { ...sourceProviderEvidence(), template: true }, /source provider evidence is a template/],
    ["target runtime", "targetRuntime", { ...targetRuntimeEvidence(), template: true }, /target runtime evidence is a template/],
    ["operator access", "operatorAccess", { ...operatorAccessEvidence(), dryRun: true }, /operator access evidence is dry-run output/],
    ["non-session credential", "nonSessionCredential", { ...nonSessionCredentialEvidence(), template: true }, /non-session credential evidence is a template/],
    ["ingress", "ingress", { ...ingressEvidence(), status: "blocked" }, /ingress evidence has status blocked/],
    ["upgrade/rollback", "upgradeRollback", { ...upgradeRollbackEvidence(), status: "todo" }, /upgrade\/rollback drill evidence has status todo/]
  ] as const)("rejects %s template or non-final evidence before writing a bundle", async (_label, pathKey, replacement, expectedMessage) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-template-"));

    try {
      const paths = await writeEvidenceSet(root);
      const outputPath = path.join(root, "release-evidence.json");

      await writeFile(paths[pathKey], `${JSON.stringify(replacement)}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        outputPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(expectedMessage);
      expect(await exists(outputPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "source provider failed status",
      "sourceProvider",
      () => ({ ...sourceProviderEvidence(), status: "failed" }),
      /source provider evidence must have status passed/
    ],
    [
      "target runtime failed check",
      "targetRuntime",
      () => ({
        ...targetRuntimeEvidence(),
        checks: [
          ...targetRuntimeEvidence().checks,
          { name: "image_binding_digests", status: "fail", message: "digest mismatch" }
        ]
      }),
      /target runtime evidence must include non-empty checks and all checks must pass/
    ],
    [
      "operator access wrong checker name",
      "operatorAccess",
      () => ({ ...operatorAccessEvidence(), name: "siteflow-operator-access-template" }),
      /operator access evidence must be checked by siteflow-operator-access-evidence-check/
    ],
    [
      "ingress missing checkedAt",
      "ingress",
      () => {
        const evidence = ingressEvidence() as Record<string, unknown>;
        delete evidence.checkedAt;
        return evidence;
      },
      /ingress evidence must include a checkedAt timestamp/
    ],
    [
      "ingress non-ISO checkedAt",
      "ingress",
      () => ({
        ...ingressEvidence(),
        checkedAt: "June 7, 2026 11:30 UTC"
      }),
      /ingress evidence must include a checkedAt timestamp/
    ],
    [
      "source provider target environment mismatch",
      "sourceProvider",
      () => {
        const evidence = sourceProviderEvidence();
        (evidence.selectedEvidence as Record<string, unknown>).environment = "staging";
        return evidence;
      },
      /source provider evidence target environment staging does not match production/
    ]
  ] as const)("rejects %s before writing a bundle", async (_label, pathKey, replacementFactory, expectedMessage) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-final-checker-"));

    try {
      const paths = await writeEvidenceSet(root);
      const outputPath = path.join(root, "release-evidence.json");

      await writeFile(paths[pathKey], `${JSON.stringify(replacementFactory())}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        outputPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(expectedMessage);
      expect(await exists(outputPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects evidence inputs with raw secret-like values before writing a bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-secret-scan-"));

    try {
      const paths = await writeEvidenceSet(root);
      const outputPath = path.join(root, "release-evidence.json");
      const operatorAccess = operatorAccessEvidence();
      const selectedEvidence = operatorAccess.selectedEvidence as Record<string, unknown>;

      selectedEvidence.sessionCreate = {
        ...(selectedEvidence.sessionCreate as Record<string, unknown>),
        authorization: "Bearer abcdefghijklmnop"
      };
      await writeFile(paths.operatorAccess, `${JSON.stringify(operatorAccess)}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        outputPath,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/operator access evidence includes raw secret-like values/);
      expect(await exists(outputPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when Docker runner promotion evidence lacks Docker build rehearsal input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-missing-docker-"));

    try {
      const paths = await writeEvidenceSet(root);

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/Docker build rehearsal evidence is required/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when Docker runner promotion evidence lacks trusted socket profile acceptance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-missing-docker-socket-acceptance-"));

    try {
      const paths = await writeEvidenceSet(root);

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/Docker socket trusted profile must be explicitly accepted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when a host build exception is not explicitly accepted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-host-exception-missing-"));

    try {
      const paths = await writeHostBuildExceptionEvidenceSet(root);

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/Host build exception must be explicitly accepted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records an accepted host build exception and passes the bundle checker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-host-exception-"));

    try {
      const paths = await writeHostBuildExceptionEvidenceSet(root);
      const result = await composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        hostBuildExceptionAccepted: true,
        now
      });

      expect(result.bundle).toMatchObject({
        release: {
          hostBuildExceptionAccepted: true
        }
      });
      expect(result.bundle).not.toHaveProperty("dockerBuildRehearsal");

      const check = evaluateReleaseEvidenceBundle(result.bundle, {
        evidencePath: "release-evidence.json",
        commitRef,
        repo: repository,
        branch,
        now
      });

      expect(check.checks.filter((entry) => entry.status === "fail")).toEqual([]);
      expect(check.status).toBe("passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Docker build rehearsal evidence for a different release commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-docker-commit-mismatch-"));

    try {
      const paths = await writeEvidenceSet(root);
      await writeFile(paths.dockerBuild, `${JSON.stringify({
        ...dockerBuildEvidence(),
        releaseCommit: "different-commit"
      })}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/Docker build rehearsal evidence commit different-commit does not match release commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Docker build rehearsal evidence without raw release identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-docker-missing-identity-"));

    try {
      const paths = await writeEvidenceSet(root);
      const dockerBuild = dockerBuildEvidence() as Record<string, unknown>;

      delete dockerBuild.releaseCommit;
      delete dockerBuild.repository;
      delete dockerBuild.branch;
      await writeFile(paths.dockerBuild, `${JSON.stringify(dockerBuild)}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/Docker build rehearsal evidence must include commit, repository, and branch release identity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Postgres rehearsal evidence without raw release identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-postgres-missing-identity-"));

    try {
      const paths = await writeEvidenceSet(root);
      const postgres = postgresEvidence() as Record<string, unknown>;

      delete postgres.release;
      await writeFile(paths.postgres, `${JSON.stringify(postgres)}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/postgres rehearsal evidence must include commit, repository, and branch release identity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects upgrade/rollback drill evidence for a different release commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-upgrade-rollback-mismatch-"));

    try {
      const paths = await writeEvidenceSet(root);
      await writeFile(paths.upgradeRollback, `${JSON.stringify({
        ...upgradeRollbackEvidence(),
        selectedEvidence: {
          ...upgradeRollbackEvidence().selectedEvidence,
          commitRef: "different-commit"
        }
      })}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/upgrade\/rollback drill evidence commit different-commit does not match release commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects release image evidence for a different release commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-image-mismatch-"));

    try {
      const paths = await writeEvidenceSet(root);
      await writeFile(paths.releaseImage, `${JSON.stringify({
        ...releaseImageEvidence(),
        source: {
          ...releaseImageEvidence().source,
          commitRef: "different-commit"
        }
      })}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/release image evidence commit different-commit does not match release commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects release image evidence without attestation inspection metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-image-attestations-"));

    try {
      const paths = await writeEvidenceSet(root);
      const releaseImage = releaseImageEvidence() as Record<string, unknown>;

      delete releaseImage.attestations;

      await writeFile(paths.releaseImage, `${JSON.stringify(releaseImage)}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/release image evidence attestations must be inspected from the registry/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-session credential evidence for a different release commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-non-session-credential-mismatch-"));

    try {
      const paths = await writeEvidenceSet(root);
      await writeFile(paths.nonSessionCredential, `${JSON.stringify({
        ...nonSessionCredentialEvidence(),
        selectedEvidence: {
          ...nonSessionCredentialEvidence().selectedEvidence,
          commitRef: "different-commit"
        }
      })}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(/non-session credential evidence commit different-commit does not match release commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["repository", { repository: "different/repo" }, /Docker build rehearsal evidence repository different\/repo does not match release repository/],
    ["branch", { branch: "release" }, /Docker build rehearsal evidence branch release does not match release branch/]
  ])("rejects Docker build rehearsal evidence for a different %s", async (_field, dockerOverride, expectedMessage) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-docker-identity-mismatch-"));

    try {
      const paths = await writeEvidenceSet(root);
      await writeFile(paths.dockerBuild, `${JSON.stringify({
        ...dockerBuildEvidence(),
        ...dockerOverride
      })}\n`, "utf8");

      await expect(composeReleaseEvidenceBundle({
        releaseGatePath: paths.releaseGate,
        dockerBuildRehearsalPath: paths.dockerBuild,
        dockerSocketProfileAccepted: true,
        postgresRehearsalPath: paths.postgres,
        artifactEvidencePath: paths.artifact,
        releaseImageEvidencePath: paths.releaseImage,
        targetRuntimeEvidencePath: paths.targetRuntime,
        sourceProviderEvidencePath: paths.sourceProvider,
        backupEvidencePath: paths.backup,
        observabilityEvidencePath: paths.observability,
        operatorAccessEvidencePath: paths.operatorAccess,
        nonSessionCredentialEvidencePath: paths.nonSessionCredential,
        ingressEvidencePath: paths.ingress,
        upgradeRollbackEvidencePath: paths.upgradeRollback,
        operatorName: "release-operator",
        releaseTicket: "REL-2026-0607",
        now
      })).rejects.toThrow(expectedMessage);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes the bundle to --output and prints JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-compose-cli-"));
    let stdout = "";
    let stderr = "";

    try {
      const paths = await writeEvidenceSet(root);
      const outputPath = path.join(root, "release-evidence.json");
      const exitCode = await runReleaseEvidenceBundleComposeCli(
        [
          "--release-gate", paths.releaseGate,
          "--docker-build", paths.dockerBuild,
          "--postgres-rehearsal", paths.postgres,
          "--artifact-evidence", paths.artifact,
          "--release-image-evidence", paths.releaseImage,
          "--target-runtime-evidence", paths.targetRuntime,
          "--source-provider-evidence", paths.sourceProvider,
          "--backup-evidence", paths.backup,
          "--observability-evidence", paths.observability,
          "--operator-access-evidence", paths.operatorAccess,
          "--non-session-credential-evidence", paths.nonSessionCredential,
          "--ingress-evidence", paths.ingress,
          "--upgrade-rollback-evidence", paths.upgradeRollback,
          "--operator-name", "release-operator",
          "--ticket-id", "REL-2026-0607",
          "--docker-socket-profile-accepted",
          "--checked-at", "2026-06-07T12:34:56.000Z",
          "--output", outputPath,
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { now }
      );
      const printed = JSON.parse(stdout);
      const written = JSON.parse(await readFile(outputPath, "utf8"));

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toMatchObject({
        schemaVersion: "siteflow.releaseEvidence.v1",
        checkedAt: "2026-06-07T12:34:56.000Z",
        release: {
          commitRef
        }
      });
      expect(written).toEqual(printed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
