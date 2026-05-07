import { softDeleteMemory } from "../db/memories";
import { deleteMemoryEmbedding } from "../memory/embedding";
import { buildStartupContext } from "../memory/startupContext";
import type { Env, MemoryRecord } from "../types";

interface PageInput {
  q: string;
  type: string;
  status: string;
  page: number;
}

const PAGE_SIZE = 12;

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attr(value: unknown): string {
  return htmlEscape(value).replaceAll("`", "&#96;");
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Aelios memories"' }
  });
}

function adminPassword(env: Env): string | null {
  return env.ADMIN_PASSWORD || env.MEMORY_MCP_API_KEY || null;
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = adminPassword(env);
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    return password === expected;
  } catch {
    return false;
  }
}

function inputFromUrl(url: URL): PageInput {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || "1") || 1));
  const status = url.searchParams.get("status") || "active";
  return {
    q: (url.searchParams.get("q") || "").trim().slice(0, 200),
    type: (url.searchParams.get("type") || "").trim().slice(0, 80),
    status: ["active", "deleted", "superseded", "all"].includes(status) ? status : "active",
    page
  };
}

function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

async function fetchTypes(env: Env): Promise<Array<{ type: string; count: number }>> {
  const result = await env.DB
    .prepare("SELECT type, COUNT(*) AS count FROM memories WHERE status = 'active' GROUP BY type ORDER BY type")
    .all<{ type: string; count: number }>();
  return result.results ?? [];
}

async function fetchStats(env: Env): Promise<{ active: number; deleted: number; total: number }> {
  const rows = await env.DB
    .prepare("SELECT status, COUNT(*) AS count FROM memories GROUP BY status")
    .all<{ status: string; count: number }>();
  const map = new Map((rows.results ?? []).map((row) => [row.status, row.count]));
  const active = map.get("active") ?? 0;
  const deleted = map.get("deleted") ?? 0;
  return { active, deleted, total: [...map.values()].reduce((sum, count) => sum + count, 0) };
}

async function fetchMemories(env: Env, input: PageInput): Promise<{ total: number; records: MemoryRecord[] }> {
  let where = "WHERE namespace = 'default'";
  const binds: unknown[] = [];

  if (input.status !== "all") {
    where += " AND status = ?";
    binds.push(input.status);
  }
  if (input.type) {
    where += " AND type = ?";
    binds.push(input.type);
  }
  if (input.q) {
    const pattern = like(input.q);
    where += " AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
    binds.push(pattern, pattern, pattern, pattern, pattern);
  }

  const total = await env.DB
    .prepare(`SELECT COUNT(*) AS count FROM memories ${where}`)
    .bind(...binds)
    .first<{ count: number }>();

  const offset = (input.page - 1) * PAGE_SIZE;
  const result = await env.DB
    .prepare(`SELECT * FROM memories ${where} ORDER BY pinned DESC, updated_at DESC, created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE, offset)
    .all<MemoryRecord>();

  return { total: total?.count ?? 0, records: result.results ?? [] };
}

function qs(input: PageInput, patch: Partial<PageInput>): string {
  const next = { ...input, ...patch };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.type) params.set("type", next.type);
  if (next.status !== "active") params.set("status", next.status);
  if (next.page > 1) params.set("page", String(next.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function renderMemory(record: MemoryRecord): string {
  const tags = parseTags(record.tags);
  const tagHtml = tags.map((tag) => `<span class="tag-pill">${htmlEscape(tag)}</span>`).join("");
  return `<article class="memory-card ${record.status !== "active" ? "muted" : ""}">
    <div class="memory-head">
      <span class="type-pill">${htmlEscape(record.type || "note")}</span>
      <span class="memory-time">${htmlEscape(formatDate(record.updated_at || record.created_at))}</span>
    </div>
    <div class="memory-content">${htmlEscape(record.content)}</div>
    <div class="memory-meta">
      ${record.pinned ? '<span class="score-pill">pinned</span>' : ""}
      <span class="score-pill">${htmlEscape(record.id)}</span>
      <span class="score-pill">importance ${Number(record.importance || 0).toFixed(2)}</span>
      <span class="score-pill">recall ${record.recall_count || 0}</span>
      ${tagHtml}
    </div>
    <details class="memory-detail">
      <summary>展开详情</summary>
      <div>created: ${htmlEscape(formatDate(record.created_at))}</div>
      <div>updated: ${htmlEscape(formatDate(record.updated_at))}</div>
      <div>source: ${htmlEscape(record.source || "")}</div>
      <div>vector: ${htmlEscape(record.vector_id || "")}</div>
      <div>status: ${htmlEscape(record.status)}</div>
    </details>
  </article>`;
}

function renderPagination(input: PageInput, total: number): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const buttons: string[] = [];
  buttons.push(`<a class="page-btn ${input.page <= 1 ? "disabled" : ""}" href="${input.page <= 1 ? "#" : qs(input, { page: input.page - 1 })}">上一页</a>`);
  const start = Math.max(1, input.page - 2);
  const end = Math.min(pages, input.page + 2);
  for (let page = start; page <= end; page += 1) {
    buttons.push(`<a class="page-btn ${page === input.page ? "active" : ""}" href="${qs(input, { page })}">${page}</a>`);
  }
  buttons.push(`<a class="page-btn ${input.page >= pages ? "disabled" : ""}" href="${input.page >= pages ? "#" : qs(input, { page: input.page + 1 })}">下一页</a>`);
  return `<div class="pagination">${buttons.join("")}</div>`;
}

function renderPage(input: PageInput, data: {
  stats: { active: number; deleted: number; total: number };
  types: Array<{ type: string; count: number }>;
  total: number;
  records: MemoryRecord[];
  warmth: { found_count?: number; required_count?: number; missing_count?: number };
}): string {
  const typeOptions = ['<option value="">全部类型</option>']
    .concat(data.types.map((item) => `<option value="${attr(item.type)}" ${item.type === input.type ? "selected" : ""}>${htmlEscape(item.type || "note")} (${item.count})</option>`))
    .join("");
  const statusOptions = ["active", "deleted", "all"].map((status) => `<option value="${status}" ${status === input.status ? "selected" : ""}>${status}</option>`).join("");
  const list = data.records.length ? data.records.map(renderMemory).join("") : '<div class="empty">没有找到记忆</div>';

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>记忆浏览</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--pink:#e8a0b0;--pink-dark:#d4899a;--pink-light:#fff0f3;--blue:#8fa8c0;--blue-dark:#7a92a8;--text:#5c4a4f;--text-light:#9a8389;--white:#fffbfc;--shadow:rgba(232,160,176,.2)}html{background:linear-gradient(135deg,#fff0f3 0%,#fce4ec 100%);min-height:100vh}body{font-family:Georgia,'Noto Serif SC','Songti SC',serif;color:var(--text);min-height:100vh;padding:24px 16px 60px}.page{max-width:760px;margin:0 auto}header{text-align:center;padding:28px 0 22px}.heart{font-size:1.8rem;margin-bottom:10px}h1{font-size:1.35rem;font-weight:400;color:var(--pink-dark);margin-bottom:6px}.subtitle{font-size:.72rem;color:var(--text-light);letter-spacing:2px}.card,.memory-card{background:var(--white);border-radius:16px;padding:20px;margin-bottom:16px;box-shadow:0 4px 20px var(--shadow);border:1px solid rgba(232,160,176,.2)}.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.stat-item{border:1px solid rgba(232,160,176,.25);border-radius:12px;padding:10px 8px;background:rgba(255,255,255,.58);text-align:center}.stat-value{display:block;color:var(--pink-dark);font-size:1.05rem;font-weight:500}.stat-label{display:block;color:var(--text-light);font-size:.62rem;margin-top:3px}.filters{display:grid;grid-template-columns:1fr 150px 120px auto;gap:8px}input,select{width:100%;font-family:inherit;font-size:.86rem;padding:10px 12px;border-radius:10px;border:1px solid var(--pink);background:var(--white);color:var(--text);outline:none}.btn{background:linear-gradient(135deg,var(--pink) 0%,var(--pink-dark) 100%);color:#fff;border:none;font-family:inherit;font-size:.82rem;letter-spacing:2px;padding:10px 18px;cursor:pointer;border-radius:20px;box-shadow:0 3px 10px var(--shadow)}.header-row{display:flex;align-items:center;gap:10px;margin-bottom:14px}.section-title{font-size:.72rem;letter-spacing:2px;color:var(--text-light)}.divider{flex:1;height:1px;background:var(--pink);opacity:.3}.small-link{color:var(--pink-dark);font-size:.72rem;text-decoration:none}.memory-card{border-radius:12px;padding:16px;animation:slideIn .25s ease}.memory-card.muted{opacity:.72}.memory-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(232,160,176,.15)}.type-pill,.tag-pill,.score-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;background:var(--pink-light);color:var(--pink-dark);font-size:.68rem}.score-pill{background:rgba(143,168,192,.16);color:var(--blue-dark)}.memory-time{font-size:.7rem;color:var(--text-light)}.memory-content{font-size:.92rem;line-height:1.75;white-space:pre-wrap;word-wrap:break-word}.memory-meta{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.memory-detail{margin-top:10px;padding-top:10px;border-top:1px dashed rgba(232,160,176,.45);color:var(--text-light);font-size:.7rem;line-height:1.7}.pagination{display:flex;justify-content:center;gap:8px;margin-top:18px;flex-wrap:wrap}.page-btn{background:var(--white);border:1px solid var(--pink);color:var(--pink-dark);font-size:.75rem;padding:7px 12px;border-radius:8px;text-decoration:none}.page-btn.active{background:var(--pink);color:#fff}.page-btn.disabled{opacity:.35;pointer-events:none}.empty{text-align:center;color:var(--text-light);font-size:.85rem;padding:24px 0}@keyframes slideIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@media(max-width:640px){.page{max-width:480px}.stat-grid{grid-template-columns:repeat(2,1fr)}.filters{grid-template-columns:1fr}.card{padding:18px}.memory-card{padding:15px}}
</style></head><body><div class="page"><header><div class="heart">♡</div><h1>记忆浏览</h1><div class="subtitle">AELIOS MEMORY</div></header>
<section class="card"><div class="stat-grid"><div class="stat-item"><span class="stat-value">${data.stats.active}</span><span class="stat-label">active</span></div><div class="stat-item"><span class="stat-value">${data.stats.deleted}</span><span class="stat-label">deleted</span></div><div class="stat-item"><span class="stat-value">${data.total}</span><span class="stat-label">当前结果</span></div><div class="stat-item"><span class="stat-value">${data.warmth.found_count ?? 0}/${data.warmth.required_count ?? 11}</span><span class="stat-label">warmth</span></div></div></section>
<section class="card"><form class="filters" method="GET"><input name="q" value="${attr(input.q)}" placeholder="搜一句话：brat / 复述 / 穿普拉达..."><select name="type">${typeOptions}</select><select name="status">${statusOptions}</select><button class="btn" type="submit">搜索</button></form></section>
<div class="header-row"><span class="section-title">记忆列表</span><div class="divider"></div><a class="small-link" href="/admin/memories">清除筛选</a></div>
${list}${renderPagination(input, data.total)}</div></body></html>`;
}

export async function handleAdminMemories(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();

  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/admin/memories/delete") {
    const form = await request.formData();
    const id = String(form.get("id") || "").trim();
    if (id) {
      const deleted = await softDeleteMemory(env.DB, { namespace: "default", id });
      if (deleted) ctx.waitUntil(deleteMemoryEmbedding(env, deleted));
    }
    return Response.redirect(`${url.origin}/admin/memories`, 303);
  }

  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const input = inputFromUrl(url);
  const [stats, types, memories, startup] = await Promise.all([
    fetchStats(env),
    fetchTypes(env),
    fetchMemories(env, input),
    buildStartupContext(env.DB, "default")
  ]);
  return new Response(renderPage(input, {
    stats,
    types,
    total: memories.total,
    records: memories.records,
    warmth: startup.required_warmth as { found_count?: number; required_count?: number; missing_count?: number }
  }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
