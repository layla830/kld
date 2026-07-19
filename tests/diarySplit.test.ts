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

import { callOpenAICompat } from "../src/proxy/openaiAdapter";
import { upsertMemoryEmbedding } from "../src/memory/embedding";
import { removeMemoryVector } from "../src/memory/state";
import {
  dateFromDiary,
  ensureVerbatimTimelineDay,
  splitDiaryMemories
} from "../src/memory/diarySplit";

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

function llmResponse(payload: unknown): Response {
  const content = typeof payload === "string" ? payload : JSON.stringify({ items: payload });
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function setLlm(...responses: Response[]): void {
  const mock = vi.mocked(callOpenAICompat);
  if (responses.length === 1) {
    const response = responses[0];
    mock.mockImplementation(async () => response.clone());
  } else {
    responses.forEach((response) => mock.mockImplementationOnce(async () => response.clone()));
  }
}

interface FakeDbOptions {
  diaries?: MemoryRecord[];
  existingSplitCount?: number;
  existingV2SplitCount?: number;
  hasSuccessfulSplit?: boolean;
  hasActiveV2Day?: boolean;
  existingSplitItemId?: string | null;
  alreadyRescreened?: boolean;
  rescreenedOldMemories?: MemoryRecord[];
  verbatimMemory?: MemoryRecord | null;
}

function fakeDb(opts: FakeDbOptions = {}): D1Database {
  const prepare = (sql: string) => ({
    bind(..._args: unknown[]) {
      const s = sql.replace(/\s+/g, " ").trim();
      let first: unknown = null;
      let all: { results: unknown[] } = { results: [] };

      if (s.startsWith("SELECT COUNT(*) AS count FROM memories") && s.includes("source = ?")) {
        first = s.includes("AND tags LIKE ? AND tags LIKE ?")
          ? { count: opts.existingV2SplitCount ?? 0 }
          : { count: opts.existingSplitCount ?? 0 };
      } else if (s.startsWith("SELECT id FROM memory_events")) {
        first = opts.hasSuccessfulSplit ? { id: "ev_existing" } : null;
      } else if (s.startsWith("SELECT split.id FROM memories AS split")) {
        first = opts.hasActiveV2Day ? { id: "split_existing" } : null;
      } else if (s.startsWith("SELECT id FROM memories") && s.includes("tags LIKE ?")) {
        first = opts.existingSplitItemId ? { id: opts.existingSplitItemId } : null;
      } else if (s.includes("SUM(CASE WHEN")) {
        first = opts.alreadyRescreened
          ? { old_active: 0, old_review: 0, new_active: 1 }
          : { old_active: 1, old_review: 0, new_active: 0 };
      } else if (s.startsWith("SELECT * FROM memories") && s.includes("AND id = ?") && s.includes("LIMIT 1")) {
        first = opts.verbatimMemory ?? null;
      } else if (s.startsWith("SELECT * FROM memories") && s.includes("AND EXISTS (SELECT 1 FROM json_each")) {
        all = { results: opts.rescreenedOldMemories ?? [] };
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
  vi.mocked(removeMemoryVector).mockReset();
});

describe("dateFromDiary", () => {
  it("reads a single Chinese date from the diary content", () => {
    expect(dateFromDiary(diary())).toBe(DIARY_DATE);
  });

  it("uses the first day of a date range written in the content", () => {
    const record = diary({ content: "7月20日-7月22日日记\n周末和KLD一起整理记忆库。" });
    expect(dateFromDiary(record)).toBe(DIARY_DATE);
  });

  it("falls back to a date tag when the content has no date line", () => {
    const record = diary({
      content: "今天和KLD一起review了记忆库。",
      tags: JSON.stringify(["7月20日日记"])
    });
    expect(dateFromDiary(record)).toBe(DIARY_DATE);
  });

  it("returns null when no date is present anywhere", () => {
    const record = diary({ content: "今天和KLD一起review了记忆库。", tags: null });
    expect(dateFromDiary(record)).toBeNull();
  });

  it("derives the year from created_at so cross-year diaries resolve correctly", () => {
    const record = diary({
      content: "12月31日日记\n跨年夜。",
      created_at: "2025-12-31T23:59:00.000Z"
    });
    expect(dateFromDiary(record)).toBe("2025-12-31");
  });
});

describe("splitDiaryMemories plan (apply=false)", () => {
  it("maps validated LLM items into a plan with canonical timeline tags and fact_key rules", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库，确认架构可用。",
        summary: "review记忆库", importance: 0.7, confidence: 0.9, tags: ["review"],
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_like: false, fact_key: null
      },
      {
        date: DIARY_DATE, type: "quote", content: "房子能住住得很好",
        summary: null, importance: 0.8, confidence: 0.9, tags: ["家"],
        evidence: "房子能住住得很好", temporal_scope: "day", fact_like: false, fact_key: null
      },
      {
        date: DIARY_DATE, type: "lesson", content: "选择性记忆比全量记录更可持续",
        summary: "选择性记忆", importance: 0.85, confidence: 0.9, tags: ["教训"],
        evidence: "选择性记忆比全量记录更可持续", temporal_scope: "current",
        fact_like: true, fact_key: "relationship.lesson.selective_memory"
      },
      {
        date: DIARY_DATE, type: "insight", content: "记忆库是两人的家",
        summary: null, importance: 0.7, confidence: 0.85, tags: ["家"],
        evidence: "这是我们的家", temporal_scope: "day",
        fact_like: true, fact_key: "relationship.insight.home"
      },
      {
        date: DIARY_DATE, type: "rule", content: "平淡日子不写日记",
        summary: null, importance: 0.7, confidence: 0.85, tags: ["规则"],
        evidence: "选择性记忆比全量记录更可持续", temporal_scope: "day",
        fact_like: true, fact_key: "relationship.rule.selective"
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan).toMatchObject({ diary_id: DIARY_ID, date: DIARY_DATE, skipped: false });
    expect(plan.items).toHaveLength(5);

    const [timelineDay, quote, lesson, insight, rule] = plan.items;

    expect(timelineDay).toMatchObject({
      type: "timeline_day", temporal_scope: "day", review_required: false, fact_key: null,
      importance: 0.7, confidence: 0.9
    });
    expect(timelineDay.tags).toEqual([
      "timeline", `date:${DIARY_DATE}`, "timeline_day", "review",
      `origin:${DIARY_ID}`, `source_label:diary_${DIARY_DATE}`,
      "temporal_scope:day", "split_batch:20260720_diary", "split_version:v2"
    ]);

    expect(quote).toMatchObject({ type: "quote", importance: 0.8, review_required: false, fact_key: null });

    expect(lesson).toMatchObject({
      type: "lesson", temporal_scope: "current", review_required: true,
      fact_key: "relationship.lesson.selective_memory"
    });

    expect(insight).toMatchObject({ type: "insight", review_required: false, fact_key: null });
    expect(insight.temporal_scope).toBe("day");

    expect(rule).toMatchObject({ type: "rule", review_required: true, fact_key: null });
    expect(rule.temporal_scope).toBe("day");
  });

  it("drops items whose evidence is not an exact substring of the diary", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      },
      {
        date: DIARY_DATE, type: "insight", content: "这是模型编造的洞察",
        evidence: "这段证据原文里根本没有", temporal_scope: "day", fact_key: null
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    expect(plans[0].items).toHaveLength(1);
    expect(plans[0].items[0].type).toBe("timeline_day");
  });

  it("drops quote items whose content is not an exact substring even when evidence matches", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      },
      {
        date: DIARY_DATE, type: "quote", content: "这是模型改写过的引用",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    expect(plans[0].items).toHaveLength(1);
    expect(plans[0].items[0].type).toBe("timeline_day");
  });

  it("deduplicates items that share type and content", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      },
      {
        date: DIARY_DATE, type: "quote", content: "房子能住住得很好",
        evidence: "房子能住住得很好", temporal_scope: "day", fact_key: null
      },
      {
        date: DIARY_DATE, type: "quote", content: "房子能住住得很好",
        evidence: "房子能住住得很好", temporal_scope: "day", fact_key: null
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    const types = plans[0].items.map((item) => item.type);
    expect(types).toEqual(["timeline_day", "quote"]);
  });

  it("caps the number of accepted items at the per-diary maximum", async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      date: DIARY_DATE,
      type: "warmth",
      content: `温暖的记忆片段${index}号`,
      evidence: "今天和KLD一起review了记忆库",
      temporal_scope: "day" as const,
      fact_key: null
    }));
    setLlm(llmResponse(items));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    expect(plans[0].items).toHaveLength(6);
  });

  it("clamps importance and confidence into [0,1] and falls back when numeric values are missing", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day",
        importance: 1.5, confidence: "high"
      },
      {
        date: DIARY_DATE, type: "quote", content: "房子能住住得很好",
        evidence: "房子能住住得很好", temporal_scope: "day"
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    const [timelineDay, quote] = plans[0].items;
    expect(timelineDay.importance).toBe(1);
    expect(timelineDay.confidence).toBe(0.8);
    expect(quote.importance).toBe(0.7);
    expect(quote.confidence).toBe(0.8);
  });

  it("keeps only one timeline_day per date and rejects over-long summaries", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      },
      {
        date: DIARY_DATE, type: "timeline_day", content: "第二次review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    const timelineDays = plans[0].items.filter((item) => item.type === "timeline_day");
    expect(timelineDays).toHaveLength(1);
  });

  it("skips diaries that already have a successful v2 split event", async () => {
    setLlm(llmResponse([]));

    const plans = await splitDiaryMemories(
      fakeEnv(fakeDb({ diaries: [diary()], existingSplitCount: 2, hasSuccessfulSplit: true })),
      { namespace: "default", apply: false }
    );

    expect(plans[0]).toMatchObject({
      skipped: true,
      reason: "already_split",
      existing_count: 2,
      items: []
    });
  });

  it("skips diaries that already have an active v2 timeline_day", async () => {
    setLlm(llmResponse([]));

    const plans = await splitDiaryMemories(
      fakeEnv(fakeDb({ diaries: [diary()], hasActiveV2Day: true })),
      { namespace: "default", apply: false }
    );

    expect(plans[0].skipped).toBe(true);
    expect(plans[0].reason).toBe("already_split");
  });

  it("skips legacy-split diaries that were never migrated to v2", async () => {
    setLlm(llmResponse([]));

    const plans = await splitDiaryMemories(
      fakeEnv(fakeDb({ diaries: [diary()], existingSplitCount: 3, existingV2SplitCount: 0 })),
      { namespace: "default", apply: false }
    );

    expect(plans[0].reason).toBe("already_split");
    expect(plans[0].existing_count).toBe(3);
  });

  it("retries once and falls back to a verbatim timeline_day when the model omits the required date", async () => {
    setLlm(
      llmResponse([
        {
          date: DIARY_DATE, type: "quote", content: "房子能住住得很好",
          evidence: "房子能住住得很好", temporal_scope: "day", fact_key: null
        }
      ]),
      llmResponse([
        {
          date: DIARY_DATE, type: "quote", content: "房子能住住得很好",
          evidence: "房子能住住得很好", temporal_scope: "day", fact_key: null
        }
      ])
    );

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false,
      debug: true
    });

    expect(vi.mocked(callOpenAICompat)).toHaveBeenCalledTimes(2);
    const plan = plans[0];
    const timelineDay = plan.items.find((item) => item.type === "timeline_day");
    expect(timelineDay).toBeDefined();
    expect(timelineDay?.content.startsWith(`${DIARY_DATE}：`)).toBe(true);
    expect(timelineDay?.tags).toContain("timeline_day_fallback:verbatim");
    expect(plan.debug?.fallback).toBe("verbatim_timeline_day");
  });

  it("populates debug metadata only when debug=true", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      }
    ]));

    const withoutDebug = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });
    const withDebug = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false,
      debug: true
    });

    expect(withoutDebug[0].debug).toBeUndefined();
    expect(withDebug[0].debug).toMatchObject({
      parsed_kind: "array",
      raw_item_count: 1,
      accepted_item_count: 1
    });
  });

  it("filters diaries by the requested dates before splitting", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      }
    ]));

    const other = diary({ id: "diary_2", content: "7月21日日记\n第二天继续整理。" });

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary(), other] })), {
      namespace: "default",
      apply: false,
      dates: ["2026-07-21"]
    });

    expect(plans).toHaveLength(1);
    expect(plans[0].diary_id).toBe("diary_2");
    expect(plans[0].date).toBe("2026-07-21");
  });

  it("falls back to a verbatim timeline_day when the model yields nothing (apply=false, no event)", async () => {
    setLlm(llmResponse([]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: false
    });

    expect(plans[0].skipped).toBe(false);
    expect(plans[0].items).toHaveLength(1);
    expect(plans[0].items[0]).toMatchObject({ type: "timeline_day", review_required: false });
    expect(plans[0].items[0].tags).toContain("timeline_day_fallback:verbatim");
  });
});

describe("splitDiaryMemories apply=true", () => {
  it("persists non-review items as active memories, routes review items to candidates, and records the completion event", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      },
      {
        date: DIARY_DATE, type: "quote", content: "房子能住住得很好",
        evidence: "房子能住住得很好", temporal_scope: "day", fact_key: null
      },
      {
        date: DIARY_DATE, type: "lesson", content: "选择性记忆比全量记录更可持续",
        evidence: "选择性记忆比全量记录更可持续", temporal_scope: "current",
        fact_like: true, fact_key: "relationship.lesson.selective_memory"
      }
    ]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: true
    });

    const plan = plans[0];
    expect(plan.skipped).toBe(false);
    expect(plan.created_ids).toHaveLength(2);
    expect(plan.created_ids?.every((id) => typeof id === "string" && id.startsWith("mem_"))).toBe(true);
    expect(plan.candidate_keys).toEqual([expect.stringMatching(/^diary-split-v2:diary_1:[a-f0-9]{24}$/)]);

    expect(vi.mocked(upsertMemoryEmbedding)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(removeMemoryVector)).not.toHaveBeenCalled();
  });

  it("reuses an existing split memory id instead of inserting a duplicate", async () => {
    setLlm(llmResponse([
      {
        date: DIARY_DATE, type: "timeline_day", content: "和KLD一起review记忆库。",
        evidence: "今天和KLD一起review了记忆库", temporal_scope: "day", fact_key: null
      }
    ]));

    const plans = await splitDiaryMemories(
      fakeEnv(fakeDb({ diaries: [diary()], existingSplitItemId: "mem_existing" })),
      { namespace: "default", apply: true }
    );

    expect(plans[0].created_ids).toEqual(["mem_existing"]);
    expect(vi.mocked(upsertMemoryEmbedding)).not.toHaveBeenCalled();
  });

  it("persists the verbatim fallback and records a complete event when the model yields nothing", async () => {
    setLlm(llmResponse([]));

    const plans = await splitDiaryMemories(fakeEnv(fakeDb({ diaries: [diary()] })), {
      namespace: "default",
      apply: true
    });

    expect(plans[0].skipped).toBe(false);
    expect(plans[0].created_ids).toHaveLength(1);
    expect(plans[0].candidate_keys).toEqual([]);
    expect(vi.mocked(upsertMemoryEmbedding)).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid replace_importer shape", async () => {
    await expect(
      splitDiaryMemories(fakeEnv(fakeDb({})), {
        namespace: "default",
        apply: true,
        replaceImporter: "bad importer!",
        ids: [DIARY_ID],
        force: true
      })
    ).rejects.toThrow("invalid replace_importer");
  });

  it("requires force and explicit ids for a replace_importer run", async () => {
    await expect(
      splitDiaryMemories(fakeEnv(fakeDb({})), {
        namespace: "default",
        apply: true,
        replaceImporter: "nightly"
      })
    ).rejects.toThrow("replace_importer requires force=true and explicit diary ids");
  });

  it("limits replace_importer runs to at most three diaries", async () => {
    await expect(
      splitDiaryMemories(fakeEnv(fakeDb({})), {
        namespace: "default",
        apply: true,
        replaceImporter: "nightly",
        force: true,
        ids: ["d1", "d2", "d3", "d4"]
      })
    ).rejects.toThrow("replace_importer accepts at most 3 diary ids per request");
  });
});

describe("ensureVerbatimTimelineDay", () => {
  it("refuses to repair a non-active or non-diary source", async () => {
    await expect(
      ensureVerbatimTimelineDay(fakeEnv(fakeDb({})), {
        namespace: "default",
        diary: diary({ status: "deleted" }),
        date: DIARY_DATE
      })
    ).rejects.toThrow("timeline_day_repair_requires_active_diary");

    await expect(
      ensureVerbatimTimelineDay(fakeEnv(fakeDb({})), {
        namespace: "default",
        diary: diary({ type: "auto_diary" }),
        date: DIARY_DATE
      })
    ).rejects.toThrow("timeline_day_repair_requires_active_diary");
  });

  it("persists the verbatim timeline_day and returns the stored memory", async () => {
    const stored = diary({ id: "mem_verbatim", type: "timeline_day" });
    const env = fakeEnv(fakeDb({ verbatimMemory: stored }));

    const result = await ensureVerbatimTimelineDay(env, {
      namespace: "default",
      diary: diary(),
      date: DIARY_DATE
    });

    expect(result.id).toBe("mem_verbatim");
    expect(vi.mocked(upsertMemoryEmbedding)).toHaveBeenCalledTimes(1);
  });

  it("throws when the persisted memory cannot be reloaded", async () => {
    const env = fakeEnv(fakeDb({ verbatimMemory: null }));

    await expect(
      ensureVerbatimTimelineDay(env, { namespace: "default", diary: diary(), date: DIARY_DATE })
    ).rejects.toThrow("timeline_day_repair_not_found");
  });
});
