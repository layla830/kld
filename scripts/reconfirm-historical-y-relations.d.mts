export interface HistoricalYReconfirmationArgs {
  remote: boolean;
  manifestPath: string;
  offset: number;
  limit: number;
  apiUrl: string;
  apiKey: string;
  apply: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export function usage(): string;
export function parseHistoricalYReconfirmationArgs(
  argv: string[],
  environment?: Record<string, string | undefined>
): HistoricalYReconfirmationArgs;
export function loadHistoricalYReconfirmationPlan(
  manifest: Record<string, unknown>,
  offset: number,
  limit: number
): {
  namespace: string;
  manifestId: string;
  total: number;
  offset: number;
  selected: number;
  remaining: number;
  relationIds: string[];
  relationIdsSha256: string | null;
  batchId: string | null;
};
export function runHistoricalYReconfirmationCommand(
  args: HistoricalYReconfirmationArgs,
  plan: ReturnType<typeof loadHistoricalYReconfirmationPlan>,
  fetchImpl?: typeof fetch
): Promise<Record<string, unknown>>;
