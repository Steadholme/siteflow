export type SiteFlowClientMode = "http" | "fixture";

export interface RuntimeEnv {
  MODE?: string;
  VITE_SITEFLOW_API_URL?: string;
  VITE_SITEFLOW_USE_FIXTURES?: string;
  VITE_SITEFLOW_FIXTURE_SCENARIO?: string;
}

export interface RuntimeConfig {
  clientMode: SiteFlowClientMode;
  apiBaseUrl?: string;
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

export function resolveRuntimeConfig(env: RuntimeEnv = import.meta.env): RuntimeConfig {
  const mode = env.MODE ?? "production";
  const apiBaseUrl = normalizeApiBaseUrl(env.VITE_SITEFLOW_API_URL);
  const explicitlyUseFixtures = parseBooleanFlag(env.VITE_SITEFLOW_USE_FIXTURES);
  const fixtureScenario = env.VITE_SITEFLOW_FIXTURE_SCENARIO?.trim() || "healthy";

  if (mode === "production" && explicitlyUseFixtures) {
    throw new Error("VITE_SITEFLOW_USE_FIXTURES is not allowed in production runtime.");
  }

  if (apiBaseUrl) {
    return {
      clientMode: "http",
      apiBaseUrl,
      fixtureScenario
    };
  }

  if (explicitlyUseFixtures || mode !== "production") {
    return {
      clientMode: "fixture",
      fixtureScenario
    };
  }

  throw new Error("VITE_SITEFLOW_API_URL is required in production runtime.");
}

