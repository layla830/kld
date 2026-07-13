import type { MemoryRecord } from "../types";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { buildVectorId } from "../utils/vectorId";

const D1_BIND_LIMIT = 90;
const CANONICAL_SEARCH_TYPES = new Set(["rule", "lesson", "core", "preference"]);

export interface CreateMemoryInput {
  namespace: string;
  type: string;
  content: string;
  summary?: string | null;
  factKey?: string | null;
  activeFact?: boolean;
  thread?: string | null;
  riskLevel?: string | null;
  urgencyLevel?: string | null;
  tensionScore?: number | null;
  responsePosture?: string | null;
  auditState?: string | null;
  valence?: number | null;
  arousal?: number | null;
  importance?: number;
  confidence?: number;
  status?: string;
  pinned?: boolean;
  tags?: string[];
  source?: string | null;
  sourceMessageIds?: string[];
  expiresAt?: string | null;
}

export interface ListMemoryFilters {
  namespace: string;
  type?: string;
  status?: string;
  factKey?: string;
  thread?: string;
  limit: number;
}

export interface ListUnsyncedMemoryFilters {
  namespace: string;
  ids?: string[];
  force?: boolean;
  limit: number;
}

export interface UpdateMemoryInput {
  type?: string;
  content?: string;
  summary?: string | null;
  factKey?: string | null;
  activeFact?: boolean;
  thread?: string | null;
  riskLevel?: string | null;
  urgencyLevel?: string | null;
  tensionScore?: number | null;
  responsePosture?: string | null;
  auditState?: string | null;
  valence?: number | null;
  arousal?: number | null;
  importance?: number;
  confidence?: number;
  status?: string;
  pinned?: boolean;
  tags?: string[];
  sourceMessageIds?: string[];
  expiresAt?: string | null;
  vectorSyncStatus?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function markMemoryVectorUnsynced(db: D1Database, input: { namespace: string; id: string }): Promise<void> {
  try {
    await db.prepare("UPDATE memories SET vector_synced = 0 WHERE namespace = ? AND id = ?").bind(input.namespace, input.id).run();
  } catch (error) {
    console.warn("memory vector_synced flag unavailable", input.id, error);
  }
}

function activeFactForStatus(status: string): number {
  return status === "active" ? 1 : 0;
}

export async function createMemory(db: D1Database, input: CreateMemoryInput): Promise<MemoryRecord> {
  const id = newId("mem");
  const now = nowIso();
  const vectorId = buildVectorId(id);
  const status = input.status ?? "active";
  const record: MemoryRecord = {
    id,
    namespace: input.namespace,
    type: input.type,
    content: input.content,
    summary: input.summary ?? null,
    fact_key: input.factKey ?? null,
    active_fact: input.activeFact === undefined ? activeFactForStatus(status) : input.activeFact ? 1 : 0,
    thread: input.thread ?? null,
    risk_level: input.riskLevel ?? null,
    urgency_level: input.urgencyLevel ?? null,
    tension_score: input.tensionScore ?? null,
    response_posture: input.responsePosture ?? null,
    audit_state: input.auditState ?? null,
    valence: input.valence ?? null,
    arousal: input.arousal ?? null,
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    status,
    pinned: input.pinned ? 1 : 0,
    tags: JSON.stringify(input.tags ?? []),
    source: input.source ?? null,
    source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
    vector_id: vectorId,
    vector_synced: 0,
    last_recalled_at: null,
    recall_count: 0,
    created_at: now,
    updated_at: now,
    expires_at: input.expiresAt ?? null
  };

  await db
    .prepare(
      `INSERT INTO memories (
        id, namespace, type, content, summary, fact_key, active_fact,
        thread, risk_level, urgency_level, tension_score, response_posture, audit_state,
        valence, arousal,
        importance, confidence, status,
        pinned, tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.namespace,
      record.type,
      record.content,
      record.summary,
      record.fact_key,
      record.active_fact,
      record.thread,
      record.risk_level,
      record.urgency_level,
      record.tension_score,
      record.response_posture,
      record.audit_state,
      record.valence,
      record.arousal,
      record.importance,
      record.confidence,
      record.status,
      record.pinned,
      record.tags,
      record.source,
      record.source_message_ids,
      record.vector_id,
      record.created_at,
      record.updated_at,
      record.expires_at
    )
    .run();

  return record;
}

export async function listMemories(db: D1Database, filters: ListMemoryFilters): Promise<MemoryRecord[]> {
  let sql = "SELECT * FROM memories WHERE namespace = ?";
  const binds: unknown[] = [filters.namespace];

  if (filters.type) {
    sql += " AND type = ?";
    binds.push(filters.type);
  }

  if (filters.status) {
    sql += " AND status = ?";
    binds.push(filters.status);
  }

  if (filters.factKey) {
    sql += " AND fact_key = ?";
    binds.push(filters.factKey);
  }

  if (filters.thread) {
    sql += " AND thread = ?";
    binds.push(filters.thread);
  }

  sql += " ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?";
  binds.push(filters.limit);

  const result = await db.prepare(sql).bind(...binds).all<MemoryRecord>();
  return result.results ?? [];
}

export async function getMemoryById(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryRecord | null> {
  const record = await db
    .prepare("SELECT * FROM memories WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id)
    .first<MemoryRecord>();

  return record ?? null;
}

export async function ensureMemoryVectorId(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryRecord | null> {
  const existing = await getMemoryById(db, input);
  if (!existing || existing.vector_id) return existing;

  await db
    .prepare("UPDATE memories SET vector_id = ?, updated_at = ? WHERE namespace = ? AND id = ? AND (vector_id IS NULL OR vector_id = '')")
    .bind(buildVectorId(existing.id), nowIso(), input.namespace, input.id)
    .run();

  return getMemoryById(db, input);
}

export async function fetchMemoriesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MemoryRecord[]> {
  if (input.ids.length === 0) return [];

  const rows: MemoryRecord[] = [];
  const idsPerQuery = D1_BIND_LIMIT - 1;
  for (const ids of chunk(input.ids, idsPerQuery)) {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND id IN (${placeholders})`)
      .bind(input.namespace, ...ids)
      .all<MemoryRecord>();
    rows.push(...(result.results ?? []));
  }

  const order = new Map(input.ids.map((id, index) => [id, index]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function listUnsyncedVectorMemories(db: D1Database, input: ListUnsyncedMemoryFilters): Promise<MemoryRecord[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 50);
  const ids = [...new Set((input.ids ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, D1_BIND_LIMIT - 2);
  let sql = "SELECT * FROM memories WHERE namespace = ? AND status = 'active'";
  const binds: unknown[] = [input.namespace];

  if (!input.force) {
    sql += " AND vector_synced = 0";
  }

  if (ids.length > 0) {
    sql += ` AND id IN (${ids.map(() => "?").join(", ")})`;
    binds.push(...ids);
  }

  sql += " ORDER BY updated_at DESC LIMIT ?";
  binds.push(limit);
  const result = await db.prepare(sql).bind(...binds).all<MemoryRecord>();
  return result.results ?? [];
}

export async function listGuidanceSeedMemories(
  db: D1Database,
  input: { namespace: string; limit: number }
): Promise<Array<MemoryRecord & { relation_count: number }>> {
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 30);
  const result = await db
    .prepare(
      `SELECT m.*, COUNT(r.id) AS relation_count
       FROM memories m
       LEFT JOIN memory_relations r
         ON r.namespace = m.namespace
        AND (r.source_memory_id = m.id OR r.target_memory_id = m.id)
       WHERE m.namespace = ?
         AND m.status = 'active'
         AND m.fact_key IS NOT NULL AND m.fact_key != ''
         AND m.response_posture IS NOT NULL AND m.response_posture != ''
         AND m.type IN ('rule','lesson','core','preference')
       GROUP BY m.id
       ORDER BY relation_count DESC, m.importance DESC, m.updated_at DESC
       LIMIT ?`
    )
    .bind(input.namespace, limit)
    .all<MemoryRecord & { relation_count: number }>();
  return result.results ?? [];
}

export async function listActiveMemoriesByFactKeys(
  db: D1Database,
  input: { namespace: string; factKeys: string[]; limit: number; excludeTypes?: string[] }
): Promise<MemoryRecord[]> {
  const factKeys = [...new Set(input.factKeys.map((factKey) => factKey.trim()).filter(Boolean))];
  if (factKeys.length === 0) return [];

  const rows: MemoryRecord[] = [];
  const excludeTypes = [...new Set((input.excludeTypes ?? []).map((type) => type.trim()).filter(Boolean))];
  const typeClause = excludeTypes.length > 0 ? ` AND type NOT IN (${excludeTypes.map(() => "?").join(", ")})` : "";
  const keysPerQuery = Math.max(1, D1_BIND_LIMIT - 2 - excludeTypes.length);
  for (const keys of chunk(factKeys, keysPerQuery)) {
    const placeholders = keys.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT * FROM memories
         WHERE namespace = ?
           AND status = 'active'
           AND fact_key IN (${placeholders})
           ${typeClause}
         ORDER BY pinned DESC, importance DESC, updated_at DESC
         LIMIT ?`
      )
      .bind(input.namespace, ...keys, ...excludeTypes, input.limit)
      .all<MemoryRecord>();
    rows.push(...(result.results ?? []));
  }

  return rows
    .sort((a, b) => b.pinned - a.pinned || b.importance - a.importance || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, input.limit);
}

export async function updateMemory(
  db: D1Database,
  input: {
    namespace: string;
    id: string;
    patch: UpdateMemoryInput;
    expectedStatus?: string;
    requireUnpinned?: boolean;
  }
): Promise<MemoryRecord | null> {
  const assignments: string[] = [];
  const binds: unknown[] = [];

  function set(column: string, value: unknown): void {
    assignments.push(`${column} = ?`);
    binds.push(value);
  }

  if (input.patch.type !== undefined) set("type", input.patch.type);
  if (input.patch.content !== undefined) set("content", input.patch.content);
  if (input.patch.summary !== undefined) set("summary", input.patch.summary);
  if (input.patch.factKey !== undefined) set("fact_key", input.patch.factKey);
  if (input.patch.activeFact !== undefined) set("active_fact", input.patch.activeFact ? 1 : 0);
  if (input.patch.thread !== undefined) set("thread", input.patch.thread);
  if (input.patch.riskLevel !== undefined) set("risk_level", input.patch.riskLevel);
  if (input.patch.urgencyLevel !== undefined) set("urgency_level", input.patch.urgencyLevel);
  if (input.patch.tensionScore !== undefined) set("tension_score", input.patch.tensionScore);
  if (input.patch.responsePosture !== undefined) set("response_posture", input.patch.responsePosture);
  if (input.patch.auditState !== undefined) set("audit_state", input.patch.auditState);
  if (input.patch.valence !== undefined) set("valence", input.patch.valence);
  if (input.patch.arousal !== undefined) set("arousal", input.patch.arousal);
  if (input.patch.importance !== undefined) set("importance", input.patch.importance);
  if (input.patch.confidence !== undefined) set("confidence", input.patch.confidence);
  if (input.patch.status !== undefined) {
    set("status", input.patch.status);
    if (input.patch.activeFact === undefined) set("active_fact", activeFactForStatus(input.patch.status));
  }
  if (input.patch.pinned !== undefined) set("pinned", input.patch.pinned ? 1 : 0);
  if (input.patch.tags !== undefined) set("tags", JSON.stringify(input.patch.tags));
  if (input.patch.sourceMessageIds !== undefined) set("source_message_ids", JSON.stringify(input.patch.sourceMessageIds));
  if (input.patch.expiresAt !== undefined) set("expires_at", input.patch.expiresAt);
  if (input.patch.vectorSyncStatus !== undefined) set("vector_sync_status", input.patch.vectorSyncStatus);

  if (assignments.length === 0) return getMemoryById(db, input);

  set("updated_at", nowIso());

  const where = ["namespace = ?", "id = ?"];
  const whereBinds: unknown[] = [input.namespace, input.id];
  if (input.expectedStatus) {
    where.push("status = ?");
    whereBinds.push(input.expectedStatus);
  }
  if (input.requireUnpinned) {
    where.push("pinned = 0");
  }

  const result = await db
    .prepare(`UPDATE memories SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`)
    .bind(...binds, ...whereBinds)
    .run();

  if ((result.meta.changes ?? 0) === 0) return null;
  if (input.patch.vectorSyncStatus === undefined) await markMemoryVectorUnsynced(db, input);
  return getMemoryById(db, input);
}

export async function softDeleteMemory(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryRecord | null> {
  return updateMemory(db, { namespace: input.namespace, id: input.id, patch: { status: "deleted" } });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function chineseNgrams(value: string): string[] {
  const grams: string[] = [];
  for (let size = 2; size <= Math.min(4, value.length); size += 1) {
    for (let index = 0; index <= value.length - size; index += 1) {
      grams.push(value.slice(index, index + size));
    }
  }
  return grams;
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
  const words = normalized.match(/[a-z0-9_+-]{2,}|[\u4e00-\u9fff]{1,}/gi) ?? [];
  const tokens = words.flatMap((word) => {
    if (/^[\u4e00-\u9fff]+$/.test(word) && word.length > 2) {
      return [word, ...chineseNgrams(word)];
    }
    return [word];
  });
  return [...new Set(tokens)].slice(0, 24);
}

function haystack(record: MemoryRecord): string {
  return `${record.content} ${record.summary || ""} ${record.fact_key || ""} ${record.tags || ""} ${record.type}`.toLowerCase();
}

function scoreKeywordRecord(record: MemoryRecord, query: string, tokens: string[]): number {
  const text = haystack(record);
  const tagsAndType = `${record.tags || ""} ${record.type}`.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const exact = normalizedQuery && text.includes(normalizedQuery) ? 0.25 : 0;
  const hits = tokens.filter((token) => text.includes(token)).length;
  const tagOrTypeHits = tokens.filter((token) => tagsAndType.includes(token)).length;

  const denominator = Math.max(1, Math.min(tokens.length, 4));
  const tokenScore = tokens.length ? Math.min(1, hits / denominator) : 0;
  const presenceBoost = hits > 0 ? 0.14 : 0;
  const tagBoost = tagOrTypeHits > 0 ? Math.min(0.22, tagOrTypeHits * 0.11) : 0;
  const canonicalBoost = record.fact_key && CANONICAL_SEARCH_TYPES.has(record.type.toLowerCase()) ? 0.12 : 0;
  return 0.28 + exact + presenceBoost + tagBoost + tokenScore * 0.35 + canonicalBoost + record.importance * 0.05 + (record.pinned ? 0.05 : 0);
}

export async function searchMemoriesByText(
  db: D1Database,
  input: { namespace: string; query: string; types?: string[]; excludeTypes?: string[]; limit: number }
): Promise<Array<MemoryRecord & { score: number }>> {
  const query = input.query.trim().replace(/\s+/g, " ").slice(0, 500);
  const tokens = tokenizeQuery(query);
  let sql = "SELECT * FROM memories WHERE namespace = ? AND status = 'active'";
  const binds: unknown[] = [input.namespace];

  const typeBudget = Math.max(0, D1_BIND_LIMIT - binds.length - 6);
  const types = [...new Set((input.types ?? []).map((type) => type.trim()).filter(Boolean))]
    .slice(0, Math.min(input.types?.length ?? 0, typeBudget, 20));
  if (types.length > 0) {
    sql += ` AND type IN (${types.map(() => "?").join(", ")})`;
    binds.push(...types);
  }
  const excludeBudget = Math.max(0, typeBudget - types.length);
  const excludeTypes = [...new Set((input.excludeTypes ?? []).map((type) => type.trim()).filter(Boolean))]
    .slice(0, Math.min(input.excludeTypes?.length ?? 0, excludeBudget, 20));
  if (excludeTypes.length > 0) {
    sql += ` AND type NOT IN (${excludeTypes.map(() => "?").join(", ")})`;
    binds.push(...excludeTypes);
  }

  if (query) {
    const clauses = [
      `content LIKE ? ESCAPE '\\'`,
      `summary LIKE ? ESCAPE '\\'`,
      `fact_key LIKE ? ESCAPE '\\'`,
      `tags LIKE ? ESCAPE '\\'`,
      `type LIKE ? ESCAPE '\\'`
    ];
    const exactLike = `%${escapeLike(query)}%`;
    binds.push(exactLike, exactLike, exactLike, exactLike, exactLike);

    const tokenBudget = Math.max(0, Math.floor((D1_BIND_LIMIT - binds.length - 1) / 5));
    const safeTokens = tokens.slice(0, tokenBudget);
    for (const token of safeTokens) {
      const like = `%${escapeLike(token)}%`;
      clauses.push(
        `content LIKE ? ESCAPE '\\'`,
        `summary LIKE ? ESCAPE '\\'`,
        `fact_key LIKE ? ESCAPE '\\'`,
        `tags LIKE ? ESCAPE '\\'`,
        `type LIKE ? ESCAPE '\\'`
      );
      binds.push(like, like, like, like, like);
    }

    sql += ` AND (${clauses.join(" OR ")})`;
  }

  sql += " ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?";
  binds.push(Math.max(input.limit * 4, input.limit));

  let result: D1Result<MemoryRecord>;
  try {
    result = await db.prepare(sql).bind(...binds).all<MemoryRecord>();
  } catch (error) {
    console.error("text memory search failed", error);
    return [];
  }

  return (result.results ?? [])
    .map((record) => ({ ...record, score: scoreKeywordRecord(record, query, tokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);
}

export async function markMemoriesRecalled(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<void> {
  if (input.ids.length === 0) return;

  const idsPerQuery = D1_BIND_LIMIT - 2;
  for (const ids of chunk(input.ids, idsPerQuery)) {
    const placeholders = ids.map(() => "?").join(", ");
    await db
      .prepare(
        `UPDATE memories
         SET last_recalled_at = ?, recall_count = recall_count + 1
         WHERE namespace = ? AND id IN (${placeholders})`
      )
      .bind(nowIso(), input.namespace, ...ids)
      .run();
  }
}

export async function listFactKeyConflicts(
  db: D1Database,
  input: { namespace: string; limit: number; factKeys?: string[] }
): Promise<Array<{ fact_key: string; ids: string; count: number }>> {
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const factKeys = [...new Set((input.factKeys ?? []).map((key) => key.trim()).filter(Boolean))].slice(0, D1_BIND_LIMIT - 2);
  const factKeyClause = factKeys.length > 0 ? ` AND fact_key IN (${factKeys.map(() => "?").join(", ")})` : "";
  const result = await db
    .prepare(
      `SELECT fact_key, GROUP_CONCAT(id) AS ids, COUNT(*) AS count
       FROM memories
       WHERE namespace = ?
         AND fact_key IS NOT NULL AND fact_key != ''
         AND status IN ('active', 'review')
         ${factKeyClause}
       GROUP BY fact_key
       HAVING count > 1
       ORDER BY count DESC
       LIMIT ?`
    )
    .bind(input.namespace, ...factKeys, limit)
    .all<{ fact_key: string; ids: string; count: number }>();
  return result.results ?? [];
}

export async function listMemoriesSince(
  db: D1Database,
  input: { namespace: string; since: string; limit: number }
): Promise<MemoryRecord[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 1000);
  const result = await db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ?
         AND created_at >= ?
         AND status IN ('active', 'review')
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .bind(input.namespace, input.since, limit)
    .all<MemoryRecord>();
  return result.results ?? [];
}
