import { createMemory, softDeleteMemory, updateMemory } from "../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import type { Env, MemoryRecord } from "../types";

interface PageInput {
  q: string;
  type: string;
  status: string;
  page: number;
  tab: string;
  tag: string;
  date: string;
  category: string;
  mood: string;
  notice: string;
}

interface HeatDay {
  day: string;
  count: number;
  mood: string;
}

const PAGE_SIZE = 8;
const TABS = [
  { id: "message", label: "留言板" },
  { id: "diary", label: "交换日记" },
  { id: "quote", label: "语录" },
  { id: "browse", label: "记忆浏览" }
];
const MOODS = ["", "开心", "平静", "兴奋", "委屈", "低落", "生气", "焦虑", "疲惫", "感动"];

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

function parseTagInput(value: string): string[] {
  return [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

function moodOf(record: Pick<MemoryRecord, "tags">): string {
  const tag = parseTags(record.tags).find((item) => item.startsWith("mood:"));
  return tag ? tag.slice(5) : "";
}

function moodClass(mood: string): string {
  const map: Record<string, string> = {
    开心: "mood-happy",
    平静: "mood-calm",
    兴奋: "mood-bright",
    委屈: "mood-soft",
    低落: "mood-low",
    生气: "mood-angry",
    焦虑: "mood-worry",
    疲惫: "mood-tired",
    感动: "mood-moved"
  };
  return map[mood] || "";
}

function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function formatTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return date.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  if (days === 1) return `昨天 ${date.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false })}`;
  if (days > 1 && days < 7) return `${days}天前`;
  return date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" });
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
    tag: (url.searchParams.get("tag") || "").trim().slice(0, 80),
    date: (url.searchParams.get("date") || "").trim().slice(0, 10),
    category: (url.searchParams.get("category") || "").trim().slice(0, 80),
    mood: (url.searchParams.get("mood") || "").trim().slice(0, 30),
    notice: (url.searchParams.get("notice") || "").trim().slice(0, 30),
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

function noticeUrl(url: string, notice: string): string {
  const parsed = new URL(url, "https://placeholder.local");
  parsed.searchParams.set("notice", notice);
  return `${parsed.pathname}${parsed.search}`;
}

async function createBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const kind = readFormText(form, "kind");
  const content = readFormText(form, "content");
  if (!content) return null;

  let type = "note";
  let tags = ["admin-board"];
  let pinned = false;

  if (kind === "message") {
    tags = ["留言", "unread", "admin-board"];
  } else if (kind === "diary") {
    const author = readFormText(form, "author") || "layla";
    type = author === "kld" ? "diary" : "layla_diary";
    tags = ["日记", author, "admin-board"];
  } else if (kind === "quote") {
    const category = readFormText(form, "category") || "语录";
    tags = ["语录", category, "admin-board"];
  } else if (kind === "memory") {
    type = readFormText(form, "memory_type") || "note";
    tags = parseTagInput(readFormText(form, "tags"));
    tags.push("admin-board");
    pinned = readFormText(form, "pinned") === "on";
  }

  const mood = readFormText(form, "mood");
  if (mood) tags.push(`mood:${mood}`);

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

async function editBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  const content = readFormText(form, "content");
  if (!id || !content) return null;

  const tags = parseTagInput(readFormText(form, "tags"));
  const mood = readFormText(form, "mood");
  if (mood) tags.push(`mood:${mood}`);

  return updateMemory(env.DB, {
    namespace: "default",
    id,
    patch: {
      type: readFormText(form, "type") || "note",
      content,
      tags,
      importance: clampNumber(readFormText(form, "importance"), 0.65, 0, 1),
      pinned: readFormText(form, "pinned") === "on"
    }
  });
}

async function fetchTypes(env: Env): Promise<Array<{ type: string; count: number }>> {
  const result = await env.DB
    .prepare("SELECT type, COUNT(*) AS count FROM memories WHERE namespace = 'default' AND status = 'active' GROUP BY type ORDER BY type")
    .all<{ type: string; count: number }>();
  return result.results ?? [];
}

async function fetchQuoteCategories(env: Env): Promise<string[]> {
  const result = await env.DB
    .prepare("SELECT tags FROM memories WHERE namespace = 'default' AND status = 'active' AND tags LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 300")
    .bind(like("语录"))
    .all<{ tags: string | null }>();
  const categories = new Set<string>();
  for (const row of result.results ?? []) {
    for (const tag of parseTags(row.tags)) {
      if (tag && tag !== "语录" && tag !== "admin-board" && !tag.startsWith("mood:")) categories.add(tag);
    }
  }
  return [...categories].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

async function fetchStats(env: Env): Promise<{ active: number; deleted: number; total: number; vectorized: number }> {
  const result = await env.DB
    .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted, SUM(CASE WHEN vector_id IS NOT NULL AND vector_id != '' THEN 1 ELSE 0 END) AS vectorized FROM memories WHERE namespace = 'default'")
    .first<{ total: number; active: number; deleted: number; vectorized: number }>();
  return { active: result?.active ?? 0, deleted: result?.deleted ?? 0, total: result?.total ?? 0, vectorized: result?.vectorized ?? 0 };
}

async function fetchHeatmap(env: Env): Promise<HeatDay[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 89);
  const sinceText = since.toISOString().slice(0, 10);
  const rows = await env.DB
    .prepare("SELECT created_at, tags FROM memories WHERE namespace = 'default' AND status = 'active' AND created_at >= ?")
    .bind(sinceText)
    .all<{ created_at: string | null; tags: string | null }>();
  const counts = new Map<string, number>();
  const moods = new Map<string, Map<string, number>>();
  for (const row of rows.results ?? []) {
    if (!row.created_at) continue;
    const day = row.created_at.slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
    const mood = moodOf({ tags: row.tags } as Pick<MemoryRecord, "tags">);
    if (!mood) continue;
    const moodCounts = moods.get(day) || new Map<string, number>();
    moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
    moods.set(day, moodCounts);
  }
  const days: HeatDay[] = [];
  for (let i = 89; i >= 0; i -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    const day = date.toISOString().slice(0, 10);
    const moodCounts = moods.get(day);
    const mood = moodCounts ? [...moodCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "" : "";
    days.push({ day, count: counts.get(day) ?? 0, mood });
  }
  return days;
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
    let clause = " AND tags LIKE ? ESCAPE '\\'";
    if (input.category) {
      clause += " AND tags LIKE ? ESCAPE '\\'";
      binds.push(like(input.category));
    }
    return clause;
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
  if (input.tag && input.tab === "browse") {
    where += " AND tags LIKE ? ESCAPE '\\'";
    binds.push(like(input.tag));
  }
  if (input.mood && input.tab === "browse") {
    where += " AND tags LIKE ? ESCAPE '\\'";
    binds.push(like(`mood:${input.mood}`));
  }
  if (input.date && input.tab === "browse") {
    where += " AND substr(created_at, 1, 10) = ?";
    binds.push(input.date);
  }
  if (input.q) {
    const pattern = like(input.q);
    where += " AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
    binds.push(pattern, pattern, pattern, pattern, pattern);
  }

  const offset = (input.page - 1) * PAGE_SIZE;
  const [total, result] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM memories ${where}`).bind(...binds).first<{ count: number }>(),
    env.DB.prepare(`SELECT * FROM memories ${where} ORDER BY pinned DESC, updated_at DESC, created_at DESC LIMIT ? OFFSET ?`).bind(...binds, PAGE_SIZE, offset).all<MemoryRecord>()
  ]);

  return { total: total?.count ?? 0, records: result.results ?? [] };
}

function qs(input: PageInput, patch: Partial<PageInput>): string {
  const next = { ...input, ...patch };
  const params = new URLSearchParams();
  if (next.tab !== "message") params.set("tab", next.tab);
  if (next.q) params.set("q", next.q);
  if (next.type && next.tab === "browse") params.set("type", next.type);
  if (next.tag && next.tab === "browse") params.set("tag", next.tag);
  if (next.date && next.tab === "browse") params.set("date", next.date);
  if (next.mood && next.tab === "browse") params.set("mood", next.mood);
  if (next.category && next.tab === "quote") params.set("category", next.category);
  if (next.status !== "active") params.set("status", next.status);
  if (next.notice) params.set("notice", next.notice);
  if (next.page > 1) params.set("page", String(next.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function adminPath(input: PageInput, patch: Partial<PageInput>): string {
  return `/admin/memories${qs(input, patch)}`;
}

function renderTabs(input: PageInput): string {
  return `<nav class="tabs">${TABS.map((tab) => `<a class="tab ${input.tab === tab.id ? "active" : ""}" href="${adminPath(input, { tab: tab.id, page: 1, q: "", type: "", tag: "", date: "", category: "", mood: "", notice: "" })}">${tab.label}</a>`).join("")}</nav>`;
}

function renderMoodOptions(selected: string, empty = "不标记"): string {
  return MOODS.map((item) => `<option value="${attr(item)}" ${item === selected ? "selected" : ""}>${item || empty}</option>`).join("");
}

function renderComposer(input: PageInput, typeOptions = ""): string {
  if (input.tab === "message") {
    return `<section class="card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="message"><textarea name="content" placeholder="给小克留言..."></textarea><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">发送</button></div></form></section>`;
  }
  if (input.tab === "diary") {
    return `<section class="card"><form method="POST" action="/admin/memories/create"><div class="filters"><select name="author" class="filter-select"><option value="layla">Layla</option><option value="kld">KLD</option></select><select name="mood" class="filter-select">${renderMoodOptions("", "心情")}</select></div><input type="hidden" name="kind" value="diary"><textarea name="content" placeholder="写下今天的日记..."></textarea><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">保存</button></div></form></section>`;
  }
  if (input.tab === "quote") {
    return `<section class="card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="quote"><div class="input-group"><div class="input-label">语录内容</div><textarea name="content" placeholder="粘贴或输入语录..."></textarea></div><div class="input-group"><div class="input-label">分类</div><input type="text" name="category" placeholder="例如: 关于爱 / 哲学 / 让我哭的 / 骚话"></div><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">保存</button></div></form></section>`;
  }
  return `<section class="card search-card"><form method="GET"><input type="hidden" name="tab" value="browse"><div class="input-group"><div class="input-label">全局搜索</div><input type="text" name="q" value="${attr(input.q)}" placeholder="搜一句话：brat / 复述 / 穿普拉达..."></div><div class="filters"><select class="filter-select" name="type">${typeOptions}</select><select class="filter-select" name="status"><option value="active" ${input.status === "active" ? "selected" : ""}>active</option><option value="deleted" ${input.status === "deleted" ? "selected" : ""}>deleted</option><option value="all" ${input.status === "all" ? "selected" : ""}>all</option></select><select class="filter-select" name="mood">${renderMoodOptions(input.mood, "所有心情")}</select><input class="filter-input" name="tag" value="${attr(input.tag)}" placeholder="按标签筛选"><input type="hidden" name="date" value="${attr(input.date)}"></div><div class="footer"><span class="char-count">${input.q ? `搜索：${htmlEscape(input.q)}` : input.date ? `${htmlEscape(input.date)} 的记忆` : "分页浏览"}</span><button class="btn" type="submit">搜索</button></div></form></section>`;
}

function renderDashboard(input: PageInput, data: { stats: { active: number; deleted: number; total: number; vectorized: number }; heatmap: HeatDay[] }): string {
  const max = Math.max(1, ...data.heatmap.map((day) => day.count));
  const cells = data.heatmap.map((day) => {
    const level = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / max) * 4));
    const active = input.date === day.day ? " active" : "";
    return `<a class="heat-day level-${level} ${moodClass(day.mood)}${active}" title="${day.day}: ${day.count} 条${day.mood ? ` / ${day.mood}` : ""}" href="${adminPath(input, { tab: "browse", date: input.date === day.day ? "" : day.day, page: 1, notice: "" })}"></a>`;
  }).join("");
  return `<section class="card memory-dashboard"><div class="header-row"><span class="section-title">记忆状态</span><div class="divider"></div><a class="small-btn" href="/admin/memories?tab=browse">清除搜索</a></div><div class="stat-grid"><div class="stat-item"><span class="stat-value">${data.stats.total}</span><span class="stat-label">总量</span></div><div class="stat-item"><span class="stat-value">${data.stats.active}</span><span class="stat-label">活跃</span></div><div class="stat-item"><span class="stat-value">${data.stats.vectorized}</span><span class="stat-label">向量</span></div></div><div class="heatmap-title">最近 90 天写入 / 情绪热力图</div><div class="heatmap">${cells}</div><div class="heat-legend"><span>点一天可筛选</span><span>少 -&gt; 多</span></div></section>`;
}

function renderEditForm(record: MemoryRecord): string {
  const tags = parseTags(record.tags);
  const mood = moodOf(record);
  const plainTags = tags.filter((tag) => !tag.startsWith("mood:")).join(", ");
  return `<details class="memory-detail"><summary>编辑</summary><form class="edit-form" method="POST" action="/admin/memories/edit"><input type="hidden" name="id" value="${attr(record.id)}"><div class="input-group"><div class="input-label">正文</div><textarea name="content" class="edit-textarea">${htmlEscape(record.content)}</textarea></div><div class="edit-grid"><label><span>类型</span><input type="text" name="type" value="${attr(record.type || "note")}"></label><label><span>标签</span><input type="text" name="tags" value="${attr(plainTags)}" placeholder="用逗号隔开"></label><label><span>心情</span><select name="mood" class="filter-select">${renderMoodOptions(mood)}</select></label><label><span>重要度</span><input type="text" name="importance" value="${attr(Number(record.importance || 0).toFixed(2))}"></label></div><label class="pin-check"><input type="checkbox" name="pinned" ${record.pinned ? "checked" : ""}> 置顶</label><div class="footer edit-footer"><span class="char-count">id: ${htmlEscape(record.id)}</span><button class="btn" type="submit">保存修改</button></div></form></details>`;
}

function renderMemory(record: MemoryRecord, tab: string): string {
  const tags = parseTags(record.tags);
  const tagHtml = tags.slice(0, 6).map((tag) => `<span class="tag-pill ${moodClass(tag.replace("mood:", ""))}">${htmlEscape(tag)}</span>`).join("");
  const deleteForm = record.status === "active"
    ? `<form method="POST" action="/admin/memories/delete" class="delete-form" onsubmit="return confirm('确认删除吗？这会软删除，不会立刻物理清空。')"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn delete" type="submit">删除</button></form>`
    : "";
  const cardClass = tab === "diary" ? `diary-card ${record.type === "diary" ? "kld" : "layla"}` : tab === "quote" ? "quote-card" : tab === "browse" ? "memory-card" : "message-card";
  return `<article class="${cardClass} ${record.status !== "active" ? "muted" : ""}"><div class="message-header"><span class="message-time">${htmlEscape(formatTime(record.updated_at || record.created_at))}</span></div><div class="message-content">${htmlEscape(record.content)}</div><div class="memory-meta"><span class="score-pill">${htmlEscape(record.type || "note")}</span>${record.pinned ? '<span class="tag-pill">pinned</span>' : ""}${tagHtml}</div>${renderEditForm(record)}<div class="actions">${deleteForm}</div></article>`;
}

function renderPagination(input: PageInput, total: number): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return "";
  return `<div class="pagination"><a class="page-btn ${input.page <= 1 ? "disabled" : ""}" href="${input.page <= 1 ? "#" : adminPath(input, { page: input.page - 1, notice: "" })}">上一页</a><span class="page-btn active">${input.page} / ${pages}</span><a class="page-btn ${input.page >= pages ? "disabled" : ""}" href="${input.page >= pages ? "#" : adminPath(input, { page: input.page + 1, notice: "" })}">下一页</a></div>`;
}

function renderBrowseTypeOptions(types: Array<{ type: string; count: number }>, selected: string): string {
  return ['<option value="">所有类型</option>'].concat(types.map((item) => `<option value="${attr(item.type)}" ${item.type === selected ? "selected" : ""}>${htmlEscape(item.type || "note")} (${item.count})</option>`)).join("");
}

function renderQuoteFilter(input: PageInput, categories: string[]): string {
  if (input.tab !== "quote") return "";
  const options = ['<option value="">所有分类</option>'].concat(categories.map((item) => `<option value="${attr(item)}" ${item === input.category ? "selected" : ""}>${htmlEscape(item)}</option>`)).join("");
  return `<form class="quote-filter" method="GET"><input type="hidden" name="tab" value="quote"><select class="filter-select" name="category">${options}</select><button class="small-btn" type="submit">筛选</button></form>`;
}

function renderPage(input: PageInput, data: {
  stats: { active: number; deleted: number; total: number; vectorized: number };
  types: Array<{ type: string; count: number }>;
  quoteCategories: string[];
  total: number;
  records: MemoryRecord[];
  heatmap: HeatDay[];
}): string {
  const listTitle = input.tab === "message" ? "历史留言" : input.tab === "diary" ? "我们的日记" : input.tab === "quote" ? "我的语录" : input.date ? `${input.date} 的记忆` : input.q ? `搜索：${input.q}` : "记忆列表";
  const list = data.records.length ? data.records.map((record) => renderMemory(record, input.tab)).join("") : '<div class="empty">这里还没有内容</div>';
  const dashboard = input.tab === "browse" ? renderDashboard(input, data) : "";
  const composer = renderComposer(input, renderBrowseTypeOptions(data.types, input.type));
  const quoteFilter = renderQuoteFilter(input, data.quoteCategories);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>♡</title><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;500&display=swap" rel="stylesheet"><style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--pink:#e8a0b0;--pink-dark:#d4899a;--pink-light:#fff0f3;--blue:#8fa8c0;--blue-dark:#7a92a8;--text:#5c4a4f;--text-light:#9a8389;--white:#fffbfc;--shadow:rgba(232,160,176,.2)}html{background:linear-gradient(135deg,#fff0f3 0%,#fce4ec 100%);min-height:100vh}body{font-family:'Noto Serif SC',Georgia,serif;color:var(--text);min-height:100vh;padding:24px 16px 60px}.page{max-width:480px;margin:0 auto}header{text-align:center;padding:32px 0 24px}.heart{font-size:1.8rem;margin-bottom:10px;animation:pulse 2s ease-in-out infinite}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}h1{font-size:1.3rem;font-weight:400;color:var(--pink-dark);margin-bottom:6px}.subtitle{font-size:.7rem;color:var(--text-light);letter-spacing:2px}.tabs{display:flex;gap:6px;margin-bottom:20px;background:var(--white);border-radius:16px;padding:6px;box-shadow:0 2px 12px var(--shadow)}.tab{flex:1;text-align:center;text-decoration:none;font-family:'Noto Serif SC',Georgia,serif;font-size:.75rem;letter-spacing:1px;padding:10px 6px;border-radius:10px;color:var(--text-light);transition:all .3s}.tab.active{background:linear-gradient(135deg,var(--pink) 0%,var(--pink-dark) 100%);color:#fff;box-shadow:0 2px 8px var(--shadow)}.card{background:var(--white);border-radius:16px;padding:24px;margin-bottom:20px;box-shadow:0 4px 20px var(--shadow);border:1px solid rgba(232,160,176,.2)}textarea,input[type=text],.filter-input{width:100%;background:transparent;border:none;border-bottom:1px dashed var(--pink);font-family:'Noto Serif SC',Georgia,serif;font-size:.95rem;line-height:1.7;color:var(--text);resize:none;outline:none;padding:8px 0}textarea{min-height:100px}.input-group{margin-bottom:16px}.input-label{font-size:.75rem;color:var(--text-light);margin-bottom:6px;letter-spacing:1px}.footer{display:flex;justify-content:space-between;align-items:center;margin-top:16px}.char-count{font-size:.7rem;color:var(--text-light)}.btn{background:linear-gradient(135deg,var(--pink) 0%,var(--pink-dark) 100%);color:#fff;border:none;font-family:'Noto Serif SC',Georgia,serif;font-size:.82rem;letter-spacing:2px;padding:10px 20px;cursor:pointer;border-radius:20px;box-shadow:0 3px 10px var(--shadow)}.header-row{display:flex;align-items:center;gap:10px;margin-bottom:16px}.section-title{font-size:.72rem;letter-spacing:2px;color:var(--text-light)}.divider{flex:1;height:1px;background:var(--pink);opacity:.3}.small-btn{background:none;border:1px solid var(--pink);color:var(--pink-dark);font-size:.7rem;letter-spacing:1px;padding:4px 12px;cursor:pointer;border-radius:12px;font-family:'Noto Serif SC',Georgia,serif;text-decoration:none}.message-card,.diary-card,.memory-card,.quote-card{background:var(--white);border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 2px 10px var(--shadow);border:1px solid rgba(232,160,176,.15);animation:slideIn .3s ease}@keyframes slideIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}.muted{opacity:.65}.message-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(232,160,176,.15)}.message-time{font-size:.7rem;color:var(--text-light)}.message-content{font-size:.9rem;line-height:1.7;color:var(--text);white-space:pre-wrap;word-wrap:break-word}.diary-card.layla{border-left:3px solid var(--pink)}.diary-card.kld{border-left:3px solid var(--blue)}.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}.filter-select{flex:1;min-width:118px;font-family:'Noto Serif SC',Georgia,serif;font-size:.8rem;padding:8px 12px;border-radius:10px;border:1px solid var(--pink);background:var(--white);color:var(--text);outline:none}.quote-filter{display:flex;gap:8px;margin:-4px 0 16px}.memory-dashboard{padding:20px;background:linear-gradient(135deg,rgba(255,251,252,.98),rgba(255,240,243,.9))}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0 16px}.stat-item{border:1px solid rgba(232,160,176,.25);border-radius:12px;padding:10px 8px;background:rgba(255,255,255,.58);text-align:center}.stat-value{display:block;color:var(--pink-dark);font-size:1.05rem;font-weight:500}.stat-label{display:block;color:var(--text-light);font-size:.62rem;margin-top:3px}.heatmap-title{font-size:.68rem;color:var(--text-light);letter-spacing:1px;margin-bottom:8px}.heatmap{display:grid;grid-template-columns:repeat(15,1fr);gap:4px}.heat-day{aspect-ratio:1;min-height:18px;border-radius:5px;border:1px solid rgba(232,160,176,.18);background:rgba(232,160,176,.08);display:block}.heat-day.active{outline:2px solid var(--pink-dark)}.heat-day.level-1{background:rgba(232,160,176,.22)}.heat-day.level-2{background:rgba(232,160,176,.42)}.heat-day.level-3{background:rgba(232,160,176,.64)}.heat-day.level-4{background:rgba(212,137,154,.86)}.mood-happy{background:#ffd6df!important}.mood-calm{background:#dcecf4!important}.mood-bright{background:#f8d58b!important}.mood-soft{background:#e7d8f2!important}.mood-low{background:#cfd4de!important}.mood-angry{background:#ebb0aa!important}.mood-worry{background:#d9c6b8!important}.mood-tired{background:#d8d1c8!important}.mood-moved{background:#f2c6d8!important}.heat-legend{display:flex;justify-content:space-between;align-items:center;margin-top:8px;color:var(--text-light);font-size:.62rem}.search-card{padding:20px}.memory-meta{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.tag-pill,.score-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;background:var(--pink-light);color:var(--pink-dark);font-size:.62rem}.score-pill{background:rgba(143,168,192,.16);color:var(--blue-dark)}.memory-detail{margin-top:10px;padding-top:10px;border-top:1px dashed rgba(232,160,176,.45);color:var(--text-light);font-size:.68rem;line-height:1.6}.edit-form{margin-top:10px}.edit-form input[type=text],.edit-form textarea{font-size:.82rem}.edit-textarea{min-height:120px}.edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}.edit-grid label span{display:block;font-size:.66rem;color:var(--text-light);margin-bottom:4px}.pin-check{display:block;margin-top:10px;color:var(--text-light);font-size:.72rem}.edit-footer{margin-top:12px}.actions{display:flex;gap:8px;margin-top:10px;padding-top:8px;border-top:1px dashed rgba(232,160,176,.15)}.action-btn{background:none;border:none;color:var(--pink-dark);font-size:.7rem;cursor:pointer;padding:4px 8px;border-radius:6px;font-family:'Noto Serif SC',Georgia,serif}.action-btn.delete{color:#c97b7b}.empty{text-align:center;color:var(--text-light);font-size:.8rem;padding:24px 0}.pagination{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:16px}.page-btn{background:var(--white);border:1px solid var(--pink);color:var(--pink-dark);font-size:.75rem;padding:6px 12px;border-radius:8px;text-decoration:none}.page-btn.disabled{opacity:.3;pointer-events:none}.page-btn.active{background:var(--pink);color:#fff}.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--pink-dark);color:white;font-size:.8rem;padding:12px 24px;border-radius:20px;transition:transform .3s;z-index:100;white-space:nowrap;letter-spacing:1px}.toast.show{transform:translateX(-50%) translateY(0)}@media(max-width:390px){body{padding-left:12px;padding-right:12px}.tab{font-size:.7rem;padding-left:4px;padding-right:4px}.card{padding:20px}.message-content{font-size:.88rem}.edit-grid{grid-template-columns:1fr}}
</style></head><body><div class="page"><header><div class="heart">♡</div><h1>我们的记忆小家</h1><div class="subtitle">MEMORY HOME</div></header>${renderTabs(input)}${dashboard}${composer}${quoteFilter}<div class="header-row"><span class="section-title">${htmlEscape(listTitle)}</span><div class="divider"></div><a class="small-btn" href="${adminPath(input, { page: 1, q: "", tag: "", date: "", category: "", mood: "", notice: "" })}">刷新</a></div>${list}${renderPagination(input, data.total)}</div><div class="toast" id="toast"></div><script>const n=${JSON.stringify(input.notice)};const m={created:'已保存 ♡',edited:'修改成功 ♡',deleted:'已删除',empty:'没有内容'};if(n&&m[n]){const t=document.getElementById('toast');t.textContent=m[n];t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);history.replaceState(null,'',location.pathname+location.search.replace(/[?&]notice=[^&]*/,''));}</script></body></html>`;
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
    return Response.redirect(`${url.origin}/admin/memories${qs(inputFromUrl(new URL(`${url.origin}/admin/memories?tab=${tab}`)), { tab, notice: created ? "created" : "empty" })}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/edit") {
    const updated = await editBoardMemory(env, await request.formData());
    if (updated) ctx.waitUntil(upsertMemoryEmbedding(env, updated));
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories`;
    return Response.redirect(`${url.origin}${noticeUrl(ref, updated ? "edited" : "empty")}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/delete") {
    const id = readFormText(await request.formData(), "id");
    if (id) {
      const deleted = await softDeleteMemory(env.DB, { namespace: "default", id });
      if (deleted) ctx.waitUntil(deleteMemoryEmbedding(env, deleted));
    }
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories`;
    return Response.redirect(`${url.origin}${noticeUrl(ref, "deleted")}`, 303);
  }

  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const input = inputFromUrl(url);
  const needsDashboard = input.tab === "browse";
  const [types, quoteCategories, memories, stats, heatmap] = await Promise.all([
    fetchTypes(env),
    input.tab === "quote" ? fetchQuoteCategories(env) : Promise.resolve([]),
    fetchMemories(env, input),
    needsDashboard ? fetchStats(env) : Promise.resolve({ active: 0, deleted: 0, total: 0, vectorized: 0 }),
    needsDashboard ? fetchHeatmap(env) : Promise.resolve([])
  ]);

  return new Response(renderPage(input, {
    stats,
    types,
    quoteCategories,
    total: memories.total,
    records: memories.records,
    heatmap
  }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
