import type { MessageRecord, OpenAIChatMessage, TokenUsage } from "../types";
import { sha256Hex } from "../utils/hash";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

const D1_BIND_LIMIT = 90;
const D1_BATCH_LIMIT = 50;

function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

function safeCreatedAt(value: string | undefined): string {
  if (!value) return nowIso();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return nowIso();
  return parsed.toISOString();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const batch of chunk(statements, D1_BATCH_LIMIT)) await db.batch(batch);
}

export async function saveUserMessages(db: D1Database, input: { conversationId: string; namespace: string; source: string; messages: OpenAIChatMessage[]; requestModel: string; upstreamModel: string; upstreamProvider: string; stream: boolean }): Promise<string[]> {
  type UserEntry = { content: string; hash: string; prevRole: string; prevContent: string };

  const entries: UserEntry[] = [];
  const occurrences = new Map<string, number>();
  let previousVisible: { role: string; content: string } | null = null;

  for (const message of input.messages) {
    if (message.role === "system") continue;
    const content = contentToText(message.content);
    if (message.role === "user") {
      const prevRole = previousVisible?.role ?? "start";
      const prevContent = previousVisible?.content ?? "";
      const contextKey = `${prevRole}:${prevContent}:${content}`;
      const occurrence = occurrences.get(contextKey) ?? 0;
      occurrences.set(contextKey, occurrence + 1);
      const prevHash = await sha256Hex(prevContent);
      const hash = await sha256Hex(`${input.conversationId}:user:${prevRole}:${prevHash}:${occurrence}:${content}`);
      entries.push({ content, hash, prevRole, prevContent });
    }
    if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
      previousVisible = { role: message.role, content };
    }
  }

  if (entries.length === 0) return [];

  const existing = new Map<string, string>();
  const hashesPerQuery = D1_BIND_LIMIT - 1;
  for (const hashes of chunk(entries.map((entry) => entry.hash), hashesPerQuery)) {
    const placeholders = hashes.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT id, client_message_hash FROM messages WHERE conversation_id = ? AND client_message_hash IN (${placeholders})`)
      .bind(input.conversationId, ...hashes)
      .all<{ id: string; client_message_hash: string }>();
    for (const row of result.results || []) existing.set(row.client_message_hash, row.id);
  }

  // Legacy compatibility: rows written by the old code used a random-id salted
  // hash, so exact hash lookup cannot find them. Match against recent message
  // context once, then future requests use the deterministic hash above.
  const unmatched = entries.filter((entry) => !existing.has(entry.hash));
  const legacyIds = new Map<string, string>();
  if (unmatched.length > 0) {
    const recentLimit = Math.min(500, Math.max(120, input.messages.length * 2));
    const recent = await db
      .prepare(`SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(input.conversationId, recentLimit)
      .all<{ id: string; role: string; content: string }>();
    const rows = [...(recent.results || [])].reverse();
    const used = new Set<number>();
    for (const entry of unmatched) {
      if (!entry.prevContent) continue;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (used.has(index) || row.role !== "user" || row.content !== entry.content) continue;
        let prev: { role: string; content: string } | null = null;
        for (let prevIndex = index - 1; prevIndex >= 0; prevIndex -= 1) {
          const candidate = rows[prevIndex];
          if (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "tool") {
            prev = { role: candidate.role, content: candidate.content };
            break;
          }
        }
        if (prev?.role === entry.prevRole && prev.content === entry.prevContent) {
          legacyIds.set(entry.hash, row.id);
          used.add(index);
          break;
        }
      }
    }
  }

  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const entry of entries) {
    const existingId = existing.get(entry.hash) || legacyIds.get(entry.hash);
    if (existingId) {
      ids.push(existingId);
      continue;
    }
    const id = newId("msg");
    ids.push(id);
    statements.push(db.prepare(`INSERT INTO messages (
            id, conversation_id, namespace, role, content, source, client_message_hash,
            upstream_model, upstream_provider, request_model, stream, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.conversationId, input.namespace, "user", entry.content, input.source, entry.hash, input.upstreamModel, input.upstreamProvider, input.requestModel, input.stream ? 1 : 0, nowIso()));
  }
  await runBatched(db, statements);
  return ids;
}

export async function saveAssistantMessage(db: D1Database, input: { conversationId: string; namespace: string; source: string; content: string; requestModel: string; upstreamModel: string; provider: string; stream: boolean; finishReason?: string | null; usage?: TokenUsage; cacheMode?: string | null; cacheTtl?: string | null }): Promise<string> {
  const id = newId("msg");
  const usage = input.usage || {};
  await db.prepare(`INSERT INTO messages (
        id, conversation_id, namespace, role, content, source, upstream_model,
        upstream_provider, request_model, stream, finish_reason, token_input,
        token_output, cache_mode, cache_ttl, cache_hit, cache_read_tokens,
        cache_creation_tokens, raw_usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.conversationId, input.namespace, "assistant", input.content, input.source, input.upstreamModel, input.provider, input.requestModel, input.stream ? 1 : 0, input.finishReason || null, usage.prompt_tokens ?? usage.input_tokens ?? null, usage.completion_tokens ?? usage.output_tokens ?? null, input.cacheMode ?? null, input.cacheTtl ?? null, typeof usage.cache_read_input_tokens === "number" && usage.cache_read_input_tokens > 0 ? 1 : 0, usage.cache_read_input_tokens ?? null, usage.cache_creation_input_tokens ?? null, JSON.stringify(usage), nowIso())
    .run();
  return id;
}

export async function getMessagesByIds(db: D1Database, input: { namespace: string; ids: string[] }): Promise<MessageRecord[]> {
  if (input.ids.length === 0) return [];
  const rows: MessageRecord[] = [];
  const idsPerQuery = D1_BIND_LIMIT - 1;
  for (const ids of chunk(input.ids, idsPerQuery)) {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await db.prepare(`SELECT id, conversation_id, namespace, role, content, source, created_at
         FROM messages
         WHERE namespace = ? AND id IN (${placeholders})`).bind(input.namespace, ...ids).all<MessageRecord>();
    rows.push(...(result.results ?? []));
  }
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function countUnprocessedChunkMessages(db: D1Database, input: { namespace: string; conversationId: string }): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count
       FROM messages
       WHERE namespace = ?
         AND conversation_id = ?
         AND role IN ('user', 'assistant')
         AND content != ''
         AND chunk_processed_at IS NULL`).bind(input.namespace, input.conversationId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function listUnprocessedChunkMessages(db: D1Database, input: { namespace: string; conversationId: string; limit: number }): Promise<MessageRecord[]> {
  const result = await db.prepare(`SELECT id, conversation_id, namespace, role, content, source, created_at
       FROM messages
       WHERE namespace = ?
         AND conversation_id = ?
         AND role IN ('user', 'assistant')
         AND content != ''
         AND chunk_processed_at IS NULL
       ORDER BY created_at ASC
       LIMIT ?`).bind(input.namespace, input.conversationId, input.limit).all<MessageRecord>();
  return result.results ?? [];
}

export async function markMessagesChunkProcessed(db: D1Database, input: { namespace: string; ids: string[] }): Promise<void> {
  if (input.ids.length === 0) return;
  const idsPerQuery = D1_BIND_LIMIT - 2;
  for (const ids of chunk(input.ids, idsPerQuery)) {
    const placeholders = ids.map(() => "?").join(", ");
    await db.prepare(`UPDATE messages
         SET chunk_processed_at = ?
         WHERE namespace = ? AND id IN (${placeholders})`).bind(nowIso(), input.namespace, ...ids).run();
  }
}

export async function saveIngestMessages(db: D1Database, input: { conversationId: string; namespace: string; source: string; messages: OpenAIChatMessage[] }): Promise<string[]> {
  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const message of input.messages) {
    const content = contentToText(message.content);
    if (!content) continue;
    const id = newId("msg");
    ids.push(id);
    statements.push(db.prepare(`INSERT INTO messages (
            id, conversation_id, namespace, role, content, source, stream, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, input.conversationId, input.namespace, message.role, content, input.source, 0, safeCreatedAt(message.created_at)));
  }
  await runBatched(db, statements);
  return ids;
}

export async function deleteProcessedSourceMessagesBefore(db: D1Database, input: { namespace: string; source: string; before: string }): Promise<number> {
  const result = await db.prepare(`DELETE FROM messages
       WHERE namespace = ?
         AND source = ?
         AND chunk_processed_at IS NOT NULL
         AND created_at < ?`).bind(input.namespace, input.source, input.before).run();
  return result.meta.changes ?? 0;
}

function escapeLike(value: string): string {
  return value.replace(/[\%_]/g, "\\$&");
}

function messageTokens(query: string): string[] {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 300);
  return [...new Set(normalized.match(/[a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/gi) ?? [])].slice(0, 12);
}

function scoreMessage(record: MessageRecord, query: string, tokens: string[]): number {
  const content = record.content.toLowerCase();
  const exact = query && content.includes(query.toLowerCase()) ? 0.45 : 0;
  const hits = tokens.filter((token) => content.includes(token)).length;
  const roleBoost = record.role === "user" ? 0.08 : 0;
  const hitScore = tokens.length ? Math.min(1, hits / Math.min(tokens.length, 3)) * 0.5 : 0.12;
  return 0.35 + exact + hitScore + roleBoost;
}

function appendMessageTimeRange(sql: string, binds: unknown[], input: { after?: string; before?: string }): string {
  if (input.after) {
    sql += " AND created_at >= ?";
    binds.push(input.after);
  }
  if (input.before) {
    sql += " AND created_at < ?";
    binds.push(input.before);
  }
  return sql;
}

export async function searchMessagesForRecall(db: D1Database, input: { namespace: string; query: string; after?: string; before?: string; limit: number }): Promise<Array<MessageRecord & { score: number }>> {
  const query = input.query.trim().replace(/\s+/g, " ").slice(0, 300);
  const tokens = messageTokens(query);
  const baseSql = `SELECT id, conversation_id, namespace, role, content, source, created_at
             FROM messages
             WHERE namespace = ?
               AND role IN ('user', 'assistant')
               AND content != ''`;
  const limit = Math.max(input.limit * 3, input.limit);
  let sql = baseSql;
  const binds: unknown[] = [input.namespace];
  sql = appendMessageTimeRange(sql, binds, input);

  if (tokens.length > 0) {
    const tokenBudget = Math.max(0, Math.min(tokens.length, D1_BIND_LIMIT - binds.length - 1));
    const clauses: string[] = [];
    for (const token of tokens.slice(0, tokenBudget)) {
      clauses.push("content LIKE ? ESCAPE '\\'");
      binds.push(`%${escapeLike(token)}%`);
    }
    if (clauses.length > 0) sql += ` AND (${clauses.join(" OR ")})`;
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);

  let records: MessageRecord[] = [];
  try {
    const result = await db.prepare(sql).bind(...binds).all<MessageRecord>();
    records = result.results ?? [];
    if (records.length === 0 && tokens.length > 0 && (input.after || input.before)) {
      const fallbackBinds: unknown[] = [input.namespace];
      let fallbackSql = appendMessageTimeRange(baseSql, fallbackBinds, input);
      fallbackSql += " ORDER BY created_at DESC LIMIT ?";
      fallbackBinds.push(limit);
      const fallback = await db.prepare(fallbackSql).bind(...fallbackBinds).all<MessageRecord>();
      records = fallback.results ?? [];
    }
  } catch (error) {
    console.error("message recall search failed", error);
    return [];
  }

  return records
    .map((record) => ({ ...record, score: scoreMessage(record, query, tokens) }))
    .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at))
    .slice(0, input.limit);
}
