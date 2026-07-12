import { describe, expect, it } from "vitest";
import { buildRecallQueryPlan } from "../src/memory/recallQueryPlan";

describe("recall query planning", () => {
  it("classifies explicit dates as a hard range", () => {
    const plan = buildRecallQueryPlan("6月10日发生了什么");
    expect(plan.timeIntent.mode).toBe("hard_range");
    expect(plan.timeIntent.terms.some((term) => term.includes("06-10"))).toBe(true);
  });

  it("keeps recent continuity separate from durable recall", () => {
    expect(buildRecallQueryPlan("刚才聊到哪了").timeIntent.mode).toBe("soft_recent");
  });

  it("expands stable system aliases", () => {
    expect(buildRecallQueryPlan("kld 在 cf 上").expandedQuery).toContain("cloudflare");
  });
});
