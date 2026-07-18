import type { Env, MemoryRecord } from "../types";
import { upsertMemoryCandidate } from "../db/memoryCandidates";
import { getCacheEntry, parseCacheEntryValue, putCacheEntry } from "../db/cacheEntries";
import { rebuildTimelineSequenceForMemory } from "./timelineRelations";
import { rebuildDiaryTimelineForMemory, type DiaryTimelineProjectionResult } from "./diaryTimeline";
import { analyzeTimelineDateTags, extractExplicitDates } from "./timelineDates";

export { extractExplicitDates } from "./timelineDates";

const TIMELINE_BACKFILL_KEY = "maintenance:timeline_backfill";
const TIMELINE_BATCH_SIZE = 100;

export interface TimelineDateProposal {
  id: string;
  updated_at: string;
  thread: string | null;
  fact_key: string | null;
  date: string | null;
  date_options: string[];
  repair: boolean;
  before_tags: string[];
  tags: string[];
}

export interface TimelineBackfillStatus {
  cursor: string | null;
  scanned: number;
  dated: number;
  ambiguous: number;
  queued: number;
  total: number;
  complete: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
}

export interface TimelineMemoryProjectionResult {
  scanned: 1;
  outcome: "already_dated" | "reconciled" | "diary_reconciled" | "diary_incomplete" | "no_explicit_date" | "ambiguous" | "queued";
  dates: string[];
  queued: number;
  candidateExternalKeys?: string[];
  sequence?: Awaited<ReturnType<typeof rebuildTimelineSequenceForMemory>>;
  diary?: DiaryTimelineProjectionResult;
}

function timelineCandidateExternalKey(
  memory: Pick<MemoryRecord, "id" | "updated_at">,
  date: string | null,
  repair: boolean
): string {
  return repair
    ? `timeline-date-repair:${memory.id}:${encodeURIComponent(memory.updated_at)}`
    : `timeline-date:${memory.id}:${date}`;
}

function parseTags(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function queueTimelineDateCandidate(
  env: Env,
  memory: MemoryRecord,
  input: { beforeTags: string[]; dateOptions: string[]; repair: boolean }
): Promise<TimelineMemoryProjectionResult> {
  const date = input.dateOptions.length === 1 ? input.dateOptions[0] : null;
  const tags = date
    ? [...new Set([...input.beforeTags.filter((tag) => !tag.startsWith("date:")), `date:${date}`, "timeline"])]
    : [...input.beforeTags];
  const candidateExternalKey = timelineCandidateExternalKey(memory, date, input.repair);
  await upsertMemoryCandidate(env.DB, memory.namespace, {
    externalKey: candidateExternalKey,
    dreamDate: new Date().toISOString().slice(0, 10),
    action: "timeline_date",
    subject: "memory_timeline",
    targetId: memory.id,
    payload: {
      _kind: input.repair ? "timeline_date_repair" : "timeline_date",
      date,
      date_options: input.dateOptions,
      allow_manual_date: input.dateOptions.length === 0,
      thread: memory.thread,
      fact_key: memory.fact_key,
      target_updated_at: memory.updated_at,
      before_tags: input.beforeTags,
      tags
    },
    sourceChunkIds: [],
    sourceChunks: [],
    status: "pending"
  });
  return {
    scanned: 1,
    outcome: "queued",
    dates: input.dateOptions,
    queued: 1,
    candidateExternalKeys: [candidateExternalKey]
  };
}

export async function queueTimelineCandidateForMemory(
  env: Env,
  memory: MemoryRecord
): Promise<TimelineMemoryProjectionResult> {
  const beforeTags = parseTags(memory.tags);
  const tagAnalysis = analyzeTimelineDateTags(beforeTags);
  const approvedDates = tagAnalysis.validDates;
  if (tagAnalysis.dateTags.length > 0 && !tagAnalysis.isCanonical) {
    const options = [...new Set([...approvedDates, ...extractExplicitDates(memory.content)])].sort();
    return queueTimelineDateCandidate(env, memory, { beforeTags, dateOptions: options, repair: true });
  }
  if (tagAnalysis.isCanonical) {
    if (approvedDates.length === 1 && memory.source === "timeline_split") {
      const diary = await rebuildDiaryTimelineForMemory(env.DB, memory);
      if (diary) {
        return {
          scanned: 1,
          outcome: diary.outcome === "diary_timeline_reconciled" ? "diary_reconciled" : "diary_incomplete",
          dates: approvedDates,
          queued: 0,
          diary
        };
      }
    }
    if (approvedDates.length === 1 && memory.thread && memory.fact_key) {
      const sequence = await rebuildTimelineSequenceForMemory(env.DB, memory);
      return { scanned: 1, outcome: "reconciled", dates: approvedDates, queued: 0, sequence };
    }
    return { scanned: 1, outcome: "already_dated", dates: approvedDates, queued: 0 };
  }
  const dates = extractExplicitDates(memory.content);
  if (dates.length === 0) return { scanned: 1, outcome: "no_explicit_date", dates, queued: 0 };
  return queueTimelineDateCandidate(env, memory, { beforeTags, dateOptions: dates, repair: dates.length > 1 });
}

export async function runTimelineBackfill(env: Env, namespace: string, options: { cursor?: string | null; limit?: number } = {}): Promise<{
  scanned: number;
  dated: number;
  ambiguous: number;
  nextCursor: string | null;
  hasMore: boolean;
  proposals: TimelineDateProposal[];
}> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? TIMELINE_BATCH_SIZE), 1), TIMELINE_BATCH_SIZE);
  const cursor = options.cursor?.trim() || "";
  const rows = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
       AND id > ?
     ORDER BY id
     LIMIT ?`
  ).bind(namespace, cursor, limit + 1).all<MemoryRecord>();
  const allRows = rows.results ?? [];
  const hasMore = allRows.length > limit;
  const pageRows = allRows.slice(0, limit);

  const proposals: TimelineDateProposal[] = [];
  let ambiguous = 0;
  for (const memory of pageRows) {
    const beforeTags = parseTags(memory.tags);
    const tagAnalysis = analyzeTimelineDateTags(beforeTags);
    if (tagAnalysis.isCanonical) continue;
    const dates = [...new Set([...tagAnalysis.validDates, ...extractExplicitDates(memory.content)])].sort();
    if (tagAnalysis.dateTags.length === 0 && dates.length === 0) continue;
    if (dates.length !== 1) ambiguous += 1;
    const date = dates.length === 1 ? dates[0] : null;
    proposals.push({
      id: memory.id,
      updated_at: memory.updated_at,
      thread: memory.thread,
      fact_key: memory.fact_key,
      date,
      date_options: dates,
      repair: tagAnalysis.dateTags.length > 0 || dates.length > 1,
      before_tags: beforeTags,
      tags: date
        ? [...new Set([...beforeTags.filter((tag) => !tag.startsWith("date:")), `date:${date}`, "timeline"])]
        : [...beforeTags]
    });
  }

  return {
    scanned: pageRows.length,
    dated: proposals.length,
    ambiguous,
    nextCursor: hasMore ? pageRows.at(-1)?.id ?? null : null,
    hasMore,
    proposals
  };
}

export async function queueTimelineBackfill(env: Env, namespace: string, cursor: string | null = null): Promise<{
  scanned: number;
  dated: number;
  ambiguous: number;
  queued: number;
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const result = await runTimelineBackfill(env, namespace, { cursor });
  const dreamDate = new Date().toISOString().slice(0, 10);
  for (const proposal of result.proposals) {
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey: timelineCandidateExternalKey(proposal, proposal.date, proposal.repair),
      dreamDate,
      action: "timeline_date",
      subject: "memory_timeline",
      targetId: proposal.id,
      payload: {
        _kind: proposal.repair ? "timeline_date_repair" : "timeline_date",
        date: proposal.date,
        date_options: proposal.date_options,
        allow_manual_date: proposal.date_options.length === 0,
        thread: proposal.thread,
        fact_key: proposal.fact_key,
        target_updated_at: proposal.updated_at,
        before_tags: proposal.before_tags,
        tags: proposal.tags
      },
      sourceChunkIds: [],
      sourceChunks: [],
      status: "pending"
    });
  }
  return { scanned: result.scanned, dated: result.dated, ambiguous: result.ambiguous, queued: result.proposals.length, nextCursor: result.nextCursor, hasMore: result.hasMore };
}

function emptyStatus(): TimelineBackfillStatus {
  return { cursor: null, scanned: 0, dated: 0, ambiguous: 0, queued: 0, total: 0, complete: false, startedAt: null, lastRunAt: null };
}

function parseStatus(value: unknown): TimelineBackfillStatus {
  if (!value || typeof value !== "object") return emptyStatus();
  const row = value as Partial<TimelineBackfillStatus>;
  return {
    cursor: typeof row.cursor === "string" ? row.cursor : null,
    scanned: Number(row.scanned) || 0,
    dated: Number(row.dated) || 0,
    ambiguous: Number(row.ambiguous) || 0,
    queued: Number(row.queued) || 0,
    total: Number(row.total) || 0,
    complete: row.complete === true,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
    lastRunAt: typeof row.lastRunAt === "string" ? row.lastRunAt : null
  };
}

export async function getTimelineBackfillStatus(env: Env, namespace: string): Promise<TimelineBackfillStatus> {
  const entry = await getCacheEntry(env.DB, { namespace, key: TIMELINE_BACKFILL_KEY });
  return entry ? parseStatus(parseCacheEntryValue(entry)) : emptyStatus();
}

export async function scanTimelineBackfillPage(env: Env, namespace: string, reset = false): Promise<TimelineBackfillStatus> {
  let status = reset ? emptyStatus() : await getTimelineBackfillStatus(env, namespace);
  if (status.complete && !reset) return status;
  if (!status.startedAt) {
    const total = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memories
       WHERE namespace = ? AND status = 'active'
         AND type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')`
    ).bind(namespace).first<{ count: number }>();
    status = { ...status, total: total?.count ?? 0, startedAt: new Date().toISOString() };
  }
  const page = await queueTimelineBackfill(env, namespace, status.cursor);
  const now = new Date().toISOString();
  const next: TimelineBackfillStatus = {
    ...status,
    cursor: page.nextCursor,
    scanned: status.scanned + page.scanned,
    dated: status.dated + page.dated,
    ambiguous: status.ambiguous + page.ambiguous,
    queued: status.queued + page.queued,
    complete: !page.hasMore,
    lastRunAt: now
  };
  await putCacheEntry(env.DB, {
    namespace,
    key: TIMELINE_BACKFILL_KEY,
    value: next,
    contentType: "application/json",
    tags: ["maintenance", "timeline-backfill"]
  });
  return next;
}
