import { fetchMemoriesByIds, markMemoriesRecalled, searchMemoriesByText } from "../db/memories";
import type { Env, MemoryApiRecord, MemoryRecord } from "../types";
import { createEmbedding } from "./embedding";

type MetadataMap = Record<string, unknown>;
type ScoredMemoryRecord = MemoryRecord & { score: number; vectorScore?: number; keywordScore?: number };

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

function mergeSearchResults(
  vectorRecords: ScoredMemoryRecord[] | null,
  keywordRecords: ScoredMemoryRecord[],
  topK: number
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

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

export async function searchMemories(
  env: Env,
  input: { namespace: string; query: string; types?: string[]; topK?: number }
): Promise<MemoryApiRecord[]> {
  const topK = getTopK(env, input.topK);
  const candidateLimit = getCandidateLimit(topK);
  const [vectorRecords, keywordRecords] = await Promise.all([
    searchWithVectorize(env, {
      namespace: input.namespace,
      query: input.query,
      types: input.types,
      topK: candidateLimit
    }),
    searchMemoriesByText(env.DB, {
      namespace: input.namespace,
      query: input.query,
      types: input.types,
      limit: candidateLimit
    })
  ]);

  const records = mergeSearchResults(
    vectorRecords,
    keywordRecords.map((record) => ({ ...record, keywordScore: record.score })),
    topK
  );

  await markMemoriesRecalled(env.DB, {
    namespace: input.namespace,
    ids: records.map((record) => record.id)
  });

  return records.map((record) => toMemoryApiRecord(record, record.score));
}
