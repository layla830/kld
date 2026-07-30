import {
  fiveAxisMemoryEligibilityPredicate
} from "../src/memory/fiveAxis/eligibilityContract.js";
import {
  activeDiarySplitSourcePredicate
} from "../src/memory/diaryPolicyContract.js";
import {
  staleOperationalCandidateAuditPredicate
} from "../src/memory/candidateSnapshotContract.js";
import {
  relationCleanupSnapshotCountSql,
  relationCleanupSnapshotValiditySql
} from "../src/memory/relationCleanupSnapshotContract.js";

export const AUDIT_ACTIVE_OUTBOX_STATUSES = Object.freeze(["pending", "queued", "failed"]);
export const AUDIT_NON_TERMINAL_RUN_STATUSES = Object.freeze(["running", "failed", "pending_review"]);
export const AUDIT_PENDING_CANDIDATE_STATUSES = Object.freeze([
  "pending",
  "needs_subject_review",
  "deferred_relation"
]);
export const ORIGINAL_DIARY_MEMORY_TYPES = Object.freeze([
  "diary",
  "layla_diary",
  "auto_diary"
]);

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlList(values) {
  return values.map(sqlString).join(", ");
}

function bindSqlPredicate(predicate) {
  let bindIndex = 0;
  const sql = predicate.sql.replaceAll("?", () => sqlString(predicate.binds[bindIndex++]));
  if (bindIndex !== predicate.binds.length) throw new Error("eligibility_predicate_bind_mismatch");
  return sql;
}

export function eligibleMemoryPredicate(alias) {
  return bindSqlPredicate(fiveAxisMemoryEligibilityPredicate(alias));
}

export function inactiveMemoryPredicate(alias) {
  return `NOT (${eligibleMemoryPredicate(alias)})`;
}

function historicalVectorNeedsUpsertStatePredicate(alias) {
  return `(
    ${eligibleMemoryPredicate(alias)}
    AND ${alias}.vector_sync_status = 'synced'
    AND ${alias}.vector_synced = 0
  )`;
}

function historicalVectorNeedsDeleteStatePredicate(alias) {
  return `(
    ${inactiveMemoryPredicate(alias)}
    AND (
      (
        ${alias}.vector_sync_status = 'synced'
        AND ${alias}.vector_synced IN (0, 1)
      )
      OR
      (
        (${alias}.vector_sync_status IS NULL OR TRIM(${alias}.vector_sync_status) = '')
        AND ${alias}.vector_synced = 1
      )
    )
  )`;
}

export function historicalVectorNeedsUpsertPredicate(alias) {
  return `(
    ${alias}.vector_id IS NOT NULL
    AND TRIM(${alias}.vector_id) != ''
    AND ${historicalVectorNeedsUpsertStatePredicate(alias)}
  )`;
}

export function historicalVectorNeedsDeletePredicate(alias) {
  return `(
    ${alias}.vector_id IS NOT NULL
    AND TRIM(${alias}.vector_id) != ''
    AND ${historicalVectorNeedsDeleteStatePredicate(alias)}
  )`;
}

export function historicalVectorRepairPredicate(alias) {
  return `(
    ${historicalVectorNeedsUpsertPredicate(alias)}
    OR ${historicalVectorNeedsDeletePredicate(alias)}
  )`;
}

export function historicalVectorMissingIdPredicate(alias) {
  return `(
    (${alias}.vector_id IS NULL OR TRIM(${alias}.vector_id) = '')
    AND (
      ${historicalVectorNeedsUpsertStatePredicate(alias)}
      OR ${historicalVectorNeedsDeleteStatePredicate(alias)}
    )
  )`;
}

export function nonScannerManagedVectorStatePredicate(alias) {
  return `(
    ${alias}.vector_synced != 0
    AND (
      ${alias}.vector_sync_status IN ('pending', 'failed')
      OR ${alias}.vector_sync_status IS NULL
      OR TRIM(${alias}.vector_sync_status) = ''
    )
  )`;
}

export function originalDiaryTypePredicate(alias) {
  return `LOWER(TRIM(${alias}.type)) IN (${sqlList(ORIGINAL_DIARY_MEMORY_TYPES)})`;
}

export function activeDiarySplitOriginPredicate(alias) {
  return bindSqlPredicate(activeDiarySplitSourcePredicate(alias));
}

function relationReasonPrefixPredicate(alias, prefixes) {
  return `(${prefixes.map((prefix) =>
    `SUBSTR(COALESCE(${alias}.reason, ''), 1, ${prefix.length}) = ${sqlString(prefix)}`
  ).join(" OR ")})`;
}

export function buildInactiveFiveAxisAuditQueries(input) {
  const namespace = sqlString(input.namespace);
  const staleHours = Math.min(Math.max(Math.floor(input.staleHours ?? 24), 1), 24 * 365);
  const inactive = (alias) => inactiveMemoryPredicate(alias);
  const staleRelation = `(
    ${inactive("source_memory")}
    OR ${inactive("target_memory")}
  )`;
  const deterministicRelation = relationReasonPrefixPredicate("relation", [
    "diary_day:",
    "diary_timeline:",
    "timeline_approved:"
  ]);
  const humanReviewedRelation = relationReasonPrefixPredicate("relation", [
    "y-review:approved:",
    "fact-group:approved:"
  ]);
  const builderBackedRelation = relationReasonPrefixPredicate("relation", [
    "y:auto:",
    "dream:auto:"
  ]);
  const apiWrittenRelation = relationReasonPrefixPredicate("relation", [
    "api:memory-write:"
  ]);
  const legacyBackfillRelation = relationReasonPrefixPredicate("relation", [
    "legacy-backfill:"
  ]);
  const provenRelation = `(
    ${deterministicRelation}
    OR ${humanReviewedRelation}
    OR ${builderBackedRelation}
    OR ${apiWrittenRelation}
    OR ${legacyBackfillRelation}
  )`;
  const unprovenRelation = `NOT (${provenRelation})`;
  const vectorNeedsUpsert = historicalVectorNeedsUpsertPredicate("memory");
  const vectorNeedsDelete = historicalVectorNeedsDeletePredicate("memory");
  const vectorRepair = historicalVectorRepairPredicate("memory");
  const nonScannerManagedVectorState = nonScannerManagedVectorStatePredicate("memory");
  const vectorDrift = `(
    ${vectorRepair}
    OR ${historicalVectorMissingIdPredicate("memory")}
    OR ${nonScannerManagedVectorState}
    OR (
      NOT (${inactive("memory")})
      AND memory.vector_sync_status = 'deleted'
    )
    OR (
      ${inactive("memory")}
      AND (
        memory.vector_sync_status = 'synced'
        OR memory.vector_synced != 0
      )
    )
    OR memory.vector_sync_status = 'failed'
    OR (
      memory.vector_synced = 0
      AND (
        memory.vector_sync_status = 'pending'
        OR memory.vector_sync_status IS NULL
        OR TRIM(memory.vector_sync_status) = ''
      )
      AND julianday(memory.updated_at) < julianday('now', '-${staleHours} hours')
    )
    OR (
      memory.vector_sync_status IS NOT NULL
      AND TRIM(memory.vector_sync_status) != ''
      AND memory.vector_sync_status NOT IN ('pending', 'failed', 'synced', 'deleted')
    )
  )`;
  const nonTerminalRun = `run.status IN (${sqlList(AUDIT_NON_TERMINAL_RUN_STATUSES)})`;
  const staleRun = "run.memory_revision < memory.five_axis_revision";
  const futureRun = "run.memory_revision > memory.five_axis_revision";
  const eligibleRunMemory = `NOT (${inactive("memory")})`;
  const candidateLinkedRun = `EXISTS (
    SELECT 1
    FROM memory_candidate_axis_runs AS link
    WHERE link.namespace = run.namespace
      AND link.memory_id = run.memory_id
      AND link.memory_revision = run.memory_revision
      AND link.axis = run.axis
  )`;
  const malformedOwnership = `(
    (
      run.status = 'running'
      AND (run.claim_token IS NULL OR run.lease_expires_at IS NULL)
    ) OR (
      run.status != 'running'
      AND (run.claim_token IS NOT NULL OR run.lease_expires_at IS NOT NULL)
    )
  )`;
  const staleFailedRepairable = `(
    ${staleRun}
    AND ${eligibleRunMemory}
    AND NOT (${candidateLinkedRun})
    AND run.status = 'failed'
    AND run.claim_token IS NULL
    AND run.lease_expires_at IS NULL
  )`;
  const staleExpiredRunningRepairable = `(
    ${staleRun}
    AND ${eligibleRunMemory}
    AND NOT (${candidateLinkedRun})
    AND run.status = 'running'
    AND run.claim_token IS NOT NULL
    AND run.lease_expires_at IS NOT NULL
    AND run.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )`;
  const staleActiveRunning = `(
    ${staleRun}
    AND run.status = 'running'
    AND run.claim_token IS NOT NULL
    AND run.lease_expires_at IS NOT NULL
    AND run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )`;
  const exhaustedFailedRun = `(
    run.status = 'failed'
    AND run.attempts >= 5
    AND run.claim_token IS NULL
    AND run.lease_expires_at IS NULL
    AND run.memory_revision = memory.five_axis_revision
    AND ${eligibleRunMemory}
  )`;
  const exhaustedTerminalRun = `(
    run.status = 'skipped'
    AND json_extract(run.result_json, '$.reason') = 'attempts_exhausted'
    AND run.memory_revision = memory.five_axis_revision
    AND ${eligibleRunMemory}
  )`;
  const exhaustedRun = `(${exhaustedFailedRun} OR ${exhaustedTerminalRun})`;
  const candidateLinkedStaleRun = `(
    ${nonTerminalRun}
    AND ${staleRun}
    AND ${candidateLinkedRun}
  )`;
  const staleOperationalCandidate = staleOperationalCandidateAuditPredicate("candidate");
  const relationCleanupSnapshotCount = relationCleanupSnapshotCountSql("candidate");
  const relationCleanupSnapshotValidity = relationCleanupSnapshotValiditySql(
    "snapshot",
    "candidate"
  );
  const candidateHasIneligibleDependency = `EXISTS (
    SELECT 1
    FROM memory_candidate_dependencies AS dependency
    JOIN memories AS memory
      ON memory.namespace = dependency.namespace
     AND memory.id = dependency.memory_id
    WHERE dependency.namespace = candidate.namespace
      AND dependency.candidate_external_key = candidate.external_key
      AND ${inactive("memory")}
  )`;
  const operationalCandidateOwnedRun = `EXISTS (
    SELECT 1
    FROM memory_candidate_axis_runs AS owned_link
    JOIN memory_candidates AS candidate
      ON candidate.namespace = owned_link.namespace
     AND candidate.external_key = owned_link.candidate_external_key
    WHERE owned_link.namespace = run.namespace
      AND owned_link.memory_id = run.memory_id
      AND owned_link.memory_revision = run.memory_revision
      AND owned_link.axis = run.axis
      AND candidate.status IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
      AND ${staleOperationalCandidate}
      AND NOT (${candidateHasIneligibleDependency})
  )`;
  const ineligibleNonTerminalRun = `(${nonTerminalRun} AND ${inactive("memory")})`;
  const futureRevisionRun = `(${nonTerminalRun} AND ${futureRun})`;
  const axisRunDrift = `(
    ${staleFailedRepairable}
    OR ${staleExpiredRunningRepairable}
    OR ${malformedOwnership}
    OR ${futureRevisionRun}
    OR (${candidateLinkedStaleRun} AND NOT (${operationalCandidateOwnedRun}))
    OR ${ineligibleNonTerminalRun}
    OR ${exhaustedRun}
  )`;
  const invalidActiveTimelineMembership = `(
    NOT (${inactive("memory")})
    AND (
      memory.source = 'timeline_split'
      OR memory.thread IS NULL
      OR TRIM(memory.thread) = ''
      OR memory.fact_key IS NULL
      OR TRIM(memory.fact_key) = ''
      OR membership.thread != memory.thread
      OR membership.fact_key != memory.fact_key
    )
  )`;
  const invalidActiveDiaryMembership = `(
    NOT (${inactive("member")})
    AND (
      member.source != 'timeline_split'
      OR member.type = 'timeline_day'
      OR membership.timeline_key != 'diary:kld'
    )
  )`;

  return [
    {
      name: "relations",
      driftFields: ["relation_rows"],
      sql: `SELECT
        COUNT(*) AS relation_rows,
        COALESCE(SUM(CASE
          WHEN ${inactive("source_memory")} AND ${inactive("target_memory")}
          THEN 1 ELSE 0 END
        ), 0) AS both_endpoints_ineligible,
        COALESCE(SUM(CASE
          WHEN ${inactive("source_memory")} AND NOT (${inactive("target_memory")})
          THEN 1 ELSE 0 END
        ), 0) AS source_only_ineligible,
        COALESCE(SUM(CASE
          WHEN NOT (${inactive("source_memory")}) AND ${inactive("target_memory")}
          THEN 1 ELSE 0 END
        ), 0) AS target_only_ineligible,
        (
          SELECT COUNT(*) FROM (
            SELECT relation.source_memory_id AS memory_id
            FROM memory_relations AS relation
            JOIN memories AS memory
              ON memory.namespace = relation.namespace
             AND memory.id = relation.source_memory_id
            WHERE relation.namespace = ${namespace} AND ${inactive("memory")}
            UNION
            SELECT relation.target_memory_id AS memory_id
            FROM memory_relations AS relation
            JOIN memories AS memory
              ON memory.namespace = relation.namespace
             AND memory.id = relation.target_memory_id
            WHERE relation.namespace = ${namespace} AND ${inactive("memory")}
          )
        ) AS distinct_memories
      FROM memory_relations AS relation
      JOIN memories AS source_memory
        ON source_memory.namespace = relation.namespace
       AND source_memory.id = relation.source_memory_id
      JOIN memories AS target_memory
        ON target_memory.namespace = relation.namespace
       AND target_memory.id = relation.target_memory_id
      WHERE relation.namespace = ${namespace}
        AND (${inactive("source_memory")} OR ${inactive("target_memory")})`
    },
    {
      name: "relation_provenance",
      driftFields: ["eligible_unproven_source"],
      sql: `SELECT
        COUNT(*) AS relation_rows,
        COALESCE(SUM(CASE WHEN ${deterministicRelation} THEN 1 ELSE 0 END), 0)
          AS deterministic_rebuildable,
        COALESCE(SUM(CASE WHEN ${humanReviewedRelation} THEN 1 ELSE 0 END), 0)
          AS human_reviewed,
        COALESCE(SUM(CASE WHEN ${builderBackedRelation} THEN 1 ELSE 0 END), 0)
          AS builder_backed,
        COALESCE(SUM(CASE WHEN ${apiWrittenRelation} THEN 1 ELSE 0 END), 0)
          AS api_written,
        COALESCE(SUM(CASE WHEN ${legacyBackfillRelation} THEN 1 ELSE 0 END), 0)
          AS legacy_backfill,
        COALESCE(SUM(CASE WHEN ${unprovenRelation} THEN 1 ELSE 0 END), 0)
          AS unproven_source,
        COALESCE(SUM(CASE WHEN ${staleRelation} THEN 1 ELSE 0 END), 0)
          AS stale_rows,
        COALESCE(SUM(CASE
          WHEN ${staleRelation} AND ${unprovenRelation} THEN 1 ELSE 0 END
        ), 0) AS stale_unproven_source,
        COALESCE(SUM(CASE
          WHEN NOT (${staleRelation}) AND ${unprovenRelation} THEN 1 ELSE 0 END
        ), 0) AS eligible_unproven_source
      FROM memory_relations AS relation
      JOIN memories AS source_memory
        ON source_memory.namespace = relation.namespace
       AND source_memory.id = relation.source_memory_id
      JOIN memories AS target_memory
        ON target_memory.namespace = relation.namespace
       AND target_memory.id = relation.target_memory_id
      WHERE relation.namespace = ${namespace}`
    },
    {
      name: "timeline",
      driftFields: ["membership_rows", "diary_drift_rows"],
      sql: `SELECT
        (
          SELECT COUNT(*)
          FROM memory_timeline_memberships AS membership
          JOIN memories AS memory
            ON memory.namespace = membership.namespace
           AND memory.id = membership.memory_id
          WHERE membership.namespace = ${namespace}
            AND (${inactive("memory")} OR ${invalidActiveTimelineMembership})
        ) AS membership_rows,
        (
          SELECT COUNT(*)
          FROM memory_timeline_memberships AS membership
          JOIN memories AS memory
            ON memory.namespace = membership.namespace
           AND memory.id = membership.memory_id
          WHERE membership.namespace = ${namespace}
            AND ${invalidActiveTimelineMembership}
        ) AS invalid_active_membership_rows,
        (
          SELECT COUNT(*)
          FROM memory_diary_timeline_memberships AS membership
          LEFT JOIN memories AS member
            ON member.namespace = membership.namespace
           AND member.id = membership.memory_id
          LEFT JOIN memories AS origin
            ON origin.namespace = membership.namespace
           AND origin.id = membership.origin_diary_id
          LEFT JOIN memories AS day
            ON day.namespace = membership.namespace
           AND day.id = membership.day_memory_id
          WHERE membership.namespace = ${namespace}
            AND member.id IS NOT NULL
            AND day.id IS NOT NULL
            AND origin.id IS NOT NULL
            AND (
              ${inactive("member")}
              OR ${inactive("day")}
              OR NOT (${activeDiarySplitOriginPredicate("origin")})
              OR ${invalidActiveDiaryMembership}
            )
        ) AS diary_drift_rows,
        (
          SELECT COUNT(*)
          FROM memory_diary_timeline_memberships AS membership
          JOIN memories AS member
            ON member.namespace = membership.namespace
           AND member.id = membership.memory_id
          WHERE membership.namespace = ${namespace}
            AND ${invalidActiveDiaryMembership}
        ) AS invalid_active_diary_membership_rows,
        (
          SELECT COUNT(*)
          FROM memory_diary_timeline_memberships AS membership
          LEFT JOIN memories AS member
            ON member.namespace = membership.namespace
           AND member.id = membership.memory_id
          WHERE membership.namespace = ${namespace}
            AND (member.id IS NULL OR ${inactive("member")})
        ) AS diary_member_drift_rows,
        (
          SELECT COUNT(*)
          FROM memory_diary_timeline_memberships AS membership
          LEFT JOIN memories AS day
            ON day.namespace = membership.namespace
           AND day.id = membership.day_memory_id
          WHERE membership.namespace = ${namespace}
            AND (day.id IS NULL OR ${inactive("day")})
        ) AS diary_day_drift_rows,
        (
          SELECT COUNT(*)
          FROM memory_diary_timeline_memberships AS membership
          LEFT JOIN memories AS origin
            ON origin.namespace = membership.namespace
           AND origin.id = membership.origin_diary_id
          WHERE membership.namespace = ${namespace}
            AND (origin.id IS NULL OR NOT (${activeDiarySplitOriginPredicate("origin")}))
        ) AS invalid_origin_diary_rows,
        (
          SELECT COUNT(*)
          FROM memory_diary_timeline_memberships AS membership
          JOIN memories AS member
            ON member.namespace = membership.namespace
           AND member.id = membership.memory_id
          JOIN memories AS origin
            ON origin.namespace = membership.namespace
           AND origin.id = membership.origin_diary_id
          JOIN memories AS day
            ON day.namespace = membership.namespace
           AND day.id = membership.day_memory_id
          WHERE membership.namespace = ${namespace}
            AND ${originalDiaryTypePredicate("origin")}
            AND NOT (${inactive("member")})
            AND NOT (${inactive("day")})
        ) AS origin_diary_provenance_rows`
    },
    {
      name: "outbox",
      driftFields: ["count"],
      sql: `SELECT outbox.status, COUNT(*) AS count, COUNT(DISTINCT outbox.memory_id) AS distinct_memories
      FROM memory_five_axis_outbox AS outbox
      JOIN memories AS memory
        ON memory.namespace = outbox.namespace
       AND memory.id = outbox.memory_id
      WHERE outbox.namespace = ${namespace}
        AND outbox.status IN (${sqlList(AUDIT_ACTIVE_OUTBOX_STATUSES)})
        AND ${inactive("memory")}
      GROUP BY outbox.status
      ORDER BY outbox.status`
    },
    {
      name: "axis_runs",
      driftFields: ["axis_run_drift_rows"],
      sql: `SELECT
        COALESCE(SUM(CASE
          WHEN ${axisRunDrift}
          THEN 1 ELSE 0 END
        ), 0) AS axis_run_drift_rows,
        COALESCE(SUM(CASE
          WHEN ${ineligibleNonTerminalRun}
          THEN 1 ELSE 0 END
        ), 0) AS ineligible_non_terminal,
        COALESCE(SUM(CASE
          WHEN ${staleActiveRunning}
          THEN 1 ELSE 0 END
        ), 0) AS stale_running_active_lease,
        COALESCE(SUM(CASE
          WHEN ${nonTerminalRun} AND ${staleRun}
          THEN 1 ELSE 0 END
        ), 0) AS stale_revision_runs,
        COALESCE(SUM(CASE
          WHEN ${staleFailedRepairable}
          THEN 1 ELSE 0 END
        ), 0) AS stale_failed_repairable,
        COALESCE(SUM(CASE
          WHEN ${staleExpiredRunningRepairable}
          THEN 1 ELSE 0 END
        ), 0) AS stale_running_expired_repairable,
        COALESCE(SUM(CASE
          WHEN ${futureRevisionRun}
          THEN 1 ELSE 0 END
        ), 0) AS future_revision_anomalies,
        COALESCE(SUM(CASE
          WHEN ${candidateLinkedStaleRun}
          THEN 1 ELSE 0 END
        ), 0) AS candidate_linked_stale_runs,
        COALESCE(SUM(CASE
          WHEN ${candidateLinkedStaleRun}
           AND ${operationalCandidateOwnedRun}
          THEN 1 ELSE 0 END
        ), 0) AS operational_candidate_owned_stale_runs,
        COALESCE(SUM(CASE
          WHEN ${malformedOwnership}
          THEN 1 ELSE 0 END
        ), 0) AS ownership_anomalies,
        COALESCE(SUM(CASE
          WHEN ${exhaustedRun}
          THEN 1 ELSE 0 END
        ), 0) AS exhausted_attempt_runs,
        COALESCE(SUM(CASE
          WHEN ${exhaustedFailedRun}
          THEN 1 ELSE 0 END
        ), 0) AS legacy_exhausted_failed_runs,
        COALESCE(SUM(CASE
          WHEN ${exhaustedTerminalRun}
          THEN 1 ELSE 0 END
        ), 0) AS terminal_exhausted_runs,
        COALESCE(SUM(CASE
          WHEN run.status = 'running' AND run.claim_token IS NULL
          THEN 1 ELSE 0 END
        ), 0) AS running_missing_claim_token,
        COALESCE(SUM(CASE
          WHEN run.status = 'running' AND run.lease_expires_at IS NULL
          THEN 1 ELSE 0 END
        ), 0) AS running_missing_lease,
        COALESCE(SUM(CASE
          WHEN run.status != 'running' AND run.claim_token IS NOT NULL
          THEN 1 ELSE 0 END
        ), 0) AS non_running_claim_token_residue,
        COALESCE(SUM(CASE
          WHEN run.status != 'running' AND run.lease_expires_at IS NOT NULL
          THEN 1 ELSE 0 END
        ), 0) AS non_running_lease_residue
      FROM memory_five_axis_runs AS run
      JOIN memories AS memory
        ON memory.namespace = run.namespace
       AND memory.id = run.memory_id
      WHERE run.namespace = ${namespace}`
    },
    {
      name: "candidate_dependencies",
      driftFields: ["count"],
      sql: `SELECT candidate.action, dependency.role, COUNT(*) AS count
      FROM memory_candidate_dependencies AS dependency
      JOIN memory_candidates AS candidate
        ON candidate.namespace = dependency.namespace
       AND candidate.external_key = dependency.candidate_external_key
      JOIN memories AS memory
        ON memory.namespace = dependency.namespace
       AND memory.id = dependency.memory_id
      WHERE dependency.namespace = ${namespace}
        AND candidate.status IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
        AND ${inactive("memory")}
      GROUP BY candidate.action, dependency.role
      ORDER BY candidate.action, dependency.role`
    },
    {
      name: "operational_candidates",
      driftFields: ["stale_operational_candidate_rows"],
      sql: `SELECT
        COALESCE(SUM(CASE
          WHEN ${staleOperationalCandidate}
          THEN 1 ELSE 0 END
        ), 0) AS stale_operational_candidate_rows,
        COALESCE(SUM(CASE
          WHEN candidate.action = 'y_relation_review'
           AND ${staleOperationalCandidate}
          THEN 1 ELSE 0 END
        ), 0) AS stale_y_relation_review_rows,
        COALESCE(SUM(CASE
          WHEN candidate.action = 'z_supersede'
           AND ${staleOperationalCandidate}
          THEN 1 ELSE 0 END
        ), 0) AS stale_z_supersede_rows,
        COALESCE(SUM(CASE
          WHEN candidate.action = 'm_archive'
           AND ${staleOperationalCandidate}
          THEN 1 ELSE 0 END
        ), 0) AS stale_m_archive_rows
      FROM memory_candidates AS candidate
      WHERE candidate.namespace = ${namespace}
        AND candidate.status IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
        AND NOT (${candidateHasIneligibleDependency})`
    },
    {
      name: "m_snapshot_contract",
      driftFields: [
        "missing_snapshot_candidates",
        "duplicate_snapshot_candidates",
        "malformed_snapshot_candidates"
      ],
      sql: `SELECT
        COALESCE(SUM(CASE
          WHEN ${relationCleanupSnapshotCount} = 0 THEN 1 ELSE 0 END
        ), 0) AS missing_snapshot_candidates,
        COALESCE(SUM(CASE
          WHEN ${relationCleanupSnapshotCount} > 1 THEN 1 ELSE 0 END
        ), 0) AS duplicate_snapshot_candidates,
        COALESCE(SUM(CASE
          WHEN ${relationCleanupSnapshotCount} = 1
           AND NOT EXISTS (
             SELECT 1
             FROM memory_events AS snapshot
             WHERE ${relationCleanupSnapshotValidity}
           )
          THEN 1 ELSE 0 END
        ), 0) AS malformed_snapshot_candidates
      FROM memory_candidates AS candidate
      WHERE candidate.namespace = ${namespace}
        AND candidate.action = 'm_relation_cleanup'
        AND candidate.status = 'approved'`
    },
    {
      name: "vector_state",
      driftFields: ["vector_drift_rows"],
      sql: `SELECT
        COALESCE(SUM(CASE WHEN ${vectorNeedsUpsert} THEN 1 ELSE 0 END), 0)
          AS needs_upsert,
        COALESCE(SUM(CASE WHEN ${vectorNeedsDelete} THEN 1 ELSE 0 END), 0)
          AS needs_delete,
        COALESCE(SUM(CASE WHEN ${vectorRepair} THEN 1 ELSE 0 END), 0)
          AS unique_vector_drift_memories,
        COALESCE(SUM(CASE WHEN ${vectorDrift} THEN 1 ELSE 0 END), 0)
          AS vector_drift_rows,
        COALESCE(SUM(CASE
          WHEN NOT (${inactive("memory")}) AND memory.vector_sync_status = 'deleted'
          THEN 1 ELSE 0 END
        ), 0) AS eligible_marked_deleted,
        COALESCE(SUM(CASE
          WHEN NOT (${inactive("memory")})
           AND memory.vector_synced = 0
           AND COALESCE(memory.vector_sync_status, '') NOT IN ('pending', 'failed')
          THEN 1 ELSE 0 END
        ), 0) AS eligible_invalid_unsynced_state,
        COALESCE(SUM(CASE
          WHEN ${inactive("memory")} AND memory.vector_sync_status = 'synced'
          THEN 1 ELSE 0 END
        ), 0) AS ineligible_marked_synced,
        COALESCE(SUM(CASE
          WHEN ${inactive("memory")} AND memory.vector_synced != 0
          THEN 1 ELSE 0 END
        ), 0) AS ineligible_vector_synced,
        COALESCE(SUM(CASE
          WHEN memory.vector_sync_status = 'failed'
          THEN 1 ELSE 0 END
        ), 0) AS failed_vector_states,
        COALESCE(SUM(CASE
          WHEN memory.vector_sync_status IN ('pending', 'failed')
           AND julianday(memory.updated_at) < julianday('now', '-${staleHours} hours')
          THEN 1 ELSE 0 END
        ), 0) AS stale_pending_or_failed,
        COALESCE(SUM(CASE
          WHEN memory.vector_synced = 0
           AND (
             memory.vector_sync_status IN ('pending', 'failed')
             OR memory.vector_sync_status IS NULL
             OR TRIM(memory.vector_sync_status) = ''
           )
          THEN 1 ELSE 0 END
        ), 0) AS scanner_managed_rows,
        COALESCE(SUM(CASE WHEN ${nonScannerManagedVectorState}
          THEN 1 ELSE 0 END), 0) AS non_scanner_managed_rows,
        COALESCE(SUM(CASE WHEN ${historicalVectorMissingIdPredicate("memory")}
          THEN 1 ELSE 0 END), 0) AS missing_vector_id_rows,
        COALESCE(SUM(CASE
          WHEN memory.vector_sync_status IS NOT NULL
           AND TRIM(memory.vector_sync_status) != ''
           AND memory.vector_sync_status NOT IN ('pending', 'failed', 'synced', 'deleted')
          THEN 1 ELSE 0 END
        ), 0) AS unknown_status_rows
      FROM memories AS memory
      WHERE memory.namespace = ${namespace}`
    },
    {
      name: "deprojection_operations",
      driftFields: [
        "unfinished",
        "invalid_completed",
        "revision_anomalies",
        "duplicate_successes"
      ],
      sql: `SELECT
        COALESCE(SUM(CASE WHEN operation.completed_at IS NULL THEN 1 ELSE 0 END), 0) AS unfinished,
        COALESCE(SUM(CASE
          WHEN operation.completed_at IS NOT NULL AND operation.invariants_verified != 1
          THEN 1 ELSE 0 END
        ), 0) AS invalid_completed,
        COALESCE(SUM(CASE
          WHEN operation.current_revision > memory.five_axis_revision
            OR (
              operation.current_revision = memory.five_axis_revision
              AND NOT (${inactive("memory")})
            )
          THEN 1 ELSE 0 END
        ), 0) AS revision_anomalies,
        COALESCE((
          SELECT COUNT(*) FROM (
            SELECT namespace, memory_id, current_revision
            FROM memory_deprojections
            WHERE namespace = ${namespace}
              AND completed_at IS NOT NULL
              AND invariants_verified = 1
            GROUP BY namespace, memory_id, current_revision
            HAVING COUNT(*) > 1
          )
        ), 0) AS duplicate_successes
      FROM memory_deprojections AS operation
      JOIN memories AS memory
        ON memory.namespace = operation.namespace
       AND memory.id = operation.memory_id
      WHERE operation.namespace = ${namespace}`
    },
    {
      name: "retention_orphans",
      driftFields: ["actionable_rows"],
      sql: `WITH candidate_dependency_orphans AS (
        SELECT
          dependency.candidate_external_key,
          candidate.status AS candidate_status,
          CASE WHEN candidate.id IS NULL THEN 1 ELSE 0 END AS candidate_missing,
          CASE WHEN memory.id IS NULL THEN 1 ELSE 0 END AS memory_missing
        FROM memory_candidate_dependencies AS dependency
        LEFT JOIN memory_candidates AS candidate
          ON candidate.namespace = dependency.namespace
         AND candidate.external_key = dependency.candidate_external_key
        LEFT JOIN memories AS memory
          ON memory.namespace = dependency.namespace
         AND memory.id = dependency.memory_id
        WHERE dependency.namespace = ${namespace}
          AND (candidate.id IS NULL OR memory.id IS NULL)
      ),
      candidate_direct_orphans AS (
        SELECT candidate.external_key, candidate.status AS candidate_status
        FROM memory_candidates AS candidate
        WHERE candidate.namespace = ${namespace}
          AND (
            (
              candidate.target_id IS NOT NULL
              AND TRIM(candidate.target_id) != ''
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = candidate.namespace
                  AND memory.id = candidate.target_id
              )
            )
            OR (
              candidate.result_memory_id IS NOT NULL
              AND TRIM(candidate.result_memory_id) != ''
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = candidate.namespace
                  AND memory.id = candidate.result_memory_id
              )
            )
          )
      ),
      orphan_candidates AS (
        SELECT candidate_external_key AS external_key, candidate_status
        FROM candidate_dependency_orphans
        WHERE candidate_missing = 0 AND memory_missing = 1
        UNION
        SELECT external_key, candidate_status
        FROM candidate_direct_orphans
      ),
      orphan_counts AS (
        SELECT
          (
            SELECT COUNT(*)
            FROM memory_relations AS relation
            WHERE relation.namespace = ${namespace}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM memories AS memory
                  WHERE memory.namespace = relation.namespace
                    AND memory.id = relation.source_memory_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM memories AS memory
                  WHERE memory.namespace = relation.namespace
                    AND memory.id = relation.target_memory_id
                )
              )
          ) AS orphan_relations,
          (
            SELECT COUNT(*)
            FROM memory_timeline_memberships AS membership
            WHERE membership.namespace = ${namespace}
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = membership.namespace
                  AND memory.id = membership.memory_id
              )
          ) AS orphan_timeline_memberships,
          (
            SELECT COUNT(*)
            FROM memory_diary_timeline_memberships AS membership
            WHERE membership.namespace = ${namespace}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM memories AS memory
                  WHERE memory.namespace = membership.namespace
                    AND memory.id = membership.memory_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM memories AS memory
                  WHERE memory.namespace = membership.namespace
                    AND memory.id = membership.origin_diary_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM memories AS memory
                  WHERE memory.namespace = membership.namespace
                    AND memory.id = membership.day_memory_id
                )
              )
          ) AS orphan_diary_timeline_memberships,
          (
            SELECT COUNT(*)
            FROM memory_five_axis_outbox AS outbox
            WHERE outbox.namespace = ${namespace}
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = outbox.namespace
                  AND memory.id = outbox.memory_id
              )
          ) AS orphan_outbox_rows,
          (
            SELECT COUNT(*)
            FROM memory_five_axis_runs AS run
            WHERE run.namespace = ${namespace}
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = run.namespace
                  AND memory.id = run.memory_id
              )
          ) AS orphan_axis_runs,
          (
            SELECT COUNT(*)
            FROM memory_candidate_axis_runs AS link
            WHERE link.namespace = ${namespace}
              AND (
                NOT EXISTS (
                  SELECT 1 FROM memories AS memory
                  WHERE memory.namespace = link.namespace
                    AND memory.id = link.memory_id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM memory_five_axis_runs AS run
                  WHERE run.namespace = link.namespace
                    AND run.memory_id = link.memory_id
                    AND run.memory_revision = link.memory_revision
                    AND run.axis = link.axis
                )
                OR NOT EXISTS (
                  SELECT 1 FROM memory_candidates AS candidate
                  WHERE candidate.namespace = link.namespace
                    AND candidate.external_key = link.candidate_external_key
                )
              )
          ) AS orphan_candidate_axis_run_links,
          (
            SELECT COUNT(*)
            FROM candidate_dependency_orphans
            WHERE candidate_missing = 1
               OR candidate_status IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
          ) AS actionable_candidate_dependency_rows,
          (
            SELECT COUNT(*)
            FROM candidate_dependency_orphans
            WHERE candidate_missing = 0
              AND memory_missing = 1
              AND candidate_status NOT IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
          ) AS historical_candidate_dependency_rows,
          (
            SELECT COUNT(*)
            FROM candidate_direct_orphans
            WHERE candidate_status IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
          ) AS actionable_candidate_rows,
          (
            SELECT COUNT(*)
            FROM candidate_direct_orphans
            WHERE candidate_status NOT IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
          ) AS historical_candidate_rows,
          (
            SELECT COUNT(*)
            FROM orphan_candidates
            WHERE candidate_status IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
          ) AS distinct_actionable_candidates,
          (
            SELECT COUNT(*)
            FROM orphan_candidates
            WHERE candidate_status NOT IN (${sqlList(AUDIT_PENDING_CANDIDATE_STATUSES)})
          ) AS distinct_historical_candidates,
          (
            SELECT COUNT(*)
            FROM memory_metabolism_signal_state AS signal
            WHERE signal.namespace = ${namespace}
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = signal.namespace
                  AND memory.id = signal.memory_id
              )
          ) AS orphan_metabolism_signal_states,
          (
            SELECT COUNT(*)
            FROM memory_recall_daily AS daily
            WHERE daily.namespace = ${namespace}
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = daily.namespace
                  AND memory.id = daily.memory_id
              )
          ) AS orphan_recall_daily_rows,
          (
            SELECT COUNT(*)
            FROM memory_recall_receipts AS receipt
            WHERE receipt.namespace = ${namespace}
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = receipt.namespace
                  AND memory.id = receipt.memory_id
              )
          ) AS orphan_recall_receipts,
          (
            SELECT COUNT(*)
            FROM memory_events AS event
            WHERE event.namespace = ${namespace}
              AND event.memory_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = event.namespace
                  AND memory.id = event.memory_id
              )
          ) AS historical_memory_event_rows,
          (
            SELECT COUNT(*)
            FROM memory_deprojections AS operation
            WHERE operation.namespace = ${namespace}
              AND (
                operation.completed_at IS NULL
                OR operation.invariants_verified != 1
              )
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = operation.namespace
                  AND memory.id = operation.memory_id
              )
          ) AS actionable_deprojection_rows,
          (
            SELECT COUNT(*)
            FROM memory_deprojections AS operation
            WHERE operation.namespace = ${namespace}
              AND operation.completed_at IS NOT NULL
              AND operation.invariants_verified = 1
              AND NOT EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = operation.namespace
                  AND memory.id = operation.memory_id
              )
          ) AS historical_deprojection_rows
      )
      SELECT *,
        orphan_relations
        + orphan_timeline_memberships
        + orphan_diary_timeline_memberships
        + orphan_outbox_rows
        + orphan_axis_runs
        + orphan_candidate_axis_run_links
        + actionable_candidate_dependency_rows
        + actionable_candidate_rows
        + orphan_metabolism_signal_states
        + orphan_recall_daily_rows
        + orphan_recall_receipts
        + actionable_deprojection_rows
          AS actionable_rows,
        historical_candidate_dependency_rows
        + historical_candidate_rows
        + historical_memory_event_rows
        + historical_deprojection_rows
          AS historical_rows
      FROM orphan_counts`
    }
  ];
}

export function assertReadOnlyAuditQueries(queries) {
  const writePattern = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|ATTACH|DETACH)\b/i;
  for (const query of queries) {
    const sql = query.sql.trim();
    if (!/^(?:SELECT|WITH)\b/i.test(sql)) throw new Error(`audit_query_not_select:${query.name}`);
    if (writePattern.test(sql)) throw new Error(`audit_query_contains_write:${query.name}`);
  }
}

function numberValue(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildInactiveFiveAxisAuditReport(input) {
  const sections = {};
  let driftCount = 0;
  for (const query of input.queries) {
    const rows = input.rowsByName[query.name] ?? [];
    sections[query.name] = rows;
    for (const row of rows) {
      for (const field of query.driftFields) driftCount += numberValue(row[field]);
    }
  }
  return {
    schema_version: 1,
    mode: "read_only",
    namespace: input.namespace,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    clean: driftCount === 0,
    drift_count: driftCount,
    sections
  };
}
