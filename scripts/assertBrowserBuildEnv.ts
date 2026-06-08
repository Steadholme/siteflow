export type BrowserBuildCommand = "build" | "serve" | string;

export interface BrowserBuildEnvContext {
  command: BrowserBuildCommand;
  mode: string;
  env: Record<string, string | undefined>;
}

function hasValue(value: string | undefined) {
  return Boolean(value?.trim());
}

function enablesFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return true;
}

export function assertBrowserBuildEnv({ command, mode, env }: BrowserBuildEnvContext) {
  if (command !== "build") {
    return;
  }

  const violations: string[] = [];

  if (hasValue(env.VITE_SITEFLOW_API_TOKEN)) {
    violations.push("VITE_SITEFLOW_API_TOKEN must not be present");
  }

  if (enablesFlag(env.VITE_SITEFLOW_USE_FIXTURES)) {
    violations.push("VITE_SITEFLOW_USE_FIXTURES must not enable fixture mode");
  }

  if (hasValue(env.VITE_SITEFLOW_FIXTURE_SCENARIO)) {
    violations.push("VITE_SITEFLOW_FIXTURE_SCENARIO must not be present");
  }

  if (violations.length > 0) {
    throw new Error(
      `Production browser build blocked before bundling for mode "${mode}": ${violations.join("; ")}. ` +
        "Remove browser-exposed secrets and fixture controls from the production build environment."
    );
  }
}
