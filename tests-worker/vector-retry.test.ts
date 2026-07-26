import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemory, getMemoryById, updateMemory } from "../src/db/memories";
import {
  reconcileMemoryVector,
  retryPendingMemoryVectors
} from "../src/memory/state";
import type { Env, MemoryRecord } from "../src/types";

function vectorRuntime(input: {
  deleteByIds?: (ids: string[]) => Promise<unknown>;
  upsert?: (vectors: VectorizeVector[]) => Promise<unknown>;
}): Env {
  return {
    DB: env.DB,
    DREAM_NAMESPACE: "default",
    EMBEDDING_MODEL: "vector-retry-test",
    UPSTREAM_BASE_URL: "https://vector-retry.test/v1",
    UPSTREAM_API_KEY: "vector-retry-key",
    VECTORIZE: {
      deleteByIds: input.deleteByIds ?? (async () => ({ mutationId: "delete" })),
      upsert: input.upsert ?? (async () => ({ mutationId: "upsert" }))
    } as Env["VECTORIZE"]
  };
}

async function setVectorState(
  memory: MemoryRecord,
  status: "pending" | "failed",
  updatedAt = new Date().toISOString()
): Promise<void> {
  await env.DB.prepare(
    `UPDATE memories
     SET vector_sync_status = ?, vector_synced = 0, updated_at = ?
     WHERE namespace = ? AND id = ?`
  ).bind(status, updatedAt, memory.namespace, memory.id).run();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revision-safe vector reconciliation", () => {
  it("retries a failed delete for an ineligible memory without rolling back lifecycle state", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: `delete retry ${crypto.randomUUID()}`,
      status: "active"
    });
    let attempts = 0;
    const runtime = vectorRuntime({
      deleteByIds: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient delete failure");
        return { mutationId: "delete-recovered" };
      }
    });

    await expect(reconcileMemoryVector(runtime, {
      namespace: memory.namespace,
      memoryId: memory.id
    })).resolves.toMatchObject({
      outcome: "failed",
      action: "delete",
      errorCode: "vector_delete_failed"
    });
    await expect(getMemoryById(env.DB, {
      namespace: memory.namespace,
      id: memory.id
    })).resolves.toMatchObject({
      status: "active",
      type: "diary",
      vector_sync_status: "failed",
      vector_synced: 0
    });

    await expect(retryPendingMemoryVectors(runtime, memory.namespace, 10))
      .resolves.toEqual({
        selected: 1,
        synced: 0,
        deleted: 1,
        failed: 0,
        stale: 0,
        missing: 0
      });
    expect(attempts).toBe(2);
    await expect(getMemoryById(env.DB, {
      namespace: memory.namespace,
      id: memory.id
    })).resolves.toMatchObject({
      status: "active",
      type: "diary",
      vector_sync_status: "deleted",
      vector_synced: 0
    });
  });

  it("uses the same scanner to recover an eligible upsert", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: `upsert retry ${crypto.randomUUID()}`,
      status: "active"
    });
    await setVectorState(memory, "failed");
    const upsertedIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2, 0.3] }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runtime = vectorRuntime({
      upsert: async (vectors) => {
        upsertedIds.push(...vectors.map((vector) => vector.id));
        return { mutationId: "upsert-recovered" };
      }
    });

    await expect(retryPendingMemoryVectors(runtime, memory.namespace, 10))
      .resolves.toMatchObject({ selected: 1, synced: 1, deleted: 0, failed: 0 });
    expect(upsertedIds).toEqual([memory.vector_id]);
    await expect(getMemoryById(env.DB, {
      namespace: memory.namespace,
      id: memory.id
    })).resolves.toMatchObject({
      vector_sync_status: "synced",
      vector_synced: 1
    });
  });

  it("does not let a revision-eight delete result mark revision nine as deleted", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: `revision race ${crypto.randomUUID()}`,
      status: "active"
    });
    let releaseDelete: () => void = () => {
      throw new Error("vector delete did not start");
    };
    let deleteStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    const runtime = vectorRuntime({
      deleteByIds: async () => {
        deleteStarted?.();
        await new Promise<void>((resolve) => {
          releaseDelete = resolve;
        });
        return { mutationId: "stale-delete" };
      }
    });

    const reconciliation = reconcileMemoryVector(runtime, {
      namespace: memory.namespace,
      memoryId: memory.id
    });
    await started;
    const updated = await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { type: "note" },
      expectedRevision: memory.five_axis_revision ?? 1
    });
    expect(updated).toMatchObject({
      type: "note",
      five_axis_revision: (memory.five_axis_revision ?? 1) + 1,
      vector_sync_status: "pending",
      vector_synced: 0
    });
    await env.DB.prepare(
      `UPDATE memories
       SET vector_sync_status = 'synced', vector_synced = 1
       WHERE namespace = ? AND id = ?`
    ).bind(memory.namespace, memory.id).run();
    releaseDelete();

    await expect(reconciliation).resolves.toMatchObject({
      outcome: "stale",
      attemptedAction: "delete",
      latestMemory: {
        type: "note",
        five_axis_revision: (memory.five_axis_revision ?? 1) + 1,
        vector_sync_status: "pending",
        vector_synced: 0
      }
    });
  });

  it("processes only the requested bounded batch", async () => {
    const namespace = `vector-bounded-${crypto.randomUUID()}`;
    const memories: MemoryRecord[] = [];
    for (let index = 0; index < 5; index += 1) {
      const memory = await createMemory(env.DB, {
        namespace,
        type: "diary",
        content: `bounded delete ${index} ${crypto.randomUUID()}`,
        status: "active"
      });
      await setVectorState(memory, "pending", new Date(Date.now() + index * 1_000).toISOString());
      memories.push(memory);
    }
    const deletedIds: string[] = [];
    const runtime = vectorRuntime({
      deleteByIds: async (ids) => {
        deletedIds.push(...ids);
        return { mutationId: "bounded-delete" };
      }
    });

    await expect(retryPendingMemoryVectors(runtime, namespace, 2))
      .resolves.toMatchObject({ selected: 2, deleted: 2 });
    expect(deletedIds).toHaveLength(2);
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE id IN (${memories.map(() => "?").join(", ")})
         AND vector_sync_status = 'pending'`
    ).bind(...memories.map((memory) => memory.id)).first<{ count: number }>();
    expect(remaining?.count).toBe(3);
  });
});
