import { sqlString } from "./inactive-five-axis-audit.mjs";

export const MAX_LEGACY_RELATION_SNAPSHOT_REPAIR_LIMIT = 100;
export const FIRST_FLAGGED_RELATION_SNAPSHOT_AT = "2026-07-20T09:38:40.150Z";

function boundedLimit(value) {
  return Math.min(
    Math.max(Math.floor(value), 1),
    MAX_LEGACY_RELATION_SNAPSHOT_REPAIR_LIMIT
  );
}

function keyedSnapshotCount(candidateAlias) {
  return `(SELECT COUNT(*)
    FROM memory_events AS keyed_snapshot
    WHERE keyed_snapshot.namespace = ${candidateAlias}.namespace
      AND keyed_snapshot.event_type = 'm_snapshot'
      AND json_extract(keyed_snapshot.payload_json, '$.candidate_id') = ${candidateAlias}.id
      AND json_extract(keyed_snapshot.payload_json, '$.action') = 'm_relation_cleanup')`;
}

function legacyMissingFlagSelection(namespace) {
  return `FROM memory_events AS snapshot
    JOIN memory_candidates AS candidate
      ON candidate.namespace = snapshot.namespace
     AND candidate.id = json_extract(snapshot.payload_json, '$.candidate_id')
    WHERE snapshot.namespace = ${namespace}
      AND snapshot.event_type = 'm_snapshot'
      AND json_extract(snapshot.payload_json, '$.action') = 'm_relation_cleanup'
      AND candidate.action = 'm_relation_cleanup'
      AND candidate.status = 'approved'
      AND json_type(snapshot.payload_json, '$.relation_was_present') IS NULL`;
}

function repairableLegacySnapshotPredicate() {
  return `snapshot.created_at < '${FIRST_FLAGGED_RELATION_SNAPSHOT_AT}'
    AND json_type(snapshot.payload_json, '$.before') = 'object'
    AND json_extract(snapshot.payload_json, '$.before.strength') IS NOT NULL
    AND json_extract(snapshot.payload_json, '$.before.created_at') IS NOT NULL
    AND json_extract(snapshot.payload_json, '$.before.id')
      = json_extract(candidate.payload_json, '$.before.id')
    AND json_extract(snapshot.payload_json, '$.before.source_memory_id')
      = json_extract(candidate.payload_json, '$.before.source_memory_id')
    AND json_extract(snapshot.payload_json, '$.before.target_memory_id')
      = json_extract(candidate.payload_json, '$.before.target_memory_id')
    AND json_extract(snapshot.payload_json, '$.before.relation_type')
      = json_extract(candidate.payload_json, '$.before.relation_type')
    AND candidate.result_memory_id IS NULL
    AND ${keyedSnapshotCount("candidate")} = 1
    AND NOT EXISTS (
      SELECT 1
      FROM memory_relations AS current_relation
      WHERE current_relation.namespace = snapshot.namespace
        AND current_relation.id = json_extract(snapshot.payload_json, '$.before.id')
    )`;
}

export function buildLegacyRelationSnapshotDryRunQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = boundedLimit(input.limit);
  const selection = legacyMissingFlagSelection(namespace);
  const repairable = repairableLegacySnapshotPredicate();
  return {
    name: "legacy-relation-snapshots",
    sql: `WITH legacy_missing_flag AS (
      SELECT
        snapshot.rowid AS snapshot_rowid,
        snapshot.id AS snapshot_id,
        snapshot.created_at,
        CASE WHEN ${repairable} THEN 1 ELSE 0 END AS repairable,
        CASE WHEN ${keyedSnapshotCount("candidate")} != 1 THEN 1 ELSE 0 END AS non_unique,
        CASE WHEN snapshot.created_at >= '${FIRST_FLAGGED_RELATION_SNAPSHOT_AT}'
          THEN 1 ELSE 0 END AS outside_legacy_window,
        CASE WHEN (
          json_type(snapshot.payload_json, '$.before') = 'object'
          AND json_extract(snapshot.payload_json, '$.before.strength') IS NOT NULL
          AND json_extract(snapshot.payload_json, '$.before.created_at') IS NOT NULL
          AND json_extract(snapshot.payload_json, '$.before.id')
            = json_extract(candidate.payload_json, '$.before.id')
          AND json_extract(snapshot.payload_json, '$.before.source_memory_id')
            = json_extract(candidate.payload_json, '$.before.source_memory_id')
          AND json_extract(snapshot.payload_json, '$.before.target_memory_id')
            = json_extract(candidate.payload_json, '$.before.target_memory_id')
          AND json_extract(snapshot.payload_json, '$.before.relation_type')
            = json_extract(candidate.payload_json, '$.before.relation_type')
        ) THEN 0 ELSE 1 END AS identity_or_shape_mismatch,
        CASE WHEN candidate.result_memory_id IS NOT NULL
          THEN 1 ELSE 0 END AS unexpected_result_memory_id,
        CASE WHEN EXISTS (
          SELECT 1
          FROM memory_relations AS current_relation
          WHERE current_relation.namespace = snapshot.namespace
            AND current_relation.id = json_extract(snapshot.payload_json, '$.before.id')
        ) THEN 1 ELSE 0 END AS current_relation_conflict
      ${selection}
    )
    SELECT
      COUNT(*) AS legacy_missing_flag_rows,
      COALESCE(SUM(repairable), 0) AS repairable_rows,
      MIN(COALESCE(SUM(repairable), 0), ${limit}) AS selected,
      CASE WHEN COALESCE(SUM(repairable), 0) > ${limit} THEN 1 ELSE 0 END AS has_more,
      COALESCE(SUM(non_unique), 0) AS non_unique_rows,
      COALESCE(SUM(outside_legacy_window), 0) AS outside_legacy_window_rows,
      COALESCE(SUM(identity_or_shape_mismatch), 0) AS identity_or_shape_mismatch_rows,
      COALESCE(SUM(unexpected_result_memory_id), 0) AS unexpected_result_memory_id_rows,
      COALESCE(SUM(current_relation_conflict), 0) AS current_relation_conflict_rows,
      MIN(CASE WHEN repairable = 1 THEN created_at END) AS oldest_repairable_at,
      MAX(CASE WHEN repairable = 1 THEN created_at END) AS newest_repairable_at
    FROM legacy_missing_flag`
  };
}

export function buildLegacyRelationSnapshotApplyQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = boundedLimit(input.limit);
  return {
    name: "legacy-relation-snapshots",
    sql: `WITH selected AS (
      SELECT snapshot.rowid
      ${legacyMissingFlagSelection(namespace)}
        AND ${repairableLegacySnapshotPredicate()}
      ORDER BY snapshot.created_at, snapshot.id
      LIMIT ${limit}
    )
    UPDATE memory_events
    SET payload_json = json_set(
      payload_json,
      '$.relation_was_present',
      json('true')
    )
    WHERE rowid IN (SELECT rowid FROM selected)
      AND json_type(payload_json, '$.relation_was_present') IS NULL
    RETURNING id`
  };
}

export function assertReadOnlyLegacyRelationSnapshotQuery(query) {
  const sql = query.sql.trim();
  if (!/^(?:SELECT|WITH)\b/i.test(sql)) {
    throw new Error(`legacy_relation_snapshot_dry_run_not_select:${query.name}`);
  }
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(sql)) {
    throw new Error(`legacy_relation_snapshot_dry_run_contains_write:${query.name}`);
  }
}
