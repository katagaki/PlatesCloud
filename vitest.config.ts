import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        durableObjects: { DEVICE: { className: "Device", useSQLite: true } },
        bindings: {
          APPLE_TEAM_ID: "TEAMTEAM99",
          APP_BUNDLE_ID: "com.tsubuzaki.Plates",
          APP_ATTEST_ENVIRONMENT: "development",
          WRITE_DAILY_LIMIT: "3",
          IDEATE_DAILY_LIMIT: "2",
          DECIDE_DAILY_LIMIT: "2",
          TOPPINGS_DAILY_LIMIT: "2",
          CHALLENGE_SECRET: "test-secret",
          JEV_API_KEY: "jev-test",
        },
      },
    }),
  ],
});
