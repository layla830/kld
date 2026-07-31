export interface HistoricalRelationAuditArgs {
  db: string;
  namespace: string;
  pageSize: number;
  output: string | null;
  remote: boolean;
  help: boolean;
}

export function usage(): string;
export function parseHistoricalRelationAuditArgs(
  argv: string[]
): HistoricalRelationAuditArgs;
export function runHistoricalRelationAudit(
  args: HistoricalRelationAuditArgs,
  execute?: (
    args: HistoricalRelationAuditArgs,
    query: { name: string; sql: string }
  ) => Array<Record<string, unknown>>
): ReturnType<
  typeof import("./historical-relation-governance.mjs").buildHistoricalRelationManifest
>;
