import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  claimFiveAxisOutboxForDelivery,
  claimFiveAxisOutboxForExecution,
  completeFiveAxisOutboxExecution,
  failFiveAxisOutboxClaim,
  listDueFiveAxisOutbox,
  skipRejectedFiveAxisDelivery,
  type MemoryFiveAxisOutboxRecord
} from "../src/db/memoryFiveAxisOutbox";
import {
  claimFiveAxisRun,
  completeFiveAxisRun,
  getFiveAxisRun
} from "../src/db/memoryFiveAxisRuns";
import { createMemory, updateMemory } from "../src/db/memories";
import { deprojectMemoryFromFiveAxes } from "../src/memory/deprojection";
import { handleQueueMessage } from "../src/queue/consumer";
import type { Env, MemoryFiveAxisProjectionQueueMessage, MemoryRecord } from "../src/types";

async function outboxFor(memory: MemoryRecord): Promise<MemoryFiveAxisOutboxRecord> {
  const outbox = await env.DB.prepare(
    `SELECT * FROM memory_five_axis_outbox
     WHERE namespace = ? AND memory_id = ?
     ORDER BY id DESC LIMIT 1`
  ).bind(memory.namespace, memory.id).first<MemoryFiveAxisOutboxRecord>();
  if (!outbox) throw new Error("missing five-axis outbox");
  return outbox;
}

async function deproject(memory: MemoryRecord): Promise<void> {
  await deprojectMemoryFromFiveAxes({ DB: env.DB } as Env, {
    namespace: memory.namespace,
    memoryId: memory.id,
    patch: { status: "deleted" },
    expectedStatus: memory.status,
    expectedRevision: memory.five_axis_revision ?? 1,
    source: "system",
    reason: "late_delivery_test"
  });
}

function queueMessage(
  outbox: MemoryFiveAxisOutboxRecord,
  delivery: NonNullable<Awaited<ReturnType<typeof claimFiveAxisOutboxForDelivery>>>
): MemoryFiveAxisProjectionQueueMessage {
  return {
    type: "memory_five_axis_projection",
    namespace: outbox.namespace,
    memoryId: outbox.memory_id,
    memoryUpdatedAt: outbox.memory_updated_at,
    memoryRevision: outbox.memory_revision ?? 1,
    outboxId: outbox.id,
    outboxAttempt: delivery.attempt,
    outboxQueuedAt: delivery.queuedAt,
    idempotencyKey: `late-delivery:${outbox.id}`
  };
}

describe("five-axis late delivery guards", () => {
  it("skips the outbox without an incomplete-stage error when E supersedes its revision", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: `consumer supersession ${crypto.randomUUID()}`,
      status: "active"
    });
    const outbox = await outboxFor(memory);
    const delivery = await claimFiveAxisOutboxForDelivery(env.DB, outbox);
    if (!delivery) throw new Error("delivery claim failed");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            updates: [{
              id: memory.id,
              fact_key: null,
              thread: "consumer_supersession",
              risk_level: "normal",
              urgency_level: "normal",
              tension_score: 0,
              response_posture: "Keep the response clear.",
              valence: 0,
              arousal: 0
            }]
          })
        }
      }]
    }), { status: 200 }));
    const runtime = {
      DB: env.DB,
      ENABLE_FIVE_AXIS: "true",
      UPSTREAM_BASE_URL: "https://runtime.test/v1",
      UPSTREAM_API_KEY: "runtime-test-key",
      MEMORY_MODEL: "runtime-test-model",
      EMBEDDING_MODEL: "runtime-test-embedding",
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      VECTORIZE: {
        upsert: vi.fn(async () => undefined),
        deleteByIds: vi.fn(async () => undefined)
      }
    } as unknown as Env;

    try {
      await expect(handleQueueMessage(queueMessage(outbox, delivery), runtime)).resolves.toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }

    const oldOutbox = await env.DB.prepare(
      "SELECT status, last_error, result_json FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox.id).first<{ status: string; last_error: string | null; result_json: string | null }>();
    expect(oldOutbox).toMatchObject({ status: "skipped", last_error: null });
    expect(oldOutbox?.result_json).not.toContain("five_axis_stages_incomplete");
    await expect(env.DB.prepare(
      `SELECT status, claim_token, lease_expires_at
       FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = 'E'`
    ).bind(memory.namespace, memory.id, memory.five_axis_revision ?? 1).first()).resolves.toMatchObject({
      status: "skipped",
      claim_token: null,
      lease_expires_at: null
    });
    await expect(env.DB.prepare(
      `SELECT status FROM memory_five_axis_outbox
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ?`
    ).bind(memory.namespace, memory.id, (memory.five_axis_revision ?? 1) + 1).first())
      .resolves.toMatchObject({ status: "pending" });
  });

  it("rejects a queued delivery after the memory becomes ineligible", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: `late delivery ${crypto.randomUUID()}`,
      status: "active"
    });
    const outbox = await outboxFor(memory);
    const delivery = await claimFiveAxisOutboxForDelivery(env.DB, outbox);
    if (!delivery) throw new Error("delivery claim failed");
    const message = queueMessage(outbox, delivery);
    await deproject(memory);

    const upsert = vi.fn(async () => ({ mutationId: "unexpected-upsert" }));
    const runtime: Env = {
      DB: env.DB,
      ENABLE_FIVE_AXIS: "true",
      DREAM_NAMESPACE: "default",
      VECTORIZE: {
        upsert,
        deleteByIds: vi.fn(async () => ({ mutationId: "unexpected-delete" }))
      } as unknown as Env["VECTORIZE"]
    };
    await handleQueueMessage(message, runtime);

    expect(upsert).not.toHaveBeenCalled();
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND (source_memory_id = ? OR target_memory_id = ?)`
    ).bind(memory.namespace, memory.id, memory.id).first<{ count: number }>())
      .resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(memory.namespace, memory.id).first<{ count: number }>())
      .resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare(
      "SELECT status FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox.id).first<{ status: string }>())
      .resolves.toMatchObject({ status: "skipped" });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND status = 'applied'`
    ).bind(memory.namespace, memory.id).first<{ count: number }>())
      .resolves.toMatchObject({ count: 0 });
  });

  it("prevents stale outbox and axis-run finalization after deprojection wins", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: `claim then deactivate ${crypto.randomUUID()}`,
      status: "active"
    });
    const outbox = await outboxFor(memory);
    const delivery = await claimFiveAxisOutboxForDelivery(env.DB, outbox);
    if (!delivery) throw new Error("delivery claim failed");
    const execution = await claimFiveAxisOutboxForExecution(env.DB, delivery);
    if (execution.outcome !== "claimed") throw new Error(`execution rejected:${execution.reason}`);

    const runKey = {
      namespace: memory.namespace,
      memoryId: memory.id,
      memoryRevision: memory.five_axis_revision ?? 1,
      axis: "X" as const
    };
    const runClaim = await claimFiveAxisRun(env.DB, runKey);
    if (!runClaim) throw new Error("axis run claim failed");
    await deproject(memory);

    await expect(completeFiveAxisOutboxExecution(
      env.DB,
      execution.claim,
      "completed",
      { stale: true }
    )).resolves.toBe(false);
    await expect(completeFiveAxisRun(
      env.DB,
      runKey,
      runClaim,
      "applied",
      { stale: true }
    )).resolves.toBe("not_owned");
    await expect(getFiveAxisRun(env.DB, runKey)).resolves.toMatchObject({
      status: "skipped",
      claim_token: null,
      lease_expires_at: null
    });
    await expect(env.DB.prepare(
      "SELECT status, queued_at FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox.id).first<{ status: string; queued_at: string | null }>())
      .resolves.toMatchObject({ status: "skipped", queued_at: null });
    await expect(claimFiveAxisRun(env.DB, runKey)).resolves.toBeNull();
  });

  it("skips an old outbox when the revision advances before execution claim", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: `claim-before-revision ${crypto.randomUUID()}`,
      status: "active"
    });
    const outbox = await outboxFor(memory);
    const delivery = await claimFiveAxisOutboxForDelivery(env.DB, outbox);
    if (!delivery) throw new Error("delivery claim failed");
    const updated = await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { content: `new revision ${crypto.randomUUID()}` },
      expectedRevision: memory.five_axis_revision ?? 1
    });
    expect(updated?.five_axis_revision).toBe((memory.five_axis_revision ?? 1) + 1);

    await handleQueueMessage(queueMessage(outbox, delivery), {
      DB: env.DB,
      ENABLE_FIVE_AXIS: "true"
    } as Env);

    await expect(env.DB.prepare(
      "SELECT status, queued_at, result_json FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox.id).first()).resolves.toMatchObject({
      status: "skipped",
      queued_at: null,
      result_json: JSON.stringify({ reason: "stale_revision" })
    });
  });

  it("turns stale complete and fail writes into skipped terminal state", async () => {
    const completeMemory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: `stale complete ${crypto.randomUUID()}`,
      status: "active"
    });
    const completeOutbox = await outboxFor(completeMemory);
    const completeDelivery = await claimFiveAxisOutboxForDelivery(env.DB, completeOutbox);
    if (!completeDelivery) throw new Error("complete delivery claim failed");
    const completeExecution = await claimFiveAxisOutboxForExecution(env.DB, completeDelivery);
    if (completeExecution.outcome !== "claimed") throw new Error("complete execution claim failed");
    await updateMemory(env.DB, {
      namespace: completeMemory.namespace,
      id: completeMemory.id,
      patch: { content: `complete revision advanced ${crypto.randomUUID()}` },
      expectedRevision: completeMemory.five_axis_revision ?? 1
    });
    await expect(completeFiveAxisOutboxExecution(
      env.DB,
      completeExecution.claim,
      "completed",
      { stale: true }
    )).resolves.toBe(true);
    await expect(env.DB.prepare(
      "SELECT status FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(completeOutbox.id).first()).resolves.toMatchObject({ status: "skipped" });

    const failMemory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: `stale fail ${crypto.randomUUID()}`,
      status: "active"
    });
    const failOutbox = await outboxFor(failMemory);
    const failDelivery = await claimFiveAxisOutboxForDelivery(env.DB, failOutbox);
    if (!failDelivery) throw new Error("fail delivery claim failed");
    const failExecution = await claimFiveAxisOutboxForExecution(env.DB, failDelivery);
    if (failExecution.outcome !== "claimed") throw new Error("fail execution claim failed");
    await updateMemory(env.DB, {
      namespace: failMemory.namespace,
      id: failMemory.id,
      patch: { content: `fail revision advanced ${crypto.randomUUID()}` },
      expectedRevision: failMemory.five_axis_revision ?? 1
    });
    await expect(failFiveAxisOutboxClaim(
      env.DB,
      failExecution.claim,
      new Error("stale failure")
    )).resolves.toBe(true);
    await expect(env.DB.prepare(
      "SELECT status, last_error FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(failOutbox.id).first()).resolves.toMatchObject({
      status: "skipped",
      last_error: null
    });
  });

  it("does not return a skipped stale outbox to the due list after fifteen minutes", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: `skipped due list ${crypto.randomUUID()}`,
      status: "active"
    });
    const outbox = await outboxFor(memory);
    const delivery = await claimFiveAxisOutboxForDelivery(env.DB, outbox);
    if (!delivery) throw new Error("delivery claim failed");
    await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { content: `skipped revision advanced ${crypto.randomUUID()}` },
      expectedRevision: memory.five_axis_revision ?? 1
    });
    await expect(skipRejectedFiveAxisDelivery(env.DB, delivery, "stale_revision"))
      .resolves.toBe(true);
    await env.DB.prepare(
      `UPDATE memory_five_axis_outbox
       SET updated_at = ?
       WHERE id = ?`
    ).bind(new Date(Date.now() - 16 * 60_000).toISOString(), outbox.id).run();

    const due = await listDueFiveAxisOutbox(env.DB, 10);
    expect(due.map((item) => item.id)).not.toContain(outbox.id);
  });
});
