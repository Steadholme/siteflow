import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deploymentEnvironmentForBranch } from "../src/lib/environmentTarget.js";
import { sealSecretValue, unsealSecretValue } from "../src/lib/sealedSecrets.js";
import { analyticsWebVitalRating, normalizeAnalyticsEventInput } from "../src/lib/analytics.js";
import { redactLogLine, redactSecrets } from "../src/lib/redaction.js";
import { logChunkKey, releaseConsoleKey, SiteFlowNotFoundError } from "./readRepository.js";
function operationIdFor(idempotencyKey) {
    return `op_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20)}`;
}
function permissionLevel(permission) {
    return permission === "read" ? 0 : permission === "write" ? 1 : 2;
}
function rolePermissions(role) {
    switch (role) {
        case "owner":
            return ["read", "write", "admin"];
        case "member":
        case "developer":
            return ["read", "write"];
        case "viewer":
            return ["read"];
    }
}
function normalizePermissionScopes(scopes) {
    const normalized = Array.from(new Set(scopes)).sort((left, right) => permissionLevel(left) - permissionLevel(right));
    if (normalized.length === 0 || normalized.some((scope) => !["read", "write", "admin"].includes(scope))) {
        throw new Error("API token scopes must include read, write, or admin.");
    }
    return normalized;
}
function hasPermission(scopes, required) {
    return scopes.some((scope) => permissionLevel(scope) >= permissionLevel(required));
}
function apiTokenSecret() {
    return `sft_${randomBytes(24).toString("base64url")}`;
}
function apiTokenHash(token) {
    return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}
function normalizeFirewallRuleName(value) {
    const name = value.trim();
    if (!name || name.length > 80) {
        throw new Error("Firewall rule name is required and must be 80 characters or fewer.");
    }
    return name;
}
function normalizeFirewallAction(value) {
    if (value !== "allow" && value !== "block" && value !== "challenge") {
        throw new Error(`Invalid firewall action: ${String(value)}`);
    }
    return value;
}
function normalizeFirewallPriority(value) {
    if (value === undefined) {
        return 100;
    }
    if (!Number.isInteger(value) || value < 0 || value > 10000) {
        throw new Error("Firewall priority must be an integer from 0 to 10000.");
    }
    return value;
}
function normalizeFirewallConditions(conditions) {
    const normalized = {};
    if (conditions.ipRanges?.length) {
        normalized.ipRanges = Array.from(new Set(conditions.ipRanges.map((entry) => entry.trim()).filter(Boolean)));
    }
    if (conditions.pathPattern?.trim()) {
        const pathPattern = conditions.pathPattern.trim();
        if (!pathPattern.startsWith("/") || pathPattern.includes("..")) {
            throw new Error("Firewall path pattern must start with / and must not contain parent directory segments.");
        }
        normalized.pathPattern = pathPattern;
    }
    if (conditions.header?.name.trim()) {
        normalized.header = {
            name: conditions.header.name.trim().toLowerCase(),
            value: conditions.header.value?.trim() || undefined
        };
    }
    if (conditions.userAgent?.trim()) {
        normalized.userAgent = conditions.userAgent.trim();
    }
    if (!normalized.ipRanges?.length && !normalized.pathPattern && !normalized.header && !normalized.userAgent) {
        throw new Error("Firewall rule requires at least one condition.");
    }
    return normalized;
}
function normalizeEdgeConfigKey(value) {
    const key = value.trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
        throw new Error("Edge Config key must be 1-128 characters and use letters, numbers, _, ., :, or -.");
    }
    return key;
}
function normalizeRoutingRuleName(value) {
    const name = value.trim();
    if (!name || name.length > 80) {
        throw new Error("Routing rule name is required and must be 80 characters or fewer.");
    }
    return name;
}
function normalizeRoutingRuleKind(value) {
    if (value !== "redirect" && value !== "rewrite" && value !== "header") {
        throw new Error(`Invalid routing rule kind: ${String(value)}`);
    }
    return value;
}
function normalizeRoutingPath(value, field) {
    const pathName = value.trim();
    if (!pathName.startsWith("/") || pathName.includes("..")) {
        throw new Error(`Routing rule ${field} must start with / and must not contain parent directory segments.`);
    }
    return pathName;
}
function normalizeRedirectStatusCode(value) {
    if (value === undefined) {
        return 308;
    }
    if (value !== 301 && value !== 302 && value !== 307 && value !== 308) {
        throw new Error("Redirect status code must be 301, 302, 307, or 308.");
    }
    return value;
}
function normalizeRoutingHeaders(headers) {
    const normalized = (headers ?? [])
        .map((header) => ({
        key: header.key.trim().toLowerCase(),
        value: header.value.trim()
    }))
        .filter((header) => header.key && header.value);
    if (normalized.some((header) => !/^[a-z0-9-]+$/.test(header.key))) {
        throw new Error("Routing rule header keys must use HTTP token characters.");
    }
    return normalized;
}
function normalizeRoutingPriority(value) {
    if (value === undefined) {
        return 100;
    }
    if (!Number.isInteger(value) || value < 0 || value > 10000) {
        throw new Error("Routing rule priority must be an integer from 0 to 10000.");
    }
    return value;
}
function normalizeRoutingStatus(value) {
    if (value === undefined) {
        return undefined;
    }
    if (value === "active" || value === "disabled") {
        return value;
    }
    throw new Error("Routing rule status must be active or disabled.");
}
function normalizeRoutingRuleInput(command) {
    const kind = normalizeRoutingRuleKind(command.kind);
    const source = normalizeRoutingPath(command.source, "source");
    const destination = command.destination ? normalizeRoutingPath(command.destination, "destination") : undefined;
    const headers = normalizeRoutingHeaders(command.headers);
    if ((kind === "redirect" || kind === "rewrite") && !destination) {
        throw new Error("Redirect and rewrite routing rules require a destination.");
    }
    if (kind === "header" && headers.length === 0) {
        throw new Error("Header routing rules require at least one header.");
    }
    return {
        name: normalizeRoutingRuleName(command.name),
        kind,
        source,
        destination,
        statusCode: kind === "redirect" ? normalizeRedirectStatusCode(command.statusCode) : undefined,
        headers: kind === "header" ? headers : [],
        priority: normalizeRoutingPriority(command.priority)
    };
}
function prebuiltRoutingCommands(projectId, routing) {
    const commands = [];
    for (const [kind, rules] of [
        ["redirect", routing?.redirects],
        ["rewrite", routing?.rewrites],
        ["header", routing?.headers]
    ]) {
        for (const [index, rule] of (rules ?? []).entries()) {
            commands.push({
                projectId,
                name: rule.name ?? `vercel:${kind}:${index + 1}:${rule.source}`,
                kind,
                source: rule.source,
                destination: rule.destination,
                statusCode: rule.statusCode,
                headers: rule.headers,
                priority: (index + 1) * 10,
                actor: {
                    id: "siteflow:prebuilt",
                    name: "Prebuilt deploy",
                    role: "system"
                }
            });
        }
    }
    return commands;
}
const prebuiltActor = {
    id: "siteflow:prebuilt",
    name: "Prebuilt deploy",
    role: "system"
};
function prebuiltCronJobName(pathName) {
    const normalizedPath = pathName.trim().replace(/\s+/g, " ");
    const baseName = `vercel:${normalizedPath}`;
    if (baseName.length <= 80) {
        return baseName;
    }
    const digest = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 12);
    return `vercel:${normalizedPath.slice(0, 60)}:${digest}`;
}
function prebuiltCronCommands(projectId, crons) {
    return (crons ?? []).map((cron) => ({
        projectId,
        name: prebuiltCronJobName(cron.path),
        path: cron.path,
        schedule: cron.schedule,
        actor: prebuiltActor
    }));
}
function edgeConfigValueType(value) {
    if (typeof value === "boolean") {
        return "boolean";
    }
    if (typeof value === "number") {
        return "number";
    }
    if (typeof value === "string") {
        return "string";
    }
    return "json";
}
function normalizeBlobPathname(value) {
    const pathname = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!pathname || pathname === "." || pathname.length > 1024 || pathname.includes("\0")) {
        throw new Error("Blob pathname is required and must be 1-1024 characters.");
    }
    if (pathname.startsWith("../") || pathname.includes("/../") || pathname.endsWith("/..") || pathname === "..") {
        throw new Error("Blob pathname must not contain parent directory segments.");
    }
    return pathname;
}
function normalizeBlobPrefix(value) {
    if (!value?.trim()) {
        return undefined;
    }
    return normalizeBlobPathname(value);
}
function normalizeBlobAccess(value) {
    if (value === undefined) {
        return "public";
    }
    if (value !== "public" && value !== "private") {
        throw new Error("Blob access must be public or private.");
    }
    return value;
}
function normalizeBlobContentType(value) {
    const contentType = value?.trim() || "application/octet-stream";
    if (contentType.length > 160 || /[\r\n]/.test(contentType)) {
        throw new Error("Blob content type must be 160 characters or fewer.");
    }
    return contentType;
}
function normalizeBlobCacheControlMaxAge(value) {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isInteger(value) || value < 0 || value > 31536000) {
        throw new Error("Blob cache max age must be an integer from 0 to 31536000.");
    }
    return value;
}
function normalizeBlobLimit(value) {
    if (value === undefined) {
        return 100;
    }
    if (!Number.isFinite(value)) {
        return 100;
    }
    return Math.min(Math.max(Math.floor(value), 1), 1000);
}
function decodeBlobContentBase64(value) {
    if (typeof value !== "string") {
        throw new Error("Blob contentBase64 must be a base64 string.");
    }
    const normalized = value.trim();
    const content = Buffer.from(normalized, "base64");
    const compactInput = normalized.replace(/=+$/, "");
    const compactOutput = content.toString("base64").replace(/=+$/, "");
    if (compactInput !== compactOutput) {
        throw new Error("Blob contentBase64 must be valid base64.");
    }
    return content;
}
function blobUrl(projectId, pathname) {
    return `/api/projects/${encodeURIComponent(projectId)}/blobs/${encodeURIComponent(pathname)}`;
}
function normalizeCachePath(value) {
    const pathName = value.trim();
    if (!pathName.startsWith("/") || pathName.includes("\0") || pathName.includes("..") || pathName.length > 1024) {
        throw new Error("Cache path must start with / and must not contain parent directory segments.");
    }
    return pathName;
}
function normalizeCacheTag(value) {
    if (!value?.trim()) {
        return undefined;
    }
    const tag = value.trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tag)) {
        throw new Error("Cache tag must be 1-128 characters and use letters, numbers, _, ., :, or -.");
    }
    return tag;
}
function normalizeCacheStatus(value) {
    if (!value) {
        return undefined;
    }
    if (value === "fresh" || value === "stale" || value === "purged") {
        return value;
    }
    throw new Error("Cache status must be fresh, stale, or purged.");
}
function normalizeCacheLimit(value) {
    if (value === undefined) {
        return 100;
    }
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
        throw new Error("Cache limit must be an integer from 1 to 1000.");
    }
    return value;
}
function pathMatchesPattern(pathName, pattern) {
    if (pattern === "/(.*)" || pattern === "/:path*" || pattern === "/:path*?") {
        return pathName.startsWith("/");
    }
    if (pattern.endsWith("*")) {
        return pathName.startsWith(pattern.slice(0, -1));
    }
    if (pattern.includes(":")) {
        const pathSegments = pathName.split("/").filter(Boolean);
        const patternSegments = pattern.split("/").filter(Boolean);
        for (let index = 0; index < patternSegments.length; index += 1) {
            const segment = patternSegments[index];
            const pathSegment = pathSegments[index];
            if (segment.startsWith(":") && segment.endsWith("*")) {
                return true;
            }
            if (pathSegment === undefined) {
                return false;
            }
            if (segment.startsWith(":")) {
                continue;
            }
            if (segment !== pathSegment) {
                return false;
            }
        }
        return pathSegments.length === patternSegments.length;
    }
    return pathName === pattern;
}
function routingParams(pathName, pattern) {
    const params = new Map();
    const pathSegments = pathName.split("/").filter(Boolean);
    const patternSegments = pattern.split("/").filter(Boolean);
    for (let index = 0; index < patternSegments.length; index += 1) {
        const segment = patternSegments[index];
        if (!segment.startsWith(":")) {
            continue;
        }
        if (segment.endsWith("*")) {
            params.set(segment.slice(1, -1), pathSegments.slice(index).join("/"));
            break;
        }
        params.set(segment.slice(1), pathSegments[index] ?? "");
    }
    return params;
}
function applyRoutingDestination(pathName, source, destination) {
    if (!destination) {
        return undefined;
    }
    const params = routingParams(pathName, source);
    let nextPath = destination;
    for (const [key, value] of params) {
        nextPath = nextPath.replaceAll(`:${key}*`, value).replaceAll(`:${key}`, value);
    }
    return nextPath;
}
function ipv4ToNumber(value) {
    const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
    const parts = normalized.split(".");
    if (parts.length !== 4) {
        return undefined;
    }
    const octets = parts.map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return undefined;
    }
    return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}
function ipMatchesCidr(ip, cidr) {
    const [network, prefixRaw] = cidr.split("/", 2);
    const prefix = Number(prefixRaw);
    const ipValue = ipv4ToNumber(ip);
    const networkValue = ipv4ToNumber(network);
    if (ipValue === undefined || networkValue === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipValue & mask) === (networkValue & mask);
}
function ipMatches(ip, ranges) {
    if (!ranges?.length) {
        return true;
    }
    if (!ip) {
        return false;
    }
    return ranges.some((range) => {
        const normalized = range.trim();
        if (normalized.endsWith("*")) {
            return ip.startsWith(normalized.slice(0, -1));
        }
        if (normalized.includes("/")) {
            return ipMatchesCidr(ip, normalized);
        }
        return ip === normalized;
    });
}
function firewallConditionMatches(rule, request) {
    const conditions = rule.conditions;
    if (!ipMatches(request.ip, conditions.ipRanges)) {
        return false;
    }
    if (conditions.pathPattern && !pathMatchesPattern(request.path, conditions.pathPattern)) {
        return false;
    }
    if (conditions.header) {
        const headerValue = request.headers[conditions.header.name.toLowerCase()];
        if (!headerValue) {
            return false;
        }
        if (conditions.header.value && headerValue !== conditions.header.value) {
            return false;
        }
    }
    if (conditions.userAgent && !request.userAgent?.toLowerCase().includes(conditions.userAgent.toLowerCase())) {
        return false;
    }
    return true;
}
function assertReleaseCommand(command) {
    if (!command.projectId || !command.channel || !command.targetDeploymentId || !command.idempotencyKey) {
        throw new Error("Release command requires project, channel, target deployment, and idempotency key.");
    }
    if (!command.actor?.id || !command.reason.trim()) {
        throw new Error("Release command requires actor and audit reason.");
    }
}
function operationKind(action) {
    return action === "promote" ? "promotion" : "rollback";
}
function normalizeSlug(value) {
    const slug = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug)) {
        throw new Error("Project slug must be 3-63 characters of lowercase letters, numbers, and hyphens.");
    }
    return slug;
}
function normalizeName(value) {
    const name = value.trim();
    if (!name || name.length > 120) {
        throw new Error("Project name is required and must be 120 characters or fewer.");
    }
    return name;
}
function normalizeBranch(value, fallback = "main") {
    const branch = (value ?? fallback).trim();
    if (!branch || branch.length > 180 || branch.includes("..")) {
        throw new Error("Project branch must be a valid branch name.");
    }
    return branch;
}
function normalizeEnvironmentName(value) {
    const name = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
        throw new Error("Environment name must be DNS-safe and 1-63 characters.");
    }
    return name;
}
function normalizeDeployHookName(value) {
    const name = value.trim();
    if (!name || name.length > 80) {
        throw new Error("Deploy hook name is required and must be 80 characters or fewer.");
    }
    return name;
}
function normalizeCronJobName(value) {
    const name = value.trim();
    if (!name || name.length > 80) {
        throw new Error("Cron job name is required and must be 80 characters or fewer.");
    }
    return name;
}
function normalizeCronPath(value) {
    const pathName = value.trim();
    if (!pathName.startsWith("/") || pathName.includes("://") || pathName.includes("..") || pathName.length > 512) {
        throw new Error("Cron job path must start with / and must not contain protocol or parent directory segments.");
    }
    return pathName;
}
function normalizeCronSchedule(value) {
    const schedule = value.trim().replace(/\s+/g, " ");
    const fields = schedule.split(" ");
    if (fields.length !== 5) {
        throw new Error("Cron schedule must contain five fields: minute hour day-of-month month day-of-week.");
    }
    const ranges = [
        [0, 59],
        [0, 23],
        [1, 31],
        [1, 12],
        [0, 7]
    ];
    fields.forEach((field, index) => {
        if (!isCronField(field, ranges[index][0], ranges[index][1])) {
            throw new Error(`Cron schedule field ${index + 1} is invalid: ${field}.`);
        }
    });
    return schedule;
}
function isCronField(field, min, max) {
    return field.split(",").every((part) => isCronPart(part, min, max));
}
function isCronPart(part, min, max) {
    const [rangePart, stepPart] = part.split("/", 2);
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1 || Number(stepPart) > max)) {
        return false;
    }
    if (rangePart === "*") {
        return true;
    }
    if (rangePart.includes("-")) {
        const [left, right] = rangePart.split("-", 2).map(Number);
        return Number.isInteger(left) && Number.isInteger(right) && left >= min && right <= max && left <= right;
    }
    if (!/^\d+$/.test(rangePart)) {
        return false;
    }
    const value = Number(rangePart);
    return value >= min && value <= max;
}
function normalizeEnvironmentVariableKey(value) {
    const key = value.trim();
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) {
        throw new Error("Environment variable key must use uppercase letters, numbers, and underscores.");
    }
    return key;
}
function assertReleaseChannelName(value) {
    if (value !== "production" && value !== "staging" && value !== "preview") {
        throw new Error(`Invalid release channel: ${value}`);
    }
}
function normalizeHostname(value) {
    let hostname = value.trim().toLowerCase();
    if (hostname.includes("://")) {
        const parsed = new URL(hostname);
        if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
            throw new Error("Domain hostname must not include a path, query, or hash.");
        }
        hostname = parsed.hostname;
    }
    hostname = hostname.replace(/\.$/, "");
    if (!hostname || hostname.includes("/") || hostname.includes("?") || hostname.includes("#") || hostname.includes(":")) {
        throw new Error("Domain hostname must be a DNS hostname without protocol or path.");
    }
    if (hostname.length > 253) {
        throw new Error("Domain hostname must be 253 characters or fewer.");
    }
    const labels = hostname.split(".");
    if (labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error("Domain hostname must be DNS-safe.");
    }
    return hostname;
}
function normalizeProjectDomains(domains, defaultChannel = "production") {
    const seen = new Set();
    return domains.map((domain) => {
        const hostname = normalizeHostname(domain.hostname);
        const channel = domain.channel ?? defaultChannel;
        assertReleaseChannelName(channel);
        if (seen.has(hostname)) {
            throw new Error(`Duplicate domain hostname: ${hostname}`);
        }
        seen.add(hostname);
        return {
            hostname,
            channel,
            verified: domain.verified ?? true,
            lastCheckedAt: domain.lastCheckedAt ?? new Date().toISOString()
        };
    });
}
function projectIdForSlug(slug) {
    return `project_${slug.replace(/-/g, "_")}`;
}
function defaultRepository(slug, defaultBranch) {
    return {
        provider: "generic",
        owner: "local",
        name: slug,
        defaultBranch
    };
}
function defaultBuildSettings(framework, overrides) {
    return {
        installCommand: overrides?.installCommand ?? "npm install",
        buildCommand: overrides?.buildCommand ?? "npm run build",
        outputDirectory: overrides?.outputDirectory ?? "dist",
        rootDirectory: overrides?.rootDirectory,
        framework: overrides?.framework ?? framework,
        ignoreCommand: overrides?.ignoreCommand
    };
}
function defaultPolicy() {
    return {
        requiredChecks: [],
        retentionDays: 30,
        previewDeploymentsEnabled: true,
        cdnEnabled: false,
        requirePromotionReason: true
    };
}
function projectFromRow(row) {
    const repository = Object.keys(row.repository).length > 0
        ? row.repository
        : defaultRepository(row.slug, row.default_branch);
    const buildSettings = Object.keys(row.build_settings).length > 0
        ? row.build_settings
        : defaultBuildSettings(row.framework);
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        framework: row.framework,
        defaultBranch: row.default_branch,
        productionBranch: row.production_branch,
        repository,
        buildSettings,
        domains: [],
        policy: defaultPolicy(),
        secrets: [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
function environmentFromRow(row) {
    return {
        projectId: row.project_id,
        name: row.name,
        type: row.type,
        branchPattern: row.branch_pattern ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
function variableFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        key: row.key,
        targetEnvironment: row.target_environment,
        scope: row.scope,
        source: row.source,
        fingerprint: row.fingerprint,
        updatedAt: row.updated_at.toISOString(),
        updatedBy: row.updated_by ?? undefined
    };
}
function domainFromRow(row) {
    return {
        hostname: row.hostname,
        channel: row.channel,
        verified: row.verified,
        lastCheckedAt: row.last_checked_at.toISOString()
    };
}
function routeRevisionFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        channel: row.channel,
        deploymentId: row.deployment_id,
        previousDeploymentId: row.previous_deployment_id ?? undefined,
        status: row.status,
        generatedConfig: row.generated_config,
        validationSummary: row.validation_summary,
        createdAt: row.created_at.toISOString(),
        appliedAt: row.applied_at?.toISOString(),
        failedReason: row.failed_reason ?? undefined
    };
}
function rollingReleaseFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        channel: row.channel,
        currentDeploymentId: row.current_deployment_id,
        candidateDeploymentId: row.candidate_deployment_id,
        percentage: row.percentage,
        status: row.status,
        actor: row.actor,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        completedAt: row.completed_at?.toISOString(),
        abortedAt: row.aborted_at?.toISOString()
    };
}
function normalizeRolloutPercentage(value, allowComplete = false) {
    if (!Number.isInteger(value) || value < 1 || value > (allowComplete ? 100 : 99)) {
        throw new Error(`Rolling release percentage must be an integer from 1 to ${allowComplete ? 100 : 99}.`);
    }
    return value;
}
function rolloutBucketPercent(value) {
    const digest = createHash("sha256").update(value).digest("hex");
    return Number.parseInt(digest.slice(0, 8), 16) % 100;
}
function assertRollingCommand(command) {
    if (!command.projectId || !command.channel || !command.idempotencyKey) {
        throw new Error("Rolling release command requires project, channel, and idempotency key.");
    }
    if (!command.actor?.id || !command.reason.trim()) {
        throw new Error("Rolling release command requires actor and audit reason.");
    }
}
function rollingGeneratedConfig(rolloutId, projectId, channel, currentDeploymentId, candidateDeploymentId, percentage, domains) {
    return [
        `rolling_release=${rolloutId}`,
        `project=${projectId}`,
        `channel=${channel}`,
        `current_deployment=${currentDeploymentId}`,
        `candidate_deployment=${candidateDeploymentId}`,
        `candidate_percentage=${percentage}`,
        ...domains.map((domain) => `host=${domain.hostname}`)
    ].join("\n");
}
function normalizeBaseDomain(value) {
    const domain = value.trim().toLowerCase().replace(/^\*\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        throw new Error("Base domain must be a valid public DNS suffix, for example w33d.xyz.");
    }
    return domain;
}
function resolveBaseDomain(commandBaseDomain, defaultBaseDomain) {
    const baseDomain = commandBaseDomain ?? defaultBaseDomain;
    if (!baseDomain) {
        throw new Error("Base domain is required. Configure SITEFLOW_BASE_DOMAIN on the server or pass baseDomain in the deploy request.");
    }
    return normalizeBaseDomain(baseDomain);
}
function normalizeHostPrefix(value) {
    const prefix = value?.trim().toLowerCase() || randomUUID().replace(/-/g, "").slice(0, 12);
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(prefix)) {
        throw new Error("Preview host prefix must be DNS-safe.");
    }
    return prefix;
}
function safeArtifactPath(filePath) {
    const normalized = path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\/+/, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
        throw new Error(`Invalid artifact file path: ${filePath}`);
    }
    return normalized;
}
function verifyFile(file) {
    const bytes = Buffer.from(file.contentBase64, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== file.sha256) {
        throw new Error(`Artifact checksum mismatch for ${file.path}`);
    }
    if (bytes.byteLength !== file.size) {
        throw new Error(`Artifact size mismatch for ${file.path}`);
    }
    return bytes;
}
const precompressibleExtensions = new Set([
    ".html",
    ".css",
    ".js",
    ".mjs",
    ".json",
    ".svg",
    ".txt",
    ".xml",
    ".webmanifest"
]);
function isPrecompressibleBasePath(filePath) {
    if (filePath.startsWith(".siteflow/functions/")) {
        return false;
    }
    if (filePath.endsWith(".br") || filePath.endsWith(".gz")) {
        return false;
    }
    return precompressibleExtensions.has(path.posix.extname(filePath).toLowerCase());
}
function precompressedStats(files) {
    const paths = new Set(files.map((file) => safeArtifactPath(file.path)));
    const stats = {
        br: 0,
        gzip: 0
    };
    for (const filePath of paths) {
        if (filePath.endsWith(".br")) {
            const basePath = filePath.slice(0, -".br".length);
            if (paths.has(basePath) && isPrecompressibleBasePath(basePath)) {
                stats.br += 1;
            }
            continue;
        }
        if (filePath.endsWith(".gz")) {
            const basePath = filePath.slice(0, -".gz".length);
            if (paths.has(basePath) && isPrecompressibleBasePath(basePath)) {
                stats.gzip += 1;
            }
        }
    }
    return stats;
}
function fingerprintSecret(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}
function deployHookToken() {
    return `sfh_${randomBytes(24).toString("base64url")}`;
}
function deployHookTokenHash(token) {
    return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}
function stableId(prefix, value) {
    return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
function branchFromRef(value) {
    if (!value) {
        return undefined;
    }
    return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}
function deployHookFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        branch: row.branch,
        targetEnvironment: row.target_environment,
        tokenPrefix: row.token_prefix,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString(),
        lastTriggeredAt: row.last_triggered_at?.toISOString()
    };
}
function cronJobFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        path: row.path,
        schedule: row.schedule,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        disabledAt: row.disabled_at?.toISOString(),
        lastDispatchedAt: row.last_dispatched_at?.toISOString()
    };
}
function cronDispatchFromRow(row) {
    return {
        id: row.id,
        cronJobId: row.cron_job_id,
        projectId: row.project_id,
        targetUrl: row.target_url,
        method: row.method,
        userAgent: row.user_agent,
        status: row.status,
        reason: row.reason,
        scheduledAt: row.scheduled_at.toISOString(),
        dispatchedAt: row.dispatched_at.toISOString(),
        responseStatus: row.response_status ?? undefined,
        errorMessage: row.error_message ?? undefined
    };
}
function analyticsEventFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        kind: row.kind,
        path: row.path,
        referrer: row.referrer ?? undefined,
        country: row.country ?? undefined,
        browser: row.browser ?? undefined,
        device: row.device ?? undefined,
        eventName: row.event_name ?? undefined,
        vitalName: row.vital_name ?? undefined,
        vitalValue: row.vital_value === null ? undefined : pgNumber(row.vital_value),
        occurredAt: row.occurred_at.toISOString(),
        receivedAt: row.received_at.toISOString()
    };
}
function analyticsDimensionsFromRows(rows, total) {
    return rows.map((row) => {
        const count = pgNumber(row.count);
        return {
            name: row.name,
            count,
            percentage: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0
        };
    });
}
function analyticsWebVitalsFromRows(rows) {
    return rows.map((row) => {
        const p75 = pgNumber(row.p75);
        return {
            name: row.name,
            count: pgNumber(row.count),
            p75,
            rating: analyticsWebVitalRating(row.name, p75)
        };
    });
}
const observabilityLogSources = new Set(["build", "runtime", "function", "cron"]);
const observabilityLogSeverities = new Set(["info", "warning", "error"]);
const observabilitySeverityRank = { info: 0, warning: 1, error: 2 };
function normalizeLogSource(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value === "string" && observabilityLogSources.has(value)) {
        return value;
    }
    throw new Error(`Invalid observability log source: ${String(value)}`);
}
function normalizeLogSeverity(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value === "string" && observabilityLogSeverities.has(value)) {
        return value;
    }
    throw new Error(`Invalid observability log severity: ${String(value)}`);
}
function normalizeLogLimit(value) {
    if (value === undefined) {
        return 50;
    }
    return Math.min(Math.max(Math.floor(value), 1), 100);
}
function normalizeLogCursor(value) {
    if (!value) {
        return 0;
    }
    if (!/^\d+$/.test(value)) {
        throw new Error("Log cursor must be a numeric offset.");
    }
    return Number.parseInt(value, 10);
}
function normalizeLogSearch(value) {
    const search = value?.trim();
    return search ? search.slice(0, 200) : undefined;
}
function normalizeLogQueryName(value) {
    const name = value.trim();
    if (!name || name.length > 80) {
        throw new Error("Saved log query name is required and must be 80 characters or fewer.");
    }
    return name;
}
function normalizeLogDrainName(value) {
    const name = value.trim();
    if (!name || name.length > 80) {
        throw new Error("Log drain name is required and must be 80 characters or fewer.");
    }
    return name;
}
function normalizeLogDrainUrl(value) {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Log drain URL must use http or https.");
    }
    if (parsed.username || parsed.password) {
        throw new Error("Log drain URL must not include credentials.");
    }
    return parsed.toString();
}
function normalizeLogDrainSources(values) {
    const sources = values && values.length > 0 ? values : ["build", "runtime", "function", "cron"];
    const unique = Array.from(new Set(sources.map((source) => normalizeLogSource(source))));
    if (unique.length === 0) {
        throw new Error("Log drain requires at least one log source.");
    }
    return unique;
}
function generateLogDrainSigningSecret() {
    return `sfd_${randomBytes(24).toString("base64url")}`;
}
function logDrainSigningSecretPrefix(secret) {
    return secret.slice(0, 12);
}
function logFiltersFromCommand(command) {
    return {
        source: normalizeLogSource(command.source),
        severity: normalizeLogSeverity(command.severity),
        deploymentId: command.deploymentId?.trim() || undefined,
        search: normalizeLogSearch(command.search)
    };
}
function logFiltersFromSaved(filters) {
    return {
        source: normalizeLogSource(filters.source),
        severity: normalizeLogSeverity(filters.severity),
        deploymentId: filters.deploymentId?.trim() || undefined,
        search: normalizeLogSearch(filters.search)
    };
}
function savedLogQueryFromRow(row) {
    const filters = row.filters;
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        filters: {
            source: normalizeLogSource(filters.source),
            severity: normalizeLogSeverity(filters.severity),
            deploymentId: filters.deploymentId?.trim() || undefined,
            search: normalizeLogSearch(filters.search)
        },
        createdBy: row.created_by ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
function logDrainFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        url: row.url,
        sources: normalizeLogDrainSources(row.sources),
        minimumSeverity: normalizeLogSeverity(row.minimum_severity) ?? "info",
        status: row.status,
        signingSecretPrefix: row.signing_secret_prefix,
        createdBy: row.created_by ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        lastDeliveredAt: row.last_delivered_at?.toISOString()
    };
}
function logDrainDeliveryFromRow(row) {
    return {
        id: row.id,
        drainId: row.drain_id,
        projectId: row.project_id,
        status: row.status,
        responseStatus: row.response_status ?? undefined,
        eventsDelivered: row.events_delivered,
        attempt: row.attempt,
        payloadSha256: row.payload_sha256,
        errorMessage: row.error_message ?? undefined,
        deliveredAt: row.delivered_at.toISOString()
    };
}
function teamMemberFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        actor: row.actor,
        role: row.role,
        permissions: row.permissions,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
function apiTokenFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id ?? undefined,
        name: row.name,
        tokenPrefix: row.token_prefix,
        scopes: row.scopes,
        status: row.status,
        createdBy: row.created_by ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString(),
        lastUsedAt: row.last_used_at?.toISOString()
    };
}
function auditEventFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        action: row.action,
        actor: row.actor,
        targetType: row.target_type,
        targetId: row.target_id,
        summary: row.summary,
        reason: row.reason ?? undefined,
        createdAt: row.created_at.toISOString(),
        metadata: row.metadata
    };
}
function firewallRuleFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        action: row.action,
        priority: row.priority,
        status: row.status,
        conditions: normalizeFirewallConditions(row.conditions),
        createdBy: row.created_by ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        disabledAt: row.disabled_at?.toISOString()
    };
}
function edgeConfigFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        key: row.key,
        value: redactSecrets(row.value),
        valueType: row.value_type,
        createdBy: row.created_by ?? undefined,
        updatedBy: row.updated_by ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
function routingRuleFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        kind: row.kind,
        source: row.source,
        destination: row.destination ?? undefined,
        statusCode: row.status_code ?? undefined,
        headers: normalizeRoutingHeaders(row.headers),
        priority: row.priority,
        status: row.status,
        createdBy: row.created_by ?? undefined,
        updatedBy: row.updated_by ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        disabledAt: row.disabled_at?.toISOString()
    };
}
function blobFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        pathname: row.pathname,
        access: row.access,
        contentType: row.content_type,
        cacheControlMaxAge: row.cache_control_max_age ?? undefined,
        size: pgNumber(row.size_bytes),
        sha256: row.sha256,
        etag: row.etag,
        url: row.url,
        uploadedBy: row.uploaded_by ?? undefined,
        uploadedAt: row.uploaded_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
function cacheEntryFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        key: row.cache_key,
        path: row.path,
        tags: row.tags,
        status: row.status,
        contentType: row.content_type,
        size: pgNumber(row.size_bytes),
        etag: row.etag,
        maxAgeSeconds: row.max_age_seconds,
        staleWhileRevalidateSeconds: row.stale_while_revalidate_seconds,
        lastGeneratedAt: row.last_generated_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        staleAt: row.stale_at.toISOString(),
        purgedAt: row.purged_at?.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
function functionInvocationFromRow(row) {
    return {
        id: row.id,
        deploymentId: row.deployment_id,
        projectId: row.project_id,
        path: row.path,
        method: row.method,
        status: row.status,
        responseStatus: row.response_status,
        durationMs: row.duration_ms,
        requestId: row.request_id,
        errorMessage: row.error_message ?? undefined,
        logs: Array.isArray(row.logs) ? row.logs.map(String) : [],
        invokedAt: row.invoked_at.toISOString()
    };
}
function runtimeSummary(invocations) {
    const durations = invocations.map((invocation) => invocation.durationMs).sort((left, right) => left - right);
    const errors = invocations.filter((invocation) => invocation.status === "failed").length;
    const p95Index = durations.length ? Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1) : 0;
    return {
        invocations: invocations.length,
        errors,
        errorRate: invocations.length ? Number((errors / invocations.length).toFixed(3)) : 0,
        averageDurationMs: invocations.length
            ? Math.round(invocations.reduce((total, invocation) => total + invocation.durationMs, 0) / invocations.length)
            : 0,
        p95DurationMs: durations[p95Index] ?? 0,
        lastInvokedAt: invocations[0]?.invokedAt
    };
}
function functionRuntimeItem(projectId, deploymentId, entry, invocations) {
    return {
        projectId,
        deploymentId,
        function: entry,
        limits: {
            timeoutMs: entry.timeoutMs ?? 10000,
            memoryMb: entry.memoryMb ?? 512,
            concurrency: entry.concurrency ?? 50
        },
        summary: runtimeSummary(invocations.filter((invocation) => invocation.path === entry.path))
    };
}
function observabilityLogEntryFromRow(row) {
    const metadata = redactSecrets(row.metadata ?? {});
    return {
        id: row.id,
        projectId: row.project_id,
        source: row.source,
        severity: row.severity,
        message: redactLogLine(row.message),
        timestamp: row.occurred_at.toISOString(),
        deploymentId: row.deployment_id ?? undefined,
        buildJobId: row.build_job_id ?? undefined,
        cronJobId: row.cron_job_id ?? undefined,
        requestId: row.request_id ?? undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined
    };
}
async function insertDeployHookEvent(client, input) {
    const eventId = stableId("hookevent", input.idempotencyKey ?? `${input.hookId}:${input.action}:${randomUUID()}`);
    await client.query(`
      INSERT INTO siteflow_deploy_hook_events (
        id,
        hook_id,
        project_id,
        action,
        actor,
        summary,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
      ON CONFLICT (id) DO NOTHING
    `, [
        eventId,
        input.hookId,
        input.projectId,
        input.action,
        input.actor ? JSON.stringify(input.actor) : null,
        input.summary,
        JSON.stringify(input.metadata ?? {})
    ]);
}
async function insertAuditEvent(client, event) {
    const actor = event.actor ?? {
        id: "system:siteflow",
        name: "SiteFlow",
        role: "system"
    };
    await client.query(`
      INSERT INTO siteflow_audit_events (
        id,
        project_id,
        action,
        actor,
        target_type,
        target_id,
        summary,
        reason,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb)
    `, [
        stableId("audit", `${event.projectId}:${event.action}:${event.targetType}:${event.targetId}:${randomUUID()}`),
        event.projectId,
        event.action,
        JSON.stringify(actor),
        event.targetType,
        event.targetId,
        event.summary,
        event.reason?.trim() || null,
        JSON.stringify(event.metadata ?? {})
    ]);
}
function sourceEventFromRow(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        kind: row.kind,
        status: row.status,
        disposition: row.disposition,
        providerDeliveryId: row.provider_delivery_id,
        branch: row.branch,
        commitSha: row.commit_sha,
        commitMessage: row.commit_message,
        commitAuthor: row.commit_author,
        receivedAt: row.received_at.toISOString(),
        actor: row.actor
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function pgNumber(value) {
    return typeof value === "number" ? value : Number(value);
}
function functionEntrypointsFromManifest(manifest) {
    const value = manifest.functions;
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((entry) => {
        if (!isRecord(entry)) {
            return [];
        }
        const functionPath = typeof entry.path === "string" ? entry.path : undefined;
        const sourcePath = typeof entry.sourcePath === "string" ? entry.sourcePath : undefined;
        const runtime = entry.runtime === "nodejs20.x" ? entry.runtime : undefined;
        const handler = entry.handler === "handler" ? "handler" : entry.handler === "default" ? "default" : undefined;
        const methods = Array.isArray(entry.methods)
            ? entry.methods.filter((method) => typeof method === "string")
            : undefined;
        const timeoutMs = typeof entry.timeoutMs === "number" ? entry.timeoutMs : undefined;
        const memoryMb = typeof entry.memoryMb === "number" ? entry.memoryMb : undefined;
        const concurrency = typeof entry.concurrency === "number" ? entry.concurrency : undefined;
        const regions = Array.isArray(entry.regions)
            ? entry.regions.filter((region) => typeof region === "string")
            : undefined;
        const failoverRegions = Array.isArray(entry.failoverRegions)
            ? entry.failoverRegions.filter((region) => typeof region === "string")
            : undefined;
        if (!functionPath || !sourcePath || !runtime || !handler) {
            return [];
        }
        return [
            {
                path: functionPath,
                sourcePath,
                runtime,
                handler,
                methods: methods && methods.length > 0 ? methods : undefined,
                timeoutMs,
                memoryMb,
                concurrency,
                regions: regions && regions.length > 0 ? regions : undefined,
                failoverRegions: failoverRegions && failoverRegions.length > 0 ? failoverRegions : undefined
            }
        ];
    });
}
function deploymentVersion(createdAt) {
    const iso = createdAt.toISOString();
    return `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}.${iso.slice(11, 16).replace(":", "")}`;
}
function retainedUntil(createdAt) {
    const retained = new Date(createdAt);
    retained.setUTCDate(retained.getUTCDate() + 30);
    return retained.toISOString();
}
function verificationStatusForDeployment(status) {
    if (status === "ready") {
        return "verified";
    }
    if (status === "failed" || status === "canceled") {
        return "failed";
    }
    return "pending";
}
function isFinishedBuildStatus(status) {
    return status === "succeeded"
        || status === "failed"
        || status === "canceled"
        || status === "timed_out"
        || status === "skipped";
}
function evidenceStatusForBuild(status) {
    if (status === "succeeded" || status === "skipped") {
        return "pass";
    }
    if (status === "failed" || status === "canceled" || status === "timed_out") {
        return "fail";
    }
    return "pending";
}
function evidenceStatusForRoute(status) {
    if (!status || status === "planned" || status === "validating" || status === "pending_apply") {
        return "pending";
    }
    if (status === "applied" || status === "superseded") {
        return "pass";
    }
    return status === "failed" ? "fail" : "warning";
}
function artifactManifestFromRow(row, createdAt) {
    const manifest = isRecord(row.artifact_manifest) ? row.artifact_manifest : {};
    const checksum = typeof manifest.checksum === "string" && manifest.checksum
        ? manifest.checksum
        : row.checksum.startsWith("sha256:")
            ? row.checksum
            : `sha256:${row.checksum}`;
    return {
        entrypoint: typeof manifest.entrypoint === "string" && manifest.entrypoint ? manifest.entrypoint : "index.html",
        fileCount: typeof manifest.fileCount === "number" ? manifest.fileCount : row.file_count,
        totalBytes: typeof manifest.totalBytes === "number" ? manifest.totalBytes : pgNumber(row.total_bytes),
        checksum,
        generatedAt: typeof manifest.generatedAt === "string" && manifest.generatedAt ? manifest.generatedAt : createdAt.toISOString(),
        functions: functionEntrypointsFromManifest(manifest),
        metadata: isRecord(manifest.metadata) ? manifest.metadata : {}
    };
}
function functionsFromArtifactManifest(value) {
    return isRecord(value) ? functionEntrypointsFromManifest(value) : [];
}
function artifactManifestRoutingConfig(value) {
    const metadata = isRecord(value) && isRecord(value.metadata) ? value.metadata : {};
    const routing = isRecord(metadata.routing) ? metadata.routing : {};
    return {
        cleanUrls: typeof routing.cleanUrls === "boolean" ? routing.cleanUrls : undefined,
        trailingSlash: typeof routing.trailingSlash === "boolean" ? routing.trailingSlash : undefined,
        skipTrailingSlashRedirect: typeof routing.skipTrailingSlashRedirect === "boolean" ? routing.skipTrailingSlashRedirect : undefined,
        redirects: artifactRoutingRules("redirect", routing.redirects),
        rewrites: artifactRoutingRules("rewrite", routing.rewrites),
        headers: artifactRoutingRules("header", routing.headers)
    };
}
function artifactManifestImageConfig(value) {
    const metadata = isRecord(value) && isRecord(value.metadata) ? value.metadata : {};
    const images = isRecord(metadata.images) ? metadata.images : undefined;
    if (!images) {
        return undefined;
    }
    const config = {
        sizes: Array.isArray(images.sizes)
            ? images.sizes.filter((entry) => Number.isInteger(entry) && entry > 0)
            : undefined,
        qualities: Array.isArray(images.qualities)
            ? images.qualities.filter((entry) => Number.isInteger(entry) && entry > 0)
            : undefined,
        formats: Array.isArray(images.formats)
            ? images.formats.filter((entry) => entry === "image/avif" || entry === "image/webp")
            : undefined,
        minimumCacheTTL: Number.isInteger(images.minimumCacheTTL) && typeof images.minimumCacheTTL === "number" && images.minimumCacheTTL >= 0
            ? images.minimumCacheTTL
            : undefined,
        dangerouslyAllowSVG: typeof images.dangerouslyAllowSVG === "boolean" ? images.dangerouslyAllowSVG : undefined,
        contentSecurityPolicy: typeof images.contentSecurityPolicy === "string" ? images.contentSecurityPolicy : undefined,
        contentDispositionType: images.contentDispositionType === "inline" || images.contentDispositionType === "attachment"
            ? images.contentDispositionType
            : undefined
    };
    return Object.values(config).some((entry) => entry !== undefined) ? config : undefined;
}
function artifactManifestRuntimeEnvironment(value) {
    const metadata = isRecord(value) && isRecord(value.metadata) ? value.metadata : {};
    const sealedRuntimeEnv = isRecord(metadata.sealedRuntimeEnv) ? metadata.sealedRuntimeEnv : undefined;
    if (!sealedRuntimeEnv) {
        return {};
    }
    return unsealEnvironmentVariables(Object.fromEntries(Object.entries(sealedRuntimeEnv).filter((entry) => typeof entry[1] === "string")));
}
function artifactRoutingRules(kind, value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const now = new Date(0).toISOString();
    const rules = value.flatMap((entry, index) => {
        if (!isRecord(entry) || typeof entry.source !== "string") {
            return [];
        }
        const destination = typeof entry.destination === "string" ? entry.destination : undefined;
        const headers = Array.isArray(entry.headers)
            ? normalizeRoutingHeaders(entry.headers)
            : [];
        if ((kind === "redirect" || kind === "rewrite") && !destination) {
            return [];
        }
        if (kind === "header" && headers.length === 0) {
            return [];
        }
        return [
            {
                id: `artifact_${kind}_${index}`,
                projectId: "artifact",
                name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `artifact-${kind}-${index + 1}`,
                kind,
                source: entry.source,
                destination,
                statusCode: kind === "redirect" && typeof entry.statusCode === "number" ? normalizeRedirectStatusCode(entry.statusCode) : undefined,
                headers: kind === "header" ? headers : [],
                priority: 100 + index,
                status: "active",
                createdAt: now,
                updatedAt: now
            }
        ];
    });
    return rules.length ? rules : undefined;
}
function unsealEnvironmentVariables(values) {
    return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, unsealSecretValue(value)]));
}
function deploymentSummaryFromRow(row) {
    const manifest = artifactManifestFromRow(row, row.created_at);
    const verificationStatus = verificationStatusForDeployment(row.status);
    return {
        id: row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        version: deploymentVersion(row.created_at),
        commitSha: row.source_commit_sha ?? "prebuilt",
        branch: row.source_branch ?? "manual",
        status: row.status,
        artifactVerificationStatus: verificationStatus,
        routeRevisionStatus: row.route_revision_status ?? "planned",
        cdnOperationState: "skipped",
        createdAt: row.created_at.toISOString(),
        readyAt: row.status === "ready" ? row.created_at.toISOString() : undefined
    };
}
function projectFromInspectRow(row) {
    return projectFromRow({
        id: row.project_id,
        slug: row.project_slug,
        name: row.project_name,
        status: row.project_status,
        framework: row.project_framework,
        default_branch: row.project_default_branch,
        production_branch: row.project_production_branch,
        repository: row.project_repository,
        build_settings: row.project_build_settings,
        created_at: row.project_created_at,
        updated_at: row.project_updated_at
    });
}
function sourceEventFromInspectRow(row) {
    return {
        id: row.source_event_id ?? `src_${row.id}`,
        projectId: row.project_id,
        kind: row.source_kind ?? "manual",
        status: row.source_status ?? "accepted",
        disposition: row.source_disposition ?? "build_requested",
        providerDeliveryId: row.provider_delivery_id ?? `prebuilt:${row.id}`,
        branch: row.source_branch_name ?? row.source_branch ?? "manual",
        commitSha: row.source_commit_sha ?? "prebuilt",
        commitMessage: row.source_commit_message ?? "Prebuilt artifact uploaded through SiteFlow CLI.",
        commitAuthor: row.source_commit_author ?? "SiteFlow CLI",
        receivedAt: (row.source_received_at ?? row.deployment_created_at).toISOString(),
        actor: row.source_actor ?? {
            id: "siteflow:cli",
            name: "SiteFlow CLI",
            role: "developer"
        }
    };
}
function buildJobFromInspectRow(row, sourceEvent, project) {
    const buildSettings = project.buildSettings ?? defaultBuildSettings(project.framework);
    const fallbackStatus = row.deployment_status === "failed" ? "failed" : "succeeded";
    const status = row.build_status ?? fallbackStatus;
    const finishedAt = row.finished_at ?? (isFinishedBuildStatus(status)
        ? row.deployment_created_at
        : null);
    return {
        id: row.build_job_id ?? `build_${row.id}`,
        projectId: row.project_id,
        sourceEventId: sourceEvent.id,
        status,
        framework: row.build_framework ?? buildSettings.framework ?? project.framework,
        installCommand: row.install_command ?? "prebuilt artifact",
        buildCommand: row.build_command ?? "upload artifact",
        outputDirectory: row.output_directory ?? buildSettings.outputDirectory ?? ".",
        queuedAt: (row.queued_at ?? row.deployment_created_at).toISOString(),
        startedAt: (row.started_at ?? row.queued_at ?? row.deployment_created_at).toISOString(),
        finishedAt: finishedAt?.toISOString(),
        workerId: row.worker_id ?? (row.build_job_id ? undefined : "siteflow-prebuilt"),
        events: []
    };
}
function deploymentFromInspectRow(row, sourceEvent, buildJob) {
    return {
        id: row.id,
        projectId: row.project_id,
        sourceEventId: sourceEvent.id,
        buildJobId: buildJob.id,
        artifactId: `artifact_${row.id}`,
        status: row.deployment_status,
        version: deploymentVersion(row.deployment_created_at),
        environment: row.route_channel ?? "preview",
        createdAt: row.deployment_created_at.toISOString(),
        readyAt: row.deployment_status === "ready" ? row.deployment_created_at.toISOString() : undefined,
        failedReason: row.deployment_status === "failed" ? "Deployment failed before artifact routing." : undefined
    };
}
function artifactFromInspectRow(row, buildJob) {
    const manifest = artifactManifestFromRow({
        checksum: row.checksum,
        file_count: row.file_count,
        total_bytes: row.total_bytes,
        artifact_manifest: row.artifact_manifest
    }, row.deployment_created_at);
    const verificationStatus = verificationStatusForDeployment(row.deployment_status);
    return {
        id: `artifact_${row.id}`,
        projectId: row.project_id,
        buildJobId: buildJob.id,
        storageUri: `file://${row.artifact_root}`,
        manifest,
        storageStatus: verificationStatus === "verified" ? "retained" : verificationStatus === "failed" ? "delete_pending" : "pending_upload",
        verificationStatus,
        retainedUntil: retainedUntil(row.deployment_created_at),
        immutable: true,
        createdAt: row.deployment_created_at.toISOString(),
        verifiedAt: verificationStatus === "verified" ? row.deployment_created_at.toISOString() : undefined
    };
}
function routeRevisionFromInspectRow(row) {
    if (!row.route_revision_id || !row.route_channel || !row.route_status || !row.route_generated_config || !row.route_validation_summary || !row.route_created_at) {
        return undefined;
    }
    return {
        id: row.route_revision_id,
        projectId: row.project_id,
        channel: row.route_channel,
        deploymentId: row.id,
        previousDeploymentId: row.route_previous_deployment_id ?? undefined,
        status: row.route_status,
        generatedConfig: row.route_generated_config,
        validationSummary: row.route_validation_summary,
        createdAt: row.route_created_at.toISOString(),
        appliedAt: row.route_applied_at?.toISOString(),
        failedReason: row.route_failed_reason ?? undefined
    };
}
function detailEvidence(sourceEvent, buildJob, artifact, deployment, routeRevision) {
    return [
        {
            id: "evidence-source",
            label: "Source event accepted",
            status: sourceEvent.status === "accepted" ? "pass" : sourceEvent.status === "rejected" ? "fail" : "warning",
            summary: sourceEvent.disposition,
            evidence: `${sourceEvent.branch}@${sourceEvent.commitSha}`
        },
        {
            id: "evidence-build",
            label: "Build job",
            status: evidenceStatusForBuild(buildJob.status),
            summary: buildJob.status,
            evidence: buildJob.id
        },
        {
            id: "evidence-artifact",
            label: "Artifact verification",
            status: artifact.verificationStatus === "verified" ? "pass" : artifact.verificationStatus === "failed" ? "fail" : "pending",
            summary: artifact.verificationStatus,
            evidence: artifact.manifest.checksum
        },
        {
            id: "evidence-deployment",
            label: "Deployment state",
            status: deployment.status === "ready" ? "pass" : deployment.status === "failed" || deployment.status === "canceled" ? "fail" : "pending",
            summary: deployment.status,
            evidence: deployment.id
        },
        {
            id: "evidence-route",
            label: "Route revision",
            status: evidenceStatusForRoute(routeRevision?.status),
            summary: routeRevision?.validationSummary ?? "No release channel route has been applied yet.",
            evidence: routeRevision?.id
        }
    ];
}
function routeEvidenceForDetail(routeRevision, deployment) {
    if (!routeRevision) {
        return undefined;
    }
    return {
        routeRevision,
        checks: [
            {
                id: "check-route-target-deployment",
                label: "Route target deployment",
                status: routeRevision.deploymentId === deployment.id ? "pass" : "fail",
                summary: routeRevision.deploymentId === deployment.id
                    ? `Route revision targets ${deployment.id}.`
                    : "Route revision target does not match this deployment."
            },
            {
                id: "check-route-state",
                label: "Route state",
                status: routeRevision.status === "failed" ? "fail" : routeRevision.status === "applied" ? "pass" : "warning",
                summary: routeRevision.validationSummary
            }
        ],
        previousKnownGoodDeploymentId: routeRevision.previousDeploymentId
    };
}
function emptyLogChunk(deploymentId, buildJobId, cursor) {
    return {
        deploymentId,
        chunk: {
            deploymentId,
            buildJobId,
            cursor: cursor ?? "0",
            lines: [],
            complete: true,
            fetchedAt: new Date().toISOString()
        },
        hasMore: false
    };
}
function releaseVerb(action) {
    return action === "promote" ? "Promotion" : "Rollback";
}
function releaseEventStatus(routeRevision) {
    return routeRevision.status === "applied" ? "succeeded" : routeRevision.status === "failed" ? "failed" : "pending";
}
function safetyChecksForRoute(projectId, deployment, domains, channel) {
    const projectMatches = deployment?.project_id === projectId;
    return [
        {
            id: "check-target-deployment-ready",
            label: "Target deployment ready",
            status: deployment?.status === "ready" ? "pass" : "fail",
            summary: deployment
                ? `Deployment ${deployment.id} is ${deployment.status}.`
                : "Target deployment does not exist."
        },
        {
            id: "check-target-project-match",
            label: "Target belongs to project",
            status: projectMatches ? "pass" : "fail",
            summary: projectMatches
                ? `Deployment belongs to project ${projectId}.`
                : "Deployment ownership could not be verified."
        },
        {
            id: "check-verified-domain",
            label: "Verified channel domain",
            status: domains.length > 0 ? "pass" : "fail",
            summary: domains.length > 0
                ? `${domains.length} verified ${channel} domain${domains.length === 1 ? "" : "s"} ready for routing.`
                : `No verified ${channel} domains are configured.`
        }
    ];
}
function routeGeneratedConfig(projectId, channel, deployment, domains) {
    return [
        `project=${projectId}`,
        `channel=${channel}`,
        `deployment=${deployment.id}`,
        `artifact_root=${deployment.artifact_root}`,
        `entrypoint=${deployment.entrypoint}`,
        ...domains.map((domain) => `host=${domain.hostname}`)
    ].join("\n");
}
function channelEventForRoute(action, command, routeRevision, safetyChecks) {
    return {
        id: stableId("event", `${command.idempotencyKey}:${action}`),
        projectId: command.projectId,
        channel: command.channel,
        action,
        status: releaseEventStatus(routeRevision),
        previousDeploymentId: routeRevision.previousDeploymentId,
        nextDeploymentId: routeRevision.deploymentId,
        routeRevisionId: routeRevision.id,
        actor: command.actor,
        reason: command.reason.trim(),
        idempotencyKey: command.idempotencyKey,
        createdAt: routeRevision.createdAt,
        completedAt: routeRevision.appliedAt,
        safetyChecks
    };
}
export class PostgresSiteFlowReadRepository {
    pool;
    artifactRoot;
    publicScheme;
    baseDomain;
    constructor(pool, options) {
        this.pool = pool;
        this.artifactRoot = options.artifactRoot;
        this.publicScheme = options.publicScheme ?? "https";
        this.baseDomain = options.baseDomain;
    }
    async resolveTokenPermissions(token, projectId) {
        const tokenHash = apiTokenHash(token.trim());
        const result = await this.pool.query(`
        UPDATE siteflow_api_tokens
        SET last_used_at = now()
        WHERE token_hash = $1
          AND status = 'active'
          AND (project_id IS NULL OR project_id = $2)
        RETURNING id, scopes
      `, [tokenHash, projectId ?? null]);
        return result.rows[0]?.scopes;
    }
    async authorizeToken(token, permission, projectId) {
        const scopes = await this.resolveTokenPermissions(token, projectId);
        return scopes ? hasPermission(scopes, permission) : false;
    }
    listProjects() {
        return this.readModel("project-list", "default");
    }
    getProject(projectId) {
        return this.readModel("project-detail", projectId);
    }
    async getProjectSettings(projectId) {
        const project = await this.readProject(projectId);
        return {
            project,
            environments: await this.listProjectEnvironments(project.id),
            environmentVariables: await this.listEnvironmentVariables(project.id),
            teamMembers: await this.listTeamMembers(project.id),
            apiTokens: await this.listApiTokens(project.id),
            auditEvents: await this.listAuditEvents(project.id),
            currentPermissions: ["read", "write", "admin"]
        };
    }
    async createProject(command) {
        const slug = normalizeSlug(command.slug);
        const name = normalizeName(command.name);
        const defaultBranch = normalizeBranch(command.defaultBranch);
        const productionBranch = normalizeBranch(command.productionBranch, defaultBranch);
        const framework = command.framework?.trim() || command.buildSettings?.framework?.trim() || "static";
        const repository = command.repository ?? defaultRepository(slug, defaultBranch);
        const buildSettings = defaultBuildSettings(framework, command.buildSettings);
        const projectId = projectIdForSlug(slug);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
          INSERT INTO siteflow_projects (
            id,
            slug,
            name,
            status,
            framework,
            default_branch,
            production_branch,
            repository,
            build_settings
          )
          VALUES ($1, $2, $3, 'active', $4, $5, $6, $7::jsonb, $8::jsonb)
          ON CONFLICT (id) DO UPDATE
          SET slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              status = 'active',
              framework = EXCLUDED.framework,
              default_branch = EXCLUDED.default_branch,
              production_branch = EXCLUDED.production_branch,
              repository = EXCLUDED.repository,
              build_settings = EXCLUDED.build_settings,
              updated_at = now()
        `, [
                projectId,
                slug,
                name,
                framework,
                defaultBranch,
                productionBranch,
                JSON.stringify(repository),
                JSON.stringify(buildSettings)
            ]);
            await this.ensureDefaultEnvironments(client, projectId, productionBranch);
            if (command.domains) {
                await this.replaceProjectDomains(client, projectId, command.domains);
            }
            await insertAuditEvent(client, {
                projectId,
                action: "project.created",
                actor: command.actor,
                targetType: "project",
                targetId: projectId,
                summary: `Project ${name} created.`
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            status: "created",
            project: await this.readProject(projectId),
            message: "Project created."
        };
    }
    async updateProject(projectId, command) {
        const current = await this.readProject(projectId);
        const slug = command.slug ? normalizeSlug(command.slug) : current.slug;
        const name = command.name ? normalizeName(command.name) : current.name;
        const defaultBranch = normalizeBranch(command.defaultBranch, current.defaultBranch);
        const productionBranch = normalizeBranch(command.productionBranch, current.productionBranch ?? defaultBranch);
        const framework = command.framework?.trim() || current.framework;
        const repository = command.repository ?? current.repository;
        const buildSettings = {
            ...current.buildSettings,
            ...command.buildSettings
        };
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
          UPDATE siteflow_projects
          SET slug = $2,
              name = $3,
              framework = $4,
              default_branch = $5,
              production_branch = $6,
              repository = $7::jsonb,
              build_settings = $8::jsonb,
              updated_at = now()
          WHERE id = $1
        `, [
                projectId,
                slug,
                name,
                framework,
                defaultBranch,
                productionBranch,
                JSON.stringify(repository),
                JSON.stringify(buildSettings)
            ]);
            if (command.domains) {
                await this.replaceProjectDomains(client, projectId, command.domains);
            }
            await insertAuditEvent(client, {
                projectId,
                action: "project.updated",
                actor: command.actor,
                targetType: "project",
                targetId: projectId,
                summary: `Project ${name} settings updated.`
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            status: "updated",
            project: await this.readProject(projectId),
            message: "Project updated."
        };
    }
    async archiveProject(projectId) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
          UPDATE siteflow_projects
          SET status = 'archived',
              updated_at = now()
          WHERE id = $1
        `, [projectId]);
            await insertAuditEvent(client, {
                projectId,
                action: "project.archived",
                targetType: "project",
                targetId: projectId,
                summary: `Project ${projectId} archived.`
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            status: "archived",
            project: await this.readProject(projectId),
            message: "Project archived."
        };
    }
    async getProjectEnvironmentSettings(projectId) {
        await this.readProject(projectId);
        return {
            projectId,
            environments: await this.listProjectEnvironments(projectId),
            environmentVariables: await this.listEnvironmentVariables(projectId),
            updatedAt: new Date().toISOString()
        };
    }
    async upsertEnvironmentVariable(command) {
        await this.readProject(command.projectId);
        const key = normalizeEnvironmentVariableKey(command.key);
        const targetEnvironment = normalizeEnvironmentName(command.targetEnvironment);
        const id = `env_${createHash("sha256")
            .update(`${command.projectId}:${targetEnvironment}:${command.scope}:${key}`)
            .digest("hex")
            .slice(0, 24)}`;
        const source = command.source ?? "sealed";
        const sealedValue = source === "sealed" && command.value !== undefined ? sealSecretValue(command.value) : null;
        const fingerprint = source === "external" && !command.value ? "external" : fingerprintSecret(command.value ?? "");
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
          INSERT INTO siteflow_environment_variables (
            id,
            project_id,
            key,
            target_environment,
            scope,
            source,
            sealed_value,
            fingerprint,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          ON CONFLICT (project_id, key, target_environment, scope) DO UPDATE
          SET source = EXCLUDED.source,
              sealed_value = EXCLUDED.sealed_value,
              fingerprint = EXCLUDED.fingerprint,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
        `, [
                id,
                command.projectId,
                key,
                targetEnvironment,
                command.scope,
                source,
                sealedValue,
                fingerprint,
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "environment_variable.upserted",
                actor: command.actor,
                targetType: "environment_variable",
                targetId: id,
                summary: `Environment variable ${key} updated for ${targetEnvironment}.`,
                metadata: {
                    key,
                    targetEnvironment,
                    scope: command.scope,
                    source
                }
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        const variable = (await this.listEnvironmentVariables(command.projectId)).find((candidate) => candidate.key === key &&
            candidate.targetEnvironment === targetEnvironment &&
            candidate.scope === command.scope);
        if (!variable) {
            throw new SiteFlowNotFoundError(`Unknown environment variable: ${key}`);
        }
        return {
            status: "upserted",
            variable,
            message: "Environment variable metadata saved."
        };
    }
    async upsertTeamMember(command) {
        await this.readProject(command.projectId);
        const role = command.role;
        const permissions = rolePermissions(role);
        const memberId = stableId("member", `${command.projectId}:${command.actor.id}`);
        const result = await this.pool.query(`
        WITH upserted AS (
          INSERT INTO siteflow_team_members (
            id,
            project_id,
            actor_id,
            actor,
            role,
            permissions
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6)
          ON CONFLICT (project_id, actor_id) DO UPDATE
          SET actor = EXCLUDED.actor,
              role = EXCLUDED.role,
              permissions = EXCLUDED.permissions,
              updated_at = now()
          RETURNING id, project_id, actor, role, permissions, created_at, updated_at
        ), audit AS (
          INSERT INTO siteflow_audit_events (
            id,
            project_id,
            action,
            actor,
            target_type,
            target_id,
            summary,
            metadata
          )
          SELECT $7, $2, 'team.member_updated', $8::jsonb, 'team_member', id,
                 'Team member ' || ($4::jsonb->>'name') || ' assigned ' || $5 || ' role.',
                 jsonb_build_object('role', $5, 'permissions', $6::text[])
          FROM upserted
        )
        SELECT id, project_id, actor, role, permissions, created_at, updated_at
        FROM upserted
      `, [
            memberId,
            command.projectId,
            command.actor.id,
            JSON.stringify(command.actor),
            role,
            permissions,
            stableId("audit", `${command.projectId}:team:${memberId}:${randomUUID()}`),
            JSON.stringify(command.requestedBy ?? command.actor)
        ]);
        return {
            status: "upserted",
            member: teamMemberFromRow(result.rows[0]),
            message: "Team member saved."
        };
    }
    async removeTeamMember(command) {
        await this.readProject(command.projectId);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          DELETE FROM siteflow_team_members
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, actor, role, permissions, created_at, updated_at
        `, [command.projectId, command.memberId]);
            const row = result.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown team member: ${command.memberId}`);
            }
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "team.member_removed",
                actor: command.requestedBy,
                targetType: "team_member",
                targetId: command.memberId,
                summary: `Team member ${row.actor.name} removed.`,
                reason: command.reason,
                metadata: {
                    role: row.role
                }
            });
            await client.query("COMMIT");
            return {
                status: "removed",
                member: teamMemberFromRow(row),
                message: "Team member removed."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async createApiToken(command) {
        if (command.projectId) {
            await this.readProject(command.projectId);
        }
        const name = normalizeName(command.name);
        const scopes = normalizePermissionScopes(command.scopes);
        const secret = apiTokenSecret();
        const tokenId = stableId("token", `${command.projectId ?? "global"}:${name}:${randomUUID()}`);
        const result = await this.pool.query(`
        INSERT INTO siteflow_api_tokens (
          id,
          project_id,
          name,
          token_hash,
          token_prefix,
          scopes,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        RETURNING id, project_id, name, token_prefix, scopes, status, created_by,
                  created_at, updated_at, revoked_at, last_used_at
      `, [
            tokenId,
            command.projectId ?? null,
            name,
            apiTokenHash(secret),
            secret.slice(0, 12),
            scopes,
            command.actor ? JSON.stringify(command.actor) : null
        ]);
        const token = apiTokenFromRow(result.rows[0]);
        if (command.projectId) {
            await insertAuditEvent(this.pool, {
                projectId: command.projectId,
                action: "api_token.created",
                actor: command.actor,
                targetType: "api_token",
                targetId: token.id,
                summary: `API token ${token.name} created.`,
                metadata: {
                    scopes: token.scopes,
                    tokenPrefix: token.tokenPrefix
                }
            });
        }
        return {
            status: "created",
            token,
            secret,
            message: "API token created. Store the token now; it will not be shown again."
        };
    }
    async revokeApiToken(command) {
        const result = await this.pool.query(`
        UPDATE siteflow_api_tokens
        SET status = 'revoked',
            revoked_at = COALESCE(revoked_at, now()),
            updated_at = now()
        WHERE id = $1
          AND ($2::text IS NULL OR project_id = $2)
        RETURNING id, project_id, name, token_prefix, scopes, status, created_by,
                  created_at, updated_at, revoked_at, last_used_at
      `, [command.tokenId, command.projectId ?? null]);
        const row = result.rows[0];
        if (!row) {
            throw new SiteFlowNotFoundError(`Unknown API token: ${command.tokenId}`);
        }
        const token = apiTokenFromRow(row);
        if (token.projectId) {
            await insertAuditEvent(this.pool, {
                projectId: token.projectId,
                action: "api_token.revoked",
                actor: command.actor,
                targetType: "api_token",
                targetId: token.id,
                summary: `API token ${token.name} revoked.`,
                reason: command.reason,
                metadata: {
                    scopes: token.scopes,
                    tokenPrefix: token.tokenPrefix
                }
            });
        }
        return {
            status: "revoked",
            token,
            message: "API token revoked."
        };
    }
    async listFirewallRules(projectId) {
        await this.readProject(projectId);
        const result = await this.pool.query(`
        SELECT id, project_id, name, action, priority, status, conditions, created_by,
               created_at, updated_at, disabled_at
        FROM siteflow_firewall_rules
        WHERE project_id = $1
        ORDER BY priority ASC, updated_at DESC
      `, [projectId]);
        return {
            projectId,
            rules: result.rows.map(firewallRuleFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async createFirewallRule(command) {
        await this.readProject(command.projectId);
        const name = normalizeFirewallRuleName(command.name);
        const action = normalizeFirewallAction(command.action);
        const priority = normalizeFirewallPriority(command.priority);
        const conditions = normalizeFirewallConditions(command.conditions);
        const ruleId = stableId("fw", `${command.projectId}:${name}`);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_firewall_rules (
            id,
            project_id,
            name,
            action,
            priority,
            conditions,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET action = EXCLUDED.action,
              priority = EXCLUDED.priority,
              status = 'active',
              conditions = EXCLUDED.conditions,
              created_by = EXCLUDED.created_by,
              disabled_at = NULL,
              updated_at = now()
          RETURNING id, project_id, name, action, priority, status, conditions, created_by,
                    created_at, updated_at, disabled_at
        `, [
                ruleId,
                command.projectId,
                name,
                action,
                priority,
                JSON.stringify(conditions),
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            const rule = firewallRuleFromRow(result.rows[0]);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "firewall_rule.created",
                actor: command.actor,
                targetType: "firewall_rule",
                targetId: rule.id,
                summary: `Firewall rule ${rule.name} ${rule.action}s matching requests.`,
                metadata: {
                    action: rule.action,
                    priority: rule.priority,
                    conditions: rule.conditions
                }
            });
            await client.query("COMMIT");
            return {
                status: "created",
                rule,
                message: "Firewall rule created."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async disableFirewallRule(command) {
        await this.readProject(command.projectId);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          UPDATE siteflow_firewall_rules
          SET status = 'disabled',
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, action, priority, status, conditions, created_by,
                    created_at, updated_at, disabled_at
        `, [command.projectId, command.ruleId]);
            const row = result.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown firewall rule: ${command.ruleId}`);
            }
            const rule = firewallRuleFromRow(row);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "firewall_rule.disabled",
                actor: command.actor,
                targetType: "firewall_rule",
                targetId: rule.id,
                summary: `Firewall rule ${rule.name} disabled.`,
                reason: command.reason
            });
            await client.query("COMMIT");
            return {
                status: "disabled",
                rule,
                message: "Firewall rule disabled."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async evaluateFirewall(command) {
        const rules = await this.listFirewallRules(command.projectId);
        const matchedRule = rules.rules.find((rule) => rule.status === "active" && firewallConditionMatches(rule, command));
        if (!matchedRule) {
            return {
                projectId: command.projectId,
                decision: "allow",
                reason: "No firewall rule matched."
            };
        }
        return {
            projectId: command.projectId,
            decision: matchedRule.action,
            matchedRule,
            reason: `Firewall rule ${matchedRule.name} matched.`
        };
    }
    async listRoutingRules(command) {
        await this.readProject(command.projectId);
        const kind = command.kind ? normalizeRoutingRuleKind(command.kind) : undefined;
        const status = normalizeRoutingStatus(command.status);
        const result = await this.pool.query(`
        SELECT id, project_id, name, kind, source, destination, status_code, headers,
               priority, status, created_by, updated_by, created_at, updated_at, disabled_at
        FROM siteflow_routing_rules
        WHERE project_id = $1
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY priority ASC, updated_at DESC
      `, [command.projectId, kind ?? null, status ?? null]);
        return {
            projectId: command.projectId,
            rules: result.rows.map(routingRuleFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async upsertRoutingRule(command) {
        await this.readProject(command.projectId);
        const input = normalizeRoutingRuleInput(command);
        const ruleId = stableId("route", `${command.projectId}:${input.name}`);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_routing_rules (
            id,
            project_id,
            name,
            kind,
            source,
            destination,
            status_code,
            headers,
            priority,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET kind = EXCLUDED.kind,
              source = EXCLUDED.source,
              destination = EXCLUDED.destination,
              status_code = EXCLUDED.status_code,
              headers = EXCLUDED.headers,
              priority = EXCLUDED.priority,
              status = 'active',
              updated_by = EXCLUDED.updated_by,
              disabled_at = NULL,
              updated_at = now()
          RETURNING id, project_id, name, kind, source, destination, status_code, headers,
                    priority, status, created_by, updated_by, created_at, updated_at, disabled_at
        `, [
                ruleId,
                command.projectId,
                input.name,
                input.kind,
                input.source,
                input.destination ?? null,
                input.statusCode ?? null,
                JSON.stringify(input.headers),
                input.priority,
                command.actor ? JSON.stringify(command.actor) : null,
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            const rule = routingRuleFromRow(result.rows[0]);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "routing_rule.upserted",
                actor: command.actor,
                targetType: "routing_rule",
                targetId: rule.id,
                summary: `Routing rule ${rule.name} saved.`,
                metadata: {
                    kind: rule.kind,
                    source: rule.source,
                    destination: rule.destination,
                    headers: rule.headers,
                    priority: rule.priority
                }
            });
            await client.query("COMMIT");
            return {
                status: "upserted",
                rule,
                message: "Routing rule saved."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async disableRoutingRule(command) {
        await this.readProject(command.projectId);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          UPDATE siteflow_routing_rules
          SET status = 'disabled',
              updated_by = $3::jsonb,
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, kind, source, destination, status_code, headers,
                    priority, status, created_by, updated_by, created_at, updated_at, disabled_at
        `, [command.projectId, command.ruleId, command.actor ? JSON.stringify(command.actor) : null]);
            const row = result.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown routing rule: ${command.ruleId}`);
            }
            const rule = routingRuleFromRow(row);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "routing_rule.disabled",
                actor: command.actor,
                targetType: "routing_rule",
                targetId: rule.id,
                summary: `Routing rule ${rule.name} disabled.`,
                reason: command.reason
            });
            await client.query("COMMIT");
            return {
                status: "disabled",
                rule,
                message: "Routing rule disabled."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async matchRoutingRules(command) {
        const rules = await this.listRoutingRules({
            projectId: command.projectId,
            status: "active"
        });
        const pathName = normalizeRoutingPath(command.path, "path");
        const redirect = rules.rules.find((rule) => rule.kind === "redirect" && pathMatchesPattern(pathName, rule.source));
        const rewrite = redirect ? undefined : rules.rules.find((rule) => rule.kind === "rewrite" && pathMatchesPattern(pathName, rule.source));
        const headers = rules.rules.filter((rule) => rule.kind === "header" && pathMatchesPattern(pathName, rule.source));
        return {
            projectId: command.projectId,
            path: pathName,
            redirect,
            rewrite,
            headers,
            rewrittenPath: rewrite ? applyRoutingDestination(pathName, rewrite.source, rewrite.destination) : undefined,
            updatedAt: new Date().toISOString()
        };
    }
    async getEdgeConfig(projectId) {
        await this.readProject(projectId);
        const result = await this.pool.query(`
        SELECT id, project_id, key, value, value_type, created_by, updated_by, created_at, updated_at
        FROM siteflow_edge_config
        WHERE project_id = $1
        ORDER BY key ASC
      `, [projectId]);
        return {
            projectId,
            entries: result.rows.map(edgeConfigFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async upsertEdgeConfig(command) {
        await this.readProject(command.projectId);
        const key = normalizeEdgeConfigKey(command.key);
        const valueType = edgeConfigValueType(command.value);
        const entryId = stableId("edge", `${command.projectId}:${key}`);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_edge_config (
            id,
            project_id,
            key,
            value,
            value_type,
            created_by,
            updated_by
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb)
          ON CONFLICT (project_id, key) DO UPDATE
          SET value = EXCLUDED.value,
              value_type = EXCLUDED.value_type,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          RETURNING id, project_id, key, value, value_type, created_by, updated_by, created_at, updated_at
        `, [
                entryId,
                command.projectId,
                key,
                JSON.stringify(command.value),
                valueType,
                command.actor ? JSON.stringify(command.actor) : null,
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            const entry = edgeConfigFromRow(result.rows[0]);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "edge_config.upserted",
                actor: command.actor,
                targetType: "edge_config",
                targetId: entry.id,
                summary: `Edge Config ${entry.key} saved.`,
                metadata: {
                    key: entry.key,
                    valueType: entry.valueType
                }
            });
            await client.query("COMMIT");
            return {
                status: "upserted",
                entry,
                message: "Edge Config entry saved."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async deleteEdgeConfig(command) {
        await this.readProject(command.projectId);
        const key = normalizeEdgeConfigKey(command.key);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          DELETE FROM siteflow_edge_config
          WHERE project_id = $1 AND key = $2
          RETURNING id, project_id, key, value, value_type, created_by, updated_by, created_at, updated_at
        `, [command.projectId, key]);
            const row = result.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown Edge Config entry: ${key}`);
            }
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "edge_config.deleted",
                actor: command.actor,
                targetType: "edge_config",
                targetId: row.id,
                summary: `Edge Config ${key} deleted.`,
                reason: command.reason,
                metadata: {
                    key
                }
            });
            await client.query("COMMIT");
            return {
                status: "deleted",
                message: "Edge Config entry deleted."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async listBlobs(command) {
        await this.readProject(command.projectId);
        const prefix = normalizeBlobPrefix(command.prefix);
        const cursor = command.cursor ? normalizeBlobPathname(command.cursor) : undefined;
        const limit = normalizeBlobLimit(command.limit);
        const result = await this.pool.query(`
        SELECT id, project_id, pathname, access, content_type, cache_control_max_age,
               size_bytes, sha256, etag, url, uploaded_by, uploaded_at, updated_at
        FROM siteflow_blobs
        WHERE project_id = $1
          AND ($2::text IS NULL OR pathname LIKE $2 || '%')
          AND ($3::text IS NULL OR pathname > $3)
        ORDER BY pathname ASC
        LIMIT $4
      `, [command.projectId, prefix ?? null, cursor ?? null, limit]);
        return {
            projectId: command.projectId,
            blobs: result.rows.map(blobFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async putBlob(command) {
        await this.readProject(command.projectId);
        const pathname = normalizeBlobPathname(command.pathname);
        const content = decodeBlobContentBase64(command.contentBase64);
        const access = normalizeBlobAccess(command.access);
        const contentType = normalizeBlobContentType(command.contentType);
        const cacheControlMaxAge = normalizeBlobCacheControlMaxAge(command.cacheControlMaxAge);
        const digest = createHash("sha256").update(content).digest("hex");
        const sha256 = `sha256:${digest}`;
        const etag = `"${digest}"`;
        const url = blobUrl(command.projectId, pathname);
        const blobId = stableId("blob", `${command.projectId}:${pathname}`);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_blobs (
            id,
            project_id,
            pathname,
            access,
            content_type,
            cache_control_max_age,
            size_bytes,
            sha256,
            etag,
            url,
            content,
            uploaded_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          ON CONFLICT (project_id, pathname) DO UPDATE
          SET access = EXCLUDED.access,
              content_type = EXCLUDED.content_type,
              cache_control_max_age = EXCLUDED.cache_control_max_age,
              size_bytes = EXCLUDED.size_bytes,
              sha256 = EXCLUDED.sha256,
              etag = EXCLUDED.etag,
              url = EXCLUDED.url,
              content = EXCLUDED.content,
              uploaded_by = EXCLUDED.uploaded_by,
              updated_at = now()
          RETURNING id, project_id, pathname, access, content_type, cache_control_max_age,
                    size_bytes, sha256, etag, url, uploaded_by, uploaded_at, updated_at
        `, [
                blobId,
                command.projectId,
                pathname,
                access,
                contentType,
                cacheControlMaxAge ?? null,
                content.byteLength,
                sha256,
                etag,
                url,
                content,
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            const blob = blobFromRow(result.rows[0]);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "blob.uploaded",
                actor: command.actor,
                targetType: "blob",
                targetId: blob.id,
                summary: `Blob ${blob.pathname} uploaded.`,
                metadata: {
                    pathname: blob.pathname,
                    access: blob.access,
                    contentType: blob.contentType,
                    size: blob.size,
                    sha256: blob.sha256
                }
            });
            await client.query("COMMIT");
            return {
                status: "uploaded",
                blob,
                message: "Blob uploaded."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async getBlob(command) {
        await this.readProject(command.projectId);
        const pathname = normalizeBlobPathname(command.pathname);
        const result = await this.pool.query(`
        SELECT id, project_id, pathname, access, content_type, cache_control_max_age,
               size_bytes, sha256, etag, url, content, uploaded_by, uploaded_at, updated_at
        FROM siteflow_blobs
        WHERE project_id = $1 AND pathname = $2
      `, [command.projectId, pathname]);
        const row = result.rows[0];
        if (!row?.content) {
            throw new SiteFlowNotFoundError(`Unknown blob: ${pathname}`);
        }
        return {
            projectId: command.projectId,
            blob: blobFromRow(row),
            contentBase64: row.content.toString("base64")
        };
    }
    async deleteBlob(command) {
        await this.readProject(command.projectId);
        const pathname = normalizeBlobPathname(command.pathname);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          DELETE FROM siteflow_blobs
          WHERE project_id = $1 AND pathname = $2
          RETURNING id, project_id, pathname, access, content_type, cache_control_max_age,
                    size_bytes, sha256, etag, url, uploaded_by, uploaded_at, updated_at
        `, [command.projectId, pathname]);
            const row = result.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown blob: ${pathname}`);
            }
            const blob = blobFromRow(row);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "blob.deleted",
                actor: command.actor,
                targetType: "blob",
                targetId: blob.id,
                summary: `Blob ${blob.pathname} deleted.`,
                reason: command.reason,
                metadata: {
                    pathname: blob.pathname,
                    sha256: blob.sha256
                }
            });
            await client.query("COMMIT");
            return {
                status: "deleted",
                blob,
                message: "Blob deleted."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async listCacheEntries(command) {
        await this.readProject(command.projectId);
        const pathName = command.path ? normalizeCachePath(command.path) : undefined;
        const tag = normalizeCacheTag(command.tag);
        const status = normalizeCacheStatus(command.status);
        const limit = normalizeCacheLimit(command.limit);
        const result = await this.pool.query(`
        SELECT id, project_id, cache_key, path, tags, status, content_type, size_bytes, etag,
               max_age_seconds, stale_while_revalidate_seconds, last_generated_at, expires_at,
               stale_at, purged_at, updated_at
        FROM siteflow_cache_entries
        WHERE project_id = $1
          AND ($2::text IS NULL OR path = $2)
          AND ($3::text IS NULL OR $3 = ANY(tags))
          AND ($4::text IS NULL OR status = $4)
        ORDER BY updated_at DESC, path ASC
        LIMIT $5
      `, [command.projectId, pathName ?? null, tag ?? null, status ?? null, limit]);
        return {
            projectId: command.projectId,
            entries: result.rows.map(cacheEntryFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async purgeCache(command) {
        await this.readProject(command.projectId);
        const pathName = command.path ? normalizeCachePath(command.path) : undefined;
        const tag = normalizeCacheTag(command.tag);
        if (!pathName && !tag) {
            throw new Error("Cache purge requires path or tag.");
        }
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          UPDATE siteflow_cache_entries
          SET status = 'purged',
              purged_at = now(),
              updated_at = now()
          WHERE project_id = $1
            AND ($2::text IS NULL OR path = $2)
            AND ($3::text IS NULL OR $3 = ANY(tags))
          RETURNING id, project_id, cache_key, path, tags, status, content_type, size_bytes, etag,
                    max_age_seconds, stale_while_revalidate_seconds, last_generated_at, expires_at,
                    stale_at, purged_at, updated_at
        `, [command.projectId, pathName ?? null, tag ?? null]);
            const purged = result.rows.map(cacheEntryFromRow);
            const targetId = pathName ?? tag ?? "cache";
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "cache.purged",
                actor: command.actor,
                targetType: "cache",
                targetId: stableId("cache", `${command.projectId}:${targetId}`),
                summary: `Purged ${purged.length} cache entr${purged.length === 1 ? "y" : "ies"}.`,
                reason: command.reason,
                metadata: {
                    path: pathName,
                    tag,
                    total: purged.length,
                    cacheKeys: purged.map((entry) => entry.key)
                }
            });
            await client.query("COMMIT");
            return {
                status: "purged",
                projectId: command.projectId,
                purged,
                total: purged.length,
                message: `Purged ${purged.length} cache entr${purged.length === 1 ? "y" : "ies"}.`
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async listFunctions(command) {
        await this.readProject(command.projectId);
        const deploymentResult = await this.pool.query(`
        SELECT id, project_id, artifact_manifest, created_at, checksum, file_count, total_bytes
        FROM siteflow_deployments
        WHERE project_id = $1
          AND status = 'ready'
          AND ($2::text IS NULL OR id = $2)
        ORDER BY created_at DESC
        LIMIT 1
      `, [command.projectId, command.deploymentId ?? null]);
        const deployment = deploymentResult.rows[0];
        if (!deployment) {
            throw new SiteFlowNotFoundError(`Unknown ready deployment for project: ${command.projectId}`);
        }
        const functions = functionsFromArtifactManifest(deployment.artifact_manifest);
        const invocationResult = await this.pool.query(`
        SELECT id, deployment_id, project_id, path, method, status, response_status,
               duration_ms, request_id, logs, error_message, invoked_at
        FROM siteflow_function_invocations
        WHERE project_id = $1 AND deployment_id = $2
        ORDER BY invoked_at DESC
      `, [command.projectId, deployment.id]);
        const invocations = invocationResult.rows.map(functionInvocationFromRow);
        const items = functions.map((entry) => functionRuntimeItem(command.projectId, deployment.id, entry, invocations));
        return {
            projectId: command.projectId,
            deploymentId: deployment.id,
            functions: items,
            total: items.length,
            updatedAt: new Date().toISOString()
        };
    }
    async getFunctionRuntime(command) {
        const list = await this.listFunctions({
            projectId: command.projectId,
            deploymentId: command.deploymentId
        });
        const functionPath = command.path.startsWith("/") ? command.path : `/${command.path}`;
        const item = list.functions.find((entry) => entry.function.path === functionPath);
        if (!item) {
            throw new SiteFlowNotFoundError(`Unknown function: ${functionPath}`);
        }
        const limit = normalizeCacheLimit(command.limit);
        const invocationResult = await this.pool.query(`
        SELECT id, deployment_id, project_id, path, method, status, response_status,
               duration_ms, request_id, logs, error_message, invoked_at
        FROM siteflow_function_invocations
        WHERE project_id = $1
          AND deployment_id = $2
          AND path = $3
        ORDER BY invoked_at DESC
        LIMIT $4
      `, [command.projectId, item.deploymentId, functionPath, limit]);
        return {
            projectId: command.projectId,
            deploymentId: item.deploymentId,
            function: item,
            recentInvocations: invocationResult.rows.map(functionInvocationFromRow),
            updatedAt: new Date().toISOString()
        };
    }
    async listDeployHooks(projectId) {
        await this.readProject(projectId);
        const result = await this.pool.query(`
        SELECT id, project_id, name, branch, target_environment, token_prefix, status,
               created_at, updated_at, revoked_at, last_triggered_at
        FROM siteflow_deploy_hooks
        WHERE project_id = $1
        ORDER BY created_at DESC
      `, [projectId]);
        return {
            projectId,
            hooks: result.rows.map(deployHookFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async createDeployHook(command) {
        const project = await this.readProject(command.projectId);
        const name = normalizeDeployHookName(command.name);
        const branch = normalizeBranch(command.branch, project.productionBranch ?? project.defaultBranch);
        const targetEnvironment = normalizeEnvironmentName(command.targetEnvironment ?? "preview");
        const token = deployHookToken();
        const tokenHash = deployHookTokenHash(token);
        const hookId = stableId("hook", `${project.id}:${name}:${branch}:${targetEnvironment}:${randomUUID()}`);
        const tokenPrefix = token.slice(0, 12);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_deploy_hooks (
            id,
            project_id,
            name,
            branch,
            target_environment,
            token_hash,
            token_prefix,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          RETURNING id, project_id, name, branch, target_environment, token_prefix, status,
                    created_at, updated_at, revoked_at, last_triggered_at
        `, [
                hookId,
                project.id,
                name,
                branch,
                targetEnvironment,
                tokenHash,
                tokenPrefix,
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            const hook = deployHookFromRow(result.rows[0]);
            await insertDeployHookEvent(client, {
                hookId: hook.id,
                projectId: hook.projectId,
                action: "created",
                actor: command.actor,
                summary: `Deploy hook ${hook.name} created for ${hook.branch}:${hook.targetEnvironment}.`,
                metadata: {
                    tokenPrefix: hook.tokenPrefix
                }
            });
            await insertAuditEvent(client, {
                projectId: hook.projectId,
                action: "deploy_hook.created",
                actor: command.actor,
                targetType: "deploy_hook",
                targetId: hook.id,
                summary: `Deploy hook ${hook.name} created.`,
                metadata: {
                    branch: hook.branch,
                    targetEnvironment: hook.targetEnvironment,
                    tokenPrefix: hook.tokenPrefix
                }
            });
            await client.query("COMMIT");
            return {
                status: "created",
                hook,
                token,
                message: "Deploy hook created. Store the token now; it will not be shown again."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async revokeDeployHook(command) {
        await this.readProject(command.projectId);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          UPDATE siteflow_deploy_hooks
          SET status = 'revoked',
              revoked_by = $3::jsonb,
              revoke_reason = $4,
              revoked_at = COALESCE(revoked_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, branch, target_environment, token_prefix, status,
                    created_at, updated_at, revoked_at, last_triggered_at
        `, [
                command.projectId,
                command.hookId,
                command.actor ? JSON.stringify(command.actor) : null,
                command.reason?.trim() || null
            ]);
            const row = result.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown deploy hook: ${command.hookId}`);
            }
            const hook = deployHookFromRow(row);
            await insertDeployHookEvent(client, {
                hookId: hook.id,
                projectId: hook.projectId,
                action: "revoked",
                actor: command.actor,
                summary: `Deploy hook ${hook.name} revoked.`,
                metadata: {
                    reason: command.reason?.trim() || undefined
                }
            });
            await insertAuditEvent(client, {
                projectId: hook.projectId,
                action: "deploy_hook.revoked",
                actor: command.actor,
                targetType: "deploy_hook",
                targetId: hook.id,
                summary: `Deploy hook ${hook.name} revoked.`,
                reason: command.reason,
                metadata: {
                    tokenPrefix: hook.tokenPrefix
                }
            });
            await client.query("COMMIT");
            return {
                status: "revoked",
                hook,
                message: "Deploy hook revoked."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async triggerDeployHook(command) {
        const token = command.token.trim();
        if (!token) {
            throw new Error("Deploy hook token is required.");
        }
        const tokenHash = deployHookTokenHash(token);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const hookResult = await client.query(`
          SELECT id, project_id, name, branch, target_environment, token_prefix, status,
                 created_at, updated_at, revoked_at, last_triggered_at
          FROM siteflow_deploy_hooks
          WHERE token_hash = $1 AND status = 'active'
          FOR UPDATE
        `, [tokenHash]);
            const hookRow = hookResult.rows[0];
            if (!hookRow) {
                throw new SiteFlowNotFoundError("Deploy hook token is invalid or revoked.");
            }
            const deliveryKey = command.idempotencyKey?.trim() || randomUUID();
            const deliveryId = `deploy-hook:${hookRow.id}:${deliveryKey}`;
            const sourceEventId = stableId("src", `generic:${deliveryId}`);
            const buildJobId = stableId("build", sourceEventId);
            const projectResult = await client.query(`
          SELECT id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
          FROM siteflow_projects
          WHERE id = $1
        `, [hookRow.project_id]);
            const projectRow = projectResult.rows[0];
            if (!projectRow) {
                throw new SiteFlowNotFoundError(`Unknown project: ${hookRow.project_id}`);
            }
            const project = projectFromRow(projectRow);
            const buildSettings = defaultBuildSettings(project.framework, project.buildSettings);
            const branch = normalizeBranch(command.branch ?? branchFromRef(command.ref), hookRow.branch);
            const commitSha = command.commitSha?.trim() || `deploy-hook-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
            const actor = command.actor ?? {
                id: `deploy-hook:${hookRow.id}`,
                name: hookRow.name,
                role: "system"
            };
            const commitAuthor = command.commitAuthor?.trim() || actor.name;
            const commitMessage = command.commitMessage?.trim() || `Deploy hook ${hookRow.name} triggered.`;
            await client.query(`
          INSERT INTO siteflow_source_events (
            id,
            project_id,
            provider,
            provider_delivery_id,
            kind,
            status,
            disposition,
            branch,
            commit_sha,
            commit_message,
            commit_author,
            pull_request_number,
            actor,
            provider_payload,
            received_at
          )
          VALUES ($1, $2, 'generic', $3, 'manual', 'accepted', 'build_requested', $4, $5, $6, $7, NULL, $8::jsonb, $9::jsonb, now())
          ON CONFLICT (provider, provider_delivery_id) DO NOTHING
        `, [
                sourceEventId,
                project.id,
                deliveryId,
                branch,
                commitSha,
                commitMessage,
                commitAuthor,
                JSON.stringify(actor),
                JSON.stringify({
                    event: "deploy_hook",
                    ref: command.ref,
                    deployHook: {
                        id: hookRow.id,
                        name: hookRow.name,
                        targetEnvironment: hookRow.target_environment
                    }
                })
            ]);
            await client.query(`
          INSERT INTO siteflow_build_jobs (
            id,
            project_id,
            source_event_id,
            status,
            framework,
            install_command,
            build_command,
            output_directory
          )
          VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
          ON CONFLICT (source_event_id) DO NOTHING
        `, [
                buildJobId,
                project.id,
                sourceEventId,
                buildSettings.framework ?? project.framework,
                buildSettings.installCommand,
                buildSettings.buildCommand,
                buildSettings.outputDirectory
            ]);
            await client.query(`
          UPDATE siteflow_deploy_hooks
          SET last_triggered_at = now(),
              updated_at = now()
          WHERE id = $1
        `, [hookRow.id]);
            const sourceResult = await client.query(`
          SELECT id, project_id, kind, status, disposition, provider_delivery_id, branch, commit_sha, commit_message, commit_author,
                 pull_request_number, received_at, actor
          FROM siteflow_source_events
          WHERE provider = 'generic' AND provider_delivery_id = $1
        `, [deliveryId]);
            const sourceEvent = sourceResult.rows[0] ? sourceEventFromRow(sourceResult.rows[0]) : undefined;
            const queuedBuild = await client.query("SELECT id FROM siteflow_build_jobs WHERE source_event_id = $1", [sourceEventId]);
            const updatedHook = await client.query(`
          SELECT id, project_id, name, branch, target_environment, token_prefix, status,
                 created_at, updated_at, revoked_at, last_triggered_at
          FROM siteflow_deploy_hooks
          WHERE id = $1
        `, [hookRow.id]);
            if (!sourceEvent || !queuedBuild.rows[0] || !updatedHook.rows[0]) {
                throw new SiteFlowNotFoundError("Deploy hook trigger could not be materialized.");
            }
            await insertDeployHookEvent(client, {
                hookId: hookRow.id,
                projectId: hookRow.project_id,
                action: "triggered",
                actor,
                summary: `Deploy hook ${hookRow.name} queued build ${queuedBuild.rows[0].id}.`,
                metadata: {
                    sourceEventId: sourceEvent.id,
                    buildJobId: queuedBuild.rows[0].id,
                    branch,
                    commitSha,
                    deliveryId
                },
                idempotencyKey: deliveryId
            });
            await client.query("COMMIT");
            return {
                status: "accepted",
                hook: deployHookFromRow(updatedHook.rows[0]),
                sourceEvent,
                buildJobId: queuedBuild.rows[0].id,
                message: "Deploy hook accepted and build job queued."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async listCronJobs(projectId) {
        await this.readProject(projectId);
        const result = await this.pool.query(`
        SELECT id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
        FROM siteflow_cron_jobs
        WHERE project_id = $1
        ORDER BY created_at DESC
      `, [projectId]);
        return {
            projectId,
            jobs: result.rows.map(cronJobFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async createCronJob(command) {
        await this.readProject(command.projectId);
        const name = normalizeCronJobName(command.name);
        const pathName = normalizeCronPath(command.path);
        const schedule = normalizeCronSchedule(command.schedule);
        const jobId = stableId("cron", `${command.projectId}:${name}`);
        const client = await this.pool.connect();
        let row;
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_cron_jobs (
            id,
            project_id,
            name,
            path,
            schedule,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET path = EXCLUDED.path,
              schedule = EXCLUDED.schedule,
              status = 'active',
              disabled_by = NULL,
              disable_reason = NULL,
              disabled_at = NULL,
              updated_at = now()
          RETURNING id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
        `, [
                jobId,
                command.projectId,
                name,
                pathName,
                schedule,
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            row = result.rows[0];
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "cron_job.created",
                actor: command.actor,
                targetType: "cron_job",
                targetId: row.id,
                summary: `Cron job ${row.name} saved.`,
                metadata: {
                    path: row.path,
                    schedule: row.schedule
                }
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            status: "created",
            job: cronJobFromRow(row),
            message: "Cron job saved."
        };
    }
    async disableCronJob(command) {
        await this.readProject(command.projectId);
        const client = await this.pool.connect();
        let row;
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          UPDATE siteflow_cron_jobs
          SET status = 'disabled',
              disabled_by = $3::jsonb,
              disable_reason = $4,
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
        `, [
                command.projectId,
                command.jobId,
                command.actor ? JSON.stringify(command.actor) : null,
                command.reason?.trim() || null
            ]);
            row = result.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown cron job: ${command.jobId}`);
            }
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "cron_job.disabled",
                actor: command.actor,
                targetType: "cron_job",
                targetId: row.id,
                summary: `Cron job ${row.name} disabled.`,
                reason: command.reason
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            status: "disabled",
            job: cronJobFromRow(row),
            message: "Cron job disabled."
        };
    }
    async runCronJob(command) {
        await this.readProject(command.projectId);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const jobResult = await client.query(`
          SELECT id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
          FROM siteflow_cron_jobs
          WHERE project_id = $1 AND id = $2
          FOR UPDATE
        `, [command.projectId, command.jobId]);
            const row = jobResult.rows[0];
            if (!row) {
                throw new SiteFlowNotFoundError(`Unknown cron job: ${command.jobId}`);
            }
            const job = cronJobFromRow(row);
            if (job.status !== "active") {
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    job,
                    message: "Cron job is disabled."
                };
            }
            const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, "production");
            const domain = domains[0];
            if (!domain) {
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    job,
                    message: "Cron job rejected: no verified production domain is configured."
                };
            }
            const normalizedPath = job.path.startsWith("/") ? job.path : `/${job.path}`;
            const targetUrl = `${this.publicScheme}://${domain.hostname}${normalizedPath}`;
            const idempotencyKey = command.idempotencyKey?.trim() || `cron:${job.id}:${new Date().toISOString()}`;
            const dispatchId = stableId("crondispatch", idempotencyKey);
            const result = await client.query(`
          INSERT INTO siteflow_cron_dispatches (
            id,
            cron_job_id,
            project_id,
            target_url,
            method,
            user_agent,
            status,
            reason,
            scheduled_at,
            idempotency_key
          )
          VALUES ($1, $2, $3, $4, 'GET', 'vercel-cron/1.0', 'queued', $5, now(), $6)
          ON CONFLICT (idempotency_key) DO UPDATE
          SET idempotency_key = EXCLUDED.idempotency_key
          RETURNING id, cron_job_id, project_id, target_url, method, user_agent, status, reason,
                    scheduled_at, dispatched_at, response_status, error_message
        `, [
                dispatchId,
                job.id,
                command.projectId,
                targetUrl,
                command.reason?.trim() || "Manual cron run requested.",
                idempotencyKey
            ]);
            await client.query(`
          UPDATE siteflow_cron_jobs
          SET last_dispatched_at = now(),
              updated_at = now()
          WHERE id = $1
        `, [job.id]);
            const updated = await client.query(`
          SELECT id, project_id, name, path, schedule, status, created_at, updated_at, disabled_at, last_dispatched_at
          FROM siteflow_cron_jobs
          WHERE id = $1
        `, [job.id]);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "cron_job.run",
                actor: command.actor,
                targetType: "cron_job",
                targetId: job.id,
                summary: `Cron job ${job.name} queued manual dispatch.`,
                reason: command.reason,
                metadata: {
                    dispatchId,
                    targetUrl
                }
            });
            await client.query("COMMIT");
            return {
                status: "accepted",
                job: cronJobFromRow(updated.rows[0] ?? row),
                dispatch: cronDispatchFromRow(result.rows[0]),
                message: "Cron dispatch queued."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async ingestGitWebhook(command) {
        const event = command.event;
        const deliveryId = command.deliveryId.trim();
        if (!deliveryId) {
            throw new Error("Git webhook delivery id is required.");
        }
        if (command.provider !== event.provider) {
            throw new Error("Git webhook provider mismatch.");
        }
        const project = await this.findOrCreateProjectForSourceEvent(command);
        const existing = await this.readSourceEventByDelivery(command.provider, deliveryId);
        if (existing) {
            const buildJobId = await this.readBuildJobIdForSource(existing.id);
            return {
                status: "duplicate",
                sourceEvent: existing,
                buildJobId,
                message: "Git webhook delivery was already processed."
            };
        }
        const sourceEventId = stableId("src", `${command.provider}:${deliveryId}`);
        const buildJobId = stableId("build", sourceEventId);
        const buildSettings = defaultBuildSettings(project.framework, project.buildSettings);
        await this.pool.query(`
        INSERT INTO siteflow_source_events (
          id,
          project_id,
          provider,
          provider_delivery_id,
          kind,
          status,
          disposition,
          branch,
          commit_sha,
          commit_message,
          commit_author,
          pull_request_number,
          actor,
          provider_payload,
          received_at
        )
        VALUES ($1, $2, $3, $4, $5, 'accepted', 'build_requested', $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
      `, [
            sourceEventId,
            project.id,
            command.provider,
            deliveryId,
            event.kind,
            event.branch,
            event.commitSha,
            event.commitMessage,
            event.commitAuthor,
            event.pullRequestNumber ?? null,
            JSON.stringify(event.actor),
            JSON.stringify(event.providerPayload ?? {}),
            event.receivedAt
        ]);
        await this.pool.query(`
        INSERT INTO siteflow_build_jobs (
          id,
          project_id,
          source_event_id,
          status,
          framework,
          install_command,
          build_command,
          output_directory
        )
        VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
        ON CONFLICT (source_event_id) DO NOTHING
      `, [
            buildJobId,
            project.id,
            sourceEventId,
            buildSettings.framework ?? project.framework,
            buildSettings.installCommand,
            buildSettings.buildCommand,
            buildSettings.outputDirectory
        ]);
        const sourceEvent = await this.readSourceEventByDelivery(command.provider, deliveryId);
        if (!sourceEvent) {
            throw new SiteFlowNotFoundError(`Unknown source event delivery: ${deliveryId}`);
        }
        return {
            status: "accepted",
            sourceEvent,
            buildJobId,
            message: "Git webhook accepted and build job queued."
        };
    }
    async ingestAnalyticsEvent(command) {
        await this.readProject(command.projectId);
        const event = normalizeAnalyticsEventInput(command);
        const eventId = stableId("analytics", `${event.projectId}:${event.kind}:${event.path}:${event.occurredAt}:${randomUUID()}`);
        const result = await this.pool.query(`
        INSERT INTO siteflow_analytics_events (
          id,
          project_id,
          kind,
          path,
          referrer,
          country,
          browser,
          device,
          event_name,
          vital_name,
          vital_value,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, project_id, kind, path, referrer, country, browser, device, event_name,
                  vital_name, vital_value, occurred_at, received_at
      `, [
            eventId,
            event.projectId,
            event.kind,
            event.path,
            event.referrer ?? null,
            event.country ?? null,
            event.browser ?? null,
            event.device ?? null,
            event.eventName ?? null,
            event.vitalName ?? null,
            event.vitalValue ?? null,
            event.occurredAt
        ]);
        return {
            status: "accepted",
            event: analyticsEventFromRow(result.rows[0]),
            message: "Analytics event accepted."
        };
    }
    async getAnalyticsDashboard(projectId) {
        const fixtureModel = await this.tryReadModel("analytics-dashboard", projectId);
        if (fixtureModel) {
            return fixtureModel;
        }
        await this.readProject(projectId);
        const totals = await this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE kind = 'pageview') AS pageviews,
          COUNT(*) FILTER (WHERE kind = 'custom') AS custom_events,
          COUNT(*) FILTER (WHERE kind = 'web_vital') AS web_vitals,
          COUNT(DISTINCT path) FILTER (WHERE kind = 'pageview') AS unique_paths
        FROM siteflow_analytics_events
        WHERE project_id = $1 AND received_at >= now() - interval '24 hours'
      `, [projectId]);
        const totalRow = totals.rows[0] ?? { pageviews: 0, custom_events: 0, web_vitals: 0, unique_paths: 0 };
        const pageviews = pgNumber(totalRow.pageviews);
        const customEvents = pgNumber(totalRow.custom_events);
        const webVitalsCount = pgNumber(totalRow.web_vitals);
        const eventTotal = pageviews + customEvents + webVitalsCount;
        const [topPages, referrers, countries, browsers, devices, customEventRows, webVitals] = await Promise.all([
            this.pool.query(`
          SELECT path AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND kind = 'pageview' AND received_at >= now() - interval '24 hours'
          GROUP BY path
          ORDER BY count DESC, path ASC
          LIMIT 5
        `, [projectId]),
            this.pool.query(`
          SELECT referrer AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND kind = 'pageview' AND referrer IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY referrer
          ORDER BY count DESC, referrer ASC
          LIMIT 5
        `, [projectId]),
            this.pool.query(`
          SELECT country AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND country IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY country
          ORDER BY count DESC, country ASC
          LIMIT 5
        `, [projectId]),
            this.pool.query(`
          SELECT browser AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND browser IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY browser
          ORDER BY count DESC, browser ASC
          LIMIT 5
        `, [projectId]),
            this.pool.query(`
          SELECT device AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND device IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY device
          ORDER BY count DESC, device ASC
          LIMIT 5
        `, [projectId]),
            this.pool.query(`
          SELECT event_name AS name, COUNT(*) AS count
          FROM siteflow_analytics_events
          WHERE project_id = $1 AND kind = 'custom' AND event_name IS NOT NULL AND received_at >= now() - interval '24 hours'
          GROUP BY event_name
          ORDER BY count DESC, event_name ASC
          LIMIT 5
        `, [projectId]),
            this.pool.query(`
          SELECT
            vital_name AS name,
            COUNT(*) AS count,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY vital_value) AS p75
          FROM siteflow_analytics_events
          WHERE project_id = $1
            AND kind = 'web_vital'
            AND vital_name IS NOT NULL
            AND vital_value IS NOT NULL
            AND received_at >= now() - interval '24 hours'
          GROUP BY vital_name
          ORDER BY vital_name ASC
        `, [projectId])
        ]);
        return {
            projectId,
            window: "24h",
            totals: {
                pageviews,
                customEvents,
                webVitals: webVitalsCount,
                uniquePaths: pgNumber(totalRow.unique_paths)
            },
            topPages: analyticsDimensionsFromRows(topPages.rows, pageviews),
            referrers: analyticsDimensionsFromRows(referrers.rows, pageviews),
            countries: analyticsDimensionsFromRows(countries.rows, eventTotal),
            browsers: analyticsDimensionsFromRows(browsers.rows, eventTotal),
            devices: analyticsDimensionsFromRows(devices.rows, eventTotal),
            customEvents: analyticsDimensionsFromRows(customEventRows.rows, customEvents),
            webVitals: analyticsWebVitalsFromRows(webVitals.rows),
            updatedAt: new Date().toISOString()
        };
    }
    async queryLogs(command) {
        await this.readProject(command.projectId);
        const filters = logFiltersFromCommand(command);
        const result = await this.queryObservabilityLogEntries({
            projectId: command.projectId,
            source: filters.source,
            severity: filters.severity,
            deploymentId: filters.deploymentId,
            search: filters.search,
            limit: command.limit,
            cursor: command.cursor
        });
        return {
            projectId: command.projectId,
            filters,
            entries: result.entries,
            total: result.total,
            nextCursor: result.nextCursor,
            updatedAt: new Date().toISOString()
        };
    }
    async listSavedLogQueries(projectId) {
        await this.readProject(projectId);
        const result = await this.pool.query(`
        SELECT id, project_id, name, filters, created_by, created_at, updated_at
        FROM siteflow_saved_log_queries
        WHERE project_id = $1
        ORDER BY updated_at DESC, name ASC
      `, [projectId]);
        return {
            projectId,
            queries: result.rows.map(savedLogQueryFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async saveLogQuery(command) {
        await this.readProject(command.projectId);
        const name = normalizeLogQueryName(command.name);
        const filters = logFiltersFromSaved(command.filters);
        const queryId = stableId("logquery", `${command.projectId}:${name}`);
        const client = await this.pool.connect();
        let row;
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_saved_log_queries (
            id,
            project_id,
            name,
            filters,
            created_by
          )
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET filters = EXCLUDED.filters,
              created_by = EXCLUDED.created_by,
              updated_at = now()
          RETURNING id, project_id, name, filters, created_by, created_at, updated_at
        `, [
                queryId,
                command.projectId,
                name,
                JSON.stringify(filters),
                command.actor ? JSON.stringify(command.actor) : null
            ]);
            row = result.rows[0];
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "log_query.saved",
                actor: command.actor,
                targetType: "log_query",
                targetId: row.id,
                summary: `Saved log query ${row.name}.`,
                metadata: {
                    filters
                }
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            status: "saved",
            query: savedLogQueryFromRow(row),
            message: "Log query saved."
        };
    }
    async listLogDrains(projectId) {
        await this.readProject(projectId);
        const result = await this.pool.query(`
        SELECT id, project_id, name, url, sources, minimum_severity, status, signing_secret,
               signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        FROM siteflow_log_drains
        WHERE project_id = $1
        ORDER BY created_at DESC, name ASC
      `, [projectId]);
        return {
            projectId,
            drains: result.rows.map(logDrainFromRow),
            total: result.rows.length,
            updatedAt: new Date().toISOString()
        };
    }
    async createLogDrain(command) {
        await this.readProject(command.projectId);
        const name = normalizeLogDrainName(command.name);
        const url = normalizeLogDrainUrl(command.url);
        const sources = normalizeLogDrainSources(command.sources);
        const minimumSeverity = normalizeLogSeverity(command.minimumSeverity) ?? "info";
        const signingSecret = command.signingSecret?.trim() || generateLogDrainSigningSecret();
        const secretWasProvided = Boolean(command.signingSecret?.trim());
        const drainId = stableId("drain", `${command.projectId}:${name}`);
        const client = await this.pool.connect();
        let row;
        try {
            await client.query("BEGIN");
            const result = await client.query(`
          INSERT INTO siteflow_log_drains (
            id,
            project_id,
            name,
            url,
            sources,
            minimum_severity,
            signing_secret,
            signing_secret_prefix,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9::jsonb)
          ON CONFLICT (project_id, name) DO UPDATE
          SET url = EXCLUDED.url,
              sources = EXCLUDED.sources,
              minimum_severity = EXCLUDED.minimum_severity,
              status = 'active',
              signing_secret = CASE WHEN $10 THEN EXCLUDED.signing_secret ELSE siteflow_log_drains.signing_secret END,
              signing_secret_prefix = CASE WHEN $10 THEN EXCLUDED.signing_secret_prefix ELSE siteflow_log_drains.signing_secret_prefix END,
              created_by = EXCLUDED.created_by,
              updated_at = now()
          RETURNING id, project_id, name, url, sources, minimum_severity, status, signing_secret,
                    signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        `, [
                drainId,
                command.projectId,
                name,
                url,
                sources,
                minimumSeverity,
                signingSecret,
                logDrainSigningSecretPrefix(signingSecret),
                command.actor ? JSON.stringify(command.actor) : null,
                secretWasProvided
            ]);
            row = result.rows[0];
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "log_drain.created",
                actor: command.actor,
                targetType: "log_drain",
                targetId: row.id,
                summary: `Log drain ${row.name} saved.`,
                metadata: {
                    sources: row.sources,
                    minimumSeverity: row.minimum_severity,
                    signingSecretPrefix: row.signing_secret_prefix
                }
            });
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            status: "created",
            drain: logDrainFromRow(row),
            message: "Log drain created."
        };
    }
    async prepareLogDrainDelivery(command) {
        await this.readProject(command.projectId);
        const result = await this.pool.query(`
        SELECT id, project_id, name, url, sources, minimum_severity, status, signing_secret,
               signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        FROM siteflow_log_drains
        WHERE project_id = $1 AND id = $2 AND status = 'active'
      `, [command.projectId, command.drainId]);
        const row = result.rows[0];
        if (!row) {
            throw new SiteFlowNotFoundError(`Unknown active log drain: ${command.drainId}`);
        }
        const logs = await this.queryObservabilityLogEntries({
            projectId: command.projectId,
            sources: normalizeLogDrainSources(row.sources),
            severity: normalizeLogSeverity(row.minimum_severity),
            limit: command.limit ?? 100
        });
        return {
            deliveryId: stableId("delivery", `${command.projectId}:${command.drainId}:${randomUUID()}`),
            drain: logDrainFromRow(row),
            signingSecret: row.signing_secret,
            events: logs.entries
        };
    }
    async recordLogDrainDelivery(command) {
        await this.readProject(command.projectId);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const drainResult = await client.query(`
          SELECT id, project_id, name, url, sources, minimum_severity, status, signing_secret,
                 signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
          FROM siteflow_log_drains
          WHERE project_id = $1 AND id = $2
          FOR UPDATE
        `, [command.projectId, command.drainId]);
            const drainRow = drainResult.rows[0];
            if (!drainRow) {
                throw new SiteFlowNotFoundError(`Unknown log drain: ${command.drainId}`);
            }
            const attempt = command.attempt ?? (await this.nextLogDrainDeliveryAttempt(client, command.drainId));
            const deliveryResult = await client.query(`
          INSERT INTO siteflow_log_drain_deliveries (
            id,
            drain_id,
            project_id,
            status,
            response_status,
            events_delivered,
            attempt,
            payload_sha256,
            error_message
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE
          SET status = EXCLUDED.status,
              response_status = EXCLUDED.response_status,
              events_delivered = EXCLUDED.events_delivered,
              attempt = EXCLUDED.attempt,
              payload_sha256 = EXCLUDED.payload_sha256,
              error_message = EXCLUDED.error_message,
              delivered_at = now()
          RETURNING id, drain_id, project_id, status, response_status, events_delivered,
                    attempt, payload_sha256, error_message, delivered_at
        `, [
                command.deliveryId,
                command.drainId,
                command.projectId,
                command.status,
                command.responseStatus ?? null,
                command.eventsDelivered,
                attempt,
                command.payloadSha256,
                command.errorMessage ?? null
            ]);
            const updatedDrain = await client.query(`
          UPDATE siteflow_log_drains
          SET last_delivered_at = now(),
              updated_at = now()
          WHERE project_id = $1 AND id = $2
          RETURNING id, project_id, name, url, sources, minimum_severity, status, signing_secret,
                    signing_secret_prefix, created_by, created_at, updated_at, last_delivered_at
        `, [command.projectId, command.drainId]);
            await insertAuditEvent(client, {
                projectId: command.projectId,
                action: "log_drain.delivered",
                targetType: "log_drain",
                targetId: command.drainId,
                summary: `Log drain delivery ${command.status}.`,
                metadata: {
                    deliveryId: command.deliveryId,
                    status: command.status,
                    eventsDelivered: command.eventsDelivered,
                    responseStatus: command.responseStatus
                }
            });
            await client.query("COMMIT");
            return {
                status: command.status,
                drain: logDrainFromRow(updatedDrain.rows[0] ?? drainRow),
                delivery: logDrainDeliveryFromRow(deliveryResult.rows[0]),
                message: command.status === "delivered" ? "Log drain delivered." : "Log drain delivery failed."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async listDeployments(projectId) {
        const fixtureModel = await this.tryReadModel("deployment-list", projectId ?? "default");
        if (fixtureModel) {
            return fixtureModel;
        }
        const values = projectId ? [projectId] : [];
        const where = projectId ? "WHERE deployment.project_id = $1" : "";
        const result = await this.pool.query(`
        SELECT
          deployment.id,
          deployment.project_id,
          project.name AS project_name,
          deployment.source_branch,
          deployment.source_commit_sha,
          deployment.status,
          deployment.checksum,
          deployment.file_count,
          deployment.total_bytes,
          deployment.artifact_manifest,
          deployment.created_at,
          route.id AS route_revision_id,
          route.status AS route_revision_status
        FROM siteflow_deployments deployment
        JOIN siteflow_projects project ON project.id = deployment.project_id
        LEFT JOIN LATERAL (
          SELECT id, status
          FROM siteflow_route_revisions
          WHERE deployment_id = deployment.id
          ORDER BY created_at DESC
          LIMIT 1
        ) route ON true
        ${where}
        ORDER BY deployment.created_at DESC
      `, values);
        return {
            deployments: result.rows.map(deploymentSummaryFromRow),
            total: result.rows.length,
            projectId,
            updatedAt: new Date().toISOString()
        };
    }
    async getDeployment(deploymentId) {
        const fixtureModel = await this.tryReadModel("deployment-detail", deploymentId);
        if (fixtureModel) {
            return fixtureModel;
        }
        return this.readDeploymentDetail(deploymentId);
    }
    getReleaseConsole(projectId, channel) {
        return this.readModel("release-console", releaseConsoleKey(projectId, channel));
    }
    getRollbackConsole(projectId, channel) {
        return this.readModel("rollback-console", releaseConsoleKey(projectId, channel));
    }
    async promoteDeployment(command) {
        return this.recordReleaseCommand("promote", command);
    }
    async rollbackDeployment(command) {
        return this.recordReleaseCommand("rollback", command);
    }
    async getRollingRelease(projectId, channel) {
        assertReleaseChannelName(channel);
        await this.readProject(projectId);
        const rollout = await this.readActiveRollingRelease(this.pool, projectId, channel);
        return {
            projectId,
            channel,
            rollout: rollout ? rollingReleaseFromRow(rollout) : undefined,
            currentDeployment: rollout ? await this.readDeploymentSummary(rollout.current_deployment_id).catch(() => undefined) : undefined,
            candidateDeployment: rollout ? await this.readDeploymentSummary(rollout.candidate_deployment_id).catch(() => undefined) : undefined,
            safetyChecks: rollout
                ? [
                    {
                        id: "check-rollout-active",
                        label: "Rolling release active",
                        status: "pass",
                        summary: `Candidate ${rollout.candidate_deployment_id} receives ${rollout.percentage}% of traffic.`
                    }
                ]
                : [],
            updatedAt: new Date().toISOString()
        };
    }
    async startRollingRelease(command) {
        assertRollingCommand(command);
        assertReleaseChannelName(command.channel);
        const percentage = normalizeRolloutPercentage(command.percentage);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await this.ensureProjectExists(client, command.projectId);
            const existing = await this.readActiveRollingRelease(client, command.projectId, command.channel);
            if (existing) {
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    safetyChecks: [
                        {
                            id: "check-no-active-rollout",
                            label: "No active rollout",
                            status: "fail",
                            summary: `Rolling release ${existing.id} is already active.`
                        }
                    ],
                    message: "Rolling release rejected: another rollout is already active."
                };
            }
            const channel = await this.readReleaseChannel(client, command.projectId, command.channel);
            const currentDeploymentId = channel?.current_deployment_id;
            const current = currentDeploymentId ? await this.readDeploymentForRoute(client, currentDeploymentId) : undefined;
            const candidate = await this.readDeploymentForRoute(client, command.candidateDeploymentId);
            const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, command.channel);
            const safetyChecks = [
                {
                    id: "check-current-deployment-ready",
                    label: "Current deployment ready",
                    status: current?.status === "ready" ? "pass" : "fail",
                    summary: current ? `Current deployment ${current.id} is ${current.status}.` : "Release channel has no current deployment."
                },
                ...safetyChecksForRoute(command.projectId, candidate, domains, command.channel)
            ];
            const failedCheck = safetyChecks.find((check) => check.status === "fail");
            if (failedCheck || !current || !candidate) {
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    safetyChecks,
                    message: `Rolling release rejected: ${failedCheck?.summary ?? "current or candidate deployment could not be routed"}`
                };
            }
            const rolloutId = stableId("rollout", command.idempotencyKey);
            const routeRevision = await this.insertRollingRouteRevision(client, rolloutId, command, current.id, candidate.id, percentage, domains, "Rolling release started.");
            const result = await client.query(`
          INSERT INTO siteflow_rolling_releases (
            id,
            project_id,
            channel,
            current_deployment_id,
            candidate_deployment_id,
            percentage,
            status,
            actor,
            reason,
            idempotency_key,
            route_revision_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, $8, $9, $10)
          RETURNING id, project_id, channel, current_deployment_id, candidate_deployment_id, percentage,
                    status, actor, reason, route_revision_id, created_at, updated_at, completed_at, aborted_at
        `, [
                rolloutId,
                command.projectId,
                command.channel,
                current.id,
                candidate.id,
                percentage,
                JSON.stringify(command.actor),
                command.reason.trim(),
                command.idempotencyKey,
                routeRevision.id
            ]);
            await client.query("COMMIT");
            return {
                status: "accepted",
                rollout: rollingReleaseFromRow(result.rows[0]),
                routeRevision,
                safetyChecks,
                message: `Rolling release started at ${percentage}%.`
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async advanceRollingRelease(command) {
        return this.updateRollingRelease("advance", command);
    }
    async completeRollingRelease(command) {
        return this.updateRollingRelease("complete", command);
    }
    async abortRollingRelease(command) {
        return this.updateRollingRelease("abort", command);
    }
    async pollOperation(operationId) {
        const snapshot = await this.tryReadModel("operation", operationId);
        if (snapshot) {
            return snapshot;
        }
        const result = await this.pool.query(`
        SELECT operation_id, action, project_id, channel, target_deployment_id, state, message, route_revision_id, updated_at
        FROM siteflow_release_commands
        WHERE operation_id = $1
      `, [operationId]);
        const row = result.rows[0];
        if (!row) {
            throw new SiteFlowNotFoundError(`Unknown SiteFlow operation: ${operationId}`);
        }
        return {
            operationId: row.operation_id,
            projectId: row.project_id,
            state: row.state,
            kind: operationKind(row.action),
            channel: row.channel,
            targetDeploymentId: row.target_deployment_id,
            routeRevision: row.route_revision_id ? await this.readRouteRevision(this.pool, row.route_revision_id) : undefined,
            updatedAt: row.updated_at.toISOString(),
            message: row.message
        };
    }
    async getLogChunk(deploymentId, cursor) {
        const fixtureModel = await this.tryReadModel("log-chunk", logChunkKey(deploymentId, cursor));
        if (fixtureModel) {
            return fixtureModel;
        }
        return this.readBuildLogChunk(deploymentId, cursor);
    }
    async deployPrebuilt(command) {
        const projectSlug = normalizeSlug(command.projectSlug);
        const baseDomain = resolveBaseDomain(command.baseDomain, this.baseDomain);
        const hostPrefix = normalizeHostPrefix(command.requestedHostPrefix);
        const previewHost = `${hostPrefix}.${baseDomain}`;
        const deploymentId = `dep_${randomUUID().replace(/-/g, "")}`;
        const projectId = `project_${projectSlug}`;
        const artifactRoot = path.resolve(this.artifactRoot, deploymentId);
        const entrypoint = safeArtifactPath(command.entrypoint ?? "index.html");
        const artifactManifest = {
            entrypoint,
            fileCount: command.files.length,
            totalBytes: 0,
            checksum: "",
            generatedAt: new Date().toISOString(),
            metadata: {
                ...(command.public !== undefined ? { public: command.public } : {}),
                ...(command.fluid !== undefined ? { fluid: command.fluid } : {}),
                ...(command.images !== undefined ? { images: command.images } : {}),
                precompressed: precompressedStats(command.files),
                routing: {
                    ...(command.routing?.cleanUrls !== undefined ? { cleanUrls: command.routing.cleanUrls } : {}),
                    ...(command.routing?.trailingSlash !== undefined ? { trailingSlash: command.routing.trailingSlash } : {}),
                    ...(command.routing?.skipTrailingSlashRedirect !== undefined ? { skipTrailingSlashRedirect: command.routing.skipTrailingSlashRedirect } : {})
                }
            }
        };
        const checksum = createHash("sha256");
        let totalBytes = 0;
        if (command.files.length === 0) {
            throw new Error("Prebuilt deploy requires at least one file.");
        }
        await mkdir(artifactRoot, { recursive: true });
        for (const file of command.files) {
            const relativePath = safeArtifactPath(file.path);
            const bytes = verifyFile(file);
            const targetPath = path.resolve(artifactRoot, ...relativePath.split("/"));
            if (!targetPath.startsWith(`${artifactRoot}${path.sep}`)) {
                throw new Error(`Artifact file escapes deployment root: ${file.path}`);
            }
            await mkdir(path.dirname(targetPath), { recursive: true });
            await writeFile(targetPath, bytes);
            checksum.update(relativePath);
            checksum.update("\0");
            checksum.update(bytes);
            totalBytes += bytes.byteLength;
        }
        const digest = checksum.digest("hex");
        artifactManifest.totalBytes = totalBytes;
        artifactManifest.checksum = `sha256:${digest}`;
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
          INSERT INTO siteflow_projects (id, slug, name)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE
          SET slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              updated_at = now()
        `, [projectId, projectSlug, projectSlug]);
            await client.query(`
          INSERT INTO siteflow_deployments (
            id,
            project_id,
            source_type,
            source_branch,
            source_commit_sha,
            status,
            artifact_root,
            checksum,
            file_count,
            total_bytes,
            preview_host,
            artifact_manifest
          )
          VALUES ($1, $2, 'prebuilt', $3, $4, 'ready', $5, $6, $7, $8, $9, $10::jsonb)
        `, [
                deploymentId,
                projectId,
                command.source?.branch ?? null,
                command.source?.commitSha ?? null,
                artifactRoot,
                digest,
                command.files.length,
                totalBytes,
                previewHost,
                JSON.stringify(artifactManifest)
            ]);
            await client.query(`
          INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
          VALUES ($1, $2, $3, $4)
        `, [previewHost, deploymentId, artifactRoot, entrypoint]);
            for (const routingCommand of prebuiltRoutingCommands(projectId, command.routing)) {
                const input = normalizeRoutingRuleInput(routingCommand);
                const ruleId = stableId("route", `${projectId}:${input.name}`);
                await client.query(`
            INSERT INTO siteflow_routing_rules (
              id,
              project_id,
              name,
              kind,
              source,
              destination,
              status_code,
              headers,
              priority,
              created_by,
              updated_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET kind = EXCLUDED.kind,
                source = EXCLUDED.source,
                destination = EXCLUDED.destination,
                status_code = EXCLUDED.status_code,
                headers = EXCLUDED.headers,
                priority = EXCLUDED.priority,
                status = 'active',
                updated_by = EXCLUDED.updated_by,
                disabled_at = NULL,
                updated_at = now()
          `, [
                    ruleId,
                    projectId,
                    input.name,
                    input.kind,
                    input.source,
                    input.destination ?? null,
                    input.statusCode ?? null,
                    JSON.stringify(input.headers),
                    input.priority,
                    routingCommand.actor ? JSON.stringify(routingCommand.actor) : null,
                    routingCommand.actor ? JSON.stringify(routingCommand.actor) : null
                ]);
            }
            for (const cronCommand of prebuiltCronCommands(projectId, command.crons)) {
                const name = normalizeCronJobName(cronCommand.name);
                const pathName = normalizeCronPath(cronCommand.path);
                const schedule = normalizeCronSchedule(cronCommand.schedule);
                const jobId = stableId("cron", `${projectId}:${name}`);
                await client.query(`
            INSERT INTO siteflow_cron_jobs (
              id,
              project_id,
              name,
              path,
              schedule,
              created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET path = EXCLUDED.path,
                schedule = EXCLUDED.schedule,
                status = 'active',
                disabled_by = NULL,
                disable_reason = NULL,
                disabled_at = NULL,
                updated_at = now()
          `, [
                    jobId,
                    projectId,
                    name,
                    pathName,
                    schedule,
                    cronCommand.actor ? JSON.stringify(cronCommand.actor) : null
                ]);
            }
            await client.query("COMMIT");
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
        return {
            deploymentId,
            projectId,
            projectSlug,
            previewHost,
            previewUrl: `${this.publicScheme}://${previewHost}`,
            artifactRoot,
            fileCount: command.files.length,
            totalBytes,
            checksum: digest
        };
    }
    async resolveArtifactRoute(host, bucketKey) {
        const normalizedHost = host.toLowerCase().split(":")[0];
        const result = await this.pool.query(`
        SELECT
          route.host,
          deployment.project_id,
          project.production_branch,
          domain.channel AS route_channel,
          deployment.source_branch,
          route.deployment_id,
          route.artifact_root,
          route.entrypoint,
          deployment.artifact_manifest,
          rollout.id AS rolling_release_id,
          candidate.project_id AS candidate_project_id,
          candidate.source_branch AS candidate_source_branch,
          rollout.candidate_deployment_id,
          candidate.artifact_root AS candidate_artifact_root,
          candidate.artifact_manifest AS candidate_artifact_manifest,
          COALESCE(candidate_route.entrypoint, candidate.artifact_manifest->>'entrypoint', 'index.html') AS candidate_entrypoint,
          rollout.percentage
        FROM siteflow_artifact_routes route
        JOIN siteflow_deployments deployment
          ON deployment.id = route.deployment_id
         AND deployment.status = 'ready'
        JOIN siteflow_projects project
          ON project.id = deployment.project_id
        LEFT JOIN siteflow_project_domains domain
          ON domain.hostname = route.host
        LEFT JOIN siteflow_rolling_releases rollout
          ON rollout.project_id = domain.project_id
         AND rollout.channel = domain.channel
         AND rollout.status = 'active'
        LEFT JOIN siteflow_deployments candidate
          ON candidate.id = rollout.candidate_deployment_id
         AND candidate.status = 'ready'
        LEFT JOIN siteflow_artifact_routes candidate_route
          ON candidate_route.deployment_id = candidate.id
         AND candidate_route.host = candidate.preview_host
        WHERE route.host = $1
        LIMIT 1
      `, [normalizedHost]);
        const row = result.rows[0];
        if (!row) {
            return undefined;
        }
        const rolloutPercentage = typeof row.percentage === "number" ? row.percentage : undefined;
        const hasCandidate = row.rolling_release_id
            && row.candidate_deployment_id
            && row.candidate_artifact_root
            && row.candidate_entrypoint
            && rolloutPercentage !== undefined;
        const useCandidate = Boolean(hasCandidate
            && rolloutBucketPercent(`${row.rolling_release_id}:${bucketKey ?? normalizedHost}`) < rolloutPercentage);
        const runtimeEnvironment = async (projectId, branch, artifactManifest) => {
            const artifactRuntimeEnvironment = artifactManifestRuntimeEnvironment(artifactManifest);
            if (!projectId) {
                return artifactRuntimeEnvironment;
            }
            const targetEnvironment = row.route_channel ?? deploymentEnvironmentForBranch(branch ?? undefined, row.production_branch ?? undefined);
            const variables = await this.pool.query(`
          SELECT key, sealed_value
          FROM siteflow_environment_variables
          WHERE project_id = $1
            AND target_environment = $2
            AND scope = 'runtime'
            AND source = 'sealed'
            AND sealed_value IS NOT NULL
        `, [projectId, targetEnvironment]);
            return {
                ...artifactRuntimeEnvironment,
                ...unsealEnvironmentVariables(Object.fromEntries(variables.rows.map((variable) => [variable.key, variable.sealed_value])))
            };
        };
        if (useCandidate && row.rolling_release_id && row.candidate_deployment_id && row.candidate_artifact_root && row.candidate_entrypoint) {
            const candidateRouting = artifactManifestRoutingConfig(row.candidate_artifact_manifest);
            const candidateImages = artifactManifestImageConfig(row.candidate_artifact_manifest);
            return {
                host: row.host,
                projectId: row.candidate_project_id ?? undefined,
                deploymentId: row.candidate_deployment_id,
                artifactRoot: row.candidate_artifact_root,
                entrypoint: row.candidate_entrypoint,
                cleanUrls: candidateRouting.cleanUrls,
                trailingSlash: candidateRouting.trailingSlash,
                skipTrailingSlashRedirect: candidateRouting.skipTrailingSlashRedirect,
                images: candidateImages,
                routingRules: {
                    redirects: candidateRouting.redirects,
                    rewrites: candidateRouting.rewrites,
                    headers: candidateRouting.headers
                },
                functions: functionsFromArtifactManifest(row.candidate_artifact_manifest),
                runtimeEnvironment: await runtimeEnvironment(row.candidate_project_id, row.candidate_source_branch, row.candidate_artifact_manifest),
                rollingReleaseId: row.rolling_release_id,
                trafficTarget: "candidate"
            };
        }
        const routing = artifactManifestRoutingConfig(row.artifact_manifest);
        const images = artifactManifestImageConfig(row.artifact_manifest);
        return {
            host: row.host,
            projectId: row.project_id,
            deploymentId: row.deployment_id,
            artifactRoot: row.artifact_root,
            entrypoint: row.entrypoint,
            cleanUrls: routing.cleanUrls,
            trailingSlash: routing.trailingSlash,
            skipTrailingSlashRedirect: routing.skipTrailingSlashRedirect,
            images,
            routingRules: {
                redirects: routing.redirects,
                rewrites: routing.rewrites,
                headers: routing.headers
            },
            functions: functionsFromArtifactManifest(row.artifact_manifest),
            runtimeEnvironment: await runtimeEnvironment(row.project_id, row.source_branch, row.artifact_manifest),
            rollingReleaseId: row.rolling_release_id ?? undefined,
            trafficTarget: row.rolling_release_id ? "current" : undefined
        };
    }
    async recordFunctionInvocation(invocation) {
        await this.pool.query(`
        INSERT INTO siteflow_function_invocations (
          id,
          deployment_id,
          project_id,
          path,
          method,
          status,
          response_status,
          duration_ms,
          request_id,
          logs,
          error_message,
          invoked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
        ON CONFLICT (request_id) DO NOTHING
      `, [
            invocation.id,
            invocation.deploymentId,
            invocation.projectId,
            invocation.path,
            invocation.method,
            invocation.status,
            invocation.responseStatus,
            invocation.durationMs,
            invocation.requestId,
            JSON.stringify(invocation.logs),
            invocation.errorMessage ?? null,
            invocation.invokedAt
        ]);
    }
    async readModel(kind, key) {
        const model = await this.tryReadModel(kind, key);
        if (!model) {
            throw new SiteFlowNotFoundError(`Unknown SiteFlow ${kind}: ${key}`);
        }
        return model;
    }
    async tryReadModel(kind, key) {
        const result = await this.pool.query("SELECT payload FROM siteflow_read_models WHERE kind = $1 AND key = $2", [kind, key]);
        return result.rows[0]?.payload;
    }
    async readDeploymentDetail(deploymentId) {
        const result = await this.pool.query(`
        SELECT
          deployment.id,
          deployment.project_id,
          deployment.source_branch,
          deployment.source_commit_sha,
          deployment.source_event_id,
          deployment.build_job_id,
          deployment.status AS deployment_status,
          deployment.artifact_root,
          deployment.checksum,
          deployment.file_count,
          deployment.total_bytes,
          deployment.preview_host,
          deployment.artifact_manifest,
          deployment.created_at AS deployment_created_at,
          project.slug AS project_slug,
          project.name AS project_name,
          project.status AS project_status,
          project.framework AS project_framework,
          project.default_branch AS project_default_branch,
          project.production_branch AS project_production_branch,
          project.repository AS project_repository,
          project.build_settings AS project_build_settings,
          project.created_at AS project_created_at,
          project.updated_at AS project_updated_at,
          source.kind AS source_kind,
          source.status AS source_status,
          source.disposition AS source_disposition,
          source.provider_delivery_id,
          source.branch AS source_branch_name,
          source.commit_message AS source_commit_message,
          source.commit_author AS source_commit_author,
          source.received_at AS source_received_at,
          source.actor AS source_actor,
          build.status AS build_status,
          build.framework AS build_framework,
          build.install_command,
          build.build_command,
          build.output_directory,
          build.queued_at,
          build.started_at,
          build.finished_at,
          build.worker_id,
          route.id AS route_revision_id,
          route.channel AS route_channel,
          route.previous_deployment_id AS route_previous_deployment_id,
          route.status AS route_status,
          route.generated_config AS route_generated_config,
          route.validation_summary AS route_validation_summary,
          route.created_at AS route_created_at,
          route.applied_at AS route_applied_at,
          route.failed_reason AS route_failed_reason
        FROM siteflow_deployments deployment
        JOIN siteflow_projects project ON project.id = deployment.project_id
        LEFT JOIN siteflow_source_events source ON source.id = deployment.source_event_id
        LEFT JOIN siteflow_build_jobs build ON build.id = deployment.build_job_id
        LEFT JOIN LATERAL (
          SELECT id, channel, previous_deployment_id, status, generated_config, validation_summary,
                 created_at, applied_at, failed_reason
          FROM siteflow_route_revisions
          WHERE deployment_id = deployment.id
          ORDER BY created_at DESC
          LIMIT 1
        ) route ON true
        WHERE deployment.id = $1
      `, [deploymentId]);
        const row = result.rows[0];
        if (!row) {
            throw new SiteFlowNotFoundError(`Unknown SiteFlow deployment-detail: ${deploymentId}`);
        }
        const project = projectFromInspectRow(row);
        project.domains = await this.listProjectDomains(project.id);
        const sourceEvent = sourceEventFromInspectRow(row);
        const buildJob = buildJobFromInspectRow(row, sourceEvent, project);
        const artifact = artifactFromInspectRow(row, buildJob);
        const deployment = deploymentFromInspectRow(row, sourceEvent, buildJob);
        const routeRevision = routeRevisionFromInspectRow(row);
        const routeEvidence = routeEvidenceForDetail(routeRevision, deployment);
        const logs = row.build_job_id
            ? await this.readBuildLogChunk(deployment.id).catch(() => emptyLogChunk(deployment.id, buildJob.id))
            : emptyLogChunk(deployment.id, buildJob.id);
        return {
            project,
            deployment,
            lineage: {
                sourceEvent,
                buildJob,
                artifact,
                deployment,
                routeRevision
            },
            evidence: detailEvidence(sourceEvent, buildJob, artifact, deployment, routeRevision),
            routeEvidence,
            logs,
            auditEvents: []
        };
    }
    async readProject(projectId) {
        const result = await this.pool.query(`
        SELECT id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
        FROM siteflow_projects
        WHERE id = $1
      `, [projectId]);
        const row = result.rows[0];
        if (!row) {
            throw new SiteFlowNotFoundError(`Unknown project: ${projectId}`);
        }
        const project = projectFromRow(row);
        project.domains = await this.listProjectDomains(project.id);
        return project;
    }
    async listProjectEnvironments(projectId) {
        const result = await this.pool.query(`
        SELECT project_id, name, type, branch_pattern, created_at, updated_at
        FROM siteflow_project_environments
        WHERE project_id = $1
        ORDER BY
          CASE type
            WHEN 'local' THEN 1
            WHEN 'preview' THEN 2
            WHEN 'production' THEN 3
            ELSE 4
          END,
          name
      `, [projectId]);
        return result.rows.map(environmentFromRow);
    }
    async listEnvironmentVariables(projectId) {
        const result = await this.pool.query(`
        SELECT id, project_id, key, target_environment, scope, source, fingerprint, updated_by, updated_at
        FROM siteflow_environment_variables
        WHERE project_id = $1
        ORDER BY target_environment, key, scope
      `, [projectId]);
        return result.rows.map(variableFromRow);
    }
    async listTeamMembers(projectId) {
        const result = await this.pool.query(`
        SELECT id, project_id, actor, role, permissions, created_at, updated_at
        FROM siteflow_team_members
        WHERE project_id = $1
        ORDER BY
          CASE role
            WHEN 'owner' THEN 1
            WHEN 'member' THEN 2
            WHEN 'developer' THEN 3
            ELSE 4
          END,
          updated_at DESC
      `, [projectId]);
        return result.rows.map(teamMemberFromRow);
    }
    async listApiTokens(projectId) {
        const result = await this.pool.query(`
        SELECT id, project_id, name, token_prefix, scopes, status, created_by,
               created_at, updated_at, revoked_at, last_used_at
        FROM siteflow_api_tokens
        WHERE project_id = $1 OR project_id IS NULL
        ORDER BY status, updated_at DESC
      `, [projectId]);
        return result.rows.map(apiTokenFromRow);
    }
    async listAuditEvents(projectId, limit = 50) {
        const result = await this.pool.query(`
        SELECT id, project_id, action, actor, target_type, target_id, summary, reason, metadata, created_at
        FROM siteflow_audit_events
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `, [projectId, limit]);
        return result.rows.map(auditEventFromRow);
    }
    async listProjectDomains(projectId) {
        const result = await this.pool.query(`
        SELECT project_id, hostname, channel, verified, last_checked_at
        FROM siteflow_project_domains
        WHERE project_id = $1
        ORDER BY
          CASE channel
            WHEN 'production' THEN 1
            WHEN 'staging' THEN 2
            WHEN 'preview' THEN 3
            ELSE 4
          END,
          hostname
      `, [projectId]);
        return result.rows.map(domainFromRow);
    }
    async replaceProjectDomains(client, projectId, domains) {
        const normalizedDomains = normalizeProjectDomains(domains);
        await client.query("DELETE FROM siteflow_project_domains WHERE project_id = $1", [projectId]);
        for (const domain of normalizedDomains) {
            await client.query(`
          INSERT INTO siteflow_project_domains (
            project_id,
            hostname,
            channel,
            verified,
            last_checked_at
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (project_id, hostname) DO UPDATE
          SET channel = EXCLUDED.channel,
              verified = EXCLUDED.verified,
              last_checked_at = EXCLUDED.last_checked_at,
              updated_at = now()
        `, [projectId, domain.hostname, domain.channel, domain.verified, domain.lastCheckedAt]);
        }
    }
    async findOrCreateProjectForSourceEvent(command) {
        const repository = command.event.repository;
        const result = await this.pool.query(`
        SELECT id, slug, name, status, framework, default_branch, production_branch, repository, build_settings, created_at, updated_at
        FROM siteflow_projects
        WHERE repository->>'provider' = $1
          AND repository->>'owner' = $2
          AND repository->>'name' = $3
        LIMIT 1
      `, [repository.provider, repository.owner, repository.name]);
        if (result.rows[0]) {
            return projectFromRow(result.rows[0]);
        }
        return (await this.createProject({
            slug: repository.name,
            name: repository.name,
            framework: "static",
            defaultBranch: repository.defaultBranch,
            productionBranch: repository.defaultBranch,
            repository
        })).project;
    }
    async readSourceEventByDelivery(provider, deliveryId) {
        const result = await this.pool.query(`
        SELECT id, project_id, kind, status, disposition, provider_delivery_id, branch, commit_sha, commit_message, commit_author,
               pull_request_number, received_at, actor
        FROM siteflow_source_events
        WHERE provider = $1 AND provider_delivery_id = $2
      `, [provider, deliveryId]);
        const row = result.rows[0];
        return row ? sourceEventFromRow(row) : undefined;
    }
    async readBuildJobIdForSource(sourceEventId) {
        const result = await this.pool.query("SELECT id FROM siteflow_build_jobs WHERE source_event_id = $1", [sourceEventId]);
        return result.rows[0]?.id;
    }
    async queryObservabilityLogEntries(command) {
        const limit = normalizeLogLimit(command.limit);
        const offset = normalizeLogCursor(command.cursor);
        const source = normalizeLogSource(command.source);
        const sources = command.sources?.map((entry) => normalizeLogSource(entry));
        const severity = normalizeLogSeverity(command.severity);
        const severityRank = severity === undefined ? undefined : observabilitySeverityRank[severity];
        const search = normalizeLogSearch(command.search);
        const result = await this.pool.query(`
        WITH entries AS (
          SELECT
            ('buildlog_' || build_log.id::text) AS id,
            build.project_id,
            'build'::text AS source,
            CASE
              WHEN build_log.line ~* '(error|failed|exception)' OR build.status IN ('failed', 'timed_out', 'canceled') THEN 'error'
              WHEN build_log.line ~* '(warn|warning|deprecated)' THEN 'warning'
              ELSE 'info'
            END AS severity,
            build_log.line AS message,
            build_log.created_at AS occurred_at,
            deployment.id AS deployment_id,
            build.id AS build_job_id,
            NULL::text AS cron_job_id,
            NULL::text AS request_id,
            jsonb_build_object('buildStatus', build.status, 'buildLogId', build_log.id) AS metadata
          FROM siteflow_build_logs build_log
          JOIN siteflow_build_jobs build ON build.id = build_log.build_job_id
          LEFT JOIN siteflow_deployments deployment ON deployment.build_job_id = build.id
          WHERE build.project_id = $1

          UNION ALL

          SELECT
            invocation.id,
            invocation.project_id,
            'function'::text AS source,
            CASE WHEN invocation.status = 'failed' OR invocation.response_status >= 500 THEN 'error' ELSE 'info' END AS severity,
            CONCAT(invocation.method, ' ', invocation.path, ' completed with status ', invocation.response_status) AS message,
            invocation.invoked_at AS occurred_at,
            invocation.deployment_id,
            NULL::text AS build_job_id,
            NULL::text AS cron_job_id,
            invocation.request_id,
            jsonb_build_object(
              'durationMs', invocation.duration_ms,
              'errorMessage', invocation.error_message,
              'logs', invocation.logs
            ) AS metadata
          FROM siteflow_function_invocations invocation
          WHERE invocation.project_id = $1

          UNION ALL

          SELECT
            ('functionlog_' || invocation.id || '_' || log_line.ordinality::text) AS id,
            invocation.project_id,
            'function'::text AS source,
            CASE
              WHEN invocation.status = 'failed' OR invocation.response_status >= 500 OR log_line.value ~* '(error|failed|exception)' THEN 'error'
              WHEN log_line.value ~* '(warn|warning|deprecated)' THEN 'warning'
              ELSE 'info'
            END AS severity,
            log_line.value AS message,
            invocation.invoked_at AS occurred_at,
            invocation.deployment_id,
            NULL::text AS build_job_id,
            NULL::text AS cron_job_id,
            invocation.request_id,
            jsonb_build_object('responseStatus', invocation.response_status, 'durationMs', invocation.duration_ms) AS metadata
          FROM siteflow_function_invocations invocation
          CROSS JOIN LATERAL jsonb_array_elements_text(invocation.logs) WITH ORDINALITY AS log_line(value, ordinality)
          WHERE invocation.project_id = $1

          UNION ALL

          SELECT
            dispatch.id,
            dispatch.project_id,
            'cron'::text AS source,
            CASE WHEN dispatch.status = 'failed' OR dispatch.error_message IS NOT NULL THEN 'error' ELSE 'info' END AS severity,
            CASE
              WHEN dispatch.error_message IS NOT NULL THEN CONCAT('Cron dispatch failed for ', dispatch.target_url, ': ', dispatch.error_message)
              ELSE CONCAT('Cron dispatch ', dispatch.status, ' for ', dispatch.target_url)
            END AS message,
            dispatch.dispatched_at AS occurred_at,
            NULL::text AS deployment_id,
            NULL::text AS build_job_id,
            dispatch.cron_job_id,
            NULL::text AS request_id,
            jsonb_build_object(
              'responseStatus', dispatch.response_status,
              'reason', dispatch.reason,
              'userAgent', dispatch.user_agent
            ) AS metadata
          FROM siteflow_cron_dispatches dispatch
          WHERE dispatch.project_id = $1
        ),
        filtered AS (
          SELECT *
          FROM entries
          WHERE ($2::text IS NULL OR source = $2)
            AND ($3::text[] IS NULL OR source = ANY($3))
            AND ($4::integer IS NULL OR CASE severity
                  WHEN 'info' THEN 0
                  WHEN 'warning' THEN 1
                  ELSE 2
                END >= $4)
            AND ($5::text IS NULL OR deployment_id = $5)
            AND ($6::text IS NULL OR message ILIKE ('%' || $6 || '%'))
        )
        SELECT
          id,
          project_id,
          source,
          severity,
          message,
          occurred_at,
          deployment_id,
          build_job_id,
          cron_job_id,
          request_id,
          metadata,
          COUNT(*) OVER() AS total_count
        FROM filtered
        ORDER BY occurred_at DESC, id DESC
        OFFSET $7
        LIMIT $8
      `, [
            command.projectId,
            source ?? null,
            sources && sources.length > 0 ? sources : null,
            severityRank ?? null,
            command.deploymentId ?? null,
            search ?? null,
            offset,
            limit + 1
        ]);
        const rows = result.rows.slice(0, limit);
        const total = result.rows[0]?.total_count === undefined ? offset + rows.length : pgNumber(result.rows[0].total_count);
        return {
            entries: rows.map(observabilityLogEntryFromRow),
            total,
            nextCursor: result.rows.length > limit ? String(offset + limit) : undefined
        };
    }
    async nextLogDrainDeliveryAttempt(client, drainId) {
        const result = await client.query("SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM siteflow_log_drain_deliveries WHERE drain_id = $1", [drainId]);
        return pgNumber(result.rows[0]?.attempt ?? 1);
    }
    async readBuildLogChunk(deploymentId, cursor) {
        const deployment = await this.pool.query("SELECT build_job_id FROM siteflow_deployments WHERE id = $1", [deploymentId]);
        const buildJobId = deployment.rows[0]?.build_job_id;
        if (!deployment.rows[0]) {
            throw new SiteFlowNotFoundError(`Unknown SiteFlow log-chunk: ${logChunkKey(deploymentId, cursor)}`);
        }
        if (!buildJobId) {
            throw new SiteFlowNotFoundError(`Deployment has no build log stream: ${deploymentId}`);
        }
        const cursorId = cursor && /^\d+$/.test(cursor) ? Number.parseInt(cursor, 10) : 0;
        const pageSize = 100;
        const result = await this.pool.query(`
        SELECT id::text, line
        FROM siteflow_build_logs
        WHERE build_job_id = $1 AND id > $2
        ORDER BY id ASC
        LIMIT $3
      `, [buildJobId, cursorId, pageSize + 1]);
        const rows = result.rows.slice(0, pageSize);
        const hasMore = result.rows.length > pageSize;
        const nextCursor = hasMore ? rows[rows.length - 1]?.id : undefined;
        return {
            deploymentId,
            chunk: {
                deploymentId,
                buildJobId,
                cursor: cursor ?? "0",
                lines: rows.map((row) => row.line),
                nextCursor,
                complete: !hasMore,
                fetchedAt: new Date().toISOString()
            },
            nextCursor,
            hasMore
        };
    }
    async ensureDefaultEnvironments(client, projectId, productionBranch) {
        const environments = [
            ["local", "local", null],
            ["preview", "preview", "*"],
            ["production", "production", productionBranch]
        ];
        for (const [name, type, branchPattern] of environments) {
            await client.query(`
          INSERT INTO siteflow_project_environments (project_id, name, type, branch_pattern)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (project_id, name) DO UPDATE
          SET type = EXCLUDED.type,
              branch_pattern = EXCLUDED.branch_pattern,
              updated_at = now()
        `, [projectId, name, type, branchPattern]);
        }
    }
    async ensureProjectExists(client, projectId) {
        const result = await client.query("SELECT id FROM siteflow_projects WHERE id = $1", [projectId]);
        if (!result.rows[0]) {
            throw new SiteFlowNotFoundError(`Unknown project: ${projectId}`);
        }
    }
    async readReleaseCommandByIdempotencyKey(client, idempotencyKey) {
        const result = await client.query(`
        SELECT idempotency_key, operation_id, action, project_id, channel, current_deployment_id,
               target_deployment_id, state, actor, reason, message, route_revision_id, created_at, updated_at
        FROM siteflow_release_commands
        WHERE idempotency_key = $1
        FOR UPDATE
      `, [idempotencyKey]);
        return result.rows[0];
    }
    async readRouteRevision(client, routeRevisionId) {
        const result = await client.query(`
        SELECT id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
               validation_summary, created_at, applied_at, failed_reason
        FROM siteflow_route_revisions
        WHERE id = $1
      `, [routeRevisionId]);
        const row = result.rows[0];
        return row ? routeRevisionFromRow(row) : undefined;
    }
    async readRouteRevisionByIdempotencyKey(client, idempotencyKey) {
        const result = await client.query(`
        SELECT id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
               validation_summary, created_at, applied_at, failed_reason
        FROM siteflow_route_revisions
        WHERE idempotency_key = $1
      `, [idempotencyKey]);
        const row = result.rows[0];
        return row ? routeRevisionFromRow(row) : undefined;
    }
    async readActiveRollingRelease(client, projectId, channel, lock = false) {
        const result = await client.query(`
        SELECT id, project_id, channel, current_deployment_id, candidate_deployment_id, percentage,
               status, actor, reason, route_revision_id, created_at, updated_at, completed_at, aborted_at
        FROM siteflow_rolling_releases
        WHERE project_id = $1
          AND channel = $2
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
        ${lock ? "FOR UPDATE" : ""}
      `, [projectId, channel]);
        return result.rows[0];
    }
    async readDeploymentSummary(deploymentId) {
        const result = await this.pool.query(`
        SELECT
          deployment.id,
          deployment.project_id,
          project.name AS project_name,
          deployment.source_branch,
          deployment.source_commit_sha,
          deployment.status,
          deployment.checksum,
          deployment.file_count,
          deployment.total_bytes,
          deployment.artifact_manifest,
          deployment.created_at,
          route.id AS route_revision_id,
          route.status AS route_revision_status
        FROM siteflow_deployments deployment
        JOIN siteflow_projects project ON project.id = deployment.project_id
        LEFT JOIN LATERAL (
          SELECT id, status
          FROM siteflow_route_revisions
          WHERE deployment_id = deployment.id
          ORDER BY created_at DESC
          LIMIT 1
        ) route ON true
        WHERE deployment.id = $1
      `, [deploymentId]);
        const row = result.rows[0];
        if (!row) {
            throw new SiteFlowNotFoundError(`Unknown SiteFlow deployment: ${deploymentId}`);
        }
        return deploymentSummaryFromRow(row);
    }
    async insertRollingRouteRevision(client, rolloutId, command, currentDeploymentId, candidateDeploymentId, percentage, domains, summary, routeDeploymentId = candidateDeploymentId) {
        const routeRevisionId = stableId("route", `${command.idempotencyKey}:rolling:${rolloutId}:${percentage}`);
        const idempotencyKey = `${command.idempotencyKey}:rolling:${rolloutId}:${percentage}`;
        const result = await client.query(`
        INSERT INTO siteflow_route_revisions (
          id,
          project_id,
          channel,
          deployment_id,
          previous_deployment_id,
          status,
          generated_config,
          validation_summary,
          actor,
          reason,
          idempotency_key,
          applied_at
        )
        VALUES ($1, $2, $3, $4, $5, 'applied', $6, $7, $8::jsonb, $9, $10, now())
        ON CONFLICT (idempotency_key) DO UPDATE
        SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
                  validation_summary, created_at, applied_at, failed_reason
      `, [
            routeRevisionId,
            command.projectId,
            command.channel,
            routeDeploymentId,
            currentDeploymentId,
            rollingGeneratedConfig(rolloutId, command.projectId, command.channel, currentDeploymentId, candidateDeploymentId, percentage, domains),
            summary,
            JSON.stringify(command.actor),
            command.reason.trim(),
            idempotencyKey
        ]);
        return routeRevisionFromRow(result.rows[0]);
    }
    async readDeploymentForRoute(client, deploymentId) {
        const result = await client.query(`
        SELECT
          deployment.id,
          deployment.project_id,
          deployment.status,
          deployment.artifact_root,
          COALESCE(route.entrypoint, deployment.artifact_manifest->>'entrypoint', 'index.html') AS entrypoint,
          deployment.preview_host
        FROM siteflow_deployments deployment
        LEFT JOIN siteflow_artifact_routes route
          ON route.deployment_id = deployment.id
         AND route.host = deployment.preview_host
        WHERE deployment.id = $1
        LIMIT 1
      `, [deploymentId]);
        return result.rows[0];
    }
    async readReleaseChannel(client, projectId, channel) {
        const result = await client.query(`
        SELECT project_id, name, current_deployment_id, pending_deployment_id, route_revision_id, updated_by, updated_at
        FROM siteflow_release_channels
        WHERE project_id = $1 AND name = $2
        FOR UPDATE
      `, [projectId, channel]);
        return result.rows[0];
    }
    async listVerifiedDomainsForChannel(client, projectId, channel) {
        const result = await client.query(`
        SELECT project_id, hostname, channel, verified, last_checked_at
        FROM siteflow_project_domains
        WHERE project_id = $1
          AND channel = $2
          AND verified = true
        ORDER BY hostname
      `, [projectId, channel]);
        return result.rows.map(domainFromRow);
    }
    async updateRollingRelease(action, command) {
        assertRollingCommand(command);
        assertReleaseChannelName(command.channel);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await this.ensureProjectExists(client, command.projectId);
            const rollout = await this.readActiveRollingRelease(client, command.projectId, command.channel, true);
            if (!rollout) {
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    safetyChecks: [
                        {
                            id: "check-active-rollout",
                            label: "Active rollout",
                            status: "fail",
                            summary: "No active rolling release exists for this channel."
                        }
                    ],
                    message: "Rolling release rejected: no active rollout."
                };
            }
            const nextPercentage = action === "advance"
                ? normalizeRolloutPercentage(command.percentage)
                : action === "complete"
                    ? 100
                    : rollout.percentage;
            if (action === "advance" && nextPercentage <= rollout.percentage) {
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    rollout: rollingReleaseFromRow(rollout),
                    safetyChecks: [
                        {
                            id: "check-rollout-increase",
                            label: "Rollout percentage increases",
                            status: "fail",
                            summary: `Rolling release is already at ${rollout.percentage}%.`
                        }
                    ],
                    message: "Rolling release rejected: percentage must increase."
                };
            }
            const current = await this.readDeploymentForRoute(client, rollout.current_deployment_id);
            const candidate = await this.readDeploymentForRoute(client, rollout.candidate_deployment_id);
            const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, command.channel);
            const safetyChecks = [
                {
                    id: "check-active-rollout",
                    label: "Active rollout",
                    status: "pass",
                    summary: `Rolling release ${rollout.id} is active.`
                },
                {
                    id: "check-current-deployment-ready",
                    label: "Current deployment ready",
                    status: current?.status === "ready" ? "pass" : "fail",
                    summary: current ? `Current deployment ${current.id} is ${current.status}.` : "Current deployment does not exist."
                },
                ...safetyChecksForRoute(command.projectId, candidate, domains, command.channel)
            ];
            const failedCheck = safetyChecks.find((check) => check.status === "fail");
            if (failedCheck || !current || !candidate) {
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    rollout: rollingReleaseFromRow(rollout),
                    safetyChecks,
                    message: `Rolling release rejected: ${failedCheck?.summary ?? "current or candidate deployment could not be routed"}`
                };
            }
            const routeRevision = await this.insertRollingRouteRevision(client, rollout.id, command, current.id, candidate.id, nextPercentage, domains, action === "advance"
                ? `Rolling release advanced to ${nextPercentage}%.`
                : action === "complete"
                    ? "Rolling release completed and production route applied."
                    : "Rolling release aborted; current route preserved.", action === "abort" ? current.id : candidate.id);
            if (action === "complete") {
                for (const domain of domains) {
                    await client.query(`
              INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (host) DO UPDATE
              SET deployment_id = EXCLUDED.deployment_id,
                  artifact_root = EXCLUDED.artifact_root,
                  entrypoint = EXCLUDED.entrypoint
            `, [domain.hostname, candidate.id, candidate.artifact_root, candidate.entrypoint]);
                }
                await client.query(`
            INSERT INTO siteflow_release_channels (
              project_id,
              name,
              current_deployment_id,
              pending_deployment_id,
              route_revision_id,
              updated_by
            )
            VALUES ($1, $2, $3, NULL, $4, $5::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET current_deployment_id = EXCLUDED.current_deployment_id,
                pending_deployment_id = NULL,
                route_revision_id = EXCLUDED.route_revision_id,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
          `, [command.projectId, command.channel, candidate.id, routeRevision.id, JSON.stringify(command.actor)]);
            }
            const updated = await client.query(`
          UPDATE siteflow_rolling_releases
          SET percentage = $2,
              status = $3,
              actor = $4::jsonb,
              reason = $5,
              route_revision_id = $6,
              updated_at = now(),
              completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
              aborted_at = CASE WHEN $3 = 'aborted' THEN now() ELSE aborted_at END
          WHERE id = $1
          RETURNING id, project_id, channel, current_deployment_id, candidate_deployment_id, percentage,
                    status, actor, reason, route_revision_id, created_at, updated_at, completed_at, aborted_at
        `, [
                rollout.id,
                nextPercentage,
                action === "complete" ? "completed" : action === "abort" ? "aborted" : "active",
                JSON.stringify(command.actor),
                command.reason.trim(),
                routeRevision.id
            ]);
            await client.query("COMMIT");
            return {
                status: "accepted",
                rollout: rollingReleaseFromRow(updated.rows[0]),
                routeRevision,
                safetyChecks,
                message: action === "advance"
                    ? `Rolling release advanced to ${nextPercentage}%.`
                    : action === "complete"
                        ? "Rolling release completed."
                        : "Rolling release aborted."
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
    async releaseCommandResultFromRow(client, row) {
        const routeRevision = row.route_revision_id ? await this.readRouteRevision(client, row.route_revision_id) : undefined;
        const command = {
            projectId: row.project_id,
            channel: row.channel,
            targetDeploymentId: row.target_deployment_id,
            actor: row.actor,
            reason: row.reason,
            idempotencyKey: row.idempotency_key,
            currentDeploymentId: row.current_deployment_id ?? undefined
        };
        return {
            status: row.state === "failed" ? "rejected" : "accepted",
            operationId: row.operation_id,
            channelEvent: routeRevision ? channelEventForRoute(row.action, command, routeRevision, []) : undefined,
            routeRevision,
            safetyChecks: [],
            message: row.message
        };
    }
    async recordReleaseCommand(action, command) {
        assertReleaseCommand(command);
        assertReleaseChannelName(command.channel);
        const operationId = operationIdFor(command.idempotencyKey);
        const currentDeploymentId = "currentDeploymentId" in command ? command.currentDeploymentId ?? null : null;
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const existing = await this.readReleaseCommandByIdempotencyKey(client, command.idempotencyKey);
            if (existing) {
                const existingResult = await this.releaseCommandResultFromRow(client, existing);
                await client.query("COMMIT");
                return existingResult;
            }
            await this.ensureProjectExists(client, command.projectId);
            const deployment = await this.readDeploymentForRoute(client, command.targetDeploymentId);
            const channel = await this.readReleaseChannel(client, command.projectId, command.channel);
            const domains = await this.listVerifiedDomainsForChannel(client, command.projectId, command.channel);
            const safetyChecks = safetyChecksForRoute(command.projectId, deployment, domains, command.channel);
            const previousDeploymentId = channel?.current_deployment_id ?? null;
            if (currentDeploymentId && channel?.current_deployment_id && currentDeploymentId !== channel.current_deployment_id) {
                safetyChecks.push({
                    id: "check-current-deployment-match",
                    label: "Current deployment match",
                    status: "fail",
                    summary: `Channel currently points to ${channel.current_deployment_id}, not ${currentDeploymentId}.`
                });
            }
            const failedCheck = safetyChecks.find((check) => check.status === "fail");
            if (failedCheck || !deployment) {
                const message = `${releaseVerb(action)} rejected: ${failedCheck?.summary ?? "target deployment could not be routed"}`;
                await client.query(`
            INSERT INTO siteflow_release_commands (
              idempotency_key,
              operation_id,
              action,
              project_id,
              channel,
              current_deployment_id,
              target_deployment_id,
              actor,
              reason,
              state,
              message
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'failed', $10)
          `, [
                    command.idempotencyKey,
                    operationId,
                    action,
                    command.projectId,
                    command.channel,
                    currentDeploymentId,
                    command.targetDeploymentId,
                    JSON.stringify(command.actor),
                    command.reason.trim(),
                    message
                ]);
                await client.query("COMMIT");
                return {
                    status: "rejected",
                    operationId,
                    safetyChecks,
                    message
                };
            }
            const dryRun = Boolean(command.dryRun);
            const routeRevisionId = stableId("route", command.idempotencyKey);
            const routeStatus = dryRun ? "planned" : "applied";
            const generatedConfig = routeGeneratedConfig(command.projectId, command.channel, deployment, domains);
            const validationSummary = dryRun
                ? `${releaseVerb(action)} route validated for ${domains.length} domain${domains.length === 1 ? "" : "s"}; no route was applied.`
                : `${releaseVerb(action)} route applied to ${domains.length} domain${domains.length === 1 ? "" : "s"}.`;
            const routeRevisionResult = await client.query(`
          INSERT INTO siteflow_route_revisions (
            id,
            project_id,
            channel,
            deployment_id,
            previous_deployment_id,
            status,
            generated_config,
            validation_summary,
            actor,
            reason,
            idempotency_key,
            applied_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, CASE WHEN $12 THEN NULL ELSE now() END)
          ON CONFLICT (idempotency_key) DO UPDATE
          SET idempotency_key = EXCLUDED.idempotency_key
          RETURNING id, project_id, channel, deployment_id, previous_deployment_id, status, generated_config,
                    validation_summary, created_at, applied_at, failed_reason
        `, [
                routeRevisionId,
                command.projectId,
                command.channel,
                deployment.id,
                previousDeploymentId,
                routeStatus,
                generatedConfig,
                validationSummary,
                JSON.stringify(command.actor),
                command.reason.trim(),
                command.idempotencyKey,
                dryRun
            ]);
            const routeRevision = routeRevisionFromRow(routeRevisionResult.rows[0]);
            if (!dryRun) {
                for (const domain of domains) {
                    await client.query(`
              INSERT INTO siteflow_artifact_routes (host, deployment_id, artifact_root, entrypoint)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (host) DO UPDATE
              SET deployment_id = EXCLUDED.deployment_id,
                  artifact_root = EXCLUDED.artifact_root,
                  entrypoint = EXCLUDED.entrypoint
            `, [domain.hostname, deployment.id, deployment.artifact_root, deployment.entrypoint]);
                }
                await client.query(`
            INSERT INTO siteflow_release_channels (
              project_id,
              name,
              current_deployment_id,
              pending_deployment_id,
              route_revision_id,
              updated_by
            )
            VALUES ($1, $2, $3, NULL, $4, $5::jsonb)
            ON CONFLICT (project_id, name) DO UPDATE
            SET current_deployment_id = EXCLUDED.current_deployment_id,
                pending_deployment_id = NULL,
                route_revision_id = EXCLUDED.route_revision_id,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
          `, [command.projectId, command.channel, deployment.id, routeRevision.id, JSON.stringify(command.actor)]);
            }
            const message = dryRun
                ? `${releaseVerb(action)} dry run completed.`
                : `${releaseVerb(action)} route applied.`;
            await client.query(`
          INSERT INTO siteflow_release_commands (
            idempotency_key,
            operation_id,
            action,
            project_id,
            channel,
            current_deployment_id,
            target_deployment_id,
            actor,
            reason,
            state,
            message,
            route_revision_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'succeeded', $10, $11)
        `, [
                command.idempotencyKey,
                operationId,
                action,
                command.projectId,
                command.channel,
                previousDeploymentId,
                command.targetDeploymentId,
                JSON.stringify(command.actor),
                command.reason.trim(),
                message,
                routeRevision.id
            ]);
            await client.query("COMMIT");
            return {
                status: "accepted",
                operationId,
                channelEvent: channelEventForRoute(action, command, routeRevision, safetyChecks),
                routeRevision,
                safetyChecks,
                message
            };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
}
