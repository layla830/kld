import { fetchMemoriesByIds, markMemoriesRecalled, searchMemoriesByText } from "../db/memories";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryApiRecord, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { createEmbedding } from "./embedding";

type MetadataMap = Record<string, unknown>;
type ScoredMemoryRecord = MemoryRecord & { score: number; vectorScore?: number; keywordScore?: number };

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

function getMinScore(env: Env): number {
  const value = Number(env.MEMORY_MIN_SCORE || 0.35);
  return Number.isFinite(value) ? value : 0.35;
}

function getRefId(match: VectorizeMatch): string | null {
  const metadata = (match.metadata || {}) as MetadataMap;
  const refId = metadata.ref_id;
  if (typeof refId === "string") return refId;
  if (match.id.startsWith("mem_")) return match.id.slice("mem_".length);
  return null;
}

function readMetadataText(metadata: MetadataMap): string | null {
  const fields = ["content", "text", "memory", "summary", "document", "chunk", "value", "title"];

  for (const field of fields) {
    const value = metadata[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return null;
}

function readMetadataString(metadata: MetadataMap, field: string): string | null {
  const value = metadata[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readMetadataNumber(metadata: MetadataMap, field: string, fallback: number): number {
  const value = metadata[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readMetadataBoolean(metadata: MetadataMap, field: string): boolean {
  const value = metadata[field];
  return value === true || value === "true";
}

function readMetadataStringArray(metadata: MetadataMap, field: string): string[] {
  const value = metadata[field];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function toLegacyMemoryRecord(
  match: VectorizeMatch,
  input: { namespace: string }
): ScoredMemoryRecord | null {
  const metadata = (match.metadata || {}) as MetadataMap;
  const status = readMetadataString(metadata, "status");
  if (status && status !== "active") return null;

  const content = readMetadataText(metadata);
  if (!content) return null;

  const now = new Date(0).toISOString();
  const id = getRefId(match) || match.id;
  return {
    id,
    namespace: readMetadataString(metadata, "namespace") || input.namespace,
    type: readMetadataString(metadata, "type") || "note",
    content,
    summary: readMetadataString(metadata, "summary"),
    importance: readMetadataNumber(metadata, "importance", 0.5),
    confidence: readMetadataNumber(metadata, "confidence", 0.8),
    status: "active",
    pinned: readMetadataBoolean(metadata, "pinned") ? 1 : 0,
    tags: JSON.stringify(readMetadataStringArray(metadata, "tags")),
    source: readMetadataString(metadata, "source_id") || readMetadataString(metadata, "source") || "vectorize-legacy",
    source_message_ids: JSON.stringify([]),
    vector_id: match.id,
    last_recalled_at: null,
    recall_count: 0,
    created_at: readMetadataString(metadata, "created_at") || now,
    updated_at: readMetadataString(metadata, "updated_at") || now,
    expires_at: null,
    score: match.score,
    vectorScore: match.score
  };
}

async function queryVectorize(
  env: Env,
  vector: number[],
  input: { namespace: string; types?: string[]; topK: number },
  useFilter: boolean
): Promise<VectorizeMatches> {
  if (!useFilter) {
    return env.VECTORIZE!.query(vector, {
      topK: input.topK,
      returnMetadata: true
    });
  }

  const filter: VectorizeVectorMetadataFilter = {
    namespace: input.namespace,
    status: "active"
  };

  if (input.types && input.types.length > 0) {
    filter.type = { $in: input.types };
  }

  return env.VECTORIZE!.query(vector, {
    topK: input.topK,
    namespace: input.namespace,
    returnMetadata: true,
    filter
  });
}

async function searchWithVectorize(
  env: Env,
  input: { namespace: string; query: string; types?: string[]; topK: number }
): Promise<ScoredMemoryRecord[] | null> {
  if (!env.VECTORIZE || !input.query.trim()) return null;

  const vector = await createEmbedding(env, input.query);
  if (!vector) return null;

  let result = await queryVectorize(env, vector, input, true);
  if (result.matches.length === 0) {
    result = await queryVectorize(env, vector, input, false);
  }

  const minScore = getMinScore(env);
  const scoredIds = new Map<string, number>();
  const legacyRecords: ScoredMemoryRecord[] = [];

  for (const match of result.matches) {
    if (match.score < minScore) continue;
    const id = getRefId(match);
    if (id) scoredIds.set(id, Math.max(scoredIds.get(id) ?? 0, match.score));
    const legacy = toLegacyMemoryRecord(match, input);
    if (legacy) legacyRecords.push(legacy);
  }

  const allRecords = await fetchMemoriesByIds(env.DB, {
    namespace: input.namespace,
    ids: [...scoredIds.keys()]
  });

  // Only return active memories; expired/deleted/superseded records must not be injected.
  const activeRecords = allRecords.filter((record) => record.status === "active");

  // Use allRecords (not just active) so inactive D1 records block legacy fallback.
  const foundD1Ids = new Set(allRecords.map((record) => record.id));
  const d1Records = activeRecords.map((record) => {
    const score = scoredIds.get(record.id) ?? 0;
    return { ...record, score, vectorScore: score };
  });
  const legacyOnlyRecords = legacyRecords.filter((record) => !foundD1Ids.has(record.id));

  return [...d1Records, ...legacyOnlyRecords].sort(
    (a, b) => b.score + b.importance * 0.05 - (a.score + a.importance * 0.05)
  );
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

function getRewriteModel(env: Env): string | null {
  return env.MEMORY_QUERY_REWRITE_MODEL || env.MEMORY_FILTER_MODEL || env.MEMORY_MODEL || null;
}

function isRewriteEnabled(env: Env): boolean {
  return env.ENABLE_MEMORY_QUERY_REWRITE === "true" && Boolean(getRewriteModel(env));
}

function extractJsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { queries?: unknown }).queries)) {
      return (parsed as { queries: unknown[] }).queries;
    }
  } catch {
    // Providers sometimes wrap JSON in prose; try extracting the outer array below.
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanRewriteTerm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!text || text.length < 2) return null;
  return text;
}

function parseRewriteTerms(text: string, originalQuery: string): string[] {
  const items = extractJsonArray(text) ?? [];
  const terms = new Set<string>([originalQuery.trim()]);
  for (const item of items) {
    const term = cleanRewriteTerm(item);
    if (term) terms.add(term);
  }
  return [...terms].filter(Boolean).slice(0, 10);
}

function buildRewritePrompt(query: string): string {
  return [
    "你是个人长期记忆库的搜索改写器。",
    "把用户搜索词改写成 4-10 个适合检索的短查询词/短语，用来找相关记忆。",
    "规则：",
    "- 必须保留原始查询。",
    "- 展开缩写、别名、上位概念、中文/英文说法、相关术语。",
    "- 日期要补充常见格式，例如 2026.4.17 / 2026-04-17 / 4月17日。",
    "- 不要编造具体事实，不要添加人名、日期或事件，除非它们已经出现在查询里。",
    "- 每个词/短语不超过 20 个中文字符或 8 个英文词。",
    "- 只输出 JSON 数组，不要 markdown，不要解释。",
    "例子：",
    "sm -> [\"sm\", \"BDSM\", \"dom\", \"sub\", \"brat\", \"switch\", \"支配\", \"臣服\"]",
    "cf记忆库 -> [\"cf记忆库\", \"Cloudflare 记忆库\", \"Worker\", \"D1\", \"Vectorize\", \"memory MCP\"]",
    "",
    `用户搜索词：${query}`
  ].join("\n");
}

async function rewriteQueryWithModel(env: Env, query: string): Promise<string> {
  const trimmed = query.trim();
  const model = getRewriteModel(env);
  if (!trimmed || !isRewriteEnabled(env) || !model) return trimmed;

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。你只输出 JSON。" },
      { role: "user", content: buildRewritePrompt(trimmed) }
    ],
    temperature: 0,
    max_tokens: 240,
    stream: false
  };

  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return trimmed;
    const parsed = (await response.json()) as OpenAIChatResponse;
    const message = parsed.choices?.[0]?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    const terms = parseRewriteTerms(content || reasoning, trimmed);
    return terms.join(" ").slice(0, 500);
  } catch (error) {
    console.error("memory query rewrite failed", error);
    return trimmed;
  }
}

function dateNeedles(value: string): string[] {
  const needles: string[] = [];
  const matches = value.match(/\b\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\b/g) ?? [];
  for (const match of matches) {
    const parts = match.split(/[.\-/]/).map((part) => Number(part));
    const [year, month, day] = parts;
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
    const next: ScoredMemoryRecord = {
      ...existing,
      ...record,
      vectorScore: vectorScore || undefined,
      keywordScore: keywordScore || undefined
    };
    next.score = rankHybridRecord(next);
    merged.set(record.id, next);
  }

  for (const record of vectorRecords ?? []) add(record);
  for (const record of keywordRecords) add(record);

  const records = [...merged.values()];
  const hasStrongKeyword = hasStrongKeywordMatch(records);
  const strongNeedles = extractStrongNeedles(input.query);
  return records
    .filter((record) => isSupportedBySearchMode(record, { hasStrongKeyword, strongNeedles }))
    .sort((a, b) => b.score - a.score)
    .slice(0, input.topK);
}

export async function searchMemories(
  env: Env,
  input: { namespace: string; query: string; types?: string[]; topK?: number }
): Promise<MemoryApiRecord[]> {
  const topK = getTopK(env, input.topK);
  const candidateLimit = getCandidateLimit(topK);
  const rewrittenQuery = await rewriteQueryWithModel(env, input.query);
  const expandedQuery = expandQuery(rewrittenQuery);
  const [vectorRecords, keywordRecords] = await Promise.all([
    searchWithVectorize(env, {
      namespace: input.namespace,
      query: expandedQuery,
      types: input.types,
      topK: candidateLimit
    }),
    searchMemoriesByText(env.DB, {
      namespace: input.namespace,
      query: expandedQuery,
      types: input.types,
      limit: candidateLimit
    })
  ]);

  const records = mergeSearchResults(
    vectorRecords,
    keywordRecords.map((record) => ({ ...record, keywordScore: record.score })),
    { query: expandedQuery, topK }
  );

  await markMemoriesRecalled(env.DB, {
    namespace: input.namespace,
    ids: records.map((record) => record.id)
  });

  return records.map((record) => toMemoryApiRecord(record, record.score));
}
