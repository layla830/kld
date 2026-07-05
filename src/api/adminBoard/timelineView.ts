import type { MemoryCandidateRecord } from "../../db/memoryCandidates";
import { attr, htmlEscape } from "./utils";

function payloadOf(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function tagList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function pills(tags: string[]): string {
  return tags.length ? tags.map((tag) => `<span class="tag-pill">${htmlEscape(tag)}</span>`).join("") : '<span class="char-count">（没有标签）</span>';
}

export function renderTimelineCandidate(candidate: MemoryCandidateRecord): string {
  const payload = payloadOf(candidate.payload_json);
  const date = typeof payload.date === "string" ? payload.date : "";
  const before = tagList(payload.before_tags);
  const after = tagList(payload.tags);
  const available = candidate.target_status === "active" && Boolean(candidate.target_content);
  const approve = available
    ? `<form method="POST" action="/admin/memories/x-timeline/approve" onsubmit="return confirm('只给这条记忆补上日期和 timeline 标签，正文与主题线都不会改变。确认吗？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">确认补日期</button></form>`
    : '<button class="action-btn" disabled>原记忆已不可用</button>';
  return `<article class="memory-card review-card ${available ? "" : "muted"}"><div class="message-header"><strong>X 时间轴日期更新</strong><span class="score-pill">${htmlEscape(date)}</span></div><div class="lmc-explain"><p><strong>批准后会发生什么：</strong>只新增 <code>date:${htmlEscape(date)}</code> 和 <code>timeline</code> 标签；不改正文、不改 thread、不自动建关系边。</p></div><div class="review-section-title">原记忆</div><div class="review-target-content">${htmlEscape(candidate.target_content || "（原记忆不存在）")}</div><section class="review-diff"><div class="review-section-title">标签更新前后</div><div class="review-diff-row"><div class="review-before"><strong>更新前</strong><div class="memory-meta">${pills(before)}</div></div><div class="review-arrow">→</div><div class="review-after"><strong>更新后</strong><div class="memory-meta">${pills(after)}</div></div></div></section><div class="memory-meta"><span class="score-pill">thread：${htmlEscape(payload.thread || "未标记")}</span><span class="score-pill">fact：${htmlEscape(payload.fact_key || "未标记")}</span></div><div class="actions review-actions">${approve}<form method="POST" action="/admin/memories/x-timeline/reject" onsubmit="return confirm('拒绝后，这个日期建议不会在下次扫描时重新出现。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">拒绝，不更新</button></form></div><div class="char-count">${htmlEscape(candidate.target_id)} · ${htmlEscape(candidate.id)}</div></article>`;
}
