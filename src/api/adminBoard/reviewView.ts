import type { MemoryRecord } from "../../types";
import { attr, formatTime, htmlEscape, parseTags } from "./utils";

interface DreamReviewPayload {
  kind?: string;
  action?: "update" | "delete";
  target_id?: string;
  patch?: Record<string, unknown>;
  reason?: string;
  date?: string;
  target?: Record<string, unknown>;
}

function parseReviewSummary(record: MemoryRecord): DreamReviewPayload | null {
  if (!record.summary) return null;
  try {
    const parsed = JSON.parse(record.summary) as DreamReviewPayload;
    return parsed.kind === "dream_review" ? parsed : null;
  } catch {
    return null;
  }
}

function fieldRows(patch: Record<string, unknown> | undefined): string {
  if (!patch || Object.keys(patch).length === 0) return '<div class="empty">没有可展示的字段变更</div>';
  return Object.entries(patch)
    .filter(([key]) => key !== "target_id")
    .map(([key, value]) => `<div class="lmc-duplicate"><span>${htmlEscape(key)}</span><span>${htmlEscape(typeof value === "string" ? value : JSON.stringify(value))}</span></div>`)
    .join("");
}

export function renderDreamReviewMemory(record: MemoryRecord): string {
  const review = parseReviewSummary(record);
  const tags = parseTags(record.tags).slice(0, 8).map((tag) => `<span class="tag-pill">${htmlEscape(tag)}</span>`).join("");
  const actionLabel = review?.action === "delete" ? "删除" : review?.action === "update" ? "更新" : "待审";
  const targetId = review?.target_id || "未知目标";
  const reason = review?.reason ? `<div class="lmc-explain"><p><strong>理由：</strong>${htmlEscape(review.reason)}</p></div>` : "";
  const fields = review?.action === "update" ? `<details class="memory-detail" open><summary>建议改动</summary><div class="lmc-duplicates">${fieldRows(review.patch)}</div></details>` : "";
  const disabled = record.status !== "active" ? " disabled" : "";
  const approveText = review?.action === "delete" ? "允许删除" : "允许更新";
  const actions = record.status === "active"
    ? `<div class="actions"><form method="POST" action="/admin/memories/review/approve" onsubmit="return confirm('确认执行这条 Dream 提案吗？')"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn" type="submit"${disabled}>${approveText}</button></form><form method="POST" action="/admin/memories/review/reject"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn delete" type="submit"${disabled}>拒绝</button></form></div>`
    : "";

  return `<article class="memory-card ${record.status !== "active" ? "muted" : ""}"><div class="message-header"><span class="message-time">${htmlEscape(formatTime(record.created_at || record.updated_at))}</span></div><div class="memory-meta"><span class="score-pill">Dream ${actionLabel}</span><span class="tag-pill">${htmlEscape(targetId)}</span>${tags}</div><div class="message-content">${htmlEscape(record.content)}</div>${reason}${fields}<div class="char-count">proposal: ${htmlEscape(record.id)}</div>${actions}</article>`;
}
