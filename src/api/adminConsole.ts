import type { Env } from "../types";
import { isAuthorized, unauthorized } from "./adminBoard/auth";

interface CursorRow {
  name: string;
  value: string;
  updated_at: string;
}

interface MemoryEventRow {
  id: string;
  event_type: string;
  memory_id: string | null;
  payload_json: string;
  created_at: string;
}

interface UsageRow {
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_mode: string | null;
  created_at: string;
}

interface MessageRow {
  role: string;
  source: string | null;
  upstream_model: string | null;
  content: string;
  created_at: string;
}

interface StatRow {
  memories: number;
  activeMemories: number;
  messages: number;
  usage24h: number;
  events24h: number;
}

const MODEL_VARS = [
  "PUBLIC_MODEL_NAME",
  "CHAT_MODEL",
  "MEMORY_FILTER_MODEL",
  "MEMORY_MODEL",
  "VISION_MODEL",
  "GUIDE_DOG_MODEL",
  "EMBEDDING_MODEL",
  "SUMMARY_MODEL"
] as const;

const FEATURE_VARS = [
  "ENABLE_AUTO_MEMORY",
  "MEMORY_MODE",
  "ENABLE_MEMORY_FILTER",
  "MEMORY_EXTRACT_EVERY_N_MESSAGES",
  "MEMORY_MIN_IMPORTANCE",
  "INJECTION_MODE",
  "MEMORY_TOP_K",
  "MEMORY_MIN_SCORE",
  "ANTHROPIC_CACHE_ENABLED",
  "ANTHROPIC_THINKING_ENABLED",
  "ANTHROPIC_THINKING_BUDGET",
  "FORCE_ANTHROPIC_NATIVE"
] as const;

const SECRET_VARS = [
  "AI_GATEWAY_BASE_URL",
  "CHATBOX_API_KEY",
  "IM_API_KEY",
  "DEBUG_API_KEY",
  "MEMORY_MCP_API_KEY",
  "ADMIN_PASSWORD",
  "GUIDE_DOG_API_KEY",
  "CF_AIG_TOKEN"
] as const;

function envValue(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatShanghai(value: string | null): string {
  if (!value) return "-";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

async function first<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...binds).first<T>();
}

async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...binds).all<T>();
  return result.results ?? [];
}

async function loadConsoleData(env: Env) {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [stats, cursors, events, usage, messages] = await Promise.all([
    first<StatRow>(
      env.DB,
      `SELECT
        (SELECT COUNT(*) FROM memories WHERE namespace = 'default') AS memories,
        (SELECT COUNT(*) FROM memories WHERE namespace = 'default' AND status = 'active') AS activeMemories,
        (SELECT COUNT(*) FROM messages WHERE namespace = 'default') AS messages,
        (SELECT COUNT(*) FROM usage_logs WHERE namespace = 'default' AND created_at >= ?) AS usage24h,
        (SELECT COUNT(*) FROM memory_events WHERE namespace = 'default' AND created_at >= ?) AS events24h`,
      dayAgo,
      dayAgo
    ),
    all<CursorRow>(env.DB, "SELECT name, value, updated_at FROM processing_cursors ORDER BY updated_at DESC LIMIT 16"),
    all<MemoryEventRow>(env.DB, "SELECT id, event_type, memory_id, payload_json, created_at FROM memory_events WHERE namespace = 'default' ORDER BY created_at DESC LIMIT 24"),
    all<UsageRow>(env.DB, "SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_mode, created_at FROM usage_logs WHERE namespace = 'default' ORDER BY created_at DESC LIMIT 24"),
    all<MessageRow>(env.DB, "SELECT role, source, upstream_model, content, created_at FROM messages WHERE namespace = 'default' ORDER BY created_at DESC LIMIT 18")
  ]);
  return { stats, cursors, events, usage, messages };
}

function renderSettingRows(env: Env, names: readonly string[], secret = false): string {
  return names
    .map((name) => {
      const value = envValue(env, name);
      const display = secret ? (value ? "已设置" : "缺失") : value || "-";
      const cls = value ? "ok" : "warn";
      return `<tr><td>${htmlEscape(name)}</td><td><span class="pill ${cls}">${htmlEscape(display)}</span></td></tr>`;
    })
    .join("");
}

function renderCursorRows(rows: CursorRow[]): string {
  if (!rows.length) return `<tr><td colspan="3" class="muted">暂无 heartbeat / cursor</td></tr>`;
  return rows.map((row) => `<tr><td>${htmlEscape(row.name)}</td><td>${htmlEscape(row.value)}</td><td>${formatShanghai(row.updated_at)}</td></tr>`).join("");
}

function renderUsageRows(rows: UsageRow[]): string {
  if (!rows.length) return `<tr><td colspan="6" class="muted">暂无 usage log</td></tr>`;
  return rows
    .map((row) => `<tr><td>${formatShanghai(row.created_at)}</td><td>${htmlEscape(row.provider || "-")}</td><td>${htmlEscape(row.model || "-")}</td><td>${row.input_tokens ?? 0}</td><td>${row.output_tokens ?? 0}</td><td>${htmlEscape(row.cache_mode || "-")}</td></tr>`)
    .join("");
}

function renderEventRows(rows: MemoryEventRow[]): string {
  if (!rows.length) return `<div class="empty">暂无 hook / memory event</div>`;
  return rows
    .map((row) => `<article class="terminal-line"><div class="line-meta"><span>${formatShanghai(row.created_at)}</span><span>${htmlEscape(row.event_type)}</span><span>${htmlEscape(row.memory_id || row.id)}</span></div><pre>${htmlEscape(prettyJson(row.payload_json))}</pre></article>`)
    .join("");
}

function renderMessageRows(rows: MessageRow[]): string {
  if (!rows.length) return `<div class="empty">暂无 message stream</div>`;
  return rows
    .map((row) => `<article class="terminal-line"><div class="line-meta"><span>${formatShanghai(row.created_at)}</span><span>${htmlEscape(row.role)}</span><span>${htmlEscape(row.source || row.upstream_model || "-")}</span></div><pre>${htmlEscape(row.content)}</pre></article>`)
    .join("");
}

function renderPage(env: Env, data: Awaited<ReturnType<typeof loadConsoleData>>): string {
  const stats = data.stats ?? { memories: 0, activeMemories: 0, messages: 0, usage24h: 0, events24h: 0 };
  const bindings = [
    ["D1", Boolean(env.DB)],
    ["Vectorize", Boolean(env.VECTORIZE)],
    ["Queue", Boolean(env.MEMORY_QUEUE)]
  ];

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Memory Console</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#2b2b29;color:#f6f1e9;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{display:grid;grid-template-columns:252px 1fr;min-height:100vh}.side{border-right:1px solid #47423d;padding:16px 8px;background:#2c2c2a}.brand{font-weight:700;padding:0 10px 20px}.nav{display:grid;gap:6px}.nav a{color:#c9c2b8;text-decoration:none;padding:12px 14px;border-radius:8px;font-weight:650}.nav a.active,.nav a:hover{background:#4a3d35;color:#f39a67}.main{padding:30px 28px 56px;overflow:hidden}.top{display:flex;align-items:center;gap:14px;margin-bottom:22px}.back{color:#a9a39a;text-decoration:none;font-size:24px}.title{font-size:24px;font-weight:800}.badge{border:1px solid #78523f;background:#49382f;color:#f39a67;border-radius:6px;padding:3px 8px;font-size:12px;font-weight:700}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:26px}.tabs a{background:#1e3149;color:#cbd8ea;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700}.tabs a.active{background:#31435f;color:#fff}.grid{display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:18px;margin-bottom:18px}.card{background:#111;border:1px solid #2f2f2d;border-radius:8px;padding:20px;min-width:0}.value{font-size:22px;font-weight:800;margin-top:8px}.label{color:#8f9aad;font-size:13px}.section{margin-top:20px}.section-title{display:flex;align-items:center;gap:10px;color:#f6f1e9;font-size:15px;font-weight:800;margin-bottom:10px}.section-title:after{content:"";height:1px;background:#494641;flex:1}.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}.terminal{background:#10100f;border:1px solid #34312e;border-radius:8px;overflow:hidden}.terminal-head{display:flex;justify-content:space-between;gap:10px;padding:12px 14px;background:#171716;border-bottom:1px solid #34312e;color:#a9a39a;font-size:13px}.terminal-body{max-height:520px;overflow:auto;padding:12px}.terminal-line{border-bottom:1px solid #282622;padding:10px 0}.terminal-line:last-child{border-bottom:0}.line-meta{display:flex;gap:10px;flex-wrap:wrap;color:#92a0b8;font-size:12px;margin-bottom:8px}.line-meta span{background:#1f2733;border-radius:6px;padding:3px 7px}pre{margin:0;white-space:pre-wrap;word-break:break-word;color:#e8e1d8;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid #383631;padding:9px 8px;text-align:left;vertical-align:top}th{color:#9ba4b4;font-weight:700}.pill{display:inline-flex;border-radius:999px;padding:3px 8px;background:#383838;color:#d8d2ca}.pill.ok{background:#273f32;color:#93d6a6}.pill.warn{background:#4a332b;color:#ffab7a}.muted,.empty{color:#89857e}.empty{padding:16px}.settings{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.note{color:#b9b0a7;font-size:13px;line-height:1.6;margin-top:10px}@media(max-width:1100px){.shell{grid-template-columns:1fr}.side{position:static;border-right:0;border-bottom:1px solid #47423d}.nav{grid-template-columns:repeat(3,1fr)}.grid{grid-template-columns:repeat(2,1fr)}.two,.settings{grid-template-columns:1fr}}@media(max-width:560px){.main{padding:22px 14px 42px}.grid{grid-template-columns:1fr}.nav{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.tabs a{flex:1;text-align:center}}
  </style></head><body><div class="shell"><aside class="side"><div class="brand">Memory Console</div><nav class="nav"><a href="/admin/memories">记忆小家</a><a class="active" href="/admin/console">控制台</a><a href="/admin/maintenance">维护</a><a href="/admin/startup-context">Startup</a><a href="/books">共读</a></nav></aside><main class="main"><div class="top"><a class="back" href="/admin/memories">‹</a><div class="title">companion-memory-proxy</div><span class="badge">worker</span></div><nav class="tabs"><a class="active" href="#overview">概览</a><a href="#settings">项目设置</a><a href="#heartbeat">Heartbeat</a><a href="#hooks">Hooks</a><a href="#terminal">Terminal</a></nav><section id="overview" class="grid"><div class="card"><div class="label">总记忆</div><div class="value">${stats.memories}</div></div><div class="card"><div class="label">active</div><div class="value">${stats.activeMemories}</div></div><div class="card"><div class="label">messages</div><div class="value">${stats.messages}</div></div><div class="card"><div class="label">usage 24h</div><div class="value">${stats.usage24h}</div></div><div class="card"><div class="label">events 24h</div><div class="value">${stats.events24h}</div></div></section><section id="settings" class="section"><div class="section-title">项目设置</div><div class="settings"><div class="card"><div class="label">Bindings</div><table><tbody>${bindings.map(([name, ok]) => `<tr><td>${name}</td><td><span class="pill ${ok ? "ok" : "warn"}">${ok ? "已绑定" : "缺失"}</span></td></tr>`).join("")}</tbody></table></div><div class="card"><div class="label">Models</div><table><tbody>${renderSettingRows(env, MODEL_VARS)}</tbody></table></div><div class="card"><div class="label">Secrets</div><table><tbody>${renderSettingRows(env, SECRET_VARS, true)}</tbody></table></div></div><div class="card" style="margin-top:18px"><div class="label">Feature flags</div><table><tbody>${renderSettingRows(env, FEATURE_VARS)}</tbody></table><div class="note">这里按 Cloudflare Worker 当前环境变量渲染；密钥只显示是否存在，不显示明文。</div></div></section><section id="heartbeat" class="section two"><div class="card"><div class="section-title">Heartbeat / Cursors</div><table><thead><tr><th>name</th><th>value</th><th>东八区时间</th></tr></thead><tbody>${renderCursorRows(data.cursors)}</tbody></table></div><div class="card"><div class="section-title">Usage</div><table><thead><tr><th>时间</th><th>provider</th><th>model</th><th>in</th><th>out</th><th>cache</th></tr></thead><tbody>${renderUsageRows(data.usage)}</tbody></table></div></section><section id="hooks" class="section terminal"><div class="terminal-head"><span>Hooks / memory_events</span><span>latest 24</span></div><div class="terminal-body">${renderEventRows(data.events)}</div></section><section id="terminal" class="section terminal"><div class="terminal-head"><span>Terminal-like message stream</span><span>latest 18, full text</span></div><div class="terminal-body">${renderMessageRows(data.messages)}</div></section></main></div></body></html>`;
}

export async function handleAdminConsole(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const data = await loadConsoleData(env);
  return new Response(renderPage(env, data), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
