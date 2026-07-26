import {
  inactiveMemoryPredicate,
  sqlString
} from "./inactive-five-axis-audit.mjs";

export const MAX_REPAIR_LIMIT = 500;

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
        OR
        (
          run.status = 'running'
          AND run.claim_token IS NOT NULL
          AND run.lease_expires_at IS NOT NULL
          AND run.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
      )`;
}

export function buildRepairDryRunQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), MAX_REPAIR_LIMIT);
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

export function buildRepairApplyQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), MAX_REPAIR_LIMIT);
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

export function assertReadOnlyRepairQuery(query) {
  const sql = query.sql.trim();
  if (!/^(?:SELECT|WITH)\b/i.test(sql)) throw new Error(`repair_dry_run_not_select:${query.name}`);
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(sql)) {
    throw new Error(`repair_dry_run_contains_write:${query.name}`);
  }
}
