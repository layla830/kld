#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  buildHistoricalRelationManifestStateQuery,
  loadHistoricalRelationSnapshotPlan
} from "./snapshot-historical-relations.mjs";
import {
  executeHistoricalRelationQuery,
  executeHistoricalRelationSqlFile
} from "./historical-relation-d1-runtime.mjs";
import {
  buildHistoricalRelationDeletableRowsQuery,
  buildHistoricalRelationDeleteBatchSql,
  buildHistoricalRelationDeleteOverviewQuery
} from "../src/memory/historicalRelationDeleteSql.js";

const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
export const DELETE_WRANGLER_FILE_PACKAGE = "wrangler@4.115.0";

export function usage() {
  return `Usage:
  npm run delete:historical-relations -- --remote --manifest <path> --cohort stale_endpoint [options]

Options:
  --remote              Required. Target the configured remote D1 database.
  --manifest <path>     Required. The exact verified Phase-1 manifest JSON.
  --cohort <name>       Required; must be stale_endpoint.
  --db <name>           D1 database name. Default: ${DEFAULT_DB}
  --limit <n>           Maximum relation deletes in one apply. Default: ${DEFAULT_LIMIT}; max: ${MAX_LIMIT}
  --apply               Run one bounded, idempotent delete batch.
  --confirm <id>        Required for --apply; exact verified manifest_id.
  --json                Emit machine-readable JSON.
  --help                Show this help.

Default mode is read-only. --apply never loops. Every delete requires an
immutable verified snapshot, byte-for-byte live relation equality, unchanged
endpoint selection state, and a durable per-relation deletion ledger row.

Apply also requires:
  HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}

If post-apply attribution verification fails, treat the bounded batch as
possibly partially committed. Run dry-run diagnostics; do not blindly retry.`;
}

export function parseHistoricalRelationDeleteArgs(
  argv,
  environment = process.env
) {
  const args = {
    db: DEFAULT_DB,
    manifestPath: "",
    cohort: "",
    limit: DEFAULT_LIMIT,
    remote: false,
    apply: false,
    confirm: "",
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--db") args.db = String(argv[++index] ?? "").trim();
    else if (arg === "--manifest") args.manifestPath = String(argv[++index] ?? "").trim();
    else if (arg === "--cohort") args.cohort = String(argv[++index] ?? "").trim();
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--confirm") args.confirm = String(argv[++index] ?? "").trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required.");
  if (!args.db) throw new Error("--db requires a value.");
  if (!args.manifestPath) throw new Error("--manifest requires a value.");
  if (args.cohort !== "stale_endpoint") {
    throw new Error("--cohort must be stale_endpoint.");
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  if (!args.apply && args.confirm) {
    throw new Error("--confirm is only valid with --apply.");
  }
  if (
    args.apply
    && environment.HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE
      !== DELETE_WRANGLER_FILE_PACKAGE
  ) {
    throw new Error(
      "--apply requires "
      + "HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE="
      + DELETE_WRANGLER_FILE_PACKAGE
    );
  }
  return args;
}

export function buildHistoricalRelationDeleteBatchId(
  manifestId,
  batchOrdinal,
  rows
) {
  const canonical = JSON.stringify([
    manifestId,
    batchOrdinal,
    rows.map((row) => row.relation_id)
  ]);
  return `hrd_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function assertDeleteManifestState(state, descriptor) {
  if (!state) {
    throw new Error("historical_relation_delete_manifest_missing");
  }
  for (const field of [
    "manifest_id",
    "namespace",
    "lifecycle_cohort",
    "selection_predicate_version",
    "expected_relation_count",
    "expected_relations_sha256",
    "expected_selection_sha256"
  ]) {
    if (String(state[field]) !== String(descriptor[field])) {
      throw new Error(`historical_relation_delete_manifest_conflict:${field}`);
    }
  }
  if (state.lifecycle_cohort !== "stale_endpoint") {
    throw new Error("historical_relation_delete_cohort_forbidden");
  }
}

function normalizeOverview(row = {}) {
  return {
    snapshot_count: Number(row.snapshot_count ?? 0),
    attributed_deleted: Number(row.attributed_deleted ?? 0),
    missing_unattributed: Number(row.missing_unattributed ?? 0),
    drifted: Number(row.drifted ?? 0),
    deletable: Number(row.deletable ?? 0)
  };
}

function assertDeleteApplyPreconditions(state, overview, expectedCount) {
  const status = String(state.status);
  if (!["verified", "delete_in_progress", "deleted"].includes(status)) {
    throw new Error(
      `historical_relation_delete_manifest_not_deletable:${status}`
    );
  }
  const classifiedCount = overview.attributed_deleted
    + overview.missing_unattributed
    + overview.drifted
    + overview.deletable;
  if (
    overview.snapshot_count !== expectedCount
    || classifiedCount !== expectedCount
  ) {
    throw new Error("historical_relation_delete_snapshot_count_invalid");
  }
  if (
    overview.attributed_deleted
      !== Number(state.deleted_relation_count ?? 0)
  ) {
    throw new Error("historical_relation_delete_ledger_count_invalid");
  }
  if (overview.missing_unattributed > 0) {
    throw new Error("historical_relation_delete_unattributed_missing");
  }
  if (overview.drifted > 0) {
    throw new Error("historical_relation_delete_drift_detected");
  }
  if (
    status === "deleted"
    && overview.attributed_deleted !== expectedCount
  ) {
    throw new Error("historical_relation_delete_deleted_state_invalid");
  }
}

export function runHistoricalRelationDelete(
  args,
  plan,
  execute = {
    query: executeHistoricalRelationQuery,
    file: executeHistoricalRelationSqlFile
  }
) {
  if (args.apply && args.confirm !== plan.descriptor.manifest_id) {
    throw new Error(
      `--apply requires --confirm ${plan.descriptor.manifest_id}`
    );
  }
  const state = execute.query(
    args,
    buildHistoricalRelationManifestStateQuery(plan.descriptor.manifest_id)
  ).rows[0] ?? null;
  assertDeleteManifestState(state, plan.descriptor);
  const overview = normalizeOverview(execute.query(
    args,
    buildHistoricalRelationDeleteOverviewQuery(plan.descriptor.manifest_id)
  ).rows[0]);
  if (args.apply) {
    assertDeleteApplyPreconditions(
      state,
      overview,
      Number(plan.descriptor.expected_relation_count)
    );
  }
  const selectedRows = execute.query(
    args,
    buildHistoricalRelationDeletableRowsQuery(
      plan.descriptor.manifest_id,
      args.limit
    )
  ).rows;
  const baseReport = {
    schema_version: 1,
    mode: args.apply ? "apply" : "dry_run",
    manifest_id: plan.descriptor.manifest_id,
    lifecycle_cohort: "stale_endpoint",
    remote_status: state.status,
    expected_relation_count: plan.descriptor.expected_relation_count,
    ...overview,
    selected: selectedRows.length,
    selected_relation_ids: selectedRows.map((row) => row.relation_id)
  };
  if (!args.apply || selectedRows.length === 0) {
    if (
      args.apply
      && String(state.status) !== "deleted"
      && overview.attributed_deleted
        !== Number(plan.descriptor.expected_relation_count)
    ) {
      throw new Error("historical_relation_delete_no_safe_candidates");
    }
    return { ...baseReport, changed: 0 };
  }
  const batchOrdinal = Number(state.delete_batches_completed ?? 0) + 1;
  const batchId = buildHistoricalRelationDeleteBatchId(
    plan.descriptor.manifest_id,
    batchOrdinal,
    selectedRows
  );
  const deletedAt = new Date().toISOString();
  const applied = execute.file(
    args,
    buildHistoricalRelationDeleteBatchSql({
      descriptor: plan.descriptor,
      rows: selectedRows,
      batchId,
      batchOrdinal,
      deletedAt
    }),
    "historical_relation_delete_batch"
  );
  const afterState = execute.query(
    args,
    buildHistoricalRelationManifestStateQuery(plan.descriptor.manifest_id)
  ).rows[0] ?? null;
  assertDeleteManifestState(afterState, plan.descriptor);
  const afterOverview = normalizeOverview(execute.query(
    args,
    buildHistoricalRelationDeleteOverviewQuery(plan.descriptor.manifest_id)
  ).rows[0]);
  assertDeleteApplyPreconditions(
    afterState,
    afterOverview,
    Number(plan.descriptor.expected_relation_count)
  );
  if (
    afterOverview.attributed_deleted
      !== overview.attributed_deleted + selectedRows.length
  ) {
    throw new Error("historical_relation_delete_batch_attribution_mismatch");
  }
  return {
    ...baseReport,
    remote_status: afterState.status,
    ...afterOverview,
    batch_id: batchId,
    batch_ordinal: batchOrdinal,
    ledger_count: Number(afterState.deleted_relation_count ?? 0),
    delete_batches_completed: Number(
      afterState.delete_batches_completed ?? 0
    ),
    changed: applied.changes
  };
}

async function main() {
  const args = parseHistoricalRelationDeleteArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(args.manifestPath), "utf8")
  );
  const plan = loadHistoricalRelationSnapshotPlan(manifest, "stale_endpoint");
  const report = runHistoricalRelationDelete(args, plan);
  console.log(args.json ? JSON.stringify(report, null, 2) : report);
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
