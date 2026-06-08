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
    appSecretStrengthStatus: ReleaseGateCheckStatus | null;
    appSecretSource: string | null;
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
    buildNetworkStatus: ReleaseGateCheckStatus | null;
    buildNetwork: string | null;
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

const ciWorkflowPath = path.join(".github", "workflows", "ci.yml");
const releasePreflightWorkflowPath = path.join(".github", "workflows", "release-preflight.yml");
const productionDocsPath = path.join("docs", "production-readiness.md");
const productionComposePath = "docker-compose.production.yml";
const productionDeploymentDocPath = path.join("docs", "deployment", "production-single-host.md");
const requiredCiCommands = [
  "npm ci",
  "release:dependency:policy",
  "release:source:check",
  "npm test",
  "npm run build",
  "release:artifacts:check",
  "npm run test:e2e",
  "release-gate --allow-dirty --allow-manual-branch-protection"
];
const requiredReleasePreflightTerms = [
  "workflow_dispatch",
  "direct_api_url:",
  "release_image_run_id:",
  "trust_proxy_policy:",
  "api_instance_count:",
  "api_process_count:",
  "ingress_count:",
  "api_rate_limit_scope:",
  "api_rate_limit_enforcement_point:",
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
  "release_image_run_id",
  "SITEFLOW_RELEASE_GITHUB_TOKEN",
  "GH_TOKEN",
  "--set-env direct-api-url",
  "--set-env release-image-run-id",
  "--set-env SITEFLOW_TRUST_PROXY",
  "--set-env api-instance-count",
  "--set-env api-process-count",
  "--set-env ingress-count",
  "--set-env api-rate-limit-scope",
  "--set-env api-rate-limit-enforcement-point",
  "SITEFLOW_TARGET_ENV_FILE",
  "actions: read",
  "actions/upload-artifact",
  "rm -f \"$SITEFLOW_TARGET_ENV_FILE\"",
  "repo input must match",
  "build_image must be pinned",
  "release:dependency:policy",
  "release:source:check",
  "npm run build"
];
const requiredReleasePreflightCommandTerms = [
  {
    command: "release:evidence:target-run",
    terms: ["--pack", "--confirm-target-environment", "--run-record", "--gap-report-dir"]
  },
  {
    command: "release:evidence:gaps",
    terms: ["--pack"]
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
  "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
  "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
  "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
  "SITEFLOW_PREBUILT_MAX_FILES",
  "SITEFLOW_POSTGRES_PASSWORD_FILE",
  "docker compose -f docker-compose.production.yml config"
];
const maxDirtyWorktreeEntries = 200;
const defaultRequiredStatusCheck = "Install, test, and build";
const requiredDocumentedEnvNames = [
  "DATABASE_URL",
  "SITEFLOW_API_PORT",
  "SITEFLOW_ARTIFACT_ROOT",
  "SITEFLOW_PUBLIC_SCHEME",
  "SITEFLOW_API_TOKEN",
  "SITEFLOW_APP_SECRET",
  "SITEFLOW_SEALING_KEY",
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
  "SITEFLOW_BUILD_NETWORK"
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
    id: "runtime.appSecret",
    label: "App sealing secret",
    keys: ["SITEFLOW_APP_SECRET", "SITEFLOW_APP_SECRET_FILE", "SITEFLOW_SEALING_KEY", "SITEFLOW_SEALING_KEY_FILE"],
    predicate: (values) => productionAppSecretStrengthStatus(values).status === "pass",
    summary: "SITEFLOW_APP_SECRET or SITEFLOW_APP_SECRET_FILE is required, with SITEFLOW_SEALING_KEY accepted only for legacy installs."
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
  const requiredTopLevelSecrets = [
    "siteflow_app_secret",
    "siteflow_api_token",
    "siteflow_metrics_token",
    "siteflow_postgres_password"
  ];

  for (const secretName of requiredTopLevelSecrets) {
    if (!composeMappingIncludes(secretsBlock, secretName)) {
      missingComposeTerms.push(`top-level secret ${secretName}`);
    }
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
      "SITEFLOW_BACKUP_AUTOMATION_RUN_RECORD:",
      "DATABASE_URL:",
      "SITEFLOW_APP_SECRET_FILE:",
      "SITEFLOW_API_TOKEN_FILE:",
      "SITEFLOW_METRICS_TOKEN_FILE:",
      "SITEFLOW_POSTGRES_PASSWORD_FILE:",
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
      "siteflow_postgres_password"
    ]);

    if (apiBlock.includes("/var/run/docker.sock")) {
      missingComposeTerms.push("api must not mount /var/run/docker.sock");
    }

    if (/(^|\n)\s+build:\s*(\n|$)/.test(apiBlock)) {
      missingComposeTerms.push("api must not define a local Docker build");
    }

    if (apiBlock.includes("siteflow-console:production")) {
      missingComposeTerms.push("api image must not use mutable siteflow-console:production default");
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
      "SITEFLOW_BUILD_NETWORK:",
      "DATABASE_URL:",
      "SITEFLOW_APP_SECRET_FILE:",
      "SITEFLOW_POSTGRES_PASSWORD_FILE:"
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

    if (workerBlock.includes("SITEFLOW_BUILD_IMAGE_ALLOWLIST: ${SITEFLOW_BUILD_IMAGE_ALLOWLIST:?")) {
      missingComposeTerms.push("worker build image allowlist must remain optional for digest-pinned build images");
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
    "SITEFLOW_APP_SECRET",
    "SITEFLOW_SEALING_KEY",
    "SITEFLOW_POSTGRES_PASSWORD"
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
  const appSecret = productionAppSecretStrengthStatus(values);
  const postgresPassword = productionDatabasePasswordStatus(values);
  const secretStrengthViolations = [
    apiToken,
    metricsToken,
    appSecret
  ].filter((result) => result.status === "fail").map((result) => result.summary);

  return {
    apiTokenStrengthStatus: apiToken.status,
    metricsTokenStrengthStatus: metricsToken.status,
    appSecretStrengthStatus: appSecret.status,
    appSecretSource: appSecret.source,
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

function resolveRuntimeControlPosture(values: Record<string, string | undefined>) {
  const buildMaxArtifactBytes = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES");
  const buildMaxArtifactFiles = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_MAX_ARTIFACT_FILES");
  const buildMinFreeBytes = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_MIN_FREE_BYTES");
  const prebuiltMaxUploadBytes = positiveRuntimeIntegerStatus(values, "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES");
  const prebuiltMaxFiles = positiveRuntimeIntegerStatus(values, "SITEFLOW_PREBUILT_MAX_FILES");
  const buildStepTimeout = positiveRuntimeIntegerStatus(values, "SITEFLOW_BUILD_STEP_TIMEOUT_MS");
  const gitTimeout = positiveRuntimeIntegerStatus(values, "SITEFLOW_GIT_TIMEOUT_MS");
  const buildNetwork = buildNetworkRuntimeStatus(values);
  const checks = [
    buildMaxArtifactBytes,
    buildMaxArtifactFiles,
    buildMinFreeBytes,
    prebuiltMaxUploadBytes,
    prebuiltMaxFiles,
    buildStepTimeout,
    gitTimeout,
    buildNetwork
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
    buildNetworkStatus: buildNetwork.status,
    buildNetwork: buildNetwork.buildNetwork,
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
          appSecretStrengthStatus: secretPosture.appSecretStrengthStatus,
          appSecretSource: secretPosture.appSecretSource,
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
          buildNetworkStatus: runtimeControls.buildNetworkStatus,
          buildNetwork: runtimeControls.buildNetwork,
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
        appSecretStrengthStatus: secretPosture.appSecretStrengthStatus,
        appSecretSource: secretPosture.appSecretSource,
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
        buildNetworkStatus: runtimeControls.buildNetworkStatus,
        buildNetwork: runtimeControls.buildNetwork,
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
        id: "external.githubBranchProtection",
        label: "GitHub branch protection",
        status: "fail",
        summary: body?.message ?? `GitHub branch protection check failed with HTTP ${response.status}.`,
        remediation: "Require CI status checks on the main branch before release promotion.",
        details: {
          branch,
          repository: `${repository.owner}/${repository.name}`,
          requiredStatusCheck,
          httpStatus: response.status
        }
      };
    }

    const requiredStatusChecks = requiredStatusChecksFromResponse(await response.json());

    if (requiredStatusChecks.length === 0) {
      return {
        id: "external.githubBranchProtection",
        label: "GitHub branch protection",
        status: "fail",
        summary: `GitHub branch protection for ${branch} has no required status checks.`,
        remediation: "Require the CI workflow job before merging to main.",
        details: {
          branch,
          repository: `${repository.owner}/${repository.name}`,
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
          repository: `${repository.owner}/${repository.name}`,
          requiredStatusCheck,
          requiredStatusChecks
        }
      };
    }

    return {
      id: "external.githubBranchProtection",
      label: "GitHub branch protection",
      status: "pass",
      summary: `GitHub branch protection for ${branch} requires expected CI check: ${requiredStatusCheck}.`,
      details: {
        branch,
        repository: `${repository.owner}/${repository.name}`,
        requiredStatusCheck,
        requiredStatusChecks
      }
    };
  } catch (error) {
    return {
      id: "external.githubBranchProtection",
      label: "GitHub branch protection",
      status: "fail",
      summary: error instanceof Error ? error.message : "Unable to verify GitHub branch protection.",
      remediation: "Retry with network access or verify branch protection manually before release.",
      details: {
        branch,
        repository: `${repository.owner}/${repository.name}`,
        requiredStatusCheck
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
      appSecretStrengthStatus: runtimeEnv?.details?.appSecretStrengthStatus as ReleaseGateCheckStatus | undefined ?? null,
      appSecretSource: detailString(runtimeEnv?.details, "appSecretSource") ?? null,
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
      buildNetworkStatus: runtimeEnv?.details?.buildNetworkStatus as ReleaseGateCheckStatus | undefined ?? null,
      buildNetwork: detailString(runtimeEnv?.details, "buildNetwork") ?? null,
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
    checkProductionDocs(root),
    checkProductionCompose(root),
    checkReleaseSourceTree(root, runner),
    checkGitStatus(root, runner, allowDirty),
    checkRequiredEnvironment(root, env, options.envFile, Boolean(options.requireRuntimeEnv || promotion))
  ]);

  checks.push(await checkGitHubBranchProtection({ ...options, env }));
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
