import { describe, expect, it } from "vitest";
import { selectActiveD1RelationNeighbors } from "../src/memory/fiveAxis/yRelations";
import { queueRelationReviewCandidate } from "../src/memory/relationReview";
import type { Env, MemoryRecord } from "../src/types";

describe("Y relation candidate boundary", () => {
  it("keeps only active memories that still exist in D1", () => {
    const active = { id: "mem_active", status: "active" } as MemoryRecord;
    const inactive = { id: "mem_inactive", status: "superseded" } as MemoryRecord;
    const selected = selectActiveD1RelationNeighbors([
      { id: active.id, score: 0.8 },
      { id: inactive.id, score: 0.9 },
      { id: "mem_missing", score: 0.95 }
    ], [active, inactive]);

    expect(selected).toEqual([{ memory: active, vectorScore: 0.8 }]);
  });

  it("queues risky relations with endpoint revisions instead of writing dead review events", async () => {
    let bound: unknown[] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            bound = args;
            return { run: async () => ({ meta: { changes: 1 } }) };
          }
        };
      }
    } as unknown as D1Database;
    const source = {
      id: "mem_z",
      namespace: "default",
      status: "active",
      updated_at: "2026-07-15T00:00:02.000Z"
    } as MemoryRecord;
    const target = {
      id: "mem_a",
      namespace: "default",
      status: "active",
      updated_at: "2026-07-15T00:00:01.000Z"
    } as MemoryRecord;

    await queueRelationReviewCandidate({ DB: db } as Env, "default", {
      relationType: "contradicts",
      source,
      target,
      strength: 0.9,
      reason: "互相冲突",
      projectionKey: "five-axis:9:v2"
    });

    expect(bound[2]).toContain("y-review:contradicts:mem_a:mem_z");
    expect(bound[2]).toContain(encodeURIComponent(target.updated_at));
    expect(bound[4]).toBe("y_relation_review");
    const payload = JSON.parse(String(bound[7]));
    expect(payload).toMatchObject({
      relation_type: "contradicts",
      source_id: "mem_a",
      target_id: "mem_z",
      source_updated_at: target.updated_at,
      target_updated_at: source.updated_at,
      projection_key: "five-axis:9:v2"
    });
  });
});
