import { createMemory } from "../db/memories";
import { upsertMemoryCandidate } from "../db/memoryCandidates";
import { createMemoryEvent } from "../db/memoryEvents";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { upsertMemoryEmbedding } from "./embedding";
import { DIARY_SPLIT_SOURCE_TYPE, isActiveDiarySplitSource } from "./diaryPolicy";
import { removeMemoryVector } from "./state";
import {
  DIARY_SPLIT_COMPLETE_EVENT,
  DIARY_SPLIT_INCOMPLETE_EVENT,
  hasActiveV2DiaryDay,
  hasSuccessfulDiarySplit
} from "../db/diarySplitState";
import { dateFromDiary, datesFromDiary, normalizeDate } from "./diarySplitDates";
import {
  buildVerbatimTimelineDay,
  MAX_ITEMS_PER_DIARY,
  parseItemsWithDebug,
  splitItemKey,
  SPLIT_VERSION_TAG,
  type DiarySplitDebug,
  type DiarySplitItem
} from "./diarySplitParse";
import { buildSplitPrompt } from "./diarySplitPrompt";
import { cleanImporter } from "./diarySplitImporter";

export { dateFromDiary };
export type { DiarySplitItem };

const TIMELINE_SOURCE = "timeline_split";
const DEFAULT_SPLIT_MODEL = "deepseek/deepseek-v4-flash";

export interface DiarySplitPlan {
  diary_id: string;
  date: string;
  skipped: boolean;
  reason?: string;
  existing_count?: number;
  items: DiarySplitItem[];
  created_ids?: string[];
  candidate_keys?: string[];
  debug?: DiarySplitDebug;
}

export interface SplitDiaryInput {
  namespace: string;
  ids?: string[];
  dates?: string[];
  apply: boolean;
  force?: boolean;
  debug?: boolean;
  replaceImporter?: string;
}

async function callSplitModel(env: Env, record: MemoryRecord, date: string, includeDebug: boolean): Promise<{ items: DiarySplitItem[]; debug?: DiarySplitDebug }> {
  const allowedDates = datesFromDiary(record, date);
  const model = env.CC_CONNECT_CHUNK_EXTRACT_MODEL || env.MEMORY_MODEL || env.AUTO_CHUNK_SUMMARY_MODEL || env.CHAT_MODEL || DEFAULT_SPLIT_MODEL;
  const basePrompt = buildSplitPrompt(record, date, allowedDates);
  let lastMissingDates: string[] = [];
  let lastResult: { items: DiarySplitItem[]; debug?: DiarySplitDebug } = { items: [] };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "You are a strict JSON generator for Chinese memory extraction. Output JSON only. Do not explain or show reasoning." },
        {
          role: "user",
          content: attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nYour previous output was invalid because these required dates had no timeline_day: ${lastMissingDates.join(", ")}. Return exactly one timeline_day for the default date and every date represented by any item.`
        }
      ],
      temperature: 0.1,
      max_tokens: 4200,
      response_format: { type: "json_object" },
      stream: false
    };

    const response = await callOpenAICompat(env, request);
    if (!response.ok) throw new Error(`split model failed: ${response.status}`);

    const parsed = (await response.json()) as OpenAIChatResponse;
    const message = parsed.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoningContent = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    const text = content || reasoningContent;
    const result = parseItemsWithDebug(text, date, allowedDates, record.id, record.content, includeDebug);
    lastResult = result;
    const representedDates = new Set(result.items.map((item) => item.date));
    const timelineDates = new Set(result.items.filter((item) => item.type === "timeline_day").map((item) => item.date));
    const requiredDates = new Set([date, ...representedDates]);
    lastMissingDates = [...requiredDates].filter((itemDate) => !timelineDates.has(itemDate));
    if (lastMissingDates.length === 0) return result;
  }

  const fallbacks = lastMissingDates.map((itemDate) => buildVerbatimTimelineDay(record, itemDate));
  return {
    items: [...fallbacks, ...lastResult.items].slice(0, MAX_ITEMS_PER_DIARY),
    debug: lastResult.debug ? { ...lastResult.debug, fallback: "verbatim_timeline_day" } : undefined
  };
}

async function existingSplitCount(db: D1Database, input: { namespace: string; originId: string }): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active' AND source = ? AND tags LIKE ?")
    .bind(input.namespace, TIMELINE_SOURCE, `%origin:${input.originId}%`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function existingV2SplitCount(db: D1Database, input: { namespace: string; originId: string }): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active' AND source = ? AND tags LIKE ? AND tags LIKE ?")
    .bind(input.namespace, TIMELINE_SOURCE, `%origin:${input.originId}%`, `%${SPLIT_VERSION_TAG}%`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function existingSplitItemId(db: D1Database, namespace: string, itemKey: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM memories WHERE namespace = ? AND status IN ('active','review') AND source = ? AND tags LIKE ? LIMIT 1")
    .bind(namespace, TIMELINE_SOURCE, `%split_item:${itemKey}%`)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function findDiaries(db: D1Database, input: SplitDiaryInput): Promise<Array<{ record: MemoryRecord; date: string }>> {
  const requestedDates = new Set((input.dates ?? []).flatMap((date) => {
    const normalized = normalizeDate(date);
    return normalized ? [normalized] : [];
  }));
  const ids = (input.ids ?? []).map((id) => id.trim()).filter(Boolean);

  let rows: MemoryRecord[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND type = ? AND id IN (${placeholders})`)
      .bind(input.namespace, DIARY_SPLIT_SOURCE_TYPE, ...ids)
      .all<MemoryRecord>();
    rows = result.results ?? [];
  } else {
    const result = await db
      .prepare("SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND type = ? ORDER BY created_at")
      .bind(input.namespace, DIARY_SPLIT_SOURCE_TYPE)
      .all<MemoryRecord>();
    rows = result.results ?? [];
  }

  return rows.flatMap((record) => {
    const date = dateFromDiary(record);
    if (!date) return [];
    if (requestedDates.size > 0 && !requestedDates.has(date)) return [];
    return [{ record, date }];
  });
}

async function persistItems(
  env: Env,
  input: {
    namespace: string;
    diary: MemoryRecord;
    date: string;
    items: DiarySplitItem[];
    status?: "active" | "review";
    rescreenedFrom?: string;
  }
): Promise<{ createdIds: string[]; candidateKeys: string[] }> {
  const createdIds: string[] = [];
  const candidateKeys: string[] = [];
  for (const item of input.items) {
    const itemKey = await splitItemKey(input.diary.id, item);
    const tags = [...new Set([
      ...item.tags,
      `split_item:${itemKey}`,
      ...(input.rescreenedFrom ? [`rescreened_from:${input.rescreenedFrom}`] : [])
    ])];
    if (item.review_required) {
      const externalKey = `diary-split-v2:${input.diary.id}:${itemKey}`;
      await upsertMemoryCandidate(env.DB, input.namespace, {
        externalKey,
        dreamDate: item.date,
        action: "diary_split_fact",
        payload: {
          _kind: "diary_split_fact",
          origin_diary_id: input.diary.id,
          split_item_key: itemKey,
          type: item.type,
          content: item.content,
          summary: item.summary,
          importance: item.importance,
          confidence: item.confidence,
          tags,
          fact_key: item.fact_key,
          evidence: item.evidence,
          temporal_scope: item.temporal_scope
        },
        sourceChunkIds: [],
        sourceChunks: [{ diary_id: input.diary.id, date: item.date, evidence: item.evidence }],
        status: "pending"
      });
      candidateKeys.push(externalKey);
      continue;
    }

    const existingId = await existingSplitItemId(env.DB, input.namespace, itemKey);
    if (existingId) {
      createdIds.push(existingId);
      continue;
    }
    const memory = await createMemory(env.DB, {
      namespace: input.namespace,
      type: item.type,
      content: item.content,
      summary: item.summary,
      factKey: item.fact_key,
      activeFact: input.status !== "review",
      importance: item.importance,
      confidence: item.confidence,
      tags,
      source: TIMELINE_SOURCE,
      sourceMessageIds: [input.diary.id],
      status: input.status ?? "active",
      auditState: input.status === "review" ? "diary_rescreen_staged" : null
    });
    createdIds.push(memory.id);
    if (memory.status === "active") await upsertMemoryEmbedding(env, memory);
  }
  return { createdIds, candidateKeys };
}

export async function ensureVerbatimTimelineDay(
  env: Env,
  input: { namespace: string; diary: MemoryRecord; date: string }
): Promise<MemoryRecord> {
  if (!isActiveDiarySplitSource(input.diary)) {
    throw new Error("timeline_day_repair_requires_active_diary");
  }
  const persisted = await persistItems(env, {
    namespace: input.namespace,
    diary: input.diary,
    date: input.date,
    items: [buildVerbatimTimelineDay(input.diary, input.date)]
  });
  const memoryId = persisted.createdIds[0];
  if (!memoryId) throw new Error("timeline_day_repair_not_persisted");
  const memory = await env.DB.prepare(
    "SELECT * FROM memories WHERE namespace = ? AND id = ? LIMIT 1"
  ).bind(input.namespace, memoryId).first<MemoryRecord>();
  if (!memory) throw new Error("timeline_day_repair_not_found");
  return memory;
}

async function diaryAlreadyRescreened(
  db: D1Database,
  input: { namespace: string; diaryId: string; importer: string }
): Promise<boolean> {
  const originTag = `origin:${input.diaryId}`;
  const importerTag = `importer:${input.importer}`;
  const rescreenedTag = `rescreened_from:${input.importer}`;
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'active' AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?) THEN 1 ELSE 0 END) AS old_active,
       SUM(CASE WHEN status = 'review' AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?) THEN 1 ELSE 0 END) AS old_review,
       SUM(CASE WHEN status = 'active' AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?) THEN 1 ELSE 0 END) AS new_active
     FROM memories
     WHERE namespace = ?
       AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)`
  ).bind(importerTag, importerTag, rescreenedTag, input.namespace, originTag).first<{ old_active: number; old_review: number; new_active: number }>();
  return (row?.old_active ?? 0) === 0 && ((row?.new_active ?? 0) > 0 || (row?.old_review ?? 0) > 0);
}

async function activateRescreenedDiary(
  env: Env,
  input: { namespace: string; diaryId: string; importer: string; createdIds: string[] }
): Promise<string[]> {
  const importerTag = `importer:${input.importer}`;
  const originTag = `origin:${input.diaryId}`;
  const old = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)
       AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)`
  ).bind(input.namespace, importerTag, originTag).all<MemoryRecord>();

  const now = new Date().toISOString();
  const statements = [env.DB.prepare(
      `UPDATE memories
       SET status = 'review', active_fact = 0, audit_state = ?, vector_synced = 0,
           vector_sync_status = 'pending', updated_at = ?
       WHERE namespace = ? AND status = 'active'
         AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)
         AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)`
    ).bind(`rescreened_by:v2:${now}`, now, input.namespace, importerTag, originTag)];
  if (input.createdIds.length > 0) {
    const placeholders = input.createdIds.map(() => "?").join(", ");
    statements.push(env.DB.prepare(
      `UPDATE memories
       SET status = 'active', active_fact = 1, audit_state = 'diary_rescreen_activated',
           vector_synced = 0, vector_sync_status = 'pending', updated_at = ?
       WHERE namespace = ? AND status = 'review' AND id IN (${placeholders})`
    ).bind(now, input.namespace, ...input.createdIds));
  }
  await env.DB.batch(statements);

  for (const memory of old.results ?? []) await removeMemoryVector(env, memory);
  return (old.results ?? []).map((memory) => memory.id);
}

export async function splitDiaryMemories(env: Env, input: SplitDiaryInput): Promise<DiarySplitPlan[]> {
  const diaries = await findDiaries(env.DB, input);
  const plans: DiarySplitPlan[] = [];
  const replaceImporter = cleanImporter(input.replaceImporter);
  if (input.replaceImporter && !replaceImporter) throw new Error("invalid replace_importer");
  if (replaceImporter && (!input.force || !input.ids?.length)) {
    throw new Error("replace_importer requires force=true and explicit diary ids");
  }
  if (replaceImporter && input.ids!.length > 3) {
    throw new Error("replace_importer accepts at most 3 diary ids per request");
  }

  for (const { record, date } of diaries) {
    if (replaceImporter && await diaryAlreadyRescreened(env.DB, {
      namespace: input.namespace,
      diaryId: record.id,
      importer: replaceImporter
    })) {
      plans.push({ diary_id: record.id, date, skipped: true, reason: "already_rescreened", items: [] });
      continue;
    }
    const [existing, existingV2, completedV2, activeV2Day] = await Promise.all([
      existingSplitCount(env.DB, { namespace: input.namespace, originId: record.id }),
      existingV2SplitCount(env.DB, { namespace: input.namespace, originId: record.id }),
      hasSuccessfulDiarySplit(env.DB, { namespace: input.namespace, diaryId: record.id }),
      hasActiveV2DiaryDay(env.DB, { namespace: input.namespace, diaryId: record.id })
    ]);
    if (!input.force && (completedV2 || activeV2Day || (existing > 0 && existingV2 === 0))) {
      plans.push({ diary_id: record.id, date, skipped: true, reason: "already_split", existing_count: existing, items: [] });
      continue;
    }

    const { items, debug } = await callSplitModel(env, record, date, input.debug === true);
    if (items.length === 0) {
      if (input.apply) {
        const replacedIds = replaceImporter
          ? await activateRescreenedDiary(env, {
              namespace: input.namespace,
              diaryId: record.id,
              importer: replaceImporter,
              createdIds: []
            })
          : [];
        await createMemoryEvent(env.DB, {
          namespace: input.namespace,
          eventType: DIARY_SPLIT_INCOMPLETE_EVENT,
          memoryId: record.id,
          payload: {
            diary_id: record.id,
            date,
            created_ids: [],
            candidate_keys: [],
            item_count: 0,
            replace_importer: replaceImporter,
            replaced_ids: replacedIds
          }
        });
      }
      plans.push({ diary_id: record.id, date, skipped: true, reason: "no_items", items: [], debug });
      continue;
    }

    const plan: DiarySplitPlan = { diary_id: record.id, date, skipped: false, items, debug };
    if (input.apply) {
      const persisted = await persistItems(env, {
        namespace: input.namespace,
        diary: record,
        date,
        items,
        status: replaceImporter ? "review" : "active",
        rescreenedFrom: replaceImporter ?? undefined
      });
      plan.created_ids = persisted.createdIds;
      plan.candidate_keys = persisted.candidateKeys;
      const replacedIds = replaceImporter
        ? await activateRescreenedDiary(env, {
            namespace: input.namespace,
            diaryId: record.id,
            importer: replaceImporter,
            createdIds: persisted.createdIds
          })
        : [];
      await createMemoryEvent(env.DB, {
        namespace: input.namespace,
        eventType: DIARY_SPLIT_COMPLETE_EVENT,
        memoryId: record.id,
        payload: {
          diary_id: record.id,
          date,
          created_ids: persisted.createdIds,
          candidate_keys: persisted.candidateKeys,
          item_count: items.length,
          replace_importer: replaceImporter,
          replaced_ids: replacedIds
        }
      });
    }
    plans.push(plan);
  }

  return plans;
}
