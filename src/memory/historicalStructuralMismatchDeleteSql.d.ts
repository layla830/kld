export function liveStructuralMismatchExists(snapshotAlias?: string): string;
export function buildHistoricalStructuralDeleteOverviewQuery(
  manifestId: string,
  relationIds: string[]
): { name: string; sql: string };
export function buildHistoricalStructuralDeletableRowsQuery(
  manifestId: string,
  relationIds: string[]
): { name: string; sql: string };
export function buildHistoricalStructuralDeleteBatchStatements(input: {
  descriptor: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  batchId: string;
  batchOrdinal: number;
  deletedAt: string;
}): string[];
export function buildHistoricalStructuralDeleteBatchSql(input: {
  descriptor: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  batchId: string;
  batchOrdinal: number;
  deletedAt: string;
}): string;
