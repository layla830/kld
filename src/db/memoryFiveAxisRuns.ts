import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { fiveAxisMemoryEligibilityPredicate } from "../memory/fiveAxis/eligibility";
import type { FiveAxisName, FiveAxisRunStatus } from "./fiveAxisStatuses";
import {
  candidateReviewStatusSql,
  prepareMemoryCandidateDependencyInsert
} from "./memoryCandidateDependencies";

export type { FiveAxisName, FiveAxisRunStatus } from "./fiveAxisStatuses";

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

export type CompleteFiveAxisRunOutcome =
  | "completed"
  | "superseded"
  | "not_owned"
  | "invalid_input";

export type FailFiveAxisRunOutcome = "failed" | "superseded" | "not_owned";

const SUPERSEDED_BY_NEWER_MEMORY_REVISION = "superseded_by_newer_memory_revision";
export const FIVE_AXIS_RUN_ATTEMPTS_EXHAUSTED = "attempts_exhausted";

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

function prepareSupersedeOlderAxisRuns(
  db: D1Database,
  key: FiveAxisRunKey,
  now: string
): D1PreparedStatement {
  const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
  return db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = 'skipped',
         result_json = json_object(
           'reason', ?,
           'previous_revision', runs.memory_revision,
           'current_revision', ?
         ),
         last_error = NULL,
         claim_token = NULL,
         lease_expires_at = NULL,
         completed_at = ?,
         updated_at = ?
     WHERE runs.namespace = ?
       AND runs.memory_id = ?
       AND runs.axis = ?
       AND runs.memory_revision < ?
       AND (
         (
           runs.status = 'running'
           AND runs.claim_token IS NOT NULL
           AND runs.lease_expires_at IS NOT NULL
         )
         OR
         (
           runs.status = 'failed'
           AND runs.claim_token IS NULL
           AND runs.lease_expires_at IS NULL
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM memory_candidate_axis_runs AS link
         WHERE link.namespace = runs.namespace
           AND link.memory_id = runs.memory_id
           AND link.memory_revision = runs.memory_revision
           AND link.axis = runs.axis
       )
       AND EXISTS (
         SELECT 1
         FROM memories AS memory
         WHERE memory.namespace = ?
           AND memory.id = ?
           AND memory.five_axis_revision = ?
           AND (${eligibility.sql})
       )`
  ).bind(
    SUPERSEDED_BY_NEWER_MEMORY_REVISION,
    key.memoryRevision,
    now,
    now,
    key.namespace,
    key.memoryId,
    key.axis,
    key.memoryRevision,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    ...eligibility.binds
  );
}

async function supersedeClaimedAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  claimToken: string,
  now: string
): Promise<boolean> {
  const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
  const write = await db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = 'skipped',
         result_json = json_object(
           'reason', ?,
           'previous_revision', runs.memory_revision,
           'current_revision', (
             SELECT memory.five_axis_revision
             FROM memories AS memory
             WHERE memory.namespace = runs.namespace
               AND memory.id = runs.memory_id
           )
         ),
         last_error = NULL,
         claim_token = NULL,
         lease_expires_at = NULL,
         completed_at = ?,
         updated_at = ?
     WHERE runs.namespace = ?
       AND runs.memory_id = ?
       AND runs.memory_revision = ?
       AND runs.axis = ?
       AND runs.status = 'running'
       AND runs.claim_token = ?
       AND NOT EXISTS (
         SELECT 1
         FROM memory_candidate_axis_runs AS link
         WHERE link.namespace = runs.namespace
           AND link.memory_id = runs.memory_id
           AND link.memory_revision = runs.memory_revision
           AND link.axis = runs.axis
       )
       AND EXISTS (
         SELECT 1
         FROM memories AS memory
         WHERE memory.namespace = runs.namespace
           AND memory.id = runs.memory_id
           AND memory.five_axis_revision > runs.memory_revision
           AND (${eligibility.sql})
       )`
  ).bind(
    SUPERSEDED_BY_NEWER_MEMORY_REVISION,
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken,
    ...eligibility.binds
  ).run();
  return (write.meta.changes ?? 0) === 1;
}

export async function claimFiveAxisRun(db: D1Database, key: FiveAxisRunKey): Promise<string | null> {
  const now = nowIso();
  const claimToken = newId("axisrun");
  const leaseExpiresAt = new Date(Date.now() + AXIS_RUN_LEASE_MS).toISOString();
  const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
  const claimStatement = db.prepare(
    `INSERT INTO memory_five_axis_runs (
       namespace, memory_id, memory_revision, axis, status, attempts,
       result_json, last_error, claim_token, lease_expires_at,
       started_at, completed_at, updated_at
     )
     SELECT
       memory.namespace, memory.id, memory.five_axis_revision, ?,
       'running', 1, NULL, NULL, ?, ?, ?, NULL, ?
     FROM memories AS memory
     WHERE memory.namespace = ? AND memory.id = ?
       AND memory.five_axis_revision = ?
       AND (${eligibility.sql})
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
    key.axis,
    claimToken,
    leaseExpiresAt,
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    ...eligibility.binds,
    MAX_FIVE_AXIS_RUN_ATTEMPTS
  );
  const writes = await db.batch([
    prepareSupersedeOlderAxisRuns(db, key, now),
    claimStatement
  ]);
  return (writes[1]?.meta.changes ?? 0) === 1 ? claimToken : null;
}

export async function completeFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  claimToken: string,
  status: Exclude<FiveAxisRunStatus, "running" | "failed">,
  result: unknown,
  candidateExternalKeys: string[] = []
): Promise<CompleteFiveAxisRunOutcome> {
  const now = nowIso();
  const uniqueCandidateKeys = [...new Set(candidateExternalKeys.map((value) => value.trim()).filter(Boolean))];
  if (status === "pending_review" && uniqueCandidateKeys.length === 0) return "invalid_input";
  const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
  const currentMemoryGuard = `EXISTS (
    SELECT 1 FROM memories AS memory
    WHERE memory.namespace = memory_five_axis_runs.namespace
      AND memory.id = memory_five_axis_runs.memory_id
      AND memory.five_axis_revision = memory_five_axis_runs.memory_revision
      AND (${eligibility.sql})
  )`;
  const writeStatement = db.prepare(
    `UPDATE memory_five_axis_runs
     SET status = ?, result_json = ?, last_error = NULL, claim_token = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?
       AND status = 'running' AND claim_token = ?
       AND (${currentMemoryGuard})`
  ).bind(
    status,
    JSON.stringify(result),
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken,
    ...eligibility.binds
  );
  if (status !== "pending_review") {
    const write = await writeStatement.run();
    if ((write.meta.changes ?? 0) === 1) return "completed";
    return await supersedeClaimedAxisRun(db, key, claimToken, now)
      ? "superseded"
      : "not_owned";
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
         AND (${currentMemoryGuard})
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
    ...eligibility.binds,
    key.namespace,
    candidateExternalKey
  ));
  const dependencyStatements = uniqueCandidateKeys.map((candidateExternalKey) =>
    prepareMemoryCandidateDependencyInsert(db, key.namespace, candidateExternalKey, {
      memoryId: key.memoryId,
      role: "axis_run"
    }, {
      sql: `EXISTS (
        SELECT 1 FROM memory_candidate_axis_runs
        WHERE namespace = ? AND candidate_external_key = ?
          AND memory_id = ? AND memory_revision = ? AND axis = ?
      )`,
      binds: [
        key.namespace,
        candidateExternalKey,
        key.memoryId,
        key.memoryRevision,
        key.axis
      ]
    })
  );
  const updateIndex = linkStatements.length + dependencyStatements.length;
  const writes = await db.batch([
    ...linkStatements,
    ...dependencyStatements,
    writeStatement,
    prepareAxisRunReconciliation(db, key, now)
  ]);
  if ((writes[updateIndex]?.meta.changes ?? 0) === 1) return "completed";
  return await supersedeClaimedAxisRun(db, key, claimToken, now)
    ? "superseded"
    : "not_owned";
}

export async function failFiveAxisRun(
  db: D1Database,
  key: FiveAxisRunKey,
  claimToken: string,
  error: unknown
): Promise<FailFiveAxisRunOutcome> {
  const now = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
  const write = await db.prepare(
    `UPDATE memory_five_axis_runs
     SET status = CASE WHEN attempts >= ? THEN 'skipped' ELSE 'failed' END,
         result_json = CASE
           WHEN attempts >= ? THEN json_object(
             'reason', ?,
             'attempts', attempts,
             'last_error', ?
           )
           ELSE NULL
         END,
         last_error = CASE WHEN attempts >= ? THEN NULL ELSE ? END,
         claim_token = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
     WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?
       AND status = 'running' AND claim_token = ?
       AND EXISTS (
         SELECT 1 FROM memories AS memory
         WHERE memory.namespace = memory_five_axis_runs.namespace
           AND memory.id = memory_five_axis_runs.memory_id
           AND memory.five_axis_revision = memory_five_axis_runs.memory_revision
           AND (${eligibility.sql})
       )`
  ).bind(
    MAX_FIVE_AXIS_RUN_ATTEMPTS,
    MAX_FIVE_AXIS_RUN_ATTEMPTS,
    FIVE_AXIS_RUN_ATTEMPTS_EXHAUSTED,
    message.slice(0, 1000),
    MAX_FIVE_AXIS_RUN_ATTEMPTS,
    message.slice(0, 1000),
    now,
    now,
    key.namespace,
    key.memoryId,
    key.memoryRevision,
    key.axis,
    claimToken,
    ...eligibility.binds
  ).run();
  if ((write.meta.changes ?? 0) === 1) return "failed";
  return await supersedeClaimedAxisRun(db, key, claimToken, now)
    ? "superseded"
    : "not_owned";
}
