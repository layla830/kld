export interface HistoricalRelationSnapshotCanonicalRow {
  namespace: string;
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: string;
  strength: number;
  reason: string | null;
  created_at: string;
  source_eligible: boolean;
  source_status: string;
  source_active_fact: number;
  source_type: string;
  source_updated_at: string;
  source_five_axis_revision: number;
  target_eligible: boolean;
  target_status: string;
  target_active_fact: number;
  target_type: string;
  target_updated_at: string;
  target_five_axis_revision: number;
  lifecycle_cohort: string;
  provenance_class: string;
}

export function canonicalHistoricalRelationIdentity(
  row: HistoricalRelationSnapshotCanonicalRow
): string;
export function canonicalHistoricalRelationSelection(
  row: HistoricalRelationSnapshotCanonicalRow
): string;
