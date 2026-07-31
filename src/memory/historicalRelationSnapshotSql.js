function sqlValue(value) {
  if (value == null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("historical_relation_snapshot_non_finite_sql_number");
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildHistoricalRelationManifestInsertSql(descriptor) {
  return `INSERT OR IGNORE INTO historical_relation_manifests (
    manifest_id,
    namespace,
    lifecycle_cohort,
    selection_predicate_version,
    expected_relation_count,
    expected_relations_sha256,
    expected_selection_sha256,
    created_at
  ) VALUES (
    ${sqlValue(descriptor.manifest_id)},
    ${sqlValue(descriptor.namespace)},
    ${sqlValue(descriptor.lifecycle_cohort)},
    ${sqlValue(descriptor.selection_predicate_version)},
    ${sqlValue(descriptor.expected_relation_count)},
    ${sqlValue(descriptor.expected_relations_sha256)},
    ${sqlValue(descriptor.expected_selection_sha256)},
    ${sqlValue(descriptor.created_at)}
  )`;
}

export function buildHistoricalRelationSnapshotInsertSql(
  descriptor,
  row,
  snapshottedAt
) {
  return `INSERT OR IGNORE INTO historical_relation_snapshots (
    manifest_id,
    namespace,
    lifecycle_cohort,
    relation_id,
    source_memory_id,
    target_memory_id,
    relation_type,
    strength,
    reason,
    relation_created_at,
    identity_sha256,
    selection_sha256,
    source_eligible,
    source_status,
    source_active_fact,
    source_type,
    source_updated_at,
    source_five_axis_revision,
    target_eligible,
    target_status,
    target_active_fact,
    target_type,
    target_updated_at,
    target_five_axis_revision,
    provenance_class,
    snapshotted_at
  )
  SELECT
    ${sqlValue(descriptor.manifest_id)},
    relation.namespace,
    ${sqlValue(descriptor.lifecycle_cohort)},
    relation.id,
    relation.source_memory_id,
    relation.target_memory_id,
    relation.relation_type,
    relation.strength,
    relation.reason,
    relation.created_at,
    ${sqlValue(row.identity_sha256)},
    ${sqlValue(row.selection_sha256)},
    ${sqlValue(row.source_eligible)},
    source_memory.status,
    source_memory.active_fact,
    source_memory.type,
    source_memory.updated_at,
    source_memory.five_axis_revision,
    ${sqlValue(row.target_eligible)},
    target_memory.status,
    target_memory.active_fact,
    target_memory.type,
    target_memory.updated_at,
    target_memory.five_axis_revision,
    ${sqlValue(row.provenance_class)},
    ${sqlValue(snapshottedAt)}
  FROM memory_relations AS relation
  JOIN memories AS source_memory
    ON source_memory.namespace = relation.namespace
   AND source_memory.id = relation.source_memory_id
  JOIN memories AS target_memory
    ON target_memory.namespace = relation.namespace
   AND target_memory.id = relation.target_memory_id
  WHERE relation.namespace = ${sqlValue(row.namespace)}
    AND relation.id = ${sqlValue(row.id)}
    AND relation.source_memory_id = ${sqlValue(row.source_memory_id)}
    AND relation.target_memory_id = ${sqlValue(row.target_memory_id)}
    AND relation.relation_type = ${sqlValue(row.relation_type)}
    AND relation.strength = ${sqlValue(row.strength)}
    AND relation.reason IS ${sqlValue(row.reason)}
    AND relation.created_at = ${sqlValue(row.created_at)}
    AND source_memory.status = ${sqlValue(row.source_status)}
    AND source_memory.active_fact = ${sqlValue(row.source_active_fact)}
    AND source_memory.type = ${sqlValue(row.source_type)}
    AND source_memory.updated_at = ${sqlValue(row.source_updated_at)}
    AND source_memory.five_axis_revision = ${sqlValue(row.source_five_axis_revision)}
    AND target_memory.status = ${sqlValue(row.target_status)}
    AND target_memory.active_fact = ${sqlValue(row.target_active_fact)}
    AND target_memory.type = ${sqlValue(row.target_type)}
    AND target_memory.updated_at = ${sqlValue(row.target_updated_at)}
    AND target_memory.five_axis_revision = ${sqlValue(row.target_five_axis_revision)}
    AND EXISTS (
      SELECT 1
      FROM historical_relation_manifests AS manifest
      WHERE manifest.manifest_id = ${sqlValue(descriptor.manifest_id)}
        AND manifest.namespace = ${sqlValue(descriptor.namespace)}
        AND manifest.lifecycle_cohort = ${sqlValue(descriptor.lifecycle_cohort)}
        AND manifest.selection_predicate_version
          = ${sqlValue(descriptor.selection_predicate_version)}
        AND manifest.expected_relation_count
          = ${sqlValue(descriptor.expected_relation_count)}
        AND manifest.expected_relations_sha256
          = ${sqlValue(descriptor.expected_relations_sha256)}
        AND manifest.expected_selection_sha256
          = ${sqlValue(descriptor.expected_selection_sha256)}
        AND manifest.status = 'staging'
    )`;
}

export function buildHistoricalRelationSnapshotBatchStatements(
  descriptor,
  rows,
  snapshottedAt
) {
  return [
    buildHistoricalRelationManifestInsertSql(descriptor),
    ...rows.map((row) => buildHistoricalRelationSnapshotInsertSql(
      descriptor,
      row,
      snapshottedAt
    )),
    `UPDATE historical_relation_manifests
     SET snapshot_relation_count = (
           SELECT COUNT(*)
           FROM historical_relation_snapshots AS snapshot
           WHERE snapshot.manifest_id
             = historical_relation_manifests.manifest_id
         ),
         last_snapshot_at = ${sqlValue(snapshottedAt)}
     WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
       AND status = 'staging'`
  ];
}

export function buildHistoricalRelationSnapshotBatchSql(
  descriptor,
  rows,
  snapshottedAt
) {
  const statements = buildHistoricalRelationSnapshotBatchStatements(
    descriptor,
    rows,
    snapshottedAt
  );
  return `${statements.join(";\n\n")};\n`;
}

export function buildHistoricalRelationManifestStateQuery(manifestId) {
  return {
    name: "historical_relation_manifest_state",
    sql: `SELECT *
      FROM historical_relation_manifests
      WHERE manifest_id = ${sqlValue(manifestId)}`
  };
}

export function buildHistoricalRelationSnapshotIdsQuery(manifestId) {
  return {
    name: "historical_relation_snapshot_ids",
    sql: `SELECT relation_id
      FROM historical_relation_snapshots
      WHERE manifest_id = ${sqlValue(manifestId)}
      ORDER BY relation_id`
  };
}

export function buildHistoricalRelationSnapshotRowsQuery(manifestId) {
  return {
    name: "historical_relation_snapshot_rows",
    sql: `SELECT
        namespace,
        lifecycle_cohort,
        relation_id AS id,
        source_memory_id,
        target_memory_id,
        relation_type,
        strength,
        reason,
        relation_created_at AS created_at,
        identity_sha256,
        selection_sha256,
        source_eligible,
        source_status,
        source_active_fact,
        source_type,
        source_updated_at,
        source_five_axis_revision,
        target_eligible,
        target_status,
        target_active_fact,
        target_type,
        target_updated_at,
        target_five_axis_revision,
        provenance_class
      FROM historical_relation_snapshots
      WHERE manifest_id = ${sqlValue(manifestId)}
      ORDER BY relation_created_at, relation_id`
  };
}

export function buildHistoricalRelationVerifySql(descriptor, verifiedAt) {
  return `UPDATE historical_relation_manifests
  SET status = 'verified',
      snapshot_relation_count = (
        SELECT COUNT(*)
        FROM historical_relation_snapshots AS snapshot
        WHERE snapshot.manifest_id
          = historical_relation_manifests.manifest_id
      ),
      verified_at = ${sqlValue(verifiedAt)},
      verified_relations_sha256
        = ${sqlValue(descriptor.expected_relations_sha256)},
      verified_selection_sha256
        = ${sqlValue(descriptor.expected_selection_sha256)}
  WHERE manifest_id = ${sqlValue(descriptor.manifest_id)}
    AND status = 'staging'
    AND (
      SELECT COUNT(*)
      FROM historical_relation_snapshots AS snapshot
      WHERE snapshot.manifest_id
        = historical_relation_manifests.manifest_id
    ) = ${sqlValue(descriptor.expected_relation_count)}
    AND expected_relations_sha256 = ${sqlValue(descriptor.expected_relations_sha256)}
    AND expected_selection_sha256 = ${sqlValue(descriptor.expected_selection_sha256)}
  RETURNING manifest_id`;
}
