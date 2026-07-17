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

function candidateReviewStatusSql(runAlias: string): string {
  return `CASE
    WHEN EXISTS (
      SELECT 1
      FROM memory_candidate_axis_runs links
      JOIN memory_candidates candidates
        ON candidates.namespace = links.namespace
       AND candidates.external_key = links.candidate_external_key
      WHERE links.namespace = ${runAlias}.namespace
        AND links.memory_id = ${runAlias}.memory_id
        AND links.memory_revision = ${runAlias}.memory_revision
        AND links.axis = ${runAlias}.axis
        AND candidates.status IN ('pending', 'needs_subject_review', 'deferred_relation')
    ) THEN 'pending_review'
    WHEN EXISTS (
      SELECT 1
      FROM memory_candidate_axis_runs links
      JOIN memory_candidates candidates
        ON candidates.namespace = links.namespace
       AND candidates.external_key = links.candidate_external_key
      WHERE links.namespace = ${runAlias}.namespace
        AND links.memory_id = ${runAlias}.memory_id
        AND links.memory_revision = ${runAlias}.memory_revision
        AND links.axis = ${runAlias}.axis
        AND candidates.status = 'approved'
    ) THEN 'applied'
    ELSE 'skipped'
  END`;
}

export function prepareCandidateAxisRunReconciliation(
  db: D1Database,
  namespace: string,
  candidateId: string,
  now = nowIso()
): D1PreparedStatement {
  return db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = ${candidateReviewStatusSql("runs")},
         claim_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
     WHERE runs.status IN ('pending_review', 'applied', 'skipped')
       AND EXISTS (
         SELECT 1
         FROM memory_candidate_axis_runs changed_link
         JOIN memory_candidates changed_candidate
           ON changed_candidate.namespace = changed_link.namespace
          AND changed_candidate.external_key = changed_link.candidate_external_key
         WHERE changed_candidate.namespace = ? AND changed_candidate.id = ?
           AND changed_link.namespace = runs.namespace
           AND changed_link.memory_id = runs.memory_id
           AND changed_link.memory_revision = runs.memory_revision
           AND changed_link.axis = runs.axis
       )`
  ).bind(now, now, namespace, candidateId);
}

export function prepareCandidateAxisRunReconciliationByExternalKey(
  db: D1Database,
  namespace: string,
  candidateExternalKey: string,
  now = nowIso()
): D1PreparedStatement {
  return db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = ${candidateReviewStatusSql("runs")},
         claim_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
     WHERE runs.status IN ('pending_review', 'applied', 'skipped')
       AND EXISTS (
         SELECT 1 FROM memory_candidate_axis_runs changed_link
         WHERE changed_link.namespace = ?
           AND changed_link.candidate_external_key = ?
           AND changed_link.namespace = runs.namespace
           AND changed_link.memory_id = runs.memory_id
           AND changed_link.memory_revision = runs.memory_revision
           AND changed_link.axis = runs.axis
       )`
  ).bind(now, now, namespace, candidateExternalKey);
}

function prepareAxisRunReconciliation(
  db: D1Database,
  key: FiveAxisRunKey,
  now: string
): D1PreparedStatement {
  return db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = ${candidateReviewStatusSql("runs")},
         claim_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
     WHERE runs.namespace = ? AND runs.memory_id = ?
       AND runs.memory_revision = ? AND runs.axis = ?
       AND runs.status = 'pending_review'`
  ).bind(now, now, key.namespace, key.memoryId, key.memoryRevision, key.axis);
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
export const MAX_FIVE_AXIS_RUN_ATTEMPTS = 5;

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
     WHERE memory_five_axis_runs.attempts < ?
       AND (
         memory_five_axis_runs.status = 'failed'
         OR (memory_five_axis_runs.status = 'running'
             AND (memory_five_axis_runs.lease_expires_at IS NULL
                  OR memory_five_axis_runs.lease_expires_at <= excluded.started_at))
       )`
  ).bind(
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken,
    leaseExpiresAt,
    now,
    now,
    MAX_FIVE_AXIS_RUN_ATTEMPTS
  ).run();
  return (result.meta.changes ?? 0) === 1 ? claimToken : null;
}

export async function completeFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  claimToken: string,
  status: Exclude<FiveAxisRunStatus, "running" | "failed">,
  result: unknown,
  candidateExternalKeys: string[] = []
): Promise<boolean> {
  const now = nowIso();
  const uniqueCandidateKeys = [...new Set(candidateExternalKeys.map((value) => value.trim()).filter(Boolean))];
  if (status === "pending_review" && uniqueCandidateKeys.length === 0) return false;
  const writeStatement = db.prepare(
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
  );
  if (status !== "pending_review") {
    const write = await writeStatement.run();
    return (write.meta.changes ?? 0) === 1;
  }

  const linkStatements = uniqueCandidateKeys.map((candidateExternalKey) => db.prepare(
    `INSERT OR IGNORE INTO memory_candidate_axis_runs (
       namespace, candidate_external_key, memory_id, memory_revision, axis, created_at
     )
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?
         AND status = 'running' AND claim_token = ?
     )
       AND EXISTS (
         SELECT 1 FROM memory_candidates
         WHERE namespace = ? AND external_key = ?
       )`
  ).bind(
    key.namespace,
    candidateExternalKey,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken,
    key.namespace,
    candidateExternalKey
  ));
  const updateIndex = linkStatements.length;
  const writes = await db.batch([
    ...linkStatements,
    writeStatement,
    prepareAxisRunReconciliation(db, key, now)
  ]);
  return (writes[updateIndex]?.meta.changes ?? 0) === 1;
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
