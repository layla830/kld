import type { TimelineBackfillStatus } from "../../memory/timelineBackfill";
import { ADMIN_BOARD_ROUTES } from "./routes";

export function renderTimelineReviewGuide(input: {
  show: boolean;
  pending: number;
  status: TimelineBackfillStatus | null;
}): string {
  if (!input.show) return "";
  const progress = input.status && input.status.total > 0
    ? Math.min(100, Math.round((input.status.scanned / input.status.total) * 1000) / 10)
    : 0;
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">明确日期候选</span><div class="divider"></div><span class="score-pill">${input.pending} 条待审</span></div><div class="lmc-explain"><p>这里只收正文中唯一、完整的年月日。批准只补日期标签；拒绝会永久记住，不会反复出现。</p></div><div class="lmc-stat-grid"><div class="stat-item"><span class="stat-value">${input.status?.scanned ?? 0}</span><span class="stat-label">已扫描</span></div><div class="stat-item"><span class="stat-value">${input.status?.total ?? 0}</span><span class="stat-label">待扫描总量</span></div><div class="stat-item"><span class="stat-value">${progress}%</span><span class="stat-label">扫描进度</span></div><div class="stat-item"><span class="stat-value">${input.status?.dated ?? 0}</span><span class="stat-label">日期候选</span></div><div class="stat-item"><span class="stat-value">${input.status?.ambiguous ?? 0}</span><span class="stat-label">多日期跳过</span></div></div><form method="POST" action="${ADMIN_BOARD_ROUTES.scanTimeline.path}"><input type="hidden" name="reset" value="${input.status?.complete ? "true" : "false"}"><button class="btn" type="submit">${input.status?.complete ? "重新扫描全库" : input.status?.startedAt ? "扫描下一批" : "开始全库扫描"}</button></form></section>`;
}

export function renderMetabolismReviewGuide(show: boolean, pending: number): string {
  if (!show) return "";
  return `<section class="card lmc-panel"><div class="header-row"><span class="section-title">Z 事实状态 · Y 关系审核 · M 安全代谢</span><div class="divider"></div><span class="score-pill">${pending} 条待审</span></div><div class="lmc-explain"><p><strong>Z 负责事实状态：</strong>同一 fact_key 有多个 active 版本时，逐条建议保留最佳事实、取代较弱旧事实；批准前会重新核对两条记忆和当前排名。</p><p><strong>Y 负责风险关系：</strong>安全关系自动建边；矛盾、因果和支持关系进入人工审核，批准前重新核对两端记忆版本。</p><p><strong>M 负责安全代谢：</strong>过期项目、长期未召回的低信号记忆以及自环、悬空、重复关系均先生成可回滚候选。</p><p><strong>统一审核：</strong>Z/Y/M 共用同一套卡片、批准、拒绝和回滚端点；高风险动作不做批量批准。</p></div><form method="POST" action="${ADMIN_BOARD_ROUTES.scanOperationalReview.path}"><button class="btn" type="submit">重新扫描 Z/Y/M 候选</button></form></section>`;
}
