import type { PreparedMemoryDeprojection, PrepareMemoryDeprojectionInput } from "../memory/deprojection";
import {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition,
  fiveAxisMemoryEligibilityPredicate,
  type MemoryEligibilityTransition
} from "../memory/fiveAxis/eligibility";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import {
  FIVE_AXIS_OUTBOX_TRANSITIONS,
  FIVE_AXIS_RUN_STATUS,
  statusPlaceholders
} from "./fiveAxisStatuses";
import { prepareMemoryUpdate, type MemoryMutationGuard } from "./memories";

const PENDING_CANDIDATE_STATUSES = ["pending", "needs_subject_review", "deferred_relation"] as const;
const DEPROJECT_OUTBOX_TRANSITION = FIVE_AXIS_OUTBOX_TRANSITIONS.deproject;
const DEPROJECTABLE_OUTBOX_STATUSES = DEPROJECT_OUTBOX_TRANSITION.from;
const DEPROJECTED_OUTBOX_STATUS = DEPROJECT_OUTBOX_TRANSITION.to[0];
const NON_TERMINAL_AXIS_RUN_STATUSES = [
  FIVE_AXIS_RUN_STATUS.RUNNING,
  FIVE_AXIS_RUN_STATUS.FAILED,
  FIVE_AXIS_RUN_STATUS.PENDING_REVIEW
] as const;

export interface MemoryDeprojectionRecord {
  operation_id: string;
  namespace: string;
  memory_id: string;
  source: string;
  reason: string;
  candidate_id: string | null;
  transition: "eligible_to_ineligible";
  previous_status: string;
  next_status: string;
  previous_type: string;
  next_type: string;
  previous_active_fact: number;
  next_active_fact: number;
  previous_revision: number;
  current_revision: number;
  relation_snapshot_json: string;
  timeline_snapshot_json: string;
  outbox_snapshot_json: string;
  axis_run_snapshot_json: string;
  candidate_snapshot_json: string;
  removed_relations: number;
  removed_timeline_memberships: number;
  invalidated_candidates: number;
  terminalized_outboxes: number;
  terminalized_axis_runs: number;
  vector_sync_required: number;
  invariants_verified: number;
  created_at: string;
  completed_at: string | null;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

interface SqlFragment {
  sql: string;
  binds: unknown[];
}

function candidateDependencyPredicate(
  candidateAlias: string,
  memoryId: SqlFragment
): SqlFragment {
  const binds: unknown[] = [];
  const memoryIdExpression = (): string => {
    binds.push(...memoryId.binds);
    return memoryId.sql;
  };
  const linkExists = `EXISTS (
    SELECT 1
    FROM memory_candidate_axis_runs AS dependency_link
    WHERE dependency_link.namespace = ${candidateAlias}.namespace
      AND dependency_link.candidate_external_key = ${candidateAlias}.external_key
      AND dependency_link.memory_id = ${memoryIdExpression()}
  )`;
  const anyLinkExists = `EXISTS (
    SELECT 1
    FROM memory_candidate_axis_runs AS dependency_link
    WHERE dependency_link.namespace = ${candidateAlias}.namespace
      AND dependency_link.candidate_external_key = ${candidateAlias}.external_key
  )`;
  const safePayload = `(CASE
    WHEN json_valid(${candidateAlias}.payload_json) THEN ${candidateAlias}.payload_json
    ELSE '{}'
  END)`;

  const sql = `(
    ${candidateAlias}.target_id = ${memoryIdExpression()}
    OR ${linkExists}
    OR (
      NOT (${anyLinkExists})
      AND (
        (
          ${candidateAlias}.action = 'y_relation_review'
          AND (
            json_extract(${safePayload}, '$.source_id') = ${memoryIdExpression()}
            OR json_extract(${safePayload}, '$.target_id') = ${memoryIdExpression()}
          )
        )
        OR (
          ${candidateAlias}.action = 'm_relation_cleanup'
          AND (
            json_extract(${safePayload}, '$.before.source_memory_id') = ${memoryIdExpression()}
            OR json_extract(${safePayload}, '$.before.target_memory_id') = ${memoryIdExpression()}
          )
        )
      )
    )
  )`;
  return { sql, binds };
}

function operationPendingGuard(operationId: string): MemoryMutationGuard {
  return {
    sql: `EXISTS (
      SELECT 1 FROM memory_deprojections
      WHERE operation_id = ? AND completed_at IS NULL
    )`,
    binds: [operationId]
  };
}

function combineGuards(...guards: Array<MemoryMutationGuard | undefined>): MemoryMutationGuard {
  const present = guards.filter((guard): guard is MemoryMutationGuard => Boolean(guard));
  return {
    sql: present.map((guard) => `(${guard.sql})`).join(" AND "),
    binds: present.flatMap((guard) => guard.binds)
  };
}

function transitionSnapshotInsert(
  db: D1Database,
  input: PrepareMemoryDeprojectionInput,
  operationId: string,
  transition: "eligible_to_ineligible",
  previousRevision: number,
  currentRevision: number,
  next: ReturnType<typeof applyMemoryEligibilityPatch>,
  now: string
): D1PreparedStatement {
  const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
  const expectedStatus = input.expectedStatus ?? input.memory.status;
  const expectedRevision = input.expectedRevision ?? previousRevision;
  const externalGuard = input.guard ? ` AND (${input.guard.sql})` : "";
  const unpinnedGuard = input.requireUnpinned ? " AND memory.pinned = 0" : "";
  const candidateDependency = candidateDependencyPredicate("candidate", {
    sql: "memory.id",
    binds: []
  });

  return db.prepare(
    `INSERT OR IGNORE INTO memory_deprojections (
       operation_id, namespace, memory_id, source, reason, candidate_id, transition,
       previous_status, next_status, previous_type, next_type,
       previous_active_fact, next_active_fact, previous_revision, current_revision,
       relation_snapshot_json, timeline_snapshot_json, outbox_snapshot_json,
       axis_run_snapshot_json, candidate_snapshot_json,
       vector_sync_required, created_at
     )
     SELECT
       ?, memory.namespace, memory.id, ?, ?, ?, ?,
       memory.status, ?, memory.type, ?,
       memory.active_fact, ?, memory.five_axis_revision, ?,
       COALESCE((
         SELECT json_group_array(json_object(
           'id', relation.id,
           'namespace', relation.namespace,
           'source_memory_id', relation.source_memory_id,
           'target_memory_id', relation.target_memory_id,
           'relation_type', relation.relation_type,
           'strength', relation.strength,
           'reason', relation.reason,
           'created_at', relation.created_at
         ))
         FROM memory_relations AS relation
         WHERE relation.namespace = memory.namespace
           AND (relation.source_memory_id = memory.id OR relation.target_memory_id = memory.id)
       ), '[]'),
       json_object(
         'memory_timeline_memberships', json(COALESCE((
           SELECT json_group_array(json_object(
             'namespace', membership.namespace,
             'memory_id', membership.memory_id,
             'thread', membership.thread,
             'fact_key', membership.fact_key,
             'updated_at', membership.updated_at
           ))
           FROM memory_timeline_memberships AS membership
           WHERE membership.namespace = memory.namespace
             AND membership.memory_id = memory.id
         ), '[]')),
         'memory_diary_timeline_memberships', json(COALESCE((
           SELECT json_group_array(json_object(
             'namespace', diary_membership.namespace,
             'memory_id', diary_membership.memory_id,
             'origin_diary_id', diary_membership.origin_diary_id,
             'timeline_key', diary_membership.timeline_key,
             'event_date', diary_membership.event_date,
             'role', diary_membership.role,
             'day_memory_id', diary_membership.day_memory_id,
             'updated_at', diary_membership.updated_at
           ))
           FROM memory_diary_timeline_memberships AS diary_membership
           WHERE diary_membership.namespace = memory.namespace
             AND (
               diary_membership.memory_id = memory.id
               OR diary_membership.origin_diary_id = memory.id
               OR diary_membership.day_memory_id = memory.id
             )
         ), '[]'))
       ),
       COALESCE((
         SELECT json_group_array(json_object(
           'id', outbox.id,
           'memory_revision', outbox.memory_revision,
           'status', outbox.status,
           'attempts', outbox.attempts,
           'queued_at', outbox.queued_at,
           'completed_at', outbox.completed_at,
           'last_error', outbox.last_error,
           'result_json', outbox.result_json,
           'created_at', outbox.created_at,
           'updated_at', outbox.updated_at
         ))
         FROM memory_five_axis_outbox AS outbox
         WHERE outbox.namespace = memory.namespace
           AND outbox.memory_id = memory.id
           AND outbox.memory_revision <= memory.five_axis_revision
           AND outbox.status IN (${statusPlaceholders(DEPROJECTABLE_OUTBOX_STATUSES)})
       ), '[]'),
       COALESCE((
         SELECT json_group_array(json_object(
           'memory_revision', run.memory_revision,
           'axis', run.axis,
           'status', run.status,
           'attempts', run.attempts,
           'result_json', run.result_json,
           'last_error', run.last_error,
           'claim_token', run.claim_token,
           'lease_expires_at', run.lease_expires_at,
           'started_at', run.started_at,
           'completed_at', run.completed_at,
           'updated_at', run.updated_at
         ))
         FROM memory_five_axis_runs AS run
         WHERE run.namespace = memory.namespace
           AND run.memory_id = memory.id
           AND run.memory_revision <= memory.five_axis_revision
           AND run.status IN (${placeholders(NON_TERMINAL_AXIS_RUN_STATUSES)})
       ), '[]'),
       COALESCE((
         SELECT json_group_array(json_object(
           'id', candidate.id,
           'external_key', candidate.external_key,
           'action', candidate.action,
           'target_id', candidate.target_id,
           'status', candidate.status,
           'validation_error', candidate.validation_error,
           'created_at', candidate.created_at,
           'updated_at', candidate.updated_at
         ))
         FROM memory_candidates AS candidate
         WHERE candidate.namespace = memory.namespace
           AND ${candidateDependency.sql}
           AND candidate.status IN (${placeholders(PENDING_CANDIDATE_STATUSES)})
           AND candidate.id <> COALESCE(?, '')
       ), '[]'),
       1, ?
     FROM memories AS memory
     WHERE memory.namespace = ? AND memory.id = ?
       AND memory.status = ?
       AND memory.five_axis_revision = ?
       AND (${eligibility.sql})
       ${unpinnedGuard}
       ${externalGuard}`
  ).bind(
    operationId,
    input.source,
    input.reason.trim().slice(0, 500),
    input.candidateId ?? null,
    transition,
    next.status,
    next.type,
    next.active_fact,
    currentRevision,
    ...DEPROJECTABLE_OUTBOX_STATUSES,
    ...NON_TERMINAL_AXIS_RUN_STATUSES,
    ...candidateDependency.binds,
    ...PENDING_CANDIDATE_STATUSES,
    input.candidateId ?? null,
    now,
    input.namespace,
    input.memoryId,
    expectedStatus,
    expectedRevision,
    ...eligibility.binds,
    ...(input.guard?.binds ?? [])
  );
}

function cleanupStatements(
  db: D1Database,
  input: PrepareMemoryDeprojectionInput,
  operationId: string,
  currentRevision: number,
  now: string
): D1PreparedStatement[] {
  const pendingOperationSql = `EXISTS (
    SELECT 1 FROM memory_deprojections
    WHERE operation_id = ? AND completed_at IS NULL
  )`;
  const outboxStatuses = statusPlaceholders(DEPROJECTABLE_OUTBOX_STATUSES);
  const runStatuses = placeholders(NON_TERMINAL_AXIS_RUN_STATUSES);
  const candidateStatuses = placeholders(PENDING_CANDIDATE_STATUSES);
  const candidateDependency = candidateDependencyPredicate("candidate", {
    sql: "?",
    binds: [input.memoryId]
  });

  return [
    db.prepare(
      `DELETE FROM memory_relations
       WHERE namespace = ?
         AND (source_memory_id = ? OR target_memory_id = ?)
         AND ${pendingOperationSql}`
    ).bind(input.namespace, input.memoryId, input.memoryId, operationId),
    db.prepare(
      `DELETE FROM memory_timeline_memberships
       WHERE namespace = ? AND memory_id = ?
         AND ${pendingOperationSql}`
    ).bind(input.namespace, input.memoryId, operationId),
    db.prepare(
      `DELETE FROM memory_diary_timeline_memberships
       WHERE namespace = ?
         AND (memory_id = ? OR origin_diary_id = ? OR day_memory_id = ?)
         AND ${pendingOperationSql}`
    ).bind(input.namespace, input.memoryId, input.memoryId, input.memoryId, operationId),
    db.prepare(
      `UPDATE memory_five_axis_outbox
       SET status = ?,
           last_error = NULL,
           result_json = json_object('reason', 'memory_deprojected', 'operation_id', ?),
           completed_at = ?,
           updated_at = ?
       WHERE namespace = ? AND memory_id = ?
         AND memory_revision <= ?
         AND status IN (${outboxStatuses})
         AND ${pendingOperationSql}`
    ).bind(
      DEPROJECTED_OUTBOX_STATUS,
      operationId,
      now,
      now,
      input.namespace,
      input.memoryId,
      currentRevision,
      ...DEPROJECTABLE_OUTBOX_STATUSES,
      operationId
    ),
    db.prepare(
      `UPDATE memory_five_axis_runs
       SET status = ?,
           result_json = json_object('reason', 'memory_deprojected', 'operation_id', ?),
           last_error = NULL,
           claim_token = NULL,
           lease_expires_at = NULL,
           completed_at = ?,
           updated_at = ?
       WHERE namespace = ? AND memory_id = ?
         AND memory_revision <= ?
         AND status IN (${runStatuses})
         AND ${pendingOperationSql}`
    ).bind(
      FIVE_AXIS_RUN_STATUS.SKIPPED,
      operationId,
      now,
      now,
      input.namespace,
      input.memoryId,
      currentRevision,
      ...NON_TERMINAL_AXIS_RUN_STATUSES,
      operationId
    ),
    db.prepare(
      `UPDATE memory_candidates AS candidate
       SET status = 'rejected',
           validation_error = 'memory_deprojected',
           resolved_at = ?,
           updated_at = ?
       WHERE candidate.namespace = ?
         AND ${candidateDependency.sql}
         AND candidate.status IN (${candidateStatuses})
         AND candidate.id <> COALESCE(?, '')
         AND ${pendingOperationSql}`
    ).bind(
      now,
      now,
      input.namespace,
      ...candidateDependency.binds,
      ...PENDING_CANDIDATE_STATUSES,
      input.candidateId ?? null,
      operationId
    )
  ];
}

function invariantGuard(
  input: PrepareMemoryDeprojectionInput,
  operationId: string,
  currentRevision: number,
  next: ReturnType<typeof applyMemoryEligibilityPatch>
): MemoryMutationGuard {
  const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
  const candidateDependency = candidateDependencyPredicate("candidate", {
    sql: "?",
    binds: [input.memoryId]
  });
  return {
    sql: `EXISTS (
        SELECT 1 FROM memories AS memory
        WHERE memory.namespace = ? AND memory.id = ?
          AND memory.status = ?
          AND memory.type = ?
          AND memory.active_fact = ?
          AND memory.five_axis_revision = ?
          AND NOT (${eligibility.sql})
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_relations
        WHERE namespace = ? AND (source_memory_id = ? OR target_memory_id = ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_timeline_memberships
        WHERE namespace = ? AND memory_id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_diary_timeline_memberships
        WHERE namespace = ?
          AND (memory_id = ? OR origin_diary_id = ? OR day_memory_id = ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_five_axis_outbox
        WHERE namespace = ? AND memory_id = ? AND memory_revision <= ?
          AND status IN (${statusPlaceholders(DEPROJECTABLE_OUTBOX_STATUSES)})
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_five_axis_runs
        WHERE namespace = ? AND memory_id = ? AND memory_revision <= ?
          AND status IN (${placeholders(NON_TERMINAL_AXIS_RUN_STATUSES)})
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_candidates AS candidate
        WHERE candidate.namespace = ?
          AND ${candidateDependency.sql}
          AND candidate.status IN (${placeholders(PENDING_CANDIDATE_STATUSES)})
          AND candidate.id <> COALESCE(?, '')
      )
      AND EXISTS (
        SELECT 1 FROM memory_deprojections
        WHERE operation_id = ? AND completed_at IS NULL
      )`,
    binds: [
      input.namespace,
      input.memoryId,
      next.status,
      next.type,
      next.active_fact,
      currentRevision,
      ...eligibility.binds,
      input.namespace,
      input.memoryId,
      input.memoryId,
      input.namespace,
      input.memoryId,
      input.namespace,
      input.memoryId,
      input.memoryId,
      input.memoryId,
      input.namespace,
      input.memoryId,
      currentRevision,
      ...DEPROJECTABLE_OUTBOX_STATUSES,
      input.namespace,
      input.memoryId,
      currentRevision,
      ...NON_TERMINAL_AXIS_RUN_STATUSES,
      input.namespace,
      ...candidateDependency.binds,
      ...PENDING_CANDIDATE_STATUSES,
      input.candidateId ?? null,
      operationId
    ]
  };
}

export function prepareMemoryDeprojection(
  db: D1Database,
  input: PrepareMemoryDeprojectionInput
): PreparedMemoryDeprojection {
  const next = applyMemoryEligibilityPatch(input.memory, input.patch);
  const transition: MemoryEligibilityTransition = classifyMemoryEligibilityTransition(input.memory, next);
  if (transition !== "eligible_to_ineligible") {
    throw new Error(`memory_deprojection_requires_eligible_to_ineligible:${transition}`);
  }
  if (!input.reason.trim()) throw new Error("memory_deprojection_reason_required");

  const previousRevision = input.memory.five_axis_revision ?? 1;
  const currentRevision = previousRevision + 1;
  const operationId = input.operationId ?? newId("deproj");
  const now = input.now ?? nowIso();
  const operationGuard = combineGuards(
    operationPendingGuard(operationId),
    {
      sql: "five_axis_revision = ?",
      binds: [previousRevision]
    }
  );
  const memoryUpdate = prepareMemoryUpdate(db, {
    namespace: input.namespace,
    id: input.memoryId,
    patch: {
      ...input.patch,
      vectorSyncStatus: "pending"
    },
    expectedStatus: input.expectedStatus ?? input.memory.status,
    requireUnpinned: input.requireUnpinned,
    guard: operationGuard,
    markVectorUnsynced: true,
    nextFiveAxisRevision: currentRevision,
    now
  });
  if (!memoryUpdate) throw new Error("memory_deprojection_update_statement_missing");

  const invariant = invariantGuard(input, operationId, currentRevision, next);
  const finalize = db.prepare(
    `UPDATE memory_deprojections
     SET removed_relations = json_array_length(relation_snapshot_json),
         removed_timeline_memberships =
           json_array_length(timeline_snapshot_json, '$.memory_timeline_memberships')
           + json_array_length(timeline_snapshot_json, '$.memory_diary_timeline_memberships'),
         invalidated_candidates = json_array_length(candidate_snapshot_json),
         terminalized_outboxes = json_array_length(outbox_snapshot_json),
         terminalized_axis_runs = json_array_length(axis_run_snapshot_json),
         invariants_verified = CASE WHEN (${invariant.sql}) THEN 1 ELSE 0 END,
         completed_at = ?
     WHERE operation_id = ? AND completed_at IS NULL`
  ).bind(...invariant.binds, now, operationId);

  return {
    statements: [
      transitionSnapshotInsert(
        db,
        input,
        operationId,
        transition,
        previousRevision,
        currentRevision,
        next,
        now
      ),
      memoryUpdate,
      ...cleanupStatements(db, input, operationId, currentRevision, now),
      finalize
    ],
    successGuard: {
      sql: `EXISTS (
        SELECT 1 FROM memory_deprojections
        WHERE operation_id = ? AND completed_at IS NOT NULL AND invariants_verified = 1
      )`,
      binds: [operationId]
    },
    operationId,
    transition,
    previousRevision,
    currentRevision
  };
}

export async function getMemoryDeprojectionByOperationId(
  db: D1Database,
  operationId: string
): Promise<MemoryDeprojectionRecord | null> {
  return (await db.prepare(
    "SELECT * FROM memory_deprojections WHERE operation_id = ?"
  ).bind(operationId).first<MemoryDeprojectionRecord>()) ?? null;
}

export async function findCompletedMemoryDeprojection(
  db: D1Database,
  input: {
    namespace: string;
    memoryId: string;
    currentRevision: number;
    status: string;
    type: string;
    activeFact: number;
  }
): Promise<MemoryDeprojectionRecord | null> {
  return (await db.prepare(
    `SELECT * FROM memory_deprojections
     WHERE namespace = ? AND memory_id = ? AND current_revision = ?
       AND next_status = ? AND next_type = ? AND next_active_fact = ?
       AND completed_at IS NOT NULL AND invariants_verified = 1
     ORDER BY completed_at DESC
     LIMIT 1`
  ).bind(
    input.namespace,
    input.memoryId,
    input.currentRevision,
    input.status,
    input.type,
    input.activeFact
  ).first<MemoryDeprojectionRecord>()) ?? null;
}
