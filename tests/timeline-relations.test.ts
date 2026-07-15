import { describe, expect, it } from "vitest";
import { rebuildTimelineSequenceForMemory } from "../src/memory/timelineRelations";
import type { MemoryRecord } from "../src/types";

function memory(id: string, date: string): MemoryRecord {
  return {
    id,
    namespace: "default",
    type: "project_state",
    content: id,
    summary: null,
    fact_key: "project:kld.release",
    active_fact: 1,
    thread: "kld",
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: 0.5,
    confidence: 0.8,
    status: "active",
    pinned: 0,
    tags: JSON.stringify([`date:${date}`, "timeline"]),
    source: "test",
    source_message_ids: "[]",
    vector_id: null,
    vector_synced: 0,
    vector_sync_status: null,
    last_recalled_at: null,
    recall_count: 0,
    five_axis_revision: 1,
    created_at: `${date}T00:00:00.000Z`,
    updated_at: `${date}T00:00:00.000Z`,
    expires_at: null
  };
}

describe("approved X timeline relations", () => {
  it("rebuilds adjacent edges from the whole thread/fact group, independent of scan pages", async () => {
    const rows = [
      memory("mem_late", "2026-07-20"),
      memory("mem_early", "2026-07-01"),
      memory("mem_middle", "2026-07-10")
    ];
    const batched: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (sql.includes("SELECT * FROM memories")) {
              return { all: async () => ({ results: rows }) };
            }
            return { sql, args };
          }
        };
      },
      async batch(statements: Array<{ sql: string; args: unknown[] }>) {
        batched.push(...statements);
        return statements.map((_statement, index) => ({ meta: { changes: index === 0 ? 2 : 1 } }));
      }
    } as unknown as D1Database;

    const result = await rebuildTimelineSequenceForMemory(db, rows[0]);

    expect(result).toMatchObject({ memories: 3, expected: 2, inserted: 2 });
    expect(batched).toHaveLength(3);
    expect(batched[0].sql).toContain("DELETE FROM memory_relations");
    expect(batched[0].args[1]).toBe('timeline_approved:["kld","project:kld.release"]');
    expect(batched[1].args.slice(2, 4)).toEqual(["mem_early", "mem_middle"]);
    expect(batched[2].args.slice(2, 4)).toEqual(["mem_middle", "mem_late"]);
  });
});
