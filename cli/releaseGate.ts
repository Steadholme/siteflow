import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  findForbiddenTrackedReleasePaths,
  releaseSourceTreePolicyDetails,
  suggestedIndexOnlyReleaseSourceCleanupCommand
} from "./releaseSourceTreePolicy.js";
import { assertProductionSecretStrength } from "../src/lib/sealedSecrets.js";

export type ReleaseGateCheckStatus = "pass" | "fail" | "manual_required" | "skipped";
export type ReleaseGateStatus = "pass" | "fail" | "manual_required";

export interface ReleaseGateCheck {
  id: string;
  label: string;
  status: ReleaseGateCheckStatus;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface ReleaseGateReport {
  status: ReleaseGateStatus;
  root: string;
  checkedAt: string;
  promotionEvidence: ReleaseGatePromotionEvidence;
  checks: ReleaseGateCheck[];
}

export interface ReleaseGatePromotionEvidence {
  gateStatus: ReleaseGateStatus;
  checkedAt: string;
  promotion: boolean;
  commitRef?: string;
  repository?: string;
  branch: string;
  requiredStatusCheck: string;
  branchProtection: {
    status: ReleaseGateCheckStatus;
    repository?: string;
    branch: string;
    requiredStatusCheck: string;
    requiredStatusChecks?: string[];
    pullRequestReviewsRequired?: boolean | null;
    forcePushesBlocked?: boolean | null;
    linearHistoryRequired?: boolean | null;
    signedCommitsRequired?: boolean | null;
    hardeningSources?: string[];
    hardeningUnknowns?: string[];
    hardeningFailures?: string[];
  };
  protectedBranchCommit: {
    status: ReleaseGateCheckStatus;
    repository?: string;
    branch: string;
    commitRef?: string;
    branchHeadSha?: string;
  };
  commitStatus: {
    status: ReleaseGateCheckStatus;
    repository?: string;
    commitRef?: string;
    requiredStatusCheck: string;
    checkRun?: GitHubCheckRunSummary;
    checkRuns?: GitHubCheckRunSummary[];
  };
  manualRequired: boolean;
  manualRequiredCheckIds: string[];
  runtimeEnv: {
    status: ReleaseGateCheckStatus;
    summary: string;
    metricsTokenConfigured: boolean | null;
    unauthenticatedMetricsAllowed: boolean | null;
    apiTokenStrengthStatus: ReleaseGateCheckStatus | null;
    metricsTokenStrengthStatus: ReleaseGateCheckStatus | null;
    releaseEvidenceSigningKeyStrengthStatus: ReleaseGateCheckStatus | null;
    releaseEvidenceSigningKeySource: string | null;
    appSecretStrengthStatus: ReleaseGateCheckStatus | null;
    appSecretSource: string | null;
    gitWebhookSecretStrengthStatus: ReleaseGateCheckStatus | null;
    gitWebhookSecretSources: string[];
    postgresPasswordStatus: ReleaseGateCheckStatus | null;
    postgresPasswordSource: string | null;
    browserTokenFallbackEnabled: boolean | null;
    browserTokenFallbackStatus: ReleaseGateCheckStatus | null;
    browserTokenFallbackEnvValue: string | null;
    sourceBuildPostureStatus: ReleaseGateCheckStatus | null;
    buildRunner: string | null;
    hostBuildException: boolean | null;
    hostBuildExceptionReason: string | null;
    buildImage: string | null;
    buildImageDigestPinned: boolean | null;
    buildImageAllowlistConfigured: boolean | null;
    buildImageAllowedByAllowlist: boolean | null;
    buildImageTaggedTrustedExceptionAccepted: boolean | null;
    buildImagePolicyStatus: ReleaseGateCheckStatus | null;
    buildImagePolicy: string | null;
    buildMaxArtifactBytesStatus: ReleaseGateCheckStatus | null;
    buildMaxArtifactBytes: number | null;
    buildMaxArtifactFilesStatus: ReleaseGateCheckStatus | null;
    buildMaxArtifactFiles: number | null;
    prebuiltMaxUploadBytesStatus: ReleaseGateCheckStatus | null;
    prebuiltMaxUploadBytes: number | null;
    prebuiltMaxFilesStatus: ReleaseGateCheckStatus | null;
    prebuiltMaxFiles: number | null;
    buildMinFreeBytesStatus: ReleaseGateCheckStatus | null;
    buildMinFreeBytes: number | null;
    buildStepTimeoutStatus: ReleaseGateCheckStatus | null;
    buildStepTimeoutMs: number | null;
    gitTimeoutStatus: ReleaseGateCheckStatus | null;
    gitTimeoutMs: number | null;
    buildMemoryStatus: ReleaseGateCheckStatus | null;
    buildMemory: string | null;
    buildCpusStatus: ReleaseGateCheckStatus | null;
    buildCpus: number | null;
    buildPidsLimitStatus: ReleaseGateCheckStatus | null;
    buildPidsLimit: number | null;
    buildNetworkStatus: ReleaseGateCheckStatus | null;
    buildNetwork: string | null;
    workerUserStatus: ReleaseGateCheckStatus | null;
    workerUser: string | null;
    dockerSocketGidStatus: ReleaseGateCheckStatus | null;
    dockerSocketGid: number | null;
    runtimeControlViolations?: unknown;
    secretStrengthViolations?: unknown;
    missing?: unknown;
  };
  dirtyWorktree: {
    status: ReleaseGateCheckStatus;
    dirty: boolean | null;
    entries: string[];
    entryCount: number | null;
    truncated: boolean;
    summary: string;
  };
}

export interface ReleaseGateCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReleaseGateCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<ReleaseGateCommandResult>;

export type ReleaseGateFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ReleaseGateRuntimeDependencies {
  runner?: ReleaseGateCommandRunner;
  fetch?: ReleaseGateFetch;
  now?: () => Date;
}

export interface ReleaseGateOptions extends ReleaseGateRuntimeDependencies {
  root?: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  requireRuntimeEnv?: boolean;
  allowDirty?: boolean;
  allowManualBranchProtection?: boolean;
  promotion?: boolean;
  requireCommitStatus?: boolean;
  requiredStatusCheck?: string;
  commitSha?: string;
  repo?: string;
  branch?: string;
}

interface RequiredEnvGroup {
  id: string;
  label: string;
  keys: string[];
  predicate?: (values: Record<string, string | undefined>) => boolean;
  summary: string;
}

interface RequiredPackageScript {
  name: string;
  terms: string[];
}

const ciWorkflowPath = path.join(".github", "workflows", "ci.yml");
const releasePreflightWorkflowPath = path.join(".github", "workflows", "release-preflight.yml");
const releaseImageWorkflowPath = path.join(".github", "workflows", "release-image.yml");
const packageJsonPath = "package.json";
const productionDocsPath = path.join("docs", "production-readiness.md");
const productionComposePath = "docker-compose.production.yml";
const productionDeploymentDocPath = path.join("docs", "deployment", "production-single-host.md");
const requiredCiCommands = [
  "npm ci",
  "release:dependency:policy",
  "release:source:check",
  "release:commit:plan -- --fail-on-blocked",
  "release:evidence:pack-contract",
  "npm test",
  "npm run build",
  "release:artifacts:check",
  "npm run test:e2e",
  "release-gate --allow-dirty --allow-manual-branch-protection"
];
const requiredReleasePreflightEvidenceSetEnvTerms = [
  "--set-env direct-api-url",
  "--set-env release-image-digest=SITEFLOW_RELEASE_IMAGE_DIGEST",
  "--set-env release-image-run-id=SITEFLOW_RELEASE_IMAGE_RUN_ID",
  "--set-env webhook-delivery-id",
  "--set-env deploy-key-path",
  "--set-env known-hosts-path",
  "--set-env SITEFLOW_TRUST_PROXY",
  "--set-env api-instance-count",
  "--set-env api-process-count",
  "--set-env ingress-count",
  "--set-env api-rate-limit-scope",
  "--set-env api-rate-limit-enforcement-point",
  "--set-env operator-access-project-id",
  "--set-env operator-access-denied-project-id",
  "--set-env old-metrics-token-redacted-id",
  "--set-env new-metrics-token-redacted-id",
  "--set-env old-root-api-token-redacted-id",
  "--set-env new-root-api-token-redacted-id",
  "--set-env break-glass-source",
  "--set-env break-glass-approver-count"
];
const requiredReleasePreflightTerms = [
  "workflow_dispatch",
  "direct_api_url:",
  "release_image_digest:",
  "release_image_run_id:",
  "trust_proxy_policy:",
  "api_instance_count:",
  "api_process_count:",
  "ingress_count:",
  "api_rate_limit_scope:",
  "api_rate_limit_enforcement_point:",
  "operator_access_project_id:",
  "operator_access_denied_project_id:",
  "old_metrics_token_redacted_id:",
  "new_metrics_token_redacted_id:",
  "old_root_api_token_redacted_id:",
  "new_root_api_token_redacted_id:",
  "break_glass_source:",
  "break_glass_approver_count:",
  "release-gate",
  "--promotion",
  "--env-file",
  "--commit-ref",
  "--require-commit-status",
  "release:artifacts:check",
  "candidate_deployment_id",
  "siteflow_api_url",
  "siteflow -- inspect",
  "SITEFLOW_API_TOKEN",
  "--deployment-detail",
  "--write-deployment-artifact-manifest",
  "deployment-artifact-manifest.json",
  "release:evidence:rehearsal-pack",
  "release:evidence:target-run",
  "--confirm-target-environment",
  "--run-record",
  "--gap-report-dir",
  "release:evidence:gaps",
  "release_image_digest",
  "release_image_run_id",
  "SITEFLOW_RELEASE_IMAGE_DIGEST: ${{ inputs.release_image_digest }}",
  "SITEFLOW_RELEASE_IMAGE_RUN_ID: ${{ inputs.release_image_run_id }}",
  "source_provider_webhook_delivery_id:",
  "source_provider_deploy_key_path:",
  "source_provider_known_hosts_path:",
  "SITEFLOW_RELEASE_GITHUB_TOKEN",
  "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN",
  "SITEFLOW_OLD_METRICS_TOKEN",
  "SITEFLOW_METRICS_TOKEN",
  "SITEFLOW_OLD_API_TOKEN",
  "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID",
  "GH_TOKEN",
  ...requiredReleasePreflightEvidenceSetEnvTerms,
  "SITEFLOW_TARGET_ENV_FILE",
  "actions: read",
  "actions/upload-artifact",
  "rm -f \"$SITEFLOW_TARGET_ENV_FILE\"",
  "repo input must match",
  "build_image must be pinned",
  "release:dependency:policy",
  "release:source:check",
  "release:commit:plan -- --fail-on-blocked",
  "release:evidence:pack-contract",
  "npm run build"
];
const requiredReleaseImageTerms = [
  "workflow_dispatch",
  "packages: write",
  "release:dependency:policy",
  "release:source:check",
  "release:commit:plan -- --fail-on-blocked",
  "release:evidence:pack-contract",
  "npm test -- --run",
  "npm run build",
  "release:artifacts:check",
  "docker/build-push-action",
  "provenance: true",
  "sbom: true",
  "docker buildx imagetools inspect --raw",
  "release-image-evidence.json",
  "actions/upload-artifact",
  "release-image-evidence",
  "Gate image attestation evidence",
  "attestations.provenance?.failedChecks",
  "attestations.sbom?.failedChecks",
  "attestations.provenance?.present !== true",
  "attestations.sbom?.present !== true"
];
const requiredPackageScripts: RequiredPackageScript[] = [
  {
    name: "build",
    terms: [
      "npm run clean:build-artifacts",
      "tsc --noEmit -p tsconfig.json",
      "tsc --noEmit -p tsconfig.node.json",
      "npm run build:scripts",
      "npm run build:cli",
      "npm run build:server",
      "npm run build:worker",
      "vite build"
    ]
  },
  {
    name: "build:scripts",
    terms: ["tsc --noEmit -p tsconfig.scripts.json"]
  },
  {
    name: "build:cli",
    terms: ["tsc -p tsconfig.cli.json"]
  },
  {
    name: "build:server",
    terms: ["tsc -p tsconfig.server.json"]
  },
  {
    name: "build:worker",
    terms: ["tsc -p tsconfig.worker.json"]
  },
  {
    name: "siteflow",
    terms: ["node dist-cli/cli/index.js"]
  },
  {
    name: "release:dependency:policy",
    terms: ["node scripts/releaseDependencyPolicyCheck.mjs"]
  },
  {
    name: "release:source:check",
    terms: ["node scripts/runCompiledScript.mjs releaseSourceTreeCheck.js"]
  },
  {
    name: "release:commit:plan",
    terms: ["node scripts/runCompiledScript.mjs releaseCommitReadinessPlan.js"]
  },
  {
    name: "release:evidence:pack-contract",
    terms: ["node scripts/runCompiledScript.mjs releaseEvidencePackContractCheck.js"]
  },
  {
    name: "release:evidence:rehearsal-pack",
    terms: ["node scripts/runCompiledScript.mjs releaseEvidenceRehearsalPack.js"]
  },
  {
    name: "release:evidence:target-run",
    terms: ["node scripts/runCompiledScript.mjs releaseEvidenceTargetRun.js"]
  },
  {
    name: "release:evidence:gaps",
    terms: ["node scripts/runCompiledScript.mjs releaseEvidenceGapReport.js"]
  },
  {
    name: "release:artifacts:check",
    terms: ["node scripts/runCompiledScript.mjs releaseArtifactCheck.js"]
  },
  {
    name: "test",
    terms: ["vitest"]
  },
  {
    name: "test:e2e",
    terms: ["playwright test"]
  }
];
const requiredReleasePreflightCommandTerms = [
  {
    command: "release:evidence:target-run",
    terms: [
      "--pack",
      "--confirm-target-environment",
      "--run-record",
      "--gap-report-dir",
      "SITEFLOW_OBSERVABILITY_STACK_TOKEN: ${{ secrets.SITEFLOW_OBSERVABILITY_STACK_TOKEN }}",
      ...requiredReleasePreflightEvidenceSetEnvTerms
    ]
  },
  {
    command: "release:evidence:gaps",
    terms: [
      "--pack",
      "SITEFLOW_OBSERVABILITY_STACK_TOKEN: ${{ secrets.SITEFLOW_OBSERVABILITY_STACK_TOKEN }}",
      ...requiredReleasePreflightEvidenceSetEnvTerms
    ]
  }
];
const forbiddenReleasePreflightCommandTerms = [
  {
    command: "release:evidence:target-run",
    terms: ["--plan-only"]
  }
];
const forbiddenReleasePreflightTerms = ["--allow-dirty", "--allow-manual-branch-protection"];
const forbiddenReleasePreflightArtifactUploadPathTerms = [
  "siteflow-release-private",
  "siteflow-release-secrets",
  "deployment-detail.json",
  "target.env",
  "SITEFLOW_PRIVATE_DIR",
  "SITEFLOW_SECRET_DIR",
  "SITEFLOW_TARGET_ENV_FILE"
];
const requiredProductionDeploymentDocTerms = [
  "docker-compose.production.yml",
  "/var/run/docker.sock",
  "SITEFLOW_IMAGE",
  "SITEFLOW_POSTGRES_IMAGE",
  "SITEFLOW_BUILD_IMAGE",
  "SITEFLOW_BUILD_MIN_FREE_BYTES",
  "SITEFLOW_BUILD_STEP_TIMEOUT_MS",
  "SITEFLOW_GIT_TIMEOUT_MS",
  "SITEFLOW_BUILD_MEMORY",
  "SITEFLOW_BUILD_CPUS",
  "SITEFLOW_BUILD_PIDS_LIMIT",
  "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
  "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
  "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
  "SITEFLOW_PREBUILT_MAX_FILES",
  "SITEFLOW_TRUST_PROXY",
  "SITEFLOW_WORKER_USER",
  "SITEFLOW_DOCKER_SOCKET_GID",
  "SITEFLOW_GIT_SSH_KEY_PATH",
  "SITEFLOW_GIT_KNOWN_HOSTS_PATH",
  "SITEFLOW_APP_SECRET_FILE",
  "SITEFLOW_API_TOKEN_FILE",
  "SITEFLOW_METRICS_TOKEN_FILE",
  "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE",
  "SITEFLOW_POSTGRES_PASSWORD_FILE",
  "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE",
  "docker compose -f docker-compose.production.yml config"
];
const maxDirtyWorktreeEntries = 200;
const defaultRequiredStatusCheck = "Install, test, and build";
const fullGitShaPattern = /^[a-f0-9]{40}$/i;
const requiredDocumentedEnvNames = [
  "DATABASE_URL",
  "SITEFLOW_API_PORT",
  "SITEFLOW_ARTIFACT_ROOT",
  "SITEFLOW_PUBLIC_SCHEME",
  "SITEFLOW_API_TOKEN",
  "SITEFLOW_APP_SECRET",
  "SITEFLOW_SEALING_KEY",
  "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY",
  "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID",
  "SITEFLOW_METRICS_TOKEN",
  "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS",
  "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK",
  "SITEFLOW_BUILD_RUNNER",
  "SITEFLOW_BUILD_IMAGE",
  "SITEFLOW_BUILD_IMAGE_ALLOWLIST",
  "SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE",
  "SITEFLOW_TRUSTED_SOURCE_BUILDS",
  "SITEFLOW_ALLOW_UNSANDBOXED_BUILDS",
  "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
  "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
  "SITEFLOW_BUILD_MIN_FREE_BYTES",
  "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
  "SITEFLOW_PREBUILT_MAX_FILES",
  "SITEFLOW_BUILD_STEP_TIMEOUT_MS",
  "SITEFLOW_GIT_TIMEOUT_MS",
  "SITEFLOW_BUILD_MEMORY",
  "SITEFLOW_BUILD_CPUS",
  "SITEFLOW_BUILD_PIDS_LIMIT",
  "SITEFLOW_TRUST_PROXY",
  "SITEFLOW_WORKER_USER",
  "SITEFLOW_DOCKER_SOCKET_GID",
  "SITEFLOW_GIT_SSH_KEY_PATH",
  "SITEFLOW_GIT_KNOWN_HOSTS_PATH",
  "SITEFLOW_BUILD_NETWORK"
];

const gitWebhookSecretKeys = [
  "SITEFLOW_GITHUB_WEBHOOK_SECRET",
  "SITEFLOW_GITLAB_WEBHOOK_SECRET",
  "SITEFLOW_GITEA_WEBHOOK_SECRET",
  "SITEFLOW_GENERIC_WEBHOOK_SECRET"
];

const requiredEnvGroups: RequiredEnvGroup[] = [
  {
    id: "runtime.productionMode",
    label: "Production mode",
    keys: ["SITEFLOW_ENV", "NODE_ENV"],
    predicate: (values) => values.SITEFLOW_ENV === "production" || values.NODE_ENV === "production",
    summary: "SITEFLOW_ENV=production or NODE_ENV=production is required."
  },
  {
    id: "runtime.databaseUrl",
    label: "Database URL",
    keys: ["DATABASE_URL"],
    summary: "DATABASE_URL is required."
  },
  {
    id: "runtime.databasePassword",
    label: "Database password",
    keys: ["DATABASE_URL", "SITEFLOW_POSTGRES_PASSWORD", "SITEFLOW_POSTGRES_PASSWORD_FILE"],
    predicate: (values) => productionDatabasePasswordStatus(values).status === "pass",
    summary: "DATABASE_URL must include a database password, or SITEFLOW_POSTGRES_PASSWORD/SITEFLOW_POSTGRES_PASSWORD_FILE must provide one for passwordless DATABASE_URL values."
  },
  {
    id: "runtime.apiPort",
    label: "API port",
    keys: ["SITEFLOW_API_PORT"],
    summary: "SITEFLOW_API_PORT is required."
  },
  {
    id: "runtime.artifactRoot",
    label: "Artifact root",
    keys: ["SITEFLOW_ARTIFACT_ROOT"],
    summary: "SITEFLOW_ARTIFACT_ROOT is required."
  },
  {
    id: "runtime.publicScheme",
    label: "Public scheme",
    keys: ["SITEFLOW_PUBLIC_SCHEME"],
    summary: "SITEFLOW_PUBLIC_SCHEME is required."
  },
  {
    id: "runtime.apiToken",
    label: "API token",
    keys: ["SITEFLOW_API_TOKEN", "SITEFLOW_API_TOKEN_FILE"],
    predicate: (values) => productionSecretStrengthStatus(values, "SITEFLOW_API_TOKEN").status === "pass",
    summary: "SITEFLOW_API_TOKEN or SITEFLOW_API_TOKEN_FILE is required."
  },
  {
    id: "runtime.metricsToken",
    label: "Metrics token",
    keys: ["SITEFLOW_METRICS_TOKEN", "SITEFLOW_METRICS_TOKEN_FILE", "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS"],
    predicate: (values) =>
      productionMetricsTokenStrengthStatus(values).status !== "fail",
    summary: "SITEFLOW_METRICS_TOKEN or SITEFLOW_METRICS_TOKEN_FILE is required so /metrics is not promoted without bearer-token protection evidence, unless SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS=1 is explicitly accepted."
  },
  {
    id: "runtime.releaseEvidenceSigningKey",
    label: "Release evidence signing key",
    keys: ["SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY", "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE"],
    predicate: (values) => productionSecretStrengthStatus(values, "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY").status === "pass",
    summary: "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY or SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE is required so production API gates can verify signed release evidence bundles."
  },
  {
    id: "runtime.browserTokenFallback",
    label: "Browser token fallback",
    keys: ["VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK"],
    predicate: (values) => !enabledFlag(values.VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK),
    summary: "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK must be unset or false for production promotion."
  },
  {
    id: "runtime.sourceBuildPosture",
    label: "Source build runner posture",
    keys: ["SITEFLOW_BUILD_RUNNER", "SITEFLOW_TRUSTED_SOURCE_BUILDS", "SITEFLOW_ALLOW_UNSANDBOXED_BUILDS"],
    predicate: (values) => resolveSourceBuildPosture(values).status === "pass",
    summary: "SITEFLOW_BUILD_RUNNER=docker is required for production source builds, unless SITEFLOW_BUILD_RUNNER=host is paired with SITEFLOW_TRUSTED_SOURCE_BUILDS=1 or SITEFLOW_ALLOW_UNSANDBOXED_BUILDS=1."
  },
  {
    id: "runtime.buildImagePolicy",
    label: "Docker build image policy",
    keys: ["SITEFLOW_BUILD_IMAGE", "SITEFLOW_BUILD_IMAGE_ALLOWLIST", "SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE"],
    predicate: (values) => resolveSourceBuildPosture(values).buildImagePolicyStatus !== "fail",
    summary: "SITEFLOW_BUILD_IMAGE must be explicitly configured as a sha256 digest. Tagged images require SITEFLOW_BUILD_IMAGE_ALLOWLIST plus SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1."
  },
  {
    id: "runtime.buildArtifactBudget",
    label: "Build artifact budget",
    keys: ["SITEFLOW_BUILD_MAX_ARTIFACT_BYTES", "SITEFLOW_BUILD_MAX_ARTIFACT_FILES"],
    predicate: (values) => {
      const posture = resolveRuntimeControlPosture(values);

      return posture.buildMaxArtifactBytesStatus === "pass" && posture.buildMaxArtifactFilesStatus === "pass";
    },
    summary: "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES and SITEFLOW_BUILD_MAX_ARTIFACT_FILES must be explicit positive integers."
  },
  {
    id: "runtime.buildStoragePreflight",
    label: "Build storage preflight",
    keys: ["SITEFLOW_BUILD_MIN_FREE_BYTES"],
    predicate: (values) => positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_MIN_FREE_BYTES").status === "pass",
    summary: "SITEFLOW_BUILD_MIN_FREE_BYTES must be an explicit positive integer."
  },
  {
    id: "runtime.prebuiltUploadBudget",
    label: "Prebuilt upload budget",
    keys: ["SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES", "SITEFLOW_PREBUILT_MAX_FILES"],
    predicate: (values) => {
      const posture = resolveRuntimeControlPosture(values);

      return posture.prebuiltMaxUploadBytesStatus === "pass" && posture.prebuiltMaxFilesStatus === "pass";
    },
    summary: "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES and SITEFLOW_PREBUILT_MAX_FILES must be explicit positive integers."
  },
  {
    id: "runtime.buildTimeouts",
    label: "Build and Git timeouts",
    keys: ["SITEFLOW_BUILD_STEP_TIMEOUT_MS", "SITEFLOW_GIT_TIMEOUT_MS"],
    predicate: (values) => {
      const posture = resolveRuntimeControlPosture(values);

      return posture.buildStepTimeoutStatus === "pass" && posture.gitTimeoutStatus === "pass";
    },
    summary: "SITEFLOW_BUILD_STEP_TIMEOUT_MS and SITEFLOW_GIT_TIMEOUT_MS must be explicit positive integers."
  },
  {
    id: "runtime.buildNetwork",
    label: "Docker build network",
    keys: ["SITEFLOW_BUILD_NETWORK"],
    predicate: (values) => resolveRuntimeControlPosture(values).buildNetworkStatus === "pass",
    summary: "SITEFLOW_BUILD_NETWORK=none is required for production source builds."
  },
  {
    id: "runtime.buildResourceLimits",
    label: "Docker build resource limits",
    keys: ["SITEFLOW_BUILD_MEMORY", "SITEFLOW_BUILD_CPUS", "SITEFLOW_BUILD_PIDS_LIMIT"],
    predicate: (values) => {
      const posture = resolveRuntimeControlPosture(values);

      return posture.buildMemoryStatus === "pass" &&
        posture.buildCpusStatus === "pass" &&
        posture.buildPidsLimitStatus === "pass";
    },
    summary: "SITEFLOW_BUILD_MEMORY, SITEFLOW_BUILD_CPUS, and SITEFLOW_BUILD_PIDS_LIMIT must be explicit positive Docker resource limits."
  },
  {
    id: "runtime.workerSocketPosture",
    label: "Worker Docker socket posture",
    keys: ["SITEFLOW_WORKER_USER", "SITEFLOW_DOCKER_SOCKET_GID"],
    predicate: (values) => {
      const posture = resolveRuntimeControlPosture(values);

      return posture.workerUserStatus === "pass" && posture.dockerSocketGidStatus === "pass";
    },
    summary: "SITEFLOW_WORKER_USER must be non-root and SITEFLOW_DOCKER_SOCKET_GID must explicitly match the target host Docker socket group id."
  },
  {
    id: "runtime.appSecret",
    label: "App sealing secret",
    keys: ["SITEFLOW_APP_SECRET", "SITEFLOW_APP_SECRET_FILE", "SITEFLOW_SEALING_KEY", "SITEFLOW_SEALING_KEY_FILE"],
    predicate: (values) => productionAppSecretStrengthStatus(values).status === "pass",
    summary: "SITEFLOW_APP_SECRET or SITEFLOW_APP_SECRET_FILE is required, with SITEFLOW_SEALING_KEY accepted only for legacy installs."
  },
  {
    id: "runtime.gitWebhookSecrets",
    label: "Git webhook secrets",
    keys: gitWebhookSecretKeys.flatMap((key) => [key, `${key}_FILE`]),
    predicate: (values) => productionGitWebhookSecretsStrengthStatus(values).status !== "fail",
    summary: "Configured git webhook secrets or *_FILE fallbacks must meet production strength requirements."
  }
];

export const defaultReleaseGateRunner: ReleaseGateCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options?.cwd, timeout: 10_000 }, (error, stdout, stderr) => {
      const commandError = error as NodeJS.ErrnoException | null;
      const exitCode = typeof commandError?.code === "number" ? Number(commandError.code) : commandError ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });

function aggregateReleaseGateStatus(checks: ReleaseGateCheck[], allowManualBranchProtection: boolean): ReleaseGateStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  const blockingManual = checks.some((check) =>
    check.status === "manual_required"
    && (check.id !== "external.githubBranchProtection" || !allowManualBranchProtection)
  );

  return blockingManual ? "manual_required" : "pass";
}

async function fileExists(filePath: string) {
  return stat(filePath).then(
    (value) => value.isFile(),
    (error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }

      throw error;
    }
  );
}

async function checkCiWorkflow(root: string): Promise<ReleaseGateCheck> {
  const filePath = path.join(root, ciWorkflowPath);

  if (!await fileExists(filePath)) {
    return {
      id: "local.ciWorkflow",
      label: "CI workflow",
      status: "fail",
      summary: `${ciWorkflowPath} is missing.`,
      remediation: "Add the GitHub Actions workflow that runs install, source-tree, test, build, artifact, E2E, and static release-gate checks."
    };
  }

  const content = await readFile(filePath, "utf8");
  const missingCommands = requiredCiCommands.filter((command) => !content.includes(command));

  if (missingCommands.length > 0) {
    return {
      id: "local.ciWorkflow",
      label: "CI workflow",
      status: "fail",
      summary: `${ciWorkflowPath} is missing required command(s): ${missingCommands.join(", ")}.`,
      remediation: "Keep the release gate aligned with the minimum CI source-tree, test, build, artifact, E2E, and static release-gate commands.",
      details: {
        missingCommands
      }
    };
  }

  return {
    id: "local.ciWorkflow",
    label: "CI workflow",
    status: "pass",
    summary: `${ciWorkflowPath} contains install, release source, test, build, artifact, E2E, and static release-gate checks.`
  };
}

async function checkReleasePreflightWorkflow(root: string): Promise<ReleaseGateCheck> {
  const filePath = path.join(root, releasePreflightWorkflowPath);

  if (!await fileExists(filePath)) {
    return {
      id: "local.releasePreflightWorkflow",
      label: "Release preflight workflow",
      status: "fail",
      summary: `${releasePreflightWorkflowPath} is missing.`,
      remediation: "Add a workflow_dispatch release preflight that runs promotion release-gate evidence and archives release evidence artifacts."
    };
  }

  const content = await readFile(filePath, "utf8");
  const missingTerms = [
    ...requiredReleasePreflightTerms.filter((term) => !content.includes(term)),
    ...missingReleasePreflightCommandTerms(content)
  ];
  const forbiddenTerms = forbiddenReleasePreflightTerms.filter((term) => content.includes(term));
  const forbiddenCommandTerms = forbiddenReleasePreflightCommandTermMatches(content);
  const forbiddenArtifactUploadPathMatches = forbiddenReleasePreflightArtifactUploadPathMatches(content);
  const targetEnvCleanupIndex = content.indexOf("rm -f \"$SITEFLOW_TARGET_ENV_FILE\"");
  const targetEnvSecretWriteIndex = content.indexOf("SITEFLOW_RELEASE_ENV_FILE_B64");
  const e2eIndex = content.indexOf("npm run test:e2e");
  const artifactUploadIndex = content.indexOf("actions/upload-artifact");
  const targetEnvCleanupBeforeUpload = targetEnvCleanupIndex >= 0 &&
    artifactUploadIndex >= 0 &&
    targetEnvCleanupIndex < artifactUploadIndex;
  const e2eBeforeTargetEnvSecret = e2eIndex >= 0 &&
    targetEnvSecretWriteIndex >= 0 &&
    e2eIndex < targetEnvSecretWriteIndex;

  if (
    missingTerms.length > 0 ||
    forbiddenTerms.length > 0 ||
    forbiddenCommandTerms.length > 0 ||
    forbiddenArtifactUploadPathMatches.length > 0 ||
    !targetEnvCleanupBeforeUpload ||
    !e2eBeforeTargetEnvSecret
  ) {
    return {
      id: "local.releasePreflightWorkflow",
      label: "Release preflight workflow",
      status: "fail",
      summary: `${releasePreflightWorkflowPath} is not aligned with production promotion evidence requirements.`,
      remediation: "The workflow must run report-generating E2E before decoding target secrets, inspect the candidate deployment, derive sanitized artifact-manifest evidence, run release-gate --promotion with exact commit status evidence, generate the release evidence rehearsal pack and target run, remove target.env before artifact upload, keep artifact upload paths scoped to sanitized preflight, Playwright, and test-result outputs, and avoid static-sanity override flags.",
      details: {
        missingTerms,
        forbiddenTerms,
        forbiddenCommandTerms,
        forbiddenArtifactUploadPaths: forbiddenArtifactUploadPathMatches.map((match) => match.path),
        forbiddenArtifactUploadPathTerms: [
          ...new Set(forbiddenArtifactUploadPathMatches.flatMap((match) => match.terms))
        ],
        targetEnvCleanupBeforeUpload,
        e2eBeforeTargetEnvSecret
      }
    };
  }

  return {
    id: "local.releasePreflightWorkflow",
    label: "Release preflight workflow",
    status: "pass",
    summary: `${releasePreflightWorkflowPath} defines promotion preflight evidence collection without static-sanity overrides.`
  };
}

async function checkReleaseImageWorkflow(root: string): Promise<ReleaseGateCheck> {
  const filePath = path.join(root, releaseImageWorkflowPath);

  if (!await fileExists(filePath)) {
    return {
      id: "local.releaseImageWorkflow",
      label: "Release image workflow",
      status: "fail",
      summary: `${releaseImageWorkflowPath} is missing.`,
      remediation: "Add a release image workflow that runs source, commit, pack-contract, test, build, artifact, provenance/SBOM, and evidence upload gates before publishing runtime images."
    };
  }

  const content = await readFile(filePath, "utf8");
  const missingTerms = requiredReleaseImageTerms.filter((term) => !content.includes(term));

  if (missingTerms.length > 0) {
    return {
      id: "local.releaseImageWorkflow",
      label: "Release image workflow",
      status: "fail",
      summary: `${releaseImageWorkflowPath} is missing required release image gate term(s): ${missingTerms.join(", ")}.`,
      remediation: "Keep release image publishing aligned with source, commit, pack-contract, test, build, artifact, provenance/SBOM, and evidence upload gates.",
      details: {
        missingTerms
      }
    };
  }

  return {
    id: "local.releaseImageWorkflow",
    label: "Release image workflow",
    status: "pass",
    summary: `${releaseImageWorkflowPath} defines gated release image publishing and evidence upload.`
  };
}

async function checkPackageScripts(root: string): Promise<ReleaseGateCheck> {
  const filePath = path.join(root, packageJsonPath);

  if (!await fileExists(filePath)) {
    return {
      id: "local.packageScripts",
      label: "Package release scripts",
      status: "fail",
      summary: `${packageJsonPath} is missing.`,
      remediation: "Keep package.json scripts aligned with the production release workflows."
    };
  }

  let packageJson: unknown;

  try {
    packageJson = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    return {
      id: "local.packageScripts",
      label: "Package release scripts",
      status: "fail",
      summary: error instanceof Error ? `${packageJsonPath} is not valid JSON: ${error.message}` : `${packageJsonPath} is not valid JSON.`,
      remediation: "Fix package.json so release-gate can verify production release script drift."
    };
  }

  const scripts = isRecord(packageJson) && isRecord(packageJson.scripts) ? packageJson.scripts : undefined;

  if (!scripts) {
    return {
      id: "local.packageScripts",
      label: "Package release scripts",
      status: "fail",
      summary: `${packageJsonPath} does not define scripts.`,
      remediation: "Define the package scripts used by the production release workflows.",
      details: {
        missingScripts: requiredPackageScripts.map((script) => script.name)
      }
    };
  }

  const missingScripts: string[] = [];
  const driftedScripts: Array<{ script: string; missingTerms: string[] }> = [];

  for (const requiredScript of requiredPackageScripts) {
    const value = scripts[requiredScript.name];

    if (typeof value !== "string" || value.trim() === "") {
      missingScripts.push(requiredScript.name);
      continue;
    }

    const missingTerms = requiredScript.terms.filter((term) => !value.includes(term));

    if (missingTerms.length > 0) {
      driftedScripts.push({
        script: requiredScript.name,
        missingTerms
      });
    }
  }

  if (missingScripts.length > 0 || driftedScripts.length > 0) {
    return {
      id: "local.packageScripts",
      label: "Package release scripts",
      status: "fail",
      summary: `${packageJsonPath} release scripts are not aligned with production release workflows.`,
      remediation: "Restore the package scripts expected by CI, release preflight, and release image workflows before promotion.",
      details: {
        missingScripts,
        driftedScripts
      }
    };
  }

  return {
    id: "local.packageScripts",
    label: "Package release scripts",
    status: "pass",
    summary: `${packageJsonPath} defines the production release scripts used by release workflows.`
  };
}

function releasePreflightCommandBlock(content: string, command: string) {
  return releasePreflightStepBlocks(content, command)
    .find((block) => /\brun:\s*/.test(block));
}

function releasePreflightStepBlocks(content: string, term: string) {
  const blocks: string[] = [];
  let searchIndex = 0;

  while (searchIndex < content.length) {
    const termIndex = content.indexOf(term, searchIndex);

    if (termIndex < 0) {
      break;
    }

    const stepStartIndex = content.lastIndexOf("\n      - ", termIndex);
    const blockStartIndex = stepStartIndex >= 0 ? stepStartIndex + 1 : termIndex;
    const nextStepIndex = content.indexOf("\n      - ", termIndex + term.length);
    blocks.push(content.slice(blockStartIndex, nextStepIndex < 0 ? undefined : nextStepIndex));
    searchIndex = termIndex + term.length;
  }

  return blocks;
}

function releasePreflightArtifactUploadPathValues(block: string) {
  const lines = block.split(/\r?\n/);
  const pathValues: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const pathLine = /^(\s*)path:\s*(.*)$/.exec(lines[index]);

    if (!pathLine) {
      continue;
    }

    const pathIndent = pathLine[1].length;
    const inlinePath = pathLine[2].trim();

    if (inlinePath && !["|", "|-", "|+", ">", ">-", ">+"].includes(inlinePath)) {
      pathValues.push(inlinePath);
    }

    for (let pathIndex = index + 1; pathIndex < lines.length; pathIndex += 1) {
      const line = lines[pathIndex];
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      const indent = line.length - line.trimStart().length;

      if (indent <= pathIndent) {
        break;
      }

      pathValues.push(trimmed);
    }
  }

  return pathValues;
}

function forbiddenReleasePreflightArtifactUploadPathMatches(content: string) {
  return releasePreflightStepBlocks(content, "actions/upload-artifact")
    .flatMap(releasePreflightArtifactUploadPathValues)
    .map((pathValue) => {
      const normalizedPathValue = pathValue.toLowerCase();
      const terms = forbiddenReleasePreflightArtifactUploadPathTerms.filter((term) =>
        normalizedPathValue.includes(term.toLowerCase())
      );

      return { path: pathValue, terms };
    })
    .filter((match) => match.terms.length > 0);
}

function missingReleasePreflightCommandTerms(content: string) {
  return requiredReleasePreflightCommandTerms.flatMap(({ command, terms }) => {
    const commandBlock = releasePreflightCommandBlock(content, command);

    if (!commandBlock) {
      return [];
    }

    return terms
      .filter((term) => !commandBlock.includes(term))
      .map((term) => `${command} ${term}`);
  });
}

function forbiddenReleasePreflightCommandTermMatches(content: string) {
  return forbiddenReleasePreflightCommandTerms.flatMap(({ command, terms }) => {
    const commandBlock = releasePreflightCommandBlock(content, command);

    if (!commandBlock) {
      return [];
    }

    return terms
      .filter((term) => commandBlock.includes(term))
      .map((term) => `${command} ${term}`);
  });
}

async function checkProductionDocs(root: string): Promise<ReleaseGateCheck> {
  const filePath = path.join(root, productionDocsPath);

  if (!await fileExists(filePath)) {
    return {
      id: "local.productionDocs",
      label: "Production readiness docs",
      status: "fail",
      summary: `${productionDocsPath} is missing.`,
      remediation: "Document the release checklist before promotion."
    };
  }

  const content = await readFile(filePath, "utf8");
  const missingEnvNames = requiredDocumentedEnvNames.filter((name) => !content.includes(name));

  if (missingEnvNames.length > 0 || !content.toLowerCase().includes("branch protection")) {
    return {
      id: "local.productionDocs",
      label: "Production readiness docs",
      status: "fail",
      summary: `${productionDocsPath} is missing required release-gate terms.`,
      remediation: "Document required production env names and branch protection before promotion.",
      details: {
        missingEnvNames,
        branchProtectionDocumented: content.toLowerCase().includes("branch protection")
      }
    };
  }

  return {
    id: "local.productionDocs",
    label: "Production readiness docs",
    status: "pass",
    summary: `${productionDocsPath} exists and documents required env names plus branch protection.`
  };
}

function composeServiceBlock(content: string, serviceName: string) {
  const serviceStartPattern = new RegExp(`\\n  ${serviceName}:\\r?\\n`);
  const match = serviceStartPattern.exec(`\n${content}`);

  if (!match) {
    return undefined;
  }

  const start = match.index + 1;
  const nextServicePattern = /\n  [A-Za-z0-9_-]+:\r?\n/g;
  nextServicePattern.lastIndex = start + match[0].length - 1;
  const next = nextServicePattern.exec(`\n${content}`);

  return content.slice(start, next ? next.index - 1 : undefined);
}

function topLevelComposeBlock(content: string, blockName: string) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${blockName}:`);

  if (start === -1) {
    return undefined;
  }

  const blockLines = [lines[start]];

  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }

    blockLines.push(line);
  }

  return blockLines.join("\n");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function composeListIncludes(block: string | undefined, item: string) {
  return Boolean(block && new RegExp(`(^|\\n)\\s*-\\s+${escapeRegExp(item)}(?:\\s|$)`).test(block));
}

function composeMappingIncludes(block: string | undefined, key: string) {
  return Boolean(block && new RegExp(`(^|\\n)\\s{2}${escapeRegExp(key)}:\\s*(?:\\n|$)`).test(block));
}

function composeServiceNames(content: string) {
  const servicesBlock = topLevelComposeBlock(content, "services");

  if (!servicesBlock) {
    return [];
  }

  return servicesBlock
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);

      return match ? [match[1]] : [];
    });
}

function requireComposeServiceSecrets(
  missingComposeTerms: string[],
  serviceName: string,
  serviceBlock: string | undefined,
  secretNames: string[]
) {
  for (const secretName of secretNames) {
    if (!composeListIncludes(serviceBlock, secretName)) {
      missingComposeTerms.push(`${serviceName} secret ${secretName}`);
    }
  }
}

async function checkProductionCompose(root: string): Promise<ReleaseGateCheck> {
  const composeFilePath = path.join(root, productionComposePath);
  const docFilePath = path.join(root, productionDeploymentDocPath);

  if (!await fileExists(composeFilePath)) {
    return {
      id: "local.productionCompose",
      label: "Production compose profile",
      status: "fail",
      summary: `${productionComposePath} is missing.`,
      remediation: "Commit the auditable single-host production Compose profile before promotion."
    };
  }

  if (!await fileExists(docFilePath)) {
    return {
      id: "local.productionCompose",
      label: "Production compose profile",
      status: "fail",
      summary: `${productionDeploymentDocPath} is missing.`,
      remediation: "Document the production Compose profile, required host directories, required env, and Docker socket residual risk."
    };
  }

  const [composeContent, docContent] = await Promise.all([
    readFile(composeFilePath, "utf8"),
    readFile(docFilePath, "utf8")
  ]);
  const secretsBlock = topLevelComposeBlock(composeContent, "secrets");
  const postgresBlock = composeServiceBlock(composeContent, "postgres");
  const apiBlock = composeServiceBlock(composeContent, "api");
  const workerBlock = composeServiceBlock(composeContent, "worker");
  const missingComposeTerms: string[] = [];
  const serviceNames = composeServiceNames(composeContent);
  const extraServiceNames = serviceNames.filter((serviceName) => !["postgres", "api", "worker"].includes(serviceName));
  const servicesBlock = topLevelComposeBlock(composeContent, "services");
  const requiredTopLevelSecrets = [
    "siteflow_app_secret",
    "siteflow_api_token",
    "siteflow_metrics_token",
    "siteflow_release_evidence_signing_key",
    "siteflow_postgres_password",
    "siteflow_github_webhook_secret",
    "siteflow_gitlab_webhook_secret",
    "siteflow_gitea_webhook_secret",
    "siteflow_generic_webhook_secret"
  ];

  for (const secretName of requiredTopLevelSecrets) {
    if (!composeMappingIncludes(secretsBlock, secretName)) {
      missingComposeTerms.push(`top-level secret ${secretName}`);
    }
  }

  if (extraServiceNames.length > 0) {
    missingComposeTerms.push(`unexpected service(s): ${extraServiceNames.join(", ")}`);
  }

  if (servicesBlock && /(^|\n)\s{4}build:\s*(\n|$)/.test(servicesBlock)) {
    missingComposeTerms.push("services must not define local Docker build entries");
  }

  if (!postgresBlock) {
    missingComposeTerms.push("postgres service");
  } else {
    for (const term of [
      "image: ${SITEFLOW_POSTGRES_IMAGE:?",
      "POSTGRES_PASSWORD_FILE:",
      "siteflow_postgres_password",
      "healthcheck:"
    ]) {
      if (!postgresBlock.includes(term)) {
        missingComposeTerms.push(`postgres ${term}`);
      }
    }

    requireComposeServiceSecrets(missingComposeTerms, "postgres", postgresBlock, [
      "siteflow_postgres_password"
    ]);

    if (postgresBlock.includes("postgres:16-alpine")) {
      missingComposeTerms.push("postgres image must not use mutable postgres:16-alpine default");
    }
  }

  if (!apiBlock) {
    missingComposeTerms.push("api service");
  } else {
    for (const term of [
      "image: ${SITEFLOW_IMAGE:?",
      "user: \"1000:1000\"",
      "init: true",
      "read_only: true",
      "cap_drop:",
      "no-new-privileges:true",
      "condition: service_healthy",
      "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES:",
      "SITEFLOW_PREBUILT_MAX_FILES:",
      "SITEFLOW_TRUST_PROXY:",
      "SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD:",
      "DATABASE_URL:",
      "SITEFLOW_APP_SECRET_FILE:",
      "SITEFLOW_API_TOKEN_FILE:",
      "SITEFLOW_METRICS_TOKEN_FILE:",
      "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE:",
      "SITEFLOW_POSTGRES_PASSWORD_FILE:",
      "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE:",
      "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE:",
      "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE:",
      "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE:",
      "${SITEFLOW_API_BIND:-127.0.0.1}:8787:8787",
      "healthcheck:",
      "/readyz"
    ]) {
      if (!apiBlock.includes(term)) {
        missingComposeTerms.push(`api ${term}`);
      }
    }

    requireComposeServiceSecrets(missingComposeTerms, "api", apiBlock, [
      "siteflow_app_secret",
      "siteflow_api_token",
      "siteflow_metrics_token",
      "siteflow_release_evidence_signing_key",
      "siteflow_postgres_password",
      "siteflow_github_webhook_secret",
      "siteflow_gitlab_webhook_secret",
      "siteflow_gitea_webhook_secret",
      "siteflow_generic_webhook_secret"
    ]);

    if (apiBlock.includes("/var/run/docker.sock")) {
      missingComposeTerms.push("api must not mount /var/run/docker.sock");
    }

    if (/(^|\n)\s+privileged:\s*true\s*(\n|$)/i.test(apiBlock)) {
      missingComposeTerms.push("api must not run privileged");
    }

    if (/(^|\n)\s+cap_add:\s*(\n|$)/i.test(apiBlock)) {
      missingComposeTerms.push("api must not add Linux capabilities");
    }

    if (/seccomp=unconfined|apparmor=unconfined/i.test(apiBlock)) {
      missingComposeTerms.push("api must not disable seccomp or AppArmor");
    }

    if (/(^|\n)\s+network_mode:\s*["']?host["']?\s*(\n|$)/i.test(apiBlock)) {
      missingComposeTerms.push("api must not use host network mode");
    }

    if (apiBlock.includes("0.0.0.0:8787:8787") || /(^|\n)\s*-\s*["']?8787:8787["']?\s*(\n|$)/.test(apiBlock)) {
      missingComposeTerms.push("api must default to loopback port binding and must not expose bare 8787:8787");
    }

    if (/(^|\n)\s+build:\s*(\n|$)/.test(apiBlock)) {
      missingComposeTerms.push("api must not define a local Docker build");
    }

    if (apiBlock.includes("siteflow-console:production")) {
      missingComposeTerms.push("api image must not use mutable siteflow-console:production default");
    }

    if (
      apiBlock.includes("SITEFLOW_TRUST_PROXY: ${SITEFLOW_TRUST_PROXY:-loopback}") ||
      apiBlock.includes('SITEFLOW_TRUST_PROXY: "${SITEFLOW_TRUST_PROXY:-loopback}"') ||
      /(^|\n)\s+SITEFLOW_TRUST_PROXY:\s*["']?loopback["']?\s*(\n|$)/.test(apiBlock)
    ) {
      missingComposeTerms.push("api SITEFLOW_TRUST_PROXY must default to disabled/unset");
    }

    if (apiBlock.includes("export SITEFLOW_") || apiBlock.includes("$(cat /run/secrets/") || apiBlock.includes("$$(cat /run/secrets/")) {
      missingComposeTerms.push("api must not export Docker secret values");
    }
  }

  if (!workerBlock) {
    missingComposeTerms.push("worker service");
  } else {
    for (const term of [
      "image: ${SITEFLOW_IMAGE:?",
      "/var/run/docker.sock",
      "user:",
      "group_add:",
      "init: true",
      "read_only: true",
      "cap_drop:",
      "no-new-privileges:true",
      "condition: service_healthy",
      "SITEFLOW_BUILD_RUNNER: docker",
      "SITEFLOW_BUILD_IMAGE:",
      "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES:",
      "SITEFLOW_BUILD_MAX_ARTIFACT_FILES:",
      "SITEFLOW_BUILD_MIN_FREE_BYTES:",
      "SITEFLOW_BUILD_STEP_TIMEOUT_MS:",
      "SITEFLOW_GIT_TIMEOUT_MS:",
      "SITEFLOW_BUILD_MEMORY:",
      "SITEFLOW_BUILD_CPUS:",
      "SITEFLOW_BUILD_PIDS_LIMIT:",
      "SITEFLOW_GIT_SSH_KEY_PATH:",
      "SITEFLOW_GIT_KNOWN_HOSTS_PATH:",
      "SITEFLOW_BUILD_NETWORK:",
      "DATABASE_URL:",
      "SITEFLOW_APP_SECRET_FILE:",
      "SITEFLOW_POSTGRES_PASSWORD_FILE:",
      "command -v docker",
      "docker info",
      "exec node dist-worker/worker/index.js",
      "healthcheck:",
      "dist-worker/worker/index.js",
      "--healthcheck"
    ]) {
      if (!workerBlock.includes(term)) {
        missingComposeTerms.push(`worker ${term}`);
      }
    }

    requireComposeServiceSecrets(missingComposeTerms, "worker", workerBlock, [
      "siteflow_app_secret",
      "siteflow_postgres_password"
    ]);

    if (workerBlock.includes("export SITEFLOW_") || workerBlock.includes("$(cat /run/secrets/") || workerBlock.includes("$$(cat /run/secrets/")) {
      missingComposeTerms.push("worker must not export Docker secret values");
    }

    if (/(^|\n)\s+privileged:\s*true\s*(\n|$)/i.test(workerBlock)) {
      missingComposeTerms.push("worker must not run privileged");
    }

    if (/(^|\n)\s+cap_add:\s*(\n|$)/i.test(workerBlock)) {
      missingComposeTerms.push("worker must not add Linux capabilities");
    }

    if (/seccomp=unconfined|apparmor=unconfined/i.test(workerBlock)) {
      missingComposeTerms.push("worker must not disable seccomp or AppArmor");
    }

    if (/(^|\n)\s+network_mode:\s*["']?host["']?\s*(\n|$)/i.test(workerBlock)) {
      missingComposeTerms.push("worker must not use host network mode");
    }

    if (workerBlock.includes("SITEFLOW_BUILD_IMAGE_ALLOWLIST: ${SITEFLOW_BUILD_IMAGE_ALLOWLIST:?")) {
      missingComposeTerms.push("worker build image allowlist must remain optional for digest-pinned build images");
    }

    if (
      workerBlock.includes('user: "${SITEFLOW_WORKER_USER:-0:0}"') ||
      workerBlock.includes("user: '${SITEFLOW_WORKER_USER:-0:0}'") ||
      /(^|\n)\s+user:\s*["']?0(?::0)?["']?\s*(\n|$)/.test(workerBlock)
    ) {
      missingComposeTerms.push("worker SITEFLOW_WORKER_USER must default to a non-root user");
    }

    if (
      workerBlock.includes("${SITEFLOW_DOCKER_SOCKET_GID:-0}") ||
      workerBlock.includes("${SITEFLOW_DOCKER_SOCKET_GID-0}") ||
      /(^|\n)\s*-\s*["']?0["']?\s*(\n|$)/.test(workerBlock)
    ) {
      missingComposeTerms.push("worker SITEFLOW_DOCKER_SOCKET_GID must be explicitly required instead of defaulting to 0");
    }

    if (/(^|\n)\s+build:\s*(\n|$)/.test(workerBlock)) {
      missingComposeTerms.push("worker must not define a local Docker build");
    }

    if (workerBlock.includes("siteflow-console:production")) {
      missingComposeTerms.push("worker image must not use mutable siteflow-console:production default");
    }
  }

  const missingDocTerms = requiredProductionDeploymentDocTerms.filter((term) => !docContent.includes(term));

  if (missingComposeTerms.length > 0 || missingDocTerms.length > 0) {
    return {
      id: "local.productionCompose",
      label: "Production compose profile",
      status: "fail",
      summary: "Production Compose profile is not aligned with the single-host production boundary.",
      remediation: "Keep API non-root/read-only/no-socket, keep the worker Docker socket risk explicit, require pinned Docker build image and storage threshold env, and document target validation.",
      details: {
        missingComposeTerms,
        missingDocTerms
      }
    };
  }

  return {
    id: "local.productionCompose",
    label: "Production compose profile",
    status: "pass",
    summary: `${productionComposePath} defines the single-host production boundary and ${productionDeploymentDocPath} documents validation and residual Docker socket risk.`
  };
}

async function checkGitStatus(
  root: string,
  runner: ReleaseGateCommandRunner,
  allowDirty: boolean
): Promise<ReleaseGateCheck> {
  const result = await runner("git", ["status", "--porcelain"], { cwd: root });
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (result.exitCode !== 0) {
    return {
      id: "local.gitStatus",
      label: "Git worktree",
      status: "manual_required",
      summary: output || `git status exited with ${result.exitCode}; worktree cleanliness could not be verified.`,
      remediation: "Run from a Git checkout or verify the exact release tree manually.",
      details: {
        dirty: null,
        exitCode: result.exitCode
      }
    };
  }

  const rawStatus = result.stdout.replace(/\r?\n$/, "");
  const statusLines = rawStatus ? rawStatus.split(/\r?\n/) : [];
  const statusSample = statusLines.slice(0, maxDirtyWorktreeEntries);
  const statusTruncated = statusLines.length > statusSample.length;

  if (result.stdout.trim() && !allowDirty) {
    return {
      id: "local.gitStatus",
      label: "Git worktree",
      status: "fail",
      summary: "Worktree has uncommitted changes.",
      remediation: "Commit, stash, or pass --allow-dirty for a static sanity check.",
      details: {
        dirty: true,
        status: statusSample,
        entryCount: statusLines.length,
        truncated: statusTruncated
      }
    };
  }

  return {
    id: "local.gitStatus",
    label: "Git worktree",
    status: "pass",
    summary: result.stdout.trim()
      ? "Worktree has uncommitted changes, allowed by --allow-dirty."
      : "Worktree is clean.",
    details: {
      dirty: statusLines.length > 0,
      status: statusSample,
      entryCount: statusLines.length,
      truncated: statusTruncated
    }
  };
}

async function checkReleaseSourceTree(
  root: string,
  runner: ReleaseGateCommandRunner
): Promise<ReleaseGateCheck> {
  const result = await runner("git", ["ls-files"], { cwd: root });
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (result.exitCode !== 0) {
    return {
      id: "local.releaseSourceTree",
      label: "Release source tree",
      status: "manual_required",
      summary: output || `git ls-files exited with ${result.exitCode}; tracked source policy could not be verified.`,
      remediation: "Run from a Git checkout or verify tracked release source paths manually.",
      details: {
        exitCode: result.exitCode
      }
    };
  }

  const trackedFindings = findForbiddenTrackedReleasePaths(result.stdout.split(/\r?\n/));

  if (trackedFindings.length > 0) {
    const cleanupCommand = suggestedIndexOnlyReleaseSourceCleanupCommand(trackedFindings);

    return {
      id: "local.releaseSourceTree",
      label: "Release source tree",
      status: "fail",
      summary: `Release source tracks ${trackedFindings.length} generated, dependency, secret, or scratch path(s).`,
      remediation: "Review npm run release:source:cleanup-plan, remove approved paths from the Git index only, and keep them ignored so npm ci and npm run build leave the release checkout clean.",
      details: {
        trackedPaths: trackedFindings.slice(0, 50),
        ...(cleanupCommand ? { suggestedIndexOnlyCleanupCommand: cleanupCommand } : {})
      }
    };
  }

  return {
    id: "local.releaseSourceTree",
    label: "Release source tree",
    status: "pass",
    summary: "Release source does not track generated build output, dependency directories, env files, or workflow scratch paths.",
    details: releaseSourceTreePolicyDetails()
  };
}

function stripOptionalQuotes(value: string) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function parseReleaseGateEnvFile(content: string) {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(normalized);

    if (!match) {
      continue;
    }

    values[match[1]] = stripOptionalQuotes(match[2]);
  }

  return values;
}

function hasNonEmptyValue(values: Record<string, string | undefined>, key: string) {
  return typeof values[key] === "string" && values[key]?.trim() !== "";
}

function secretSourceKey(key: string) {
  return `__SITEFLOW_RELEASE_GATE_SECRET_SOURCE_${key}`;
}

function trimTrailingNewlines(value: string) {
  return value.replace(/[\r\n]+$/g, "");
}

function secretSource(values: Record<string, string | undefined>, key: string) {
  return values[secretSourceKey(key)] ?? (hasNonEmptyValue(values, key) ? key : null);
}

function hasSecretConfigured(values: Record<string, string | undefined>, key: string) {
  return Boolean(secretSource(values, key) ?? normalizedEnvValue(values, `${key}_FILE`));
}

async function resolveSecretFileEnvValues(values: Record<string, string | undefined>, baseDir: string) {
  const resolved = { ...values };
  const secretKeys = [
    "SITEFLOW_API_TOKEN",
    "SITEFLOW_METRICS_TOKEN",
    "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY",
    "SITEFLOW_APP_SECRET",
    "SITEFLOW_SEALING_KEY",
    "SITEFLOW_POSTGRES_PASSWORD",
    ...gitWebhookSecretKeys
  ];

  for (const key of secretKeys) {
    if (hasNonEmptyValue(resolved, key)) {
      resolved[secretSourceKey(key)] = key;
      continue;
    }

    const fileEnvName = `${key}_FILE`;
    const fileValue = normalizedEnvValue(resolved, fileEnvName);

    if (!fileValue) {
      continue;
    }

    const filePath = path.isAbsolute(fileValue) ? fileValue : path.join(baseDir, fileValue);
    let fileContent: string;

    try {
      fileContent = await readFile(filePath, "utf8");
    } catch {
      throw new Error(`${fileEnvName} points to an unreadable secret file for ${key}: ${filePath}`);
    }

    const normalized = trimTrailingNewlines(fileContent);

    if (normalized.length === 0) {
      throw new Error(`${fileEnvName} points to an empty secret file for ${key}: ${filePath}`);
    }

    resolved[key] = normalized;
    resolved[secretSourceKey(key)] = fileEnvName;
  }

  return resolved;
}

function enabledFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizedEnvValue(values: Record<string, string | undefined>, key: string) {
  const normalized = values[key]?.trim();

  return normalized ? normalized : undefined;
}

function productionSecretStrengthStatus(values: Record<string, string | undefined>, key: string) {
  const value = normalizedEnvValue(values, key);
  const source = secretSource(values, key) ?? key;

  if (!value) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      source,
      summary: `${key} or ${key}_FILE is required.`
    };
  }

  try {
    assertProductionSecretStrength(value, source);
    return {
      status: "pass" as ReleaseGateCheckStatus,
      source,
      summary: `${source} meets production strength requirements.`
    };
  } catch (error) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      source,
      summary: error instanceof Error ? error.message : `${key} does not meet production strength requirements.`
    };
  }
}

function productionMetricsTokenStrengthStatus(values: Record<string, string | undefined>) {
  const tokenStatus = productionSecretStrengthStatus(values, "SITEFLOW_METRICS_TOKEN");

  if (tokenStatus.status === "pass") {
    return tokenStatus;
  }

  if (!hasNonEmptyValue(values, "SITEFLOW_METRICS_TOKEN") && !hasNonEmptyValue(values, "SITEFLOW_METRICS_TOKEN_FILE") && enabledFlag(values.SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS)) {
    return {
      status: "skipped" as ReleaseGateCheckStatus,
      source: null,
      summary: "SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS explicitly accepts a private-scrape exception."
    };
  }

  return tokenStatus;
}

function productionAppSecretStrengthStatus(values: Record<string, string | undefined>) {
  const appSecret = normalizedEnvValue(values, "SITEFLOW_APP_SECRET");
  const appSecretFile = normalizedEnvValue(values, "SITEFLOW_APP_SECRET_FILE");
  const legacySealingKey = normalizedEnvValue(values, "SITEFLOW_SEALING_KEY");
  const legacySealingKeyFile = normalizedEnvValue(values, "SITEFLOW_SEALING_KEY_FILE");
  const source = appSecret || appSecretFile
    ? "SITEFLOW_APP_SECRET"
    : legacySealingKey || legacySealingKeyFile
      ? "SITEFLOW_SEALING_KEY"
      : null;

  if (!source) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      source,
      summary: "SITEFLOW_APP_SECRET, SITEFLOW_APP_SECRET_FILE, SITEFLOW_SEALING_KEY, or SITEFLOW_SEALING_KEY_FILE is required."
    };
  }

  const result = productionSecretStrengthStatus(values, source);

  return {
    ...result,
    source: result.source
  };
}

function optionalProductionSecretStrengthStatus(values: Record<string, string | undefined>, key: string) {
  if (!hasNonEmptyValue(values, key) && !hasNonEmptyValue(values, `${key}_FILE`) && !secretSource(values, key)) {
    return {
      status: "skipped" as ReleaseGateCheckStatus,
      source: null,
      summary: `${key} is not configured.`
    };
  }

  return productionSecretStrengthStatus(values, key);
}

function productionGitWebhookSecretsStrengthStatus(values: Record<string, string | undefined>) {
  const checks = gitWebhookSecretKeys.map((key) => optionalProductionSecretStrengthStatus(values, key));
  const configured = checks.filter((check) => check.status !== "skipped");
  const failures = checks.filter((check) => check.status === "fail");

  return {
    status: failures.length > 0
      ? "fail" as ReleaseGateCheckStatus
      : configured.length > 0
        ? "pass" as ReleaseGateCheckStatus
        : "skipped" as ReleaseGateCheckStatus,
    sources: configured.map((check) => check.source).filter((source): source is string => typeof source === "string"),
    violations: failures.map((check) => check.summary)
  };
}

function databaseUrlHasPassword(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).password.trim().length > 0;
  } catch {
    return /:\/\/[^/\s:]+:[^@\s]+@/.test(value);
  }
}

function productionDatabasePasswordStatus(values: Record<string, string | undefined>) {
  if (databaseUrlHasPassword(normalizedEnvValue(values, "DATABASE_URL"))) {
    return {
      status: "pass" as ReleaseGateCheckStatus,
      source: "DATABASE_URL",
      summary: "DATABASE_URL includes database password material."
    };
  }

  const source = secretSource(values, "SITEFLOW_POSTGRES_PASSWORD");

  if (normalizedEnvValue(values, "SITEFLOW_POSTGRES_PASSWORD")) {
    return {
      status: "pass" as ReleaseGateCheckStatus,
      source,
      summary: `${source ?? "SITEFLOW_POSTGRES_PASSWORD"} provides database password material.`
    };
  }

  return {
    status: "fail" as ReleaseGateCheckStatus,
    source,
    summary: "DATABASE_URL is passwordless and SITEFLOW_POSTGRES_PASSWORD or SITEFLOW_POSTGRES_PASSWORD_FILE is required."
  };
}

function resolveProductionSecretPosture(values: Record<string, string | undefined>) {
  const apiToken = productionSecretStrengthStatus(values, "SITEFLOW_API_TOKEN");
  const metricsToken = productionMetricsTokenStrengthStatus(values);
  const releaseEvidenceSigningKey = productionSecretStrengthStatus(values, "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY");
  const appSecret = productionAppSecretStrengthStatus(values);
  const postgresPassword = productionDatabasePasswordStatus(values);
  const gitWebhookSecrets = productionGitWebhookSecretsStrengthStatus(values);
  const secretStrengthViolations = [
    apiToken,
    metricsToken,
    releaseEvidenceSigningKey,
    appSecret,
    ...gitWebhookSecrets.violations.map((summary) => ({
      status: "fail" as ReleaseGateCheckStatus,
      summary
    }))
  ].filter((result) => result.status === "fail").map((result) => result.summary);

  return {
    apiTokenStrengthStatus: apiToken.status,
    metricsTokenStrengthStatus: metricsToken.status,
    releaseEvidenceSigningKeyStrengthStatus: releaseEvidenceSigningKey.status,
    releaseEvidenceSigningKeySource: releaseEvidenceSigningKey.source,
    appSecretStrengthStatus: appSecret.status,
    appSecretSource: appSecret.source,
    gitWebhookSecretStrengthStatus: gitWebhookSecrets.status,
    gitWebhookSecretSources: gitWebhookSecrets.sources,
    postgresPasswordStatus: postgresPassword.status,
    postgresPasswordSource: postgresPassword.source,
    secretStrengthViolations
  };
}

function hasDockerDigest(image: string) {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}

function parseBuildImageAllowlist(value: string | undefined) {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
}

function hasInvalidBuildImageAllowlistEntry(allowlist: string[]) {
  return allowlist.some((entry) => entry.startsWith("-") || /\s/.test(entry));
}

function buildImageMatchesAllowlist(image: string, allowlist: string[]) {
  return allowlist.some((entry) => {
    if (entry.endsWith("*")) {
      return image.startsWith(entry.slice(0, -1));
    }

    return image === entry;
  });
}

function sourceBuildHostExceptionReason(values: Record<string, string | undefined>) {
  if (enabledFlag(values.SITEFLOW_TRUSTED_SOURCE_BUILDS)) {
    return "SITEFLOW_TRUSTED_SOURCE_BUILDS";
  }

  if (enabledFlag(values.SITEFLOW_ALLOW_UNSANDBOXED_BUILDS)) {
    return "SITEFLOW_ALLOW_UNSANDBOXED_BUILDS";
  }

  return undefined;
}

function resolveSourceBuildPosture(values: Record<string, string | undefined>) {
  const buildRunner = normalizedEnvValue(values, "SITEFLOW_BUILD_RUNNER")?.toLowerCase();
  const buildImage = normalizedEnvValue(values, "SITEFLOW_BUILD_IMAGE");
  const buildImageAllowlist = parseBuildImageAllowlist(values.SITEFLOW_BUILD_IMAGE_ALLOWLIST);
  const buildImageDigestPinned = buildImage ? hasDockerDigest(buildImage) : false;
  const buildImageAllowlistConfigured = buildImageAllowlist.length > 0;
  const buildImageAllowedByAllowlist = buildImage
    ? buildImageMatchesAllowlist(buildImage, buildImageAllowlist)
    : false;
  const buildImageAllowlistValid = !hasInvalidBuildImageAllowlistEntry(buildImageAllowlist);
  const buildImageTaggedTrustedExceptionAccepted = enabledFlag(values.SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE);
  const hostBuildExceptionReason = sourceBuildHostExceptionReason(values);
  const hostBuildException = Boolean(hostBuildExceptionReason);

  if (buildRunner === "host" && hostBuildException) {
    return {
      status: "pass" as ReleaseGateCheckStatus,
      buildRunner,
      hostBuildException,
      hostBuildExceptionReason,
      buildImage: buildImage ?? null,
      buildImageDigestPinned,
      buildImageAllowlistConfigured,
      buildImageAllowedByAllowlist,
      buildImageTaggedTrustedExceptionAccepted,
      buildImagePolicyStatus: "skipped" as ReleaseGateCheckStatus,
      buildImagePolicy: "host_build_exception"
    };
  }

  const sourceBuildPosturePass = buildRunner === "docker";
  let buildImagePolicyStatus: ReleaseGateCheckStatus = "skipped";
  let buildImagePolicy = "not_applicable";

  if (buildRunner === "docker") {
    if (!buildImage) {
      buildImagePolicyStatus = "fail";
      buildImagePolicy = "missing_image";
    } else if (buildImageAllowlistConfigured && !buildImageAllowedByAllowlist) {
      buildImagePolicyStatus = "fail";
      buildImagePolicy = "not_allowed_by_allowlist";
    } else if (buildImageDigestPinned) {
      buildImagePolicyStatus = "pass";
      buildImagePolicy = "digest";
    } else if (buildImageAllowlistConfigured && buildImageAllowedByAllowlist && buildImageTaggedTrustedExceptionAccepted) {
      buildImagePolicyStatus = "pass";
      buildImagePolicy = "tag_allowlist_exception";
    } else if (buildImageAllowlistConfigured && buildImageAllowedByAllowlist) {
      buildImagePolicyStatus = "fail";
      buildImagePolicy = "tagged_image_without_exception";
    } else {
      buildImagePolicyStatus = "fail";
      buildImagePolicy = "mutable_tag_without_allowlist";
    }
  }

  return {
    status: sourceBuildPosturePass ? "pass" as ReleaseGateCheckStatus : "fail" as ReleaseGateCheckStatus,
    buildRunner: buildRunner ?? null,
    hostBuildException,
    hostBuildExceptionReason: hostBuildExceptionReason ?? null,
    buildImage: buildImage ?? null,
    buildImageDigestPinned,
    buildImageAllowlistConfigured,
    buildImageAllowedByAllowlist,
    buildImageTaggedTrustedExceptionAccepted,
    buildImagePolicyStatus: buildImageAllowlistValid ? buildImagePolicyStatus : "fail",
    buildImagePolicy: buildImageAllowlistValid ? buildImagePolicy : "invalid_allowlist"
  };
}

function positiveRuntimeIntegerStatus(values: Record<string, string | undefined>, key: string) {
  const rawValue = normalizedEnvValue(values, key);

  if (!rawValue) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: `${key} is required.`
    };
  }

  const parsed = Number(rawValue);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: `${key} must be a positive integer.`
    };
  }

  return {
    status: "pass" as ReleaseGateCheckStatus,
    value: parsed,
    summary: `${key} is explicitly configured.`
  };
}

function positiveRuntimeNumberStatus(values: Record<string, string | undefined>, key: string) {
  const rawValue = normalizedEnvValue(values, key);

  if (!rawValue) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: `${key} is required.`
    };
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: `${key} must be a positive number.`
    };
  }

  return {
    status: "pass" as ReleaseGateCheckStatus,
    value: parsed,
    summary: `${key} is explicitly configured.`
  };
}

function buildMemoryRuntimeStatus(values: Record<string, string | undefined>) {
  const rawValue = normalizedEnvValue(values, "SITEFLOW_BUILD_MEMORY");

  if (!rawValue) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: "SITEFLOW_BUILD_MEMORY is required."
    };
  }

  if (!/^[1-9]\d*(?:[bkmg])?$/i.test(rawValue)) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: "SITEFLOW_BUILD_MEMORY must be a positive Docker memory value such as 512m or 1g."
    };
  }

  return {
    status: "pass" as ReleaseGateCheckStatus,
    value: rawValue,
    summary: "SITEFLOW_BUILD_MEMORY is explicitly configured."
  };
}

function buildNetworkRuntimeStatus(values: Record<string, string | undefined>) {
  const buildNetwork = normalizedEnvValue(values, "SITEFLOW_BUILD_NETWORK")?.toLowerCase() ?? null;

  if (!buildNetwork) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      buildNetwork,
      summary: "SITEFLOW_BUILD_NETWORK is required."
    };
  }

  if (buildNetwork !== "none") {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      buildNetwork,
      summary: "SITEFLOW_BUILD_NETWORK must be none for production source builds."
    };
  }

  return {
    status: "pass" as ReleaseGateCheckStatus,
    buildNetwork,
    summary: "SITEFLOW_BUILD_NETWORK disables Docker build network access."
  };
}

function workerUserRuntimeStatus(values: Record<string, string | undefined>) {
  const workerUser = normalizedEnvValue(values, "SITEFLOW_WORKER_USER") ?? "1000:1000";
  const uid = workerUser.split(":")[0]?.trim().toLowerCase();

  if (!/^[0-9]+(?::[0-9]+)?$/.test(workerUser)) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      workerUser,
      summary: "SITEFLOW_WORKER_USER must be a numeric user or user:group value."
    };
  }

  if (uid === "0") {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      workerUser,
      summary: "SITEFLOW_WORKER_USER must not run the socket-mounted production worker as root."
    };
  }

  return {
    status: "pass" as ReleaseGateCheckStatus,
    workerUser,
    summary: "SITEFLOW_WORKER_USER uses a non-root worker user."
  };
}

function dockerSocketGidRuntimeStatus(values: Record<string, string | undefined>) {
  const rawValue = normalizedEnvValue(values, "SITEFLOW_DOCKER_SOCKET_GID");

  if (!rawValue) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: "SITEFLOW_DOCKER_SOCKET_GID is required and must match /var/run/docker.sock group id on the target host."
    };
  }

  if (!/^\d+$/.test(rawValue)) {
    return {
      status: "fail" as ReleaseGateCheckStatus,
      value: null,
      summary: "SITEFLOW_DOCKER_SOCKET_GID must be a numeric group id."
    };
  }

  return {
    status: "pass" as ReleaseGateCheckStatus,
    value: Number(rawValue),
    summary: "SITEFLOW_DOCKER_SOCKET_GID is explicitly configured."
  };
}

function resolveRuntimeControlPosture(values: Record<string, string | undefined>) {
  const buildMaxArtifactBytes = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES");
  const buildMaxArtifactFiles = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_MAX_ARTIFACT_FILES");
  const buildMinFreeBytes = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_MIN_FREE_BYTES");
  const prebuiltMaxUploadBytes = positiveRuntimeIntegerStatus(values, "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES");
  const prebuiltMaxFiles = positiveRuntimeIntegerStatus(values, "SITEFLOW_PREBUILT_MAX_FILES");
  const buildStepTimeout = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_STEP_TIMEOUT_MS");
  const gitTimeout = positiveRuntimeIntegerStatus(values, "SITEFLOW_GIT_TIMEOUT_MS");
  const buildMemory = buildMemoryRuntimeStatus(values);
  const buildCpus = positiveRuntimeNumberStatus(values, "SITEFLOW_BUILD_CPUS");
  const buildPidsLimit = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_PIDS_LIMIT");
  const buildNetwork = buildNetworkRuntimeStatus(values);
  const workerUser = workerUserRuntimeStatus(values);
  const dockerSocketGid = dockerSocketGidRuntimeStatus(values);
  const checks = [
    buildMaxArtifactBytes,
    buildMaxArtifactFiles,
    buildMinFreeBytes,
    prebuiltMaxUploadBytes,
    prebuiltMaxFiles,
    buildStepTimeout,
    gitTimeout,
    buildMemory,
    buildCpus,
    buildPidsLimit,
    buildNetwork,
    workerUser,
    dockerSocketGid
  ];

  return {
    buildMaxArtifactBytesStatus: buildMaxArtifactBytes.status,
    buildMaxArtifactBytes: buildMaxArtifactBytes.value,
    buildMaxArtifactFilesStatus: buildMaxArtifactFiles.status,
    buildMaxArtifactFiles: buildMaxArtifactFiles.value,
    buildMinFreeBytesStatus: buildMinFreeBytes.status,
    buildMinFreeBytes: buildMinFreeBytes.value,
    prebuiltMaxUploadBytesStatus: prebuiltMaxUploadBytes.status,
    prebuiltMaxUploadBytes: prebuiltMaxUploadBytes.value,
    prebuiltMaxFilesStatus: prebuiltMaxFiles.status,
    prebuiltMaxFiles: prebuiltMaxFiles.value,
    buildStepTimeoutStatus: buildStepTimeout.status,
    buildStepTimeoutMs: buildStepTimeout.value,
    gitTimeoutStatus: gitTimeout.status,
    gitTimeoutMs: gitTimeout.value,
    buildMemoryStatus: buildMemory.status,
    buildMemory: buildMemory.value,
    buildCpusStatus: buildCpus.status,
    buildCpus: buildCpus.value,
    buildPidsLimitStatus: buildPidsLimit.status,
    buildPidsLimit: buildPidsLimit.value,
    buildNetworkStatus: buildNetwork.status,
    buildNetwork: buildNetwork.buildNetwork,
    workerUserStatus: workerUser.status,
    workerUser: workerUser.workerUser,
    dockerSocketGidStatus: dockerSocketGid.status,
    dockerSocketGid: dockerSocketGid.value,
    runtimeControlViolations: checks
      .filter((check) => check.status === "fail")
      .map((check) => check.summary)
  };
}

async function resolveEnvValues(root: string, envFile: string | undefined, env: NodeJS.ProcessEnv) {
  if (!envFile) {
    return { values: await resolveSecretFileEnvValues(env, root), source: "process env" };
  }

  const envPath = path.isAbsolute(envFile) ? envFile : path.join(root, envFile);
  const values = await resolveSecretFileEnvValues(
    parseReleaseGateEnvFile(await readFile(envPath, "utf8")),
    path.dirname(envPath)
  );

  return { values, source: envPath };
}

async function checkRequiredEnvironment(
  root: string,
  env: NodeJS.ProcessEnv,
  envFile: string | undefined,
  requireRuntimeEnv: boolean
): Promise<ReleaseGateCheck> {
  if (!envFile && !requireRuntimeEnv && env.SITEFLOW_ENV !== "production" && env.NODE_ENV !== "production") {
    return {
      id: "local.requiredEnv",
      label: "Required runtime env",
      status: "skipped",
      summary: "Runtime env value check skipped; pass --env-file or --require-env to validate a target environment."
    };
  }

  try {
    const { values, source } = await resolveEnvValues(root, envFile, env);
    const sourceBuildPosture = resolveSourceBuildPosture(values);
    const secretPosture = resolveProductionSecretPosture(values);
    const runtimeControls = resolveRuntimeControlPosture(values);
    const browserTokenFallbackEnvValue = normalizedEnvValue(values, "VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK") ?? null;
    const browserTokenFallbackEnabled = enabledFlag(values.VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK);
    const browserTokenFallbackStatus: ReleaseGateCheckStatus = browserTokenFallbackEnabled ? "fail" : "pass";
    const missing = requiredEnvGroups.filter((group) => {
      if (group.predicate) {
        return !group.predicate(values);
      }

      return !group.keys.some((key) => hasNonEmptyValue(values, key));
    });

    if (missing.length > 0) {
      return {
        id: "local.requiredEnv",
        label: "Required runtime env",
        status: "fail",
        summary: `Required runtime environment is incomplete in ${source}.`,
        remediation: missing.map((group) => group.summary).join(" "),
        details: {
          metricsTokenConfigured: hasSecretConfigured(values, "SITEFLOW_METRICS_TOKEN"),
          unauthenticatedMetricsAllowed: enabledFlag(values.SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS),
          apiTokenStrengthStatus: secretPosture.apiTokenStrengthStatus,
          metricsTokenStrengthStatus: secretPosture.metricsTokenStrengthStatus,
          releaseEvidenceSigningKeyStrengthStatus: secretPosture.releaseEvidenceSigningKeyStrengthStatus,
          releaseEvidenceSigningKeySource: secretPosture.releaseEvidenceSigningKeySource,
          appSecretStrengthStatus: secretPosture.appSecretStrengthStatus,
          appSecretSource: secretPosture.appSecretSource,
          gitWebhookSecretStrengthStatus: secretPosture.gitWebhookSecretStrengthStatus,
          gitWebhookSecretSources: secretPosture.gitWebhookSecretSources,
          postgresPasswordStatus: secretPosture.postgresPasswordStatus,
          postgresPasswordSource: secretPosture.postgresPasswordSource,
          browserTokenFallbackEnabled,
          browserTokenFallbackStatus,
          browserTokenFallbackEnvValue,
          sourceBuildPostureStatus: sourceBuildPosture.status,
          buildRunner: sourceBuildPosture.buildRunner,
          hostBuildException: sourceBuildPosture.hostBuildException,
          hostBuildExceptionReason: sourceBuildPosture.hostBuildExceptionReason,
          buildImage: sourceBuildPosture.buildImage,
          buildImageDigestPinned: sourceBuildPosture.buildImageDigestPinned,
          buildImageAllowlistConfigured: sourceBuildPosture.buildImageAllowlistConfigured,
          buildImageAllowedByAllowlist: sourceBuildPosture.buildImageAllowedByAllowlist,
          buildImageTaggedTrustedExceptionAccepted: sourceBuildPosture.buildImageTaggedTrustedExceptionAccepted,
          buildImagePolicyStatus: sourceBuildPosture.buildImagePolicyStatus,
          buildImagePolicy: sourceBuildPosture.buildImagePolicy,
          buildMaxArtifactBytesStatus: runtimeControls.buildMaxArtifactBytesStatus,
          buildMaxArtifactBytes: runtimeControls.buildMaxArtifactBytes,
          buildMaxArtifactFilesStatus: runtimeControls.buildMaxArtifactFilesStatus,
          buildMaxArtifactFiles: runtimeControls.buildMaxArtifactFiles,
          buildMinFreeBytesStatus: runtimeControls.buildMinFreeBytesStatus,
          buildMinFreeBytes: runtimeControls.buildMinFreeBytes,
          prebuiltMaxUploadBytesStatus: runtimeControls.prebuiltMaxUploadBytesStatus,
          prebuiltMaxUploadBytes: runtimeControls.prebuiltMaxUploadBytes,
          prebuiltMaxFilesStatus: runtimeControls.prebuiltMaxFilesStatus,
          prebuiltMaxFiles: runtimeControls.prebuiltMaxFiles,
          buildStepTimeoutStatus: runtimeControls.buildStepTimeoutStatus,
          buildStepTimeoutMs: runtimeControls.buildStepTimeoutMs,
          gitTimeoutStatus: runtimeControls.gitTimeoutStatus,
          gitTimeoutMs: runtimeControls.gitTimeoutMs,
          buildMemoryStatus: runtimeControls.buildMemoryStatus,
          buildMemory: runtimeControls.buildMemory,
          buildCpusStatus: runtimeControls.buildCpusStatus,
          buildCpus: runtimeControls.buildCpus,
          buildPidsLimitStatus: runtimeControls.buildPidsLimitStatus,
          buildPidsLimit: runtimeControls.buildPidsLimit,
          buildNetworkStatus: runtimeControls.buildNetworkStatus,
          buildNetwork: runtimeControls.buildNetwork,
          workerUserStatus: runtimeControls.workerUserStatus,
          workerUser: runtimeControls.workerUser,
          dockerSocketGidStatus: runtimeControls.dockerSocketGidStatus,
          dockerSocketGid: runtimeControls.dockerSocketGid,
          runtimeControlViolations: runtimeControls.runtimeControlViolations,
          secretStrengthViolations: secretPosture.secretStrengthViolations,
          missing: missing.map((group) => ({
            id: group.id,
            keys: group.keys
          }))
        }
      };
    }

    return {
      id: "local.requiredEnv",
      label: "Required runtime env",
      status: "pass",
      summary: `Required runtime environment is present in ${source}.`,
      details: {
        metricsTokenConfigured: hasSecretConfigured(values, "SITEFLOW_METRICS_TOKEN"),
        unauthenticatedMetricsAllowed: enabledFlag(values.SITEFLOW_ALLOW_UNAUTHENTICATED_METRICS),
        apiTokenStrengthStatus: secretPosture.apiTokenStrengthStatus,
        metricsTokenStrengthStatus: secretPosture.metricsTokenStrengthStatus,
        releaseEvidenceSigningKeyStrengthStatus: secretPosture.releaseEvidenceSigningKeyStrengthStatus,
        releaseEvidenceSigningKeySource: secretPosture.releaseEvidenceSigningKeySource,
        appSecretStrengthStatus: secretPosture.appSecretStrengthStatus,
        appSecretSource: secretPosture.appSecretSource,
        gitWebhookSecretStrengthStatus: secretPosture.gitWebhookSecretStrengthStatus,
        gitWebhookSecretSources: secretPosture.gitWebhookSecretSources,
        postgresPasswordStatus: secretPosture.postgresPasswordStatus,
        postgresPasswordSource: secretPosture.postgresPasswordSource,
        browserTokenFallbackEnabled,
        browserTokenFallbackStatus,
        browserTokenFallbackEnvValue,
        sourceBuildPostureStatus: sourceBuildPosture.status,
        buildRunner: sourceBuildPosture.buildRunner,
        hostBuildException: sourceBuildPosture.hostBuildException,
        hostBuildExceptionReason: sourceBuildPosture.hostBuildExceptionReason,
        buildImage: sourceBuildPosture.buildImage,
        buildImageDigestPinned: sourceBuildPosture.buildImageDigestPinned,
        buildImageAllowlistConfigured: sourceBuildPosture.buildImageAllowlistConfigured,
        buildImageAllowedByAllowlist: sourceBuildPosture.buildImageAllowedByAllowlist,
        buildImageTaggedTrustedExceptionAccepted: sourceBuildPosture.buildImageTaggedTrustedExceptionAccepted,
        buildImagePolicyStatus: sourceBuildPosture.buildImagePolicyStatus,
        buildImagePolicy: sourceBuildPosture.buildImagePolicy,
        buildMaxArtifactBytesStatus: runtimeControls.buildMaxArtifactBytesStatus,
        buildMaxArtifactBytes: runtimeControls.buildMaxArtifactBytes,
        buildMaxArtifactFilesStatus: runtimeControls.buildMaxArtifactFilesStatus,
        buildMaxArtifactFiles: runtimeControls.buildMaxArtifactFiles,
        buildMinFreeBytesStatus: runtimeControls.buildMinFreeBytesStatus,
        buildMinFreeBytes: runtimeControls.buildMinFreeBytes,
        prebuiltMaxUploadBytesStatus: runtimeControls.prebuiltMaxUploadBytesStatus,
        prebuiltMaxUploadBytes: runtimeControls.prebuiltMaxUploadBytes,
        prebuiltMaxFilesStatus: runtimeControls.prebuiltMaxFilesStatus,
        prebuiltMaxFiles: runtimeControls.prebuiltMaxFiles,
        buildStepTimeoutStatus: runtimeControls.buildStepTimeoutStatus,
        buildStepTimeoutMs: runtimeControls.buildStepTimeoutMs,
        gitTimeoutStatus: runtimeControls.gitTimeoutStatus,
        gitTimeoutMs: runtimeControls.gitTimeoutMs,
        buildMemoryStatus: runtimeControls.buildMemoryStatus,
        buildMemory: runtimeControls.buildMemory,
        buildCpusStatus: runtimeControls.buildCpusStatus,
        buildCpus: runtimeControls.buildCpus,
        buildPidsLimitStatus: runtimeControls.buildPidsLimitStatus,
        buildPidsLimit: runtimeControls.buildPidsLimit,
        buildNetworkStatus: runtimeControls.buildNetworkStatus,
        buildNetwork: runtimeControls.buildNetwork,
        workerUserStatus: runtimeControls.workerUserStatus,
        workerUser: runtimeControls.workerUser,
        dockerSocketGidStatus: runtimeControls.dockerSocketGidStatus,
        dockerSocketGid: runtimeControls.dockerSocketGid,
        runtimeControlViolations: runtimeControls.runtimeControlViolations
      }
    };
  } catch (error) {
    return {
      id: "local.requiredEnv",
      label: "Required runtime env",
      status: "fail",
      summary: error instanceof Error ? error.message : "Unable to read runtime env values.",
      remediation: "Pass a readable --env-file or use --require-env with process environment values."
    };
  }
}

function resolveGitHubRepository(options: ReleaseGateOptions) {
  const repo = options.repo ?? options.env?.GITHUB_REPOSITORY;

  if (!repo?.includes("/")) {
    return undefined;
  }

  const [owner, name] = repo.split("/", 2);

  if (!owner || !name) {
    return undefined;
  }

  return { owner, name };
}

function requiredStatusChecksFromResponse(body: unknown) {
  if (!body || typeof body !== "object") {
    return [];
  }

  const candidate = body as {
    contexts?: unknown;
    checks?: unknown;
  };
  const contexts = Array.isArray(candidate.contexts)
    ? candidate.contexts.filter((context): context is string => typeof context === "string")
    : [];
  const checks = Array.isArray(candidate.checks)
    ? candidate.checks
      .map((check) => {
        if (!check || typeof check !== "object") {
          return undefined;
        }

        const context = (check as { context?: unknown }).context;

        return typeof context === "string" ? context : undefined;
      })
      .filter((context): context is string => typeof context === "string")
    : [];

  return [...new Set([...contexts, ...checks])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function booleanEnabledValue(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return typeof value.enabled === "boolean" ? value.enabled : undefined;
}

function requiredPullRequestReviewsFromProtection(value: unknown) {
  if (value === null) {
    return false;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const requiredReviewCount = value.required_approving_review_count;

  if (typeof requiredReviewCount === "number") {
    return requiredReviewCount > 0;
  }

  return true;
}

function requiredStatusChecksFromProtectionResponse(body: unknown) {
  if (!isRecord(body)) {
    return [];
  }

  return requiredStatusChecksFromResponse(body.required_status_checks);
}

interface GitHubBranchProtectionHardeningEvidence {
  requiredStatusChecks: string[];
  pullRequestReviewsRequired?: boolean;
  forcePushesBlocked?: boolean;
  linearHistoryRequired?: boolean;
  signedCommitsRequired?: boolean;
  sources: string[];
}

function branchProtectionHardeningFromResponse(body: unknown): GitHubBranchProtectionHardeningEvidence {
  const evidence: GitHubBranchProtectionHardeningEvidence = {
    requiredStatusChecks: requiredStatusChecksFromProtectionResponse(body),
    sources: []
  };

  if (!isRecord(body)) {
    return evidence;
  }

  const pullRequestReviewsRequired = requiredPullRequestReviewsFromProtection(body.required_pull_request_reviews);
  const allowForcePushes = booleanEnabledValue(body.allow_force_pushes);
  const requiredLinearHistory = booleanEnabledValue(body.required_linear_history);
  const requiredSignatures = booleanEnabledValue(body.required_signatures);

  if (pullRequestReviewsRequired !== undefined) {
    evidence.pullRequestReviewsRequired = pullRequestReviewsRequired;
    evidence.sources.push("branch_protection.required_pull_request_reviews");
  }

  if (allowForcePushes !== undefined) {
    evidence.forcePushesBlocked = !allowForcePushes;
    evidence.sources.push("branch_protection.allow_force_pushes");
  }

  if (requiredLinearHistory !== undefined) {
    evidence.linearHistoryRequired = requiredLinearHistory;
    evidence.sources.push("branch_protection.required_linear_history");
  }

  if (requiredSignatures !== undefined) {
    evidence.signedCommitsRequired = requiredSignatures;
    evidence.sources.push("branch_protection.required_signatures");
  }

  return evidence;
}

function rulesetsFromResponse(body: unknown) {
  if (Array.isArray(body)) {
    return body.filter(isRecord);
  }

  if (isRecord(body) && Array.isArray(body.rulesets)) {
    return body.rulesets.filter(isRecord);
  }

  return undefined;
}

function globPatternMatches(value: string, pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  return new RegExp(`^${escaped}$`).test(value);
}

function refPatternMatchesBranch(pattern: unknown, branch: string) {
  if (typeof pattern !== "string" || !pattern.trim()) {
    return false;
  }

  const normalized = pattern.trim();
  const branchRef = `refs/heads/${branch}`;

  return normalized === "~DEFAULT_BRANCH"
    || normalized === branch
    || normalized === branchRef
    || globPatternMatches(branch, normalized)
    || globPatternMatches(branchRef, normalized);
}

function rulesetAppliesToBranch(ruleset: Record<string, unknown>, branch: string) {
  const target = typeof ruleset.target === "string" ? ruleset.target : "branch";

  if (target !== "branch") {
    return false;
  }

  const enforcement = typeof ruleset.enforcement === "string" ? ruleset.enforcement : "active";

  if (enforcement !== "active") {
    return false;
  }

  const conditions = isRecord(ruleset.conditions) ? ruleset.conditions : undefined;
  const refName = conditions && isRecord(conditions.ref_name) ? conditions.ref_name : undefined;

  if (!refName) {
    return true;
  }

  const includes = Array.isArray(refName.include) ? refName.include : [];
  const excludes = Array.isArray(refName.exclude) ? refName.exclude : [];

  if (excludes.some((pattern) => refPatternMatchesBranch(pattern, branch))) {
    return false;
  }

  return includes.length === 0 || includes.some((pattern) => refPatternMatchesBranch(pattern, branch));
}

function requiredStatusChecksFromRulesetRule(rule: Record<string, unknown>) {
  const parameters = isRecord(rule.parameters) ? rule.parameters : {};
  const requiredStatusChecks = parameters.required_status_checks;

  if (!Array.isArray(requiredStatusChecks)) {
    return [];
  }

  return requiredStatusChecks
    .map((check) => {
      if (!isRecord(check)) {
        return undefined;
      }

      const context = check.context ?? check.name;

      return typeof context === "string" ? context : undefined;
    })
    .filter((context): context is string => typeof context === "string");
}

function rulesetHardeningFromResponse(body: unknown, branch: string): GitHubBranchProtectionHardeningEvidence | undefined {
  const rulesets = rulesetsFromResponse(body);

  if (!rulesets) {
    return undefined;
  }

  const evidence: GitHubBranchProtectionHardeningEvidence = {
    requiredStatusChecks: [],
    sources: []
  };

  for (const ruleset of rulesets) {
    if (!rulesetAppliesToBranch(ruleset, branch) || !Array.isArray(ruleset.rules)) {
      continue;
    }

    const rulesetName = typeof ruleset.name === "string" ? ruleset.name : "unnamed";

    for (const rule of ruleset.rules.filter(isRecord)) {
      const type = typeof rule.type === "string" ? rule.type : undefined;

      if (!type) {
        continue;
      }

      const source = `ruleset.${rulesetName}.${type}`;

      if (type === "required_status_checks") {
        evidence.requiredStatusChecks.push(...requiredStatusChecksFromRulesetRule(rule));
        evidence.sources.push(source);
      } else if (type === "pull_request") {
        evidence.pullRequestReviewsRequired = true;
        evidence.sources.push(source);
      } else if (type === "non_fast_forward") {
        evidence.forcePushesBlocked = true;
        evidence.sources.push(source);
      } else if (type === "required_linear_history") {
        evidence.linearHistoryRequired = true;
        evidence.sources.push(source);
      } else if (type === "required_signatures") {
        evidence.signedCommitsRequired = true;
        evidence.sources.push(source);
      }
    }
  }

  evidence.requiredStatusChecks = [...new Set(evidence.requiredStatusChecks)];
  evidence.sources = [...new Set(evidence.sources)];

  return evidence;
}

function mergeHardeningEvidence(
  left: GitHubBranchProtectionHardeningEvidence,
  right: GitHubBranchProtectionHardeningEvidence
): GitHubBranchProtectionHardeningEvidence {
  return {
    requiredStatusChecks: [...new Set([...left.requiredStatusChecks, ...right.requiredStatusChecks])],
    pullRequestReviewsRequired: left.pullRequestReviewsRequired === true || right.pullRequestReviewsRequired === true
      ? true
      : left.pullRequestReviewsRequired ?? right.pullRequestReviewsRequired,
    forcePushesBlocked: left.forcePushesBlocked === true || right.forcePushesBlocked === true
      ? true
      : left.forcePushesBlocked ?? right.forcePushesBlocked,
    linearHistoryRequired: left.linearHistoryRequired === true || right.linearHistoryRequired === true
      ? true
      : left.linearHistoryRequired ?? right.linearHistoryRequired,
    signedCommitsRequired: left.signedCommitsRequired === true || right.signedCommitsRequired === true
      ? true
      : left.signedCommitsRequired ?? right.signedCommitsRequired,
    sources: [...new Set([...left.sources, ...right.sources])]
  };
}

function hardeningFailures(evidence: GitHubBranchProtectionHardeningEvidence, requiredStatusCheck: string) {
  const failures: string[] = [];

  if (!evidence.requiredStatusChecks.includes(requiredStatusCheck)) {
    failures.push(`required status check ${requiredStatusCheck}`);
  }

  if (evidence.pullRequestReviewsRequired === false) {
    failures.push("required pull request reviews");
  }

  if (evidence.forcePushesBlocked === false) {
    failures.push("force-push prohibition");
  }

  if (evidence.linearHistoryRequired === false) {
    failures.push("required linear history");
  }

  if (evidence.signedCommitsRequired === false) {
    failures.push("signed commits");
  }

  return failures;
}

function hardeningUnknowns(evidence: GitHubBranchProtectionHardeningEvidence) {
  const unknowns: string[] = [];

  if (evidence.pullRequestReviewsRequired === undefined) {
    unknowns.push("required pull request reviews");
  }

  if (evidence.forcePushesBlocked === undefined) {
    unknowns.push("force-push prohibition");
  }

  if (evidence.linearHistoryRequired === undefined) {
    unknowns.push("required linear history");
  }

  return unknowns;
}

interface GitHubCheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl?: string;
}

function checkRunsFromResponse(body: unknown): GitHubCheckRunSummary[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const candidate = body as { check_runs?: unknown };

  if (!Array.isArray(candidate.check_runs)) {
    return [];
  }

  return candidate.check_runs
    .map((run) => {
      if (!run || typeof run !== "object") {
        return undefined;
      }

      const value = run as {
        name?: unknown;
        status?: unknown;
        conclusion?: unknown;
        html_url?: unknown;
      };

      if (typeof value.name !== "string" || typeof value.status !== "string") {
        return undefined;
      }

      return {
        name: value.name,
        status: value.status,
        conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
        ...(typeof value.html_url === "string" ? { htmlUrl: value.html_url } : {})
      };
    })
    .filter((run): run is GitHubCheckRunSummary => run !== undefined);
}

function resolveRequiredStatusCheck(options: ReleaseGateOptions, env: NodeJS.ProcessEnv) {
  return (options.requiredStatusCheck ?? env.SITEFLOW_REQUIRED_STATUS_CHECK ?? defaultRequiredStatusCheck).trim()
    || defaultRequiredStatusCheck;
}

function isFullGitSha(value: string | undefined) {
  return Boolean(value && fullGitShaPattern.test(value));
}

async function resolveCommitSha(
  root: string,
  options: ReleaseGateOptions,
  env: NodeJS.ProcessEnv,
  runner: ReleaseGateCommandRunner
) {
  const explicitSha = options.commitSha ?? env.GITHUB_SHA;

  if (explicitSha?.trim()) {
    return explicitSha.trim();
  }

  const result = await runner("git", ["rev-parse", "HEAD"], { cwd: root });

  if (result.exitCode !== 0) {
    return undefined;
  }

  return result.stdout.trim() || undefined;
}

async function checkGitHubBranchProtection(options: ReleaseGateOptions): Promise<ReleaseGateCheck> {
  const env = options.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  const repository = resolveGitHubRepository(options);
  const branch = options.branch ?? "main";
  const requiredStatusCheck = resolveRequiredStatusCheck(options, env);

  if (!token || !repository) {
    return {
      id: "external.githubBranchProtection",
      label: "GitHub branch protection",
      status: "manual_required",
      summary: "GITHUB_TOKEN and GITHUB_REPOSITORY/--repo were not both available; branch protection was not verified.",
      remediation: "Verify that main requires the CI status check, or pass --allow-manual-branch-protection for a static sanity check.",
      details: {
        branch,
        requiredStatusCheck,
        hasToken: Boolean(token),
        hasRepository: Boolean(repository)
      }
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`;
  const repositoryName = `${repository.owner}/${repository.name}`;
  const requestHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28"
  };

  try {
    const response = await fetchImpl(url, {
      headers: requestHeaders
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;

      return {
        id: "external.githubBranchProtection",
        label: "GitHub branch protection",
        status: options.promotion ? "manual_required" : "fail",
        summary: body?.message ?? `GitHub branch protection check failed with HTTP ${response.status}.`,
        remediation: "Require CI status checks on the main branch before release promotion.",
        details: {
          branch,
          repository: repositoryName,
          requiredStatusCheck,
          httpStatus: response.status
        }
      };
    }

    const requiredStatusChecks = requiredStatusChecksFromResponse(await response.json());
    let hardeningEvidence: GitHubBranchProtectionHardeningEvidence = {
      requiredStatusChecks,
      sources: requiredStatusChecks.length > 0 ? ["branch_protection.required_status_checks"] : []
    };

    if (requiredStatusChecks.length === 0) {
      return {
        id: "external.githubBranchProtection",
        label: "GitHub branch protection",
        status: "fail",
        summary: `GitHub branch protection for ${branch} has no required status checks.`,
        remediation: "Require the CI workflow job before merging to main.",
        details: {
          branch,
          repository: repositoryName,
          requiredStatusCheck
        }
      };
    }

    if (!requiredStatusChecks.includes(requiredStatusCheck)) {
      return {
        id: "external.githubBranchProtection",
        label: "GitHub branch protection",
        status: "fail",
        summary: `GitHub branch protection for ${branch} does not require the expected CI check: ${requiredStatusCheck}.`,
        remediation: "Require the SiteFlow CI workflow job before merging to main, or pass --required-status-check with the actual protected check name.",
        details: {
          branch,
          repository: repositoryName,
          requiredStatusCheck,
          requiredStatusChecks
        }
      };
    }

    const explicitCommitRef = options.commitSha ?? env.GITHUB_SHA;
    const skipPromotionHardening = Boolean(options.promotion && explicitCommitRef && !isFullGitSha(explicitCommitRef));

    if (options.promotion && !skipPromotionHardening) {
      const apiIssues: string[] = [];
      const protectionUrl = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches/${encodeURIComponent(branch)}/protection`;
      const protectionResponse = await fetchImpl(protectionUrl, {
        headers: requestHeaders
      });

      if (protectionResponse.ok) {
        hardeningEvidence = mergeHardeningEvidence(
          hardeningEvidence,
          branchProtectionHardeningFromResponse(await protectionResponse.json())
        );
      } else {
        const body = (await protectionResponse.json().catch(() => undefined)) as { message?: string } | undefined;
        apiIssues.push(body?.message ?? `GitHub branch protection hardening check failed with HTTP ${protectionResponse.status}.`);
      }

      let failures = hardeningFailures(hardeningEvidence, requiredStatusCheck);
      let unknowns = hardeningUnknowns(hardeningEvidence);

      if (failures.length > 0 || unknowns.length > 0) {
        const rulesetsUrl = new URL(
          `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/rulesets`
        );
        rulesetsUrl.searchParams.set("targets", "branch");
        rulesetsUrl.searchParams.set("includes_parents", "true");

        const rulesetsResponse = await fetchImpl(rulesetsUrl, {
          headers: requestHeaders
        });

        if (rulesetsResponse.ok) {
          const rulesetEvidence = rulesetHardeningFromResponse(await rulesetsResponse.json(), branch);

          if (rulesetEvidence) {
            hardeningEvidence = mergeHardeningEvidence(hardeningEvidence, rulesetEvidence);
          } else {
            apiIssues.push("GitHub rulesets response did not include a parseable ruleset list.");
          }
        } else {
          const body = (await rulesetsResponse.json().catch(() => undefined)) as { message?: string } | undefined;
          apiIssues.push(body?.message ?? `GitHub rulesets check failed with HTTP ${rulesetsResponse.status}.`);
        }

        failures = hardeningFailures(hardeningEvidence, requiredStatusCheck);
        unknowns = hardeningUnknowns(hardeningEvidence);
      }

      const details = {
        branch,
        repository: repositoryName,
        requiredStatusCheck,
        requiredStatusChecks: hardeningEvidence.requiredStatusChecks,
        pullRequestReviewsRequired: hardeningEvidence.pullRequestReviewsRequired ?? null,
        forcePushesBlocked: hardeningEvidence.forcePushesBlocked ?? null,
        linearHistoryRequired: hardeningEvidence.linearHistoryRequired ?? null,
        signedCommitsRequired: hardeningEvidence.signedCommitsRequired ?? null,
        hardeningSources: hardeningEvidence.sources,
        ...(unknowns.length > 0 ? { hardeningUnknowns: unknowns } : {}),
        ...(failures.length > 0 ? { hardeningFailures: failures } : {}),
        ...(apiIssues.length > 0 ? { apiIssues } : {})
      };

      if (failures.length > 0) {
        return {
          id: "external.githubBranchProtection",
          label: "GitHub branch protection",
          status: "fail",
          summary: `GitHub branch protection or rulesets for ${branch} do not satisfy production promotion hardening: ${failures.join(", ")}.`,
          remediation: "Require CI status checks, pull request reviews, non-fast-forward protection, and linear history before promotion.",
          details
        };
      }

      if (unknowns.length > 0) {
        return {
          id: "external.githubBranchProtection",
          label: "GitHub branch protection",
          status: "manual_required",
          summary: `GitHub branch protection or rulesets for ${branch} could not prove production promotion hardening: ${[...unknowns, ...apiIssues].join(", ")}.`,
          remediation: "Retry with a token that can read branch protection and rulesets, or block promotion until the repository policy is manually verified.",
          details
        };
      }
    }

    return {
      id: "external.githubBranchProtection",
      label: "GitHub branch protection",
      status: "pass",
      summary: `GitHub branch protection for ${branch} requires expected CI check: ${requiredStatusCheck}.`,
      details: {
        branch,
        repository: repositoryName,
        requiredStatusCheck,
        requiredStatusChecks: hardeningEvidence.requiredStatusChecks,
        ...(hardeningEvidence.pullRequestReviewsRequired !== undefined
          ? { pullRequestReviewsRequired: hardeningEvidence.pullRequestReviewsRequired }
          : {}),
        ...(hardeningEvidence.forcePushesBlocked !== undefined
          ? { forcePushesBlocked: hardeningEvidence.forcePushesBlocked }
          : {}),
        ...(hardeningEvidence.linearHistoryRequired !== undefined
          ? { linearHistoryRequired: hardeningEvidence.linearHistoryRequired }
          : {}),
        ...(hardeningEvidence.signedCommitsRequired !== undefined
          ? { signedCommitsRequired: hardeningEvidence.signedCommitsRequired }
          : {}),
        ...(hardeningEvidence.sources.length > 0 ? { hardeningSources: hardeningEvidence.sources } : {})
      }
    };
  } catch (error) {
    return {
      id: "external.githubBranchProtection",
      label: "GitHub branch protection",
      status: options.promotion ? "manual_required" : "fail",
      summary: error instanceof Error ? error.message : "Unable to verify GitHub branch protection.",
      remediation: "Retry with network access or verify branch protection manually before release.",
      details: {
        branch,
        repository: repositoryName,
        requiredStatusCheck
      }
    };
  }
}

function branchHeadShaFromResponse(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const value = body as { commit?: unknown };

  if (!value.commit || typeof value.commit !== "object" || Array.isArray(value.commit)) {
    return undefined;
  }

  const commit = value.commit as { sha?: unknown };

  return typeof commit.sha === "string" && commit.sha.trim()
    ? commit.sha.trim()
    : undefined;
}

async function checkGitHubProtectedBranchCommit(
  root: string,
  options: ReleaseGateOptions,
  runner: ReleaseGateCommandRunner
): Promise<ReleaseGateCheck> {
  const required = Boolean(options.promotion || options.requireCommitStatus);
  const env = options.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  const repository = resolveGitHubRepository(options);
  const branch = options.branch ?? "main";
  const commitSha = await resolveCommitSha(root, options, env, runner);

  if (!required) {
    return {
      id: "external.githubProtectedBranchCommit",
      label: "GitHub protected branch commit",
      status: "skipped",
      summary: "Protected branch head binding skipped; pass --require-commit-status or --promotion to verify the release commit is the protected branch head."
    };
  }

  if (!token || !repository || !commitSha) {
    return {
      id: "external.githubProtectedBranchCommit",
      label: "GitHub protected branch commit",
      status: "manual_required",
      summary: "GITHUB_TOKEN, GITHUB_REPOSITORY/--repo, and a commit SHA were not all available; protected branch head binding was not verified.",
      remediation: "Set GITHUB_TOKEN and GITHUB_REPOSITORY, and pass a full --commit-ref for the protected release branch before production promotion.",
      details: {
        branch,
        ...(repository ? { repository: `${repository.owner}/${repository.name}` } : {}),
        ...(commitSha ? { commitSha } : {}),
        hasToken: Boolean(token),
        hasRepository: Boolean(repository),
        hasCommitSha: Boolean(commitSha)
      }
    };
  }

  if (!isFullGitSha(commitSha)) {
    return {
      id: "external.githubProtectedBranchCommit",
      label: "GitHub protected branch commit",
      status: "fail",
      summary: "--commit-ref must be a canonical 40-character Git SHA for production promotion.",
      remediation: "Resolve the release commit with git rev-parse HEAD and rerun release-gate with the full SHA.",
      details: {
        branch,
        repository: `${repository.owner}/${repository.name}`,
        commitSha
      }
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches/${encodeURIComponent(branch)}`;

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28"
      }
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;

      return {
        id: "external.githubProtectedBranchCommit",
        label: "GitHub protected branch commit",
        status: "fail",
        summary: body?.message ?? `GitHub branch head check failed with HTTP ${response.status}.`,
        remediation: "Verify that the release commit is the current head of the protected branch before promotion.",
        details: {
          branch,
          repository: `${repository.owner}/${repository.name}`,
          commitSha,
          httpStatus: response.status
        }
      };
    }

    const branchHeadSha = branchHeadShaFromResponse(await response.json());

    if (!branchHeadSha) {
      return {
        id: "external.githubProtectedBranchCommit",
        label: "GitHub protected branch commit",
        status: "fail",
        summary: "GitHub branch response did not include a branch head commit SHA.",
        remediation: "Retry with a token that can read the protected branch metadata.",
        details: {
          branch,
          repository: `${repository.owner}/${repository.name}`,
          commitSha
        }
      };
    }

    if (branchHeadSha !== commitSha) {
      return {
        id: "external.githubProtectedBranchCommit",
        label: "GitHub protected branch commit",
        status: "fail",
        summary: `Release commit ${commitSha} is not the current head of protected branch ${branch}.`,
        remediation: "Promote only the exact commit currently protected on the release branch, or update the branch and rerun CI/preflight.",
        details: {
          branch,
          repository: `${repository.owner}/${repository.name}`,
          commitSha,
          branchHeadSha
        }
      };
    }

    return {
      id: "external.githubProtectedBranchCommit",
      label: "GitHub protected branch commit",
      status: "pass",
      summary: `Release commit ${commitSha} is the current head of protected branch ${branch}.`,
      details: {
        branch,
        repository: `${repository.owner}/${repository.name}`,
        commitSha,
        branchHeadSha
      }
    };
  } catch (error) {
    return {
      id: "external.githubProtectedBranchCommit",
      label: "GitHub protected branch commit",
      status: "fail",
      summary: error instanceof Error ? error.message : "Unable to verify GitHub protected branch commit.",
      remediation: "Retry with network access or verify the protected branch head manually before release.",
      details: {
        branch,
        repository: `${repository.owner}/${repository.name}`,
        commitSha
      }
    };
  }
}

async function checkGitHubCommitStatus(
  root: string,
  options: ReleaseGateOptions,
  runner: ReleaseGateCommandRunner
): Promise<ReleaseGateCheck> {
  const required = Boolean(options.promotion || options.requireCommitStatus);
  const env = options.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  const repository = resolveGitHubRepository(options);
  const requiredStatusCheck = resolveRequiredStatusCheck(options, env);
  const commitSha = await resolveCommitSha(root, options, env, runner);

  if (!required) {
    return {
      id: "external.githubCommitStatus",
      label: "GitHub commit status",
      status: "skipped",
      summary: "Exact commit status check skipped; pass --require-commit-status or --promotion to verify the release commit."
    };
  }

  if (!token || !repository || !commitSha) {
    return {
      id: "external.githubCommitStatus",
      label: "GitHub commit status",
      status: "manual_required",
      summary: "GITHUB_TOKEN, GITHUB_REPOSITORY/--repo, and a commit SHA were not all available; exact release commit status was not verified.",
      remediation: "Set GITHUB_TOKEN and GITHUB_REPOSITORY, and pass --commit-ref or run from the exact Git checkout before production promotion.",
      details: {
        requiredStatusCheck,
        ...(repository ? { repository: `${repository.owner}/${repository.name}` } : {}),
        ...(commitSha ? { commitSha } : {}),
        hasToken: Boolean(token),
        hasRepository: Boolean(repository),
        hasCommitSha: Boolean(commitSha)
      }
    };
  }

  if (!isFullGitSha(commitSha)) {
    return {
      id: "external.githubCommitStatus",
      label: "GitHub commit status",
      status: "fail",
      summary: "--commit-ref must be a canonical 40-character Git SHA before exact commit status can be verified.",
      remediation: "Resolve the release commit with git rev-parse HEAD and rerun release-gate with the full SHA.",
      details: {
        requiredStatusCheck,
        repository: `${repository.owner}/${repository.name}`,
        commitSha
      }
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(commitSha)}/check-runs`
  );
  url.searchParams.set("check_name", requiredStatusCheck);

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28"
      }
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;

      return {
        id: "external.githubCommitStatus",
        label: "GitHub commit status",
        status: "fail",
        summary: body?.message ?? `GitHub commit status check failed with HTTP ${response.status}.`,
        remediation: "Verify that GitHub Actions completed successfully on the exact release commit before promotion.",
        details: {
          repository: `${repository.owner}/${repository.name}`,
          commitSha,
          requiredStatusCheck,
          httpStatus: response.status
        }
      };
    }

    const checkRuns = checkRunsFromResponse(await response.json());
    const matching = checkRuns.filter((run) => run.name === requiredStatusCheck);
    const successful = matching.find((run) => run.status === "completed" && run.conclusion === "success");

    if (!successful) {
      return {
        id: "external.githubCommitStatus",
        label: "GitHub commit status",
        status: "fail",
        summary: matching.length === 0
          ? `No GitHub check run named ${requiredStatusCheck} was found for the release commit.`
          : `GitHub check run ${requiredStatusCheck} has not completed successfully for the release commit.`,
        remediation: "Wait for the expected CI check to pass on the exact release commit before promotion.",
        details: {
          repository: `${repository.owner}/${repository.name}`,
          commitSha,
          requiredStatusCheck,
          checkRuns: matching
        }
      };
    }

    return {
      id: "external.githubCommitStatus",
      label: "GitHub commit status",
      status: "pass",
      summary: `GitHub check run ${requiredStatusCheck} passed on release commit ${commitSha}.`,
      details: {
        repository: `${repository.owner}/${repository.name}`,
        commitSha,
        requiredStatusCheck,
        checkRun: successful
      }
    };
  } catch (error) {
    return {
      id: "external.githubCommitStatus",
      label: "GitHub commit status",
      status: "fail",
      summary: error instanceof Error ? error.message : "Unable to verify GitHub commit status.",
      remediation: "Retry with network access or verify the exact release commit status manually before release.",
      details: {
        repository: `${repository.owner}/${repository.name}`,
        commitSha,
        requiredStatusCheck
      }
    };
  }
}

function getCheck(checks: ReleaseGateCheck[], id: string) {
  return checks.find((check) => check.id === id);
}

function detailString(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];

  return typeof value === "string" ? value : undefined;
}

function detailStringArray(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];

  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function detailCheckRun(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as GitHubCheckRunSummary;

  return typeof candidate.name === "string" && typeof candidate.status === "string"
    ? candidate
    : undefined;
}

function detailCheckRuns(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const checkRuns = value.filter((item): item is GitHubCheckRunSummary => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }

    const candidate = item as GitHubCheckRunSummary;

    return typeof candidate.name === "string" && typeof candidate.status === "string";
  });

  return checkRuns.length > 0 ? checkRuns : undefined;
}

function detailBoolean(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];

  return typeof value === "boolean" ? value : undefined;
}

function detailNumber(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];

  return typeof value === "number" ? value : undefined;
}

function buildReleaseGatePromotionEvidence(
  status: ReleaseGateStatus,
  checkedAt: string,
  checks: ReleaseGateCheck[],
  options: ReleaseGateOptions,
  env: NodeJS.ProcessEnv
): ReleaseGatePromotionEvidence {
  const repository = resolveGitHubRepository({ ...options, env });
  const repositoryName = repository ? `${repository.owner}/${repository.name}` : undefined;
  const branch = options.branch ?? "main";
  const requiredStatusCheck = resolveRequiredStatusCheck(options, env);
  const branchProtection = getCheck(checks, "external.githubBranchProtection");
  const protectedBranchCommit = getCheck(checks, "external.githubProtectedBranchCommit");
  const commitStatus = getCheck(checks, "external.githubCommitStatus");
  const runtimeEnv = getCheck(checks, "local.requiredEnv");
  const gitStatus = getCheck(checks, "local.gitStatus");
  const manualRequiredCheckIds = checks
    .filter((check) => check.status === "manual_required")
    .map((check) => check.id);
  const commitRef = detailString(commitStatus?.details, "commitSha")
    ?? options.commitSha
    ?? env.GITHUB_SHA;
  const dirtyValue = detailBoolean(gitStatus?.details, "dirty");
  const dirty = dirtyValue ?? (gitStatus?.status === "manual_required" ? null : false);

  return {
    gateStatus: status,
    checkedAt,
    promotion: Boolean(options.promotion),
    ...(commitRef ? { commitRef } : {}),
    ...(repositoryName ? { repository: repositoryName } : {}),
    branch,
    requiredStatusCheck,
    branchProtection: {
      status: branchProtection?.status ?? "skipped",
      repository: detailString(branchProtection?.details, "repository") ?? repositoryName,
      branch: detailString(branchProtection?.details, "branch") ?? branch,
      requiredStatusCheck: detailString(branchProtection?.details, "requiredStatusCheck") ?? requiredStatusCheck,
      ...(detailStringArray(branchProtection?.details, "requiredStatusChecks")
        ? { requiredStatusChecks: detailStringArray(branchProtection?.details, "requiredStatusChecks") }
        : {}),
      pullRequestReviewsRequired: detailBoolean(branchProtection?.details, "pullRequestReviewsRequired") ?? null,
      forcePushesBlocked: detailBoolean(branchProtection?.details, "forcePushesBlocked") ?? null,
      linearHistoryRequired: detailBoolean(branchProtection?.details, "linearHistoryRequired") ?? null,
      signedCommitsRequired: detailBoolean(branchProtection?.details, "signedCommitsRequired") ?? null,
      ...(detailStringArray(branchProtection?.details, "hardeningSources")
        ? { hardeningSources: detailStringArray(branchProtection?.details, "hardeningSources") }
        : {}),
      ...(detailStringArray(branchProtection?.details, "hardeningUnknowns")
        ? { hardeningUnknowns: detailStringArray(branchProtection?.details, "hardeningUnknowns") }
        : {}),
      ...(detailStringArray(branchProtection?.details, "hardeningFailures")
        ? { hardeningFailures: detailStringArray(branchProtection?.details, "hardeningFailures") }
        : {})
    },
    protectedBranchCommit: {
      status: protectedBranchCommit?.status ?? "skipped",
      repository: detailString(protectedBranchCommit?.details, "repository") ?? repositoryName,
      branch: detailString(protectedBranchCommit?.details, "branch") ?? branch,
      ...(commitRef ? { commitRef } : {}),
      ...(detailString(protectedBranchCommit?.details, "branchHeadSha")
        ? { branchHeadSha: detailString(protectedBranchCommit?.details, "branchHeadSha") }
        : {})
    },
    commitStatus: {
      status: commitStatus?.status ?? "skipped",
      repository: detailString(commitStatus?.details, "repository") ?? repositoryName,
      ...(commitRef ? { commitRef } : {}),
      requiredStatusCheck: detailString(commitStatus?.details, "requiredStatusCheck") ?? requiredStatusCheck,
      ...(detailCheckRun(commitStatus?.details, "checkRun")
        ? { checkRun: detailCheckRun(commitStatus?.details, "checkRun") }
        : {}),
      ...(detailCheckRuns(commitStatus?.details, "checkRuns")
        ? { checkRuns: detailCheckRuns(commitStatus?.details, "checkRuns") }
        : {})
    },
    manualRequired: manualRequiredCheckIds.length > 0,
    manualRequiredCheckIds,
    runtimeEnv: {
      status: runtimeEnv?.status ?? "skipped",
      summary: runtimeEnv?.summary ?? "Runtime env validation was not run.",
      metricsTokenConfigured: detailBoolean(runtimeEnv?.details, "metricsTokenConfigured") ?? null,
      unauthenticatedMetricsAllowed: detailBoolean(runtimeEnv?.details, "unauthenticatedMetricsAllowed") ?? null,
      apiTokenStrengthStatus: runtimeEnv?.details?.apiTokenStrengthStatus as ReleaseGateCheckStatus | undefined ?? null,
      metricsTokenStrengthStatus: runtimeEnv?.details?.metricsTokenStrengthStatus as ReleaseGateCheckStatus | undefined ?? null,
      releaseEvidenceSigningKeyStrengthStatus: runtimeEnv?.details?.releaseEvidenceSigningKeyStrengthStatus as ReleaseGateCheckStatus | undefined ?? null,
      releaseEvidenceSigningKeySource: detailString(runtimeEnv?.details, "releaseEvidenceSigningKeySource") ?? null,
      appSecretStrengthStatus: runtimeEnv?.details?.appSecretStrengthStatus as ReleaseGateCheckStatus | undefined ?? null,
      appSecretSource: detailString(runtimeEnv?.details, "appSecretSource") ?? null,
      gitWebhookSecretStrengthStatus: runtimeEnv?.details?.gitWebhookSecretStrengthStatus as ReleaseGateCheckStatus | undefined ?? null,
      gitWebhookSecretSources: detailStringArray(runtimeEnv?.details, "gitWebhookSecretSources") ?? [],
      postgresPasswordStatus: runtimeEnv?.details?.postgresPasswordStatus as ReleaseGateCheckStatus | undefined ?? null,
      postgresPasswordSource: detailString(runtimeEnv?.details, "postgresPasswordSource") ?? null,
      browserTokenFallbackEnabled: detailBoolean(runtimeEnv?.details, "browserTokenFallbackEnabled") ?? null,
      browserTokenFallbackStatus: runtimeEnv?.details?.browserTokenFallbackStatus as ReleaseGateCheckStatus | undefined ?? null,
      browserTokenFallbackEnvValue: detailString(runtimeEnv?.details, "browserTokenFallbackEnvValue") ?? null,
      sourceBuildPostureStatus: runtimeEnv?.details?.sourceBuildPostureStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildRunner: detailString(runtimeEnv?.details, "buildRunner") ?? null,
      hostBuildException: detailBoolean(runtimeEnv?.details, "hostBuildException") ?? null,
      hostBuildExceptionReason: detailString(runtimeEnv?.details, "hostBuildExceptionReason") ?? null,
      buildImage: detailString(runtimeEnv?.details, "buildImage") ?? null,
      buildImageDigestPinned: detailBoolean(runtimeEnv?.details, "buildImageDigestPinned") ?? null,
      buildImageAllowlistConfigured: detailBoolean(runtimeEnv?.details, "buildImageAllowlistConfigured") ?? null,
      buildImageAllowedByAllowlist: detailBoolean(runtimeEnv?.details, "buildImageAllowedByAllowlist") ?? null,
      buildImageTaggedTrustedExceptionAccepted: detailBoolean(runtimeEnv?.details, "buildImageTaggedTrustedExceptionAccepted") ?? null,
      buildImagePolicyStatus: runtimeEnv?.details?.buildImagePolicyStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildImagePolicy: detailString(runtimeEnv?.details, "buildImagePolicy") ?? null,
      buildMaxArtifactBytesStatus: runtimeEnv?.details?.buildMaxArtifactBytesStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildMaxArtifactBytes: detailNumber(runtimeEnv?.details, "buildMaxArtifactBytes") ?? null,
      buildMaxArtifactFilesStatus: runtimeEnv?.details?.buildMaxArtifactFilesStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildMaxArtifactFiles: detailNumber(runtimeEnv?.details, "buildMaxArtifactFiles") ?? null,
      buildMinFreeBytesStatus: runtimeEnv?.details?.buildMinFreeBytesStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildMinFreeBytes: detailNumber(runtimeEnv?.details, "buildMinFreeBytes") ?? null,
      prebuiltMaxUploadBytesStatus: runtimeEnv?.details?.prebuiltMaxUploadBytesStatus as ReleaseGateCheckStatus | undefined ?? null,
      prebuiltMaxUploadBytes: detailNumber(runtimeEnv?.details, "prebuiltMaxUploadBytes") ?? null,
      prebuiltMaxFilesStatus: runtimeEnv?.details?.prebuiltMaxFilesStatus as ReleaseGateCheckStatus | undefined ?? null,
      prebuiltMaxFiles: detailNumber(runtimeEnv?.details, "prebuiltMaxFiles") ?? null,
      buildStepTimeoutStatus: runtimeEnv?.details?.buildStepTimeoutStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildStepTimeoutMs: detailNumber(runtimeEnv?.details, "buildStepTimeoutMs") ?? null,
      gitTimeoutStatus: runtimeEnv?.details?.gitTimeoutStatus as ReleaseGateCheckStatus | undefined ?? null,
      gitTimeoutMs: detailNumber(runtimeEnv?.details, "gitTimeoutMs") ?? null,
      buildMemoryStatus: runtimeEnv?.details?.buildMemoryStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildMemory: detailString(runtimeEnv?.details, "buildMemory") ?? null,
      buildCpusStatus: runtimeEnv?.details?.buildCpusStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildCpus: detailNumber(runtimeEnv?.details, "buildCpus") ?? null,
      buildPidsLimitStatus: runtimeEnv?.details?.buildPidsLimitStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildPidsLimit: detailNumber(runtimeEnv?.details, "buildPidsLimit") ?? null,
      buildNetworkStatus: runtimeEnv?.details?.buildNetworkStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildNetwork: detailString(runtimeEnv?.details, "buildNetwork") ?? null,
      workerUserStatus: runtimeEnv?.details?.workerUserStatus as ReleaseGateCheckStatus | undefined ?? null,
      workerUser: detailString(runtimeEnv?.details, "workerUser") ?? null,
      dockerSocketGidStatus: runtimeEnv?.details?.dockerSocketGidStatus as ReleaseGateCheckStatus | undefined ?? null,
      dockerSocketGid: detailNumber(runtimeEnv?.details, "dockerSocketGid") ?? null,
      ...(runtimeEnv?.details?.runtimeControlViolations ? { runtimeControlViolations: runtimeEnv.details.runtimeControlViolations } : {}),
      ...(runtimeEnv?.details?.secretStrengthViolations ? { secretStrengthViolations: runtimeEnv.details.secretStrengthViolations } : {}),
      ...(runtimeEnv?.details?.missing ? { missing: runtimeEnv.details.missing } : {})
    },
    dirtyWorktree: {
      status: gitStatus?.status ?? "skipped",
      dirty,
      entries: detailStringArray(gitStatus?.details, "status") ?? [],
      entryCount: detailNumber(gitStatus?.details, "entryCount") ?? null,
      truncated: detailBoolean(gitStatus?.details, "truncated") ?? false,
      summary: gitStatus?.summary ?? "Git worktree status was not checked."
    }
  };
}

export async function runReleaseGate(options: ReleaseGateOptions = {}): Promise<ReleaseGateReport> {
  const root = path.resolve(options.root ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultReleaseGateRunner;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const promotion = Boolean(options.promotion);
  const allowDirty = !promotion && Boolean(options.allowDirty);
  const checks = await Promise.all([
    checkCiWorkflow(root),
    checkReleasePreflightWorkflow(root),
    checkReleaseImageWorkflow(root),
    checkPackageScripts(root),
    checkProductionDocs(root),
    checkProductionCompose(root),
    checkReleaseSourceTree(root, runner),
    checkGitStatus(root, runner, allowDirty),
    checkRequiredEnvironment(root, env, options.envFile, Boolean(options.requireRuntimeEnv || promotion))
  ]);

  checks.push(await checkGitHubBranchProtection({ ...options, env }));
  checks.push(await checkGitHubProtectedBranchCommit(root, { ...options, env }, runner));
  checks.push(await checkGitHubCommitStatus(root, { ...options, env }, runner));
  const status = aggregateReleaseGateStatus(checks, !promotion && Boolean(options.allowManualBranchProtection));

  return {
    status,
    root,
    checkedAt,
    promotionEvidence: buildReleaseGatePromotionEvidence(status, checkedAt, checks, options, env),
    checks
  };
}

export function formatReleaseGateReport(report: ReleaseGateReport) {
  const lines = [`SiteFlow release gate: ${report.status.toUpperCase()}`];

  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.summary}`);

    if (check.remediation) {
      lines.push(`  Remediation: ${check.remediation}`);
    }
  }

  return lines.join("\n");
}
