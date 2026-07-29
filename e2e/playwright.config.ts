import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Resolved from this file so the suite runs from the repo root too.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { headless: true, viewport: { width: 1500, height: 1000 }, actionTimeout: 15_000 },
});
