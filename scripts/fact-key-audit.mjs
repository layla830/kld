#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_AUDIT_PATH = "scripts/fact_key_audit_final.json";
const DEFAULT_REPORT_PATH = "scripts/fact_key_audit_dry_run_report.json";
const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_NAMESPACE = "default";
const WRANGLER_ENTRY = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

const ACTIONS = new Set(["keep", "remove_fact_key", "rename_fact_key", "merge_with", "add_fact_key", "no_fact_key"]);
const WRITING_ACTIONS = new Set(["remove_fact_key", "rename_fact_key", "merge_with", "add_fact_key"]);
const SUBJECT_PREFIXES = new Set(["user", "partner", "relationship", "project", "knowledge"]);

function usage() {
  console.log(`Usage:
  npm run memory:fact-key-audit -- --audit scripts/fact_key_audit_final.json
  npm run memory:fact-key-audit -- --audit scripts/fact_key_audit_final.json --apply

Options:
  --audit <path>       Audit JSON path. Default: ${DEFAULT_AUDIT_PATH}
  --report <path>      Report output path. Default: ${DEFAULT_REPORT_PATH}
  --db <name>          D1 database name. Default: ${DEFAULT_DB}
  --namespace <name>   Memory namespace. Default: ${DEFAULT_NAMESPACE}
  --local              Read/write local D1 instead of remote.
  --apply              Apply valid changes. Without this, dry-run only.
  --include-warnings   With --apply, also apply rows marked as needing review.
  --yes                Required with --apply.
`);
}

function parseArgs(argv) {
  const args = {
    auditPath: DEFAULT_AUDIT_PATH,
    reportPath: DEFAULT_REPORT_PATH,
    db: DEFAULT_DB,
    namespace: DEFAULT_NAMESPACE,
    remote: true,
    apply: false,
    includeWarnings: false,
    yes: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--audit") args.auditPath = argv[++index];
    else if (arg === "--report") args.reportPath = argv[++index];
    else if (arg === "--db") args.db = argv[++index];
    else if (arg === "--namespace") args.namespace = argv[++index];
    else if (arg === "--local") args.remote = false;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--include-warnings") args.includeWarnings = true;
    else if (arg === "--yes") args.yes = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.apply && !args.yes) {
    throw new Error("--apply requires --yes. Run dry-run first, then apply intentionally.");
  }
  return args;
}

function readJson(filePath) {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) {
    throw new Error(`Audit file not found: ${absolute}`);
  }
  return JSON.parse(readFileSync(absolute, "utf8"));
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function normalizeAction(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return ACTIONS.has(clean) ? clean : null;
}

function normalizeEntry(raw, sourcePath, inheritedAction = null) {
  const action = normalizeAction(firstString(raw, ["action", "operation", "op", "decision", "status"])) ?? inheritedAction;
  const id = firstString(raw, ["id", "mem_id", "memory_id", "source_memory_id", "memoryId"]);
  if (!action || !id) return null;

  const currentFactKey = firstString(raw, ["current_fact_key", "old_fact_key", "from_fact_key", "existing_fact_key"]);
  const targetFactKey =
    firstString(raw, ["target_fact_key", "target_key", "new_fact_key", "to_fact_key", "fact_key", "key", "target"]) ??
    (action === "remove_fact_key" ? null : undefined);
  const reason = firstString(raw, ["reason", "note", "notes", "explanation", "rationale"]);

  return {
    id,
    action,
    currentFactKey,
    targetFactKey,
    reason,
    strength: firstNumber(raw, ["strength", "confidence"]),
    sourcePath,
    raw
  };
}

function normalizeGroupedEntries(raw, sourcePath, inheritedAction) {
  const action = normalizeAction(firstString(raw, ["action", "operation", "op", "decision", "status"])) ?? inheritedAction;
  if (!action) return [];

  const ids = raw?.ids ?? raw?.memory_ids ?? raw?.mem_ids;
  if (!Array.isArray(ids)) return [];

  return ids
    .filter((id) => typeof id === "string" && id.trim())
    .map((id, index) => normalizeEntry({ ...raw, id }, `${sourcePath}.ids[${index}]`, action))
    .filter(Boolean);
}

function collectEntries(value, sourcePath = "$", entries = [], inheritedAction = null) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEntries(item, `${sourcePath}[${index}]`, entries, inheritedAction));
    return entries;
  }
  if (!value || typeof value !== "object") return entries;

  const entry = normalizeEntry(value, sourcePath, inheritedAction);
  if (entry) entries.push(entry);
  entries.push(...normalizeGroupedEntries(value, sourcePath, inheritedAction));

  for (const [key, child] of Object.entries(value)) {
    if (key === "raw") continue;
    const childAction = normalizeAction(key) ?? inheritedAction;
    if (Array.isArray(child)) collectEntries(child, `${sourcePath}.${key}`, entries, childAction);
    else if (child && typeof child === "object" && ["items", "results", "decisions", "changes", "entries", "audit", "records"].includes(key)) {
      collectEntries(child, `${sourcePath}.${key}`, entries, childAction);
    } else if (child && typeof child === "object" && normalizeAction(key)) {
      collectEntries(child, `${sourcePath}.${key}`, entries, childAction);
    }
  }
  return entries;
}

function shellQuoteSql(value) {
  return String(value).replaceAll("'", "''");
}

function parseWranglerJson(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    const firstJson = text.indexOf("[");
    if (firstJson >= 0) return JSON.parse(text.slice(firstJson));
    throw new Error(`Could not parse wrangler JSON output:\n${text.slice(0, 1000)}`);
  }
}

function wranglerD1(args, command) {
  const wranglerArgs = [WRANGLER_ENTRY, "d1", "execute", args.db, args.remote ? "--remote" : "--local", "--json", "--command", command];
  const result = spawnSync(process.execPath, wranglerArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed:\n${result.error ? `${result.error}\n` : ""}${result.stderr || result.stdout || "No output"}`);
  }
  return parseWranglerJson(result.stdout);
}

function extractRows(result) {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item) => item?.results ?? []);
}

function fetchMemories(args, ids) {
  const rows = [];
  const uniqueIds = [...new Set(ids)];
  for (let index = 0; index < uniqueIds.length; index += 80) {
    const batch = uniqueIds.slice(index, index + 80);
    const quotedIds = batch.map((id) => `'${shellQuoteSql(id)}'`).join(", ");
    const sql = `SELECT id, namespace, type, content, summary, fact_key, active_fact, status, pinned, source, tags, updated_at FROM memories WHERE namespace = '${shellQuoteSql(args.namespace)}' AND id IN (${quotedIds})`;
    rows.push(...extractRows(wranglerD1(args, sql)));
  }
  return new Map(rows.map((row) => [row.id, row]));
}

function factSubject(factKey) {
  if (!factKey) return null;
  const subject = factKey.split(".")[0];
  return SUBJECT_PREFIXES.has(subject) ? subject : null;
}

function targetFor(entry) {
  if (entry.action === "remove_fact_key") return null;
  if (entry.action === "rename_fact_key" || entry.action === "merge_with" || entry.action === "add_fact_key") return entry.targetFactKey ?? null;
  return undefined;
}

function validateEntry(entry, memory) {
  const problems = [];
  const warnings = [];
  const desiredFactKey = targetFor(entry);

  if (!memory) {
    problems.push("memory_not_found");
    return { desiredFactKey, problems, warnings };
  }
  if (memory.status !== "active") warnings.push(`status_is_${memory.status}`);

  if (entry.currentFactKey !== null && (memory.fact_key ?? null) !== entry.currentFactKey) {
    problems.push(`current_fact_key_mismatch:${memory.fact_key ?? "null"}!=${entry.currentFactKey}`);
  }

  if (WRITING_ACTIONS.has(entry.action) && desiredFactKey === undefined) {
    problems.push("target_fact_key_missing");
  }
  if ((entry.action === "rename_fact_key" || entry.action === "merge_with") && !memory.fact_key && !entry.currentFactKey) {
    warnings.push("rename_without_existing_fact_key");
  }
  if (entry.action === "add_fact_key" && memory.fact_key) {
    warnings.push(`add_over_existing_fact_key:${memory.fact_key}`);
  }

  const fromSubject = factSubject(entry.currentFactKey ?? memory.fact_key);
  const toSubject = factSubject(desiredFactKey);
  if (fromSubject && toSubject && fromSubject !== toSubject) {
    warnings.push(`subject_prefix_change:${fromSubject}->${toSubject}`);
  }

  if (entry.action === "remove_fact_key" && !memory.fact_key) {
    warnings.push("remove_when_fact_key_already_empty");
  }
  if (desiredFactKey !== undefined && (memory.fact_key ?? null) === desiredFactKey) {
    warnings.push("already_at_target_fact_key");
  }

  return { desiredFactKey, problems, warnings };
}

function buildPlan(entries, memories) {
  const seen = new Map();
  const duplicateIds = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicateIds.add(entry.id);
    seen.set(entry.id, entry);
  }

  return entries.map((entry) => {
    const memory = memories.get(entry.id) ?? null;
    const validation = validateEntry(entry, memory);
    if (duplicateIds.has(entry.id)) validation.warnings.push("duplicate_decision_for_id");
    const canApply = WRITING_ACTIONS.has(entry.action) && validation.problems.length === 0 && validation.warnings.length === 0;
    return {
      id: entry.id,
      action: entry.action,
      current_fact_key_expected: entry.currentFactKey,
      current_fact_key_actual: memory?.fact_key ?? null,
      target_fact_key: validation.desiredFactKey,
      type: memory?.type ?? null,
      status: memory?.status ?? null,
      source: memory?.source ?? null,
      preview: memory?.content ? memory.content.slice(0, 80) : null,
      reason: entry.reason,
      warnings: validation.warnings,
      problems: validation.problems,
      can_apply: canApply,
      source_path: entry.sourcePath
    };
  });
}

function summarize(plan) {
  const risky = plan.filter((item) => hasReviewWarnings(item));
  const settled = plan.filter((item) => !item.can_apply && item.problems.length === 0 && item.warnings.length > 0 && !hasReviewWarnings(item));
  const summary = {
    total_decisions: plan.length,
    writable_decisions: plan.filter((item) => WRITING_ACTIONS.has(item.action)).length,
    can_apply: plan.filter((item) => item.can_apply).length,
    blocked: plan.filter((item) => item.problems.length > 0).length,
    needs_review: risky.length,
    already_settled: settled.length,
    by_action: {}
  };
  for (const item of plan) {
    summary.by_action[item.action] = (summary.by_action[item.action] ?? 0) + 1;
  }
  return summary;
}

function hasReviewWarnings(item) {
  return item.warnings.some(
    (warning) =>
      warning.startsWith("subject_prefix_change:") ||
      warning.startsWith("status_is_") ||
      warning === "duplicate_decision_for_id" ||
      warning === "rename_without_existing_fact_key"
  );
}

function applyPlan(args, plan) {
  const changes = plan.filter(
    (item) => WRITING_ACTIONS.has(item.action) && item.problems.length === 0 && (args.includeWarnings || item.warnings.length === 0)
  );
  for (const item of changes) {
    const factExpr = item.target_fact_key === null ? "NULL" : `'${shellQuoteSql(item.target_fact_key)}'`;
    const sql = `UPDATE memories SET fact_key = ${factExpr}, vector_synced = 0, updated_at = datetime('now') WHERE namespace = '${shellQuoteSql(args.namespace)}' AND id = '${shellQuoteSql(item.id)}'`;
    const result = extractRows(wranglerD1(args, sql));
    item.apply_result = result;
  }
  return changes.length;
}

function writeReport(reportPath, report) {
  const absolute = path.resolve(reportPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return absolute;
}

function printHumanSummary(report, reportPath) {
  console.log(report.apply ? "Fact-key audit apply complete." : "Fact-key audit dry-run complete.");
  console.log(JSON.stringify(report.summary));
  if (report.blocked.length > 0) {
    console.log("\nBlocked:");
    for (const item of report.blocked.slice(0, 12)) {
      console.log(`- ${item.id} ${item.action}: ${item.problems.join(", ")}`);
    }
  }
  if (report.risky.length > 0) {
    console.log("\nNeeds review:");
    for (const item of report.risky.slice(0, 12)) {
      console.log(`- ${item.id} ${item.action}: ${item.warnings.join(", ")}`);
    }
  }
  console.log(`\nReport: ${reportPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const audit = readJson(args.auditPath);
  const entries = collectEntries(audit);
  if (entries.length === 0) {
    throw new Error("No audit decisions found. Expected objects with id/mem_id plus action/operation.");
  }

  const memories = fetchMemories(args, entries.map((entry) => entry.id));
  const plan = buildPlan(entries, memories);
  const applied = args.apply ? applyPlan(args, plan) : 0;
  const report = {
    generated_at: new Date().toISOString(),
    mode: args.remote ? "remote" : "local",
    database: args.db,
    namespace: args.namespace,
    apply: args.apply,
    include_warnings: args.includeWarnings,
    applied,
    summary: summarize(plan),
    blocked: plan.filter((item) => item.problems.length > 0),
    risky: plan.filter((item) => item.problems.length === 0 && hasReviewWarnings(item)),
    already_settled: plan.filter((item) => !item.can_apply && item.problems.length === 0 && item.warnings.length > 0 && !hasReviewWarnings(item)),
    plan
  };

  const reportPath = writeReport(args.reportPath, report);
  printHumanSummary(report, reportPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
