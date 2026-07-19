import { nowIso } from "../utils/time";
import { newId } from "../utils/ids";
import {
  FIVE_AXIS_OUTBOX_TRANSITIONS,
  FIVE_AXIS_OUTBOX_STATUS,
  statusPlaceholders,
  type FiveAxisOutboxStatus
} from "./fiveAxisStatuses";

export interface MemoryFiveAxisOutboxRecord {
  id: number;
  namespace: string;
  memory_id: string;
  memory_updated_at: string;
  memory_revision?: number;
  status: FiveAxisOutboxStatus;
  attempts: number;
  queued_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_FIVE_AXIS_OUTBOX_ATTEMPTS = 5;
const STALE_QUEUED_AFTER_MS = 15 * 60_000;
const RETRY_FAILED_AFTER_MS = 30 * 60_000;

export async function finalizeExhaustedFiveAxisOutbox(db: D1Database): Promise<number> {
  const transition = FIVE_AXIS_OUTBOX_TRANSITIONS.finalize_exhausted;
  const staleQueuedAt = new Date(Date.now() - STALE_QUEUED_AFTER_MS).toISOString();
  const now = nowIso();
  const result = await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = ?, completed_at = ?, updated_at = ?
     WHERE attempts >= ?
       AND status IN (${statusPlaceholders(transition.from)})
       AND (status != ? OR queued_at < ?)`
  ).bind(
    transition.to[0],
    now,
    now,
    MAX_FIVE_AXIS_OUTBOX_ATTEMPTS,
    ...transition.from,
    FIVE_AXIS_OUTBOX_STATUS.QUEUED,
    staleQueuedAt
  ).run();
  return result.meta.changes ?? 0;
}

export async function listDueFiveAxisOutbox(
  db: D1Database,
  limit = 5
): Promise<MemoryFiveAxisOutboxRecord[]> {
  await finalizeExhaustedFiveAxisOutbox(db);
  const now = new Date();
  const staleQueuedAt = new Date(now.getTime() - STALE_QUEUED_AFTER_MS).toISOString();
  const retryFailedAt = new Date(now.getTime() - RETRY_FAILED_AFTER_MS).toISOString();
  const result = await db.prepare(
    `SELECT * FROM memory_five_axis_outbox
     WHERE attempts < ? AND (
       status = ?
       OR (status = ? AND queued_at < ?)
       OR (status = ? AND updated_at < ?)
     )
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(
    MAX_FIVE_AXIS_OUTBOX_ATTEMPTS,
    FIVE_AXIS_OUTBOX_STATUS.PENDING,
    FIVE_AXIS_OUTBOX_STATUS.QUEUED,
    staleQueuedAt,
    FIVE_AXIS_OUTBOX_STATUS.FAILED,
    retryFailedAt,
    Math.min(Math.max(limit, 1), 10)
  ).all<MemoryFiveAxisOutboxRecord>();
  return result.results ?? [];
}

export async function getFiveAxisOutbox(
  db: D1Database,
  id: number
): Promise<MemoryFiveAxisOutboxRecord | null> {
  return (await db.prepare("SELECT * FROM memory_five_axis_outbox WHERE id = ?")
    .bind(id).first<MemoryFiveAxisOutboxRecord>()) ?? null;
}

export async function hasNewerFiveAxisOutboxVersion(
  db: D1Database,
  record: Pick<MemoryFiveAxisOutboxRecord, "id" | "namespace" | "memory_id" | "memory_revision">
): Promise<boolean> {
  if (record.memory_revision === undefined) {
    const legacyNewer = await db.prepare(
      `SELECT id FROM memory_five_axis_outbox
       WHERE namespace = ? AND memory_id = ? AND id > ?
       LIMIT 1`
    ).bind(record.namespace, record.memory_id, record.id).first<{ id: number }>();
    return Boolean(legacyNewer?.id);
  }
  const newer = await db.prepare(
    `SELECT id FROM memory_five_axis_outbox
     WHERE namespace = ? AND memory_id = ? AND memory_revision > ?
     LIMIT 1`
  ).bind(record.namespace, record.memory_id, record.memory_revision).first<{ id: number }>();
  return Boolean(newer?.id);
}

export async function markFiveAxisOutboxQueued(db: D1Database, id: number): Promise<boolean> {
  const transition = FIVE_AXIS_OUTBOX_TRANSITIONS.queue;
  const now = nowIso();
  const result = await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = ?, attempts = attempts + 1, queued_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ? AND status IN (${statusPlaceholders(transition.from)})`
  ).bind(transition.to[0], now, now, id, ...transition.from).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function markFiveAxisOutboxCompleted(
  db: D1Database,
  id: number,
  status: Extract<FiveAxisOutboxStatus, "completed" | "skipped">,
  result: unknown
): Promise<boolean> {
  const transition = status === "completed"
    ? FIVE_AXIS_OUTBOX_TRANSITIONS.complete
    : FIVE_AXIS_OUTBOX_TRANSITIONS.skip;
  const now = nowIso();
  const write = await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = ?, completed_at = ?, updated_at = ?, last_error = NULL, result_json = ?
     WHERE id = ? AND status IN (${statusPlaceholders(transition.from)})`
  ).bind(status, now, now, JSON.stringify(result), id, ...transition.from).run();
  return (write.meta.changes ?? 0) === 1;
}

export async function markFiveAxisOutboxFailed(
  db: D1Database,
  id: number,
  error: unknown,
  result?: unknown
): Promise<boolean> {
  const transition = FIVE_AXIS_OUTBOX_TRANSITIONS.fail;
  const now = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const write = await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = CASE WHEN attempts >= ? THEN ? ELSE ? END,
         completed_at = CASE WHEN attempts >= ? THEN ? ELSE completed_at END,
         updated_at = ?, last_error = ?, result_json = COALESCE(?, result_json)
     WHERE id = ? AND status IN (${statusPlaceholders(transition.from)})`
  ).bind(
    MAX_FIVE_AXIS_OUTBOX_ATTEMPTS,
    FIVE_AXIS_OUTBOX_STATUS.DEAD_LETTER,
    FIVE_AXIS_OUTBOX_STATUS.FAILED,
    MAX_FIVE_AXIS_OUTBOX_ATTEMPTS,
    now,
    now,
    message.slice(0, 1000),
    result === undefined ? null : JSON.stringify(result),
    id,
    ...transition.from
  ).run();
  return (write.meta.changes ?? 0) === 1;
}

export async function listFiveAxisDeadLetters(
  db: D1Database,
  namespace: string,
  limit = 20
): Promise<MemoryFiveAxisOutboxRecord[]> {
  const result = await db.prepare(
    `SELECT * FROM memory_five_axis_outbox
     WHERE namespace = ? AND status = ?
     ORDER BY updated_at DESC LIMIT ?`
  ).bind(
    namespace,
    FIVE_AXIS_OUTBOX_STATUS.DEAD_LETTER,
    Math.min(Math.max(limit, 1), 100)
  ).all<MemoryFiveAxisOutboxRecord>();
  return result.results ?? [];
}

export async function retryFiveAxisDeadLetter(db: D1Database, namespace: string, id: number): Promise<boolean> {
  const transition = FIVE_AXIS_OUTBOX_TRANSITIONS.retry_dead_letter;
  const outbox = await getFiveAxisOutbox(db, id);
  if (!outbox || outbox.namespace !== namespace || outbox.status !== FIVE_AXIS_OUTBOX_STATUS.DEAD_LETTER) return false;
  const failedRuns = await db.prepare(
    `SELECT axis, status, attempts FROM memory_five_axis_runs
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ?
       AND status IN ('failed', 'running')
     ORDER BY axis`
  ).bind(namespace, outbox.memory_id, outbox.memory_revision ?? 1)
    .all<{ axis: string; status: string; attempts: number }>();
  const now = nowIso();
  const audit = db.prepare(
    `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
     SELECT ?, namespace, 'five_axis_dead_letter_retried', memory_id, ?, ?
     FROM memory_five_axis_outbox
     WHERE namespace = ? AND id = ? AND status = 'dead_letter'`
  ).bind(
    newId("ev"),
    JSON.stringify({
      source: "admin_board",
      outbox_id: id,
      memory_revision: outbox.memory_revision ?? 1,
      previous_attempts: outbox.attempts,
      previous_error: outbox.last_error,
      axis_runs_reset: failedRuns.results ?? []
    }),
    now,
    namespace,
    id
  );
  const resetRuns = db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = 'failed', attempts = 0, claim_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
     WHERE runs.status IN ('failed', 'running')
       AND EXISTS (
         SELECT 1 FROM memory_five_axis_outbox AS outbox
         WHERE outbox.namespace = ? AND outbox.id = ? AND outbox.status = 'dead_letter'
           AND outbox.namespace = runs.namespace
           AND outbox.memory_id = runs.memory_id
           AND outbox.memory_revision = runs.memory_revision
       )`
  ).bind(now, now, namespace, id);
  const resetOutbox = db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = ?, attempts = 0, queued_at = NULL, completed_at = NULL,
         last_error = NULL, updated_at = ?
     WHERE namespace = ? AND id = ? AND status IN (${statusPlaceholders(transition.from)})`
  ).bind(transition.to[0], now, namespace, id, ...transition.from);
  const results = await db.batch([audit, resetRuns, resetOutbox]);
  return (results[2]?.meta.changes ?? 0) === 1;
}
