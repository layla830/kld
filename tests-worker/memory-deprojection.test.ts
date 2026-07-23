import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitMemoryCandidateApproval,
  upsertMemoryCandidate
} from "../src/db/memoryCandidates";
import { createMemory, getMemoryById } from "../src/db/memories";
import {
  getMemoryDeprojectionByOperationId,
  prepareMemoryDeprojection
} from "../src/db/memoryDeprojection";
import { completeFiveAxisRun } from "../src/db/memoryFiveAxisRuns";
import { deprojectMemoryFromFiveAxes } from "../src/memory/deprojection";
import type { Env, MemoryRecord } from "../src/types";

const NAMESPACE = "deprojection-contract";

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ count: number }>();
  return row?.count ?? 0;
}

async function createEligibleMemory(id: string): Promise<MemoryRecord> {
  return createMemory(env.DB, {
    namespace: NAMESPACE,
    type: "project_state",
    content: `deprojection target ${id}`,
    factKey: `project:${id}`,
    thread: "deprojection",
    status: "active",
    activeFact: true,
    source: "worker-test"
  });
}

async function seedProjectionState(memory: MemoryRecord, suffix: string): Promise<void> {
  const peer = await createMemory(env.DB, {
    namespace: NAMESPACE,
    type: "note",
    content: `peer ${suffix}`,
    status: "active",
    source: "worker-test"
  });
  const now = "2026-07-23T02:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id,
         relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, 'supports', 0.8, 'deprojection test', ?)`
    ).bind(`rel_${suffix}_y`, NAMESPACE, memory.id, peer.id, now),
    env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id,
         relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, 'temporal_sequence', 1, 'deprojection test', ?)`
    ).bind(`rel_${suffix}_x`, NAMESPACE, peer.id, memory.id, now),
    env.DB.prepare(
      `INSERT INTO memory_timeline_memberships (
         namespace, memory_id, thread, fact_key, updated_at
       ) VALUES (?, ?, 'deprojection', ?, ?)`
    ).bind(NAMESPACE, memory.id, `project:${memory.id}`, now),
    env.DB.prepare(
      `INSERT INTO memory_diary_timeline_memberships (
         namespace, memory_id, origin_diary_id, timeline_key,
         event_date, role, day_memory_id, updated_at
       ) VALUES (?, ?, ?, 'diary:kld', '2026-07-23', 'item', ?, ?)`
    ).bind(NAMESPACE, memory.id, `diary_${suffix}`, `day_${suffix}`, now),
    env.DB.prepare(
      `UPDATE memory_five_axis_outbox
       SET status = 'queued', attempts = 1, queued_at = ?, updated_at = ?
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ?`
    ).bind(now, now, NAMESPACE, memory.id, memory.five_axis_revision ?? 1),
    env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         claim_token, lease_expires_at, started_at, updated_at
       ) VALUES (?, ?, ?, 'Y', 'running', 1, ?, ?, ?, ?)`
    ).bind(
      NAMESPACE,
      memory.id,
      memory.five_axis_revision ?? 1,
      `claim_${suffix}`,
      "2026-07-23T02:15:00.000Z",
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO memory_candidates (
         id, namespace, external_key, dream_date, action, subject, target_id,
         payload_json, source_chunk_ids_json, source_chunks_json,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, '2026-07-23', 'update', 'system', ?,
         '{}', '[]', '[]', 'pending', ?, ?)`
    ).bind(`cand_${suffix}`, NAMESPACE, `deprojection:${suffix}`, memory.id, now, now),
    env.DB.prepare(
      `INSERT INTO memory_candidate_dependencies (
         namespace, candidate_external_key, memory_id, role
       ) VALUES (?, ?, ?, 'target')`
    ).bind(NAMESPACE, `deprojection:${suffix}`, memory.id)
  ]);
}

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS fail_deprojection_relation_cleanup"),
    env.DB.prepare("DROP TRIGGER IF EXISTS preserve_deprojection_relation_cleanup")
  ]);
});

describe("memory deprojection Workers contract", () => {
  it("atomically removes current projections and terminalizes old work", async () => {
    const memory = await createEligibleMemory("mem_deprojection_atomic");
    await seedProjectionState(memory, "atomic");

    const result = await deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "deleted" },
      expectedStatus: "active",
      expectedRevision: memory.five_axis_revision ?? 1,
      source: "system",
      reason: "worker atomic contract",
      operationId: "deproj_atomic"
    });

    expect(result).toMatchObject({
      transition: "eligible_to_ineligible",
      previousRevision: 1,
      currentRevision: 2,
      removedRelations: 2,
      removedTimelineMemberships: 2,
      invalidatedCandidates: 1,
      terminalizedOutboxes: 1,
      terminalizedAxisRuns: 1,
      vectorSyncRequired: true,
      reused: false
    });
    expect(result.memory).toMatchObject({
      status: "deleted",
      active_fact: 0,
      five_axis_revision: 2,
      vector_synced: 0,
      vector_sync_status: "pending"
    });

    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND (source_memory_id = ? OR target_memory_id = ?)`,
      NAMESPACE,
      memory.id,
      memory.id
    )).toBe(0);
    expect(await count(
      "SELECT COUNT(*) AS count FROM memory_timeline_memberships WHERE namespace = ? AND memory_id = ?",
      NAMESPACE,
      memory.id
    )).toBe(0);
    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND (memory_id = ? OR origin_diary_id = ? OR day_memory_id = ?)`,
      NAMESPACE,
      memory.id,
      memory.id,
      memory.id
    )).toBe(0);

    const outbox = await env.DB.prepare(
      `SELECT memory_revision, status, result_json FROM memory_five_axis_outbox
       WHERE namespace = ? AND memory_id = ?`
    ).bind(NAMESPACE, memory.id).all<{
      memory_revision: number;
      status: string;
      result_json: string;
    }>();
    expect(outbox.results).toHaveLength(1);
    expect(outbox.results?.[0]).toMatchObject({ memory_revision: 1, status: "skipped" });
    expect(JSON.parse(outbox.results?.[0]?.result_json ?? "{}")).toMatchObject({
      reason: "memory_deprojected",
      operation_id: "deproj_atomic"
    });

    const run = await env.DB.prepare(
      `SELECT status, claim_token, lease_expires_at, result_json
       FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = 1 AND axis = 'Y'`
    ).bind(NAMESPACE, memory.id).first<{
      status: string;
      claim_token: string | null;
      lease_expires_at: string | null;
      result_json: string;
    }>();
    expect(run).toMatchObject({ status: "skipped", claim_token: null, lease_expires_at: null });
    expect(JSON.parse(run?.result_json ?? "{}")).toMatchObject({ reason: "memory_deprojected" });

    const candidate = await env.DB.prepare(
      "SELECT status, validation_error FROM memory_candidates WHERE namespace = ? AND id = 'cand_atomic'"
    ).bind(NAMESPACE).first<{ status: string; validation_error: string }>();
    expect(candidate).toEqual({ status: "rejected", validation_error: "memory_deprojected" });

    const operation = await getMemoryDeprojectionByOperationId(env.DB, "deproj_atomic");
    expect(operation).toMatchObject({
      invariants_verified: 1,
      removed_relations: 2,
      removed_timeline_memberships: 2,
      invalidated_candidates: 1,
      terminalized_outboxes: 1,
      terminalized_axis_runs: 1
    });
    expect(operation?.completed_at).not.toBeNull();
    expect(operation?.relation_snapshot_json).not.toContain(memory.content);
    expect(operation?.candidate_snapshot_json).not.toContain(memory.content);
  });

  it("rejects standalone candidate ownership instead of leaving its candidate pending", async () => {
    const memory = await createEligibleMemory("mem_deprojection_standalone_owner");
    const now = "2026-07-23T02:30:00.000Z";
    await env.DB.prepare(
      `INSERT INTO memory_candidates (
         id, namespace, external_key, dream_date, action, subject, target_id,
         payload_json, source_chunk_ids_json, source_chunks_json,
         status, created_at, updated_at
       ) VALUES ('cand_standalone_owner', ?, 'deprojection:standalone-owner', '2026-07-23',
         'delete', 'system', ?, '{}', '[]', '[]', 'pending', ?, ?)`
    ).bind(NAMESPACE, memory.id, now, now).run();

    const unsafeStandaloneInput: Parameters<typeof deprojectMemoryFromFiveAxes>[1] & {
      candidateId: string;
    } = {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "deleted" },
      source: "dream_candidate",
      reason: "standalone candidate misuse",
      candidateId: "cand_standalone_owner"
    };

    await expect(deprojectMemoryFromFiveAxes(
      env as Env,
      unsafeStandaloneInput
    )).rejects.toThrow("memory_deprojection_candidate_requires_prepared_plan");

    expect(await getMemoryById(env.DB, { namespace: NAMESPACE, id: memory.id }))
      .toMatchObject({ status: "active", active_fact: 1, five_axis_revision: 1 });
    expect(await env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = ? AND id = 'cand_standalone_owner'"
    ).bind(NAMESPACE).first<{ status: string }>()).toEqual({ status: "pending" });
    expect(await count(
      "SELECT COUNT(*) AS count FROM memory_deprojections WHERE namespace = ? AND memory_id = ?",
      NAMESPACE,
      memory.id
    )).toBe(0);
  });

  it("invalidates Y through normalized source dependency when only target owns the run", async () => {
    const source = await createEligibleMemory("mem_deprojection_y_source");
    const target = await createEligibleMemory("mem_deprojection_y_target");
    const now = "2026-07-23T02:40:00.000Z";
    const candidateKey = "deprojection:y-source";
    await upsertMemoryCandidate(env.DB, NAMESPACE, {
      externalKey: candidateKey,
      dreamDate: "2026-07-23",
      action: "y_relation_review",
      subject: "system",
      targetId: target.id,
      payload: { _kind: "y_relation_review" },
      sourceChunkIds: [],
      status: "pending",
      dependencies: [
        { memoryId: source.id, role: "source" },
        { memoryId: target.id, role: "target" }
      ]
    });
    await env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         claim_token, started_at, updated_at
       ) VALUES (?, ?, ?, 'Y', 'running', 1, 'claim_y_target', ?, ?)`
    ).bind(NAMESPACE, target.id, target.five_axis_revision ?? 1, now, now).run();
    await expect(completeFiveAxisRun(
      env.DB,
      {
        namespace: NAMESPACE,
        memoryId: target.id,
        memoryRevision: target.five_axis_revision ?? 1,
        axis: "Y"
      },
      "claim_y_target",
      "pending_review",
      { candidates: 1 },
      [candidateKey]
    )).resolves.toBe(true);

    const result = await deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: source.id,
      patch: { status: "deleted" },
      source: "system",
      reason: "Y source endpoint deprojection",
      operationId: "deproj_y_source"
    });

    expect(result.invalidatedCandidates).toBe(1);
    expect(result.reconciledAxisRuns).toBe(1);
    expect(await env.DB.prepare(
      "SELECT status, validation_error FROM memory_candidates WHERE namespace = ? AND external_key = ?"
    ).bind(NAMESPACE, candidateKey).first<{ status: string; validation_error: string }>())
      .toEqual({ status: "rejected", validation_error: "memory_deprojected" });
    expect(await env.DB.prepare(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = 1 AND axis = 'Y'`
    ).bind(NAMESPACE, target.id).first<{ status: string }>())
      .toEqual({ status: "skipped" });
    const operation = await getMemoryDeprojectionByOperationId(env.DB, "deproj_y_source");
    expect(operation?.reconciled_axis_runs).toBe(1);
    expect(JSON.parse(operation?.reconciled_run_snapshot_json ?? "[]")).toEqual([
      expect.objectContaining({
        namespace: NAMESPACE,
        memory_id: target.id,
        memory_revision: 1,
        axis: "Y",
        status: "pending_review"
      })
    ]);
  });

  it("preserves axis-run ownership when a pending candidate is re-upserted", async () => {
    const target = await createEligibleMemory("mem_deprojection_reupsert_owner");
    const candidateKey = "deprojection:reupsert-owner";
    const candidateInput = {
      externalKey: candidateKey,
      dreamDate: "2026-07-23",
      action: "update" as const,
      subject: "system",
      targetId: target.id,
      payload: { version: 1 },
      sourceChunkIds: [],
      status: "pending" as const
    };
    await upsertMemoryCandidate(env.DB, NAMESPACE, candidateInput);
    const now = "2026-07-23T02:45:00.000Z";
    await env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         claim_token, started_at, updated_at
       ) VALUES (?, ?, ?, 'Y', 'running', 1, 'claim_reupsert_owner', ?, ?)`
    ).bind(NAMESPACE, target.id, target.five_axis_revision ?? 1, now, now).run();
    await expect(completeFiveAxisRun(
      env.DB,
      {
        namespace: NAMESPACE,
        memoryId: target.id,
        memoryRevision: target.five_axis_revision ?? 1,
        axis: "Y"
      },
      "claim_reupsert_owner",
      "pending_review",
      { candidates: 1 },
      [candidateKey]
    )).resolves.toBe(true);

    await upsertMemoryCandidate(env.DB, NAMESPACE, {
      ...candidateInput,
      payload: { version: 2 }
    });

    expect(await env.DB.prepare(
      `SELECT role, memory_id FROM memory_candidate_dependencies
       WHERE namespace = ? AND candidate_external_key = ?
       ORDER BY role`
    ).bind(NAMESPACE, candidateKey).all<{ role: string; memory_id: string }>())
      .toMatchObject({
        results: [
          { role: "axis_run", memory_id: target.id },
          { role: "target", memory_id: target.id }
        ]
      });
    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_candidate_axis_runs
       WHERE namespace = ? AND candidate_external_key = ?`,
      NAMESPACE,
      candidateKey
    )).toBe(1);
  });

  it("invalidates M through normalized target dependency when only source owns the run", async () => {
    const source = await createEligibleMemory("mem_deprojection_m_source");
    const target = await createEligibleMemory("mem_deprojection_m_target");
    const now = "2026-07-23T02:50:00.000Z";
    const candidateKey = "deprojection:m-endpoint";
    await upsertMemoryCandidate(env.DB, NAMESPACE, {
      externalKey: candidateKey,
      dreamDate: "2026-07-23",
      action: "m_relation_cleanup",
      subject: "system",
      payload: { _kind: "metabolism_relation_cleanup" },
      sourceChunkIds: [],
      status: "pending",
      dependencies: [
        { memoryId: source.id, role: "source" },
        { memoryId: target.id, role: "target" }
      ]
    });
    await env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         claim_token, started_at, updated_at
       ) VALUES (?, ?, ?, 'M', 'running', 1, 'claim_m_source', ?, ?)`
    ).bind(NAMESPACE, source.id, source.five_axis_revision ?? 1, now, now).run();
    await expect(completeFiveAxisRun(
      env.DB,
      {
        namespace: NAMESPACE,
        memoryId: source.id,
        memoryRevision: source.five_axis_revision ?? 1,
        axis: "M"
      },
      "claim_m_source",
      "pending_review",
      { candidates: 1 },
      [candidateKey]
    )).resolves.toBe(true);

    const result = await deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: target.id,
      patch: { activeFact: false },
      source: "system",
      reason: "M relation endpoint deprojection",
      operationId: "deproj_m_endpoint"
    });

    expect(result.invalidatedCandidates).toBe(1);
    expect(await env.DB.prepare(
      "SELECT status, validation_error FROM memory_candidates WHERE namespace = ? AND external_key = ?"
    ).bind(NAMESPACE, candidateKey).first<{ status: string; validation_error: string }>())
      .toEqual({ status: "rejected", validation_error: "memory_deprojected" });
    expect(await env.DB.prepare(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = 1 AND axis = 'M'`
    ).bind(NAMESPACE, source.id).first<{ status: string }>())
      .toEqual({ status: "skipped" });
  });

  it("keeps a linked run pending while another pending candidate still owns it", async () => {
    const source = await createEligibleMemory("mem_deprojection_shared_source");
    const target = await createEligibleMemory("mem_deprojection_shared_target");
    const now = "2026-07-23T02:55:00.000Z";
    const rejectedKey = "deprojection:shared-rejected";
    const remainingKey = "deprojection:shared-remaining";
    await upsertMemoryCandidate(env.DB, NAMESPACE, {
      externalKey: rejectedKey,
      dreamDate: "2026-07-23",
      action: "m_relation_cleanup",
      subject: "system",
      payload: { _kind: "metabolism_relation_cleanup" },
      sourceChunkIds: [],
      status: "pending",
      dependencies: [
        { memoryId: source.id, role: "source" },
        { memoryId: target.id, role: "target" }
      ]
    });
    await upsertMemoryCandidate(env.DB, NAMESPACE, {
      externalKey: remainingKey,
      dreamDate: "2026-07-23",
      action: "m_archive",
      subject: "system",
      targetId: source.id,
      payload: { _kind: "metabolism_archive" },
      sourceChunkIds: [],
      status: "pending"
    });
    await env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         claim_token, started_at, updated_at
       ) VALUES (?, ?, ?, 'M', 'running', 1, 'claim_m_shared', ?, ?)`
    ).bind(NAMESPACE, source.id, source.five_axis_revision ?? 1, now, now).run();
    await expect(completeFiveAxisRun(
      env.DB,
      {
        namespace: NAMESPACE,
        memoryId: source.id,
        memoryRevision: source.five_axis_revision ?? 1,
        axis: "M"
      },
      "claim_m_shared",
      "pending_review",
      { candidates: 2 },
      [rejectedKey, remainingKey]
    )).resolves.toBe(true);

    const result = await deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: target.id,
      patch: { status: "deleted" },
      source: "system",
      reason: "shared candidate reconciliation",
      operationId: "deproj_shared_candidate"
    });

    expect(result.invalidatedCandidates).toBe(1);
    expect(await env.DB.prepare(
      `SELECT external_key, status FROM memory_candidates
       WHERE namespace = ? AND external_key IN (?, ?)
       ORDER BY external_key`
    ).bind(NAMESPACE, rejectedKey, remainingKey).all<{ external_key: string; status: string }>())
      .toMatchObject({
        results: [
          { external_key: rejectedKey, status: "rejected" },
          { external_key: remainingKey, status: "pending" }
        ]
      });
    expect(await env.DB.prepare(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = 1 AND axis = 'M'`
    ).bind(NAMESPACE, source.id).first<{ status: string }>())
      .toEqual({ status: "pending_review" });
  });

  it("reuses a completed operation without incrementing revision twice", async () => {
    const memory = await createEligibleMemory("mem_deprojection_idempotent");
    await seedProjectionState(memory, "idempotent");
    const input = {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "archived" },
      source: "system" as const,
      reason: "worker idempotency contract",
      operationId: "deproj_idempotent"
    };

    const first = await deprojectMemoryFromFiveAxes(env as Env, input);
    const second = await deprojectMemoryFromFiveAxes(env as Env, input);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.currentRevision).toBe(2);
    expect(second.memory.five_axis_revision).toBe(2);
    expect(await count(
      "SELECT COUNT(*) AS count FROM memory_deprojections WHERE namespace = ? AND memory_id = ?",
      NAMESPACE,
      memory.id
    )).toBe(1);
  });

  it("rejects reuse of an operation id with a different patch", async () => {
    const memory = await createEligibleMemory("mem_deprojection_intent_mismatch");
    const operationId = "deproj_intent_mismatch";
    await deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "archived" },
      source: "system",
      reason: "intent mismatch contract",
      operationId
    });

    await expect(deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "deleted" },
      source: "system",
      reason: "intent mismatch contract",
      operationId
    })).rejects.toThrow("memory_deprojection_operation_intent_mismatch");
    expect(await getMemoryById(env.DB, { namespace: NAMESPACE, id: memory.id }))
      .toMatchObject({ status: "archived", active_fact: 0, five_axis_revision: 2 });
  });

  it("rejects stale reuse after the memory is reactivated", async () => {
    const memory = await createEligibleMemory("mem_deprojection_stale_reuse");
    const input = {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "archived" },
      source: "system" as const,
      reason: "stale reuse contract",
      operationId: "deproj_stale_reuse"
    };
    await deprojectMemoryFromFiveAxes(env as Env, input);
    await env.DB.prepare(
      `UPDATE memories
       SET status = 'active', active_fact = 1, updated_at = ?
       WHERE namespace = ? AND id = ?`
    ).bind("2026-07-23T03:10:00.000Z", NAMESPACE, memory.id).run();

    await expect(deprojectMemoryFromFiveAxes(env as Env, input))
      .rejects.toThrow("memory_deprojection_operation_stale");
    expect(await getMemoryById(env.DB, { namespace: NAMESPACE, id: memory.id }))
      .toMatchObject({ status: "active", active_fact: 1, five_axis_revision: 3 });
  });

  it("does not let a completed operation for another memory satisfy a prepared plan", async () => {
    const first = await createEligibleMemory("mem_deprojection_scope_first");
    await deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: first.id,
      patch: { status: "deleted" },
      source: "system",
      reason: "seed scoped operation",
      operationId: "deproj_scope_collision"
    });

    const target = await createEligibleMemory("mem_deprojection_scope_target");
    await upsertMemoryCandidate(env.DB, NAMESPACE, {
      externalKey: "deprojection:scope-owner",
      dreamDate: "2026-07-23",
      action: "delete",
      subject: "system",
      targetId: target.id,
      payload: {},
      sourceChunkIds: [],
      status: "pending"
    });
    const owner = await env.DB.prepare(
      `SELECT id FROM memory_candidates
       WHERE namespace = ? AND external_key = 'deprojection:scope-owner'`
    ).bind(NAMESPACE).first<{ id: string }>();
    const plan = await prepareMemoryDeprojection(env.DB, {
      namespace: NAMESPACE,
      memoryId: target.id,
      memory: target,
      patch: { status: "deleted" },
      source: "dream_candidate",
      reason: "scoped prepared operation",
      candidateId: owner!.id,
      operationId: "deproj_scope_collision",
      guard: {
        sql: `EXISTS (
          SELECT 1 FROM memory_candidates
          WHERE namespace = ? AND id = ? AND status = 'pending'
        )`,
        binds: [NAMESPACE, owner!.id]
      }
    });

    await expect(commitMemoryCandidateApproval(env.DB, {
      namespace: NAMESPACE,
      id: owner!.id,
      expectedStatus: "pending",
      resultMemoryId: target.id,
      businessStatements: plan.statements,
      successGuard: plan.successGuard
    })).resolves.toBe(false);

    expect(await getMemoryById(env.DB, { namespace: NAMESPACE, id: target.id }))
      .toMatchObject({ status: "active", active_fact: 1, five_axis_revision: 1 });
    expect(await env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = ? AND id = ?"
    ).bind(NAMESPACE, owner!.id).first<{ status: string }>())
      .toEqual({ status: "pending" });
    expect(await env.DB.prepare(
      "SELECT namespace, memory_id FROM memory_deprojections WHERE operation_id = ?"
    ).bind("deproj_scope_collision").first<{ namespace: string; memory_id: string }>())
      .toEqual({ namespace: NAMESPACE, memory_id: first.id });
  });

  it("rolls back the entire batch when projection cleanup fails", async () => {
    const memory = await createEligibleMemory("mem_deprojection_rollback");
    await seedProjectionState(memory, "rollback");
    await env.DB.prepare(
      `CREATE TRIGGER fail_deprojection_relation_cleanup
       BEFORE DELETE ON memory_relations
       WHEN OLD.namespace = '${NAMESPACE}' AND (
         OLD.source_memory_id = '${memory.id}' OR OLD.target_memory_id = '${memory.id}'
       )
       BEGIN
         SELECT RAISE(ABORT, 'forced deprojection cleanup failure');
       END`
    ).run();

    await expect(deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "deleted" },
      source: "system",
      reason: "worker rollback contract",
      operationId: "deproj_rollback"
    })).rejects.toThrow();

    const unchanged = await getMemoryById(env.DB, { namespace: NAMESPACE, id: memory.id });
    expect(unchanged).toMatchObject({
      status: "active",
      active_fact: 1,
      five_axis_revision: 1
    });
    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND (source_memory_id = ? OR target_memory_id = ?)`,
      NAMESPACE,
      memory.id,
      memory.id
    )).toBe(2);
    expect(await count(
      "SELECT COUNT(*) AS count FROM memory_deprojections WHERE operation_id = 'deproj_rollback'"
    )).toBe(0);
    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_five_axis_outbox
       WHERE namespace = ? AND memory_id = ? AND status = 'queued'`,
      NAMESPACE,
      memory.id
    )).toBe(1);
    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND status = 'running'`,
      NAMESPACE,
      memory.id
    )).toBe(1);
    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_candidates
       WHERE namespace = ? AND target_id = ? AND status = 'pending'`,
      NAMESPACE,
      memory.id
    )).toBe(1);
  });

  it("turns a silent cleanup miss into a constraint failure and rollback", async () => {
    const memory = await createEligibleMemory("mem_deprojection_invariant");
    await seedProjectionState(memory, "invariant");
    await env.DB.prepare(
      `CREATE TRIGGER preserve_deprojection_relation_cleanup
       BEFORE DELETE ON memory_relations
       WHEN OLD.namespace = '${NAMESPACE}' AND (
         OLD.source_memory_id = '${memory.id}' OR OLD.target_memory_id = '${memory.id}'
       )
       BEGIN
         SELECT RAISE(IGNORE);
       END`
    ).run();

    await expect(deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: memory.id,
      patch: { status: "deleted" },
      source: "system",
      reason: "worker invariant rollback contract",
      operationId: "deproj_invariant"
    })).rejects.toThrow();

    expect(await getMemoryById(env.DB, { namespace: NAMESPACE, id: memory.id }))
      .toMatchObject({ status: "active", active_fact: 1, five_axis_revision: 1 });
    expect(await count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND (source_memory_id = ? OR target_memory_id = ?)`,
      NAMESPACE,
      memory.id,
      memory.id
    )).toBe(2);
    expect(await count(
      "SELECT COUNT(*) AS count FROM memory_deprojections WHERE operation_id = 'deproj_invariant'"
    )).toBe(0);
  });

  it("keeps a prepared plan inert when its caller guard is stale", async () => {
    const memory = await createEligibleMemory("mem_deprojection_guarded");
    const now = "2026-07-23T03:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO memory_candidates (
         id, namespace, external_key, dream_date, action, subject, target_id,
         payload_json, source_chunk_ids_json, source_chunks_json,
         status, created_at, updated_at
       ) VALUES ('cand_guarded', ?, 'deprojection:guarded', '2026-07-23',
         'delete', 'system', ?, '{}', '[]', '[]', 'pending', ?, ?)`
    ).bind(NAMESPACE, memory.id, now, now).run();

    const plan = await prepareMemoryDeprojection(env.DB, {
      namespace: NAMESPACE,
      memoryId: memory.id,
      memory,
      patch: { status: "deleted" },
      source: "dream_candidate",
      reason: "prepared guard contract",
      candidateId: "cand_guarded",
      operationId: "deproj_guarded",
      guard: {
        sql: "EXISTS (SELECT 1 FROM memory_candidates WHERE namespace = ? AND id = ? AND status = 'pending')",
        binds: [NAMESPACE, "cand_guarded"]
      }
    });
    await env.DB.prepare(
      "UPDATE memory_candidates SET status = 'rejected' WHERE namespace = ? AND id = 'cand_guarded'"
    ).bind(NAMESPACE).run();

    await env.DB.batch(plan.statements);

    expect(await getMemoryById(env.DB, { namespace: NAMESPACE, id: memory.id }))
      .toMatchObject({ status: "active", active_fact: 1, five_axis_revision: 1 });
    expect(await count(
      "SELECT COUNT(*) AS count FROM memory_deprojections WHERE operation_id = 'deproj_guarded'"
    )).toBe(0);
  });
});
