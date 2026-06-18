#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_COORDINATES_PATH = "scripts/lmc5_coordinates.json";
const DEFAULT_REPORT_PATH = "scripts/lmc5_coordinates_dry_run_report.json";
const DEFAULT_NAMESPACE = "default";
const DEFAULT_API_URL = "https://kld.yuxin2247.workers.dev";
const DEFAULT_DB = "companion_memory_proxy";
const WRANGLER_ENTRY = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const LEVELS = new Set(["low", "normal", "medium", "high"]);

function usage() {
  console.log(`Usage:
  npm run memory:lmc5-coordinates -- --coordinates scripts/lmc5_coordinates.json
  npm run memory:lmc5-coordinates -- --coordinates scripts/lmc5_coordinates.json --apply --yes

Options:
  --coordinates <path>  Coordinates JSON path. Default: ${DEFAULT_COORDINATES_PATH}
  --report <path>       Report output path. Default: ${DEFAULT_REPORT_PATH}
  --api-url <url>       Worker base URL. Default: ${DEFAULT_API_URL}
  --api-key <key>       API key. Defaults to KLD_API_KEY or MEMORY_MCP_API_KEY.
  --mode <api|d1>       Validation/apply mode. Default: api.
  --db <name>           D1 database name for --mode d1. Default: ${DEFAULT_DB}
  --local               Use local D1 with --mode d1.
  --namespace <name>    Memory namespace. Default: ${DEFAULT_NAMESPACE}
  --apply               Apply valid coordinate patches. Without this, dry-run only.
  --yes                 Required with --apply.
`);
}

function parseArgs(argv) {
  const args = {
    coordinatesPath: DEFAULT_COORDINATES_PATH,
    reportPath: DEFAULT_REPORT_PATH,
    apiUrl: process.env.KLD_API_URL || DEFAULT_API_URL,
    apiKey: process.env.KLD_API_KEY || process.env.MEMORY_MCP_API_KEY || "",
    mode: "api",
    db: DEFAULT_DB,
    remote: true,
    namespace: DEFAULT_NAMESPACE,
    apply: false,
    yes: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--coordinates") args.coordinatesPath = argv[++index];
    else if (arg === "--report") args.reportPath = argv[++index];
    else if (arg === "--api-url") args.apiUrl = argv[++index];
    else if (arg === "--api-key") args.apiKey = argv[++index];
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg === "--db") args.db = argv[++index];
    else if (arg === "--local") args.remote = false;
    else if (arg === "--namespace") args.namespace = argv[++index];
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--yes") args.yes = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["api", "d1"].includes(args.mode)) throw new Error("--mode must be api or d1.");
  if (args.mode === "api" && !args.apiKey) throw new Error("Missing API key. Set KLD_API_KEY or pass --api-key.");
  if (args.apply && !args.yes) throw new Error("--apply requires --yes. Run dry-run first.");
  args.apiUrl = args.apiUrl.replace(/\/+$/, "");
  return args;
}

function readJson(filePath) {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) throw new Error(`Coordinates file not found: ${absolute}`);
  return JSON.parse(readFileSync(absolute, "utf8"));
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

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function optionalString(value, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function optionalLevel(value) {
  const text = optionalString(value, 20)?.toLowerCase();
  if (text === null) return null;
  return text && LEVELS.has(text) ? text : undefined;
}

function optionalTension(value) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 1) return undefined;
  return numberValue;
}

function normalizeItem(raw, sourcePath) {
  const id = firstString(raw, ["id", "memory_id", "mem_id", "memoryId"]);
  if (!id) return { sourcePath, valid: false, errors: ["missing_id"], raw };

  const normalized = {
    id,
    thread: optionalString(raw.thread, 80),
    risk_level: optionalLevel(raw.risk_level),
    urgency_level: optionalLevel(raw.urgency_level),
    tension_score: optionalTension(raw.tension_score),
    response_posture: optionalString(raw.response_posture, 120),
    audit_state: optionalString(raw.audit_state, 80),
    reason: firstString(raw, ["reason", "note", "rationale"]),
    sourcePath,
    raw
  };

  const errors = [];
  for (const key of ["thread", "risk_level", "urgency_level", "tension_score", "response_posture", "audit_state"]) {
    if (normalized[key] === undefined) errors.push(`invalid_${key}`);
  }
  return { ...normalized, valid: errors.length === 0, errors };
}

function collectItems(value, sourcePath = "$", items = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectItems(item, `${sourcePath}[${index}]`, items));
    return items;
  }
  if (!value || typeof value !== "object") return items;

  if (firstString(value, ["id", "memory_id", "mem_id", "memoryId"])) {
    items.push(normalizeItem(value, sourcePath));
    return items;
  }

  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child) && ["items", "results", "coordinates", "memories"].includes(key)) {
      collectItems(child, `${sourcePath}.${key}`, items);
    }
  }
  return items;
}

async function workerJson(args, pathName, init = {}) {
  const response = await fetch(`${args.apiUrl}${pathName}`, {
    ...init,
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.error || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

async function fetchMemory(args, id) {
  if (args.mode === "d1") {
    const sql = `SELECT id, type, fact_key, thread, risk_level, urgency_level, tension_score, response_posture, audit_state, status FROM memories WHERE namespace = '${shellQuoteSql(args.namespace)}' AND id = '${shellQuoteSql(id)}' LIMIT 1`;
    return extractRows(wranglerD1(args, sql))[0] ?? null;
  }

  try {
    const data = await workerJson(args, `/v1/memories/${encodeURIComponent(id)}`);
    return data?.data ?? null;
  } catch (error) {
    if (String(error.message).includes("not found") || String(error.message).includes("Memory not found")) return null;
    throw error;
  }
}

function fetchMemories(args, ids) {
  if (args.mode !== "d1") return null;
  const memories = new Map();
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  for (let index = 0; index < uniqueIds.length; index += 80) {
    const batch = uniqueIds.slice(index, index + 80);
    const quotedIds = batch.map((id) => `'${shellQuoteSql(id)}'`).join(", ");
    const sql = `SELECT id, type, fact_key, thread, risk_level, urgency_level, tension_score, response_posture, audit_state, status FROM memories WHERE namespace = '${shellQuoteSql(args.namespace)}' AND id IN (${quotedIds})`;
    for (const row of extractRows(wranglerD1(args, sql))) memories.set(row.id, row);
  }
  return memories;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${shellQuoteSql(value)}'`;
}

async function patchMemory(args, item) {
  if (args.mode === "d1") {
    const patch = patchBody(args, item);
    const sql = `UPDATE memories SET
      thread = ${patch.thread === null ? "NULL" : `'${shellQuoteSql(patch.thread)}'`},
      risk_level = ${patch.risk_level === null ? "NULL" : `'${shellQuoteSql(patch.risk_level)}'`},
      urgency_level = ${patch.urgency_level === null ? "NULL" : `'${shellQuoteSql(patch.urgency_level)}'`},
      tension_score = ${patch.tension_score === null ? "NULL" : patch.tension_score},
      response_posture = ${patch.response_posture === null ? "NULL" : `'${shellQuoteSql(patch.response_posture)}'`},
      audit_state = ${patch.audit_state === null ? "NULL" : `'${shellQuoteSql(patch.audit_state)}'`},
      updated_at = '${new Date().toISOString()}'
      WHERE namespace = '${shellQuoteSql(args.namespace)}' AND id = '${shellQuoteSql(item.id)}'`;
    wranglerD1(args, sql);
    return fetchMemory(args, item.id);
  }

  const result = await workerJson(args, `/v1/memories/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    body: JSON.stringify(patchBody(args, item))
  });
  return result.data;
}

async function patchMemories(args, items) {
  if (args.mode !== "d1") {
    const applied = [];
    for (const item of items) applied.push({ id: item.id, data: await patchMemory(args, item) });
    return applied;
  }

  const now = new Date().toISOString();
  const statements = items.map((item) => {
    const patch = patchBody(args, item);
    return `UPDATE memories SET
      thread = ${sqlValue(patch.thread)},
      risk_level = ${sqlValue(patch.risk_level)},
      urgency_level = ${sqlValue(patch.urgency_level)},
      tension_score = ${sqlValue(patch.tension_score)},
      response_posture = ${sqlValue(patch.response_posture)},
      audit_state = ${sqlValue(patch.audit_state)},
      updated_at = '${shellQuoteSql(now)}'
      WHERE namespace = '${shellQuoteSql(args.namespace)}' AND id = '${shellQuoteSql(item.id)}';`;
  });
  wranglerD1(args, statements.join("\n"));
  const updated = fetchMemories(args, items.map((item) => item.id)) ?? new Map();
  return items.map((item) => ({ id: item.id, data: updated.get(item.id) ?? null }));
}

function patchBody(args, item) {
  return {
    namespace: args.namespace,
    thread: item.thread,
    risk_level: item.risk_level,
    urgency_level: item.urgency_level,
    tension_score: item.tension_score,
    response_posture: item.response_posture,
    audit_state: item.audit_state
  };
}

function summarize(plan) {
  const counts = {
    total: plan.length,
    valid: plan.filter((item) => item.valid).length,
    writable: plan.filter((item) => item.valid && item.exists && item.status !== "deleted").length,
    missing: plan.filter((item) => item.valid && !item.exists).length,
    invalid: plan.filter((item) => !item.valid).length,
    skipped_deleted: plan.filter((item) => item.valid && item.exists && item.status === "deleted").length
  };
  const byThread = {};
  for (const item of plan) {
    if (!item.valid || !item.thread) continue;
    byThread[item.thread] = (byThread[item.thread] || 0) + 1;
  }
  return { counts, byThread };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = readJson(args.coordinatesPath);
  const items = collectItems(raw);
  if (items.length === 0) throw new Error("No coordinate items found.");

  const seen = new Set();
  const d1Memories = args.mode === "d1" ? fetchMemories(args, items.filter((item) => item.valid).map((item) => item.id)) : null;
  const plan = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      plan.push({ ...item, valid: false, errors: [...item.errors, "duplicate_id"] });
      continue;
    }
    seen.add(item.id);
    if (!item.valid) {
      plan.push(item);
      continue;
    }
    const memory = d1Memories ? d1Memories.get(item.id) ?? null : await fetchMemory(args, item.id);
    plan.push({
      ...item,
      exists: Boolean(memory),
      status: memory?.status ?? null,
      current: memory
        ? {
            type: memory.type,
            fact_key: memory.fact_key,
            thread: memory.thread,
            risk_level: memory.risk_level,
            urgency_level: memory.urgency_level,
            tension_score: memory.tension_score,
            response_posture: memory.response_posture,
            audit_state: memory.audit_state
          }
        : null,
      patch: patchBody(args, item)
    });
  }

  const writable = plan.filter((item) => item.valid && item.exists && item.status !== "deleted");
  const applied = [];
  if (args.apply) {
    applied.push(...(await patchMemories(args, writable)));
  }

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    coordinates_path: args.coordinatesPath,
    mode: args.mode,
    namespace: args.namespace,
    summary: summarize(plan),
    applied_count: applied.length,
    plan,
    applied: applied.map((item) => ({
      id: item.id,
      thread: item.data?.thread,
      risk_level: item.data?.risk_level,
      urgency_level: item.data?.urgency_level,
      tension_score: item.data?.tension_score,
      response_posture: item.data?.response_posture,
      audit_state: item.data?.audit_state
    }))
  };

  const reportPath = path.resolve(args.reportPath);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`${args.apply ? "Applied" : "Dry-run"} ${args.apply ? applied.length : writable.length} writable coordinate updates.`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
