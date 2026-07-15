import { nowIso } from "../utils/time";

export type FiveAxisName = "X" | "Y" | "Z" | "E" | "M";
export type FiveAxisRunStatus = "running" | "applied" | "pending_review" | "skipped" | "failed";

export interface MemoryFiveAxisRunRecord {
  namespace: string;
  memory_id: string;
  memory_revision: number;
  axis: FiveAxisName;
  status: FiveAxisRunStatus;
  attempts: number;
  result_json: string | null;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface FiveAxisRunKey {
  namespace: string;
  memoryId: string;
  memoryRevision: number;
  axis: FiveAxisName;
}

export async function getFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey
): Promise<MemoryFiveAxisRunRecord | null> {
  return (await db.prepare(
    `SELECT * FROM memory_five_axis_runs
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?`
  ).bind(key.namespace, key.memoryId, key.memoryRevision, key.axis)
    .first<MemoryFiveAxisRunRecord>()) ?? null;
}

export async function startFiveAxisRun(db: D1Database, key: FiveAxisRunKey): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `INSERT INTO memory_five_axis_runs (
       namespace, memory_id, memory_revision, axis, status, attempts,
       result_json, last_error, started_at, completed_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', 1, NULL, NULL, ?, NULL, ?)
     ON CONFLICT(namespace, memory_id, memory_revision, axis) DO UPDATE SET
       status = 'running', attempts = memory_five_axis_runs.attempts + 1,
       result_json = NULL, last_error = NULL, started_at = excluded.started_at,
       completed_at = NULL, updated_at = excluded.updated_at`
  ).bind(key.namespace, key.memoryId, key.memoryRevision, key.axis, now, now).run();
}

export async function completeFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  status: Exclude<FiveAxisRunStatus, "running" | "failed">,
  result: unknown
): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `UPDATE memory_five_axis_runs
     SET status = ?, result_json = ?, last_error = NULL, completed_at = ?, updated_at = ?
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?`
  ).bind(
    status,
    JSON.stringify(result),
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis
  ).run();
}

export async function failFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  error: unknown
): Promise<void> {
  const now = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(
    `UPDATE memory_five_axis_runs
     SET status = 'failed', result_json = NULL, last_error = ?, completed_at = ?, updated_at = ?
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?`
  ).bind(
    message.slice(0, 1000),
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis
  ).run();
}
