import {
  historicalVectorNeedsDeletePredicate,
  historicalVectorNeedsUpsertPredicate,
  historicalVectorMissingIdPredicate,
  historicalVectorRepairPredicate,
  sqlString
} from "./inactive-five-axis-audit.mjs";

export const MAX_VECTOR_REPAIR_LIMIT = 500;

function boundedLimit(value) {
  return Math.min(Math.max(Math.floor(value), 1), MAX_VECTOR_REPAIR_LIMIT);
}

function historicalVectorRepairSelection(namespace) {
  return `FROM memories AS memory
    WHERE memory.namespace = ${namespace}
      AND ${historicalVectorRepairPredicate("memory")}`;
}

export function buildVectorRepairDryRunQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = boundedLimit(input.limit);
  const selection = historicalVectorRepairSelection(namespace);
  return {
    name: "inactive-vector-state",
    sql: `SELECT
      COUNT(*) AS repairable_rows,
      COALESCE(SUM(CASE
        WHEN ${historicalVectorNeedsUpsertPredicate("memory")}
        THEN 1 ELSE 0 END
      ), 0) AS needs_upsert_rows,
      COALESCE(SUM(CASE
        WHEN ${historicalVectorNeedsDeletePredicate("memory")}
        THEN 1 ELSE 0 END
      ), 0) AS needs_delete_rows,
      MIN(COUNT(*), ${limit}) AS selected,
      CASE WHEN COUNT(*) > ${limit} THEN 1 ELSE 0 END AS has_more,
      (
        SELECT COUNT(*)
        FROM memories AS missing_memory
        WHERE missing_memory.namespace = ${namespace}
          AND ${historicalVectorMissingIdPredicate("missing_memory")}
      ) AS missing_vector_id_rows
    ${selection}`
  };
}

export function buildVectorRepairApplyQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = boundedLimit(input.limit);
  const selection = historicalVectorRepairSelection(namespace);
  return {
    name: "inactive-vector-state",
    sql: `WITH selected AS (
      SELECT memory.rowid
      ${selection}
      ORDER BY memory.id
      LIMIT ${limit}
    )
    UPDATE memories
    SET vector_sync_status = 'pending',
        vector_synced = 0,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE rowid IN (SELECT rowid FROM selected)
    RETURNING id, five_axis_revision`
  };
}

export function assertReadOnlyVectorRepairQuery(query) {
  const sql = query.sql.trim();
  if (!/^(?:SELECT|WITH)\b/i.test(sql)) {
    throw new Error(`vector_repair_dry_run_not_select:${query.name}`);
  }
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(sql)) {
    throw new Error(`vector_repair_dry_run_contains_write:${query.name}`);
  }
}
