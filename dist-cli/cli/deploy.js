import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
function toPosixPath(value) {
    return value.split(path.sep).join("/");
}
const compressibleExtensions = new Set([
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
function prebuiltFileFromBytes(filePath, content) {
    return {
        path: filePath,
        contentBase64: content.toString("base64"),
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex")
    };
}
function shouldPrecompressPath(filePath) {
    if (filePath.startsWith(".siteflow/functions/")) {
        return false;
    }
    if (filePath.endsWith(".br") || filePath.endsWith(".gz")) {
        return false;
    }
    return compressibleExtensions.has(path.posix.extname(filePath).toLowerCase());
}
function addPrecompressedFiles(files) {
    const artifactPaths = new Set(files.map((file) => file.path));
    const sourceFiles = [...files];
    for (const file of sourceFiles) {
        if (!shouldPrecompressPath(file.path)) {
            continue;
        }
        const content = Buffer.from(file.contentBase64, "base64");
        const variants = [
            prebuiltFileFromBytes(`${file.path}.br`, brotliCompressSync(content)),
            prebuiltFileFromBytes(`${file.path}.gz`, gzipSync(content))
        ];
        for (const variant of variants) {
            if (artifactPaths.has(variant.path)) {
                continue;
            }
            files.push(variant);
            artifactPaths.add(variant.path);
        }
    }
}
async function collectFiles(root, current, files) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
            await collectFiles(root, fullPath, files);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const relativePath = toPosixPath(path.relative(root, fullPath));
        const content = await readFile(fullPath);
        files.push(prebuiltFileFromBytes(relativePath, content));
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function statusCode(value) {
    return value === 301 || value === 302 || value === 307 || value === 308 ? value : undefined;
}
function routingRule(value) {
    if (!isRecord(value) || typeof value.source !== "string") {
        return undefined;
    }
    const rawHeaders = Array.isArray(value.headers)
        ? value.headers.filter((entry) => isRecord(entry) && typeof entry.key === "string" && typeof entry.value === "string")
        : undefined;
    const headers = rawHeaders?.map((entry) => ({
        key: entry.key,
        value: entry.value
    }));
    return {
        name: typeof value.name === "string" ? value.name : undefined,
        source: value.source,
        destination: typeof value.destination === "string" ? value.destination : undefined,
        statusCode: statusCode(value.statusCode ?? (value.permanent === true ? 308 : undefined)),
        headers
    };
}
function routingRules(value) {
    return Array.isArray(value) ? value.map(routingRule).filter((entry) => Boolean(entry)) : undefined;
}
function cronJob(value) {
    if (!isRecord(value) || typeof value.path !== "string" || typeof value.schedule !== "string") {
        return undefined;
    }
    return {
        path: value.path,
        schedule: value.schedule
    };
}
function cronJobs(value) {
    return Array.isArray(value) ? value.map(cronJob).filter((entry) => Boolean(entry)) : undefined;
}
function positiveIntegerList(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value
        .filter((entry) => Number.isInteger(entry) && entry > 0);
    return entries.length ? [...new Set(entries)].sort((left, right) => left - right) : undefined;
}
function imageFormats(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value.filter((entry) => entry === "image/avif" || entry === "image/webp");
    return entries.length ? [...new Set(entries)] : undefined;
}
function nonNegativeInteger(value) {
    return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}
function imageConfig(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const config = {
        sizes: positiveIntegerList(value.sizes),
        qualities: positiveIntegerList(value.qualities),
        formats: imageFormats(value.formats),
        minimumCacheTTL: nonNegativeInteger(value.minimumCacheTTL),
        dangerouslyAllowSVG: typeof value.dangerouslyAllowSVG === "boolean" ? value.dangerouslyAllowSVG : undefined,
        contentSecurityPolicy: typeof value.contentSecurityPolicy === "string" && value.contentSecurityPolicy.trim()
            ? value.contentSecurityPolicy.trim()
            : undefined,
        contentDispositionType: value.contentDispositionType === "inline" || value.contentDispositionType === "attachment"
            ? value.contentDispositionType
            : undefined
    };
    return Object.values(config).some((entry) => entry !== undefined) ? config : undefined;
}
async function readVercelConfig(options) {
    const configPath = path.resolve(options.configPath ?? path.join(options.directory, "vercel.json"));
    try {
        const raw = await readFile(configPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed)) {
            return {};
        }
        const routing = {
            redirects: routingRules(parsed.redirects),
            rewrites: routingRules(parsed.rewrites),
            headers: routingRules(parsed.headers),
            cleanUrls: typeof parsed.cleanUrls === "boolean" ? parsed.cleanUrls : undefined,
            trailingSlash: typeof parsed.trailingSlash === "boolean" ? parsed.trailingSlash : undefined,
            skipTrailingSlashRedirect: typeof parsed.skipTrailingSlashRedirect === "boolean" ? parsed.skipTrailingSlashRedirect : undefined
        };
        const crons = cronJobs(parsed.crons);
        const hasRouting = Boolean(routing.redirects?.length
            || routing.rewrites?.length
            || routing.headers?.length
            || routing.cleanUrls !== undefined
            || routing.trailingSlash !== undefined
            || routing.skipTrailingSlashRedirect !== undefined);
        return {
            public: typeof parsed.public === "boolean" ? parsed.public : undefined,
            fluid: typeof parsed.fluid === "boolean" || parsed.fluid === null ? parsed.fluid : undefined,
            images: imageConfig(parsed.images),
            routing: hasRouting ? routing : undefined,
            crons: crons?.length ? crons : undefined
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return {};
        }
        throw error;
    }
}
export async function packagePrebuiltDirectory(options) {
    const root = path.resolve(options.directory);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
        throw new Error(`Prebuilt path is not a directory: ${options.directory}`);
    }
    const files = [];
    await collectFiles(root, root, files);
    addPrecompressedFiles(files);
    if (files.length === 0) {
        throw new Error(`Prebuilt directory is empty: ${options.directory}`);
    }
    const entrypoint = options.entrypoint ?? "index.html";
    if (!files.some((file) => file.path === entrypoint)) {
        throw new Error(`Prebuilt directory must contain ${entrypoint}.`);
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
}
export async function deployPrebuilt(options) {
    const files = await packagePrebuiltDirectory(options);
    const config = await readVercelConfig(options);
    const command = {
        projectSlug: options.projectSlug,
        requestedHostPrefix: options.requestedHostPrefix,
        entrypoint: options.entrypoint ?? "index.html",
        files,
        public: config.public,
        fluid: config.fluid,
        images: config.images,
        routing: config.routing,
        crons: config.crons
    };
    if (options.baseDomain) {
        command.baseDomain = options.baseDomain;
    }
    const serverUrl = options.serverUrl.replace(/\/+$/, "");
    const fetchImpl = options.fetch ?? fetch;
    const headers = {
        accept: "application/json",
        "content-type": "application/json"
    };
    if (options.apiToken) {
        headers.authorization = `Bearer ${options.apiToken}`;
    }
    const response = await fetchImpl(`${serverUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers,
        body: JSON.stringify(command)
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => undefined));
        throw new Error(body?.message ?? `Prebuilt deploy failed with HTTP ${response.status}.`);
    }
    return (await response.json());
}
export function formatPrebuiltDeployResult(result) {
    return [
        "SiteFlow deploy accepted",
        `Deployment: ${result.deploymentId}`,
        `Preview:    ${result.previewUrl}`,
        `Files:      ${result.fileCount}`,
        `Bytes:      ${result.totalBytes}`,
        `Checksum:   ${result.checksum}`
    ].join("\n");
}
