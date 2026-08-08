import {
  exactLiveRelationExists,
  sqlValue
} from "./historicalRelationDeleteSql.js";

const COHORT = "eligible_unproven";
const MAX_BATCH = 10;

function relationIdsSql(relationIds) {
  if (
    !Array.isArray(relationIds)
    || relationIds.length < 1
    || relationIds.length > MAX_BATCH
    || new Set(relationIds).size !== relationIds.length
  ) {
    throw new Error("historical_structural_delete_selection_invalid");
  }
  return relationIds.map(sqlValue).join(", ");
}

export function liveStructuralMismatchExists(snapshotAlias = "snapshot") {
  return `EXISTS (
    SELECT 1
    FROM memories AS source_memory
    JOIN memories AS target_memory
      ON target_memory.namespace = source_memory.namespace
     AND target_memory.id = ${snapshotAlias}.target_memory_id
    WHERE source_memory.namespace = ${snapshotAlias}.namespace
      AND source_memory.id = ${snapshotAlias}.source_memory_id
      AND (
        (
          ${snapshotAlias}.relation_type = 'same_fact_key'
          AND NOT (
            source_memory.fact_key IS NOT NULL
            AND target_memory.fact_key IS NOT NULL
            AND source_memory.fact_key = target_memory.fact_key
          )
        )
        OR (
          ${snapshotAlias}.relation_type = 'in_thread'
          AND NOT (
            source_memory.thread IS NOT NULL
            AND target_memory.thread IS NOT NULL
            AND source_memory.thread = target_memory.thread
          )
        )
      )
  )`;
}

function snapshotScope(manifestId, relationIds, alias = "snapshot") {
  return `${alias}.manifest_id = ${sqlValue(manifestId)}
    AND ${alias}.relation_id IN (${relationIdsSql(relationIds)})
    AND ${alias}.lifecycle_cohort = '${COHORT}'
    AND ${alias}.source_eligible = 1
    AND ${alias}.target_eligible = 1
    AND ${alias}.relation_type IN ('same_fact_key', 'in_thread')`;
}

export function buildHistoricalStructuralDeleteOverviewQuery(manifestId, relationIds) {
  return {
    name: "historical_structural_delete_overview",
    sql: `WITH classified AS (
      SELECT snapshot.relation_id,
        CASE
          WHEN deletion.relation_id IS NOT NULL AND relation.id IS NULL
            THEN 'attributed_deleted'
          WHEN relation.id IS NULL THEN 'missing_unattributed'
          WHEN NOT ${exactLiveRelationExists("snapshot")} THEN 'drifted'
          WHEN ${liveStructuralMismatchExists("snapshot")} THEN 'deletable'
          ELSE 'now_confirmable'
        END AS disposition
      FROM historical_relation_snapshots AS snapshot
      LEFT JOIN memory_relations AS relation
        ON relation.namespace = snapshot.namespace
       AND relation.id = snapshot.relation_id
      LEFT JOIN historical_relation_deletions AS deletion
        ON deletion.manifest_id = snapshot.manifest_id
       AND deletion.relation_id = snapshot.relation_id
      WHERE ${snapshotScope(manifestId, relationIds)}
    )
    SELECT
      COUNT(*) AS snapshot_count,
      SUM(disposition = 'attributed_deleted') AS attributed_deleted,
      SUM(disposition = 'missing_unattributed') AS missing_unattributed,
      SUM(disposition = 'drifted') AS drifted,
      SUM(disposition = 'now_confirmable') AS now_confirmable,
      SUM(disposition = 'deletable') AS deletable,
      GROUP_CONCAT(
        CASE WHEN disposition = 'now_confirmable' THEN relation_id END
      ) AS now_confirmable_relation_ids
    FROM classified`
  };
}

export function buildHistoricalStructuralDeletableRowsQuery(manifestId, relationIds) {
  return {
    name: "historical_structural_deletable_rows",
    sql: `SELECT snapshot.*
    FROM historical_relation_snapshots AS snapshot
    JOIN historical_relation_manifests AS manifest
      ON manifest.manifest_id = snapshot.manifest_id
    WHERE ${snapshotScope(manifestId, relationIds)}
      AND manifest.lifecycle_cohort = '${COHORT}'
      AND manifest.status IN ('verified', 'delete_in_progress')
      AND manifest.verified_relations_sha256 = manifest.expected_relations_sha256
      AND manifest.verified_selection_sha256 = manifest.expected_selection_sha256
      AND manifest.snapshot_relation_count = manifest.expected_relation_count
      AND NOT EXISTS (
        SELECT 1 FROM historical_relation_deletions AS deletion
        WHERE deletion.manifest_id = snapshot.manifest_id
          AND deletion.relation_id = snapshot.relation_id
      )
      AND ${exactLiveRelationExists("snapshot")}
      AND ${liveStructuralMismatchExists("snapshot")}
    ORDER BY snapshot.relation_created_at, snapshot.relation_id`
  };
}

function ledgerInsert(descriptor, row, batchId, batchOrdinal, deletedAt) {
  return `INSERT OR IGNORE INTO historical_relation_deletions (
    manifest_id, relation_id, batch_id, batch_ordinal, deleted_at
  )
  SELECT snapshot.manifest_id, snapshot.relation_id,
    ${sqlValue(batchId)}, ${sqlValue(batchOrdinal)}, ${sqlValue(deletedAt)}
  FROM historical_relation_snapshots AS snapshot
  JOIN historical_relation_manifests AS manifest
    ON manifest.manifest_id = snapshot.manifest_id
  WHERE ${snapshotScope(descriptor.manifest_id, [row.relation_id])}
    AND manifest.status = 'delete_in_progress'
    AND manifest.verified_relations_sha256 = manifest.expected_relations_sha256
    AND manifest.verified_selection_sha256 = manifest.expected_selection_sha256
    AND manifest.snapshot_relation_count = manifest.expected_relation_count
    AND ${exactLiveRelationExists("snapshot")}
    AND ${liveStructuralMismatchExists("snapshot")}`;
}

function exactDelete(descriptor, row, batchId) {
  return `DELETE FROM memory_relations
  WHERE namespace = ${sqlValue(row.namespace)}
    AND id = ${sqlValue(row.relation_id)}
    AND source_memory_id = ${sqlValue(row.source_memory_id)}
    AND target_memory_id = ${sqlValue(row.target_memory_id)}
    AND relation_type = ${sqlValue(row.relation_type)}
    AND strength = ${sqlValue(row.strength)}
    AND reason IS ${sqlValue(row.reason)}
    AND created_at = ${sqlValue(row.relation_created_at)}
    AND EXISTS (
      SELECT 1
      FROM historical_relation_snapshots AS snapshot
      WHERE ${snapshotScope(descriptor.manifest_id, [row.relation_id])}
        AND ${exactLiveRelationExists("snapshot")}
        AND ${liveStructuralMismatchExists("snapshot")}
    )
    AND EXISTS (
      SELECT 1 FROM historical_relation_deletions AS deletion
      WHERE deletion.manifest_id = ${sqlValue(descriptor.manifest_id)}
        AND deletion.relation_id = ${sqlValue(row.relation_id)}
        AND deletion.batch_id = ${sqlValue(batchId)}
    )`;
}

export function buildHistoricalStructuralDeleteBatchStatements({
  descriptor,
  rows,
  batchId,
  batchOrdinal,
  deletedAt
}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_BATCH) {
    throw new Error("historical_structural_delete_batch_size_invalid");
  }
  const statements = [
    `UPDATE historical_relation_manifests
     SET status = 'delete_in_progress'
     WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
       AND lifecycle_cohort = '${COHORT}'
       AND status = 'verified'`
  ];
  for (const row of rows) {
    statements.push(ledgerInsert(descriptor, row, batchId, batchOrdinal, deletedAt));
    statements.push(exactDelete(descriptor, row, batchId));
  }
  statements.push(
    `UPDATE historical_relation_manifests
     SET deleted_relation_count = (
           SELECT COUNT(*) FROM historical_relation_deletions AS deletion
           WHERE deletion.manifest_id = historical_relation_manifests.manifest_id
         ),
         delete_batches_completed = (
           SELECT COUNT(DISTINCT deletion.batch_id)
           FROM historical_relation_deletions AS deletion
           WHERE deletion.manifest_id = historical_relation_manifests.manifest_id
         )
     WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
       AND status = 'delete_in_progress'`,
    `UPDATE historical_relation_manifests
     SET status = 'deleted', deleted_at = ${sqlValue(deletedAt)}
     WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
       AND status = 'delete_in_progress'
       AND deleted_relation_count = expected_relation_count`
  );
  return statements;
}

export function buildHistoricalStructuralDeleteBatchSql(input) {
  return `${buildHistoricalStructuralDeleteBatchStatements(input).join(";\n\n")};\n`;
}
