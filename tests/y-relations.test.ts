import { afterEach, describe, expect, it, vi } from "vitest";
import { proposeRelationsViaLlm, selectActiveD1RelationNeighbors } from "../src/memory/fiveAxis/yRelations";
import { queueRelationReviewCandidate } from "../src/memory/relationReview";
import type { Env, MemoryRecord } from "../src/types";

describe("Y relation candidate boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("retries invalid JSON and accepts array-form assistant content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "not-json" } }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: [{ type: "text", text: '{"hints":[{"pair_id":"p0","relation_type":"same_topic","strength":0.8}]}' }] } }]
      }), { status: 200 }));
    const source = { id: "mem_a", content: "alpha" } as MemoryRecord;
    const target = { id: "mem_b", content: "beta" } as MemoryRecord;

    const result = await proposeRelationsViaLlm({
      DREAM_MODEL: "test-model",
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "test-key"
    } as Env, [{ pairId: "p0", source, target, vectorScore: 0.9 }]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      hints: [{ pair_id: "p0", relation_type: "same_topic", strength: 0.8, reason: undefined }]
    });
    const retryRequest = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(retryRequest.messages[1].content).toContain("previous response was invalid");
  });

  it("returns a bounded error after two invalid JSON responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "still-not-json" } }]
    }), { status: 200 }));
    const source = { id: "mem_a", content: "alpha" } as MemoryRecord;
    const target = { id: "mem_b", content: "beta" } as MemoryRecord;

    const result = await proposeRelationsViaLlm({
      DREAM_MODEL: "test-model",
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "test-key"
    } as Env, [{ pairId: "p0", source, target, vectorScore: 0.9 }]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ hints: [], error: "invalid_json" });
  });
});
