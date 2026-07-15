import { describe, expect, it } from "vitest";
import {
  projectMemoryIntoFiveAxes,
  type MemoryFiveAxisProjectionDependencies
} from "../src/memory/fiveAxis/projection";
import type { Env, MemoryRecord } from "../src/types";
import type { FiveAxisName, FiveAxisRunKey, MemoryFiveAxisRunRecord } from "../src/db/memoryFiveAxisRuns";

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
  it("runs E before X so the timeline sees labeled coordinates, then projects Y, Z and M", async () => {
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
      "E",
      "read:2",
      "E:vector",
      "read:3",
      "X",
      "Y:default:mem_new:false",
      "Z:default:project:kld.release",
      "M:default:mem_new"
    ]);
    expect(result?.x?.queued).toBe(1);
    expect(result?.z?.candidates).toBe(1);
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

  it("records a failed Y axis while allowing Z and M to finish", async () => {
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

    const result = await projectMemoryIntoFiveAxes({} as Env, {
      namespace: "default",
      memoryId: initial.id,
      projectionKey: "five-axis:3:v1"
    }, dependencies);

    expect(result?.failedAxes).toEqual(["Y"]);
    expect(result?.axes.Y).toMatchObject({
      status: "failed",
      error: "y_relation_projection_failed:invalid_json"
    });
    expect(result?.axes.Z.status).toBe("skipped");
    expect(result?.axes.M.status).toBe("skipped");
  });

  it("does not persist X while E is failed, then runs X after E succeeds on retry", async () => {
    const initial = memory({ thread: null });
    const labeled = memory({ thread: "kld", risk_level: "normal", valence: 0.2 });
    const records = new Map<FiveAxisName, MemoryFiveAxisRunRecord>();
    let eAttempts = 0;
    const timelineThreads: Array<string | null> = [];
    const recordFor = (
      key: FiveAxisRunKey,
      patch: Partial<MemoryFiveAxisRunRecord>
    ): MemoryFiveAxisRunRecord => ({
      namespace: key.namespace,
      memory_id: key.memoryId,
      memory_revision: key.memoryRevision,
      axis: key.axis,
      status: "running",
      attempts: records.get(key.axis)?.attempts ?? 1,
      result_json: null,
      last_error: null,
      claim_token: null,
      lease_expires_at: null,
      started_at: "2026-07-15T00:00:00.000Z",
      completed_at: null,
      updated_at: "2026-07-15T00:00:00.000Z",
      ...patch
    });
    const dependencies: MemoryFiveAxisProjectionDependencies = {
      getMemory: async () => eAttempts >= 2 ? labeled : initial,
      projectTimeline: async (_env, current) => {
        timelineThreads.push(current.thread);
        return { scanned: 1, outcome: "queued", dates: ["2026-07-20"], queued: 1 };
      },
      projectCoordinates: async () => {
        eAttempts += 1;
        if (eAttempts === 1) throw new Error("coordinate provider unavailable");
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
      syncVector: async () => "synced",
      projectRelations: async () => ({ scanned: 1, inserted: 0, review: 0, proposed: 0, candidates: 0 }),
      projectFacts: async () => ({ conflicts: 0, candidates: 0 }),
      projectMetabolism: async () => ({ archive: 0, relations: 0 }),
      axisRuns: {
        get: async (_env, key) => records.get(key.axis) ?? null,
        claim: async (_env, key) => {
          const token = `claim-${key.axis}-${(records.get(key.axis)?.attempts ?? 0) + 1}`;
          records.set(key.axis, recordFor(key, {
            status: "running",
            attempts: (records.get(key.axis)?.attempts ?? 0) + 1,
            claim_token: token
          }));
          return token;
        },
        complete: async (_env, key, _claimToken, status, value) => {
          records.set(key.axis, recordFor(key, {
            status,
            result_json: JSON.stringify(value),
            completed_at: "2026-07-15T00:00:01.000Z"
          }));
          return true;
        },
        fail: async (_env, key, _claimToken, error) => {
          records.set(key.axis, recordFor(key, {
            status: "failed",
            last_error: error instanceof Error ? error.message : String(error),
            completed_at: "2026-07-15T00:00:01.000Z"
          }));
          return true;
        }
      }
    };
    const input = {
      namespace: "default",
      memoryId: initial.id,
      memoryRevision: 8,
      projectionKey: "five-axis:e-retry:v8"
    };

    const first = await projectMemoryIntoFiveAxes({} as Env, input, dependencies);
    expect(first?.failedAxes).toEqual(["E"]);
    expect(first?.deferredAxes).toEqual(["X"]);
    expect(records.has("X")).toBe(false);
    const second = await projectMemoryIntoFiveAxes({} as Env, input, dependencies);

    expect(second?.failedAxes).toEqual([]);
    expect(second?.deferredAxes).toEqual([]);
    expect(timelineThreads).toEqual(["kld"]);
    expect(records.get("E")?.attempts).toBe(2);
  });

  it("reuses completed axes and retries only the failed axis for the same revision", async () => {
    const initial = memory({ fact_key: null, thread: "kld", valence: 0.2 });
    const records = new Map<FiveAxisName, MemoryFiveAxisRunRecord>();
    const calls = { X: 0, Y: 0, Z: 0, E: 0, M: 0 };
    let yAttempt = 0;
    const keyRecord = (key: FiveAxisRunKey, patch: Partial<MemoryFiveAxisRunRecord>): MemoryFiveAxisRunRecord => ({
      namespace: key.namespace,
      memory_id: key.memoryId,
      memory_revision: key.memoryRevision,
      axis: key.axis,
      status: "running",
      attempts: records.get(key.axis)?.attempts ?? 1,
      result_json: null,
      last_error: null,
      claim_token: null,
      lease_expires_at: null,
      started_at: "2026-07-15T00:00:00.000Z",
      completed_at: null,
      updated_at: "2026-07-15T00:00:00.000Z",
      ...patch
    });
    const dependencies: MemoryFiveAxisProjectionDependencies = {
      getMemory: async () => initial,
      projectTimeline: async () => {
        calls.X += 1;
        return { scanned: 1, outcome: "already_dated", dates: [], queued: 0 };
      },
      projectCoordinates: async () => {
        calls.E += 1;
        return { skipped: "coordinates_present" };
      },
      syncVector: async () => "synced",
      projectRelations: async () => {
        calls.Y += 1;
        yAttempt += 1;
        return yAttempt === 1
          ? { scanned: 1, inserted: 0, review: 0, proposed: 0, candidates: 1, error: "invalid_json" }
          : { scanned: 1, inserted: 1, review: 0, proposed: 0, candidates: 1 };
      },
      projectFacts: async () => {
        calls.Z += 1;
        return { conflicts: 0, candidates: 0 };
      },
      projectMetabolism: async () => {
        calls.M += 1;
        return { archive: 0, relations: 0 };
      },
      axisRuns: {
        get: async (_env, key) => records.get(key.axis) ?? null,
        claim: async (_env, key) => {
          const token = `claim-${key.axis}`;
          records.set(key.axis, keyRecord(key, {
            status: "running",
            claim_token: token,
            attempts: (records.get(key.axis)?.attempts ?? 0) + 1
          }));
          return token;
        },
        complete: async (_env, key, _claimToken, status, value) => {
          records.set(key.axis, keyRecord(key, {
            status,
            result_json: JSON.stringify(value),
            completed_at: "2026-07-15T00:00:01.000Z"
          }));
          return true;
        },
        fail: async (_env, key, _claimToken, error) => {
          records.set(key.axis, keyRecord(key, {
            status: "failed",
            last_error: error instanceof Error ? error.message : String(error),
            completed_at: "2026-07-15T00:00:01.000Z"
          }));
          return true;
        }
      }
    };
    const input = {
      namespace: "default",
      memoryId: initial.id,
      memoryRevision: 7,
      projectionKey: "five-axis:retry:v7"
    };

    const first = await projectMemoryIntoFiveAxes({} as Env, input, dependencies);
    const second = await projectMemoryIntoFiveAxes({} as Env, input, dependencies);

    expect(first?.failedAxes).toEqual(["Y"]);
    expect(second?.failedAxes).toEqual([]);
    expect(second?.axes.Y).toMatchObject({ status: "applied", reused: false });
    expect(second?.axes.X.reused).toBe(true);
    expect(second?.axes.Z.reused).toBe(true);
    expect(second?.axes.E.reused).toBe(true);
    expect(second?.axes.M.reused).toBe(true);
    expect(calls).toEqual({ X: 1, Y: 2, Z: 0, E: 1, M: 1 });
    expect(records.get("Y")?.attempts).toBe(2);
  });
});
