export interface HistoricalYReconfirmationArgs {
  remote: boolean;
  manifestPath: string;
  selectionPath: string;
  offset: number;
  limit: number;
  offsetProvided: boolean;
  limitProvided: boolean;
  apiUrl: string;
  apiKey: string;
  apply: boolean;
  confirm: string;
  approveSelection: string;
  json: boolean;
  help: boolean;
}

export function usage(): string;
export function parseHistoricalYReconfirmationArgs(
  argv: string[],
  environment?: Record<string, string | undefined>
): HistoricalYReconfirmationArgs;
export interface HistoricalYReconfirmationPlan {
  namespace: string;
  manifestId: string;
  total: number;
  skipped_origin_split: number;
  offset: number | null;
  selected: number;
  remaining: number;
  relationIds: string[];
  relationIdsSha256: string | null;
  batchId: string | null;
  selection: boolean;
}
export function loadHistoricalYReconfirmationPlan(
  manifest: Record<string, unknown>,
  offset: number,
  limit: number
): HistoricalYReconfirmationPlan;
export function loadHistoricalYSelectionPlan(
  manifest: Record<string, unknown>,
  selection: Record<string, unknown>
): HistoricalYReconfirmationPlan;
export function runHistoricalYReconfirmationCommand(
  args: HistoricalYReconfirmationArgs,
  plan: HistoricalYReconfirmationPlan,
  fetchImpl?: typeof fetch
): Promise<Record<string, unknown>>;
