import type { MemoryCandidateRecord } from "../../db/memoryCandidates";
import { attr, htmlEscape } from "./utils";

function parse(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }
function pretty(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }

const ACTIONS: Record<string, { title: string; effect: string; approve: string }> = {
  add: { title: "建议新增记忆", effect: "接受后：新增一条长期记忆，不修改旧记忆。", approve: "接受并新增" },
  excerpt: { title: "建议保存关键原话", effect: "接受后：把这段原话保存成一条新的摘录记忆。", approve: "保存为新记忆" },
  update: { title: "建议更新已有记忆", effect: "接受后：用下方新内容修改指定的旧记忆。", approve: "确认更新旧记忆" },
  delete: { title: "建议删除已有记忆", effect: "接受后：软删除指定旧记忆，可以追溯，不会物理清空。", approve: "确认软删除" },
  relation: { title: "建议建立记忆关联", effect: "它只建议连接两条记忆，不会修改记忆正文；目前暂不支持执行。", approve: "暂不支持执行" }
};

const ERRORS: Record<string, string> = {
  ambiguous_pronoun: "正文中的‘我、你、她’指代不清，需要先改成人名或明确主体。",
  missing_or_invalid_subject: "没有判断清楚这是谁的记忆。",
  user_subject_prefix_mismatch: "标记为用户记忆，但正文没有明确写‘用户（Layla）’。",
  kld_subject_prefix_mismatch: "标记为 KLD 记忆，但正文没有明确写‘KLD’。",
  relationship_subjects_missing: "关系记忆没有同时明确写出用户（Layla）和 KLD。"
};

function comparison(candidate: MemoryCandidateRecord, content: unknown): string {
  if (candidate.action !== "update" && candidate.action !== "delete") return "";
  const before = candidate.target_content || "（没有找到旧记忆原文，请不要批准）";
  if (candidate.action === "delete") {
    return `<section class="review-target"><div class="review-section-title">将被软删除的旧记忆</div><div class="review-target-content">${htmlEscape(before)}</div></section>`;
  }
  return `<section class="review-diff"><div class="review-section-title">更新前后对照</div><div class="review-diff-row"><div class="review-before"><strong>更新前</strong><p>${htmlEscape(before)}</p></div><div class="review-arrow">→</div><div class="review-after"><strong>更新后</strong><p>${htmlEscape(pretty(content))}</p></div></div></section>`;
}

export function renderMemoryCandidate(candidate: MemoryCandidateRecord): string {
  const payload = parse(candidate.payload_json) as Record<string, unknown>;
  const chunks = parse(candidate.source_chunks_json);
  const sourceIds = parse(candidate.source_chunk_ids_json);
  const content = payload?._kind === "coordinate_backfill"
    ? { before: payload._before, proposed: Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith("_"))) }
    : payload?.content ?? payload?.quote ?? payload?.reason ?? "（没有候选正文）";
  const action = ACTIONS[candidate.action] || { title: "待审核候选", effect: "请核对内容和来源。", approve: "接受" };
  const blocked = candidate.status !== "pending";
  const canApprove = !blocked && candidate.action !== "relation" && (!(candidate.action === "update" || candidate.action === "delete") || Boolean(candidate.target_content));
  const subject = candidate.subject ? `<span class="tag-pill">主体：${htmlEscape(candidate.subject)}</span>` : "";
  const status = blocked ? '<span class="tag-pill">人称有问题，不能执行</span>' : '<span class="tag-pill">等待你决定</span>';
  const warning = candidate.validation_error
    ? `<div class="review-warning"><strong>为什么被拦截：</strong>${htmlEscape(ERRORS[candidate.validation_error] || candidate.validation_error)}</div>` : "";
  const approve = canApprove
    ? `<form method="POST" action="/admin/memories/candidates/approve" onsubmit="return confirm('${attr(action.effect)}')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">${htmlEscape(action.approve)}</button></form>`
    : `<button class="action-btn" disabled>${candidate.action === "relation" ? "关联功能尚未开放" : blocked ? "需先修正人称" : "找不到旧记忆，不能执行"}</button>`;
  return `<article class="memory-card review-card ${blocked ? "muted" : ""}"><div class="message-header"><strong>${htmlEscape(action.title)}</strong></div><div class="memory-meta"><span class="score-pill">来自 VPS Dream</span>${subject}${status}</div><div class="lmc-explain"><p><strong>这条会做什么：</strong>${htmlEscape(action.effect)}</p></div><div class="message-content" style="white-space:pre-wrap">${htmlEscape(pretty(content))}</div>${warning}${comparison(candidate, content)}<details class="memory-detail"><summary>为什么生成这条？查看来源对话摘要</summary><div class="char-count">来源片段：${htmlEscape(pretty(sourceIds))}</div><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(pretty(chunks))}</pre><details><summary>查看技术载荷</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(pretty(payload))}</pre></details></details><div class="actions review-actions">${approve}<form method="POST" action="/admin/memories/candidates/reject" onsubmit="return confirm('确认拒绝这条建议？不会修改任何记忆。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">拒绝，不做改动</button></form></div><div class="char-count">${htmlEscape(candidate.dream_date)} · ${htmlEscape(candidate.id)}</div></article>`;
}
