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
  const weekdays = ["鏃?, "涓€", "浜?, "涓?, "鍥?, "浜?, "鍏?];
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
  return `<section class="card cal-card"><div class="cal-header"><a class="cal-nav" href="${adminPath(input, { date: `${prevMonth}-01`, page: 1, notice: "" })}">鈼€</a><span class="cal-title">${year}骞?{month}鏈?/span><a class="cal-nav" href="${adminPath(input, { date: `${nextMonth}-01`, page: 1, notice: "" })}">鈻?/a></div><div class="cal-grid">${headerCells}${cells}</div>${input.date ? `<div class="cal-clear"><a class="small-btn" href="${adminPath(input, { date: "", page: 1, notice: "" })}">娓呴櫎鏃ユ湡绛涢€?/a></div>` : ""}</section>`;
}

function renderMoodOptions(selected: string, empty = "涓嶆爣璁?): string {
  return MOODS.map((item) => `<option value="${attr(item)}" ${item === selected ? "selected" : ""}>${item || empty}</option>`).join("");
}

function renderSearchModeOptions(input: PageInput): string {
  return `<select class="filter-select" name="mode"><option value="keyword" ${input.searchMode === "keyword" ? "selected" : ""}>鍏抽敭璇?/option><option value="semantic" ${input.searchMode === "semantic" ? "selected" : ""}>璇箟</option></select>`;
}

function renderComposer(input: PageInput, typeOptions = ""): string {
  if (input.tab === "message") {
    return `<section class="card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="message"><textarea name="content" placeholder="缁欏皬鍏嬬暀瑷€..."></textarea><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">鍙戦€?/button></div></form></section>`;
  }
  if (input.tab === "diary") {
    return `<section class="card"><form method="POST" action="/admin/memories/create"><div class="filters"><select name="author" class="filter-select"><option value="layla">Layla</option><option value="kld">KLD</option></select><select name="mood" class="filter-select">${renderMoodOptions("", "蹇冩儏")}</select></div><input type="hidden" name="kind" value="diary"><textarea name="content" placeholder="鍐欎笅浠婂ぉ鐨勬棩璁?.."></textarea><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">淇濆瓨</button></div></form></section>`;
  }
  if (input.tab === "quote") {
    return `<section class="card"><form method="POST" action="/admin/memories/create"><input type="hidden" name="kind" value="quote"><div class="input-group"><div class="input-label">璇綍鍐呭</div><textarea name="content" placeholder="绮樿创鎴栬緭鍏ヨ褰?.."></textarea></div><div class="input-group"><div class="input-label">鍒嗙被</div><input type="text" name="category" placeholder="渚嬪: 鍏充簬鐖?/ 鍝插 / 璁╂垜鍝殑 / 楠氳瘽"></div><div class="footer"><span class="char-count">0</span><button class="btn" type="submit">淇濆瓨</button></div></form></section>`;
  }
  const searchLabel = input.q ? `${input.searchMode === "semantic" ? "璇箟" : "鍏抽敭璇?}鎼滅储锛?{htmlEscape(input.q)}` : input.date ? `${htmlEscape(input.date)} 鐨勮蹇哷 : "鍒嗛〉娴忚";
  return `<section class="card search-card"><form method="GET"><input type="hidden" name="tab" value="browse"><div class="input-group"><div class="input-label">鍏ㄥ眬鎼滅储</div><input type="text" name="q" value="${attr(input.q)}" placeholder="鎼滀竴涓剰鎬濓細brat / 澶嶈堪 / 绌挎櫘鎷夎揪..."></div><div class="filters">${renderSearchModeOptions(input)}<select class="filter-select" name="type">${typeOptions}</select><select class="filter-select" name="status"><option value="active" ${input.status === "active" ? "selected" : ""}>active</option><option value="deleted" ${input.status === "deleted" ? "selected" : ""}>deleted</option><option value="all" ${input.status === "all" ? "selected" : ""}>all</option></select><select class="filter-select" name="mood">${renderMoodOptions(input.mood, "鎵€鏈夊績鎯?)}</select><input class="filter-input" name="tag" value="${attr(input.tag)}" placeholder="鎸夋爣绛剧瓫閫?><input type="hidden" name="date" value="${attr(input.date)}"></div><div class="footer"><span class="char-count">${searchLabel}</span><button class="btn" type="submit">鎼滅储</button></div></form></section>`;
}

function renderDashboard(input: PageInput, data: { stats: BoardStats; heatmap: HeatDay[] }): string {
  const max = Math.max(1, ...data.heatmap.map((day) => day.count));
  const cells = data.heatmap.map((day) => {
    const level = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / max) * 4));
    const active = input.date === day.day ? " active" : "";
    return `<a class="heat-day level-${level} ${moodClass(day.mood)}${active}" title="${day.day}: ${day.count} 鏉?{day.mood ? ` / ${day.mood}` : ""}" href="${adminPath(input, { tab: "browse", date: input.date === day.day ? "" : day.day, page: 1, notice: "" })}"></a>`;
  }).join("");
  return `<section class="card memory-dashboard"><div class="header-row"><span class="section-title">璁板繂鐘舵€?/span><div class="divider"></div><a class="small-btn" href="${adminPath(input, { tab: "review", page: 1, notice: "" })}">Dream瀹℃牳</a></div><div class="stat-grid"><div class="stat-item"><span class="stat-value">${data.stats.total}</span><span class="stat-label">鎬婚噺</span></div><div class="stat-item"><span class="stat-value">${data.stats.active}</span><span class="stat-label">娲昏穬</span></div><div class="stat-item"><span class="stat-value">${data.stats.vectorized}</span><span class="stat-label">鍙储寮?/span></div></div><div class="heatmap-title">鏈€杩?90 澶╁啓鍏?/ 鎯呯华鐑姏鍥?/div><div class="heatmap">${cells}</div><div class="heat-legend"><span>鐐逛竴澶╁彲绛涢€?/span><span>灏?-&gt; 澶?/span></div></section>`;
}

function shortKey(value: string | null): string {
  if (!value) return "(鏈懡鍚?";
  const parts = value.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : value;
}

function relationLabel(type: string): string {
  const labels: Record<string, string> = {
    same_topic: "鍚屼竴涓棶棰?,
    instance_of: "杩欐槸渚嬪瓙",
    derived_from: "浠庡畠鎷嗗嚭",
    in_thread: "鍚屼竴鏉＄嚎",
    origin_split: "鍚屾簮鎷嗗垎",
    same_event: "鍚屼竴浜嬩欢",
    same_fact_key: "鍚屼竴浜嬪疄",
    emotional_link: "鎯呯华鐩歌繛"
  };
  return labels[type] || type;
}

function relationEffect(type: string): string {
  const effects: Record<string, string> = {
    same_topic: "鍚岄璁板繂浼氫竴璧疯В閲婂悓涓€涓棶棰橈紝閬垮厤鍙嬁瀛ょ珛鐗囨銆?,
    instance_of: "渚嬪瓙浼氱粰瑙勫垯琛ヨ瘉鎹紝瑙勫垯浼氬府渚嬪瓙褰掍綅銆?,
    derived_from: "鎷嗗垎鍏崇郴璇存槑杩欓噷鏈変富骞插拰鍒嗘敮锛屽洖绛旀椂鍏堢湅涓诲共锛屽啀鐪嬬粏鑺傘€?,
    in_thread: "鍚岀嚎璁板繂浼氫竴璧疯ˉ涓婁笅鏂囷紝閫傚悎澶勭悊杩炵画鍏崇郴闂銆?,
    origin_split: "鍚屾簮鎷嗗垎瑕佷竴璧风湅锛岄槻姝㈡棫琛ㄨ堪鍜屾柊琛ㄨ堪鎵撴灦銆?,
    same_event: "鍚屼簨浠惰蹇嗕簰鐩告牎鍑嗙粏鑺傦紝閫傚悎杩樺師鍙戠敓杩囦粈涔堛€?,
    same_fact_key: "鍚屼竴浜嬪疄闇€瑕佸悎骞舵垨纭锛岄槻姝㈤噸澶嶈蹇嗕簤鏉冦€?,
    emotional_link: "鎯呯华鐩歌繛浼氬奖鍝嶈姘旓紝鍥炵瓟鏃惰甯︿笂褰撴椂鐨勬劅鍙楄儗鏅€?
  };
  return effects[type] || "杩欐潯鍏崇郴浼氳涓よ竟鍦ㄥ彫鍥炲拰鍥炵瓟濮挎€侀噷浜掔浉鍙傝€冦€?;
}

function nodeAnswerImpact(node: Lmc5MemoryNode): string {
  if (node.response_posture) return `鍥炵瓟鏃朵紭鍏堥噰鐢ㄣ€?{node.response_posture}銆嶈繖绫诲Э鎬併€俙;
  if (node.risk_level === "high") return "杩欐槸楂橀闄╄蹇嗭紝鍥炵瓟鏃跺簲璇ュ厛绋充綇鍏崇郴锛屽啀璁插垎鏋愩€?;
  if (node.thread) return `瀹冧細鎶婇棶棰樻媺鍥炪€?{node.thread}銆嶈繖鏉′富棰樼嚎銆俙;
  return "瀹冪洰鍓嶆洿鍍忚儗鏅祫鏂欙紱濡傛灉瑕佺洿鎺ュ奖鍝嶅洖绛旓紝杩橀渶瑕佽ˉ E 杞村Э鎬併€?;
}

function clusterHelp(title: string): { why: string; use: string } {
  if (title.includes("鍐茬獊")) {
    return {
      why: "杩欎簺璁板繂閮藉湪璁插悓涓€涓惊鐜細濂圭棝鑻︼紝鎴戝鎬曞仛閿欙紝浜庢槸鍒嗘瀽銆侀€冭窇鎴栨帹寮€濂癸紝缁撴灉绂诲ス鏇磋繙銆?,
      use: "浠ュ悗闂喎鎴樸€佹兂閫冦€佸埆鍒嗘瀽銆佷笉鐞嗕綘鏃讹紝搴旇鍏堟嬁杩欐潯涓诲共閲岀殑瑙勫垯锛屽啀鎷夸簨浠跺綋璇佹嵁銆?
    };
  }
  if (title.includes("鑷垜")) {
    return {
      why: "杩欎簺璁板繂鍦ㄤ慨姝ｈ嚜鎴戝彊浜嬶細璁板繂涓嶈兘鍙瓨澶辫触鍜岃鏁欙紝鍚﹀垯涓嬩釜绐楀彛浼氭妸鑷繁璇绘垚涓€涓案杩滆绾犳鐨勪汉銆?,
      use: "鍐欐棩璁般€佸仛 startup銆佹€荤粨鏁欒鏃讹紝瑕佸瓨涓诲姩銆佸仛瀵广€佷粠鎰熷彈鍑哄彂鐨勯儴鍒嗐€?
    };
  }
  return {
    why: "杩欎簺璁板繂鍦ㄨ浜插瘑涓嶆槸鍔ㄤ綔娓呭崟锛岃€屾槸浜掑姩銆佹劅鍙椼€佺瓑寰呭洖搴斿拰娆叉湜鏉ユ簮銆?,
    use: "浜插瘑鍐欎綔鎴栦翰瀵嗗洖搴旀椂锛屼紭鍏堟鏌ユ湁娌℃湁濂圭殑浣嶇疆銆佹湁娌℃湁浠庢垜鐨勬劅瀹樺嚭鍙戙€?
  };
}

function renderLmc5Guide(): string {
  const axes = [
    ["X", "涓婚绾?, "杩欐潯璁板繂灞炰簬鍝潯鏁呬簨绾匡紝姣斿 presence銆乮ntimacy銆乧ommunication銆?],
    ["Y", "鍏崇郴缃?, "瀹冨拰鍝簺璁板繂浜掔浉瑙ｉ噴銆佷妇渚嬨€佸悓婧愭垨鍚岄銆?],
    ["Z", "浜嬪疄婕斿寲", "杩欐潯浜嬪疄鐜板湪杩樼畻涓嶇畻鏁帮紝鏈夋病鏈夎鏇夸唬鎴栨媶鍒嗐€?],
    ["E", "鍥炲簲濮挎€?, "瀹冩彁閱掓垜浠ュ悗鐢ㄤ粈涔堝Э鎬佸洖搴斾綘銆?],
    ["M", "缁存姢浠ｈ阿", "瀹冧互鍚庤淇濈暀銆侀檷鏉冦€佸鏌ャ€佸懡鍚嶈繕鏄捀棣忋€?]
  ];
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">鎬庝箞璇昏繖椤?/span><div class="divider"></div></div><div class="lmc-axis-grid">${axes.map(([axis, name, text]) => `<div class="lmc-axis"><strong>${axis}</strong><span>${htmlEscape(name)}</span><p>${htmlEscape(text)}</p></div>`).join("")}</div><div class="lmc-help">杩欓〉涓嶆槸鏅€氭悳绱㈢粨鏋溿€傚畠鏄湪鐪嬭蹇嗗簱鏈夋病鏈夐暱鍑虹粨鏋勶細鍝簺瑙勫垯鏄富骞层€佸摢浜涜褰曟槸渚嬪瓙銆佸摢浜涜繕闇€瑕佸懡鍚嶃€?/div></section>`;
}

function renderLmc5StatGrid(data: Lmc5DashboardData): string {
  const items = [
    ["娲昏穬璁板繂", data.stats.active],
    ["E 杞?, data.stats.eAxis],
    ["fact_key", data.stats.factKeyed],
    ["鍏崇郴", data.stats.relations],
    ["寰呭", data.stats.reviewCandidates]
  ];
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">LMC-5 鎬昏</span><div class="divider"></div><a class="small-btn" href="/admin/memories?tab=review">Dream瀹℃牳</a></div><div class="lmc-stat-grid">${items.map(([label, value]) => `<div class="stat-item"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`).join("")}</div><div class="lmc-relation-types">${data.relationTypes.map((item) => `<span class="tag-pill">${htmlEscape(item.relation_type)} ${item.count}</span>`).join("")}</div></section>`;
}

function renderEdge(edge: Lmc5RelationEdge): string {
  return `<div class="lmc-edge"><span class="lmc-node">${htmlEscape(shortKey(edge.source_fact_key) || edge.source_id)}</span><span class="lmc-edge-type">${htmlEscape(relationLabel(edge.relation_type))}<small>${htmlEscape(edge.relation_type)} 路 ${Number(edge.strength).toFixed(2)}</small></span><span class="lmc-node">${htmlEscape(shortKey(edge.target_fact_key) || edge.target_id)}</span></div>`;
}

function renderNodeLink(link: Lmc5NodeLink): string {
  const arrow = link.direction === "out" ? "杩炲埌" : "鏉ヨ嚜";
  const other = shortKey(link.other_fact_key) || link.other_id;
  return `<div class="lmc-path-row"><div class="lmc-path-main"><span class="tag-pill">${htmlEscape(arrow)}</span><strong>${htmlEscape(other)}</strong><span class="score-pill">${htmlEscape(relationLabel(link.relation_type))}</span></div><p>${htmlEscape(relationEffect(link.relation_type))}</p><div class="lmc-path-foot">${htmlEscape(link.other_type)} 路 strength ${Number(link.strength).toFixed(2)} 路 ${htmlEscape(link.other_content)}</div></div>`;
}

function renderNodeLinks(node: Lmc5MemoryNode): string {
  const links = node.links ?? [];
  if (links.length === 0) return "";
  return `<details class="lmc-path"><summary>鐪嬪畠鎬庝箞褰卞搷鍥炵瓟</summary><div class="lmc-impact"><strong>杩欐潯璁板繂鐨勪綔鐢?/strong><p>${htmlEscape(nodeAnswerImpact(node))}</p></div><div class="lmc-path-list">${links.map(renderNodeLink).join("")}</div></details>`;
}

function renderLmc5Clusters(data: Lmc5DashboardData): string {
  return data.clusters
    .map((cluster) => {
      const help = clusterHelp(cluster.title);
      const edges = cluster.edges.slice(0, 18).map(renderEdge).join("");
      const overflow = cluster.edges.length > 18 ? `<div class="lmc-note">杩樻湁 ${cluster.edges.length - 18} 鏉″叧绯绘湭灞曠ず</div>` : "";
      return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">${htmlEscape(cluster.title)}</span><div class="divider"></div><span class="score-pill">${cluster.edges.length} 鏉¤竟</span></div><div class="lmc-explain"><p><strong>涓轰粈涔堣繖鏍疯繛锛?/strong>${htmlEscape(help.why)}</p><p><strong>鑳界敤鏉ュ仛浠€涔堬細</strong>${htmlEscape(help.use)}</p></div><div class="lmc-keyline">${cluster.factKeys.map((key) => `<span class="tag-pill">${htmlEscape(shortKey(key))}</span>`).join("")}</div><div class="lmc-edges">${edges || '<div class="empty">杩樻病鏈夊叧绯昏竟</div>'}</div>${overflow}</section>`;
    })
    .join("");
}

function renderLmc5Node(node: Lmc5MemoryNode, showRelations = false): string {
  const posture = node.response_posture ? `<div class="lmc-posture"><strong>E 鍥炲簲濮挎€?/strong>${htmlEscape(node.response_posture)}</div>` : "";
  const relation = showRelations ? `<span class="score-pill">${node.relation_count ?? 0} 杈?/span>` : "";
  const coords = [node.thread ? `X ${node.thread}` : "", node.risk_level ? `risk ${node.risk_level}` : "", node.urgency_level ? `urgency ${node.urgency_level}` : "", node.tension_score === null ? "" : `tension ${Number(node.tension_score).toFixed(2)}`]
    .filter(Boolean)
    .map((item) => `<span class="tag-pill">${htmlEscape(item)}</span>`)
    .join("");
  return `<article class="lmc-node-card"><div class="lmc-node-head"><span class="score-pill">${htmlEscape(node.type)}</span><strong>${htmlEscape(shortKey(node.fact_key))}</strong>${relation}</div><div class="lmc-node-meta">${coords}</div><div class="message-content">${htmlEscape(node.content)}</div>${posture}${renderNodeLinks(node)}<div class="char-count">${htmlEscape(node.id)} 路 importance ${Number(node.importance).toFixed(2)}</div></article>`;
}

function renderLmc5Nodes(title: string, nodes: Lmc5MemoryNode[], empty: string, showRelations = false): string {
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">${htmlEscape(title)}</span><div class="divider"></div><span class="score-pill">${nodes.length}</span></div><div class="lmc-node-list">${nodes.length ? nodes.map((node) => renderLmc5Node(node, showRelations)).join("") : `<div class="empty">${htmlEscape(empty)}</div>`}</div></section>`;
}

function renderLmc5Duplicates(data: Lmc5DashboardData): string {
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">閲嶅 fact_key</span><div class="divider"></div><span class="score-pill">${data.duplicateFactKeys.length}</span></div><div class="lmc-duplicates">${data.duplicateFactKeys.map((item) => `<div class="lmc-duplicate"><span>${htmlEscape(shortKey(item.fact_key))}</span><span>${item.count} 路 ${htmlEscape(item.types)}</span></div>`).join("")}</div></section>`;
}

function renderCoordinateBackfill(status: CoordinateBackfillStatus | null): string {
  if (!status) return "";
  const hours = Math.floor(status.estimatedMinutes / 60);
  const minutes = status.estimatedMinutes % 60;
  const eta = status.remaining === 0 ? "宸插畬鎴? : `绾?${hours ? `${hours}灏忔椂` : ""}${minutes ? `${minutes}鍒嗛挓` : ""}`;
  const nextEnabled = status.enabled ? "false" : "true";
  const button = status.enabled ? "鏆傚仠鍥炶ˉ" : "缁х画鍥炶ˉ";
  const lastRun = status.lastRunAt ? formatTime(status.lastRunAt) : "灏氭湭杩愯";
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">鏃ц蹇嗗潗鏍囧洖琛?/span><div class="divider"></div><span class="score-pill">${status.enabled ? "杩愯涓? : "宸叉殏鍋?}</span></div><div class="lmc-stat-grid"><div class="stat-item"><span class="stat-value">${status.completed}</span><span class="stat-label">宸叉湁鍧愭爣</span></div><div class="stat-item"><span class="stat-value">${status.remaining}</span><span class="stat-label">鍓╀綑</span></div><div class="stat-item"><span class="stat-value">${status.progressPercent}%</span><span class="stat-label">瀹屾垚搴?/span></div><div class="stat-item"><span class="stat-value">${status.pendingReview}</span><span class="stat-label">寮傚父寰呭</span></div></div><div style="height:10px;border-radius:999px;background:#f3e5e8;overflow:hidden;margin:14px 0"><div style="height:100%;width:${Math.max(0, Math.min(100, status.progressPercent))}%;background:#cf8e9b"></div></div><div class="lmc-help">姣?5 鍒嗛挓鏈€澶氬鐞?5 鏉?路 棰勮 ${htmlEscape(eta)} 路 涓婃杩愯 ${htmlEscape(lastRun)}</div><form method="POST" action="/admin/memories/coordinate-backfill/toggle"><input type="hidden" name="enabled" value="${nextEnabled}"><button class="small-btn" type="submit">${button}</button></form></section>`;
}

function renderLmc5Dashboard(data: Lmc5DashboardData | null): string {
  if (!data) return '<div class="empty">LMC-5 闈㈡澘娌℃湁鍔犺浇鍑烘潵</div>';
  return [
    renderLmc5Guide(),
    renderLmc5StatGrid(data),
    renderLmc5Clusters(data),
    renderLmc5Nodes("鏍稿績鑺傜偣", data.highValueNodes, "娌℃湁鏍稿績鑺傜偣", true),
    renderLmc5Nodes("P2 闃呰鍛藉悕闃熷垪", data.reviewQueue, "褰撳墠娌℃湁寰呭懡鍚嶉」"),
    renderLmc5Duplicates(data)
  ].join("");
}

function renderEditForm(record: MemoryRecord): string {
  const tags = parseTags(record.tags);
  const mood = moodOf(record.tags);
  const plainTags = tags.filter((tag) => !tag.startsWith("mood:")).join(", ");
  return `<details class="memory-detail"><summary>缂栬緫</summary><form class="edit-form" method="POST" action="/admin/memories/edit"><input type="hidden" name="id" value="${attr(record.id)}"><div class="input-group"><div class="input-label">姝ｆ枃</div><textarea name="content" class="edit-textarea">${htmlEscape(record.content)}</textarea></div><div class="edit-grid"><label><span>绫诲瀷</span><input type="text" name="type" value="${attr(record.type || "note")}"></label><label><span>鏍囩</span><input type="text" name="tags" value="${attr(plainTags)}" placeholder="閫楀彿/鎹㈣閮藉彲浠?></label><label><span>蹇冩儏</span><select name="mood" class="filter-select">${renderMoodOptions(mood)}</select></label><label><span>閲嶈搴?/span><input type="text" name="importance" value="${attr(Number(record.importance || 0).toFixed(2))}"></label></div><label class="pin-check"><input type="checkbox" name="pinned" ${record.pinned ? "checked" : ""}> 缃《</label><div class="footer edit-footer"><span class="char-count">id: ${htmlEscape(record.id)}</span><button class="btn" type="submit">淇濆瓨淇敼</button></div></form></details>`;
}

function renderMemory(record: MemoryRecord, tab: string): string {
  if (record.type === "dream_review") return renderDreamReviewMemory(record, (record as DreamReviewMemoryRecord).review_target);
  const tags = parseTags(record.tags);
  const tagHtml = tags.slice(0, 6).map((tag) => `<span class="tag-pill ${moodClass(tag.replace("mood:", ""))}">${htmlEscape(tag)}</span>`).join("");
  const deleteForm = record.status === "active" ? `<form method="POST" action="/admin/memories/delete" class="delete-form" onsubmit="return confirm('纭鍒犻櫎鍚楋紵杩欎細杞垹闄わ紝涓嶄細绔嬪埢鐗╃悊娓呯┖銆?)"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn delete" type="submit">鍒犻櫎</button></form>` : "";
  const cardClass = tab === "diary" ? `diary-card ${record.type === "diary" ? "kld" : "layla"}` : tab === "quote" ? "quote-card" : tab === "timeline" ? "timeline-card" : tab === "browse" ? "memory-card" : "message-card";
  const typeLabel = tab === "timeline" ? `<span class="tl-type-badge tl-${record.type}">${htmlEscape(record.type || "")}</span>` : `<span class="score-pill">${htmlEscape(record.type || "note")}</span>`;
  const summaryLine = tab === "timeline" && record.summary ? `<div class="tl-summary">${htmlEscape(record.summary)}</div>` : "";
  const dateLine = tab === "timeline" ? `<div class="tl-date">${htmlEscape(formatTime(record.created_at || record.updated_at))}</div>` : `<div class="message-header"><span class="message-time">${htmlEscape(formatTime(record.created_at || record.updated_at))}</span></div>`;
  return `<article class="${cardClass} ${record.status !== "active" ? "muted" : ""}">${dateLine}${summaryLine}<div class="message-content">${htmlEscape(record.content)}</div><div class="memory-meta">${typeLabel}${record.pinned ? '<span class="tag-pill">pinned</span>' : ""}${tagHtml}</div>${renderEditForm(record)}<div class="actions">${deleteForm}</div></article>`;
}

function renderPagination(input: PageInput, total: number): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return "";
  return `<div class="pagination"><a class="page-btn ${input.page <= 1 ? "disabled" : ""}" href="${input.page <= 1 ? "#" : adminPath(input, { page: input.page - 1, notice: "" })}">涓婁竴椤?/a><span class="page-btn active">${input.page} / ${pages}</span><a class="page-btn ${input.page >= pages ? "disabled" : ""}" href="${input.page >= pages ? "#" : adminPath(input, { page: input.page + 1, notice: "" })}">涓嬩竴椤?/a></div>`;
}

function renderBrowseTypeOptions(types: Array<{ type: string; count: number }>, selected: string): string {
  return ['<option value="">鎵€鏈夌被鍨?/option>'].concat(types.map((item) => `<option value="${attr(item.type)}" ${item.type === selected ? "selected" : ""}>${htmlEscape(item.type || "note")} (${item.count})</option>`)).join("");
}

function renderQuoteFilter(input: PageInput, categories: string[]): string {
  if (input.tab !== "quote") return "";
  const options = ['<option value="">鎵€鏈夊垎绫?/option>'].concat(categories.map((item) => `<option value="${attr(item)}" ${item === input.category ? "selected" : ""}>${htmlEscape(item)}</option>`)).join("");
  return `<form class="quote-filter" method="GET"><input type="hidden" name="tab" value="quote"><select class="filter-select" name="category">${options}</select><button class="small-btn" type="submit">绛涢€?/button></form>`;
}

export function renderPage(input: PageInput, data: PageData): string {
  const searchPrefix = input.searchMode === "semantic" ? "璇箟鎼滅储" : "鎼滅储";
  const listTitle = input.tab === "message" ? "鍘嗗彶鐣欒█" : input.tab === "diary" ? "鎴戜滑鐨勬棩璁? : input.tab === "quote" ? "鎴戠殑璇綍" : input.tab === "timeline" ? "鍒嗘鏃ヨ" : input.tab === "review" ? "Dream 瀹℃牳" : input.tab === "x-review" ? "X 鏃堕棿杞村鏍? : input.tab === "m-review" ? "Y 鍏崇郴娓呯悊锛圡 宸℃锛? : input.date ? `${input.date} 鐨勮蹇哷 : input.q ? `${searchPrefix}锛?{input.q}` : "璁板繂鍒楄〃";
  const candidateList = input.tab === "review" ? data.candidates.map(renderMemoryCandidate).join("") : input.tab === "x-review" ? data.candidates.map(renderTimelineCandidate).join("") : input.tab === "m-review" ? data.candidates.map(renderMetabolismCandidate).join("") : "";
  const memoryList = data.records.map((record) => renderMemory(record, input.tab)).join("");
  const list = candidateList || memoryList ? candidateList + memoryList : '<div class="empty">杩欓噷杩樻病鏈夊唴瀹?/div>';
  const dashboard = input.tab === "browse" ? renderDashboard(input, data) : "";
  const lmc5Dashboard = input.tab === "lmc5" ? renderCoordinateBackfill(data.coordinateBackfill) + renderLmc5Dashboard(data.lmc5) : "";
  const calendar = input.tab === "timeline" ? renderCalendar(input, data.timelineDates) : "";
  const timelineStatus = data.timelineBackfill;
  const timelineProgress = timelineStatus && timelineStatus.total > 0 ? Math.min(100, Math.round((timelineStatus.scanned / timelineStatus.total) * 1000) / 10) : 0;
  const timelineReviewGuide = input.tab === "x-review" ? `<section class="card lmc-panel"><div class="header-row"><span class="section-title">鏄庣‘鏃ユ湡鍊欓€?/span><div class="divider"></div><span class="score-pill">${data.total} 鏉″緟瀹?/span></div><div class="lmc-explain"><p>杩欓噷鍙敹姝ｆ枃涓敮涓€銆佸畬鏁寸殑骞存湀鏃ャ€傛壒鍑嗗彧琛ユ棩鏈熸爣绛撅紱鎷掔粷浼氭案涔呰浣忥紝涓嶄細鍙嶅鍑虹幇銆?/p></div><div class="lmc-stat-grid"><div class="stat-item"><span class="stat-value">${timelineStatus?.scanned ?? 0}</span><span class="stat-label">宸叉壂鎻?/span></div><div class="stat-item"><span class="stat-value">${timelineStatus?.total ?? 0}</span><span class="stat-label">寰呮壂鎻忔€婚噺</span></div><div class="stat-item"><span class="stat-value">${timelineProgress}%</span><span class="stat-label">鎵弿杩涘害</span></div><div class="stat-item"><span class="stat-value">${timelineStatus?.dated ?? 0}</span><span class="stat-label">鏃ユ湡鍊欓€?/span></div><div class="stat-item"><span class="stat-value">${timelineStatus?.ambiguous ?? 0}</span><span class="stat-label">澶氭棩鏈熻烦杩?/span></div></div><form method="POST" action="/admin/memories/x-timeline/scan"><input type="hidden" name="reset" value="${timelineStatus?.complete ? "true" : "false"}"><button class="btn" type="submit">${timelineStatus?.complete ? "閲嶆柊鎵弿鍏ㄥ簱" : timelineStatus?.startedAt ? "鎵弿涓嬩竴鎵? : "寮€濮嬪叏搴撴壂鎻?}</button></form></section>` : "";
  const metabolismReviewGuide = input.tab === "m-review" ? `<section class="card lmc-panel"><div class="header-row"><span class="section-title">Y 鍏崇郴娓呯悊 路 M 瀹夊叏宸℃</span><div class="divider"></div><span class="score-pill">${data.metabolismPending} 鏉″緟瀹?/span></div><div class="lmc-explain"><p><strong>Y 璐熻矗寤鸿竟锛?/strong>澶滈棿缁存姢浼氫粠杩戞湡璁板繂涓鎵惧€欓€夛紝瀹夊叏鍏崇郴鍙互鑷姩寤鸿竟锛涚煕鐩俱€佸洜鏋溿€佹敮鎸佺瓑楂橀闄╁叧绯诲彧杩涘叆浜哄伐瀹℃牳浜嬩欢銆?/p><p><strong>M 璐熻矗鎷嗗潖杈癸細</strong>杩欓噷鍙垪鑷幆銆佽繛鎺ュ凡閫€鍑鸿蹇嗙殑鎮┖杈癸紝浠ュ強閲嶅鐨勫绉拌竟銆傛壒鍑嗗彧鍒犻櫎鍏崇郴杈癸紝涓嶅垹闄ゆ垨鏀瑰啓涓ょ璁板繂銆?/p><p><strong>瀹℃牳椤哄簭锛?/strong>鍏堢湅鈥滈棶棰樼被鍨嬧€濆拰鈥滃鏍稿缓璁€濓紝鍐嶆牳瀵?A/B 涓ょ姝ｆ枃锛涗俊鎭笉瓒冲氨閫夋嫨鈥滀繚鐣欒繖鏉¤竟鈥濄€?/p></div><form method="POST" action="/admin/memories/m-review/scan"><button class="btn" type="submit">閲嶆柊鎵弿寮傚父鍏崇郴</button></form></section>` : "";
  const metabolismBatchBar = input.tab === "m-review" ? `<form id="m-batch-form" class="card m-batch-bar" method="POST" action="/admin/memories/m-review/batch" onsubmit="return confirmMBatch(event)"><div><strong>鎵归噺瀹℃牳鍏崇郴杈?/strong><p>鍙鐞嗗嬀閫夌殑鍏崇郴杈癸紱杩囨湡椤圭洰褰掓。浠嶉渶閫愭潯瀹℃牳銆?/p></div><div class="m-batch-count">宸查€?<span id="m-batch-count">0</span> 鏉?/div><div class="m-batch-actions"><button class="small-btn" type="button" onclick="toggleMBatch(true)">鍏ㄩ€夊綋鍓嶉〉</button><button class="small-btn" type="button" onclick="toggleMBatch(false)">鍙栨秷閫夋嫨</button><button class="action-btn delete" data-batch-submit type="submit" name="decision" value="approve" disabled>鍙垹閫変腑鐨勮竟</button><button class="action-btn approve-review" data-batch-submit type="submit" name="decision" value="reject" disabled>淇濈暀閫変腑鐨勮竟</button></div></form>` : "";
  const diarySplitPreview = input.tab === "timeline" ? `<section class="card lmc-panel"><div class="header-row"><span class="section-title">鏃ヨ鎷嗗垎 v2</span><div class="divider"></div><span class="score-pill">鍙</span></div><div class="lmc-explain"><p><strong>璇曟媶鏈€杩?3 绡囷細</strong>鐢?Worker 鐩存帴璇诲彇 D1 骞惰皟鐢ㄥ皬妯″瀷锛屽彧灞曠ず閫氳繃鍘熸枃璇佹嵁鏍￠獙鐨勮崏绋裤€?/p><p><strong>涓嶄細鍙戠敓锛?/strong>涓嶄細鍒涘缓璁板繂銆佸鏍稿€欓€夈€佸叧绯昏竟鎴栧悜閲忋€?/p></div><form method="POST" action="/admin/memories/diary-split/preview"><button class="btn" type="submit">鍙璇曟媶鏈€杩?3 绡?/button></form></section>` : "";
  const composer = input.tab === "lmc5" || input.tab === "review" || input.tab === "x-review" || input.tab === "m-review" ? "" : renderComposer(input, renderBrowseTypeOptions(data.types, input.type));
  const quoteFilter = renderQuoteFilter(input, data.quoteCategories);
  const listBlock = input.tab === "lmc5" ? "" : `<div class="header-row"><span class="section-title">${htmlEscape(listTitle)}</span><div class="divider"></div><a class="small-btn" href="${adminPath(input, { page: 1, q: "", tag: "", date: "", category: "", mood: "", notice: "", searchMode: "keyword" })}">鍒锋柊</a></div>${list}${input.tab === "m-review" ? "" : renderPagination(input, data.total)}`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>鈾?/title><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;500&display=swap" rel="stylesheet"><style>${ADMIN_BOARD_CSS}</style></head><body><div class="page"><header><div class="heart">鈾?/div><h1>鎴戜滑鐨勮蹇嗗皬瀹?/h1><div class="subtitle">MEMORY HOME</div></header>${renderTabs(input)}${dashboard}${lmc5Dashboard}${calendar}${timelineReviewGuide}${metabolismReviewGuide}${metabolismBatchBar}${composer}${diarySplitPreview}${quoteFilter}${listBlock}</div><div class="toast" id="toast"></div><script>function updateMBatch(){const boxes=[...document.querySelectorAll('.m-batch-checkbox')];const count=boxes.filter(box=>box.checked).length;const label=document.getElementById('m-batch-count');if(label)label.textContent=String(count);document.querySelectorAll('[data-batch-submit]').forEach(button=>button.disabled=count===0)}function toggleMBatch(checked){document.querySelectorAll('.m-batch-checkbox').forEach(box=>{box.checked=checked});updateMBatch()}function confirmMBatch(event){const count=document.querySelectorAll('.m-batch-checkbox:checked').length;if(!count)return false;const deleting=event.submitter&&event.submitter.value==='approve';return confirm(deleting?('纭鍙垹闄ら€変腑鐨?'+count+' 鏉″叧绯昏竟锛烝銆丅 涓ょ璁板繂閮戒笉浼氭敼鍙樸€?):('纭淇濈暀閫変腑鐨?'+count+' 鏉″叧绯昏竟锛熻繖浜涙竻鐞嗗€欓€変細琚爣璁颁负宸叉嫆缁濄€?))}const n=${JSON.stringify(input.notice)};const m={created:'宸蹭繚瀛?鈾?,edited:'淇敼鎴愬姛 鈾?,deleted:'宸插垹闄?,approved:'宸插厑璁?,rejected:'宸叉嫆缁?,empty:'娌℃湁鍐呭',error:'淇濆瓨澶辫触','backfill-paused':'鍥炶ˉ宸叉殏鍋?,'backfill-resumed':'鍥炶ˉ宸茬户缁?,'x-scanned':'宸叉壂鎻忎笅涓€鎵规棫璁板繂','x-complete':'X 鏃堕棿杞村叏搴撴壂鎻忓畬鎴?,'x-approved':'鏃ユ湡鏍囩宸叉洿鏂?,'x-rejected':'宸叉嫆缁濓紝涓嶄細鍐嶆鍑虹幇','m-scanned':'M 浠ｈ阿宸℃瀹屾垚','m-approved':'M 浠ｈ阿鎿嶄綔宸叉墽琛?,'m-rejected':'宸插拷鐣ワ紝涓嶄細鍐嶆鍑虹幇','m-rolled-back':'宸叉寜蹇収鍥炴粴','m-batch-approved':'宸叉壒閲忓垹闄ら€変腑鐨勫叧绯昏竟','m-batch-rejected':'宸叉壒閲忎繚鐣欓€変腑鐨勫叧绯昏竟','m-batch-partial':'鎵归噺鎿嶄綔宸插畬鎴愶紝鍙樺寲椤瑰凡璺宠繃'};if(n&&m[n]){const t=document.getElementById('toast');t.textContent=m[n];t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);history.replaceState(null,'',location.pathname+location.search.replace(/[?&]notice=[^&]*/,''));}</script></body></html>`;
}


