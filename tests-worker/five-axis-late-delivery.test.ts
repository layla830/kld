import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  claimFiveAxisOutboxForDelivery,
  claimFiveAxisOutboxForExecution,
  completeFiveAxisOutboxExecution,
  type MemoryFiveAxisOutboxRecord
} from "../src/db/memoryFiveAxisOutbox";
import {
  claimFiveAxisRun,
  completeFiveAxisRun,
  getFiveAxisRun
} from "../src/db/memoryFiveAxisRuns";
import { createMemory } from "../src/db/memories";
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
    )).resolves.toBe(false);
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
});
