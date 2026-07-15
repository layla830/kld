import { describe, expect, it } from "vitest";
import {
  approveRelationReviewCandidate,
  rollbackRelationReviewCandidate
} from "../src/api/adminBoard/relationReviewActions";
import type { MemoryCandidateRecord } from "../src/db/memoryCandidates";
import type { MemoryRelationRecord } from "../src/db/memoryRelations";
import { queueRelationReviewCandidate } from "../src/memory/relationReview";
import type { Env, MemoryRecord } from "../src/types";

function endpoint(id: string, updatedAt: string): MemoryRecord {
  return {
    id,
    namespace: "default",
    type: "note",
    content: id,
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
    importance: 0.5,
    confidence: 0.8,
    status: "active",
    pinned: 0,
    tags: "[]",
    source: "test",
    source_message_ids: "[]",
    vector_id: null,
    vector_synced: 0,
    vector_sync_status: null,
    last_recalled_at: null,
    recall_count: 0,
    five_axis_revision: 1,
    created_at: updatedAt,
    updated_at: updatedAt,
    expires_at: null
  };
}

function candidateFor(source: MemoryRecord, target: MemoryRecord): MemoryCandidateRecord {
  return {
    id: "cand_y",
    namespace: "default",
    external_key: [
      "y-review",
      "supports",
      source.id,
      target.id,
      source.updated_at,
      target.updated_at
    ].map(encodeURIComponent).join(":"),
    dream_date: "2026-07-15",
    action: "y_relation_review",
    subject: "system",
    target_id: target.id,
    payload_json: JSON.stringify({
      relation_type: "supports",
      source_id: source.id,
      target_id: target.id,
      source_updated_at: source.updated_at,
      target_updated_at: target.updated_at,
      strength: 0.8,
      reason: "A supports B"
    }),
    source_chunk_ids_json: "[]",
    source_chunks_json: "[]",
    status: "pending",
    validation_error: null,
    created_at: source.updated_at,
    updated_at: source.updated_at,
    resolved_at: null,
    result_memory_id: null
  };
}

function harness(options: { failApprovalUpdate?: boolean } = {}) {
  const source = endpoint("mem_a", "2026-07-15T00:00:01.000Z");
  const target = endpoint("mem_b", "2026-07-15T00:00:02.000Z");
  const candidate = candidateFor(source, target);
  const memories = new Map([[source.id, source], [target.id, target]]);
  const relations = new Map<string, MemoryRelationRecord>();
  const events: string[] = [];

  function statement(sql: string, args: unknown[]) {
    return {
      sql,
      args,
      first: async () => {
        if (sql.includes("FROM memory_candidates")) return candidate;
        if (sql.includes("FROM memories")) return memories.get(String(args[1])) ?? null;
        if (sql.includes("FROM memory_relations") && sql.includes("source_memory_id = ?")) {
          return [...relations.values()].find((relation) => relation.namespace === args[0]
            && relation.source_memory_id === args[1]
            && relation.target_memory_id === args[2]
            && relation.relation_type === args[3]) ?? null;
        }
        if (sql.includes("FROM memory_relations")) return relations.get(String(args[1])) ?? null;
        return null;
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO memory_candidates")) {
          if (!["pending", "needs_subject_review", "deferred_relation"].includes(candidate.status)) {
            return { meta: { changes: 0 } };
          }
          candidate.payload_json = String(args[7]);
          candidate.updated_at = String(args[13]);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO memory_relations")) {
          if (candidate.status !== "pending") return { meta: { changes: 0 } };
          const duplicate = [...relations.values()].some((relation) => relation.namespace === args[1]
            && relation.source_memory_id === args[2] && relation.target_memory_id === args[3]
            && relation.relation_type === args[4]);
          if (duplicate) throw new Error("UNIQUE constraint failed");
          const relation: MemoryRelationRecord = {
            id: String(args[0]),
            namespace: String(args[1]),
            source_memory_id: String(args[2]),
            target_memory_id: String(args[3]),
            relation_type: String(args[4]),
            strength: Number(args[5]),
            reason: args[6] === null ? null : String(args[6]),
            created_at: String(args[7])
          };
          relations.set(relation.id, relation);
          return { meta: { changes: 1 } };
        }
        if (sql.trim().startsWith("UPDATE memory_candidates")
          && sql.includes("status = 'approved', result_memory_id = ?")) {
          if (options.failApprovalUpdate) throw new Error("injected approval failure");
          if (candidate.status !== "pending") return { meta: { changes: 0 } };
          candidate.payload_json = String(args[0]);
          candidate.status = "approved";
          candidate.result_memory_id = String(args[1]);
          candidate.resolved_at = String(args[2]);
          candidate.updated_at = String(args[3]);
          return { meta: { changes: 1 } };
        }
        if (sql.trim().startsWith("UPDATE memory_candidates") && sql.includes("status = 'rolled_back'")) {
          if (candidate.status !== "approved") return { meta: { changes: 0 } };
          candidate.payload_json = String(args[0]);
          candidate.status = "rolled_back";
          candidate.resolved_at = String(args[1]);
          candidate.updated_at = String(args[2]);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM memory_relations")) {
          return { meta: { changes: relations.delete(String(args[1])) ? 1 : 0 } };
        }
        if (sql.includes("INSERT INTO memory_events")) {
          if (sql.includes("y_relation_approved") && candidate.status === "approved") events.push("y_relation_approved");
          if (sql.includes("y_relation_rollback") && candidate.status === "rolled_back") events.push("y_relation_rollback");
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
    };
  }

  const db = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => statement(sql, args) };
    },
    async batch(statements: Array<ReturnType<typeof statement>>) {
      const candidateBefore = { ...candidate };
      const relationsBefore = new Map(relations);
      const eventsBefore = [...events];
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        return results;
      } catch (error) {
        Object.assign(candidate, candidateBefore);
        relations.clear();
        for (const [id, relation] of relationsBefore) relations.set(id, relation);
        events.splice(0, events.length, ...eventsBefore);
        throw error;
      }
    }
  } as unknown as D1Database;
  return { env: { DB: db } as Env, source, target, candidate, relations, events };
}

describe("Y relation review actions", () => {
  it("atomically approves, preserves approval metadata on re-projection, and rolls back its edge", async () => {
    const state = harness();
    const form = new FormData();
    form.set("id", state.candidate.id);

    const approved = await approveRelationReviewCandidate(state.env, form);
    expect(approved).toMatchObject({ axis: "Y", action: "approve", changed: true });
    expect(state.candidate.status).toBe("approved");
    expect(state.relations.size).toBe(1);
    const approvedPayload = state.candidate.payload_json;

    await queueRelationReviewCandidate(state.env, "default", {
      relationType: "supports",
      source: state.source,
      target: state.target,
      strength: 0.9,
      reason: "duplicate projection"
    });
    expect(state.candidate.payload_json).toBe(approvedPayload);

    const rolledBack = await rollbackRelationReviewCandidate(state.env, form);
    expect(rolledBack).toMatchObject({ axis: "Y", action: "rollback", changed: true });
    expect(state.candidate.status).toBe("rolled_back");
    expect(state.relations.size).toBe(0);
    expect(state.events).toEqual(["y_relation_approved", "y_relation_rollback"]);
  });

  it("rolls back relation insertion when the candidate update fails inside the D1 batch", async () => {
    const state = harness({ failApprovalUpdate: true });
    const form = new FormData();
    form.set("id", state.candidate.id);

    await expect(approveRelationReviewCandidate(state.env, form)).rejects.toThrow("injected approval failure");
    expect(state.candidate.status).toBe("pending");
    expect(state.relations.size).toBe(0);
    expect(state.events).toEqual([]);
  });
});
