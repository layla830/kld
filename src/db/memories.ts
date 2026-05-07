import type { MemoryRecord } from "../types";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateMemoryInput {
  namespace: string;
  type: string;
  content: string;
  summary?: string | null;
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
  limit: number;
}

export interface UpdateMemoryInput {
  type?: string;
  content?: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  status?: string;
  pinned?: boolean;
  tags?: string[];
  sourceMessageIds?: string[];
  expiresAt?: string | null;
}

export async function createMemory(db: D1Database, input: CreateMemoryInput): Promise<MemoryRecord> {
  const id = newId("mem");
  const now = nowIso();
  const vectorId = `mem_${id}`;
  const record: MemoryRecord = {
    id,
    namespace: input.namespace,
    type: input.type,
    content: input.content,
    summary: input.summary ?? null,
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    status: input.status ?? "active",
    pinned: input.pinned ? 1 : 0,
    tags: JSON.stringify(input.tags ?? []),
    source: input.source ?? null,
    source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
    vector_id: vectorId,
    last_recalled_at: null,
    recall_count: 0,
    created_at: now,
    updated_at: now,
    expires_at: input.expiresAt ?? null
  };

  await db
    .prepare(
      `INSERT INTO memories (
        id, namespace, type, content, summary, importance, confidence, status,
        pinned, tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.namespace,
      record.type,
      record.content,
      record.summary,
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

export async function fetchMemoriesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MemoryRecord[]> {
  if (input.ids.length === 0) return [];

  const placeholders = input.ids.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT * FROM memories WHERE namespace = ? AND id IN (${placeholders})`)
    .bind(input.namespace, ...input.ids)
    .all<MemoryRecord>();

  return result.results ?? [];
}

export async function updateMemory(
  db: D1Database,
  input: { namespace: string; id: string; patch: UpdateMemoryInput }
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
  if (input.patch.importance !== undefined) set("importance", input.patch.importance);
  if (input.patch.confidence !== undefined) set("confidence", input.patch.confidence);
  if (input.patch.status !== undefined) set("status", input.patch.status);
  if (input.patch.pinned !== undefined) set("pinned", input.patch.pinned ? 1 : 0);
  if (input.patch.tags !== undefined) set("tags", JSON.stringify(input.patch.tags));
  if (input.patch.sourceMessageIds !== undefined) set("source_message_ids", JSON.stringify(input.patch.sourceMessageIds));
  if (input.patch.expiresAt !== undefined) set("expires_at", input.patch.expiresAt);

  if (assignments.length === 0) return getMemoryById(db, input);

  set("updated_at", nowIso());

  await db
    .prepare(`UPDATE memories SET ${assignments.join(", ")} WHERE namespace = ? AND id = ?`)
    .bind(...binds, input.namespace, input.id)
    .run();

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

function tokenizeQuery(query: string): string[] {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
  const words = normalized.match(/[a-z0-9_+-]{2,}|[\u4e00-\u9fff]{1,}/gi) ?? [];
  const tokens = words.flatMap((word) => {
    if (/^[\u4e00-\u9fff]+$/.test(word) && word.length > 2) {
      return [word, ...Array.from(word)];
    }
    return [word];
  });
  return [...new Set(tokens)].slice(0, 12);
}

function haystack(record: MemoryRecord): string {
  return `${record.content} ${record.summary || ""} ${record.tags || ""} ${record.type}`.toLowerCase();
}

function scoreKeywordRecord(record: MemoryRecord, query: string, tokens: string[]): number {
  const text = haystack(record);
  const exact = query && text.includes(query.toLowerCase()) ? 0.25 : 0;
  const hits = tokens.filter((token) => text.includes(token)).length;
  const tokenScore = tokens.length ? hits / tokens.length : 0;
  return 0.35 + exact + tokenScore * 0.35 + record.importance * 0.05 + (record.pinned ? 0.05 : 0);
}

export async function searchMemoriesByText(
  db: D1Database,
  input: { namespace: string; query: string; types?: string[]; limit: number }
): Promise<Array<MemoryRecord & { score: number }>> {
  const query = input.query.trim().replace(/\s+/g, " ").slice(0, 500);
  const tokens = tokenizeQuery(query);
  let sql = "SELECT * FROM memories WHERE namespace = ? AND status = 'active'";
  const binds: unknown[] = [input.namespace];

  if (input.types && input.types.length > 0) {
    sql += ` AND type IN (${input.types.map(() => "?").join(", ")})`;
    binds.push(...input.types);
  }

  if (query) {
    const clauses = [`content LIKE ? ESCAPE '\\'`, `summary LIKE ? ESCAPE '\\'`, `tags LIKE ? ESCAPE '\\'`, `type LIKE ? ESCAPE '\\'`];
    const exactLike = `%${escapeLike(query)}%`;
    binds.push(exactLike, exactLike, exactLike, exactLike);

    for (const token of tokens) {
      const like = `%${escapeLike(token)}%`;
      clauses.push(`content LIKE ? ESCAPE '\\'`, `summary LIKE ? ESCAPE '\\'`, `tags LIKE ? ESCAPE '\\'`, `type LIKE ? ESCAPE '\\'`);
      binds.push(like, like, like, like);
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

  const placeholders = input.ids.map(() => "?").join(", ");
  await db
    .prepare(
      `UPDATE memories
       SET last_recalled_at = ?, recall_count = recall_count + 1
       WHERE namespace = ? AND id IN (${placeholders})`
    )
    .bind(nowIso(), input.namespace, ...input.ids)
    .run();
}
