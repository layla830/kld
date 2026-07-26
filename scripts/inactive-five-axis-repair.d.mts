export interface InactiveFiveAxisRepairQuery {
  name: "stale-axis-runs";
  sql: string;
}

export const MAX_REPAIR_LIMIT: number;
export function buildRepairDryRunQuery(input: {
  namespace: string;
  limit: number;
}): InactiveFiveAxisRepairQuery;
export function buildRepairApplyQuery(input: {
  namespace: string;
  limit: number;
}): InactiveFiveAxisRepairQuery;
export function assertReadOnlyRepairQuery(query: InactiveFiveAxisRepairQuery): void;
