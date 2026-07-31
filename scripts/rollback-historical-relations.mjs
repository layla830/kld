#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
  DELETE_WRANGLER_FILE_PACKAGE
} from "./delete-historical-relations.mjs";
import {
  buildHistoricalRelationRestorableRowsQuery,
  buildHistoricalRelationRollbackBatchSql,
  buildHistoricalRelationRollbackFinalizeSql,
  buildHistoricalRelationRollbackOverviewQuery
} from "../src/memory/historicalRelationRollbackSql.js";

const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export function usage() {
  return `Usage:
  npm run rollback:historical-relations -- --remote --manifest <path> --cohort stale_endpoint [options]

Options:
  --remote              Required. Target the configured remote D1 database.
  --manifest <path>     Required. The exact verified Phase-1 manifest JSON.
  --cohort <name>       Required; must be stale_endpoint.
  --db <name>           D1 database name. Default: ${DEFAULT_DB}
  --limit <n>           Maximum restores in one apply. Default: ${DEFAULT_LIMIT}; max: ${MAX_LIMIT}
  --apply               Run one bounded, idempotent restore batch.
  --confirm <id>        Required for --apply; exact manifest_id.
  --json                Emit machine-readable JSON.

Default mode is read-only. Apply restores only relation rows attributed to
this governance ledger, never overwrites a live relation identity, never
loops, and requires:
  HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}`;
}

export function parseHistoricalRelationRollbackArgs(
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
    else if (arg === "--manifest") {
      args.manifestPath = String(argv[++index] ?? "").trim();
    } else if (arg === "--cohort") {
      args.cohort = String(argv[++index] ?? "").trim();
    } else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--confirm") {
      args.confirm = String(argv[++index] ?? "").trim();
    } else throw new Error(`Unknown argument: ${arg}`);
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

function assertManifestIdentity(state, descriptor) {
  if (!state) throw new Error("historical_relation_rollback_manifest_missing");
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
      throw new Error(`historical_relation_rollback_manifest_conflict:${field}`);
    }
  }
}

function normalizeOverview(row = {}) {
  return {
    ledger_count: Number(row.ledger_count ?? 0),
    restored: Number(row.restored ?? 0),
    restorable: Number(row.restorable ?? 0),
    conflict: Number(row.conflict ?? 0)
  };
}

export function runHistoricalRelationRollback(
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
  assertManifestIdentity(state, plan.descriptor);
  const overview = normalizeOverview(execute.query(
    args,
    buildHistoricalRelationRollbackOverviewQuery(plan.descriptor.manifest_id)
  ).rows[0]);
  const classified = overview.restored
    + overview.restorable
    + overview.conflict;
  if (
    overview.ledger_count !== Number(state.deleted_relation_count ?? 0)
    || classified !== overview.ledger_count
  ) {
    throw new Error("historical_relation_rollback_ledger_count_invalid");
  }
  if (overview.conflict > 0) {
    throw new Error("historical_relation_rollback_conflict_detected");
  }
  const selectedRows = execute.query(
    args,
    buildHistoricalRelationRestorableRowsQuery(
      plan.descriptor.manifest_id,
      args.limit
    )
  ).rows;
  const baseReport = {
    schema_version: 1,
    mode: args.apply ? "apply" : "dry_run",
    manifest_id: plan.descriptor.manifest_id,
    remote_status: state.status,
    ...overview,
    selected: selectedRows.length,
    selected_relation_ids: selectedRows.map((row) => row.relation_id)
  };
  if (!args.apply) return { ...baseReport, changed: 0 };
  if (!["delete_in_progress", "deleted", "rolled_back"].includes(
    String(state.status)
  )) {
    throw new Error(
      `historical_relation_rollback_manifest_not_restorable:${state.status}`
    );
  }
  if (overview.ledger_count < 1) {
    throw new Error("historical_relation_rollback_ledger_empty");
  }
  if (String(state.status) === "rolled_back") {
    return { ...baseReport, changed: 0 };
  }
  const restoredAt = new Date().toISOString();
  const sql = selectedRows.length > 0
    ? buildHistoricalRelationRollbackBatchSql({
        descriptor: plan.descriptor,
        rows: selectedRows,
        restoredAt
      })
    : `${buildHistoricalRelationRollbackFinalizeSql(
        plan.descriptor,
        restoredAt
      )};\n`;
  const applied = execute.file(
    args,
    sql,
    "historical_relation_rollback_batch"
  );
  const afterState = execute.query(
    args,
    buildHistoricalRelationManifestStateQuery(plan.descriptor.manifest_id)
  ).rows[0] ?? null;
  assertManifestIdentity(afterState, plan.descriptor);
  const afterOverview = normalizeOverview(execute.query(
    args,
    buildHistoricalRelationRollbackOverviewQuery(plan.descriptor.manifest_id)
  ).rows[0]);
  if (
    afterOverview.conflict > 0
    || afterOverview.restored !== overview.restored + selectedRows.length
  ) {
    throw new Error("historical_relation_rollback_batch_mismatch");
  }
  return {
    ...baseReport,
    remote_status: afterState.status,
    ...afterOverview,
    changed: applied.changes
  };
}

async function main() {
  const args = parseHistoricalRelationRollbackArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(args.manifestPath), "utf8")
  );
  const plan = loadHistoricalRelationSnapshotPlan(manifest, "stale_endpoint");
  const report = runHistoricalRelationRollback(args, plan);
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
