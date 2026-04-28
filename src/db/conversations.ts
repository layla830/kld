import type { Conversation } from "../types";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export async function getOrCreateConversation(
  db: D1Database,
  input: { namespace: string; id?: string }
): Promise<Conversation> {
  const id = input.id || `${input.namespace}:default`;
  const existing = await db
    .prepare("SELECT id, namespace, created_at, updated_at FROM conversations WHERE id = ?")
    .bind(id)
    .first<Conversation>();

  if (existing) return existing;

  const now = nowIso();
  const conversation: Conversation = {
    id,
    namespace: input.namespace,
    created_at: now,
    updated_at: now
  };

  await db
    .prepare("INSERT INTO conversations (id, namespace, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(conversation.id, conversation.namespace, conversation.created_at, conversation.updated_at)
    .run();

  return conversation;
}
