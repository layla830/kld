#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertReadOnlyAuditQueries,
  buildInactiveFiveAxisAuditQueries,
  buildInactiveFiveAxisAuditReport
} from "./inactive-five-axis-audit.mjs";

const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_NAMESPACE = "default";
const WRANGLER_ENTRY = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

export function usage() {
  return `Usage:
  npm run audit:inactive-five-axis -- --remote [--namespace default] [--json]

Options:
  --remote              Required. Audit the configured remote D1 database.
  --db <name>           D1 database name. Default: ${DEFAULT_DB}
  --namespace <name>    Memory namespace. Default: ${DEFAULT_NAMESPACE}
  --stale-hours <n>     Age threshold for pending/failed vector state. Default: 24
  --json                Emit machine-readable JSON.
  --help                Show this help.

This command is read-only. It has no fix, delete, repair, or apply mode.`;
}

export function parseAuditArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    namespace: DEFAULT_NAMESPACE,
    staleHours: 24,
    remote: false,
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--db") args.db = String(argv[++index] ?? "").trim();
    else if (arg === "--namespace") args.namespace = String(argv[++index] ?? "").trim();
    else if (arg === "--stale-hours") args.staleHours = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required for the production audit.");
  if (!args.db) throw new Error("--db requires a value.");
  if (!args.namespace) throw new Error("--namespace requires a value.");
  if (!Number.isInteger(args.staleHours) || args.staleHours < 1 || args.staleHours > 24 * 365) {
    throw new Error("--stale-hours must be an integer between 1 and 8760.");
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
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      `inactive five-axis audit query failed (${query.name}):\n`
      + `${result.error ? `${result.error.message}\n` : ""}`
      + `${result.stderr || result.stdout || "No output"}`
    );
  }
  return extractRows(parseWranglerJson(result.stdout));
}

function printHumanReport(report) {
  console.log(`Inactive five-axis audit: ${report.clean ? "clean" : "drift detected"}`);
  console.log(`Namespace: ${report.namespace}`);
  console.log(`Drift count: ${report.drift_count}`);
  for (const [name, rows] of Object.entries(report.sections)) {
    console.log(`\n[${name}]`);
    console.log(rows.length > 0 ? JSON.stringify(rows, null, 2) : "[]");
  }
}

export function runInactiveFiveAxisAudit(args, execute = executeReadOnlyQuery) {
  const queries = buildInactiveFiveAxisAuditQueries({
    namespace: args.namespace,
    staleHours: args.staleHours
  });
  assertReadOnlyAuditQueries(queries);
  const rowsByName = {};
  for (const query of queries) rowsByName[query.name] = execute(args, query);
  return buildInactiveFiveAxisAuditReport({
    namespace: args.namespace,
    queries,
    rowsByName
  });
}

async function main() {
  const args = parseAuditArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const report = runInactiveFiveAxisAudit(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
  process.exitCode = report.clean ? 0 : 2;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
