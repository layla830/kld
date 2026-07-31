export function sqlValue(value) {
  if (value == null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("historical_relation_delete_non_finite_sql_number");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function exactLiveRelationRowExists(snapshotAlias = "snapshot") {
  return `EXISTS (
    SELECT 1
    FROM memory_relations AS relation
    WHERE relation.namespace = ${snapshotAlias}.namespace
      AND relation.id = ${snapshotAlias}.relation_id
      AND relation.source_memory_id = ${snapshotAlias}.source_memory_id
      AND relation.target_memory_id = ${snapshotAlias}.target_memory_id
      AND relation.relation_type = ${snapshotAlias}.relation_type
      AND relation.strength = ${snapshotAlias}.strength
      AND relation.reason IS ${snapshotAlias}.reason
      AND relation.created_at = ${snapshotAlias}.relation_created_at
  )`;
}

export function exactLiveRelationExists(snapshotAlias = "snapshot") {
  return `EXISTS (
    SELECT 1
    FROM memory_relations AS relation
    JOIN memories AS source_memory
      ON source_memory.namespace = relation.namespace
     AND source_memory.id = relation.source_memory_id
    JOIN memories AS target_memory
      ON target_memory.namespace = relation.namespace
     AND target_memory.id = relation.target_memory_id
    WHERE relation.namespace = ${snapshotAlias}.namespace
      AND relation.id = ${snapshotAlias}.relation_id
      AND relation.source_memory_id = ${snapshotAlias}.source_memory_id
      AND relation.target_memory_id = ${snapshotAlias}.target_memory_id
      AND relation.relation_type = ${snapshotAlias}.relation_type
      AND relation.strength = ${snapshotAlias}.strength
      AND relation.reason IS ${snapshotAlias}.reason
      AND relation.created_at = ${snapshotAlias}.relation_created_at
      AND source_memory.status = ${snapshotAlias}.source_status
      AND source_memory.active_fact = ${snapshotAlias}.source_active_fact
      AND source_memory.type = ${snapshotAlias}.source_type
      AND source_memory.updated_at = ${snapshotAlias}.source_updated_at
      AND source_memory.five_axis_revision
        = ${snapshotAlias}.source_five_axis_revision
      AND target_memory.status = ${snapshotAlias}.target_status
      AND target_memory.active_fact = ${snapshotAlias}.target_active_fact
      AND target_memory.type = ${snapshotAlias}.target_type
      AND target_memory.updated_at = ${snapshotAlias}.target_updated_at
      AND target_memory.five_axis_revision
        = ${snapshotAlias}.target_five_axis_revision
  )`;
}

export function buildHistoricalRelationDeleteOverviewQuery(manifestId) {
  return {
    name: "historical_relation_delete_overview",
    sql: `WITH classified AS (
      SELECT
        snapshot.relation_id,
        CASE
          WHEN deletion.relation_id IS NOT NULL
            AND relation.id IS NULL
            THEN 'attributed_deleted'
          WHEN relation.id IS NULL
            THEN 'missing_unattributed'
          WHEN deletion.relation_id IS NULL
            AND ${exactLiveRelationExists("snapshot")}
            THEN 'deletable'
          ELSE 'drifted'
        END AS disposition
      FROM historical_relation_snapshots AS snapshot
      LEFT JOIN memory_relations AS relation
        ON relation.namespace = snapshot.namespace
       AND relation.id = snapshot.relation_id
      LEFT JOIN historical_relation_deletions AS deletion
        ON deletion.manifest_id = snapshot.manifest_id
       AND deletion.relation_id = snapshot.relation_id
      WHERE snapshot.manifest_id = ${sqlValue(manifestId)}
        AND snapshot.lifecycle_cohort = 'stale_endpoint'
        AND (
          snapshot.source_eligible = 0
          OR snapshot.target_eligible = 0
        )
    )
    SELECT
      COUNT(*) AS snapshot_count,
      SUM(disposition = 'attributed_deleted') AS attributed_deleted,
      SUM(disposition = 'missing_unattributed') AS missing_unattributed,
      SUM(disposition = 'drifted') AS drifted,
      SUM(disposition = 'deletable') AS deletable
    FROM classified`
  };
}

export function buildHistoricalRelationDeletableRowsQuery(manifestId, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("historical_relation_delete_limit_invalid");
  }
  return {
    name: "historical_relation_deletable_rows",
    sql: `SELECT snapshot.*
    FROM historical_relation_snapshots AS snapshot
    JOIN historical_relation_manifests AS manifest
      ON manifest.manifest_id = snapshot.manifest_id
    WHERE snapshot.manifest_id = ${sqlValue(manifestId)}
      AND snapshot.lifecycle_cohort = 'stale_endpoint'
      AND (
        snapshot.source_eligible = 0
        OR snapshot.target_eligible = 0
      )
      AND manifest.lifecycle_cohort = 'stale_endpoint'
      AND manifest.status IN ('verified', 'delete_in_progress')
      AND manifest.verified_relations_sha256
        = manifest.expected_relations_sha256
      AND manifest.verified_selection_sha256
        = manifest.expected_selection_sha256
      AND manifest.snapshot_relation_count
        = manifest.expected_relation_count
      AND NOT EXISTS (
        SELECT 1
        FROM historical_relation_deletions AS deletion
        WHERE deletion.manifest_id = snapshot.manifest_id
          AND deletion.relation_id = snapshot.relation_id
      )
      AND ${exactLiveRelationExists("snapshot")}
    ORDER BY snapshot.relation_created_at, snapshot.relation_id
    LIMIT ${limit}`
  };
}

function buildDeletionLedgerInsertSql(
  descriptor,
  row,
  batchId,
  batchOrdinal,
  deletedAt
) {
  return `INSERT OR IGNORE INTO historical_relation_deletions (
    manifest_id,
    relation_id,
    batch_id,
    batch_ordinal,
    deleted_at
  )
  SELECT
    snapshot.manifest_id,
    snapshot.relation_id,
    ${sqlValue(batchId)},
    ${sqlValue(batchOrdinal)},
    ${sqlValue(deletedAt)}
  FROM historical_relation_snapshots AS snapshot
  JOIN historical_relation_manifests AS manifest
    ON manifest.manifest_id = snapshot.manifest_id
  WHERE snapshot.manifest_id = ${sqlValue(descriptor.manifest_id)}
    AND snapshot.relation_id = ${sqlValue(row.relation_id)}
    AND snapshot.lifecycle_cohort = 'stale_endpoint'
    AND (
      snapshot.source_eligible = 0
      OR snapshot.target_eligible = 0
    )
    AND manifest.status = 'delete_in_progress'
    AND manifest.verified_relations_sha256
      = manifest.expected_relations_sha256
    AND manifest.verified_selection_sha256
      = manifest.expected_selection_sha256
    AND manifest.snapshot_relation_count = manifest.expected_relation_count
    AND ${exactLiveRelationExists("snapshot")}`;
}

function buildExactRelationDeleteSql(descriptor, row, batchId) {
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
      FROM memories AS source_memory
      WHERE source_memory.namespace = ${sqlValue(row.namespace)}
        AND source_memory.id = ${sqlValue(row.source_memory_id)}
        AND source_memory.status = ${sqlValue(row.source_status)}
        AND source_memory.active_fact = ${sqlValue(row.source_active_fact)}
        AND source_memory.type = ${sqlValue(row.source_type)}
        AND source_memory.updated_at = ${sqlValue(row.source_updated_at)}
        AND source_memory.five_axis_revision
          = ${sqlValue(row.source_five_axis_revision)}
    )
    AND EXISTS (
      SELECT 1
      FROM memories AS target_memory
      WHERE target_memory.namespace = ${sqlValue(row.namespace)}
        AND target_memory.id = ${sqlValue(row.target_memory_id)}
        AND target_memory.status = ${sqlValue(row.target_status)}
        AND target_memory.active_fact = ${sqlValue(row.target_active_fact)}
        AND target_memory.type = ${sqlValue(row.target_type)}
        AND target_memory.updated_at = ${sqlValue(row.target_updated_at)}
        AND target_memory.five_axis_revision
          = ${sqlValue(row.target_five_axis_revision)}
    )
    AND EXISTS (
      SELECT 1
      FROM historical_relation_deletions AS deletion
      WHERE deletion.manifest_id = ${sqlValue(descriptor.manifest_id)}
        AND deletion.relation_id = ${sqlValue(row.relation_id)}
        AND deletion.batch_id = ${sqlValue(batchId)}
    )`;
}

export function buildHistoricalRelationDeleteBatchStatements({
  descriptor,
  rows,
  batchId,
  batchOrdinal,
  deletedAt
}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new Error("historical_relation_delete_batch_size_invalid");
  }
  const statements = [
    `UPDATE historical_relation_manifests
     SET status = 'delete_in_progress'
     WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
       AND lifecycle_cohort = 'stale_endpoint'
       AND status = 'verified'`
  ];
  for (const row of rows) {
    statements.push(buildDeletionLedgerInsertSql(
      descriptor,
      row,
      batchId,
      batchOrdinal,
      deletedAt
    ));
    statements.push(buildExactRelationDeleteSql(descriptor, row, batchId));
  }
  statements.push(
    `UPDATE historical_relation_manifests
     SET deleted_relation_count = (
           SELECT COUNT(*)
           FROM historical_relation_deletions AS deletion
           WHERE deletion.manifest_id
             = historical_relation_manifests.manifest_id
         ),
         delete_batches_completed = (
           SELECT COUNT(DISTINCT deletion.batch_id)
           FROM historical_relation_deletions AS deletion
           WHERE deletion.manifest_id
             = historical_relation_manifests.manifest_id
         )
     WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
       AND status = 'delete_in_progress'`,
    `UPDATE historical_relation_manifests
     SET status = 'deleted',
         deleted_at = ${sqlValue(deletedAt)}
     WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
       AND status = 'delete_in_progress'
       AND deleted_relation_count = expected_relation_count`
  );
  return statements;
}

export function buildHistoricalRelationDeleteBatchSql(input) {
  return `${
    buildHistoricalRelationDeleteBatchStatements(input).join(";\n\n")
  };\n`;
}
