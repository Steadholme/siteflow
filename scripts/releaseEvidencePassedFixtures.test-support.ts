import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requiredOffHostBackupEvidenceCheckNames } from "./backupEvidenceCheck.js";
import {
  bundleWithReleaseEvidenceAttestation,
  evaluateReleaseEvidenceBundle,
  releaseEvidenceBundleAttestationKeyId
} from "./releaseEvidenceBundleCheck.js";
import type { createReleaseEvidenceRehearsalPack } from "./releaseEvidenceRehearsalPack.js";
import { requiredIngressEvidenceCheckNames } from "./ingressEvidenceCheck.js";
import { requiredNonSessionCredentialEvidenceCheckNames } from "./nonSessionCredentialEvidenceCheck.js";
import { requiredOperatorAccessEvidenceCheckNames } from "./operatorAccessEvidenceCheck.js";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts.js";
import { requiredSourceProviderEvidenceCheckNames } from "./sourceProviderEvidenceCheck.js";
import { requiredTargetRuntimeEvidenceCheckNames } from "./releaseTargetRuntimeEvidenceCheck.js";
import { requiredUpgradeRollbackDrillEvidenceCheckNames } from "./upgradeRollbackDrillEvidenceCheck.js";
import { requiredObservabilityEvidenceCheckNames } from "./observabilityEvidenceCheck.js";

const pinnedBuildImage = "registry.local/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const backupKmsKeyRef = "arn:aws:kms:us-east-1:111122223333:key/siteflow-prod-backups";
const now = () => new Date("2026-06-08T12:00:00.000Z");
export const passedReleaseEvidenceAttestationSigningKey = "release-evidence-test-signing-key-with-enough-entropy";
export const passedReleaseEvidenceAttestationKeyId = releaseEvidenceBundleAttestationKeyId(passedReleaseEvidenceAttestationSigningKey);

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
    checks: [
      passingCheck("local.gitStatus"),
      passingCheck("local.requiredEnv"),
      passingCheck("external.githubBranchProtection"),
      passingCheck("external.githubProtectedBranchCommit"),
      passingCheck("external.githubCommitStatus")
    ],
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
        buildNetwork: "none",
        workerUserStatus: "pass",
        workerUser: "1000:1000",
        dockerSocketGidStatus: "pass",
        dockerSocketGid: 998
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
      deployKeyMode: "not_required",
      checkout: {
        status: "passed",
        timestamp: "2026-06-08T11:25:00.000Z",
        commitRef: "abc123def4567890",
        headSha: "abc123def4567890",
        exactCommitVerified: true
      },
      signedWebhook: {
        status: "passed",
        timestamp: "2026-06-08T11:26:00.000Z",
        deliveryId: "delivery-123",
        event: "push",
        signatureVerified: true
      },
      deployKey: {
        status: "not_required",
        timestamp: "2026-06-08T11:27:00.000Z"
      },
      hostKey: {
        status: "not_required",
        timestamp: "2026-06-08T11:28:00.000Z"
      },
      releaseProvenance: {
        status: "passed",
        timestamp: "2026-06-08T11:29:00.000Z",
        commitRef: "abc123def4567890",
        repository: "acme/siteflow",
        branch: "main"
      }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...requiredSourceProviderEvidenceCheckNames.map(passingCheck)
    ]
  };
}

export function passedSourceProviderRawEvidence() {
  return {
    schemaVersion: "siteflow.sourceProviderEvidence.v1",
    name: "siteflow-source-provider-evidence",
    status: "passed",
    dryRun: false,
    checkedAt: "2026-06-08T11:30:00.000Z",
    targetEnvironment: "production",
    provider: "github",
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main"
    },
    repository: {
      provider: "github",
      fullName: "acme/siteflow",
      remoteUrl: "git@github.com:acme/siteflow.git",
      visibility: "private",
      urlEmbeddedCredentials: false
    },
    checkout: {
      status: "passed",
      commitRef: "abc123def4567890",
      headSha: "abc123def4567890",
      exactCommitVerified: true,
      remoteUrl: "git@github.com:acme/siteflow.git"
    },
    webhook: {
      status: "passed",
      deliveryId: "delivery-123",
      event: "push",
      signatureVerified: true,
      secretConfigured: true,
      rawSecretArchived: false,
      signatureHeaderArchived: false
    },
    deployKey: {
      status: "passed",
      required: true,
      mounted: true,
      mode: "read_only",
      path: "/run/secrets/siteflow_git_ssh_key",
      privateKeyArchived: false
    },
    hostKey: {
      status: "passed",
      pinned: true,
      knownHostsConfigured: true,
      acceptedBlindly: false
    },
    releaseProvenance: {
      status: "passed",
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main"
    },
    operatorName: "Platform Operator",
    ticketId: "REL-2026-0608",
    rawCredentialArchived: false
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
  const imageDigest = `sha256:${"f".repeat(64)}`;

  return {
    schemaVersion: "siteflow.releaseImageEvidence.v1",
    name: "siteflow-release-image-evidence",
    image: {
      name: "ghcr.io/siteflow/siteflow",
      versionTag: "ghcr.io/siteflow/siteflow:0.1.0",
      commitTag: "ghcr.io/siteflow/siteflow:sha-abc123def4567890",
      digest: imageDigest
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
      subjectDigest: imageDigest,
      inspector: "docker buildx imagetools inspect --raw",
      inspectedAt: "2026-06-08T11:30:35.000Z",
      provenance: {
        requested: true,
        present: true,
        predicateType: "https://slsa.dev/provenance/v1",
        manifestDigest: `sha256:${"e".repeat(64)}`,
        statementDigest: `sha256:${"c".repeat(64)}`,
        subjectDigest: imageDigest,
        builder: {
          id: "https://github.com/actions/runner/github-hosted"
        },
        materials: [
          {
            uri: "git+https://github.com/acme/siteflow",
            digest: {
              sha1: "abc123def4567890"
            }
          }
        ],
        source: {
          repository: "acme/siteflow",
          commitRef: "abc123def4567890",
          refName: "v0.1.0"
        }
      },
      sbom: {
        requested: true,
        present: true,
        predicateType: "https://spdx.dev/Document",
        manifestDigest: `sha256:${"d".repeat(64)}`,
        statementDigest: `sha256:${"b".repeat(64)}`,
        subjectDigest: imageDigest
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
    release: {
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production"
    },
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
        timestamp: "2026-06-08T10:40:00.000Z",
        restoreDrill: true,
        backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260608"
      },
      backupOffload: {
        status: "offloaded",
        timestamp: "2026-06-08T10:50:00.000Z",
        offHostLocation: "s3://siteflow-prod-backups/siteflow-20260608",
        provider: "s3",
        treeSha256: "b".repeat(64),
        objectCount: 4,
        totalBytes: 512,
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
        timestamp: "2026-06-08T10:52:00.000Z",
        backupPath: "/tmp/siteflow-fetched-backups/siteflow-20260608",
        offHostLocation: "s3://siteflow-prod-backups/siteflow-20260608",
        provider: "s3",
        treeSha256: "b".repeat(64),
        objectCount: 4,
        totalBytes: 512
      },
      backupProviderSecurityAudit: backupProviderSecurityAuditEvidence(),
      backupPrune: {
        status: "completed",
        timestamp: "2026-06-08T10:55:00.000Z",
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

const observabilityRequiredChecks = [...requiredObservabilityEvidenceCheckNames];

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

const operatorAccessRequiredChecks = [...requiredOperatorAccessEvidenceCheckNames];

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
      sessionCreate: { status: "passed", timestamp: "2026-06-08T11:01:00.000Z" },
      projectScope: { status: "passed", timestamp: "2026-06-08T11:02:00.000Z" },
      sessionRotation: { status: "passed", timestamp: "2026-06-08T11:03:00.000Z" },
      sessionRevoke: { status: "revoked", timestamp: "2026-06-08T11:04:00.000Z" },
      csrf: { status: "enforced", timestamp: "2026-06-08T11:05:00.000Z" },
      bearerPrecedence: { status: "passed", timestamp: "2026-06-08T11:06:00.000Z" },
      actorAttribution: { status: "passed", timestamp: "2026-06-08T11:07:00.000Z" },
      emergencyCutoff: { status: "passed", timestamp: "2026-06-08T11:08:00.000Z" },
      browserTokenFallback: {
        status: "passed",
        timestamp: "2026-06-08T11:09:00.000Z",
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

const nonSessionCredentialRequiredChecks = [...requiredNonSessionCredentialEvidenceCheckNames];

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
      breakGlass: { status: "passed", timestamp: "2026-06-08T11:10:00.000Z" }
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
      directApiPort: { status: "blocked", timestamp: "2026-06-08T11:11:00.000Z" },
      forwardedHeaders: { status: "passed", timestamp: "2026-06-08T11:12:00.000Z" },
      apiRateLimit: {
        status: "limited",
        timestamp: "2026-06-08T11:13:00.000Z",
        edgeEnforced: true
      },
      unthrottledRoutes: { status: "passed", timestamp: "2026-06-08T11:14:00.000Z" }
    },
    checks: [
      passingCheck("evidence_shape"),
      ...requiredIngressEvidenceCheckNames.map(passingCheck)
    ]
  };
}

const upgradeRollbackRequiredChecks = [...requiredUpgradeRollbackDrillEvidenceCheckNames];

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
      rollbackOperationId: "op_rollback_1",
      backupEvidence: { status: "passed", timestamp: "2026-06-08T11:20:00.000Z" },
      routeUpgrade: { status: "passed", timestamp: "2026-06-08T11:21:00.000Z" },
      routeRollback: { status: "passed", timestamp: "2026-06-08T11:22:00.000Z" },
      readiness: { status: "passed", timestamp: "2026-06-08T11:23:00.000Z" },
      observability: { status: "passed", timestamp: "2026-06-08T11:24:00.000Z" }
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
      targetIdentity: { status: "passed", timestamp: "2026-06-08T11:19:00.000Z" },
      composeConfig: { status: "passed", timestamp: "2026-06-08T11:20:00.000Z" },
      workerRuntimePosture: {
        status: "passed",
        timestamp: "2026-06-08T11:20:00.000Z",
        dockerSocketMounted: true,
        groupAddConfigured: true,
        hostDockerSocketGid: 998,
        groupAddMatchesHostDockerSocketGid: true,
        privileged: false,
        capAddEmpty: true,
        dangerousSecurityOptConfigured: false,
        hostNetworkMode: false,
        buildRunnerDocker: true,
        buildNetworkNone: true,
        buildMemoryConfigured: true,
        buildCpusConfigured: true,
        buildPidsLimitConfigured: true,
        dockerCliPreflightPresent: true,
        dockerInfoPreflightPresent: true,
        gitSshKeyPathEnvPresent: true,
        gitKnownHostsPathEnvPresent: true
      },
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
  const bundle = {
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

  return bundleWithReleaseEvidenceAttestation(bundle, "2026-06-08T11:45:00.000Z", {
    attestationSigningKey: passedReleaseEvidenceAttestationSigningKey,
    attestationSigningKeyId: passedReleaseEvidenceAttestationKeyId
  });
}

export function passedReleaseEvidenceCheck(pack: ReleaseEvidencePack) {
  return evaluateReleaseEvidenceBundle(passedReleaseEvidenceBundle(pack), {
    evidencePath: pack.evidenceFiles.releaseEvidence,
    commitRef: pack.release.commitRef,
    repo: pack.release.repository,
    branch: pack.release.branch,
    targetEnvironment: pack.release.targetEnvironment,
    attestationSigningKey: passedReleaseEvidenceAttestationSigningKey,
    requiredAttestationKeyId: passedReleaseEvidenceAttestationKeyId,
    now
  });
}

export function passingEvidenceForCommandArgs(args: string[], pack: ReleaseEvidencePack) {
  if (args.includes("release-gate")) return passedReleaseGateEvidence();
  if (args.includes("rehearsal:docker-build")) return passedDockerBuildRehearsal();
  if (args.includes("rehearsal:postgres")) return passedPostgresRehearsal();
  if (args.includes("release:artifacts:evidence")) return passedReleaseArtifactEvidence();
  if (args.includes("release:target-runtime:evidence")) return passedTargetRuntimeEvidence();
  if (args.includes("source-provider:evidence") || args.includes("source-provider:evidence:collect")) return passedSourceProviderEvidence();
  if (args.includes("operator-access:evidence:collect") || args.includes("operator-access:evidence")) return passedOperatorAccessEvidence();
  if (args.includes("non-session-credential:evidence:collect") || args.includes("non-session-credential:evidence")) return passedNonSessionCredentialEvidence();
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
  await writeJson(pack.evidenceFiles.sourceProviderRaw, passedSourceProviderRawEvidence());
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
