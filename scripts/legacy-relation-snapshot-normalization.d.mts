export interface LegacyRelationSnapshotRepairInput {
  namespace: string;
  limit: number;
}

export interface LegacyRelationSnapshotQuery {
  name: string;
  sql: string;
}

export const MAX_LEGACY_RELATION_SNAPSHOT_REPAIR_LIMIT: number;
export const FIRST_FLAGGED_RELATION_SNAPSHOT_AT: string;

export function buildLegacyRelationSnapshotDryRunQuery(
  input: LegacyRelationSnapshotRepairInput
): LegacyRelationSnapshotQuery;

export function buildLegacyRelationSnapshotApplyQuery(
  input: LegacyRelationSnapshotRepairInput
): LegacyRelationSnapshotQuery;

export function assertReadOnlyLegacyRelationSnapshotQuery(
  query: LegacyRelationSnapshotQuery
): void;
