import { runMemoryRetention } from "../memory/retention";
import { maybeUpdateLongTermSummary } from "../memory/summary";
import type { Env, QueueMessage } from "../types";
import { runConversationChunking } from "../memory/chunking";
import { runMemoryMaintenance } from "../memory/maintenance";
import { splitDiaryMemories } from "../memory/diarySplit";
import { createMemoryEvent } from "../db/memoryEvents";
import { fetchMemoriesByIds } from "../db/memories";
import { syncMemoryVector } from "../memory/state";

async function hasCompletedDiarySplit(env: Env, namespace: string, diaryId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM memory_events WHERE namespace = ? AND memory_id = ? AND event_type = 'diary_split_v2_complete' LIMIT 1"
  ).bind(namespace, diaryId).first<{ id: string }>();
  return Boolean(row?.id);
}

export async function handleQueueMessage(message: QueueMessage, env: Env): Promise<void> {
  switch (message.type) {
    case "memory_maintenance":
      await runMemoryMaintenance(env, message);
      // After memory extraction, try updating long-term summary
      try {
        await maybeUpdateLongTermSummary(env, message.namespace);
      } catch (error) {
        console.error("summary update failed", error);
      }
      return;
    case "conversation_chunk":
      await runConversationChunking(env, message);
      return;
    case "retention":
      await runMemoryRetention(env, message.namespace, message.idempotencyKey);
      return;
    case "diary_split": {
      if (await hasCompletedDiarySplit(env, message.namespace, message.diaryId)) return;
      const plans = await splitDiaryMemories(env, {
        namespace: message.namespace,
        ids: [message.diaryId],
        apply: true,
        force: false,
        debug: false
      });
      await createMemoryEvent(env.DB, {
        namespace: message.namespace,
        eventType: "diary_split_queue_complete",
        memoryId: message.diaryId,
        payload: { job_id: message.jobId, plans }
      });
      return;
    }
    case "memory_vector_sync": {
      const eventKey = `%\"job_id\":\"${message.jobId}\"%`;
      const completed = await env.DB.prepare(
        "SELECT id FROM memory_events WHERE namespace = ? AND event_type = 'memory_vector_sync_complete' AND payload_json LIKE ? LIMIT 1"
      ).bind(message.namespace, eventKey).first<{ id: string }>();
      if (completed?.id) return;
      const memories = await fetchMemoriesByIds(env.DB, {
        namespace: message.namespace,
        ids: message.memoryIds.slice(0, 3)
      });
      const results: Array<{ id: string; status: string }> = [];
      for (const memory of memories) {
        results.push({ id: memory.id, status: await syncMemoryVector(env, memory) });
      }
      await createMemoryEvent(env.DB, {
        namespace: message.namespace,
        eventType: "memory_vector_sync_complete",
        memoryId: message.memoryIds[0] ?? null,
        payload: { job_id: message.jobId, memory_ids: message.memoryIds, results }
      });
      return;
    }
  }
}
