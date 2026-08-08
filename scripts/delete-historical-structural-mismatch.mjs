#!/usr/bin/env node
import { createHash } from "node:crypto";
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
import { DELETE_WRANGLER_FILE_PACKAGE } from "./delete-historical-relations.mjs";
import {
  buildHistoricalStructuralDeletableRowsQuery,
  buildHistoricalStructuralDeleteBatchSql,
  buildHistoricalStructuralDeleteOverviewQuery
} from "../src/memory/historicalStructuralMismatchDeleteSql.js";

const DEFAULT_DB = "companion_memory_proxy";
const MAX_BATCH = 10;

export function usage() {
  return `Usage:
  npm run delete:historical-structural-mismatch -- --remote --manifest <path> --selection <path> [options]

Options:
  --remote                    Required. Target remote D1.
  --manifest <path>           Required dedicated eligible_unproven manifest.
  --selection <path>          Required explicit relation-ID selection (1-${MAX_BATCH}).
  --db <name>                 D1 database. Default: ${DEFAULT_DB}
  --apply                     Apply one bounded batch; default is SELECT-only.
  --confirm <manifest_id>     Required for apply.
  --approve-selection <sha>   Required for apply; exact batch_sha256.
  --json                      Emit JSON.

Apply never loops and requires HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}.`;
}

export function parseHistoricalStructuralDeleteArgs(argv, environment = process.env) {
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
  if (args.apply && !args.confirm) throw new Error("--apply requires --confirm.");
  if (args.apply && !args.approveSelection) {
    throw new Error("--apply requires --approve-selection.");
  }
  if (
    args.apply
    && environment.HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE !== DELETE_WRANGLER_FILE_PACKAGE
  ) {
    throw new Error(`--apply requires HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}`);
  }
  return args;
}

function batchSha256(manifestId, relationIds) {
  return createHash("sha256").update(JSON.stringify([
    manifestId,
    [...relationIds].sort()
  ])).digest("hex");
}

export function loadHistoricalStructuralDeletePlan(manifest, selection) {
  const snapshot = loadHistoricalRelationSnapshotPlan(manifest, "eligible_unproven");
  if (!selection || typeof selection !== "object" || selection.schema_version !== 1) {
    throw new Error("historical_structural_delete_selection_invalid");
  }
  if (selection.manifest_id !== snapshot.descriptor.manifest_id) {
    throw new Error("historical_structural_delete_selection_manifest_mismatch");
  }
  if (
    !Array.isArray(selection.relation_ids)
    || selection.relation_ids.length < 1
    || selection.relation_ids.length > MAX_BATCH
  ) {
    throw new Error("historical_structural_delete_selection_count_invalid");
  }
  const relationIds = selection.relation_ids.map((value) => String(value).trim());
  if (relationIds.some((value) => !value) || new Set(relationIds).size !== relationIds.length) {
    throw new Error("historical_structural_delete_selection_ids_invalid");
  }
  const candidates = new Set(snapshot.rows.filter((row) =>
    row.lifecycle_cohort === "eligible_unproven"
    && row.provenance_class === "unproven_source"
    && row.source_eligible === true
    && row.target_eligible === true
    && ["same_fact_key", "in_thread"].includes(row.relation_type)
  ).map((row) => row.id));
  if (
    snapshot.rows.length < 1
    || snapshot.rows.length > 100
    || candidates.size !== snapshot.rows.length
  ) {
    throw new Error("historical_structural_delete_manifest_not_dedicated");
  }
  if (relationIds.some((id) => !candidates.has(id))) {
    throw new Error("historical_structural_delete_selection_relation_forbidden");
  }
  const normalizedIds = [...relationIds].sort();
  const sha256 = batchSha256(snapshot.descriptor.manifest_id, normalizedIds);
  if (selection.batch_sha256 != null && String(selection.batch_sha256).toLowerCase() !== sha256) {
    throw new Error("historical_structural_delete_selection_sha256_mismatch");
  }
  return { ...snapshot, relationIds: normalizedIds, batchSha256: sha256 };
}

function assertManifest(state, descriptor) {
  if (!state) throw new Error("historical_structural_delete_manifest_missing");
  for (const field of [
    "manifest_id", "namespace", "lifecycle_cohort", "selection_predicate_version",
    "expected_relation_count", "expected_relations_sha256", "expected_selection_sha256"
  ]) {
    if (String(state[field]) !== String(descriptor[field])) {
      throw new Error(`historical_structural_delete_manifest_conflict:${field}`);
    }
  }
  if (state.lifecycle_cohort !== "eligible_unproven") {
    throw new Error("historical_structural_delete_cohort_forbidden");
  }
}

function normalizeOverview(row = {}) {
  return {
    snapshot_count: Number(row.snapshot_count ?? 0),
    attributed_deleted: Number(row.attributed_deleted ?? 0),
    missing_unattributed: Number(row.missing_unattributed ?? 0),
    drifted: Number(row.drifted ?? 0),
    now_confirmable: Number(row.now_confirmable ?? 0),
    now_confirmable_relation_ids: String(row.now_confirmable_relation_ids ?? "")
      .split(",").filter(Boolean),
    deletable: Number(row.deletable ?? 0)
  };
}

function assertSafeSelection(overview, selectedCount) {
  const classified = overview.attributed_deleted + overview.missing_unattributed
    + overview.drifted + overview.now_confirmable + overview.deletable;
  if (overview.snapshot_count !== selectedCount || classified !== selectedCount) {
    throw new Error("historical_structural_delete_snapshot_count_invalid");
  }
  if (overview.missing_unattributed > 0) {
    throw new Error("historical_structural_delete_unattributed_missing");
  }
  if (overview.drifted > 0) throw new Error("historical_structural_delete_drift_detected");
  if (overview.now_confirmable > 0) {
    throw new Error(`historical_structural_delete_now_confirmable:${overview.now_confirmable_relation_ids.join(",")}`);
  }
}

export function runHistoricalStructuralDelete(args, plan, execute = {
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
  const overview = normalizeOverview(execute.query(
    args,
    buildHistoricalStructuralDeleteOverviewQuery(plan.descriptor.manifest_id, plan.relationIds)
  ).rows[0]);
  assertSafeSelection(overview, plan.relationIds.length);
  const selectedRows = execute.query(args, buildHistoricalStructuralDeletableRowsQuery(
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
  if (!["verified", "delete_in_progress", "deleted"].includes(String(state.status))) {
    throw new Error(`historical_structural_delete_manifest_not_deletable:${state.status}`);
  }
  if (overview.attributed_deleted === plan.relationIds.length) {
    return { ...base, replay: true, changed: 0 };
  }
  if (selectedRows.length !== plan.relationIds.length - overview.attributed_deleted) {
    throw new Error("historical_structural_delete_candidate_count_invalid");
  }
  const batchOrdinal = Number(state.delete_batches_completed ?? 0) + 1;
  const batchId = `hrs_${plan.batchSha256.slice(0, 28)}_${batchOrdinal}`;
  const applied = execute.file(args, buildHistoricalStructuralDeleteBatchSql({
    descriptor: plan.descriptor,
    rows: selectedRows,
    batchId,
    batchOrdinal,
    deletedAt: new Date().toISOString()
  }), "historical_structural_delete_batch");
  const afterState = execute.query(args, buildHistoricalRelationManifestStateQuery(
    plan.descriptor.manifest_id
  )).rows[0] ?? null;
  assertManifest(afterState, plan.descriptor);
  const after = normalizeOverview(execute.query(
    args,
    buildHistoricalStructuralDeleteOverviewQuery(plan.descriptor.manifest_id, plan.relationIds)
  ).rows[0]);
  assertSafeSelection(after, plan.relationIds.length);
  if (after.attributed_deleted !== overview.attributed_deleted + selectedRows.length) {
    throw new Error("historical_structural_delete_batch_attribution_mismatch");
  }
  return {
    ...base,
    remote_status: afterState.status,
    ...after,
    batch_id: batchId,
    batch_ordinal: batchOrdinal,
    changed: applied.changes
  };
}

async function main() {
  const args = parseHistoricalStructuralDeleteArgs(process.argv.slice(2));
  if (args.help) return console.log(usage());
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifestPath), "utf8"));
  const selection = JSON.parse(fs.readFileSync(path.resolve(args.selectionPath), "utf8"));
  const report = runHistoricalStructuralDelete(args, loadHistoricalStructuralDeletePlan(
    manifest,
    selection
  ));
  console.log(args.json ? JSON.stringify(report, null, 2) : report);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
