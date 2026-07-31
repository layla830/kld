export function buildHistoricalRelationDeleteOverviewQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationDeletableRowsQuery(
  manifestId: string,
  limit: number
): { name: string; sql: string };
export function buildHistoricalRelationDeleteBatchStatements(input: {
  descriptor: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  batchId: string;
  batchOrdinal: number;
  deletedAt: string;
}): string[];
export function buildHistoricalRelationDeleteBatchSql(input: {
  descriptor: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  batchId: string;
  batchOrdinal: number;
  deletedAt: string;
}): string;
export function sqlValue(value: unknown): string;
export function exactLiveRelationExists(snapshotAlias?: string): string;
export function exactLiveRelationRowExists(snapshotAlias?: string): string;
