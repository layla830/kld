import type { DiarySplitPlan } from "../../memory/diarySplit";
import { ADMIN_BOARD_CSS } from "./styles";
import { htmlEscape } from "./utils";

function renderItem(item: DiarySplitPlan["items"][number]): string {
  return `<article class="memory-card review-card"><div class="message-header"><strong>${htmlEscape(item.type)}</strong><span class="tag-pill">${item.review_required ? "需要审核" : "可自动写入"}</span></div><div class="memory-meta"><span class="score-pill">${htmlEscape(item.temporal_scope)}</span>${item.fact_key ? `<span class="tag-pill">${htmlEscape(item.fact_key)}</span>` : ""}</div><div class="message-content">${htmlEscape(item.content)}</div><div class="review-warning"><strong>原文证据：</strong>${htmlEscape(item.evidence)}</div></article>`;
}

function renderPlan(plan: DiarySplitPlan): string {
  const items = plan.items.map(renderItem).join("");
  const status = plan.skipped ? htmlEscape(plan.reason || "已跳过") : `${plan.items.length} 条草稿`;
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">${htmlEscape(plan.date)}</span><div class="divider"></div><span class="score-pill">${status}</span></div><div class="char-count">原日记：${htmlEscape(plan.diary_id)}</div>${items || '<div class="empty">严格证据校验后没有留下可用条目</div>'}</section>`;
}

export function renderDiarySplitPreview(plans: DiarySplitPlan[], error?: string): string {
  const total = plans.reduce((sum, plan) => sum + plan.items.length, 0);
  const review = plans.reduce((sum, plan) => sum + plan.items.filter((item) => item.review_required).length, 0);
  const body = error
    ? `<section class="card"><div class="review-warning"><strong>试拆失败：</strong>${htmlEscape(error)}</div></section>`
    : plans.map(renderPlan).join("") || '<div class="empty">没有找到可试拆的日记</div>';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>日记试拆预览</title><meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"><style>${ADMIN_BOARD_CSS}</style></head><body><div class="page"><header><div class="heart">♡</div><h1>日记试拆预览</h1><div class="subtitle">READ ONLY · 不写入 D1</div></header><section class="card lmc-panel"><div class="header-row"><span class="section-title">最近 ${plans.length} 篇</span><div class="divider"></div><span class="score-pill">${total} 条草稿</span></div><div class="lmc-explain"><p><strong>本次影响：</strong>只调用拆分模型并展示结果，不创建记忆、候选、关系或向量。</p><p><strong>后续审核：</strong>${review} 条事实型草稿在正式执行时会进入审核，其余 ${Math.max(0, total - review)} 条才允许自动写入。</p></div><a class="small-btn" href="/admin/memories?tab=diary">返回交换日记</a></section>${body}</div></body></html>`;
}
