import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

// Integration tests use their own database so they never wipe the dev/demo data.
const testDatabaseEnv = {
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? "postgres://neuradash_app:app-password-change-me@localhost:5432/neuradash_test",
  DATABASE_OWNER_URL: process.env.TEST_DATABASE_OWNER_URL ?? "postgres://postgres:postgres@localhost:5432/neuradash_test",
};
// globalSetup runs in the main process, so expose the same values there.
if (process.argv.some((a) => a.includes("integration"))) Object.assign(process.env, testDatabaseEnv);

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          env: testDatabaseEnv,
          globalSetup: ["tests/integration/global-setup.ts"],
          // Files share one database; run them one at a time.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
