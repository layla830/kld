import { describe, expect, it } from "vitest";
import type { MemoryCandidateRecord } from "../src/db/memoryCandidates";
import {
  M_BATCH_SCRIPT,
  renderFactBatchBar,
  renderMBatchBar,
  renderQualityBatchBar
} from "../src/api/adminBoard/batchBars";
import { renderPageShell } from "../src/api/adminBoard/pageShell";
import {
  renderMetabolismReviewGuide,
  renderTimelineReviewGuide
} from "../src/api/adminBoard/reviewGuides";
import { renderPage } from "../src/api/adminBoard/view";
import { renderToastScriptContent, TOAST_TEXT } from "../src/api/adminBoard/viewToast";
import type { PageInput } from "../src/api/adminBoard/utils";

function candidate(action: string, status = "pending"): MemoryCandidateRecord {
  return {
    id: `cand_${action}`,
    namespace: "default",
    external_key: `test:${action}`,
    dream_date: "2026-07-19",
    action,
    subject: "system",
    target_id: "mem_target",
    payload_json: "{}",
    source_chunk_ids_json: "[]",
    source_chunks_json: "[]",
    status,
    validation_error: null,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    resolved_at: null,
    result_memory_id: null
  };
}

function pageInput(tab: string, notice = ""): PageInput {
  return {
    q: "",
    type: "",
    status: "active",
    page: 1,
    tab,
    tag: "",
    date: "",
    category: "",
    mood: "",
    notice,
    searchMode: "keyword"
  };
}

function pageData(overrides: Partial<Parameters<typeof renderPage>[1]> = {}): Parameters<typeof renderPage>[1] {
  return {
    stats: { active: 0, deleted: 0, total: 0, vectorized: 0 },
    types: [],
    quoteCategories: [],
    total: 0,
    records: [],
    candidates: [],
    resolvedCandidates: [],
    heatmap: [],
    timelineDates: new Set<string>(),
    lmc5: null,
    coordinateBackfill: null,
    timelineBackfill: null,
    operationalPending: 0,
    ...overrides
  };
}

describe("admin board view", () => {
  it("keeps the page shell structure and insertion order", () => {
    const html = renderPageShell({ bodyChildren: "<X/>", pageScript: "<script>Y</script>" });
    expect(html).toMatch(/^<!DOCTYPE html><html lang="zh-CN">/);
    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    expect(html).toContain('<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">');
    expect(html).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
    expect(html).toContain("<style>");
    expect(html.indexOf("<X/>")).toBeLessThan(html.indexOf('<div class="toast" id="toast"></div>'));
    expect(html.indexOf('<div class="toast" id="toast"></div>')).toBeLessThan(html.indexOf("<script>Y</script>"));
  });

  it("keeps toast codes and notice injection stable", () => {
    expect(TOAST_TEXT.created).toBe("已保存 ♡");
    expect(TOAST_TEXT["five-axis-retried"]).toBe("五维死信已重新入队");
    expect(TOAST_TEXT["x-approved"]).toBe("日期标签已更新");
    expect(TOAST_TEXT["y-relation-stale"]).toContain("关系候选已过期");
    expect(renderToastScriptContent("x-approved")).toContain('const n="x-approved"');
    expect(renderToastScriptContent(null)).toContain("const n=null");
    expect(renderToastScriptContent(undefined)).toContain("const n=undefined");
    expect(renderToastScriptContent("")).toContain("if(n&&m[n])");
  });

  it("renders each batch bar only for matching candidates", () => {
    expect(renderQualityBatchBar([])).toBe("");
    const quality = renderQualityBatchBar([candidate("add")]);
    expect(quality).toContain('action="/admin/memories/candidates/batch-quality-reject"');
    expect(quality).toContain("function updateQualityBatch()");
    expect(quality).toContain("确认拒绝选中的");

    expect(renderFactBatchBar([candidate("add")])).toBe("");
    const facts = renderFactBatchBar([candidate("diary_split_fact")]);
    expect(facts).toContain('action="/admin/memories/candidates/batch-facts"');
    expect(facts).toContain("function confirmFactBatch(event)");
    expect(facts).toContain("确认新增选中的");
    expect(facts).toContain("确认拒绝选中的");

    expect(renderMBatchBar([candidate("m_archive")])).toBe("");
    const metabolism = renderMBatchBar([candidate("m_relation_cleanup")]);
    expect(metabolism).toContain('action="/admin/memories/m-review/batch"');
    expect(metabolism).toContain("只删选中的边");
    expect(M_BATCH_SCRIPT).toContain("function updateMBatch()");
    expect(M_BATCH_SCRIPT).toContain("确认只删除选中的");
    expect(M_BATCH_SCRIPT).toContain("确认保留选中的");
  });

  it("renders review guides only in their owning tabs", () => {
    expect(renderTimelineReviewGuide({ show: false, pending: 4, status: null })).toBe("");
    const timeline = renderTimelineReviewGuide({
      show: true,
      pending: 4,
      status: {
        cursor: "mem_10",
        scanned: 25,
        dated: 7,
        ambiguous: 2,
        queued: 7,
        total: 100,
        complete: false,
        startedAt: "2026-07-19T00:00:00.000Z",
        lastRunAt: "2026-07-19T00:05:00.000Z"
      }
    });
    expect(timeline).toContain("4 条待审");
    expect(timeline).toContain("25%");
    expect(timeline).toContain("扫描下一批");

    expect(renderMetabolismReviewGuide(false, 3)).toBe("");
    const metabolism = renderMetabolismReviewGuide(true, 3);
    expect(metabolism).toContain("Z 事实状态 · Y 关系审核 · M 安全代谢");
    expect(metabolism).toContain("3 条待审");
  });

  it("preserves tab-owned section composition and page script placement", () => {
    const lmc5 = renderPage(pageInput("lmc5"), pageData());
    expect(lmc5).toContain("LMC-5 面板没有加载出来");
    expect(lmc5).not.toContain("这里还没有内容");

    const review = renderPage(
      pageInput("review"),
      pageData({ candidates: [candidate("add"), candidate("diary_split_fact")] })
    );
    expect(review.indexOf('id="quality-batch-form"')).toBeLessThan(review.indexOf('id="fact-batch-form"'));
    expect(review.indexOf('id="fact-batch-form"')).toBeLessThan(review.indexOf("<article"));

    const mReview = renderPage(
      pageInput("m-review", "m-scanned"),
      pageData({ candidates: [candidate("m_relation_cleanup")], operationalPending: 1 })
    );
    expect(mReview.indexOf("Z 事实状态 · Y 关系审核 · M 安全代谢")).toBeLessThan(mReview.indexOf('id="m-batch-form"'));
    expect(mReview.indexOf('id="m-batch-form"')).toBeLessThan(mReview.indexOf("<article"));
    expect(mReview).toContain(`<script>${M_BATCH_SCRIPT}const n="m-scanned"`);
  });
});
