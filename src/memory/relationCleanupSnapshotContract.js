export function relationCleanupSnapshotCountSql(candidateAlias) {
  return `(SELECT COUNT(*)
    FROM memory_events AS snapshot_count
    WHERE snapshot_count.namespace = ${candidateAlias}.namespace
      AND snapshot_count.event_type = 'm_snapshot'
      AND json_extract(snapshot_count.payload_json, '$.candidate_id') = ${candidateAlias}.id
      AND json_extract(snapshot_count.payload_json, '$.action') = 'm_relation_cleanup')`;
}

export function relationCleanupSnapshotValiditySql(snapshotAlias, candidateAlias) {
  return `${snapshotAlias}.namespace = ${candidateAlias}.namespace
    AND ${candidateAlias}.action = 'm_relation_cleanup'
    AND ${snapshotAlias}.event_type = 'm_snapshot'
    AND json_extract(${snapshotAlias}.payload_json, '$.candidate_id') = ${candidateAlias}.id
    AND json_extract(${snapshotAlias}.payload_json, '$.action') = 'm_relation_cleanup'
    AND json_type(${snapshotAlias}.payload_json, '$.relation_was_present') IN ('true', 'false')
    AND json_type(${snapshotAlias}.payload_json, '$.before') = 'object'
    AND json_extract(${snapshotAlias}.payload_json, '$.before.id')
      = json_extract(${candidateAlias}.payload_json, '$.before.id')
    AND json_extract(${snapshotAlias}.payload_json, '$.before.source_memory_id')
      = json_extract(${candidateAlias}.payload_json, '$.before.source_memory_id')
    AND json_extract(${snapshotAlias}.payload_json, '$.before.target_memory_id')
      = json_extract(${candidateAlias}.payload_json, '$.before.target_memory_id')
    AND json_extract(${snapshotAlias}.payload_json, '$.before.relation_type')
      = json_extract(${candidateAlias}.payload_json, '$.before.relation_type')
    AND (
      json_extract(${snapshotAlias}.payload_json, '$.relation_was_present') = 0
      OR (
        json_extract(${snapshotAlias}.payload_json, '$.relation_was_present') = 1
        AND json_extract(${snapshotAlias}.payload_json, '$.before.strength') IS NOT NULL
        AND json_extract(${snapshotAlias}.payload_json, '$.before.created_at') IS NOT NULL
      )
    )`;
}
