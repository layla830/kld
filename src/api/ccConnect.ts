import { requireScope } from "../auth/scopes";
import { persistChunkMemory } from "../memory/chunkPersistence";
import { formatShanghaiDateTime } from "../memory/chunkPeriods";
import { summarizeChunk } from "../memory/chunkSummary";
import { enqueueConversationChunkingIfNeeded } from "../queue/producer";
import type { Env, KeyProfile, MessageRecord } from "../types";
import { newId } from "../utils/ids";
import { json, openAiError } from "../utils/json";
import { readBody, readNumber, readString, resolveNamespace } from "./common";

const DEFAULT_LOCAL_DIARY_MIN_MESSAGES = 4;

function parseTimestamp(value: unknown): string {
  const raw = readString(value);
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function readLocalDiaryMessages(
  value: unknown,
  input: { namespace: string; conversationId: string; source: string }
): MessageRecord[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): MessageRecord[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as { id?: unknown; role?: unknown; content?: unknown; created_at?: unknown; timestamp?: unknown };
    if (record.role !== "user" && record.role !== "assistant") return [];
    if (typeof record.content !== "string" || !record.content.trim()) return [];

    return [
      {
        id: readString(record.id) || newId("localmsg"),
        conversation_id: input.conversationId,
        namespace: input.namespace,
        role: record.role,
        content: record.content.trim(),
        source: input.source,
        created_at: parseTimestamp(record.created_at || record.timestamp)
      }
    ];
  });
}

function localPeriodKey(body: Record<string, unknown>, messages: MessageRecord[]): string {
  const explicit = readString(body.period_key);
  if (explicit) return explicit;

  const start = readString(body.period_start) || messages[0]?.created_at || new Date().toISOString();
  const end = readString(body.period_end) || messages[messages.length - 1]?.created_at || start;
  return `${formatShanghaiDateTime(start)}-${formatShanghaiDateTime(end)}`;
}

function localPeriodLabel(body: Record<string, unknown>, messages: MessageRecord[]): string {
  const explicit = readString(body.period_label);
  if (explicit) return explicit;

  const start = readString(body.period_start) || messages[0]?.created_at || new Date().toISOString();
  const end = readString(body.period_end) || messages[messages.length - 1]?.created_at || start;
  return `${formatShanghaiDateTime(start)} 至 ${formatShanghaiDateTime(end)}`;
}

function localDiaryMinMessages(env: Env, value: unknown): number {
  const configured = Number(env.CC_CONNECT_AUTO_DIARY_MIN_MESSAGES || DEFAULT_LOCAL_DIARY_MIN_MESSAGES);
  return Math.max(1, readNumber(value, Number.isFinite(configured) ? configured : DEFAULT_LOCAL_DIARY_MIN_MESSAGES));
}

export async function handleResetCcConnect(
  env: Env,
  profile: KeyProfile,
  namespace: string
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const vectorRows = await env.DB.prepare(
    `SELECT vector_id
     FROM memories
     WHERE namespace = ?
       AND vector_id IS NOT NULL
       AND vector_id != ''
       AND (source = 'cc-connect' OR type IN ('auto_chunk', 'auto_diary'))`
  ).bind(namespace).all<{ vector_id: string }>();
  const vectorIds = (vectorRows.results ?? []).map((row) => row.vector_id).filter(Boolean);

  if (env.VECTORIZE && vectorIds.length > 0) {
    for (let i = 0; i < vectorIds.length; i += 100) {
      await env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 100));
    }
  }

  const memories = await env.DB.prepare(
    `DELETE FROM memories
     WHERE namespace = ?
       AND (source = 'cc-connect' OR type IN ('auto_chunk', 'auto_diary'))`
  ).bind(namespace).run();

  const messages = await env.DB.prepare(
    "DELETE FROM messages WHERE namespace = ? AND source = 'cc-connect'"
  ).bind(namespace).run();

  return json({
    data: {
      namespace,
      deleted_memories: memories.meta.changes ?? 0,
      deleted_messages: messages.meta.changes ?? 0,
      deleted_vectors: vectorIds.length
    }
  });
}

export async function handleGenerateCcConnectDiary(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const conversationId = readString(body.conversation_id);
  if (!conversationId) return openAiError("conversation_id is required", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const source = readString(body.source) || "cc-connect";
  const force = body.force !== false;

  ctx.waitUntil(
    enqueueConversationChunkingIfNeeded(env, {
      namespace,
      conversationId,
      source,
      force
    })
  );

  return json({
    data: {
      queued: true,
      namespace,
      conversation_id: conversationId,
      source,
      force
    }
  });
}

export async function handleGenerateCcConnectDiaryFromMessages(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const conversationId = readString(body.conversation_id) || "cc-connect:local";
  const source = readString(body.source) || "cc-connect-vps";
  const messages = readLocalDiaryMessages(body.messages, { namespace, conversationId, source });
  const minMessages = localDiaryMinMessages(env, body.min_messages);

  if (messages.length < minMessages) {
    return json({
      data: {
        skipped: true,
        reason: "not_enough_messages",
        namespace,
        conversation_id: conversationId,
        message_count: messages.length,
        min_messages: minMessages
      }
    });
  }

  const periodKey = localPeriodKey(body, messages);
  const periodLabel = localPeriodLabel(body, messages);
  const summary = await summarizeChunk(env, messages, periodLabel);
  if (!summary) return openAiError("Failed to generate diary summary", 502);

  const memory = await persistChunkMemory(env, {
    namespace,
    source,
    chunk: { messages, periodKey, periodLabel },
    summary
  });

  ctx.waitUntil(Promise.resolve());

  return json({
    data: {
      created: true,
      namespace,
      conversation_id: conversationId,
      memory_id: memory.id,
      message_count: messages.length,
      period_key: periodKey,
      period_label: periodLabel
    }
  }, { status: 201 });
}
