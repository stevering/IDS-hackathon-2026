import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  // No webServer — run `pnpm dev` from root manually before running e2e tests
  // (it starts Next.js + Temporal server + Temporal worker via concurrently)
});
