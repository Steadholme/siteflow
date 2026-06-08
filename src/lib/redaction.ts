export const REDACTION_PLACEHOLDER = "[REDACTED]";
const secretCanaryPrefix = ["SITEFLOW", "SECRET", "CANARY"].join("_");
export const SITEFLOW_SECRET_CANARY = [secretCanaryPrefix, "20260515"].join("_");

export interface RedactionOptions {
  replacement?: string;
  extraPatterns?: RegExp[];
  sensitiveKeyPatterns?: RegExp[];
}

const defaultSecretPatterns = [
  new RegExp(`${secretCanaryPrefix}_[A-Z0-9_-]+`, "gi"),
  /\bsf_(?:live|test)_[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{8,}@/g
];

const defaultSensitiveKeyPatterns = [
  /secret/i,
  /token/i,
  /password/i,
  /private[-_]?key/i,
  /authorization/i,
  /signature/i,
  /api[-_]?key/i,
  /cookie/i
];

function getReplacement(options?: RedactionOptions) {
  return options?.replacement ?? REDACTION_PLACEHOLDER;
}

function isSensitiveKey(key: string, options?: RedactionOptions) {
  const patterns = [...defaultSensitiveKeyPatterns, ...(options?.sensitiveKeyPatterns ?? [])];
  return patterns.some((pattern) => pattern.test(key));
}

export function redactString(value: string, options?: RedactionOptions) {
  const replacement = getReplacement(options);
  const patterns = [...defaultSecretPatterns, ...(options?.extraPatterns ?? [])];

  return patterns.reduce((nextValue, pattern) => nextValue.replace(pattern, replacement), value);
}

function redactUnknown(value: unknown, options: RedactionOptions | undefined, seen: WeakSet<object>, key?: string): unknown {
  if (typeof value === "string") {
    return key && isSensitiveKey(key, options) ? getReplacement(options) : redactString(value, options);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return getReplacement(options);
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, options, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => {
      if (entryValue !== null && typeof entryValue === "object") {
        return [entryKey, redactUnknown(entryValue, options, seen, entryKey)];
      }

      return [entryKey, isSensitiveKey(entryKey, options) ? getReplacement(options) : redactUnknown(entryValue, options, seen, entryKey)];
    })
  );
}

export function redactSecrets<T>(value: T, options?: RedactionOptions): T {
  return redactUnknown(value, options, new WeakSet<object>()) as T;
}

export function redactLogLine(line: string, options?: RedactionOptions) {
  return redactString(line, options);
}

export function redactLogLines(lines: string[], options?: RedactionOptions) {
  return lines.map((line) => redactLogLine(line, options));
}

export function redactManifest<T extends Record<string, unknown>>(manifest: T, options?: RedactionOptions): T {
  return redactSecrets(manifest, options);
}

export function redactRouteConfig(config: string, options?: RedactionOptions) {
  return redactString(config, options);
}

export function redactProviderPayload<T>(payload: T, options?: RedactionOptions): T {
  return redactSecrets(payload, options);
}
