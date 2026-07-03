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

const FIELD_LABELS: Record<string, string> = {
  content: "正文", summary: "摘要", type: "类型", fact_key: "事实槽", thread: "时间线",
  importance: "重要度", confidence: "可信度", risk_level: "风险", urgency_level: "紧急度",
  tension_score: "张力", response_posture: "回应姿态", valence: "情绪效价", arousal: "唤醒度", tags: "标签"
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "（空）";
  if (Array.isArray(value)) return value.join("、") || "（空）";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function targetValue(target: Record<string, unknown> | undefined, key: string): unknown {
  if (!target) return undefined;
  if (key in target) return target[key];
  return target[key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())];
}

function comparisonRows(target: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined): string {
  if (!patch || Object.keys(patch).length === 0) return '<div class="empty">没有可展示的字段变更</div>';
  return Object.entries(patch).filter(([key]) => key !== "target_id").map(([key, after]) => {
    const before = targetValue(target, key);
    const changed = displayValue(before) !== displayValue(after);
    return `<div class="review-diff-row ${changed ? "changed" : "unchanged"}" style="padding:10px 0;border-bottom:1px dashed rgba(232,160,176,.25)"><div class="review-field" style="font-size:.7rem;color:var(--pink-dark);font-weight:600;margin-bottom:6px">${htmlEscape(FIELD_LABELS[key] || key)}</div><div style="display:grid;grid-template-columns:minmax(0,1fr) 22px minmax(0,1fr);gap:7px;align-items:stretch"><div class="review-before" style="padding:9px;border-radius:8px;background:rgba(143,168,192,.1);min-width:0"><span style="display:block;font-size:.58rem;color:var(--text-light);margin-bottom:4px">修改前</span><p style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:.7rem;line-height:1.5">${htmlEscape(displayValue(before))}</p></div><div class="review-arrow" style="display:flex;align-items:center;justify-content:center;color:var(--text-light)">→</div><div class="review-after" style="padding:9px;border-radius:8px;background:rgba(232,160,176,.12);min-width:0"><span style="display:block;font-size:.58rem;color:var(--text-light);margin-bottom:4px">修改后</span><p style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:.7rem;line-height:1.5">${htmlEscape(displayValue(after))}</p></div></div></div>`;
  }).join("");
}

function targetCard(target: Record<string, unknown> | undefined, action: DreamReviewPayload["action"]): string {
  if (!target) return '<div class="review-warning">旧记录快照缺失。请先拒绝，不要在看不到原文时批准。</div>';
  const meta = [target.type ? `类型 ${displayValue(target.type)}` : "", target.fact_key ? `事实槽 ${displayValue(target.fact_key)}` : "", target.status ? `状态 ${displayValue(target.status)}` : ""]
    .filter(Boolean).map((item) => `<span class="tag-pill">${htmlEscape(item)}</span>`).join("");
  const title = action === "delete" ? "批准后将被软删除的原记录" : "当前原记录";
  return `<section class="review-target" style="margin:12px 0;padding:12px;border:1px solid rgba(143,168,192,.3);border-radius:11px;background:rgba(255,255,255,.62)"><div class="review-section-title" style="font-size:.72rem;color:var(--blue-dark);font-weight:600;margin-bottom:8px">${title}</div><div class="memory-meta">${meta}</div><div class="review-target-content" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:.82rem;line-height:1.65;max-height:360px;overflow:auto;padding:10px;border-radius:8px;background:var(--white)">${htmlEscape(displayValue(target.content))}</div></section>`;
}

export function renderDreamReviewMemory(record: MemoryRecord, liveTarget?: MemoryRecord | null): string {
  const review = parseReviewSummary(record);
  const targetSnapshot = liveTarget ? { ...review?.target, ...liveTarget } : review?.target;
  const tags = parseTags(record.tags).slice(0, 8).map((tag) => `<span class="tag-pill">${htmlEscape(tag)}</span>`).join("");
  const actionLabel = review?.action === "delete" ? "删除" : review?.action === "update" ? "更新" : "待审";
  const targetId = review?.target_id || "未知目标";
  const reason = review?.reason ? `<div class="lmc-explain"><p><strong>Dream 给出的理由：</strong>${htmlEscape(review.reason)}</p></div>` : '<div class="review-warning">Dream 没有提供修改理由。信息不足时建议拒绝。</div>';
  const target = targetCard(targetSnapshot, review?.action);
  const fields = review?.action === "update" ? `<section class="review-diff" style="margin:12px 0;padding:12px;border:1px solid rgba(232,160,176,.28);border-radius:11px;background:rgba(255,255,255,.62)"><div class="review-section-title" style="font-size:.72rem;color:var(--pink-dark);font-weight:600;margin-bottom:8px">逐字段对照</div>${comparisonRows(targetSnapshot, review.patch)}</section>` : "";
  const disabled = record.status !== "active" ? " disabled" : "";
  const approveText = review?.action === "delete" ? "允许删除" : "允许更新";
  const confirmation = review?.action === "delete" ? `确认软删除 ${targetId}？请先核对上方原文和删除理由。` : `确认把上方“修改后”内容写入 ${targetId}？`;
  const actions = record.status === "active"
    ? `<div class="actions review-actions"><form method="POST" action="/admin/memories/review/approve" onsubmit="return confirm('${attr(confirmation)}')"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn approve-review" type="submit"${disabled}>${approveText}</button></form><form method="POST" action="/admin/memories/review/reject" onsubmit="return confirm('确认拒绝这条提案？原记忆不会改变。')"><input type="hidden" name="id" value="${attr(record.id)}"><button class="action-btn delete" type="submit"${disabled}>拒绝并保留原记录</button></form></div>`
    : "";

  return `<article class="memory-card review-card ${review?.action === "delete" ? "review-delete" : "review-update"} ${record.status !== "active" ? "muted" : ""}"><div class="message-header"><span class="message-time">${htmlEscape(formatTime(record.created_at || record.updated_at))}</span><span class="review-action-label">${htmlEscape(actionLabel)}提案</span></div><div class="memory-meta"><span class="score-pill">Dream ${actionLabel}</span><span class="tag-pill">目标 ${htmlEscape(targetId)}</span>${review?.date ? `<span class="tag-pill">来源 ${htmlEscape(review.date)}</span>` : ""}${tags}</div><div class="review-proposal-summary">${htmlEscape(record.content)}</div>${reason}${target}${fields}<div class="char-count">proposal: ${htmlEscape(record.id)}</div>${actions}</article>`;
}

