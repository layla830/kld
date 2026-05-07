import { createMemory, softDeleteMemory } from "../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import { buildStartupContext } from "../memory/startupContext";
import type { Env, MemoryRecord } from "../types";

interface PageInput {
  q: string;
  type: string;
  status: string;
  page: number;
  tab: string;
}

const PAGE_SIZE = 10;
const TABS = [
  { id: "message", label: "留言板" },
  { id: "diary", label: "交换日记" },
  { id: "quote", label: "语录" },
  { id: "browse", label: "记忆浏览" }
];

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

function formatTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
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
  const tab = url.searchParams.get("tab") || "message";
  return {
    q: (url.searchParams.get("q") || "").trim().slice(0, 200),
    type: (url.searchParams.get("type") || "").trim().slice(0, 80),
    status: ["active", "deleted", "superseded", "all"].includes(status) ? status : "active",
    tab: TABS.some((item) => item.id === tab) ? tab : "message",
    page
  };
}

function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function readFormText(form: FormData, name: string): string {
  return String(form.get(name) || "").trim();
}

async function createBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const kind = readFormText(form, "kind");
  const content = readFormText(form, "content");
  if (!content) return null;

  let type = "note";
  let tags = ["admin-board"];
  let pinned = false;

  if (kind === "message") {
    tags = ["留言", "admin-board"];
  } else if (kind === "diary") {
    const author = readFormText(form, "author") || "layla";
    type = author === "kld" ? "diary" : "layla_diary";
    tags = ["日记", author, "admin-board"];
  } else if (kind === "quote") {
    const category = readFormText(form, "category") || "语录";
    tags = ["语录", category, "admin-board"];
  } else if (kind === "memory") {
    type = readFormText(form, "memory_type") || "note";
    tags = readFormText(form, "tags").split(",").map((tag) => tag.trim()).filter(Boolean);
    tags.push("admin-board");
    pinned = readFormText(form, "pinned") === "on";
  }

  return createMemory(env.DB, {
    namespace: "default",
    type,
    content,
    summary: null,
    importance: pinned ? 1 : 0.65,
    confidence: 0.95,
    status: "active",
    pinned,
    tags: [...new Set(tags)],
    source: "admin-board",
    sourceMessageIds: [],
    expiresAt: null
  });
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

function applyTabWhere(input: PageInput, binds: unknown[]): string {
  if (input.tab === "message") {
    binds.push(like("留言"));
    return " AND tags LIKE ? ESCAPE '\\'";
  }
  if (input.tab === "diary") {
    binds.push("diary", "layla_diary", like("日记"));
    return " AND (type IN (?, ?) OR tags LIKE ? ESCAPE '\\')";
  }
  if (input.tab === "quote") {
    binds.push(like("语录"));
    return " AND tags LIKE ? ESCAPE '\\'";
  }
  return "";
}

async function fetchMemories(env: Env, input: PageInput): Promise<{ total: number; records: MemoryRecord[] }> {
  let where = "WHERE namespace = 'default'";
  const binds: unknown[] = [];

  if (input.status !== "all") {
    where += " AND status = ?";
    binds.push(input.status);
  }
  where += applyTabWhere(input, binds);

  if (input.type && input.tab === "browse") {
    where += " AND type = ?";
    binds.push(input.type);
  }
  if (input.q) {
    const pattern = like(input.q);
    where += " AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
    binds.push(pattern, pattern, pattern, pattern, pattern);
  }

  const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM memories ${where}`).bind(...binds).first<{ count: number }>();
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
  if (next.tab !== "message") params.set("tab", next.tab);
  if (next.q) params.set("q", next.q);
  if (next.type && next.tab === "browse") params.set("type", next.type);
  if (next.status !== "active") params.set("status", next.status);
  if (next.page > 1) params.set("page", String(next.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function renderTabs(input: PageInput): string {
  return `<nav class="tabs">${TABS.map((tab) => `<a class="tab ${input.tab === tab.id ? "active" : ""}" href="${qs(input, { tab: tab.id, page: 1, q: "", type: "" })}">${tab.label}</a>`).join("")}</nav>`;
}

function renderComposer(input: PageInput): string {
  if (input.tab === "message") {
    return `<section class="main-card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="message"><textarea class="hero-textarea" name="content" placeholder="给小克留言..."></textarea><div class="composer-foot"><span class="counter">0</span><button class="btn" type="submit">发送</button></div></form></section>`;
  }
  if (input.tab === "diary") {
    return `<section class="main-card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="diary"><select name="author"><option value="layla">Layla</option><option value="kld">KLD</option></select><textarea class="hero-textarea" name="content" placeholder="今天发生了什么"></textarea><div class="composer-foot"><span class="hint">交换日记</span><button class="btn" type="submit">保存</button></div></form></section>`;
  }
  if (input.tab === "quote") {
    return `<section class="main-card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="quote"><input name="category" placeholder="分类，例如：她说的"><textarea class="hero-textarea" name="content" placeholder="那句想留下来的话"></textarea><div class="composer-foot"><span class="hint">语录收藏</span><button class="btn" type="submit">收藏</button></div></form></section>`;
  }
  return `<section class="main-card"><form class="browse-form" method="GET"><input type="hidden" name="tab" value="browse"><input name="q" value="${attr(input.q)}" placeholder="搜索完整记忆"><select name="type"><option value="">全部类型</option></select><select name="status"><option value="active" ${input.status === "active" ? "selected" : ""}>active</option><option value="deleted" ${input.status === "deleted" ? "selected" : ""}>deleted</option><option value="all" ${input.status === "all" ? "selected" : ""}>all</option></select><button class="btn" type="submit">搜索</button></form></section>`;
}

function renderMemory(record: MemoryRecord, tab: string): string {
  const tags = parseTags(record.tags);
  const tagHtml = tags.slice(0, 5).map((tag) => `<span class="tag-pill">${htmlEscape(tag)}</span>`).join("");
  const deleteForm = record.status === "active"
    ? `<form method="POST" action="/admin/memories/delete" class="delete-form"><input type="hidden" name="id" value="${attr(record.id)}"><button class="text-btn delete" type="submit">删除</button></form>`
    : "";
  const editText = tab === "browse" ? "详情" : "编辑";
  return `<article class="memory-card ${record.status !== "active" ? "muted" : ""}"><time>${htmlEscape(formatTime(record.updated_at || record.created_at))}</time><div class="memory-content">${htmlEscape(record.content)}</div><div class="soft-line"></div><div class="memory-meta"><span class="type-pill">${htmlEscape(record.type || "note")}</span>${record.pinned ? '<span class="tag-pill">pinned</span>' : ""}${tagHtml}</div><div class="actions"><details><summary>${editText}</summary><div class="detail-lines"><div>id: ${htmlEscape(record.id)}</div><div>source: ${htmlEscape(record.source || "")}</div><div>status: ${htmlEscape(record.status)}</div><div>importance: ${Number(record.importance || 0).toFixed(2)}</div></div></details>${deleteForm}</div></article>`;
}

function renderPagination(input: PageInput, total: number): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return "";
  return `<div class="pagination"><a class="page-link ${input.page <= 1 ? "disabled" : ""}" href="${input.page <= 1 ? "#" : qs(input, { page: input.page - 1 })}">上一页</a><span>${input.page} / ${pages}</span><a class="page-link ${input.page >= pages ? "disabled" : ""}" href="${input.page >= pages ? "#" : qs(input, { page: input.page + 1 })}">下一页</a></div>`;
}

function renderBrowseTypeOptions(types: Array<{ type: string; count: number }>, selected: string): string {
  return ['<option value="">全部类型</option>'].concat(types.map((item) => `<option value="${attr(item.type)}" ${item.type === selected ? "selected" : ""}>${htmlEscape(item.type || "note")} (${item.count})</option>`)).join("");
}

function renderPage(input: PageInput, data: {
  stats: { active: number; deleted: number; total: number };
  types: Array<{ type: string; count: number }>;
  total: number;
  records: MemoryRecord[];
  warmth: { found_count?: number; required_count?: number; missing_count?: number };
}): string {
  const listTitle = input.tab === "message" ? "历史留言" : input.tab === "diary" ? "日记记录" : input.tab === "quote" ? "收藏语录" : "完整记忆";
  const list = data.records.length ? data.records.map((record) => renderMemory(record, input.tab)).join("") : '<div class="empty">这里还没有内容</div>';
  const composer = renderComposer(input).replace('<select name="type"><option value="">全部类型</option></select>', `<select name="type">${renderBrowseTypeOptions(data.types, input.type)}</select>`);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>我们的记忆小家</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--pink:#d98aa1;--pink-dark:#c8768f;--pink-soft:#f8dfe7;--paper:#fffdfd;--ink:#66565c;--muted:#aa929a;--line:rgba(216,138,161,.28);--shadow:rgba(216,138,161,.18)}html{min-height:100%;background:linear-gradient(180deg,#f9e9ef 0%,#fff7fa 42%,#fce8ef 100%)}body{min-height:100%;font-family:Georgia,'Noto Serif SC','Songti SC',serif;color:var(--ink);padding:22px 14px 56px}.page{width:min(900px,100%);margin:0 auto}.hero{text-align:center;padding:56px 0 28px}.heart{font-size:2rem;line-height:1;color:#4e4548;margin-bottom:22px}.hero h1{font-weight:400;font-size:1.9rem;letter-spacing:1px;color:#c98a9a;margin-bottom:12px}.subtitle{font-size:.9rem;letter-spacing:7px;color:#a99aa0}.tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;background:rgba(255,255,255,.78);border-radius:24px;padding:8px;margin:0 auto 24px;box-shadow:0 10px 30px var(--shadow);border:1px solid rgba(255,255,255,.8)}.tab{display:flex;align-items:center;justify-content:center;min-height:58px;border-radius:18px;text-decoration:none;color:#8b7880;font-size:1.02rem;white-space:nowrap}.tab.active{background:linear-gradient(135deg,#df96aa,#cd7891);color:white;box-shadow:0 8px 18px var(--shadow)}.main-card,.memory-card{background:rgba(255,255,255,.92);border-radius:24px;border:1px solid rgba(255,255,255,.88);box-shadow:0 12px 34px var(--shadow)}.main-card{padding:28px;margin-bottom:34px}.hero-textarea{min-height:190px;border:0;border-bottom:1px dashed rgba(216,138,161,.58);border-radius:0;background:transparent;padding:4px 8px;font-size:1.1rem;line-height:1.8;resize:vertical;color:var(--ink);outline:none;width:100%;font-family:inherit}.hero-textarea::placeholder,input::placeholder{color:#bbaab0}input,select{width:100%;border:1px solid rgba(216,138,161,.62);border-radius:14px;background:rgba(255,255,255,.76);padding:14px 16px;font-family:inherit;font-size:1rem;color:var(--ink);outline:none;margin-bottom:14px}.composer-foot{display:flex;align-items:center;justify-content:space-between;margin-top:20px}.counter,.hint{color:var(--muted);font-size:.95rem}.btn{border:0;border-radius:999px;background:linear-gradient(135deg,#df96aa,#cc7891);color:#fff;font-family:inherit;font-size:1.05rem;letter-spacing:2px;padding:16px 34px;box-shadow:0 8px 18px var(--shadow);cursor:pointer}.section-head{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;margin:0 0 18px;color:#8f7b83}.section-head span{font-size:1rem;white-space:nowrap}.section-head::after{content:"";height:1px;background:var(--line)}.refresh{border:1px solid rgba(216,138,161,.55);border-radius:16px;padding:10px 18px;text-decoration:none;color:#c07d92;background:rgba(255,255,255,.5)}.stats{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:-8px 0 22px}.stat{font-size:.72rem;color:#b0969f;background:rgba(255,255,255,.52);border:1px solid rgba(216,138,161,.22);border-radius:999px;padding:6px 10px}.browse-form{display:grid;grid-template-columns:1fr 150px 120px auto;gap:10px}.browse-form input,.browse-form select{margin-bottom:0}.memory-list{display:grid;gap:18px}.memory-card{padding:24px}.memory-card.muted{opacity:.66}.memory-card time{display:block;color:#9c8b90;font-size:.95rem;margin-bottom:14px}.memory-content{font-size:1.08rem;line-height:1.85;white-space:pre-wrap;word-break:break-word}.soft-line{height:1px;background:rgba(216,138,161,.14);margin:18px 0 12px}.memory-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.type-pill,.tag-pill{border-radius:999px;background:#fff0f4;color:#c0768e;padding:5px 10px;font-size:.76rem}.actions{display:flex;gap:20px;align-items:center;color:#b58b99}.actions details{font-size:.92rem}.actions summary{cursor:pointer;list-style:none}.text-btn{border:0;background:transparent;color:#b58b99;font-family:inherit;font-size:.92rem;cursor:pointer}.text-btn.delete{color:#b77d8d}.detail-lines{margin-top:10px;font-size:.76rem;line-height:1.7;color:#9c8b90;word-break:break-all}.empty{text-align:center;color:#ad979f;background:rgba(255,255,255,.65);border-radius:20px;padding:36px}.pagination{display:flex;justify-content:center;align-items:center;gap:18px;margin:24px 0;color:#9d8990}.page-link{color:#c07d92;text-decoration:none;border:1px solid rgba(216,138,161,.48);border-radius:14px;padding:9px 14px;background:rgba(255,255,255,.55)}.page-link.disabled{opacity:.38;pointer-events:none}@media(max-width:700px){body{padding:0 18px 44px}.hero{padding:70px 0 28px}.hero h1{font-size:1.65rem}.subtitle{font-size:.78rem;letter-spacing:5px}.tabs{gap:4px;padding:6px;border-radius:22px}.tab{min-height:50px;font-size:.92rem;border-radius:16px}.main-card{padding:24px 20px;border-radius:22px}.hero-textarea{min-height:175px}.browse-form{grid-template-columns:1fr}.btn{font-size:1rem;padding:14px 30px}.memory-card{padding:22px 20px;border-radius:22px}.memory-content{font-size:1.03rem}.stats{display:none}}@media(max-width:390px){body{padding-left:12px;padding-right:12px}.tab{font-size:.84rem}.hero h1{font-size:1.48rem}.main-card,.memory-card{padding-left:17px;padding-right:17px}}
</style></head><body><div class="page"><header class="hero"><div class="heart">♡</div><h1>我们的记忆小家</h1><div class="subtitle">MEMORY HOME</div></header>${renderTabs(input)}<div class="stats"><span class="stat">active ${data.stats.active}</span><span class="stat">deleted ${data.stats.deleted}</span><span class="stat">当前 ${data.total}</span><span class="stat">warmth ${data.warmth.found_count ?? 0}/${data.warmth.required_count ?? 11}</span></div>${composer}<div class="section-head"><span>${listTitle}</span><a class="refresh" href="${qs(input, { page: 1 })}">刷新</a></div><section class="memory-list">${list}</section>${renderPagination(input, data.total)}</div></body></html>`;
}

export async function handleAdminMemories(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/admin/memories/create") {
    const form = await request.formData();
    const created = await createBoardMemory(env, form);
    const kind = readFormText(form, "kind");
    const tab = kind === "diary" ? "diary" : kind === "quote" ? "quote" : kind === "memory" ? "browse" : "message";
    if (created) ctx.waitUntil(upsertMemoryEmbedding(env, created));
    return Response.redirect(`${url.origin}/admin/memories${qs(inputFromUrl(new URL(`${url.origin}/admin/memories?tab=${tab}`)), { tab })}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/delete") {
    const id = readFormText(await request.formData(), "id");
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
