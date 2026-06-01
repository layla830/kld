import { RETENTION_POLICY } from "../memory/retention";
import type { Env } from "../types";
import { isAuthorized, unauthorized } from "./adminBoard/auth";

interface MaintenanceStats {
  total: number;
  active: number;
  deleted: number;
  expired: number;
  superseded: number;
  lowConfidence: number;
  vectorReady: number;
  legacyVps: number;
  adminBoard: number;
}

interface TypeStat {
  type: string;
  count: number;
}

interface PipelineStatus {
  queueBinding: boolean;
  autoMemoryEnabled: boolean;
  autoDiaryEnabled: boolean;
  taskCounts: Array<{ status: string; count: number }>;
  memoryOutputs: Array<{ type: string; count: number; latest: string | null }>;
  messageChunkStats: { processed: number | null; unprocessed: number | null; unavailable: boolean };
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function boolLabel(value: boolean): string {
  return value ? '<span class="ok">enabled</span>' : '<span class="warn">disabled</span>';
}

async function fetchStats(env: Env): Promise<MaintenanceStats> {
  const row = await env.DB.prepare(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded,
      SUM(CASE WHEN status = 'low_confidence' THEN 1 ELSE 0 END) AS lowConfidence,
      SUM(CASE WHEN status = 'active' AND vector_id IS NOT NULL AND vector_id != '' THEN 1 ELSE 0 END) AS vectorReady,
      SUM(CASE WHEN source = 'vps-mcp-memory' THEN 1 ELSE 0 END) AS legacyVps,
      SUM(CASE WHEN source = 'admin-board' THEN 1 ELSE 0 END) AS adminBoard
     FROM memories
     WHERE namespace = 'default'`
  ).first<MaintenanceStats>();

  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    deleted: row?.deleted ?? 0,
    expired: row?.expired ?? 0,
    superseded: row?.superseded ?? 0,
    lowConfidence: row?.lowConfidence ?? 0,
    vectorReady: row?.vectorReady ?? 0,
    legacyVps: row?.legacyVps ?? 0,
    adminBoard: row?.adminBoard ?? 0
  };
}

async function fetchTypes(env: Env): Promise<TypeStat[]> {
  const result = await env.DB.prepare(
    "SELECT type, COUNT(*) AS count FROM memories WHERE namespace = 'default' AND status = 'active' GROUP BY type ORDER BY count DESC, type ASC LIMIT 12"
  ).all<TypeStat>();
  return result.results ?? [];
}

async function fetchRecent(env: Env): Promise<Array<{ id: string; type: string; created_at: string; content: string }>> {
  const result = await env.DB.prepare(
    "SELECT id, type, created_at, content FROM memories WHERE namespace = 'default' AND status = 'active' ORDER BY created_at DESC LIMIT 5"
  ).all<{ id: string; type: string; created_at: string; content: string }>();
  return result.results ?? [];
}

async function fetchTaskCounts(env: Env): Promise<Array<{ status: string; count: number }>> {
  try {
    const result = await env.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM idempotency_keys GROUP BY status ORDER BY count DESC, status ASC"
    ).all<{ status: string; count: number }>();
    return result.results ?? [];
  } catch (error) {
    console.warn("maintenance task counts unavailable", error);
    return [];
  }
}

async function fetchMemoryOutputs(env: Env): Promise<Array<{ type: string; count: number; latest: string | null }>> {
  try {
    const result = await env.DB.prepare(
      `SELECT type, COUNT(*) AS count, MAX(created_at) AS latest
       FROM memories
       WHERE namespace = 'default'
         AND status = 'active'
         AND type IN ('timeline_day', 'diary', 'layla_diary', 'chunk')
       GROUP BY type
       ORDER BY latest DESC, type ASC`
    ).all<{ type: string; count: number; latest: string | null }>();
    return result.results ?? [];
  } catch (error) {
    console.warn("maintenance memory outputs unavailable", error);
    return [];
  }
}

async function fetchMessageChunkStats(env: Env): Promise<PipelineStatus["messageChunkStats"]> {
  try {
    const row = await env.DB.prepare(
      `SELECT
        SUM(CASE WHEN chunk_processed_at IS NULL THEN 1 ELSE 0 END) AS unprocessed,
        SUM(CASE WHEN chunk_processed_at IS NOT NULL THEN 1 ELSE 0 END) AS processed
       FROM messages
       WHERE namespace = 'default'
         AND role IN ('user', 'assistant')
         AND content != ''`
    ).first<{ processed: number | null; unprocessed: number | null }>();
    return { processed: row?.processed ?? 0, unprocessed: row?.unprocessed ?? 0, unavailable: false };
  } catch (error) {
    console.warn("maintenance message chunk stats unavailable", error);
    return { processed: null, unprocessed: null, unavailable: true };
  }
}

async function fetchPipelineStatus(env: Env): Promise<PipelineStatus> {
  const [taskCounts, memoryOutputs, messageChunkStats] = await Promise.all([
    fetchTaskCounts(env),
    fetchMemoryOutputs(env),
    fetchMessageChunkStats(env)
  ]);
  return {
    queueBinding: Boolean(env.MEMORY_QUEUE),
    autoMemoryEnabled: env.ENABLE_AUTO_MEMORY !== "false" && (env.MEMORY_MODE || "external") !== "none",
    autoDiaryEnabled: env.AUTO_DIARY_ENABLED === "true",
    taskCounts,
    memoryOutputs,
    messageChunkStats
  };
}

function renderTypeRows(types: TypeStat[]): string {
  if (types.length === 0) return "<tr><td colspan=\"2\">暂无 active 记忆</td></tr>";
  return types.map((item) => `<tr><td>${htmlEscape(item.type || "note")}</td><td>${item.count}</td></tr>`).join("");
}

function renderRecentRows(rows: Array<{ id: string; type: string; created_at: string; content: string }>): string {
  if (rows.length === 0) return "<tr><td colspan=\"4\">暂无 recent 记忆</td></tr>";
  return rows.map((item) => `<tr><td>${htmlEscape(item.created_at.slice(0, 10))}</td><td>${htmlEscape(item.type)}</td><td>${htmlEscape(item.id)}</td><td>${htmlEscape(item.content.slice(0, 80))}</td></tr>`).join("");
}

function renderTaskRows(rows: Array<{ status: string; count: number }>): string {
  if (rows.length === 0) return "<tr><td colspan=\"2\">暂无后台任务记录，或 idempotency 表不可用</td></tr>";
  return rows.map((item) => `<tr><td>${htmlEscape(item.status)}</td><td>${item.count}</td></tr>`).join("");
}

function renderOutputRows(rows: Array<{ type: string; count: number; latest: string | null }>): string {
  if (rows.length === 0) return "<tr><td colspan=\"3\">暂无 diary / timeline_day / chunk 类型产出</td></tr>";
  return rows.map((item) => `<tr><td>${htmlEscape(item.type)}</td><td>${item.count}</td><td>${htmlEscape((item.latest || "").slice(0, 10) || "-")}</td></tr>`).join("");
}

function renderMessageChunkRows(stats: PipelineStatus["messageChunkStats"]): string {
  if (stats.unavailable) {
    return '<tr><td colspan="2">messages.chunk_processed_at 不可用；这通常说明当前 D1 schema 还没补该列</td></tr>';
  }
  return `<tr><td>processed messages</td><td>${stats.processed}</td></tr><tr><td>unprocessed messages</td><td>${stats.unprocessed}</td></tr>`;
}

function renderRetentionNote(): string {
  const activeText = RETENTION_POLICY.activeMemoryAutoExpiry
    ? "active 长期记忆会按策略自动过期。"
    : "active 长期记忆不会自动过期。";

  return `<span class="ok">${activeText}</span> 临时聊天 messages 保留 ${RETENTION_POLICY.messagesDays} 天，usage logs / memory events 保留 ${RETENTION_POLICY.usageLogsDays} 天。手动删除后的记忆会先变成 deleted，超过 ${RETENTION_POLICY.terminalMemoryHardDeleteDays} 天后才可能被物理清理。`;
}

function renderPipelineStatus(pipeline: PipelineStatus): string {
  const diaryNote = pipeline.autoDiaryEnabled
    ? '<span class="ok">AUTO_DIARY_ENABLED=true，chunk/diary 生成路径已开启。</span>'
    : '<span class="warn">AUTO_DIARY_ENABLED=false，conversation_chunk 只会标记 processed，不会生成 diary/chunk memory。</span>';

  return `<section class="card"><div class="section-title">后台管线状态</div><div class="note">只读状态面板：这里不触发 queue、不补跑 chunk、不判断异常，只展示当前配置和已有记录。${diaryNote}</div><div class="two"><div><table><tbody><tr><td>Queue binding</td><td>${boolLabel(pipeline.queueBinding)}</td></tr><tr><td>Auto memory</td><td>${boolLabel(pipeline.autoMemoryEnabled)}</td></tr><tr><td>Auto diary / chunk generation</td><td>${boolLabel(pipeline.autoDiaryEnabled)}</td></tr></tbody></table></div><div><table><thead><tr><th>task status</th><th>count</th></tr></thead><tbody>${renderTaskRows(pipeline.taskCounts)}</tbody></table></div></div><div class="two"><div><div class="section-title">messages chunk 标记</div><table><tbody>${renderMessageChunkRows(pipeline.messageChunkStats)}</tbody></table></div><div><div class="section-title">diary / chunk 产出</div><table><thead><tr><th>type</th><th>count</th><th>latest</th></tr></thead><tbody>${renderOutputRows(pipeline.memoryOutputs)}</tbody></table></div></div></section>`;
}

function renderPage(stats: MaintenanceStats, types: TypeStat[], recent: Array<{ id: string; type: string; created_at: string; content: string }>, pipeline: PipelineStatus): string {
  const vectorPercent = stats.active ? Math.round((stats.vectorReady / stats.active) * 100) : 0;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Memory Home Maintenance</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#fff0f3;color:#5c4a4f;font-family:Georgia,'Noto Serif SC',serif;padding:24px}.page{max-width:860px;margin:0 auto}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px}h1{font-size:1.35rem;font-weight:400;color:#d4899a;margin:0}.nav{display:flex;gap:8px;flex-wrap:wrap}.nav a,.pill{border:1px solid rgba(212,137,154,.45);border-radius:999px;padding:7px 12px;color:#d4899a;text-decoration:none;background:#fffbfc;font-size:.82rem}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:#fffbfc;border:1px solid rgba(232,160,176,.24);border-radius:14px;padding:16px;box-shadow:0 4px 18px rgba(232,160,176,.16);margin-bottom:14px}.value{font-size:1.45rem;color:#d4899a}.label{font-size:.72rem;color:#9a8389;margin-top:4px}.section-title{font-size:.9rem;color:#9a8389;letter-spacing:1px;margin:4px 0 12px}.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}table{width:100%;border-collapse:collapse;font-size:.82rem}td,th{border-bottom:1px solid rgba(232,160,176,.18);padding:8px 4px;text-align:left;vertical-align:top}th{color:#9a8389;font-weight:400}.note{line-height:1.75;font-size:.86rem;color:#6a555b;margin-bottom:12px}.ok{color:#548765}.warn{color:#9a6b43}@media(max-width:720px){.grid{grid-template-columns:repeat(2,1fr)}.two{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
  </style></head><body><main class="page"><div class="top"><div><h1>Memory Home Maintenance</h1><div class="label">后台维护状态</div></div><nav class="nav"><a href="/admin/memories">记忆小家</a><a href="/admin/startup-context">Startup</a><a href="/health">Health</a></nav></div>
  <section class="grid"><div class="card"><div class="value">${stats.total}</div><div class="label">总记忆</div></div><div class="card"><div class="value">${stats.active}</div><div class="label">active</div></div><div class="card"><div class="value">${stats.deleted}</div><div class="label">deleted</div></div><div class="card"><div class="value">${vectorPercent}%</div><div class="label">可索引记忆</div></div></section>
  ${renderPipelineStatus(pipeline)}
  <section class="two"><div class="card"><div class="section-title">来源</div><table><tbody><tr><td>旧 VPS 迁移</td><td>${stats.legacyVps}</td></tr><tr><td>前端写入</td><td>${stats.adminBoard}</td></tr><tr><td>expired</td><td>${stats.expired}</td></tr><tr><td>superseded</td><td>${stats.superseded}</td></tr><tr><td>low confidence</td><td>${stats.lowConfidence}</td></tr></tbody></table></div><div class="card"><div class="section-title">类型分布</div><table><thead><tr><th>type</th><th>count</th></tr></thead><tbody>${renderTypeRows(types)}</tbody></table></div></section>
  <section class="card"><div class="section-title">保留策略</div><div class="note">${renderRetentionNote()}</div></section>
  <section class="card"><div class="section-title">Vectorize 说明</div><div class="note"><span class="warn">这里的“可索引记忆”来自 D1 的 vector_id 字段，不等于 Cloudflare 面板的 stored vector 实时计数。</span> 它用于判断哪些 active 记忆具备向量索引身份；真正的语义搜索会先查 Vectorize，查不到时再走文字搜索兜底。</div></section>
  <section class="card"><div class="section-title">最近写入</div><table><thead><tr><th>date</th><th>type</th><th>id</th><th>content</th></tr></thead><tbody>${renderRecentRows(recent)}</tbody></table></section>
  </main></body></html>`;
}

export async function handleAdminMaintenance(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const [stats, types, recent, pipeline] = await Promise.all([fetchStats(env), fetchTypes(env), fetchRecent(env), fetchPipelineStatus(env)]);
  return new Response(renderPage(stats, types, recent, pipeline), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
