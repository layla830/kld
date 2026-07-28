import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertReadOnlyAuditQueries,
  buildInactiveFiveAxisAuditQueries,
  buildInactiveFiveAxisAuditReport
} from "../scripts/inactive-five-axis-audit.mjs";
import {
  assertReadOnlyRepairQuery,
  buildRepairApplyQuery,
  buildRepairDryRunQuery
} from "../scripts/inactive-five-axis-repair.mjs";
import { createMemory } from "../src/db/memories";
import type { MemoryRecord } from "../src/types";

async function runAudit(namespace: string) {
  const queries = buildInactiveFiveAxisAuditQueries({ namespace, staleHours: 24 });
  assertReadOnlyAuditQueries(queries);
  const rowsByName: Record<string, Array<Record<string, unknown>>> = {};
  for (const query of queries) {
    const result = await env.DB.prepare(query.sql).all<Record<string, unknown>>();
    rowsByName[query.name] = result.results ?? [];
  }
  return buildInactiveFiveAxisAuditReport({
    namespace,
    queries,
    rowsByName,
    generatedAt: "2026-07-26T00:00:00.000Z"
  });
}

async function tableCounts(namespace: string): Promise<Record<string, number>> {
  const tables = [
    "memories",
    "memory_relations",
    "memory_timeline_memberships",
    "memory_diary_timeline_memberships",
    "memory_five_axis_outbox",
    "memory_five_axis_runs",
    "memory_candidates",
    "memory_candidate_dependencies",
    "memory_deprojections"
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE namespace = ?`
    ).bind(namespace).first<{ count: number }>();
    counts[table] = row?.count ?? 0;
  }
  return counts;
}

describe("read-only inactive five-axis audit", () => {
  it("executes real D1 queries for every drift class without exposing memory content", async () => {
    const namespace = `inactive-audit-${crypto.randomUUID()}`;
    const privateMarker = `PRIVATE-CONTENT-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const eligible = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: `eligible ${privateMarker}`,
      status: "active"
    });
    const ineligible = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: `ineligible ${privateMarker}`,
      status: "active"
    });
    const failedVector = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: `failed vector ${privateMarker}`,
      status: "active"
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE memories
         SET vector_sync_status = 'deleted', vector_synced = 0
         WHERE namespace = ? AND id = ?`
      ).bind(namespace, eligible.id),
      env.DB.prepare(
        `UPDATE memories
         SET vector_sync_status = 'synced', vector_synced = 1
         WHERE namespace = ? AND id = ?`
      ).bind(namespace, ineligible.id),
      env.DB.prepare(
        `UPDATE memories
         SET vector_sync_status = 'failed', vector_synced = 0
         WHERE namespace = ? AND id = ?`
      ).bind(namespace, failedVector.id),
      env.DB.prepare(
        `INSERT INTO memory_relations (
           id, namespace, source_memory_id, target_memory_id,
           relation_type, strength, reason, created_at
         ) VALUES (?, ?, ?, ?, 'same_topic', 0.9, 'audit fixture', ?)`
      ).bind(`rel_${crypto.randomUUID()}`, namespace, ineligible.id, eligible.id, now),
      env.DB.prepare(
        `INSERT INTO memory_timeline_memberships (
           namespace, memory_id, thread, fact_key, updated_at
         ) VALUES (?, ?, 'audit', 'audit.fact', ?)`
      ).bind(namespace, ineligible.id, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_outbox (
           namespace, memory_id, memory_updated_at, memory_revision,
           status, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
      ).bind(
        namespace,
        ineligible.id,
        ineligible.updated_at,
        ineligible.five_axis_revision ?? 1,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, 'X', 'running', 1, NULL, NULL, 'audit-lease', ?, ?, NULL, ?)`
      ).bind(
        namespace,
        ineligible.id,
        (ineligible.five_axis_revision ?? 1) + 1,
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_candidates (
           id, namespace, external_key, dream_date, action, subject, target_id,
           payload_json, source_chunk_ids_json, source_chunks_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, '2026-07-26', 'update', NULL, ?, '{}', '[]', '[]', 'pending', ?, ?)`
      ).bind(
        `candidate_${crypto.randomUUID()}`,
        namespace,
        `audit-candidate:${crypto.randomUUID()}`,
        ineligible.id,
        now,
        now
      )
    ]);
    const candidate = await env.DB.prepare(
      `SELECT external_key FROM memory_candidates
       WHERE namespace = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(namespace).first<{ external_key: string }>();
    if (!candidate) throw new Error("candidate fixture missing");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_candidate_dependencies (
           namespace, candidate_external_key, memory_id, role
         ) VALUES (?, ?, ?, 'target')`
      ).bind(namespace, candidate.external_key, ineligible.id),
      env.DB.prepare(
        `INSERT INTO memory_deprojections (
           operation_id, namespace, memory_id, source, reason,
           intent_fingerprint, transition,
           previous_status, next_status, previous_type, next_type,
           previous_active_fact, next_active_fact,
           previous_revision, current_revision, created_at
         ) VALUES (
           ?, ?, ?, 'system', 'audit fixture',
           ?, 'eligible_to_ineligible',
           'active', 'deleted', 'note', 'note',
           1, 0, 1, 2, ?
         )`
      ).bind(
        `deproj_${crypto.randomUUID()}`,
        namespace,
        eligible.id,
        "a".repeat(64),
        now
      )
    ]);

    const before = await tableCounts(namespace);
    const report = await runAudit(namespace);
    const after = await tableCounts(namespace);
    expect(after).toEqual(before);
    expect(report.clean).toBe(false);
    expect(report.sections.relations[0]).toMatchObject({
      relation_rows: 1,
      both_endpoints_ineligible: 0,
      source_only_ineligible: 1,
      target_only_ineligible: 0,
      distinct_memories: 1
    });
    expect(report.sections.timeline[0]).toMatchObject({ membership_rows: 1 });
    expect(report.sections.outbox[0]).toMatchObject({ status: "pending", count: 1 });
    expect(report.sections.axis_runs[0]).toMatchObject({
      axis_run_drift_rows: 1,
      ineligible_non_terminal: 1,
      stale_running_active_lease: 0,
      stale_revision_runs: 0,
      future_revision_anomalies: 1,
      stale_running_expired_repairable: 0
    });
    expect(report.sections.candidate_dependencies[0]).toMatchObject({
      action: "update",
      role: "target",
      count: 1
    });
    expect(report.sections.vector_state[0]).toMatchObject({
      needs_upsert: 0,
      needs_delete: 1,
      unique_vector_drift_memories: 1,
      vector_drift_rows: 3,
      eligible_marked_deleted: 1,
      ineligible_marked_synced: 1,
      ineligible_vector_synced: 1,
      failed_vector_states: 1
    });
    expect(report.sections.deprojection_operations[0]).toMatchObject({
      unfinished: 1,
      revision_anomalies: 1
    });
    const output = JSON.stringify(report);
    expect(output).not.toContain(privateMarker);
    expect(output).not.toContain("content");
    expect(output).not.toContain("summary");
  });

  it("reports a clean namespace as clean", async () => {
    const report = await runAudit(`inactive-audit-clean-${crypto.randomUUID()}`);
    expect(report.clean).toBe(true);
    expect(report.drift_count).toBe(0);
    expect(report.sections.deprojection_operations[0]).toMatchObject({
      unfinished: 0,
      invalid_completed: 0,
      revision_anomalies: 0,
      duplicate_successes: 0
    });
  });

  it("separates actionable orphans from retained historical references", async () => {
    const namespace = `retention-orphan-audit-${crypto.randomUUID()}`;
    const missingMemoryId = `missing_${crypto.randomUUID()}`;
    const candidateKey = `orphan-candidate:${crypto.randomUUID()}`;
    const pendingMemoryId = `pending_${crypto.randomUUID()}`;
    const pendingCandidateKey = `pending-orphan-candidate:${crypto.randomUUID()}`;
    const now = "2026-07-28T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_relations (
           id, namespace, source_memory_id, target_memory_id,
           relation_type, strength, reason, created_at
         ) VALUES (?, ?, ?, ?, 'same_topic', 1, 'orphan fixture', ?)`
      ).bind(
        `relation_${crypto.randomUUID()}`,
        namespace,
        missingMemoryId,
        `also_${missingMemoryId}`,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_timeline_memberships (
           namespace, memory_id, thread, fact_key, updated_at
         ) VALUES (?, ?, 'orphan', 'orphan.fact', ?)`
      ).bind(namespace, missingMemoryId, now),
      env.DB.prepare(
        `INSERT INTO memory_diary_timeline_memberships (
           namespace, memory_id, origin_diary_id, timeline_key,
           event_date, role, day_memory_id, updated_at
         ) VALUES (?, ?, ?, 'orphan:test', '2026-07-28', 'item', ?, ?)`
      ).bind(namespace, missingMemoryId, missingMemoryId, missingMemoryId, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_outbox (
           namespace, memory_id, memory_updated_at, memory_revision,
           status, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'skipped', 0, ?, ?)`
      ).bind(namespace, missingMemoryId, now, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts, updated_at
         ) VALUES (?, ?, 1, 'X', 'skipped', 0, ?)`
      ).bind(namespace, missingMemoryId, now),
      env.DB.prepare(
        `INSERT INTO memory_candidates (
           id, namespace, external_key, dream_date, action, target_id,
           payload_json, source_chunk_ids_json, source_chunks_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, '2026-07-28', 'update', ?, '{}', '[]', '[]', 'rejected', ?, ?)`
      ).bind(
        `candidate_${crypto.randomUUID()}`,
        namespace,
        candidateKey,
        missingMemoryId,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_candidates (
           id, namespace, external_key, dream_date, action, target_id,
           payload_json, source_chunk_ids_json, source_chunks_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, '2026-07-28', 'update', ?, '{}', '[]', '[]', 'pending', ?, ?)`
      ).bind(
        `candidate_${crypto.randomUUID()}`,
        namespace,
        pendingCandidateKey,
        pendingMemoryId,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_metabolism_signal_state (
           namespace, memory_id, policy_key, band, payload_json,
           first_observed_at, updated_at
         ) VALUES (?, ?, 'orphan', 'cooled_after_use', '{}', ?, ?)`
      ).bind(namespace, missingMemoryId, now, now),
      env.DB.prepare(
        `INSERT INTO memory_recall_receipts (
           namespace, operation_id, memory_id, source,
           recall_day, recalled_at, created_at
         ) VALUES (?, ?, ?, 'api_context', '2026-07-28', ?, ?)`
      ).bind(namespace, `recall_${crypto.randomUUID()}`, missingMemoryId, now, now),
      env.DB.prepare(
        `INSERT INTO memory_events (
           id, namespace, event_type, memory_id, payload_json, created_at
         ) VALUES (?, ?, 'orphan_fixture', ?, '{}', ?)`
      ).bind(`event_${crypto.randomUUID()}`, namespace, missingMemoryId, now),
      env.DB.prepare(
        `INSERT INTO memory_deprojections (
           operation_id, namespace, memory_id, source, reason,
           intent_fingerprint, transition,
           previous_status, next_status, previous_type, next_type,
           previous_active_fact, next_active_fact,
           previous_revision, current_revision, created_at
         ) VALUES (
           ?, ?, ?, 'system', 'orphan fixture',
           ?, 'eligible_to_ineligible',
           'active', 'deleted', 'note', 'note',
           1, 0, 1, 2, ?
         )`
      ).bind(
        `deprojection_${crypto.randomUUID()}`,
        namespace,
        missingMemoryId,
        "b".repeat(64),
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_deprojections (
           operation_id, namespace, memory_id, source, reason,
           intent_fingerprint, transition,
           previous_status, next_status, previous_type, next_type,
           previous_active_fact, next_active_fact,
           previous_revision, current_revision,
           invariants_verified, created_at, completed_at
         ) VALUES (
           ?, ?, ?, 'system', 'completed orphan fixture',
           ?, 'eligible_to_ineligible',
           'active', 'deleted', 'note', 'note',
           1, 0, 2, 3, 1, ?, ?
         )`
      ).bind(
        `deprojection_${crypto.randomUUID()}`,
        namespace,
        missingMemoryId,
        "c".repeat(64),
        now,
        now
      )
    ]);
    await env.DB.prepare(
      `INSERT INTO memory_candidate_dependencies (
         namespace, candidate_external_key, memory_id, role
       ) VALUES (?, ?, ?, 'target')`
    ).bind(namespace, candidateKey, missingMemoryId).run();
    await env.DB.prepare(
      `INSERT INTO memory_candidate_dependencies (
         namespace, candidate_external_key, memory_id, role
       ) VALUES (?, ?, ?, 'target')`
    ).bind(namespace, pendingCandidateKey, pendingMemoryId).run();

    const report = await runAudit(namespace);
    expect(report.sections.retention_orphans[0]).toMatchObject({
      orphan_relations: 1,
      orphan_timeline_memberships: 1,
      orphan_diary_timeline_memberships: 1,
      orphan_outbox_rows: 1,
      orphan_axis_runs: 1,
      orphan_candidate_axis_run_links: 0,
      actionable_candidate_dependency_rows: 1,
      historical_candidate_dependency_rows: 1,
      actionable_candidate_rows: 1,
      historical_candidate_rows: 1,
      distinct_actionable_candidates: 1,
      distinct_historical_candidates: 1,
      orphan_metabolism_signal_states: 1,
      orphan_recall_daily_rows: 1,
      orphan_recall_receipts: 1,
      historical_memory_event_rows: 1,
      actionable_deprojection_rows: 1,
      historical_deprojection_rows: 1,
      actionable_rows: 11,
      historical_rows: 4
    });
    expect(report.drift_count).toBe(11);
  });

  it("classifies relation provenance without double-counting stale unproven rows", async () => {
    const namespace = `relation-provenance-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const eligibleSource = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "eligible source",
      status: "active"
    });
    const ineligibleSource = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "ineligible source",
      status: "active"
    });
    const reasons: Array<string | null> = [
      "diary_day:origin:2026-07-27",
      "y-review:approved:candidate:key",
      "fact-group:approved:candidate:key",
      "y:auto:mem_source:7",
      "dream:auto:2026-07-27",
      "api:memory-write:chatbox",
      "legacy-backfill:thread old",
      null,
      "",
      "free-text explanation"
    ];
    const targets: MemoryRecord[] = [];
    for (let index = 0; index < reasons.length; index += 1) {
      targets.push(await createMemory(env.DB, {
        namespace,
        type: "note",
        content: `target ${index}`,
        status: "active"
      }));
    }
    await env.DB.batch(reasons.map((reason, index) => env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id,
         relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, ?, ?)`
    ).bind(
      `rel_${crypto.randomUUID()}`,
      namespace,
      index === 7 ? ineligibleSource.id : eligibleSource.id,
      targets[index].id,
      reason,
      now
    )));

    const report = await runAudit(namespace);

    expect(report.sections.relations[0]).toMatchObject({ relation_rows: 1 });
    expect(report.sections.relation_provenance[0]).toMatchObject({
      relation_rows: 10,
      deterministic_rebuildable: 1,
      human_reviewed: 2,
      builder_backed: 2,
      api_written: 1,
      legacy_backfill: 1,
      unproven_source: 3,
      stale_rows: 1,
      stale_unproven_source: 1,
      eligible_unproven_source: 2
    });
    expect(report.drift_count).toBe(3);
  });

  it("counts only an excluded original diary as valid provenance", async () => {
    const namespace = `inactive-audit-diary-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const origin = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "origin diary",
      status: "active"
    });
    const wrongOrigin = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "not an origin diary",
      status: "active"
    });
    const dreamReviewOrigin = await createMemory(env.DB, {
      namespace,
      type: "dream_review",
      content: "review proposal, not an origin diary",
      status: "active"
    });
    const day = await createMemory(env.DB, {
      namespace,
      type: "timeline_day",
      content: "eligible day",
      status: "active"
    });
    const ineligibleDay = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "ineligible day",
      status: "active"
    });
    const cleanMember = await createMemory(env.DB, {
      namespace,
      type: "timeline_item",
      content: "clean member",
      status: "active"
    });
    const wrongOriginMember = await createMemory(env.DB, {
      namespace,
      type: "timeline_item",
      content: "wrong origin member",
      status: "active"
    });
    const dreamReviewOriginMember = await createMemory(env.DB, {
      namespace,
      type: "timeline_item",
      content: "dream review origin member",
      status: "active"
    });
    const ineligibleMember = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "ineligible member",
      status: "active"
    });
    const badDayMember = await createMemory(env.DB, {
      namespace,
      type: "timeline_item",
      content: "bad day member",
      status: "active"
    });
    await env.DB.batch([
      [cleanMember.id, origin.id, day.id],
      [wrongOriginMember.id, wrongOrigin.id, day.id],
      [dreamReviewOriginMember.id, dreamReviewOrigin.id, day.id],
      [ineligibleMember.id, origin.id, day.id],
      [badDayMember.id, origin.id, ineligibleDay.id]
    ].map(([memoryId, originDiaryId, dayMemoryId]) => env.DB.prepare(
      `INSERT INTO memory_diary_timeline_memberships (
         namespace, memory_id, origin_diary_id, timeline_key,
         event_date, role, day_memory_id, updated_at
       ) VALUES (?, ?, ?, 'diary:test', '2026-07-26', 'item', ?, ?)`
    ).bind(namespace, memoryId, originDiaryId, dayMemoryId, now)));

    const report = await runAudit(namespace);
    expect(report.sections.timeline[0]).toMatchObject({
      membership_rows: 0,
      diary_drift_rows: 4,
      diary_member_drift_rows: 1,
      diary_day_drift_rows: 1,
      invalid_origin_diary_rows: 2,
      origin_diary_provenance_rows: 1
    });
  });
});

async function executeRepairQuery(query: { sql: string }) {
  return env.DB.prepare(query.sql).all<Record<string, unknown>>();
}

describe("bounded inactive five-axis D1 repair", () => {
  it("repairs stale failed and strictly expired running runs across axes", async () => {
    const namespace = `inactive-repair-runs-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const active = new Date(Date.now() + 60_000).toISOString();
    const failedMemory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "failed stale run",
      status: "active"
    });
    const expiredMemory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "expired stale run",
      status: "active"
    });
    const activeMemory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "active stale run",
      status: "active"
    });
    const missingLeaseMemory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "running with no lease",
      status: "active"
    });
    const missingTokenMemory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "running with no claim token",
      status: "active"
    });
    const linkedMemory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "candidate linked stale run",
      status: "active"
    });
    await env.DB.batch([
      failedMemory,
      expiredMemory,
      activeMemory,
      missingLeaseMemory,
      missingTokenMemory,
      linkedMemory
    ].map((memory) => env.DB.prepare(
      "UPDATE memories SET five_axis_revision = 2 WHERE namespace = ? AND id = ?"
    ).bind(namespace, memory.id)));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 1, 'X', 'failed', 1, NULL, 'old failure', NULL, NULL, ?, ?, ?)`
      ).bind(namespace, failedMemory.id, now, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 1, 'E', 'running', 1, NULL, NULL, 'expired-claim', ?, ?, NULL, ?)`
      ).bind(namespace, expiredMemory.id, expired, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 1, 'Y', 'running', 1, NULL, NULL, 'active-claim', ?, ?, NULL, ?)`
      ).bind(namespace, activeMemory.id, active, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 1, 'Y', 'running', 1, NULL, NULL, 'missing-lease-claim', NULL, ?, NULL, ?)`
      ).bind(namespace, missingLeaseMemory.id, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 1, 'Y', 'running', 1, NULL, NULL, NULL, ?, ?, NULL, ?)`
      ).bind(namespace, missingTokenMemory.id, expired, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 1, 'Y', 'failed', 1, NULL, 'linked failure', NULL, NULL, ?, ?, ?)`
      ).bind(namespace, linkedMemory.id, now, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 2, 'X', 'failed', 1, NULL, 'claim residue',
           'orphan-claim', NULL, ?, ?, ?)`
      ).bind(namespace, activeMemory.id, now, now, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 2, 'M', 'failed', 1, NULL, 'lease residue',
           NULL, ?, ?, ?, ?)`
      ).bind(namespace, activeMemory.id, active, now, now, now)
    ]);
    const candidateId = `candidate_${crypto.randomUUID()}`;
    const candidateKey = `repair-run-linked:${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_candidates (
           id, namespace, external_key, dream_date, action, subject, target_id,
           payload_json, source_chunk_ids_json, source_chunks_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, '2026-07-26', 'y_relation_review', NULL, NULL,
           '{}', '[]', '[]', 'pending', ?, ?)`
      ).bind(candidateId, namespace, candidateKey, now, now),
      env.DB.prepare(
        `INSERT INTO memory_candidate_axis_runs (
           namespace, candidate_external_key, memory_id, memory_revision, axis, created_at
         ) VALUES (?, ?, ?, 1, 'Y', ?)`
      ).bind(namespace, candidateKey, linkedMemory.id, now)
    ]);

    const audit = await runAudit(namespace);
    expect(audit.sections.axis_runs[0]).toMatchObject({
      axis_run_drift_rows: 7,
      stale_running_active_lease: 1,
      stale_revision_runs: 6,
      stale_failed_repairable: 1,
      stale_running_expired_repairable: 1,
      candidate_linked_stale_runs: 1,
      ownership_anomalies: 4,
      running_missing_claim_token: 1,
      running_missing_lease: 1,
      non_running_claim_token_residue: 1,
      non_running_lease_residue: 1
    });

    const dryRun = buildRepairDryRunQuery({ namespace, limit: 100 });
    expect(() => assertReadOnlyRepairQuery(dryRun)).not.toThrow();
    await expect(executeRepairQuery(dryRun)).resolves.toMatchObject({
      results: [{
        repairable_rows: 2,
        failed_rows: 1,
        expired_running_rows: 1,
        selected: 2,
        has_more: 0
      }]
    });

    const applied = await executeRepairQuery(
      buildRepairApplyQuery({ namespace, limit: 100 })
    );
    expect(applied.results).toHaveLength(2);
    expect(applied.meta.changes).toBe(2);
    const rows = await env.DB.prepare(
      `SELECT memory_id, status, result_json, claim_token, lease_expires_at
       FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_revision = 1 ORDER BY memory_id`
    ).bind(namespace).all<Record<string, unknown>>();
    const byMemory = new Map((rows.results ?? []).map((row) => [row.memory_id, row]));
    expect(byMemory.get(failedMemory.id)).toMatchObject({
      status: "skipped",
      claim_token: null,
      lease_expires_at: null
    });
    const failedResult = JSON.parse(String(byMemory.get(failedMemory.id)?.result_json));
    expect(failedResult).toMatchObject({
      reason: "superseded_by_newer_memory_revision",
      previous_revision: 1,
      current_revision: 2
    });
    expect(failedResult).not.toHaveProperty("repair");
    expect(byMemory.get(expiredMemory.id)).toMatchObject({
      status: "skipped",
      claim_token: null,
      lease_expires_at: null
    });
    expect(byMemory.get(activeMemory.id)).toMatchObject({
      status: "running",
      claim_token: "active-claim"
    });
    expect(byMemory.get(missingLeaseMemory.id)).toMatchObject({
      status: "running",
      claim_token: "missing-lease-claim",
      lease_expires_at: null
    });
    expect(byMemory.get(missingTokenMemory.id)).toMatchObject({
      status: "running",
      claim_token: null,
      lease_expires_at: expired
    });
    expect(byMemory.get(linkedMemory.id)).toMatchObject({ status: "failed" });
  });

  it("counts stale operational candidates once with an action breakdown", async () => {
    const namespace = `inactive-candidate-audit-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const [source, target, archive] = await Promise.all([
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "stale candidate source",
        status: "active"
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "stale candidate target",
        status: "active"
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "stale archive target",
        status: "active"
      })
    ]);
    const fixtures = [
      {
        id: `candidate_${crypto.randomUUID()}`,
        key: `y-review:${crypto.randomUUID()}`,
        action: "y_relation_review",
        targetId: target.id,
        payload: {
          relation_type: "supports",
          source_id: source.id,
          target_id: target.id,
          source_revision: source.five_axis_revision ?? 1,
          target_revision: target.five_axis_revision ?? 1,
          source_updated_at: source.updated_at,
          target_updated_at: target.updated_at
        },
        dependencies: [
          { memoryId: source.id, role: "source" },
          { memoryId: target.id, role: "target" }
        ]
      },
      {
        id: `candidate_${crypto.randomUUID()}`,
        key: `z-review:${crypto.randomUUID()}`,
        action: "z_supersede",
        targetId: target.id,
        payload: {
          fact_key: "audit:stale-z",
          best: { id: source.id, updated_at: "2020-01-01T00:00:00.000Z" },
          weaker: { id: target.id, updated_at: target.updated_at }
        },
        dependencies: [
          { memoryId: source.id, role: "source" },
          { memoryId: target.id, role: "target" }
        ]
      },
      {
        id: `candidate_${crypto.randomUUID()}`,
        key: `m-review:${crypto.randomUUID()}`,
        action: "m_archive",
        targetId: archive.id,
        payload: {
          before: { id: archive.id, updated_at: "2020-01-01T00:00:00.000Z" }
        },
        dependencies: [
          { memoryId: archive.id, role: "target" }
        ]
      }
    ];
    for (const fixture of fixtures) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO memory_candidates (
             id, namespace, external_key, dream_date, action, subject, target_id,
             payload_json, source_chunk_ids_json, source_chunks_json,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, '2026-07-28', ?, 'system', ?, ?, '[]', '[]',
             'pending', ?, ?)`
        ).bind(
          fixture.id,
          namespace,
          fixture.key,
          fixture.action,
          fixture.targetId,
          JSON.stringify(fixture.payload),
          now,
          now
        ),
        ...fixture.dependencies.map((dependency) => env.DB.prepare(
          `INSERT INTO memory_candidate_dependencies (
             namespace, candidate_external_key, memory_id, role
           ) VALUES (?, ?, ?, ?)`
        ).bind(namespace, fixture.key, dependency.memoryId, dependency.role))
      ]);
    }
    const sourceRevision = source.five_axis_revision ?? 1;
    const yCandidate = fixtures[0];
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE memories
         SET five_axis_revision = ?
         WHERE namespace = ? AND id = ?`
      ).bind(sourceRevision + 1, namespace, source.id),
      env.DB.prepare(
        `UPDATE memories
         SET five_axis_revision = five_axis_revision + 1
         WHERE namespace = ? AND id = ?`
      ).bind(namespace, target.id),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, 'Y', 'pending_review', 1, NULL, NULL, NULL, NULL,
           ?, NULL, ?)`
      ).bind(namespace, source.id, sourceRevision, now, now),
      env.DB.prepare(
        `INSERT INTO memory_candidate_axis_runs (
           namespace, candidate_external_key, memory_id, memory_revision, axis, created_at
         ) VALUES (?, ?, ?, ?, 'Y', ?)`
      ).bind(namespace, yCandidate.key, source.id, sourceRevision, now)
    ]);

    const audit = await runAudit(namespace);
    expect(audit.sections.axis_runs[0]).toMatchObject({
      axis_run_drift_rows: 0,
      candidate_linked_stale_runs: 1,
      operational_candidate_owned_stale_runs: 1
    });
    expect(audit.sections.operational_candidates[0]).toMatchObject({
      stale_operational_candidate_rows: 3,
      stale_y_relation_review_rows: 1,
      stale_z_supersede_rows: 1,
      stale_m_archive_rows: 1
    });
    expect(audit.drift_count).toBe(3);
  });
});
