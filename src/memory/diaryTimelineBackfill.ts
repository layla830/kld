import type { Env, MemoryRecord } from "../types";
import { DIARY_SPLIT_SOURCE_TYPE } from "./diaryPolicy";
import { rebuildDiaryTimelineForMemory } from "./diaryTimeline";
import { patchSyncedMemory } from "./state";

const TIMELINE_SOURCE = "timeline_split";
const DATE_TAG = /^date:(20\d{2}-\d{2}-\d{2})$/;

export interface DiaryTimelineCoverageRow {
  diaryId: string;
  diaryType: string;
  dates: string[];
  activeItems: number;
  timelineDays: number;
  missingTimelineDates: string[];
  undatedItems: number;
  lowCoverageReasons: Array<"no_split_items" | "missing_timeline_day" | "multiple_timeline_days" | "undated_items">;
  backfilled: boolean;
  repairedTimelineDays: number;
}

export interface DiaryTimelineBackfillResult {
  scanned: number;
  eligible: number;
  lowCoverage: number;
  backfilled: number;
  nextCursor: string | null;
  hasMore: boolean;
  rows: DiaryTimelineCoverageRow[];
}

function tagsOf(memory: MemoryRecord): string[] {
  try {
    const parsed = JSON.parse(memory.tags || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function singleDate(memory: MemoryRecord): string | null {
  const dates = tagsOf(memory).flatMap((tag) => tag.match(DATE_TAG)?.[1] ?? []);
  return dates.length === 1 ? dates[0] : null;
}

function coverageForDiary(diary: MemoryRecord, allItems: MemoryRecord[]): DiaryTimelineCoverageRow {
  const timelineDays = allItems.filter((memory) => memory.type === "timeline_day").length;
  const items = allItems.filter((memory) => memory.type !== "timeline_day");
  const dated = items.flatMap((memory) => {
    const date = singleDate(memory);
    return date ? [{ memory, date }] : [];
  });
  const dates = [...new Set(dated.map((item) => item.date))].sort();
  const lowCoverageReasons: DiaryTimelineCoverageRow["lowCoverageReasons"] = [];
  if (items.length === 0) lowCoverageReasons.push("no_split_items");
  if (dated.length !== items.length) lowCoverageReasons.push("undated_items");
  return {
    diaryId: diary.id,
    diaryType: diary.type,
    dates,
    activeItems: items.length,
    timelineDays,
    missingTimelineDates: [],
    undatedItems: items.length - dated.length,
    lowCoverageReasons,
    backfilled: false,
    repairedTimelineDays: 0
  };
}

async function retireLegacyDayNodes(env: Env, namespace: string, nodes: MemoryRecord[]): Promise<void> {
  for (const node of nodes) {
    if (node.type !== "timeline_day") continue;
    await patchSyncedMemory(env, namespace, node.id, {
      status: "deleted",
      activeFact: false,
      pinned: false
    }, {
      source: "system",
      reason: "retire_legacy_timeline_day",
      expectedStatus: node.status,
      expectedRevision: node.five_axis_revision ?? 1
    });
  }
}

export async function scanDiaryTimelineBackfill(
  env: Env,
  namespace: string,
  options: { apply?: boolean; cursor?: string | null; limit?: number } = {}
): Promise<DiaryTimelineBackfillResult> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 100);
  const cursor = options.cursor?.trim() || "";
  const result = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND type = ? AND id > ?
     ORDER BY id LIMIT ?`
  ).bind(namespace, DIARY_SPLIT_SOURCE_TYPE, cursor, limit + 1).all<MemoryRecord>();
  const all = result.results ?? [];
  const hasMore = all.length > limit;
  const diaries = all.slice(0, limit);
  const rows: DiaryTimelineCoverageRow[] = [];

  for (const diary of diaries) {
    const split = await env.DB.prepare(
      `SELECT * FROM memories AS memory
       WHERE memory.namespace = ? AND memory.status = 'active' AND memory.source = ?
         AND EXISTS (
           SELECT 1 FROM json_each(CASE WHEN json_valid(memory.tags) THEN memory.tags ELSE '[]' END)
           WHERE value = ?
         )
       ORDER BY memory.created_at, memory.id`
    ).bind(namespace, TIMELINE_SOURCE, `origin:${diary.id}`).all<MemoryRecord>();
    const allItems = split.results ?? [];
    const items = allItems.filter((memory) => memory.type !== "timeline_day");
    const legacyDays = allItems.filter((memory) => memory.type === "timeline_day");
    const coverage = coverageForDiary(diary, allItems);
    if (options.apply) {
      await retireLegacyDayNodes(env, namespace, legacyDays);
      const representativeByDate = new Map<string, MemoryRecord>();
      for (const item of items) {
        const date = singleDate(item);
        if (date && !representativeByDate.has(date)) representativeByDate.set(date, item);
      }
      for (const item of representativeByDate.values()) {
        await rebuildDiaryTimelineForMemory(env.DB, item);
      }
      coverage.backfilled = representativeByDate.size > 0 || legacyDays.length > 0;
      coverage.timelineDays = 0;
      coverage.missingTimelineDates = [];
      coverage.repairedTimelineDays = 0;
    }
    rows.push(coverage);
  }

  return {
    scanned: rows.length,
    eligible: rows.filter((row) => row.lowCoverageReasons.length === 0).length,
    lowCoverage: rows.filter((row) => row.lowCoverageReasons.length > 0).length,
    backfilled: rows.filter((row) => row.backfilled).length,
    nextCursor: hasMore ? diaries.at(-1)?.id ?? null : null,
    hasMore,
    rows
  };
}
