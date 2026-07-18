import { replaceOwnedDiaryTimelineRelations } from "../db/memoryRelations";
import type { MemoryRecord } from "../types";
import { nowIso } from "../utils/time";
import { DIARY_SPLIT_SOURCE_TYPE } from "./diaryPolicy";

const DIARY_TIMELINE_SOURCE = "timeline_split";
const DATE_TAG = /^date:(20\d{2}-\d{2}-\d{2})$/;
const ORIGIN_TAG = /^origin:(.+)$/;

interface DiaryTimelineMembershipRecord {
  namespace: string;
  memory_id: string;
  origin_diary_id: string;
  timeline_key: string;
  event_date: string;
  role: "day" | "item";
  day_memory_id: string;
  updated_at: string;
}

interface DiaryTimelineDescriptor {
  originDiaryId: string;
  timelineKey: string;
  eventDate: string;
}

interface DiaryTimelineGroupResult {
  originDiaryId: string;
  eventDate: string;
  timelineKey: string | null;
  outcome: "reconciled" | "missing_day_node" | "multiple_day_nodes" | "no_active_items";
  items: number;
  dayMemoryId: string | null;
  episodeEdges: number;
}

export interface DiaryTimelineProjectionResult {
  outcome: "diary_timeline_reconciled" | "diary_timeline_incomplete" | "not_diary_split";
  originDiaryId: string | null;
  eventDate: string | null;
  timelineKey: string | null;
  dayMemoryId: string | null;
  items: number;
  episodeEdges: number;
  sequenceMemories: number;
  sequenceEdges: number;
  reason?: "missing_day_node" | "multiple_day_nodes" | "no_active_items";
}

function tagsOf(memory: MemoryRecord): string[] {
  try {
    const parsed = JSON.parse(memory.tags || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function singleTagValue(tags: string[], pattern: RegExp): string | null {
  const values = tags.flatMap((tag) => tag.match(pattern)?.[1] ?? []);
  return values.length === 1 ? values[0] : null;
}

function timelineKeyForDiaryType(type: string): string | null {
  if (type === DIARY_SPLIT_SOURCE_TYPE) return "diary:kld";
  return null;
}

async function descriptorForMemory(db: D1Database, memory: MemoryRecord): Promise<DiaryTimelineDescriptor | null> {
  if (memory.status !== "active" || memory.source !== DIARY_TIMELINE_SOURCE) return null;
  const tags = tagsOf(memory);
  const eventDate = singleTagValue(tags, DATE_TAG);
  const originDiaryId = singleTagValue(tags, ORIGIN_TAG);
  if (!eventDate || !originDiaryId) return null;
  const diary = await db.prepare(
    "SELECT type FROM memories WHERE namespace = ? AND id = ? AND type = ? LIMIT 1"
  ).bind(memory.namespace, originDiaryId, DIARY_SPLIT_SOURCE_TYPE).first<{ type: string }>();
  const timelineKey = diary ? timelineKeyForDiaryType(diary.type) : null;
  return timelineKey ? { originDiaryId, timelineKey, eventDate } : null;
}

async function listActiveDiaryItems(
  db: D1Database,
  input: { namespace: string; originDiaryId: string; eventDate: string }
): Promise<MemoryRecord[]> {
  const rows = await db.prepare(
    `SELECT memory.* FROM memories AS memory
     WHERE memory.namespace = ? AND memory.status = 'active' AND memory.source = ?
       AND EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(memory.tags) THEN memory.tags ELSE '[]' END)
         WHERE value = ?
       )
       AND EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(memory.tags) THEN memory.tags ELSE '[]' END)
         WHERE value = ?
       )
     ORDER BY memory.created_at, memory.id`
  ).bind(
    input.namespace,
    DIARY_TIMELINE_SOURCE,
    `origin:${input.originDiaryId}`,
    `date:${input.eventDate}`
  ).all<MemoryRecord>();
  return (rows.results ?? []).filter((memory) => {
    const tags = tagsOf(memory);
    return singleTagValue(tags, ORIGIN_TAG) === input.originDiaryId
      && singleTagValue(tags, DATE_TAG) === input.eventDate;
  });
}

async function clearDiaryDayGroup(
  db: D1Database,
  input: { namespace: string; originDiaryId: string; eventDate: string }
): Promise<void> {
  await db.prepare(
    `DELETE FROM memory_diary_timeline_memberships
     WHERE namespace = ? AND origin_diary_id = ? AND event_date = ?`
  ).bind(input.namespace, input.originDiaryId, input.eventDate).run();
  await replaceOwnedDiaryTimelineRelations(db, {
    namespace: input.namespace,
    ownerKey: `${input.originDiaryId}:${input.eventDate}`,
    relationType: "in_episode",
    edges: []
  });
}

async function reconcileDiaryDayGroup(
  db: D1Database,
  input: { namespace: string; originDiaryId: string; eventDate: string; timelineKey: string }
): Promise<DiaryTimelineGroupResult> {
  const items = await listActiveDiaryItems(db, input);
  const dayNodes = items.filter((memory) => memory.type === "timeline_day");
  if (items.length === 0 || dayNodes.length !== 1) {
    await clearDiaryDayGroup(db, input);
    return {
      originDiaryId: input.originDiaryId,
      eventDate: input.eventDate,
      timelineKey: input.timelineKey,
      outcome: items.length === 0 ? "no_active_items" : dayNodes.length === 0 ? "missing_day_node" : "multiple_day_nodes",
      items: items.length,
      dayMemoryId: null,
      episodeEdges: 0
    };
  }

  const dayMemoryId = dayNodes[0].id;
  const now = nowIso();
  const ids = items.map((memory) => memory.id);
  const placeholders = ids.map(() => "?").join(", ");
  const upserts = items.map((memory) => db.prepare(
    `INSERT INTO memory_diary_timeline_memberships (
       namespace, memory_id, origin_diary_id, timeline_key, event_date, role, day_memory_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, memory_id) DO UPDATE SET
       origin_diary_id = excluded.origin_diary_id,
       timeline_key = excluded.timeline_key,
       event_date = excluded.event_date,
       role = excluded.role,
       day_memory_id = excluded.day_memory_id,
       updated_at = excluded.updated_at`
  ).bind(
    input.namespace,
    memory.id,
    input.originDiaryId,
    input.timelineKey,
    input.eventDate,
    memory.id === dayMemoryId ? "day" : "item",
    dayMemoryId,
    now
  ));
  await db.batch([
    ...upserts,
    db.prepare(
      `DELETE FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND origin_diary_id = ? AND event_date = ?
         AND memory_id NOT IN (${placeholders})`
    ).bind(input.namespace, input.originDiaryId, input.eventDate, ...ids)
  ]);

  const episode = await replaceOwnedDiaryTimelineRelations(db, {
    namespace: input.namespace,
    ownerKey: `${input.originDiaryId}:${input.eventDate}`,
    relationType: "in_episode",
    edges: items
      .filter((memory) => memory.id !== dayMemoryId)
      .map((memory) => ({ sourceMemoryId: memory.id, targetMemoryId: dayMemoryId }))
  });
  return {
    originDiaryId: input.originDiaryId,
    eventDate: input.eventDate,
    timelineKey: input.timelineKey,
    outcome: "reconciled",
    items: items.length,
    dayMemoryId,
    episodeEdges: episode.expected
  };
}

async function rebuildDiaryTimelineSequence(
  db: D1Database,
  namespace: string,
  timelineKey: string
): Promise<{ memories: number; expected: number; inserted: number }> {
  const rows = await db.prepare(
    `SELECT membership.memory_id, membership.event_date
     FROM memory_diary_timeline_memberships AS membership
     JOIN memories AS memory
       ON memory.namespace = membership.namespace AND memory.id = membership.memory_id
     WHERE membership.namespace = ? AND membership.timeline_key = ? AND membership.role = 'day'
       AND memory.status = 'active' AND memory.type = 'timeline_day'
     ORDER BY membership.event_date, membership.memory_id`
  ).bind(namespace, timelineKey).all<{ memory_id: string; event_date: string }>();
  const canonicalByDate = new Map<string, string>();
  for (const row of rows.results ?? []) {
    if (!canonicalByDate.has(row.event_date)) canonicalByDate.set(row.event_date, row.memory_id);
  }
  const dayNodes = [...canonicalByDate].map(([eventDate, memoryId]) => ({ eventDate, memoryId }));
  const edges = dayNodes.slice(1).map((node, index) => ({
    sourceMemoryId: dayNodes[index].memoryId,
    targetMemoryId: node.memoryId
  }));
  const result = await replaceOwnedDiaryTimelineRelations(db, {
    namespace,
    ownerKey: timelineKey,
    relationType: "temporal_sequence",
    edges
  });
  return { memories: dayNodes.length, ...result };
}

export async function rebuildDiaryTimelineForMemory(
  db: D1Database,
  memory: MemoryRecord
): Promise<DiaryTimelineProjectionResult | null> {
  const previous = await db.prepare(
    `SELECT * FROM memory_diary_timeline_memberships
     WHERE namespace = ? AND memory_id = ?`
  ).bind(memory.namespace, memory.id).first<DiaryTimelineMembershipRecord>();
  const current = await descriptorForMemory(db, memory);
  if (!previous && !current) return null;

  const groups = new Map<string, { originDiaryId: string; eventDate: string; timelineKey: string }>();
  if (previous) {
    groups.set(`${previous.origin_diary_id}\n${previous.event_date}`, {
      originDiaryId: previous.origin_diary_id,
      eventDate: previous.event_date,
      timelineKey: previous.timeline_key
    });
  }
  if (current) {
    groups.set(`${current.originDiaryId}\n${current.eventDate}`, current);
  }

  const groupResults: DiaryTimelineGroupResult[] = [];
  for (const group of groups.values()) {
    groupResults.push(await reconcileDiaryDayGroup(db, {
      namespace: memory.namespace,
      ...group
    }));
  }

  const timelineKeys = new Set([...groups.values()].map((group) => group.timelineKey));
  const sequences = new Map<string, { memories: number; expected: number; inserted: number }>();
  for (const timelineKey of timelineKeys) {
    sequences.set(timelineKey, await rebuildDiaryTimelineSequence(db, memory.namespace, timelineKey));
  }

  if (!current) {
    return {
      outcome: "not_diary_split",
      originDiaryId: previous?.origin_diary_id ?? null,
      eventDate: previous?.event_date ?? null,
      timelineKey: previous?.timeline_key ?? null,
      dayMemoryId: null,
      items: 0,
      episodeEdges: 0,
      sequenceMemories: sequences.get(previous?.timeline_key ?? "")?.memories ?? 0,
      sequenceEdges: sequences.get(previous?.timeline_key ?? "")?.expected ?? 0
    };
  }

  const group = groupResults.find((result) => result.originDiaryId === current.originDiaryId && result.eventDate === current.eventDate)!;
  const sequence = sequences.get(current.timelineKey) ?? { memories: 0, expected: 0, inserted: 0 };
  return {
    outcome: group.outcome === "reconciled" ? "diary_timeline_reconciled" : "diary_timeline_incomplete",
    originDiaryId: current.originDiaryId,
    eventDate: current.eventDate,
    timelineKey: current.timelineKey,
    dayMemoryId: group.dayMemoryId,
    items: group.items,
    episodeEdges: group.episodeEdges,
    sequenceMemories: sequence.memories,
    sequenceEdges: sequence.expected,
    ...(group.outcome === "reconciled" ? {} : { reason: group.outcome })
  };
}
