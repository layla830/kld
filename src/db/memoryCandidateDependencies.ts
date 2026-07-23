import type { MemoryMutationGuard } from "./memories";

export const PENDING_MEMORY_CANDIDATE_STATUSES = [
  "pending",
  "needs_subject_review",
  "deferred_relation"
] as const;

export type MemoryCandidateDependencyRole = "source" | "target" | "axis_run";

export interface MemoryCandidateDependency {
  memoryId: string;
  role: MemoryCandidateDependencyRole;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export function candidateDependsOnMemorySql(
  candidateAlias: string,
  memoryIdExpression: string
): string {
  return `EXISTS (
    SELECT 1
    FROM memory_candidate_dependencies AS dependency
    WHERE dependency.namespace = ${candidateAlias}.namespace
      AND dependency.candidate_external_key = ${candidateAlias}.external_key
      AND dependency.memory_id = ${memoryIdExpression}
  )`;
}

export function candidateReviewStatusSql(runAlias: string): string {
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

export function prepareMemoryCandidateDependencyInsert(
  db: D1Database,
  namespace: string,
  candidateExternalKey: string,
  dependency: MemoryCandidateDependency,
  guard?: MemoryMutationGuard
): D1PreparedStatement {
  const guardSql = guard ? ` AND (${guard.sql})` : "";
  return db.prepare(
    `INSERT OR IGNORE INTO memory_candidate_dependencies (
       namespace, candidate_external_key, memory_id, role
     )
     SELECT ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM memory_candidates
       WHERE namespace = ? AND external_key = ?
     )${guardSql}`
  ).bind(
    namespace,
    candidateExternalKey,
    dependency.memoryId,
    dependency.role,
    namespace,
    candidateExternalKey,
    ...(guard?.binds ?? [])
  );
}

export function prepareMemoryCandidateDependencyReplacement(
  db: D1Database,
  namespace: string,
  candidateExternalKey: string,
  dependencies: readonly MemoryCandidateDependency[]
): D1PreparedStatement[] {
  const pendingStatuses = placeholders(PENDING_MEMORY_CANDIDATE_STATUSES);
  const candidateIsPending: MemoryMutationGuard = {
    sql: `EXISTS (
      SELECT 1 FROM memory_candidates
      WHERE namespace = ? AND external_key = ?
        AND status IN (${pendingStatuses})
    )`,
    binds: [
      namespace,
      candidateExternalKey,
      ...PENDING_MEMORY_CANDIDATE_STATUSES
    ]
  };
  const remove = db.prepare(
    `DELETE FROM memory_candidate_dependencies
     WHERE namespace = ? AND candidate_external_key = ?
       AND (${candidateIsPending.sql})`
  ).bind(
    namespace,
    candidateExternalKey,
    ...candidateIsPending.binds
  );
  return [
    remove,
    ...dependencies.map((dependency) => prepareMemoryCandidateDependencyInsert(
      db,
      namespace,
      candidateExternalKey,
      dependency,
      candidateIsPending
    ))
  ];
}

export interface PrepareRejectDependentCandidatesInput {
  namespace: string;
  memoryId: string;
  excludeCandidateId?: string;
  reason: string;
  now: string;
  guard: MemoryMutationGuard;
  excludeRunMemoryId?: string;
}

export interface PreparedDependentCandidateRejection {
  statements: D1PreparedStatement[];
  invariant: MemoryMutationGuard;
}

export function prepareRejectDependentCandidates(
  db: D1Database,
  input: PrepareRejectDependentCandidatesInput
): PreparedDependentCandidateRejection {
  const pendingStatuses = placeholders(PENDING_MEMORY_CANDIDATE_STATUSES);
  const dependency = candidateDependsOnMemorySql("candidate", "?");
  const rejection = db.prepare(
    `UPDATE memory_candidates AS candidate
     SET status = 'rejected',
         validation_error = ?,
         resolved_at = ?,
         updated_at = ?
     WHERE candidate.namespace = ?
       AND ${dependency}
       AND candidate.status IN (${pendingStatuses})
       AND candidate.id <> COALESCE(?, '')
       AND (${input.guard.sql})`
  ).bind(
    input.reason,
    input.now,
    input.now,
    input.namespace,
    input.memoryId,
    ...PENDING_MEMORY_CANDIDATE_STATUSES,
    input.excludeCandidateId ?? null,
    ...input.guard.binds
  );

  const affectedRun = `EXISTS (
    SELECT 1
    FROM memory_candidate_axis_runs AS changed_link
    JOIN memory_candidates AS changed_candidate
      ON changed_candidate.namespace = changed_link.namespace
     AND changed_candidate.external_key = changed_link.candidate_external_key
    JOIN memory_candidate_dependencies AS changed_dependency
      ON changed_dependency.namespace = changed_candidate.namespace
     AND changed_dependency.candidate_external_key = changed_candidate.external_key
    WHERE changed_dependency.namespace = ?
      AND changed_dependency.memory_id = ?
      AND changed_candidate.id <> COALESCE(?, '')
      AND changed_candidate.status = 'rejected'
      AND changed_candidate.validation_error = ?
      AND changed_link.namespace = runs.namespace
      AND changed_link.memory_id = runs.memory_id
      AND changed_link.memory_revision = runs.memory_revision
      AND changed_link.axis = runs.axis
  )`;
  const affectedRunBinds = [
    input.namespace,
    input.memoryId,
    input.excludeCandidateId ?? null,
    input.reason
  ];
  const reconcile = db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = ${candidateReviewStatusSql("runs")},
         claim_token = NULL,
         lease_expires_at = NULL,
         completed_at = ?,
         updated_at = ?
     WHERE runs.status IN ('pending_review', 'applied', 'skipped')
       AND runs.memory_id <> COALESCE(?, '')
       AND ${affectedRun}
       AND (${input.guard.sql})`
  ).bind(
    input.now,
    input.now,
    input.excludeRunMemoryId ?? null,
    ...affectedRunBinds,
    ...input.guard.binds
  );

  return {
    statements: [rejection, reconcile],
    invariant: {
      sql: `NOT EXISTS (
          SELECT 1
          FROM memory_candidates AS candidate
          WHERE candidate.namespace = ?
            AND ${dependency}
            AND candidate.status IN (${pendingStatuses})
            AND candidate.id <> COALESCE(?, '')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM memory_five_axis_runs AS runs
          WHERE runs.memory_id <> COALESCE(?, '')
            AND ${affectedRun}
            AND runs.status <> ${candidateReviewStatusSql("runs")}
        )`,
      binds: [
        input.namespace,
        input.memoryId,
        ...PENDING_MEMORY_CANDIDATE_STATUSES,
        input.excludeCandidateId ?? null,
        input.excludeRunMemoryId ?? null,
        ...affectedRunBinds
      ]
    }
  };
}
