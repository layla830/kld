import type { Env, MemoryRecord } from "../types";
import { upsertMemoryCandidate } from "../db/memoryCandidates";
import { getCacheEntry, parseCacheEntryValue, putCacheEntry } from "../db/cacheEntries";

const TIMELINE_BACKFILL_KEY = "maintenance:timeline_backfill";
const TIMELINE_BATCH_SIZE = 100;

export interface TimelineDateProposal {
  id: string;
  thread: string | null;
  fact_key: string | null;
  date: string;
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
  outcome: "already_dated" | "no_explicit_date" | "ambiguous" | "queued";
  dates: string[];
  queued: number;
}

function parseTags(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function extractExplicitDates(text: string): string[] {
  const dates = new Set<string>();
  for (const match of text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  for (const match of text.matchAll(/(20\d{2})年(\d{1,2})月(\d{1,2})日/g)) {
    const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  return [...dates].sort();
}

export async function queueTimelineCandidateForMemory(
  env: Env,
  memory: MemoryRecord
): Promise<TimelineMemoryProjectionResult> {
  const beforeTags = parseTags(memory.tags);
  if (beforeTags.some((tag) => tag.startsWith("date:"))) {
    return { scanned: 1, outcome: "already_dated", dates: [], queued: 0 };
  }
  const dates = extractExplicitDates(memory.content);
  if (dates.length === 0) return { scanned: 1, outcome: "no_explicit_date", dates, queued: 0 };
  if (dates.length > 1) return { scanned: 1, outcome: "ambiguous", dates, queued: 0 };

  const date = dates[0];
  const tags = [...new Set([...beforeTags, `date:${date}`, "timeline"])];
  await upsertMemoryCandidate(env.DB, memory.namespace, {
    externalKey: `timeline-date:${memory.id}:${date}`,
    dreamDate: new Date().toISOString().slice(0, 10),
    action: "timeline_date",
    subject: "memory_timeline",
    targetId: memory.id,
    payload: {
      _kind: "timeline_date",
      date,
      thread: memory.thread,
      fact_key: memory.fact_key,
      before_tags: beforeTags,
      tags
    },
    sourceChunkIds: [],
    sourceChunks: [],
    status: "pending"
  });
  return { scanned: 1, outcome: "queued", dates, queued: 1 };
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
       AND type != 'dream_review'
       AND (tags IS NULL OR tags NOT LIKE '%"date:%')
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
    const dates = extractExplicitDates(memory.content);
    if (dates.length > 1) {
      ambiguous += 1;
      continue;
    }
    if (dates.length !== 1) continue;
    const beforeTags = parseTags(memory.tags);
    proposals.push({
      id: memory.id,
      thread: memory.thread,
      fact_key: memory.fact_key,
      date: dates[0],
      before_tags: beforeTags,
      tags: [...new Set([...beforeTags, `date:${dates[0]}`, "timeline"])]
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
      externalKey: `timeline-date:${proposal.id}:${proposal.date}`,
      dreamDate,
      action: "timeline_date",
      subject: "memory_timeline",
      targetId: proposal.id,
      payload: {
        _kind: "timeline_date",
        date: proposal.date,
        thread: proposal.thread,
        fact_key: proposal.fact_key,
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
       WHERE namespace = ? AND status = 'active' AND type != 'dream_review'
         AND (tags IS NULL OR tags NOT LIKE '%"date:%')`
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
