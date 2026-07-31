export function buildHistoricalRelationRollbackOverviewQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationRestorableRowsQuery(
  manifestId: string,
  limit: number
): { name: string; sql: string };
export function buildHistoricalRelationRollbackBatchStatements(input: {
  descriptor: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  restoredAt: string;
}): string[];
export function buildHistoricalRelationRollbackFinalizeSql(
  descriptor: Record<string, unknown>,
  restoredAt: string
): string;
export function buildHistoricalRelationRollbackBatchSql(input: {
  descriptor: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  restoredAt: string;
}): string;
