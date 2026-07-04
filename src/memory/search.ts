import { listActiveMemoriesByFactKeys, listGuidanceSeedMemories, markMemoriesRecalled, searchMemoriesByText } from "../db/memories";
import { listRelationExpandedMemories } from "../db/memoryRelations";
import { searchMessagesForRecall } from "../db/messages";
import type { Env, MemoryApiRecord, MemoryRecord, MessageRecord } from "../types";
import { postProcessMemorySearchResults, applyLead } from "./postProcess";
import { toMemoryApiRecord } from "./mapper";
import { factKeysForQueryHint, queryHintAliasGroups } from "./queryHints";
import { searchVectorMemories, type ScoredMemoryRecord } from "./vectorStore";
import { shouldApplyEAxisToRanking } from "./eAxis";
import { computeDecayedWeight } from "./halfLife";
import { expandQueryAngles, rerankMemories } from "./queryExpand";

export { toMemoryApiRecord } from "./mapper";

const STRONG_KEYWORD_SCORE = 0.54;
const WEAK_KEYWORD_SCORE = 0.48;
const VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS = 0.78;
const QUERY_HINT_SCORE = 1.35;
const GUIDANCE_SEED_SCORE = 0.72;
const RRF_K = 60;
const GUIDANCE_QUERY_RE = /应该怎么做|怎么办|怎么接|怎么哄|怎么回应|怎么处理|要怎么做|该怎么办/;
const FTS_FLOOR = 0.45;
const RAW_EVENTS_FLOOR = 0.30;
const LITERAL_QUERY_MAX_CHARS = 80;
const LITERAL_TOP_K = 3;
const EMOTION_RESONATE_TOP_K = 4;
const EMOTION_RESONATE_MIN_SCORE = 0.3;
const EMOTION_CATEGORY_TYPES = new Set(["diary", "layla_diary", "quote", "warmth", "milestone", "message", "intimate", "episodic"]);

const QUERY_ALIAS_GROUPS = [
  ["sm", "s/m", "bdsm", "dom", "sub", "brat", "switch", "支配", "臣服", "主导", "被主导"],
  ["cc", "claude code", "claude-code", "cc-connect", "telegram", "tg"],
  ["cf", "cloudflare", "worker", "workers", "d1", "vectorize"],
  ["memory", "memories", "记忆", "记忆库", "memory home", "小家"],
  ["book", "books", "reading", "reader", "共读", "读书", "书架"],
  ["handoff", "交接"],
  ["startup", "startup context", "启动", "启动上下文"],
  ...queryHintAliasGroups(),
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
  /刚刚/g,
  /昨天/g,
  /昨晚/g,
  /前天/g,
  /今天/g,
  /今晚/g,
  /那次/g,
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

const RULE_LIKE_TYPES = new Set(["rule", "lesson", "core", "preference", "identity"]);
const CONTEXT_TYPES = new Set(["diary", "layla_diary", "quote", "message", "timeline_day", "conversation_message"]);

function eAxisBoost(record: HybridScoredMemoryRecord): number {
  const type = record.type;
  if (CONTEXT_TYPES.has(type)) return 0;
  let boost = 0;
  if (RULE_LIKE_TYPES.has(type)) boost += 0.06;
  const tension = typeof record.tension_score === "number" ? record.tension_score : null;
  if (tension !== null && tension >= 0.5) boost += 0.04;
  const risk = record.risk_level;
  if (risk === "high") boost += 0.03;
  else if (risk === "medium") boost += 0.015;
  if (record.thread && String(record.thread).startsWith("relationship.boundaries")) boost += 0.02;
  return Math.min(boost, 0.15);
}
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

type TimeIntentMode = "none" | "hard_range" | "soft_recent" | "past_reference";
type DateParts = { year: number; month: number; day: number };
type DayPart = "morning" | "afternoon" | "evening";
type HybridScoredMemoryRecord = ScoredMemoryRecord & { lexicalScore?: number; rankScore?: number; timeScore?: number };

interface TimeIntent {
  mode: TimeIntentMode;
  terms: string[];
  after?: string;
  before?: string;
}

interface SearchMemoriesInput {
  namespace: string;
  query: string;
  rawQuery?: string;
  types?: string[];
  topK?: number;
  includeMessages?: boolean;
  recordRecall?: boolean;
}

const EMPTY_TIME_INTENT: TimeIntent = { mode: "none", terms: [] };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function recencyBoost(record: MemoryRecord): number {
  const timestamp = recordTimestamp(record);
  if (!timestamp) return 0;
  const daysOld = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (daysOld <= 7) return 1;
  if (daysOld <= 30) return 0.7;
  if (daysOld <= 90) return 0.4;
  return 0;
}

function recordHaystack(record: MemoryRecord): string {
  return normalizeText(`${record.content} ${record.summary || ""} ${record.fact_key || ""} ${record.tags || ""} ${record.type}`);
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
  const factKey = normalizeText(record.fact_key || "");
  const tags = normalizeText(record.tags || "");
  const type = normalizeText(record.type);
  const haystack = `${content} ${summary} ${factKey} ${tags} ${type}`;

  let best = 0;
  if (compactQuery.length >= 2 && compactQuery.length <= 24 && haystack.includes(compactQuery)) best = Math.max(best, 0.7);

  let hits = 0;
  for (const term of terms) {
    const inContent = content.includes(term) || summary.includes(term);
    const inTagsOrType = factKey.includes(term) || tags.includes(term) || type.includes(term);
    if (!inContent && !inTagsOrType) continue;
    hits += 1;
    best = Math.max(best, inTagsOrType ? 0.9 : 0.6);
  }

  const coverage = terms.length ? Math.min(1, hits / Math.min(terms.length, 4)) : 0;
  return clamp(best + coverage * 0.22, 0, 1.1);
}

function rankHybridRecord(record: HybridScoredMemoryRecord, applyEAxis: boolean): number {
  const vectorScore = record.vectorScore ?? 0;
  const keywordScore = record.keywordScore ?? 0;
  const lexicalScore = record.lexicalScore ?? 0;
  const rankScore = record.rankScore ?? 0;
  const timeScore = record.timeScore ?? 0;
  const pinnedBoost = record.pinned ? 0.08 : 0;
  const decayedWeight = computeDecayedWeight(record);
  return (
    vectorScore * 0.42 +
    keywordScore * 0.7 +
    lexicalScore * 0.45 +
    timeScore * 1.2 +
    rankScore * 8 +
    decayedWeight * 0.12 +
    pinnedBoost +
    recencyBoost(record) * 0.02 +
    (applyEAxis ? eAxisBoost(record) : 0)
  );
}

function hasStrongKeywordMatch(records: ScoredMemoryRecord[]): boolean {
  return records.some((record) => (record.keywordScore ?? 0) >= STRONG_KEYWORD_SCORE);
}

function isSupportedBySearchMode(record: HybridScoredMemoryRecord, input: { hasStrongKeyword: boolean; strongNeedles: string[] }): boolean {
  if (!input.hasStrongKeyword) return true;
  if ((record.lexicalScore ?? 0) >= 0.55) return true;
  if ((record.keywordScore ?? 0) >= WEAK_KEYWORD_SCORE) return true;
  if ((record.timeScore ?? 0) >= 0.55) return true;
  if (input.strongNeedles.length > 0 && containsStrongNeedle(record, input.strongNeedles)) return true;
  return (record.vectorScore ?? 0) >= VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS;
}

function messageToMemoryRecord(message: MessageRecord & { score: number }): ScoredMemoryRecord {
  const role = message.role === "user" ? "她" : "他";
  return {
    id: `msg_${message.id}`,
    namespace: message.namespace,
    type: "conversation_message",
    content: `${role}：${message.content}`,
    summary: null,
    fact_key: null,
    active_fact: 1,
    thread: null,
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: message.role === "user" ? 0.42 : 0.34,
    confidence: 0.75,
    status: "active",
    pinned: 0,
    tags: JSON.stringify(["raw_message", message.source || "chat"]),
    source: message.source || "messages",
    source_message_ids: JSON.stringify([message.id]),
    vector_id: null,
    vector_synced: 0,
    last_recalled_at: null,
    recall_count: 0,
    created_at: message.created_at,
    updated_at: message.created_at,
    expires_at: null,
    score: message.score,
    keywordScore: message.score
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

function shouldRecordRecall(input: SearchMemoriesInput): boolean {
  return input.recordRecall === true;
}

function mergeSearchResults(
  vectorRecords: ScoredMemoryRecord[] | null,
  keywordRecords: ScoredMemoryRecord[],
  input: { query: string; expandedQuery: string; topK: number; timeIntent: TimeIntent; applyEAxis: boolean }
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
      next.score = rankHybridRecord(next, input.applyEAxis);
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
    next.score = rankHybridRecord(next, input.applyEAxis);
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

function mergeRelatedRecords(records: ScoredMemoryRecord[], relationRecords: ScoredMemoryRecord[], limit: number): ScoredMemoryRecord[] {
  if (relationRecords.length === 0) return records.slice(0, limit);
  const byId = new Map<string, ScoredMemoryRecord>();

  for (const record of records) byId.set(record.id, record);
  for (const record of relationRecords) {
    const existing = byId.get(record.id);
    if (!existing || (record.score ?? 0) > (existing.score ?? 0)) byId.set(record.id, record);
  }

  return [...byId.values()]
    .sort((a, b) => (b.score ?? 0) + b.importance * 0.05 - ((a.score ?? 0) + a.importance * 0.05))
    .slice(0, limit);
}

function keepRelatedContext(primary: MemoryApiRecord[], related: MemoryApiRecord[], topK: number): MemoryApiRecord[] {
  if (related.length === 0 || primary.length >= topK) return primary.slice(0, topK);
  const keptIds = new Set(primary.map((memory) => memory.id));
  const additions = related
    .filter((memory) => !keptIds.has(memory.id))
    .filter((memory) => typeof memory.score !== "number" || memory.score >= 0.16)
    .sort((a, b) => (b.score ?? 0) + b.importance * 0.05 - ((a.score ?? 0) + a.importance * 0.05))
    .slice(0, Math.min(3, topK - primary.length));
  return [...primary, ...additions].slice(0, topK);
}

function keepExplicitHintContext(primary: MemoryApiRecord[], hinted: MemoryApiRecord[], topK: number): MemoryApiRecord[] {
  if (hinted.length === 0 || primary.length >= topK) return primary.slice(0, topK);
  const keptIds = new Set(primary.map((memory) => memory.id));
  const additions = hinted
    .filter((memory) => !keptIds.has(memory.id))
    .sort((a, b) => (b.score ?? 0) + b.importance * 0.05 - ((a.score ?? 0) + a.importance * 0.05))
    .slice(0, Math.min(2, topK - primary.length));
  return [...primary, ...additions].slice(0, topK);
}

function shouldRunLiteralSearch(rawQuery: string): boolean {
  const normalized = normalizeText(rawQuery).trim();
  if (!normalized || normalized.length > LITERAL_QUERY_MAX_CHARS) return false;
  if (/[""「」『』]/.test(rawQuery)) return true;
  const compact = normalized.replace(/\s+/g, "");
  if (/^[\u4e00-\u9fff]{2,8}$/.test(compact)) return true;
  const words = normalized.match(/[a-z][a-z0-9_+-]{1,}/gi) ?? [];
  if (words.length === 1 && words[0].length <= 20) return true;
  return false;
}

function literalQueryTerms(rawQuery: string): string[] {
  const normalized = normalizeText(rawQuery).trim();
  const compact = normalized.replace(/\s+/g, "");
  if (/[""「」『』]/.test(rawQuery)) {
    const quoted = rawQuery.match(/[""「」『』]([^""「」『』]+)[""「」『』]/);
    if (quoted?.[1]) return [normalizeText(quoted[1])];
  }
  if (/^[\u4e00-\u9fff]{2,8}$/.test(compact)) return [compact];
  const words = normalized.match(/[a-z][a-z0-9_+-]{1,}/gi) ?? [];
  if (words.length === 1 && words[0].length <= 20) return [normalizeText(words[0])];
  return [normalized];
}

interface EmotionCoord {
  valence: number;
  arousal: number;
}

function detectEmotionCoord(rawQuery: string): EmotionCoord | null {
  const text = normalizeText(rawQuery);
  let valence = 0;
  let arousal = 0;
  let matched = false;

  if (/哭|难过|伤心|心痛|崩溃|绝望|害怕|恐惧|焦虑|担心|委屈|想念|舍不得|不舍|孤独|冷|疼|痛|害怕|怕/.test(text)) {
    valence -= 0.6; arousal += 0.5; matched = true;
  }
  if (/开心|高兴|快乐|喜欢|爱|幸福|甜|暖|笑|嘻嘻|哈哈|撒娇|亲|抱|好喜欢|好爱/.test(text)) {
    valence += 0.6; arousal += 0.4; matched = true;
  }
  if (/生气|怒|气死|讨厌|烦|骂|吵|打架|滚|分手|别理我|不想理/.test(text)) {
    valence -= 0.5; arousal += 0.7; matched = true;
  }
  if (/老公|柯柯|宝宝|亲爱的|想你|爱我|抱抱|贴贴/.test(text)) {
    valence += 0.7; arousal += 0.3; matched = true;
  }
  if (/高潮|舒服|想要|亲密|做爱|敏感|刺激|体位/.test(text)) {
    valence += 0.5; arousal += 0.8; matched = true;
  }
  if (/平静|安静|睡了|晚安|休息|放松/.test(text)) {
    valence += 0.2; arousal -= 0.3; matched = true;
  }

  if (!matched) return null;
  return {
    valence: Math.max(-1, Math.min(1, valence)),
    arousal: Math.max(0, Math.min(1, arousal))
  };
}

function russellDistance(a: EmotionCoord, b: { valence: number | null; arousal: number | null }): number {
  if (b.valence === null || b.arousal === null) return 1;
  const dv = a.valence - b.valence;
  const da = a.arousal - b.arousal;
  return Math.sqrt(dv * dv + da * da);
}

function resonanceScore(query: EmotionCoord, memory: { valence: number | null; arousal: number | null; importance: number }): number {
  const dist = russellDistance(query, memory);
  const similarity = Math.max(0, 1 - dist / 2);
  return similarity * (0.5 + memory.importance * 0.5);
}

async function searchEmotionResonate(
  env: Env,
  input: { namespace: string; coord: EmotionCoord; limit: number }
): Promise<ScoredMemoryRecord[]> {
  const rows = await env.DB
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ?
         AND status = 'active'
         AND valence IS NOT NULL
         AND arousal IS NOT NULL
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`
    )
    .bind(input.namespace, Math.min(input.limit * 4, 80))
    .all<MemoryRecord>();

  const results: ScoredMemoryRecord[] = [];
  for (const record of (rows.results ?? [])) {
    const score = resonanceScore(input.coord, { valence: record.valence, arousal: record.arousal, importance: record.importance });
    if (score < EMOTION_RESONATE_MIN_SCORE) continue;
    results.push({ ...record, score, vectorScore: undefined, keywordScore: score });
  }
  return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, input.limit);
}

export async function searchMemories(env: Env, input: SearchMemoriesInput): Promise<MemoryApiRecord[]> {
  const topK = getTopK(env, input.topK);
  const candidateLimit = getCandidateLimit(topK);
  const rawQuery = input.rawQuery || input.query;
  const searchQuery = normalizeQueryForSearch(input.query);
  const timeIntent = parseTimeIntent(rawQuery);
  const expandedQuery = expandQuery([searchQuery, ...timeIntent.terms].filter(Boolean).join(" "));
  const hintedFactKeys = factKeysForQueryHint(`${rawQuery} ${input.query} ${searchQuery}`);
  const shouldAddGuidanceSeeds = GUIDANCE_QUERY_RE.test(`${rawQuery} ${input.query} ${searchQuery}`);
  const shouldLiteral = shouldRunLiteralSearch(rawQuery);
  const applyEAxis = shouldApplyEAxisToRanking(env);

  const queryAngles = await expandQueryAngles(env, rawQuery);
  const expandedAngles = queryAngles.length > 1 ? queryAngles : [expandedQuery];

  const vectorSearches = await Promise.all(
    expandedAngles.map((angle) =>
      searchVectorMemories(env, { namespace: input.namespace, query: angle, types: input.types, topK: candidateLimit })
    )
  );
  const allVectorHits = vectorSearches.flatMap((results) => results ?? []);
  const vectorRecords = allVectorHits.length > 0
    ? [...new Map(allVectorHits.map((r) => [r.id, r])).values()].sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0))
    : null;
  const vectorTopScore = vectorRecords && vectorRecords.length > 0 ? (vectorRecords[0].vectorScore ?? 0) : 0;

  const keywordRecords: ScoredMemoryRecord[] = [];
  const messageRecords: ScoredMemoryRecord[] = [];

  if (vectorTopScore < FTS_FLOOR) {
    const ftsResults = await searchMemoriesByText(env.DB, { namespace: input.namespace, query: expandedQuery, types: input.types, limit: candidateLimit });
    keywordRecords.push(...ftsResults.map((record) => ({ ...record, keywordScore: record.score })));

    if (vectorTopScore < RAW_EVENTS_FLOOR && input.includeMessages) {
      const rawResults = await searchMessagesForRecall(env.DB, {
        namespace: input.namespace,
        query: searchQuery,
        after: timeIntent.mode === "hard_range" ? timeIntent.after : undefined,
        before: timeIntent.mode === "hard_range" ? timeIntent.before : undefined,
        limit: Math.min(candidateLimit, 24)
      });
      messageRecords.push(...rawResults.map(messageToMemoryRecord));
    }
  }

  const hintedRecords = hintedFactKeys.length > 0
    ? await listActiveMemoriesByFactKeys(env.DB, {
        namespace: input.namespace,
        factKeys: hintedFactKeys,
        limit: Math.max(6, hintedFactKeys.length * 3),
        excludeTypes: ["diary", "layla_diary"]
      })
    : [];
  const guidanceSeedRecords = shouldAddGuidanceSeeds
    ? await listGuidanceSeedMemories(env.DB, { namespace: input.namespace, limit: 18 })
    : [];

  let literalRecords: ScoredMemoryRecord[] = [];
  if (shouldLiteral) {
    const literalTerms = literalQueryTerms(rawQuery);
    const literalHits = await searchMemoriesByText(env.DB, {
      namespace: input.namespace,
      query: literalTerms.join(" "),
      types: input.types,
      limit: LITERAL_TOP_K
    });
    literalRecords = literalHits
      .filter((record) => {
        const haystack = recordHaystack(record);
        return literalTerms.some((term) => haystack.includes(normalizeText(term)));
      })
      .map((record) => ({ ...record, score: Math.max(record.score, 0.82), keywordScore: Math.max(record.score, 0.82) }));
  }

  const emotionCoord = detectEmotionCoord(rawQuery);
  let emotionRecords: ScoredMemoryRecord[] = [];
  if (emotionCoord) {
    emotionRecords = await searchEmotionResonate(env, { namespace: input.namespace, coord: emotionCoord, limit: EMOTION_RESONATE_TOP_K });
  }

  const records = mergeSearchResults(
    vectorRecords,
    [
      ...keywordRecords,
      ...hintedRecords.map((record) => ({ ...record, score: QUERY_HINT_SCORE, keywordScore: QUERY_HINT_SCORE })),
      ...guidanceSeedRecords.map((record) => ({
        ...record,
        score: GUIDANCE_SEED_SCORE + Math.min(0.24, record.relation_count * 0.015) + record.importance * 0.08,
        keywordScore: GUIDANCE_SEED_SCORE
      })),
      ...messageRecords,
      ...literalRecords,
      ...emotionRecords
    ],
    {
      query: searchQuery,
      expandedQuery,
      topK: candidateLimit,
      timeIntent,
      applyEAxis
    }
  );
  const relationRecords = await listRelationExpandedMemories(env.DB, {
    namespace: input.namespace,
    baseIds: records.map((record) => record.id),
    limit: Math.max(topK, Math.ceil(candidateLimit / 3))
  });
  const recordsWithRelations = mergeRelatedRecords(records, relationRecords, candidateLimit);
  const apiRecords = recordsWithRelations.map((record) => toMemoryApiRecord(record, record.score));
  const processedRecords = await postProcessMemorySearchResults(env, { query: searchQuery, rawQuery, memories: apiRecords, topK });
  const finalRelationRecords = await listRelationExpandedMemories(env.DB, {
    namespace: input.namespace,
    baseIds: processedRecords.map((record) => record.id),
    limit: Math.max(topK, 8)
  });
  const relatedApiRecords = finalRelationRecords.map((record) => toMemoryApiRecord(record, record.score));
  const hintedApiRecords = hintedRecords.map((record) => toMemoryApiRecord(record, QUERY_HINT_SCORE));
  const outputRecords = applyLead(
    await rerankMemories(env, {
      query: searchQuery,
      memories: keepRelatedContext(keepExplicitHintContext(processedRecords, hintedApiRecords, topK), relatedApiRecords, topK),
      topK
    }),
    rawQuery
  );

  if (shouldRecordRecall(input)) {
    const memoryIds = outputRecords.map((record) => record.id).filter((id) => !id.startsWith("msg_"));
    await markMemoriesRecalled(env.DB, { namespace: input.namespace, ids: memoryIds });
  }

  return outputRecords;
}


