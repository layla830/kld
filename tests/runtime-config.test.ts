import { describe, expect, it } from "vitest";
import { loadRecallConfig } from "../src/config/runtime";
import type { Env } from "../src/types";

describe("typed runtime config", () => {
  it("applies defaults and clamps invalid recall settings", () => {
    const config = loadRecallConfig({ MEMORY_TOP_K: "999", MEMORY_RECALL_TOP_K: "oops", MEMORY_FILTER_MIN_SCORE: "-2" } as Env);
    expect(config.searchTopK).toBe(50);
    expect(config.contextTopK).toBe(3);
    expect(config.filterMinScore).toBe(0);
  });
});
