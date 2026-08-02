export const HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION: 2;
export const HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES: readonly string[];
export const HISTORICAL_Y_DIRECTED_RELATION_TYPES: readonly string[];
export const HISTORICAL_Y_STRUCTURAL_RELATION_TYPES: readonly string[];
export function normalizeHistoricalYRelationIds(relationIds: unknown[]): string[];
export function canonicalHistoricalYBatch(
  manifestId: string,
  relationIds: unknown[]
): string;
export function historicalYBatchIdFromSha256(sha256: string): string;
