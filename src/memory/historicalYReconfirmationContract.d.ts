export const HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION: 1;
export const HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES: readonly string[];
export function normalizeHistoricalYRelationIds(relationIds: unknown[]): string[];
export function canonicalHistoricalYBatch(
  manifestId: string,
  relationIds: unknown[]
): string;
export function historicalYBatchIdFromSha256(sha256: string): string;
