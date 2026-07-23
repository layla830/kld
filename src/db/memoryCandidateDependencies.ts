import type { MemoryMutationGuard } from "./memories";

export const PENDING_MEMORY_CANDIDATE_STATUSES = [
  "pending",
  "needs_subject_review",
  "deferred_relation"
] as const;

export type MemoryCandidateDependencyRole = "source" | "target" | "axis_run";
export type MemoryCandidateDeclaredDependencyRole = Exclude<
  MemoryCandidateDependencyRole,
  "axis_run"
>;

export interface MemoryCandidateDependency {
  memoryId: string;
  role: MemoryCandidateDependencyRole;
}

export interface MemoryCandidateDeclaredDependency {
  memoryId: string;
  role: MemoryCandidateDeclaredDependencyRole;
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

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

export function pendingDependentCandidateSql(
  candidateAlias: string,
  memoryIdExpression: string,
  excludedCandidateIdExpression: string
): string {
  return `${candidateDependsOnMemorySql(candidateAlias, memoryIdExpression)}
    AND ${candidateAlias}.status IN (${sqlStringList(PENDING_MEMORY_CANDIDATE_STATUSES)})
    AND ${candidateAlias}.id <> COALESCE(${excludedCandidateIdExpression}, '')`;
}

export const RECONCILABLE_CANDIDATE_RUN_STATUSES = [
  "pending_review",
  "applied",
  "skipped"
] as const;

export function dependentCandidateLinkedRunSql(
  runAlias: string,
  memoryIdExpression: string,
  excludedCandidateIdExpression: string
): string {
  return `EXISTS (
    SELECT 1
    FROM memory_candidate_axis_runs AS selected_link
    JOIN memory_candidates AS selected_candidate
      ON selected_candidate.namespace = selected_link.namespace
     AND selected_candidate.external_key = selected_link.candidate_external_key
    WHERE ${pendingDependentCandidateSql(
      "selected_candidate",
      memoryIdExpression,
      excludedCandidateIdExpression
    )}
      AND selected_link.namespace = ${runAlias}.namespace
      AND selected_link.memory_id = ${runAlias}.memory_id
      AND selected_link.memory_revision = ${runAlias}.memory_revision
      AND selected_link.axis = ${runAlias}.axis
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
  dependencies: readonly MemoryCandidateDeclaredDependency[]
): D1PreparedStatement[] {
  const candidateIsPending: MemoryMutationGuard = {
    sql: `EXISTS (
      SELECT 1 FROM memory_candidates
      WHERE namespace = ? AND external_key = ?
        AND status IN (${sqlStringList(PENDING_MEMORY_CANDIDATE_STATUSES)})
    )`,
    binds: [
      namespace,
      candidateExternalKey
    ]
  };
  const remove = db.prepare(
    `DELETE FROM memory_candidate_dependencies
     WHERE namespace = ? AND candidate_external_key = ?
       AND role IN ('source', 'target')
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
  reason: string;
  now: string;
  guard: MemoryMutationGuard;
  candidateSelection: MemoryMutationGuard;
  runSelection: MemoryMutationGuard;
}

export interface PreparedDependentCandidateRejection {
  statements: D1PreparedStatement[];
  invariant: MemoryMutationGuard;
}

export function prepareRejectDependentCandidates(
  db: D1Database,
  input: PrepareRejectDependentCandidatesInput
): PreparedDependentCandidateRejection {
  const rejection = db.prepare(
    `UPDATE memory_candidates AS candidate
     SET status = 'rejected',
         validation_error = ?,
         resolved_at = ?,
         updated_at = ?
     WHERE candidate.status IN (${sqlStringList(PENDING_MEMORY_CANDIDATE_STATUSES)})
       AND (${input.candidateSelection.sql})
       AND (${input.guard.sql})`
  ).bind(
    input.reason,
    input.now,
    input.now,
    ...input.candidateSelection.binds,
    ...input.guard.binds
  );

  const reconcile = db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = ${candidateReviewStatusSql("runs")},
         claim_token = NULL,
         lease_expires_at = NULL,
         completed_at = ?,
         updated_at = ?
     WHERE runs.status IN (${sqlStringList(RECONCILABLE_CANDIDATE_RUN_STATUSES)})
       AND (${input.runSelection.sql})
       AND (${input.guard.sql})`
  ).bind(
    input.now,
    input.now,
    ...input.runSelection.binds,
    ...input.guard.binds
  );

  return {
    statements: [rejection, reconcile],
    invariant: {
      sql: `NOT EXISTS (
          SELECT 1
          FROM memory_candidates AS candidate
          WHERE candidate.status IN (${sqlStringList(PENDING_MEMORY_CANDIDATE_STATUSES)})
            AND (${input.candidateSelection.sql})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM memory_five_axis_runs AS runs
          WHERE (${input.runSelection.sql})
            AND runs.status <> ${candidateReviewStatusSql("runs")}
        )`,
      binds: [
        ...input.candidateSelection.binds,
        ...input.runSelection.binds
      ]
    }
  };
}
