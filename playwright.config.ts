import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:3210",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: externalBaseUrl ? undefined : {
    command: "npm run dev -- --port 3210",
    url: "http://127.0.0.1:3210",
    env: {
      ...process.env,
      SCOPELEDGER_AUTH0_DISABLED: "1",
      SCOPELEDGER_DEMO_DB_DISABLED: "1",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
