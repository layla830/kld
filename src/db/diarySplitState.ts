import type { MemoryRecord } from "../types";

export const DIARY_SPLIT_COMPLETE_EVENT = "diary_split_v2_complete";
export const DIARY_SPLIT_INCOMPLETE_EVENT = "diary_split_v2_incomplete";

export async function hasSuccessfulDiarySplit(
  db: D1Database,
  input: { namespace: string; diaryId: string }
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id FROM memory_events
     WHERE namespace = ? AND memory_id = ? AND event_type = ?
       AND COALESCE(CAST(json_extract(payload_json, '$.item_count') AS INTEGER), 0) > 0
     LIMIT 1`
  ).bind(input.namespace, input.diaryId, DIARY_SPLIT_COMPLETE_EVENT).first<{ id: string }>();
  return Boolean(row?.id);
}

export async function hasActiveV2DiaryDay(
  db: D1Database,
  input: { namespace: string; diaryId: string }
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT split.id FROM memories AS split
     WHERE split.namespace = ? AND split.status IN ('active','review')
       AND split.source = 'timeline_split' AND split.type = 'timeline_day'
       AND EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(split.tags) THEN split.tags ELSE '[]' END)
         WHERE value = ?
       )
       AND EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(split.tags) THEN split.tags ELSE '[]' END)
         WHERE value = 'split_version:v2'
       )
     LIMIT 1`
  ).bind(input.namespace, `origin:${input.diaryId}`).first<{ id: string }>();
  return Boolean(row?.id);
}

export async function listMissedDiarySplitCandidates(
  db: D1Database,
  input: { namespace: string; createdBefore: string; limit: number }
): Promise<MemoryRecord[]> {
  const result = await db.prepare(
    `SELECT m.* FROM memories AS m
     WHERE m.namespace = ? AND m.status = 'active' AND m.type IN ('diary','layla_diary')
       AND m.created_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM memory_events AS event
         WHERE event.namespace = m.namespace AND event.memory_id = m.id
           AND event.event_type = ?
           AND COALESCE(CAST(json_extract(event.payload_json, '$.item_count') AS INTEGER), 0) > 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM memories AS split
         WHERE split.namespace = m.namespace AND split.status IN ('active','review')
           AND split.source = 'timeline_split' AND split.type = 'timeline_day'
           AND EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(split.tags) THEN split.tags ELSE '[]' END)
             WHERE value = 'origin:' || m.id
           )
           AND EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(split.tags) THEN split.tags ELSE '[]' END)
             WHERE value = 'split_version:v2'
           )
       )
       AND NOT EXISTS (
         SELECT 1 FROM memories AS split
         WHERE split.namespace = m.namespace AND split.status IN ('active','review')
           AND split.source = 'timeline_split'
           AND EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(split.tags) THEN split.tags ELSE '[]' END)
             WHERE value = 'origin:' || m.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(split.tags) THEN split.tags ELSE '[]' END)
             WHERE value = 'split_version:v2'
           )
       )
       AND NOT EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(m.tags) THEN m.tags ELSE '[]' END)
         WHERE value = 'has_timeline_split'
       )
     ORDER BY m.created_at ASC
     LIMIT ?`
  ).bind(
    input.namespace,
    input.createdBefore,
    DIARY_SPLIT_COMPLETE_EVENT,
    Math.min(Math.max(Math.floor(input.limit), 1), 100)
  ).all<MemoryRecord>();
  return result.results ?? [];
}
