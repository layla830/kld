import { describe, expect, it } from "vitest";
import {
  coordinatePatchForMissingFields,
  needsCoordinateBackfill
} from "../src/memory/coordinateBackfill";
import type { MemoryRecord } from "../src/types";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_partial",
    namespace: "default",
    type: "lesson",
    content: "A partially labeled memory.",
    summary: null,
    fact_key: "relationship.boundary",
    active_fact: 1,
    thread: "relationship",
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: -0.3,
    arousal: null,
    importance: 0.8,
    confidence: 0.9,
    status: "active",
    pinned: 0,
    tags: "[]",
    source: "test",
    source_message_ids: "[]",
    vector_id: "vec_partial",
    vector_synced: 1,
    vector_sync_status: "synced",
    last_recalled_at: null,
    recall_count: 0,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    expires_at: null,
    ...overrides
  };
}

describe("field-level coordinate completion", () => {
  it("selects partially labeled new memories without widening the legacy sweep", () => {
    const partial = memory();
    expect(needsCoordinateBackfill(partial, "missing_fields")).toBe(true);
    expect(needsCoordinateBackfill(partial, "empty_bundle")).toBe(false);
  });

  it("fills only missing fields and preserves coordinates supplied at write time", () => {
    const patch = coordinatePatchForMissingFields(memory(), {
      thread: "should.not.replace",
      risk_level: "normal",
      urgency_level: "low",
      tension_score: 0.4,
      response_posture: "先确认感受，再给出直接回应。",
      valence: 0.9,
      arousal: 0.6
    });

    expect(patch).toEqual({
      riskLevel: "normal",
      urgencyLevel: "low",
      tensionScore: 0.4,
      responsePosture: "先确认感受，再给出直接回应。",
      arousal: 0.6
    });
    expect(patch.thread).toBeUndefined();
    expect(patch.valence).toBeUndefined();
  });

  it("does not reselect a complete coordinate bundle", () => {
    expect(needsCoordinateBackfill(memory({
      risk_level: "normal",
      urgency_level: "normal",
      tension_score: 0,
      response_posture: "保持简洁、事实性的回应。",
      arousal: 0
    }), "missing_fields")).toBe(false);
  });
});
