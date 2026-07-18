import { nowIso } from "../utils/time";

export interface MemoryFiveAxisOutboxRecord {
  id: number;
  namespace: string;
  memory_id: string;
  memory_updated_at: string;
  memory_revision?: number;
  status: "pending" | "queued" | "failed" | "dead_letter" | "completed" | "skipped";
  attempts: number;
  queued_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_FIVE_AXIS_OUTBOX_ATTEMPTS = 5;

export async function finalizeExhaustedFiveAxisOutbox(db: D1Database): Promise<number> {
  const staleQueuedAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const now = nowIso();
  const result = await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = 'dead_letter', completed_at = ?, updated_at = ?
     WHERE attempts >= ?
       AND (status = 'failed' OR (status = 'queued' AND queued_at < ?))`
  ).bind(now, now, MAX_FIVE_AXIS_OUTBOX_ATTEMPTS, staleQueuedAt).run();
  return result.meta.changes ?? 0;
}

export async function listDueFiveAxisOutbox(
  db: D1Database,
  limit = 5
): Promise<MemoryFiveAxisOutboxRecord[]> {
  await finalizeExhaustedFiveAxisOutbox(db);
  const now = new Date();
  const staleQueuedAt = new Date(now.getTime() - 15 * 60_000).toISOString();
  const retryFailedAt = new Date(now.getTime() - 30 * 60_000).toISOString();
  const result = await db.prepare(
    `SELECT * FROM memory_five_axis_outbox
     WHERE attempts < ? AND (
       status = 'pending'
       OR (status = 'queued' AND queued_at < ?)
       OR (status = 'failed' AND updated_at < ?)
     )
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(MAX_FIVE_AXIS_OUTBOX_ATTEMPTS, staleQueuedAt, retryFailedAt, Math.min(Math.max(limit, 1), 10)).all<MemoryFiveAxisOutboxRecord>();
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
  record: Pick<MemoryFiveAxisOutboxRecord, "id" | "namespace" | "memory_id">
): Promise<boolean> {
  const newer = await db.prepare(
    `SELECT id FROM memory_five_axis_outbox
     WHERE namespace = ? AND memory_id = ? AND id > ?
     LIMIT 1`
  ).bind(record.namespace, record.memory_id, record.id).first<{ id: number }>();
  return Boolean(newer?.id);
}

export async function markFiveAxisOutboxQueued(db: D1Database, id: number): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = 'queued', attempts = attempts + 1, queued_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ? AND status != 'completed' AND status != 'skipped'`
  ).bind(now, now, id).run();
}

export async function markFiveAxisOutboxCompleted(
  db: D1Database,
  id: number,
  status: "completed" | "skipped",
  result: unknown
): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = ?, completed_at = ?, updated_at = ?, last_error = NULL, result_json = ?
     WHERE id = ?`
  ).bind(status, now, now, JSON.stringify(result), id).run();
}

export async function markFiveAxisOutboxFailed(
  db: D1Database,
  id: number,
  error: unknown,
  result?: unknown
): Promise<void> {
  const now = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = CASE WHEN attempts >= ? THEN 'dead_letter' ELSE 'failed' END,
         completed_at = CASE WHEN attempts >= ? THEN ? ELSE completed_at END,
         updated_at = ?, last_error = ?, result_json = COALESCE(?, result_json)
     WHERE id = ? AND status != 'completed' AND status != 'skipped'`
  ).bind(
    MAX_FIVE_AXIS_OUTBOX_ATTEMPTS,
    MAX_FIVE_AXIS_OUTBOX_ATTEMPTS,
    now,
    now,
    message.slice(0, 1000),
    result === undefined ? null : JSON.stringify(result),
    id
  ).run();
}

export async function listFiveAxisDeadLetters(
  db: D1Database,
  namespace: string,
  limit = 20
): Promise<MemoryFiveAxisOutboxRecord[]> {
  const result = await db.prepare(
    `SELECT * FROM memory_five_axis_outbox
     WHERE namespace = ? AND status = 'dead_letter'
     ORDER BY updated_at DESC LIMIT ?`
  ).bind(namespace, Math.min(Math.max(limit, 1), 100)).all<MemoryFiveAxisOutboxRecord>();
  return result.results ?? [];
}

export async function retryFiveAxisDeadLetter(db: D1Database, namespace: string, id: number): Promise<boolean> {
  const now = nowIso();
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
     SET status = 'pending', attempts = 0, queued_at = NULL, completed_at = NULL,
         last_error = NULL, updated_at = ?
     WHERE namespace = ? AND id = ? AND status = 'dead_letter'`
  ).bind(now, namespace, id);
  const results = await db.batch([resetRuns, resetOutbox]);
  return (results[1]?.meta.changes ?? 0) === 1;
}
