// Audit for the legacy relation backfill type-filter contract.
// Calls the REAL production functions from src/memory/legacyRelations.ts:
//   - parseLegacyRelationRequest (request validation, shared with handler)
//   - filterLegacyProposals (pure filter)
//   - runLegacyRelationBackfill (full flow with mock D1)
// This file is the esbuild entry point; run via:
//   node scripts/run-legacy-relations-audit.mjs

import assert from "node:assert/strict";
import {
  parseLegacyRelationRequest,
  isLegacyRelationRequestError,
  filterLegacyProposals,
  runLegacyRelationBackfill,
  LEGACY_RELATION_TYPES
} from "../src/memory/legacyRelations.ts";

const syncChecks = [];
const asyncChecks = [];

function check(name, fn) {
  syncChecks.push({ name, fn });
}
function checkAsync(name, fn) {
  asyncChecks.push({ name, fn });
}

// --- proposal fixtures matching the handoff dry-run snapshot (772 total) ---
function sampleProposals() {
  const out = [];
  for (let i = 0; i < 9; i++) out.push({ source_id: `s${i}`, target_id: `t${i}`, relation_type: "same_fact_key", strength: 0.92, reason: "legacy-backfill:same fact_key" });
  for (let i = 0; i < 631; i++) out.push({ source_id: `is${i}`, target_id: `it${i}`, relation_type: "in_thread", strength: 0.75, reason: "legacy-backfill:thread" });
  for (let i = 0; i < 132; i++) out.push({ source_id: `os${i}`, target_id: `ot${i}`, relation_type: "origin_split", strength: 0.9, reason: "legacy-backfill:shared source" });
  return out; // 772
}
const ALL = sampleProposals();

// ===================== Part 0: parseLegacyRelationRequest (real validation) =====================

// unknown type -> 400
check("req. unknown type -> 400", () => {
  const r = parseLegacyRelationRequest({ apply: false, relation_types: ["bogus_type"] });
  assert.ok(isLegacyRelationRequestError(r));
  assert.equal(r.status, 400);
  assert.equal(r.code, "unknown_relation_type");
  assert.ok(r.allowed.includes("same_fact_key"));
});

// non-string item -> 400
check("req. non-string item -> 400", () => {
  const r = parseLegacyRelationRequest({ apply: false, relation_types: ["same_fact_key", 42] });
  assert.ok(isLegacyRelationRequestError(r));
  assert.equal(r.status, 400);
  assert.equal(r.code, "invalid_relation_types");
});

// apply=true no types -> 400
check("req. apply=true no types -> 400", () => {
  const r = parseLegacyRelationRequest({ apply: true });
  assert.ok(isLegacyRelationRequestError(r));
  assert.equal(r.status, 400);
  assert.equal(r.code, "apply_requires_relation_types");
});

// apply=true empty array -> 400
check("req. apply=true empty array -> 400", () => {
  const r = parseLegacyRelationRequest({ apply: true, relation_types: [] });
  assert.ok(isLegacyRelationRequestError(r));
  assert.equal(r.status, 400);
  assert.equal(r.code, "apply_requires_relation_types");
});

// duplicate types -> deduped (valid request)
check("req. duplicate types deduped", () => {
  const r = parseLegacyRelationRequest({ apply: true, relation_types: ["same_fact_key", "same_fact_key", "origin_split"] });
  assert.ok(!isLegacyRelationRequestError(r));
  assert.equal(r.apply, true);
  assert.equal(r.selectedTypes.length, 2);
  assert.ok(r.selectedTypes.includes("same_fact_key"));
  assert.ok(r.selectedTypes.includes("origin_split"));
});

// non-array relation_types -> 400
check("req. non-array relation_types -> 400", () => {
  const r = parseLegacyRelationRequest({ apply: false, relation_types: "same_fact_key" });
  assert.ok(isLegacyRelationRequestError(r));
  assert.equal(r.status, 400);
  assert.equal(r.code, "invalid_relation_types");
});

// dry-run no filter -> valid, empty selectedTypes (preview all)
check("req. dry-run no filter valid", () => {
  const r = parseLegacyRelationRequest({ apply: false });
  assert.ok(!isLegacyRelationRequestError(r));
  assert.equal(r.apply, false);
  assert.equal(r.selectedTypes.length, 0);
  assert.equal(r.namespace, "default");
});

// namespace defaults to "default"
check("req. namespace defaults to default", () => {
  const r = parseLegacyRelationRequest({});
  assert.ok(!isLegacyRelationRequestError(r));
  assert.equal(r.namespace, "default");
});

// ===================== Part 1: filterLegacyProposals (real function) =====================

// 1. dry-run without filter previews all types
check("1. dry-run no filter previews all", () => {
  const r = filterLegacyProposals(ALL, []);
  assert.equal(r.filtered.length, 772);
  assert.equal(r.byType.same_fact_key, 9);
  assert.equal(r.byType.in_thread, 631);
  assert.equal(r.byType.origin_split, 132);
  assert.deepEqual(r.selectedRelationTypes, [...LEGACY_RELATION_TYPES]);
});

// 2. only same_fact_key -> no other types
check("2. only same_fact_key", () => {
  const r = filterLegacyProposals(ALL, ["same_fact_key"]);
  assert.equal(r.filtered.length, 9);
  assert.deepEqual(Object.keys(r.byType), ["same_fact_key"]);
  assert.equal(r.byType.same_fact_key, 9);
  assert.deepEqual(r.selectedRelationTypes, ["same_fact_key"]);
});

// 3. same_fact_key + origin_split -> only those two
check("3. same_fact_key + origin_split", () => {
  const r = filterLegacyProposals(ALL, ["same_fact_key", "origin_split"]);
  assert.equal(r.filtered.length, 141);
  assert.equal(r.byType.same_fact_key, 9);
  assert.equal(r.byType.origin_split, 132);
  assert.equal(r.byType.in_thread, undefined);
  assert.deepEqual(r.selectedRelationTypes, ["same_fact_key", "origin_split"]);
});

// extra. empty array -> preview all (dry-run semantics)
check("extra. empty array previews all", () => {
  const r = filterLegacyProposals(ALL, []);
  assert.equal(r.filtered.length, 772);
});

// ===================== Part 2: runLegacyRelationBackfill (real function, mock D1) =====================

function makeMemoryRow(id, overrides = {}) {
  return {
    id,
    namespace: "default",
    type: "note",
    status: "active",
    content: `memory ${id}`,
    summary: null,
    importance: 0.7,
    confidence: 0.8,
    pinned: 0,
    tags: overrides.tags ?? "[]",
    fact_key: overrides.fact_key ?? null,
    active_fact: overrides.active_fact ?? 1,
    thread: overrides.thread ?? null,
    risk_level: "normal",
    urgency_level: "normal",
    tension_score: 0,
    response_posture: null,
    valence: 0,
    arousal: 0,
    audit_state: null,
    source: "test",
    source_message_ids: overrides.source_message_ids ?? "[]",
    vector_sync_status: "synced",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
    expires_at: null,
    vector_id: null,
    summary_label: null
  };
}

// Mock D1 with unique-key state: INSERT OR IGNORE tracks (source, target, type) keys.
// First insert of a key -> changes:1. Repeat insert of same key -> changes:0.
function makeMockEnv(memories) {
  const inserted = [];
  const seenKeys = new Set();
  const db = {
    prepare(sql) {
      const trimmed = sql.trim().replace(/\s+/g, " ");
      if (trimmed.startsWith("SELECT * FROM memories")) {
        return {
          bind() { return { all: async () => ({ results: memories, success: true }) }; }
        };
      }
      if (trimmed.startsWith("INSERT OR IGNORE INTO memory_relations")) {
        return {
          bind(...args) {
            // args: id, namespace, source, target, type, strength, reason, created_at
            const relKey = `${args[2]}|${args[3]}|${args[4]}`;
            if (seenKeys.has(relKey)) {
              return { run: async () => ({ meta: { changes: 0 }, success: true }) };
            }
            seenKeys.add(relKey);
            inserted.push(args);
            return { run: async () => ({ meta: { changes: 1 }, success: true }) };
          }
        };
      }
      return {
        bind() { return { all: async () => ({ results: [], success: true }), run: async () => ({ meta: { changes: 0 }, success: true }) }; }
      };
    }
  };
  return { DB: db, VECTORIZE: undefined, inserted, seenKeys };
}

const testMemories = [
  makeMemoryRow("m1", { fact_key: "k.safety", created_at: "2026-01-01T00:00:00.000Z" }),
  makeMemoryRow("m2", { fact_key: "k.safety", created_at: "2026-01-02T00:00:00.000Z" }),
  makeMemoryRow("m3", { thread: "safety", created_at: "2026-01-01T00:00:00.000Z" }),
  makeMemoryRow("m4", { thread: "safety", created_at: "2026-01-01T00:00:00.000Z" }),
  makeMemoryRow("m5", { source_message_ids: '["msg_42"]', created_at: "2026-01-01T00:00:00.000Z" }),
  makeMemoryRow("m6", { source_message_ids: '["msg_42"]', created_at: "2026-01-01T00:00:00.000Z" })
];

// 4. apply=true with empty types -> bottom layer throws (does not write)
checkAsync("4. apply with empty types rejected at bottom layer", async () => {
  const env = makeMockEnv(testMemories);
  await assert.rejects(
    () => runLegacyRelationBackfill(env, "default", true, []),
    /apply_requires_relation_types/
  );
  assert.equal(env.inserted.length, 0, "no relations written when guard rejects");
});

// 7. apply=false never writes (even with types selected)
checkAsync("7. apply=false is read-only even with types", async () => {
  const env = makeMockEnv(testMemories);
  const result = await runLegacyRelationBackfill(env, "default", false, ["same_fact_key"]);
  assert.equal(result.inserted, 0);
  assert.equal(env.inserted.length, 0, "no writes on dry-run");
  assert.ok(result.proposed >= 0, "proposals counted but not inserted");
});

// 8. idempotent re-run: SAME mock DB twice, second run inserts nothing
checkAsync("8. idempotent re-run on same DB", async () => {
  const env = makeMockEnv(testMemories);
  const r1 = await runLegacyRelationBackfill(env, "default", true, ["same_fact_key", "origin_split"]);
  assert.ok(r1.inserted > 0, "first run must insert at least one relation");
  const firstInserted = env.inserted.length;
  const r2 = await runLegacyRelationBackfill(env, "default", true, ["same_fact_key", "origin_split"]);
  assert.equal(r2.inserted, 0, "second run must insert nothing (idempotent)");
  assert.equal(env.inserted.length, firstInserted, "mock DB must not record new inserts on re-run");
  assert.equal(r1.proposed, r2.proposed, "proposed count stable");
  assert.deepEqual(r1.by_type, r2.by_type, "by_type stable");
});

// 9. bottom layer guard: apply=true, no types -> throws (covers direct-call risk)
checkAsync("9. bottom layer guard prevents full write", async () => {
  const env = makeMockEnv(testMemories);
  let threw = false;
  try { await runLegacyRelationBackfill(env, "default", true, []); }
  catch (e) { threw = /apply_requires_relation_types/.test(e.message); }
  assert.ok(threw, "must throw apply_requires_relation_types");
  assert.equal(env.inserted.length, 0, "guard must prevent any writes");
});

// 10. apply=true with same_fact_key only -> only same_fact_key written
checkAsync("10. apply same_fact_key only writes same_fact_key", async () => {
  const env = makeMockEnv(testMemories);
  const result = await runLegacyRelationBackfill(env, "default", true, ["same_fact_key"]);
  assert.equal(result.inserted, result.proposed);
  assert.deepEqual(Object.keys(result.by_type), ["same_fact_key"]);
  for (const args of env.inserted) {
    const reason = args[6]; // reason is the 7th bind arg
    assert.ok(String(reason).includes("same fact_key"), `inserted relation must be same_fact_key, got: ${reason}`);
  }
});

// --- run all checks, await async, then report ---
let passed = 0;
let failed = 0;

for (const { name, fn } of syncChecks) {
  try { fn(); console.log(`PASS ${name}`); passed += 1; }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed += 1; }
}

await Promise.all(asyncChecks.map(async ({ name, fn }) => {
  try { await fn(); console.log(`PASS ${name}`); passed += 1; }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed += 1; }
}));

console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${passed} passed)`);
if (failed) process.exitCode = 1;
