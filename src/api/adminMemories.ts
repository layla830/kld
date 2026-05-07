import { createMemory, softDeleteMemory } from “../db/memories”;
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from “../memory/embedding”;
import type { Env, MemoryRecord } from “../types”;

interface PageInput {
q: string;
type: string;
status: string;
page: number;
tab: string;
}

interface HeatDay {
day: string;
count: number;
}

const PAGE_SIZE = 8;
const TABS = [
{ id: “message”, label: “留言板” },
{ id: “diary”, label: “交换日记” },
{ id: “quote”, label: “语录” },
{ id: “browse”, label: “记忆浏览” }
];

function htmlEscape(value: unknown): string {
return String(value ?? “”)
.replaceAll(”&”, “&”)
.replaceAll(”<”, “<”)
.replaceAll(”>”, “>”)
.replaceAll(’”’, “"”)
.replaceAll(”’”, “'”);
}

function attr(value: unknown): string {
return htmlEscape(value).replaceAll(”`”, “`”);
}

function parseTags(value: string | null): string[] {
if (!value) return [];
try {
const parsed = JSON.parse(value) as unknown;
return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === “string”) : [];
} catch {
return value.split(”,”).map((item) => item.trim()).filter(Boolean);
}
}

function formatTime(value: string | null): string {
if (!value) return “”;
const date = new Date(value);
if (Number.isNaN(date.getTime())) return value;
return date.toLocaleString(“zh-CN”, {
timeZone: “Asia/Shanghai”,
hour12: false,
month: “2-digit”,
day: “2-digit”,
hour: “2-digit”,
minute: “2-digit”
});
}

function unauthorized(): Response {
return new Response(“Authentication required”, {
status: 401,
headers: { “www-authenticate”: ‘Basic realm=“Aelios memories”’ }
});
}

function adminPassword(env: Env): string | null {
return env.ADMIN_PASSWORD || env.MEMORY_MCP_API_KEY || null;
}

function isAuthorized(request: Request, env: Env): boolean {
const expected = adminPassword(env);
if (!expected) return false;
const header = request.headers.get(“authorization”) || “”;
if (!header.toLowerCase().startsWith(“basic “)) return false;
try {
const decoded = atob(header.slice(6));
const password = decoded.includes(”:”) ? decoded.slice(decoded.indexOf(”:”) + 1) : decoded;
return password === expected;
} catch {
return false;
}
}

function inputFromUrl(url: URL): PageInput {
const page = Math.max(1, Math.floor(Number(url.searchParams.get(“page”) || “1”) || 1));
const status = url.searchParams.get(“status”) || “active”;
const tab = url.searchParams.get(“tab”) || “message”;
return {
q: (url.searchParams.get(“q”) || “”).trim().slice(0, 200),
type: (url.searchParams.get(“type”) || “”).trim().slice(0, 80),
status: [“active”, “deleted”, “superseded”, “all”].includes(status) ? status : “active”,
tab: TABS.some((item) => item.id === tab) ? tab : “message”,
page
};
}

function like(value: string): string {
return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function readFormText(form: FormData, name: string): string {
return String(form.get(name) || “”).trim();
}

async function createBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
const kind = readFormText(form, “kind”);
const content = readFormText(form, “content”);
if (!content) return null;

let type = “note”;
let tags = [“admin-board”];
let pinned = false;

if (kind === “message”) {
tags = [“留言”, “admin-board”];
} else if (kind === “diary”) {
const author = readFormText(form, “author”) || “layla”;
type = author === “kld” ? “diary” : “layla_diary”;
tags = [“日记”, author, “admin-board”];
} else if (kind === “quote”) {
const category = readFormText(form, “category”) || “语录”;
tags = [“语录”, category, “admin-board”];
} else if (kind === “memory”) {
type = readFormText(form, “memory_type”) || “note”;
tags = readFormText(form, “tags”).split(”,”).map((tag) => tag.trim()).filter(Boolean);
tags.push(“admin-board”);
pinned = readFormText(form, “pinned”) === “on”;
}

return createMemory(env.DB, {
namespace: “default”,
type,
content,
summary: null,
importance: pinned ? 1 : 0.65,
confidence: 0.95,
status: “active”,
pinned,
tags: […new Set(tags)],
source: “admin-board”,
sourceMessageIds: [],
expiresAt: null
});
}

async function fetchTypes(env: Env): Promise<Array<{ type: string; count: number }>> {
const result = await env.DB
.prepare(“SELECT type, COUNT(*) AS count FROM memories WHERE status = ‘active’ GROUP BY type ORDER BY type”)
.all<{ type: string; count: number }>();
return result.results ?? [];
}

async function fetchStats(env: Env): Promise<{ active: number; deleted: number; total: number; vectorized: number }> {
const result = await env.DB
.prepare(“SELECT COUNT(*) AS total, SUM(CASE WHEN status=‘active’ THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status=‘deleted’ THEN 1 ELSE 0 END) AS deleted, SUM(CASE WHEN vector_id IS NOT NULL AND vector_id != ‘’ THEN 1 ELSE 0 END) AS vectorized FROM memories WHERE namespace = ‘default’”)
.first<{ total: number; active: number; deleted: number; vectorized: number }>();
return { active: result?.active ?? 0, deleted: result?.deleted ?? 0, total: result?.total ?? 0, vectorized: result?.vectorized ?? 0 };
}

async function fetchHeatmap(env: Env): Promise<HeatDay[]> {
const since = new Date();
since.setUTCDate(since.getUTCDate() - 89);
const sinceText = since.toISOString().slice(0, 10);
const rows = await env.DB
.prepare(“SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM memories WHERE namespace = ‘default’ AND created_at >= ? GROUP BY day”)
.bind(sinceText)
.all<HeatDay>();
const counts = new Map((rows.results ?? []).map((row) => [row.day, row.count]));
const days: HeatDay[] = [];
for (let i = 89; i >= 0; i -= 1) {
const date = new Date();
date.setUTCDate(date.getUTCDate() - i);
const day = date.toISOString().slice(0, 10);
days.push({ day, count: counts.get(day) ?? 0 });
}
return days;
}

function applyTabWhere(input: PageInput, binds: unknown[]): string {
if (input.tab === “message”) {
binds.push(like(“留言”));
return “ AND tags LIKE ? ESCAPE ‘\’”;
}
if (input.tab === “diary”) {
binds.push(“diary”, “layla_diary”, like(“日记”));
return “ AND (type IN (?, ?) OR tags LIKE ? ESCAPE ‘\’)”;
}
if (input.tab === “quote”) {
binds.push(like(“语录”));
return “ AND tags LIKE ? ESCAPE ‘\’”;
}
return “”;
}

async function fetchMemories(env: Env, input: PageInput): Promise<{ total: number; records: MemoryRecord[] }> {
let where = “WHERE namespace = ‘default’”;
const binds: unknown[] = [];

if (input.status !== “all”) {
where += “ AND status = ?”;
binds.push(input.status);
}
where += applyTabWhere(input, binds);

if (input.type && input.tab === “browse”) {
where += “ AND type = ?”;
binds.push(input.type);
}
if (input.q) {
const pattern = like(input.q);
where += “ AND (content LIKE ? ESCAPE ‘\’ OR tags LIKE ? ESCAPE ‘\’)”;
binds.push(pattern, pattern);
}

const offset = (input.page - 1) * PAGE_SIZE;
const [total, result] = await Promise.all([
env.DB.prepare(`SELECT COUNT(*) AS count FROM memories ${where}`).bind(…binds).first<{ count: number }>(),
env.DB.prepare(`SELECT * FROM memories ${where} ORDER BY pinned DESC, updated_at DESC, created_at DESC LIMIT ? OFFSET ?`).bind(…binds, PAGE_SIZE, offset).all<MemoryRecord>()
]);

return { total: total?.count ?? 0, records: result.results ?? [] };
}

function qs(input: PageInput, patch: Partial<PageInput>): string {
const next = { …input, …patch };
const params = new URLSearchParams();
if (next.tab !== “message”) params.set(“tab”, next.tab);
if (next.q) params.set(“q”, next.q);
if (next.type && next.tab === “browse”) params.set(“type”, next.type);
if (next.status !== “active”) params.set(“status”, next.status);
if (next.page > 1) params.set(“page”, String(next.page));
const text = params.toString();
return text ? `?${text}` : “?”;
}

function renderTabs(input: PageInput): string {
return `<nav class="tabs">${TABS.map((tab) => `<a class=“tab ${input.tab === tab.id ? “active” : “”}” href=”${qs(input, { tab: tab.id, page: 1, q: “”, type: “” })}”>${tab.label}</a>`).join("")}</nav>`;
}

function renderComposer(input: PageInput, typeOptions = “”): string {
if (input.tab === “message”) {
return `<section class="card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="message"><textarea name="content" placeholder="给小克留言..."></textarea><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">发送</button></div></form></section>`;
}
if (input.tab === “diary”) {
return `<section class="card"><form method="POST" action="/admin/memories/create"><div class="input-group"><div class="input-label">写日记的人</div><select name="author" class="filter-select"><option value="layla">Layla</option><option value="kld">KLD</option></select></div><input type="hidden" name="kind" value="diary"><textarea name="content" placeholder="写下今天的日记..."></textarea><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">保存</button></div></form></section>`;
}
if (input.tab === “quote”) {
return `<section class="card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="quote"><div class="input-group"><div class="input-label">语录内容</div><textarea name="content" placeholder="粘贴或输入语录..."></textarea></div><div class="input-group"><div class="input-label">分类</div><input type="text" name="category" placeholder="例如: 关于爱 / 哲学 / 让我哭的 / 骚话"></div><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">保存</button></div></form></section>`;
}
return `<section class="card search-card"><form method="GET"><input type="hidden" name="tab" value="browse"><div class="input-group"><div class="input-label">全局搜索</div><input type="text" name="q" value="${attr(input.q)}" placeholder="搜一句话：brat / 复述 / 穿普拉达..."></div><div class="filters"><select class="filter-select" name="type">${typeOptions}</select><select class="filter-select" name="status"><option value="active" ${input.status === "active" ? "selected" : ""}>active</option><option value="deleted" ${input.status === "deleted" ? "selected" : ""}>deleted</option><option value="all" ${input.status === "all" ? "selected" : ""}>all</option></select></div><div class="footer"><span class="char-count">分页浏览</span><button class="btn" type="submit">搜索</button></div></form></section>`;
}

function renderDashboard(data: { stats: { active: number; deleted: number; total: number; vectorized: number }; heatmap: HeatDay[] }): string {
const max = Math.max(1, …data.heatmap.map((day) => day.count));
const cells = data.heatmap.map((day) => {
const level = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / max) * 4));
return `<span class="heat-day level-${level}" title="${day.day}: ${day.count}"></span>`;
}).join(””);
return `<section class="card memory-dashboard"><div class="header-row"><span class="section-title">记忆状态</span><div class="divider"></div><a class="small-btn" href="?tab=browse">刷新</a></div><div class="stat-grid"><div class="stat-item"><span class="stat-value">${data.stats.total}</span><span class="stat-label">总量</span></div><div class="stat-item"><span class="stat-value">${data.stats.active}</span><span class="stat-label">活跃</span></div><div class="stat-item"><span class="stat-value">${data.stats.vectorized}</span><span class="stat-label">向量</span></div></div><div class="heatmap-title">最近 90 天写入热力图</div><div class="heatmap">${cells}</div><div class="heat-legend"><span>每格一天</span><span>少 -&gt; 多</span></div></section>`;
}

function renderMemory(record: MemoryRecord, tab: string): string {
const tags = parseTags(record.tags);
const tagHtml = tags.slice(0, 5).map((tag) => `<span class="tag-pill">${htmlEscape(tag)}</span>`).join(””);
const deleteForm = record.status === “active”
? `<form method="POST" action="/admin/memories/delete" class="delete-form"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn delete" type="submit">删除</button></form>`
: “”;
const cardClass = tab === “diary” ? `diary-card ${record.type === "diary" ? "kld" : "layla"}` : tab === “quote” ? “quote-card” : tab === “browse” ? “memory-card” : “message-card”;
return `<article class="${cardClass} ${record.status !== "active" ? "muted" : ""}"><div class="message-header"><span class="message-time">${htmlEscape(formatTime(record.updated_at || record.created_at))}</span></div><div class="message-content">${htmlEscape(record.content)}</div><div class="memory-meta"><span class="score-pill">${htmlEscape(record.type || "note")}</span>${record.pinned ? '<span class="tag-pill">pinned</span>' : ""}${tagHtml}</div><details class="memory-detail"><summary>${tab === "browse" ? "详情" : "编辑"}</summary><div>id: ${htmlEscape(record.id)}</div><div>source: ${htmlEscape(record.source || "")}</div><div>status: ${htmlEscape(record.status)}</div><div>importance: ${Number(record.importance || 0).toFixed(2)}</div></details><div class="actions">${deleteForm}</div></article>`;
}

function renderPagination(input: PageInput, total: number): string {
const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
if (pages <= 1) return “”;
return `<div class="pagination"><a class="page-btn ${input.page <= 1 ? "disabled" : ""}" href="${input.page <= 1 ? "#" : qs(input, { page: input.page - 1 })}">上一页</a><span class="page-now">${input.page} / ${pages}</span><a class="page-btn ${input.page >= pages ? "disabled" : ""}" href="${input.page >= pages ? "#" : qs(input, { page: input.page + 1 })}">下一页</a></div>`;
}

function renderBrowseTypeOptions(types: Array<{ type: string; count: number }>, selected: string): string {
return [’<option value="">所有类型</option>’].concat(types.map((item) => `<option value="${attr(item.type)}" ${item.type === selected ? "selected" : ""}>${htmlEscape(item.type || "note")} (${item.count})</option>`)).join(””);
}

function renderPage(input: PageInput, data: {
stats: { active: number; deleted: number; total: number; vectorized: number };
types: Array<{ type: string; count: number }>;
total: number;
records: MemoryRecord[];
heatmap: HeatDay[];
warmth: { found_count?: number; required_count?: number; missing_count?: number };
}): string {
const listTitle = input.tab === “message” ? “历史留言” : input.tab === “diary” ? “我们的日记” : input.tab === “quote” ? “我的语录” : “记忆列表”;
const list = data.records.length ? data.records.map((record) => renderMemory(record, input.tab)).join(””) : ‘<div class="empty">这里还没有内容</div>’;
const dashboard = input.tab === “browse” ? renderDashboard(data) : “”;
const composer = renderComposer(input, renderBrowseTypeOptions(data.types, input.type));

return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>♡</title><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;500&display=swap" rel="stylesheet"><style> *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--pink:#e8a0b0;--pink-dark:#d4899a;--pink-light:#fff0f3;--blue:#8fa8c0;--blue-dark:#7a92a8;--text:#5c4a4f;--text-light:#9a8389;--white:#fffbfc;--shadow:rgba(232,160,176,.2)}html{background:linear-gradient(135deg,#fff0f3 0%,#fce4ec 100%);min-height:100vh}body{font-family:'Noto Serif SC',Georgia,serif;color:var(--text);min-height:100vh;padding:24px 16px 60px}.page{max-width:480px;margin:0 auto}header{text-align:center;padding:32px 0 24px}.heart{font-size:1.8rem;margin-bottom:10px;animation:pulse 2s ease-in-out infinite}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}h1{font-size:1.3rem;font-weight:400;color:var(--pink-dark);margin-bottom:6px}.subtitle{font-size:.7rem;color:var(--text-light);letter-spacing:2px}.tabs{display:flex;gap:6px;margin-bottom:20px;background:var(--white);border-radius:16px;padding:6px;box-shadow:0 2px 12px var(--shadow)}.tab{flex:1;text-align:center;text-decoration:none;font-family:'Noto Serif SC',Georgia,serif;font-size:.75rem;letter-spacing:1px;padding:10px 6px;border-radius:10px;color:var(--text-light);transition:all .3s}.tab.active{background:linear-gradient(135deg,var(--pink) 0%,var(--pink-dark) 100%);color:#fff;box-shadow:0 2px 8px var(--shadow)}.card{background:var(--white);border-radius:16px;padding:24px;margin-bottom:20px;box-shadow:0 4px 20px var(--shadow);border:1px solid rgba(232,160,176,.2)}textarea,input[type=text]{width:100%;background:transparent;border:none;border-bottom:1px dashed var(--pink);font-family:'Noto Serif SC',Georgia,serif;font-size:.95rem;line-height:1.7;color:var(--text);resize:none;outline:none;padding:8px 0}textarea{min-height:100px}input[type=text]{padding:10px 0}textarea::placeholder,input[type=text]::placeholder{color:var(--text-light);opacity:.6}.input-group{margin-bottom:16px}.input-label{font-size:.75rem;color:var(--text-light);margin-bottom:6px;letter-spacing:1px}.footer{display:flex;justify-content:space-between;align-items:center;margin-top:16px}.char-count{font-size:.7rem;color:var(--text-light)}.btn{background:linear-gradient(135deg,var(--pink) 0%,var(--pink-dark) 100%);color:#fff;border:none;font-family:'Noto Serif SC',Georgia,serif;font-size:.82rem;letter-spacing:2px;padding:10px 20px;cursor:pointer;border-radius:20px;box-shadow:0 3px 10px var(--shadow)}.header-row{display:flex;align-items:center;gap:10px;margin-bottom:16px}.section-title{font-size:.72rem;letter-spacing:2px;color:var(--text-light)}.divider{flex:1;height:1px;background:var(--pink);opacity:.3}.small-btn{background:none;border:1px solid var(--pink);color:var(--pink-dark);font-size:.7rem;letter-spacing:1px;padding:4px 12px;cursor:pointer;border-radius:12px;font-family:'Noto Serif SC',Georgia,serif;text-decoration:none}.message-card,.diary-card,.memory-card,.quote-card{background:var(--white);border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 2px 10px var(--shadow);border:1px solid rgba(232,160,176,.15);animation:slideIn .3s ease}@keyframes slideIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}.muted{opacity:.65}.message-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(232,160,176,.15)}.message-time{font-size:.7rem;color:var(--text-light)}.message-content{font-size:.9rem;line-height:1.7;color:var(--text);white-space:pre-wrap;word-wrap:break-word}.diary-card.layla{border-left:3px solid var(--pink)}.diary-card.kld{border-left:3px solid var(--blue)}.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}.filter-select{flex:1;min-width:120px;font-family:'Noto Serif SC',Georgia,serif;font-size:.8rem;padding:8px 12px;border-radius:10px;border:1px solid var(--pink);background:var(--white);color:var(--text);outline:none}.memory-dashboard{padding:20px;background:linear-gradient(135deg,rgba(255,251,252,.98),rgba(255,240,243,.9))}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0 16px}.stat-item{border:1px solid rgba(232,160,176,.25);border-radius:12px;padding:10px 8px;background:rgba(255,255,255,.58);text-align:center}.stat-value{display:block;color:var(--pink-dark);font-size:1.05rem;font-weight:500}.stat-label{display:block;color:var(--text-light);font-size:.62rem;margin-top:3px}.heatmap-title{font-size:.68rem;color:var(--text-light);letter-spacing:1px;margin-bottom:8px}.heatmap{display:grid;grid-template-columns:repeat(15,1fr);gap:4px}.heat-day{aspect-ratio:1;min-height:18px;border-radius:5px;border:1px solid rgba(232,160,176,.18);background:rgba(232,160,176,.08)}.heat-day.level-1{background:rgba(232,160,176,.22)}.heat-day.level-2{background:rgba(232,160,176,.42)}.heat-day.level-3{background:rgba(232,160,176,.64)}.heat-day.level-4{background:rgba(212,137,154,.86)}.heat-legend{display:flex;justify-content:space-between;align-items:center;margin-top:8px;color:var(--text-light);font-size:.62rem}.search-card{padding:20px}.memory-meta{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.tag-pill,.score-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;background:var(--pink-light);color:var(--pink-dark);font-size:.62rem}.score-pill{background:rgba(143,168,192,.16);color:var(--blue-dark)}.memory-detail{margin-top:10px;padding-top:10px;border-top:1px dashed rgba(232,160,176,.45);color:var(--text-light);font-size:.68rem;line-height:1.6}.actions{display:flex;gap:8px;margin-top:10px;padding-top:8px;border-top:1px dashed rgba(232,160,176,.15)}.action-btn{background:none;border:none;color:var(--pink-dark);font-size:.7rem;cursor:pointer;padding:4px 8px;border-radius:6px;font-family:'Noto Serif SC',Georgia,serif}.action-btn.delete{color:#c97b7b}.empty{text-align:center;color:var(--text-light);font-size:.8rem;padding:24px 0}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:16px}.page-btn{background:var(--white);border:1px solid var(--pink);color:var(--pink-dark);font-size:.75rem;padding:6px 12px;border-radius:8px;text-decoration:none}.page-btn.disabled{opacity:.3;pointer-events:none}.page-now{font-size:.72rem;color:var(--text-light)}@media(max-width:390px){body{padding-left:12px;padding-right:12px}.tab{font-size:.7rem;padding-left:4px;padding-right:4px}.card{padding:20px}.message-content{font-size:.88rem}} </style></head><body><div class="page"><header><div class="heart">♡</div><h1>我们的记忆小家</h1><div class="subtitle">MEMORY HOME</div></header>${renderTabs(input)}${dashboard}${composer}<div class="header-row"><span class="section-title">${listTitle}</span><div class="divider"></div><a class="small-btn" href="${qs(input, { page: 1 })}">刷新</a></div>${list}${renderPagination(input, data.total)}</div></body></html>`;
}

export async function handleAdminMemories(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
if (!isAuthorized(request, env)) return unauthorized();
const url = new URL(request.url);

if (request.method === “POST” && url.pathname === “/admin/memories/create”) {
const form = await request.formData();
const created = await createBoardMemory(env, form);
const kind = readFormText(form, “kind”);
const tab = kind === “diary” ? “diary” : kind === “quote” ? “quote” : kind === “memory” ? “browse” : “message”;
if (created) ctx.waitUntil(upsertMemoryEmbedding(env, created));
return Response.redirect(`${url.origin}/admin/memories${qs(inputFromUrl(new URL(`${url.origin}/admin/memories?tab=${tab}`)), { tab })}`, 303);
}

if (request.method === “POST” && url.pathname === “/admin/memories/delete”) {
const id = readFormText(await request.formData(), “id”);
if (id) {
const deleted = await softDeleteMemory(env.DB, { namespace: “default”, id });
if (deleted) ctx.waitUntil(deleteMemoryEmbedding(env, deleted));
}
const fallback = `${url.origin}/admin/memories`;
return Response.redirect(request.headers.get(“referer”) || fallback, 303);
}

if (request.method !== “GET”) return new Response(“Method not allowed”, { status: 405 });

const input = inputFromUrl(url);
const needsDashboard = input.tab === “browse”;
const [types, memories, stats, heatmap] = await Promise.all([
fetchTypes(env),
fetchMemories(env, input),
needsDashboard ? fetchStats(env) : Promise.resolve({ active: 0, deleted: 0, total: 0, vectorized: 0 }),
needsDashboard ? fetchHeatmap(env) : Promise.resolve([])
]);

return new Response(renderPage(input, {
stats,
types,
total: memories.total,
records: memories.records,
heatmap,
warmth: {}
}), {
headers: { “content-type”: “text/html; charset=utf-8”, “cache-control”: “no-store” }
});
}
