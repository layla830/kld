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
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Default retention policy (hardcoded, not user-configurable)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Called from background tasks after chat. Uses processing_cursors for 24h
// per-namespace throttling so it doesn't run on every request.
// ---------------------------------------------------------------------------

export async function runMemoryRetention(
  env: Env,
  namespace: string
): Promise<{ ran: boolean; stats?: Record<string, number> }> {
  const cursorName = `retention:${namespace}`;
  const lastRun = await readCursor(env.DB, cursorName);

  if (lastRun) {
    const lastRunMs = new Date(lastRun).getTime();
    if (lastRunMs > hoursAgoMs(RETENTION_POLICY.throttleHours)) {
      return { ran: false };
    }
  }

  const now = new Date().toISOString();
  const stats: Record<string, number> = {};

  stats.messages = await deleteOldMessages(env.DB, namespace, daysAgo(RETENTION_POLICY.messagesDays));
  stats.usageLogs = await deleteOldUsageLogs(env.DB, namespace, daysAgo(RETENTION_POLICY.usageLogsDays));
  stats.memoryEvents = await deleteOldMemoryEvents(env.DB, namespace, daysAgo(RETENTION_POLICY.memoryEventsDays));
  stats.idempotencyKeys = await deleteOldIdempotencyKeys(env.DB, daysAgo(RETENTION_POLICY.idempotencyKeysDays));

  // Active long-term memories do not expire automatically. Manual deletes still
  // become hard-deletable after the terminal-memory retention window.
  stats.expiredMemories = 0;

  const hardCutoff = daysAgo(RETENTION_POLICY.terminalMemoryHardDeleteDays);
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
