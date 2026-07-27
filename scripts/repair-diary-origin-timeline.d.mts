export interface DiaryOriginRepairArgs {
  db: string;
  namespace: string;
  limit: number;
  remote: boolean;
  apply: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export interface DiaryOriginRepairQuery {
  name: string;
  sql: string;
}

export function usage(): string;
export function parseDiaryOriginRepairArgs(argv: string[]): DiaryOriginRepairArgs;
export function buildDiaryOriginRepairDryRunQuery(input: {
  namespace: string;
  limit: number;
}): DiaryOriginRepairQuery;
export function buildDiaryOriginRepairApplyQueries(input: {
  namespace: string;
  limit: number;
}): DiaryOriginRepairQuery[];
export function assertReadOnlyDiaryOriginRepairQuery(query: DiaryOriginRepairQuery): void;
export function runDiaryOriginRepair(
  args: DiaryOriginRepairArgs,
  execute?: (
    args: DiaryOriginRepairArgs,
    query: DiaryOriginRepairQuery
  ) => {
    rows: Array<Record<string, unknown>>;
    changes: number;
    rowsWritten: number;
  }
): Record<string, unknown>;
