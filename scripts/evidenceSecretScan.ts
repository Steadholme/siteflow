export interface EvidenceSecretFinding {
  path: string;
  reason: string;
  key?: string;
}

export interface EvidenceSecretScanOptions {
  maxFindings?: number;
}

const defaultMaxFindings = 25;
const maxJsonStringDepth = 4;

const sensitiveValuePatterns: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: "secret canary",
    pattern: new RegExp(
      `${["SITEFLOW", "SECRET", "CANARY"].join("_")}_[A-Z0-9_-]+|(?:^|[^A-Z0-9_])${["SECRET", "CANARY"].join("_")}(?:$|[^A-Z0-9_])`,
      "i"
    )
  },
  { reason: "authorization bearer token", pattern: /\bAuthorization\b[^\n\r]{0,160}\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { reason: "bearer token", pattern: /\bBearer\s+(?!precedence\b)(?!tokens?\b)[A-Za-z0-9._~+/=-]{12,}\b/i },
  { reason: "SiteFlow token", pattern: /\bsf_(?:live|test)_[A-Za-z0-9_-]{8,}\b/ },
  { reason: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { reason: "npm token", pattern: /\bnpm_[A-Za-z0-9]{24,}\b/ },
  { reason: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { reason: "OpenAI token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { reason: "URL credentials", pattern: /[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:[^@\s/]+@/i },
  { reason: "Postgres URL password", pattern: /\bpostgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/i },
  { reason: "URL password query parameter", pattern: /[?&](?:password|token|secret)=([^&\s#]{4,})/i },
  { reason: "private key block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i }
];

const highRiskStringKeyPatterns: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "authorization field", pattern: /^(?:authorization|authorizationHeader|authHeader)$/i },
  { reason: "cookie field", pattern: /^(?:cookie|setCookie|setCookieHeader|sessionCookie)$/i },
  { reason: "password field", pattern: /(?:^|[-_])(?:password|passphrase)(?:[-_]|$)/i },
  { reason: "private key field", pattern: /(?:^|[-_])private[-_]?key(?:[-_]|$)/i },
  { reason: "raw credential field", pattern: /(?:^|[-_])raw[-_]?(?:credential|secret|token|key)(?:[-_]|$)/i },
  { reason: "raw credential field", pattern: /^(?:rawCredential|rawSecret|rawToken|rawKey)(?:$|[A-Z_-])/ },
  { reason: "token field", pattern: /^(?:token|authToken|apiToken|metricsToken)(?:$|[A-Z_-])/ },
  { reason: "token field", pattern: /(?:^|[-_])token(?:[-_]|$)/i },
  {
    reason: "secret field",
    pattern: new RegExp(`^(?:secret|sessionSecret|webhookSecret|${["delivery", "Secret"].join("")}|appSecret)(?:$|[A-Z_-])`)
  },
  { reason: "secret field", pattern: /(?:^|[-_])secret(?:[-_]|$)/i },
  { reason: "API key field", pattern: /(?:^|[-_])api[-_]?key(?:[-_]|$)/i },
  { reason: "signature header field", pattern: /(?:^|[-_])signature[-_]?header(?:[-_]|$)/i }
];

function safePublicReference(value: string, options: { allowEnvVarName?: boolean } = {}) {
  const normalized = value.trim();

  return !normalized ||
    /^\[?redacted[^\]]*\]?$/i.test(normalized) ||
    /^<redacted>$/i.test(normalized) ||
    normalized === "***" ||
    (options.allowEnvVarName === true && /^[A-Z][A-Z0-9_]{2,}$/.test(normalized)) ||
    /^sha256:[a-f0-9]{16,64}$/i.test(normalized) ||
    /^[a-f0-9]{32,64}$/i.test(normalized);
}

function highRiskKeyReason(key: string | undefined) {
  if (!key) {
    return undefined;
  }

  return highRiskStringKeyPatterns.find(({ pattern }) => pattern.test(key))?.reason;
}

function keyAllowsEnvVarReference(key: string | undefined) {
  return Boolean(
    key &&
      /(?:source|env(?:Var|ironment|Name)?|variable|ref|reference|identifier|fingerprint|hash|sha256|prefix)$/i.test(key)
  );
}

function shouldFlagHighRiskKeyValue(value: string, reason: string, key: string | undefined) {
  if (safePublicReference(value, { allowEnvVarName: keyAllowsEnvVarReference(key) })) {
    return false;
  }

  if (reason === "authorization field" || reason === "cookie field" || reason === "password field" || reason === "private key field") {
    return value.trim().length > 0;
  }

  return value.trim().length >= 8;
}

function pathKey(parentPath: string, key: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parentPath}.${key}`
    : `${parentPath}[${JSON.stringify(key)}]`;
}

function arrayPath(parentPath: string, index: number) {
  return `${parentPath}[${index}]`;
}

function addFinding(
  findings: EvidenceSecretFinding[],
  finding: EvidenceSecretFinding,
  maxFindings: number
) {
  if (findings.length < maxFindings) {
    findings.push(finding);
  }
}

function parsedJsonValue(value: string) {
  const trimmed = value.trim();

  if (!trimmed || !["{", "[", "\""].includes(trimmed[0])) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function scanValue(
  value: unknown,
  path: string,
  key: string | undefined,
  findings: EvidenceSecretFinding[],
  maxFindings: number,
  seen: WeakSet<object>,
  jsonStringDepth = 0
) {
  if (findings.length >= maxFindings) {
    return;
  }

  if (typeof value === "string") {
    for (const { reason, pattern } of sensitiveValuePatterns) {
      if (pattern.test(value)) {
        addFinding(findings, { path, key, reason }, maxFindings);
      }
    }

    const keyReason = highRiskKeyReason(key);

    if (keyReason && shouldFlagHighRiskKeyValue(value, keyReason, key)) {
      addFinding(findings, { path, key, reason: keyReason }, maxFindings);
    }

    if (findings.length < maxFindings && jsonStringDepth < maxJsonStringDepth) {
      const parsed = parsedJsonValue(value);

      if (parsed !== undefined) {
        scanValue(parsed, pathKey(path, "__json"), key, findings, maxFindings, seen, jsonStringDepth + 1);
      }
    }

    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanValue(entry, arrayPath(path, index), undefined, findings, maxFindings, seen, jsonStringDepth));
    return;
  }

  for (const [entryKey, entryValue] of Object.entries(value)) {
    scanValue(entryValue, pathKey(path, entryKey), entryKey, findings, maxFindings, seen, jsonStringDepth);
  }
}

export function scanEvidenceForRawSecrets(value: unknown, options: EvidenceSecretScanOptions = {}) {
  const findings: EvidenceSecretFinding[] = [];
  const maxFindings = options.maxFindings ?? defaultMaxFindings;

  scanValue(value, "$", undefined, findings, Math.max(1, maxFindings), new WeakSet<object>());

  return findings;
}

export function evidenceSecretFindingSummary(findings: EvidenceSecretFinding[]) {
  return findings.map((finding) => `${finding.path} (${finding.reason})`).join(", ");
}

export function sensitiveOutputReasons(value: string, options: EvidenceSecretScanOptions = {}) {
  if (!value.trim()) {
    return [];
  }

  const findings = scanEvidenceForRawSecrets(value, options);

  return [...new Set(findings.map((finding) => finding.reason))];
}
