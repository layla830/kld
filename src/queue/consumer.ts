import { runMemoryRetention } from "../memory/retention";
import { maybeUpdateLongTermSummary } from "../memory/summary";
import type { Env, QueueMessage } from "../types";
import { runConversationChunking } from "../memory/chunking";
import { runMemoryMaintenance } from "../memory/maintenance";
import { splitDiaryMemories } from "../memory/diarySplit";
import { createMemoryEvent } from "../db/memoryEvents";
import { reconcileMemoryVector } from "../memory/state";
import {
  claimFiveAxisOutboxForExecution,
  completeFiveAxisOutboxExecution,
  failFiveAxisOutboxClaim,
  skipRejectedFiveAxisDelivery
} from "../db/memoryFiveAxisOutbox";
import { projectMemoryIntoFiveAxes } from "../memory/fiveAxis/projection";
import { loadFiveAxisConfig } from "../config/runtime";
import { hasSuccessfulDiarySplit } from "../db/diarySplitState";

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
      if (await hasSuccessfulDiarySplit(env.DB, {
        namespace: message.namespace,
        diaryId: message.diaryId
      })) return;
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
      const memoryIds = [...new Set(message.memoryIds.map((id) => id.trim()).filter(Boolean))].slice(0, 3);
      const results: Array<{ id: string; outcome: string; action?: string }> = [];
      for (const memoryId of memoryIds) {
        const result = await reconcileMemoryVector(env, {
          namespace: message.namespace,
          memoryId
        });
        results.push({
          id: memoryId,
          outcome: result.outcome,
          ...("action" in result ? { action: result.action } : {})
        });
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
      if (!Number.isInteger(message.outboxAttempt) || message.outboxAttempt < 1 || !message.outboxQueuedAt) return;
      const executionResult = await claimFiveAxisOutboxForExecution(env.DB, {
        id: message.outboxId,
        namespace: message.namespace,
        memoryId: message.memoryId,
        memoryUpdatedAt: message.memoryUpdatedAt,
        memoryRevision: message.memoryRevision ?? 1,
        attempt: message.outboxAttempt,
        queuedAt: message.outboxQueuedAt
      });
      if (executionResult.outcome === "rejected") {
        if (
          executionResult.reason === "stale_revision"
          || executionResult.reason === "memory_ineligible"
          || executionResult.reason === "memory_missing"
        ) {
          await skipRejectedFiveAxisDelivery(env.DB, {
            id: message.outboxId,
            namespace: message.namespace,
            memoryId: message.memoryId,
            memoryUpdatedAt: message.memoryUpdatedAt,
            memoryRevision: message.memoryRevision ?? 1,
            attempt: message.outboxAttempt,
            queuedAt: message.outboxQueuedAt
          }, executionResult.reason);
        }
        return;
      }
      const execution = executionResult.claim;
      let failureRecorded = false;
      try {
        const result = await projectMemoryIntoFiveAxes(env, {
          namespace: message.namespace,
          memoryId: message.memoryId,
          memoryRevision: execution.memoryRevision,
          projectionKey: message.idempotencyKey
        });
        if (result && (result.failedAxes.length || result.deferredAxes.length)) {
          const detail = [
            result.failedAxes.length ? `failed=${result.failedAxes.join(",")}` : "",
            result.deferredAxes.length ? `deferred=${result.deferredAxes.join(",")}` : ""
          ].filter(Boolean).join(";");
          const error = new Error(`five_axis_stages_incomplete:${detail}`);
          if (!await failFiveAxisOutboxClaim(env.DB, execution, error, result)) return;
          failureRecorded = true;
          throw error;
        }
        await completeFiveAxisOutboxExecution(
          env.DB,
          execution,
          result && result.supersededByRevision === undefined ? "completed" : "skipped",
          result ?? {
            reason: "memory_not_projectable_or_revision_stale"
          }
        );
      } catch (error) {
        if (!failureRecorded && !await failFiveAxisOutboxClaim(env.DB, execution, error)) {
          return;
        }
        throw error;
      }
      return;
    }
  }
}
