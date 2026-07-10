import { defineConfig } from "@playwright/test";

const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium-375x812",
      use: {
        viewport: { width: 375, height: 812 }
      }
    },
    {
      name: "chromium-768x1024",
      use: {
        viewport: { width: 768, height: 1024 }
      }
    },
    {
      name: "chromium-1280x900",
      use: {
        viewport: { width: 1280, height: 900 }
      }
    }
  ]
});
