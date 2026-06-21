import { requireScope } from "../auth/scopes";
import type { Env, KeyProfile } from "../types";
import { json } from "../utils/json";

const LEGACY_CC_CONNECT_SOURCE = "cc-connect";

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
       AND source = ?`
  ).bind(namespace, LEGACY_CC_CONNECT_SOURCE).all<{ vector_id: string }>();
  const vectorIds = (vectorRows.results ?? []).map((row) => row.vector_id).filter(Boolean);

  if (env.VECTORIZE && vectorIds.length > 0) {
    for (let i = 0; i < vectorIds.length; i += 100) {
      await env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 100));
    }
  }

  const memories = await env.DB.prepare(
    `DELETE FROM memories
     WHERE namespace = ?
       AND source = ?`
  ).bind(namespace, LEGACY_CC_CONNECT_SOURCE).run();

  const messages = await env.DB.prepare(
    "DELETE FROM messages WHERE namespace = ? AND source = ?"
  ).bind(namespace, LEGACY_CC_CONNECT_SOURCE).run();

  return json({
    data: {
      namespace,
      deleted_legacy_source: LEGACY_CC_CONNECT_SOURCE,
      deleted_memories: memories.meta.changes ?? 0,
      deleted_messages: messages.meta.changes ?? 0,
      deleted_vectors: vectorIds.length
    }
  });
}
