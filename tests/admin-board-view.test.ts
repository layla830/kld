import { describe, expect, it } from "vitest";
import type { MemoryCandidateRecord } from "../src/db/memoryCandidates";
import type { MemoryRecord } from "../src/types";
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
import { ADMIN_BOARD_POST_ROUTES } from "../src/api/adminBoard/routes";
import { renderPage } from "../src/api/adminBoard/view";
import { renderToastScriptContent, TOAST_TEXT } from "../src/api/adminBoard/viewToast";
import type { PageInput } from "../src/api/adminBoard/utils";

function candidate(
  action: string,
  status = "pending",
  overrides: Partial<MemoryCandidateRecord> = {}
): MemoryCandidateRecord {
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
    result_memory_id: null,
    ...overrides
  };
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_test",
    namespace: "default",
    type: "note",
    content: "test memory",
    summary: null,
    fact_key: null,
    active_fact: 1,
    thread: null,
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: 0.5,
    confidence: 0.8,
    status: "active",
    pinned: 0,
    tags: null,
    source: null,
    source_message_ids: null,
    vector_id: null,
    vector_synced: 0,
    last_recalled_at: null,
    recall_count: 0,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    expires_at: null,
    ...overrides
  };
}

function postFormActions(html: string): string[] {
  return [...html.matchAll(/<form\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((form) => /\bmethod="POST"/i.test(form))
    .map((form) => form.match(/\baction="([^"]+)"/i)?.[1])
    .filter((action): action is string => Boolean(action));
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
    expect(Object.keys(TOAST_TEXT)).toHaveLength(31);
    expect(renderToastScriptContent("x-approved")).toContain('const n="x-approved"');
    expect(renderToastScriptContent(null)).toContain("const n=null");
    expect(renderToastScriptContent(undefined)).toContain("const n=undefined");
    expect(renderToastScriptContent("")).toContain("if(n&&m[n])");
    expect(renderToastScriptContent("")).not.toContain("tl-timeline_day");
    expect(renderToastScriptContent("")).not.toContain("remove()");
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

    const xReview = renderPage(
      pageInput("x-review"),
      pageData({ total: 4 })
    );
    expect(xReview).toContain("明确日期候选");
    expect(xReview.indexOf("明确日期候选")).toBeLessThan(xReview.indexOf("X 时间轴审核"));

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
    expect(mReview).toContain(`<script>${M_BATCH_SCRIPT}${renderToastScriptContent("m-scanned")}</script>`);
  });

  it("keeps rendered POST form actions bidirectionally aligned with the route registry", () => {
    const reviewCandidates = [
      candidate("add", "pending", { payload_json: JSON.stringify({ content: "A durable memory" }) }),
      candidate("diary_split_fact", "pending", {
        payload_json: JSON.stringify({ content: "A dated fact", evidence: "verbatim evidence" })
      }),
      candidate("diary_split_fact", "pending", {
        id: "cand_evidence_repair",
        validation_error: "missing_evidence",
        source_chunks_json: JSON.stringify([{ important_quotes: ["verbatim evidence"] }])
      })
    ];
    const dreamReview = memoryRecord({
      id: "review_test",
      type: "dream_review",
      content: "Update proposal",
      summary: JSON.stringify({
        kind: "dream_review",
        action: "update",
        target_id: "mem_target",
        patch: { content: "updated memory" },
        target: { id: "mem_target", type: "note", status: "active", content: "old memory" }
      })
    });
    const timelineCandidate = candidate("timeline_date", "pending", {
      id: "cand_timeline",
      target_status: "active",
      target_content: "timeline memory",
      payload_json: JSON.stringify({
        date: "2026-07-19",
        before_tags: [],
        tags: ["date:2026-07-19", "timeline"]
      })
    });
    const relationCandidate = candidate("m_relation_cleanup", "pending", {
      id: "cand_relation_cleanup",
      payload_json: JSON.stringify({
        before: {
          id: "rel_test",
          source_memory_id: "mem_source",
          target_memory_id: "mem_target",
          relation_type: "same_issue",
          strength: 0.7
        },
        reason: "duplicate relation"
      })
    });
    const resolvedArchiveCandidate = candidate("m_archive", "approved", {
      id: "cand_archive_approved",
      target_content: "archived memory",
      payload_json: JSON.stringify({ before: { content: "archived memory" } })
    });
    const lmc5Data: NonNullable<Parameters<typeof renderPage>[1]["lmc5"]> = {
      stats: { active: 1, eAxis: 0, factKeyed: 0, relations: 0, reviewCandidates: 0 },
      eAxisObservability: {
        state: {
          configured: false,
          startedAt: null,
          shadowDays: 7,
          rankingEnabled: false,
          readyForPromotion: false,
          inShadow: true,
          daysElapsed: 0,
          daysRemaining: 7
        },
        windowDays: 7,
        samples: 0,
        changedQueries: 0,
        changedRate: 0,
        averageBoosted: 0,
        recent: []
      },
      relationTypes: [],
      clusters: [],
      highValueNodes: [],
      reviewQueue: [],
      duplicateFactKeys: [],
      deadLetters: [{
        id: 1,
        namespace: "default",
        memory_id: "mem_dead_letter",
        memory_updated_at: "2026-07-19T00:00:00.000Z",
        memory_revision: 1,
        status: "dead_letter",
        attempts: 5,
        queued_at: null,
        completed_at: "2026-07-19T00:00:00.000Z",
        last_error: "test failure",
        result_json: null,
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z"
      }]
    };

    const renderedPages = [
      renderPage(pageInput("message"), pageData({ records: [memoryRecord()] })),
      renderPage(pageInput("review"), pageData({ records: [dreamReview], candidates: reviewCandidates })),
      renderPage(pageInput("x-review"), pageData({ candidates: [timelineCandidate] })),
      renderPage(pageInput("m-review"), pageData({
        candidates: [relationCandidate],
        resolvedCandidates: [resolvedArchiveCandidate],
        operationalPending: 1
      })),
      renderPage(pageInput("lmc5"), pageData({
        lmc5: lmc5Data,
        coordinateBackfill: {
          enabled: true,
          lastRunAt: null,
          lastResult: null,
          cursor: null,
          totalActive: 1,
          completed: 0,
          remaining: 1,
          progressPercent: 0,
          estimatedMinutes: 1,
          pendingReview: 0
        }
      }))
    ];
    const renderedActions = new Set<string>(renderedPages.flatMap(postFormActions));
    const registeredActions = new Set<string>(ADMIN_BOARD_POST_ROUTES.map((route) => route.path));

    expect([...renderedActions].filter((action) => !registeredActions.has(action))).toEqual([]);
    expect([...registeredActions].filter((action) => !renderedActions.has(action))).toEqual([]);
  });
});
