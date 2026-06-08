import { resolveRuntimeConfig, type RuntimeConfig, type SiteFlowClientMode } from "@lib/config/runtimeConfig";
import { createFixtureSiteFlowClient } from "@lib/api/fixtureClient";
import { HttpSiteFlowClient } from "./httpClient";
import type { SiteFlowClient } from "./siteflowClient";
import { isSiteFlowScenarioName, type SiteFlowScenarioName } from "./scenarioContracts";

export interface SiteFlowClientFactoryOptions {
  config?: RuntimeConfig;
  fixtureScenario?: string;
}

const browserTokenStorageKey = "siteflow.apiToken";

function browserOperatorToken() {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.sessionStorage.getItem(browserTokenStorageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveFixtureScenario(value: string): SiteFlowScenarioName {
  if (isSiteFlowScenarioName(value)) {
    return value;
  }

  throw new Error(`Unknown SiteFlow fixture scenario: ${value}`);
}

export function createSiteFlowClient(options: SiteFlowClientFactoryOptions = {}): SiteFlowClient {
  const config = options.config ?? resolveRuntimeConfig();

  if (config.clientMode === "fixture") {
    return createFixtureSiteFlowClient({
      scenario: resolveFixtureScenario(options.fixtureScenario ?? config.fixtureScenario)
    });
  }

  if (!config.apiBaseUrl) {
    throw new Error("SiteFlow API base URL is required for HTTP client mode.");
  }

  return new HttpSiteFlowClient({
    baseUrl: config.apiBaseUrl,
    authToken: config.apiToken,
    getAuthToken: config.browserTokenFallbackEnabled ? browserOperatorToken : undefined
  });
}

export function getDefaultSiteFlowClientMode(config: RuntimeConfig = resolveRuntimeConfig()): SiteFlowClientMode {
  return config.clientMode;
}
