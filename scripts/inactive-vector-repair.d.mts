export interface InactiveVectorRepairQuery {
  name: "inactive-vector-state";
  sql: string;
}

export const MAX_VECTOR_REPAIR_LIMIT: number;
export function buildVectorRepairDryRunQuery(input: {
  namespace: string;
  limit: number;
}): InactiveVectorRepairQuery;
export function buildVectorRepairApplyQuery(input: {
  namespace: string;
  limit: number;
}): InactiveVectorRepairQuery;
export function assertReadOnlyVectorRepairQuery(query: InactiveVectorRepairQuery): void;
