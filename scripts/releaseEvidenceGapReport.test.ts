import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createReleaseEvidenceGapReport,
  runReleaseEvidenceGapReportCli
} from "./releaseEvidenceGapReport";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck";
import { evaluateReleaseEvidenceBundle } from "./releaseEvidenceBundleCheck";
import { createReleaseEvidenceRehearsalPack } from "./releaseEvidenceRehearsalPack";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const pinnedBuildImage = "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const backupKmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";

function basePack(
  outputDir: string,
  overrides: Partial<Parameters<typeof createReleaseEvidenceRehearsalPack>[0]> = {}
) {
  return createReleaseEvidenceRehearsalPack({
    commitRef: "abc123def4567890",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvFile: path.join(outputDir, "target.env"),
    publicBaseUrl: "https://siteflow.example.com",
    operatorName: "release-operator",
    releaseTicket: "REL-2026-0608",
    outputDir,
    now,
    ...overrides
  });
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function passedChecker(name: string) {
  return {
    name,
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    dryRun: false,
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main"
    },
    checks: [
      {
        name: "evidence_shape",
        status: "pass",
        message: "Evidence shape passed."
      }
    ]
  };
}

function passingCheck(name: string) {
  return {
    name,
    status: "pass",
    message: `${name} passed.`
  };
}

function backupProviderSecurityAuditEvidence(checkedAt = "2026-06-08T10:53:00.000Z") {
  return {
    status: "passed",
    timestamp: checkedAt,
    schemaVersion: "siteflow.backupProviderSecurityAudit.v1",
    name: "siteflow-backup-provider-security-audit",
    evidenceSource: "provider_security_audit",
    operator: "release-operator",
    ticket: "REL-2026-0608",
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
      completedAt: "2026-06-08T10:54:00.000Z",
      restoreAccountId: "444455556666",
      restoreRoleArn: "arn:aws:iam::444455556666:role/siteflow-restore",
      backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260608"
    }
  };
}

function passedReleaseGateEvidence() {
  return {
    status: "pass",
    checkedAt: "2026-06-08T11:30:00.000Z",
    promotionEvidence: {
      gateStatus: "pass",
      checkedAt: "2026-06-08T11:30:00.000Z",
      promotion: true,
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      requiredStatusCheck: "Install, test, and build",
      branchProtection: {
        status: "pass",
        repository: "acme/siteflow",
        branch: "main",
        requiredStatusCheck: "Install, test, and build",
        requiredStatusChecks: ["Install, test, and build"]
      },
      protectedBranchCommit: {
        status: "pass",
        repository: "acme/siteflow",
        branch: "main",
        commitRef: "abc123def4567890",
        branchHeadSha: "abc123def4567890"
      },
      commitStatus: {
        status: "pass",
        repository: "acme/siteflow",
        commitRef: "abc123def4567890",
        requiredStatusCheck: "Install, test, and build",
        checkRun: {
          name: "Install, test, and build",
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
        entries: []
      }
    }
  };
}

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

function passedPostgresRehearsal() {
  return {
    name: "siteflow-postgres-rehearsal",
    status: "passed",
    startedAt: "2026-06-08T11:25:00.000Z",
    completedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    dryRun: false,
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production"
    },
    targetDatabase: {
      parseStatus: "passed",
      redactedUrl: "postgres://postgres.internal:5432/siteflow_rehearsal?sslmode=require",
      host: "postgres.internal",
      port: 5432,
      database: "siteflow_rehearsal",
      sslMode: "require"
    },
    prerequisites: [
      {
        name: "SITEFLOW_RUN_POSTGRES_INTEGRATION",
        required: true,
        status: "passed"
      },
      {
        name: "TEST_DATABASE_URL",
        required: true,
        status: "passed"
      },
      {
        name: "TEST_DATABASE_URL_FORMAT",
        required: true,
        status: "passed"
      }
    ],
    rehearsalScope: postgresRehearsalScopes,
    scenarioResults: postgresRehearsalScopes.map((scope) => ({
      scope,
      status: "passed",
      recordedAt: "2026-06-08T11:30:00.000Z",
      assertions: {
        exercised: true
      },
      metrics: {
        durationMs: 1
      }
    })),
    command: {
      args: ["vitest", "run", "worker/postgresRehearsal.integration.test.ts"],
      display: "npx vitest run worker/postgresRehearsal.integration.test.ts"
    }
  };
}

function passedDockerBuildRehearsal() {
  return {
    name: "siteflow-docker-build-rehearsal",
    status: "passed",
    dryRun: false,
    startedAt: "2026-06-08T11:20:00.000Z",
    completedAt: "2026-06-08T11:30:00.000Z",
    releaseCommit: "abc123def4567890",
    repository: "acme/siteflow",
    branch: "main",
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
        status: "passed"
      },
      {
        name: "SITEFLOW_BUILD_IMAGE",
        required: true,
        status: "passed"
      },
      {
        name: "docker_cli",
        required: true,
        status: "passed"
      },
      {
        name: "docker_daemon",
        required: true,
        status: "passed"
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

function passedSourceProviderEvidence() {
  return {
    name: "siteflow-source-provider-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      environment: "production",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      provider: "github",
      webhookDeliveryId: "delivery-123",
      deployKeyMode: "not_required"
    },
    checks: [
      passingCheck("evidence_shape"),
      ...sourceProviderRequiredChecks.map(passingCheck)
    ]
  };
}

function passedTargetRuntimeEvidence() {
  const digest = `sha256:${"f".repeat(64)}`;

  return {
    name: "siteflow-target-runtime-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    evidencePath: "target-runtime-evidence-raw.json",
    thresholds: {
      maxAgeHours: 168
    },
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production"
    },
    selectedEvidence: {
      targetEnvironment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      composeConfig: {
        status: "passed",
        timestamp: "2026-06-08T11:21:00.000Z"
      },
      startup: {
        status: "passed",
        timestamp: "2026-06-08T11:21:10.000Z"
      },
      serviceHealth: {
        status: "passed",
        timestamp: "2026-06-08T11:21:20.000Z"
      },
      readiness: {
        status: "passed",
        timestamp: "2026-06-08T11:21:30.000Z"
      },
      imageBinding: {
        status: "passed",
        timestamp: "2026-06-08T11:21:40.000Z",
        expectedDigest: digest,
        apiImageDigest: digest,
        workerImageDigest: digest
      },
      restartSmoke: {
        status: "passed",
        timestamp: "2026-06-08T11:21:50.000Z"
      },
      logSanity: {
        status: "passed",
        timestamp: "2026-06-08T11:22:00.000Z"
      }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...requiredTargetRuntimeEvidenceCheckNames.map(passingCheck)
    ],
    exitCode: 0
  };
}

function passedReleaseArtifactEvidence() {
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
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    artifactDirs: ["dist", "dist-cli", "dist-server", "dist-worker"],
    selectedEvidence: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      fileCount: artifacts.length,
      totalBytes: artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0),
      packageBinSiteflow: "./dist-cli/cli/index.js",
      auditExitCode: 0
    },
    manifest: {
      schemaVersion: "siteflow.releaseArtifactManifest.v1",
      name: "siteflow-release-artifact-manifest",
      generatedAt: "2026-06-08T11:29:00.000Z",
      artifacts
    },
    artifactManifest: {
      functions: []
    },
    checks: [
      passingCheck("evidence_shape"),
      ...releaseArtifactRequiredChecks.map(passingCheck)
    ]
  };
}

function sameProcessFunctionReleaseArtifactEvidence() {
  const evidence = passedReleaseArtifactEvidence() as ReturnType<typeof passedReleaseArtifactEvidence> & Record<string, unknown>;
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

function functionReleaseArtifactEvidenceWithRuntimeIsolation(runtimeIsolation?: unknown) {
  const evidence = passedReleaseArtifactEvidence() as ReturnType<typeof passedReleaseArtifactEvidence> & Record<string, unknown>;
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

function passedReleaseImageEvidence() {
  return {
    schemaVersion: "siteflow.releaseImageEvidence.v1",
    name: "siteflow-release-image-evidence",
    image: {
      name: "ghcr.io/siteflow/siteflow",
      versionTag: "ghcr.io/siteflow/siteflow:0.1.0",
      commitTag: "ghcr.io/siteflow/siteflow:sha-abc123def4567890",
      digest: `sha256:${"f".repeat(64)}`
    },
    source: {
      repository: "acme/siteflow",
      commitRef: "abc123def4567890",
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
      inspectedAt: "2026-06-08T11:30:35.000Z",
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
    checkedAt: "2026-06-08T11:30:30.000Z"
  };
}

const backupRequiredChecks = [...requiredOffHostBackupEvidenceCheckNames];
const releaseArtifactRequiredChecks = [...requiredReleaseArtifactCheckNames];
const sourceProviderRequiredChecks = [...requiredSourceProviderEvidenceCheckNames];
const observabilityRequiredChecks = [
  "release_identity",
  "target_environment",
  "readiness_present",
  "readiness_status",
  "readiness_age",
  "readiness_status_codes",
  "readiness_traffic_removed",
  "metrics_present",
  "metrics_status",
  "metrics_age",
  "metrics_access_control",
  "metrics_expected_names",
  "backup_automation_run_present",
  "backup_automation_run_identity",
  "backup_automation_run_status",
  "backup_automation_run_age",
  "backup_automation_run_steps",
  "backup_automation_checker_output",
  "backup_automation_history_present",
  "backup_automation_history_identity",
  "backup_automation_history_latest_run",
  "backup_automation_history_latest_status",
  "backup_restore_drill_cadence_count",
  "backup_restore_drill_cadence_gap",
  "backup_history_checker_output",
  "backup_scheduler_ownership_present",
  "backup_scheduler_ownership_status",
  "backup_scheduler_ownership_age",
  "backup_scheduler_ownership_schema",
  "backup_scheduler_ownership_source",
  "backup_scheduler_ownership_target_environment",
  "backup_scheduler_ownership_enabled",
  "backup_scheduler_ownership_schedule",
  "backup_scheduler_ownership_command",
  "backup_scheduler_ownership_run_links",
  "backup_scheduler_ownership_owner",
  "observability_apply_proof_present",
  "observability_apply_proof_status",
  "observability_apply_proof_age",
  "observability_apply_proof_schema",
  "observability_apply_proof_source",
  "observability_apply_proof_plan_schema",
  "observability_apply_proof_assets",
  "observability_target_stack_proof_present",
  "observability_target_stack_proof_status",
  "observability_target_stack_proof_age",
  "observability_target_stack_proof_schema",
  "observability_target_stack_proof_source",
  "observability_target_stack_proof_release_identity",
  "observability_target_stack_proof_target_environment",
  "observability_target_stack_prometheus_rules",
  "observability_target_stack_grafana_dashboard",
  "observability_target_stack_alertmanager_receiver",
  "alert_present",
  "alert_status",
  "alert_age",
  "alert_delivered",
  "dashboard_present",
  "dashboard_status",
  "dashboard_age",
  "dashboard_reference",
  "dashboard_owner",
  "log_pipeline_present",
  "log_pipeline_status",
  "log_pipeline_age",
  "log_retention",
  "log_redaction_spot_check",
  "no_sensitive_evidence_values"
];
const operatorAccessRequiredChecks = [
  "non_dry_run",
  "not_template",
  "status_final",
  "release_identity",
  "environment",
  "public_base_url",
  "session_create_present",
  "session_create_status",
  "session_cookie_flags",
  "session_secret_not_returned",
  "session_policy_present",
  "session_policy_enforced",
  "project_scope_present",
  "project_scope_enforced",
  "session_rotation_present",
  "session_rotation_status",
  "session_rotation_cookie_flags",
  "session_rotation_secret_not_returned",
  "session_rotation_csrf_enforced",
  "session_rotation_old_cookie_rejected",
  "session_revoke_present",
  "session_revoke_status",
  "csrf_present",
  "csrf_enforced",
  "bearer_precedence_present",
  "bearer_precedence_enforced",
  "actor_attribution_present",
  "actor_attribution_enforced",
  "emergency_cutoff_present",
  "emergency_cutoff_global",
  "emergency_cutoff_project",
  "emergency_cutoff_cookie_only_rejected",
  "emergency_cutoff_low_scope_bearer",
  "emergency_cutoff_old_cookie_rejected",
  "browser_token_fallback_present",
  "browser_token_fallback_posture",
  "browser_token_fallback_exception_documented",
  "browser_token_fallback_local_storage_disabled",
  "browser_token_fallback_age",
  "negative_evidence_present",
  "no_raw_secrets_stored",
  "no_sensitive_evidence_values",
  "operator",
  "ticket"
];
const nonSessionCredentialRequiredChecks = [
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
const ingressRequiredChecks = [...requiredIngressEvidenceCheckNames];
const upgradeRollbackRequiredChecks = [
  "non_dry_run",
  "not_template",
  "status_final",
  "no_sensitive_evidence_values",
  "drill_time_order",
  "target_environment",
  "release_identity",
  "version_pair",
  "rollback_version",
  "api_image_digests",
  "worker_image_digests",
  "service_rollback_digest",
  "migration_versions",
  "schema_rollback_compatibility",
  "backup_evidence_passed",
  "release_operations",
  "route_upgrade",
  "route_rollback_restores_previous_artifact",
  "http_rollback_verification",
  "readiness_evidence",
  "metrics_evidence",
  "logs_evidence",
  "alert_evidence",
  "operator",
  "ticket"
];

function passedBackupEvidence() {
  return {
    name: "siteflow-backup-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    thresholds: {
      maxBackupAgeHours: 24,
      maxRestoreDrillAgeHours: 168,
      requireOffHost: true
    },
    selectedEvidence: {
      backupVerify: {
        status: "verified",
        timestamp: "2026-06-08T10:30:00.000Z",
        backupPath: "/backups/siteflow-20260608",
        offHostLocation: "s3://siteflow-prod-backups/siteflow-20260608",
        provider: "s3"
      },
      restoreDrill: {
        status: "restored",
        completedAt: "2026-06-08T10:40:00.000Z",
        restoreDrill: true
      },
      backupOffload: {
        status: "offloaded",
        completedAt: "2026-06-08T10:50:00.000Z",
        offHostLocation: "s3://siteflow-prod-backups/siteflow-20260608",
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
        completedAt: "2026-06-08T10:52:00.000Z",
        backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260608",
        offHostLocation: "s3://siteflow-prod-backups/siteflow-20260608",
        provider: "s3"
      },
      backupProviderSecurityAudit: backupProviderSecurityAuditEvidence(),
      backupPrune: {
        status: "completed",
        completedAt: "2026-06-08T10:55:00.000Z",
        dryRun: false,
        retainedCurrentBackup: true
      }
    },
    checks: [
      {
        name: "backup_shape",
        status: "pass",
        message: "Backup evidence shape passed."
      },
      ...backupRequiredChecks.map((name) => ({
        name,
        status: "pass",
        message: `${name} passed.`
      }))
    ]
  };
}

function passedObservabilityEvidence() {
  return {
    name: "siteflow-observability-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production"
    },
    selectedEvidence: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      readinessProbe: {
        status: "passed",
        timestamp: "2026-06-08T11:00:00.000Z"
      },
      metricsScrape: {
        status: "scraped",
        timestamp: "2026-06-08T11:01:00.000Z"
      },
      backupAutomationRun: {
        status: "completed",
        timestamp: "2026-06-08T11:02:00.000Z"
      },
      backupAutomationRunHistory: {
        status: "completed",
        timestamp: "2026-06-08T11:02:30.000Z"
      },
      backupSchedulerOwnership: {
        status: "applied",
        timestamp: "2026-06-08T11:02:40.000Z"
      },
      observabilityApplyProof: {
        status: "applied",
        timestamp: "2026-06-08T11:02:30.000Z"
      },
      observabilityTargetStackProof: {
        status: "passed",
        timestamp: "2026-06-08T11:02:45.000Z"
      },
      alertDelivery: {
        status: "delivered",
        timestamp: "2026-06-08T11:03:00.000Z"
      },
      dashboard: {
        status: "available",
        timestamp: "2026-06-08T11:04:00.000Z"
      },
      logPipeline: {
        status: "passed",
        timestamp: "2026-06-08T11:05:00.000Z"
      }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...observabilityRequiredChecks.map(passingCheck)
    ]
  };
}

function passedOperatorAccessEvidence() {
  return {
    name: "siteflow-operator-access-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      sessionCreate: { status: "passed" },
      projectScope: { status: "passed" },
      sessionRotation: { status: "passed" },
      sessionRevoke: { status: "revoked" },
      csrf: { status: "enforced" },
      bearerPrecedence: { status: "passed" },
      actorAttribution: { status: "passed" },
      emergencyCutoff: { status: "passed" },
      browserTokenFallback: {
        status: "passed",
        productionFallbackEnabled: false,
        localStorageFallbackDisabled: true
      }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...operatorAccessRequiredChecks.map(passingCheck)
    ]
  };
}

function passedNonSessionCredentialEvidence() {
  return {
    name: "siteflow-non-session-credential-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      environment: "production",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      credentialTypes: ["scoped_api_token"],
      credentialCount: 1,
      breakGlass: { status: "passed" }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...nonSessionCredentialRequiredChecks.map(passingCheck)
    ]
  };
}

function passedIngressEvidence() {
  return {
    name: "siteflow-ingress-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      trustProxyPolicy: "loopback",
      deploymentTopology: {
        apiInstanceCount: 2,
        apiProcessCount: 2,
        ingressCount: 1
      },
      directApiPort: { status: "blocked" },
      forwardedHeaders: { status: "passed" },
      apiRateLimit: {
        status: "limited",
        edgeEnforced: true
      },
      unthrottledRoutes: { status: "passed" }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...ingressRequiredChecks.map(passingCheck)
    ]
  };
}

function passedUpgradeRollbackEvidence() {
  return {
    name: "siteflow-upgrade-rollback-drill-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      fromVersion: "0.1.0",
      toVersion: "0.1.1",
      rollbackVersion: "0.1.0",
      upgradeOperationId: "op_upgrade_1",
      rollbackOperationId: "op_rollback_1"
    },
    checks: [
      passingCheck("evidence_shape"),
      ...upgradeRollbackRequiredChecks.map(passingCheck)
    ]
  };
}

function evidenceAttachment(sourcePath: string, evidence: unknown) {
  return {
    sourcePath,
    collectedAt: "2026-06-08T11:40:00.000Z",
    releaseCommit: "abc123def4567890",
    evidence
  };
}

function passedReleaseEvidenceBundle(pack: ReturnType<typeof createReleaseEvidenceRehearsalPack>) {
  return {
    schemaVersion: "siteflow.releaseEvidence.v1",
    name: "siteflow-release-evidence-bundle",
    checkedAt: "2026-06-08T11:45:00.000Z",
    targetEnvironment: pack.release.targetEnvironment,
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: pack.release.targetEnvironment,
      requiredStatusCheck: "Install, test, and build",
      operatorName: "release-operator",
      releaseTicket: "REL-2026-0608",
      dockerSocketProfileAccepted: true
    },
    releaseGate: evidenceAttachment(pack.evidenceFiles.releaseGate, passedReleaseGateEvidence()),
    dockerBuildRehearsal: evidenceAttachment(pack.evidenceFiles.dockerBuild, passedDockerBuildRehearsal()),
    postgresRehearsal: evidenceAttachment(pack.evidenceFiles.postgres, passedPostgresRehearsal()),
    artifactEvidence: evidenceAttachment(pack.evidenceFiles.releaseArtifact, passedReleaseArtifactEvidence()),
    releaseImageEvidence: evidenceAttachment(pack.evidenceFiles.releaseImage, passedReleaseImageEvidence()),
    sourceProviderEvidence: evidenceAttachment(pack.evidenceFiles.sourceProvider, passedSourceProviderEvidence()),
    targetRuntimeEvidence: evidenceAttachment(pack.evidenceFiles.targetRuntime, passedTargetRuntimeEvidence()),
    backupEvidence: evidenceAttachment(pack.evidenceFiles.backup, passedBackupEvidence()),
    observabilityEvidence: evidenceAttachment(pack.evidenceFiles.observability, passedObservabilityEvidence()),
    operatorAccessEvidence: evidenceAttachment(pack.evidenceFiles.operatorAccess, passedOperatorAccessEvidence()),
    nonSessionCredentialEvidence: evidenceAttachment(pack.evidenceFiles.nonSessionCredential, passedNonSessionCredentialEvidence()),
    ingressEvidence: evidenceAttachment(pack.evidenceFiles.ingress, passedIngressEvidence()),
    upgradeRollbackEvidence: evidenceAttachment(pack.evidenceFiles.upgradeRollback, passedUpgradeRollbackEvidence())
  };
}

function releaseEvidenceBundleResult(
  pack: ReturnType<typeof createReleaseEvidenceRehearsalPack>,
  bundle: ReturnType<typeof passedReleaseEvidenceBundle> = passedReleaseEvidenceBundle(pack)
) {
  return evaluateReleaseEvidenceBundle(bundle, {
    evidencePath: pack.evidenceFiles.releaseEvidence,
    commitRef: pack.release.commitRef,
    repo: pack.release.repository,
    branch: pack.release.branch,
    targetEnvironment: pack.release.targetEnvironment,
    now
  });
}

function passedReleaseEvidenceCheck(
  pack: ReturnType<typeof createReleaseEvidenceRehearsalPack>,
  bundle: ReturnType<typeof passedReleaseEvidenceBundle> = passedReleaseEvidenceBundle(pack)
) {
  return releaseEvidenceBundleResult(pack, bundle);
}

describe("releaseEvidenceGapReport", () => {
  it("rejects incomplete rehearsal packs instead of reporting zero clean gaps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-incomplete-pack-"));

    try {
      const pack = {
        ...basePack(path.join(root, "evidence")),
        steps: [],
        finalCommands: {}
      };
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);

      await expect(createReleaseEvidenceGapReport({ packPath, now })).rejects.toThrow("Release evidence rehearsal pack is incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports planned release evidence outputs that have not been collected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-missing-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const releaseGate = result.items.find((item) => item.id === "release_gate");

      expect(result.status).toBe("blocked");
      expect(result.summary).toMatchObject({
        total: 15,
        gaps: 15,
        missing: 15
      });
      expect(releaseGate).toMatchObject({
        status: "missing",
        outputPath: pack.evidenceFiles.releaseGate,
        nextCommand: expect.stringContaining("release-gate"),
        requiresRealEnvironment: true
      });
      expect(result.blockedProductionClaims.join("\n")).toContain("does not execute GitHub");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps failed checker details and manual release-gate requirements actionable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-blocked-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseGate, {
        status: "pass",
        promotionEvidence: {
          gateStatus: "pass",
          commitRef: "abc123def4567890",
          repository: "acme/siteflow",
          branch: "main",
          manualRequired: true,
          manualRequiredCheckIds: ["branch_protection"]
        }
      });
      await writeJson(pack.evidenceFiles.operatorAccess, {
        name: "siteflow-operator-access-evidence-check",
        status: "blocked",
        checkedAt: "2026-06-08T11:30:00.000Z",
        exitCode: 1,
        checks: [
          {
            name: "evidence_shape",
            status: "fail",
            message: "missing proof"
          }
        ]
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });

      expect(result.summary.manualRequired).toBe(1);
      expect(result.summary.blocked).toBe(1);
      expect(result.items.find((item) => item.id === "release_gate")).toMatchObject({
        status: "manual_required",
        message: expect.stringContaining("manual_required")
      });
      expect(result.items.find((item) => item.id === "operator_access_evidence")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "evidence_shape",
            status: "fail",
            message: "missing proof"
          })
        ]),
        nextCommand: expect.stringContaining("operator-access:evidence")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks passing release-gate evidence when checkedAt is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-release-gate-timestamp-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const gate = passedReleaseGateEvidence() as Record<string, unknown>;

      delete gate.checkedAt;
      delete (gate.promotionEvidence as Record<string, unknown>).checkedAt;

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseGate, gate);

      const result = await createReleaseEvidenceGapReport({ packPath, now });

      expect(result.items.find((item) => item.id === "release_gate")).toMatchObject({
        status: "blocked",
        message: "Release gate evidence is missing checkedAt and cannot prove raw evidence freshness."
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks release-gate evidence that omits browser token fallback posture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-release-gate-browser-fallback-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const gate = passedReleaseGateEvidence();
      const runtimeEnv = gate.promotionEvidence.runtimeEnv as Record<string, unknown>;

      delete runtimeEnv.browserTokenFallbackEnabled;
      delete runtimeEnv.browserTokenFallbackStatus;
      delete runtimeEnv.browserTokenFallbackEnvValue;

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseGate, gate);

      const result = await createReleaseEvidenceGapReport({ packPath, now });

      expect(result.items.find((item) => item.id === "release_gate")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "release_gate_browser_token_fallback",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks release-gate evidence that omits build storage preflight posture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-release-gate-storage-preflight-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const gate = passedReleaseGateEvidence();
      const runtimeEnv = gate.promotionEvidence.runtimeEnv as Record<string, unknown>;

      delete runtimeEnv.buildMinFreeBytesStatus;
      delete runtimeEnv.buildMinFreeBytes;

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseGate, gate);

      const result = await createReleaseEvidenceGapReport({ packPath, now });

      expect(result.items.find((item) => item.id === "release_gate")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "release_gate_build_storage_preflight",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing command input files and env prerequisites without changing output item counts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-inputs-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);

      const result = await createReleaseEvidenceGapReport({
        packPath,
        env: {},
        now
      });
      const releaseGate = result.items.find((item) => item.id === "release_gate");
      const backupEvidence = result.items.find((item) => item.id === "backup_evidence");
      const sourceProviderEvidence = result.items.find((item) => item.id === "source_provider_evidence");
      const observabilityEvidence = result.items.find((item) => item.id === "observability_evidence");
      const operatorAccess = result.items.find((item) => item.id === "operator_access_evidence");

      expect(result.summary).toMatchObject({
        total: 15,
        missing: 15
      });
      expect(result.summary.inputGaps).toBeGreaterThan(11);
      expect(releaseGate?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "file",
            value: pack.release.targetEnvFile,
            status: "missing"
          }),
          expect.objectContaining({
            kind: "env",
            value: "GITHUB_TOKEN",
            status: "missing"
          })
        ])
      );
      expect(backupEvidence?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.backupVerify, status: "missing" }),
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.restoreDrill, status: "missing" }),
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.backupOffload, status: "missing" }),
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.backupFetch, status: "missing" }),
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.backupProviderSecurityAudit, status: "missing" }),
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.backupPrune, status: "missing" }),
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.backupPolicy, status: "missing" })
        ])
      );
      expect(backupEvidence?.inputGaps).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: pack.evidenceFiles.backupRaw }),
          expect.objectContaining({ value: pack.evidenceFiles.backup })
        ])
      );
      expect(sourceProviderEvidence?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.sourceProviderRaw, status: "missing" })
        ])
      );
      expect(observabilityEvidence?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.backupAutomationRun, status: "missing" })
        ])
      );
      expect(operatorAccess?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "file", value: pack.evidenceFiles.operatorAccessRaw, status: "missing" })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unresolved command argument placeholders and rehearses --set without leaking values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-placeholders-"));
    let stdout = "";
    let stderr = "";

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const replacements = {
        "release-image-run-id": "run-id-do-not-leak",
        "direct-api-url": "https://api.internal/do-not-leak/readyz",
        SITEFLOW_TRUST_PROXY: "proxy-policy-do-not-leak",
        "api-instance-count": "api-instances-do-not-leak",
        "api-process-count": "api-processes-do-not-leak",
        "ingress-count": "ingress-count-do-not-leak",
        "api-rate-limit-scope": "rate-scope-do-not-leak",
        "api-rate-limit-enforcement-point": "rate-enforcement-do-not-leak"
      };

      await writeJson(packPath, pack);

      const unresolved = await createReleaseEvidenceGapReport({
        packPath,
        env: {},
        now
      });
      const unresolvedReleaseImage = unresolved.items.find((item) => item.id === "release_image_evidence");
      const unresolvedIngress = unresolved.items.find((item) => item.id === "ingress_evidence");

      expect(unresolvedReleaseImage?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "operator_input",
            source: "command_arg",
            status: "operator_required",
            value: "release-image-run-id",
            placeholder: "<release-image-run-id>"
          })
        ])
      );
      expect(unresolvedIngress?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "command_arg", value: "direct-api-url", placeholder: "<direct-api-url>" }),
          expect.objectContaining({ source: "command_arg", value: "api-instance-count", placeholder: "<api-instance-count>" }),
          expect.objectContaining({ source: "command_arg", value: "api-rate-limit-enforcement-point", placeholder: "<api-rate-limit-enforcement-point>" })
        ])
      );

      const rehearsed = await createReleaseEvidenceGapReport({
        packPath,
        replacements,
        env: {},
        now
      });
      const rehearsedReleaseImage = rehearsed.items.find((item) => item.id === "release_image_evidence");
      const rehearsedIngress = rehearsed.items.find((item) => item.id === "ingress_evidence");
      const serialized = JSON.stringify(rehearsed);

      expect(rehearsedReleaseImage?.inputGaps).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "command_arg", value: "release-image-run-id" })
        ])
      );
      expect(rehearsedIngress?.inputGaps).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "operator_input", source: "command_arg" })
        ])
      );
      for (const value of Object.values(replacements)) {
        expect(serialized).not.toContain(value);
      }

      const exitCode = await runReleaseEvidenceGapReportCli(
        [
          "--pack", packPath,
          "--json",
          ...Object.entries(replacements).flatMap(([key, value]) => ["--set", `${key}=${value}`])
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { env: {}, now }
      );

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      for (const value of Object.values(replacements)) {
        expect(stdout).not.toContain(value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rehearses --set-env placeholders without leaking resolved env values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-set-env-"));
    let stdout = "";
    let stderr = "";

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const envReplacements = {
        "release-image-run-id": "SITEFLOW_RELEASE_IMAGE_RUN_ID",
        "direct-api-url": "SITEFLOW_DIRECT_API_URL",
        SITEFLOW_TRUST_PROXY: "SITEFLOW_TRUST_PROXY",
        "api-instance-count": "SITEFLOW_API_INSTANCE_COUNT",
        "api-process-count": "SITEFLOW_API_PROCESS_COUNT",
        "ingress-count": "SITEFLOW_INGRESS_COUNT",
        "api-rate-limit-scope": "SITEFLOW_API_RATE_LIMIT_SCOPE",
        "api-rate-limit-enforcement-point": "SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT"
      };
      const envValues = {
        SITEFLOW_RELEASE_IMAGE_RUN_ID: "run-id-do-not-leak",
        SITEFLOW_DIRECT_API_URL: "https://api.internal/do-not-leak/readyz",
        SITEFLOW_TRUST_PROXY: "proxy-policy-do-not-leak",
        SITEFLOW_API_INSTANCE_COUNT: "api-instances-do-not-leak",
        SITEFLOW_API_PROCESS_COUNT: "api-processes-do-not-leak",
        SITEFLOW_INGRESS_COUNT: "ingress-count-do-not-leak",
        SITEFLOW_API_RATE_LIMIT_SCOPE: "rate-scope-do-not-leak",
        SITEFLOW_API_RATE_LIMIT_ENFORCEMENT_POINT: "rate-enforcement-do-not-leak"
      };

      await writeJson(packPath, pack);

      const result = await createReleaseEvidenceGapReport({
        packPath,
        envReplacements,
        env: envValues,
        now
      });
      const releaseImage = result.items.find((item) => item.id === "release_image_evidence");
      const ingress = result.items.find((item) => item.id === "ingress_evidence");
      const serialized = JSON.stringify(result);

      expect(result.envReplacements).toEqual(
        Object.entries(envReplacements).map(([key, envName]) => ({ key, envName }))
      );
      expect(releaseImage?.inputGaps).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "command_arg", value: "release-image-run-id" })
        ])
      );
      expect(ingress?.inputGaps).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "operator_input", source: "command_arg" })
        ])
      );
      for (const value of Object.values(envValues)) {
        expect(serialized).not.toContain(value);
      }
      for (const envName of Object.values(envReplacements)) {
        expect(serialized).toContain(envName);
      }

      const exitCode = await runReleaseEvidenceGapReportCli(
        [
          "--pack", packPath,
          "--json",
          ...Object.entries(envReplacements).flatMap(([key, envName]) => ["--set-env", `${key}=${envName}`])
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { env: envValues, now }
      );

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      for (const value of Object.values(envValues)) {
        expect(stdout).not.toContain(value);
      }
      for (const envName of Object.values(envReplacements)) {
        expect(stdout).toContain(envName);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints input gap names in human output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-human-placeholders-"));
    let stdout = "";
    let stderr = "";

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);

      const exitCode = await runReleaseEvidenceGapReportCli(
        ["--pack", packPath],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { env: {}, now }
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Input gap: placeholder <release-image-run-id>");
      expect(stderr).toContain("Input gap: placeholder <direct-api-url>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks shallow source provider, target runtime, operator, credential, and ingress checker outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-shallow-access-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const shallowPassed = {
        status: "passed",
        checkedAt: "2026-06-08T11:30:00.000Z",
        exitCode: 0,
        checks: []
      };

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.sourceProvider, {
        ...shallowPassed,
        name: "siteflow-source-provider-evidence-check"
      });
      await writeJson(pack.evidenceFiles.targetRuntime, {
        ...shallowPassed,
        name: "siteflow-target-runtime-evidence-check"
      });
      await writeJson(pack.evidenceFiles.operatorAccess, {
        ...shallowPassed,
        name: "siteflow-operator-access-evidence-check"
      });
      await writeJson(pack.evidenceFiles.nonSessionCredential, {
        ...shallowPassed,
        name: "siteflow-non-session-credential-evidence-check"
      });
      await writeJson(pack.evidenceFiles.ingress, {
        ...shallowPassed,
        name: "siteflow-ingress-evidence-check"
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const sourceProvider = result.items.find((item) => item.id === "source_provider_evidence");
      const targetRuntime = result.items.find((item) => item.id === "target_runtime_evidence");
      const operatorAccess = result.items.find((item) => item.id === "operator_access_evidence");
      const nonSessionCredential = result.items.find((item) => item.id === "non_session_credential_evidence");
      const ingress = result.items.find((item) => item.id === "ingress_evidence");

      expect(sourceProvider).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ name: "source_provider_selected_evidence" }),
          expect.objectContaining({ name: "source_provider_required_checks" })
        ])
      });
      expect(targetRuntime).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ name: "target_runtime_selected_evidence" }),
          expect.objectContaining({ name: "target_runtime_required_checks" })
        ])
      });
      expect(operatorAccess).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ name: "operator_access_selected_evidence" }),
          expect.objectContaining({ name: "operator_access_required_checks" })
        ])
      });
      expect(nonSessionCredential).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ name: "non_session_credential_selected_evidence" }),
          expect.objectContaining({ name: "non_session_credential_required_checks" })
        ])
      });
      expect(ingress).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ name: "ingress_selected_evidence" }),
          expect.objectContaining({ name: "ingress_required_checks" })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks target runtime evidence with shallow selected section summaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-target-runtime-summary-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const targetRuntime = passedTargetRuntimeEvidence();

      (targetRuntime.selectedEvidence as Record<string, unknown>).composeConfig = { status: "passed" };

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.targetRuntime, targetRuntime);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const targetRuntimeItem = result.items.find((item) => item.id === "target_runtime_evidence");

      expect(targetRuntimeItem).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "target_runtime_selected_evidence",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks source provider, target runtime, access, credential, ingress, and rollback evidence collected for a different target environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-access-target-env-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const sourceProvider = passedSourceProviderEvidence();
      const targetRuntime = passedTargetRuntimeEvidence();
      const operatorAccess = passedOperatorAccessEvidence();
      const nonSessionCredential = passedNonSessionCredentialEvidence();
      const ingress = passedIngressEvidence();
      const upgradeRollback = passedUpgradeRollbackEvidence();

      sourceProvider.selectedEvidence.environment = "staging";
      targetRuntime.release.targetEnvironment = "staging";
      operatorAccess.selectedEvidence.environment = "staging";
      nonSessionCredential.selectedEvidence.environment = "staging";
      ingress.selectedEvidence.environment = "staging";
      upgradeRollback.selectedEvidence.targetEnvironment = "staging";

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.sourceProvider, sourceProvider);
      await writeJson(pack.evidenceFiles.targetRuntime, targetRuntime);
      await writeJson(pack.evidenceFiles.operatorAccess, operatorAccess);
      await writeJson(pack.evidenceFiles.nonSessionCredential, nonSessionCredential);
      await writeJson(pack.evidenceFiles.ingress, ingress);
      await writeJson(pack.evidenceFiles.upgradeRollback, upgradeRollback);

      const result = await createReleaseEvidenceGapReport({ packPath, now });

      expect(result.items.find((item) => item.id === "source_provider_evidence")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "source_provider_target_environment",
            status: "fail"
          })
        ])
      });
      expect(result.items.find((item) => item.id === "target_runtime_evidence")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "target_runtime_target_environment",
            status: "fail"
          })
        ])
      });
      expect(result.items.find((item) => item.id === "operator_access_evidence")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "operator_access_target_environment",
            status: "fail"
          })
        ])
      });
      expect(result.items.find((item) => item.id === "non_session_credential_evidence")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "non_session_credential_target_environment",
            status: "fail"
          })
        ])
      });
      expect(result.items.find((item) => item.id === "ingress_evidence")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "ingress_target_environment",
            status: "fail"
          })
        ])
      });
      expect(result.items.find((item) => item.id === "upgrade_rollback_evidence")).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "upgrade_rollback_target_environment",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports shallow release image evidence without attestations as blocked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-image-attestations-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const releaseImage = passedReleaseImageEvidence() as Record<string, unknown>;

      delete releaseImage.attestations;

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseImage, releaseImage);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const releaseImageItem = result.items.find((item) => item.id === "release_image_evidence");

      expect(releaseImageItem).toMatchObject({
        status: "blocked",
        message: "Evidence output is not passing.",
        nextCommand: expect.stringContaining("release-image-evidence"),
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "release_image_provenance_attestation",
            status: "fail"
          }),
          expect.objectContaining({
            name: "release_image_sbom_attestation",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts sensitive failed check messages in object and CLI JSON reports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-check-message-redaction-"));
    const secretOutput = "Authorization: Bearer abcdefghijklmnop";
    let stdout = "";
    let stderr = "";

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseImage, {
        ...passedReleaseImageEvidence(),
        status: "blocked",
        checks: [
          {
            name: "registry_attestation",
            status: "fail",
            message: `registry check failed with ${secretOutput}`
          }
        ]
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const serialized = JSON.stringify(result);
      const releaseImageItem = result.items.find((item) => item.id === "release_image_evidence");

      expect(serialized).not.toContain(secretOutput);
      expect(serialized).not.toContain("abcdefghijklmnop");
      expect(releaseImageItem?.failedChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "registry_attestation",
            status: "fail",
            message: expect.stringContaining("[redacted: sensitive check message omitted")
          })
        ])
      );

      const exitCode = await runReleaseEvidenceGapReportCli(
        ["--pack", packPath, "--json"],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { now }
      );

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(stdout).not.toContain(secretOutput);
      expect(stdout).not.toContain("abcdefghijklmnop");
      expect(JSON.parse(stdout).items.find((item: { id: string }) => item.id === "release_image_evidence").failedChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "registry_attestation",
            message: expect.stringContaining("[redacted: sensitive check message omitted")
          })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports multi-instance process-local API rate limiting as an ingress evidence gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-ingress-rate-limit-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const ingress = passedIngressEvidence();
      const apiRateLimit = ingress.selectedEvidence.apiRateLimit as Record<string, unknown>;

      delete apiRateLimit.edgeEnforced;
      apiRateLimit.processLocalOnly = true;
      apiRateLimit.clientIpBucketed = true;

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.ingress, ingress);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const ingressItem = result.items.find((item) => item.id === "ingress_evidence");

      expect(ingressItem).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("ingress:evidence:collect"),
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "ingress_rate_limit_topology",
            status: "fail",
            message: expect.stringContaining("process-local-only")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports env prerequisite names without leaking configured values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-env-redaction-"));
    const secret = "ghp_super_secret_do_not_leak";

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);

      const result = await createReleaseEvidenceGapReport({
        packPath,
        env: {
          GITHUB_TOKEN: secret,
          SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL: "wrong-secret"
        },
        now
      });
      const serialized = JSON.stringify(result);
      const dockerBuild = result.items.find((item) => item.id === "docker_build_rehearsal");

      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("wrong-secret");
      expect(dockerBuild?.inputGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "operator_input",
            value: "SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL",
            status: "operator_required"
          }),
          expect.objectContaining({
            kind: "operator_input",
            value: "SITEFLOW_BUILD_IMAGE",
            status: "operator_required"
          })
        ])
      );
      expect(result.items.find((item) => item.id === "release_gate")?.inputGaps).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "GITHUB_TOKEN" })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks generic-passing Postgres evidence with missing production diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-postgres-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.postgres, {
        ...passedPostgresRehearsal(),
        targetDatabase: {
          parseStatus: "passed",
          redactedUrl: "postgres://postgres.internal:5432/siteflow_rehearsal?sslmode=require"
        },
        prerequisites: [
          {
            name: "SITEFLOW_RUN_POSTGRES_INTEGRATION",
            required: true,
            status: "failed"
          }
        ],
        rehearsalScope: ["migration_advisory_lock"]
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const postgres = result.items.find((item) => item.id === "postgres_rehearsal");
      const failedCheckNames = postgres?.failedChecks.map((check) => check.name);

      expect(postgres).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("rehearsal:postgres")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "postgres_prerequisites",
          "postgres_target_database",
          "postgres_rehearsal_scope"
        ])
      );
      expect(failedCheckNames).not.toContain("postgres_passed");
      expect(result.summary.blocked).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks Postgres evidence without complete passed scenario results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-postgres-scenarios-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.postgres, {
        ...passedPostgresRehearsal(),
        scenarioResults: postgresRehearsalScopes.slice(0, -1).map((scope) => ({
          scope,
          status: "passed"
        }))
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const postgres = result.items.find((item) => item.id === "postgres_rehearsal");

      expect(postgres).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "postgres_scenario_results",
            status: "fail",
            message: expect.stringContaining("exhausted_lease_failure")
          })
        ]),
        nextCommand: expect.stringContaining("rehearsal:postgres")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks Postgres evidence collected for a different target environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-postgres-target-env-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const postgres = passedPostgresRehearsal();

      postgres.release.targetEnvironment = "staging";
      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.postgres, postgres);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const postgresItem = result.items.find((item) => item.id === "postgres_rehearsal");

      expect(postgresItem).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "postgres_target_environment",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks generic-passing Docker build rehearsal evidence with missing production diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-docker-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      const dockerBuildEvidence = {
        ...passedDockerBuildRehearsal(),
        docker: {
          ...passedDockerBuildRehearsal().docker,
          network: "bridge",
          dockerInfoAvailable: false
        },
        buildCommands: ["npm run build"],
        artifact: {
          entrypoint: "index.html",
          fileCount: 3
        }
      };

      delete (dockerBuildEvidence as Record<string, unknown>).artifactLimits;
      await writeJson(pack.evidenceFiles.dockerBuild, dockerBuildEvidence);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const dockerBuild = result.items.find((item) => item.id === "docker_build_rehearsal");
      const failedCheckNames = dockerBuild?.failedChecks.map((check) => check.name);

      expect(dockerBuild).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("rehearsal:docker-build")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "docker_build_rehearsal_profile",
          "docker_build_rehearsal_commands",
          "docker_build_rehearsal_artifact"
        ])
      );
      expect(result.summary.blocked).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports allowlisted Docker build image tags without tagged-image exception evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-docker-tag-exception-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const releaseGate = passedReleaseGateEvidence();
      const runtimeEnv = releaseGate.promotionEvidence.runtimeEnv;
      const taggedImage = "registry.local/siteflow/build-node:20.11";
      runtimeEnv.buildImage = taggedImage;
      runtimeEnv.buildImageDigestPinned = false;
      runtimeEnv.buildImageAllowlistConfigured = true;
      runtimeEnv.buildImageAllowedByAllowlist = true;
      runtimeEnv.buildImageTaggedTrustedExceptionAccepted = true;
      runtimeEnv.buildImagePolicyStatus = "pass";
      runtimeEnv.buildImagePolicy = "tag_allowlist_exception";
      const dockerBuildEvidence = passedDockerBuildRehearsal();
      dockerBuildEvidence.docker = {
        ...dockerBuildEvidence.docker,
        image: taggedImage,
        imageDigestPinned: false,
        imageAllowlistConfigured: true,
        imageAllowedByAllowlist: true,
        imageTaggedTrustedExceptionAccepted: false
      };

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseGate, releaseGate);
      await writeJson(pack.evidenceFiles.dockerBuild, dockerBuildEvidence);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const dockerBuild = result.items.find((item) => item.id === "docker_build_rehearsal");

      expect(dockerBuild).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "docker_build_rehearsal_profile",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports final release evidence check identity mismatches from selected evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-final-check-identity-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseEvidenceCheck, {
        name: "siteflow-release-evidence-bundle-check",
        status: "passed",
        checkedAt: "2026-06-08T11:45:00.000Z",
        evidencePath: pack.evidenceFiles.releaseEvidence,
        exitCode: 0,
        selectedEvidence: {
          releaseCommitRef: "different-release-commit",
          repository: "acme/siteflow",
          branch: "main"
        },
        checks: [
          {
            name: "bundle",
            status: "pass",
            message: "Bundle passed."
          }
        ]
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const finalCheck = result.items.find((item) => item.id === "release_evidence_check");

      expect(finalCheck).toMatchObject({
        status: "identity_mismatch",
        message: "Evidence release identity does not match the rehearsal pack release.",
        nextCommand: expect.stringContaining("release:evidence")
      });
      expect(result.summary.identityMismatches).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks shallow final release evidence bundles by running final bundle checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-shallow-bundle-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseEvidence, {
        schemaVersion: "siteflow.releaseEvidence.v1",
        name: "siteflow-release-evidence-bundle",
        release: {
          commitRef: "abc123def4567890",
          repository: "acme/siteflow",
          branch: "main",
          targetEnvironment: "production"
        }
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const finalBundle = result.items.find((item) => item.id === "release_evidence_bundle");
      const failedCheckNames = finalBundle?.failedChecks.map((check) => check.name);

      expect(finalBundle).toMatchObject({
        status: "blocked",
        message: "Release evidence bundle does not pass final bundle checks.",
        nextCommand: expect.stringContaining("release:evidence:compose")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "bundle_checked_at",
          "release_gate_present",
          "postgres_present"
        ])
      );
      expect(result.summary.blocked).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks final release bundles whose target environment differs from the rehearsal pack", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-target-env-"));

    try {
      const pack = basePack(path.join(root, "evidence"), { targetEnvironment: "staging" });
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const bundle = passedReleaseEvidenceBundle(pack);

      bundle.targetEnvironment = "production";
      (bundle.release as Record<string, unknown>).targetEnvironment = "production";

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseEvidence, bundle);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const finalBundle = result.items.find((item) => item.id === "release_evidence_bundle");

      expect(finalBundle).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "target_environment",
            status: "fail",
            message: "Release evidence bundle targetEnvironment must be staging."
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks final release evidence checks that point at a different bundle path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-final-check-path-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const bundle = passedReleaseEvidenceBundle(pack);
      const finalCheck = {
        ...passedReleaseEvidenceCheck(pack, bundle),
        evidencePath: path.join(root, "other", "release-evidence.json")
      };

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseEvidence, bundle);
      await writeJson(pack.evidenceFiles.releaseEvidenceCheck, finalCheck);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const finalCheckItem = result.items.find((item) => item.id === "release_evidence_check");

      expect(finalCheckItem).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "final_release_evidence_check_expected_path",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks final release evidence checks that disagree with the recomputed bundle result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-final-check-recomputed-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseEvidence, {
        schemaVersion: "siteflow.releaseEvidence.v1",
        name: "siteflow-release-evidence-bundle",
        checkedAt: "2026-06-08T11:45:00.000Z",
        targetEnvironment: "production",
        release: {
          commitRef: "abc123def4567890",
          repository: "acme/siteflow",
          branch: "main",
          targetEnvironment: "production"
        }
      });
      await writeJson(pack.evidenceFiles.releaseEvidenceCheck, passedReleaseEvidenceCheck(pack));

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const finalCheckItem = result.items.find((item) => item.id === "release_evidence_check");
      const failedCheckNames = finalCheckItem?.failedChecks.map((check) => check.name);

      expect(finalCheckItem).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("release:evidence")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "final_release_evidence_check_result_status",
          "final_release_evidence_check_rows_match_bundle"
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks final release evidence checks that omit recomputed bundle check rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-final-check-rows-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const bundle = passedReleaseEvidenceBundle(pack);
      const finalCheck = {
        ...passedReleaseEvidenceCheck(pack, bundle),
        checks: [passingCheck("bundle_shape")]
      };

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseEvidence, bundle);
      await writeJson(pack.evidenceFiles.releaseEvidenceCheck, finalCheck);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const finalCheckItem = result.items.find((item) => item.id === "release_evidence_check");

      expect(finalCheckItem).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "final_release_evidence_check_rows_match_bundle",
            status: "fail"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks fake-passing final release evidence check outputs without checker shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-final-check-shape-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseEvidenceCheck, {
        name: "siteflow-release-evidence-bundle-check",
        status: "passed",
        checkedAt: "2026-06-08T11:45:00.000Z",
        exitCode: 0,
        selectedEvidence: {
          releaseCommitRef: "abc123def4567890",
          repository: "acme/siteflow",
          branch: "main"
        },
        checks: []
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const finalCheck = result.items.find((item) => item.id === "release_evidence_check");
      const failedCheckNames = finalCheck?.failedChecks.map((check) => check.name);

      expect(finalCheck).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("release:evidence")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "final_release_evidence_check_evidence_path",
          "final_release_evidence_check_checks"
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports same-process function runtime isolation as a release artifact evidence gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-function-runtime-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseArtifact, sameProcessFunctionReleaseArtifactEvidence());

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const releaseArtifact = result.items.find((item) => item.id === "release_artifact_evidence");

      expect(releaseArtifact).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("release:artifact"),
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "release_artifact_function_runtime_isolation",
            status: "fail",
            message: expect.stringContaining("same_process")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing deployment artifact manifest as a release artifact evidence gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-artifact-manifest-missing-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");
      const artifactEvidence = passedReleaseArtifactEvidence() as ReturnType<typeof passedReleaseArtifactEvidence> & Record<string, unknown>;

      delete artifactEvidence.artifactManifest;
      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseArtifact, artifactEvidence);

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const releaseArtifact = result.items.find((item) => item.id === "release_artifact_evidence");

      expect(releaseArtifact).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "release_artifact_function_runtime_isolation",
            status: "fail",
            message: expect.stringContaining("deployment artifact manifest")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing function runtime isolation as a release artifact evidence gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-function-runtime-missing-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseArtifact, functionReleaseArtifactEvidenceWithRuntimeIsolation());

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const releaseArtifact = result.items.find((item) => item.id === "release_artifact_evidence");

      expect(releaseArtifact).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "release_artifact_function_runtime_isolation",
            status: "fail",
            message: expect.stringContaining("missing")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unknown function runtime isolation as a release artifact evidence gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-function-runtime-unknown-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseArtifact, functionReleaseArtifactEvidenceWithRuntimeIsolation("shared_process"));

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const releaseArtifact = result.items.find((item) => item.id === "release_artifact_evidence");

      expect(releaseArtifact).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "release_artifact_function_runtime_isolation",
            status: "fail",
            message: expect.stringContaining("unknown")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks generic-passing backup evidence without off-host selected evidence diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-backup-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.backup, {
        ...passedBackupEvidence(),
        thresholds: {
          maxBackupAgeHours: 24,
          maxRestoreDrillAgeHours: 168,
          requireOffHost: false
        },
        selectedEvidence: {
          backupVerify: passedBackupEvidence().selectedEvidence.backupVerify
        },
        checks: [
          {
            name: "backup_shape",
            status: "pass",
            message: "Backup evidence shape passed."
          }
        ]
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const backupEvidence = result.items.find((item) => item.id === "backup_evidence");
      const failedCheckNames = backupEvidence?.failedChecks.map((check) => check.name);

      expect(backupEvidence).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("backup:evidence:compose")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "backup_off_host_required",
          "backup_selected_evidence",
          "backup_offload_prune_checks"
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks generic-passing observability evidence without selected target diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-observability-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.observability, {
        ...passedObservabilityEvidence(),
        selectedEvidence: {
          readinessProbe: {
            status: "passed",
            timestamp: "2026-06-08T11:00:00.000Z"
          }
        },
        checks: [passingCheck("readiness_traffic_removed")]
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const observability = result.items.find((item) => item.id === "observability_evidence");
      const failedCheckNames = observability?.failedChecks.map((check) => check.name);

      expect(observability).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("observability:evidence:collect")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "observability_selected_evidence",
          "observability_required_checks"
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks observability selected evidence summaries without status and timestamps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-observability-summary-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.observability, {
        ...passedObservabilityEvidence(),
        selectedEvidence: {
          ...passedObservabilityEvidence().selectedEvidence,
          logPipeline: {
            status: "passed"
          }
        }
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const observability = result.items.find((item) => item.id === "observability_evidence");

      expect(observability).toMatchObject({
        status: "blocked",
        failedChecks: expect.arrayContaining([
          expect.objectContaining({
            name: "observability_selected_evidence",
            status: "fail",
            message: expect.stringContaining("status and timestamp")
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks generic-passing upgrade/rollback evidence without required drill diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-upgrade-rollback-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.upgradeRollback, {
        ...passedUpgradeRollbackEvidence(),
        selectedEvidence: {
          fromVersion: "0.1.0",
          toVersion: "0.1.1",
          rollbackVersion: "0.1.0",
          upgradeOperationId: "op_upgrade_1",
          rollbackOperationId: "op_rollback_1"
        },
        checks: [passingCheck("evidence_shape")]
      });

      const result = await createReleaseEvidenceGapReport({ packPath, now });
      const upgradeRollback = result.items.find((item) => item.id === "upgrade_rollback_evidence");
      const failedCheckNames = upgradeRollback?.failedChecks.map((check) => check.name);

      expect(upgradeRollback).toMatchObject({
        status: "blocked",
        message: "Evidence output is missing required production diagnostics.",
        nextCommand: expect.stringContaining("upgrade-rollback:evidence")
      });
      expect(failedCheckNames).toEqual(
        expect.arrayContaining([
          "upgrade_rollback_selected_evidence",
          "upgrade_rollback_required_checks"
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes when all planned evidence, final bundle, and final check outputs exist and pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-passed-"));

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);
      await writeJson(pack.evidenceFiles.releaseGate, passedReleaseGateEvidence());

      for (const step of pack.steps.filter((entry) => entry.id !== "release_gate")) {
        await writeJson(
          step.outputPath,
          step.id === "postgres_rehearsal"
            ? passedPostgresRehearsal()
            : step.id === "docker_build_rehearsal"
              ? passedDockerBuildRehearsal()
              : step.id === "release_artifact_evidence"
                ? passedReleaseArtifactEvidence()
              : step.id === "release_image_evidence"
                ? passedReleaseImageEvidence()
              : step.id === "source_provider_evidence"
                ? passedSourceProviderEvidence()
              : step.id === "target_runtime_evidence"
                ? passedTargetRuntimeEvidence()
              : step.id === "backup_evidence"
                ? passedBackupEvidence()
                : step.id === "observability_evidence"
                  ? passedObservabilityEvidence()
                  : step.id === "operator_access_evidence"
                    ? passedOperatorAccessEvidence()
                    : step.id === "non_session_credential_evidence"
                      ? passedNonSessionCredentialEvidence()
                      : step.id === "ingress_evidence"
                        ? passedIngressEvidence()
                  : step.id === "upgrade_rollback_evidence"
                    ? passedUpgradeRollbackEvidence()
                    : passedChecker(`siteflow-${step.id}`)
        );
      }

      await writeJson(pack.evidenceFiles.releaseEvidence, passedReleaseEvidenceBundle(pack));
      await writeJson(pack.evidenceFiles.releaseEvidenceCheck, passedReleaseEvidenceCheck(pack));

      const result = await createReleaseEvidenceGapReport({ packPath, now });

      expect(result.status).toBe("passed");
      expect(result.exitCode).toBe(0);
      expect(result.summary).toMatchObject({
        total: 15,
        passed: 15,
        gaps: 0
      });
      expect(result.items.every((item) => item.status === "passed")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits a JSON CLI report without executing evidence commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-release-gaps-cli-"));
    let stdout = "";
    let stderr = "";

    try {
      const pack = basePack(path.join(root, "evidence"));
      const packPath = path.join(pack.outputDir, "release-evidence-rehearsal-pack.json");

      await writeJson(packPath, pack);

      const exitCode = await runReleaseEvidenceGapReportCli(
        ["--pack", packPath, "--json"],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        { now }
      );
      const printed = JSON.parse(stdout);

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(printed).toMatchObject({
        name: "siteflow-release-evidence-gap-report",
        status: "blocked",
        summary: {
          missing: 15
        }
      });
      expect(await readFile(packPath, "utf8")).toContain("siteflow-release-evidence-rehearsal-pack");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
