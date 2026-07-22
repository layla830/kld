import type { MemoryCandidateRecord } from "../../db/memoryCandidates";
import { ADMIN_BOARD_ROUTES } from "./routes";
import { attr, htmlEscape, payloadOf } from "./utils";

function tagList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function pills(tags: string[]): string {
  return tags.length ? tags.map((tag) => `<span class="tag-pill">${htmlEscape(tag)}</span>`).join("") : '<span class="char-count">（没有标签）</span>';
}

export function renderTimelineCandidate(candidate: MemoryCandidateRecord): string {
  const payload = payloadOf(candidate.payload_json);
  const date = typeof payload.date === "string" ? payload.date : "";
  const repair = payload._kind === "timeline_date_repair";
  const dateOptions = tagList(payload.date_options);
  const before = tagList(payload.before_tags);
  const after = tagList(payload.tags);
  const available = candidate.target_status === "active" && Boolean(candidate.target_content);
  const dateControl = repair
    ? dateOptions.length > 0
      ? `<label><span>选择正确日期</span><select name="date" required>${dateOptions.map((option) => `<option value="${attr(option)}">${htmlEscape(option)}</option>`).join("")}</select></label>`
      : '<label><span>填写正确日期</span><input type="date" name="date" required></label>'
    : `<input type="hidden" name="date" value="${attr(date)}">`;
  const approve = available
    ? `<form method="POST" action="${ADMIN_BOARD_ROUTES.approveTimeline.path}" onsubmit="return confirm('只修正日期和 timeline 标签，正文与主题线都不会改变。确认吗？')"><input type="hidden" name="id" value="${attr(candidate.id)}">${dateControl}<button class="action-btn approve-review">${repair ? "确认修复日期" : "确认补日期"}</button></form>`
    : '<button class="action-btn" disabled>原记忆已不可用</button>';
  const effect = repair
    ? "移除旧的异常或多重 date 标签，只保留你确认的一个合法日期，并重建相邻时间边。"
    : `新增 <code>date:${htmlEscape(date)}</code> 和 <code>timeline</code> 标签，并按同一 thread + fact_key 的已批准日期重建相邻时间边；不改正文、不改 thread。`;
  return `<article class="memory-card review-card ${available ? "" : "muted"}"><div class="message-header"><strong>${repair ? "X 日期标签修复" : "X 时间轴日期更新"}</strong><span class="score-pill">${htmlEscape(date || dateOptions.join(" / ") || "待填写")}</span></div><div class="lmc-explain"><p><strong>批准后会发生什么：</strong>${effect}</p></div><div class="review-section-title">原记忆</div><div class="review-target-content">${htmlEscape(candidate.target_content || "（原记忆不存在）")}</div><section class="review-diff"><div class="review-section-title">标签更新前后</div><div class="review-diff-row"><div class="review-before"><strong>更新前</strong><div class="memory-meta">${pills(before)}</div></div><div class="review-arrow">→</div><div class="review-after"><strong>更新后</strong><div class="memory-meta">${pills(after)}</div></div></div></section><div class="memory-meta"><span class="score-pill">thread：${htmlEscape(payload.thread || "未标记")}</span><span class="score-pill">fact：${htmlEscape(payload.fact_key || "未标记")}</span></div><div class="actions review-actions">${approve}<form method="POST" action="${ADMIN_BOARD_ROUTES.rejectTimeline.path}" onsubmit="return confirm('拒绝后，这个日期建议不会在下次扫描时重新出现。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">拒绝，不更新</button></form></div><div class="char-count">${htmlEscape(candidate.target_id)} · ${htmlEscape(candidate.id)}</div></article>`;
}
