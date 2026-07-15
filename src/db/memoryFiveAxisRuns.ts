import { newId } from "../utils/ids";
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
  claim_token: string | null;
  lease_expires_at: string | null;
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

const AXIS_RUN_LEASE_MS = 15 * 60 * 1000;

export async function claimFiveAxisRun(db: D1Database, key: FiveAxisRunKey): Promise<string | null> {
  const now = nowIso();
  const claimToken = newId("axisrun");
  const leaseExpiresAt = new Date(Date.now() + AXIS_RUN_LEASE_MS).toISOString();
  const result = await db.prepare(
    `INSERT INTO memory_five_axis_runs (
       namespace, memory_id, memory_revision, axis, status, attempts,
       result_json, last_error, claim_token, lease_expires_at,
       started_at, completed_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', 1, NULL, NULL, ?, ?, ?, NULL, ?)
     ON CONFLICT(namespace, memory_id, memory_revision, axis) DO UPDATE SET
       status = 'running', attempts = memory_five_axis_runs.attempts + 1,
       result_json = NULL, last_error = NULL, claim_token = excluded.claim_token,
       lease_expires_at = excluded.lease_expires_at, started_at = excluded.started_at,
       completed_at = NULL, updated_at = excluded.updated_at
     WHERE memory_five_axis_runs.status = 'failed'
        OR (memory_five_axis_runs.status = 'running'
            AND (memory_five_axis_runs.lease_expires_at IS NULL
                 OR memory_five_axis_runs.lease_expires_at <= excluded.started_at))`
  ).bind(
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken,
    leaseExpiresAt,
    now,
    now
  ).run();
  return (result.meta.changes ?? 0) === 1 ? claimToken : null;
}

export async function completeFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  claimToken: string,
  status: Exclude<FiveAxisRunStatus, "running" | "failed">,
  result: unknown
): Promise<boolean> {
  const now = nowIso();
  const write = await db.prepare(
    `UPDATE memory_five_axis_runs
     SET status = ?, result_json = ?, last_error = NULL, claim_token = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?
       AND status = 'running' AND claim_token = ?`
  ).bind(
    status,
    JSON.stringify(result),
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken
  ).run();
  return (write.meta.changes ?? 0) === 1;
}

export async function failFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  claimToken: string,
  error: unknown
): Promise<boolean> {
  const now = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const write = await db.prepare(
    `UPDATE memory_five_axis_runs
     SET status = 'failed', result_json = NULL, last_error = ?, claim_token = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?
       AND status = 'running' AND claim_token = ?`
  ).bind(
    message.slice(0, 1000),
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken
  ).run();
  return (write.meta.changes ?? 0) === 1;
}
