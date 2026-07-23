import { describe, expect, it } from "vitest";
import { prepareMemoryDeprojection } from "../src/db/memoryDeprojection";
import {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition
} from "../src/memory/deprojection";
import type { MemoryRecord } from "../src/types";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_deprojection",
    namespace: "default",
    type: "note",
    content: "private memory body must not enter the lifecycle snapshot",
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
    vector_id: "vec_deprojection",
    vector_synced: 1,
    vector_sync_status: "synced",
    last_recalled_at: null,
    recall_count: 0,
    five_axis_revision: 4,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    expires_at: null,
    ...overrides
  };
}

describe("memory deprojection contract", () => {
  it("classifies every eligibility boundary from the shared predicate", () => {
    const eligible = memory();
    const stillEligible = applyMemoryEligibilityPatch(eligible, { type: "lesson" });
    const deleted = applyMemoryEligibilityPatch(eligible, { status: "deleted" });
    const inactiveFact = applyMemoryEligibilityPatch(eligible, { activeFact: false });
    const excludedType = applyMemoryEligibilityPatch(eligible, { type: "auto_diary" });
    const reactivated = applyMemoryEligibilityPatch(
      memory({ status: "deleted", active_fact: 0 }),
      { status: "active" }
    );

    expect(classifyMemoryEligibilityTransition(eligible, stillEligible)).toBe("eligible_to_eligible");
    expect(classifyMemoryEligibilityTransition(eligible, deleted)).toBe("eligible_to_ineligible");
    expect(classifyMemoryEligibilityTransition(eligible, inactiveFact)).toBe("eligible_to_ineligible");
    expect(classifyMemoryEligibilityTransition(eligible, excludedType)).toBe("eligible_to_ineligible");
    expect(classifyMemoryEligibilityTransition(
      memory({ status: "deleted", active_fact: 0 }),
      reactivated
    )).toBe("ineligible_to_eligible");
    expect(classifyMemoryEligibilityTransition(
      memory({ status: "deleted", active_fact: 0 }),
      memory({ status: "archived", active_fact: 0 })
    )).toBe("ineligible_to_ineligible");
  });

  it("builds a composable guarded batch without snapshotting memory content", () => {
    const prepared: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            const statement = { sql, binds };
            prepared.push(statement);
            return statement;
          }
        };
      }
    } as unknown as D1Database;

    const plan = prepareMemoryDeprojection(db, {
      namespace: "default",
      memoryId: "mem_deprojection",
      memory: memory(),
      patch: { status: "deleted" },
      expectedStatus: "active",
      expectedRevision: 4,
      source: "system",
      reason: "unit contract",
      candidateId: "cand_owner",
      operationId: "deproj_unit",
      guard: {
        sql: "EXISTS (SELECT 1 FROM memory_candidates WHERE id = ? AND status = 'pending')",
        binds: ["cand_owner"]
      },
      now: "2026-07-23T01:00:00.000Z"
    });

    expect(plan.transition).toBe("eligible_to_ineligible");
    expect(plan.previousRevision).toBe(4);
    expect(plan.currentRevision).toBe(5);
    expect(plan.statements).toHaveLength(10);
    expect(plan.successGuard.binds).toEqual([
      "deproj_unit",
      "default",
      "mem_deprojection",
      4,
      5,
      "eligible_to_ineligible"
    ]);
    const snapshot = prepared.find((statement) =>
      statement.sql.includes("INSERT OR IGNORE INTO memory_deprojections")
    );
    expect(snapshot?.sql).toContain("relation_snapshot_json");
    expect(snapshot?.sql).not.toContain("memory.content");
    expect(snapshot?.binds).not.toContain(memory().content);
    expect(prepared.some((statement) => statement.sql.includes("memory_candidate_dependencies"))).toBe(true);
    expect(prepared.some((statement) => statement.sql.includes("memory_candidate_axis_runs"))).toBe(true);
    expect(prepared.some((statement) => statement.sql.includes("json_extract(candidate.payload_json"))).toBe(false);
    expect(prepared.some((statement) =>
      statement.sql.includes("UPDATE memory_candidates AS candidate")
    )).toBe(true);
    expect(prepared.some((statement) =>
      statement.sql.includes("UPDATE memory_five_axis_runs AS runs")
    )).toBe(true);
    expect(prepared.some((statement) => statement.sql.includes("invariants_verified"))).toBe(true);
  });

  it("rejects non-deprojection transitions before preparing writes", () => {
    const db = {
      prepare() {
        throw new Error("must not prepare SQL");
      }
    } as unknown as D1Database;

    expect(() => prepareMemoryDeprojection(db, {
      namespace: "default",
      memoryId: "mem_deprojection",
      memory: memory(),
      patch: { type: "lesson" },
      source: "system",
      reason: "not a boundary"
    })).toThrow("memory_deprojection_requires_eligible_to_ineligible:eligible_to_eligible");
  });
});
