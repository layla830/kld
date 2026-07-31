export function canonicalHistoricalRelationIdentity(row) {
  return JSON.stringify([
    row.namespace,
    row.id,
    row.source_memory_id,
    row.target_memory_id,
    row.relation_type,
    row.strength,
    row.reason,
    row.created_at
  ]);
}

export function canonicalHistoricalRelationSelection(row) {
  return JSON.stringify([
    canonicalHistoricalRelationIdentity(row),
    row.source_eligible,
    row.source_status,
    row.source_active_fact,
    row.source_type,
    row.source_updated_at,
    row.source_five_axis_revision,
    row.target_eligible,
    row.target_status,
    row.target_active_fact,
    row.target_type,
    row.target_updated_at,
    row.target_five_axis_revision,
    row.lifecycle_cohort,
    row.provenance_class
  ]);
}
