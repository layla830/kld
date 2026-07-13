import type { MemoryRecord } from "../types";
import { systemClock } from "../config/runtime";
import { normalizeText } from "../memory/query";

export type TimeIntentMode = "none" | "hard_range" | "soft_recent" | "past_reference";
export interface TimeIntent { mode: TimeIntentMode; terms: string[]; after?: string; before?: string }
type DateParts = { year: number; month: number; day: number };
type DayPart = "morning" | "afternoon" | "evening";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const EMPTY_TIME_INTENT: TimeIntent = { mode: "none", terms: [] };

function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), max); }
function pad2(value: number): string { return String(value).padStart(2, "0"); }

function shanghaiDateParts(now = systemClock.now()): DateParts {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function addDays(parts: DateParts, offset: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function utcIso(parts: DateParts, hour: number): string {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, 0, 0)).toISOString();
}

function dayPart(query: string): DayPart | undefined {
  if (/上午|早上|清晨|凌晨/.test(query)) return "morning";
  if (/下午|中午/.test(query)) return "afternoon";
  if (/晚上|今晚|昨晚|夜里|夜晚|半夜/.test(query)) return "evening";
  return undefined;
}

function dayIntent(parts: DateParts, part?: DayPart): TimeIntent {
  const range = part === "morning" ? [0, 12] : part === "afternoon" ? [12, 18] : part === "evening" ? [18, 24] : [0, 24];
  const names: DayPart[] = part ? [part] : ["morning", "afternoon", "evening"];
  const iso = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  return {
    mode: "hard_range",
    terms: [iso, `${parts.year}.${parts.month}.${parts.day}`, `${parts.month}月${parts.day}日`, ...names.map((name) => `${iso}:${name}`)],
    after: utcIso(parts, range[0]),
    before: utcIso(parts, range[1])
  };
}

function explicitDate(query: string): DateParts | null {
  const full = query.match(/\b(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?\b/);
  if (full) return { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
  const short = query.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日?/);
  const current = shanghaiDateParts();
  return short ? { year: current.year, month: Number(short[1]), day: Number(short[2]) } : null;
}

export function parseTimeIntent(rawQuery: string): TimeIntent {
  const query = normalizeText(rawQuery);
  const explicit = explicitDate(query);
  if (explicit) return dayIntent(explicit, dayPart(query));
  const current = shanghaiDateParts();
  if (/前天/.test(query)) return dayIntent(addDays(current, -2), dayPart(query));
  if (/昨天|昨晚/.test(query)) return dayIntent(addDays(current, -1), dayPart(query));
  if (/今天|今晚|上午|下午|早上|中午|晚上/.test(query)) return dayIntent(current, dayPart(query));
  if (/刚刚|刚才|方才|刚聊|刚说/.test(query)) return { mode: "soft_recent", terms: [] };
  if (/上次|之前|以前|过去|那次|那天|当时/.test(query)) return { mode: "past_reference", terms: [] };
  return EMPTY_TIME_INTENT;
}

function timestamp(record: MemoryRecord): number {
  const value = Date.parse(record.updated_at || record.created_at || "");
  return Number.isFinite(value) ? value : 0;
}

function recency(record: MemoryRecord): number {
  const value = timestamp(record);
  if (!value) return 0;
  const days = Math.max(0, (systemClock.now().getTime() - value) / 86_400_000);
  return days <= 7 ? 1 : days <= 30 ? 0.7 : days <= 90 ? 0.4 : 0;
}

export function timeIntentScore(record: MemoryRecord, intent: TimeIntent): number {
  if (intent.mode === "none") return 0;
  if (intent.mode === "soft_recent") return recency(record) * 0.75;
  if (intent.mode === "past_reference") return recency(record) * 0.25;
  const haystack = normalizeText(`${record.content} ${record.summary || ""} ${record.fact_key || ""} ${record.tags || ""} ${record.type}`);
  const after = intent.after ? Date.parse(intent.after) : Number.NEGATIVE_INFINITY;
  const before = intent.before ? Date.parse(intent.before) : Number.POSITIVE_INFINITY;
  const inRange = timestamp(record) >= after && timestamp(record) < before;
  return clamp((intent.terms.some((term) => haystack.includes(normalizeText(term))) ? 1 : 0) + (inRange ? 0.65 : 0), 0, 1.4);
}

export function recencyBoost(record: MemoryRecord): number { return recency(record); }
