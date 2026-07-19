import {
  deleteOldMessages,
  deleteOldUsageLogs,
  deleteOldMemoryEvents,
  deleteOldIdempotencyKeys,
  deleteOldRecallReceipts,
  deleteOldRecallDailyRows,
  listHardDeletableMemories,
  hardDeleteMemoriesBatched,
  readCursor,
  writeCursor,
  RETENTION_BATCH_SIZE,
} from "../db/retention";
import { finishIdempotentTask, tryStartIdempotentTask } from "../db/idempotency";
import { upsertMemoryEmbedding } from "./embedding";
import type { Env, MemoryRecord } from "../types";
import { pruneProcessedCcConnectMessages } from "./ccConnectRetention";
import { loadRetentionConfig, systemClock, type AppClock } from "../config/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(clock: AppClock, days: number): string {
  return new Date(clock.nowMs() - days * 86_400_000).toISOString();
}

function hoursAgoMs(clock: AppClock, hours: number): number {
  return clock.nowMs() - hours * 3_600_000;
}

/**
 * Delete Vectorize vectors in batches of RETENTION_BATCH_SIZE.
 * Errors are logged, not thrown, so the caller can decide how to degrade.
 */
async function deleteVectorizeBatched(
  vectorize: Vectorize | VectorizeIndex,
  vectorIds: string[]
): Promise<void> {
  for (let i = 0; i < vectorIds.length; i += RETENTION_BATCH_SIZE) {
    const batch = vectorIds.slice(i, i + RETENTION_BATCH_SIZE);
    await vectorize.deleteByIds(batch);
  }
}

// ---------------------------------------------------------------------------
// runMemoryRetention
//
// Called from background tasks after chat. Uses processing_cursors for per-
// namespace throttling so it doesn't run on every request.
// ---------------------------------------------------------------------------


const VECTOR_RESYNC_BATCH = 50;

/**
 * Re-embed active memories whose vector write previously failed (or whose
 * metadata changed since the last embed). Errors are logged per memory so a
 * single bad record cannot block the rest of the batch.
 */
async function resyncUnsyncedVectors(env: Env, namespace: string): Promise<number> {
  if (!env.VECTORIZE) return 0;
  let result: D1Result<MemoryRecord>;
  try {
    result = await env.DB
      .prepare(
        `SELECT * FROM memories
         WHERE namespace = ? AND status = 'active' AND vector_synced = 0
         ORDER BY updated_at DESC LIMIT ?`
      )
      .bind(namespace, VECTOR_RESYNC_BATCH)
      .all<MemoryRecord>();
  } catch (error) {
    console.warn("retention: vector_synced column unavailable; skipping vector resync", error);
    return 0;
  }

  let synced = 0;
  for (const memory of result.results || []) {
    try {
      if (await upsertMemoryEmbedding(env, memory)) synced += 1;
    } catch (error) {
      console.error("retention: vector resync failed", memory.id, error);
    }
  }
  return synced;
}

async function runMemoryRetentionInner(
  env: Env,
  namespace: string,
  clock: AppClock
): Promise<{ ran: boolean; stats?: Record<string, number> }> {
  const policy = loadRetentionConfig(env);
  const cursorName = `retention:${namespace}`;
  const lastRun = await readCursor(env.DB, cursorName);

  if (lastRun) {
    const lastRunMs = new Date(lastRun).getTime();
    if (lastRunMs > hoursAgoMs(clock, policy.throttleHours)) {
      return { ran: false };
    }
  }

  const now = clock.iso();
  const stats: Record<string, number> = {};

  stats.messages = await deleteOldMessages(env.DB, namespace, daysAgo(clock, policy.messagesDays));
  stats.ccConnectProcessedMessages = await pruneProcessedCcConnectMessages(env, namespace, clock);
  stats.usageLogs = await deleteOldUsageLogs(env.DB, namespace, daysAgo(clock, policy.usageLogsDays));
  stats.memoryEvents = await deleteOldMemoryEvents(env.DB, namespace, daysAgo(clock, policy.memoryEventsDays));
  stats.idempotencyKeys = await deleteOldIdempotencyKeys(env.DB, daysAgo(clock, policy.idempotencyKeysDays));
  stats.recallReceipts = await deleteOldRecallReceipts(env.DB, namespace, daysAgo(clock, policy.recallReceiptsDays));
  stats.recallDailyRows = await deleteOldRecallDailyRows(env.DB, namespace, daysAgo(clock, policy.recallDailyDays));
  stats.vectorResynced = await resyncUnsyncedVectors(env, namespace);

  // Active long-term memories do not expire automatically. Manual deletes still
  // become hard-deletable after the terminal-memory retention window.
  stats.expiredMemories = 0;

  const hardCutoff = daysAgo(clock, policy.terminalMemoryHardDeleteDays);
  const deletable = await listHardDeletableMemories(env.DB, namespace, hardCutoff);

  if (deletable.length > 0) {
    const vectorIds = deletable
      .map((m) => m.vector_id)
      .filter((v): v is string => v !== null);

    if (env.VECTORIZE && vectorIds.length > 0) {
      try {
        await deleteVectorizeBatched(env.VECTORIZE, vectorIds);
      } catch (error) {
        console.error("retention: vectorize delete failed, skipping vector-backed memories", error);
        const noVectorIds = deletable
          .filter((m) => m.vector_id === null)
          .map((m) => m.id);
        stats.hardDeletedMemories = await hardDeleteMemoriesBatched(env.DB, namespace, noVectorIds);
        stats.hardDeleteSkipped = deletable.length - noVectorIds.length;
        await writeCursor(env.DB, cursorName, now);
        return { ran: true, stats };
      }
    }

    if (!env.VECTORIZE) {
      const safeIds = deletable
        .filter((m) => m.vector_id === null)
        .map((m) => m.id);
      stats.hardDeletedMemories = await hardDeleteMemoriesBatched(env.DB, namespace, safeIds);
      stats.hardDeleteSkipped = deletable.length - safeIds.length;
    } else {
      const allIds = deletable.map((m) => m.id);
      stats.hardDeletedMemories = await hardDeleteMemoriesBatched(env.DB, namespace, allIds);
    }
  } else {
    stats.hardDeletedMemories = 0;
  }

  await writeCursor(env.DB, cursorName, now);

  return { ran: true, stats };
}

export async function runMemoryRetention(
  env: Env,
  namespace: string,
  idempotencyKey?: string,
  clock: AppClock = systemClock
): Promise<{ ran: boolean; stats?: Record<string, number> }> {
  if (!idempotencyKey) return runMemoryRetentionInner(env, namespace, clock);

  const started = await tryStartIdempotentTask(env.DB, {
    key: idempotencyKey,
    taskType: "retention"
  });
  if (!started) return { ran: false };

  try {
    const result = await runMemoryRetentionInner(env, namespace, clock);
    await finishIdempotentTask(env.DB, { key: idempotencyKey, status: "done" });
    return result;
  } catch (error) {
    await finishIdempotentTask(env.DB, { key: idempotencyKey, status: "failed" });
    throw error;
  }
}
