import path from "node:path";
import { defineConfig } from "vitest/config";

process.env.WRANGLER_LOG_PATH ??= path.join(import.meta.dirname, ".audit", "wrangler-logs");
const { cloudflareTest, readD1Migrations } = await import("@cloudflare/vitest-pool-workers");

// These scenarios asserted the removed synthetic timeline_day contract. They
// remain in the historical circuit file for context and are replaced by
// diary-without-day-memory.test.ts.
const REMOVED_TIMELINE_DAY_SCENARIOS = [
  "closes formal diary split through dated day nodes, X memberships and adjacent-day edges",
  "backfills complete historical splits and deterministically repairs missing day nodes",
  "retries a non-empty diary split that omits its required timeline day",
  "adds a verbatim day anchor when both model attempts omit the timeline day",
  "retries an empty formal diary split until the default date has a day node",
  "retries legacy zero-item completion events but preserves successful and legacy-owned diaries"
].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

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
    setupFiles: ["./tests-worker/apply-migrations.ts"],
    testNamePattern: new RegExp(`^(?!.*(?:${REMOVED_TIMELINE_DAY_SCENARIOS})).*$`)
  }
});
