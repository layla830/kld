import { requireScope } from "../auth/scopes";
import { enqueueConversationChunkingIfNeeded } from "../queue/producer";
import type { Env, KeyProfile } from "../types";
import { json, openAiError } from "../utils/json";
import { readBody, readString, resolveNamespace } from "./common";

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
