export interface HistoricalRelationDeleteArgs {
  db: string;
  manifestPath: string;
  cohort: "stale_endpoint" | "";
  limit: number;
  remote: boolean;
  apply: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export const DELETE_WRANGLER_FILE_PACKAGE: "wrangler@4.115.0";

export function usage(): string;
export function parseHistoricalRelationDeleteArgs(
  argv: string[],
  environment?: Record<string, string | undefined>
): HistoricalRelationDeleteArgs;
export function buildHistoricalRelationDeleteBatchId(
  manifestId: string,
  batchOrdinal: number,
  rows: Array<Record<string, unknown>>
): string;
export function runHistoricalRelationDelete(
  args: HistoricalRelationDeleteArgs,
  plan: {
    descriptor: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
  },
  execute?: {
    query: (
      args: HistoricalRelationDeleteArgs,
      query: { name: string; sql: string }
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
    file: (
      args: HistoricalRelationDeleteArgs,
      sql: string,
      name?: string
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
  }
): Record<string, unknown>;
