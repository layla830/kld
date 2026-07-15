import { runMemoryRetention } from "../memory/retention";
import { maybeUpdateLongTermSummary } from "../memory/summary";
import type { Env, QueueMessage } from "../types";
import { runConversationChunking } from "../memory/chunking";
import { runMemoryMaintenance } from "../memory/maintenance";
import { splitDiaryMemories } from "../memory/diarySplit";
import { createMemoryEvent } from "../db/memoryEvents";
import { fetchMemoriesByIds } from "../db/memories";
import { syncMemoryVector } from "../memory/state";
import {
  getFiveAxisOutbox,
  hasNewerFiveAxisOutboxVersion,
  markFiveAxisOutboxCompleted,
  markFiveAxisOutboxFailed
} from "../db/memoryFiveAxisOutbox";
import { getMemoryById } from "../db/memories";
import { projectMemoryIntoFiveAxes } from "../memory/fiveAxis/projection";
import { loadFiveAxisConfig } from "../config/runtime";

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
    case "memory_five_axis_projection": {
      if (!loadFiveAxisConfig(env).enabled) return;
      const outbox = await getFiveAxisOutbox(env.DB, message.outboxId);
      if (!outbox || outbox.status === "completed" || outbox.status === "skipped") return;
      const outboxRevision = outbox.memory_revision ?? 1;
      const messageRevision = message.memoryRevision ?? outboxRevision;
      if (
        outbox.namespace !== message.namespace
        || outbox.memory_id !== message.memoryId
        || outbox.memory_updated_at !== message.memoryUpdatedAt
        || outboxRevision !== messageRevision
      ) {
        await markFiveAxisOutboxCompleted(env.DB, message.outboxId, "skipped", {
          reason: "outbox_message_identity_mismatch",
          expected: {
            namespace: outbox.namespace,
            memory_id: outbox.memory_id,
            memory_updated_at: outbox.memory_updated_at,
            memory_revision: outboxRevision
          },
          received: {
            namespace: message.namespace,
            memory_id: message.memoryId,
            memory_updated_at: message.memoryUpdatedAt,
            memory_revision: messageRevision
          }
        });
        return;
      }
      const memory = await getMemoryById(env.DB, { namespace: message.namespace, id: message.memoryId });
      if (!memory || memory.status !== "active") {
        await markFiveAxisOutboxCompleted(env.DB, message.outboxId, "skipped", {
          reason: memory ? "memory_not_active" : "memory_not_found"
        });
        return;
      }
      const currentRevision = memory.five_axis_revision ?? 1;
      if (currentRevision !== outboxRevision) {
        await markFiveAxisOutboxCompleted(env.DB, message.outboxId, "skipped", {
          reason: "memory_revision_mismatch",
          expected: outboxRevision,
          current: currentRevision
        });
        return;
      }
      if (await hasNewerFiveAxisOutboxVersion(env.DB, outbox)) {
        await markFiveAxisOutboxCompleted(env.DB, message.outboxId, "skipped", {
          reason: "superseded_by_newer_memory_version"
        });
        return;
      }
      try {
        const result = await projectMemoryIntoFiveAxes(env, {
          namespace: message.namespace,
          memoryId: message.memoryId,
          memoryRevision: outboxRevision,
          projectionKey: message.idempotencyKey
        });
        if (result?.failedAxes.length) {
          const error = new Error(`five_axis_stages_failed:${result.failedAxes.join(",")}`);
          await markFiveAxisOutboxFailed(env.DB, message.outboxId, error, result);
          throw error;
        }
        await markFiveAxisOutboxCompleted(env.DB, message.outboxId, result ? "completed" : "skipped", result ?? {
          reason: "memory_not_projectable"
        });
      } catch (error) {
        const latest = await getFiveAxisOutbox(env.DB, message.outboxId);
        if (latest?.status !== "failed") await markFiveAxisOutboxFailed(env.DB, message.outboxId, error);
        throw error;
      }
      return;
    }
  }
}
