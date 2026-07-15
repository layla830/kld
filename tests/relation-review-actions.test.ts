import { describe, expect, it } from "vitest";
import {
  approveRelationReviewCandidate,
  rollbackRelationReviewCandidate
} from "../src/api/adminBoard/relationReviewActions";
import type { MemoryCandidateRecord } from "../src/db/memoryCandidates";
import type { MemoryRelationRecord } from "../src/db/memoryRelations";
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

describe("Y relation review actions", () => {
  it("approves a version-checked edge and rolls back only the edge created by that approval", async () => {
    const source = endpoint("mem_a", "2026-07-15T00:00:01.000Z");
    const target = endpoint("mem_b", "2026-07-15T00:00:02.000Z");
    const candidate: MemoryCandidateRecord = {
      id: "cand_y",
      namespace: "default",
      external_key: "y-review",
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
        reason: "A 支持 B"
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
    const memories = new Map([[source.id, source], [target.id, target]]);
    const relations = new Map<string, MemoryRelationRecord>();
    const events: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first: async () => {
                if (sql.includes("FROM memory_candidates")) return candidate;
                if (sql.includes("FROM memories")) return memories.get(String(args[1])) ?? null;
                if (sql.includes("FROM memory_relations") && sql.includes("source_memory_id = ?")) {
                  return [...relations.values()].find((relation) => relation.namespace === args[0]
                    && relation.source_memory_id === args[1] && relation.target_memory_id === args[2]
                    && relation.relation_type === args[3]) ?? null;
                }
                if (sql.includes("FROM memory_relations")) return relations.get(String(args[1])) ?? null;
                return null;
              },
              run: async () => {
                if (sql.includes("INSERT OR IGNORE INTO memory_relations")) {
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
                if (sql.includes("SET payload_json = ?")) {
                  if (candidate.status !== "pending") return { meta: { changes: 0 } };
                  candidate.payload_json = String(args[0]);
                  candidate.updated_at = String(args[1]);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET status = ?, result_memory_id")) {
                  if (candidate.status !== "pending") return { meta: { changes: 0 } };
                  candidate.status = String(args[0]);
                  candidate.result_memory_id = args[1] === null ? null : String(args[1]);
                  candidate.resolved_at = String(args[2]);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("DELETE FROM memory_relations")) {
                  return { meta: { changes: relations.delete(String(args[1])) ? 1 : 0 } };
                }
                if (sql.includes("SET status = 'rolled_back'")) {
                  if (candidate.status !== "approved") return { meta: { changes: 0 } };
                  candidate.status = "rolled_back";
                  candidate.resolved_at = String(args[0]);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("INSERT INTO memory_events")) {
                  events.push(String(args[2]));
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
            };
          }
        };
      }
    } as unknown as D1Database;
    const env = { DB: db } as Env;
    const form = new FormData();
    form.set("id", candidate.id);

    const approved = await approveRelationReviewCandidate(env, form);
    expect(approved).toMatchObject({ axis: "Y", action: "approve", changed: true });
    expect(candidate.status).toBe("approved");
    expect(relations.size).toBe(1);
    expect(JSON.parse(candidate.payload_json).approval).toEqual({
      relation_id: approved?.relationId,
      inserted: true
    });

    const rolledBack = await rollbackRelationReviewCandidate(env, form);
    expect(rolledBack).toMatchObject({ axis: "Y", action: "rollback", changed: true });
    expect(candidate.status).toBe("rolled_back");
    expect(relations.size).toBe(0);
    expect(events).toEqual(["y_relation_approved", "y_relation_rollback"]);
  });
});
