import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
function toPosixPath(value) {
    return value.split(path.sep).join("/");
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
        files.push({
            path: relativePath,
            contentBase64: content.toString("base64"),
            size: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex")
        });
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
    const command = {
        projectSlug: options.projectSlug,
        baseDomain: options.baseDomain,
        requestedHostPrefix: options.requestedHostPrefix,
        entrypoint: options.entrypoint ?? "index.html",
        files
    };
    const serverUrl = options.serverUrl.replace(/\/+$/, "");
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(`${serverUrl}/api/deployments/prebuilt`, {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json"
        },
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
