import { clamp, cleanString, cleanTags } from "./diarySplitSanitize";
import { normalizeDate, sourceLabel, splitBatchTag } from "./diarySplitDates";

export const MAX_ITEMS_PER_DIARY = 5;
export const FACT_TYPES = new Set(["rule", "preference", "project_state", "lesson"]);
export const REVIEW_TYPES = new Set(["rule", "preference", "project_state", "lesson"]);
export const SPLIT_VERSION_TAG = "split_version:v2";
export const MEMORY_TYPES = new Set([
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

export interface DiarySplitDebug {
  model_text_chars: number;
  parsed_kind: string;
  parsed_keys: string[];
  raw_item_count: number;
  accepted_item_count: number;
  raw_type_sample: string[];
  raw_key_sample: string[][];
  text_preview?: string;
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

function rawItemType(raw: RawSplitItem): string {
  return cleanString(raw.type ?? raw.memory_type ?? raw.category, 40).toLowerCase();
}

function rawItemContent(raw: RawSplitItem): string {
  return cleanString(raw.content ?? raw.text ?? raw.memory, 1200);
}

export function temporalScope(raw: RawSplitItem): "day" | "current" | "historical" {
  const value = cleanString(raw.temporal_scope, 20).toLowerCase();
  return value === "current" || value === "historical" ? value : "day";
}

export function factKeyForItem(raw: RawSplitItem, type: string, scope: "day" | "current" | "historical"): string | null {
  const factKey = cleanString(raw.fact_key, 120);
  if (!factKey || !FACT_TYPES.has(type) || raw.fact_like !== true || scope !== "current") return null;
  if (!/^[a-z0-9_.:-]+$/i.test(factKey)) return null;
  return factKey;
}

export function extractRawItems(parsed: unknown): RawSplitItem[] {
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

export function extractJsonPayload(text: string): unknown | null {
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

export function parseItemsWithDebug(
  text: string,
  date: string,
  allowedDates: string[],
  originId: string,
  diary: string,
  includeDebug: boolean
): { items: DiarySplitItem[]; debug?: DiarySplitDebug } {
  const parsed = extractJsonPayload(text);
  const rawItems = extractRawItems(parsed);
  const items: DiarySplitItem[] = [];
  const seen = new Set<string>();
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
      importance: clamp(raw.importance, 0.7),
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

export async function splitItemKey(diaryId: string, item: DiarySplitItem): Promise<string> {
  const normalized = `${diaryId}\n${item.date}\n${item.type}\n${item.content.replace(/\s+/g, " ").trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
