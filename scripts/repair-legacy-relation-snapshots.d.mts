export {
  assertReadOnlyLegacyRelationSnapshotQuery,
  buildLegacyRelationSnapshotApplyQuery,
  buildLegacyRelationSnapshotDryRunQuery
} from "./legacy-relation-snapshot-normalization.mjs";

import type {
  LegacyRelationSnapshotQuery
} from "./legacy-relation-snapshot-normalization.mjs";

export interface LegacyRelationSnapshotRepairArgs {
  db: string;
  namespace: string;
  limit: number;
  remote: boolean;
  apply: boolean;
  confirm: string;
  json: boolean;
  help: boolean;
}

export interface LegacyRelationSnapshotExecutionResult {
  rows: Array<Record<string, unknown>>;
  changes: number;
  rowsWritten: number;
}

export interface LegacyRelationSnapshotRepairReport {
  schema_version: number;
  mode: "dry_run" | "apply";
  namespace: string;
  limit: number;
  has_more: boolean;
  [key: string]: unknown;
}

export function usage(): string;

export function parseLegacyRelationSnapshotRepairArgs(
  argv: string[]
): LegacyRelationSnapshotRepairArgs;

export function runLegacyRelationSnapshotRepair(
  args: LegacyRelationSnapshotRepairArgs,
  execute?: (
    args: LegacyRelationSnapshotRepairArgs,
    query: LegacyRelationSnapshotQuery
  ) => LegacyRelationSnapshotExecutionResult
): LegacyRelationSnapshotRepairReport;
