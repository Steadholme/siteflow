import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export function defaultConfigPath(env = process.env) {
    return env.SITEFLOW_CONFIG ?? path.join(os.homedir(), ".siteflow", "config.json");
}
export function emptyConfig() {
    return {
        servers: {}
    };
}
function normalizeServerUrl(serverUrl) {
    const trimmed = serverUrl.trim();
    if (!trimmed) {
        throw new Error("SiteFlow server URL is required.");
    }
    return trimmed.replace(/\/+$/, "");
}
export async function readCliConfig(configPath = defaultConfigPath()) {
    try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        return {
            defaultServer: config.defaultServer,
            servers: config.servers ?? {}
        };
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return emptyConfig();
        }
        throw error;
    }
}
export async function writeCliConfig(config, configPath = defaultConfigPath()) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
export async function saveLoginConfig(input) {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const config = await readCliConfig(input.configPath);
    config.defaultServer = serverUrl;
    config.servers[serverUrl] = {
        ...config.servers[serverUrl],
        token: input.token,
        baseDomain: input.baseDomain ?? config.servers[serverUrl]?.baseDomain
    };
    await writeCliConfig(config, input.configPath);
    return {
        serverUrl,
        configPath: input.configPath ?? defaultConfigPath()
    };
}
export function resolveServerConfig(config, serverUrl) {
    const resolvedServer = serverUrl ? normalizeServerUrl(serverUrl) : config.defaultServer;
    if (!resolvedServer) {
        return undefined;
    }
    return {
        serverUrl: resolvedServer,
        config: config.servers[resolvedServer] ?? {}
    };
}
