import { markMemoriesRecalled, searchMemoriesByText } from "../db/memories";
import type { Env, MemoryApiRecord, MemoryRecord } from "../types";
import { postProcessMemorySearchResults } from "./postProcess";
import { searchVectorMemories, type ScoredMemoryRecord } from "./vectorStore";

const STRONG_KEYWORD_SCORE = 0.54;
const WEAK_KEYWORD_SCORE = 0.48;
const VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS = 0.78;
const RRF_K = 60;

const QUERY_ALIAS_GROUPS = [
  ["sm", "s/m", "bdsm", "dom", "sub", "brat", "switch", "支配", "臣服", "主导", "被主导"],
  ["cc", "claude code", "claude-code", "cc-connect", "telegram", "tg"],
  ["cf", "cloudflare", "worker", "workers", "d1", "vectorize"],
  ["memory", "memories", "记忆", "记忆库", "memory home", "小家"],
  ["book", "books", "reading", "reader", "共读", "读书", "书架"],
  ["handoff", "交接"],
  ["startup", "startup context", "启动", "启动上下文"],
  ["vps", "server", "服务器"]
];

const QUERY_NOISE_PATTERNS = [
  /你还记得/g,
  /还记得/g,
  /记不记得/g,
  /记得/g,
  /记住/g,
  /想起来/g,
  /回忆/g,
  /印象/g,
  /之前/g,
  /上次/g,
  /以前/g,
  /过去/g,
  /刚才/g,
  /昨天/g,
  /那天/g,
  /当时/g,
  /说过/g,
  /聊过/g,
  /提过/g,
  /存过/g,
  /是什么/g,
  /什么/g,
  /哪个/g,
  /哪里/g,
  /哪儿/g,
  /吗/g,
  /呢/g,
  /呀/g,
  /啊/g,
  /的/g
];

const LEADING_PRONOUN_PATTERN = /^(你们|我们|他们|她们|它们|你|我|她|他|它)+/;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function toMemoryApiRecord(record: MemoryRecord, score?: number): MemoryApiRecord {
  return {
    id: record.id,
    namespace: record.namespace,
    type: record.type,
    content: record.content,
    summary: record.summary,
    importance: record.importance,
    confidence: record.confidence,
    status: record.status,
    pinned: Boolean(record.pinned),
    tags: parseJsonArray(record.tags),
    source: record.source,
    source_message_ids: parseJsonArray(record.source_message_ids),
    vector_id: record.vector_id,
    last_recalled_at: record.last_recalled_at,
    recall_count: record.recall_count,
    created_at: record.created_at,
    updated_at: record.updated_at,
    expires_at: record.expires_at,
    ...(score === undefined ? {} : { score })
  };
}

function getTopK(env: Env, requested?: number): number {
  const fallback = Number(env.MEMORY_TOP_K || 8);
  const value = requested || fallback;
  return Math.min(Math.max(value, 1), 50);
}

function getCandidateLimit(topK: number): number {
  return Math.min(Math.max(topK * 5, topK), 80);
}

function recencyBoost(record: MemoryRecord): number {
  const timestamp = Date.parse(record.updated_at || record.created_at || "");
  if (!Number.isFinite(timestamp)) return 0;
  const daysOld = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (daysOld <= 7) return 1;
  if (daysOld <= 30) return 0.7;
  if (daysOld <= 90) return 0.4;
  return 0;
}

type TimeIntentMode = "none" | "hard_range" | "soft_recent" | "past_reference";

interface TimeIntent {
  mode: TimeIntentMode;
  terms: string[];
  after?: string;
  before?: string;
}

const EMPTY_TIME_INTENT: TimeIntent = { mode: "none", terms: [] };
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

type DateParts = { year: number; month: number; day: number };
type DayPart = "morning" | "afternoon" | "evening";

type HybridScoredMemoryRecord = ScoredMemoryRecord & { lexicalScore?: number; rankScore?: number; timeScore?: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rankHybridRecord(record: HybridScoredMemoryRecord): number {
  const vectorScore = record.vectorScore ?? 0;
  const keywordScore = record.keywordScore ?? 0;
  const lexicalScore = record.lexicalScore ?? 0;
  const rankScore = record.rankScore ?? 0;
  const timeScore = record.timeScore ?? 0;
  const pinnedBoost = record.pinned ? 0.08 : 0;
  return (
    vectorScore * 0.42 +
    keywordScore * 0.7 +
    lexicalScore * 0.45 +
    timeScore * 0.8 +
    rankScore * 8 +
    record.importance * 0.08 +
    pinnedBoost +
    recencyBoost(record) * 0.04
  );
}

function hasStrongKeywordMatch(records: ScoredMemoryRecord[]): boolean {
  return records.some((record) => (record.keywordScore ?? 0) >= STRONG_KEYWORD_SCORE);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeQueryForSearch(query: string): string {
  let normalized = normalizeText(query).replace(/[?？!！。.,，、:：;；"“”'‘’]/g, " ");
  for (const pattern of QUERY_NOISE_PATTERNS) normalized = normalized.replace(pattern, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  const withoutLeadingPronoun = normalized.replace(LEADING_PRONOUN_PATTERN, "").trim();
  if (withoutLeadingPronoun.length >= 2) normalized = withoutLeadingPronoun;
  return normalized.length >= 2 ? normalized : normalizeText(query);
}

function chineseNgrams(value: string): string[] {
  const grams: string[] = [];
  for (let size = 2; size <= Math.min(4, value.length); size += 1) {
    for (let index = 0; index <= value.length - size; index += 1) grams.push(value.slice(index, index + size));
  }
  return grams;
}

function hasLatin(value: string): boolean {
  return /[a-z0-9]/i.test(value);
}

function aliasMatches(query: string, alias: string): boolean {
  const normalizedAlias = normalizeText(alias);
  if (!normalizedAlias) return false;
  if (!hasLatin(normalizedAlias)) return query.includes(normalizedAlias);
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(query);
}

function expandQuery(query: string): string {
  const normalized = normalizeText(query);
  const terms = new Set([query.trim()]);
  for (const group of QUERY_ALIAS_GROUPS) {
    if (!group.some((alias) => aliasMatches(normalized, alias))) continue;
    for (const alias of group) terms.add(alias);
  }
  return [...terms].filter(Boolean).join(" ");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function shanghaiDateParts(now = new Date()): DateParts {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function addShanghaiDays(parts: DateParts, offset: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function utcIsoForShanghai(parts: DateParts, hour: number): string {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour - 8, 0, 0)).toISOString();
}

function dateTerms(parts: DateParts, dayParts: DayPart[] = []): string[] {
  const iso = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const loose = `${parts.year}.${parts.month}.${parts.day}`;
  const zh = `${parts.month}月${parts.day}日`;
  return [iso, loose, zh, ...dayParts.map((part) => `${iso}:${part}`)];
}

function dayPartRange(dayPart?: DayPart): { startHour: number; endHour: number; parts: DayPart[] } {
  if (dayPart === "morning") return { startHour: 0, endHour: 12, parts: ["morning"] };
  if (dayPart === "afternoon") return { startHour: 12, endHour: 18, parts: ["afternoon"] };
  if (dayPart === "evening") return { startHour: 18, endHour: 24, parts: ["evening"] };
  return { startHour: 0, endHour: 24, parts: ["morning", "afternoon", "evening"] };
}

function dayIntent(parts: DateParts, dayPart?: DayPart): TimeIntent {
  const range = dayPartRange(dayPart);
  return {
    mode: "hard_range",
    terms: dateTerms(parts, range.parts),
    after: utcIsoForShanghai(parts, range.startHour),
    before: utcIsoForShanghai(parts, range.endHour)
  };
}

function queryDayPart(query: string): DayPart | undefined {
  if (/上午|早上|清晨|凌晨/.test(query)) return "morning";
  if (/下午|中午/.test(query)) return "afternoon";
  if (/晚上|今晚|昨晚|夜里|夜晚|半夜/.test(query)) return "evening";
  return undefined;
}

function parseExplicitDate(query: string): DateParts | null {
  const current = shanghaiDateParts();
  const isoMatch = query.match(/\b(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?\b/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return { year: Number(year), month: Number(month), day: Number(day) };
  }

  const zhMatch = query.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日/);
  if (zhMatch) {
    const [, month, day] = zhMatch;
    return { year: current.year, month: Number(month), day: Number(day) };
  }

  return null;
}

function parseTimeIntent(rawQuery: string): TimeIntent {
  const query = normalizeText(rawQuery);
  const explicitDate = parseExplicitDate(query);
  if (explicitDate) return dayIntent(explicitDate, queryDayPart(query));

  const current = shanghaiDateParts();
  if (/前天/.test(query)) return dayIntent(addShanghaiDays(current, -2), queryDayPart(query));
  if (/昨天|昨晚/.test(query)) return dayIntent(addShanghaiDays(current, -1), queryDayPart(query));
  if (/今天|今晚|上午|下午|早上|中午|晚上/.test(query)) return dayIntent(current, queryDayPart(query));
  if (/刚刚|刚才|方才|刚聊|刚说/.test(query)) return { mode: "soft_recent", terms: [] };
  if (/上次|之前|以前|过去|那次|那天|当时/.test(query)) return { mode: "past_reference", terms: [] };
  return EMPTY_TIME_INTENT;
}

function recordTimestamp(record: MemoryRecord): number {
  const timestamp = Date.parse(record.updated_at || record.created_at || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function inTimeRange(timestamp: number, after?: string, before?: string): boolean {
  if (!timestamp) return false;
  const afterTime = after ? Date.parse(after) : Number.NEGATIVE_INFINITY;
  const beforeTime = before ? Date.parse(before) : Number.POSITIVE_INFINITY;
  return timestamp >= afterTime && timestamp < beforeTime;
}

function timeIntentScore(record: MemoryRecord, intent: TimeIntent): number {
  if (intent.mode === "none") return 0;

  if (intent.mode === "soft_recent") return recencyBoost(record) * 0.75;
  if (intent.mode === "past_reference") return recencyBoost(record) * 0.25;

  const haystack = recordHaystack(record);
  let score = 0;
  if (intent.terms.some((term) => haystack.includes(normalizeText(term)))) score += 1;
  if (inTimeRange(recordTimestamp(record), intent.after, intent.before)) score += 0.65;
  return clamp(score, 0, 1.4);
}

function dateNeedles(value: string): string[] {
  const needles: string[] = [];
  const matches = value.match(/\b\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\b/g) ?? [];
  for (const match of matches) {
    const [year, month, day] = match.split(/[.\-/]/).map((part) => Number(part));
    if (!year || !month || !day) continue;
    needles.push(`${year}.${month}.${day}`, `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, `${month}月${day}日`);
  }
  return needles;
}

function extractStrongNeedles(query: string): string[] {
  const normalized = normalizeText(query);
  const needles = new Set<string>();
  for (const item of dateNeedles(normalized)) needles.add(item);

  const compact = normalized.replace(/\s+/g, "");
  if (/[^\d.\-/]/.test(compact) && compact.length >= 3) needles.add(compact);

  const words = normalized.match(/[a-z][a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/gi) ?? [];
  for (const word of words) {
    const term = normalizeText(word);
    needles.add(term);
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) {
      for (const gram of chineseNgrams(term)) needles.add(gram);
    }
  }
  return [...needles].filter((needle) => needle.length >= 2).slice(0, 24);
}

function recordHaystack(record: MemoryRecord): string {
  return normalizeText(`${record.content} ${record.summary || ""} ${record.tags || ""} ${record.type}`);
}

function containsStrongNeedle(record: MemoryRecord, needles: string[]): boolean {
  const haystack = recordHaystack(record);
  return needles.some((needle) => haystack.includes(normalizeText(needle)));
}

function queryTermsForLexicalScore(input: { query: string; expandedQuery: string }): string[] {
  const terms = new Set<string>();
  for (const source of [input.query, input.expandedQuery]) {
    for (const term of source.match(/[a-z][a-z0-9_+-]{1,}|[\u4e00-\u9fff]{2,}/gi) ?? []) {
      const normalized = normalizeText(term);
      if (normalized.length < 2) continue;
      terms.add(normalized);
      if (/^[\u4e00-\u9fff]+$/.test(normalized) && normalized.length > 2) {
        for (const gram of chineseNgrams(normalized)) terms.add(gram);
      }
    }
  }
  return [...terms].slice(0, 30);
}

function lexicalScoreRecord(record: MemoryRecord, input: { query: string; expandedQuery: string }): number {
  const query = normalizeText(input.query);
  const compactQuery = query.replace(/\s+/g, "");
  const terms = queryTermsForLexicalScore(input);
  const content = normalizeText(record.content);
  const summary = normalizeText(record.summary || "");
  const tags = normalizeText(record.tags || "");
  const type = normalizeText(record.type);
  const haystack = `${content} ${summary} ${tags} ${type}`;

  let best = 0;
  if (compactQuery.length >= 2 && compactQuery.length <= 24 && haystack.includes(compactQuery)) best = Math.max(best, 0.7);

  let hits = 0;
  for (const term of terms) {
    const inContent = content.includes(term) || summary.includes(term);
    const inTagsOrType = tags.includes(term) || type.includes(term);
    if (!inContent && !inTagsOrType) continue;
    hits += 1;
    best = Math.max(best, inTagsOrType ? 0.9 : 0.6);
  }

  const coverage = terms.length ? Math.min(1, hits / Math.min(terms.length, 4)) : 0;
  return clamp(best + coverage * 0.22, 0, 1.1);
}

function isSupportedBySearchMode(record: HybridScoredMemoryRecord, input: { hasStrongKeyword: boolean; strongNeedles: string[] }): boolean {
  if (!input.hasStrongKeyword) return true;
  if ((record.lexicalScore ?? 0) >= 0.55) return true;
  if ((record.keywordScore ?? 0) >= WEAK_KEYWORD_SCORE) return true;
  if (input.strongNeedles.length > 0 && containsStrongNeedle(record, input.strongNeedles)) return true;
  return (record.vectorScore ?? 0) >= VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS;
}

function mergeSearchResults(
  vectorRecords: ScoredMemoryRecord[] | null,
  keywordRecords: ScoredMemoryRecord[],
  input: { query: string; expandedQuery: string; topK: number; timeIntent: TimeIntent }
): ScoredMemoryRecord[] {
  const merged = new Map<string, HybridScoredMemoryRecord>();

  function add(record: ScoredMemoryRecord, source: "vector" | "keyword", rank: number): void {
    const existing = merged.get(record.id);
    const rankWeight = source === "keyword" ? 1.25 : 1;
    const rankScore = rankWeight / (RRF_K + rank);
    const lexicalScore = lexicalScoreRecord(record, input);
    const timeScore = timeIntentScore(record, input.timeIntent);

    if (!existing) {
      const next: HybridScoredMemoryRecord = { ...record, lexicalScore, rankScore, timeScore };
      next.score = rankHybridRecord(next);
      merged.set(record.id, next);
      return;
    }

    const vectorScore = Math.max(existing.vectorScore ?? 0, record.vectorScore ?? 0);
    const keywordScore = Math.max(existing.keywordScore ?? 0, record.keywordScore ?? 0);
    const next: HybridScoredMemoryRecord = {
      ...existing,
      ...record,
      vectorScore: vectorScore || undefined,
      keywordScore: keywordScore || undefined,
      lexicalScore: Math.max(existing.lexicalScore ?? 0, lexicalScore),
      timeScore: Math.max(existing.timeScore ?? 0, timeScore),
      rankScore: (existing.rankScore ?? 0) + rankScore
    };
    next.score = rankHybridRecord(next);
    merged.set(record.id, next);
  }

  (vectorRecords ?? []).forEach((record, index) => add(record, "vector", index + 1));
  keywordRecords.forEach((record, index) => add(record, "keyword", index + 1));

  const rankedRecords = [...merged.values()].sort((a, b) => b.score - a.score);
  const hasStrongKeyword = hasStrongKeywordMatch(rankedRecords) || rankedRecords.some((record) => (record.lexicalScore ?? 0) >= 0.55);
  const strongNeedles = [...new Set([...extractStrongNeedles(input.expandedQuery), ...queryTermsForLexicalScore(input)])];
  const filteredRecords = rankedRecords.filter((record) => isSupportedBySearchMode(record, { hasStrongKeyword, strongNeedles }));
  return (filteredRecords.length > 0 ? filteredRecords : rankedRecords).slice(0, input.topK);
}

export async function searchMemories(
  env: Env,
  input: { namespace: string; query: string; rawQuery?: string; types?: string[]; topK?: number }
): Promise<MemoryApiRecord[]> {
  const topK = getTopK(env, input.topK);
  const candidateLimit = getCandidateLimit(topK);
  const rawQuery = input.rawQuery || input.query;
  const searchQuery = normalizeQueryForSearch(input.query);
  const timeIntent = parseTimeIntent(rawQuery);
  const expandedQuery = expandQuery([searchQuery, ...timeIntent.terms].filter(Boolean).join(" "));
  const [vectorRecords, keywordRecords] = await Promise.all([
    searchVectorMemories(env, { namespace: input.namespace, query: expandedQuery, types: input.types, topK: candidateLimit }),
    searchMemoriesByText(env.DB, { namespace: input.namespace, query: expandedQuery, types: input.types, limit: candidateLimit })
  ]);

  const records = mergeSearchResults(
    vectorRecords,
    keywordRecords.map((record) => ({ ...record, keywordScore: record.score })),
    { query: searchQuery, expandedQuery, topK: candidateLimit, timeIntent }
  );
  const apiRecords = records.map((record) => toMemoryApiRecord(record, record.score));
  const processedRecords = await postProcessMemorySearchResults(env, { query: searchQuery, rawQuery, memories: apiRecords, topK });

  await markMemoriesRecalled(env.DB, { namespace: input.namespace, ids: processedRecords.map((record) => record.id) });
  return processedRecords;
}
