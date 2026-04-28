import type { MessageRecord, OpenAIChatMessage, TokenUsage } from "../types";
import { sha256Hex } from "../utils/hash";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

export async function saveUserMessages(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    messages: OpenAIChatMessage[];
    requestModel: string;
    upstreamModel: string;
    upstreamProvider: string;
    stream: boolean;
  }
): Promise<string[]> {
  const userMessages = input.messages.filter((message) => message.role === "user");
  const ids: string[] = [];

  for (const message of userMessages) {
    const content = contentToText(message.content);
    const id = newId("msg");
    const hash = await sha256Hex(`${input.conversationId}:${id}:${message.role}:${content}`);
    ids.push(id);

    await db
      .prepare(
        `INSERT INTO messages (
          id, conversation_id, namespace, role, content, source, client_message_hash,
          upstream_model, upstream_provider, request_model, stream, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.conversationId,
        input.namespace,
        "user",
        content,
        input.source,
        hash,
        input.upstreamModel,
        input.upstreamProvider,
        input.requestModel,
        input.stream ? 1 : 0,
        nowIso()
      )
      .run();
  }

  return ids;
}

export async function saveAssistantMessage(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    content: string;
    requestModel: string;
    upstreamModel: string;
    provider: string;
    stream: boolean;
    finishReason?: string | null;
    usage?: TokenUsage;
    cacheMode?: string | null;
    cacheTtl?: string | null;
  }
): Promise<string> {
  const id = newId("msg");
  const usage = input.usage || {};

  await db
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, namespace, role, content, source, upstream_model,
        upstream_provider, request_model, stream, finish_reason, token_input,
        token_output, cache_mode, cache_ttl, cache_hit, cache_read_tokens,
        cache_creation_tokens, raw_usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.conversationId,
      input.namespace,
      "assistant",
      input.content,
      input.source,
      input.upstreamModel,
      input.provider,
      input.requestModel,
      input.stream ? 1 : 0,
      input.finishReason || null,
      usage.prompt_tokens ?? usage.input_tokens ?? null,
      usage.completion_tokens ?? usage.output_tokens ?? null,
      input.cacheMode ?? null,
      input.cacheTtl ?? null,
      typeof usage.cache_read_input_tokens === "number" && usage.cache_read_input_tokens > 0 ? 1 : 0,
      usage.cache_read_input_tokens ?? null,
      usage.cache_creation_input_tokens ?? null,
      JSON.stringify(usage),
      nowIso()
    )
    .run();

  return id;
}

export async function getMessagesByIds(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<MessageRecord[]> {
  if (input.ids.length === 0) return [];

  const placeholders = input.ids.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT id, conversation_id, namespace, role, content, source, created_at
       FROM messages
       WHERE namespace = ? AND id IN (${placeholders})
       ORDER BY created_at ASC`
    )
    .bind(input.namespace, ...input.ids)
    .all<MessageRecord>();

  return result.results ?? [];
}

export async function saveIngestMessages(
  db: D1Database,
  input: {
    conversationId: string;
    namespace: string;
    source: string;
    messages: OpenAIChatMessage[];
  }
): Promise<string[]> {
  const ids: string[] = [];

  for (const message of input.messages) {
    const content = contentToText(message.content);
    if (!content) continue;

    const id = newId("msg");
    ids.push(id);

    await db
      .prepare(
        `INSERT INTO messages (
          id, conversation_id, namespace, role, content, source, stream, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.conversationId,
        input.namespace,
        message.role,
        content,
        input.source,
        0,
        nowIso()
      )
      .run();
  }

  return ids;
}
