import type { MemoryRecord } from "../../types";
import { ADMIN_BOARD_CSS } from "./styles";
import type { BoardStats, HeatDay } from "./data";
import {
  adminPath,
  attr,
  formatTime,
  htmlEscape,
  moodClass,
  moodOf,
  MOODS,
  PAGE_SIZE,
  parseTags,
  TABS,
  type PageInput
} from "./utils";

interface PageData {
  stats: BoardStats;
  types: Array<{ type: string; count: number }>;
  quoteCategories: string[];
  total: number;
  records: MemoryRecord[];
  heatmap: HeatDay[];
}

function renderTabs(input: PageInput): string {
  return `<nav class="tabs">${TABS.map((tab) => `<a class="tab ${input.tab === tab.id ? "active" : ""}" href="${adminPath(input, { tab: tab.id, page: 1, q: "", type: "", tag: "", date: "", category: "", mood: "", notice: "", searchMode: "keyword" })}">${tab.label}</a>`).join("")}</nav>`;
}

function renderMoodOptions(selected: string, empty = "不标记"): string {
  return MOODS.map((item) => `<option value="${attr(item)}" ${item === selected ? "selected" : ""}>${item || empty}</option>`).join("");
}

function renderSearchModeOptions(input: PageInput): string {
  return `<select class="filter-select" name="mode"><option value="keyword" ${input.searchMode === "keyword" ? "selected" : ""}>关键词</option><option value="semantic" ${input.searchMode === "semantic" ? "selected" : ""}>语义</option></select>`;
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
  const searchLabel = input.q ? `${input.searchMode === "semantic" ? "语义" : "关键词"}搜索：${htmlEscape(input.q)}` : input.date ? `${htmlEscape(input.date)} 的记忆` : "分页浏览";
  return `<section class="card search-card"><form method="GET"><input type="hidden" name="tab" value="browse"><div class="input-group"><div class="input-label">全局搜索</div><input type="text" name="q" value="${attr(input.q)}" placeholder="搜一个意思：brat / 复述 / 穿普拉达..."></div><div class="filters">${renderSearchModeOptions(input)}<select class="filter-select" name="type">${typeOptions}</select><select class="filter-select" name="status"><option value="active" ${input.status === "active" ? "selected" : ""}>active</option><option value="deleted" ${input.status === "deleted" ? "selected" : ""}>deleted</option><option value="all" ${input.status === "all" ? "selected" : ""}>all</option></select><select class="filter-select" name="mood">${renderMoodOptions(input.mood, "所有心情")}</select><input class="filter-input" name="tag" value="${attr(input.tag)}" placeholder="按标签筛选"><input type="hidden" name="date" value="${attr(input.date)}"></div><div class="footer"><span class="char-count">${searchLabel}</span><button class="btn" type="submit">搜索</button></div></form></section>`;
}

function renderDashboard(input: PageInput, data: { stats: BoardStats; heatmap: HeatDay[] }): string {
  const max = Math.max(1, ...data.heatmap.map((day) => day.count));
  const cells = data.heatmap.map((day) => {
    const level = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / max) * 4));
    const active = input.date === day.day ? " active" : "";
    return `<a class="heat-day level-${level} ${moodClass(day.mood)}${active}" title="${day.day}: ${day.count} 条${day.mood ? ` / ${day.mood}` : ""}" href="${adminPath(input, { tab: "browse", date: input.date === day.day ? "" : day.day, page: 1, notice: "" })}"></a>`;
  }).join("");
  return `<section class="card memory-dashboard"><div class="header-row"><span class="section-title">记忆状态</span><div class="divider"></div><a class="small-btn" href="/admin/maintenance">维护页</a></div><div class="stat-grid"><div class="stat-item"><span class="stat-value">${data.stats.total}</span><span class="stat-label">总量</span></div><div class="stat-item"><span class="stat-value">${data.stats.active}</span><span class="stat-label">活跃</span></div><div class="stat-item"><span class="stat-value">${data.stats.vectorized}</span><span class="stat-label">可索引</span></div></div><div class="heatmap-title">最近 90 天写入 / 情绪热力图</div><div class="heatmap">${cells}</div><div class="heat-legend"><span>点一天可筛选</span><span>少 -&gt; 多</span></div></section>`;
}

function renderEditForm(record: MemoryRecord): string {
  const tags = parseTags(record.tags);
  const mood = moodOf(record.tags);
  const plainTags = tags.filter((tag) => !tag.startsWith("mood:")).join(", ");
  return `<details class="memory-detail"><summary>编辑</summary><form class="edit-form" method="POST" action="/admin/memories/edit"><input type="hidden" name="id" value="${attr(record.id)}"><div class="input-group"><div class="input-label">正文</div><textarea name="content" class="edit-textarea">${htmlEscape(record.content)}</textarea></div><div class="edit-grid"><label><span>类型</span><input type="text" name="type" value="${attr(record.type || "note")}"></label><label><span>标签</span><input type="text" name="tags" value="${attr(plainTags)}" placeholder="逗号/换行都可以"></label><label><span>心情</span><select name="mood" class="filter-select">${renderMoodOptions(mood)}</select></label><label><span>重要度</span><input type="text" name="importance" value="${attr(Number(record.importance || 0).toFixed(2))}"></label></div><label class="pin-check"><input type="checkbox" name="pinned" ${record.pinned ? "checked" : ""}> 置顶</label><div class="footer edit-footer"><span class="char-count">id: ${htmlEscape(record.id)}</span><button class="btn" type="submit">保存修改</button></div></form></details>`;
}

function renderMemory(record: MemoryRecord, tab: string): string {
  const tags = parseTags(record.tags);
  const tagHtml = tags.slice(0, 6).map((tag) => `<span class="tag-pill ${moodClass(tag.replace("mood:", ""))}">${htmlEscape(tag)}</span>`).join("");
  const deleteForm = record.status === "active" ? `<form method="POST" action="/admin/memories/delete" class="delete-form" onsubmit="return confirm('确认删除吗？这会软删除，不会立刻物理清空。')"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn delete" type="submit">删除</button></form>` : "";
  const cardClass = tab === "diary" ? `diary-card ${record.type === "diary" ? "kld" : "layla"}` : tab === "quote" ? "quote-card" : tab === "browse" ? "memory-card" : "message-card";
  return `<article class="${cardClass} ${record.status !== "active" ? "muted" : ""}"><div class="message-header"><span class="message-time">${htmlEscape(formatTime(record.created_at || record.updated_at))}</span></div><div class="message-content">${htmlEscape(record.content)}</div><div class="memory-meta"><span class="score-pill">${htmlEscape(record.type || "note")}</span>${record.pinned ? '<span class="tag-pill">pinned</span>' : ""}${tagHtml}</div>${renderEditForm(record)}<div class="actions">${deleteForm}</div></article>`;
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

export function renderPage(input: PageInput, data: PageData): string {
  const searchPrefix = input.searchMode === "semantic" ? "语义搜索" : "搜索";
  const listTitle = input.tab === "message" ? "历史留言" : input.tab === "diary" ? "我们的日记" : input.tab === "quote" ? "我的语录" : input.date ? `${input.date} 的记忆` : input.q ? `${searchPrefix}：${input.q}` : "记忆列表";
  const list = data.records.length ? data.records.map((record) => renderMemory(record, input.tab)).join("") : '<div class="empty">这里还没有内容</div>';
  const dashboard = input.tab === "browse" ? renderDashboard(input, data) : "";
  const composer = renderComposer(input, renderBrowseTypeOptions(data.types, input.type));
  const quoteFilter = renderQuoteFilter(input, data.quoteCategories);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>♡</title><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;500&display=swap" rel="stylesheet"><style>${ADMIN_BOARD_CSS}</style></head><body><div class="page"><header><div class="heart">♡</div><h1>我们的记忆小家</h1><div class="subtitle">MEMORY HOME</div></header>${renderTabs(input)}${dashboard}${composer}${quoteFilter}<div class="header-row"><span class="section-title">${htmlEscape(listTitle)}</span><div class="divider"></div><a class="small-btn" href="${adminPath(input, { page: 1, q: "", tag: "", date: "", category: "", mood: "", notice: "", searchMode: "keyword" })}">刷新</a></div>${list}${renderPagination(input, data.total)}</div><div class="toast" id="toast"></div><script>const n=${JSON.stringify(input.notice)};const m={created:'已保存 ♡',edited:'修改成功 ♡',deleted:'已删除',empty:'没有内容',error:'保存失败'};if(n&&m[n]){const t=document.getElementById('toast');t.textContent=m[n];t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);history.replaceState(null,'',location.pathname+location.search.replace(/[?&]notice=[^&]*/,''));}</script></body></html>`;
}
