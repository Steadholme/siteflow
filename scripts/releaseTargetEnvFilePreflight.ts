export type TargetEnvFilePreflightIssueStatus = "missing" | "mismatch";

export interface TargetEnvFilePreflightIssue {
  name: string;
  status: TargetEnvFilePreflightIssueStatus;
  ruleId: string;
  message: string;
}

const digestPinnedImagePattern = /@sha256:[a-f0-9]{64}$/i;
const positiveIntegerPattern = /^[1-9]\d*$/;
const positiveNumberPattern = /^(?:[1-9]\d*(?:\.\d+)?|0?\.\d*[1-9]\d*)$/;
const dockerMemoryPattern = /^[1-9]\d*(?:[bkmg])?$/i;
const rawSecretEnvKeys = [
  "SITEFLOW_API_TOKEN",
  "SITEFLOW_METRICS_TOKEN",
  "SITEFLOW_APP_SECRET",
  "SITEFLOW_SEALING_KEY",
  "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY",
  "SITEFLOW_POSTGRES_PASSWORD",
  "SITEFLOW_GITHUB_WEBHOOK_SECRET",
  "SITEFLOW_GITLAB_WEBHOOK_SECRET",
  "SITEFLOW_GITEA_WEBHOOK_SECRET",
  "SITEFLOW_GENERIC_WEBHOOK_SECRET"
];
const requiredSecretFileKeys = [
  "SITEFLOW_API_TOKEN_FILE",
  "SITEFLOW_METRICS_TOKEN_FILE",
  "SITEFLOW_APP_SECRET_FILE",
  "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE",
  "SITEFLOW_POSTGRES_PASSWORD_FILE",
  "SITEFLOW_GITHUB_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GITLAB_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GITEA_WEBHOOK_SECRET_FILE",
  "SITEFLOW_GENERIC_WEBHOOK_SECRET_FILE"
];
const requiredPresentProductionKeys = [
  "DATABASE_URL",
  "SITEFLOW_ARTIFACT_ROOT",
  "SITEFLOW_EVIDENCE_ROOT",
  "SITEFLOW_BASE_DOMAIN",
  "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID"
];
const positiveIntegerKeys = [
  "SITEFLOW_API_PORT",
  "SITEFLOW_BUILD_MIN_FREE_BYTES",
  "SITEFLOW_BUILD_STEP_TIMEOUT_MS",
  "SITEFLOW_GIT_TIMEOUT_MS",
  "SITEFLOW_BUILD_MAX_ARTIFACT_BYTES",
  "SITEFLOW_BUILD_MAX_ARTIFACT_FILES",
  "SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES",
  "SITEFLOW_PREBUILT_MAX_FILES",
  "SITEFLOW_BUILD_PIDS_LIMIT"
];

function stringValue(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unquoteEnvValue(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  return quote && (quote === "\"" || quote === "'") && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

export function parseTargetEnvFile(contents: string) {
  const values = new Map<string, string>();

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separatorIndex = assignment.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = assignment.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(assignment.slice(separatorIndex + 1));

    if (key) {
      values.set(key, value);
    }
  }

  return values;
}

function issue(name: string, status: TargetEnvFilePreflightIssueStatus, ruleId: string, message: string) {
  return { name, status, ruleId, message };
}

function requirePresent(values: Map<string, string>, name: string, message?: string) {
  return stringValue(values.get(name))
    ? undefined
    : issue(name, "missing", "required", message ?? `${name} is required in the target env file.`);
}

function requireLiteral(values: Map<string, string>, name: string, expected: string) {
  const actual = stringValue(values.get(name));

  if (!actual) {
    return issue(name, "missing", "required", `${name}=${expected} is required in the target env file.`);
  }

  return actual === expected
    ? undefined
    : issue(name, "mismatch", "literal", `${name} must be ${expected} in the target env file.`);
}

function requireDigestPinnedImage(values: Map<string, string>, name: string) {
  const actual = stringValue(values.get(name));

  if (!actual) {
    return issue(name, "missing", "required", `${name} is required in the target env file.`);
  }

  return digestPinnedImagePattern.test(actual)
    ? undefined
    : issue(name, "mismatch", "digest_pinned_image", `${name} must be pinned with @sha256:<64 hex digest>.`);
}

function requirePositiveInteger(values: Map<string, string>, name: string) {
  const actual = stringValue(values.get(name));

  if (!actual) {
    return issue(name, "missing", "required", `${name} is required in the target env file.`);
  }

  return positiveIntegerPattern.test(actual)
    ? undefined
    : issue(name, "mismatch", "positive_integer", `${name} must be a positive integer.`);
}

function requirePositiveNumber(values: Map<string, string>, name: string) {
  const actual = stringValue(values.get(name));

  if (!actual) {
    return issue(name, "missing", "required", `${name} is required in the target env file.`);
  }

  return positiveNumberPattern.test(actual)
    ? undefined
    : issue(name, "mismatch", "positive_number", `${name} must be a positive number.`);
}

function requireDockerMemory(values: Map<string, string>, name: string) {
  const actual = stringValue(values.get(name));

  if (!actual) {
    return issue(name, "missing", "required", `${name} is required in the target env file.`);
  }

  return dockerMemoryPattern.test(actual)
    ? undefined
    : issue(name, "mismatch", "docker_memory", `${name} must be a positive Docker memory value such as 512m or 1g.`);
}

function requireWorkerUser(values: Map<string, string>) {
  const actual = stringValue(values.get("SITEFLOW_WORKER_USER"));
  const uid = actual?.split(":")[0]?.trim();

  if (!actual) {
    return issue("SITEFLOW_WORKER_USER", "missing", "required", "SITEFLOW_WORKER_USER is required in the target env file.");
  }

  if (!/^[0-9]+(?::[0-9]+)?$/.test(actual)) {
    return issue("SITEFLOW_WORKER_USER", "mismatch", "worker_user", "SITEFLOW_WORKER_USER must be a numeric user or user:group value.");
  }

  return uid === "0"
    ? issue("SITEFLOW_WORKER_USER", "mismatch", "worker_user", "SITEFLOW_WORKER_USER must not run the socket-mounted production worker as root.")
    : undefined;
}

function requireDockerSocketGid(values: Map<string, string>) {
  const actual = stringValue(values.get("SITEFLOW_DOCKER_SOCKET_GID"));

  if (!actual) {
    return issue("SITEFLOW_DOCKER_SOCKET_GID", "missing", "required", "SITEFLOW_DOCKER_SOCKET_GID is missing from the target env file.");
  }

  return /^\d+$/.test(actual)
    ? undefined
    : issue("SITEFLOW_DOCKER_SOCKET_GID", "mismatch", "docker_socket_gid", "SITEFLOW_DOCKER_SOCKET_GID must be a numeric group id.");
}

function databaseUrlHasInlinePassword(value: string | undefined) {
  const actual = stringValue(value);

  if (!actual) {
    return false;
  }

  try {
    return Boolean(new URL(actual).password);
  } catch {
    return false;
  }
}

function optionalTrustProxyIssue(values: Map<string, string>) {
  const actual = stringValue(values.get("SITEFLOW_TRUST_PROXY"));
  const normalized = actual?.toLowerCase();

  if (!actual || normalized === "false" || normalized === "0") {
    return undefined;
  }

  if (normalized === "true" || normalized === "1" || normalized === "loopback" || normalized === "private") {
    return undefined;
  }

  const explicitSources = actual.split(",").map((entry) => entry.trim()).filter(Boolean);
  const explicitlyScoped = explicitSources.length > 0 &&
    explicitSources.every((entry) => /^[a-f0-9:.]+(?:\/\d{1,3})?$/i.test(entry)) &&
    !explicitSources.some((entry) => entry === "0.0.0.0/0" || entry === "::/0");

  return explicitlyScoped
    ? undefined
    : issue("SITEFLOW_TRUST_PROXY", "mismatch", "trust_proxy", "SITEFLOW_TRUST_PROXY must be unset, false, loopback, private, or explicit trusted proxy IP/CIDR entries.");
}

function optionalSshKeyPairIssues(values: Map<string, string>) {
  const deployKey = stringValue(values.get("SITEFLOW_GIT_SSH_KEY_PATH"));
  const knownHosts = stringValue(values.get("SITEFLOW_GIT_KNOWN_HOSTS_PATH"));
  const issues: TargetEnvFilePreflightIssue[] = [];

  if (deployKey && !knownHosts) {
    issues.push(issue("SITEFLOW_GIT_KNOWN_HOSTS_PATH", "missing", "ssh_key_pair", "SITEFLOW_GIT_KNOWN_HOSTS_PATH is required when SITEFLOW_GIT_SSH_KEY_PATH is configured."));
  }

  if (knownHosts && !deployKey) {
    issues.push(issue("SITEFLOW_GIT_SSH_KEY_PATH", "missing", "ssh_key_pair", "SITEFLOW_GIT_SSH_KEY_PATH is required when SITEFLOW_GIT_KNOWN_HOSTS_PATH is configured."));
  }

  return issues;
}

function productionIssues(values: Map<string, string>) {
  const issues: Array<TargetEnvFilePreflightIssue | undefined> = [
    requireLiteral(values, "SITEFLOW_ENV", "production"),
    requireLiteral(values, "SITEFLOW_PUBLIC_SCHEME", "https"),
    requireLiteral(values, "SITEFLOW_BUILD_RUNNER", "docker"),
    requireLiteral(values, "SITEFLOW_BUILD_NETWORK", "none"),
    requireWorkerUser(values),
    requireDockerSocketGid(values),
    requirePositiveNumber(values, "SITEFLOW_BUILD_CPUS"),
    requireDockerMemory(values, "SITEFLOW_BUILD_MEMORY"),
    requireDigestPinnedImage(values, "SITEFLOW_IMAGE"),
    requireDigestPinnedImage(values, "SITEFLOW_POSTGRES_IMAGE"),
    requireDigestPinnedImage(values, "SITEFLOW_BUILD_IMAGE"),
    optionalTrustProxyIssue(values),
    ...requiredPresentProductionKeys.map((name) => requirePresent(values, name)),
    ...requiredSecretFileKeys.map((name) => requirePresent(values, name, `${name} is required so the target env file references secret files instead of raw secrets.`)),
    ...positiveIntegerKeys.map((name) => requirePositiveInteger(values, name)),
    ...optionalSshKeyPairIssues(values)
  ];

  for (const name of rawSecretEnvKeys) {
    if (stringValue(values.get(name))) {
      issues.push(issue(name, "mismatch", "raw_secret", `${name} must not be stored as a raw value in the target env file; use ${name}_FILE instead.`));
    }
  }

  if (databaseUrlHasInlinePassword(values.get("DATABASE_URL"))) {
    issues.push(issue("DATABASE_URL", "mismatch", "raw_secret", "DATABASE_URL must not contain inline password material in the target env file; use SITEFLOW_POSTGRES_PASSWORD_FILE with a passwordless URL."));
  }

  return issues.filter((entry): entry is TargetEnvFilePreflightIssue => Boolean(entry));
}

export function targetEnvFilePreflightIssues(
  values: Map<string, string>,
  targetEnvironment: string | null | undefined
) {
  if (targetEnvironment !== "production") {
    return [requireDockerSocketGid(values)].filter((entry): entry is TargetEnvFilePreflightIssue => Boolean(entry));
  }

  return productionIssues(values);
}

export function targetEnvFileUnreadableIssues(targetEnvironment: string | null | undefined) {
  const target = targetEnvironment === "production" ? "production target env file" : "target env file";

  return [
    issue("SITEFLOW_TARGET_ENV_FILE", "mismatch", "readable", `${target} cannot be read, so required target env-file keys cannot be verified.`)
  ];
}
