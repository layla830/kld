import type { MemoryCandidateRecord } from "../../db/memoryCandidates";
import { isFiveAxisMemoryTypeEligible } from "../../memory/fiveAxis/eligibility";
import { RECALL_EXCLUDED_TYPES } from "../../recall/outputPolicy";
import { attr, htmlEscape, payloadOf } from "./utils";

interface RelationTypeInfo {
  label: string;
  meaning: string;
  direction: "对称关系" | "有向关系";
}

interface RelationIssue {
  label: string;
  explanation: string;
  recommendation: string;
  code: "self_loop" | "missing_endpoint" | "inactive_endpoint" | "symmetric_duplicate" | "unknown";
}

const RELATION_TYPES: Record<string, RelationTypeInfo> = {
  same_issue: { label: "同一问题", meaning: "两条记忆在处理同一个问题", direction: "对称关系" },
  same_project: { label: "同一项目", meaning: "两条记忆属于同一个项目", direction: "对称关系" },
  same_tool: { label: "同一工具", meaning: "两条记忆涉及同一个工具", direction: "对称关系" },
  same_event: { label: "同一事件", meaning: "两条记忆描述同一件具体事件", direction: "对称关系" },
  same_topic: { label: "同一话题", meaning: "两条记忆主题相同，但不一定是同一事件", direction: "对称关系" },
  temporal_sequence: { label: "时间先后", meaning: "起点记忆发生在前，终点记忆是后续", direction: "有向关系" },
  emotional_link: { label: "情绪关联", meaning: "两条记忆共享相近的情绪体验", direction: "对称关系" },
  in_thread: { label: "同一主题线", meaning: "两条记忆属于同一条长期主题线", direction: "对称关系" },
  same_person: { label: "同一人物", meaning: "两条记忆涉及同一个人", direction: "对称关系" },
  in_episode: { label: "同一经历", meaning: "两条记忆属于同一段经历", direction: "对称关系" },
  instance_of: { label: "实例归属", meaning: "起点记忆是终点概念的一个具体实例", direction: "有向关系" },
  derived_from: { label: "由此提炼", meaning: "终点记忆由起点记忆提炼或演化而来", direction: "有向关系" },
  same_fact_key: { label: "同一事实槽", meaning: "两条记忆是同一事实的不同记录", direction: "对称关系" },
  origin_split: { label: "同源拆分", meaning: "两条记忆来自同一条原始记录的拆分", direction: "对称关系" }
};

Object.assign(RELATION_TYPES, {
  contradicts: { label: "相互矛盾", meaning: "两条记忆对同一事实给出了不兼容的描述", direction: "对称关系" },
  cause_effect: { label: "因果关系", meaning: "起点记忆描述原因，终点记忆描述结果", direction: "有向关系" },
  supports: { label: "支持关系", meaning: "起点记忆为终点记忆提供证据或支撑", direction: "有向关系" }
} satisfies Record<string, RelationTypeInfo>);

function beforeOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.before && typeof payload.before === "object" ? payload.before as Record<string, unknown> : {};
}

function short(value: unknown, length = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isLiveStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "review";
}

function relationTypeInfo(type: string | null): RelationTypeInfo {
  if (type && RELATION_TYPES[type]) return RELATION_TYPES[type];
  return {
    label: type || "未知关系",
    meaning: "页面没有这类关系的中文说明，请先保留并查看完整快照",
    direction: "有向关系"
  };
}

function relationIssue(candidate: MemoryCandidateRecord, before: Record<string, unknown>, rawReason: string | null): RelationIssue {
  const sourceId = readString(before, "source_memory_id");
  const targetId = readString(before, "target_memory_id");
  const reason = rawReason?.toLowerCase() || "";
  if ((sourceId && targetId && sourceId === targetId) || reason.includes("self-loop")) {
    return {
      code: "self_loop",
      label: "自环关系",
      explanation: "这条边把一条记忆连回了它自己，没有提供额外信息。",
      recommendation: "建议批准清理。只删这条自环边，记忆正文不变。"
    };
  }

  const missing: string[] = [];
  if (!candidate.source_memory_content || !candidate.source_memory_status) missing.push("起点记忆");
  if (!candidate.target_memory_content || !candidate.target_memory_status) missing.push("终点记忆");
  if (missing.length > 0) {
    return {
      code: "missing_endpoint",
      label: "悬空关系",
      explanation: `${missing.join("和")}已经不存在，关系边失去了可连接的对象。`,
      recommendation: "建议批准清理。不存在的记忆不会因这次操作发生任何变化。"
    };
  }

  const inactive: string[] = [];
  if (!isLiveStatus(candidate.source_memory_status)) inactive.push(`起点是 ${candidate.source_memory_status}`);
  if (!isLiveStatus(candidate.target_memory_status)) inactive.push(`终点是 ${candidate.target_memory_status}`);
  if (inactive.length > 0) {
    return {
      code: "inactive_endpoint",
      label: "失效端点",
      explanation: `${inactive.join("，")}；该端点已经退出正常召回，旧关系不再参与 Y 轴检索。`,
      recommendation: "通常可以批准清理。批准只删边，不会删除或改写两端记忆。"
    };
  }

  if (reason.includes("对称") || reason.includes("symmetric") || reason.includes("a→b")) {
    return {
      code: "symmetric_duplicate",
      label: "对称重复",
      explanation: "同一种对称关系同时保存了 A→B 和 B→A；Y 轴只需要保留其中一条。",
      recommendation: "建议批准清理重复方向。两条记忆仍会通过保留的那条边互相关联。"
    };
  }

  return {
    code: "unknown",
    label: "原因待确认",
    explanation: "当前快照不足以自动判断它属于哪种异常关系。",
    recommendation: "建议先保留，不要批准；展开完整快照后再判断。"
  };
}

export function relationEndpointState(
  type: string | null | undefined,
  status: string | null | undefined,
  activeFact: number | null | undefined
): string {
  if (!status) return "不存在";
  if (status === "review") return "审核中，仍视为可连接";
  if (status !== "active") return `${status}，已退出正常召回`;
  if (activeFact === 0) return "active，但不是当前事实";
  const normalizedType = type?.trim().toLowerCase() ?? "";
  if (RECALL_EXCLUDED_TYPES.has(normalizedType) || !isFiveAxisMemoryTypeEligible(normalizedType)) {
    return `active，但 ${type || "该类型"} 原文不参与正常召回或 Y 建边`;
  }
  return "active，正常参与召回";
}

function relationEndpointCard(
  label: string,
  id: string | null,
  content: string | null | undefined,
  type: string | null | undefined,
  status: string | null | undefined,
  activeFact: number | null | undefined
): string {
  const body = content
    ? htmlEscape(short(content, 320))
    : '<span class="review-warning">找不到这条记忆正文</span>';
  return `<div class="review-before"><strong>${htmlEscape(label)}</strong><div class="memory-meta"><span class="score-pill">${htmlEscape(type || "unknown")}</span><span class="tag-pill">${htmlEscape(relationEndpointState(type, status, activeFact))}</span></div><p>${body}</p><div class="char-count">ID：${htmlEscape(id || "未知")}</div></div>`;
}

function renderRelationEndpoints(candidate: MemoryCandidateRecord, before: Record<string, unknown>): string {
  const sourceId = readString(before, "source_memory_id");
  const targetId = readString(before, "target_memory_id");
  return `<section class="review-diff"><div class="review-section-title">这条边连接的两条记忆</div><div class="review-diff-row">${relationEndpointCard("A · 起点记忆", sourceId, candidate.source_memory_content, candidate.source_memory_type, candidate.source_memory_status, candidate.source_memory_active_fact)}<div class="review-arrow">→</div>${relationEndpointCard("B · 终点记忆", targetId, candidate.target_memory_content, candidate.target_memory_type, candidate.target_memory_status, candidate.target_memory_active_fact)}</div></section>`;
}

function renderArchiveCandidate(candidate: MemoryCandidateRecord, payload: Record<string, unknown>, before: Record<string, unknown>, approved: boolean): string {
  const effect = "状态从 active 变为 archived，退出默认召回；正文不改、不会物理删除，并且可以回滚。";
  const beforeText = candidate.target_content || before.content || "（原记忆不存在，请不要批准）";
  const actionButtons = approved
    ? `<form method="POST" action="/admin/memories/m-review/rollback" onsubmit="return confirm('按快照恢复这次 M 轴操作？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">回滚这次操作</button></form>`
    : `<form method="POST" action="/admin/memories/m-review/approve" onsubmit="return confirm('${attr(effect)}')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">确认归档</button></form><form method="POST" action="/admin/memories/m-review/reject" onsubmit="return confirm('保留这条记忆，不做归档？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">保留，不归档</button></form>`;
  return `<article class="memory-card review-card"><div class="message-header"><strong>M 代谢 · 过期项目状态</strong><span class="tag-pill">${approved ? "已执行，可回滚" : "等待审核"}</span></div><div class="lmc-explain"><p><strong>为什么出现：</strong>${htmlEscape(readString(payload, "reason") || "项目状态已经超过 expires_at")}</p><p><strong>批准影响：</strong>${htmlEscape(effect)}</p></div><div class="review-section-title">原记忆正文</div><div class="review-target-content">${htmlEscape(short(beforeText))}</div><div class="actions review-actions">${actionButtons}</div><div class="char-count">candidate：${htmlEscape(candidate.id)}</div></article>`;
}

function renderRelationCandidate(candidate: MemoryCandidateRecord, payload: Record<string, unknown>, before: Record<string, unknown>, approved: boolean): string {
  const relationType = readString(before, "relation_type");
  const typeInfo = relationTypeInfo(relationType);
  const rawReason = readString(payload, "reason");
  const issue = relationIssue(candidate, before, rawReason);
  const strength = readNumber(before, "strength");
  const effect = `只删除这条${relationType ? ` ${relationType} ` : ""}关系边；A、B 两端记忆正文都不会改变。`;
  const batchSelector = candidate.status === "pending"
    ? `<label class="m-batch-select"><input class="m-batch-checkbox" form="m-batch-form" type="checkbox" name="id" value="${attr(candidate.id)}" onchange="updateMBatch()"> 加入批量</label>`
    : "";
  const actionButtons = approved
    ? `<form method="POST" action="/admin/memories/m-review/rollback" onsubmit="return confirm('按快照恢复这条关系边？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">恢复这条边</button></form>`
    : `<form method="POST" action="/admin/memories/m-review/approve" onsubmit="return confirm('${attr(effect)}')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">只删这条边</button></form><form method="POST" action="/admin/memories/m-review/reject" onsubmit="return confirm('保留这条关系边？不会修改两端记忆。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">保留这条边</button></form>`;

  return `<article class="memory-card review-card ${issue.code === "unknown" ? "muted" : ""}"><div class="message-header"><strong>Y 关系清理 · M 巡检</strong><div class="m-review-status">${batchSelector}<span class="tag-pill">${approved ? "已执行，可回滚" : "等待审核"}</span></div></div><div class="memory-meta"><span class="score-pill">问题类型：${htmlEscape(issue.label)}</span><span class="score-pill">关系：${htmlEscape(typeInfo.label)}</span><span class="tag-pill">${htmlEscape(typeInfo.direction)}</span>${strength === null ? "" : `<span class="tag-pill">强度 ${strength.toFixed(2)}</span>`}</div><div class="lmc-explain"><p><strong>这条线表示：</strong>${htmlEscape(typeInfo.meaning)}</p><p><strong>为什么建议删：</strong>${htmlEscape(issue.explanation)}</p><p><strong>审核建议：</strong>${htmlEscape(issue.recommendation)}</p><p><strong>批准影响：</strong>${htmlEscape(effect)}</p></div>${renderRelationEndpoints(candidate, before)}<section class="review-diff"><div class="review-section-title">批准前后</div><div class="review-diff-row"><div class="review-before"><strong>批准前</strong><p>A 和 B 之间保存着这条关系边。</p></div><div class="review-arrow">→</div><div class="review-after"><strong>批准后</strong><p>只移除这条边；A、B 两条记忆仍原样保留。</p></div></div></section><details class="memory-detail"><summary>查看技术快照与巡检原始原因</summary><p class="char-count">${htmlEscape(rawReason || "没有原始原因")}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(JSON.stringify(before, null, 2))}</pre></details><div class="actions review-actions">${actionButtons}</div><div class="char-count">relation：${htmlEscape(readString(before, "id") || "未知")} · candidate：${htmlEscape(candidate.id)}</div></article>`;
}

function renderRelationReviewCandidate(
  candidate: MemoryCandidateRecord,
  payload: Record<string, unknown>,
  approved: boolean
): string {
  const relationType = readString(payload, "relation_type");
  const typeInfo = relationTypeInfo(relationType);
  const strength = readNumber(payload, "strength");
  const relation = {
    source_memory_id: readString(payload, "source_id"),
    target_memory_id: readString(payload, "target_id"),
    relation_type: relationType,
    strength,
    reason: readString(payload, "reason")
  };
  const effect = `新增一条 ${relationType || "待确认"} 关系边；两端记忆正文和状态都不会改变。`;
  const actionButtons = approved
    ? `<form method="POST" action="/admin/memories/m-review/rollback" onsubmit="return confirm('撤销这次关系批准？只会移除本次新建的边。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">回滚这次建边</button></form>`
    : `<form method="POST" action="/admin/memories/m-review/approve" onsubmit="return confirm('${attr(effect)}')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">批准建立关系</button></form><form method="POST" action="/admin/memories/m-review/reject" onsubmit="return confirm('拒绝这条关系建议？不会修改任何记忆。')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">拒绝关系</button></form>`;
  return `<article class="memory-card review-card"><div class="message-header"><strong>Y 关系判断 · 人工审核</strong><span class="tag-pill">${approved ? "已批准，可回滚" : "等待审核"}</span></div><div class="memory-meta"><span class="score-pill">关系：${htmlEscape(typeInfo.label)}</span><span class="tag-pill">${htmlEscape(typeInfo.direction)}</span>${strength === null ? "" : `<span class="tag-pill">强度 ${strength.toFixed(2)}</span>`}</div><div class="lmc-explain"><p><strong>模型判断：</strong>${htmlEscape(typeInfo.meaning)}</p><p><strong>理由：</strong>${htmlEscape(readString(payload, "reason") || "没有提供额外理由")}</p><p><strong>批准影响：</strong>${htmlEscape(effect)}</p></div>${renderRelationEndpoints(candidate, relation)}<details class="memory-detail"><summary>查看技术载荷</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(JSON.stringify(payload, null, 2))}</pre></details><div class="actions review-actions">${actionButtons}</div><div class="char-count">candidate：${htmlEscape(candidate.id)}</div></article>`;
}

function renderFactMemory(label: string, value: unknown, state: string): string {
  const memory = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const importance = readNumber(memory, "importance");
  const confidence = readNumber(memory, "confidence");
  return `<div class="review-before"><strong>${htmlEscape(label)}</strong><div class="memory-meta"><span class="score-pill">${htmlEscape(readString(memory, "type") || "unknown")}</span><span class="tag-pill">${htmlEscape(state)}</span>${importance === null ? "" : `<span class="tag-pill">重要度 ${importance.toFixed(2)}</span>`}${confidence === null ? "" : `<span class="tag-pill">置信度 ${confidence.toFixed(2)}</span>`}</div><p>${htmlEscape(short(readString(memory, "content") || "（正文缺失）", 420))}</p><div class="char-count">ID：${htmlEscape(readString(memory, "id") || "未知")}</div></div>`;
}

function renderFactTransitionCandidate(candidate: MemoryCandidateRecord, payload: Record<string, unknown>, approved: boolean): string {
  const factKey = readString(payload, "fact_key") || "未标记";
  const best = payload.best;
  const weaker = payload.weaker;
  const effect = "保留上方事实为 active；下方较弱版本改为 superseded 并退出召回。两条正文都不会被删除。";
  const actionButtons = approved
    ? `<form method="POST" action="/admin/memories/m-review/rollback" onsubmit="return confirm('恢复被取代的旧事实，让它重新参与召回？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">回滚这次取代</button></form>`
    : `<form method="POST" action="/admin/memories/m-review/approve" onsubmit="return confirm('${attr(effect)}')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn approve-review">确认取代旧事实</button></form><form method="POST" action="/admin/memories/m-review/reject" onsubmit="return confirm('保留两条 active 事实，不执行取代？')"><input type="hidden" name="id" value="${attr(candidate.id)}"><button class="action-btn delete">两条都保留</button></form>`;
  return `<article class="memory-card review-card"><div class="message-header"><strong>Z 事实状态 · 取代候选</strong><span class="tag-pill">${approved ? "已执行，可回滚" : "等待审核"}</span></div><div class="memory-meta"><span class="score-pill">fact：${htmlEscape(factKey)}</span></div><div class="lmc-explain"><p><strong>为什么出现：</strong>${htmlEscape(readString(payload, "reason") || "同一事实槽存在多个 active 版本")}</p><p><strong>批准影响：</strong>${htmlEscape(effect)}</p></div><section class="review-diff"><div class="review-section-title">核对保留版本与被取代版本</div><div class="review-diff-row">${renderFactMemory("保留 · 当前最佳事实", best, "继续 active")}<div class="review-arrow">→</div>${renderFactMemory("取代 · 较弱旧事实", weaker, approved ? "当前 superseded" : "将变为 superseded")}</div></section><section class="review-diff"><div class="review-section-title">批准前后</div><div class="review-diff-row"><div class="review-before"><strong>批准前</strong><p>两条记忆都以 active 状态参与召回，可能互相冲突。</p></div><div class="review-arrow">→</div><div class="review-after"><strong>批准后</strong><p>只保留最佳版本参与召回；旧版本保留正文和审计记录，可从这里回滚。</p></div></div></section><details class="memory-detail"><summary>查看 Z proposal 技术快照</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${htmlEscape(JSON.stringify(payload, null, 2))}</pre></details><div class="actions review-actions">${actionButtons}</div><div class="char-count">candidate：${htmlEscape(candidate.id)}</div></article>`;
}

export function renderMetabolismCandidate(candidate: MemoryCandidateRecord): string {
  const payload = payloadOf(candidate.payload_json);
  const before = beforeOf(payload);
  const approved = candidate.status === "approved";
  if (candidate.action === "z_supersede") return renderFactTransitionCandidate(candidate, payload, approved);
  if (candidate.action === "y_relation_review") return renderRelationReviewCandidate(candidate, payload, approved);
  return candidate.action === "m_archive"
    ? renderArchiveCandidate(candidate, payload, before, approved)
    : renderRelationCandidate(candidate, payload, before, approved);
}

export const renderOperationalReviewCandidate = renderMetabolismCandidate;
