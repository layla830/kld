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

export function renderMetabolismCandidate(candidate: MemoryCandidateRecord): string {
  const payload = payloadOf(candidate.payload_json);
  const before = beforeOf(payload);
  const approved = candidate.status === "approved";
  const isArchive = candidate.action === "m_archive";
  const title = isArchive ? "M 代谢：建议归档过期项目状态" : "M 代谢：建议清理异常关系边";
  const effect = isArchive
    ? "批准后：状态从 active 变为 archived，退出召回；正文不改、不会物理删除，可以回滚。"
    : "批准后：只删除这一条异常关系边；两端记忆正文不变，可以按快照原样回滚。";
  const beforeText = isArchive
    ? candidate.target_content || before.content || "（原记忆不存在，请不要批准）"
    : before;
  const afterText = isArchive
    ? { status: "archived", active_fact: false, content: "保持不变" }
    : { relation: "删除", memories: "保持不变" };
  const actionButtons = approved
    ? `<form method="POST" action="/admin/memories/m-review/rollback" onsubmit="return confirm('按快照恢复这次 M 轴操作？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">回滚这次操作</button></form>`
    : `<form method="POST" action="/admin/memories/m-review/approve" onsubmit="return confirm('${attr(effect)}')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">${isArchive ? "确认归档" : "确认清理关系"}</button></form><form method="POST" action="/admin/memories/m-review/reject" onsubmit="return confirm('忽略这条建议？不会修改任何记忆。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">忽略，不处理</button></form>`;
  return `<article class="memory-card review-card"><div class="message-header"><strong>${title}</strong><span class="tag-pill">${approved ? "已执行，可回滚" : "等待审核"}</span></div><div class="lmc-explain"><p><strong>为什么出现：</strong>${htmlEscape(payload.reason || "巡检发现可代谢对象")}</p><p><strong>批准后：</strong>${htmlEscape(effect)}</p></div><section class="review-diff"><div class="review-section-title">操作前后对照</div><div class="review-diff-row"><div class="review-before"><strong>操作前</strong><p>${htmlEscape(short(beforeText))}</p></div><div class="review-arrow">→</div><div class="review-after"><strong>操作后</strong><p>${htmlEscape(short(afterText))}</p></div></div></section><details class="memory-detail"><summary>查看完整快照</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(JSON.stringify(before, null, 2))}</pre></details><div class="actions review-actions">${actionButtons}</div><div class="char-count">${htmlEscape(candidate.id)}</div></article>`;
}
