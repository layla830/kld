import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  approveFactTransitionCandidate,
  rollbackFactTransitionCandidate
} from "../src/api/adminBoard/factTransitionActions";
import {
  approveMetabolismCandidate,
  rollbackMetabolismCandidate
} from "../src/api/adminBoard/metabolismActions";
import { createMemory } from "../src/db/memories";
import { projectMemoryIntoFiveAxes } from "../src/memory/fiveAxis/projection";
import type { Env, MemoryRecord } from "../src/types";

interface CandidateRow {
  id: string;
  status: string;
  action: string;
}

function formFor(id: string): FormData {
  const form = new FormData();
  form.set("id", id);
  return form;
}

async function first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...binds).first<T>();
}

const coordinates = {
  thread: "runtime-axis",
  riskLevel: "low",
  urgencyLevel: "normal",
  tensionScore: 0.2,
  responsePosture: "supportive",
  valence: 0.2,
  arousal: 0.3
};

describe("Z-axis Worker circuit", () => {
  it("creates a conflict candidate, supersedes with vector deletion, and rolls back with vector upsert", async () => {
    const best = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "current runtime fact",
      factKey: "runtime:z:fact",
      importance: 0.95,
      confidence: 0.95,
      ...coordinates
    });
    const weaker = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "older runtime fact",
      factKey: "runtime:z:fact",
      importance: 0.4,
      confidence: 0.7,
      ...coordinates
    });
    const deletedIds: string[] = [];
    const upsertedIds: string[] = [];
    const vectorize = {
      deleteByIds: async (ids: string[]) => {
        deletedIds.push(...ids);
        return { mutationId: "delete-runtime-z" };
      },
      upsert: async (vectors: VectorizeVector[]) => {
        upsertedIds.push(...vectors.map((vector) => vector.id));
        return { mutationId: "upsert-runtime-z" };
      }
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2, 0.3] }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runtimeEnv: Env = {
      DB: env.DB,
      DREAM_NAMESPACE: "default",
      EMBEDDING_MODEL: "runtime-test-embedding",
      UPSTREAM_BASE_URL: "https://runtime.test/v1",
      UPSTREAM_API_KEY: "runtime-test-key",
      VECTORIZE: vectorize as Env["VECTORIZE"]
    };

    await expect(projectMemoryIntoFiveAxes(runtimeEnv, {
      namespace: "default",
      memoryId: weaker.id,
      memoryRevision: 1,
      projectionKey: "runtime-z"
    }, {
      projectRelations: async () => ({
        scanned: 1,
        inserted: 0,
        review: 0,
        proposed: 0,
        candidates: 0,
        candidateExternalKeys: []
      })
    })).resolves.toMatchObject({
      axes: { Z: { status: "pending_review" } },
      z: { conflicts: 1, candidates: 1 }
    });
    const candidate = await first<CandidateRow>(
      `SELECT id, status, action FROM memory_candidates
       WHERE namespace = 'default' AND action = 'z_supersede' AND target_id = ?`,
      weaker.id
    );
    expect(candidate).toMatchObject({ status: "pending", action: "z_supersede" });

    await expect(approveFactTransitionCandidate(runtimeEnv, formFor(candidate!.id)))
      .resolves.toMatchObject({ axis: "Z", action: "supersede" });
    await expect(first<Pick<MemoryRecord, "status" | "active_fact" | "vector_sync_status">>(
      "SELECT status, active_fact, vector_sync_status FROM memories WHERE namespace = 'default' AND id = ?",
      weaker.id
    )).resolves.toMatchObject({ status: "superseded", active_fact: 0, vector_sync_status: "deleted" });
    expect(deletedIds).toContain(weaker.vector_id);
    await expect(first<CandidateRow>(
      "SELECT id, status, action FROM memory_candidates WHERE id = ?",
      candidate!.id
    )).resolves.toMatchObject({ status: "approved" });
    await expect(first<{ status: string }>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'Z'`,
      weaker.id
    )).resolves.toMatchObject({ status: "applied" });

    await expect(rollbackFactTransitionCandidate(runtimeEnv, formFor(candidate!.id)))
      .resolves.toMatchObject({ axis: "Z", action: "rollback" });
    await expect(first<Pick<MemoryRecord, "status" | "active_fact" | "vector_sync_status">>(
      "SELECT status, active_fact, vector_sync_status FROM memories WHERE namespace = 'default' AND id = ?",
      weaker.id
    )).resolves.toMatchObject({ status: "active", active_fact: 1, vector_sync_status: "synced" });
    expect(upsertedIds).toContain(weaker.vector_id);
    await expect(first<CandidateRow>(
      "SELECT id, status, action FROM memory_candidates WHERE id = ?",
      candidate!.id
    )).resolves.toMatchObject({ status: "rolled_back" });
    await expect(first<{ status: string }>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'Z'`,
      weaker.id
    )).resolves.toMatchObject({ status: "skipped" });
    await expect(first<MemoryRecord>(
      "SELECT * FROM memories WHERE namespace = 'default' AND id = ?",
      best.id
    )).resolves.toMatchObject({ status: "active", active_fact: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe("M-axis Worker circuit", () => {
  it("archives and restores expired memory with a snapshot", async () => {
    const expired = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "expired runtime project state",
      importance: 0.3,
      confidence: 0.5,
      expiresAt: "2020-01-01T00:00:00.000Z",
      ...coordinates
    });
    await expect(projectMemoryIntoFiveAxes(env, {
      namespace: "default",
      memoryId: expired.id,
      memoryRevision: 1,
      projectionKey: "runtime-m-archive"
    })).resolves.toMatchObject({
      axes: { M: { status: "pending_review" } },
      m: { archive: 1, relations: 0 }
    });
    const candidate = await first<CandidateRow>(
      `SELECT id, status, action FROM memory_candidates
       WHERE namespace = 'default' AND action = 'm_archive' AND target_id = ?`,
      expired.id
    );
    expect(candidate).toMatchObject({ status: "pending", action: "m_archive" });

    await expect(approveMetabolismCandidate(env, formFor(candidate!.id)))
      .resolves.toMatchObject({ action: "m_archive", memory: { id: expired.id, status: "archived" } });
    await expect(first<{ status: string }>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'M'`,
      expired.id
    )).resolves.toMatchObject({ status: "applied" });
    await expect(first<{ event_type: string }>(
      `SELECT event_type FROM memory_events
       WHERE namespace = 'default' AND event_type = 'm_snapshot'
         AND json_extract(payload_json, '$.candidate_id') = ?`,
      candidate!.id
    )).resolves.toMatchObject({ event_type: "m_snapshot" });

    await expect(rollbackMetabolismCandidate(env, formFor(candidate!.id)))
      .resolves.toMatchObject({ action: "rollback", memory: { id: expired.id, status: "active" } });
    await expect(first<CandidateRow>(
      "SELECT id, status, action FROM memory_candidates WHERE id = ?",
      candidate!.id
    )).resolves.toMatchObject({ status: "rolled_back" });
    await expect(first<{ status: string }>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'M'`,
      expired.id
    )).resolves.toMatchObject({ status: "skipped" });
  });

  it("removes and restores a reviewed relation cleanup candidate", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "runtime relation cleanup",
      ...coordinates
    });
    const relationId = "rel_runtime_m_self_loop";
    await env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at
       ) VALUES (?, 'default', ?, ?, 'same_topic', 0.8, 'runtime self-loop', ?)`
    ).bind(relationId, memory.id, memory.id, new Date().toISOString()).run();

    await expect(projectMemoryIntoFiveAxes(env, {
      namespace: "default",
      memoryId: memory.id,
      memoryRevision: 1,
      projectionKey: "runtime-m-relation"
    })).resolves.toMatchObject({
      axes: { M: { status: "pending_review" } },
      m: { archive: 0, relations: 1 }
    });
    const candidate = await first<CandidateRow>(
      `SELECT id, status, action FROM memory_candidates
       WHERE namespace = 'default' AND action = 'm_relation_cleanup'`
    );
    expect(candidate).toMatchObject({ status: "pending", action: "m_relation_cleanup" });

    await expect(approveMetabolismCandidate(env, formFor(candidate!.id)))
      .resolves.toMatchObject({ action: "m_relation_cleanup", memory: null });
    await expect(first<{ status: string }>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'M'`,
      memory.id
    )).resolves.toMatchObject({ status: "applied" });
    await expect(first("SELECT id FROM memory_relations WHERE namespace = 'default' AND id = ?", relationId))
      .resolves.toBeNull();

    await expect(rollbackMetabolismCandidate(env, formFor(candidate!.id)))
      .resolves.toMatchObject({ action: "rollback", memory: null });
    await expect(first<{ id: string }>(
      "SELECT id FROM memory_relations WHERE namespace = 'default' AND id = ?",
      relationId
    )).resolves.toMatchObject({ id: relationId });
    await expect(first<{ status: string }>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'M'`,
      memory.id
    )).resolves.toMatchObject({ status: "skipped" });
  });
});
