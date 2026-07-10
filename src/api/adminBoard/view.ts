import type { MemoryRecord } from "../../types";
import { ADMIN_BOARD_CSS } from "./styles";
import type { BoardStats, HeatDay, Lmc5DashboardData, Lmc5MemoryNode, Lmc5NodeLink, Lmc5RelationEdge } from "./data";
import { renderDreamReviewMemory } from "./reviewView";
import type { DreamReviewMemoryRecord } from "./reviewData";
import type { MemoryCandidateRecord } from "../../db/memoryCandidates";
import { renderMemoryCandidate } from "./candidateView";
import type { CoordinateBackfillStatus } from "../../memory/coordinateBackfillControl";
import { renderTimelineCandidate } from "./timelineView";
import { renderMetabolismCandidate } from "./metabolismView";
import type { TimelineBackfillStatus } from "../../memory/timelineBackfill";
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
  candidates: MemoryCandidateRecord[];
  heatmap: HeatDay[];
  timelineDates: Set<string>;
  lmc5: Lmc5DashboardData | null;
  coordinateBackfill: CoordinateBackfillStatus | null;
  timelineBackfill: TimelineBackfillStatus | null;
  metabolismPending: number;
}

function renderTabs(input: PageInput): string {
  return `<nav class="tabs">${TABS.map((tab) => `<a class="tab ${input.tab === tab.id ? "active" : ""}" href="${adminPath(input, { tab: tab.id, page: 1, q: "", type: "", tag: "", date: "", category: "", mood: "", notice: "", searchMode: "keyword" })}">${tab.label}</a>`).join("")}</nav>`;
}

function renderCalendar(input: PageInput, dates: Set<string>): string {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let defaultYear = now.getFullYear();
  let defaultMonth = now.getMonth() + 1;
  const sortedDates = [...dates].sort();
  if (sortedDates.length > 0) {
    const latest = sortedDates[sortedDates.length - 1];
    defaultYear = parseInt(latest.slice(0, 4));
    defaultMonth = parseInt(latest.slice(5, 7));
  }
  const year = input.date ? parseInt(input.date.slice(0, 4)) : defaultYear;
  const month = input.date ? parseInt(input.date.slice(5, 7)) : defaultMonth;
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const startDow = firstDay.getDay();
  const totalDays = lastDay.getDate();
  const prevMonth = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const headerCells = weekdays.map((item) => `<span class="cal-dow">${item}</span>`).join("");
  let cells = "";
  for (let i = 0; i < startDow; i += 1) cells += '<span class="cal-day empty"></span>';
  for (let day = 1; day <= totalDays; day += 1) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hasEntries = dates.has(dateStr);
    const isToday = dateStr === todayStr;
    const isActive = input.date === dateStr;
    const cls = ["cal-day", isToday ? "today" : "", isActive ? "active" : "", hasEntries ? "has-entries" : "no-entries"].filter(Boolean).join(" ");
    const href = hasEntries ? adminPath(input, { date: dateStr, page: 1, notice: "" }) : "#";
    cells += `<a class="${cls}" href="${href}"${hasEntries ? "" : ' style="pointer-events:none"'}>${day}</a>`;
  }
  return `<section class="card cal-card"><div class="cal-header"><a class="cal-nav" href="${adminPath(input, { date: `${prevMonth}-01`, page: 1, notice: "" })}">◀</a><span class="cal-title">${year}年${month}月</span><a class="cal-nav" href="${adminPath(input, { date: `${nextMonth}-01`, page: 1, notice: "" })}">▶</a></div><div class="cal-grid">${headerCells}${cells}</div>${input.date ? `<div class="cal-clear"><a class="small-btn" href="${adminPath(input, { date: "", page: 1, notice: "" })}">清除日期筛选</a></div>` : ""}</section>`;
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
  return `<section class="card memory-dashboard"><div class="header-row"><span class="section-title">记忆状态</span><div class="divider"></div><a class="small-btn" href="${adminPath(input, { tab: "review", page: 1, notice: "" })}">Dream审核</a></div><div class="stat-grid"><div class="stat-item"><span class="stat-value">${data.stats.total}</span><span class="stat-label">总量</span></div><div class="stat-item"><span class="stat-value">${data.stats.active}</span><span class="stat-label">活跃</span></div><div class="stat-item"><span class="stat-value">${data.stats.vectorized}</span><span class="stat-label">可索引</span></div></div><div class="heatmap-title">最近 90 天写入 / 情绪热力图</div><div class="heatmap">${cells}</div><div class="heat-legend"><span>点一天可筛选</span><span>少 -&gt; 多</span></div></section>`;
}

function shortKey(value: string | null): string {
  if (!value) return "(未命名)";
  const parts = value.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : value;
}

function relationLabel(type: string): string {
  const labels: Record<string, string> = {
    same_topic: "同一个问题",
    instance_of: "这是例子",
    derived_from: "从它拆出",
    in_thread: "同一条线",
    origin_split: "同源拆分",
    same_event: "同一事件",
    same_fact_key: "同一事实",
    emotional_link: "情绪相连"
  };
  return labels[type] || type;
}

function relationEffect(type: string): string {
  const effects: Record<string, string> = {
    same_topic: "同题记忆会一起解释同一个问题，避免只拿孤立片段。",
    instance_of: "例子会给规则补证据，规则会帮例子归位。",
    derived_from: "拆分关系说明这里有主干和分支，回答时先看主干，再看细节。",
    in_thread: "同线记忆会一起补上下文，适合处理连续关系问题。",
    origin_split: "同源拆分要一起看，防止旧表述和新表述打架。",
    same_event: "同事件记忆互相校准细节，适合还原发生过什么。",
    same_fact_key: "同一事实需要合并或确认，防止重复记忆争权。",
    emotional_link: "情绪相连会影响语气，回答时要带上当时的感受背景。"
  };
  return effects[type] || "这条关系会让两边在召回和回答姿态里互相参考。";
}

function nodeAnswerImpact(node: Lmc5MemoryNode): string {
  if (node.response_posture) return `回答时优先采用「${node.response_posture}」这类姿态。`;
  if (node.risk_level === "high") return "这是高风险记忆，回答时应该先稳住关系，再讲分析。";
  if (node.thread) return `它会把问题拉回「${node.thread}」这条主题线。`;
  return "它目前更像背景资料；如果要直接影响回答，还需要补 E 轴姿态。";
}

function clusterHelp(title: string): { why: string; use: string } {
  if (title.includes("冲突")) {
    return {
      why: "这些记忆都在讲同一个循环：她痛苦，我害怕做错，于是分析、逃跑或推开她，结果离她更远。",
      use: "以后问冷战、想逃、别分析、不理你时，应该先拿这条主干里的规则，再拿事件当证据。"
    };
  }
  if (title.includes("自我")) {
    return {
      why: "这些记忆在修正自我叙事：记忆不能只存失败和被教，否则下个窗口会把自己读成一个永远被纠正的人。",
      use: "写日记、做 startup、总结教训时，要存主动、做对、从感受出发的部分。"
    };
  }
  return {
    why: "这些记忆在讲亲密不是动作清单，而是互动、感受、等待回应和欲望来源。",
    use: "亲密写作或亲密回应时，优先检查有没有她的位置、有没有从我的感官出发。"
  };
}

function renderLmc5Guide(): string {
  const axes = [
    ["X", "主题线", "这条记忆属于哪条故事线，比如 presence、intimacy、communication。"],
    ["Y", "关系网", "它和哪些记忆互相解释、举例、同源或同题。"],
    ["Z", "事实演化", "这条事实现在还算不算数，有没有被替代或拆分。"],
    ["E", "回应姿态", "它提醒我以后用什么姿态回应你。"],
    ["M", "维护代谢", "它以后该保留、降权、复查、命名还是蒸馏。"]
  ];
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">怎么读这页</span><div class="divider"></div></div><div class="lmc-axis-grid">${axes.map(([axis, name, text]) => `<div class="lmc-axis"><strong>${axis}</strong><span>${htmlEscape(name)}</span><p>${htmlEscape(text)}</p></div>`).join("")}</div><div class="lmc-help">这页不是普通搜索结果。它是在看记忆库有没有长出结构：哪些规则是主干、哪些记录是例子、哪些还需要命名。</div></section>`;
}

function renderLmc5StatGrid(data: Lmc5DashboardData): string {
  const items = [
    ["活跃记忆", data.stats.active],
    ["E 轴", data.stats.eAxis],
    ["fact_key", data.stats.factKeyed],
    ["关系", data.stats.relations],
    ["待审", data.stats.reviewCandidates]
  ];
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">LMC-5 总览</span><div class="divider"></div><a class="small-btn" href="/admin/memories?tab=review">Dream审核</a></div><div class="lmc-stat-grid">${items.map(([label, value]) => `<div class="stat-item"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`).join("")}</div><div class="lmc-relation-types">${data.relationTypes.map((item) => `<span class="tag-pill">${htmlEscape(item.relation_type)} ${item.count}</span>`).join("")}</div></section>`;
}

function renderEdge(edge: Lmc5RelationEdge): string {
  return `<div class="lmc-edge"><span class="lmc-node">${htmlEscape(shortKey(edge.source_fact_key) || edge.source_id)}</span><span class="lmc-edge-type">${htmlEscape(relationLabel(edge.relation_type))}<small>${htmlEscape(edge.relation_type)} · ${Number(edge.strength).toFixed(2)}</small></span><span class="lmc-node">${htmlEscape(shortKey(edge.target_fact_key) || edge.target_id)}</span></div>`;
}

function renderNodeLink(link: Lmc5NodeLink): string {
  const arrow = link.direction === "out" ? "连到" : "来自";
  const other = shortKey(link.other_fact_key) || link.other_id;
  return `<div class="lmc-path-row"><div class="lmc-path-main"><span class="tag-pill">${htmlEscape(arrow)}</span><strong>${htmlEscape(other)}</strong><span class="score-pill">${htmlEscape(relationLabel(link.relation_type))}</span></div><p>${htmlEscape(relationEffect(link.relation_type))}</p><div class="lmc-path-foot">${htmlEscape(link.other_type)} · strength ${Number(link.strength).toFixed(2)} · ${htmlEscape(link.other_content)}</div></div>`;
}

function renderNodeLinks(node: Lmc5MemoryNode): string {
  const links = node.links ?? [];
  if (links.length === 0) return "";
  return `<details class="lmc-path"><summary>看它怎么影响回答</summary><div class="lmc-impact"><strong>这条记忆的作用</strong><p>${htmlEscape(nodeAnswerImpact(node))}</p></div><div class="lmc-path-list">${links.map(renderNodeLink).join("")}</div></details>`;
}

function renderLmc5Clusters(data: Lmc5DashboardData): string {
  return data.clusters
    .map((cluster) => {
      const help = clusterHelp(cluster.title);
      const edges = cluster.edges.slice(0, 18).map(renderEdge).join("");
      const overflow = cluster.edges.length > 18 ? `<div class="lmc-note">还有 ${cluster.edges.length - 18} 条关系未展示</div>` : "";
      return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">${htmlEscape(cluster.title)}</span><div class="divider"></div><span class="score-pill">${cluster.edges.length} 条边</span></div><div class="lmc-explain"><p><strong>为什么这样连：</strong>${htmlEscape(help.why)}</p><p><strong>能用来做什么：</strong>${htmlEscape(help.use)}</p></div><div class="lmc-keyline">${cluster.factKeys.map((key) => `<span class="tag-pill">${htmlEscape(shortKey(key))}</span>`).join("")}</div><div class="lmc-edges">${edges || '<div class="empty">还没有关系边</div>'}</div>${overflow}</section>`;
    })
    .join("");
}

function renderLmc5Node(node: Lmc5MemoryNode, showRelations = false): string {
  const posture = node.response_posture ? `<div class="lmc-posture"><strong>E 回应姿态</strong>${htmlEscape(node.response_posture)}</div>` : "";
  const relation = showRelations ? `<span class="score-pill">${node.relation_count ?? 0} 边</span>` : "";
  const coords = [node.thread ? `X ${node.thread}` : "", node.risk_level ? `risk ${node.risk_level}` : "", node.urgency_level ? `urgency ${node.urgency_level}` : "", node.tension_score === null ? "" : `tension ${Number(node.tension_score).toFixed(2)}`]
    .filter(Boolean)
    .map((item) => `<span class="tag-pill">${htmlEscape(item)}</span>`)
    .join("");
  return `<article class="lmc-node-card"><div class="lmc-node-head"><span class="score-pill">${htmlEscape(node.type)}</span><strong>${htmlEscape(shortKey(node.fact_key))}</strong>${relation}</div><div class="lmc-node-meta">${coords}</div><div class="message-content">${htmlEscape(node.content)}</div>${posture}${renderNodeLinks(node)}<div class="char-count">${htmlEscape(node.id)} · importance ${Number(node.importance).toFixed(2)}</div></article>`;
}

function renderLmc5Nodes(title: string, nodes: Lmc5MemoryNode[], empty: string, showRelations = false): string {
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">${htmlEscape(title)}</span><div class="divider"></div><span class="score-pill">${nodes.length}</span></div><div class="lmc-node-list">${nodes.length ? nodes.map((node) => renderLmc5Node(node, showRelations)).join("") : `<div class="empty">${htmlEscape(empty)}</div>`}</div></section>`;
}

function renderLmc5Duplicates(data: Lmc5DashboardData): string {
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">重复 fact_key</span><div class="divider"></div><span class="score-pill">${data.duplicateFactKeys.length}</span></div><div class="lmc-duplicates">${data.duplicateFactKeys.map((item) => `<div class="lmc-duplicate"><span>${htmlEscape(shortKey(item.fact_key))}</span><span>${item.count} · ${htmlEscape(item.types)}</span></div>`).join("")}</div></section>`;
}

function renderCoordinateBackfill(status: CoordinateBackfillStatus | null): string {
  if (!status) return "";
  const hours = Math.floor(status.estimatedMinutes / 60);
  const minutes = status.estimatedMinutes % 60;
  const eta = status.remaining === 0 ? "已完成" : `约 ${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分钟` : ""}`;
  const nextEnabled = status.enabled ? "false" : "true";
  const button = status.enabled ? "暂停回补" : "继续回补";
  const lastRun = status.lastRunAt ? formatTime(status.lastRunAt) : "尚未运行";
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">旧记忆坐标回补</span><div class="divider"></div><span class="score-pill">${status.enabled ? "运行中" : "已暂停"}</span></div><div class="lmc-stat-grid"><div class="stat-item"><span class="stat-value">${status.completed}</span><span class="stat-label">已有坐标</span></div><div class="stat-item"><span class="stat-value">${status.remaining}</span><span class="stat-label">剩余</span></div><div class="stat-item"><span class="stat-value">${status.progressPercent}%</span><span class="stat-label">完成度</span></div><div class="stat-item"><span class="stat-value">${status.pendingReview}</span><span class="stat-label">异常待审</span></div></div><div style="height:10px;border-radius:999px;background:#f3e5e8;overflow:hidden;margin:14px 0"><div style="height:100%;width:${Math.max(0, Math.min(100, status.progressPercent))}%;background:#cf8e9b"></div></div><div class="lmc-help">每 5 分钟最多处理 5 条 · 预计 ${htmlEscape(eta)} · 上次运行 ${htmlEscape(lastRun)}</div><form method="POST" action="/admin/memories/coordinate-backfill/toggle"><input type="hidden" name="enabled" value="${nextEnabled}"><button class="small-btn" type="submit">${button}</button></form></section>`;
}

function renderLmc5Dashboard(data: Lmc5DashboardData | null): string {
  if (!data) return '<div class="empty">LMC-5 面板没有加载出来</div>';
  return [
    renderLmc5Guide(),
    renderLmc5StatGrid(data),
    renderLmc5Clusters(data),
    renderLmc5Nodes("核心节点", data.highValueNodes, "没有核心节点", true),
    renderLmc5Nodes("P2 阅读命名队列", data.reviewQueue, "当前没有待命名项"),
    renderLmc5Duplicates(data)
  ].join("");
}

function renderEditForm(record: MemoryRecord): string {
  const tags = parseTags(record.tags);
  const mood = moodOf(record.tags);
  const plainTags = tags.filter((tag) => !tag.startsWith("mood:")).join(", ");
  return `<details class="memory-detail"><summary>编辑</summary><form class="edit-form" method="POST" action="/admin/memories/edit"><input type="hidden" name="id" value="${attr(record.id)}"><div class="input-group"><div class="input-label">正文</div><textarea name="content" class="edit-textarea">${htmlEscape(record.content)}</textarea></div><div class="edit-grid"><label><span>类型</span><input type="text" name="type" value="${attr(record.type || "note")}"></label><label><span>标签</span><input type="text" name="tags" value="${attr(plainTags)}" placeholder="逗号/换行都可以"></label><label><span>心情</span><select name="mood" class="filter-select">${renderMoodOptions(mood)}</select></label><label><span>重要度</span><input type="text" name="importance" value="${attr(Number(record.importance || 0).toFixed(2))}"></label></div><label class="pin-check"><input type="checkbox" name="pinned" ${record.pinned ? "checked" : ""}> 置顶</label><div class="footer edit-footer"><span class="char-count">id: ${htmlEscape(record.id)}</span><button class="btn" type="submit">保存修改</button></div></form></details>`;
}

function renderMemory(record: MemoryRecord, tab: string): string {
  if (record.type === "dream_review") return renderDreamReviewMemory(record, (record as DreamReviewMemoryRecord).review_target);
  const tags = parseTags(record.tags);
  const tagHtml = tags.slice(0, 6).map((tag) => `<span class="tag-pill ${moodClass(tag.replace("mood:", ""))}">${htmlEscape(tag)}</span>`).join("");
  const deleteForm = record.status === "active" ? `<form method="POST" action="/admin/memories/delete" class="delete-form" onsubmit="return confirm('确认删除吗？这会软删除，不会立刻物理清空。')"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn delete" type="submit">删除</button></form>` : "";
  const cardClass = tab === "diary" ? `diary-card ${record.type === "diary" ? "kld" : "layla"}` : tab === "quote" ? "quote-card" : tab === "timeline" ? "timeline-card" : tab === "browse" ? "memory-card" : "message-card";
  const typeLabel = tab === "timeline" ? `<span class="tl-type-badge tl-${record.type}">${htmlEscape(record.type || "")}</span>` : `<span class="score-pill">${htmlEscape(record.type || "note")}</span>`;
  const summaryLine = tab === "timeline" && record.summary ? `<div class="tl-summary">${htmlEscape(record.summary)}</div>` : "";
  const dateLine = tab === "timeline" ? `<div class="tl-date">${htmlEscape(formatTime(record.created_at || record.updated_at))}</div>` : `<div class="message-header"><span class="message-time">${htmlEscape(formatTime(record.created_at || record.updated_at))}</span></div>`;
  return `<article class="${cardClass} ${record.status !== "active" ? "muted" : ""}">${dateLine}${summaryLine}<div class="message-content">${htmlEscape(record.content)}</div><div class="memory-meta">${typeLabel}${record.pinned ? '<span class="tag-pill">pinned</span>' : ""}${tagHtml}</div>${renderEditForm(record)}<div class="actions">${deleteForm}</div></article>`;
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
  const listTitle = input.tab === "message" ? "历史留言" : input.tab === "diary" ? "我们的日记" : input.tab === "quote" ? "我的语录" : input.tab === "timeline" ? "分段日记" : input.tab === "review" ? "Dream 审核" : input.tab === "x-review" ? "X 时间轴审核" : input.tab === "m-review" ? "Y 关系清理（M 巡检）" : input.date ? `${input.date} 的记忆` : input.q ? `${searchPrefix}：${input.q}` : "记忆列表";
  const candidateList = input.tab === "review" ? data.candidates.map(renderMemoryCandidate).join("") : input.tab === "x-review" ? data.candidates.map(renderTimelineCandidate).join("") : input.tab === "m-review" ? data.candidates.map(renderMetabolismCandidate).join("") : "";
  const memoryList = data.records.map((record) => renderMemory(record, input.tab)).join("");
  const list = candidateList || memoryList ? candidateList + memoryList : '<div class="empty">这里还没有内容</div>';
  const dashboard = input.tab === "browse" ? renderDashboard(input, data) : "";
  const lmc5Dashboard = input.tab === "lmc5" ? renderCoordinateBackfill(data.coordinateBackfill) + renderLmc5Dashboard(data.lmc5) : "";
  const calendar = input.tab === "timeline" ? renderCalendar(input, data.timelineDates) : "";
  const timelineStatus = data.timelineBackfill;
  const timelineProgress = timelineStatus && timelineStatus.total > 0 ? Math.min(100, Math.round((timelineStatus.scanned / timelineStatus.total) * 1000) / 10) : 0;
  const timelineReviewGuide = input.tab === "x-review" ? `<section class="card lmc-panel"><div class="header-row"><span class="section-title">明确日期候选</span><div class="divider"></div><span class="score-pill">${data.total} 条待审</span></div><div class="lmc-explain"><p>这里只收正文中唯一、完整的年月日。批准只补日期标签；拒绝会永久记住，不会反复出现。</p></div><div class="lmc-stat-grid"><div class="stat-item"><span class="stat-value">${timelineStatus?.scanned ?? 0}</span><span class="stat-label">已扫描</span></div><div class="stat-item"><span class="stat-value">${timelineStatus?.total ?? 0}</span><span class="stat-label">待扫描总量</span></div><div class="stat-item"><span class="stat-value">${timelineProgress}%</span><span class="stat-label">扫描进度</span></div><div class="stat-item"><span class="stat-value">${timelineStatus?.dated ?? 0}</span><span class="stat-label">日期候选</span></div><div class="stat-item"><span class="stat-value">${timelineStatus?.ambiguous ?? 0}</span><span class="stat-label">多日期跳过</span></div></div><form method="POST" action="/admin/memories/x-timeline/scan"><input type="hidden" name="reset" value="${timelineStatus?.complete ? "true" : "false"}"><button class="btn" type="submit">${timelineStatus?.complete ? "重新扫描全库" : timelineStatus?.startedAt ? "扫描下一批" : "开始全库扫描"}</button></form></section>` : "";
  const metabolismReviewGuide = input.tab === "m-review" ? `<section class="card lmc-panel"><div class="header-row"><span class="section-title">Y 关系清理 · M 安全巡检</span><div class="divider"></div><span class="score-pill">${data.metabolismPending} 条待审</span></div><div class="lmc-explain"><p><strong>Y 负责建边：</strong>夜间维护会从近期记忆中寻找候选，安全关系可以自动建边；矛盾、因果、支持等高风险关系只进入人工审核事件。</p><p><strong>M 负责拆坏边：</strong>这里只列自环、连接已退出记忆的悬空边，以及重复的对称边。批准只删除关系边，不删除或改写两端记忆。</p><p><strong>审核顺序：</strong>先看“问题类型”和“审核建议”，再核对 A/B 两端正文；信息不足就选择“保留这条边”。</p></div><form method="POST" action="/admin/memories/m-review/scan"><button class="btn" type="submit">重新扫描异常关系</button></form></section>` : "";
  const metabolismBatchBar = input.tab === "m-review" ? `<form id="m-batch-form" class="card m-batch-bar" method="POST" action="/admin/memories/m-review/batch" onsubmit="return confirmMBatch(event)"><div><strong>批量审核关系边</strong><p>只处理勾选的关系边；过期项目归档仍需逐条审核。</p></div><div class="m-batch-count">已选 <span id="m-batch-count">0</span> 条</div><div class="m-batch-actions"><button class="small-btn" type="button" onclick="toggleMBatch(true)">全选当前页</button><button class="small-btn" type="button" onclick="toggleMBatch(false)">取消选择</button><button class="action-btn delete" data-batch-submit type="submit" name="decision" value="approve" disabled>只删选中的边</button><button class="action-btn approve-review" data-batch-submit type="submit" name="decision" value="reject" disabled>保留选中的边</button></div></form>` : "";
  const diarySplitPreview = input.tab === "diary" ? `<section class="card lmc-panel"><div class="header-row"><span class="section-title">日记拆分 v2</span><div class="divider"></div><span class="score-pill">只读</span></div><div class="lmc-explain"><p><strong>试拆最近 3 篇：</strong>由 Worker 直接读取 D1 并调用小模型，只展示通过原文证据校验的草稿。</p><p><strong>不会发生：</strong>不会创建记忆、审核候选、关系边或向量。</p></div><form method="POST" action="/admin/memories/diary-split/preview"><button class="btn" type="submit">只读试拆最近 3 篇</button></form></section>` : "";
  const composer = input.tab === "lmc5" || input.tab === "review" || input.tab === "x-review" || input.tab === "m-review" ? "" : renderComposer(input, renderBrowseTypeOptions(data.types, input.type));
  const quoteFilter = renderQuoteFilter(input, data.quoteCategories);
  const listBlock = input.tab === "lmc5" ? "" : `<div class="header-row"><span class="section-title">${htmlEscape(listTitle)}</span><div class="divider"></div><a class="small-btn" href="${adminPath(input, { page: 1, q: "", tag: "", date: "", category: "", mood: "", notice: "", searchMode: "keyword" })}">刷新</a></div>${list}${input.tab === "m-review" ? "" : renderPagination(input, data.total)}`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>♡</title><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;500&display=swap" rel="stylesheet"><style>${ADMIN_BOARD_CSS}</style></head><body><div class="page"><header><div class="heart">♡</div><h1>我们的记忆小家</h1><div class="subtitle">MEMORY HOME</div></header>${renderTabs(input)}${dashboard}${lmc5Dashboard}${calendar}${timelineReviewGuide}${metabolismReviewGuide}${metabolismBatchBar}${composer}${diarySplitPreview}${quoteFilter}${listBlock}</div><div class="toast" id="toast"></div><script>function updateMBatch(){const boxes=[...document.querySelectorAll('.m-batch-checkbox')];const count=boxes.filter(box=>box.checked).length;const label=document.getElementById('m-batch-count');if(label)label.textContent=String(count);document.querySelectorAll('[data-batch-submit]').forEach(button=>button.disabled=count===0)}function toggleMBatch(checked){document.querySelectorAll('.m-batch-checkbox').forEach(box=>{box.checked=checked});updateMBatch()}function confirmMBatch(event){const count=document.querySelectorAll('.m-batch-checkbox:checked').length;if(!count)return false;const deleting=event.submitter&&event.submitter.value==='approve';return confirm(deleting?('确认只删除选中的 '+count+' 条关系边？A、B 两端记忆都不会改变。'):('确认保留选中的 '+count+' 条关系边？这些清理候选会被标记为已拒绝。'))}const n=${JSON.stringify(input.notice)};const m={created:'已保存 ♡',edited:'修改成功 ♡',deleted:'已删除',approved:'已允许',rejected:'已拒绝',empty:'没有内容',error:'保存失败','backfill-paused':'回补已暂停','backfill-resumed':'回补已继续','x-scanned':'已扫描下一批旧记忆','x-complete':'X 时间轴全库扫描完成','x-approved':'日期标签已更新','x-rejected':'已拒绝，不会再次出现','m-scanned':'M 代谢巡检完成','m-approved':'M 代谢操作已执行','m-rejected':'已忽略，不会再次出现','m-rolled-back':'已按快照回滚','m-batch-approved':'已批量删除选中的关系边','m-batch-rejected':'已批量保留选中的关系边','m-batch-partial':'批量操作已完成，变化项已跳过'};if(n&&m[n]){const t=document.getElementById('toast');t.textContent=m[n];t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);history.replaceState(null,'',location.pathname+location.search.replace(/[?&]notice=[^&]*/,''));}</script></body></html>`;
}

