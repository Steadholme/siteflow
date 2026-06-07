import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@app": fromRoot("./src/app"),
      "@components": fromRoot("./src/components"),
      "@features": fromRoot("./src/features"),
      "@domain": fromRoot("./src/domain"),
      "@lib": fromRoot("./src/lib"),
      "@styles": fromRoot("./src/styles"),
      "@test": fromRoot("./src/test")
    }
  },
  test: {
    css: true,
    environment: "jsdom",
    exclude: ["node_modules/**", "dist/**", "dist-cli/**", "dist-server/**", "tests/e2e/**"],
    globals: true,
    setupFiles: "./src/test/setup.ts"
  }
});
