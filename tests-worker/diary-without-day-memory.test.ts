import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemory } from "../src/db/memories";
import { rebuildDiaryTimelineForMemory } from "../src/memory/diaryTimeline";
import { splitDiaryMemories } from "../src/memory/diarySplit";
import type { Env } from "../src/types";

afterEach(() => vi.restoreAllMocks());

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ count: number }>();
  return row?.count ?? 0;
}

describe("formal diary timeline without synthetic day memories", () => {
  it("uses real split items as day anchors and supports multiple diary dates", async () => {
    const firstDiary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "7月18日日记\n今天留下了一句真实的摘录和一件具体的事。",
      source: "mcp"
    });
    const secondDiary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "7月19日日记\n今天又留下了一件具体的事。",
      source: "mcp"
    });
    const firstQuote = await createMemory(env.DB, {
      namespace: "default",
      type: "quote",
      content: "一句真实的摘录",
      importance: 0.6,
      source: "timeline_split",
      sourceMessageIds: [firstDiary.id],
      tags: ["timeline", "date:2026-07-18", `origin:${firstDiary.id}`, "split_version:v2"]
    });
    const firstAnchor = await createMemory(env.DB, {
      namespace: "default",
      type: "event",
      content: "留下了一件具体的事",
      importance: 0.9,
      source: "timeline_split",
      sourceMessageIds: [firstDiary.id],
      tags: ["timeline", "date:2026-07-18", `origin:${firstDiary.id}`, "split_version:v2"]
    });
    const secondItem = await createMemory(env.DB, {
      namespace: "default",
      type: "event",
      content: "又留下了一件具体的事",
      source: "timeline_split",
      sourceMessageIds: [secondDiary.id],
      tags: ["timeline", "date:2026-07-19", `origin:${secondDiary.id}`, "split_version:v2"]
    });

    await expect(rebuildDiaryTimelineForMemory(env.DB, firstQuote)).resolves.toMatchObject({
      outcome: "diary_timeline_reconciled",
      dayMemoryId: firstAnchor.id,
      items: 2,
      episodeEdges: 1
    });
    await expect(rebuildDiaryTimelineForMemory(env.DB, secondItem)).resolves.toMatchObject({
      outcome: "diary_timeline_reconciled",
      dayMemoryId: secondItem.id,
      items: 1,
      sequenceMemories: 2,
      sequenceEdges: 1
    });

    await expect(count(
      "SELECT COUNT(*) AS count FROM memories WHERE namespace = 'default' AND status = 'active' AND type = 'timeline_day'"
    )).resolves.toBe(0);
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships WHERE namespace = 'default' AND role = 'day' AND memory_id IN (?, ?)",
      firstAnchor.id,
      secondItem.id
    )).resolves.toBe(2);
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_relations WHERE namespace = 'default' AND relation_type = 'in_episode' AND reason LIKE 'diary_day:%'"
    )).resolves.toBe(1);
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_relations WHERE namespace = 'default' AND relation_type = 'temporal_sequence' AND reason = 'diary_timeline:diary:kld'"
    )).resolves.toBe(1);
  });

  it("treats an empty atomic extraction as a successful terminal split", async () => {
    const diary = await createMemory(env.DB, {
      namespace: "empty-diary-split",
      type: "diary",
      content: "7月20日日记\n今天没有需要单独抽成长期记忆的内容。",
      source: "mcp"
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items: [] }) } }]
    }), { status: 200 }));
    const runtimeEnv = {
      ...env,
      UPSTREAM_BASE_URL: "https://runtime.test/v1",
      UPSTREAM_API_KEY: "runtime-test-key",
      MEMORY_MODEL: "runtime-test-model"
    } as Env;

    const plans = await splitDiaryMemories(runtimeEnv, {
      namespace: "empty-diary-split",
      ids: [diary.id],
      apply: true,
      force: true
    });

    expect(plans).toMatchObject([{
      diary_id: diary.id,
      skipped: false,
      reason: "no_durable_items",
      items: []
    }]);
    await expect(env.DB.prepare(
      `SELECT json_extract(payload_json, '$.outcome') AS outcome,
              CAST(json_extract(payload_json, '$.item_count') AS INTEGER) AS item_count
       FROM memory_events
       WHERE namespace = ? AND memory_id = ? AND event_type = 'diary_split_v2_complete'
       ORDER BY created_at DESC LIMIT 1`
    ).bind("empty-diary-split", diary.id).first()).resolves.toMatchObject({
      outcome: "no_durable_items",
      item_count: 0
    });
    await expect(count(
      "SELECT COUNT(*) AS count FROM memories WHERE namespace = ? AND source = 'timeline_split'",
      "empty-diary-split"
    )).resolves.toBe(0);
  });
});
