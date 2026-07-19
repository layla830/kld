import fs from "node:fs";

const files = {
  chunk: fs.readFileSync("src/memory/chunkPersistence.ts", "utf8"),
  digest: fs.readFileSync("src/memory/dailyDigest.ts", "utf8"),
  relations: fs.readFileSync("src/db/memoryRelations.ts", "utf8"),
  search: fs.readFileSync("src/memory/search.ts", "utf8"),
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
const factTransitionReview = fs.readFileSync("src/memory/factTransitionReview.ts", "utf8");
const operationalReview = fs.readFileSync("src/memory/operationalReview.ts", "utf8");
const factTransitionActions = fs.readFileSync("src/api/adminBoard/factTransitionActions.ts", "utf8");
const operationalReviewActions = fs.readFileSync("src/api/adminBoard/operationalReviewActions.ts", "utf8");
const relationReviewActions = fs.readFileSync("src/api/adminBoard/relationReviewActions.ts", "utf8");
const relationReview = fs.readFileSync("src/memory/relationReview.ts", "utf8");

const timelineBackfill = fs.readFileSync(
  "src/memory/timelineBackfill.ts",
  "utf8",
);
const timelineRelations = fs.readFileSync("src/memory/timelineRelations.ts", "utf8");
const candidateResultMigration = fs.readFileSync(
  "migrations/20260704_candidate_result_link.sql",
  "utf8",
);
const memoriesApi = fs.readFileSync("src/api/memories.ts", "utf8");
const mcpApi = fs.readFileSync("src/api/mcp.ts", "utf8");
const memoriesDb = fs.readFileSync("src/db/memories.ts", "utf8");
const startupContext = fs.readFileSync("src/memory/startupContext.ts", "utf8");
const recallFormat = fs.readFileSync("src/recall/formatter.ts", "utf8");
const queueConsumer = fs.readFileSync("src/queue/consumer.ts", "utf8");
const queueProducer = fs.readFileSync("src/queue/producer.ts", "utf8");
const workerIndex = fs.readFileSync("src/index.ts", "utf8");
const candidateDb = fs.readFileSync("src/db/memoryCandidates.ts", "utf8");
const memoryState = fs.readFileSync("src/memory/state.ts", "utf8");
const legacyRelations = fs.readFileSync("src/memory/legacyRelations.ts", "utf8");
const diarySplit = fs.readFileSync("src/memory/diarySplit.ts", "utf8");
const diarySplitState = fs.readFileSync("src/db/diarySplitState.ts", "utf8");
const candidateActions = fs.readFileSync("src/api/adminBoard/candidateActions.ts", "utf8");
const candidateView = fs.readFileSync("src/api/adminBoard/candidateView.ts", "utf8");
const adminBoard = fs.readFileSync("src/api/adminBoard.ts", "utf8");
const adminView = fs.readFileSync("src/api/adminBoard/view.ts", "utf8");
const candidateQuality = fs.readFileSync("src/memory/candidateQuality.ts", "utf8");
const dreamCandidatePolicy = fs.readFileSync("src/memory/dreamCandidatePolicy.ts", "utf8");
const candidateOverride = fs.readFileSync("src/memory/candidateOverride.ts", "utf8");
const candidateIngress = fs.readFileSync("src/api/memoryCandidates.ts", "utf8");
const recallTrace = fs.readFileSync("src/recall/trace.ts", "utf8");
const recallApi = fs.readFileSync("src/api/recall.ts", "utf8");
const recallSignals = fs.readFileSync("src/db/recallSignals.ts", "utf8");
const recallContext = fs.readFileSync("src/recall/service.ts", "utf8");
const recallFilter = fs.readFileSync("src/recall/candidatePolicy.ts", "utf8");
const injection = fs.readFileSync("src/memory/inject.ts", "utf8");
const coordinateBackfill = fs.readFileSync("src/memory/coordinateBackfill.ts", "utf8");
const recallFusion = fs.readFileSync("src/recall/fusion.ts", "utf8");
const eAxisObservability = fs.readFileSync("src/memory/eAxisObservability.ts", "utf8");
const eAxisRuntime = fs.readFileSync("src/memory/eAxis.ts", "utf8");
const recallOutputPolicy = fs.readFileSync("src/recall/outputPolicy.ts", "utf8");
const vpsDreamCandidate = fs.readFileSync("ops/vps/kld_dream_candidate_shadow.py", "utf8");
const workerTypes = fs.readFileSync("src/types.ts", "utf8");
const runtimeVariables = fs.readFileSync("src/config/variables.ts", "utf8");
const generatedBindings = fs.readFileSync("src/generated/worker-configuration.d.ts", "utf8");
const runtimeConfig = fs.readFileSync("src/config/runtime.ts", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");
const packageConfig = JSON.parse(packageJson);
const wranglerConfig = fs.readFileSync("wrangler.toml", "utf8");
const fiveAxisRelations = fs.readFileSync("src/memory/fiveAxis/yRelations.ts", "utf8");
const fiveAxisFacts = fs.readFileSync("src/memory/fiveAxis/zFacts.ts", "utf8");
const fiveAxisNightly = fs.readFileSync("src/memory/fiveAxis/nightly.ts", "utf8");
const recallMetabolismShadow = fs.readFileSync("src/memory/recallMetabolismShadow.ts", "utf8");
const fiveAxisProjection = fs.readFileSync("src/memory/fiveAxis/projection.ts", "utf8");
const fiveAxisOutboxMigration = fs.readFileSync("migrations/20260713_memory_five_axis_outbox.sql", "utf8");
const fiveAxisDependencyMigration = fs.readFileSync("migrations/20260716_five_axis_dependency_triggers.sql", "utf8");
const eAxisRuntimeMigration = fs.readFileSync("migrations/20260718_e_axis_runtime_state.sql", "utf8");
const recallSignalMigration = fs.readFileSync("migrations/20260719_recall_signal_rollups.sql", "utf8");
const timelineSequenceMigration = fiveAxisDependencyMigration;

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
    timelineBackfill.includes("type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')"),
  ],
  [
    "X: approved dates rebuild durable adjacent edges across the full thread/fact group",
    timelineRelations.includes("WHERE namespace = ? AND status = 'active' AND thread = ? AND fact_key = ?") &&
      timelineRelations.includes("replaceTimelineSequenceRelations") &&
    timelineRelations.includes("previous.memory.id") &&
      timelineRelations.includes("memory_timeline_memberships") &&
      files.relations.includes("timeline_approved:") &&
      files.relations.includes("DELETE FROM memory_relations") &&
      files.relations.includes("AND reason = ?") &&
      !files.relations.includes("source_memory_id IN (\n               SELECT id FROM memories") &&
      timelineSequenceMigration.includes("LAG(id) OVER") &&
      timelineSequenceMigration.includes("CREATE TABLE IF NOT EXISTS memory_timeline_memberships") &&
      timelineSequenceMigration.includes("json_array(thread, fact_key)"),
  ],
  [
    "X: date proposals use an explicit review queue",
    timelineBackfill.includes('action: "timeline_date"') &&
      fs
        .readFileSync("src/api/adminBoard/timelineActions.ts", "utf8")
        .includes("extractExplicitDates(target.content)"),
  ],
  [
    "X: approval preserves text and only replaces timeline date tags",
    fs
      .readFileSync("src/api/adminBoard/timelineActions.ts", "utf8")
      .includes('tags.filter((tag) => !tag.startsWith("date:"))') &&
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
    "Y: risky relations enter expansion only after reviewed persistence",
    files.relations.includes("PERSISTED_RELATION_TYPES") &&
      relationReviewActions.includes("await env.DB.batch(statements)") &&
      relationReviewActions.includes("status = 'approved'") &&
      relationReviewActions.includes("rel_yreview_") &&
      fs.readFileSync("src/db/memoryCandidates.ts", "utf8")
        .includes("WHERE memory_candidates.status IN ('pending','needs_subject_review','deferred_relation')"),
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
    "Diary split: v2 requires a day node, verbatim evidence, and bounded sparse output",
    diarySplit.includes("Never return an empty items array for a formal diary") &&
      diarySplit.includes("timeline_day_fallback:verbatim") &&
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
      diarySplit.includes("existingSplitItemId") &&
      diarySplit.includes("DIARY_SPLIT_INCOMPLETE_EVENT") &&
      diarySplitState.includes('DIARY_SPLIT_COMPLETE_EVENT = "diary_split_v2_complete"') &&
      diarySplitState.includes("json_extract(payload_json, '$.item_count')") &&
      diarySplitState.includes(") > 0"),
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
      vpsDreamCandidate.includes('action in {"add", "excerpt"} and len(source_message_ids) < 2') &&
      vpsDreamCandidate.includes("missing_durable_claim") &&
      candidateQuality.includes("single_message_support"),
  ],
  [
    "Dream: VPS ingress keeps chunk-summary memories and suppresses standalone quote cards",
    dreamCandidatePolicy.includes('candidate.action === "excerpt"') &&
      dreamCandidatePolicy.includes('reason: "standalone_excerpt"') &&
      dreamCandidatePolicy.includes("missing_chunk_summary") &&
      candidateIngress.includes('eventType: "dream_candidates_suppressed"') &&
      candidateIngress.includes('policy: "chunk_summary_first"') &&
      candidateIngress.includes("accepted: candidates.length") &&
      candidateIngress.includes("stored: accepted.length"),
  ],
  [
    "Dream review: blocked memory candidates require an explicit audited human override",
    candidateOverride.includes('candidate.status === "needs_subject_review"') &&
      candidateActions.includes('readFormText(form, "override_validation") === "1"') &&
      candidateActions.includes('eventType: "memory_candidate_validation_override_requested"') &&
      candidateActions.includes('eventType: "memory_candidate_validation_override_applied"') &&
      candidateView.includes("人工确认并通过"),
  ],
  [
    "Diary split: active formal diaries enqueue automatically and missed jobs self-heal",
    queueProducer.includes("enqueueDiarySplitIfNeeded") &&
      queueProducer.includes("enqueueMissedDiarySplits") &&
      queueProducer.includes("listMissedDiarySplitCandidates") &&
      queueProducer.includes("dateFromDiary(memory)") &&
      queueConsumer.includes('case "diary_split"') &&
      queueConsumer.includes("hasSuccessfulDiarySplit") &&
      queueConsumer.includes('eventType: "diary_split_queue_complete"') &&
      diarySplitState.includes("split.type = 'timeline_day'") &&
      diarySplitState.includes("value = 'split_version:v2'") &&
      diarySplitState.includes("value = 'has_timeline_split'") &&
      diarySplitState.includes("COALESCE(CAST(json_extract(event.payload_json, '$.item_count') AS INTEGER), 0) > 0") &&
      mcpApi.includes("enqueueDiarySplitIfNeeded(env, memory)") &&
      memoriesApi.includes("enqueueDiarySplitIfNeeded(env, memory)"),
  ],
  [
    "Five-axis: nightly Y/Z/M is independent from narrative Dream and stays review-first",
    workerIndex.includes("config.fiveAxis.enabled") &&
      workerIndex.includes("config.fiveAxis.dryRun") &&
      fiveAxisNightly.includes("scanOperationalReviewCandidates") &&
      workerIndex.includes('skipped: "five_axis_disabled"'),
  ],
  [
    "Dream review: blocked verbatim evidence can be repaired and revalidated inline",
    candidateActions.includes("repairCandidateEvidence") &&
      candidateActions.includes("quote.includes(evidence)") &&
      candidateDb.includes("updateMemoryCandidateEvidence") &&
      candidateView.includes("修复逐字证据") &&
      adminBoard.includes("repair-evidence"),
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
    "Diary rescreen: authenticated bounded API replaces the producerless Queue variant",
    memoriesApi.includes("async function handleSplitDiaryMemories") &&
      memoriesApi.includes('requireScope(profile, "memory:write")') &&
      memoriesApi.includes("replace_importer") &&
      !queueConsumer.includes('case "diary_rescreen"') &&
      !workerTypes.includes('type: "diary_rescreen"'),
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
    "Coordinate backfill: scheduled use case is not duplicated in Queue",
    !queueConsumer.includes('case "coordinate_backfill"') &&
      !workerTypes.includes('type: "coordinate_backfill"') &&
      workerIndex.includes("runScheduledCoordinateBackfill") &&
      coordinateBackfill.includes("export async function runScheduledCoordinateBackfill"),
  ],
  [
    "Y: legacy relation backfill stays explicitly scoped and manual",
    legacyRelations.includes("requiredTag") &&
      legacyRelations.includes("json_each(memories.tags)") &&
      files.debug.includes("handleLegacyRelationBackfill") &&
      workerIndex.includes('/v1/debug/legacy_relation_backfill') &&
      !queueConsumer.includes('case "relation_backfill"') &&
      !workerTypes.includes('type: "relation_backfill"'),
  ],
  [
    "M: scheduled patrol remains review-first without a dead Queue variant",
    !queueConsumer.includes('case "metabolism_scan"') &&
      !workerTypes.includes('type: "metabolism_scan"') &&
      operationalReview.includes("scanMetabolismReviewCandidates") &&
      fiveAxisNightly.includes("scanOperationalReviewCandidates"),
  ],
  [
    "Architecture: Queue contract contains only six actively produced background jobs",
    workerTypes.includes('type: "memory_maintenance"') &&
      workerTypes.includes('type: "conversation_chunk"') &&
      workerTypes.includes('type: "retention"') &&
      workerTypes.includes('type: "diary_split"') &&
      workerTypes.includes('type: "memory_vector_sync"') &&
      workerTypes.includes('type: "memory_five_axis_projection"') &&
      queueProducer.includes('type: "memory_maintenance"') &&
      queueProducer.includes('type: "conversation_chunk"') &&
      queueProducer.includes('type: "retention"') &&
      queueProducer.includes('type: "diary_split"') &&
      queueProducer.includes('type: "memory_vector_sync"') &&
      queueProducer.includes('type: "memory_five_axis_projection"') &&
      !workerTypes.includes('type: "diary_rescreen"') &&
      !workerTypes.includes('type: "coordinate_backfill"') &&
      !workerTypes.includes('type: "relation_backfill"') &&
      !workerTypes.includes('type: "metabolism_scan"'),
  ],
  [
    "Architecture: generated bindings and grouped runtime variables replace a flat hand-written Env",
    workerTypes.includes('Pick<CloudflareBindings, "DB">') &&
      workerTypes.includes("extends GeneratedPlatformBindings, RuntimeVariables") &&
      runtimeVariables.includes("export interface AuthVariables") &&
      runtimeVariables.includes("export interface RecallVariables") &&
      runtimeVariables.includes("export interface FiveAxisVariables") &&
      generatedBindings.includes("interface CloudflareBindings extends Cloudflare.Env") &&
      packageJson.includes('"types:check"') &&
      runtimeConfig.includes("export interface AppConfig"),
  ],
  [
    "Architecture: recall modules have one owner and no placeholder DDD directories remain",
    fs.existsSync("src/recall/service.ts") &&
      fs.existsSync("src/recall/sources/emotion.ts") &&
      !fs.existsSync("src/memory/recall.ts") &&
      !fs.existsSync("src/memory/recallFusion.ts") &&
      !fs.existsSync("src/domain/memoryProposal.ts") &&
      !fs.existsSync("src/application/coordinateBackfill.ts") &&
      coordinateBackfill.includes("export async function runCoordinateBackfill") &&
      coordinateBackfill.includes("export async function runScheduledCoordinateBackfill") &&
      files.debug.includes("runCoordinateBackfill") &&
      workerIndex.includes("runScheduledCoordinateBackfill"),
  ],
  [
    "Architecture: Y and the unified Z/M review scanner have separate owners without dead patrol modules",
    !fs.existsSync("src/memory/xyzem.ts") &&
      fiveAxisRelations.includes("export async function runRelationBuild") &&
      factTransitionReview.includes("scanFactTransitionReviewCandidates") &&
      metabolismReview.includes("scanMetabolismReviewCandidates") &&
      !fs.existsSync("src/memory/fiveAxis/mMetabolism.ts") &&
      !fiveAxisFacts.includes("runZAudit") &&
      fiveAxisNightly.includes("export async function runFiveAxisNightlyMaintenance") &&
      workerIndex.includes('from "./memory/fiveAxis/nightly"'),
  ],
  [
    "Ingest wiring: trigger, scheduled producer, and Queue consumer remain connected",
    fiveAxisOutboxMigration.includes("trg_memories_five_axis_after_insert") &&
      fiveAxisOutboxMigration.includes("memory_five_axis_outbox") &&
      queueProducer.includes("enqueuePendingFiveAxisProjections") &&
      queueConsumer.includes('case "memory_five_axis_projection"') &&
      workerIndex.includes("enqueuePendingFiveAxisProjections(env, 5)"),
  ],
  [
    "Ingest behavior: the default test command runs the Workers runtime circuit",
    packageConfig.scripts?.test === "npm run test:unit && npm run test:worker" &&
      packageConfig.scripts?.["test:worker"] === "vitest run --config vitest.worker.config.ts" &&
      packageConfig.devDependencies?.["@cloudflare/vitest-pool-workers"] &&
      fs.existsSync("vitest.worker.config.ts") &&
      fs.existsSync("tests-worker/five-axis-circuit.test.ts"),
  ],
  [
    "Ingest: type transitions enqueue cleanup before excluded memories leave five-axis ownership",
    fiveAxisDependencyMigration.includes("OLD.type NOT IN") &&
      fiveAxisDependencyMigration.includes("OR NEW.type NOT IN") &&
      queueConsumer.includes("isFiveAxisMemoryTypeEligible(memory.type)") &&
      queueConsumer.includes('reason: !memory') &&
      timelineRelations.includes("AND type NOT IN") &&
      timelineRelations.includes("isFiveAxisMemoryTypeEligible(memory.type)"),
  ],
  [
    "E ingest: partial coordinate bundles are completed field-by-field without overwriting supplied values",
    fiveAxisProjection.includes('needsCoordinateBackfill(memory, "missing_fields")') &&
      fiveAxisProjection.includes('selection: "missing_fields"') &&
      coordinateBackfill.includes("coordinatePatchForMissingFields") &&
      coordinateBackfill.includes('selection === "empty_bundle"') &&
      coordinateBackfill.includes("missingText(current.thread)") &&
      coordinateBackfill.includes("current.valence === null"),
  ],
  [
    "E: production shadow state is durable and promotion remains manual",
    !wranglerConfig.includes("E_AXIS_STARTED_AT") &&
      wranglerConfig.includes('E_AXIS_SHADOW_DAYS = "7"') &&
      wranglerConfig.includes('E_AXIS_RANKING_ENABLED = "false"') &&
      !generatedBindings.includes("E_AXIS_STARTED_AT: string") &&
      generatedBindings.includes("E_AXIS_SHADOW_DAYS: string") &&
      generatedBindings.includes("E_AXIS_RANKING_ENABLED: string") &&
      runtimeConfig.includes("rankingEnabled: strictFlag(env.E_AXIS_RANKING_ENABLED)") &&
      eAxisRuntime.includes('E_AXIS_STATE_KEY = "lmc5:e-axis:runtime-state"') &&
      eAxisRuntime.includes("getCacheEntry") &&
      eAxisRuntimeMigration.includes("ON CONFLICT(namespace, key) DO NOTHING"),
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
    files.search.includes("await shouldApplyEAxisToRanking(env, input.namespace)") &&
      recallFusion.includes("applyEAxis ? eAxisBoost(record) : 0"),
  ],
  [
    "E: shadow observability compares one candidate set without changing baseline output",
    recallFusion.includes("baselineRanked") &&
      recallFusion.includes("eAxisRanked") &&
      files.search.includes("fusion.records") &&
      files.search.includes("onEAxisTrace"),
  ],
  [
    "E: automatic and MCP recall persist privacy-bounded observations off the response path",
    recallApi.includes("trace: result.trace") &&
      mcpApi.includes("recordRecallSearchObservation") &&
      mcpApi.includes("ctx.waitUntil") &&
      eAxisObservability.includes('eventType: "recall_search_observed"') &&
      eAxisObservability.includes("hashRecallQuery") &&
      !eAxisObservability.includes("raw_query"),
  ],
  [
    "E: existing LMC-5 admin renders read-only shadow evidence",
    adminView.includes("E shadow 观测") &&
      adminView.includes("不会自动结束 shadow") &&
      adminView.includes("shadow 完成 · 待放量") &&
      adminView.includes("E_AXIS_RANKING_ENABLED 仍为 false") &&
      !adminView.includes("E_AXIS_STARTED_AT\" value="),
  ],
  [
    "Night: Y runs once before the single unified Z/M candidate scan",
    fiveAxisNightly.indexOf("const relations = await dependencies.runRelations") <
      fiveAxisNightly.indexOf("const [operationalReview, recallMetabolismShadow]") &&
      fiveAxisNightly.includes("dependencies.scanOperational") &&
      fiveAxisNightly.includes("dependencies.observeRecallMetabolism") &&
      recallMetabolismShadow.includes("'metabolism_signal_observed'") &&
      !workerIndex.includes("scanOperationalReviewCandidates"),
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
    coordinateBackfill.includes("runScheduledCoordinateBackfill") &&
      workerIndex.includes("labelCoordinateBatch") &&
      workerIndex.includes('controller.cron === "*/5 * * * *"') &&
      !files.debug.includes("export async function runScheduledCoordinateBackfill"),
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
    "Safety: nightly dry-run reaches the unified candidate projectors without dead audit-event pipes",
    fiveAxisNightly.includes("dependencies.scanOperational(env, namespace") &&
      fiveAxisNightly.includes("dryRun: options.dryRun") &&
      !fiveAxisFacts.includes('eventType: "z_audit"') &&
      !fs.existsSync("src/memory/fiveAxis/mMetabolism.ts"),
  ],
  [
    "Y: nightly relation build auto-creates safe edges and queues risky edges",
      fiveAxisNightly.includes("runRelations: runRelationBuild") &&
      fiveAxisRelations.includes("SAFE_RELATION_TYPES.has(relationType)") &&
      fiveAxisRelations.includes("await dependencies.createRelation") &&
      fiveAxisRelations.includes('relationType !== "temporal_sequence"') &&
      files.digest.includes('relationType !== "temporal_sequence"') &&
      fiveAxisRelations.includes("REVIEW_RELATION_TYPES.has(relationType)") &&
      fiveAxisRelations.includes("dependencies.queueReviewCandidate") &&
      relationReview.includes('action: "y_relation_review"') &&
      files.digest.includes("queueRelationReviewCandidate") &&
      !files.digest.includes('eventType: "y_relation_review"') &&
      relationReviewActions.includes("approveRelationReviewCandidate") &&
      relationReviewActions.includes("rejectRelationReviewCandidate") &&
      relationReviewActions.includes("rollbackRelationReviewCandidate"),
  ],
  [
    "M: patrol findings become explicit review candidates",
    metabolismReview.includes('action: "m_archive"') &&
      metabolismReview.includes('action: "m_relation_cleanup"'),
  ],
  [
    "Z: nightly conflicts become one typed review candidate per weaker fact",
    factTransitionReview.includes('action: "z_supersede"') &&
      factTransitionReview.includes('_kind: "fact_transition"') &&
      factTransitionReview.includes("for (const weaker of review.weaker)") &&
      operationalReview.includes("scanFactTransitionReviewCandidates") &&
      operationalReview.includes("scanMetabolismReviewCandidates") &&
      fiveAxisNightly.includes("scanOperationalReviewCandidates"),
  ],
  [
    "Z/Y/M: one admin skeleton dispatches approve reject and rollback by proposal action",
    operationalReviewActions.includes('case "z_supersede"') &&
      operationalReviewActions.includes('case "y_relation_review"') &&
      operationalReviewActions.includes('case "m_archive"') &&
      operationalReviewActions.includes('case "m_relation_cleanup"') &&
      operationalReviewActions.includes("parseOperationalCandidateAction") &&
      operationalReviewActions.includes("approveMetabolismCandidate") &&
      operationalReviewActions.includes("approveFactTransitionCandidate") &&
      operationalReviewActions.includes("approveRelationReviewCandidate") &&
      adminBoard.includes("approveOperationalReviewCandidate") &&
      adminBoard.includes("rejectOperationalReviewCandidate") &&
      adminBoard.includes("rollbackOperationalReviewCandidate") &&
      metabolismView.includes("renderFactTransitionCandidate") &&
      metabolismView.includes('/admin/memories/m-review/approve') &&
      metabolismView.includes('/admin/memories/m-review/reject') &&
      metabolismView.includes('/admin/memories/m-review/rollback') &&
      !adminBoard.includes("/admin/memories/z-review/"),
  ],
  [
    "Z: approval revalidates current ranking, snapshots, supersedes, and rollback resyncs",
    factTransitionActions.includes("listFactKeyConflictsForReview") &&
      factTransitionActions.includes("fact_transition_candidate_is_stale") &&
      factTransitionActions.includes('eventType: "z_snapshot"') &&
    factTransitionActions.includes("markMemorySupersededSynced") &&
      memoryState.includes('expectedStatus: "active"') &&
      memoryState.includes("requireUnpinned: true") &&
      factTransitionActions.includes('status: "active"') &&
      factTransitionActions.includes("syncMemoryVector") &&
      factTransitionActions.includes('eventType: "z_rollback"'),
  ],
  [
    "Z: compatibility debug approval delegates to the same candidate use case",
    files.debug.includes("scanFactTransitionReviewCandidates") &&
      files.debug.includes("approveFactTransitionCandidate") &&
      !files.debug.includes("markMemorySupersededSynced"),
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
      metabolismActions.includes("rollbackMemoryCandidate") &&
      candidateDb.includes("status = 'rolled_back'") &&
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
      recallApi.includes("recordRecallSignals") &&
      recallApi.includes('source: "api_context"') &&
      recallApi.includes("ctx.waitUntil") &&
      recallSignals.includes("memory_recall_receipts") &&
      recallSignalMigration.includes("memory_recall_daily") &&
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
      injection.includes("recordRecallSignals") &&
      injection.includes('source: "gateway_injection"'),
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
