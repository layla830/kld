import { describe, expect, it } from "vitest";
import {
  coordinatePatchForMissingFields,
  needsCoordinateBackfill,
  runScheduledCoordinateBackfill
} from "../src/memory/coordinateBackfill";
import type { Env, MemoryRecord } from "../src/types";

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
    five_axis_revision: 1,
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

  it("includes partially labeled legacy memories in the scheduled sweep", async () => {
    const partial = memory();
    const sql: string[] = [];
    const db = {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind() {
            return { all: async () => ({ results: [partial] }) };
          }
        };
      }
    } as unknown as D1Database;
    let labeled: MemoryRecord[] = [];

    const result = await runScheduledCoordinateBackfill(
      { DB: db, MEMORY_MODEL: "coordinate-model" } as Env,
      "default",
      async (_env, _model, memories) => {
        labeled = memories;
        return [];
      }
    );

    expect(labeled.map((item) => item.id)).toEqual([partial.id]);
    expect(result).toMatchObject({ needBackfill: 1, processed: 1 });
    expect(result.cursor).toEqual({ createdAt: partial.created_at, id: partial.id });
    expect(sql[0]).toContain("NOT EXISTS");
    expect(sql[0]).toContain("coordinate-backfill:");
  });

  it("wraps a persisted cursor instead of letting one unresolved page starve the sweep", async () => {
    const partial = memory({ id: "mem_after_wrap" });
    let scheduledQueries = 0;
    const binds: unknown[][] = [];
    const db = {
      prepare(statement: string) {
        return {
          bind(...values: unknown[]) {
            binds.push(values);
            if (statement.includes("SELECT m.* FROM memories m")) {
              scheduledQueries += 1;
              return { all: async () => ({ results: scheduledQueries === 1 ? [] : [partial] }) };
            }
            return { all: async () => ({ results: [partial] }) };
          }
        };
      }
    } as unknown as D1Database;
    let labeled: MemoryRecord[] = [];

    const result = await runScheduledCoordinateBackfill(
      { DB: db, MEMORY_MODEL: "coordinate-model" } as Env,
      "default",
      async (_env, _model, memories) => {
        labeled = memories;
        return [];
      },
      { createdAt: "2026-07-15T00:00:00.000Z", id: "mem_cursor" }
    );

    expect(scheduledQueries).toBe(2);
    expect(binds[0]).toEqual([
      "default",
      "2026-07-15T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "mem_cursor",
      5
    ]);
    expect(binds[1]).toEqual(["default", 5]);
    expect(labeled.map((item) => item.id)).toEqual([partial.id]);
    expect(result.cursor).toEqual({ createdAt: partial.created_at, id: partial.id });
  });
});
