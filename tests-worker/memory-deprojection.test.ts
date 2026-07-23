import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createMemory, getMemoryById } from "../src/db/memories";
import {
  getMemoryDeprojectionByOperationId,
  prepareMemoryDeprojection
} from "../src/db/memoryDeprojection";
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
    ).bind(`cand_${suffix}`, NAMESPACE, `deprojection:${suffix}`, memory.id, now, now)
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

  it("invalidates a Y review candidate when deprojecting its linked source endpoint", async () => {
    const source = await createEligibleMemory("mem_deprojection_y_source");
    const target = await createEligibleMemory("mem_deprojection_y_target");
    const now = "2026-07-23T02:40:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_candidates (
           id, namespace, external_key, dream_date, action, subject, target_id,
           payload_json, source_chunk_ids_json, source_chunks_json,
           status, created_at, updated_at
         ) VALUES ('cand_y_source', ?, 'deprojection:y-source', '2026-07-23',
           'y_relation_review', 'system', ?, ?, '[]', '[]', 'pending', ?, ?)`
      ).bind(
        NAMESPACE,
        target.id,
        JSON.stringify({
          _kind: "y_relation_review",
          source_id: source.id,
          target_id: target.id
        }),
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, completed_at, updated_at
         ) VALUES (?, ?, ?, 'Y', 'pending_review', 1, '{}', ?, ?)`
      ).bind(NAMESPACE, source.id, source.five_axis_revision ?? 1, now, now),
      env.DB.prepare(
        `INSERT INTO memory_candidate_axis_runs (
           namespace, candidate_external_key, memory_id, memory_revision, axis, created_at
         ) VALUES (?, 'deprojection:y-source', ?, ?, 'Y', ?)`
      ).bind(NAMESPACE, source.id, source.five_axis_revision ?? 1, now)
    ]);

    const result = await deprojectMemoryFromFiveAxes(env as Env, {
      namespace: NAMESPACE,
      memoryId: source.id,
      patch: { status: "deleted" },
      source: "system",
      reason: "Y source endpoint deprojection",
      operationId: "deproj_y_source"
    });

    expect(result.invalidatedCandidates).toBe(1);
    expect(await env.DB.prepare(
      "SELECT status, validation_error FROM memory_candidates WHERE namespace = ? AND id = 'cand_y_source'"
    ).bind(NAMESPACE).first<{ status: string; validation_error: string }>())
      .toEqual({ status: "rejected", validation_error: "memory_deprojected" });
  });

  it("invalidates a legacy M cleanup candidate through either payload endpoint", async () => {
    const source = await createEligibleMemory("mem_deprojection_m_source");
    const target = await createEligibleMemory("mem_deprojection_m_target");
    const now = "2026-07-23T02:50:00.000Z";
    await env.DB.prepare(
      `INSERT INTO memory_candidates (
         id, namespace, external_key, dream_date, action, subject, target_id,
         payload_json, source_chunk_ids_json, source_chunks_json,
         status, created_at, updated_at
       ) VALUES ('cand_m_endpoint', ?, 'deprojection:m-endpoint', '2026-07-23',
         'm_relation_cleanup', 'system', NULL, ?, '[]', '[]', 'pending', ?, ?)`
    ).bind(
      NAMESPACE,
      JSON.stringify({
        _kind: "metabolism_relation_cleanup",
        before: {
          source_memory_id: source.id,
          target_memory_id: target.id,
          relation_type: "supports"
        }
      }),
      now,
      now
    ).run();

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
      "SELECT status, validation_error FROM memory_candidates WHERE namespace = ? AND id = 'cand_m_endpoint'"
    ).bind(NAMESPACE).first<{ status: string; validation_error: string }>())
      .toEqual({ status: "rejected", validation_error: "memory_deprojected" });
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

    const plan = prepareMemoryDeprojection(env.DB, {
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
