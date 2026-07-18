import { createMemory } from "../db/memories";
import { upsertMemoryCandidate } from "../db/memoryCandidates";
import { createMemoryEvent } from "../db/memoryEvents";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { parseJsonStringArray } from "../utils/jsonHelpers";
import { upsertMemoryEmbedding } from "./embedding";
import { removeMemoryVector } from "./state";

const TIMELINE_SOURCE = "timeline_split";
const DEFAULT_SPLIT_MODEL = "deepseek/deepseek-v4-flash";
const MAX_DIARY_CHARS = 18000;
const MAX_ITEMS_PER_DIARY = 6;
const FACT_TYPES = new Set(["rule", "preference", "project_state", "lesson"]);
const REVIEW_TYPES = new Set(["rule", "preference", "project_state", "lesson"]);
const SPLIT_VERSION_TAG = "split_version:v2";
const SPLIT_COMPLETE_EVENT = "diary_split_v2_complete";
const MEMORY_TYPES = new Set([
  "timeline_day",
  "quote",
  "lesson",
  "milestone",
  "insight",
  "rule",
  "preference",
  "project_state",
  "warmth",
  "event"
]);
const ITEM_ARRAY_KEYS = ["items", "memories", "records", "results", "entries"];

export interface DiarySplitItem {
  date: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  tags: string[];
  fact_key: string | null;
  evidence: string;
  temporal_scope: "day" | "current" | "historical";
  review_required: boolean;
}

interface DiarySplitDebug {
  model_text_chars: number;
  parsed_kind: string;
  parsed_keys: string[];
  raw_item_count: number;
  accepted_item_count: number;
  raw_type_sample: string[];
  raw_key_sample: string[][];
  text_preview?: string;
}

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

interface RawSplitItem {
  date?: unknown;
  type?: unknown;
  memory_type?: unknown;
  category?: unknown;
  content?: unknown;
  text?: unknown;
  memory?: unknown;
  summary?: unknown;
  importance?: unknown;
  confidence?: unknown;
  tags?: unknown;
  fact_key?: unknown;
  fact_like?: unknown;
  evidence?: unknown;
  temporal_scope?: unknown;
}

function clamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

function cleanString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

function normalizeDate(value: string): string | null {
  const match = value.trim().match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function dateFromDiary(record: MemoryRecord): string | null {
  const rangeMatch = record.content.match(/(?:^|\n)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[-–—至到]\s*(\d{1,2})\s*日/)
    || parseJsonStringArray(record.tags).join(" ").match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[-–—至到]\s*(\d{1,2})\s*日/);
  const contentMatch = record.content.match(/(?:^|\n)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:日记)?/);
  const tagMatch = parseJsonStringArray(record.tags).join(" ").match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const match = rangeMatch || contentMatch || tagMatch;
  if (!match) return null;
  const year = new Date(record.created_at || Date.now()).getUTCFullYear();
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function sourceLabel(date: string): string {
  return `diary_${date}`;
}

function splitBatchTag(date: string): string {
  return `split_batch:${date.replaceAll("-", "")}_diary`;
}

function temporalScope(raw: RawSplitItem): "day" | "current" | "historical" {
  const value = cleanString(raw.temporal_scope, 20).toLowerCase();
  return value === "current" || value === "historical" ? value : "day";
}

function datesFromDiary(record: MemoryRecord, fallback: string): string[] {
  const year = new Date(record.created_at || Date.now()).getUTCFullYear();
  const text = `${record.content.slice(0, 300)} ${parseJsonStringArray(record.tags).join(" ")}`;
  const dates = new Set<string>();
  for (const match of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})(?:\s*[-–—至到]\s*(\d{1,2}))?\s*日/g)) {
    const month = match[1].padStart(2, "0");
    dates.add(`${year}-${month}-${match[2].padStart(2, "0")}`);
    if (match[3]) dates.add(`${year}-${month}-${match[3].padStart(2, "0")}`);
  }
  if (dates.size === 0) dates.add(fallback);
  return [...dates];
}

function factKeyForItem(raw: RawSplitItem, type: string, scope: "day" | "current" | "historical"): string | null {
  const factKey = cleanString(raw.fact_key, 120);
  if (!factKey || !FACT_TYPES.has(type) || raw.fact_like !== true || scope !== "current") return null;
  if (!/^[a-z0-9_.:-]+$/i.test(factKey)) return null;
  return factKey;
}

function rawItemType(raw: RawSplitItem): string {
  return cleanString(raw.type ?? raw.memory_type ?? raw.category, 40).toLowerCase();
}

function rawItemContent(raw: RawSplitItem): string {
  return cleanString(raw.content ?? raw.text ?? raw.memory, 1200);
}

function extractRawItems(parsed: unknown): RawSplitItem[] {
  if (Array.isArray(parsed)) return parsed as RawSplitItem[];
  if (!parsed || typeof parsed !== "object") return [];

  const record = parsed as Record<string, unknown>;
  for (const key of ITEM_ARRAY_KEYS) {
    if (Array.isArray(record[key])) return record[key] as RawSplitItem[];
  }

  const firstArray = Object.values(record).find((value) => Array.isArray(value));
  return Array.isArray(firstArray) ? (firstArray as RawSplitItem[]) : [];
}

function candidateShapeCount(parsed: unknown): number {
  return extractRawItems(parsed).filter((item) => {
    if (!item || typeof item !== "object") return false;
    return Boolean(rawItemType(item) && rawItemContent(item));
  }).length;
}

function parsedKind(parsed: unknown): string {
  if (Array.isArray(parsed)) return "array";
  if (parsed === null) return "null";
  return typeof parsed;
}

function parsedKeys(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed as Record<string, unknown>).slice(0, 20);
}

function extractJsonPayload(text: string): unknown | null {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text) as unknown);
  } catch {
    // Providers sometimes wrap JSON in prose or code fences.
  }

  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") continue;
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === opener) {
        depth += 1;
      } else if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            candidates.push(JSON.parse(text.slice(start, index + 1)) as unknown);
          } catch {
            break;
          }
        }
      }
    }
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      candidates.push(JSON.parse(text.slice(objectStart, objectEnd + 1)) as unknown);
    } catch {
      // Continue and try array-shaped output.
    }
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      candidates.push(JSON.parse(text.slice(arrayStart, arrayEnd + 1)) as unknown);
    } catch {
      // Fall through to choosing the best earlier candidate.
    }
  }

  if (candidates.length === 0) return null;
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      shapeCount: candidateShapeCount(candidate),
      count: extractRawItems(candidate).length
    }))
    .sort((a, b) => b.shapeCount - a.shapeCount || b.count - a.count || b.index - a.index)[0].candidate;
}

function parseItemsWithDebug(text: string, date: string, allowedDates: string[], originId: string, diary: string, includeDebug: boolean): { items: DiarySplitItem[]; debug?: DiarySplitDebug } {
  const parsed = extractJsonPayload(text);
  const rawItems = extractRawItems(parsed);
  const items: DiarySplitItem[] = [];
  const seen = new Set<string>();
  const timelineDates = new Set<string>();
  const allowedDateSet = new Set(allowedDates);

  for (const raw of rawItems.slice(0, MAX_ITEMS_PER_DIARY)) {
    if (!raw || typeof raw !== "object") continue;
    const type = rawItemType(raw);
    const content = rawItemContent(raw);
    const evidence = cleanString(raw.evidence, 80);
    if (content === "Chinese memory text") continue;
    if (!MEMORY_TYPES.has(type) || content.length < 4) continue;
    if (!evidence || !diary.includes(evidence)) continue;
    if (type === "quote" && !diary.includes(content)) continue;
    const requestedDate = normalizeDate(cleanString(raw.date, 20));
    const itemDate = requestedDate && allowedDateSet.has(requestedDate) ? requestedDate : date;
    if (type === "timeline_day") {
      if (content.length > 360 || content.length > Math.max(120, diary.length * 0.65)) continue;
      if (timelineDates.has(itemDate)) continue;
      timelineDates.add(itemDate);
    }
    const dedupeKey = `${type}:${content.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const scope = temporalScope(raw);

    const tags = [
      "timeline",
      `date:${itemDate}`,
      type,
      ...cleanTags(raw.tags),
      `origin:${originId}`,
      `source_label:${sourceLabel(itemDate)}`,
      `temporal_scope:${scope}`,
      splitBatchTag(itemDate),
      SPLIT_VERSION_TAG
    ];

    items.push({
      date: itemDate,
      type,
      content,
      summary: cleanString(raw.summary, 300) || null,
      importance: clamp(raw.importance, type === "timeline_day" ? 0.55 : 0.7),
      confidence: clamp(raw.confidence, 0.8),
      tags: [...new Set(tags)],
      fact_key: factKeyForItem(raw, type, scope),
      evidence,
      temporal_scope: scope,
      review_required: REVIEW_TYPES.has(type)
    });
  }

  return {
    items,
    debug: includeDebug
      ? {
          model_text_chars: text.length,
          parsed_kind: parsedKind(parsed),
          parsed_keys: parsedKeys(parsed),
          raw_item_count: rawItems.length,
          accepted_item_count: items.length,
          raw_type_sample: rawItems.map((item) => rawItemType(item)).filter(Boolean).slice(0, 12),
          raw_key_sample: rawItems
            .filter((item) => item && typeof item === "object")
            .map((item) => Object.keys(item as Record<string, unknown>).slice(0, 12))
            .slice(0, 6),
          text_preview: items.length === 0 ? text.slice(0, 500) : undefined
        }
      : undefined
  };
}

function buildSplitPrompt(record: MemoryRecord, date: string, allowedDates: string[]): string {
  const diary = record.content.slice(0, MAX_DIARY_CHARS);
  return [
    "Split this Chinese diary into searchable long-term memory records.",
    "Return JSON only. Do not use markdown.",
    "It is valid to return {\"items\":[]} when the diary has no durable or searchable memory.",
    "Return 2-6 high-signal items. Fewer is better than padding. Do not create one item for every allowed type.",
    "The goal is one compact day overview plus only the few atomic memories that would be useful in a future search.",
    "Do not repeat the same scene or conclusion across timeline_day, quote, lesson, insight, and rule records.",
    "Reject generic quotes, routine details, literary restatements, and interpretations that merely repeat the day overview.",
    "Each non-timeline item must still be useful when read alone without the source diary.",
    "Identity is fixed: the diary narrator '我' is KLD; '她', '老婆', and the addressed user are Layla/the user.",
    "Never store KLD's own behavior, preference, lesson, or project state under a user.* fact_key.",
    "",
    "Allowed item types:",
    "- timeline_day: at most one compact day-level summary.",
    "- quote: an exact memorable line copied from the diary. Never paraphrase a quote.",
    "- lesson: a durable lesson explicitly stated by the narrator, not a model interpretation.",
    "- milestone: a relationship/project milestone.",
    "- insight: a stable interpretation worth recalling.",
    "- rule/preference/project_state: only when the diary explicitly states a durable current fact; these will require human review.",
    "- warmth/event: warm memory or concrete event.",
    "",
    "fact_key rules:",
    "- fact_key is optional.",
    "- Only set fact_like=true and fact_key for rule, preference, project_state, or lesson records with temporal_scope=current.",
    "- Never set fact_key for diary, timeline_day, quote, milestone, warmth, or one-off event records.",
    "- A one-day event, temporary mood, role-play statement, apology, argument, or inference is not a durable current fact.",
    "- Do not infer a rule, preference, project state, or lesson merely because the diary describes one occurrence.",
    "- Use lowercase dotted keys with the correct subject, for example kld.preference.response_style, user.preference.food, relationship.rule.honesty, or project.kld.memory_schema.",
    "",
    "evidence rules:",
    "- Every item must include evidence: an exact verbatim substring from the diary, at most 80 Chinese characters.",
    "- The evidence must directly support the item. Do not invent or paraphrase evidence.",
    "- For quote items, content itself must also be an exact substring of the diary.",
    "- temporal_scope must be day, current, or historical. Use current only for facts explicitly stated as still true.",
    "- Do not generate relations or XYZEM coordinates; downstream maintenance handles them.",
    `- Each item must set date to one of these dates found in the diary title: ${allowedDates.join(", ")}.`,
    "- If the diary covers multiple dates, assign each item to the date of its supporting evidence; each date may have at most one timeline_day.",
    "",
    "Output schema:",
    JSON.stringify({
      items: [
        {
          date,
          type: "timeline_day",
          content: "Chinese memory text",
          summary: "optional short summary",
          importance: 0.65,
          confidence: 0.85,
          tags: ["keyword"],
          evidence: "exact diary substring",
          temporal_scope: "day",
          fact_like: false,
          fact_key: null
        }
      ]
    }),
    "",
    `Default date: ${date}`,
    `Allowed dates: ${allowedDates.join(", ")}`,
    `Diary memory id: ${record.id}`,
    "",
    "Diary:",
    diary
  ].join("\n");
}

async function callSplitModel(env: Env, record: MemoryRecord, date: string, includeDebug: boolean): Promise<{ items: DiarySplitItem[]; debug?: DiarySplitDebug }> {
  const allowedDates = datesFromDiary(record, date);
  const model = env.CC_CONNECT_CHUNK_EXTRACT_MODEL || env.MEMORY_MODEL || env.AUTO_CHUNK_SUMMARY_MODEL || env.CHAT_MODEL || DEFAULT_SPLIT_MODEL;
  const basePrompt = buildSplitPrompt(record, date, allowedDates);
  let lastMissingDates: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "You are a strict JSON generator for Chinese memory extraction. Output JSON only. Do not explain or show reasoning." },
        {
          role: "user",
          content: attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nYour previous non-empty output was invalid because these represented dates had no timeline_day: ${lastMissingDates.join(", ")}. Return exactly one timeline_day for every date represented by any item.`
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
    if (result.items.length === 0) return result;

    const representedDates = new Set(result.items.map((item) => item.date));
    const timelineDates = new Set(result.items.filter((item) => item.type === "timeline_day").map((item) => item.date));
    lastMissingDates = [...representedDates].filter((itemDate) => !timelineDates.has(itemDate));
    if (lastMissingDates.length === 0) return result;
  }

  throw new Error(`split_model_missing_timeline_day:${lastMissingDates.join(",")}`);
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

async function hasCompletedV2Split(db: D1Database, input: { namespace: string; originId: string }): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM memory_events WHERE namespace = ? AND event_type = ? AND memory_id = ? LIMIT 1")
    .bind(input.namespace, SPLIT_COMPLETE_EVENT, input.originId)
    .first<{ id: string }>();
  return Boolean(row?.id);
}

async function splitItemKey(diaryId: string, item: DiarySplitItem): Promise<string> {
  const normalized = `${diaryId}\n${item.date}\n${item.type}\n${item.content.replace(/\s+/g, " ").trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
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
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND type IN ('diary', 'layla_diary') AND id IN (${placeholders})`)
      .bind(input.namespace, ...ids)
      .all<MemoryRecord>();
    rows = result.results ?? [];
  } else {
    const result = await db
      .prepare("SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND type IN ('diary', 'layla_diary') ORDER BY created_at")
      .bind(input.namespace)
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

function cleanImporter(value: string | undefined): string | null {
  const importer = value?.trim().toLowerCase();
  return importer && /^[a-z0-9._-]{1,40}$/.test(importer) ? importer : null;
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
    const [existing, existingV2, completedV2] = await Promise.all([
      existingSplitCount(env.DB, { namespace: input.namespace, originId: record.id }),
      existingV2SplitCount(env.DB, { namespace: input.namespace, originId: record.id }),
      hasCompletedV2Split(env.DB, { namespace: input.namespace, originId: record.id })
    ]);
    if (!input.force && (completedV2 || (existing > 0 && existingV2 === 0))) {
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
          eventType: SPLIT_COMPLETE_EVENT,
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
        eventType: SPLIT_COMPLETE_EVENT,
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
