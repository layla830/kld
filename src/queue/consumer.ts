import { runMemoryRetention } from "../memory/retention";
import { maybeUpdateLongTermSummary } from "../memory/summary";
import type { Env, QueueMessage } from "../types";
import { runConversationChunking } from "../memory/chunking";
import { runMemoryMaintenance } from "../memory/maintenance";
import { splitDiaryMemories } from "../memory/diarySplit";
import { createMemoryEvent } from "../db/memoryEvents";
import { fetchMemoriesByIds } from "../db/memories";
import { syncMemoryVector } from "../memory/state";
import { runScheduledCoordinateBackfill } from "../api/debug";
import { runLegacyRelationBackfill } from "../memory/legacyRelations";
import { scanMetabolismReviewCandidates } from "../memory/metabolismReview";

async function hasCompletedDiaryRescreenJob(env: Env, namespace: string, jobId: string): Promise<boolean> {
  if (!/^[a-z0-9._:-]{1,100}$/i.test(jobId)) return false;
  const row = await env.DB.prepare(
    `SELECT id FROM memory_events
     WHERE namespace = ?
       AND event_type IN ('diary_rescreen_dry_run','diary_rescreen_applied')
       AND payload_json LIKE ?
     LIMIT 1`
  ).bind(namespace, `%\"job_id\":\"${jobId}\"%`).first<{ id: string }>();
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
    case "diary_rescreen": {
      if (await hasCompletedDiaryRescreenJob(env, message.namespace, message.jobId)) return;
      const plans = await splitDiaryMemories(env, {
        namespace: message.namespace,
        ids: message.diaryIds.slice(0, 3),
        apply: message.apply,
        force: true,
        debug: true,
        replaceImporter: message.importer
      });
      await createMemoryEvent(env.DB, {
        namespace: message.namespace,
        eventType: message.apply ? "diary_rescreen_applied" : "diary_rescreen_dry_run",
        memoryId: message.diaryIds[0] ?? null,
        payload: {
          job_id: message.jobId,
          importer: message.importer,
          apply: message.apply,
          diary_ids: message.diaryIds,
          plans
        }
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
    case "coordinate_backfill": {
      const eventKey = `%\"job_id\":\"${message.jobId}\"%`;
      const completed = await env.DB.prepare(
        "SELECT id FROM memory_events WHERE namespace = ? AND event_type = 'coordinate_backfill_complete' AND payload_json LIKE ? LIMIT 1"
      ).bind(message.namespace, eventKey).first<{ id: string }>();
      if (completed?.id) return;
      const result = await runScheduledCoordinateBackfill(env, message.namespace);
      await createMemoryEvent(env.DB, {
        namespace: message.namespace,
        eventType: "coordinate_backfill_complete",
        payload: { job_id: message.jobId, result }
      });
      return;
    }
    case "relation_backfill": {
      const eventKey = `%\"job_id\":\"${message.jobId}\"%`;
      const completed = await env.DB.prepare(
        "SELECT id FROM memory_events WHERE namespace = ? AND event_type = 'relation_backfill_complete' AND payload_json LIKE ? LIMIT 1"
      ).bind(message.namespace, eventKey).first<{ id: string }>();
      if (completed?.id) return;
      const result = await runLegacyRelationBackfill(
        env,
        message.namespace,
        true,
        ["origin_split"],
        { requiredTag: message.requiredTag }
      );
      await createMemoryEvent(env.DB, {
        namespace: message.namespace,
        eventType: "relation_backfill_complete",
        payload: { job_id: message.jobId, required_tag: message.requiredTag, result }
      });
      return;
    }
    case "metabolism_scan": {
      const eventKey = `%\"job_id\":\"${message.jobId}\"%`;
      const completed = await env.DB.prepare(
        "SELECT id FROM memory_events WHERE namespace = ? AND event_type = 'metabolism_scan_complete' AND payload_json LIKE ? LIMIT 1"
      ).bind(message.namespace, eventKey).first<{ id: string }>();
      if (completed?.id) return;
      const result = await scanMetabolismReviewCandidates(env, message.namespace);
      await createMemoryEvent(env.DB, {
        namespace: message.namespace,
        eventType: "metabolism_scan_complete",
        payload: { job_id: message.jobId, result }
      });
      return;
    }
  }
}
