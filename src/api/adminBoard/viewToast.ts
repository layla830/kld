const TOAST_ENTRIES = [
  ["created", "已保存 ♡"],
  ["edited", "修改成功 ♡"],
  ["deleted", "已删除"],
  ["approved", "已允许"],
  ["rejected", "已拒绝"],
  ["empty", "没有内容"],
  ["error", "保存失败"],
  ["y-relation-stale", "关系候选已过期：两端记忆内容已更新，请拒绝旧候选并等待重新扫描"],
  ["timeline-invalid-date", "手填的日期无效，请检查日历"],
  ["timeline-stale", "候选已过期，请刷新后重审"],
  ["timeline-date-conflict", "这条记忆又有了新的 date 标签，请重审"],
  ["five-axis-retried", "五维死信已重新入队"],
  ["evidence-repaired", "逐字证据已通过校验，可以继续审核"],
  ["evidence-not_verbatim", "这段文字不在来源关键原话中"],
  ["evidence-too_long", "证据不能超过 80 字"],
  ["evidence-not_found", "候选不存在或已处理"],
  ["quality-batch-rejected", "已批量拒绝低质量候选"],
  ["quality-batch-partial", "已处理可拒绝项，其余已跳过"],
  ["backfill-paused", "回补已暂停"],
  ["backfill-resumed", "回补已继续"],
  ["x-scanned", "已扫描下一批旧记忆"],
  ["x-complete", "X 时间轴全库扫描完成"],
  ["x-approved", "日期标签已更新"],
  ["x-rejected", "已拒绝，不会再次出现"],
  ["m-scanned", "M 代谢巡检完成"],
  ["m-approved", "M 代谢操作已执行"],
  ["m-rejected", "已忽略，不会再次出现"],
  ["m-rolled-back", "已按快照回滚"],
  ["m-batch-approved", "已批量删除选中的关系边"],
  ["m-batch-rejected", "已批量保留选中的关系边"],
  ["m-batch-partial", "批量操作已完成，变化项已跳过"]
] as const;

export const TOAST_TEXT: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(TOAST_ENTRIES)
);

function singleQuotedScriptString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

const TOAST_MAP_SCRIPT = `{${TOAST_ENTRIES.map(([key, value]) => {
  const scriptKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : singleQuotedScriptString(key);
  return `${scriptKey}:${singleQuotedScriptString(value)}`;
}).join(",")}}`;

export function renderToastScriptContent(notice: string | null | undefined): string {
  return `document.querySelectorAll('.timeline-card .tl-timeline_day').forEach(b=>b.closest('.timeline-card')?.remove());const n=${JSON.stringify(notice)};const m=${TOAST_MAP_SCRIPT};if(n&&m[n]){const t=document.getElementById('toast');t.textContent=m[n];t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);history.replaceState(null,'',location.pathname+location.search.replace(/[?&]notice=[^&]*/,''));}`;
}
