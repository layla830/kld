import { createMemory } from "../db/memories";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { parseJsonStringArray } from "../utils/jsonHelpers";
import { upsertMemoryEmbedding } from "./embedding";

const TIMELINE_SOURCE = "timeline_split";
const DEFAULT_SPLIT_MODEL = "deepseek/deepseek-v4-flash";
const MAX_DIARY_CHARS = 18000;
const MAX_ITEMS_PER_DIARY = 24;
const FACT_TYPES = new Set(["rule", "preference", "project_state", "lesson", "identity", "core"]);
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
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  tags: string[];
  fact_key: string | null;
}

interface DiarySplitDebug {
  model_text_chars: number;
  parsed_kind: string;
  parsed_keys: string[];
  raw_item_count: number;
  accepted_item_count: number;
  raw_type_sample: string[];
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
  debug?: DiarySplitDebug;
}

export interface SplitDiaryInput {
  namespace: string;
  ids?: string[];
  dates?: string[];
  apply: boolean;
  force?: boolean;
  debug?: boolean;
}

interface RawSplitItem {
  type?: unknown;
  content?: unknown;
  summary?: unknown;
  importance?: unknown;
  confidence?: unknown;
  tags?: unknown;
  fact_key?: unknown;
  fact_like?: unknown;
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

function dateFromDiary(record: MemoryRecord): string | null {
  const contentMatch = record.content.match(/(?:^|\n)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:日记)?/);
  const tagMatch = parseJsonStringArray(record.tags).join(" ").match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const match = contentMatch || tagMatch;
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

function factKeyForItem(raw: RawSplitItem, type: string): string | null {
  const factKey = cleanString(raw.fact_key, 120);
  if (!factKey || !FACT_TYPES.has(type) || raw.fact_like !== true) return null;
  if (!/^[a-z0-9_.:-]+$/i.test(factKey)) return null;
  return factKey;
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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Providers sometimes wrap JSON in prose or code fences.
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(text.slice(objectStart, objectEnd + 1)) as unknown;
    } catch {
      // Continue and try array-shaped output.
    }
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(text.slice(arrayStart, arrayEnd + 1)) as unknown;
    } catch {
      return null;
    }
  }

  return null;
}

function parseItemsWithDebug(text: string, date: string, originId: string, includeDebug: boolean): { items: DiarySplitItem[]; debug?: DiarySplitDebug } {
  const parsed = extractJsonPayload(text);
  const rawItems = extractRawItems(parsed);
  const items: DiarySplitItem[] = [];

  for (const raw of rawItems.slice(0, MAX_ITEMS_PER_DIARY)) {
    if (!raw || typeof raw !== "object") continue;
    const type = cleanString(raw.type, 40).toLowerCase();
    const content = cleanString(raw.content, 1200);
    if (!MEMORY_TYPES.has(type) || content.length < 4) continue;

    const tags = [
      "timeline",
      `date:${date}`,
      type,
      ...cleanTags(raw.tags),
      `origin:${originId}`,
      `source_label:${sourceLabel(date)}`,
      splitBatchTag(date)
    ];

    items.push({
      type,
      content,
      summary: cleanString(raw.summary, 300) || null,
      importance: clamp(raw.importance, type === "timeline_day" ? 0.55 : 0.7),
      confidence: clamp(raw.confidence, 0.8),
      tags: [...new Set(tags)],
      fact_key: factKeyForItem(raw, type)
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
          raw_type_sample: rawItems.map((item) => cleanString(item?.type, 80)).filter(Boolean).slice(0, 12),
          text_preview: items.length === 0 ? text.slice(0, 500) : undefined
        }
      : undefined
  };
}

function buildSplitPrompt(record: MemoryRecord, date: string): string {
  const diary = record.content.slice(0, MAX_DIARY_CHARS);
  return [
    "Split this Chinese diary into searchable long-term memory records.",
    "Return JSON only. Do not use markdown.",
    "",
    "Allowed item types:",
    "- timeline_day: one compact day-level summary. Usually exactly one.",
    "- quote: a memorable line or compact quote-like moment.",
    "- lesson: a durable lesson learned from this day.",
    "- milestone: a relationship/project milestone.",
    "- insight: a stable interpretation worth recalling.",
    "- rule/preference/project_state: only when the diary states a durable current fact.",
    "- warmth/event: warm memory or concrete event.",
    "",
    "fact_key rules:",
    "- fact_key is optional.",
    "- Only set fact_like=true and fact_key for rule, preference, project_state, lesson, identity, or core records.",
    "- Never set fact_key for diary, timeline_day, quote, milestone, warmth, or one-off event records.",
    "- Use lowercase dotted keys, for example user.preference.debugging_style or project.kld.memory_schema.",
    "",
    "Output schema:",
    JSON.stringify({
      items: [
        {
          type: "timeline_day",
          content: "Chinese memory text",
          summary: "optional short summary",
          importance: 0.65,
          confidence: 0.85,
          tags: ["keyword"],
          fact_like: false,
          fact_key: null
        }
      ]
    }),
    "",
    `Date: ${date}`,
    `Diary memory id: ${record.id}`,
    "",
    "Diary:",
    diary
  ].join("\n");
}

async function callSplitModel(env: Env, record: MemoryRecord, date: string, includeDebug: boolean): Promise<{ items: DiarySplitItem[]; debug?: DiarySplitDebug }> {
  const model = env.CC_CONNECT_CHUNK_EXTRACT_MODEL || env.AUTO_CHUNK_SUMMARY_MODEL || env.CHAT_MODEL || env.MEMORY_MODEL || DEFAULT_SPLIT_MODEL;
  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "You are a strict JSON generator for Chinese memory extraction. Output JSON only." },
      { role: "user", content: buildSplitPrompt(record, date) }
    ],
    temperature: 0.1,
    max_tokens: 2600,
    stream: false
  };

  const response = await callOpenAICompat(env, request);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`split model failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const parsed = (await response.json()) as OpenAIChatResponse;
  const message = parsed.choices?.[0]?.message;
  const text = typeof message?.content === "string" ? message.content : typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  return parseItemsWithDebug(text, date, record.id, includeDebug);
}

async function existingSplitCount(db: D1Database, input: { namespace: string; originId: string }): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active' AND source = ? AND tags LIKE ?")
    .bind(input.namespace, TIMELINE_SOURCE, `%origin:${input.originId}%`)
    .first<{ count: number }>();
  return row?.count ?? 0;
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
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND id IN (${placeholders})`)
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

async function persistItems(env: Env, input: { namespace: string; diary: MemoryRecord; items: DiarySplitItem[] }): Promise<string[]> {
  const ids: string[] = [];
  for (const item of input.items) {
    const memory = await createMemory(env.DB, {
      namespace: input.namespace,
      type: item.type,
      content: item.content,
      summary: item.summary,
      factKey: item.fact_key,
      activeFact: true,
      importance: item.importance,
      confidence: item.confidence,
      tags: item.tags,
      source: TIMELINE_SOURCE,
      sourceMessageIds: [input.diary.id]
    });
    ids.push(memory.id);
    await upsertMemoryEmbedding(env, memory);
  }
  return ids;
}

export async function splitDiaryMemories(env: Env, input: SplitDiaryInput): Promise<DiarySplitPlan[]> {
  const diaries = await findDiaries(env.DB, input);
  const plans: DiarySplitPlan[] = [];

  for (const { record, date } of diaries) {
    const existing = await existingSplitCount(env.DB, { namespace: input.namespace, originId: record.id });
    if (existing > 0 && !input.force) {
      plans.push({ diary_id: record.id, date, skipped: true, reason: "already_split", existing_count: existing, items: [] });
      continue;
    }

    const { items, debug } = await callSplitModel(env, record, date, input.debug === true);
    if (items.length === 0) {
      plans.push({ diary_id: record.id, date, skipped: true, reason: "no_items", items: [], debug });
      continue;
    }

    const plan: DiarySplitPlan = { diary_id: record.id, date, skipped: false, items, debug };
    if (input.apply) {
      plan.created_ids = await persistItems(env, { namespace: input.namespace, diary: record, items });
    }
    plans.push(plan);
  }

  return plans;
}
