export type InactiveFiveAxisRepairCohort = "relations" | "stale-axis-runs";

export interface InactiveFiveAxisRepairArgs {
  db: string;
  namespace: string;
  cohort: InactiveFiveAxisRepairCohort | "";
  limit: number;
  remote: boolean;
  apply: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export interface InactiveFiveAxisRepairQuery {
  name: InactiveFiveAxisRepairCohort;
  sql: string;
}

export const INACTIVE_FIVE_AXIS_REPAIR_COHORTS: readonly InactiveFiveAxisRepairCohort[];
export function usage(): string;
export function parseRepairArgs(argv: string[]): InactiveFiveAxisRepairArgs;
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
export function runInactiveFiveAxisRepair(
  args: InactiveFiveAxisRepairArgs,
  execute?: (
    args: InactiveFiveAxisRepairArgs,
    query: InactiveFiveAxisRepairQuery
  ) => {
    rows: Array<Record<string, unknown>>;
    changes: number;
    rowsWritten: number;
  }
): Record<string, unknown>;
