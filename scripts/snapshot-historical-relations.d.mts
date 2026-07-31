export interface HistoricalRelationSnapshotArgs {
  db: string;
  manifestPath: string;
  cohort: "stale_endpoint" | "eligible_unproven" | "";
  limit: number;
  remote: boolean;
  apply: boolean;
  verify: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export function usage(): string;
export function parseHistoricalRelationSnapshotArgs(
  argv: string[]
): HistoricalRelationSnapshotArgs;
export function loadHistoricalRelationSnapshotPlan(
  manifest: Record<string, unknown>,
  cohort: "stale_endpoint" | "eligible_unproven"
): {
  descriptor: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
};
export function buildHistoricalRelationManifestInsertSql(
  descriptor: Record<string, unknown>
): string;
export function buildHistoricalRelationSnapshotInsertSql(
  descriptor: Record<string, unknown>,
  row: Record<string, unknown>,
  snapshottedAt: string
): string;
export function buildHistoricalRelationSnapshotBatchStatements(
  descriptor: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  snapshottedAt: string
): string[];
export function buildHistoricalRelationSnapshotBatchSql(
  descriptor: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  snapshottedAt: string
): string;
export function buildHistoricalRelationManifestStateQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationSnapshotIdsQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationSnapshotRowsQuery(
  manifestId: string
): { name: string; sql: string };
export function buildHistoricalRelationVerifySql(
  descriptor: Record<string, unknown>,
  verifiedAt: string
): string;
export function resolveHistoricalRelationWranglerInvocation(
  environment?: Record<string, string | undefined>,
  useFilePackage?: boolean
): { command: string; prefixArgs: string[] };
export function runHistoricalRelationSnapshot(
  args: HistoricalRelationSnapshotArgs,
  plan: {
    descriptor: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
  },
  execute?: {
    query: (
      args: HistoricalRelationSnapshotArgs,
      query: { name: string; sql: string }
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
    file: (
      args: HistoricalRelationSnapshotArgs,
      sql: string
    ) => { rows: Array<Record<string, unknown>>; changes: number; rowsWritten: number };
  }
): Record<string, unknown>;
