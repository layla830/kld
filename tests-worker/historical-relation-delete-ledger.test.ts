import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function insertVerifiedManifest(manifestId: string, relationId: string) {
  await env.DB.prepare(
    `INSERT INTO historical_relation_manifests (
       manifest_id,
       namespace,
       lifecycle_cohort,
       selection_predicate_version,
       expected_relation_count,
       expected_relations_sha256,
       expected_selection_sha256,
       snapshot_relation_count,
       status,
       created_at,
       verified_at,
       verified_relations_sha256,
       verified_selection_sha256
     ) VALUES (?, 'default', 'stale_endpoint', 'test:v1', 1, ?, ?, 1,
       'verified', '2026-07-30T00:00:00.000Z', '2026-07-30T00:01:00.000Z',
       ?, ?)`
  ).bind(manifestId, HASH_A, HASH_B, HASH_A, HASH_B).run();
  await env.DB.prepare(
    `INSERT INTO historical_relation_snapshots (
       manifest_id, namespace, lifecycle_cohort, relation_id,
       source_memory_id, target_memory_id, relation_type, strength, reason,
       relation_created_at, identity_sha256, selection_sha256,
       source_eligible, source_status, source_active_fact, source_type,
       source_updated_at, source_five_axis_revision,
       target_eligible, target_status, target_active_fact, target_type,
       target_updated_at, target_five_axis_revision,
       provenance_class, snapshotted_at
     ) VALUES (
       ?, 'default', 'stale_endpoint', ?, 'source', 'target', 'same_topic',
       0.8, NULL, '2026-07-01T00:00:00.000Z', ?, ?, 0, 'active', 1,
       'diary', '2026-07-01T00:00:00.000Z', 1, 1, 'active', 1, 'note',
       '2026-07-01T00:00:00.000Z', 1, 'unproven_source',
       '2026-07-30T00:00:00.000Z'
     )`
  ).bind(manifestId, relationId, HASH_A, HASH_B).run();
}

describe("historical relation deletion ledger", () => {
  it("preserves exact deletion attribution and write-once lifecycle evidence", async () => {
    const manifestId = `hrg_${crypto.randomUUID().replaceAll("-", "")}`;
    const relationId = `rel_${crypto.randomUUID().replaceAll("-", "")}`;
    await insertVerifiedManifest(manifestId, relationId);

    await env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET status = 'delete_in_progress'
       WHERE manifest_id = ?`
    ).bind(manifestId).run();
    await expect(env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET status = 'deleted', deleted_at = '2026-07-30T01:00:00.000Z'
       WHERE manifest_id = ?`
    ).bind(manifestId).run())
      .rejects.toThrow("historical_relation_manifest_delete_audit_invalid");

    await env.DB.prepare(
      `INSERT INTO historical_relation_deletions (
         manifest_id, relation_id, batch_id, batch_ordinal, deleted_at
       ) VALUES (?, ?, 'batch-1', 1, '2026-07-30T01:00:00.000Z')`
    ).bind(manifestId, relationId).run();
    await env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET status = 'deleted',
           deleted_relation_count = 1,
           delete_batches_completed = 1,
           deleted_at = '2026-07-30T01:00:00.000Z'
       WHERE manifest_id = ?`
    ).bind(manifestId).run();

    await expect(env.DB.prepare(
      `SELECT json_object(
         'status', status,
         'deleted', deleted_relation_count,
         'batches', delete_batches_completed
       ) AS state
       FROM historical_relation_manifests
       WHERE manifest_id = ?`
    ).bind(manifestId).first<string>("state"))
      .resolves.toBe('{"status":"deleted","deleted":1,"batches":1}');

    await expect(env.DB.prepare(
      `DELETE FROM historical_relation_deletions
       WHERE manifest_id = ? AND relation_id = ?`
    ).bind(manifestId, relationId).run())
      .rejects.toThrow("historical_relation_deletion_delete_forbidden");
    await expect(env.DB.prepare(
      `UPDATE historical_relation_deletions
       SET deleted_at = '2026-07-30T02:00:00.000Z'
       WHERE manifest_id = ? AND relation_id = ?`
    ).bind(manifestId, relationId).run())
      .rejects.toThrow("historical_relation_deletion_identity_immutable");
    await expect(env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET deleted_at = '2026-07-30T02:00:00.000Z'
       WHERE manifest_id = ?`
    ).bind(manifestId).run())
      .rejects.toThrow("historical_relation_manifest_delete_audit_invalid");
    await expect(env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET status = 'delete_in_progress'
       WHERE manifest_id = ?`
    ).bind(manifestId).run())
      .rejects.toThrow("historical_relation_manifest_status_regression");

    await env.DB.prepare(
      `UPDATE historical_relation_deletions
       SET restored_at = '2026-07-30T03:00:00.000Z'
       WHERE manifest_id = ? AND relation_id = ?`
    ).bind(manifestId, relationId).run();
    await env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET status = 'rolled_back',
           rolled_back_at = '2026-07-30T03:00:00.000Z'
       WHERE manifest_id = ?`
    ).bind(manifestId).run();
    await expect(env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET status = 'deleted'
       WHERE manifest_id = ?`
    ).bind(manifestId).run())
      .rejects.toThrow("historical_relation_manifest_status_regression");
    await expect(env.DB.prepare(
      `UPDATE historical_relation_deletions
       SET restored_at = '2026-07-30T04:00:00.000Z'
       WHERE manifest_id = ? AND relation_id = ?`
    ).bind(manifestId, relationId).run())
      .rejects.toThrow("historical_relation_deletion_identity_immutable");
  });

  it("rejects progress counters that do not match the immutable ledger", async () => {
    const manifestId = `hrg_${crypto.randomUUID().replaceAll("-", "")}`;
    const relationId = `rel_${crypto.randomUUID().replaceAll("-", "")}`;
    await insertVerifiedManifest(manifestId, relationId);

    await expect(env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET deleted_relation_count = 1,
           delete_batches_completed = 1
       WHERE manifest_id = ?`
    ).bind(manifestId).run())
      .rejects.toThrow("historical_relation_manifest_delete_progress_invalid");
  });
});
