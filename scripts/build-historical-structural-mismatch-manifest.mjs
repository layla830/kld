#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertReadOnlyHistoricalRelationQueries,
  buildHistoricalRelationManifest,
  buildHistoricalRelationSubsetSummary,
  buildHistoricalStructuralMismatchRowsQuery
} from "./historical-relation-governance.mjs";
import {
  executeHistoricalRelationQuery
} from "./historical-relation-d1-runtime.mjs";

const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_NAMESPACE = "default";

export function usage() {
  return `Usage:
  npm run manifest:historical-structural-mismatch -- --remote --relation-ids <path> --output <path> [options]

Options:
  --remote              Required. Read the configured remote D1 database.
  --relation-ids <path> Required JSON array or {"relation_ids": [...]}.
  --output <path>       Required manifest path; refuses overwrite.
  --db <name>           D1 database name. Default: ${DEFAULT_DB}
  --namespace <name>    Memory namespace. Default: ${DEFAULT_NAMESPACE}
  --help                Show this help.

This command performs one SELECT and never emits memory content, fact_key, or
thread values.`;
}

export function parseHistoricalStructuralManifestArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    namespace: DEFAULT_NAMESPACE,
    relationIdsPath: "",
    output: "",
    remote: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--db") args.db = String(argv[++index] ?? "").trim();
    else if (arg === "--namespace") args.namespace = String(argv[++index] ?? "").trim();
    else if (arg === "--relation-ids") args.relationIdsPath = String(argv[++index] ?? "").trim();
    else if (arg === "--output") args.output = String(argv[++index] ?? "").trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required.");
  if (!args.db) throw new Error("--db requires a value.");
  if (!args.namespace) throw new Error("--namespace requires a value.");
  if (!args.relationIdsPath) throw new Error("--relation-ids requires a value.");
  if (!args.output) throw new Error("--output requires a value.");
  return args;
}

export function loadHistoricalStructuralRelationIds(value) {
  const values = Array.isArray(value) ? value : value?.relation_ids;
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new Error("historical_structural_manifest_relation_ids_invalid");
  }
  const relationIds = values.map((item) => String(item).trim());
  if (relationIds.some((item) => !item) || new Set(relationIds).size !== relationIds.length) {
    throw new Error("historical_structural_manifest_relation_ids_invalid");
  }
  return relationIds;
}

export function runHistoricalStructuralManifest(args, relationIds, execute = executeHistoricalRelationQuery) {
  const query = buildHistoricalStructuralMismatchRowsQuery({
    namespace: args.namespace,
    relationIds
  });
  assertReadOnlyHistoricalRelationQueries([query]);
  const rows = execute(args, query).rows;
  if (rows.length !== relationIds.length) {
    throw new Error(`historical_structural_manifest_relation_count_mismatch:${rows.length}:${relationIds.length}`);
  }
  const returnedIds = new Set(rows.map((row) => String(row.id)));
  if (relationIds.some((id) => !returnedIds.has(id))) {
    throw new Error("historical_structural_manifest_relation_id_missing");
  }
  for (const row of rows) {
    if (
      row.lifecycle_cohort !== "eligible_unproven"
      || row.provenance_class !== "unproven_source"
      || !["same_fact_key", "in_thread"].includes(row.relation_type)
      || Number(row.structural_mismatch) !== 1
    ) {
      throw new Error(`historical_structural_manifest_row_not_mismatch:${row.id}`);
    }
  }
  return buildHistoricalRelationManifest({
    namespace: args.namespace,
    summaryRows: buildHistoricalRelationSubsetSummary(rows),
    rows
  });
}

async function main() {
  const args = parseHistoricalStructuralManifestArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const relationIds = loadHistoricalStructuralRelationIds(JSON.parse(
    fs.readFileSync(path.resolve(args.relationIdsPath), "utf8")
  ));
  const manifest = runHistoricalStructuralManifest(args, relationIds);
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  console.log(JSON.stringify({
    mode: "read_only",
    manifest_id: manifest.cohort_manifests.eligible_unproven.manifest_id,
    relation_count: manifest.relation_count,
    output: outputPath
  }, null, 2));
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
