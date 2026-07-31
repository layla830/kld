import type {
  HistoricalRelationDeleteArgs
} from "./delete-historical-relations.mjs";

export function usage(): string;
export function parseHistoricalRelationRollbackArgs(
  argv: string[],
  environment?: Record<string, string | undefined>
): HistoricalRelationDeleteArgs;
export function runHistoricalRelationRollback(
  args: HistoricalRelationDeleteArgs,
  plan: {
    descriptor: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
  },
  execute?: {
    query: (
      args: HistoricalRelationDeleteArgs,
      query: { name: string; sql: string }
    ) => {
      rows: Array<Record<string, unknown>>;
      changes: number;
      rowsWritten: number;
    };
    file: (
      args: HistoricalRelationDeleteArgs,
      sql: string,
      name?: string
    ) => {
      rows: Array<Record<string, unknown>>;
      changes: number;
      rowsWritten: number;
    };
  }
): Record<string, unknown>;
