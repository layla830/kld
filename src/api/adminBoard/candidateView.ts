import type { MemoryCandidateRecord } from "../../db/memoryCandidates";
import { attr, htmlEscape } from "./utils";

function parse(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }
function pretty(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }

export function renderMemoryCandidate(candidate: MemoryCandidateRecord): string {
  const payload = parse(candidate.payload_json) as Record<string, unknown>;
  const chunks = parse(candidate.source_chunks_json);
  const sourceIds = parse(candidate.source_chunk_ids_json);
  const content = payload?.content ?? payload?.quote ?? payload?.reason ?? "（无正文）";
  const blocked = candidate.status !== "pending";
  const canApprove = !blocked && candidate.action !== "relation";
  const warning = candidate.validation_error
    ? `<div class="review-warning"><strong>自动拦截：</strong>${htmlEscape(candidate.validation_error)}</div>` : "";
  const approve = canApprove
    ? `<form method="POST" action="/admin/memories/candidates/approve" onsubmit="return confirm('确认执行这条候选吗？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">接受并执行</button></form>`
    : `<button class="action-btn" disabled>${candidate.action === "relation" ? "关系候选暂不执行" : "需先修正主体"}</button>`;
  return `<article class="memory-card review-card ${blocked ? "muted" : ""}"><div class="memory-meta"><span class="score-pill">VPS Candidate</span><span class="tag-pill">${htmlEscape(candidate.action)}</span><span class="tag-pill">主体 ${htmlEscape(candidate.subject || "未标记")}</span><span class="tag-pill">${htmlEscape(candidate.status)}</span></div><div class="message-content" style="white-space:pre-wrap">${htmlEscape(pretty(content))}</div>${warning}<details class="memory-detail"><summary>查看来源 chunk 与完整载荷</summary><div class="char-count">chunk ids: ${htmlEscape(pretty(sourceIds))}</div><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(pretty(chunks))}</pre><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(pretty(payload))}</pre></details><div class="actions review-actions">${approve}<form method="POST" action="/admin/memories/candidates/reject" onsubmit="return confirm('确认拒绝这条候选？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">拒绝</button></form></div><div class="char-count">candidate: ${htmlEscape(candidate.id)} · ${htmlEscape(candidate.dream_date)}</div></article>`;
}
