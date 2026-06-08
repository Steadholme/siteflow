import { assertBrowserBuildEnv } from "./assertBrowserBuildEnv";

describe("assertBrowserBuildEnv", () => {
  it("allows non-build commands to use local secret and fixture controls", () => {
    expect(() =>
      assertBrowserBuildEnv({
        command: "serve",
        mode: "development",
        env: {
          VITE_SITEFLOW_API_TOKEN: "local-operator-token",
          VITE_SITEFLOW_USE_FIXTURES: "true",
          VITE_SITEFLOW_FIXTURE_SCENARIO: "routeDrift"
        }
      })
    ).not.toThrow();
  });

  it("blocks browser builds when a VITE_SITEFLOW_API_TOKEN is present", () => {
    expect(() =>
      assertBrowserBuildEnv({
        command: "build",
        mode: "production",
        env: {
          VITE_SITEFLOW_API_TOKEN: " sf_live_operator_console_token "
        }
      })
    ).toThrow(/VITE_SITEFLOW_API_TOKEN/);
  });

  it("blocks browser builds when fixture mode is enabled", () => {
    expect(() =>
      assertBrowserBuildEnv({
        command: "build",
        mode: "production",
        env: {
          VITE_SITEFLOW_USE_FIXTURES: "true"
        }
      })
    ).toThrow(/VITE_SITEFLOW_USE_FIXTURES/);
  });

  it("treats unknown fixture flag values as enabled for browser builds", () => {
    expect(() =>
      assertBrowserBuildEnv({
        command: "build",
        mode: "production",
        env: {
          VITE_SITEFLOW_USE_FIXTURES: "fixture"
        }
      })
    ).toThrow(/VITE_SITEFLOW_USE_FIXTURES/);
  });

  it("blocks browser builds when a fixture scenario is selected", () => {
    expect(() =>
      assertBrowserBuildEnv({
        command: "build",
        mode: "production",
        env: {
          VITE_SITEFLOW_FIXTURE_SCENARIO: "routeDrift"
        }
      })
    ).toThrow(/VITE_SITEFLOW_FIXTURE_SCENARIO/);
  });

  it("allows browser builds without secrets or fixture controls", () => {
    expect(() =>
      assertBrowserBuildEnv({
        command: "build",
        mode: "production",
        env: {
          VITE_SITEFLOW_USE_FIXTURES: "false",
          VITE_SITEFLOW_FIXTURE_SCENARIO: " "
        }
      })
    ).not.toThrow();
  });
});
