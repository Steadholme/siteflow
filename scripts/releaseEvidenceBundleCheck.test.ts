import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateReleaseEvidenceBundle,
  runReleaseEvidenceBundleCheckCli
} from "./releaseEvidenceBundleCheck";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck";

const now = () => new Date("2026-06-07T12:00:00.000Z");
const commitRef = "abc123def456";
const repository = "acme/siteflow";
const branch = "main";
const requiredStatusCheck = "Install, test, and build";
const pinnedBuildImage = "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const backupKmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";
const postgresRehearsalScopes = [
  "migration_advisory_lock",
  "migration_checksum_drift",
  "concurrent_migration_startup",
  "skip_locked_claim",
  "concurrent_worker_claim",
  "lease_heartbeat",
  "stale_lease_recovery",
  "exhausted_lease_failure"
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

function validReleaseGateEvidence() {
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
          conclusion: "success",
          htmlUrl: "https://github.example/acme/siteflow/actions/runs/1"
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
        buildImage: pinnedBuildImage,
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

function validPostgresEvidence() {
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
    rehearsalScope: postgresRehearsalScopes,
    scenarioResults: postgresRehearsalScopes.map((scope) => ({
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
      {
        name: "SITEFLOW_RUN_POSTGRES_INTEGRATION",
        required: true,
        status: "passed",
        message: "SITEFLOW_RUN_POSTGRES_INTEGRATION is set to 1."
      },
      {
        name: "TEST_DATABASE_URL",
        required: true,
        status: "passed",
        message: "TEST_DATABASE_URL is present."
      },
      {
        name: "TEST_DATABASE_URL_FORMAT",
        required: true,
        status: "passed",
        message: "TEST_DATABASE_URL parses as a Postgres connection URL."
      }
    ],
    command: {
      executable: "npx",
      args: ["vitest", "run", "worker/postgresRehearsal.integration.test.ts"],
      display: "npx vitest run worker/postgresRehearsal.integration.test.ts"
    },
    exitCode: 0
  };
}

function validDockerBuildEvidence() {
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
      image: pinnedBuildImage,
      imageDigestPinned: true,
      imageAllowlistConfigured: false,
      imageAllowedByAllowlist: false,
      imageTaggedTrustedExceptionAccepted: false,
      network: "none",
      memory: "1g",
      cpus: "2",
      pidsLimit: 256,
      user: "1000:1000",
      dockerVersion: "Docker version 27.0.0",
      dockerInfoAvailable: true
    },
    prerequisites: [
      {
        name: "SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL",
        required: true,
        status: "passed",
        message: "SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL is set to 1."
      },
      {
        name: "SITEFLOW_BUILD_IMAGE",
        required: true,
        status: "passed",
        message: "SITEFLOW_BUILD_IMAGE is present."
      },
      {
        name: "docker_cli",
        required: true,
        status: "passed",
        message: "Docker CLI is available."
      },
      {
        name: "docker_daemon",
        required: true,
        status: "passed",
        message: "Docker daemon is reachable."
      }
    ],
    buildCommands: ["npm ci", "npm run build"],
    artifact: {
      entrypoint: "index.html",
      fileCount: 3,
      totalBytes: 512,
      checksum: "sha256:rehearsal"
    },
    artifactLimits: {
      maxArtifactBytes: 536870912,
      maxArtifactFiles: 20000
    },
    redactionVerified: true,
    exitCode: 0
  };
}

function validArtifactEvidence() {
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

function sameProcessFunctionArtifactEvidence() {
  const evidence = validArtifactEvidence() as ReturnType<typeof validArtifactEvidence> & Record<string, unknown>;
  const artifactManifest = evidence.artifactManifest as Record<string, unknown>;

  artifactManifest.functions = [
    {
      path: "/api/revalidate",
      sourcePath: ".siteflow/functions/api/revalidate.js",
      runtime: "nodejs20.x",
      handler: "default"
    }
  ];
  artifactManifest.runtimeIsolation = "same_process";

  return evidence;
}

function functionArtifactEvidenceWithRuntimeIsolation(runtimeIsolation?: unknown) {
  const evidence = validArtifactEvidence() as ReturnType<typeof validArtifactEvidence> & Record<string, unknown>;
  const artifactManifest = evidence.artifactManifest as Record<string, unknown>;
  const entry: Record<string, unknown> = {
    path: "/api/revalidate",
    sourcePath: ".siteflow/functions/api/revalidate.js",
    runtime: "nodejs20.x",
    handler: "default"
  };

  if (runtimeIsolation !== undefined) {
    entry.runtimeIsolation = runtimeIsolation;
  }

  artifactManifest.functions = [entry];

  return evidence;
}

function validReleaseImageEvidence() {
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

function validSourceProviderEvidence() {
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

function validTargetRuntimeEvidence() {
  const digest = `sha256:${"f".repeat(64)}`;

  return {
    name: "siteflow-target-runtime-evidence-check",
    status: "passed",
    checkedAt: "2026-06-07T10:22:00.000Z",
    evidencePath: "evidence/target-runtime-evidence-raw.json",
    thresholds: {
      maxAgeHours: 168
    },
    selectedEvidence: {
      targetEnvironment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef,
      repository,
      branch,
      composeConfig: {
        status: "passed",
        timestamp: "2026-06-07T10:21:00.000Z"
      },
      startup: {
        status: "passed",
        timestamp: "2026-06-07T10:21:10.000Z"
      },
      serviceHealth: {
        status: "passed",
        timestamp: "2026-06-07T10:21:20.000Z"
      },
      readiness: {
        status: "passed",
        timestamp: "2026-06-07T10:21:30.000Z"
      },
      imageBinding: {
        status: "passed",
        timestamp: "2026-06-07T10:21:40.000Z",
        expectedDigest: digest,
        apiImageDigest: digest,
        workerImageDigest: digest
      },
      restartSmoke: {
        status: "passed",
        timestamp: "2026-06-07T10:21:50.000Z"
      },
      logSanity: {
        status: "passed",
        timestamp: "2026-06-07T10:22:00.000Z"
      }
    },
    release: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production"
    },
    checks: [
      passingCheck("evidence_shape"),
      ...requiredTargetRuntimeEvidenceCheckNames.map(passingCheck)
    ],
    exitCode: 0
  };
}

function validBackupEvidence() {
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
      restoreDrill: {
        status: "restore_drilled",
        restoreDrill: true,
        timestamp: "2026-06-07T10:25:00.000Z"
      },
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

function validBackupAutomationRun() {
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

function validObservabilityEvidence() {
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
      readinessProbe: {
        status: "passed",
        timestamp: "2026-06-07T10:45:00.000Z"
      },
      metricsScrape: {
        status: "scraped",
        timestamp: "2026-06-07T10:46:00.000Z"
      },
      backupAutomationRun: validBackupAutomationRun(),
      backupAutomationRunHistory: {
        status: "completed",
        timestamp: "2026-06-07T10:46:30.000Z"
      },
      backupSchedulerOwnership: {
        status: "applied",
        timestamp: "2026-06-07T10:46:40.000Z"
      },
      observabilityApplyProof: {
        status: "applied",
        timestamp: "2026-06-07T10:46:30.000Z"
      },
      observabilityTargetStackProof: {
        status: "passed",
        timestamp: "2026-06-07T10:46:45.000Z"
      },
      alertDelivery: {
        status: "delivered",
        timestamp: "2026-06-07T10:47:00.000Z"
      },
      dashboard: {
        status: "available",
        timestamp: "2026-06-07T10:48:00.000Z"
      },
      logPipeline: {
        status: "passed",
        timestamp: "2026-06-07T10:49:00.000Z"
      }
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

function validOperatorAccessEvidence() {
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

function validNonSessionCredentialEvidence() {
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
      passingCheck("non_dry_run"),
      passingCheck("not_template"),
      passingCheck("status_final"),
      passingCheck("evidence_age"),
      passingCheck("release_identity"),
      passingCheck("environment"),
      passingCheck("operator"),
      passingCheck("ticket"),
      passingCheck("credentials_present"),
      passingCheck("credential_types_supported"),
      passingCheck("credential_owners_and_tickets"),
      passingCheck("credential_status"),
      passingCheck("credential_age"),
      passingCheck("credential_redacted_identifiers"),
      passingCheck("no_raw_credentials_archived"),
      passingCheck("no_sensitive_evidence_values"),
      passingCheck("old_credentials_rejected"),
      passingCheck("new_credentials_accepted"),
      passingCheck("credential_specific_evidence"),
      passingCheck("break_glass_present"),
      passingCheck("break_glass_status"),
      passingCheck("break_glass_age"),
      passingCheck("break_glass_controls"),
      passingCheck("automation_not_claimed")
    ],
    exitCode: 0
  };
}

function validUpgradeRollbackEvidence() {
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

function validIngressEvidence() {
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
      passingCheck("non_dry_run"),
      passingCheck("not_template"),
      passingCheck("status_final"),
      passingCheck("evidence_age"),
      passingCheck("release_identity"),
      passingCheck("environment"),
      passingCheck("no_sensitive_evidence_values"),
      passingCheck("public_base_url"),
      passingCheck("deployment_topology_present"),
      passingCheck("direct_api_port_present"),
      passingCheck("direct_api_port_blocked"),
      passingCheck("direct_api_port_age"),
      passingCheck("forwarded_headers_present"),
      passingCheck("forwarded_headers_overwritten"),
      passingCheck("forwarded_headers_age"),
      passingCheck("proxy_source_policy_present"),
      passingCheck("proxy_source_policy_allowed"),
      passingCheck("proxy_source_policy_matches"),
      passingCheck("api_rate_limit_present"),
      passingCheck("api_rate_limit_status"),
      passingCheck("api_rate_limit_age"),
      passingCheck("api_rate_limit_429"),
      passingCheck("api_rate_limit_bucket"),
      passingCheck("api_rate_limit_topology"),
      passingCheck("unthrottled_routes_present"),
      passingCheck("unthrottled_routes_age"),
      passingCheck("unthrottled_routes_not_limited"),
      passingCheck("operator"),
      passingCheck("ticket")
    ],
    exitCode: 0
  };
}

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.releaseEvidence.v1",
    name: "siteflow-release-evidence-bundle",
    checkedAt: "2026-06-07T11:30:00.000Z",
    targetEnvironment: "production",
    release: {
      commitRef,
      repository,
      branch,
      requiredStatusCheck,
      operatorName: "release-operator",
      releaseTicket: "REL-2026-0607",
      dockerSocketProfileAccepted: true
    },
    releaseGate: {
      sourcePath: "evidence/release-gate.json",
      collectedAt: "2026-06-07T10:10:00.000Z",
      releaseCommit: commitRef,
      evidence: validReleaseGateEvidence()
    },
    postgresRehearsal: {
      sourcePath: "evidence/postgres-rehearsal.json",
      collectedAt: "2026-06-07T10:06:00.000Z",
      releaseCommit: commitRef,
      evidence: validPostgresEvidence()
    },
    dockerBuildRehearsal: {
      sourcePath: "evidence/docker-build-rehearsal.json",
      collectedAt: "2026-06-07T10:19:00.000Z",
      releaseCommit: commitRef,
      evidence: validDockerBuildEvidence()
    },
    artifactEvidence: {
      sourcePath: "evidence/release-artifact-evidence.json",
      collectedAt: "2026-06-07T10:20:00.000Z",
      releaseCommit: commitRef,
      evidence: validArtifactEvidence()
    },
    releaseImageEvidence: {
      sourcePath: "evidence/release-image-evidence.json",
      collectedAt: "2026-06-07T10:20:30.000Z",
      releaseCommit: commitRef,
      evidence: validReleaseImageEvidence()
    },
    sourceProviderEvidence: {
      sourcePath: "evidence/source-provider-evidence.json",
      collectedAt: "2026-06-07T10:21:00.000Z",
      releaseCommit: commitRef,
      evidence: validSourceProviderEvidence()
    },
    targetRuntimeEvidence: {
      sourcePath: "evidence/target-runtime-evidence.json",
      collectedAt: "2026-06-07T10:22:30.000Z",
      releaseCommit: commitRef,
      evidence: validTargetRuntimeEvidence()
    },
    backupEvidence: {
      sourcePath: "evidence/backup-evidence.json",
      collectedAt: "2026-06-07T10:31:00.000Z",
      releaseCommit: commitRef,
      evidence: validBackupEvidence()
    },
    observabilityEvidence: {
      sourcePath: "evidence/observability-evidence.json",
      collectedAt: "2026-06-07T11:01:00.000Z",
      releaseCommit: commitRef,
      evidence: validObservabilityEvidence()
    },
    operatorAccessEvidence: {
      sourcePath: "evidence/operator-access-evidence.json",
      collectedAt: "2026-06-07T11:04:00.000Z",
      releaseCommit: commitRef,
      evidence: validOperatorAccessEvidence()
    },
    nonSessionCredentialEvidence: {
      sourcePath: "evidence/non-session-credential-evidence.json",
      collectedAt: "2026-06-07T11:04:30.000Z",
      releaseCommit: commitRef,
      evidence: validNonSessionCredentialEvidence()
    },
    ingressEvidence: {
      sourcePath: "evidence/ingress-evidence.json",
      collectedAt: "2026-06-07T11:06:00.000Z",
      releaseCommit: commitRef,
      evidence: validIngressEvidence()
    },
    upgradeRollbackEvidence: {
      sourcePath: "evidence/upgrade-rollback-evidence.json",
      collectedAt: "2026-06-07T11:11:00.000Z",
      releaseCommit: commitRef,
      evidence: validUpgradeRollbackEvidence()
    },
    ...overrides
  };
}

describe("releaseEvidenceBundleCheck", () => {
  it("passes when all release evidence is complete and consistent", () => {
    const result = evaluateReleaseEvidenceBundle(validEvidence(), {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(result.selectedEvidence).toMatchObject({
      releaseCommitRef: commitRef,
      repository,
      branch,
      releaseGateStatus: "pass",
      dockerBuildRehearsalStatus: "passed",
      postgresRehearsalStatus: "passed",
      artifactEvidenceStatus: "passed",
      releaseImageDigest: `sha256:${"f".repeat(64)}`,
      sourceProviderEvidenceStatus: "passed",
      targetRuntimeEvidenceStatus: "passed",
      backupEvidenceStatus: "passed",
      observabilityEvidenceStatus: "passed",
      operatorAccessEvidenceStatus: "passed",
      nonSessionCredentialEvidenceStatus: "passed",
      ingressEvidenceStatus: "passed",
      upgradeRollbackDrillStatus: "passed"
    });
  });

  it("blocks missing target runtime evidence", () => {
    const evidence = validEvidence();

    delete (evidence as Record<string, unknown>).targetRuntimeEvidence;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "target_runtime_present",
      status: "fail"
    }));
  });

  it("blocks target runtime evidence with shallow section summaries", () => {
    const targetRuntime = validTargetRuntimeEvidence();
    const selectedEvidence = targetRuntime.selectedEvidence as Record<string, unknown>;

    selectedEvidence.composeConfig = { status: "passed" };

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        targetRuntimeEvidence: {
          ...validEvidence().targetRuntimeEvidence,
          evidence: targetRuntime
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now,
        commitRef,
        repo: repository,
        branch
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "target_runtime_selected_evidence",
      status: "fail"
    }));
  });

  it("blocks target runtime evidence whose running image digest does not match the release image digest", () => {
    const targetRuntime = validTargetRuntimeEvidence();
    const selectedEvidence = targetRuntime.selectedEvidence as Record<string, unknown>;
    const imageBinding = selectedEvidence.imageBinding as Record<string, unknown>;

    imageBinding.expectedDigest = `sha256:${"a".repeat(64)}`;
    imageBinding.apiImageDigest = `sha256:${"a".repeat(64)}`;
    imageBinding.workerImageDigest = `sha256:${"a".repeat(64)}`;

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        targetRuntimeEvidence: {
          ...validEvidence().targetRuntimeEvidence,
          evidence: targetRuntime
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now,
        commitRef,
        repo: repository,
        branch
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "target_runtime_release_image_digest",
      status: "fail"
    }));
  });

  it("blocks release gate evidence that omits runtime resource controls", () => {
    const evidence = validEvidence();
    const releaseGate = evidence.releaseGate.evidence as ReturnType<typeof validReleaseGateEvidence>;
    const runtimeEnv = releaseGate.promotionEvidence.runtimeEnv as Record<string, unknown>;

    for (const key of [
      "buildMaxArtifactBytesStatus",
      "buildMaxArtifactBytes",
      "buildMaxArtifactFilesStatus",
      "buildMaxArtifactFiles",
      "buildMinFreeBytesStatus",
      "buildMinFreeBytes",
      "prebuiltMaxUploadBytesStatus",
      "prebuiltMaxUploadBytes",
      "prebuiltMaxFilesStatus",
      "prebuiltMaxFiles",
      "buildStepTimeoutStatus",
      "buildStepTimeoutMs",
      "gitTimeoutStatus",
      "gitTimeoutMs",
      "buildNetworkStatus",
      "buildNetwork"
    ]) {
      delete runtimeEnv[key];
    }

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runtime_resource_controls",
          status: "fail"
        })
      ])
    );
  });

  it("blocks release gate evidence when browser token fallback is enabled", () => {
    const evidence = validEvidence();
    const releaseGate = evidence.releaseGate.evidence as ReturnType<typeof validReleaseGateEvidence>;
    const runtimeEnv = releaseGate.promotionEvidence.runtimeEnv as Record<string, unknown>;

    runtimeEnv.browserTokenFallbackEnabled = true;
    runtimeEnv.browserTokenFallbackStatus = "fail";
    runtimeEnv.browserTokenFallbackEnvValue = "1";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "browser_token_fallback_runtime",
          status: "fail"
        })
      ])
    );
  });

  it("blocks raw secret-like values anywhere in the final release evidence bundle", () => {
    const evidence = validEvidence();
    const operatorAccess = evidence.operatorAccessEvidence.evidence as Record<string, unknown>;
    const selectedEvidence = operatorAccess.selectedEvidence as Record<string, unknown>;
    selectedEvidence.sessionCreate = {
      ...(selectedEvidence.sessionCreate as Record<string, unknown>),
      authorization: "Bearer abcdefghijklmnop"
    };
    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bundle_no_sensitive_evidence_values", status: "fail" })
      ])
    );
    expect(serialized).not.toContain("abcdefghijklmnop");
  });

  it("blocks release artifact manifests that declare same-process function runtime isolation", () => {
    const evidence = validEvidence();
    evidence.artifactEvidence.evidence = sameProcessFunctionArtifactEvidence();

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "artifact_function_runtime_isolation",
          status: "fail",
          message: expect.stringContaining("same_process")
        })
      ])
    );
  });

  it("blocks release artifact evidence that omits the deployment artifact manifest", () => {
    const evidence = validEvidence();
    const artifactEvidence = validArtifactEvidence() as ReturnType<typeof validArtifactEvidence> & Record<string, unknown>;

    delete artifactEvidence.artifactManifest;
    evidence.artifactEvidence.evidence = artifactEvidence;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "artifact_function_runtime_isolation",
          status: "fail",
          message: expect.stringContaining("deployment artifact manifest")
        })
      ])
    );
  });

  it("blocks release artifact manifests with functions missing runtime isolation", () => {
    const evidence = validEvidence();
    evidence.artifactEvidence.evidence = functionArtifactEvidenceWithRuntimeIsolation();

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "artifact_function_runtime_isolation",
          status: "fail",
          message: expect.stringContaining("missing")
        })
      ])
    );
  });

  it("blocks release artifact manifests with unknown function runtime isolation", () => {
    const evidence = validEvidence();
    evidence.artifactEvidence.evidence = functionArtifactEvidenceWithRuntimeIsolation("shared_process");

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "artifact_function_runtime_isolation",
          status: "fail",
          message: expect.stringContaining("unknown")
        })
      ])
    );
  });

  it("allows release artifact manifests that declare isolated function runtime isolation", () => {
    const evidence = validEvidence();
    evidence.artifactEvidence.evidence = functionArtifactEvidenceWithRuntimeIsolation("isolated_process");

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "artifact_function_runtime_isolation",
          status: "pass"
        })
      ])
    );
  });

  it("blocks same-process function runtime isolation even when the bundle records a trusted exception", () => {
    const evidence = validEvidence({
      functionRuntimeIsolationTrustedExceptionAccepted: true
    });
    evidence.artifactEvidence.evidence = sameProcessFunctionArtifactEvidence();

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "artifact_function_runtime_isolation",
          status: "fail",
          message: expect.stringContaining("isolated function runner")
        })
      ])
    );
  });

  it("blocks when stale raw release gate evidence is repackaged with fresh attachment metadata", () => {
    const staleGate = validReleaseGateEvidence();
    staleGate.checkedAt = "2026-05-30T10:09:00.000Z";
    staleGate.promotionEvidence.checkedAt = "2026-05-30T10:09:00.000Z";
    const result = evaluateReleaseEvidenceBundle(validEvidence({
      releaseGate: {
        sourcePath: "evidence/release-gate.json",
        collectedAt: "2026-06-07T10:10:00.000Z",
        releaseCommit: commitRef,
        evidence: staleGate
      }
    }), {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_gate_age",
      status: "fail"
    }));
  });

  it("blocks release image evidence with an invalid digest", () => {
    const evidence = validEvidence();
    const releaseImage = ((evidence.releaseImageEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const image = releaseImage.image as Record<string, unknown>;

    image.digest = "not-a-digest";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_image_digest",
      status: "fail"
    }));
  });

  it("blocks release image evidence bound to a different source commit", () => {
    const evidence = validEvidence();
    const releaseImage = ((evidence.releaseImageEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const source = releaseImage.source as Record<string, unknown>;

    source.commitRef = "different-commit";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_image_source_identity",
      status: "fail"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "commit_consistency",
      status: "fail"
    }));
  });

  it("blocks release image evidence without provenance attestation evidence", () => {
    const evidence = validEvidence();
    const releaseImage = ((evidence.releaseImageEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const attestations = releaseImage.attestations as Record<string, unknown>;

    delete attestations.provenance;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_image_provenance_attestation",
      status: "fail"
    }));
  });

  it("blocks release image evidence without SBOM attestation evidence", () => {
    const evidence = validEvidence();
    const releaseImage = ((evidence.releaseImageEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const attestations = releaseImage.attestations as Record<string, unknown>;

    delete attestations.sbom;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_image_sbom_attestation",
      status: "fail"
    }));
  });

  it("blocks release image attestation evidence bound to a different image digest", () => {
    const evidence = validEvidence();
    const releaseImage = ((evidence.releaseImageEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const attestations = releaseImage.attestations as Record<string, unknown>;

    attestations.subjectDigest = `sha256:${"a".repeat(64)}`;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_image_attestation_subject",
      status: "fail"
    }));
  });

  it("blocks stale release image attestation inspection evidence", () => {
    const evidence = validEvidence();
    const releaseImage = ((evidence.releaseImageEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const attestations = releaseImage.attestations as Record<string, unknown>;

    attestations.inspectedAt = "2026-05-30T10:19:50.000Z";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_image_attestation_inspection",
      status: "fail"
    }));
  });

  it("blocks when raw release gate evidence does not include checkedAt", () => {
    const gate = validReleaseGateEvidence() as Record<string, unknown>;

    delete gate.checkedAt;
    delete (gate.promotionEvidence as Record<string, unknown>).checkedAt;

    const result = evaluateReleaseEvidenceBundle(validEvidence({
      releaseGate: {
        sourcePath: "evidence/release-gate.json",
        collectedAt: "2026-06-07T10:10:00.000Z",
        releaseCommit: commitRef,
        evidence: gate
      }
    }), {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_gate_age",
      status: "fail"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "release_gate_attachment",
      status: "fail"
    }));
  });

  it("blocks Docker build rehearsal evidence that omits raw release identity", () => {
    const evidence = validEvidence();
    const dockerBuild = ((evidence.dockerBuildRehearsal as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;

    delete dockerBuild.releaseCommit;
    delete dockerBuild.repository;
    delete dockerBuild.branch;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "docker_build_rehearsal_release_identity",
      status: "fail"
    }));
  });

  it("blocks Postgres rehearsal evidence for a different target environment", () => {
    const evidence = validEvidence();
    const postgres = ((evidence.postgresRehearsal as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const postgresRelease = postgres.release as Record<string, unknown>;

    postgresRelease.targetEnvironment = "staging";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch,
      targetEnvironment: "production"
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "postgres_target_environment",
      status: "fail"
    }));
  });

  it("blocks observability evidence that is not bound to the release identity", () => {
    const evidence = validEvidence();
    const observability = ((evidence.observabilityEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const selectedEvidence = observability.selectedEvidence as Record<string, unknown>;

    selectedEvidence.commitRef = "different-sha";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch,
      targetEnvironment: "production"
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "observability_release_identity",
      status: "fail"
    }));
  });

  it("blocks observability evidence for a different target environment", () => {
    const evidence = validEvidence();
    const observability = ((evidence.observabilityEvidence as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
    const selectedEvidence = observability.selectedEvidence as Record<string, unknown>;

    selectedEvidence.targetEnvironment = "staging";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch,
      targetEnvironment: "production"
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "observability_target_environment",
      status: "fail"
    }));
  });

  it("blocks release evidence bundles for a different target environment", () => {
    const evidence = validEvidence();

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch,
      targetEnvironment: "staging"
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "target_environment",
          status: "fail",
          message: "Release evidence bundle targetEnvironment must be staging."
        })
      ])
    );
  });

  it("blocks release evidence bundles with mismatched root and release target environments", () => {
    const evidence = validEvidence();
    const release = evidence.release as Record<string, unknown>;

    release.targetEnvironment = "staging";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "target_environment",
          status: "fail"
        })
      ])
    );
  });

  it("blocks promotion evidence with manual_required checks", () => {
    const evidence = validEvidence();
    const releaseGateEvidence = (evidence.releaseGate as Record<string, unknown>).evidence as Record<string, unknown>;
    const promotionEvidence = releaseGateEvidence.promotionEvidence as Record<string, unknown>;

    releaseGateEvidence.status = "manual_required";
    promotionEvidence.gateStatus = "manual_required";
    promotionEvidence.manualRequired = true;
    promotionEvidence.manualRequiredCheckIds = ["external.githubBranchProtection"];

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release_gate_passed",
          status: "fail"
        }),
        expect.objectContaining({
          name: "no_manual_required",
          status: "fail"
        })
      ])
    );
  });

  it("blocks promotion evidence that lists dirty worktree entries", () => {
    const evidence = validEvidence();
    const releaseGateEvidence = (evidence.releaseGate as Record<string, unknown>).evidence as Record<string, unknown>;
    const promotionEvidence = releaseGateEvidence.promotionEvidence as Record<string, unknown>;
    const dirtyWorktree = promotionEvidence.dirtyWorktree as Record<string, unknown>;

    dirtyWorktree.entries = [" M dist/index.html"];

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "clean_worktree_entries",
          status: "fail"
        })
      ])
    );
  });

  it("blocks mismatched release commit refs", () => {
    const evidence = validEvidence();
    const releaseGateEvidence = (evidence.releaseGate as Record<string, unknown>).evidence as Record<string, unknown>;
    const promotionEvidence = releaseGateEvidence.promotionEvidence as Record<string, unknown>;

    promotionEvidence.commitRef = "different-sha";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "commit_consistency",
          status: "fail"
        })
      ])
    );
  });

  it("blocks release metadata mismatches even when CLI target options are correct", () => {
    const evidence = validEvidence();
    const release = evidence.release as Record<string, unknown>;

    release.commitRef = "different-sha";
    release.repository = "different/repo";
    release.branch = "release";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "commit_consistency",
          status: "fail"
        }),
        expect.objectContaining({
          name: "repository_consistency",
          status: "fail"
        }),
        expect.objectContaining({
          name: "branch_consistency",
          status: "fail"
        })
      ])
    );
  });

  it("blocks raw attachment identity mismatches even when wrapper metadata matches", () => {
    const evidence = validEvidence();
    const dockerAttachment = evidence.dockerBuildRehearsal as Record<string, unknown>;
    const dockerEvidence = dockerAttachment.evidence as Record<string, unknown>;

    dockerEvidence.releaseCommit = "different-sha";
    dockerEvidence.repository = "different/repo";
    dockerEvidence.branch = "release";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now,
      commitRef,
      repo: repository,
      branch
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "commit_consistency",
          status: "fail"
        }),
        expect.objectContaining({
          name: "repository_consistency",
          status: "fail"
        }),
        expect.objectContaining({
          name: "branch_consistency",
          status: "fail"
        })
      ])
    );
  });

  it("blocks release gate evidence without production token strength posture", () => {
    const evidence = validEvidence();
    const releaseGateEvidence = (evidence.releaseGate as Record<string, unknown>).evidence as Record<string, unknown>;
    const promotionEvidence = releaseGateEvidence.promotionEvidence as Record<string, unknown>;
    const runtimeEnv = promotionEvidence.runtimeEnv as Record<string, unknown>;

    runtimeEnv.apiTokenStrengthStatus = "fail";
    runtimeEnv.metricsTokenStrengthStatus = undefined;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "api_token_strength",
          status: "fail"
        }),
        expect.objectContaining({
          name: "metrics_token_strength",
          status: "fail"
        })
      ])
    );
  });

  it("accepts release gate evidence with native secret file app secret source", () => {
    const evidence = validEvidence();
    const releaseGateEvidence = (evidence.releaseGate as Record<string, unknown>).evidence as Record<string, unknown>;
    const promotionEvidence = releaseGateEvidence.promotionEvidence as Record<string, unknown>;
    const runtimeEnv = promotionEvidence.runtimeEnv as Record<string, unknown>;
    runtimeEnv.appSecretSource = "SITEFLOW_APP_SECRET_FILE";

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("passed");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "app_secret_strength",
      status: "pass"
    }));
  });

  it("blocks missing Docker build rehearsal evidence when Docker runner is promoted", () => {
    const evidence = validEvidence();

    delete (evidence as Record<string, unknown>).dockerBuildRehearsal;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_present",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Docker runner release evidence without trusted socket profile acceptance", () => {
    const evidence = validEvidence();
    const release = evidence.release as Record<string, unknown>;

    delete release.dockerSocketProfileAccepted;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_socket_profile_acceptance",
          status: "fail"
        })
      ])
    );
  });

  it("blocks dry-run Docker build rehearsal evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        dockerBuildRehearsal: {
          ...validEvidence().dockerBuildRehearsal,
          evidence: {
            ...validDockerBuildEvidence(),
            status: "dry_run",
            dryRun: true,
            exitCode: 0
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Docker build rehearsal evidence without the target runner profile", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        dockerBuildRehearsal: {
          ...validEvidence().dockerBuildRehearsal,
          evidence: {
            ...validDockerBuildEvidence(),
            docker: {
              ...validDockerBuildEvidence().docker,
              network: "bridge",
              dockerInfoAvailable: false
            }
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_profile",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Docker build rehearsal evidence for allowlisted image tags without an explicit tagged-image exception", () => {
    const evidence = validEvidence();
    const taggedImage = "registry.local/siteflow/build-node:20.11";
    const runtimeEnv = evidence.releaseGate.evidence.promotionEvidence.runtimeEnv;
    runtimeEnv.buildImage = taggedImage;
    runtimeEnv.buildImageDigestPinned = false;
    runtimeEnv.buildImageAllowlistConfigured = true;
    runtimeEnv.buildImageAllowedByAllowlist = true;
    runtimeEnv.buildImageTaggedTrustedExceptionAccepted = true;
    runtimeEnv.buildImagePolicyStatus = "pass";
    runtimeEnv.buildImagePolicy = "tag_allowlist_exception";
    evidence.dockerBuildRehearsal.evidence = {
      ...validDockerBuildEvidence(),
      docker: {
        ...validDockerBuildEvidence().docker,
        image: taggedImage,
        imageDigestPinned: false,
        imageAllowlistConfigured: true,
        imageAllowedByAllowlist: true,
        imageTaggedTrustedExceptionAccepted: false
      }
    };

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_profile",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Docker build rehearsal evidence without artifact publish limits", () => {
    const dockerBuild = validDockerBuildEvidence();

    delete (dockerBuild as Record<string, unknown>).artifactLimits;

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        dockerBuildRehearsal: {
          ...validEvidence().dockerBuildRehearsal,
          evidence: dockerBuild
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_profile",
          status: "fail"
        }),
        expect.objectContaining({
          name: "docker_build_rehearsal_artifact",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Docker build rehearsal evidence when required prerequisites failed", () => {
    const dockerEvidence = validDockerBuildEvidence();

    dockerEvidence.prerequisites = dockerEvidence.prerequisites.map((entry) => (
      entry.name === "docker_daemon" ? { ...entry, status: "failed" } : entry
    ));

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        dockerBuildRehearsal: {
          ...validEvidence().dockerBuildRehearsal,
          evidence: dockerEvidence
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_profile",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Docker build rehearsal evidence without exact build commands and artifact integrity", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        dockerBuildRehearsal: {
          ...validEvidence().dockerBuildRehearsal,
          evidence: {
            ...validDockerBuildEvidence(),
            buildCommands: ["npm run build"],
            artifact: {
              entrypoint: "index.html",
              fileCount: 3
            }
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_commands",
          status: "fail"
        }),
        expect.objectContaining({
          name: "docker_build_rehearsal_artifact",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Docker build rehearsal evidence whose artifact exceeds the recorded limits", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        dockerBuildRehearsal: {
          ...validEvidence().dockerBuildRehearsal,
          evidence: {
            ...validDockerBuildEvidence(),
            artifactLimits: {
              maxArtifactBytes: 100,
              maxArtifactFiles: 2
            }
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "docker_build_rehearsal_artifact",
          status: "fail"
        })
      ])
    );
  });

  it("blocks dry-run Postgres rehearsal evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        postgresRehearsal: {
          ...validEvidence().postgresRehearsal,
          evidence: {
            ...validPostgresEvidence(),
            status: "dry_run",
            dryRun: true
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postgres_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Postgres rehearsal evidence without release identity", () => {
    const postgres = validPostgresEvidence();

    delete (postgres as Record<string, unknown>).release;

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        postgresRehearsal: {
          ...validEvidence().postgresRehearsal,
          evidence: postgres
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postgres_release_identity",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Postgres rehearsal evidence without redacted target database metadata", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        postgresRehearsal: {
          ...validEvidence().postgresRehearsal,
          evidence: {
            ...validPostgresEvidence(),
            targetDatabase: {
              redactedUrl: "postgres://user:password@postgres.internal:5432/siteflow_rehearsal",
              host: "postgres.internal",
              database: "siteflow_rehearsal",
              parseStatus: "passed"
            }
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postgres_target_database",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Postgres rehearsal evidence without the required production rehearsal scope", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        postgresRehearsal: {
          ...validEvidence().postgresRehearsal,
          evidence: {
            ...validPostgresEvidence(),
            rehearsalScope: [
              "migration_advisory_lock",
              "migration_checksum_drift"
            ]
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postgres_rehearsal_scope",
          status: "fail"
        })
      ])
    );
  });

  it("blocks Postgres rehearsal evidence without passed scenario results for every scope", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        postgresRehearsal: {
          ...validEvidence().postgresRehearsal,
          evidence: {
            ...validPostgresEvidence(),
            scenarioResults: postgresRehearsalScopes.slice(0, -1).map((scope) => ({
              scope,
              status: "passed"
            }))
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postgres_scenario_results",
          status: "fail"
        })
      ])
    );
  });

  it("blocks backup evidence that was not checked with off-host required", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        backupEvidence: {
          ...validEvidence().backupEvidence,
          evidence: {
            ...validBackupEvidence(),
            thresholds: {
              maxBackupAgeHours: 24,
              maxRestoreDrillAgeHours: 168,
              requireOffHost: false
            }
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_off_host_required",
          status: "fail"
        })
      ])
    );
  });

  it("blocks backup evidence checker output that lacks offload and prune proof", () => {
    const backupEvidence = validBackupEvidence();
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        backupEvidence: {
          ...validEvidence().backupEvidence,
          evidence: {
            ...backupEvidence,
            selectedEvidence: {
              backupVerify: backupEvidence.selectedEvidence.backupVerify,
              restoreDrill: backupEvidence.selectedEvidence.restoreDrill
            },
            checks: backupEvidence.checks.filter((check) =>
              !check.name.startsWith("backup_offload") && !check.name.startsWith("backup_prune")
            )
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_selected_evidence",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_offload_prune_checks",
          status: "fail"
        })
      ])
    );
  });

  it("blocks raw backup automation run records used as backup evidence checker output", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        backupEvidence: {
          ...validEvidence().backupEvidence,
          evidence: validBackupAutomationRun()
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "backup_passed",
          status: "fail"
        }),
        expect.objectContaining({
          name: "backup_off_host_required",
          status: "fail"
        })
      ])
    );
  });

  it("blocks observability evidence without selected backup automation run proof", () => {
    const observabilityEvidence = validObservabilityEvidence();
    const { backupAutomationRun: _backupAutomationRun, ...selectedEvidence } = observabilityEvidence.selectedEvidence;
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        observabilityEvidence: {
          ...validEvidence().observabilityEvidence,
          evidence: {
            ...observabilityEvidence,
            selectedEvidence
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_selected_evidence",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale observability evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        observabilityEvidence: {
          ...validEvidence().observabilityEvidence,
          evidence: {
            ...validObservabilityEvidence(),
            checkedAt: "2026-05-30T11:00:00.000Z"
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now,
        maxEvidenceAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "observability_age",
          status: "fail"
        })
      ])
    );
  });

  it.each([
    {
      label: "source provider",
      attachment: "sourceProviderEvidence",
      evidence: validSourceProviderEvidence,
      expectedCheck: "source_provider_required_checks"
    },
    {
      label: "target runtime",
      attachment: "targetRuntimeEvidence",
      evidence: validTargetRuntimeEvidence,
      expectedCheck: "target_runtime_required_checks"
    },
    {
      label: "observability",
      attachment: "observabilityEvidence",
      evidence: validObservabilityEvidence,
      expectedCheck: "observability_required_checks"
    },
    {
      label: "operator access",
      attachment: "operatorAccessEvidence",
      evidence: validOperatorAccessEvidence,
      expectedCheck: "operator_access_required_checks"
    },
    {
      label: "non-session credential",
      attachment: "nonSessionCredentialEvidence",
      evidence: validNonSessionCredentialEvidence,
      expectedCheck: "non_session_credential_required_checks"
    },
    {
      label: "ingress",
      attachment: "ingressEvidence",
      evidence: validIngressEvidence,
      expectedCheck: "ingress_required_checks"
    }
  ])("blocks shallow passing $label checker output without required check names", ({ attachment, evidence, expectedCheck }) => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        [attachment]: {
          ...((validEvidence() as Record<string, unknown>)[attachment] as Record<string, unknown>),
          evidence: {
            ...evidence(),
            checks: [
              passingCheck("evidence_shape")
            ]
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expectedCheck,
          status: "fail"
        })
      ])
    );
  });

  it.each([
    {
      label: "source provider",
      attachment: "sourceProviderEvidence",
      evidence: validSourceProviderEvidence,
      fakeName: "fake-source-provider-check",
      expectedCheck: "source_provider_name"
    },
    {
      label: "target runtime",
      attachment: "targetRuntimeEvidence",
      evidence: validTargetRuntimeEvidence,
      fakeName: "fake-target-runtime-check",
      expectedCheck: "target_runtime_name"
    },
    {
      label: "operator access",
      attachment: "operatorAccessEvidence",
      evidence: validOperatorAccessEvidence,
      fakeName: "fake-operator-access-check",
      expectedCheck: "operator_access_name"
    },
    {
      label: "non-session credential",
      attachment: "nonSessionCredentialEvidence",
      evidence: validNonSessionCredentialEvidence,
      fakeName: "fake-non-session-credential-check",
      expectedCheck: "non_session_credential_name"
    },
    {
      label: "ingress",
      attachment: "ingressEvidence",
      evidence: validIngressEvidence,
      fakeName: "fake-ingress-check",
      expectedCheck: "ingress_name"
    }
  ])("blocks spoofed $label checker names", ({ attachment, evidence, fakeName, expectedCheck }) => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        [attachment]: {
          ...((validEvidence() as Record<string, unknown>)[attachment] as Record<string, unknown>),
          evidence: {
            ...evidence(),
            name: fakeName
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expectedCheck,
          status: "fail"
        })
      ])
    );
  });

  it.each([
    {
      label: "source provider",
      attachment: "sourceProviderEvidence",
      evidence: validSourceProviderEvidence,
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.selectedEvidence as Record<string, unknown>).environment) = "staging";
      },
      expectedCheck: "source_provider_target_environment"
    },
    {
      label: "target runtime",
      attachment: "targetRuntimeEvidence",
      evidence: validTargetRuntimeEvidence,
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.release as Record<string, unknown>).targetEnvironment) = "staging";
      },
      expectedCheck: "target_runtime_target_environment"
    },
    {
      label: "operator access",
      attachment: "operatorAccessEvidence",
      evidence: validOperatorAccessEvidence,
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.selectedEvidence as Record<string, unknown>).environment) = "staging";
      },
      expectedCheck: "operator_access_target_environment"
    },
    {
      label: "non-session credential",
      attachment: "nonSessionCredentialEvidence",
      evidence: validNonSessionCredentialEvidence,
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.selectedEvidence as Record<string, unknown>).environment) = "staging";
      },
      expectedCheck: "non_session_credential_target_environment"
    },
    {
      label: "ingress",
      attachment: "ingressEvidence",
      evidence: validIngressEvidence,
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.selectedEvidence as Record<string, unknown>).environment) = "staging";
      },
      expectedCheck: "ingress_target_environment"
    },
    {
      label: "upgrade/rollback",
      attachment: "upgradeRollbackEvidence",
      evidence: validUpgradeRollbackEvidence,
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.selectedEvidence as Record<string, unknown>).targetEnvironment) = "staging";
      },
      expectedCheck: "upgrade_rollback_target_environment"
    }
  ])("blocks $label evidence collected for a different target environment", ({ attachment, evidence, mutate, expectedCheck }) => {
    const changedEvidence = evidence() as Record<string, unknown>;
    mutate(changedEvidence);

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        [attachment]: {
          ...((validEvidence() as Record<string, unknown>)[attachment] as Record<string, unknown>),
          evidence: changedEvidence
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expectedCheck,
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing source provider evidence", () => {
    const evidence = validEvidence();
    delete (evidence as Record<string, unknown>).sourceProviderEvidence;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "source_provider_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "source_provider_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing upgrade/rollback drill evidence", () => {
    const evidence = validEvidence();

    delete (evidence as Record<string, unknown>).upgradeRollbackEvidence;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "upgrade_rollback_present",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing ingress evidence", () => {
    const evidence = validEvidence();
    delete (evidence as Record<string, unknown>).ingressEvidence;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ingress_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "ingress_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks ingress evidence that omits deployment topology", () => {
    const ingress = validIngressEvidence();
    delete (ingress.selectedEvidence as Record<string, unknown>).deploymentTopology;

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        ingressEvidence: {
          ...validEvidence().ingressEvidence,
          evidence: ingress
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ingress_deployment_topology",
          status: "fail"
        }),
        expect.objectContaining({
          name: "ingress_rate_limit_topology",
          status: "fail"
        })
      ])
    );
  });

  it("blocks ingress evidence missing topology and section age check rows", () => {
    const ingress = validIngressEvidence();
    const removedCheckNames = new Set([
      "deployment_topology_present",
      "direct_api_port_age",
      "forwarded_headers_age",
      "api_rate_limit_age",
      "api_rate_limit_topology",
      "unthrottled_routes_age"
    ]);

    ingress.checks = ingress.checks.filter((check) => !removedCheckNames.has(check.name));

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        ingressEvidence: {
          ...validEvidence().ingressEvidence,
          evidence: ingress
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ingress_passed",
          status: "pass"
        }),
        expect.objectContaining({
          name: "ingress_required_checks",
          status: "fail"
        })
      ])
    );
  });

  it("blocks multi-instance ingress evidence that only proves a process-local API limiter", () => {
    const ingress = validIngressEvidence();
    const apiRateLimit = ingress.selectedEvidence.apiRateLimit as Record<string, unknown>;

    delete apiRateLimit.edgeEnforced;
    apiRateLimit.processLocalOnly = true;
    apiRateLimit.clientIpBucketed = true;

    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        ingressEvidence: {
          ...validEvidence().ingressEvidence,
          evidence: ingress
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ingress_deployment_topology",
          status: "pass"
        }),
        expect.objectContaining({
          name: "ingress_rate_limit_topology",
          status: "fail",
          message: expect.stringContaining("process-local-only")
        })
      ])
    );
  });

  it("blocks missing operator access evidence", () => {
    const evidence = validEvidence();
    delete (evidence as Record<string, unknown>).operatorAccessEvidence;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "operator_access_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "operator_access_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks failed operator access evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        operatorAccessEvidence: {
          ...validEvidence().operatorAccessEvidence,
          evidence: {
            ...validOperatorAccessEvidence(),
            status: "blocked",
            checks: [
              passingCheck("evidence_shape"),
              {
                name: "emergency_cutoff_cookie_only_rejected",
                status: "fail",
                message: "cookie-only revoke-all was accepted"
              }
            ],
            exitCode: 1
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "operator_access_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale operator access evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        operatorAccessEvidence: {
          ...validEvidence().operatorAccessEvidence,
          collectedAt: "2026-06-01T11:04:00.000Z",
          evidence: {
            ...validOperatorAccessEvidence(),
            checkedAt: "2026-06-01T11:03:00.000Z"
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now,
        maxEvidenceAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "operator_access_attachment",
          status: "fail"
        }),
        expect.objectContaining({
          name: "operator_access_age",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing non-session credential evidence", () => {
    const evidence = validEvidence();
    delete (evidence as Record<string, unknown>).nonSessionCredentialEvidence;

    const result = evaluateReleaseEvidenceBundle(evidence, {
      evidencePath: "release-evidence.json",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "non_session_credential_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "non_session_credential_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks failed non-session credential evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        nonSessionCredentialEvidence: {
          ...validEvidence().nonSessionCredentialEvidence,
          evidence: {
            ...validNonSessionCredentialEvidence(),
            status: "blocked",
            checks: [
              passingCheck("evidence_shape"),
              {
                name: "automation_not_claimed",
                status: "fail",
                message: "automatic rotation was claimed"
              }
            ],
            exitCode: 1
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "non_session_credential_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale non-session credential evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        nonSessionCredentialEvidence: {
          ...validEvidence().nonSessionCredentialEvidence,
          collectedAt: "2026-06-01T11:04:30.000Z",
          evidence: {
            ...validNonSessionCredentialEvidence(),
            checkedAt: "2026-06-01T11:02:00.000Z"
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now,
        maxEvidenceAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "non_session_credential_attachment",
          status: "fail"
        }),
        expect.objectContaining({
          name: "non_session_credential_age",
          status: "fail"
        })
      ])
    );
  });

  it("blocks failed upgrade/rollback drill evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        upgradeRollbackEvidence: {
          ...validEvidence().upgradeRollbackEvidence,
          evidence: {
            ...validUpgradeRollbackEvidence(),
            status: "blocked",
            checks: [
              passingCheck("evidence_shape"),
              {
                name: "route_rollback_restores_previous_artifact",
                status: "fail",
                message: "rollback did not restore previous artifact"
              }
            ],
            exitCode: 1
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "upgrade_rollback_passed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks upgrade/rollback drill evidence without required checker rows", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        upgradeRollbackEvidence: {
          ...validEvidence().upgradeRollbackEvidence,
          evidence: {
            ...validUpgradeRollbackEvidence(),
            checks: [
              passingCheck("evidence_shape")
            ]
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "upgrade_rollback_required_checks",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale upgrade/rollback drill evidence", () => {
    const result = evaluateReleaseEvidenceBundle(
      validEvidence({
        upgradeRollbackEvidence: {
          ...validEvidence().upgradeRollbackEvidence,
          collectedAt: "2026-06-01T11:11:00.000Z",
          evidence: {
            ...validUpgradeRollbackEvidence(),
            checkedAt: "2026-06-01T11:10:00.000Z"
          }
        }
      }),
      {
        evidencePath: "release-evidence.json",
        now,
        maxEvidenceAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "upgrade_rollback_attachment",
          status: "fail"
        }),
        expect.objectContaining({
          name: "upgrade_rollback_age",
          status: "fail"
        })
      ])
    );
  });

  it("prints help that lists all bundled evidence categories", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runReleaseEvidenceBundleCheckCli(
      ["--help"],
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      },
      {
        now
      }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("source provider");
    expect(stdout).toContain("target runtime");
    expect(stdout).toContain("operator access");
    expect(stdout).toContain("non-session credential");
    expect(stdout).toContain("upgrade/rollback drill");
  });

  it("emits JSON from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-evidence-"));
    const evidencePath = path.join(root, "release-evidence.json");
    let stdout = "";
    let stderr = "";

    try {
      await writeFile(evidencePath, `${JSON.stringify(validEvidence())}\n`, "utf8");

      const exitCode = await runReleaseEvidenceBundleCheckCli(
        ["--evidence", evidencePath, "--commit-ref", commitRef, "--repo", repository, "--branch", branch, "--json"],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          now
        }
      );
      const parsed = JSON.parse(stdout);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(parsed).toMatchObject({
        name: "siteflow-release-evidence-bundle-check",
        status: "passed",
        evidencePath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
