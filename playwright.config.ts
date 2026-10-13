import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 240000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: process.env.DIORAMA_URL || "http://127.0.0.1:4173/diorama/",
    headless: true,
    viewport: { width: 1440, height: 1050 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH,
      args: ["--no-sandbox"],
    },
  },
  webServer: process.env.DIORAMA_URL
    ? undefined
    : {
        command: "npm run preview -- --port 4173",
        url: "http://127.0.0.1:4173/diorama/",
        reuseExistingServer: true,
        timeout: 30000,
      },
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
});
