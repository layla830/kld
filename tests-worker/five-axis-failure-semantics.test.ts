import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approveTimelineCandidate } from "../src/api/adminBoard/timelineActions";
import {
  finalizeExhaustedFiveAxisOutbox,
  listFiveAxisDeadLetters,
  retryFiveAxisDeadLetter,
  type MemoryFiveAxisOutboxRecord
} from "../src/db/memoryFiveAxisOutbox";
import { createMemory, getMemoryById } from "../src/db/memories";
import { runRelationBuild } from "../src/memory/fiveAxis/yRelations";
import { queueTimelineCandidateForMemory } from "../src/memory/timelineBackfill";
import type { Env } from "../src/types";

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

  it("moves exhausted outboxes to dead letter and resets both outbox and axis attempts on manual retry", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "Dead letter runtime contract.",
      thread: "dead-letter-runtime"
    });
    const outbox = await env.DB.prepare(
      "SELECT * FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ? ORDER BY id DESC LIMIT 1"
    ).bind(memory.id).first<MemoryFiveAxisOutboxRecord>();
    expect(outbox).toBeTruthy();
    await env.DB.prepare(
      `UPDATE memory_five_axis_outbox
       SET status = 'failed', attempts = 5, updated_at = '2026-07-18T00:00:00.000Z'
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
  });
});
