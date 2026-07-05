import fs from "node:fs";

const files = {
  chunk: fs.readFileSync("src/memory/chunkPersistence.ts", "utf8"),
  digest: fs.readFileSync("src/memory/dailyDigest.ts", "utf8"),
  relations: fs.readFileSync("src/db/memoryRelations.ts", "utf8"),
  search: fs.readFileSync("src/memory/search.ts", "utf8"),
  xyzem: fs.readFileSync("src/memory/xyzem.ts", "utf8"),
  debug: fs.readFileSync("src/api/debug.ts", "utf8"),
  narrative: fs.readFileSync("src/memory/narrativeTimeline.ts", "utf8")
};

const timelineBackfill = fs.readFileSync("src/memory/timelineBackfill.ts", "utf8");

const checks = [
  ["X: chunks receive a deterministic timeline thread", files.chunk.includes("thread = `timeline:") && files.chunk.includes("thread,")],
  ["X: legacy timeline dry-run requires explicit full dates", timelineBackfill.includes("extractExplicitDates") && timelineBackfill.includes("dates.length > 1") && files.debug.includes("timeline_backfill_apply_not_enabled")],
  ["X: review records are excluded from timeline proposals", timelineBackfill.includes("type != 'dream_review'")],
  ["X: temporal proposals require the same thread and fact", timelineBackfill.includes("byFact") && timelineBackfill.includes("proposal.fact_key") && timelineBackfill.includes("source_date") && timelineBackfill.includes("target_date")],
  ["Y: recall expands two hops with strength thresholds", files.relations.includes("for (const depth of [1, 2])") && files.relations.includes("relation.strength < 0.7")],
  ["Y: review-only relations are excluded from safe expansion", files.relations.includes("REVIEW_RELATION_TYPES") && files.relations.includes("SAFE_RELATION_TYPES.has(relation.relation_type)")],
  ["Z/M: dream mutations are review-first", files.digest.includes('eventType: "dream_mutation_review"') && !files.digest.includes("async function applyMemoryUpdates")],
  ["Z: fact keys are proposed as reviewable groups", fs.readFileSync("src/memory/factGroups.ts", "utf8").includes('action:"fact_group"') && fs.readFileSync("src/api/adminBoard/candidateActions.ts", "utf8").includes('candidate.action === "fact_group"')],
  ["E: shadow gate controls ranking", files.search.includes("shouldApplyEAxisToRanking(env)") && files.search.includes("applyEAxis ? eAxisBoost(record) : 0")],
  ["Night: Y runs before Z and M", files.xyzem.indexOf("const relations = await runRelationBuild") < files.xyzem.indexOf("const zAudit = await runZAudit") && files.xyzem.indexOf("const zAudit = await runZAudit") < files.xyzem.indexOf("const patrol = await runMetabolismPatrol")],
  ["Safety: coordinate backfill apply=false is read-only", files.debug.includes("const apply = body?.apply === true")],
  ["Safety: coordinate proposals are bounded and exceptions are reviewable", files.debug.includes("BACKFILL_BATCH_SIZE = 5") && files.debug.includes("slice(offset, offset + limit)") && files.debug.includes("splitCoordinatePatch") && files.debug.includes('mode: apply ? "auto_apply_with_exception_review" : "dry_run"')],
  ["Cron: coordinate backfill is isolated from daily maintenance", files.debug.includes("runScheduledCoordinateBackfill") && fs.readFileSync("src/index.ts", "utf8").includes('controller.cron === "*/5 * * * *"')],
  ["Cron: coordinate backfill has persisted pause control", fs.readFileSync("src/index.ts", "utf8").includes("getCoordinateBackfillControl") && fs.readFileSync("src/api/adminBoard.ts", "utf8").includes("coordinate-backfill/toggle")],
  ["Safety: XYZEM dry-run does not persist audit events", files.xyzem.includes("runZAudit(env, namespace, { dryRun: options.dryRun })") && files.xyzem.includes("runMetabolismPatrol(env, namespace, { dryRun: options.dryRun })")],
  ["Identity: narratives use explicit third-person subjects", files.narrative.includes("用户（Layla）") && files.narrative.includes("KLD") && !files.narrative.includes("我=助手")]
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
}

if (failed) process.exitCode = 1;

