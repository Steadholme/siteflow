export const REDACTION_PLACEHOLDER = "[REDACTED]";
export const SITEFLOW_SECRET_CANARY = "SITEFLOW_SECRET_CANARY_20260515";
const defaultSecretPatterns = [
    /SITEFLOW_SECRET_CANARY_[A-Z0-9_-]+/gi,
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
function getReplacement(options) {
    return options?.replacement ?? REDACTION_PLACEHOLDER;
}
function isSensitiveKey(key, options) {
    const patterns = [...defaultSensitiveKeyPatterns, ...(options?.sensitiveKeyPatterns ?? [])];
    return patterns.some((pattern) => pattern.test(key));
}
export function redactString(value, options) {
    const replacement = getReplacement(options);
    const patterns = [...defaultSecretPatterns, ...(options?.extraPatterns ?? [])];
    return patterns.reduce((nextValue, pattern) => nextValue.replace(pattern, replacement), value);
}
function redactUnknown(value, options, seen, key) {
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
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => {
        if (entryValue !== null && typeof entryValue === "object") {
            return [entryKey, redactUnknown(entryValue, options, seen, entryKey)];
        }
        return [entryKey, isSensitiveKey(entryKey, options) ? getReplacement(options) : redactUnknown(entryValue, options, seen, entryKey)];
    }));
}
export function redactSecrets(value, options) {
    return redactUnknown(value, options, new WeakSet());
}
export function redactLogLine(line, options) {
    return redactString(line, options);
}
export function redactLogLines(lines, options) {
    return lines.map((line) => redactLogLine(line, options));
}
export function redactManifest(manifest, options) {
    return redactSecrets(manifest, options);
}
export function redactRouteConfig(config, options) {
    return redactString(config, options);
}
export function redactProviderPayload(payload, options) {
    return redactSecrets(payload, options);
}
