import { describe, expect, it } from "vitest";
import { createClock, loadAppConfig, loadDreamConfig, loadRecallConfig, loadRetentionConfig } from "../src/config/runtime";
import type { Env } from "../src/types";

describe("typed runtime config", () => {
  it("applies defaults and clamps invalid recall settings", () => {
    const config = loadRecallConfig({ MEMORY_TOP_K: "999", MEMORY_RECALL_TOP_K: "oops", MEMORY_FILTER_MIN_SCORE: "-2" } as Env);
    expect(config.searchTopK).toBe(50);
    expect(config.contextTopK).toBe(3);
    expect(config.filterMinScore).toBe(0);
  });

  it("groups scheduled, dream, retention, and chunking settings once", () => {
    const config = loadAppConfig({
      ENABLE_FIVE_AXIS: "false",
      DREAM_MAX_RUNS: "99",
      AUTO_CHUNK_MIN_MESSAGES: "40",
      AUTO_CHUNK_MAX_MESSAGES: "20",
      MEMORY_RETENTION_MESSAGES_DAYS: "oops"
    } as Env);

    expect(config.fiveAxis.enabled).toBe(false);
    expect(config.dream.maxRuns).toBe(10);
    expect(config.chunking).toMatchObject({ minMessages: 40, maxMessages: 40 });
    expect(config.retention.messagesDays).toBe(14);
  });

  it("preserves dream and retention defaults while normalizing overrides", () => {
    expect(loadDreamConfig({ DREAM_MODEL: "  dream-model  " } as Env)).toMatchObject({
      enabled: false,
      dryRun: true,
      namespace: "default",
      model: "dream-model"
    });
    expect(loadRetentionConfig({ CC_CONNECT_MESSAGE_RETENTION_DAYS: "0" } as Env)).toMatchObject({
      ccConnectProcessedMessagesDays: 7,
      recallReceiptsDays: 7,
      recallDailyDays: 400
    });
  });

  it("provides an injectable clock for deterministic application code", () => {
    const clock = createClock(() => new Date("2026-07-13T12:34:56.000Z"));
    expect(clock.nowMs()).toBe(1783946096000);
    expect(clock.iso()).toBe("2026-07-13T12:34:56.000Z");
    expect(clock.today("UTC")).toBe("2026-07-13");
  });
});
