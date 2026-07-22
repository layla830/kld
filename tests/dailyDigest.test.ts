import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClock } from "../src/config/runtime";
import type { Env, MemoryApiRecord, MemoryRecord, MessageRecord } from "../src/types";

vi.mock("../src/proxy/openaiAdapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/proxy/openaiAdapter")>();
  return { ...actual, callOpenAICompat: vi.fn() };
});
vi.mock("../src/db/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/messages")>();
  return { ...actual, listMessagesByNamespaceInRange: vi.fn(async () => [] as MessageRecord[]) };
});
vi.mock("../src/db/retention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/retention")>();
  return { ...actual, readCursor: vi.fn(async () => null), writeCursor: vi.fn(async () => undefined) };
});
vi.mock("../src/db/memories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/memories")>();
  return { ...actual, listMemories: vi.fn(async () => [] as MemoryRecord[]), getMemoryById: vi.fn(async () => null) };
});
vi.mock("../src/db/memoryEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/memoryEvents")>();
  return { ...actual, createMemoryEvent: vi.fn(async () => undefined) };
});
vi.mock("../src/db/summaries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/summaries")>();
  return { ...actual, upsertSummary: vi.fn(async () => ({ id: "sum_1" } as never)) };
});
vi.mock("../src/memory/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/state")>();
  return {
    ...actual,
    createSyncedMemory: vi.fn(async () => ({ id: "mem_new" } as MemoryRecord)),
    deleteSyncedMemory: vi.fn(async () => ({ id: "mem_del" } as MemoryRecord))
  };
});
vi.mock("../src/db/memoryRelations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/memoryRelations")>();
  return { ...actual, createMemoryRelation: vi.fn(async () => true) };
});
vi.mock("../src/memory/relationReview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/relationReview")>();
  return { ...actual, queueRelationReviewCandidate: vi.fn(async () => "y-review-key") };
});

import { callOpenAICompat } from "../src/proxy/openaiAdapter";
import { listMessagesByNamespaceInRange } from "../src/db/messages";
import { readCursor, writeCursor } from "../src/db/retention";
import { listMemories, getMemoryById } from "../src/db/memories";
import { createMemoryEvent } from "../src/db/memoryEvents";
import { upsertSummary } from "../src/db/summaries";
import { createSyncedMemory, deleteSyncedMemory } from "../src/memory/state";
import { createMemoryRelation } from "../src/db/memoryRelations";
import { queueRelationReviewCandidate } from "../src/memory/relationReview";
import { runDailyMemoryDigest } from "../src/memory/dailyDigest";

const NAMESPACE = "default";

function fixedClock(now: Date): AppClock {
  return {
    now: () => now,
    nowMs: () => now.getTime(),
    iso: () => now.toISOString(),
    today: () => ""
  };
}

function env(overrides: Record<string, string> = {}): Env {
  return {
    DB: {} as D1Database,
    ENABLE_DREAM: "true",
    DREAM_DRY_RUN: "false",
    DREAM_TIME_ZONE: "Asia/Shanghai",
    DREAM_MAX_MESSAGES: "40",
    DREAM_EXCERPT_LIMIT: "8",
    EMPTY_MEMORY_MIN_CHARS: "4",
    DREAM_MEMORY_CONTEXT_LIMIT: "40",
    DREAM_MAX_TOKENS: "3000",
    ENABLE_DAILY_SUMMARY_MEMORY: "true",
    DREAM_MODEL: "test-dream-model",
    ...overrides
  } as unknown as Env;
}

function message(id: string, role: "user" | "assistant", content: string, createdAt: string): MessageRecord {
  return { id, conversation_id: "conv1", namespace: NAMESPACE, role, content, source: null, created_at: createdAt };
}

function windowMessages(): MessageRecord[] {
  return [
    message("msg_a", "user", "我们今天继续整理记忆库。", "2026-07-18T20:00:00.000Z"),
    message("msg_b", "assistant", "好的，先看 dailyDigest。", "2026-07-18T20:05:00.000Z"),
    message("msg_c", "user", "记得保留 durable 的事实。", "2026-07-18T21:00:00.000Z"),
    message("msg_d", "assistant", "已经在 dream 里处理了。", "2026-07-18T21:10:00.000Z")
  ];
}

function llmResponse(payload: unknown, status = 200): Response {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function llmResponseWithReasoning(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "", reasoning_content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function defaultDigestJson(): Record<string, unknown> {
  return {
    date: "2026-07-19",
    title: "夜间整理",
    summary: "合并了重复记忆。",
    sections: [{ heading: "整理结果", content: "更新了项目状态。" }],
    important_excerpts: [],
    memories_to_add: [],
    memories_to_update: [],
    memories_to_delete: [],
    relation_hints: []
  };
}

let createSeq = 0;

beforeEach(() => {
  vi.mocked(callOpenAICompat).mockReset();
  vi.mocked(listMessagesByNamespaceInRange).mockReset();
  vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue([]);
  vi.mocked(readCursor).mockReset();
  vi.mocked(readCursor).mockResolvedValue(null);
  vi.mocked(writeCursor).mockReset();
  vi.mocked(writeCursor).mockResolvedValue(undefined);
  vi.mocked(listMemories).mockReset();
  vi.mocked(listMemories).mockResolvedValue([]);
  vi.mocked(getMemoryById).mockReset();
  vi.mocked(getMemoryById).mockResolvedValue(null);
  vi.mocked(createMemoryEvent).mockReset();
  vi.mocked(createMemoryEvent).mockResolvedValue(undefined);
  vi.mocked(upsertSummary).mockReset();
  vi.mocked(upsertSummary).mockResolvedValue({ id: "sum_1" } as never);
  createSeq = 0;
  vi.mocked(createSyncedMemory).mockReset();
  vi.mocked(createSyncedMemory).mockImplementation(async (_e, input) => ({ id: `mem_new_${createSeq++}`, content: input.content, type: input.type } as unknown as MemoryRecord));
  vi.mocked(deleteSyncedMemory).mockReset();
  vi.mocked(deleteSyncedMemory).mockResolvedValue({ id: "mem_del" } as MemoryRecord);
  vi.mocked(createMemoryRelation).mockReset();
  vi.mocked(createMemoryRelation).mockResolvedValue(true);
  vi.mocked(queueRelationReviewCandidate).mockReset();
  vi.mocked(queueRelationReviewCandidate).mockResolvedValue("y-review-key");
});

describe("timezone and date window", () => {
  it("defaults the target date to yesterday in the configured timezone", async () => {
    const clock = fixedClock(new Date("2026-07-20T02:00:00.000Z"));
    await runDailyMemoryDigest(env(), NAMESPACE, { clock });

    const args = vi.mocked(listMessagesByNamespaceInRange).mock.calls[0][1];
    expect(args.startCreatedAt).toBe("2026-07-18T16:00:00.000Z");
    expect(args.endCreatedAt).toBe("2026-07-19T16:00:00.000Z");
    expect(args.afterCreatedAt).toBeNull();
  });

  it("honors an explicit dateLabel over the derived yesterday", async () => {
    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    const args = vi.mocked(listMessagesByNamespaceInRange).mock.calls[0][1];
    expect(args.startCreatedAt).toBe("2026-07-18T16:00:00.000Z");
    expect(args.endCreatedAt).toBe("2026-07-19T16:00:00.000Z");
  });

  it("computes the window in the configured timezone, not UTC", async () => {
    await runDailyMemoryDigest(
      env({ DREAM_TIME_ZONE: "America/Los_Angeles" }),
      NAMESPACE,
      { dateLabel: "2026-07-19" }
    );

    const args = vi.mocked(listMessagesByNamespaceInRange).mock.calls[0][1];
    expect(args.startCreatedAt).toBe("2026-07-19T07:00:00.000Z");
    expect(args.endCreatedAt).toBe("2026-07-20T07:00:00.000Z");
  });

  it("skips when dream is disabled by config", async () => {
    const result = await runDailyMemoryDigest(env({ ENABLE_DREAM: "false" }), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result).toMatchObject({ ran: false, reason: "dream_disabled" });
    expect(vi.mocked(listMessagesByNamespaceInRange)).not.toHaveBeenCalled();
  });
});

describe("LLM JSON tolerance", () => {
  it("parses a clean JSON object in content", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse(defaultDigestJson()));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result.ran).toBe(true);
  });

  it("recovers JSON wrapped in prose via extractJsonObject", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(
      llmResponse(`好的，这是结果：${JSON.stringify(defaultDigestJson())} 整理完毕。`)
    );

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result.ran).toBe(true);
  });

  it("falls back to reasoning_content when content is empty", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponseWithReasoning(defaultDigestJson()));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result.ran).toBe(true);
  });

  it("skips with model_invalid_json when the body has no JSON object", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse("完全没有JSON的纯文本输出"));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result).toMatchObject({ ran: false, reason: "model_invalid_json" });
    expect(vi.mocked(writeCursor)).not.toHaveBeenCalled();
  });
});

describe("retry, cursor, and empty output", () => {
  it("marks the cursor done when there are no messages in the window", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue([]);

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result).toMatchObject({ ran: false, reason: "no_messages" });
    expect(vi.mocked(writeCursor)).toHaveBeenCalledTimes(1);
    const [, name, value] = vi.mocked(writeCursor).mock.calls[0];
    expect(name).toBe("dream:default:2026-07-19");
    expect(value).toBe("done:2026-07-18T16:00:00.000Z");
  });

  it("skips when the cursor is already marked done for the window", async () => {
    vi.mocked(readCursor).mockResolvedValue("done:2026-07-18T16:00:00.000Z");

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result).toMatchObject({ ran: false, reason: "already_done" });
    expect(vi.mocked(listMessagesByNamespaceInRange)).not.toHaveBeenCalled();
    expect(vi.mocked(callOpenAICompat)).not.toHaveBeenCalled();
  });

  it("resumes from a mid-window cursor instead of restarting the window", async () => {
    vi.mocked(readCursor).mockResolvedValue("2026-07-18T20:30:00.000Z");

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    const args = vi.mocked(listMessagesByNamespaceInRange).mock.calls[0][1];
    expect(args.afterCreatedAt).toBe("2026-07-18T20:30:00.000Z");
  });

  it("ignores a stale cursor from outside the window and restarts fresh", async () => {
    vi.mocked(readCursor).mockResolvedValue("2026-07-15T00:00:00.000Z");

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    const args = vi.mocked(listMessagesByNamespaceInRange).mock.calls[0][1];
    expect(args.afterCreatedAt).toBeNull();
  });

  it("advances the cursor to the last message when more messages remain (pagination)", async () => {
    const msgs = windowMessages();
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(msgs);
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse(defaultDigestJson()));

    await runDailyMemoryDigest(env({ DREAM_MAX_MESSAGES: "4" }), NAMESPACE, { dateLabel: "2026-07-19" });

    const [, name, value] = vi.mocked(writeCursor).mock.calls[0];
    expect(name).toBe("dream:default:2026-07-19");
    expect(value).toBe("2026-07-18T21:10:00.000Z");
  });

  it("marks the cursor done when the window fits in one batch", async () => {
    const msgs = windowMessages();
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(msgs);
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse(defaultDigestJson()));

    await runDailyMemoryDigest(env({ DREAM_MAX_MESSAGES: "40" }), NAMESPACE, { dateLabel: "2026-07-19" });

    const [, , value] = vi.mocked(writeCursor).mock.calls[0];
    expect(value).toBe("done:2026-07-18T21:10:00.000Z");
  });

  it("does not advance the cursor when the model fails, so the next run retries", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse("not json", 200));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result.ran).toBe(false);
    expect(vi.mocked(writeCursor)).not.toHaveBeenCalled();
  });
});

describe("message dedup and durable claim (repeated message support)", () => {
  it("drops an important_excerpt backed by fewer than two distinct message ids", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      important_excerpts: [
        { quote: "记得保留 durable 的事实。", reason: "重要原文", tags: ["durable"], source_message_ids: ["msg_c"] }
      ]
    }));

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createSyncedMemory)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "excerpt" })
    );
  });

  it("keeps an important_excerpt backed by two distinct message ids", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      important_excerpts: [
        { quote: "记得保留 durable 的事实。", reason: "重要原文", tags: ["durable"], source_message_ids: ["msg_a", "msg_c"] }
      ]
    }));

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createSyncedMemory)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "excerpt", sourceMessageIds: ["msg_a", "msg_c"] })
    );
  });

  it("drops a memories_to_add item with fewer than two distinct message ids", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_add: [
        { type: "project", content: "正在简化记忆写入策略。", importance: 0.86, confidence: 0.9, tags: ["kld"], source_message_ids: ["msg_a"] }
      ]
    }));

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createSyncedMemory)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "project" })
    );
  });

  it("keeps a memories_to_add item backed by two distinct message ids and normalizes its fact_key", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_add: [
        { type: "project", content: "正在简化记忆写入策略。", importance: 0.86, confidence: 0.9, tags: ["kld"], source_message_ids: ["msg_a", "msg_b"], fact_key: "project:kld_memory" }
      ]
    }));

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createSyncedMemory)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "project", factKey: "project:kld_memory", sourceMessageIds: ["msg_a", "msg_b"] })
    );
  });

  it("normalizes an all-punctuation fact_key to null rather than rejecting the memory", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_add: [
        { type: "project", content: "正在简化记忆写入策略。", importance: 0.8, confidence: 0.9, tags: [], source_message_ids: ["msg_a", "msg_b"], fact_key: "!!!" }
      ]
    }));

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createSyncedMemory)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "project", factKey: null })
    );
  });
});

describe("digest writes, candidates, and events", () => {
  it("writes the daily summary, the daily_summary memory, snapshot, and completion cursor", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse(defaultDigestJson()));

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(upsertSummary)).toHaveBeenCalledTimes(1);
    const summaryInput = vi.mocked(upsertSummary).mock.calls[0][1];
    expect(summaryInput.content).toContain("# 2026-07-19 夜间整理");
    expect(summaryInput.messageCount).toBe(4);

    expect(vi.mocked(createSyncedMemory)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "daily_summary", thread: "timeline:2026-07-19", tags: expect.arrayContaining(["dream-summary", "daily-summary", "2026-07-19"]) })
    );

    expect(vi.mocked(createMemoryEvent)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "dream_snapshot" })
    );
  });

  it("skips the daily_summary memory when the config flag is off", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse(defaultDigestJson()));

    await runDailyMemoryDigest(env({ ENABLE_DAILY_SUMMARY_MEMORY: "false" }), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createSyncedMemory)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "daily_summary" })
    );
  });

  it("persists each memories_to_add and maps placeholders to real ids for relation hints", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_add: [
        { type: "project", content: "记忆写入策略 A。", importance: 0.8, confidence: 0.9, tags: [], source_message_ids: ["msg_a", "msg_b"] },
        { type: "project", content: "记忆写入策略 B。", importance: 0.8, confidence: 0.9, tags: [], source_message_ids: ["msg_c", "msg_d"] }
      ],
      relation_hints: [
        { source_id: "add_0", target_id: "add_1", relation_type: "same_topic", strength: 0.6, reason: "都关于记忆策略" }
      ]
    }));

    await runDailyMemoryDigest(env({ ENABLE_DAILY_SUMMARY_MEMORY: "false" }), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createSyncedMemory)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "project" }));
    expect(vi.mocked(createMemoryRelation)).toHaveBeenCalledTimes(1);
    const relInput = vi.mocked(createMemoryRelation).mock.calls[0][1];
    expect(relInput.sourceMemoryId).toBe("mem_new_0");
    expect(relInput.targetMemoryId).toBe("mem_new_1");
    expect(relInput.relationType).toBe("same_topic");
  });

  it("routes safe relations directly and review relations to the review queue", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_add: [
        { type: "project", content: "策略 A。", importance: 0.8, confidence: 0.9, tags: [], source_message_ids: ["msg_a", "msg_b"] }
      ],
      relation_hints: [
        { source_id: "add_0", target_id: "mem_existing", relation_type: "same_topic", strength: 0.5 },
        { source_id: "add_0", target_id: "mem_existing", relation_type: "contradicts", strength: 0.7, reason: "新信息否定旧记忆" }
      ]
    }));
    vi.mocked(getMemoryById).mockImplementation(async (_db, input) => ({
      id: input.id, status: "active", pinned: 0, namespace: NAMESPACE
    } as MemoryRecord) as never);

    await runDailyMemoryDigest(env({ ENABLE_DAILY_SUMMARY_MEMORY: "false" }), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(vi.mocked(createMemoryRelation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queueRelationReviewCandidate)).toHaveBeenCalledTimes(1);
    const reviewInput = vi.mocked(queueRelationReviewCandidate).mock.calls[0][2];
    expect(reviewInput.relationType).toBe("contradicts");
    expect(reviewInput.projectionKey).toBe("dream:2026-07-19");
  });

  it("never executes memory updates/deletes directly; it only queues a review event", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_update: [{ target_id: "mem_old", content: "更新后的正文" }],
      memories_to_delete: [{ target_id: "mem_stale", reason: "重复" }]
    }));
    vi.mocked(getMemoryById).mockImplementation(async (_db, input) => ({
      id: input.id,
      status: "active",
      pinned: 0,
      namespace: NAMESPACE,
      type: "note",
      importance: 0.2,
      fact_key: null,
      active_fact: 1
    } as MemoryRecord) as never);

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    const eventCalls = vi.mocked(createMemoryEvent).mock.calls.map((c) => c[1].eventType);
    expect(eventCalls).toContain("dream_mutation_review");
    const reviewCall = vi.mocked(createMemoryEvent).mock.calls.find((c) => c[1].eventType === "dream_mutation_review");
    expect(reviewCall).toBeDefined();
    const reviewEvent = reviewCall![1];
    expect(reviewEvent.payload).toMatchObject({ policy: "review_first" });
    expect(reviewEvent.payload.updates).toHaveLength(1);
    expect(reviewEvent.payload.deletes).toHaveLength(1);
    expect(vi.mocked(deleteSyncedMemory)).not.toHaveBeenCalled();
  });

  it("filters protected memories out of Dream delete reviews", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_delete: [
        { target_id: "mem_rule", reason: "not mentioned today" },
        { target_id: "mem_note", reason: "exact duplicate" }
      ]
    }));
    vi.mocked(getMemoryById).mockImplementation(async (_db, input) => ({
      id: input.id,
      status: "active",
      pinned: 0,
      namespace: NAMESPACE,
      type: input.id === "mem_rule" ? "rule" : "note",
      importance: input.id === "mem_rule" ? 1 : 0.2,
      fact_key: null,
      active_fact: 1
    } as MemoryRecord) as never);

    await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    const reviewCall = vi.mocked(createMemoryEvent).mock.calls.find((call) => call[1].eventType === "dream_mutation_review");
    expect(reviewCall?.[1].payload.deletes).toEqual([
      expect.objectContaining({ target_id: "mem_note" })
    ]);
  });

  it("records a dry-run plan event without writing any memory or summary", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse({
      ...defaultDigestJson(),
      memories_to_add: [{ type: "project", content: "策略。", importance: 0.8, confidence: 0.9, tags: [], source_message_ids: ["msg_a", "msg_b"] }]
    }));

    const result = await runDailyMemoryDigest(env({ DREAM_DRY_RUN: "true" }), NAMESPACE, { dateLabel: "2026-07-19" });
    if (!result.ran) throw new Error("expected ran");

    expect(result.stats.dryRun).toBe(true);
    expect(result.stats.addedMemories).toBe(0);
    expect(vi.mocked(createMemoryEvent)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "dream_dry_run" })
    );
    expect(vi.mocked(createSyncedMemory)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertSummary)).not.toHaveBeenCalled();
  });
});

describe("failure recovery", () => {
  it("skips with model_error on a non-ok HTTP status and leaves the cursor untouched", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse("upstream down", 500));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result).toMatchObject({ ran: false, reason: "model_error", status: 500 });
    expect(vi.mocked(writeCursor)).not.toHaveBeenCalled();
    expect(vi.mocked(createSyncedMemory)).not.toHaveBeenCalled();
  });

  it("skips with model_error when callOpenAICompat throws and leaves the cursor untouched", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockRejectedValue(new Error("network reset"));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result).toMatchObject({ ran: false, reason: "model_error" });
    expect(vi.mocked(writeCursor)).not.toHaveBeenCalled();
  });

  it("skips with missing_model when no dream model is configured", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());

    const result = await runDailyMemoryDigest(env({ DREAM_MODEL: "", MEMORY_MODEL: "", SUMMARY_MODEL: "" }), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result).toMatchObject({ ran: false, reason: "missing_model" });
    expect(vi.mocked(callOpenAICompat)).not.toHaveBeenCalled();
  });

  it("continues the run when listing existing memories throws (degraded memory context)", async () => {
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(listMemories).mockRejectedValueOnce(new Error("d1 read failed"));
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse(defaultDigestJson()));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19" });

    expect(result.ran).toBe(true);
  });

  it("force re-runs even when the cursor is already done", async () => {
    vi.mocked(readCursor).mockResolvedValue("done:2026-07-18T16:00:00.000Z");
    vi.mocked(listMessagesByNamespaceInRange).mockResolvedValue(windowMessages());
    vi.mocked(callOpenAICompat).mockResolvedValue(llmResponse(defaultDigestJson()));

    const result = await runDailyMemoryDigest(env(), NAMESPACE, { dateLabel: "2026-07-19", force: true });

    expect(result.ran).toBe(true);
    expect(vi.mocked(listMessagesByNamespaceInRange)).toHaveBeenCalled();
  });
});
