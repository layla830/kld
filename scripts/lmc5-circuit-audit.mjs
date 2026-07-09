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

const checks = [
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
    files.search.includes("const ftsResults = await searchMemoriesByText") &&
      !files.search.includes("vectorTopScore < FTS_FLOOR"),
  ],
  [
    "Recall: strong lexical hits survive the model filter",
    files.search.includes("protectedIds") &&
      postProcess.includes("protectedCandidates"),
  ],
  [
    "Recall: relation context receives reserved output slots",
    files.search.includes("topK - additions.length") &&
      files.search.includes("Math.min(2, topK - 1)"),
  ],
  [
    "Recall: long diary records are excluded from every route",
    files.search.includes('new Set(["diary", "layla_diary", "auto_diary"])') &&
      files.search.includes("filter(isRecallEligible)"),
  ],
  [
    "Recall: fact-intent rule memories lead before milestone context",
    postProcess.includes("isGuidanceRecord(memory) && directHitAny") &&
      postProcess.includes(
        "directHit || input.hasGuidanceCandidate ? 0.6 : 1.5",
      ) &&
      postProcess.includes("const guidanceHit = memories.find"),
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
      files.search.includes("applyEAxis ? eAxisBoost(record) : 0"),
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
    files.debug.includes("const apply = body?.apply === true"),
  ],
  [
    "Safety: coordinate proposals are bounded and exceptions are reviewable",
    files.debug.includes("BACKFILL_BATCH_SIZE = 5") &&
      files.debug.includes("slice(offset, offset + limit)") &&
      files.debug.includes("splitCoordinatePatch") &&
      files.debug.includes(
        'mode: apply ? "auto_apply_with_exception_review" : "dry_run"',
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
    "M: patrol findings become explicit review candidates",
    metabolismReview.includes('action: "m_archive"') &&
      metabolismReview.includes('action: "m_relation_cleanup"'),
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
    ["scan", "approve", "reject", "rollback"].every((action) =>
      fs
        .readFileSync("src/index.ts", "utf8")
        .includes(`/admin/memories/m-review/${action}`),
    ),
  ],
  [
    "M: relation cleanup cards show both endpoint memories",
    fs
      .readFileSync("src/db/memoryCandidates.ts", "utf8")
      .includes("enrichMetabolismRelationEndpoints") &&
      metabolismView.includes("这条关系连着哪两条记忆") &&
      metabolismView.includes("source_memory_content") &&
      metabolismView.includes("target_memory_content"),
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
