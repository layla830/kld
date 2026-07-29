import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { approveTimelineCandidate } from "../src/api/adminBoard/timelineActions";
import { renderTimelineCandidate } from "../src/api/adminBoard/timelineView";
import { getMemoryCandidate } from "../src/db/memoryCandidates";
import {
  claimFiveAxisOutboxForDelivery,
  claimFiveAxisOutboxForExecution,
  completeFiveAxisOutboxExecution,
  failFiveAxisOutboxClaim,
  finalizeExhaustedFiveAxisOutbox,
  hasNewerFiveAxisOutboxVersion,
  listFiveAxisDeadLetters,
  retryFiveAxisDeadLetter,
  type MemoryFiveAxisOutboxRecord
} from "../src/db/memoryFiveAxisOutbox";
import { createMemory, getMemoryById } from "../src/db/memories";
import { runRelationBuild } from "../src/memory/fiveAxis/yRelations";
import { queueTimelineCandidateForMemory } from "../src/memory/timelineBackfill";
import { enqueueFiveAxisOutboxRecord, enqueuePendingFiveAxisProjections } from "../src/queue/producer";
import type { Env, MemoryFiveAxisProjectionQueueMessage } from "../src/types";

describe("five-axis failure semantics", () => {
  it("rejects unknown durable statuses and prevents late workers from overwriting terminal outboxes", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Durable five-axis status contract.",
      thread: `status-contract:${crypto.randomUUID()}`
    });
    const outbox = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    expect(outbox).toBeTruthy();

    await expect(env.DB.prepare(
      "UPDATE memory_five_axis_outbox SET status = 'mystery' WHERE id = ?"
    ).bind(outbox!.id).run()).rejects.toThrow(/CHECK constraint failed/i);

    await env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         result_json, last_error, claim_token, lease_expires_at,
         started_at, completed_at, updated_at
       ) VALUES ('default', ?, ?, 'X', 'skipped', 1, NULL, NULL, NULL, NULL, NULL, ?, ?)`
    ).bind(memory.id, outbox!.memory_revision ?? 1, new Date().toISOString(), new Date().toISOString()).run();
    await expect(env.DB.prepare(
      `UPDATE memory_five_axis_runs SET status = 'mystery'
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = ? AND axis = 'X'`
    ).bind(memory.id, outbox!.memory_revision ?? 1).run()).rejects.toThrow(/CHECK constraint failed/i);

    const delivery = await claimFiveAxisOutboxForDelivery(env.DB, outbox!);
    expect(delivery).toBeTruthy();
    const execution = await claimFiveAxisOutboxForExecution(env.DB, delivery!);
    expect(execution.outcome).toBe("claimed");
    if (execution.outcome !== "claimed") throw new Error("execution claim rejected");
    await expect(completeFiveAxisOutboxExecution(env.DB, execution.claim, "completed", { ok: true }))
      .resolves.toBe(true);
    await expect(failFiveAxisOutboxClaim(env.DB, execution.claim, new Error("late worker")))
      .resolves.toBe(false);
    await expect(env.DB.prepare(
      "SELECT status, last_error FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first()).resolves.toMatchObject({ status: "completed", last_error: null });
  });

  it("claims one delivery when concurrent schedulers enqueue the same outbox snapshot", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Concurrent producer claim contract.",
      thread: `producer-claim:${crypto.randomUUID()}`
    });
    const outbox = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    const send = vi.fn(async (_message: unknown) => undefined);
    const runtimeEnv = {
      ...env,
      MEMORY_QUEUE: { send }
    } as unknown as Env;

    const results = await Promise.all([
      enqueueFiveAxisOutboxRecord(runtimeEnv, outbox!),
      enqueueFiveAxisOutboxRecord(runtimeEnv, outbox!)
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as MemoryFiveAxisProjectionQueueMessage;
    const executions = await Promise.all([
      claimFiveAxisOutboxForExecution(env.DB, {
        id: sent.outboxId,
        namespace: sent.namespace,
        memoryId: sent.memoryId,
        memoryUpdatedAt: sent.memoryUpdatedAt,
        memoryRevision: sent.memoryRevision ?? 1,
        attempt: sent.outboxAttempt,
        queuedAt: sent.outboxQueuedAt
      }),
      claimFiveAxisOutboxForExecution(env.DB, {
        id: sent.outboxId,
        namespace: sent.namespace,
        memoryId: sent.memoryId,
        memoryUpdatedAt: sent.memoryUpdatedAt,
        memoryRevision: sent.memoryRevision ?? 1,
        attempt: sent.outboxAttempt,
        queuedAt: sent.outboxQueuedAt
      })
    ]);
    expect(executions.filter((execution) => execution.outcome === "claimed")).toHaveLength(1);
    await expect(env.DB.prepare(
      "SELECT status, attempts FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first()).resolves.toMatchObject({ status: "queued", attempts: 1 });
  });

  it("releases an owned delivery to failed when Queue send throws", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Producer send failure contract.",
      thread: `producer-failure:${crypto.randomUUID()}`
    });
    const outbox = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    const runtimeEnv = {
      ...env,
      MEMORY_QUEUE: { send: vi.fn(async () => { throw new Error("queue send unavailable"); }) }
    } as unknown as Env;

    await expect(enqueueFiveAxisOutboxRecord(runtimeEnv, outbox!))
      .rejects.toThrow("queue send unavailable");
    await expect(env.DB.prepare(
      "SELECT status, attempts, last_error FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first()).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "queue send unavailable"
    });
  });

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
    const triggerName = `test_x_approval_abort_${crypto.randomUUID().replaceAll("-", "")}`;
    const candidateId = candidate!.id.replaceAll("'", "''");
    await env.DB.prepare(
      `CREATE TRIGGER ${triggerName}
       BEFORE UPDATE OF status ON memory_candidates
       WHEN OLD.id = '${candidateId}' AND NEW.status = 'approved'
       BEGIN
         SELECT RAISE(ABORT, 'forced timeline approval failure');
       END`
    ).run();
    try {
      await expect(approveTimelineCandidate(env as Env, form)).rejects.toThrow();
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }
    await expect(getMemoryById(env.DB, { namespace: "default", id: memory.id }))
      .resolves.toMatchObject({ tags: memory.tags });
    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
    ).bind(candidate!.id).first()).resolves.toMatchObject({ status: "pending" });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = 'default' AND event_type = 'x_timeline_candidate_approved'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(candidate!.id).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });

    await expect(approveTimelineCandidate(env as Env, form)).resolves.toMatchObject({ id: memory.id });

    const repaired = await getMemoryById(env.DB, { namespace: "default", id: memory.id });
    const dateTags = JSON.parse(repaired!.tags || "[]").filter((tag: string) => tag.startsWith("date:"));
    expect(dateTags).toEqual(["date:2026-07-21"]);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = 'default' AND event_type = 'x_timeline_candidate_approved'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(candidate!.id).first<{ count: number }>()).resolves.toMatchObject({ count: 1 });
    const sequenceEvent = await env.DB.prepare(
      `SELECT payload_json FROM memory_events
       WHERE namespace = 'default' AND event_type = 'x_timeline_sequence_rebuilt'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(candidate!.id).first<{ payload_json: string }>();
    expect(JSON.parse(sequenceEvent!.payload_json)).toMatchObject({ owner: "sequence" });
  });

  it("routes timeline_split date repair to the diary owner and clears ordinary membership", async () => {
    const origin = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "Timeline owner repair origin",
      status: "active",
      source: "mcp"
    });
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Timeline split fact with a date conflict",
      status: "active",
      source: "timeline_split",
      sourceMessageIds: [origin.id],
      thread: `timeline-split-owner:${crypto.randomUUID()}`,
      factKey: `timeline.split.owner:${crypto.randomUUID()}`,
      tags: [
        "timeline",
        "date:2026-07-20",
        "date:2026-07-21",
        `origin:${origin.id}`,
        "split_version:v2"
      ]
    });
    await env.DB.prepare(
      `INSERT INTO memory_timeline_memberships
       (namespace, memory_id, thread, fact_key, updated_at)
       VALUES ('default', ?, ?, ?, ?)`
    ).bind(
      memory.id,
      memory.thread,
      memory.fact_key,
      new Date().toISOString()
    ).run();

    await expect(queueTimelineCandidateForMemory(env as Env, memory)).resolves.toMatchObject({
      outcome: "queued",
      dates: ["2026-07-20", "2026-07-21"]
    });
    const candidate = await env.DB.prepare(
      `SELECT id FROM memory_candidates
       WHERE namespace = 'default' AND target_id = ? AND action = 'timeline_date' AND status = 'pending'`
    ).bind(memory.id).first<{ id: string }>();
    const form = new FormData();
    form.set("id", candidate!.id);
    form.set("date", "2026-07-21");

    await expect(approveTimelineCandidate(env as Env, form)).resolves.toMatchObject({ id: memory.id });

    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_timeline_memberships
       WHERE namespace = 'default' AND memory_id = ?`
    ).bind(memory.id).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });
    await expect(env.DB.prepare(
      `SELECT origin_diary_id, event_date, timeline_key
       FROM memory_diary_timeline_memberships
       WHERE namespace = 'default' AND memory_id = ?`
    ).bind(memory.id).first()).resolves.toMatchObject({
      origin_diary_id: origin.id,
      event_date: "2026-07-21",
      timeline_key: "diary:kld"
    });
    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
    ).bind(candidate!.id).first()).resolves.toMatchObject({ status: "approved" });
    const event = await env.DB.prepare(
      `SELECT payload_json FROM memory_events
       WHERE namespace = 'default' AND event_type = 'x_timeline_sequence_rebuilt'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(candidate!.id).first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      owner: "diary",
      sequence: {
        outcome: "diary_timeline_reconciled",
        originDiaryId: origin.id,
        eventDate: "2026-07-21"
      }
    });
  });

  it("keeps timeline approval committed when diary rebuild fails and lets X retry it", async () => {
    const origin = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "Timeline owner retry origin",
      status: "active",
      source: "mcp"
    });
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Timeline split fact whose diary rebuild retries",
      status: "active",
      source: "timeline_split",
      sourceMessageIds: [origin.id],
      thread: `timeline-split-retry:${crypto.randomUUID()}`,
      factKey: `timeline.split.retry:${crypto.randomUUID()}`,
      tags: [
        "timeline",
        "date:2026-07-20",
        "date:2026-07-21",
        `origin:${origin.id}`,
        "split_version:v2"
      ]
    });
    await queueTimelineCandidateForMemory(env as Env, memory);
    const candidate = await env.DB.prepare(
      `SELECT id FROM memory_candidates
       WHERE namespace = 'default' AND target_id = ? AND action = 'timeline_date' AND status = 'pending'`
    ).bind(memory.id).first<{ id: string }>();
    const form = new FormData();
    form.set("id", candidate!.id);
    form.set("date", "2026-07-21");
    const triggerName = `test_diary_owner_abort_${crypto.randomUUID().replaceAll("-", "")}`;
    const memoryId = memory.id.replaceAll("'", "''");
    await env.DB.prepare(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON memory_diary_timeline_memberships
       WHEN NEW.memory_id = '${memoryId}'
       BEGIN
         SELECT RAISE(ABORT, 'forced diary owner failure');
       END`
    ).run();
    try {
      await expect(approveTimelineCandidate(env as Env, form))
        .rejects.toThrow("forced diary owner failure");
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }

    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
    ).bind(candidate!.id).first()).resolves.toMatchObject({ status: "approved" });
    const updated = await getMemoryById(env.DB, { namespace: "default", id: memory.id });
    expect(JSON.parse(updated!.tags || "[]").filter((tag: string) => tag.startsWith("date:")))
      .toEqual(["date:2026-07-21"]);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = 'default' AND event_type = 'x_timeline_sequence_rebuilt'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(candidate!.id).first<{ count: number }>()).resolves.toMatchObject({ count: 0 });

    await expect(queueTimelineCandidateForMemory(env as Env, updated!)).resolves.toMatchObject({
      outcome: "diary_reconciled",
      queued: 0
    });
    await expect(env.DB.prepare(
      `SELECT origin_diary_id, event_date FROM memory_diary_timeline_memberships
       WHERE namespace = 'default' AND memory_id = ?`
    ).bind(memory.id).first()).resolves.toMatchObject({
      origin_diary_id: origin.id,
      event_date: "2026-07-21"
    });
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
       ) VALUES (
         'default', ?, ?, 'Y', 'skipped', 5,
         json_object(
           'reason', 'attempts_exhausted',
           'attempts', 5,
           'last_error', 'embedding unavailable'
         ),
         NULL, NULL, NULL, NULL, ?, ?
       )`
    ).bind(
      memory.id,
      outbox!.memory_revision ?? 1,
      new Date().toISOString(),
      new Date().toISOString()
    ).run();

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
      axis_runs_reset: [{ axis: "Y", status: "skipped", attempts: 5 }]
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
      outboxAttempt: queued!.attempts,
      outboxQueuedAt: queued!.queued_at!,
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
    const queuedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE memory_five_axis_outbox SET status = 'queued', attempts = 5, queued_at = ?, updated_at = ? WHERE id = ?"
    ).bind(queuedAt, queuedAt, outbox!.id).run();

    await failFiveAxisOutboxClaim(
      env.DB,
      {
        id: outbox!.id,
        namespace: outbox!.namespace,
        memoryId: outbox!.memory_id,
        memoryUpdatedAt: outbox!.memory_updated_at,
        memoryRevision: outbox!.memory_revision ?? 1,
        attempt: 5,
        queuedAt
      },
      new Error("fifth delivery failed")
    );
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
      const claim = await claimFiveAxisOutboxForDelivery(env.DB, item);
      expect(claim).toBeTruthy();
      const body: MemoryFiveAxisProjectionQueueMessage = {
        type: "memory_five_axis_projection",
        namespace: item.namespace,
        memoryId: item.memory_id,
        memoryUpdatedAt: item.memory_updated_at,
        memoryRevision: item.memory_revision ?? 1,
        outboxId: item.id,
        outboxAttempt: claim!.attempt,
        outboxQueuedAt: claim!.queuedAt,
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
      result_json: JSON.stringify({ reason: "stale_revision" })
    });
    await expect(env.DB.prepare(
      `SELECT status FROM memory_five_axis_outbox
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 3`
    ).bind(memory.id).first()).resolves.toMatchObject({ status: "completed" });
  });
});
