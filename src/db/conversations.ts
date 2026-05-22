import type { Conversation } from "../types";
import { nowIso } from "../utils/time";

export async function getOrCreateConversation(
  db: D1Database,
  input: { namespace: string; id?: string }
): Promise<Conversation> {
  const id = input.id || `${input.namespace}:default`;
  const now = nowIso();

  await db
    .prepare(
      `INSERT OR IGNORE INTO conversations (id, namespace, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(id, input.namespace, now, now)
    .run();

  const conversation = await db
    .prepare("SELECT id, namespace, created_at, updated_at FROM conversations WHERE id = ?")
    .bind(id)
    .first<Conversation>();

  if (conversation) return conversation;

  return {
    id,
    namespace: input.namespace,
    created_at: now,
    updated_at: now
  };
}
