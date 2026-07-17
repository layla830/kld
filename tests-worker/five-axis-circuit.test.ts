import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { approveTimelineCandidate } from "../src/api/adminBoard/timelineActions";
import { enqueuePendingFiveAxisProjections } from "../src/queue/producer";
import type { MemoryFiveAxisProjectionQueueMessage } from "../src/types";

interface OutboxRow {
  id: number;
  namespace: string;
  memory_id: string;
  memory_updated_at: string;
  memory_revision: number;
  status: string;
}

interface CandidateRow {
  id: string;
  external_key: string;
  status: string;
}

interface AxisRunRow {
  status: string;
}

async function first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...binds).first<T>();
}

describe("five-axis Worker circuit", () => {
  it("closes ingest through X review and re-enters the outbox at the next revision", async () => {
    const memoryId = "runtime-circuit-memory";
    const createdAt = "2026-07-17T06:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO memories (
         id, namespace, type, content, importance, confidence, status, pinned,
         tags, source, created_at, updated_at, fact_key, active_fact,
         thread, risk_level, urgency_level, tension_score, response_posture,
         valence, arousal
       ) VALUES (?, 'default', 'project_state', ?, 0.9, 0.95, 'active', 0,
         '[]', 'worker-circuit-test', ?, ?, 'project:runtime-circuit', 1,
         'runtime-circuit', 'low', 'normal', 0.2, 'supportive', 0.3, 0.4)`
    ).bind(memoryId, "2026-07-17 五维运行时闭环测试", createdAt, createdAt).run();

    const revisionOneOutbox = await first<OutboxRow>(
      `SELECT * FROM memory_five_axis_outbox
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1`,
      memoryId
    );
    expect(revisionOneOutbox).toMatchObject({ status: "pending", memory_revision: 1 });

    await expect(enqueuePendingFiveAxisProjections(env, 5)).resolves.toBe(1);
    const queuedOutbox = await first<OutboxRow>(
      "SELECT * FROM memory_five_axis_outbox WHERE id = ?",
      revisionOneOutbox!.id
    );
    expect(queuedOutbox?.status).toBe("queued");

    const body: MemoryFiveAxisProjectionQueueMessage = {
      type: "memory_five_axis_projection",
      namespace: queuedOutbox!.namespace,
      memoryId: queuedOutbox!.memory_id,
      memoryUpdatedAt: queuedOutbox!.memory_updated_at,
      memoryRevision: queuedOutbox!.memory_revision,
      outboxId: queuedOutbox!.id,
      idempotencyKey: `five-axis:${queuedOutbox!.id}:r${queuedOutbox!.memory_revision}`
    };
    const batch = createMessageBatch<MemoryFiveAxisProjectionQueueMessage>("companion-memory", [{
      id: "runtime-circuit-message",
      timestamp: new Date(createdAt),
      attempts: 1,
      body
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const queueResult = await getQueueResult(batch, ctx);
    expect(queueResult.explicitAcks).toStrictEqual(["runtime-circuit-message"]);

    await expect(first<OutboxRow>(
      "SELECT * FROM memory_five_axis_outbox WHERE id = ?",
      queuedOutbox!.id
    )).resolves.toMatchObject({ status: "completed" });

    const candidate = await first<CandidateRow>(
      `SELECT id, external_key, status FROM memory_candidates
       WHERE namespace = 'default' AND target_id = ? AND action = 'timeline_date'`,
      memoryId
    );
    expect(candidate).toMatchObject({ status: "pending" });
    await expect(first<AxisRunRow>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'X'`,
      memoryId
    )).resolves.toMatchObject({ status: "pending_review" });
    await expect(first<{ candidate_external_key: string }>(
      `SELECT candidate_external_key FROM memory_candidate_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'X'`,
      memoryId
    )).resolves.toMatchObject({ candidate_external_key: candidate!.external_key });

    const form = new FormData();
    form.set("id", candidate!.id);
    await expect(approveTimelineCandidate(env, form)).resolves.toMatchObject({ id: memoryId });

    await expect(first<CandidateRow>(
      "SELECT id, external_key, status FROM memory_candidates WHERE id = ?",
      candidate!.id
    )).resolves.toMatchObject({ status: "approved" });
    await expect(first<AxisRunRow>(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'X'`,
      memoryId
    )).resolves.toMatchObject({ status: "applied" });
    await expect(first<{ five_axis_revision: number }>(
      "SELECT five_axis_revision FROM memories WHERE namespace = 'default' AND id = ?",
      memoryId
    )).resolves.toMatchObject({ five_axis_revision: 2 });
    await expect(first<OutboxRow>(
      `SELECT * FROM memory_five_axis_outbox
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 2`,
      memoryId
    )).resolves.toMatchObject({ status: "pending", memory_revision: 2 });
  });
});
