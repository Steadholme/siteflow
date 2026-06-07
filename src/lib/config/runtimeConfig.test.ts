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
      fixtureScenario: "healthy"
    });
  });

  it("allows fixtures in non-production mode for tests and local demos", () => {
    expect(resolveRuntimeConfig({ MODE: "test", VITE_SITEFLOW_FIXTURE_SCENARIO: "routeDrift" })).toMatchObject({
      clientMode: "fixture",
      fixtureScenario: "routeDrift"
    });
  });

  it("rejects fixture mode in production", () => {
    expect(() => resolveRuntimeConfig({ MODE: "production", VITE_SITEFLOW_USE_FIXTURES: "true" })).toThrow(
      /not allowed in production/i
    );
  });

  it("requires a real API URL in production", () => {
    expect(() => resolveRuntimeConfig({ MODE: "production" })).toThrow(/VITE_SITEFLOW_API_URL/i);
  });
});

