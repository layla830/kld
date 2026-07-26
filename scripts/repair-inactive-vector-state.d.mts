export interface InactiveVectorRepairArgs {
  db: string;
  namespace: string;
  limit: number;
  remote: boolean;
  apply: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export interface InactiveVectorRepairQuery {
  name: "inactive-vector-state";
  sql: string;
}

export function usage(): string;
export function parseVectorRepairArgs(argv: string[]): InactiveVectorRepairArgs;
export function buildVectorRepairDryRunQuery(input: {
  namespace: string;
  limit: number;
}): InactiveVectorRepairQuery;
export function buildVectorRepairApplyQuery(input: {
  namespace: string;
  limit: number;
}): InactiveVectorRepairQuery;
export function assertReadOnlyVectorRepairQuery(query: InactiveVectorRepairQuery): void;
export function runInactiveVectorRepair(
  args: InactiveVectorRepairArgs,
  execute?: (
    args: InactiveVectorRepairArgs,
    query: InactiveVectorRepairQuery
  ) => {
    rows: Array<Record<string, unknown>>;
    changes: number;
    rowsWritten: number;
  }
): Record<string, unknown>;
