import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SiteFlowServerConfig {
  token?: string;
  baseDomain?: string;
}

export interface SiteFlowCliConfig {
  defaultServer?: string;
  servers: Record<string, SiteFlowServerConfig>;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env) {
  return env.SITEFLOW_CONFIG ?? path.join(os.homedir(), ".siteflow", "config.json");
}

export function emptyConfig(): SiteFlowCliConfig {
  return {
    servers: {}
  };
}

function normalizeServerUrl(serverUrl: string) {
  const trimmed = serverUrl.trim();

  if (!trimmed) {
    throw new Error("SiteFlow server URL is required.");
  }

  return trimmed.replace(/\/+$/, "");
}

export async function readCliConfig(configPath = defaultConfigPath()): Promise<SiteFlowCliConfig> {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as Partial<SiteFlowCliConfig>;

    return {
      defaultServer: config.defaultServer,
      servers: config.servers ?? {}
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return emptyConfig();
    }

    throw error;
  }
}

export async function writeCliConfig(config: SiteFlowCliConfig, configPath = defaultConfigPath()) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function saveLoginConfig(input: {
  serverUrl: string;
  token: string;
  baseDomain?: string;
  configPath?: string;
}) {
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

export function resolveServerConfig(config: SiteFlowCliConfig, serverUrl?: string) {
  const resolvedServer = serverUrl ? normalizeServerUrl(serverUrl) : config.defaultServer;

  if (!resolvedServer) {
    return undefined;
  }

  return {
    serverUrl: resolvedServer,
    config: config.servers[resolvedServer] ?? {}
  };
}

