import { nowIso } from "../utils/time";

export interface MemoryFiveAxisOutboxRecord {
  id: number;
  namespace: string;
  memory_id: string;
  memory_updated_at: string;
  status: "pending" | "queued" | "failed" | "completed" | "skipped";
  attempts: number;
  queued_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export async function listDueFiveAxisOutbox(
  db: D1Database,
  limit = 5
): Promise<MemoryFiveAxisOutboxRecord[]> {
  const now = new Date();
  const staleQueuedAt = new Date(now.getTime() - 15 * 60_000).toISOString();
  const retryFailedAt = new Date(now.getTime() - 30 * 60_000).toISOString();
  const result = await db.prepare(
    `SELECT * FROM memory_five_axis_outbox
     WHERE attempts < 5 AND (
       status = 'pending'
       OR (status = 'queued' AND queued_at < ?)
       OR (status = 'failed' AND updated_at < ?)
     )
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(staleQueuedAt, retryFailedAt, Math.min(Math.max(limit, 1), 10)).all<MemoryFiveAxisOutboxRecord>();
  return result.results ?? [];
}

export async function getFiveAxisOutbox(
  db: D1Database,
  id: number
): Promise<MemoryFiveAxisOutboxRecord | null> {
  return (await db.prepare("SELECT * FROM memory_five_axis_outbox WHERE id = ?")
    .bind(id).first<MemoryFiveAxisOutboxRecord>()) ?? null;
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

export async function markFiveAxisOutboxFailed(db: D1Database, id: number, error: unknown): Promise<void> {
  const now = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(
    `UPDATE memory_five_axis_outbox
     SET status = 'failed', updated_at = ?, last_error = ?
     WHERE id = ? AND status != 'completed' AND status != 'skipped'`
  ).bind(now, message.slice(0, 1000), id).run();
}
