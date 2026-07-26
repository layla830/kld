import {
  inactiveMemoryPredicate,
  sqlString
} from "./inactive-five-axis-audit.mjs";

export const MAX_REPAIR_LIMIT = 500;
export const INACTIVE_FIVE_AXIS_REPAIR_COHORTS = Object.freeze([
  "relations",
  "stale-axis-runs"
]);

function approvedCandidateRelationPredicate(alias) {
  return `EXISTS (
    SELECT 1
    FROM memory_candidates AS candidate
    WHERE candidate.namespace = ${alias}.namespace
      AND candidate.action = 'y_relation_review'
      AND candidate.result_memory_id = ${alias}.id
  )`;
}

function inactiveRelationSelection(namespace) {
  const inactiveSource = inactiveMemoryPredicate("source_memory");
  const inactiveTarget = inactiveMemoryPredicate("target_memory");
  return `FROM memory_relations AS relation
    JOIN memories AS source_memory
      ON source_memory.namespace = relation.namespace
     AND source_memory.id = relation.source_memory_id
    JOIN memories AS target_memory
      ON target_memory.namespace = relation.namespace
     AND target_memory.id = relation.target_memory_id
    WHERE relation.namespace = ${namespace}
      AND (${inactiveSource} OR ${inactiveTarget})`;
}

function staleAxisRunSelection(namespace) {
  const inactiveMemory = inactiveMemoryPredicate("memory");
  return `FROM memory_five_axis_runs AS run
    JOIN memories AS memory
      ON memory.namespace = run.namespace
     AND memory.id = run.memory_id
    WHERE run.namespace = ${namespace}
      AND run.axis = 'Y'
      AND run.memory_revision < memory.five_axis_revision
      AND NOT (${inactiveMemory})
      AND NOT EXISTS (
        SELECT 1
        FROM memory_candidate_axis_runs AS link
        WHERE link.namespace = run.namespace
          AND link.memory_id = run.memory_id
          AND link.memory_revision = run.memory_revision
          AND link.axis = run.axis
      )
      AND (
        (
          run.status = 'failed'
          AND run.claim_token IS NULL
          AND run.lease_expires_at IS NULL
        )
        OR (
          run.status = 'running'
          AND (
            run.lease_expires_at IS NULL
            OR run.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
        )
      )`;
}

export function buildRepairDryRunQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), MAX_REPAIR_LIMIT);
  if (input.cohort === "relations") {
    const selection = inactiveRelationSelection(namespace);
    const inactiveSource = inactiveMemoryPredicate("source_memory");
    const inactiveTarget = inactiveMemoryPredicate("target_memory");
    const candidateLinked = approvedCandidateRelationPredicate("relation");
    return {
      name: "relations",
      sql: `SELECT
        COUNT(*) AS relation_rows,
        COALESCE(SUM(CASE
          WHEN ${inactiveSource} AND ${inactiveTarget}
          THEN 1 ELSE 0 END
        ), 0) AS both_endpoints_ineligible,
        COALESCE(SUM(CASE
          WHEN ${inactiveSource} AND NOT (${inactiveTarget})
          THEN 1 ELSE 0 END
        ), 0) AS source_only_ineligible,
        COALESCE(SUM(CASE
          WHEN NOT (${inactiveSource}) AND ${inactiveTarget}
          THEN 1 ELSE 0 END
        ), 0) AS target_only_ineligible,
        COALESCE(SUM(CASE WHEN ${candidateLinked} THEN 1 ELSE 0 END), 0) AS candidate_linked_rows,
        COALESCE(SUM(CASE WHEN NOT (${candidateLinked}) THEN 1 ELSE 0 END), 0) AS repairable_rows,
        MIN(COALESCE(SUM(CASE WHEN NOT (${candidateLinked}) THEN 1 ELSE 0 END), 0), ${limit}) AS selected,
        CASE
          WHEN COALESCE(SUM(CASE WHEN NOT (${candidateLinked}) THEN 1 ELSE 0 END), 0) > ${limit}
          THEN 1 ELSE 0 END
        AS has_more
      ${selection}`
    };
  }
  if (input.cohort === "stale-axis-runs") {
    const selection = staleAxisRunSelection(namespace);
    return {
      name: "stale-axis-runs",
      sql: `SELECT
        COUNT(*) AS repairable_rows,
        COALESCE(SUM(CASE WHEN run.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_rows,
        COALESCE(SUM(CASE WHEN run.status = 'running' THEN 1 ELSE 0 END), 0) AS expired_running_rows,
        MIN(COUNT(*), ${limit}) AS selected,
        CASE WHEN COUNT(*) > ${limit} THEN 1 ELSE 0 END AS has_more
      ${selection}`
    };
  }
  throw new Error(`unsupported repair cohort: ${input.cohort}`);
}

export function buildRepairApplyQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), MAX_REPAIR_LIMIT);
  if (input.cohort === "relations") {
    const selection = inactiveRelationSelection(namespace);
    const candidateLinked = approvedCandidateRelationPredicate("relation");
    return {
      name: "relations",
      sql: `WITH selected AS (
        SELECT relation.rowid
        ${selection}
          AND NOT (${candidateLinked})
        ORDER BY relation.id
        LIMIT ${limit}
      )
      DELETE FROM memory_relations
      WHERE rowid IN (SELECT rowid FROM selected)
      RETURNING id`
    };
  }
  if (input.cohort === "stale-axis-runs") {
    const selection = staleAxisRunSelection(namespace);
    return {
      name: "stale-axis-runs",
      sql: `WITH selected AS (
        SELECT run.rowid
        ${selection}
        ORDER BY run.memory_id, run.memory_revision, run.axis
        LIMIT ${limit}
      )
      UPDATE memory_five_axis_runs
      SET status = 'skipped',
          result_json = json_object(
            'reason', 'superseded_by_newer_memory_revision',
            'previous_revision', memory_revision,
            'current_revision', (
              SELECT memory.five_axis_revision
              FROM memories AS memory
              WHERE memory.namespace = memory_five_axis_runs.namespace
                AND memory.id = memory_five_axis_runs.memory_id
            )
          ),
          last_error = NULL,
          claim_token = NULL,
          lease_expires_at = NULL,
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE rowid IN (SELECT rowid FROM selected)
      RETURNING memory_id, memory_revision, axis`
    };
  }
  throw new Error(`unsupported repair cohort: ${input.cohort}`);
}

export function assertReadOnlyRepairQuery(query) {
  const sql = query.sql.trim();
  if (!/^(?:SELECT|WITH)\b/i.test(sql)) throw new Error(`repair_dry_run_not_select:${query.name}`);
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(sql)) {
    throw new Error(`repair_dry_run_contains_write:${query.name}`);
  }
}
