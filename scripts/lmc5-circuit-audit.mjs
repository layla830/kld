import fs from "node:fs";

const files = {
  chunk: fs.readFileSync("src/memory/chunkPersistence.ts", "utf8"),
  digest: fs.readFileSync("src/memory/dailyDigest.ts", "utf8"),
  relations: fs.readFileSync("src/db/memoryRelations.ts", "utf8"),
  search: fs.readFileSync("src/memory/search.ts", "utf8"),
  xyzem: fs.readFileSync("src/memory/xyzem.ts", "utf8")
};

const checks = [
  ["X: chunks receive a deterministic timeline thread", files.chunk.includes("thread = `timeline:") && files.chunk.includes("thread,")],
  ["Y: recall expands two hops with strength thresholds", files.relations.includes("for (const depth of [1, 2])") && files.relations.includes("relation.strength < 0.7")],
  ["Y: review-only relations are excluded from safe expansion", files.relations.includes("REVIEW_RELATION_TYPES") && files.relations.includes("SAFE_RELATION_TYPES.has(relation.relation_type)")],
  ["Z/M: dream mutations are review-first", files.digest.includes('eventType: "dream_mutation_review"') && !files.digest.includes("async function applyMemoryUpdates")],
  ["E: shadow gate controls ranking", files.search.includes("shouldApplyEAxisToRanking(env)") && files.search.includes("applyEAxis ? eAxisBoost(record) : 0")],
  ["Night: Y runs before Z and M", files.xyzem.indexOf("const relations = await runRelationBuild") < files.xyzem.indexOf("const zAudit = await runZAudit") && files.xyzem.indexOf("const zAudit = await runZAudit") < files.xyzem.indexOf("const patrol = await runMetabolismPatrol")]
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed += 1;
}

if (failed) process.exitCode = 1;

