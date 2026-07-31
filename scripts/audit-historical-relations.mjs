#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assertReadOnlyHistoricalRelationQueries,
  buildHistoricalRelationManifest,
  buildHistoricalRelationPageQuery,
  buildHistoricalRelationSummaryQuery
} from "./historical-relation-governance.mjs";

const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_NAMESPACE = "default";
const DEFAULT_PAGE_SIZE = 250;
const WRANGLER_ENTRY = path.join(
  process.cwd(),
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js"
);

export function usage() {
  return `Usage:
  npm run audit:historical-relations -- --remote [options]

Options:
  --remote              Required. Read the configured remote D1 database.
  --db <name>           D1 database name. Default: ${DEFAULT_DB}
  --namespace <name>    Memory namespace. Default: ${DEFAULT_NAMESPACE}
  --page-size <n>       Read-only page size, 1-500. Default: ${DEFAULT_PAGE_SIZE}
  --output <path>       Write the full immutable JSON manifest. Refuses overwrite.
  --help                Show this help.

This command is SELECT-only. It has no snapshot, repair, apply, update, or delete mode.
Without --output it prints only counts and hashes; relation rows stay out of stdout.`;
}

export function parseHistoricalRelationAuditArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    namespace: DEFAULT_NAMESPACE,
    pageSize: DEFAULT_PAGE_SIZE,
    output: null,
    remote: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--db") args.db = String(argv[++index] ?? "").trim();
    else if (arg === "--namespace") args.namespace = String(argv[++index] ?? "").trim();
    else if (arg === "--page-size") args.pageSize = Number(argv[++index]);
    else if (arg === "--output") args.output = String(argv[++index] ?? "").trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required for the production audit.");
  if (!args.db) throw new Error("--db requires a value.");
  if (!args.namespace) throw new Error("--namespace requires a value.");
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 500) {
    throw new Error("--page-size must be an integer between 1 and 500.");
  }
  if (args.output === "") throw new Error("--output requires a value.");
  return args;
}

function parseWranglerJson(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    const firstJson = text.indexOf("[");
    if (firstJson >= 0) return JSON.parse(text.slice(firstJson));
    throw new Error(`Could not parse wrangler JSON output: ${text.slice(0, 500)}`);
  }
}

function extractRows(result) {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item) => item?.results ?? []);
}

function executeReadOnlyQuery(args, query) {
  const result = spawnSync(process.execPath, [
    WRANGLER_ENTRY,
    "d1",
    "execute",
    args.db,
    "--remote",
    "--json",
    "--command",
    query.sql
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: path.join(
        process.cwd(),
        ".wrangler",
        "historical-relations-audit.log"
      )
    },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `historical relation audit query failed (${query.name}):\n`
      + `${result.error ? `${result.error.message}\n` : ""}`
      + `${result.stderr || result.stdout || "No output"}`
    );
  }
  return extractRows(parseWranglerJson(result.stdout));
}

export function runHistoricalRelationAudit(args, execute = executeReadOnlyQuery) {
  const summaryQuery = buildHistoricalRelationSummaryQuery({
    namespace: args.namespace
  });
  assertReadOnlyHistoricalRelationQueries([summaryQuery]);
  const summaryRows = execute(args, summaryQuery);
  const rows = [];
  let afterCreatedAt = null;
  let afterId = null;
  while (true) {
    const pageQuery = buildHistoricalRelationPageQuery({
      namespace: args.namespace,
      pageSize: args.pageSize,
      afterCreatedAt,
      afterId
    });
    assertReadOnlyHistoricalRelationQueries([pageQuery]);
    const page = execute(args, pageQuery);
    rows.push(...page);
    if (page.length < args.pageSize) break;
    const last = page.at(-1);
    const nextCreatedAt = String(last?.created_at ?? "");
    const nextId = String(last?.id ?? "");
    if (!nextCreatedAt || !nextId) {
      throw new Error("historical_relation_cursor_missing");
    }
    if (nextCreatedAt === afterCreatedAt && nextId === afterId) {
      throw new Error("historical_relation_cursor_did_not_advance");
    }
    afterCreatedAt = nextCreatedAt;
    afterId = nextId;
  }
  return buildHistoricalRelationManifest({
    namespace: args.namespace,
    summaryRows,
    rows
  });
}

function reportSummary(manifest, outputPath) {
  return {
    schema_version: manifest.schema_version,
    mode: manifest.mode,
    namespace: manifest.namespace,
    generated_at: manifest.generated_at,
    selection_predicate_version: manifest.selection_predicate_version,
    relation_count: manifest.relation_count,
    counts_by_cohort: manifest.counts_by_cohort,
    relations_sha256: manifest.relations_sha256,
    selection_sha256: manifest.selection_sha256,
    cohort_manifests: manifest.cohort_manifests,
    summary_rows: manifest.summary_rows,
    manifest_path: outputPath
  };
}

async function main() {
  const args = parseHistoricalRelationAuditArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const manifest = runHistoricalRelationAudit(args);
  let outputPath = null;
  if (args.output) {
    outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
  }
  console.log(JSON.stringify(reportSummary(manifest, outputPath), null, 2));
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
