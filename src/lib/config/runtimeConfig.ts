export type SiteFlowClientMode = "http" | "fixture";

export interface RuntimeEnv {
  MODE?: string;
  PROD?: boolean;
  VITE_SITEFLOW_API_TOKEN?: string;
  VITE_SITEFLOW_API_URL?: string;
  VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK?: string;
  VITE_SITEFLOW_USE_FIXTURES?: string;
  VITE_SITEFLOW_FIXTURE_SCENARIO?: string;
}

export interface RuntimeConfig {
  clientMode: SiteFlowClientMode;
  apiBaseUrl?: string;
  apiToken?: string;
  browserTokenFallbackEnabled: boolean;
  fixtureScenario: string;
}

function parseBooleanFlag(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

function normalizeApiBaseUrl(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, "");
}

function assertProductionApiBaseUrl(apiBaseUrl: string | undefined) {
  if (!apiBaseUrl) {
    return;
  }

  let parsed: URL;

  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new Error("VITE_SITEFLOW_API_URL must be an absolute HTTPS URL in production runtime.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("VITE_SITEFLOW_API_URL must use https:// in production runtime.");
  }
}

function normalizeSecret(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed || undefined;
}

export function resolveRuntimeConfig(env: RuntimeEnv = import.meta.env): RuntimeConfig {
  const mode = env.MODE ?? "production";
  const production = env.PROD === true || mode === "production";
  const apiBaseUrl = normalizeApiBaseUrl(env.VITE_SITEFLOW_API_URL);
  const apiToken = normalizeSecret(env.VITE_SITEFLOW_API_TOKEN);
  const allowBrowserTokenFallback = production
    ? parseBooleanFlag(env.VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK)
    : env.VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK === undefined || parseBooleanFlag(env.VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK);
  const explicitlyUseFixtures = parseBooleanFlag(env.VITE_SITEFLOW_USE_FIXTURES);
  const fixtureScenario = env.VITE_SITEFLOW_FIXTURE_SCENARIO?.trim() || "healthy";

  if (production && explicitlyUseFixtures) {
    throw new Error("VITE_SITEFLOW_USE_FIXTURES is not allowed in production runtime.");
  }

  if (production && apiToken) {
    throw new Error("VITE_SITEFLOW_API_TOKEN is not allowed in production runtime.");
  }

  if (production) {
    assertProductionApiBaseUrl(apiBaseUrl);
  }

  if (apiBaseUrl) {
    return {
      clientMode: "http",
      apiBaseUrl,
      ...(apiToken ? { apiToken } : {}),
      browserTokenFallbackEnabled: allowBrowserTokenFallback,
      fixtureScenario
    };
  }

  if (explicitlyUseFixtures || !production) {
    return {
      clientMode: "fixture",
      browserTokenFallbackEnabled: false,
      fixtureScenario
    };
  }

  throw new Error("VITE_SITEFLOW_API_URL is required in production runtime.");
}
