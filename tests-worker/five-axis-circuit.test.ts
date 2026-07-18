import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { approveTimelineCandidate } from "../src/api/adminBoard/timelineActions";
import { enqueuePendingFiveAxisProjections } from "../src/queue/producer";
import { createMemory } from "../src/db/memories";
import { scanDiaryTimelineBackfill } from "../src/memory/diaryTimelineBackfill";
import { splitDiaryMemories } from "../src/memory/diarySplit";
import type { DiarySplitQueueMessage, Env, MemoryFiveAxisProjectionQueueMessage, MemoryRecord } from "../src/types";

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

afterEach(() => vi.restoreAllMocks());

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

  it("closes formal diary split through dated day nodes, X memberships and adjacent-day edges", async () => {
    const vectorize = {
      upsert: vi.fn(async () => undefined),
      deleteByIds: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ matches: [] }))
    } as unknown as Vectorize;
    const runtimeEnv = {
      ...env,
      UPSTREAM_BASE_URL: "https://runtime.test/v1",
      UPSTREAM_API_KEY: "runtime-test-key",
      MEMORY_MODEL: "runtime-test-model",
      EMBEDDING_MODEL: "runtime-test-embedding",
      VECTORIZE: vectorize
    } as Env;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body || "{}")) as { input?: unknown; messages?: Array<{ content?: unknown }> };
      if (request.input !== undefined) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
      }
      const prompt = request.messages?.map((message) => String(message.content ?? "")).join("\n") ?? "";
      if (prompt.includes("Split this Chinese diary")) {
        const date = prompt.match(/Default date: (20\d{2}-\d{2}-\d{2})/)?.[1] ?? "2026-07-17";
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            items: [
              {
                date,
                type: "timeline_day",
                content: `${date} 完成了记忆时间轴闭环`,
                summary: "日记时间轴闭环",
                importance: 0.8,
                confidence: 0.95,
                tags: ["runtime-diary"],
                evidence: "完成了记忆时间轴闭环",
                temporal_scope: "day",
                fact_like: false,
                fact_key: null
              },
              {
                date,
                type: "quote",
                content: "完成了记忆时间轴闭环",
                summary: null,
                importance: 0.7,
                confidence: 0.95,
                tags: ["runtime-diary"],
                evidence: "完成了记忆时间轴闭环",
                temporal_scope: "day",
                fact_like: false,
                fact_key: null
              }
            ]
          }) } }]
        }), { status: 200 });
      }
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          updates: ids.map((id) => ({
            id,
            fact_key: null,
            thread: "kld",
            risk_level: "low",
            urgency_level: "low",
            tension_score: 0,
            valence: 0.4,
            arousal: 0.2,
            response_posture: "保持温暖而清晰"
          }))
        }) } }]
      }), { status: 200 });
    });

    const diaryInputs = [
      { date: "2026-07-17", title: "7月17日日记" },
      { date: "2026-07-18", title: "7月18日日记" }
    ];
    for (const [index, diaryInput] of diaryInputs.entries()) {
      const diary = await createMemory(env.DB, {
        namespace: "default",
        type: "diary",
        content: `${diaryInput.title}\n今天完成了记忆时间轴闭环。`,
        source: "mcp",
        tags: [diaryInput.title]
      });
      const splitMessage: DiarySplitQueueMessage = {
        type: "diary_split",
        namespace: "default",
        diaryId: diary.id,
        jobId: `runtime-diary-split-${index}`
      };
      const splitBatch = createMessageBatch<DiarySplitQueueMessage>("companion-memory", [{
        id: `runtime-diary-split-message-${index}`,
        timestamp: new Date(`${diaryInput.date}T12:00:00.000Z`),
        attempts: 1,
        body: splitMessage
      }]);
      await worker.queue(splitBatch, runtimeEnv);
      await expect(getQueueResult(splitBatch, createExecutionContext())).resolves.toMatchObject({
        explicitAcks: [`runtime-diary-split-message-${index}`]
      });
    }

    const children = await env.DB.prepare(
      `SELECT * FROM memories
       WHERE namespace = 'default' AND source = 'timeline_split' AND status = 'active'
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'runtime-diary')
       ORDER BY created_at, id`
    ).all<MemoryRecord>();
    expect(children.results).toHaveLength(4);
    expect(children.results?.every((memory) => JSON.parse(memory.tags || "[]").some((tag: string) => tag.startsWith("date:")))).toBe(true);

    const enqueued = await enqueuePendingFiveAxisProjections(runtimeEnv, 20);
    expect(enqueued).toBeGreaterThanOrEqual(4);
    const outboxes = await env.DB.prepare(
      `SELECT outbox.* FROM memory_five_axis_outbox AS outbox
       JOIN memories AS memory ON memory.namespace = outbox.namespace AND memory.id = outbox.memory_id
       WHERE outbox.namespace = 'default' AND outbox.status = 'queued'
         AND memory.source = 'timeline_split'
         AND EXISTS (SELECT 1 FROM json_each(memory.tags) WHERE value = 'runtime-diary')
       ORDER BY outbox.id`
    ).all<OutboxRow>();
    expect(outboxes.results).toHaveLength(4);
    for (const outbox of outboxes.results ?? []) {
      const projection: MemoryFiveAxisProjectionQueueMessage = {
        type: "memory_five_axis_projection",
        namespace: outbox.namespace,
        memoryId: outbox.memory_id,
        memoryUpdatedAt: outbox.memory_updated_at,
        memoryRevision: outbox.memory_revision,
        outboxId: outbox.id,
        idempotencyKey: `five-axis:${outbox.id}:r${outbox.memory_revision}`
      };
      const projectionBatch = createMessageBatch<MemoryFiveAxisProjectionQueueMessage>("companion-memory", [{
        id: `runtime-diary-projection-${outbox.id}`,
        timestamp: new Date(),
        attempts: 1,
        body: projection
      }]);
      await worker.queue(projectionBatch, runtimeEnv);
      await expect(getQueueResult(projectionBatch, createExecutionContext())).resolves.toMatchObject({
        explicitAcks: [`runtime-diary-projection-${outbox.id}`]
      });
    }

    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships AS membership
       JOIN memories AS memory ON memory.namespace = membership.namespace AND memory.id = membership.memory_id
       WHERE membership.namespace = 'default'
         AND EXISTS (SELECT 1 FROM json_each(memory.tags) WHERE value = 'runtime-diary')`
    )).resolves.toMatchObject({ count: 4 });
    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = 'default' AND relation_type = 'in_episode' AND reason LIKE 'diary_day:%'`
    )).resolves.toMatchObject({ count: 2 });
    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = 'default' AND relation_type = 'temporal_sequence' AND reason = 'diary_timeline:diary:kld'`
    )).resolves.toMatchObject({ count: 1 });
    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memory_five_axis_runs AS run
       JOIN memories AS memory ON memory.namespace = run.namespace AND memory.id = run.memory_id
       WHERE run.namespace = 'default' AND run.axis = 'X' AND run.status = 'applied'
         AND memory.source = 'timeline_split'
         AND EXISTS (SELECT 1 FROM json_each(memory.tags) WHERE value = 'runtime-diary')`
    )).resolves.toMatchObject({ count: 4 });
  });

  it("backfills complete historical diary splits while leaving low-coverage days untouched", async () => {
    const completeDiary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "7月15日日记\n完整历史拆分。",
      source: "mcp"
    });
    const sparseDiary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "7月14日日记\n只有一句旧摘录。",
      source: "mcp"
    });
    await createMemory(env.DB, {
      namespace: "default",
      type: "timeline_day",
      content: "7月15日完整日节点",
      source: "timeline_split",
      sourceMessageIds: [completeDiary.id],
      tags: ["timeline", "date:2026-07-15", `origin:${completeDiary.id}`]
    });
    await createMemory(env.DB, {
      namespace: "default",
      type: "quote",
      content: "完整历史拆分",
      source: "timeline_split",
      sourceMessageIds: [completeDiary.id],
      tags: ["timeline", "date:2026-07-15", `origin:${completeDiary.id}`]
    });
    const sparseQuote = await createMemory(env.DB, {
      namespace: "default",
      type: "quote",
      content: "只有一句旧摘录",
      source: "timeline_split",
      sourceMessageIds: [sparseDiary.id],
      tags: ["timeline", "date:2026-07-14", `origin:${sparseDiary.id}`]
    });

    const result = await scanDiaryTimelineBackfill(env as Env, "default", { apply: true, limit: 100 });
    expect(result.rows.find((row) => row.diaryId === completeDiary.id)).toMatchObject({
      lowCoverageReasons: [],
      backfilled: true
    });
    expect(result.rows.find((row) => row.diaryId === sparseDiary.id)).toMatchObject({
      lowCoverageReasons: ["missing_timeline_day"],
      backfilled: false
    });
    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships
       WHERE namespace = 'default' AND origin_diary_id = ?`,
      completeDiary.id
    )).resolves.toMatchObject({ count: 2 });
    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships
       WHERE namespace = 'default' AND memory_id = ?`,
      sparseQuote.id
    )).resolves.toMatchObject({ count: 0 });
  });

  it("retries a non-empty diary split that omits its required timeline day", async () => {
    const diary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "7月14日日记\n她说：先查证据，再下结论。",
      source: "mcp"
    });
    let attempts = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      const items = attempts === 1
        ? [{
            date: "2026-07-14",
            type: "quote",
            content: "先查证据，再下结论",
            evidence: "先查证据，再下结论",
            temporal_scope: "day"
          }]
        : [
            {
              date: "2026-07-14",
              type: "timeline_day",
              content: "7月14日，她提醒先查证据再下结论。",
              evidence: "先查证据，再下结论",
              temporal_scope: "day"
            },
            {
              date: "2026-07-14",
              type: "quote",
              content: "先查证据，再下结论",
              evidence: "先查证据，再下结论",
              temporal_scope: "day"
            }
          ];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items }) } }]
      }), { status: 200 });
    });
    const runtimeEnv = {
      ...env,
      UPSTREAM_BASE_URL: "https://runtime.test/v1",
      UPSTREAM_API_KEY: "runtime-test-key",
      MEMORY_MODEL: "runtime-test-model"
    } as Env;

    const plans = await splitDiaryMemories(runtimeEnv, {
      namespace: "default",
      ids: [diary.id],
      apply: false,
      force: true
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(plans[0].items.map((item) => item.type)).toEqual(["timeline_day", "quote"]);
    expect(plans[0].items.every((item) => item.date === "2026-07-14")).toBe(true);
  });

  it("writes nothing when both diary split attempts omit the timeline day", async () => {
    const diary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "7月13日日记\n只记住这一句话。",
      source: "mcp"
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        items: [{
          date: "2026-07-13",
          type: "quote",
          content: "只记住这一句话",
          evidence: "只记住这一句话",
          temporal_scope: "day"
        }]
      }) } }]
    }), { status: 200 }));
    const runtimeEnv = {
      ...env,
      UPSTREAM_BASE_URL: "https://runtime.test/v1",
      UPSTREAM_API_KEY: "runtime-test-key",
      MEMORY_MODEL: "runtime-test-model"
    } as Env;

    await expect(splitDiaryMemories(runtimeEnv, {
      namespace: "default",
      ids: [diary.id],
      apply: true,
      force: true
    })).rejects.toThrow("split_model_missing_timeline_day:2026-07-13");
    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memories
       WHERE namespace = 'default' AND source = 'timeline_split'
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`,
      `origin:${diary.id}`
    )).resolves.toMatchObject({ count: 0 });
    await expect(first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = 'default' AND event_type = 'diary_split_v2_complete' AND memory_id = ?`,
      diary.id
    )).resolves.toMatchObject({ count: 0 });
  });

  it("retries an empty formal diary split until the default date has a day node", async () => {
    const diary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "7月15日日记\n今天仍然值得留下一个日节点。",
      source: "mcp"
    });
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      const items = attempts === 1 ? [] : [{
        date: "2026-07-15",
        type: "timeline_day",
        content: "7月15日仍然值得被记住。",
        evidence: "今天仍然值得留下一个日节点",
        temporal_scope: "day"
      }];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items }) } }]
      }), { status: 200 });
    });
    const runtimeEnv = {
      ...env,
      UPSTREAM_BASE_URL: "https://runtime.test/v1",
      UPSTREAM_API_KEY: "runtime-test-key",
      MEMORY_MODEL: "runtime-test-model"
    } as Env;

    const plans = await splitDiaryMemories(runtimeEnv, {
      namespace: "default",
      ids: [diary.id],
      apply: false,
      force: true
    });

    expect(attempts).toBe(2);
    expect(plans[0].items).toMatchObject([{ type: "timeline_day", date: "2026-07-15" }]);
  });
});
