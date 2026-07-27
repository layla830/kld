#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertReadOnlyRepairQuery,
  buildRepairApplyQuery,
  buildRepairDryRunQuery,
  MAX_REPAIR_LIMIT
} from "./inactive-five-axis-repair.mjs";

export {
  assertReadOnlyRepairQuery,
  buildRepairApplyQuery,
  buildRepairDryRunQuery
} from "./inactive-five-axis-repair.mjs";

const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_NAMESPACE = "default";
const DEFAULT_LIMIT = 100;
const APPLY_CONFIRMATION = "inactive-five-axis-d1";
const WRANGLER_ENTRY = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

export function usage() {
  return `Usage:
  npm run repair:inactive-five-axis-d1 -- --remote [options]

Options:
  --remote              Required. Target the configured remote D1 database.
  --db <name>           D1 database name. Default: ${DEFAULT_DB}
  --namespace <name>    Memory namespace. Default: ${DEFAULT_NAMESPACE}
  --limit <n>           Maximum rows in this run. Default: ${DEFAULT_LIMIT}; max: ${MAX_REPAIR_LIMIT}
  --apply               Execute one bounded write statement.
  --confirm <text>      Required with --apply; must equal ${APPLY_CONFIRMATION}
  --json                Emit machine-readable JSON.
  --help                Show this help.

Without --apply this command executes SELECT only. It targets stale failed axis runs and
strictly expired stale running axis runs. It does not repair relations or loop automatically.`;
}

export function parseRepairArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    namespace: DEFAULT_NAMESPACE,
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
    else if (arg === "--namespace") args.namespace = String(argv[++index] ?? "").trim();
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--confirm") args.confirm = String(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required for the production repair command.");
  if (!args.db) throw new Error("--db requires a value.");
  if (!args.namespace) throw new Error("--namespace requires a value.");
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_REPAIR_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_REPAIR_LIMIT}.`);
  }
  if (args.apply && args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm ${APPLY_CONFIRMATION}.`);
  }
  if (!args.apply && args.confirm) {
    throw new Error("--confirm is only valid with --apply.");
  }
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

function executeQuery(args, query) {
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
      WRANGLER_LOG_PATH: path.join(process.cwd(), ".wrangler", "inactive-five-axis-repair.log")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      `inactive five-axis repair query failed (${query.name}):\n`
      + `${result.error ? `${result.error.message}\n` : ""}`
      + `${result.stderr || result.stdout || "No output"}`
    );
  }
  const response = parseWranglerJson(result.stdout);
  const entries = Array.isArray(response) ? response : [];
  return {
    rows: entries.flatMap((item) => item?.results ?? []),
    changes: entries.reduce((sum, item) => sum + Number(item?.meta?.changes ?? 0), 0),
    rowsWritten: entries.reduce((sum, item) => sum + Number(item?.meta?.rows_written ?? 0), 0)
  };
}

export function runInactiveFiveAxisRepair(args, execute = executeQuery) {
  const dryRunQuery = buildRepairDryRunQuery(args);
  assertReadOnlyRepairQuery(dryRunQuery);
  if (!args.apply) {
    const preview = execute(args, dryRunQuery);
    if (preview.rowsWritten !== 0) throw new Error("repair_dry_run_reported_rows_written");
    return {
      schema_version: 1,
      mode: "dry_run",
      namespace: args.namespace,
      limit: args.limit,
      ...(preview.rows[0] ?? {})
    };
  }

  const applied = execute(args, buildRepairApplyQuery(args));
  const remaining = execute(args, dryRunQuery);
  const after = remaining.rows[0] ?? {};
  return {
    schema_version: 1,
    mode: "apply",
    namespace: args.namespace,
    limit: args.limit,
    changed: applied.changes,
    remaining: Number(after.repairable_rows ?? 0),
    has_more: Boolean(Number(after.has_more ?? 0))
  };
}

function printHumanReport(report) {
  console.log(`Inactive five-axis D1 repair: ${report.mode}`);
  console.log(`Namespace: ${report.namespace}`);
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const args = parseRepairArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const report = runInactiveFiveAxisRepair(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
