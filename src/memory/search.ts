import { markMemoriesRecalled, searchMemoriesByText } from "../db/memories";
import type { Env, MemoryApiRecord, MemoryRecord } from "../types";
import { postProcessMemorySearchResults } from "./postProcess";
import { searchVectorMemories, type ScoredMemoryRecord } from "./vectorStore";

const STRONG_KEYWORD_SCORE = 0.62;
const WEAK_KEYWORD_SCORE = 0.55;
const VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS = 0.68;

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
  return Math.min(Math.max(topK * 3, topK), 50);
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

function rankHybridRecord(record: ScoredMemoryRecord): number {
  const vectorScore = record.vectorScore ?? 0;
  const keywordScore = record.keywordScore ?? 0;
  const pinnedBoost = record.pinned ? 0.08 : 0;
  return vectorScore * 0.7 + keywordScore * 0.55 + record.importance * 0.08 + pinnedBoost + recencyBoost(record) * 0.04;
}

function hasStrongKeywordMatch(records: ScoredMemoryRecord[]): boolean {
  return records.some((record) => (record.keywordScore ?? 0) >= STRONG_KEYWORD_SCORE);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
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
  for (const word of words) needles.add(normalizeText(word));
  return [...needles].filter((needle) => needle.length >= 2).slice(0, 12);
}

function recordHaystack(record: MemoryRecord): string {
  return normalizeText(`${record.content} ${record.summary || ""} ${record.tags || ""} ${record.type}`);
}

function containsStrongNeedle(record: MemoryRecord, needles: string[]): boolean {
  const haystack = recordHaystack(record);
  return needles.some((needle) => haystack.includes(normalizeText(needle)));
}

function isSupportedBySearchMode(record: ScoredMemoryRecord, input: { hasStrongKeyword: boolean; strongNeedles: string[] }): boolean {
  if (!input.hasStrongKeyword) return true;
  if (input.strongNeedles.length > 0) return containsStrongNeedle(record, input.strongNeedles);
  if ((record.keywordScore ?? 0) >= WEAK_KEYWORD_SCORE) return true;
  return (record.vectorScore ?? 0) >= VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS;
}

function mergeSearchResults(
  vectorRecords: ScoredMemoryRecord[] | null,
  keywordRecords: ScoredMemoryRecord[],
  input: { query: string; topK: number }
): ScoredMemoryRecord[] {
  const merged = new Map<string, ScoredMemoryRecord>();

  function add(record: ScoredMemoryRecord): void {
    const existing = merged.get(record.id);
    if (!existing) {
      const next = { ...record };
      next.score = rankHybridRecord(next);
      merged.set(record.id, next);
      return;
    }

    const vectorScore = Math.max(existing.vectorScore ?? 0, record.vectorScore ?? 0);
    const keywordScore = Math.max(existing.keywordScore ?? 0, record.keywordScore ?? 0);
    const next: ScoredMemoryRecord = { ...existing, ...record, vectorScore: vectorScore || undefined, keywordScore: keywordScore || undefined };
    next.score = rankHybridRecord(next);
    merged.set(record.id, next);
  }

  for (const record of vectorRecords ?? []) add(record);
  for (const record of keywordRecords) add(record);

  const rankedRecords = [...merged.values()].sort((a, b) => b.score - a.score);
  const hasStrongKeyword = hasStrongKeywordMatch(rankedRecords);
  const strongNeedles = extractStrongNeedles(input.query);
  const filteredRecords = rankedRecords.filter((record) => isSupportedBySearchMode(record, { hasStrongKeyword, strongNeedles }));
  return (filteredRecords.length > 0 ? filteredRecords : rankedRecords).slice(0, input.topK);
}

export async function searchMemories(
  env: Env,
  input: { namespace: string; query: string; types?: string[]; topK?: number }
): Promise<MemoryApiRecord[]> {
  const topK = getTopK(env, input.topK);
  const candidateLimit = getCandidateLimit(topK);
  const expandedQuery = expandQuery(input.query);
  const [vectorRecords, keywordRecords] = await Promise.all([
    searchVectorMemories(env, { namespace: input.namespace, query: expandedQuery, types: input.types, topK: candidateLimit }),
    searchMemoriesByText(env.DB, { namespace: input.namespace, query: expandedQuery, types: input.types, limit: candidateLimit })
  ]);

  const records = mergeSearchResults(
    vectorRecords,
    keywordRecords.map((record) => ({ ...record, keywordScore: record.score })),
    { query: expandedQuery, topK: candidateLimit }
  );
  const apiRecords = records.map((record) => toMemoryApiRecord(record, record.score));
  const processedRecords = await postProcessMemorySearchResults(env, { query: input.query, memories: apiRecords, topK });

  await markMemoriesRecalled(env.DB, { namespace: input.namespace, ids: processedRecords.map((record) => record.id) });
  return processedRecords;
}
