import { EXCLUDED_FIVE_AXIS_MEMORY_TYPES } from "../src/memory/fiveAxis/eligibilityContract.js";

export const AUDIT_ACTIVE_OUTBOX_STATUSES = Object.freeze(["pending", "queued", "failed"]);
export const AUDIT_NON_TERMINAL_RUN_STATUSES = Object.freeze(["running", "failed", "pending_review"]);
export const AUDIT_PENDING_CANDIDATE_STATUSES = Object.freeze([
  "pending",
  "needs_subject_review",
  "deferred_relation"
]);

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlList(values) {
  return values.map(sqlString).join(", ");
}

export function inactiveMemoryPredicate(alias) {
  return `NOT (
    ${alias}.status = 'active'
    AND ${alias}.active_fact != 0
    AND LOWER(TRIM(${alias}.type)) NOT IN (${sqlList(EXCLUDED_FIVE_AXIS_MEMORY_TYPES)})
  )`;
}

export function buildInactiveFiveAxisAuditQueries(input) {
  const namespace = sqlString(input.namespace);
  const staleHours = Math.min(Math.max(Math.floor(input.staleHours ?? 24), 1), 24 * 365);
  const inactive = (alias) => inactiveMemoryPredicate(alias);

  return [
    {
      name: "relations",
      driftFields: ["relations_as_source", "relations_as_target", "distinct_memories"],
      sql: `SELECT
        SUM(CASE WHEN ${inactive("source_memory")} THEN 1 ELSE 0 END) AS relations_as_source,
        SUM(CASE WHEN ${inactive("target_memory")} THEN 1 ELSE 0 END) AS relations_as_target,
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
      name: "timeline",
      driftFields: ["membership_rows", "diary_membership_rows", "distinct_memories"],
      sql: `SELECT
        (
          SELECT COUNT(*)
          FROM memory_timeline_memberships AS membership
          JOIN memories AS memory
            ON memory.namespace = membership.namespace
           AND memory.id = membership.memory_id
          WHERE membership.namespace = ${namespace} AND ${inactive("memory")}
        ) AS membership_rows,
        (
          SELECT COUNT(*)
          FROM memory_diary_timeline_memberships AS membership
          WHERE membership.namespace = ${namespace}
            AND (
              EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = membership.namespace
                  AND memory.id = membership.memory_id
                  AND ${inactive("memory")}
              )
              OR EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = membership.namespace
                  AND memory.id = membership.origin_diary_id
                  AND ${inactive("memory")}
              )
              OR EXISTS (
                SELECT 1 FROM memories AS memory
                WHERE memory.namespace = membership.namespace
                  AND memory.id = membership.day_memory_id
                  AND ${inactive("memory")}
              )
            )
        ) AS diary_membership_rows,
        (
          SELECT COUNT(*) FROM (
            SELECT membership.memory_id
            FROM memory_timeline_memberships AS membership
            JOIN memories AS memory
              ON memory.namespace = membership.namespace
             AND memory.id = membership.memory_id
            WHERE membership.namespace = ${namespace} AND ${inactive("memory")}
            UNION
            SELECT membership.memory_id
            FROM memory_diary_timeline_memberships AS membership
            JOIN memories AS memory
              ON memory.namespace = membership.namespace
             AND memory.id = membership.memory_id
            WHERE membership.namespace = ${namespace} AND ${inactive("memory")}
            UNION
            SELECT membership.origin_diary_id
            FROM memory_diary_timeline_memberships AS membership
            JOIN memories AS memory
              ON memory.namespace = membership.namespace
             AND memory.id = membership.origin_diary_id
            WHERE membership.namespace = ${namespace} AND ${inactive("memory")}
            UNION
            SELECT membership.day_memory_id
            FROM memory_diary_timeline_memberships AS membership
            JOIN memories AS memory
              ON memory.namespace = membership.namespace
             AND memory.id = membership.day_memory_id
            WHERE membership.namespace = ${namespace} AND ${inactive("memory")}
          )
        ) AS distinct_memories`
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
      driftFields: ["ineligible_non_terminal", "active_leases", "revision_mismatches"],
      sql: `SELECT
        SUM(CASE
          WHEN run.status IN (${sqlList(AUDIT_NON_TERMINAL_RUN_STATUSES)})
           AND ${inactive("memory")}
          THEN 1 ELSE 0 END
        ) AS ineligible_non_terminal,
        SUM(CASE
          WHEN (run.claim_token IS NOT NULL OR run.lease_expires_at IS NOT NULL)
           AND ${inactive("memory")}
          THEN 1 ELSE 0 END
        ) AS active_leases,
        SUM(CASE
          WHEN run.status IN (${sqlList(AUDIT_NON_TERMINAL_RUN_STATUSES)})
           AND run.memory_revision != memory.five_axis_revision
          THEN 1 ELSE 0 END
        ) AS revision_mismatches
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
      name: "vector_state",
      driftFields: [
        "eligible_marked_deleted",
        "eligible_invalid_unsynced_state",
        "ineligible_marked_synced",
        "ineligible_vector_synced",
        "stale_pending_or_failed"
      ],
      sql: `SELECT
        SUM(CASE
          WHEN NOT (${inactive("memory")}) AND memory.vector_sync_status = 'deleted'
          THEN 1 ELSE 0 END
        ) AS eligible_marked_deleted,
        SUM(CASE
          WHEN NOT (${inactive("memory")})
           AND memory.vector_synced = 0
           AND COALESCE(memory.vector_sync_status, '') NOT IN ('pending', 'failed')
          THEN 1 ELSE 0 END
        ) AS eligible_invalid_unsynced_state,
        SUM(CASE
          WHEN ${inactive("memory")} AND memory.vector_sync_status = 'synced'
          THEN 1 ELSE 0 END
        ) AS ineligible_marked_synced,
        SUM(CASE
          WHEN ${inactive("memory")} AND memory.vector_synced != 0
          THEN 1 ELSE 0 END
        ) AS ineligible_vector_synced,
        SUM(CASE
          WHEN memory.vector_sync_status IN ('pending', 'failed')
           AND julianday(memory.updated_at) < julianday('now', '-${staleHours} hours')
          THEN 1 ELSE 0 END
        ) AS stale_pending_or_failed
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
        SUM(CASE WHEN operation.completed_at IS NULL THEN 1 ELSE 0 END) AS unfinished,
        SUM(CASE
          WHEN operation.completed_at IS NOT NULL AND operation.invariants_verified != 1
          THEN 1 ELSE 0 END
        ) AS invalid_completed,
        SUM(CASE
          WHEN operation.current_revision > memory.five_axis_revision
            OR (
              operation.current_revision = memory.five_axis_revision
              AND NOT (${inactive("memory")})
            )
          THEN 1 ELSE 0 END
        ) AS revision_anomalies,
        (
          SELECT COUNT(*) FROM (
            SELECT namespace, memory_id, current_revision
            FROM memory_deprojections
            WHERE namespace = ${namespace}
              AND completed_at IS NOT NULL
              AND invariants_verified = 1
            GROUP BY namespace, memory_id, current_revision
            HAVING COUNT(*) > 1
          )
        ) AS duplicate_successes
      FROM memory_deprojections AS operation
      JOIN memories AS memory
        ON memory.namespace = operation.namespace
       AND memory.id = operation.memory_id
      WHERE operation.namespace = ${namespace}`
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
