import { finishIdempotentTask, tryStartIdempotentTask } from "../db/idempotency";
import { createMemory, searchMemoriesByText } from "../db/memories";
import { getMessagesByIds } from "../db/messages";
import { upsertMemoryEmbedding } from "./embedding";
import { extractMemoriesFromMessages, type ExtractedMemory } from "./extract";
import type { Env, QueueMessage } from "../types";

function getMinImportance(env: Env): number {
  const value = Number(env.MEMORY_MIN_IMPORTANCE || 0.55);
  return Number.isFinite(value) ? value : 0.55;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

async function isDuplicateMemory(
  env: Env,
  input: { namespace: string; memory: ExtractedMemory }
): Promise<boolean> {
  const existing = await searchMemoriesByText(env.DB, {
    namespace: input.namespace,
    query: input.memory.content,
    limit: 5
  });
  const content = normalizeText(input.memory.content);
  return existing.some((record) => normalizeText(record.content) === content);
}

export async function runMemoryMaintenance(env: Env, message: QueueMessage): Promise<void> {
  const started = await tryStartIdempotentTask(env.DB, {
    key: message.idempotencyKey,
    taskType: message.type
  });
  if (!started) return;

  try {
    const sourceMessages = await getMessagesByIds(env.DB, {
      namespace: message.namespace,
      ids: [message.fromMessageId, message.toMessageId]
    });

    const extraction = await extractMemoriesFromMessages(env, sourceMessages);
    const minImportance = getMinImportance(env);

    for (const memory of extraction.memories) {
      if (memory.importance < minImportance) continue;
      if (memory.confidence < 0.6) continue;
      if (await isDuplicateMemory(env, { namespace: message.namespace, memory })) continue;

      const created = await createMemory(env.DB, {
        namespace: message.namespace,
        type: memory.type,
        content: memory.content,
        importance: memory.importance,
        confidence: memory.confidence,
        tags: memory.tags,
        source: message.source,
        sourceMessageIds: memory.source_message_ids.length > 0 ? memory.source_message_ids : sourceMessages.map((item) => item.id)
      });

      await upsertMemoryEmbedding(env, created);
    }

    await finishIdempotentTask(env.DB, {
      key: message.idempotencyKey,
      status: "done"
    });
  } catch (error) {
    await finishIdempotentTask(env.DB, {
      key: message.idempotencyKey,
      status: "failed"
    });
    throw error;
  }
}
