import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${PORT}`;

// E2E runs the production build against its own database, reseeded on every run.
const env = {
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgres://neuradash_app:app-password-change-me@localhost:5432/neuradash_e2e",
  DATABASE_OWNER_URL: process.env.E2E_DATABASE_OWNER_URL ?? "postgres://postgres:postgres@localhost:5432/neuradash_e2e",
  COOKIE_SECURE: "false",
  PORT: String(PORT),
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: E2E_BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run db:create && npm run db:setup && npm run db:seed -- --reset && npm run start",
    url: `${E2E_BASE_URL}/api/health`,
    env,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
