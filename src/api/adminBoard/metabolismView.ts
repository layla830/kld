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

function beforeOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.before && typeof payload.before === "object" ? payload.before as Record<string, unknown> : {};
}

function short(value: unknown, length = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function relationEndpointCard(label: string, id: string | null, content: string | null | undefined, type: string | null | undefined, status: string | null | undefined, activeFact: number | null | undefined): string {
  const state = status
    ? `${status}${activeFact === 0 ? " / 非 active_fact" : ""}`
    : "不存在或已被物理清理";
  const body = content
    ? htmlEscape(short(content, 260))
    : `<span class="tag-pill">找不到这条记忆正文</span>`;
  return `<div class="review-before"><strong>${htmlEscape(label)}</strong><div class="char-count">${htmlEscape(id || "未知 ID")} · ${htmlEscape(type || "unknown")} · ${htmlEscape(state)}</div><p>${body}</p></div>`;
}

function renderRelationEndpoints(candidate: MemoryCandidateRecord, before: Record<string, unknown>): string {
  const sourceId = readString(before, "source_memory_id");
  const targetId = readString(before, "target_memory_id");
  return `<section class="review-diff"><div class="review-section-title">这条关系连着哪两条记忆</div><div class="review-diff-row">${relationEndpointCard("起点记忆 source", sourceId, candidate.source_memory_content, candidate.source_memory_type, candidate.source_memory_status, candidate.source_memory_active_fact)}<div class="review-arrow">→</div>${relationEndpointCard("终点记忆 target", targetId, candidate.target_memory_content, candidate.target_memory_type, candidate.target_memory_status, candidate.target_memory_active_fact)}</div></section>`;
}

export function renderMetabolismCandidate(candidate: MemoryCandidateRecord): string {
  const payload = payloadOf(candidate.payload_json);
  const before = beforeOf(payload);
  const approved = candidate.status === "approved";
  const isArchive = candidate.action === "m_archive";
  const relationType = readString(before, "relation_type");
  const title = isArchive ? "M 代谢：建议归档过期项目状态" : "M 代谢：建议清理异常关系边";
  const effect = isArchive
    ? "批准后：状态从 active 变为 archived，退出召回；正文不改、不会物理删除，可以回滚。"
    : `批准后：只删除这一条${relationType ? ` ${relationType} ` : ""}关系边；两端记忆正文不变，可以按快照原样回滚。`;
  const beforeText = isArchive
    ? candidate.target_content || before.content || "（原记忆不存在，请不要批准）"
    : before;
  const afterText = isArchive
    ? { status: "archived", active_fact: false, content: "保持不变" }
    : { relation: "删除", memories: "保持不变" };
  const relationPreview = isArchive ? "" : renderRelationEndpoints(candidate, before);
  const actionButtons = approved
    ? `<form method="POST" action="/admin/memories/m-review/rollback" onsubmit="return confirm('按快照恢复这次 M 轴操作？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">回滚这次操作</button></form>`
    : `<form method="POST" action="/admin/memories/m-review/approve" onsubmit="return confirm('${attr(effect)}')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">${isArchive ? "确认归档" : "确认清理关系"}</button></form><form method="POST" action="/admin/memories/m-review/reject" onsubmit="return confirm('忽略这条建议？不会修改任何记忆。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">忽略，不处理</button></form>`;
  return `<article class="memory-card review-card"><div class="message-header"><strong>${title}</strong><span class="tag-pill">${approved ? "已执行，可回滚" : "等待审核"}</span></div><div class="lmc-explain"><p><strong>为什么出现：</strong>${htmlEscape(payload.reason || "巡检发现可代谢对象")}</p><p><strong>批准后：</strong>${htmlEscape(effect)}</p></div>${relationPreview}<section class="review-diff"><div class="review-section-title">操作前后对照</div><div class="review-diff-row"><div class="review-before"><strong>操作前</strong><p>${htmlEscape(short(beforeText))}</p></div><div class="review-arrow">→</div><div class="review-after"><strong>操作后</strong><p>${htmlEscape(short(afterText))}</p></div></div></section><details class="memory-detail"><summary>查看完整快照</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(JSON.stringify(before, null, 2))}</pre></details><div class="actions review-actions">${actionButtons}</div><div class="char-count">${htmlEscape(candidate.id)}</div></article>`;
}
