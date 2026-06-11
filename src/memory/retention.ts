import {
  deleteOldMessages,
  deleteOldUsageLogs,
  deleteOldMemoryEvents,
  deleteOldIdempotencyKeys,
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

// ---------------------------------------------------------------------------
// Default retention policy. Environment variables can override the day/hour
// windows without changing code; invalid values fall back to these defaults.
// ---------------------------------------------------------------------------

export const RETENTION_POLICY = {
  activeMemoryAutoExpiry: false,
  messagesDays: 14,
  usageLogsDays: 30,
  memoryEventsDays: 30,
  idempotencyKeysDays: 7,
  terminalMemoryHardDeleteDays: 30,
  throttleHours: 24,
} as const;

interface ResolvedRetentionPolicy {
  activeMemoryAutoExpiry: false;
  messagesDays: number;
  usageLogsDays: number;
  memoryEventsDays: number;
  idempotencyKeysDays: number;
  terminalMemoryHardDeleteDays: number;
  throttleHours: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function retentionPolicy(env: Env): ResolvedRetentionPolicy {
  return {
    activeMemoryAutoExpiry: false,
    messagesDays: readPositiveInteger(env.MEMORY_RETENTION_MESSAGES_DAYS, RETENTION_POLICY.messagesDays),
    usageLogsDays: readPositiveInteger(env.MEMORY_RETENTION_USAGE_LOGS_DAYS, RETENTION_POLICY.usageLogsDays),
    memoryEventsDays: readPositiveInteger(env.MEMORY_RETENTION_EVENTS_DAYS, RETENTION_POLICY.memoryEventsDays),
    idempotencyKeysDays: readPositiveInteger(env.MEMORY_RETENTION_IDEMPOTENCY_DAYS, RETENTION_POLICY.idempotencyKeysDays),
    terminalMemoryHardDeleteDays: readPositiveInteger(
      env.MEMORY_RETENTION_TERMINAL_MEMORY_DAYS,
      RETENTION_POLICY.terminalMemoryHardDeleteDays
    ),
    throttleHours: readPositiveInteger(env.MEMORY_RETENTION_THROTTLE_HOURS, RETENTION_POLICY.throttleHours),
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function hoursAgoMs(hours: number): number {
  return Date.now() - hours * 3_600_000;
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
  namespace: string
): Promise<{ ran: boolean; stats?: Record<string, number> }> {
  const policy = retentionPolicy(env);
  const cursorName = `retention:${namespace}`;
  const lastRun = await readCursor(env.DB, cursorName);

  if (lastRun) {
    const lastRunMs = new Date(lastRun).getTime();
    if (lastRunMs > hoursAgoMs(policy.throttleHours)) {
      return { ran: false };
    }
  }

  const now = new Date().toISOString();
  const stats: Record<string, number> = {};

  stats.messages = await deleteOldMessages(env.DB, namespace, daysAgo(policy.messagesDays));
  stats.ccConnectProcessedMessages = await pruneProcessedCcConnectMessages(env, namespace);
  stats.usageLogs = await deleteOldUsageLogs(env.DB, namespace, daysAgo(policy.usageLogsDays));
  stats.memoryEvents = await deleteOldMemoryEvents(env.DB, namespace, daysAgo(policy.memoryEventsDays));
  stats.idempotencyKeys = await deleteOldIdempotencyKeys(env.DB, daysAgo(policy.idempotencyKeysDays));
  stats.vectorResynced = await resyncUnsyncedVectors(env, namespace);

  // Active long-term memories do not expire automatically. Manual deletes still
  // become hard-deletable after the terminal-memory retention window.
  stats.expiredMemories = 0;

  const hardCutoff = daysAgo(policy.terminalMemoryHardDeleteDays);
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
  idempotencyKey?: string
): Promise<{ ran: boolean; stats?: Record<string, number> }> {
  if (!idempotencyKey) return runMemoryRetentionInner(env, namespace);

  const started = await tryStartIdempotentTask(env.DB, {
    key: idempotencyKey,
    taskType: "retention"
  });
  if (!started) return { ran: false };

  try {
    const result = await runMemoryRetentionInner(env, namespace);
    await finishIdempotentTask(env.DB, { key: idempotencyKey, status: "done" });
    return result;
  } catch (error) {
    await finishIdempotentTask(env.DB, { key: idempotencyKey, status: "failed" });
    throw error;
  }
}
