import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PackStatus = "planned" | "blocked";
export type SourceProvider = "github" | "gitlab" | "gitea" | "generic";

export interface ReleaseEvidenceRehearsalPackOptions {
  commitRef: string;
  repo: string;
  branch: string;
  sourceProvider?: SourceProvider;
  targetEnvFile: string;
  publicBaseUrl: string;
  operatorName: string;
  releaseTicket: string;
  observabilityTargetStackApiUrl?: string;
  observabilityTargetStackTokenEnv?: string;
  outputDir?: string;
  targetEnvironment?: string;
  requiredStatusCheck?: string;
  dockerSocketProfileAccepted?: boolean;
  checkedAt?: string;
  now?: () => Date;
}

export interface ReleaseEvidencePackCommand {
  executable: string;
  args: string[];
  display: string;
  env?: string[];
  captureStdoutTo?: string;
}

export interface ReleaseEvidencePackStep {
  id: string;
  title: string;
  required: boolean;
  outputPath: string;
  command: ReleaseEvidencePackCommand;
  prerequisites: string[];
  notes: string[];
}

export interface ReleaseEvidenceRehearsalPackResult {
  schemaVersion: "siteflow.releaseEvidenceRehearsalPack.v1";
  name: "siteflow-release-evidence-rehearsal-pack";
  status: PackStatus;
  generatedAt: string;
  release: {
    commitRef: string;
    repository: string;
    branch: string;
    sourceProvider: SourceProvider;
    targetEnvironment: string;
    requiredStatusCheck: string;
    operatorName: string;
    releaseTicket: string;
    observabilityTargetStackApiUrl: string | null;
    observabilityTargetStackTokenEnv: string | null;
    publicBaseUrl: string;
    targetEnvFile: string;
  };
  outputDir: string;
  packPath: string;
  markdownPath: string;
  evidenceFiles: Record<string, string>;
  steps: ReleaseEvidencePackStep[];
  finalCommands: {
    compose: ReleaseEvidencePackCommand;
    check: ReleaseEvidencePackCommand;
  };
  requiredManualInputs: string[];
  blockedProductionClaims: string[];
  exitCode: number;
}

interface ParsedArgs {
  commitRef?: string;
  repo?: string;
  branch?: string;
  sourceProvider?: SourceProvider;
  targetEnvFile?: string;
  publicBaseUrl?: string;
  operatorName?: string;
  releaseTicket?: string;
  observabilityTargetStackApiUrl?: string;
  observabilityTargetStackTokenEnv?: string;
  outputDir?: string;
  targetEnvironment?: string;
  requiredStatusCheck?: string;
  dockerSocketProfileAccepted: boolean;
  checkedAt?: string;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const defaultTargetEnvironment = "production";
const defaultRequiredStatusCheck = "Install, test, and build";
const defaultOutputRoot = "evidence";
const defaultSourceProvider: SourceProvider = "github";
const defaultObservabilityTargetStackTokenEnv = "SITEFLOW_OBSERVABILITY_STACK_TOKEN";
const sourceProviders = new Set<SourceProvider>(["github", "gitlab", "gitea", "generic"]);
const releaseEvidenceSigningKeyEnv = "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY";
const releaseEvidenceRequiredSigningKeyIdEnv = "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID";

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredValue(value: string | undefined, label: string) {
  const normalized = stringValue(value);

  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function sourceProviderValue(value: string | undefined) {
  const normalized = (stringValue(value) ?? defaultSourceProvider).toLowerCase();

  if (!sourceProviders.has(normalized as SourceProvider)) {
    throw new Error("--source-provider must be one of github, gitlab, gitea, or generic.");
  }

  return normalized as SourceProvider;
}

function observabilityTargetStackApiUrlValue(value: string | undefined, targetEnvironment: string) {
  const normalized = stringValue(value);

  if (targetEnvironment === "production" && !normalized) {
    throw new Error("--observability-target-stack-api-url is required for production release evidence packs.");
  }

  return normalized ?? null;
}

function requiredArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!stringValue(value) || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function timestampValue(value: string | undefined, fallback: string) {
  if (value === undefined) {
    return fallback;
  }

  if (!stringValue(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("--checked-at must be a valid ISO timestamp.");
  }

  return value.trim();
}

function safeSlug(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "release";
}

function normalizePublicBaseUrl(raw: string) {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("--public-base-url must be a valid URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("--public-base-url must use https.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--public-base-url must not include credentials, query strings, or fragments.");
  }

  return parsed.toString().replace(/\/$/, "");
}

function powershellQuote(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,\\-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "''")}'`;
}

function commandDisplay(executable: string, args: string[], captureStdoutTo?: string) {
  const display = [executable, ...args].map(powershellQuote).join(" ");

  return captureStdoutTo ? `${display} > ${powershellQuote(captureStdoutTo)}` : display;
}

function command(executable: string, args: string[], captureStdoutTo?: string, env?: string[]): ReleaseEvidencePackCommand {
  return {
    executable,
    args,
    display: commandDisplay(executable, args, captureStdoutTo),
    ...(env && env.length > 0 ? { env } : {}),
    ...(captureStdoutTo ? { captureStdoutTo } : {})
  };
}

function evidencePaths(outputDir: string) {
  return {
    releaseGate: path.join(outputDir, "release-gate.json"),
    dockerBuild: path.join(outputDir, "docker-build-rehearsal.json"),
    releaseArtifactManifest: path.join(outputDir, "release-artifact-manifest.json"),
    deploymentArtifactManifest: path.join(outputDir, "deployment-artifact-manifest.json"),
    releaseArtifact: path.join(outputDir, "release-artifact-evidence.json"),
    releaseImage: path.join(outputDir, "release-image-evidence.json"),
    postgres: path.join(outputDir, "postgres-rehearsal.json"),
    sourceProviderRaw: path.join(outputDir, "source-provider-evidence-raw.json"),
    sourceProvider: path.join(outputDir, "source-provider-evidence.json"),
    backupVerify: path.join(outputDir, "backup-verify.json"),
    restoreDrill: path.join(outputDir, "restore-drill.json"),
    backupOffload: path.join(outputDir, "backup-offload.json"),
    backupFetch: path.join(outputDir, "backup-fetch.json"),
    backupProviderSecurityAudit: path.join(outputDir, "backup-provider-security-audit.json"),
    backupPrune: path.join(outputDir, "backup-prune.json"),
    backupPolicy: path.join(outputDir, "backup-policy.json"),
    backupAutomationRun: path.join(outputDir, "backup-automation-run.json"),
    backupAutomationHistory: path.join(outputDir, "backup-automation-history.json"),
    backupSchedulerOwnership: path.join(outputDir, "backup-scheduler-ownership.json"),
    backupRaw: path.join(outputDir, "backup-evidence-raw.json"),
    backup: path.join(outputDir, "backup-evidence.json"),
    operatorObservability: path.join(outputDir, "operator-observability.json"),
    observabilityRaw: path.join(outputDir, "observability-evidence-raw.json"),
    observability: path.join(outputDir, "observability-evidence.json"),
    operatorAccessRaw: path.join(outputDir, "operator-access-evidence-raw.json"),
    operatorAccess: path.join(outputDir, "operator-access-evidence.json"),
    nonSessionCredentialRaw: path.join(outputDir, "non-session-credential-evidence-raw.json"),
    nonSessionCredential: path.join(outputDir, "non-session-credential-evidence.json"),
    operatorIngress: path.join(outputDir, "operator-ingress.json"),
    ingressRaw: path.join(outputDir, "ingress-evidence-raw.json"),
    ingress: path.join(outputDir, "ingress-evidence.json"),
    upgradeRollbackRaw: path.join(outputDir, "upgrade-rollback-evidence-raw.json"),
    upgradeRollback: path.join(outputDir, "upgrade-rollback-evidence.json"),
    targetRuntimeRaw: path.join(outputDir, "target-runtime-evidence-raw.json"),
    targetRuntime: path.join(outputDir, "target-runtime-evidence.json"),
    releaseEvidence: path.join(outputDir, "release-evidence.json"),
    releaseEvidenceCheck: path.join(outputDir, "release-evidence-check.json")
  };
}

function step(
  id: string,
  title: string,
  outputPath: string,
  stepCommand: ReleaseEvidencePackCommand,
  prerequisites: string[],
  notes: string[]
): ReleaseEvidencePackStep {
  return {
    id,
    title,
    required: true,
    outputPath,
    command: stepCommand,
    prerequisites,
    notes
  };
}

function buildSteps(
  release: ReleaseEvidenceRehearsalPackResult["release"],
  files: Record<string, string>
) {
  const releaseArgs = ["--commit-ref", release.commitRef, "--repo", release.repository, "--branch", release.branch];
  const productionArtifactEvidenceArgs = release.targetEnvironment === "production"
    ? [
        "--deployment-detail",
        "<candidate-deployment-detail-path>",
        "--write-deployment-artifact-manifest",
        files.deploymentArtifactManifest
      ]
    : [];
  const operatorAccessTemplate = command("npm", [
    "run",
    "--silent",
    "operator-access:evidence:template",
    "--",
    ...releaseArgs,
    "--target-environment",
    release.targetEnvironment,
    "--public-base-url",
    release.publicBaseUrl,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    "--output",
    files.operatorAccessRaw
  ]);
  const nonSessionCredentialTemplate = command("npm", [
    "run",
    "--silent",
    "non-session-credential:evidence:template",
    "--",
    ...releaseArgs,
    "--target-environment",
    release.targetEnvironment,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    "--output",
    files.nonSessionCredentialRaw
  ]);
  const sourceProviderTemplate = command("npm", [
    "run",
    "--silent",
    "source-provider:evidence:template",
    "--",
    ...releaseArgs,
    "--target-environment",
    release.targetEnvironment,
    "--provider",
    release.sourceProvider,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    "--output",
    files.sourceProviderRaw
  ]);
  const observabilityOperatorTemplate = command("npm", [
    "run",
    "--silent",
    "observability:operator-evidence:template",
    "--",
    ...releaseArgs,
    "--target-environment",
    release.targetEnvironment,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    "--output",
    files.operatorObservability
  ]);
  const ingressOperatorTemplate = command("npm", [
    "run",
    "--silent",
    "ingress:operator-evidence:template",
    "--",
    ...releaseArgs,
    "--target-environment",
    release.targetEnvironment,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    "--public-base-url",
    release.publicBaseUrl,
    "--trust-proxy-policy",
    "<SITEFLOW_TRUST_PROXY>",
    "--output",
    files.operatorIngress
  ]);
  const upgradeRollbackTemplate = command("npm", [
    "run",
    "--silent",
    "upgrade-rollback:evidence:template",
    "--",
    ...releaseArgs,
    "--target-environment",
    release.targetEnvironment,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    "--output",
    files.upgradeRollbackRaw
  ]);
  const targetRuntimeTemplate = command("npm", [
    "run",
    "--silent",
    "release:target-runtime:evidence:template",
    "--",
    ...releaseArgs,
    "--target-environment",
    release.targetEnvironment,
    "--public-base-url",
    release.publicBaseUrl,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    "--output",
    files.targetRuntimeRaw
  ]);
  const sourceProviderCommand = release.sourceProvider === "github"
    ? command(
        "npm",
        [
          "run",
          "--silent",
          "source-provider:evidence:collect",
          "--",
          "--provider",
          "github",
          ...releaseArgs,
          "--target-environment",
          release.targetEnvironment,
          "--operator-name",
          release.operatorName,
          "--release-ticket",
          release.releaseTicket,
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
          files.sourceProviderRaw,
          "--check-output",
          files.sourceProvider,
          "--json"
        ],
        undefined,
        ["GITHUB_TOKEN"]
      )
    : command(
        "npm",
        [
          "run",
          "--silent",
          "source-provider:evidence",
          "--",
          "--evidence",
          files.sourceProviderRaw,
          ...releaseArgs,
          "--target-environment",
          release.targetEnvironment,
          "--json"
        ],
        files.sourceProvider
      );
  const sourceProviderPrerequisites = release.sourceProvider === "github"
    ? [
        "GitHub token with read access to repository metadata and deploy keys.",
        "Target-side signed webhook verification has selected a real delivery id for this release.",
        `To start from a non-passing placeholder, run: ${sourceProviderTemplate.display}`
      ]
    : [
        `Source provider is ${release.sourceProvider}; the GitHub collector is not used and GITHUB_TOKEN is not required for this step.`,
        `Run the template first, replace every placeholder with real ${release.sourceProvider} target or target-equivalent observations, then run the checker command: ${sourceProviderTemplate.display}`,
        "Manual evidence must include signed webhook delivery, exact checkout, safe remote URL, deploy-key, host-key, and release provenance observations."
      ];
  const sourceProviderNotes = release.sourceProvider === "github"
    ? [
        "The collector writes both the raw source-provider evidence and the checker output expected by release:evidence:compose.",
        "The template command still writes status=blocked, dryRun=true, and template=true raw evidence for manual fallback; production evidence must come from the collector or equivalent target observations.",
        "The checker expects signed webhook delivery proof, exact commit checkout, remote URL hygiene, deploy-key policy, host-key policy, and no raw credential archival."
      ]
    : [
        "The generated command checks the completed manual raw source-provider evidence and captures the checker output expected by release:evidence:compose.",
        "The template command writes status=blocked, dryRun=true, and template=true raw evidence; production evidence requires replacing every placeholder with real target observations before running the checker.",
        "The checker expects signed webhook delivery proof, exact commit checkout, remote URL hygiene, deploy-key policy, host-key policy, and no raw credential archival."
      ];

  return [
    step(
      "release_gate",
      "Collect protected-repository promotion evidence",
      files.releaseGate,
      command(
        "npm",
        [
          "run",
          "siteflow",
          "--",
          "release-gate",
          "--promotion",
          "--env-file",
          release.targetEnvFile,
          "--repo",
          release.repository,
          "--branch",
          release.branch,
          "--commit-ref",
          release.commitRef,
          "--required-status-check",
          release.requiredStatusCheck,
          "--require-commit-status",
          "--json"
        ],
        files.releaseGate,
        ["GITHUB_TOKEN"]
      ),
      ["GitHub token with read access to branch protection and commit checks.", "Clean checkout at the exact release commit."],
      ["manual_required, skipped, or dirty-worktree promotion evidence is not production evidence."]
    ),
    step(
      "docker_build_rehearsal",
      "Run target-profile Docker build rehearsal",
      files.dockerBuild,
      command(
        "npm",
        ["run", "--silent", "rehearsal:docker-build", "--", ...releaseArgs, "--json"],
        files.dockerBuild,
        ["SITEFLOW_RUN_DOCKER_BUILD_REHEARSAL=1", "SITEFLOW_BUILD_IMAGE=<target-image@sha256:...>"]
      ),
      ["Docker CLI and daemon available in the target worker profile.", "Pinned build image, or allowlisted tag with SITEFLOW_ALLOW_TAGGED_BUILD_IMAGE=1."],
      ["Dry-run or docker --version output alone is not production evidence."]
    ),
    step(
      "postgres_rehearsal",
      "Run target-equivalent Postgres rehearsal",
      files.postgres,
      command(
        "npm",
        ["run", "--silent", "rehearsal:postgres", "--", ...releaseArgs, "--target-environment", release.targetEnvironment, "--json"],
        files.postgres,
        ["SITEFLOW_RUN_POSTGRES_INTEGRATION=1", "TEST_DATABASE_URL=<target-or-disposable-postgres-url>"]
      ),
      ["Disposable or target-equivalent Postgres database.", "Database URL must not be archived outside the command environment."],
      ["The output must include redacted database metadata and the full migration/queue rehearsal scope."]
    ),
    step(
      "release_artifact_evidence",
      "Validate release build artifacts, manifest, topology, and production dependencies",
      files.releaseArtifact,
      command(
        "npm",
        [
          "run",
          "--silent",
          "release:artifacts:evidence",
          "--",
          "--manifest",
          files.releaseArtifactManifest,
          ...productionArtifactEvidenceArgs,
          ...releaseArgs,
          "--target-environment",
          release.targetEnvironment,
          "--json"
        ],
        files.releaseArtifact
      ),
      release.targetEnvironment === "production"
        ? [
            "Clean build outputs exist in dist, dist-cli, dist-server, and dist-worker for the exact release commit.",
            "candidate deployment detail has been collected from the target SiteFlow API with private retention, and lineage.artifact.manifest is bound to the release identity."
          ]
        : ["Clean build outputs exist in dist, dist-cli, dist-server, and dist-worker for the exact release commit."],
      [
        "This gate hashes release artifacts, scans for canary/fixture/credential leakage, validates CLI topology, runs production dependency audit, and attaches a sanitized deployment function manifest summary.",
        "The raw deployment detail is consumed from a private path and is not uploaded as release evidence; only deployment-artifact-manifest.json is written as sanitized evidence."
      ]
    ),
    step(
      "release_image_evidence",
      "Download release image digest evidence from the GHCR publish workflow",
      files.releaseImage,
      command(
        "gh",
        ["run", "download", "<release-image-run-id>", "--name", "release-image-evidence", "--dir", path.dirname(files.releaseImage)],
        undefined,
        ["GH_TOKEN"]
      ),
      ["Release image workflow run has completed successfully for the exact release commit.", "GitHub CLI can download the release-image-evidence artifact."],
      ["The downloaded release-image-evidence.json must contain the published GHCR digest; a workflow summary line is not enough."]
    ),
    step(
      "source_provider_evidence",
      "Validate target source provider, signed webhook, and checkout provenance evidence",
      files.sourceProvider,
      sourceProviderCommand,
      sourceProviderPrerequisites,
      sourceProviderNotes
    ),
    step(
      "target_runtime_evidence",
      "Collect target Compose startup, readiness, running image binding, restart smoke, and log sanity evidence",
      files.targetRuntime,
      command("npm", [
        "run",
        "--silent",
        "release:target-runtime:evidence:collect",
        "--",
        ...releaseArgs,
        "--target-environment",
        release.targetEnvironment,
        "--env-file",
        release.targetEnvFile,
        "--public-base-url",
        release.publicBaseUrl,
        "--expected-digest",
        "<release-image-digest>",
        "--operator-name",
        release.operatorName,
        "--release-ticket",
        release.releaseTicket,
        "--output",
        files.targetRuntimeRaw,
        "--check-output",
        files.targetRuntime,
        "--json"
      ]),
      [
        "Run this collector on the actual target host after the release image and target env are configured.",
        "Target env file must include SITEFLOW_DOCKER_SOCKET_GID with the target host /var/run/docker.sock group id.",
        "Provide <release-image-digest> from the release image evidence artifact so API and worker runtime evidence is bound to the published release image.",
        "Docker CLI access to the target Compose project, loopback API access, and public /readyz reachability are required.",
        `To start from a non-passing placeholder, run: ${targetRuntimeTemplate.display}`
      ],
      [
        "The collector writes both the raw target-runtime evidence and the checker output expected by release:evidence:compose.",
        "It summarizes docker compose config, startup, service health, worker healthcheck, loopback and public /readyz, image/container binding, restart smoke, and log sanity without archiving raw config, raw env, or unredacted logs.",
        "The template command remains a blocked manual fallback; production evidence should come from the collector or equivalent target-host observations."
      ]
    ),
    step(
      "backup_evidence",
      "Compose backup, restore-drill, offload, prune, and policy evidence",
      files.backup,
      command(
        "npm",
        [
          "run",
          "--silent",
          "backup:evidence:compose",
          "--",
          "--backup-verify",
          files.backupVerify,
          "--restore-drill",
          files.restoreDrill,
          "--backup-offload",
          files.backupOffload,
          "--backup-fetch",
          files.backupFetch,
          "--provider-security-audit",
          files.backupProviderSecurityAudit,
          "--backup-prune",
          files.backupPrune,
          "--policy",
          files.backupPolicy,
          "--commit-ref",
          release.commitRef,
          "--repo",
          release.repository,
          "--branch",
          release.branch,
          "--target-environment",
          release.targetEnvironment,
          "--operator-name",
          release.operatorName,
          "--release-ticket",
          release.releaseTicket,
          "--require-off-host",
          "--output",
          files.backupRaw,
          "--check-output",
          files.backup
        ]
      ),
      ["Fresh backup verify, restore drill, offload, fetch, provider security audit, prune, and policy files exist.", "Off-host backup target has been verified."],
      ["The release bundle expects the checker output, not the raw composed backup evidence."]
    ),
    step(
      "observability_evidence",
      "Collect readiness, metrics, alert, dashboard, and log evidence",
      files.observability,
      command(
        "npm",
        [
          "run",
          "--silent",
          "observability:evidence:collect",
          "--",
          "--base-url",
          release.publicBaseUrl,
          "--backup-automation-run",
          files.backupAutomationRun,
          "--backup-automation-history",
          files.backupAutomationHistory,
          "--backup-scheduler-ownership",
          files.backupSchedulerOwnership,
          "--operator-evidence",
          files.operatorObservability,
          ...releaseArgs,
          "--target-environment",
          release.targetEnvironment,
          ...(release.observabilityTargetStackApiUrl
            ? [
                "--target-stack-api-url",
                release.observabilityTargetStackApiUrl,
                ...(release.observabilityTargetStackTokenEnv ? ["--target-stack-token-env", release.observabilityTargetStackTokenEnv] : []),
                "--operator-name",
                release.operatorName,
                "--release-ticket",
                release.releaseTicket
              ]
            : []),
          "--output",
          files.observabilityRaw,
          "--check-output",
          files.observability
        ],
        undefined,
        [
          "SITEFLOW_METRICS_TOKEN",
          "SITEFLOW_METRICS_TOKEN_FILE",
          ...(release.observabilityTargetStackApiUrl
            ? [
                release.observabilityTargetStackTokenEnv ?? defaultObservabilityTargetStackTokenEnv,
                `${release.observabilityTargetStackTokenEnv ?? defaultObservabilityTargetStackTokenEnv}_FILE`
              ]
            : [])
        ]
      ),
      [
        "Backup automation run record exists and points at passed backup checker output.",
        "Backup automation history exists with at least two successful restore drills inside the expected cadence.",
        "Backup scheduler ownership evidence exists for an enabled cron, systemd timer, or external orchestrator job that invokes backup:automation and points at the selected run record and history.",
        `To start from a non-passing operator-observability placeholder, run: ${observabilityOperatorTemplate.display}`,
        "Operator evidence file includes observabilityProvisioning.renderedAssets and observabilityApplyProof applied asset hashes.",
        "Operator evidence file includes observabilityTargetStackProof from target Prometheus, Alertmanager, and Grafana APIs matching rendered asset hashes.",
        "Operator evidence file covers alert delivery, dashboard owner, log retention, and readiness traffic removal."
      ],
      [
        "The observability operator template writes status=blocked, dryRun=true, and template=true; replace it with real target observations before running the collector for production evidence.",
        "The collector does not provision the observability stack; it only scrapes and checks evidence."
      ]
    ),
    step(
      "operator_access_evidence",
      "Collect operator session and emergency cutoff evidence",
      files.operatorAccess,
      command("npm", [
        "run",
        "--silent",
        "operator-access:evidence:collect",
        "--",
        "--base-url",
        release.publicBaseUrl,
        ...releaseArgs,
        "--target-environment",
        release.targetEnvironment,
        "--operator-name",
        release.operatorName,
        "--release-ticket",
        release.releaseTicket,
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
        files.operatorAccessRaw,
        "--check-output",
        files.operatorAccess
      ], undefined, [
        "SITEFLOW_API_TOKEN",
        "SITEFLOW_API_TOKEN_FILE",
        "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN",
        "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN_FILE"
      ]),
      [
        "Collector runs on the target evidence host with an admin API token and a low-scope API token available by env or *_FILE.",
        "Operator selects a project id and a denied project id to prove project-scoped sessions are constrained.",
        "Collector creates and disables a temporary routing rule to prove server-derived actor attribution; cleanup failure blocks the evidence.",
        "Global emergency cutoff confirmation is intentional: executing this step revokes active operator sessions.",
        `To start from a non-passing placeholder, run: ${operatorAccessTemplate.display}`
      ],
      [
        "The collector writes both the raw operator-access evidence and the checker output expected by release:evidence:compose.",
        "The template command remains a blocked manual fallback; production evidence should come from the collector or equivalent target observations.",
        "This does not prove IdP, MFA, credentialed CORS, or full login is complete."
      ]
    ),
    step(
      "non_session_credential_evidence",
      "Collect non-session credential rotation and break-glass evidence",
      files.nonSessionCredential,
      command("npm", [
        "run",
        "--silent",
        "non-session-credential:evidence:collect",
        "--",
        "--base-url",
        release.publicBaseUrl,
        ...releaseArgs,
        "--target-environment",
        release.targetEnvironment,
        "--operator-name",
        release.operatorName,
        "--release-ticket",
        release.releaseTicket,
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
        files.nonSessionCredentialRaw,
        "--check-output",
        files.nonSessionCredential
      ], undefined, [
        "SITEFLOW_OLD_METRICS_TOKEN",
        "SITEFLOW_OLD_METRICS_TOKEN_FILE",
        "SITEFLOW_METRICS_TOKEN",
        "SITEFLOW_METRICS_TOKEN_FILE",
        "SITEFLOW_OLD_API_TOKEN",
        "SITEFLOW_OLD_API_TOKEN_FILE",
        "SITEFLOW_API_TOKEN",
        "SITEFLOW_API_TOKEN_FILE"
      ]),
      [
        "Collector runs after rotating the metrics token and root API token, then reloading the target service or scraper.",
        "Old and new metrics tokens are available by env or *_FILE; raw token values are never written.",
        "Old and new root API tokens are available by env or *_FILE; /api/auth/verify proves the retired token is rejected and the active token is accepted without archiving raw token values.",
        "Break-glass source and approver count are operator-supplied non-secret facts.",
        `To start from a non-passing placeholder, run: ${nonSessionCredentialTemplate.display}`
      ],
      [
        "The collector writes both the raw non-session credential evidence and the checker output expected by release:evidence:compose.",
        "The template command remains a blocked manual fallback; production evidence should come from the collector or equivalent target observations.",
        "This is an evidence gate; SiteFlow does not automatically rotate external credentials."
      ]
    ),
    step(
      "ingress_evidence",
      "Collect target ingress and edge/shared rate-limit evidence",
      files.ingress,
      command("npm", [
        "run",
        "--silent",
        "ingress:evidence:collect",
        "--",
        "--public-base-url",
        release.publicBaseUrl,
        "--direct-api-url",
        "<direct-api-url>",
        "--target-environment",
        release.targetEnvironment,
        ...releaseArgs,
        "--trust-proxy-policy",
        "<SITEFLOW_TRUST_PROXY>",
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
        "--operator-name",
        release.operatorName,
        "--release-ticket",
        release.releaseTicket,
        "--operator-evidence",
        files.operatorIngress,
        "--output",
        files.ingressRaw,
        "--check-output",
        files.ingress,
        "--json"
      ]),
      [
        `To start from a non-passing operator-ingress placeholder, run: ${ingressOperatorTemplate.display}`,
        "Target direct API URL is checked from outside the trusted ingress, and operator-ingress evidence covers forwarded-header cleanup or proxy final-hop proof when no echo endpoint is available.",
        "Topology placeholders must match the target API instance count, API process count, ingress count, API limiter scope, and limiter enforcement point."
      ],
      [
        "The operator-ingress template command writes status=blocked, dryRun=true, and template=true operator evidence; replace every todo/null field with real target observations before running ingress:evidence:collect.",
        "The collector actively probes direct API reachability, API 429 behavior, and non-API route status, but cannot prove proxy ownership without a target echo endpoint or operator evidence.",
        "For multi-instance, multi-process, or multi-ingress targets, use an edge/shared limiter scope or equivalent operator-ingress apiRateLimit proof; process-local-only limiting remains blocked."
      ]
    ),
    step(
      "upgrade_rollback_evidence",
      "Validate target-equivalent upgrade and rollback drill evidence",
      files.upgradeRollback,
      command("npm", [
        "run",
        "--silent",
        "upgrade-rollback:evidence",
        "--",
        "--evidence",
        files.upgradeRollbackRaw,
        ...releaseArgs,
        "--target-environment",
        release.targetEnvironment,
        "--json"
      ], files.upgradeRollback),
      [
        "Raw drill evidence covers API, worker, schema, route/artifact, readiness, metrics, logs, alerts, backup, operator, and ticket metadata.",
        `To start from a non-passing placeholder, run: ${upgradeRollbackTemplate.display}`
      ],
      [
        "The template command writes status=blocked, dryRun=true, and template=true raw evidence; replace every todo/null field with real drill observations before running this checker.",
        "This does not implement an automated upgrade orchestrator."
      ]
    )
  ];
}

function composeCommand(
  release: ReleaseEvidenceRehearsalPackResult["release"],
  files: Record<string, string>,
  options: { dockerSocketProfileAccepted: boolean }
) {
  return command("npm", [
    "run",
    "--silent",
    "release:evidence:compose",
    "--",
    "--release-gate",
    files.releaseGate,
    "--docker-build",
    files.dockerBuild,
    "--postgres-rehearsal",
    files.postgres,
    "--artifact-evidence",
    files.releaseArtifact,
    "--release-image-evidence",
    files.releaseImage,
    "--target-runtime-evidence",
    files.targetRuntime,
    "--source-provider-evidence",
    files.sourceProvider,
    "--backup-evidence",
    files.backup,
    "--observability-evidence",
    files.observability,
    "--operator-access-evidence",
    files.operatorAccess,
    "--non-session-credential-evidence",
    files.nonSessionCredential,
    "--ingress-evidence",
    files.ingress,
    "--upgrade-rollback-evidence",
    files.upgradeRollback,
    "--target-environment",
    release.targetEnvironment,
    "--operator-name",
    release.operatorName,
    "--release-ticket",
    release.releaseTicket,
    ...(options.dockerSocketProfileAccepted ? ["--docker-socket-profile-accepted"] : []),
    "--attestation-key-env",
    releaseEvidenceSigningKeyEnv,
    "--attestation-key-id-env",
    releaseEvidenceRequiredSigningKeyIdEnv,
    "--output",
    files.releaseEvidence
  ], undefined, [releaseEvidenceSigningKeyEnv, releaseEvidenceRequiredSigningKeyIdEnv]);
}

function checkCommand(release: ReleaseEvidenceRehearsalPackResult["release"], files: Record<string, string>) {
  return command(
    "npm",
    [
      "run",
      "--silent",
      "release:evidence",
      "--",
      "--evidence",
      files.releaseEvidence,
      "--commit-ref",
      release.commitRef,
      "--repo",
      release.repository,
      "--branch",
      release.branch,
      "--target-environment",
      release.targetEnvironment,
      "--attestation-key-env",
      releaseEvidenceSigningKeyEnv,
      "--attestation-key-id-env",
      releaseEvidenceRequiredSigningKeyIdEnv,
      "--json"
    ],
    files.releaseEvidenceCheck,
    [releaseEvidenceSigningKeyEnv, releaseEvidenceRequiredSigningKeyIdEnv]
  );
}

function markdown(pack: ReleaseEvidenceRehearsalPackResult) {
  const lines = [
    `# SiteFlow Release Evidence Rehearsal Pack`,
    "",
    `Generated: ${pack.generatedAt}`,
    `Release: ${pack.release.repository}@${pack.release.commitRef} (${pack.release.branch})`,
    `Target: ${pack.release.targetEnvironment} ${pack.release.publicBaseUrl}`,
    "",
    "## Required Manual Inputs",
    ""
  ];

  for (const input of pack.requiredManualInputs) {
    lines.push(`- ${input}`);
  }

  lines.push(
    "",
    "## Steps",
    ""
  );

  for (const stepEntry of pack.steps) {
    const environmentRequirements = stepEntry.command.env ?? [];

    lines.push(`### ${stepEntry.id}`);
    lines.push("");
    lines.push(stepEntry.title);
    lines.push("");
    lines.push("```powershell");
    lines.push(stepEntry.command.display);
    lines.push("```");
    lines.push("");
    lines.push(`Output: ${stepEntry.outputPath}`);
    lines.push("");

    if (environmentRequirements.length > 0) {
      lines.push("Environment requirements:");
      lines.push("");

      for (const requirement of environmentRequirements) {
        lines.push(`- ${requirement}`);
      }

      lines.push("");
    }

    if (stepEntry.prerequisites.length > 0) {
      lines.push("Prerequisites:");
      lines.push("");

      for (const prerequisite of stepEntry.prerequisites) {
        lines.push(`- ${prerequisite}`);
      }

      lines.push("");
    }

    if (stepEntry.notes.length > 0) {
      lines.push("Notes:");
      lines.push("");

      for (const note of stepEntry.notes) {
        lines.push(`- ${note}`);
      }

      lines.push("");
    }
  }

  lines.push("## Compose");
  lines.push("");
  lines.push("```powershell");
  lines.push(pack.finalCommands.compose.display);
  lines.push("```");
  lines.push("");
  lines.push("## Check");
  lines.push("");
  lines.push("```powershell");
  lines.push(pack.finalCommands.check.display);
  lines.push("```");
  lines.push("");
  lines.push("## Non-goals");
  lines.push("");

  for (const claim of pack.blockedProductionClaims) {
    lines.push(`- ${claim}`);
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

export function createReleaseEvidenceRehearsalPack(
  options: ReleaseEvidenceRehearsalPackOptions
): ReleaseEvidenceRehearsalPackResult {
  const generatedAt = timestampValue(options.checkedAt, (options.now?.() ?? new Date()).toISOString());
  const commitRef = requiredValue(options.commitRef, "--commit-ref");
  const outputDir = options.outputDir ?? path.join(defaultOutputRoot, `release-${safeSlug(commitRef.slice(0, 12))}`);
  const files = evidencePaths(outputDir);
  const targetEnvironment = stringValue(options.targetEnvironment) ?? defaultTargetEnvironment;
  const release = {
    commitRef,
    repository: requiredValue(options.repo, "--repo"),
    branch: requiredValue(options.branch, "--branch"),
    sourceProvider: sourceProviderValue(options.sourceProvider),
    targetEnvironment,
    requiredStatusCheck: stringValue(options.requiredStatusCheck) ?? defaultRequiredStatusCheck,
    operatorName: requiredValue(options.operatorName, "--operator-name"),
    releaseTicket: requiredValue(options.releaseTicket, "--release-ticket"),
    observabilityTargetStackApiUrl: observabilityTargetStackApiUrlValue(options.observabilityTargetStackApiUrl, targetEnvironment),
    observabilityTargetStackTokenEnv: stringValue(options.observabilityTargetStackTokenEnv) ?? null,
    publicBaseUrl: normalizePublicBaseUrl(requiredValue(options.publicBaseUrl, "--public-base-url")),
    targetEnvFile: requiredValue(options.targetEnvFile, "--target-env-file")
  };
  const packPath = path.join(outputDir, "release-evidence-rehearsal-pack.json");
  const markdownPath = path.join(outputDir, "release-evidence-rehearsal-pack.md");
  const steps = buildSteps(release, files);
  const dockerSocketProfileAccepted = options.dockerSocketProfileAccepted === true;

  return {
    schemaVersion: "siteflow.releaseEvidenceRehearsalPack.v1",
    name: "siteflow-release-evidence-rehearsal-pack",
    status: "planned",
    generatedAt,
    release,
    outputDir,
    packPath,
    markdownPath,
    evidenceFiles: files,
    steps,
    finalCommands: {
      compose: composeCommand(release, files, { dockerSocketProfileAccepted }),
      check: checkCommand(release, files)
    },
    requiredManualInputs: [
      "target env file reviewed without raw secret archival",
      "SITEFLOW_DOCKER_SOCKET_GID captured from the target host /var/run/docker.sock group id in the target env file",
      "GitHub branch protection and exact commit status access",
      "target Docker worker profile",
      "release artifact evidence proving clean dist outputs, SHA-256 manifest, attached deployment artifact manifest, no canary/fixture/credential leakage, CLI bin topology, and production dependency audit",
      "release image workflow run id and GitHub artifact download permission for release-image-evidence.json",
      "target runtime collector run on the target host, writing raw target-runtime evidence and checker output with redacted Compose metadata, no-build-fallback state, API/worker image binding, startup, service health, worker healthcheck, readiness, restart smoke, and log sanity observations",
      ...(dockerSocketProfileAccepted
        ? ["Docker socket trusted single-host profile explicitly accepted for this release pack"]
        : ["Docker socket trusted single-host profile not accepted by this pack; add --docker-socket-profile-accepted only after a release owner records the risk acceptance"]),
      "target-equivalent Postgres database",
      `source provider ${release.sourceProvider} raw evidence prepared from source-provider:evidence:template and completed with real signed webhook delivery, exact commit checkout, remote URL hygiene, deploy key policy, host key policy, and release provenance observations`,
      "backup verify, restore drill, offload, prune, policy evidence, backup automation run record, and backup automation history",
      "operator observability evidence prepared from observability:operator-evidence:template and completed with real target apply proof, target-stack proof, alert delivery, dashboard owner, log retention, and readiness traffic-removal observations",
      "operator access collector run on the target evidence host, writing raw operator-access evidence and checker output with real target observations",
      "non-session credential collector run after target metrics and root API token rotation, writing raw credential evidence and checker output with real target observations",
      "operator ingress evidence prepared from ingress:operator-evidence:template for forwarded-header/proxy final-hop proof when the target has no echo endpoint, plus deployment topology and edge/shared limiter proof for the actual ingress topology",
      "upgrade/rollback raw evidence prepared from upgrade-rollback:evidence:template and completed with real target drill observations"
    ],
    blockedProductionClaims: [
      "The pack does not execute GitHub, Docker, Postgres, backup, credential, observability, or rollback workflows; ingress probing runs only when the generated collector command is executed on the target network.",
      "The pack is not production evidence until every command output exists and release:evidence passes for the exact commit.",
      "The pack does not prove untrusted multi-tenant build isolation, IdP/MFA, credentialed CORS, external object storage, or automated credential rotation."
    ],
    exitCode: 0
  };
}

export async function writeReleaseEvidenceRehearsalPack(
  options: ReleaseEvidenceRehearsalPackOptions
) {
  const pack = createReleaseEvidenceRehearsalPack(options);

  await mkdir(pack.outputDir, { recursive: true });
  await writeFile(pack.packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(pack.markdownPath, markdown(pack), "utf8");

  return pack;
}

export function parseReleaseEvidenceRehearsalPackArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dockerSocketProfileAccepted: false,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--commit-ref") {
      parsed.commitRef = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--source-provider") {
      parsed.sourceProvider = sourceProviderValue(requiredArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--target-env-file") {
      parsed.targetEnvFile = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--public-base-url") {
      parsed.publicBaseUrl = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--operator-name") {
      parsed.operatorName = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--release-ticket" || arg === "--ticket-id") {
      parsed.releaseTicket = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--observability-target-stack-api-url") {
      parsed.observabilityTargetStackApiUrl = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--observability-target-stack-token-env") {
      parsed.observabilityTargetStackTokenEnv = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--output-dir") {
      parsed.outputDir = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--required-status-check") {
      parsed.requiredStatusCheck = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--checked-at") {
      parsed.checkedAt = requiredArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--docker-socket-profile-accepted") {
      parsed.dockerSocketProfileAccepted = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.help) {
    const required = [
      ["--commit-ref", parsed.commitRef],
      ["--repo", parsed.repo],
      ["--branch", parsed.branch],
      ["--target-env-file", parsed.targetEnvFile],
      ["--public-base-url", parsed.publicBaseUrl],
      ["--operator-name", parsed.operatorName],
      ["--release-ticket", parsed.releaseTicket]
    ];
    const missing = required.filter(([, value]) => !value).map(([flag]) => flag);

    if (missing.length > 0) {
      throw new Error(`Missing required option(s): ${missing.join(", ")}.`);
    }
  }

  return parsed;
}

export function releaseEvidenceRehearsalPackUsage() {
  return [
    "Usage: npm run --silent release:evidence:rehearsal-pack -- --commit-ref <sha> --repo <owner/repo> --branch <branch> --target-env-file <file> --public-base-url <https-url> --operator-name <name> --release-ticket <id> [options]",
    "",
    "Options:",
    "  Alias: npm run --silent release:evidence:pack --",
    "  --output-dir <dir>              Directory for the pack and expected evidence files. Default: evidence/release-<sha>.",
    `  --source-provider <provider>    Source provider for source evidence. One of github, gitlab, gitea, or generic. Default: ${defaultSourceProvider}.`,
    "  --target-environment <name>     Target environment label. Default: production.",
    `  --required-status-check <name>  Protected branch check name. Default: ${defaultRequiredStatusCheck}.`,
    "  --observability-target-stack-api-url <url>  Target observability stack proof API URL passed to observability:evidence:collect.",
    "  --observability-target-stack-token-env <n>  Token env var for target-stack proof API. Default in collector: SITEFLOW_OBSERVABILITY_STACK_TOKEN.",
    "  --docker-socket-profile-accepted           Explicitly accept the trusted single-host Docker socket profile in the generated final compose command.",
    "  --checked-at <iso>              Reproducible generation timestamp.",
    "  --ticket-id <id>                Alias for --release-ticket.",
    "  --json                         Print the pack JSON after writing files.",
    "  --help                         Show this help."
  ].join("\n");
}

function writeHumanResult(pack: ReleaseEvidenceRehearsalPackResult, io: CliIo) {
  io.stdout.write(`SiteFlow release evidence rehearsal pack: ${pack.status}\n`);
  io.stdout.write(`Pack: ${pack.packPath}\n`);
  io.stdout.write(`Runbook: ${pack.markdownPath}\n`);
  io.stdout.write(`Final check: ${pack.finalCommands.check.display}\n`);
}

export async function runReleaseEvidenceRehearsalPackCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseEvidenceRehearsalPackOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseEvidenceRehearsalPackArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseEvidenceRehearsalPackUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseEvidenceRehearsalPackUsage()}\n`);
    return 0;
  }

  try {
    const pack = await writeReleaseEvidenceRehearsalPack({
      ...baseOptions,
      commitRef: parsed.commitRef!,
      repo: parsed.repo!,
      branch: parsed.branch!,
      sourceProvider: parsed.sourceProvider,
      targetEnvFile: parsed.targetEnvFile!,
      publicBaseUrl: parsed.publicBaseUrl!,
      operatorName: parsed.operatorName!,
      releaseTicket: parsed.releaseTicket!,
      observabilityTargetStackApiUrl: parsed.observabilityTargetStackApiUrl,
      observabilityTargetStackTokenEnv: parsed.observabilityTargetStackTokenEnv,
      outputDir: parsed.outputDir,
      targetEnvironment: parsed.targetEnvironment,
      requiredStatusCheck: parsed.requiredStatusCheck,
      dockerSocketProfileAccepted: parsed.dockerSocketProfileAccepted,
      checkedAt: parsed.checkedAt
    });

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
    } else {
      writeHumanResult(pack, io);
    }

    return pack.exitCode;
  } catch (error) {
    const result = {
      name: "siteflow-release-evidence-rehearsal-pack",
      status: "blocked",
      checkedAt: (baseOptions.now?.() ?? new Date()).toISOString(),
      message: error instanceof Error ? error.message : String(error),
      exitCode: 1
    };

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stderr.write(`${result.message}\n`);
    }

    return 1;
  }
}

if (isEntrypoint()) {
  runReleaseEvidenceRehearsalPackCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
