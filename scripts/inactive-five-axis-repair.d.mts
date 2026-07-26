export type InactiveFiveAxisRepairCohort = "relations" | "stale-axis-runs";

export interface InactiveFiveAxisRepairQuery {
  name: InactiveFiveAxisRepairCohort;
  sql: string;
}

export const MAX_REPAIR_LIMIT: number;
export const INACTIVE_FIVE_AXIS_REPAIR_COHORTS: readonly InactiveFiveAxisRepairCohort[];
export function buildRepairDryRunQuery(input: {
  namespace: string;
  cohort: InactiveFiveAxisRepairCohort;
  limit: number;
}): InactiveFiveAxisRepairQuery;
export function buildRepairApplyQuery(input: {
  namespace: string;
  cohort: InactiveFiveAxisRepairCohort;
  limit: number;
}): InactiveFiveAxisRepairQuery;
export function assertReadOnlyRepairQuery(query: InactiveFiveAxisRepairQuery): void;
