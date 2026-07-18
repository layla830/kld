import type { Env, MemoryRecord } from "../types";
import { nowIso } from "../utils/time";
import { ensureVerbatimTimelineDay } from "./diarySplit";
import { rebuildDiaryTimelineForMemory } from "./diaryTimeline";

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

function coverageForDiary(diary: MemoryRecord, items: MemoryRecord[]): DiaryTimelineCoverageRow {
  const dated = items.flatMap((memory) => {
    const date = singleDate(memory);
    return date ? [{ memory, date }] : [];
  });
  const dates = [...new Set(dated.map((item) => item.date))].sort();
  const timelineDays = dated.filter((item) => item.memory.type === "timeline_day").length;
  const dayCountByDate = new Map<string, number>();
  for (const item of dated) {
    if (item.memory.type === "timeline_day") dayCountByDate.set(item.date, (dayCountByDate.get(item.date) ?? 0) + 1);
  }
  const lowCoverageReasons: DiaryTimelineCoverageRow["lowCoverageReasons"] = [];
  if (items.length === 0) lowCoverageReasons.push("no_split_items");
  const missingTimelineDates = dates.filter((date) => (dayCountByDate.get(date) ?? 0) === 0);
  if (missingTimelineDates.length > 0) lowCoverageReasons.push("missing_timeline_day");
  if ([...dayCountByDate.values()].some((count) => count > 1)) lowCoverageReasons.push("multiple_timeline_days");
  if (dated.length !== items.length) lowCoverageReasons.push("undated_items");
  return {
    diaryId: diary.id,
    diaryType: diary.type,
    dates,
    activeItems: items.length,
    timelineDays,
    missingTimelineDates,
    undatedItems: items.length - dated.length,
    lowCoverageReasons,
    backfilled: false,
    repairedTimelineDays: 0
  };
}

async function markLatestSkippedXRunsApplied(db: D1Database, namespace: string, diaryId: string): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `UPDATE memory_five_axis_runs AS run
     SET status = 'applied',
         result_json = json_object('outcome', 'diary_timeline_reconciled', 'originDiaryId', ?, 'backfill', 1),
         last_error = NULL, claim_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
     WHERE run.namespace = ? AND run.axis = 'X' AND run.status = 'skipped'
       AND run.memory_id IN (
         SELECT memory_id FROM memory_diary_timeline_memberships
         WHERE namespace = ? AND origin_diary_id = ?
       )
       AND run.memory_revision = (
         SELECT MAX(latest.memory_revision) FROM memory_five_axis_runs AS latest
         WHERE latest.namespace = run.namespace AND latest.memory_id = run.memory_id AND latest.axis = 'X'
       )`
  ).bind(diaryId, now, now, namespace, namespace, diaryId).run();
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
     WHERE namespace = ? AND status = 'active' AND type IN ('diary','layla_diary') AND id > ?
     ORDER BY id LIMIT ?`
  ).bind(namespace, cursor, limit + 1).all<MemoryRecord>();
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
    const items = split.results ?? [];
    const coverage = coverageForDiary(diary, items);
    const canRepairMissingDays = coverage.missingTimelineDates.length > 0
      && coverage.lowCoverageReasons.every((reason) => reason === "missing_timeline_day");
    if (options.apply && (coverage.lowCoverageReasons.length === 0 || canRepairMissingDays)) {
      const repairedDays: MemoryRecord[] = [];
      if (canRepairMissingDays) {
        for (const date of coverage.missingTimelineDates) {
          repairedDays.push(await ensureVerbatimTimelineDay(env, { namespace, diary, date }));
        }
      }
      for (const day of [...items.filter((memory) => memory.type === "timeline_day"), ...repairedDays]) {
        await rebuildDiaryTimelineForMemory(env.DB, day);
      }
      await markLatestSkippedXRunsApplied(env.DB, namespace, diary.id);
      coverage.backfilled = true;
      coverage.repairedTimelineDays = repairedDays.length;
      coverage.timelineDays += repairedDays.length;
      coverage.activeItems += repairedDays.length;
      coverage.missingTimelineDates = [];
      coverage.lowCoverageReasons = [];
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
