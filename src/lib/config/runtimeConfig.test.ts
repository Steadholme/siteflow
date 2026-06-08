import { resolveRuntimeConfig } from "./runtimeConfig";

describe("resolveRuntimeConfig", () => {
  it("uses the HTTP client when an API URL is configured", () => {
    expect(
      resolveRuntimeConfig({
        MODE: "production",
        VITE_SITEFLOW_API_URL: "https://siteflow.example.com/"
      })
    ).toEqual({
      clientMode: "http",
      apiBaseUrl: "https://siteflow.example.com",
      browserTokenFallbackEnabled: false,
      fixtureScenario: "healthy"
    });
  });

  it("includes an optional operator API token for non-production HTTP client mode", () => {
    expect(
      resolveRuntimeConfig({
        MODE: "test",
        VITE_SITEFLOW_API_URL: "https://siteflow.example.com/",
        VITE_SITEFLOW_API_TOKEN: " sf_live_operator_console_token "
      })
    ).toEqual({
      clientMode: "http",
      apiBaseUrl: "https://siteflow.example.com",
      apiToken: "sf_live_operator_console_token",
      browserTokenFallbackEnabled: true,
      fixtureScenario: "healthy"
    });
  });

  it("allows browser token fallback in production only when explicitly enabled", () => {
    expect(
      resolveRuntimeConfig({
        MODE: "production",
        VITE_SITEFLOW_API_URL: "https://siteflow.example.com/",
        VITE_SITEFLOW_ALLOW_BROWSER_TOKEN_FALLBACK: "1"
      })
    ).toEqual({
      clientMode: "http",
      apiBaseUrl: "https://siteflow.example.com",
      browserTokenFallbackEnabled: true,
      fixtureScenario: "healthy"
    });
  });

  it("rejects bundled operator API tokens in production", () => {
    expect(() =>
      resolveRuntimeConfig({
        MODE: "production",
        VITE_SITEFLOW_API_URL: "https://siteflow.example.com/",
        VITE_SITEFLOW_API_TOKEN: "sf_live_operator_console_token"
      })
    ).toThrow(/VITE_SITEFLOW_API_TOKEN/i);
  });

  it("rejects bundled operator API tokens when the bundler marks the runtime as production", () => {
    expect(() =>
      resolveRuntimeConfig({
        MODE: "staging",
        PROD: true,
        VITE_SITEFLOW_API_URL: "https://siteflow.example.com/",
        VITE_SITEFLOW_API_TOKEN: "sf_live_operator_console_token"
      })
    ).toThrow(/VITE_SITEFLOW_API_TOKEN/i);
  });

  it("requires HTTPS API URLs in production", () => {
    expect(() =>
      resolveRuntimeConfig({
        MODE: "production",
        VITE_SITEFLOW_API_URL: "http://siteflow.example.com/"
      })
    ).toThrow(/https/i);
  });

  it("rejects relative API URLs in production", () => {
    expect(() =>
      resolveRuntimeConfig({
        MODE: "production",
        VITE_SITEFLOW_API_URL: "/api"
      })
    ).toThrow(/absolute HTTPS URL/i);
  });

  it("allows localhost HTTP URLs outside production", () => {
    expect(
      resolveRuntimeConfig({
        MODE: "development",
        VITE_SITEFLOW_API_URL: "http://localhost:8787/"
      })
    ).toMatchObject({
      clientMode: "http",
      apiBaseUrl: "http://localhost:8787",
      browserTokenFallbackEnabled: true
    });
  });

  it("allows fixtures in non-production mode for tests and local demos", () => {
    expect(resolveRuntimeConfig({ MODE: "test", VITE_SITEFLOW_FIXTURE_SCENARIO: "routeDrift" })).toMatchObject({
      clientMode: "fixture",
      browserTokenFallbackEnabled: false,
      fixtureScenario: "routeDrift"
    });
  });

  it("rejects fixture mode in production", () => {
    expect(() => resolveRuntimeConfig({ MODE: "production", VITE_SITEFLOW_USE_FIXTURES: "true" })).toThrow(
      /not allowed in production/i
    );
  });

  it("rejects fixture mode when the bundler marks the runtime as production", () => {
    expect(() => resolveRuntimeConfig({ MODE: "staging", PROD: true, VITE_SITEFLOW_USE_FIXTURES: "true" })).toThrow(
      /not allowed in production/i
    );
  });

  it("requires a real API URL in production", () => {
    expect(() => resolveRuntimeConfig({ MODE: "production" })).toThrow(/VITE_SITEFLOW_API_URL/i);
  });
});
