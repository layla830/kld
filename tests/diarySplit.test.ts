import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, MemoryRecord } from "../src/types";

vi.mock("../src/proxy/openaiAdapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/proxy/openaiAdapter")>();
  return { ...actual, callOpenAICompat: vi.fn() };
});
vi.mock("../src/memory/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/embedding")>();
  return { ...actual, upsertMemoryEmbedding: vi.fn(async () => false) };
});
vi.mock("../src/memory/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/state")>();
  return { ...actual, removeMemoryVector: vi.fn(async () => "deleted" as const) };
});
vi.mock("../src/db/memoryEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/memoryEvents")>();
  return { ...actual, createMemoryEvent: vi.fn(async () => undefined) };
});

import { callOpenAICompat } from "../src/proxy/openaiAdapter";
import { upsertMemoryEmbedding } from "../src/memory/embedding";
import { createMemoryEvent } from "../src/db/memoryEvents";
import { DIARY_SPLIT_COMPLETE_EVENT } from "../src/db/diarySplitState";
import {
  dateFromDiary,
  ensureVerbatimTimelineDay,
  splitDiaryMemories
} from "../src/memory/diarySplit";
import { parseItemsWithDebug } from "../src/memory/diarySplitParse";
import { buildSplitPrompt } from "../src/memory/diarySplitPrompt";

const DIARY_ID = "diary_1";
const DIARY_DATE = "2026-07-20";
const DIARY_CONTENT =
  "7月20日日记\n今天和KLD一起review了记忆库。她说房子能住住得很好。这是我们的家。学到的教训是选择性记忆比全量记录更可持续。";

function diary(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: DIARY_ID,
    namespace: "default",
    type: "diary",
    content: DIARY_CONTENT,
    summary: null,
    fact_key: null,
    active_fact: 1,
    thread: null,
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: 0.5,
    confidence: 0.8,
    status: "active",
    pinned: 0,
    tags: null,
    source: null,
    source_message_ids: "[]",
    vector_id: null,
    vector_synced: 0,
    vector_sync_status: null,
    last_recalled_at: null,
    recall_count: 0,
    five_axis_revision: 1,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    expires_at: null,
    ...overrides
  };
}

function llmResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function setLlm(response: Response): void {
  vi.mocked(callOpenAICompat).mockImplementation(async () => response.clone());
}

interface FakeDbOptions {
  diaries?: MemoryRecord[];
  existingSplitCount?: number;
  existingV2SplitCount?: number;
  hasSuccessfulSplit?: boolean;
  hasActiveV2Item?: boolean;
  existingSplitItemId?: string | null;
}

function fakeDb(opts: FakeDbOptions = {}): D1Database {
  const prepare = (sql: string) => ({
    bind(..._args: unknown[]) {
      const s = sql.replace(/\s+/g, " ").trim();
      let first: unknown = null;
      let all: { results: unknown[] } = { results: [] };

      if (s.startsWith("SELECT COUNT(*) AS count FROM memories") && s.includes("source = ?")) {
        first = s.includes("split_version:v2") || s.includes("AND tags LIKE ? AND tags LIKE ?")
          ? { count: opts.existingV2SplitCount ?? 0 }
          : { count: opts.existingSplitCount ?? 0 };
      } else if (s.startsWith("SELECT id FROM memory_events AS event")) {
        first = opts.hasSuccessfulSplit ? { id: "ev_existing" } : null;
      } else if (s.startsWith("SELECT split.id FROM memories AS split")) {
        first = opts.hasActiveV2Item ? { id: "split_existing" } : null;
      } else if (s.startsWith("SELECT id FROM memories") && s.includes("tags LIKE ?")) {
        first = opts.existingSplitItemId ? { id: opts.existingSplitItemId } : null;
      } else if (s.startsWith("SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND type = ?")) {
        all = { results: opts.diaries ?? [] };
      }

      return {
        first: async () => first,
        all: async () => all,
        run: async () => ({ meta: { changes: 1 } })
      };
    }
  });
  const batch = async (statements: unknown[]) => statements.map(() => ({ meta: { changes: 1 } }));
  return { prepare, batch } as unknown as D1Database;
}

function fakeEnv(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

beforeEach(() => {
  vi.mocked(callOpenAICompat).mockReset();
  vi.mocked(upsertMemoryEmbedding).mockReset();
  vi.mocked(createMemoryEvent).mockReset();
});

describe("dateFromDiary", () => {
  it("reads a single Chinese date from the diary content", () => {
    expect(dateFromDiary(diary())).toBe(DIARY_DATE);
  });

  it("uses the first day of a date range written in the content", () => {
    expect(dateFromDiary(diary({ content: "7月20日-7月22日日记\n周末整理记忆库。" }))).toBe(DIARY_DATE);
  });

  it("falls back to a date tag when the content has no date line", () => {
    expect(dateFromDiary(diary({ content: "今天review了记忆库。", tags: JSON.stringify(["7月20日日记"]) }))).toBe(DIARY_DATE);
  });

  it("returns null when no date is present", () => {
    expect(dateFromDiary(diary({ content: "今天review了记忆库。", tags: null }))).toBeNull();
  });
});

describe("diary split prompt", () => {
  it("explicitly forbids date-only and timeline_day records", () => {
    const prompt = buildSplitPrompt(diary(), DIARY_DATE, [DIARY_DATE]);
    expect(prompt).toContain("Do not create a date-only record");
    expect(prompt).toContain("An empty items array is correct");
    expect(prompt).not.toContain("Always include a timeline_day");
  });
});

describe("parseItemsWithDebug", () => {
  it("drops legacy timeline_day output while keeping supported atomic memories", () => {
    const parsed = parseItemsWithDebug(JSON.stringify({
      items: [
        {
          date: DIARY_DATE,
          type: "timeline_day",
          content: "2026-07-20：今天review了记忆库",
          evidence: "今天和KLD一起review了记忆库",
          temporal_scope: "day"
        },
        {
          date: DIARY_DATE,
          type: "quote",
          content: "房子能住住得很好",
          evidence: "房子能住住得很好",
          temporal_scope: "day"
        },
        {
          date: DIARY_DATE,
          type: "lesson",
          content: "选择性记忆比全量记录更可持续",
          evidence: "选择性记忆比全量记录更可持续",
          temporal_scope: "current",
          fact_like: true,
          fact_key: "relationship.lesson.selective_memory"
        }
      ]
    }), DIARY_DATE, [DIARY_DATE], DIARY_ID, DIARY_CONTENT, true);

    expect(parsed.items.map((item) => item.type)).toEqual(["quote", "lesson"]);
    expect(parsed.items[1]).toMatchObject({
      fact_key: "relationship.lesson.selective_memory",
      review_required: true
    });
    expect(parsed.debug).toMatchObject({ raw_item_count: 3, accepted_item_count: 2 });
  });

  it("accepts an empty model result without manufacturing a fallback", () => {
    expect(parseItemsWithDebug('{"items":[]}', DIARY_DATE, [DIARY_DATE], DIARY_ID, DIARY_CONTENT, true).items).toEqual([]);
  });
});

describe("splitDiaryMemories", () => {
  it("calls the model once and returns only atomic items", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE,
        type: "event",
        content: "和KLD一起review了记忆库",
        evidence: "今天和KLD一起review了记忆库",
        temporal_scope: "day"
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    expect(callOpenAICompat).toHaveBeenCalledTimes(1);
    expect(plans[0]).toMatchObject({ skipped: false, items: [{ type: "event" }] });
  });

  it("records an intentional empty split as terminal completion", async () => {
    setLlm(llmResponse([]));
    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: true
    });

    expect(plans[0]).toMatchObject({ skipped: false, reason: "no_durable_items", items: [] });
    expect(createMemoryEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: DIARY_SPLIT_COMPLETE_EVENT,
      memoryId: DIARY_ID,
      payload: expect.objectContaining({ item_count: 0, outcome: "no_durable_items" })
    }));
    expect(upsertMemoryEmbedding).not.toHaveBeenCalled();
  });

  it("persists a real split item without creating a timeline_day", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE,
        type: "quote",
        content: "房子能住住得很好",
        evidence: "房子能住住得很好",
        temporal_scope: "day"
      }
    ]));
    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: true
    });

    expect(plans[0].items.map((item) => item.type)).toEqual(["quote"]);
    expect(plans[0].created_ids).toHaveLength(1);
    expect(upsertMemoryEmbedding).toHaveBeenCalledTimes(1);
    expect(createMemoryEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: DIARY_SPLIT_COMPLETE_EVENT,
      payload: expect.objectContaining({ item_count: 1, outcome: "items_created" })
    }));
  });

  it("skips a diary that already has an active V2 atomic item", async () => {
    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()], hasActiveV2Item: true })), {
      namespace: "default",
      apply: false
    });
    expect(plans[0]).toMatchObject({ skipped: true, reason: "already_split" });
    expect(callOpenAICompat).not.toHaveBeenCalled();
  });
});

describe("legacy timeline day repair", () => {
  it("is fail-closed for active formal diaries", async () => {
    await expect(ensureVerbatimTimelineDay(fakeEnv(fakeDb()), {
      namespace: "default",
      diary: diary(),
      date: DIARY_DATE
    })).rejects.toThrow("timeline_day_memories_removed");
  });

  it("still rejects non-formal diary sources before the compatibility error", async () => {
    await expect(ensureVerbatimTimelineDay(fakeEnv(fakeDb()), {
      namespace: "default",
      diary: diary({ type: "layla_diary" }),
      date: DIARY_DATE
    })).rejects.toThrow("timeline_day_repair_requires_active_diary");
  });
});
