import { describe, expect, it } from "vitest";
import { readShadowState, shouldApplyEAxisToRanking } from "../src/memory/eAxis";
import { mergeSearchResults } from "../src/memory/recallFusion";
import type { ScoredMemoryRecord } from "../src/memory/vectorStore";

function record(id: string, type: string, patch: Partial<ScoredMemoryRecord> = {}): ScoredMemoryRecord {
  return {
    id,
    namespace: "default",
    type,
    content: "relationship boundary",
    summary: null,
    fact_key: null,
    active_fact: 1,
    thread: null,
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: 0.7,
    confidence: 0.8,
    status: "active",
    pinned: 0,
    tags: "[]",
    source: "test",
    source_message_ids: "[]",
    vector_id: null,
    vector_synced: 0,
    last_recalled_at: null,
    recall_count: 0,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    expires_at: null,
    score: 0.6,
    keywordScore: 0.6,
    ...patch
  };
}

const input = {
  query: "relationship boundary",
  expandedQuery: "relationship boundary",
  limit: 10,
  observeTopK: 2,
  timeIntent: { mode: "none" as const, terms: [] }
};

describe("E-axis shadow ranking", () => {
  it("keeps baseline output while reporting the hypothetical E-axis order", () => {
    const baseline = record("mem_baseline", "rule", { fact_key: "relationship.rule.boundary_baseline", score: 0.65, keywordScore: 0.65 });
    const sensitiveRule = record("mem_sensitive", "rule", {
      fact_key: "relationship.rule.boundary",
      thread: "relationship.boundaries.safety",
      risk_level: "high",
      tension_score: 0.8
    });

    const result = mergeSearchResults(null, [baseline, sensitiveRule], { ...input, applyEAxis: false });

    expect(result.records[0].id).toBe("mem_baseline");
    expect(result.eAxis.mode).toBe("shadow");
    expect(result.eAxis.top_k_changed).toBe(true);
    expect(result.eAxis.baseline_top_ids).toEqual(["mem_baseline", "mem_sensitive"]);
    expect(result.eAxis.e_axis_top_ids).toEqual(["mem_sensitive", "mem_baseline"]);
    expect(result.eAxis.changes.find((change) => change.id === "mem_sensitive")?.boost).toBe(0.15);
  });

  it("uses the same hypothetical order only after the gate is active", () => {
    const baseline = record("mem_baseline", "rule", { fact_key: "relationship.rule.boundary_baseline", score: 0.65, keywordScore: 0.65 });
    const sensitiveRule = record("mem_sensitive", "rule", {
      fact_key: "relationship.rule.boundary",
      thread: "relationship.boundaries.safety",
      risk_level: "high",
      tension_score: 0.8
    });

    const result = mergeSearchResults(null, [baseline, sensitiveRule], { ...input, applyEAxis: true });

    expect(result.records[0].id).toBe("mem_sensitive");
    expect(result.eAxis.mode).toBe("active");
  });

  it("does not activate when the start time is missing or the shadow window is incomplete", () => {
    const now = Date.parse("2026-07-13T00:00:00.000Z");
    expect(readShadowState({}, now)).toMatchObject({ configured: false, inShadow: true, daysRemaining: 30 });
    expect(readShadowState({ E_AXIS_STARTED_AT: "2026-07-10T00:00:00.000Z", E_AXIS_SHADOW_DAYS: "7" }, now))
      .toMatchObject({ configured: true, inShadow: true, daysElapsed: 3, daysRemaining: 4 });
    expect(readShadowState({ E_AXIS_STARTED_AT: "2026-07-01T00:00:00.000Z", E_AXIS_SHADOW_DAYS: "7" }, now).inShadow).toBe(false);
    expect(shouldApplyEAxisToRanking({})).toBe(false);
  });
});
