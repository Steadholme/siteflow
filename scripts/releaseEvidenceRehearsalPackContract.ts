import path from "node:path";

export const requiredReleaseEvidenceStepIds = [
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
];

const requiredEvidenceFileKeys = ["releaseEvidence", "releaseEvidenceCheck"];
const requiredFinalCommandKeys = ["compose", "check"];
const releaseIdentityFlags = ["--commit-ref", "--repo", "--branch"];
const sourceProviders = new Set(["github", "gitlab", "gitea", "generic"]);
const releaseEvidenceSigningKeyEnv = "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY";
const releaseEvidenceRequiredSigningKeyIdEnv = "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID";
const defaultObservabilityTargetStackTokenEnv = "SITEFLOW_OBSERVABILITY_STACK_TOKEN";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function commandProblems(label: string, command: unknown) {
  const problems: string[] = [];

  if (!isRecord(command)) {
    return [`${label} command must be an object`];
  }

  if (!stringValue(command.executable)) {
    problems.push(`${label} command executable is missing`);
  }

  if (!stringArray(command.args)) {
    problems.push(`${label} command args must be a string array`);
  }

  if (!stringValue(command.display)) {
    problems.push(`${label} command display is missing`);
  }

  return problems;
}

function nestedRecord(value: unknown, key: string) {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function commandArgs(command: unknown) {
  return isRecord(command) ? stringArray(command.args) ?? [] : [];
}

function commandEnv(command: unknown) {
  return isRecord(command) ? stringArray(command.env) ?? [] : [];
}

function flagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);

  return index === -1 ? undefined : args[index + 1];
}

function hasToken(args: string[], token: string) {
  return args.includes(token);
}

function hasOrderedTokens(args: string[], tokens: string[]) {
  let searchFrom = 0;

  for (const token of tokens) {
    const index = args.indexOf(token, searchFrom);

    if (index === -1) {
      return false;
    }

    searchFrom = index + 1;
  }

  return true;
}

function requireToken(problems: string[], label: string, args: string[], token: string) {
  if (!hasToken(args, token)) {
    problems.push(`${label} command args must include ${token}`);
  }
}

function requireFlagValue(problems: string[], label: string, args: string[], flag: string, expected: string | undefined) {
  if (!expected) {
    problems.push(`${label} expected value for ${flag} is missing from the pack`);
    return;
  }

  if (flagValue(args, flag) !== expected) {
    problems.push(`${label} command ${flag} must be ${expected}`);
  }
}

function requireReleaseIdentity(problems: string[], label: string, args: string[], release: Record<string, unknown> | undefined) {
  const expected = [
    stringValue(release?.commitRef),
    stringValue(release?.repository),
    stringValue(release?.branch)
  ];

  releaseIdentityFlags.forEach((flag, index) => {
    requireFlagValue(problems, label, args, flag, expected[index]);
  });
}

function requireScript(problems: string[], label: string, command: unknown, script: string, prefix = ["run", "--silent"]) {
  const args = commandArgs(command);

  if (!isRecord(command) || command.executable !== "npm") {
    problems.push(`${label} command executable must be npm`);
  }

  if (!hasOrderedTokens(args, [...prefix, script, "--"])) {
    problems.push(`${label} command args must run ${script} with -- separator`);
  }

  if (isRecord(command) && !stringValue(command.display)?.includes(script)) {
    problems.push(`${label} command display must include ${script}`);
  }
}

function requireSiteflowSubcommand(problems: string[], label: string, command: unknown, subcommand: string) {
  const args = commandArgs(command);

  if (!isRecord(command) || command.executable !== "npm") {
    problems.push(`${label} command executable must be npm`);
  }

  if (!hasOrderedTokens(args, ["run", "siteflow", "--", subcommand])) {
    problems.push(`${label} command args must run siteflow ${subcommand} with -- separator`);
  }

  if (isRecord(command) && !stringValue(command.display)?.includes(subcommand)) {
    problems.push(`${label} command display must include ${subcommand}`);
  }
}

function requireCapture(problems: string[], label: string, command: unknown, outputPath: string | undefined) {
  if (!outputPath) {
    problems.push(`${label} outputPath is missing`);
    return;
  }

  if (!isRecord(command) || command.captureStdoutTo !== outputPath) {
    problems.push(`${label} command captureStdoutTo must equal outputPath`);
  }

  if (isRecord(command) && !stringValue(command.display)?.includes(outputPath)) {
    problems.push(`${label} command display must include the captured output path`);
  }
}

function requireNoCapture(problems: string[], label: string, command: unknown) {
  if (isRecord(command) && command.captureStdoutTo !== undefined) {
    problems.push(`${label} command must not capture stdout; it must write evidence via explicit output flags`);
  }
}

function requireCommandEnv(problems: string[], label: string, command: unknown, expected: string) {
  const env = commandEnv(command);

  if (!env.includes(expected)) {
    problems.push(`${label} command env must include ${expected}`);
  }
}

function requireCommandEnvAbsent(problems: string[], label: string, command: unknown, unexpected: string) {
  const env = commandEnv(command);

  if (env.includes(unexpected)) {
    problems.push(`${label} command env must not include ${unexpected}`);
  }
}

function requireStepOutput(
  problems: string[],
  label: string,
  step: Record<string, unknown>,
  expected: string | undefined
) {
  if (!expected) {
    problems.push(`${label} expected output evidence file is missing from evidenceFiles`);
    return;
  }

  if (step.outputPath !== expected) {
    problems.push(`${label} outputPath must equal ${expected}`);
  }
}

function requireDisplayTokens(problems: string[], label: string, command: unknown, tokens: string[]) {
  const display = isRecord(command) ? stringValue(command.display) : undefined;

  if (!display) {
    return;
  }

  for (const token of tokens) {
    if (!display.includes(token)) {
      problems.push(`${label} command display must include ${token}`);
    }
  }
}

function requireStringListIncludes(problems: string[], label: string, value: unknown, token: string) {
  const entries = stringArray(value);

  if (!entries?.some((entry) => entry.includes(token))) {
    problems.push(`${label} must mention ${token}`);
  }
}

function requireEnvValue(
  problems: string[],
  label: string,
  release: Record<string, unknown> | undefined,
  key: string
) {
  if (!stringValue(release?.[key])) {
    problems.push(`release.${key} is required for ${label}`);
  }
}

function validateStepSemantics(
  problems: string[],
  step: Record<string, unknown>,
  release: Record<string, unknown> | undefined,
  files: Record<string, unknown> | undefined
) {
  const id = stringValue(step.id);
  const command = step.command;
  const args = commandArgs(command);
  const outputPath = stringValue(step.outputPath);

  switch (id) {
    case "release_gate":
      requireStepOutput(problems, id, step, stringValue(files?.releaseGate));
      requireSiteflowSubcommand(problems, id, command, "release-gate");
      requireToken(problems, id, args, "--promotion");
      requireFlagValue(problems, id, args, "--env-file", stringValue(release?.targetEnvFile));
      requireFlagValue(problems, id, args, "--repo", stringValue(release?.repository));
      requireFlagValue(problems, id, args, "--branch", stringValue(release?.branch));
      requireFlagValue(problems, id, args, "--commit-ref", stringValue(release?.commitRef));
      requireFlagValue(problems, id, args, "--required-status-check", stringValue(release?.requiredStatusCheck));
      requireToken(problems, id, args, "--require-commit-status");
      requireToken(problems, id, args, "--json");
      requireCapture(problems, id, command, outputPath);
      break;
    case "docker_build_rehearsal":
      requireStepOutput(problems, id, step, stringValue(files?.dockerBuild));
      requireScript(problems, id, command, "rehearsal:docker-build");
      requireReleaseIdentity(problems, id, args, release);
      requireToken(problems, id, args, "--json");
      requireCapture(problems, id, command, outputPath);
      break;
    case "postgres_rehearsal":
      requireStepOutput(problems, id, step, stringValue(files?.postgres));
      requireScript(problems, id, command, "rehearsal:postgres");
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      requireToken(problems, id, args, "--json");
      requireCapture(problems, id, command, outputPath);
      break;
    case "release_artifact_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.releaseArtifact));
      requireScript(problems, id, command, "release:artifacts:evidence");
      requireFlagValue(problems, id, args, "--manifest", stringValue(files?.releaseArtifactManifest));
      if (stringValue(release?.targetEnvironment) === "production") {
        requireFlagValue(problems, id, args, "--deployment-detail", "<candidate-deployment-detail-path>");
        requireFlagValue(problems, id, args, "--write-deployment-artifact-manifest", stringValue(files?.deploymentArtifactManifest));
        if (args.includes("--deployment-artifact-manifest")) {
          problems.push(`${id} command must consume the private candidate deployment detail instead of requiring a pre-exported deployment artifact manifest`);
        }
      }
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      requireToken(problems, id, args, "--json");
      requireCapture(problems, id, command, outputPath);
      break;
    case "release_image_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.releaseImage));
      if (!isRecord(command) || command.executable !== "gh") {
        problems.push(`${id} command executable must be gh`);
      }
      if (!hasOrderedTokens(args, ["run", "download", "<release-image-run-id>"])) {
        problems.push(`${id} command args must download the release image workflow artifact by run id`);
      }
      requireFlagValue(problems, id, args, "--name", "release-image-evidence");
      requireFlagValue(problems, id, args, "--dir", stringValue(files?.releaseImage) ? path.dirname(stringValue(files?.releaseImage)!) : undefined);
      requireNoCapture(problems, id, command);
      requireDisplayTokens(problems, id, command, ["<release-image-run-id>", "release-image-evidence"]);
      break;
    case "source_provider_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.sourceProvider));
      if (stringValue(release?.sourceProvider) === "github") {
        requireScript(problems, id, command, "source-provider:evidence:collect");
        requireFlagValue(problems, id, args, "--provider", "github");
        requireReleaseIdentity(problems, id, args, release);
        requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
        requireFlagValue(problems, id, args, "--operator-name", stringValue(release?.operatorName));
        requireFlagValue(problems, id, args, "--release-ticket", stringValue(release?.releaseTicket));
        requireFlagValue(problems, id, args, "--webhook-delivery-id", "<webhook-delivery-id>");
        requireToken(problems, id, args, "--webhook-signature-verified");
        requireToken(problems, id, args, "--webhook-secret-configured");
        requireFlagValue(problems, id, args, "--deploy-key-path", "<deploy-key-path>");
        requireToken(problems, id, args, "--deploy-key-mounted");
        requireToken(problems, id, args, "--host-key-pinned");
        requireFlagValue(problems, id, args, "--known-hosts-path", "<known-hosts-path>");
        requireFlagValue(problems, id, args, "--output", stringValue(files?.sourceProviderRaw));
        requireFlagValue(problems, id, args, "--check-output", stringValue(files?.sourceProvider));
        requireToken(problems, id, args, "--json");
        requireCommandEnv(problems, id, command, "GITHUB_TOKEN");
        requireNoCapture(problems, id, command);
        requireDisplayTokens(problems, id, command, [
          "<webhook-delivery-id>",
          "<deploy-key-path>",
          "<known-hosts-path>",
          stringValue(files?.sourceProviderRaw),
          stringValue(files?.sourceProvider)
        ].filter((value): value is string => Boolean(value)));
      } else {
        requireScript(problems, id, command, "source-provider:evidence");
        requireFlagValue(problems, id, args, "--evidence", stringValue(files?.sourceProviderRaw));
        requireReleaseIdentity(problems, id, args, release);
        requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
        requireToken(problems, id, args, "--json");
        requireCapture(problems, id, command, stringValue(files?.sourceProvider));
        requireCommandEnvAbsent(problems, id, command, "GITHUB_TOKEN");
        requireStringListIncludes(problems, `${id} prerequisites`, step.prerequisites, `--provider ${stringValue(release?.sourceProvider)}`);
      }
      break;
    case "target_runtime_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.targetRuntime));
      requireScript(problems, id, command, "release:target-runtime:evidence:collect");
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      requireFlagValue(problems, id, args, "--env-file", stringValue(release?.targetEnvFile));
      requireFlagValue(problems, id, args, "--public-base-url", stringValue(release?.publicBaseUrl));
      requireFlagValue(problems, id, args, "--expected-digest", "<release-image-digest>");
      requireFlagValue(problems, id, args, "--operator-name", stringValue(release?.operatorName));
      requireFlagValue(problems, id, args, "--release-ticket", stringValue(release?.releaseTicket));
      requireFlagValue(problems, id, args, "--output", stringValue(files?.targetRuntimeRaw));
      requireFlagValue(problems, id, args, "--check-output", stringValue(files?.targetRuntime));
      requireToken(problems, id, args, "--json");
      requireNoCapture(problems, id, command);
      requireStringListIncludes(problems, `${id} prerequisites`, step.prerequisites, "SITEFLOW_DOCKER_SOCKET_GID");
      break;
    case "backup_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.backup));
      requireScript(problems, id, command, "backup:evidence:compose");
      requireFlagValue(problems, id, args, "--backup-verify", stringValue(files?.backupVerify));
      requireFlagValue(problems, id, args, "--restore-drill", stringValue(files?.restoreDrill));
      requireFlagValue(problems, id, args, "--backup-offload", stringValue(files?.backupOffload));
      requireFlagValue(problems, id, args, "--backup-fetch", stringValue(files?.backupFetch));
      requireFlagValue(problems, id, args, "--provider-security-audit", stringValue(files?.backupProviderSecurityAudit));
      requireFlagValue(problems, id, args, "--backup-prune", stringValue(files?.backupPrune));
      requireFlagValue(problems, id, args, "--policy", stringValue(files?.backupPolicy));
      requireFlagValue(problems, id, args, "--operator-name", stringValue(release?.operatorName));
      requireFlagValue(problems, id, args, "--release-ticket", stringValue(release?.releaseTicket));
      requireToken(problems, id, args, "--require-off-host");
      requireFlagValue(problems, id, args, "--output", stringValue(files?.backupRaw));
      requireFlagValue(problems, id, args, "--check-output", stringValue(files?.backup));
      requireNoCapture(problems, id, command);
      requireDisplayTokens(problems, id, command, [stringValue(files?.backupRaw), stringValue(files?.backup)].filter((value): value is string => Boolean(value)));
      break;
    case "observability_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.observability));
      requireScript(problems, id, command, "observability:evidence:collect");
      requireFlagValue(problems, id, args, "--base-url", stringValue(release?.publicBaseUrl));
      requireFlagValue(problems, id, args, "--backup-automation-run", stringValue(files?.backupAutomationRun));
      requireFlagValue(problems, id, args, "--backup-automation-history", stringValue(files?.backupAutomationHistory));
      requireFlagValue(problems, id, args, "--backup-scheduler-ownership", stringValue(files?.backupSchedulerOwnership));
      requireFlagValue(problems, id, args, "--operator-evidence", stringValue(files?.operatorObservability));
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      if (stringValue(release?.observabilityTargetStackApiUrl)) {
        const targetStackTokenEnv = stringValue(release?.observabilityTargetStackTokenEnv) ?? defaultObservabilityTargetStackTokenEnv;

        requireFlagValue(problems, id, args, "--target-stack-api-url", stringValue(release?.observabilityTargetStackApiUrl));
        if (stringValue(release?.observabilityTargetStackTokenEnv)) {
          requireFlagValue(problems, id, args, "--target-stack-token-env", stringValue(release?.observabilityTargetStackTokenEnv));
        }
        requireFlagValue(problems, id, args, "--operator-name", stringValue(release?.operatorName));
        requireFlagValue(problems, id, args, "--release-ticket", stringValue(release?.releaseTicket));
        requireCommandEnv(problems, id, command, targetStackTokenEnv);
        requireCommandEnv(problems, id, command, `${targetStackTokenEnv}_FILE`);
      } else if (stringValue(release?.targetEnvironment) === "production") {
        problems.push(`${id} command must include --target-stack-api-url for production release evidence packs`);
      }
      requireFlagValue(problems, id, args, "--output", stringValue(files?.observabilityRaw));
      requireFlagValue(problems, id, args, "--check-output", stringValue(files?.observability));
      requireNoCapture(problems, id, command);
      requireDisplayTokens(problems, id, command, [stringValue(files?.observabilityRaw), stringValue(files?.observability)].filter((value): value is string => Boolean(value)));
      break;
    case "operator_access_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.operatorAccess));
      requireScript(problems, id, command, "operator-access:evidence:collect");
      requireFlagValue(problems, id, args, "--base-url", stringValue(release?.publicBaseUrl));
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      requireFlagValue(problems, id, args, "--operator-name", stringValue(release?.operatorName));
      requireFlagValue(problems, id, args, "--release-ticket", stringValue(release?.releaseTicket));
      requireFlagValue(problems, id, args, "--admin-token-env", "SITEFLOW_API_TOKEN");
      requireFlagValue(problems, id, args, "--low-scope-token-env", "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN");
      requireFlagValue(problems, id, args, "--project-id", "<operator-access-project-id>");
      requireFlagValue(problems, id, args, "--denied-project-id", "<operator-access-denied-project-id>");
      requireToken(problems, id, args, "--execute-project-cutoff");
      requireToken(problems, id, args, "--execute-global-cutoff");
      requireToken(problems, id, args, "--i-understand-this-revokes-active-operator-sessions");
      requireToken(problems, id, args, "--browser-token-fallback-disabled");
      requireToken(problems, id, args, "--local-storage-fallback-disabled");
      requireFlagValue(problems, id, args, "--output", stringValue(files?.operatorAccessRaw));
      requireFlagValue(problems, id, args, "--check-output", stringValue(files?.operatorAccess));
      requireCommandEnv(problems, id, command, "SITEFLOW_API_TOKEN");
      requireCommandEnv(problems, id, command, "SITEFLOW_API_TOKEN_FILE");
      requireCommandEnv(problems, id, command, "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN");
      requireCommandEnv(problems, id, command, "SITEFLOW_OPERATOR_LOW_SCOPE_TOKEN_FILE");
      requireNoCapture(problems, id, command);
      requireDisplayTokens(problems, id, command, [stringValue(files?.operatorAccessRaw), stringValue(files?.operatorAccess)].filter((value): value is string => Boolean(value)));
      break;
    case "non_session_credential_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.nonSessionCredential));
      requireScript(problems, id, command, "non-session-credential:evidence:collect");
      requireFlagValue(problems, id, args, "--base-url", stringValue(release?.publicBaseUrl));
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      requireFlagValue(problems, id, args, "--operator-name", stringValue(release?.operatorName));
      requireFlagValue(problems, id, args, "--release-ticket", stringValue(release?.releaseTicket));
      requireFlagValue(problems, id, args, "--old-metrics-token-env", "SITEFLOW_OLD_METRICS_TOKEN");
      requireFlagValue(problems, id, args, "--new-metrics-token-env", "SITEFLOW_METRICS_TOKEN");
      requireFlagValue(problems, id, args, "--old-api-token-env", "SITEFLOW_OLD_API_TOKEN");
      requireFlagValue(problems, id, args, "--new-api-token-env", "SITEFLOW_API_TOKEN");
      requireFlagValue(problems, id, args, "--old-redacted-identifier", "<old-metrics-token-redacted-id>");
      requireFlagValue(problems, id, args, "--new-redacted-identifier", "<new-metrics-token-redacted-id>");
      requireFlagValue(problems, id, args, "--old-api-redacted-identifier", "<old-root-api-token-redacted-id>");
      requireFlagValue(problems, id, args, "--new-api-redacted-identifier", "<new-root-api-token-redacted-id>");
      requireFlagValue(problems, id, args, "--break-glass-source", "<break-glass-source>");
      requireFlagValue(problems, id, args, "--break-glass-approver-count", "<break-glass-approver-count>");
      requireToken(problems, id, args, "--break-glass-reviewed");
      requireToken(problems, id, args, "--break-glass-time-bounded");
      requireToken(problems, id, args, "--break-glass-revocation-planned");
      requireFlagValue(problems, id, args, "--output", stringValue(files?.nonSessionCredentialRaw));
      requireFlagValue(problems, id, args, "--check-output", stringValue(files?.nonSessionCredential));
      requireCommandEnv(problems, id, command, "SITEFLOW_OLD_METRICS_TOKEN");
      requireCommandEnv(problems, id, command, "SITEFLOW_OLD_METRICS_TOKEN_FILE");
      requireCommandEnv(problems, id, command, "SITEFLOW_METRICS_TOKEN");
      requireCommandEnv(problems, id, command, "SITEFLOW_METRICS_TOKEN_FILE");
      requireCommandEnv(problems, id, command, "SITEFLOW_OLD_API_TOKEN");
      requireCommandEnv(problems, id, command, "SITEFLOW_OLD_API_TOKEN_FILE");
      requireCommandEnv(problems, id, command, "SITEFLOW_API_TOKEN");
      requireCommandEnv(problems, id, command, "SITEFLOW_API_TOKEN_FILE");
      requireNoCapture(problems, id, command);
      requireDisplayTokens(problems, id, command, [stringValue(files?.nonSessionCredentialRaw), stringValue(files?.nonSessionCredential)].filter((value): value is string => Boolean(value)));
      break;
    case "ingress_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.ingress));
      requireScript(problems, id, command, "ingress:evidence:collect");
      requireFlagValue(problems, id, args, "--public-base-url", stringValue(release?.publicBaseUrl));
      requireFlagValue(problems, id, args, "--direct-api-url", "<direct-api-url>");
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--trust-proxy-policy", "<SITEFLOW_TRUST_PROXY>");
      requireFlagValue(problems, id, args, "--api-instance-count", "<api-instance-count>");
      requireFlagValue(problems, id, args, "--api-process-count", "<api-process-count>");
      requireFlagValue(problems, id, args, "--ingress-count", "<ingress-count>");
      requireFlagValue(problems, id, args, "--api-rate-limit-scope", "<api-rate-limit-scope>");
      requireFlagValue(problems, id, args, "--api-rate-limit-enforcement-point", "<api-rate-limit-enforcement-point>");
      requireFlagValue(problems, id, args, "--operator-name", stringValue(release?.operatorName));
      requireFlagValue(problems, id, args, "--release-ticket", stringValue(release?.releaseTicket));
      requireFlagValue(problems, id, args, "--operator-evidence", stringValue(files?.operatorIngress));
      requireFlagValue(problems, id, args, "--output", stringValue(files?.ingressRaw));
      requireFlagValue(problems, id, args, "--check-output", stringValue(files?.ingress));
      requireToken(problems, id, args, "--json");
      requireNoCapture(problems, id, command);
      requireDisplayTokens(problems, id, command, [
        "<direct-api-url>",
        "<SITEFLOW_TRUST_PROXY>",
        "<api-instance-count>",
        "<api-process-count>",
        "<ingress-count>",
        "<api-rate-limit-scope>",
        "<api-rate-limit-enforcement-point>"
      ]);
      break;
    case "upgrade_rollback_evidence":
      requireStepOutput(problems, id, step, stringValue(files?.upgradeRollback));
      requireScript(problems, id, command, "upgrade-rollback:evidence");
      requireFlagValue(problems, id, args, "--evidence", stringValue(files?.upgradeRollbackRaw));
      requireReleaseIdentity(problems, id, args, release);
      requireFlagValue(problems, id, args, "--target-environment", stringValue(release?.targetEnvironment));
      requireToken(problems, id, args, "--json");
      requireCapture(problems, id, command, outputPath);
      break;
    default:
      break;
  }
}

function validateFinalCommandSemantics(
  problems: string[],
  pack: Record<string, unknown>,
  release: Record<string, unknown> | undefined,
  files: Record<string, unknown> | undefined
) {
  const finalCommands = nestedRecord(pack, "finalCommands");
  const compose = finalCommands?.compose;
  const check = finalCommands?.check;
  const composeArgs = commandArgs(compose);
  const checkArgs = commandArgs(check);

  if (compose) {
    requireScript(problems, "finalCommands.compose", compose, "release:evidence:compose");
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--release-gate", stringValue(files?.releaseGate));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--docker-build", stringValue(files?.dockerBuild));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--postgres-rehearsal", stringValue(files?.postgres));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--artifact-evidence", stringValue(files?.releaseArtifact));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--release-image-evidence", stringValue(files?.releaseImage));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--target-runtime-evidence", stringValue(files?.targetRuntime));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--source-provider-evidence", stringValue(files?.sourceProvider));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--backup-evidence", stringValue(files?.backup));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--observability-evidence", stringValue(files?.observability));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--operator-access-evidence", stringValue(files?.operatorAccess));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--non-session-credential-evidence", stringValue(files?.nonSessionCredential));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--ingress-evidence", stringValue(files?.ingress));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--upgrade-rollback-evidence", stringValue(files?.upgradeRollback));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--target-environment", stringValue(release?.targetEnvironment));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--operator-name", stringValue(release?.operatorName));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--release-ticket", stringValue(release?.releaseTicket));
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--attestation-key-env", releaseEvidenceSigningKeyEnv);
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--attestation-key-id-env", releaseEvidenceRequiredSigningKeyIdEnv);
    requireFlagValue(problems, "finalCommands.compose", composeArgs, "--output", stringValue(files?.releaseEvidence));
    requireCommandEnv(problems, "finalCommands.compose", compose, releaseEvidenceSigningKeyEnv);
    requireNoCapture(problems, "finalCommands.compose", compose);
  }

  if (check) {
    requireScript(problems, "finalCommands.check", check, "release:evidence");
    requireFlagValue(problems, "finalCommands.check", checkArgs, "--evidence", stringValue(files?.releaseEvidence));
    requireReleaseIdentity(problems, "finalCommands.check", checkArgs, release);
    requireFlagValue(problems, "finalCommands.check", checkArgs, "--target-environment", stringValue(release?.targetEnvironment));
    requireFlagValue(problems, "finalCommands.check", checkArgs, "--attestation-key-env", releaseEvidenceSigningKeyEnv);
    requireFlagValue(problems, "finalCommands.check", checkArgs, "--attestation-key-id-env", releaseEvidenceRequiredSigningKeyIdEnv);
    requireToken(problems, "finalCommands.check", checkArgs, "--json");
    requireCommandEnv(problems, "finalCommands.check", check, releaseEvidenceSigningKeyEnv);
    requireCapture(problems, "finalCommands.check", check, stringValue(files?.releaseEvidenceCheck));
  }
}

export function validateReleaseEvidenceRehearsalPackContract(pack: Record<string, unknown>) {
  const problems: string[] = [];
  const stepsRaw = pack.steps;
  const steps = Array.isArray(stepsRaw) ? stepsRaw.filter(isRecord) : [];
  const release = isRecord(pack.release) ? pack.release : undefined;

  if (!Array.isArray(stepsRaw)) {
    problems.push("steps must be an array");
  } else if (steps.length !== stepsRaw.length) {
    problems.push("steps must contain only objects");
  }

  const stepIds = steps.map((step) => stringValue(step.id) ?? "");
  const stepIdSet = new Set(stepIds);
  const missingSteps = requiredReleaseEvidenceStepIds.filter((id) => !stepIdSet.has(id));
  const duplicateSteps = [...new Set(stepIds.filter((id, index) => id && stepIds.indexOf(id) !== index))];

  if (missingSteps.length > 0) {
    problems.push(`missing required step(s): ${missingSteps.join(", ")}`);
  }

  if (duplicateSteps.length > 0) {
    problems.push(`duplicate step id(s): ${duplicateSteps.join(", ")}`);
  }

  for (const requiredStepId of requiredReleaseEvidenceStepIds) {
    const step = steps.find((entry) => stringValue(entry.id) === requiredStepId);

    if (!step) {
      continue;
    }

    if (!stringValue(step.outputPath)) {
      problems.push(`${requiredStepId} outputPath is missing`);
    }

    problems.push(...commandProblems(`${requiredStepId}`, step.command));
  }

  const evidenceFiles = isRecord(pack.evidenceFiles) ? pack.evidenceFiles : undefined;

  if (!evidenceFiles) {
    problems.push("evidenceFiles must be an object");
  } else {
    for (const key of requiredEvidenceFileKeys) {
      if (!stringValue(evidenceFiles[key])) {
        problems.push(`evidenceFiles.${key} is missing`);
      }
    }
  }

  if (!release) {
    problems.push("release must be an object");
  } else {
    for (const key of [
      "commitRef",
      "repository",
      "branch",
      "sourceProvider",
      "targetEnvironment",
      "requiredStatusCheck",
      "operatorName",
      "releaseTicket",
      "publicBaseUrl",
      "targetEnvFile"
    ]) {
      requireEnvValue(problems, "release evidence pack", release, key);
    }

    const sourceProvider = stringValue(release.sourceProvider);

    if (!sourceProvider || !sourceProviders.has(sourceProvider)) {
      problems.push("release.sourceProvider must be one of github, gitlab, gitea, or generic");
    }

    if (stringValue(release.targetEnvironment) === "production" && !stringValue(release.observabilityTargetStackApiUrl)) {
      problems.push("release.observabilityTargetStackApiUrl is required for production release evidence packs");
    }
  }

  requireStringListIncludes(problems, "requiredManualInputs", pack.requiredManualInputs, "SITEFLOW_DOCKER_SOCKET_GID");

  const finalCommands = isRecord(pack.finalCommands) ? pack.finalCommands : undefined;

  if (!finalCommands) {
    problems.push("finalCommands must be an object");
  } else {
    for (const key of requiredFinalCommandKeys) {
      problems.push(...commandProblems(`finalCommands.${key}`, finalCommands[key]));
    }
  }

  for (const requiredStepId of requiredReleaseEvidenceStepIds) {
    const step = steps.find((entry) => stringValue(entry.id) === requiredStepId);

    if (step) {
      validateStepSemantics(problems, step, release, evidenceFiles);
    }
  }

  validateFinalCommandSemantics(problems, pack, release, evidenceFiles);

  if (problems.length > 0) {
    throw new Error(`Release evidence rehearsal pack is incomplete: ${problems.join("; ")}. Regenerate it with npm run --silent release:evidence:rehearsal-pack.`);
  }
}
