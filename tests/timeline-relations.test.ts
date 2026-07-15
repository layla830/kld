import { describe, expect, it } from "vitest";
import { rebuildTimelineSequenceForMemory } from "../src/memory/timelineRelations";
import { queueTimelineCandidateForMemory } from "../src/memory/timelineBackfill";
import type { Env, MemoryRecord } from "../src/types";

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
  it("reconciles an already-dated memory instead of permanently skipping X", async () => {
    const dated = memory("mem_dated", "2026-07-10");
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            if (sql.includes("FROM memory_timeline_memberships")) return { first: async () => null };
            if (sql.includes("SELECT * FROM memories")) return { all: async () => ({ results: [dated] }) };
            if (sql.includes("memory_timeline_memberships")) return { run: async () => ({ meta: { changes: 1 } }) };
            return { sql, args: [] };
          }
        };
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    } as unknown as D1Database;

    const result = await queueTimelineCandidateForMemory({ DB: db } as Env, dated);

    expect(result.outcome).toBe("reconciled");
    expect(result.sequence?.group).toBe('["kld","project:kld.release"]');
  });

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
            if (sql.trim().startsWith("SELECT thread, fact_key FROM memory_timeline_memberships")) {
              return { first: async () => null };
            }
            if (sql.includes("SELECT * FROM memories")) {
              return { all: async () => ({ results: rows }) };
            }
            if (sql.includes("memory_timeline_memberships")) {
              return { run: async () => ({ meta: { changes: 1 } }) };
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
    expect(batched[0].sql).not.toContain("source_memory_id IN");
    expect(batched[1].args.slice(2, 4)).toEqual(["mem_early", "mem_middle"]);
    expect(batched[2].args.slice(2, 4)).toEqual(["mem_middle", "mem_late"]);
  });

  it("rebuilds both the previous and current owned groups when a dated memory moves", async () => {
    const moved = { ...memory("mem_moved", "2026-07-10"), thread: "new-thread", fact_key: "fact:new" };
    const oldRows = [
      { ...memory("old_early", "2026-07-01"), thread: "old-thread", fact_key: "fact:old" },
      { ...memory("old_late", "2026-07-20"), thread: "old-thread", fact_key: "fact:old" }
    ];
    const newRows = [
      { ...memory("new_early", "2026-07-05"), thread: "new-thread", fact_key: "fact:new" },
      moved
    ];
    const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
    let membershipArgs: unknown[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (sql.includes("FROM memory_timeline_memberships")) {
              return { first: async () => ({ thread: "old-thread", fact_key: "fact:old" }) };
            }
            if (sql.includes("SELECT * FROM memories")) {
              return { all: async () => ({ results: args[1] === "old-thread" ? oldRows : newRows }) };
            }
            if (sql.includes("INSERT INTO memory_timeline_memberships")) {
              membershipArgs = args;
              return { run: async () => ({ meta: { changes: 1 } }) };
            }
            return { sql, args };
          }
        };
      },
      async batch(statements: Array<{ sql: string; args: unknown[] }>) {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    } as unknown as D1Database;

    const result = await rebuildTimelineSequenceForMemory(db, moved);

    expect(result.previousGroup).toBe('["old-thread","fact:old"]');
    expect(result.group).toBe('["new-thread","fact:new"]');
    expect(batches).toHaveLength(2);
    expect(batches[0][0].args[1]).toBe('timeline_approved:["old-thread","fact:old"]');
    expect(batches[1][0].args[1]).toBe('timeline_approved:["new-thread","fact:new"]');
    expect(batches.flatMap((batch) => batch)[0].sql).not.toContain("source_memory_id IN");
    expect(membershipArgs.slice(1, 4)).toEqual([moved.id, "new-thread", "fact:new"]);
  });

  it("removes membership and owned edges when a memory becomes a non-projectable type", async () => {
    const excluded = { ...memory("mem_diary", "2026-07-10"), type: "auto_diary" };
    const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
    let membershipDeleted = false;
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (sql.trim().startsWith("SELECT thread, fact_key FROM memory_timeline_memberships")) {
              return { first: async () => ({ thread: "kld", fact_key: "project:kld.release" }) };
            }
            if (sql.includes("SELECT * FROM memories")) {
              expect(sql).toContain("type NOT IN");
              return { all: async () => ({ results: [] }) };
            }
            if (sql.startsWith("DELETE FROM memory_timeline_memberships")) {
              return { run: async () => {
                membershipDeleted = true;
                return { meta: { changes: 1 } };
              } };
            }
            return { sql, args };
          }
        };
      },
      async batch(statements: Array<{ sql: string; args: unknown[] }>) {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    } as unknown as D1Database;

    const result = await rebuildTimelineSequenceForMemory(db, excluded);

    expect(result.group).toBeNull();
    expect(result.previousGroup).toBe('["kld","project:kld.release"]');
    expect(membershipDeleted).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].args[1]).toBe('timeline_approved:["kld","project:kld.release"]');
  });
});
