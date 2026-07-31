export function buildHistoricalRelationManifestInsertSql(
  descriptor: Record<string, unknown>
): string;
export function buildHistoricalRelationSnapshotInsertSql(
  descriptor: Record<string, unknown>,
  row: Record<string, unknown>,
  snapshottedAt: string
): string;
export function buildHistoricalRelationSnapshotBatchStatements(
  descriptor: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  snapshottedAt: string
): string[];
export function buildHistoricalRelationSnapshotBatchSql(
  descriptor: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  snapshottedAt: string
): string;
export function buildHistoricalRelationManifestStateQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationSnapshotIdsQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationSnapshotRowsQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationVerifySql(
  descriptor: Record<string, unknown>,
  verifiedAt: string
): string;
