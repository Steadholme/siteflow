import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { assertBrowserBuildEnv } from "./scripts/assertBrowserBuildEnv";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig((configEnv) => {
  assertBrowserBuildEnv({
    command: configEnv.command,
    mode: configEnv.mode,
    env: loadEnv(configEnv.mode, fromRoot("./"), "")
  });

  const browserBuild = configEnv.command === "build";
  const alias = [
    ...(browserBuild
      ? [{
          find: "@lib/api/fixtureClient",
          replacement: fromRoot("./src/lib/api/browserProductionFixtureClient.ts")
        }]
      : []),
    { find: "@app", replacement: fromRoot("./src/app") },
    { find: "@components", replacement: fromRoot("./src/components") },
    { find: "@features", replacement: fromRoot("./src/features") },
    { find: "@domain", replacement: fromRoot("./src/domain") },
    { find: "@lib", replacement: fromRoot("./src/lib") },
    { find: "@styles", replacement: fromRoot("./src/styles") },
    { find: "@test", replacement: fromRoot("./src/test") }
  ];

  return {
    plugins: [react()],
    resolve: {
      alias
    },
    test: {
      css: true,
      environment: "jsdom",
      exclude: ["node_modules/**", "dist/**", "dist-cli/**", "dist-server/**", "tests/e2e/**"],
      globals: true,
      setupFiles: "./src/test/setup.ts",
      testTimeout: 30000
    }
  };
});
