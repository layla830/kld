import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemory } from "../src/db/memories";
import {
  hardDeleteMemoriesBatched,
  listHardDeletableMemories
} from "../src/db/retention";

const OLD_TIME = "2025-01-01T00:00:00.000Z";
const CUTOFF = "2026-01-01T00:00:00.000Z";

async function markTerminal(namespace: string, memoryId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE memories
     SET status = 'deleted', updated_at = ?
     WHERE namespace = ? AND id = ?`
  ).bind(OLD_TIME, namespace, memoryId).run();
}

async function countRows(
  table: string,
  namespace: string
): Promise<number> {
  return (await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE namespace = ?`
  ).bind(namespace).first<number>("count")) ?? 0;
}

async function insertCandidate(
  namespace: string,
  externalKey: string,
  memoryId: string,
  status: "pending" | "approved"
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO memory_candidates (
         id, namespace, external_key, dream_date, action, target_id,
         result_memory_id, payload_json, source_chunk_ids_json,
         source_chunks_json, status, created_at, updated_at
       ) VALUES (?, ?, ?, '2026-07-28', 'update', ?, ?, '{}', '[]', '[]', ?, ?, ?)`
    ).bind(
      `candidate_${crypto.randomUUID()}`,
      namespace,
      externalKey,
      memoryId,
      memoryId,
      status,
      OLD_TIME,
      OLD_TIME
    ),
    env.DB.prepare(
      `INSERT INTO memory_candidate_dependencies (
         namespace, candidate_external_key, memory_id, role
       ) VALUES (?, ?, ?, 'target')`
    ).bind(namespace, externalKey, memoryId)
  ]);
}

async function insertPendingReference(
  namespace: string,
  memoryId: string,
  reference: "dependency" | "target" | "result"
): Promise<void> {
  const externalKey = `pending-${reference}:${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO memory_candidates (
       id, namespace, external_key, dream_date, action, target_id,
       result_memory_id, payload_json, source_chunk_ids_json,
       source_chunks_json, status, created_at, updated_at
     ) VALUES (?, ?, ?, '2026-07-28', 'update', ?, ?, '{}', '[]', '[]', 'pending', ?, ?)`
  ).bind(
    `candidate_${crypto.randomUUID()}`,
    namespace,
    externalKey,
    reference === "target" ? memoryId : null,
    reference === "result" ? memoryId : null,
    OLD_TIME,
    OLD_TIME
  ).run();
  if (reference === "dependency") {
    await env.DB.prepare(
      `INSERT INTO memory_candidate_dependencies (
         namespace, candidate_external_key, memory_id, role
       ) VALUES (?, ?, ?, 'target')`
    ).bind(namespace, externalKey, memoryId).run();
  }
}

describe("terminal memory hard-delete ownership", () => {
  it("deletes structural rows while preserving historical records", async () => {
    const namespace = `retention-cascade-${crypto.randomUUID()}`;
    const doomed = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "terminal memory",
      status: "active"
    });
    const survivor = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "surviving endpoint",
      status: "active"
    });
    await markTerminal(namespace, doomed.id);

    const candidateKey = `retention:${crypto.randomUUID()}`;
    await insertCandidate(namespace, candidateKey, doomed.id, "approved");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_relations (
           id, namespace, source_memory_id, target_memory_id,
           relation_type, strength, reason, created_at
         ) VALUES (?, ?, ?, ?, 'same_topic', 1, 'retention fixture', ?)`
      ).bind(
        `relation_${crypto.randomUUID()}`,
        namespace,
        doomed.id,
        survivor.id,
        OLD_TIME
      ),
      env.DB.prepare(
        `INSERT INTO memory_timeline_memberships (
           namespace, memory_id, thread, fact_key, updated_at
         ) VALUES (?, ?, 'retention', 'retention.fact', ?)`
      ).bind(namespace, doomed.id, OLD_TIME),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts, updated_at
         ) VALUES (?, ?, 1, 'X', 'applied', 1, ?)`
      ).bind(namespace, doomed.id, OLD_TIME),
      env.DB.prepare(
        `INSERT INTO memory_metabolism_signal_state (
           namespace, memory_id, policy_key, band, payload_json,
           first_observed_at, updated_at
         ) VALUES (?, ?, 'retention', 'cooled_after_use', '{}', ?, ?)`
      ).bind(namespace, doomed.id, OLD_TIME, OLD_TIME),
      env.DB.prepare(
        `INSERT INTO memory_recall_receipts (
           namespace, operation_id, memory_id, source,
           recall_day, recalled_at, created_at
         ) VALUES (?, ?, ?, 'api_context', '2025-01-01', ?, ?)`
      ).bind(namespace, `recall_${crypto.randomUUID()}`, doomed.id, OLD_TIME, OLD_TIME),
      env.DB.prepare(
        `INSERT INTO memory_events (
           id, namespace, event_type, memory_id, payload_json, created_at
         ) VALUES (?, ?, 'retention_fixture', ?, '{}', ?)`
      ).bind(`event_${crypto.randomUUID()}`, namespace, doomed.id, OLD_TIME),
      env.DB.prepare(
        `INSERT INTO memory_deprojections (
           operation_id, namespace, memory_id, source, reason,
           intent_fingerprint, transition,
           previous_status, next_status, previous_type, next_type,
           previous_active_fact, next_active_fact,
           previous_revision, current_revision,
           invariants_verified, created_at, completed_at
         ) VALUES (
           ?, ?, ?, 'retention', 'retention fixture',
           ?, 'eligible_to_ineligible',
           'active', 'deleted', 'note', 'note',
           1, 0, 1, 2, 1, ?, ?
         )`
      ).bind(
        `deprojection_${crypto.randomUUID()}`,
        namespace,
        doomed.id,
        "a".repeat(64),
        OLD_TIME,
        OLD_TIME
      )
    ]);
    await env.DB.prepare(
      "UPDATE memories SET updated_at = ? WHERE namespace = ? AND id = ?"
    ).bind(OLD_TIME, namespace, doomed.id).run();

    await expect(listHardDeletableMemories(env.DB, namespace, CUTOFF))
      .resolves.toEqual([expect.objectContaining({ id: doomed.id })]);
    await expect(hardDeleteMemoriesBatched(
      env.DB,
      namespace,
      [doomed.id],
      CUTOFF
    )).resolves.toBe(1);

    await expect(env.DB.prepare(
      "SELECT id FROM memories WHERE namespace = ? AND id = ?"
    ).bind(namespace, doomed.id).first()).resolves.toBeNull();
    await expect(env.DB.prepare(
      "SELECT id FROM memories WHERE namespace = ? AND id = ?"
    ).bind(namespace, survivor.id).first()).resolves.not.toBeNull();

    const ownedTables = [
      "memory_relations",
      "memory_timeline_memberships",
      "memory_five_axis_runs",
      "memory_candidate_dependencies",
      "memory_metabolism_signal_state",
      "memory_recall_daily",
      "memory_recall_receipts"
    ];
    for (const table of ownedTables) {
      await expect(countRows(table, namespace), table).resolves.toBe(0);
    }
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_five_axis_outbox
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, doomed.id).first<number>("count")).resolves.toBe(0);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_five_axis_outbox
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, survivor.id).first<number>("count")).resolves.toBe(1);
    await expect(countRows("memory_candidates", namespace)).resolves.toBe(1);
    await expect(countRows("memory_events", namespace)).resolves.toBe(1);
    await expect(countRows("memory_deprojections", namespace)).resolves.toBe(1);
  });

  it("does not hide a missed diary lifecycle cleanup", async () => {
    const namespace = `retention-diary-owner-${crypto.randomUUID()}`;
    const origin = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "terminal diary origin",
      status: "active"
    });
    const member = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "live diary member",
      status: "active"
    });
    await markTerminal(namespace, origin.id);
    await env.DB.prepare(
      `INSERT INTO memory_diary_timeline_memberships (
         namespace, memory_id, origin_diary_id, timeline_key,
         event_date, role, day_memory_id, updated_at
       ) VALUES (?, ?, ?, 'retention:test', '2026-07-28', 'item', ?, ?)`
    ).bind(namespace, member.id, origin.id, member.id, OLD_TIME).run();

    await expect(listHardDeletableMemories(env.DB, namespace, CUTOFF))
      .resolves.toEqual([]);
    await expect(hardDeleteMemoriesBatched(
      env.DB,
      namespace,
      [origin.id],
      CUTOFF
    )).resolves.toBe(0);
    await expect(countRows("memories", namespace)).resolves.toBe(2);
    await expect(countRows("memory_diary_timeline_memberships", namespace))
      .resolves.toBe(1);
  });

  it("does not delete or strip a memory that was restored after selection", async () => {
    const namespace = `retention-restored-${crypto.randomUUID()}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "restored before hard delete",
      status: "active"
    });
    await markTerminal(namespace, memory.id);
    const selected = await listHardDeletableMemories(env.DB, namespace, CUTOFF);
    expect(selected.map((row) => row.id)).toContain(memory.id);

    await env.DB.prepare(
      `UPDATE memories
       SET status = 'active', updated_at = ?
       WHERE namespace = ? AND id = ?`
    ).bind("2026-07-28T00:00:00.000Z", namespace, memory.id).run();

    await expect(hardDeleteMemoriesBatched(
      env.DB,
      namespace,
      selected.map((row) => row.id),
      CUTOFF
    )).resolves.toBe(0);
    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = ? AND id = ?"
    ).bind(namespace, memory.id).first<string>("status")).resolves.toBe("active");
    await expect(countRows("memory_five_axis_outbox", namespace)).resolves.toBeGreaterThan(0);
  });

  it.each(["dependency", "target", "result"] as const)(
    "leaves a terminal memory referenced through pending candidate %s untouched",
    async (reference) => {
      const namespace = `retention-blocked-${reference}-${crypto.randomUUID()}`;
      const memory = await createMemory(env.DB, {
        namespace,
        type: "note",
        content: "pending candidate dependency",
        status: "active"
      });
      await markTerminal(namespace, memory.id);
      await insertPendingReference(namespace, memory.id, reference);

      await expect(listHardDeletableMemories(env.DB, namespace, CUTOFF))
        .resolves.toEqual([]);
      await expect(hardDeleteMemoriesBatched(
        env.DB,
        namespace,
        [memory.id],
        CUTOFF
      )).resolves.toBe(0);
      await expect(countRows("memories", namespace)).resolves.toBe(1);
      await expect(countRows("memory_candidates", namespace)).resolves.toBe(1);
      await expect(countRows("memory_candidate_dependencies", namespace))
        .resolves.toBe(reference === "dependency" ? 1 : 0);
    }
  );

  it("leaves a terminal memory with an unfinished deprojection untouched", async () => {
    const namespace = `retention-operation-${crypto.randomUUID()}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "unfinished deprojection",
      status: "active"
    });
    await markTerminal(namespace, memory.id);
    await env.DB.prepare(
      `INSERT INTO memory_deprojections (
         operation_id, namespace, memory_id, source, reason,
         intent_fingerprint, transition,
         previous_status, next_status, previous_type, next_type,
         previous_active_fact, next_active_fact,
         previous_revision, current_revision, created_at
       ) VALUES (
         ?, ?, ?, 'retention', 'unfinished fixture',
         ?, 'eligible_to_ineligible',
         'active', 'deleted', 'note', 'note',
         1, 0, 1, 2, ?
       )`
    ).bind(
      `deprojection_${crypto.randomUUID()}`,
      namespace,
      memory.id,
      "c".repeat(64),
      OLD_TIME
    ).run();

    await expect(listHardDeletableMemories(env.DB, namespace, CUTOFF))
      .resolves.toEqual([]);
    await expect(hardDeleteMemoriesBatched(
      env.DB,
      namespace,
      [memory.id],
      CUTOFF
    )).resolves.toBe(0);
    await expect(countRows("memories", namespace)).resolves.toBe(1);
    await expect(countRows("memory_deprojections", namespace)).resolves.toBe(1);
  });

  it("preserves a terminal candidate that still depends on a live memory", async () => {
    const namespace = `retention-shared-candidate-${crypto.randomUUID()}`;
    const doomed = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "deleted relation endpoint",
      status: "active"
    });
    const survivor = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "live relation endpoint",
      status: "active"
    });
    await markTerminal(namespace, doomed.id);
    const candidateKey = `shared-candidate:${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_candidates (
           id, namespace, external_key, dream_date, action,
           payload_json, source_chunk_ids_json, source_chunks_json,
           status, created_at, updated_at
         ) VALUES (
           ?, ?, ?, '2026-07-28', 'y_relation_review',
           '{}', '[]', '[]', 'approved', ?, ?
         )`
      ).bind(
        `candidate_${crypto.randomUUID()}`,
        namespace,
        candidateKey,
        OLD_TIME,
        OLD_TIME
      ),
      env.DB.prepare(
        `INSERT INTO memory_candidate_dependencies (
           namespace, candidate_external_key, memory_id, role
         ) VALUES (?, ?, ?, 'source')`
      ).bind(namespace, candidateKey, doomed.id),
      env.DB.prepare(
        `INSERT INTO memory_candidate_dependencies (
           namespace, candidate_external_key, memory_id, role
         ) VALUES (?, ?, ?, 'target')`
      ).bind(namespace, candidateKey, survivor.id)
    ]);

    await expect(hardDeleteMemoriesBatched(
      env.DB,
      namespace,
      [doomed.id],
      CUTOFF
    )).resolves.toBe(1);
    await expect(countRows("memory_candidates", namespace)).resolves.toBe(1);
    const dependencies = await env.DB.prepare(
      `SELECT memory_id FROM memory_candidate_dependencies
       WHERE namespace = ? AND candidate_external_key = ?`
    ).bind(namespace, candidateKey).all<{ memory_id: string }>();
    expect(dependencies.results).toEqual([{ memory_id: survivor.id }]);
  });
});
