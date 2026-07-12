import fs from "node:fs";

const files = {
  chunk: fs.readFileSync("src/memory/chunkPersistence.ts", "utf8"),
  digest: fs.readFileSync("src/memory/dailyDigest.ts", "utf8"),
  relations: fs.readFileSync("src/db/memoryRelations.ts", "utf8"),
  search: fs.readFileSync("src/memory/search.ts", "utf8"),
  xyzem: fs.readFileSync("src/memory/xyzem.ts", "utf8"),
  debug: fs.readFileSync("src/api/debug.ts", "utf8"),
  narrative: fs.readFileSync("src/memory/narrativeTimeline.ts", "utf8"),
};
const merge = fs.readFileSync("src/memory/merge.ts", "utf8");
const reviewActions = fs.readFileSync("src/api/adminBoard/actions.ts", "utf8");
const reviewView = fs.readFileSync("src/api/adminBoard/reviewView.ts", "utf8");
const postProcess = fs.readFileSync("src/memory/postProcess.ts", "utf8");
const metabolismReview = fs.readFileSync(
  "src/memory/metabolismReview.ts",
  "utf8",
);
const metabolismActions = fs.readFileSync(
  "src/api/adminBoard/metabolismActions.ts",
  "utf8",
);
const metabolismView = fs.readFileSync(
  "src/api/adminBoard/metabolismView.ts",
  "utf8",
);

const timelineBackfill = fs.readFileSync(
  "src/memory/timelineBackfill.ts",
  "utf8",
);
const candidateResultMigration = fs.readFileSync(
  "migrations/20260704_candidate_result_link.sql",
  "utf8",
);
const memoriesApi = fs.readFileSync("src/api/memories.ts", "utf8");
const mcpApi = fs.readFileSync("src/api/mcp.ts", "utf8");
const memoriesDb = fs.readFileSync("src/db/memories.ts", "utf8");
const startupContext = fs.readFileSync("src/memory/startupContext.ts", "utf8");
const recallFormat = fs.readFileSync("src/memory/recallFormat.ts", "utf8");
const queueConsumer = fs.readFileSync("src/queue/consumer.ts", "utf8");
const memoryState = fs.readFileSync("src/memory/state.ts", "utf8");
const legacyRelations = fs.readFileSync("src/memory/legacyRelations.ts", "utf8");
const diarySplit = fs.readFileSync("src/memory/diarySplit.ts", "utf8");
const candidateActions = fs.readFileSync("src/api/adminBoard/candidateActions.ts", "utf8");
const candidateView = fs.readFileSync("src/api/adminBoard/candidateView.ts", "utf8");
const adminBoard = fs.readFileSync("src/api/adminBoard.ts", "utf8");
const adminView = fs.readFileSync("src/api/adminBoard/view.ts", "utf8");
const candidateQuality = fs.readFileSync("src/memory/candidateQuality.ts", "utf8");
const recallTrace = fs.readFileSync("src/memory/recallTrace.ts", "utf8");
const recallApi = fs.readFileSync("src/api/recall.ts", "utf8");
const recallContext = fs.readFileSync("src/memory/recall.ts", "utf8");
const recallFilter = fs.readFileSync("src/memory/recallFilter.ts", "utf8");
const injection = fs.readFileSync("src/memory/inject.ts", "utf8");
const coordinateBackfill = fs.readFileSync("src/application/coordinateBackfill.ts", "utf8");
const recallFusion = fs.readFileSync("src/memory/recallFusion.ts", "utf8");
const recallOutputPolicy = fs.readFileSync("src/memory/recallOutputPolicy.ts", "utf8");
const vpsDreamCandidate = fs.readFileSync("ops/vps/kld_dream_candidate_shadow.py", "utf8");

const checks = [
  [
    "Safety: fresh migrations bootstrap memory_candidates before result link",
    candidateResultMigration.indexOf(
      "CREATE TABLE IF NOT EXISTS memory_candidates",
    ) < candidateResultMigration.indexOf("ALTER TABLE memory_candidates"),
  ],
  [
    "Safety: memory API failures are observable JSON instead of Worker 1101",
    memoriesApi.includes('event: "memory_api_unhandled_error"') &&
      memoriesApi.includes('code: "memory_operation_failed"') &&
      memoriesApi.includes("return memoryRouteFailure(request, error)"),
  ],
  [
    "Recall: MCP exposes exact search and deep active-recall tools",
    mcpApi.includes('{ name: "memory_search"') &&
      mcpApi.includes('{ name: "memory_recall"') &&
      mcpApi.includes('params.name === "memory_search"') &&
      mcpApi.includes('params.name === "retrieve_memory" || params.name === "memory_recall"') &&
      mcpApi.includes("searchMemoriesByText(env.DB") &&
      mcpApi.includes("searchMemories(env"),
  ],
  [
    "Recall: startup context directs active lookup before guessing",
    startupContext.includes("search memory instead of guessing") &&
      startupContext.includes("Use memory_search for exact") &&
      startupContext.includes("Use memory_recall for nuanced past context") &&
      startupContext.includes("Current user statements override recalled memory"),
  ],
  [
    "E: recalled posture affects response style without rewriting facts",
    recallFormat.includes("memory.response_posture") &&
      recallFormat.includes("tell you how to respond next time") &&
      startupContext.includes("E-axis fields guide tone only; they never rewrite facts"),
  ],
  [
    "X: chunks receive a deterministic timeline thread",
    files.chunk.includes("thread = `timeline:") &&
      files.chunk.includes("thread,"),
  ],
  [
    "X: legacy timeline dry-run requires explicit full dates",
    timelineBackfill.includes("extractExplicitDates") &&
      timelineBackfill.includes("dates.length > 1") &&
      files.debug.includes("timeline_backfill_apply_not_enabled"),
  ],
  [
    "X: review records are excluded from timeline proposals",
    timelineBackfill.includes("type != 'dream_review'"),
  ],
  [
    "X: temporal proposals require the same thread and fact",
    timelineBackfill.includes("byFact") &&
      timelineBackfill.includes("proposal.fact_key") &&
      timelineBackfill.includes("source_date") &&
      timelineBackfill.includes("target_date"),
  ],
  [
    "X: date proposals use an explicit review queue",
    timelineBackfill.includes('action: "timeline_date"') &&
      fs
        .readFileSync("src/api/adminBoard/timelineActions.ts", "utf8")
        .includes("extractExplicitDates(target.content)"),
  ],
  [
    "X: approval preserves text and only appends timeline tags",
    fs
      .readFileSync("src/api/adminBoard/timelineActions.ts", "utf8")
      .includes("patch: { tags:") &&
      !fs
        .readFileSync("src/api/adminBoard/timelineActions.ts", "utf8")
        .includes("patch: { content:"),
  ],
  [
    "X: legacy scan uses stable bounded cursor pagination",
    timelineBackfill.includes("AND id > ?") &&
      timelineBackfill.includes("ORDER BY id") &&
      timelineBackfill.includes("TIMELINE_BATCH_SIZE = 100") &&
      timelineBackfill.includes("nextCursor"),
  ],
  [
    "X: full-corpus scan progress is persisted",
    timelineBackfill.includes("maintenance:timeline_backfill") &&
      timelineBackfill.includes("scanTimelineBackfillPage") &&
      fs
        .readFileSync("src/api/adminBoard/view.ts", "utf8")
        .includes("扫描进度"),
  ],
  [
    "X: review cards remain reachable beyond the first page",
    fs
      .readFileSync("src/db/memoryCandidates.ts", "utf8")
      .includes("LIMIT ? OFFSET ?") &&
      fs
        .readFileSync("src/db/memoryCandidates.ts", "utf8")
        .includes("countMemoryCandidatesByAction"),
  ],
  [
    "Y: recall expands two hops with strength thresholds",
    files.relations.includes("for (const depth of [1, 2])") &&
      files.relations.includes("relation.strength < 0.7"),
  ],
  [
    "Y: review-only relations are excluded from safe expansion",
    files.relations.includes("REVIEW_RELATION_TYPES") &&
      files.relations.includes(
        "SAFE_RELATION_TYPES.has(relation.relation_type)",
      ),
  ],
  [
    "Recall: lexical evidence is never vector-gated",
    files.search.includes("searchMemoriesByText(env.DB") &&
      !files.search.includes("vectorTopScore < FTS_FLOOR"),
  ],
  [
    "Recall: strong lexical hits survive the model filter",
    files.search.includes("protectedIds") &&
      postProcess.includes("protectedCandidates"),
  ],
  [
    "Recall: relation context receives reserved output slots",
    recallOutputPolicy.includes("topK - additions.length") &&
      recallOutputPolicy.includes("Math.min(2, Math.max(0, topK - 1))"),
  ],
  [
    "Recall: long diary records are excluded from every route",
    recallOutputPolicy.includes('new Set(["diary", "layla_diary", "auto_diary"])') &&
      files.search.includes("filter(isRecallEligible)"),
  ],
  [
    "Diary split: v2 requires verbatim evidence and bounded sparse output",
    diarySplit.includes("It is valid to return") &&
      diarySplit.includes("Return 2-6 high-signal items") &&
      diarySplit.includes("the diary narrator '我' is KLD") &&
      diarySplit.includes("Never store KLD's own behavior") &&
    diarySplit.includes("!diary.includes(evidence)") &&
      diarySplit.includes('type === "quote" && !diary.includes(content)') &&
      diarySplit.includes("content.length > 360") &&
      diarySplit.includes("diary.length * 0.65") &&
      diarySplit.includes("datesFromDiary") &&
      diarySplit.includes("allowedDateSet.has") &&
      diarySplit.includes("timelineDates.has(itemDate)") &&
      diarySplit.includes("MAX_ITEMS_PER_DIARY = 6") &&
      diarySplit.includes("max_tokens: 4200"),
  ],
  [
    "Diary split: fact-like items are review-first with approval evidence revalidation",
    diarySplit.includes('action: "diary_split_fact"') &&
      diarySplit.includes("REVIEW_TYPES.has(type)") &&
      candidateActions.includes('candidate.action === "diary_split_fact"') &&
      candidateActions.includes("!diary.content.includes(evidence)") &&
      candidateView.includes("原文证据："),
  ],
  [
    "Diary split: item hashes and completion events make partial retries idempotent",
    diarySplit.includes('crypto.subtle.digest("SHA-256"') &&
      diarySplit.includes("split_item:") &&
      diarySplit.includes("diary_split_v2_complete") &&
      diarySplit.includes("existingSplitItemId"),
  ],
  [
    "Recall: exact MCP search excludes diaries unless explicitly requested",
    mcpApi.includes("include_diary") &&
      mcpApi.includes('includeDiary ? [] : ["diary", "layla_diary", "auto_diary"]') &&
      memoriesDb.includes("input.excludeTypes"),
  ],
  [
    "Recall: final output deduplicates repeated content and rejects weak relation tails",
    files.search.includes("dedupeRecallOutput") &&
      recallOutputPolicy.includes('memory.score >= 0.3'),
  ],
  [
    "Recall: explicit dates deterministically lead with the matching timeline day",
    postProcess.includes("hasExplicitDateHit") &&
      postProcess.includes("isTimelineDay(memory) && hasExplicitDateHit") &&
      postProcess.includes("pruneConflictingDateContext") &&
      recallFilter.includes("CASE WHEN type = 'timeline_day'") &&
      recallContext.includes("directDatedCandidates.length > 0"),
  ],
  [
    "Diary split: selected fact candidates support bounded batch approve and reject",
    candidateActions.includes("MAX_DIARY_FACT_BATCH_SIZE = 100") &&
      candidateActions.includes('candidate.action !== "diary_split_fact"') &&
      adminBoard.includes("batchReviewDiaryFactCandidates") &&
      adminView.includes('id="fact-batch-form"') &&
      candidateView.includes('form="fact-batch-form"'),
  ],
  [
    "Dream: isolated single-message content is not recorded as a new memory",
    files.digest.includes("hasRepeatedMessageSupport") &&
      files.digest.includes("source_message_ids 必须至少包含 2 个不同消息 id") &&
      vpsDreamCandidate.includes("single_message_not_durable") &&
      vpsDreamCandidate.includes('action in {"add", "excerpt"} and source_message_count < 2'),
  ],
  [
    "Diary rescreen: replacement is explicit, bounded, staged, and reversible",
    diarySplit.includes("replace_importer requires force=true and explicit diary ids") &&
      diarySplit.includes("replace_importer accepts at most 3 diary ids per request") &&
      diarySplit.includes('status: replaceImporter ? "review" : "active"') &&
      diarySplit.includes("rescreened_by:v2:") &&
      diarySplit.includes('reason: "already_rescreened"') &&
      diarySplit.includes("old_review") &&
      diarySplit.includes("createdIds: []") &&
      diarySplit.includes("env.DB.batch") &&
      diarySplit.includes("removeMemoryVector") &&
      diarySplit.includes("vector_sync_status = 'pending'"),
  ],
  [
    "Diary rescreen: queue supports authenticated dry-run and bounded apply jobs",
    queueConsumer.includes('case "diary_rescreen"') &&
      queueConsumer.includes("hasCompletedDiaryRescreenJob") &&
      queueConsumer.includes("diaryIds.slice(0, 3)") &&
      queueConsumer.includes('"diary_rescreen_dry_run"') &&
      queueConsumer.includes('"diary_rescreen_applied"'),
  ],
  [
    "Vector sync: canonical and legacy status fields change together",
    memoryState.includes("vector_sync_status = ?, vector_synced = ?") &&
      memoryState.includes('status === "synced" ? 1 : 0'),
  ],
  [
    "Vector sync: queue jobs are bounded and idempotent",
    queueConsumer.includes('case "memory_vector_sync"') &&
      queueConsumer.includes("message.memoryIds.slice(0, 3)") &&
      queueConsumer.includes('eventType: "memory_vector_sync_complete"') &&
      queueConsumer.includes("syncMemoryVector"),
  ],
  [
    "Vector sync: five-minute self-healing excludes diary records",
    fs.readFileSync("src/index.ts", "utf8").includes("retryStaleVectorSyncs(env, namespace, 12)") &&
      memoryState.includes("type NOT IN ('diary','layla_diary','auto_diary')") &&
      fs.readFileSync("src/index.ts", "utf8").includes("scheduled five-minute maintenance"),
  ],
  [
    "Coordinate backfill: queue reuses the review-first scheduled path",
    queueConsumer.includes('case "coordinate_backfill"') &&
      queueConsumer.includes("runScheduledCoordinateBackfill") &&
      queueConsumer.includes('eventType: "coordinate_backfill_complete"'),
  ],
  [
    "Y: relation backfill can be scoped to one tagged import batch",
    legacyRelations.includes("requiredTag") &&
      legacyRelations.includes("json_each(memories.tags)") &&
      queueConsumer.includes('case "relation_backfill"') &&
      queueConsumer.includes('["origin_split"]') &&
      queueConsumer.includes('eventType: "relation_backfill_complete"'),
  ],
  [
    "M: queue patrol remains review-first",
    queueConsumer.includes('case "metabolism_scan"') &&
      queueConsumer.includes("scanMetabolismReviewCandidates") &&
      queueConsumer.includes('eventType: "metabolism_scan_complete"'),
  ],
  [
    "Recall: fact-intent rule memories lead before milestone context",
    postProcess.includes("isGuidanceRecord(memory) && directHitAny") &&
      postProcess.includes(
        "directHit || input.hasGuidanceCandidate ? 0.6 : 1.5",
      ) &&
      postProcess.includes("const guidanceHit") &&
      postProcess.includes(
        "leadQuery = query && query.trim() ? query : rawQuery",
      ) &&
      postProcess.includes("memories.find(isGuidanceRecord);") &&
      files.search.includes("plan.rawQuery") &&
      files.search.includes("plan.searchQuery"),
  ],
  [
    "Y: existing memories have deterministic additive backfill",
    fs
      .readFileSync("src/memory/legacyRelations.ts", "utf8")
      .includes("same_fact_key") &&
      fs
        .readFileSync("src/memory/legacyRelations.ts", "utf8")
        .includes("origin_split") &&
      fs
        .readFileSync("src/memory/legacyRelations.ts", "utf8")
        .includes("legacy-backfill:"),
  ],
  [
    "Y: in-thread backfill requires a precise fact or provenance anchor",
    fs
      .readFileSync("src/memory/legacyRelations.ts", "utf8")
      .includes("addAnchoredThreadChain") &&
      fs
        .readFileSync("src/memory/legacyRelations.ts", "utf8")
        .includes("direct_source_ref") &&
      fs
        .readFileSync("src/memory/legacyRelations.ts", "utf8")
        .includes("active_fact != 0"),
  ],
  [
    "Z/M: dream mutations are review-first",
    files.digest.includes('eventType: "dream_mutation_review"') &&
      !files.digest.includes("async function applyMemoryUpdates"),
  ],
  [
    "Z: fact keys are proposed as reviewable groups",
    fs
      .readFileSync("src/memory/factGroups.ts", "utf8")
      .includes('action:"fact_group"') &&
      fs
        .readFileSync("src/api/adminBoard/candidateActions.ts", "utf8")
        .includes('candidate.action === "fact_group"'),
  ],
  [
    "Z: merge supersede creates a visible review instead of mutating facts",
    merge.includes('type: "dream_review"') &&
      merge.includes('"supersede-review"') &&
      !merge.includes('eventType: "z_supersede_review"'),
  ],
  [
    "Z: supersede review has approve and reject closure",
    reviewActions.includes('parsed.action !== "supersede"') &&
      reviewActions.includes("previousTarget: superseded") &&
      reviewActions.includes('status: "superseded", activeFact: false'),
  ],
  [
    "Z: supersede review displays before and after content",
    reviewView.includes('review?.action === "supersede"') &&
      reviewView.includes("review.replacement") &&
      reviewView.includes("批准替换"),
  ],
  [
    "E: shadow gate controls ranking",
    files.search.includes("shouldApplyEAxisToRanking(env)") &&
      recallFusion.includes("applyEAxis ? eAxisBoost(record) : 0"),
  ],
  [
    "Night: Y runs before Z and M",
    files.xyzem.indexOf("const relations = await runRelationBuild") <
      files.xyzem.indexOf("const zAudit = await runZAudit") &&
      files.xyzem.indexOf("const zAudit = await runZAudit") <
        files.xyzem.indexOf("const patrol = await runMetabolismPatrol"),
  ],
  [
    "Safety: coordinate backfill apply=false is read-only",
    coordinateBackfill.includes("if (apply)") &&
      files.debug.includes("apply: body?.apply === true"),
  ],
  [
    "Safety: coordinate proposals are bounded and exceptions are reviewable",
    coordinateBackfill.includes("COORDINATE_BACKFILL_BATCH_SIZE = 5") &&
      coordinateBackfill.includes("slice(offset, offset + limit)") &&
      coordinateBackfill.includes("splitCoordinatePatch") &&
      coordinateBackfill.includes(
        'apply ? "auto_apply_with_exception_review" : "dry_run"',
      ),
  ],
  [
    "Cron: coordinate backfill is isolated from daily maintenance",
    files.debug.includes("runScheduledCoordinateBackfill") &&
      fs
        .readFileSync("src/index.ts", "utf8")
        .includes('controller.cron === "*/5 * * * *"'),
  ],
  [
    "Cron: coordinate backfill has persisted pause control",
    fs
      .readFileSync("src/index.ts", "utf8")
      .includes("getCoordinateBackfillControl") &&
      fs
        .readFileSync("src/api/adminBoard.ts", "utf8")
        .includes("coordinate-backfill/toggle"),
  ],
  [
    "Safety: XYZEM dry-run does not persist audit events",
    files.xyzem.includes(
      "runZAudit(env, namespace, { dryRun: options.dryRun })",
    ) &&
      files.xyzem.includes(
        "runMetabolismPatrol(env, namespace, { dryRun: options.dryRun })",
      ),
  ],
  [
    "Y: nightly relation build auto-creates safe edges and queues risky edges",
    files.xyzem.includes("const relations = await runRelationBuild") &&
      files.xyzem.includes("SAFE_RELATION_TYPES.has(relationType)") &&
      files.xyzem.includes("await createMemoryRelation") &&
      files.xyzem.includes("REVIEW_RELATION_TYPES.has(relationType)") &&
      files.xyzem.includes('eventType: "y_relation_review"'),
  ],
  [
    "M: patrol findings become explicit review candidates",
    metabolismReview.includes('action: "m_archive"') &&
      metabolismReview.includes('action: "m_relation_cleanup"'),
  ],
  [
    "M: repeated patrols advance past relations already reviewed or queued",
    metabolismReview.includes("NOT EXISTS") &&
      metabolismReview.includes("c.external_key = 'm-review:relation:' || r.id") &&
      metabolismReview.includes("c.external_key = 'm-review:relation:' || b.id"),
  ],
  [
    "M: protected memories never enter archive review",
    metabolismReview.includes("PROTECTED_MEMORY_TYPES") &&
      metabolismReview.includes("type = 'project_state'") &&
      metabolismActions.includes("PROTECTED_MEMORY_TYPES.has"),
  ],
  [
    "M: only symmetric relation types are deduplicated",
    metabolismReview.includes("SYMMETRIC_RELATION_TYPES") &&
      metabolismReview.includes("symmetricPlaceholders"),
  ],
  [
    "M: approval snapshots state and revalidates targets",
    metabolismActions.includes('eventType: "m_snapshot"') &&
      metabolismActions.includes("metabolism_candidate_is_stale") &&
      metabolismActions.includes("metabolism_relation_candidate_changed"),
  ],
  [
    "M: approved operations expose rollback closure",
    metabolismActions.includes('eventType: "m_rollback"') &&
      metabolismActions.includes("rolled_back") &&
      metabolismView.includes("回滚这次操作"),
  ],
  [
    "M: every review action is reachable through the Worker router",
    ["scan", "approve", "reject", "batch", "rollback"].every((action) =>
      fs
        .readFileSync("src/index.ts", "utf8")
        .includes(`/admin/memories/m-review/${action}`),
    ),
  ],
  [
    "Y/M: batch review is relation-only, bounded, and explicitly selected",
    metabolismActions.includes("MAX_METABOLISM_BATCH_SIZE = 30") &&
      metabolismActions.includes("relationOnly: true") &&
      metabolismView.includes('form="m-batch-form"') &&
      fs.readFileSync("src/api/adminBoard/view.ts", "utf8").includes("只删选中的边") &&
      fs.readFileSync("src/api/adminBoard/view.ts", "utf8").includes("保留选中的边"),
  ],
  [
    "M: relation cleanup cards show both endpoint memories",
    fs
      .readFileSync("src/db/memoryCandidates.ts", "utf8")
      .includes("enrichMetabolismRelationEndpoints") &&
      metabolismView.includes("这条边连接的两条记忆") &&
      metabolismView.includes("source_memory_content") &&
      metabolismView.includes("target_memory_content"),
  ],
  [
    "Y/M: cleanup cards explain issue, meaning, recommendation, and edge-only impact",
    metabolismView.includes("问题类型：") &&
      metabolismView.includes("这条线表示：") &&
      metabolismView.includes("为什么建议删：") &&
      metabolismView.includes("审核建议：") &&
      metabolismView.includes("只删这条边") &&
      metabolismView.includes("A、B 两端记忆正文都不会改变"),
  ],
  [
    "Dream: Worker memory_maintenance uses explicit fallback only, no LLM extraction",
    !fs
      .readFileSync("src/memory/maintenance.ts", "utf8")
      .includes("extractMemoriesFromMessages") &&
      !fs
        .readFileSync("src/memory/maintenance.ts", "utf8")
        .includes("await extractMemories"),
  ],
  [
    "Dream: candidate atom quality is advisory, deterministic, and batch-reject only",
    candidateQuality.includes('"reject_suggested"') &&
      candidateQuality.includes("pipeline_scaffold") &&
      candidateQuality.includes("contextless_excerpt") &&
      candidateView.includes("原子质量提示") &&
      candidateActions.includes("batchRejectLowQualityCandidates") &&
      candidateActions.includes('resolveMemoryCandidate(env.DB, "default", id, "rejected")') &&
      !candidateQuality.includes("createMemory(") &&
      adminView.includes("只会拒绝你勾选的低质量候选"),
  ],
  [
    "Recall: final injected memories feed M state with privacy-preserving layered trace",
    recallApi.includes('eventType: "recall_context_injected"') &&
      recallApi.includes("query_hash") &&
      recallApi.includes("markMemoriesRecalled") &&
      recallApi.includes("ctx.waitUntil") &&
      !recallApi.includes("payload: {\n            prompt:") &&
      recallTrace.includes('"authority"') &&
      recallTrace.includes('"evidence"') &&
      recallTrace.includes('"association"') &&
      recallTrace.includes('"fallback"'),
  ],
  [
    "Recall: gateway feedback counts final compressed output rather than search candidates",
    !injection.includes("recordRecall: true") &&
      injection.includes("finalizeInjectionSelection") &&
      injection.includes("markMemoriesRecalled"),
  ],
  [
    "M: listMetabolismCandidates shows pending only, no approved re-bubbling",
    fs
      .readFileSync("src/db/memoryCandidates.ts", "utf8")
      .includes("AND c.status = 'pending'") &&
      !fs
        .readFileSync("src/db/memoryCandidates.ts", "utf8")
        .includes("C c.status WHEN 'pending'"),
  ],
  [
    "Identity: narratives use explicit third-person subjects",
    files.narrative.includes("用户（Layla）") &&
      files.narrative.includes("KLD") &&
      !files.narrative.includes("我=助手"),
  ],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
}

if (failed) process.exitCode = 1;
