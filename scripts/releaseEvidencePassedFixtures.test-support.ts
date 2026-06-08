import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck.js";
import { evaluateReleaseEvidenceBundle } from "./releaseEvidenceBundleCheck.js";
import type { createReleaseEvidenceRehearsalPack } from "./releaseEvidenceRehearsalPack.js";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck.js";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts.js";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck.js";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck.js";

const pinnedBuildImage = "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const backupKmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";
const now = () => new Date("2026-06-08T12:00:00.000Z");

type ReleaseEvidencePack = ReturnType<typeof createReleaseEvidenceRehearsalPack>;

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function passingCheck(name: string) {
  return {
    name,
    status: "pass",
    message: `${name} passed.`
  };
}

export function passedReleaseGateEvidence() {
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

export function passedPostgresRehearsal() {
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
      { name: "SITEFLOW_RUN_POSTGRES_INTEGRATION", required: true, status: "passed" },
      { name: "TEST_DATABASE_URL", required: true, status: "passed" },
      { name: "TEST_DATABASE_URL_FORMAT", required: true, status: "passed" }
    ],
    rehearsalScope: postgresRehearsalScopes,
    scenarioResults: postgresRehearsalScopes.map((scope) => ({
      scope,
      status: "passed",
      recordedAt: "2026-06-08T11:30:00.000Z",
      assertions: { exercised: true },
      metrics: { durationMs: 1 }
    })),
    command: {
      args: ["vitest", "run", "worker/postgresRehearsal.integration.test.ts"],
      display: "npx vitest run worker/postgresRehearsal.integration.test.ts"
    }
  };
}

export function passedDockerBuildRehearsal() {
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

export function passedSourceProviderEvidence() {
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
      ...requiredSourceProviderEvidenceCheckNames.map(passingCheck)
    ]
  };
}

export function passedReleaseArtifactEvidence() {
  const artifacts = [
    { path: "dist/index.html", sizeBytes: 512, sha256: "a".repeat(64) },
    { path: "dist/assets/index.js", sizeBytes: 1024, sha256: "b".repeat(64) },
    { path: "dist-cli/cli/index.js", sizeBytes: 2048, sha256: "c".repeat(64) },
    { path: "dist-server/server/index.js", sizeBytes: 2048, sha256: "d".repeat(64) },
    { path: "dist-worker/worker/index.js", sizeBytes: 2048, sha256: "e".repeat(64) }
  ];
  const checksum = `sha256:${"9".repeat(64)}`;

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
      checksum,
      packageBinSiteflow: "./dist-cli/cli/index.js",
      auditExitCode: 0
    },
    manifest: {
      schemaVersion: "siteflow.releaseArtifactManifest.v1",
      name: "siteflow-release-artifact-manifest",
      generatedAt: "2026-06-08T11:29:00.000Z",
      checksum,
      artifacts
    },
    artifactManifest: {
      functions: []
    },
    checks: [
      passingCheck("evidence_shape"),
      ...requiredReleaseArtifactCheckNames.map(passingCheck)
    ]
  };
}

export function passedReleaseImageEvidence() {
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

export function passedBackupEvidence() {
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
      passingCheck("backup_shape"),
      ...requiredOffHostBackupEvidenceCheckNames.map(passingCheck)
    ]
  };
}

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

export function passedObservabilityEvidence() {
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
      readinessProbe: { status: "passed", timestamp: "2026-06-08T11:00:00.000Z" },
      metricsScrape: { status: "scraped", timestamp: "2026-06-08T11:01:00.000Z" },
      backupAutomationRun: { status: "completed", timestamp: "2026-06-08T11:02:00.000Z" },
      backupAutomationRunHistory: { status: "completed", timestamp: "2026-06-08T11:02:30.000Z" },
      backupSchedulerOwnership: { status: "applied", timestamp: "2026-06-08T11:02:40.000Z" },
      observabilityApplyProof: { status: "applied", timestamp: "2026-06-08T11:02:30.000Z" },
      observabilityTargetStackProof: { status: "passed", timestamp: "2026-06-08T11:02:45.000Z" },
      alertDelivery: { status: "delivered", timestamp: "2026-06-08T11:03:00.000Z" },
      dashboard: { status: "available", timestamp: "2026-06-08T11:04:00.000Z" },
      logPipeline: { status: "passed", timestamp: "2026-06-08T11:05:00.000Z" }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...observabilityRequiredChecks.map(passingCheck)
    ]
  };
}

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

export function passedOperatorAccessEvidence() {
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

export function passedNonSessionCredentialEvidence() {
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

export function passedIngressEvidence() {
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
      ...requiredIngressEvidenceCheckNames.map(passingCheck)
    ]
  };
}

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

export function passedUpgradeRollbackEvidence() {
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

export function passedTargetRuntimeEvidence() {
  const digest = `sha256:${"f".repeat(64)}`;

  return {
    name: "siteflow-target-runtime-evidence-check",
    status: "passed",
    checkedAt: "2026-06-08T11:30:00.000Z",
    exitCode: 0,
    selectedEvidence: {
      targetEnvironment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      composeConfig: { status: "passed", timestamp: "2026-06-08T11:20:00.000Z" },
      startup: { status: "passed", timestamp: "2026-06-08T11:21:00.000Z" },
      serviceHealth: { status: "passed", timestamp: "2026-06-08T11:22:00.000Z" },
      readiness: { status: "passed", timestamp: "2026-06-08T11:23:00.000Z" },
      imageBinding: { status: "passed", timestamp: "2026-06-08T11:24:00.000Z" },
      restartSmoke: { status: "passed", timestamp: "2026-06-08T11:25:00.000Z" },
      logSanity: { status: "passed", timestamp: "2026-06-08T11:26:00.000Z" }
    },
    checks: requiredTargetRuntimeEvidenceCheckNames.map(passingCheck),
    targetRuntimeSummary: {
      expectedDigest: digest,
      apiImageDigest: digest,
      workerImageDigest: digest
    }
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

export function passedReleaseEvidenceBundle(pack: ReleaseEvidencePack) {
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
    targetRuntimeEvidence: evidenceAttachment(pack.evidenceFiles.targetRuntime, passedTargetRuntimeEvidence()),
    sourceProviderEvidence: evidenceAttachment(pack.evidenceFiles.sourceProvider, passedSourceProviderEvidence()),
    backupEvidence: evidenceAttachment(pack.evidenceFiles.backup, passedBackupEvidence()),
    observabilityEvidence: evidenceAttachment(pack.evidenceFiles.observability, passedObservabilityEvidence()),
    operatorAccessEvidence: evidenceAttachment(pack.evidenceFiles.operatorAccess, passedOperatorAccessEvidence()),
    nonSessionCredentialEvidence: evidenceAttachment(pack.evidenceFiles.nonSessionCredential, passedNonSessionCredentialEvidence()),
    ingressEvidence: evidenceAttachment(pack.evidenceFiles.ingress, passedIngressEvidence()),
    upgradeRollbackEvidence: evidenceAttachment(pack.evidenceFiles.upgradeRollback, passedUpgradeRollbackEvidence())
  };
}

export function passedReleaseEvidenceCheck(pack: ReleaseEvidencePack) {
  return evaluateReleaseEvidenceBundle(passedReleaseEvidenceBundle(pack), {
    evidencePath: pack.evidenceFiles.releaseEvidence,
    commitRef: pack.release.commitRef,
    repo: pack.release.repository,
    branch: pack.release.branch,
    targetEnvironment: pack.release.targetEnvironment,
    now
  });
}

export function passingEvidenceForCommandArgs(args: string[], pack: ReleaseEvidencePack) {
  if (args.includes("release-gate")) return passedReleaseGateEvidence();
  if (args.includes("rehearsal:docker-build")) return passedDockerBuildRehearsal();
  if (args.includes("rehearsal:postgres")) return passedPostgresRehearsal();
  if (args.includes("release:artifacts:evidence")) return passedReleaseArtifactEvidence();
  if (args.includes("release:target-runtime:evidence")) return passedTargetRuntimeEvidence();
  if (args.includes("source-provider:evidence")) return passedSourceProviderEvidence();
  if (args.includes("operator-access:evidence")) return passedOperatorAccessEvidence();
  if (args.includes("non-session-credential:evidence")) return passedNonSessionCredentialEvidence();
  if (args.includes("upgrade-rollback:evidence")) return passedUpgradeRollbackEvidence();
  if (args.includes("release:evidence:compose")) return passedReleaseEvidenceBundle(pack);
  if (args.includes("release:evidence")) return passedReleaseEvidenceCheck(pack);

  return undefined;
}

export async function writePassingReleaseEvidenceOutputs(pack: ReleaseEvidencePack) {
  await writeJson(pack.evidenceFiles.releaseGate, passedReleaseGateEvidence());
  await writeJson(pack.evidenceFiles.dockerBuild, passedDockerBuildRehearsal());
  await writeJson(pack.evidenceFiles.postgres, passedPostgresRehearsal());
  await writeJson(pack.evidenceFiles.releaseArtifact, passedReleaseArtifactEvidence());
  await writeJson(pack.evidenceFiles.releaseImage, passedReleaseImageEvidence());
  await writeJson(pack.evidenceFiles.targetRuntime, passedTargetRuntimeEvidence());
  await writeJson(pack.evidenceFiles.sourceProvider, passedSourceProviderEvidence());
  await writeJson(pack.evidenceFiles.backup, passedBackupEvidence());
  await writeJson(pack.evidenceFiles.observability, passedObservabilityEvidence());
  await writeJson(pack.evidenceFiles.operatorAccess, passedOperatorAccessEvidence());
  await writeJson(pack.evidenceFiles.nonSessionCredential, passedNonSessionCredentialEvidence());
  await writeJson(pack.evidenceFiles.ingress, passedIngressEvidence());
  await writeJson(pack.evidenceFiles.upgradeRollback, passedUpgradeRollbackEvidence());
  await writeJson(pack.evidenceFiles.releaseEvidence, passedReleaseEvidenceBundle(pack));
  await writeJson(pack.evidenceFiles.releaseEvidenceCheck, passedReleaseEvidenceCheck(pack));
}
