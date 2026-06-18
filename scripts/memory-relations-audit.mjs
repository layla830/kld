#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_RELATIONS_PATH = "scripts/memory_relations_final.json";
const DEFAULT_REPORT_PATH = "scripts/memory_relations_dry_run_report.json";
const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_NAMESPACE = "default";
const WRANGLER_ENTRY = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

const SAFE_RELATION_TYPES = new Set([
  "same_issue",
  "same_project",
  "same_tool",
  "same_event",
  "same_topic",
  "temporal_sequence",
  "emotional_link",
  "in_thread",
  "same_person",
  "in_episode",
  "instance_of",
  "derived_from",
  "same_fact_key",
  "origin_split"
]);
const REVIEW_RELATION_TYPES = new Set(["contradicts", "cause_effect", "supports", "contradiction"]);
const SYMMETRIC_RELATION_TYPES = new Set([
  "same_issue",
  "same_project",
  "same_tool",
  "same_event",
  "same_topic",
  "emotional_link",
  "in_thread",
  "same_person",
  "in_episode",
  "same_fact_key",
  "contradicts"
]);

function usage() {
  console.log(`Usage:
  npm run memory:relations-audit -- --relations scripts/memory_relations_final.json
  npm run memory:relations-audit -- --relations scripts/memory_relations_final.json --apply --yes

Options:
  --relations <path>  Relation JSON path. Default: ${DEFAULT_RELATIONS_PATH}
  --report <path>     Report output path. Default: ${DEFAULT_REPORT_PATH}
  --db <name>         D1 database name. Default: ${DEFAULT_DB}
  --namespace <name>  Memory namespace. Default: ${DEFAULT_NAMESPACE}
  --local             Read/write local D1 instead of remote.
  --apply             Apply valid safe relations. Without this, dry-run only.
  --yes               Required with --apply.
`);
}

function parseArgs(argv) {
  const args = {
    relationsPath: DEFAULT_RELATIONS_PATH,
    reportPath: DEFAULT_REPORT_PATH,
    db: DEFAULT_DB,
    namespace: DEFAULT_NAMESPACE,
    remote: true,
    apply: false,
    yes: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--relations") args.relationsPath = argv[++index];
    else if (arg === "--report") args.reportPath = argv[++index];
    else if (arg === "--db") args.db = argv[++index];
    else if (arg === "--namespace") args.namespace = argv[++index];
    else if (arg === "--local") args.remote = false;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--yes") args.yes = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.apply && !args.yes) throw new Error("--apply requires --yes. Run dry-run first.");
  return args;
}

function readJson(filePath) {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) throw new Error(`Relation file not found: ${absolute}`);
  return JSON.parse(readFileSync(absolute, "utf8"));
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readStrength(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.min(Math.max(value, 0), 1);
  if (typeof value === "string" && Number.isFinite(Number(value))) return Math.min(Math.max(Number(value), 0), 1);
  return 1;
}

function normalizeType(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean === "contradiction" ? "contradicts" : clean;
}

function normalizePair(sourceId, targetId, relationType) {
  if (SYMMETRIC_RELATION_TYPES.has(relationType) && sourceId > targetId) return { sourceId: targetId, targetId: sourceId };
  return { sourceId, targetId };
}

function normalizeRelation(raw, sourcePath) {
  const sourceId = firstString(raw, ["source_memory_id", "source_id", "from_id", "sourceMemoryId", "source"]);
  const targetId = firstString(raw, ["target_memory_id", "target_id", "to_id", "targetMemoryId", "target"]);
  const relationType = normalizeType(firstString(raw, ["relation_type", "type", "relation", "kind"]));
  if (!sourceId || !targetId || !relationType) return null;
  const pair = normalizePair(sourceId, targetId, relationType);
  return {
    sourceId: pair.sourceId,
    targetId: pair.targetId,
    relationType,
    strength: readStrength(raw?.strength ?? raw?.confidence),
    reason: firstString(raw, ["reason", "note", "rationale", "evidence"]),
    sourcePath,
    raw
  };
}

function collectRelations(value, sourcePath = "$", relations = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRelations(item, `${sourcePath}[${index}]`, relations));
    return relations;
  }
  if (!value || typeof value !== "object") return relations;

  const relation = normalizeRelation(value, sourcePath);
  if (relation) relations.push(relation);

  for (const [key, child] of Object.entries(value)) {
    if (key === "raw") continue;
    if (Array.isArray(child)) collectRelations(child, `${sourcePath}.${key}`, relations);
    else if (child && typeof child === "object" && ["relations", "items", "results", "edges", "links"].includes(key)) {
      collectRelations(child, `${sourcePath}.${key}`, relations);
    }
  }
  return relations;
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
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  for (let index = 0; index < uniqueIds.length; index += 80) {
    const batch = uniqueIds.slice(index, index + 80);
    const quotedIds = batch.map((id) => `'${shellQuoteSql(id)}'`).join(", ");
    const sql = `SELECT id, type, content, fact_key, status, source, tags FROM memories WHERE namespace = '${shellQuoteSql(args.namespace)}' AND id IN (${quotedIds})`;
    rows.push(...extractRows(wranglerD1(args, sql)));
  }
  return new Map(rows.map((row) => [row.id, row]));
}

function fetchExistingRelations(args, relations) {
  const rows = [];
  const uniqueIds = [...new Set(relations.flatMap((relation) => [relation.sourceId, relation.targetId]))];
  if (uniqueIds.length === 0) return new Set();

  for (let index = 0; index < uniqueIds.length; index += 80) {
    const batch = uniqueIds.slice(index, index + 80);
    const quotedIds = batch.map((id) => `'${shellQuoteSql(id)}'`).join(", ");
    const sql = `SELECT source_memory_id, target_memory_id, relation_type FROM memory_relations WHERE namespace = '${shellQuoteSql(args.namespace)}' AND (source_memory_id IN (${quotedIds}) OR target_memory_id IN (${quotedIds}))`;
    rows.push(...extractRows(wranglerD1(args, sql)));
  }
  return new Set(rows.map((row) => `${row.source_memory_id}\u0000${row.target_memory_id}\u0000${row.relation_type}`));
}

function relationKey(relation) {
  return `${relation.sourceId}\u0000${relation.targetId}\u0000${relation.relationType}`;
}

function buildPlan(relations, memories, existing) {
  const seen = new Set();
  return relations.map((relation) => {
    const problems = [];
    const warnings = [];
    const source = memories.get(relation.sourceId) ?? null;
    const target = memories.get(relation.targetId) ?? null;
    const key = relationKey(relation);

    if (relation.sourceId === relation.targetId) problems.push("self_relation");
    if (!source) problems.push("source_memory_not_found");
    if (!target) problems.push("target_memory_not_found");
    if (source && source.status !== "active") warnings.push(`source_status_is_${source.status}`);
    if (target && target.status !== "active") warnings.push(`target_status_is_${target.status}`);
    if (!SAFE_RELATION_TYPES.has(relation.relationType)) {
      if (REVIEW_RELATION_TYPES.has(relation.relationType)) warnings.push(`review_only_relation_type:${relation.relationType}`);
      else problems.push(`unknown_relation_type:${relation.relationType}`);
    }
    if (seen.has(key)) warnings.push("duplicate_relation_in_file");
    seen.add(key);
    if (existing.has(key)) warnings.push("already_exists");

    return {
      source_memory_id: relation.sourceId,
      target_memory_id: relation.targetId,
      relation_type: relation.relationType,
      strength: relation.strength,
      reason: relation.reason,
      source_preview: source?.content?.slice(0, 80) ?? null,
      target_preview: target?.content?.slice(0, 80) ?? null,
      source_fact_key: source?.fact_key ?? null,
      target_fact_key: target?.fact_key ?? null,
      problems,
      warnings,
      can_apply: problems.length === 0 && warnings.length === 0,
      source_path: relation.sourcePath
    };
  });
}

function ensureSchema(args) {
  wranglerD1(
    args,
    `CREATE TABLE IF NOT EXISTS memory_relations (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'default',
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1,
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(namespace, source_memory_id, target_memory_id, relation_type)
    )`
  );
}

function randomId() {
  return `rel_${crypto.randomUUID().replaceAll("-", "")}`;
}

function applyPlan(args, plan) {
  const changes = plan.filter((item) => item.can_apply);
  for (let index = 0; index < changes.length; index += 40) {
    const batch = changes.slice(index, index + 40);
    const values = batch
      .map(
        (item) =>
          `('${randomId()}', '${shellQuoteSql(args.namespace)}', '${shellQuoteSql(item.source_memory_id)}', '${shellQuoteSql(item.target_memory_id)}', '${shellQuoteSql(item.relation_type)}', ${item.strength}, ${item.reason ? `'${shellQuoteSql(item.reason)}'` : "NULL"}, datetime('now'))`
      )
      .join(", ");
    const sql = `INSERT OR IGNORE INTO memory_relations (id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at) VALUES ${values}`;
    wranglerD1(args, sql);
  }
  return changes.length;
}

function summarize(plan) {
  const summary = {
    total_relations: plan.length,
    can_apply: plan.filter((item) => item.can_apply).length,
    blocked: plan.filter((item) => item.problems.length > 0).length,
    needs_review: plan.filter((item) => item.problems.length === 0 && item.warnings.length > 0 && !item.warnings.includes("already_exists")).length,
    already_exists: plan.filter((item) => item.warnings.includes("already_exists")).length,
    by_type: {}
  };
  for (const item of plan) summary.by_type[item.relation_type] = (summary.by_type[item.relation_type] ?? 0) + 1;
  return summary;
}

function writeReport(reportPath, report) {
  const absolute = path.resolve(reportPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return absolute;
}

function printSummary(report, reportPath) {
  console.log(report.apply ? "Memory relation apply complete." : "Memory relation dry-run complete.");
  console.log(JSON.stringify(report.summary));
  if (report.blocked.length > 0) {
    console.log("\nBlocked:");
    for (const item of report.blocked.slice(0, 12)) console.log(`- ${item.source_memory_id} -> ${item.target_memory_id} ${item.relation_type}: ${item.problems.join(", ")}`);
  }
  if (report.risky.length > 0) {
    console.log("\nNeeds review:");
    for (const item of report.risky.slice(0, 12)) console.log(`- ${item.source_memory_id} -> ${item.target_memory_id} ${item.relation_type}: ${item.warnings.join(", ")}`);
  }
  console.log(`\nReport: ${reportPath}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = readJson(args.relationsPath);
  const relations = collectRelations(raw);
  if (relations.length === 0) throw new Error("No relations found. Expected source_memory_id, target_memory_id, relation_type.");

  ensureSchema(args);
  const memories = fetchMemories(args, relations.flatMap((relation) => [relation.sourceId, relation.targetId]));
  const existing = fetchExistingRelations(args, relations);
  const plan = buildPlan(relations, memories, existing);
  const applied = args.apply ? applyPlan(args, plan) : 0;
  const report = {
    generated_at: new Date().toISOString(),
    mode: args.remote ? "remote" : "local",
    database: args.db,
    namespace: args.namespace,
    apply: args.apply,
    applied,
    summary: summarize(plan),
    blocked: plan.filter((item) => item.problems.length > 0),
    risky: plan.filter((item) => item.problems.length === 0 && item.warnings.length > 0 && !item.warnings.includes("already_exists")),
    already_exists: plan.filter((item) => item.warnings.includes("already_exists")),
    plan
  };
  const reportPath = writeReport(args.reportPath, report);
  printSummary(report, reportPath);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
