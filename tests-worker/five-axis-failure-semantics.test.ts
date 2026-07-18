import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { approveTimelineCandidate } from "../src/api/adminBoard/timelineActions";
import { renderTimelineCandidate } from "../src/api/adminBoard/timelineView";
import { getMemoryCandidate } from "../src/db/memoryCandidates";
import {
  finalizeExhaustedFiveAxisOutbox,
  hasNewerFiveAxisOutboxVersion,
  listFiveAxisDeadLetters,
  markFiveAxisOutboxFailed,
  retryFiveAxisDeadLetter,
  type MemoryFiveAxisOutboxRecord
} from "../src/db/memoryFiveAxisOutbox";
import { createMemory, getMemoryById } from "../src/db/memories";
import { runRelationBuild } from "../src/memory/fiveAxis/yRelations";
import { queueTimelineCandidateForMemory } from "../src/memory/timelineBackfill";
import { enqueuePendingFiveAxisProjections } from "../src/queue/producer";
import type { Env, MemoryFiveAxisProjectionQueueMessage } from "../src/types";

describe("five-axis failure semantics", () => {
  it("turns malformed or multiple X date tags into an actionable repair", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "候选日期是 2026-07-20 或 2026-07-21，需要人工确认。",
      thread: "x-repair-runtime",
      factKey: `x-repair-runtime:${crypto.randomUUID()}`,
      tags: ["timeline", "date:2026-13-40", "date:2026-07-20", "date:2026-07-21"]
    });

    await expect(queueTimelineCandidateForMemory(env as Env, memory)).resolves.toMatchObject({
      outcome: "queued",
      dates: ["2026-07-20", "2026-07-21"],
      queued: 1
    });
    const candidate = await env.DB.prepare(
      `SELECT id, payload_json FROM memory_candidates
       WHERE namespace = 'default' AND target_id = ? AND action = 'timeline_date' AND status = 'pending'`
    ).bind(memory.id).first<{ id: string; payload_json: string }>();
    expect(candidate).toBeTruthy();
    expect(JSON.parse(candidate!.payload_json)).toMatchObject({
      _kind: "timeline_date_repair",
      date_options: ["2026-07-20", "2026-07-21"]
    });

    const form = new FormData();
    form.set("id", candidate!.id);
    form.set("date", "2026-07-21");
    await expect(approveTimelineCandidate(env as Env, form)).resolves.toMatchObject({ id: memory.id });

    const repaired = await getMemoryById(env.DB, { namespace: "default", id: memory.id });
    const dateTags = JSON.parse(repaired!.tags || "[]").filter((tag: string) => tag.startsWith("date:"));
    expect(dateTags).toEqual(["date:2026-07-21"]);
  });

  it("reports missing Y infrastructure as an error instead of a true empty graph", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Y infrastructure failure must be retryable.",
      thread: "y-failure-runtime"
    });
    const runtimeEnv = { ...env, VECTORIZE: undefined } as unknown as Env;

    await expect(runRelationBuild(runtimeEnv, "default", {
      dryRun: false,
      memoryIds: [memory.id]
    })).resolves.toMatchObject({
      scanned: 1,
      candidates: 0,
      error: "vector_search_unavailable:missing_vectorize_binding"
    });
  });

  it("offers manual repair when every existing X date tag is invalid", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "正文里没有可以自动采用的明确日期。",
      thread: "x-manual-repair-runtime",
      tags: ["timeline", "date:2026-13-40", "date:2026-02-29"]
    });

    await expect(queueTimelineCandidateForMemory(env as Env, memory)).resolves.toMatchObject({
      outcome: "queued",
      dates: [],
      queued: 1
    });
    const candidateId = await env.DB.prepare(
      `SELECT id FROM memory_candidates
       WHERE namespace = 'default' AND target_id = ? AND action = 'timeline_date' AND status = 'pending'`
    ).bind(memory.id).first<{ id: string }>();
    const candidate = await getMemoryCandidate(env.DB, "default", candidateId!.id);
    expect(candidate).toBeTruthy();
    expect(JSON.parse(candidate!.payload_json)).toMatchObject({
      date_options: [],
      allow_manual_date: true
    });
    expect(renderTimelineCandidate({
      ...candidate!,
      target_status: memory.status,
      target_content: memory.content
    })).toContain('<input type="date" name="date" required>');

    const form = new FormData();
    form.set("id", candidate!.id);
    form.set("date", "2026-07-21");
    await expect(approveTimelineCandidate(env as Env, form)).resolves.toMatchObject({ id: memory.id });
    const repaired = await getMemoryById(env.DB, { namespace: "default", id: memory.id });
    expect(JSON.parse(repaired!.tags || "[]").filter((tag: string) => tag.startsWith("date:")))
      .toEqual(["date:2026-07-21"]);
  });

  it("moves exhausted outboxes to dead letter and resets both outbox and axis attempts on manual retry", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Dead letter runtime contract.",
      factKey: `dead-letter-runtime:${crypto.randomUUID()}`,
      thread: "dead-letter-runtime",
      riskLevel: "low",
      urgencyLevel: "normal",
      tensionScore: 0.2,
      responsePosture: "supportive",
      valence: 0.3,
      arousal: 0.4,
      tags: ["timeline", "date:2026-07-18"]
    });
    const outbox = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    expect(outbox).toBeTruthy();
    await env.DB.prepare(
      `UPDATE memory_five_axis_outbox
       SET status = 'failed', attempts = 5,
           last_error = 'embedding unavailable',
           created_at = '2000-01-01T00:00:00.000Z', updated_at = '2026-07-18T00:00:00.000Z'
       WHERE id = ?`
    ).bind(outbox!.id).run();
    await env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         result_json, last_error, claim_token, lease_expires_at,
         started_at, completed_at, updated_at
       ) VALUES ('default', ?, ?, 'Y', 'failed', 5, NULL, 'embedding unavailable', NULL, NULL, NULL, NULL, ?)`
    ).bind(memory.id, outbox!.memory_revision ?? 1, new Date().toISOString()).run();

    await expect(finalizeExhaustedFiveAxisOutbox(env.DB)).resolves.toBeGreaterThanOrEqual(1);
    const deadLetters = await listFiveAxisDeadLetters(env.DB, "default", 100);
    expect(deadLetters.some((item) => item.id === outbox!.id)).toBe(true);
    await expect(retryFiveAxisDeadLetter(env.DB, "default", outbox!.id)).resolves.toBe(true);
    await expect(env.DB.prepare(
      "SELECT status, attempts FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first()).resolves.toMatchObject({ status: "pending", attempts: 0 });
    await expect(env.DB.prepare(
      `SELECT status, attempts FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = ? AND axis = 'Y'`
    ).bind(memory.id, outbox!.memory_revision ?? 1).first()).resolves.toMatchObject({ status: "failed", attempts: 0 });

    const audit = await env.DB.prepare(
      `SELECT payload_json FROM memory_events
       WHERE namespace = 'default' AND memory_id = ? AND event_type = 'five_axis_dead_letter_retried'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(memory.id).first<{ payload_json: string }>();
    expect(JSON.parse(audit!.payload_json)).toMatchObject({
      source: "admin_board",
      outbox_id: outbox!.id,
      previous_attempts: 5,
      previous_error: "embedding unavailable",
      axis_runs_reset: [{ axis: "Y", status: "failed", attempts: 5 }]
    });

    const runtimeEnv = {
      ...env,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTORIZE: {
        query: async () => ({ matches: [] }),
        upsert: async () => undefined,
        deleteByIds: async () => undefined
      }
    } as unknown as Env;
    await expect(enqueuePendingFiveAxisProjections(runtimeEnv, 1)).resolves.toBe(1);
    const queued = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first<MemoryFiveAxisOutboxRecord>();
    expect(queued).toMatchObject({ status: "queued", attempts: 1 });

    const body: MemoryFiveAxisProjectionQueueMessage = {
      type: "memory_five_axis_projection",
      namespace: queued!.namespace,
      memoryId: queued!.memory_id,
      memoryUpdatedAt: queued!.memory_updated_at,
      memoryRevision: queued!.memory_revision ?? 1,
      outboxId: queued!.id,
      idempotencyKey: `five-axis:${queued!.id}:r${queued!.memory_revision ?? 1}`
    };
    const batch = createMessageBatch<MemoryFiveAxisProjectionQueueMessage>("companion-memory", [{
      id: `dead-letter-retry-${queued!.id}`,
      timestamp: new Date(),
      attempts: 1,
      body
    }]);
    await worker.queue(batch, runtimeEnv);
    await expect(getQueueResult(batch, createExecutionContext())).resolves.toMatchObject({
      explicitAcks: [`dead-letter-retry-${queued!.id}`]
    });
    await expect(env.DB.prepare(
      "SELECT status, last_error FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first()).resolves.toMatchObject({ status: "completed", last_error: null });
  });

  it("promotes the failing fifth delivery directly to dead letter", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Inline dead-letter transition.",
      thread: "inline-dead-letter-runtime"
    });
    const outbox = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    await env.DB.prepare(
      "UPDATE memory_five_axis_outbox SET status = 'queued', attempts = 5 WHERE id = ?"
    ).bind(outbox!.id).run();

    await markFiveAxisOutboxFailed(env.DB, outbox!.id, new Error("fifth delivery failed"));
    await expect(env.DB.prepare(
      "SELECT status, attempts, last_error, completed_at FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first()).resolves.toMatchObject({
      status: "dead_letter",
      attempts: 5,
      last_error: "fifth delivery failed"
    });
  });

  it("detects a newer outbox revision for the same memory", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Revision one.",
      thread: "newer-outbox-runtime"
    });
    const first = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id ASC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    await env.DB.prepare(
      "UPDATE memories SET content = ?, updated_at = ? WHERE namespace = 'default' AND id = ?"
    ).bind("Revision two.", new Date(Date.now() + 1_000).toISOString(), memory.id).run();
    const second = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();

    await expect(hasNewerFiveAxisOutboxVersion(env.DB, first!)).resolves.toBe(true);
    await expect(hasNewerFiveAxisOutboxVersion(env.DB, second!)).resolves.toBe(false);
  });

  it("preserves and processes the latest revision when material updates share a timestamp", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Same-millisecond outbox revision contract.",
      factKey: `same-millisecond-runtime:${crypto.randomUUID()}`,
      thread: "same-millisecond-runtime",
      riskLevel: "low",
      urgencyLevel: "normal",
      tensionScore: 0.2,
      responsePosture: "supportive",
      valence: 0.3,
      arousal: 0.4,
      tags: ["timeline", "date:2026-07-18"]
    });
    const initial = await env.DB.prepare(
      `SELECT * FROM memory_five_axis_outbox
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1`
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    expect(initial).toBeTruthy();
    await env.DB.prepare(
      `UPDATE memory_five_axis_outbox
       SET status = 'completed', completed_at = updated_at
       WHERE id = ?`
    ).bind(initial!.id).run();

    const sharedTimestamp = "2026-07-18T12:34:56.789Z";
    await env.DB.prepare(
      `UPDATE memories SET tags = ?, updated_at = ?
       WHERE namespace = 'default' AND id = ?`
    ).bind(JSON.stringify(["timeline", "date:2026-07-18", "revision:2"]), sharedTimestamp, memory.id).run();
    await env.DB.prepare(
      `UPDATE memories SET tags = ?, updated_at = ?
       WHERE namespace = 'default' AND id = ?`
    ).bind(JSON.stringify(["timeline", "date:2026-07-18", "revision:3"]), sharedTimestamp, memory.id).run();

    const revisions = await env.DB.prepare(
      `SELECT * FROM memory_five_axis_outbox
       WHERE namespace = 'default' AND memory_id = ?
       ORDER BY memory_revision`
    ).bind(memory.id).all<MemoryFiveAxisOutboxRecord>();
    expect((revisions.results ?? []).map((item) => ({
      memory_revision: item.memory_revision,
      memory_updated_at: item.memory_updated_at,
      status: item.status
    }))).toEqual([
      { memory_revision: 1, memory_updated_at: memory.updated_at, status: "completed" },
      { memory_revision: 2, memory_updated_at: sharedTimestamp, status: "pending" },
      { memory_revision: 3, memory_updated_at: sharedTimestamp, status: "pending" }
    ]);
    await expect(getMemoryById(env.DB, { namespace: "default", id: memory.id }))
      .resolves.toMatchObject({ five_axis_revision: 3, tags: expect.stringContaining("revision:3") });

    const runtimeEnv = {
      ...env,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTORIZE: {
        query: async () => ({ matches: [] }),
        upsert: async () => undefined,
        deleteByIds: async () => undefined
      }
    } as unknown as Env;
    const pending = (revisions.results ?? []).filter((item) => item.status === "pending");
    for (const item of pending) {
      await env.DB.prepare(
        "UPDATE memory_five_axis_outbox SET status = 'queued', attempts = 1 WHERE id = ?"
      ).bind(item.id).run();
      const body: MemoryFiveAxisProjectionQueueMessage = {
        type: "memory_five_axis_projection",
        namespace: item.namespace,
        memoryId: item.memory_id,
        memoryUpdatedAt: item.memory_updated_at,
        memoryRevision: item.memory_revision ?? 1,
        outboxId: item.id,
        idempotencyKey: `five-axis:${item.id}:r${item.memory_revision ?? 1}`
      };
      const batch = createMessageBatch<MemoryFiveAxisProjectionQueueMessage>("companion-memory", [{
        id: `same-millisecond-${item.memory_revision}`,
        timestamp: new Date(),
        attempts: 1,
        body
      }]);
      await worker.queue(batch, runtimeEnv);
      await expect(getQueueResult(batch, createExecutionContext())).resolves.toMatchObject({
        explicitAcks: [`same-millisecond-${item.memory_revision}`]
      });
    }

    await expect(env.DB.prepare(
      `SELECT status, result_json FROM memory_five_axis_outbox
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 2`
    ).bind(memory.id).first()).resolves.toMatchObject({
      status: "skipped",
      result_json: JSON.stringify({ reason: "memory_revision_mismatch", expected: 2, current: 3 })
    });
    await expect(env.DB.prepare(
      `SELECT status FROM memory_five_axis_outbox
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 3`
    ).bind(memory.id).first()).resolves.toMatchObject({ status: "completed" });
  });
});
