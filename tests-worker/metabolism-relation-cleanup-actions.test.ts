import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  approveMetabolismCandidate,
  rollbackMetabolismCandidate
} from "../src/api/adminBoard/metabolismActions";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { createMemory } from "../src/db/memories";
import type { Env } from "../src/types";

const runtimeEnv = { DB: env.DB } as Env;

interface RelationCleanupFixture {
  candidateId: string;
  relationId: string;
  form: FormData;
}

async function relationCleanupFixture(): Promise<RelationCleanupFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const source = await createMemory(env.DB, {
    namespace: "default",
    type: "note",
    content: `relation cleanup source ${suffix}`
  });
  const target = await createMemory(env.DB, {
    namespace: "default",
    type: "note",
    content: `relation cleanup target ${suffix}`
  });
  const relationId = `rel_m_cleanup_${suffix}`;
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO memory_relations
       (id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at)
     VALUES (?, 'default', ?, ?, 'same_topic', 0.8, 'test cleanup', ?)`
  ).bind(relationId, source.id, target.id, createdAt).run();
  const relation = await env.DB.prepare(
    "SELECT * FROM memory_relations WHERE namespace = 'default' AND id = ?"
  ).bind(relationId).first<Record<string, unknown>>();

  const externalKey = `m-review:relation:${relationId}`;
  await upsertMemoryCandidate(env.DB, "default", {
    externalKey,
    dreamDate: "2026-07-20",
    action: "m_relation_cleanup",
    subject: "system",
    payload: {
      _kind: "metabolism_relation_cleanup",
      reason: "测试关系边清理",
      before: relation
    },
    sourceChunkIds: [],
    status: "pending"
  });
  const candidate = await env.DB.prepare(
    "SELECT id FROM memory_candidates WHERE namespace = 'default' AND external_key = ?"
  ).bind(externalKey).first<{ id: string }>();
  const form = new FormData();
  form.set("id", candidate!.id);
  return { candidateId: candidate!.id, relationId, form };
}

async function candidateState(candidateId: string) {
  return env.DB.prepare(
    "SELECT status, result_memory_id FROM memory_candidates WHERE namespace = 'default' AND id = ?"
  ).bind(candidateId).first<{ status: string; result_memory_id: string | null }>();
}

async function rollbackEvent(candidateId: string) {
  return env.DB.prepare(
    `SELECT payload_json
     FROM memory_events
     WHERE namespace = 'default' AND event_type = 'm_rollback'
       AND json_extract(payload_json, '$.candidate_id') = ?`
  ).bind(candidateId).first<{ payload_json: string }>();
}

describe("M relation cleanup approval", () => {
  it("deletes the relation and resolves the candidate", async () => {
    const fixture = await relationCleanupFixture();

    await expect(approveMetabolismCandidate(runtimeEnv, fixture.form)).resolves.toMatchObject({
      action: "m_relation_cleanup",
      memory: null
    });
    await expect(env.DB.prepare(
      "SELECT id FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toBeNull();
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({
      status: "approved",
      result_memory_id: fixture.relationId
    });
  });

  it("treats an already-absent relation as a successful idempotent cleanup", async () => {
    const fixture = await relationCleanupFixture();
    await env.DB.prepare(
      "DELETE FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).run();

    await expect(approveMetabolismCandidate(runtimeEnv, fixture.form)).resolves.toMatchObject({
      action: "m_relation_cleanup",
      memory: null
    });
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({
      status: "approved",
      result_memory_id: fixture.relationId
    });
  });

  it("does not delete a relation whose endpoints or type changed after scanning", async () => {
    const fixture = await relationCleanupFixture();
    await env.DB.prepare(
      "UPDATE memory_relations SET relation_type = 'same_event' WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).run();

    await expect(approveMetabolismCandidate(runtimeEnv, fixture.form))
      .rejects.toThrow("metabolism_relation_candidate_changed");
    await expect(env.DB.prepare(
      "SELECT relation_type FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toMatchObject({ relation_type: "same_event" });
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "pending" });
  });

  it("rolls the delete back when candidate approval cannot commit", async () => {
    const fixture = await relationCleanupFixture();
    const triggerName = `test_m_cleanup_abort_${crypto.randomUUID().replaceAll("-", "")}`;
    const candidateId = fixture.candidateId.replaceAll("'", "''");
    await env.DB.prepare(
      `CREATE TRIGGER ${triggerName}
       BEFORE UPDATE OF status ON memory_candidates
       WHEN OLD.id = '${candidateId}' AND NEW.status = 'approved'
       BEGIN
         SELECT RAISE(ABORT, 'forced relation cleanup approval failure');
       END`
    ).run();
    try {
      await expect(approveMetabolismCandidate(runtimeEnv, fixture.form)).rejects.toThrow();
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }

    await expect(env.DB.prepare(
      "SELECT id FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toMatchObject({ id: fixture.relationId });
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "pending" });
  });
});

describe("M relation cleanup rollback snapshot ownership", () => {
  it("restores the approval-time snapshot instead of the mutable candidate payload", async () => {
    const fixture = await relationCleanupFixture();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);
    await env.DB.prepare(
      `UPDATE memory_candidates
       SET payload_json = json_set(payload_json, '$.before.strength', 0.1)
       WHERE namespace = 'default' AND id = ?`
    ).bind(fixture.candidateId).run();

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form)).resolves.toMatchObject({
      action: "rollback",
      memory: null
    });
    await expect(env.DB.prepare(
      "SELECT strength FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toMatchObject({ strength: 0.8 });
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "rolled_back" });
    const event = await rollbackEvent(fixture.candidateId);
    expect(JSON.parse(event!.payload_json)).toMatchObject({ relation_restored: 1 });
  });

  it("does not resurrect a relation that was already absent at approval", async () => {
    const fixture = await relationCleanupFixture();
    await env.DB.prepare(
      "DELETE FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).run();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form)).resolves.toMatchObject({
      action: "rollback",
      memory: null
    });
    await expect(env.DB.prepare(
      "SELECT id FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toBeNull();
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "rolled_back" });
    const event = await rollbackEvent(fixture.candidateId);
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      relation_restored: 0,
      restored: null
    });
  });

  it("rejects rollback when a relation reappears after an absent approval snapshot", async () => {
    const fixture = await relationCleanupFixture();
    await env.DB.prepare(
      "DELETE FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).run();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);
    await env.DB.prepare(
      `INSERT INTO memory_relations
       (id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at)
       SELECT ?, 'default', id, id, 'same_event', 0.2, 'concurrent', ?
       FROM memories
       WHERE namespace = 'default'
       ORDER BY created_at DESC
       LIMIT 1`
    ).bind(fixture.relationId, new Date().toISOString()).run();

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form))
      .rejects.toThrow("metabolism_relation_rollback_conflict");
    await expect(env.DB.prepare(
      "SELECT relation_type FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toMatchObject({ relation_type: "same_event" });
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "approved" });
    await expect(rollbackEvent(fixture.candidateId)).resolves.toBeNull();
  });

  it("rejects an identical relation reinserted after a present approval snapshot", async () => {
    const fixture = await relationCleanupFixture();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);
    const snapshot = await env.DB.prepare(
      `SELECT payload_json
       FROM memory_events
       WHERE namespace = 'default' AND event_type = 'm_snapshot'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(fixture.candidateId).first<{ payload_json: string }>();
    const before = JSON.parse(snapshot!.payload_json).before as Record<string, unknown>;
    await env.DB.prepare(
      `INSERT INTO memory_relations
       (id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?)`
    ).bind(
      before.id,
      before.source_memory_id,
      before.target_memory_id,
      before.relation_type,
      before.strength,
      before.reason,
      before.created_at
    ).run();

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form))
      .rejects.toThrow("metabolism_relation_rollback_conflict");
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "approved" });
    await expect(rollbackEvent(fixture.candidateId)).resolves.toBeNull();
  });

  it("fails closed when the approval snapshot is missing", async () => {
    const fixture = await relationCleanupFixture();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);
    await env.DB.prepare(
      `DELETE FROM memory_events
       WHERE namespace = 'default' AND event_type = 'm_snapshot'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(fixture.candidateId).run();

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form))
      .rejects.toThrow("metabolism_relation_rollback_snapshot_invalid");
    await expect(env.DB.prepare(
      "SELECT id FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toBeNull();
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "approved" });
    await expect(rollbackEvent(fixture.candidateId)).resolves.toBeNull();
  });

  it("fails closed when the approval snapshot is malformed", async () => {
    const fixture = await relationCleanupFixture();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);
    await env.DB.prepare(
      `UPDATE memory_events
       SET payload_json = json_set(payload_json, '$.relation_was_present', 'false')
       WHERE namespace = 'default' AND event_type = 'm_snapshot'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(fixture.candidateId).run();

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form))
      .rejects.toThrow("metabolism_relation_rollback_snapshot_invalid");
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "approved" });
    await expect(rollbackEvent(fixture.candidateId)).resolves.toBeNull();
  });

  it("fails closed when the approval snapshot identity is blank", async () => {
    const fixture = await relationCleanupFixture();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);
    await env.DB.prepare(
      `UPDATE memory_events
       SET payload_json = json_set(payload_json, '$.before.id', '')
       WHERE namespace = 'default' AND event_type = 'm_snapshot'
         AND json_extract(payload_json, '$.candidate_id') = ?`
    ).bind(fixture.candidateId).run();

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form))
      .rejects.toThrow("metabolism_relation_rollback_snapshot_invalid");
    await expect(candidateState(fixture.candidateId)).resolves.toMatchObject({ status: "approved" });
    await expect(rollbackEvent(fixture.candidateId)).resolves.toBeNull();
  });

  it("does nothing after another owner changes the candidate status", async () => {
    const fixture = await relationCleanupFixture();
    await approveMetabolismCandidate(runtimeEnv, fixture.form);
    await env.DB.prepare(
      `UPDATE memory_candidates
       SET status = 'rejected'
       WHERE namespace = 'default' AND id = ? AND status = 'approved'`
    ).bind(fixture.candidateId).run();

    await expect(rollbackMetabolismCandidate(runtimeEnv, fixture.form)).resolves.toBeNull();
    await expect(env.DB.prepare(
      "SELECT id FROM memory_relations WHERE namespace = 'default' AND id = ?"
    ).bind(fixture.relationId).first()).resolves.toBeNull();
    await expect(rollbackEvent(fixture.candidateId)).resolves.toBeNull();
  });
});
