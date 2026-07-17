import path from "node:path";
import { defineConfig } from "vitest/config";

process.env.WRANGLER_LOG_PATH ??= path.join(import.meta.dirname, ".audit", "wrangler-logs");
const { cloudflareTest, readD1Migrations } = await import("@cloudflare/vitest-pool-workers");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-04-01",
        bindings: {
          ENABLE_FIVE_AXIS: "true",
          DREAM_NAMESPACE: "default",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations"))
        },
        d1Databases: ["DB"],
        queueProducers: { MEMORY_QUEUE: "companion-memory" }
      }
    }))
  ],
  test: {
    include: ["tests-worker/**/*.test.ts"],
    setupFiles: ["./tests-worker/apply-migrations.ts"]
  }
});
