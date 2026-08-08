import {
  exactLiveRelationRowExists,
  sqlValue
} from "./historicalRelationDeleteSql.js";
import {
  buildHistoricalRelationRollbackBatchSql
} from "./historicalRelationRollbackSql.js";

const MAX_BATCH = 10;

function idsSql(relationIds) {
  if (
    !Array.isArray(relationIds)
    || relationIds.length < 1
    || relationIds.length > MAX_BATCH
    || new Set(relationIds).size !== relationIds.length
  ) {
    throw new Error("historical_structural_rollback_selection_invalid");
  }
  return relationIds.map(sqlValue).join(", ");
}

export function buildHistoricalStructuralRollbackOverviewQuery(manifestId, relationIds) {
  return {
    name: "historical_structural_rollback_overview",
    sql: `WITH classified AS (
      SELECT snapshot.relation_id,
        CASE
          WHEN deletion.restored_at IS NOT NULL
            AND ${exactLiveRelationRowExists("snapshot")} THEN 'restored'
          WHEN deletion.restored_at IS NULL
            AND relation.id IS NULL
            AND source_memory.id IS NOT NULL
            AND target_memory.id IS NOT NULL THEN 'restorable'
          ELSE 'conflict'
        END AS disposition
      FROM historical_relation_deletions AS deletion
      JOIN historical_relation_snapshots AS snapshot
        ON snapshot.manifest_id = deletion.manifest_id
       AND snapshot.relation_id = deletion.relation_id
      JOIN historical_relation_manifests AS manifest
        ON manifest.manifest_id = deletion.manifest_id
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
        AND deletion.relation_id IN (${idsSql(relationIds)})
        AND manifest.lifecycle_cohort = 'eligible_unproven'
    )
    SELECT COUNT(*) AS ledger_count,
      SUM(disposition = 'restored') AS restored,
      SUM(disposition = 'restorable') AS restorable,
      SUM(disposition = 'conflict') AS conflict
    FROM classified`
  };
}

export function buildHistoricalStructuralRestorableRowsQuery(manifestId, relationIds) {
  return {
    name: "historical_structural_restorable_rows",
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
      AND deletion.relation_id IN (${idsSql(relationIds)})
      AND deletion.restored_at IS NULL
      AND manifest.lifecycle_cohort = 'eligible_unproven'
      AND manifest.status IN ('delete_in_progress', 'deleted')
      AND NOT EXISTS (
        SELECT 1 FROM memory_relations AS relation
        WHERE relation.namespace = snapshot.namespace
          AND relation.id = snapshot.relation_id
      )
    ORDER BY deletion.batch_ordinal DESC, snapshot.relation_created_at,
      snapshot.relation_id`
  };
}

export function buildHistoricalStructuralRollbackBatchSql(input) {
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_BATCH) {
    throw new Error("historical_structural_rollback_batch_size_invalid");
  }
  return buildHistoricalRelationRollbackBatchSql(input);
}
