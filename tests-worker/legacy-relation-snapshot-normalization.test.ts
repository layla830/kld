import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { createMemory } from "../src/db/memories";
import {
  buildLegacyRelationSnapshotApplyQuery,
  buildLegacyRelationSnapshotDryRunQuery
} from "../scripts/legacy-relation-snapshot-normalization.mjs";

interface FixtureOptions {
  createdAt?: string;
  duplicate?: boolean;
  identityMismatch?: boolean;
  currentRelation?: boolean;
  resultMemoryId?: boolean;
}

async function seedLegacySnapshot(
  namespace: string,
  memoryId: string,
  suffix: string,
  options: FixtureOptions = {}
): Promise<{ candidateId: string; snapshotId: string }> {
  const relationId = `legacy_snapshot_relation_${suffix}`;
  const relationCreatedAt = "2026-07-01T00:00:00.000Z";
  const before = {
    id: relationId,
    namespace,
    source_memory_id: memoryId,
    target_memory_id: memoryId,
    relation_type: "same_topic",
    strength: 0.8,
    reason: "worker test",
    created_at: relationCreatedAt
  };
  const externalKey = `m-review:relation:${relationId}:${relationCreatedAt}`;
  await upsertMemoryCandidate(env.DB, namespace, {
    externalKey,
    dreamDate: "2026-07-01",
    action: "m_relation_cleanup",
    subject: "system",
    payload: {
      _kind: "metabolism_relation_cleanup",
      before: options.identityMismatch
        ? { ...before, relation_type: "same_event" }
        : before
    },
    sourceChunkIds: [],
    status: "pending"
  });
  const candidate = await env.DB.prepare(
    "SELECT id FROM memory_candidates WHERE namespace = ? AND external_key = ?"
  ).bind(namespace, externalKey).first<{ id: string }>();
  if (!candidate) throw new Error("candidate fixture missing");
  await env.DB.prepare(
    `UPDATE memory_candidates
     SET status = 'approved', result_memory_id = ?
     WHERE namespace = ? AND id = ?`
  ).bind(options.resultMemoryId ? relationId : null, namespace, candidate.id).run();

  const snapshotId = `legacy_snapshot_${suffix}`;
  const payload = JSON.stringify({
    candidate_id: candidate.id,
    action: "m_relation_cleanup",
    before
  });
  await env.DB.prepare(
    `INSERT INTO memory_events (
       id, namespace, event_type, memory_id, payload_json, created_at
     ) VALUES (?, ?, 'm_snapshot', NULL, ?, ?)`
  ).bind(
    snapshotId,
    namespace,
    payload,
    options.createdAt ?? "2026-07-20T08:00:00.000Z"
  ).run();
  if (options.duplicate) {
    await env.DB.prepare(
      `INSERT INTO memory_events (
         id, namespace, event_type, memory_id, payload_json, created_at
       ) VALUES (?, ?, 'm_snapshot', NULL, ?, ?)`
    ).bind(
      `${snapshotId}_duplicate`,
      namespace,
      payload,
      options.createdAt ?? "2026-07-20T08:00:00.000Z"
    ).run();
  }
  if (options.currentRelation) {
    await env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id,
         relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, 'worker test current', ?)`
    ).bind(relationId, namespace, memoryId, memoryId, relationCreatedAt).run();
  }
  return { candidateId: candidate.id, snapshotId };
}

describe("legacy relation snapshot normalization", () => {
  it("normalizes only the proven legacy cohort and is idempotent", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `legacy-snapshot-${suffix}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "legacy snapshot endpoint",
      status: "active",
      source: "worker-test"
    });
    const repairable = await seedLegacySnapshot(
      namespace,
      memory.id,
      `${suffix}_repairable`
    );
    await seedLegacySnapshot(namespace, memory.id, `${suffix}_mismatch`, {
      identityMismatch: true
    });
    await seedLegacySnapshot(namespace, memory.id, `${suffix}_duplicate`, {
      duplicate: true
    });
    await seedLegacySnapshot(namespace, memory.id, `${suffix}_conflict`, {
      currentRelation: true
    });
    await seedLegacySnapshot(namespace, memory.id, `${suffix}_late`, {
      createdAt: "2026-07-20T10:00:00.000Z"
    });
    await seedLegacySnapshot(namespace, memory.id, `${suffix}_modern_result`, {
      resultMemoryId: true
    });

    const input = { namespace, limit: 100 };
    const dryRun = buildLegacyRelationSnapshotDryRunQuery(input);
    await expect(env.DB.prepare(dryRun.sql).first()).resolves.toMatchObject({
      legacy_missing_flag_rows: 7,
      repairable_rows: 1,
      selected: 1,
      has_more: 0,
      non_unique_rows: 2,
      outside_legacy_window_rows: 1,
      identity_or_shape_mismatch_rows: 1,
      unexpected_result_memory_id_rows: 1,
      current_relation_conflict_rows: 1
    });

    const apply = buildLegacyRelationSnapshotApplyQuery(input);
    const first = await env.DB.prepare(apply.sql).all<{ id: string }>();
    expect(first.results).toEqual([{ id: repairable.snapshotId }]);
    await expect(env.DB.prepare(
      `SELECT json_type(payload_json, '$.relation_was_present') AS flag_type,
              json_extract(payload_json, '$.relation_was_present') AS flag_value
       FROM memory_events
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, repairable.snapshotId).first())
      .resolves.toEqual({ flag_type: "true", flag_value: 1 });
    await expect(env.DB.prepare(dryRun.sql).first()).resolves.toMatchObject({
      legacy_missing_flag_rows: 6,
      repairable_rows: 0
    });

    const second = await env.DB.prepare(apply.sql).all<{ id: string }>();
    expect(second.results).toEqual([]);
  });
});
