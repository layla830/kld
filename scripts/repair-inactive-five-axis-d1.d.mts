export interface InactiveFiveAxisRepairArgs {
  db: string;
  namespace: string;
  limit: number;
  remote: boolean;
  apply: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export interface InactiveFiveAxisRepairQuery {
  name: "stale-axis-runs";
  sql: string;
}

export function usage(): string;
export function parseRepairArgs(argv: string[]): InactiveFiveAxisRepairArgs;
export function buildRepairDryRunQuery(input: {
  namespace: string;
  limit: number;
}): InactiveFiveAxisRepairQuery;
export function buildRepairApplyQuery(input: {
  namespace: string;
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
