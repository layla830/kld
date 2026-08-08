#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildHistoricalRelationManifestStateQuery
} from "./snapshot-historical-relations.mjs";
import {
  executeHistoricalRelationQuery,
  executeHistoricalRelationSqlFile
} from "./historical-relation-d1-runtime.mjs";
import { DELETE_WRANGLER_FILE_PACKAGE } from "./delete-historical-relations.mjs";
import { loadHistoricalStructuralDeletePlan } from "./delete-historical-structural-mismatch.mjs";
import {
  buildHistoricalStructuralRestorableRowsQuery,
  buildHistoricalStructuralRollbackBatchSql,
  buildHistoricalStructuralRollbackOverviewQuery
} from "../src/memory/historicalStructuralMismatchRollbackSql.js";

const DEFAULT_DB = "companion_memory_proxy";

export function usage() {
  return `Usage:
  npm run rollback:historical-structural-mismatch -- --remote --manifest <path> --selection <path> [options]

Apply requires --confirm <manifest_id>, --approve-selection <batch_sha256>,
and HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}.
Default mode is SELECT-only; one command restores at most 10 selected rows.`;
}

export function parseHistoricalStructuralRollbackArgs(argv, environment = process.env) {
  const args = {
    db: DEFAULT_DB,
    manifestPath: "",
    selectionPath: "",
    remote: false,
    apply: false,
    confirm: "",
    approveSelection: "",
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
    else if (arg === "--selection") args.selectionPath = String(argv[++index] ?? "").trim();
    else if (arg === "--confirm") args.confirm = String(argv[++index] ?? "").trim();
    else if (arg === "--approve-selection") args.approveSelection = String(argv[++index] ?? "").trim().toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required.");
  if (!args.db) throw new Error("--db requires a value.");
  if (!args.manifestPath) throw new Error("--manifest requires a value.");
  if (!args.selectionPath) throw new Error("--selection requires a value.");
  if (!args.apply && (args.confirm || args.approveSelection)) {
    throw new Error("--confirm and --approve-selection are only valid with --apply.");
  }
  if (args.apply && (!args.confirm || !args.approveSelection)) {
    throw new Error("--apply requires --confirm and --approve-selection.");
  }
  if (
    args.apply
    && environment.HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE !== DELETE_WRANGLER_FILE_PACKAGE
  ) {
    throw new Error(`--apply requires HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}`);
  }
  return args;
}

function assertManifest(state, descriptor) {
  if (!state) throw new Error("historical_structural_rollback_manifest_missing");
  for (const field of [
    "manifest_id", "namespace", "lifecycle_cohort", "selection_predicate_version",
    "expected_relation_count", "expected_relations_sha256", "expected_selection_sha256"
  ]) {
    if (String(state[field]) !== String(descriptor[field])) {
      throw new Error(`historical_structural_rollback_manifest_conflict:${field}`);
    }
  }
  if (state.lifecycle_cohort !== "eligible_unproven") {
    throw new Error("historical_structural_rollback_cohort_forbidden");
  }
}

function normalize(row = {}) {
  return {
    ledger_count: Number(row.ledger_count ?? 0),
    restored: Number(row.restored ?? 0),
    restorable: Number(row.restorable ?? 0),
    conflict: Number(row.conflict ?? 0)
  };
}

export function runHistoricalStructuralRollback(args, plan, execute = {
  query: executeHistoricalRelationQuery,
  file: executeHistoricalRelationSqlFile
}) {
  if (args.apply && args.confirm !== plan.descriptor.manifest_id) {
    throw new Error(`--apply requires --confirm ${plan.descriptor.manifest_id}`);
  }
  if (args.apply && args.approveSelection !== plan.batchSha256) {
    throw new Error(`--apply requires --approve-selection ${plan.batchSha256}`);
  }
  const state = execute.query(args, buildHistoricalRelationManifestStateQuery(
    plan.descriptor.manifest_id
  )).rows[0] ?? null;
  assertManifest(state, plan.descriptor);
  const overview = normalize(execute.query(args, buildHistoricalStructuralRollbackOverviewQuery(
    plan.descriptor.manifest_id,
    plan.relationIds
  )).rows[0]);
  const classified = overview.restored + overview.restorable + overview.conflict;
  if (overview.ledger_count !== plan.relationIds.length || classified !== overview.ledger_count) {
    throw new Error("historical_structural_rollback_ledger_count_invalid");
  }
  if (overview.conflict > 0) throw new Error("historical_structural_rollback_conflict_detected");
  const selectedRows = execute.query(args, buildHistoricalStructuralRestorableRowsQuery(
    plan.descriptor.manifest_id,
    plan.relationIds
  )).rows;
  const base = {
    schema_version: 1,
    mode: args.apply ? "apply" : "dry_run",
    manifest_id: plan.descriptor.manifest_id,
    batch_sha256: plan.batchSha256,
    relation_ids: plan.relationIds,
    remote_status: state.status,
    ...overview,
    selected: selectedRows.length
  };
  if (!args.apply) return { ...base, changed: 0 };
  if (!["delete_in_progress", "deleted", "rolled_back"].includes(String(state.status))) {
    throw new Error(`historical_structural_rollback_manifest_not_restorable:${state.status}`);
  }
  if (overview.restored === plan.relationIds.length) {
    return { ...base, replay: true, changed: 0 };
  }
  if (selectedRows.length !== plan.relationIds.length - overview.restored) {
    throw new Error("historical_structural_rollback_candidate_count_invalid");
  }
  const applied = execute.file(args, buildHistoricalStructuralRollbackBatchSql({
    descriptor: plan.descriptor,
    rows: selectedRows,
    restoredAt: new Date().toISOString()
  }), "historical_structural_rollback_batch");
  const afterState = execute.query(args, buildHistoricalRelationManifestStateQuery(
    plan.descriptor.manifest_id
  )).rows[0] ?? null;
  assertManifest(afterState, plan.descriptor);
  const after = normalize(execute.query(args, buildHistoricalStructuralRollbackOverviewQuery(
    plan.descriptor.manifest_id,
    plan.relationIds
  )).rows[0]);
  if (after.conflict > 0 || after.restored !== overview.restored + selectedRows.length) {
    throw new Error("historical_structural_rollback_batch_mismatch");
  }
  return { ...base, remote_status: afterState.status, ...after, changed: applied.changes };
}

async function main() {
  const args = parseHistoricalStructuralRollbackArgs(process.argv.slice(2));
  if (args.help) return console.log(usage());
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifestPath), "utf8"));
  const selection = JSON.parse(fs.readFileSync(path.resolve(args.selectionPath), "utf8"));
  const plan = loadHistoricalStructuralDeletePlan(manifest, selection);
  const report = runHistoricalStructuralRollback(args, plan);
  console.log(args.json ? JSON.stringify(report, null, 2) : report);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
