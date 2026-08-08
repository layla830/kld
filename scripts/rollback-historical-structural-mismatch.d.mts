export interface HistoricalStructuralRollbackArgs {
  db: string;
  manifestPath: string;
  selectionPath: string;
  remote: boolean;
  apply: boolean;
  confirm: string;
  approveSelection: string;
  json: boolean;
  help: boolean;
}

export interface HistoricalStructuralRollbackPlan {
  descriptor: Record<string, unknown> & { manifest_id: string };
  rows: Array<Record<string, unknown>>;
  relationIds: string[];
  batchSha256: string;
}

export function usage(): string;
export function parseHistoricalStructuralRollbackArgs(
  argv: string[],
  environment?: Record<string, string | undefined>
): HistoricalStructuralRollbackArgs;
export function runHistoricalStructuralRollback(
  args: HistoricalStructuralRollbackArgs,
  plan: HistoricalStructuralRollbackPlan,
  execute?: {
    query: (
      args: HistoricalStructuralRollbackArgs,
      query: { name: string; sql: string }
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
    file: (
      args: HistoricalStructuralRollbackArgs,
      sql: string,
      name?: string
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
  }
): Record<string, unknown>;
