import {
  exactLiveRelationRowExists,
  sqlValue
} from "./historicalRelationDeleteSql.js";

export function buildHistoricalRelationRollbackOverviewQuery(manifestId) {
  return {
    name: "historical_relation_rollback_overview",
    sql: `WITH classified AS (
      SELECT CASE
        WHEN deletion.restored_at IS NOT NULL
          AND ${exactLiveRelationRowExists("snapshot")}
          THEN 'restored'
        WHEN deletion.restored_at IS NULL
          AND relation.id IS NULL
          AND source_memory.id IS NOT NULL
          AND target_memory.id IS NOT NULL
          THEN 'restorable'
        ELSE 'conflict'
      END AS disposition
      FROM historical_relation_deletions AS deletion
      JOIN historical_relation_snapshots AS snapshot
        ON snapshot.manifest_id = deletion.manifest_id
       AND snapshot.relation_id = deletion.relation_id
      LEFT JOIN memory_relations AS relation
        ON relation.namespace = snapshot.namespace
       AND relation.id = snapshot.relation_id
      LEFT JOIN memories AS source_memory
        ON source_memory.namespace = snapshot.namespace
       AND source_memory.id = snapshot.source_memory_id
      LEFT JOIN memories AS target_memory
        ON target_memory.namespace = snapshot.namespace
       AND target_memory.id = snapshot.target_memory_id
      WHERE deletion.manifest_id = ${sqlValue(manifestId)}
    )
    SELECT
      COUNT(*) AS ledger_count,
      SUM(disposition = 'restored') AS restored,
      SUM(disposition = 'restorable') AS restorable,
      SUM(disposition = 'conflict') AS conflict
    FROM classified`
  };
}

export function buildHistoricalRelationRestorableRowsQuery(manifestId, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("historical_relation_rollback_limit_invalid");
  }
  return {
    name: "historical_relation_restorable_rows",
    sql: `SELECT snapshot.*
    FROM historical_relation_deletions AS deletion
    JOIN historical_relation_snapshots AS snapshot
      ON snapshot.manifest_id = deletion.manifest_id
     AND snapshot.relation_id = deletion.relation_id
    JOIN historical_relation_manifests AS manifest
      ON manifest.manifest_id = deletion.manifest_id
    JOIN memories AS source_memory
      ON source_memory.namespace = snapshot.namespace
     AND source_memory.id = snapshot.source_memory_id
    JOIN memories AS target_memory
      ON target_memory.namespace = snapshot.namespace
     AND target_memory.id = snapshot.target_memory_id
    WHERE deletion.manifest_id = ${sqlValue(manifestId)}
      AND deletion.restored_at IS NULL
      AND manifest.lifecycle_cohort = 'stale_endpoint'
      AND manifest.status IN ('delete_in_progress', 'deleted')
      AND NOT EXISTS (
        SELECT 1
        FROM memory_relations AS relation
        WHERE relation.namespace = snapshot.namespace
          AND relation.id = snapshot.relation_id
      )
    ORDER BY deletion.batch_ordinal DESC, snapshot.relation_created_at,
      snapshot.relation_id
    LIMIT ${limit}`
  };
}

function restoreInsertSql(descriptor, row) {
  return `INSERT INTO memory_relations (
    id, namespace, source_memory_id, target_memory_id,
    relation_type, strength, reason, created_at
  )
  SELECT
    snapshot.relation_id,
    snapshot.namespace,
    snapshot.source_memory_id,
    snapshot.target_memory_id,
    snapshot.relation_type,
    snapshot.strength,
    snapshot.reason,
    snapshot.relation_created_at
  FROM historical_relation_snapshots AS snapshot
  JOIN historical_relation_deletions AS deletion
    ON deletion.manifest_id = snapshot.manifest_id
   AND deletion.relation_id = snapshot.relation_id
  JOIN historical_relation_manifests AS manifest
    ON manifest.manifest_id = snapshot.manifest_id
  WHERE snapshot.manifest_id = ${sqlValue(descriptor.manifest_id)}
    AND snapshot.relation_id = ${sqlValue(row.relation_id)}
    AND deletion.restored_at IS NULL
    AND manifest.status IN ('delete_in_progress', 'deleted')
    AND EXISTS (
      SELECT 1 FROM memories
      WHERE namespace = snapshot.namespace
        AND id = snapshot.source_memory_id
    )
    AND EXISTS (
      SELECT 1 FROM memories
      WHERE namespace = snapshot.namespace
        AND id = snapshot.target_memory_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM memory_relations AS relation
      WHERE relation.namespace = snapshot.namespace
        AND relation.id = snapshot.relation_id
    )`;
}

export function buildHistoricalRelationRollbackBatchStatements({
  descriptor,
  rows,
  restoredAt
}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new Error("historical_relation_rollback_batch_size_invalid");
  }
  const statements = [];
  for (const row of rows) {
    statements.push(restoreInsertSql(descriptor, row));
    statements.push(`UPDATE historical_relation_deletions
      SET restored_at = ${sqlValue(restoredAt)}
      WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
        AND relation_id = ${sqlValue(row.relation_id)}
        AND restored_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM historical_relation_snapshots AS snapshot
          WHERE snapshot.manifest_id
              = historical_relation_deletions.manifest_id
            AND snapshot.relation_id
              = historical_relation_deletions.relation_id
            AND ${exactLiveRelationRowExists("snapshot")}
        )`);
  }
  statements.push(buildHistoricalRelationRollbackFinalizeSql(
    descriptor,
    restoredAt
  ));
  return statements;
}

export function buildHistoricalRelationRollbackFinalizeSql(
  descriptor,
  restoredAt
) {
  return `UPDATE historical_relation_manifests
    SET status = 'rolled_back',
        rolled_back_at = ${sqlValue(restoredAt)}
    WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
      AND status IN ('delete_in_progress', 'deleted')
      AND deleted_relation_count > 0
      AND NOT EXISTS (
        SELECT 1
        FROM historical_relation_deletions AS deletion
        WHERE deletion.manifest_id
            = historical_relation_manifests.manifest_id
          AND deletion.restored_at IS NULL
      )`;
}

export function buildHistoricalRelationRollbackBatchSql(input) {
  return `${buildHistoricalRelationRollbackBatchStatements(input).join(
    ";\n\n"
  )};\n`;
}
