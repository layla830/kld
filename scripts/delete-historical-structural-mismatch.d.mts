export interface HistoricalStructuralDeleteArgs {
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

export interface HistoricalStructuralDeletePlan {
  descriptor: Record<string, unknown> & { manifest_id: string };
  rows: Array<Record<string, unknown>>;
  relationIds: string[];
  batchSha256: string;
}

export function usage(): string;
export function parseHistoricalStructuralDeleteArgs(
  argv: string[],
  environment?: Record<string, string | undefined>
): HistoricalStructuralDeleteArgs;
export function loadHistoricalStructuralDeletePlan(
  manifest: Record<string, unknown>,
  selection: Record<string, unknown>
): HistoricalStructuralDeletePlan;
export function runHistoricalStructuralDelete(
  args: HistoricalStructuralDeleteArgs,
  plan: HistoricalStructuralDeletePlan,
  execute?: {
    query: (
      args: HistoricalStructuralDeleteArgs,
      query: { name: string; sql: string }
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
    file: (
      args: HistoricalStructuralDeleteArgs,
      sql: string,
      name?: string
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
  }
): Record<string, unknown>;
