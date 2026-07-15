import { describe, expect, it } from "vitest";
import {
  projectMemoryIntoFiveAxes,
  type MemoryFiveAxisProjectionDependencies
} from "../src/memory/fiveAxis/projection";
import type { Env, MemoryRecord } from "../src/types";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_new",
    namespace: "default",
    type: "project_state",
    content: "KLD will ship on 2026-07-20.",
    summary: null,
    fact_key: "project:kld.release",
    active_fact: 1,
    thread: null,
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: 0.8,
    confidence: 0.9,
    status: "active",
    pinned: 0,
    tags: "[]",
    source: "test",
    source_message_ids: "[]",
    vector_id: "vec_mem_new",
    vector_synced: 1,
    vector_sync_status: "synced",
    last_recalled_at: null,
    recall_count: 0,
    five_axis_revision: 1,
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
    expires_at: null,
    ...overrides
  };
}

describe("per-memory five-axis projection", () => {
  it("runs X and E before review-safe Y, Z and M, then resyncs E metadata", async () => {
    const calls: string[] = [];
    const initial = memory();
    const labeled = memory({ thread: "kld", risk_level: "normal", valence: 0.2 });
    let reads = 0;
    const dependencies: MemoryFiveAxisProjectionDependencies = {
      getMemory: async () => {
        reads += 1;
        calls.push(`read:${reads}`);
        return reads === 1 ? initial : labeled;
      },
      projectTimeline: async () => {
        calls.push("X");
        return { scanned: 1, outcome: "queued", dates: ["2026-07-20"], queued: 1 };
      },
      projectCoordinates: async () => {
        calls.push("E");
        return {
          ok: true,
          mode: "auto_apply_with_exception_review",
          scanned: 1,
          needBackfill: 1,
          offset: 0,
          nextOffset: null,
          processed: 1,
          applied: 1,
          queued: 0
        };
      },
      syncVector: async () => {
        calls.push("E:vector");
        return "synced";
      },
      projectRelations: async (_env, namespace, options) => {
        calls.push(`Y:${namespace}:${options?.memoryIds?.join(",")}:${options?.dryRun}`);
        return { scanned: 1, inserted: 1, review: 0, proposed: 0, candidates: 2 };
      },
      projectFacts: async (_env, namespace, options) => {
        calls.push(`Z:${namespace}:${options?.factKeys?.join(",")}`);
        return { conflicts: 1, candidates: 1 };
      },
      projectMetabolism: async (_env, namespace, options) => {
        calls.push(`M:${namespace}:${options?.memoryIds?.join(",")}`);
        return { archive: 0, relations: 0 };
      }
    };

    const result = await projectMemoryIntoFiveAxes({} as Env, {
      namespace: "default",
      memoryId: "mem_new",
      projectionKey: "five-axis:1:v1"
    }, dependencies);

    expect(calls).toEqual([
      "read:1",
      "X",
      "E",
      "read:2",
      "E:vector",
      "read:3",
      "Y:default:mem_new:false",
      "Z:default:project:kld.release",
      "M:default:mem_new"
    ]);
    expect(result?.x.queued).toBe(1);
    expect(result?.z.candidates).toBe(1);
  });

  it("does not project inactive memories", async () => {
    const unreachable = async (): Promise<never> => { throw new Error("unreachable"); };
    const dependencies: MemoryFiveAxisProjectionDependencies = {
      getMemory: async () => memory({ status: "review" }),
      projectTimeline: unreachable,
      projectCoordinates: unreachable,
      syncVector: unreachable,
      projectRelations: unreachable,
      projectFacts: unreachable,
      projectMetabolism: unreachable
    };
    await expect(projectMemoryIntoFiveAxes({} as Env, {
      namespace: "default",
      memoryId: "mem_new",
      projectionKey: "five-axis:2:v1"
    }, dependencies)).resolves.toBeNull();
  });

  it("fails the projection when Y cannot produce a valid result", async () => {
    const initial = memory({ fact_key: null, thread: "kld", valence: 0.2 });
    const dependencies: MemoryFiveAxisProjectionDependencies = {
      getMemory: async () => initial,
      projectTimeline: async () => ({ scanned: 1, outcome: "already_dated", dates: [], queued: 0 }),
      projectCoordinates: async () => ({ skipped: "coordinates_present" }),
      syncVector: async () => "synced",
      projectRelations: async () => ({
        scanned: 1,
        inserted: 0,
        review: 0,
        proposed: 0,
        candidates: 2,
        error: "invalid_json"
      }),
      projectFacts: async () => ({ conflicts: 0, candidates: 0 }),
      projectMetabolism: async () => ({ archive: 0, relations: 0 })
    };

    await expect(projectMemoryIntoFiveAxes({} as Env, {
      namespace: "default",
      memoryId: initial.id,
      projectionKey: "five-axis:3:v1"
    }, dependencies)).rejects.toThrow("y_relation_projection_failed:invalid_json");
  });
});
