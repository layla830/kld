import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemory } from "../src/db/memories";
import {
  buildHistoricalRelationManifest,
  buildHistoricalRelationPageQuery,
  buildHistoricalRelationSummaryQuery
} from "../scripts/historical-relation-governance.mjs";
import {
  buildHistoricalRelationSnapshotBatchStatements,
  buildHistoricalRelationVerifySql
} from "../src/memory/historicalRelationSnapshotSql.js";

async function buildStaleManifestFixture(namespace: string) {
  const source = await createMemory(env.DB, {
    namespace,
    type: "diary",
    content: "historical diary endpoint",
    status: "active"
  });
  const target = await createMemory(env.DB, {
    namespace,
    type: "note",
    content: "eligible target",
    status: "active"
  });
  const relationId = `rel_${crypto.randomUUID()}`;
  const createdAt = "2026-07-30T01:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO memory_relations (
       id, namespace, source_memory_id, target_memory_id,
       relation_type, strength, reason, created_at
     ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, 'free text', ?)`
  ).bind(relationId, namespace, source.id, target.id, createdAt).run();

  const summary = await env.DB.prepare(
    buildHistoricalRelationSummaryQuery({ namespace }).sql
  ).all<Record<string, unknown>>();
  const page = await env.DB.prepare(
    buildHistoricalRelationPageQuery({ namespace, pageSize: 100 }).sql
  ).all<Record<string, unknown>>();
  const generatedAt = "2026-07-30T02:00:00.000Z";
  const manifest = buildHistoricalRelationManifest({
    namespace,
    summaryRows: summary.results ?? [],
    rows: page.results ?? [],
    generatedAt
  });
  return {
    relationId,
    generatedAt,
    row: manifest.relations[0] as Record<string, unknown>,
    cohort: manifest.cohort_manifests.stale_endpoint,
    selectionPredicateVersion: manifest.selection_predicate_version
  };
}

async function insertManifest(
  namespace: string,
  fixture: Awaited<ReturnType<typeof buildStaleManifestFixture>>
) {
  await env.DB.prepare(
    `INSERT INTO historical_relation_manifests (
       manifest_id,
       namespace,
       lifecycle_cohort,
       selection_predicate_version,
       expected_relation_count,
       expected_relations_sha256,
       expected_selection_sha256,
       created_at
     ) VALUES (?, ?, 'stale_endpoint', ?, ?, ?, ?, ?)`
  ).bind(
    fixture.cohort.manifest_id,
    namespace,
    fixture.selectionPredicateVersion,
    fixture.cohort.relation_count,
    fixture.cohort.relations_sha256,
    fixture.cohort.selection_sha256,
    fixture.generatedAt
  ).run();
}

describe("historical relation snapshot schema lifecycle", () => {
  it("executes generated apply and verify SQL and repairs a stale manifest count", async () => {
    const namespace = `historical-builder-${crypto.randomUUID()}`;
    const fixture = await buildStaleManifestFixture(namespace);
    const descriptor = {
      manifest_id: fixture.cohort.manifest_id,
      namespace,
      lifecycle_cohort: "stale_endpoint",
      selection_predicate_version: fixture.selectionPredicateVersion,
      expected_relation_count: fixture.cohort.relation_count,
      expected_relations_sha256: fixture.cohort.relations_sha256,
      expected_selection_sha256: fixture.cohort.selection_sha256,
      created_at: fixture.generatedAt
    };

    await env.DB.batch(buildHistoricalRelationSnapshotBatchStatements(
      descriptor,
      [fixture.row],
      "2026-07-30T03:00:00.000Z"
    ).map((sql) => env.DB.prepare(sql)));

    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM historical_relation_snapshots
       WHERE manifest_id = ?`
    ).bind(descriptor.manifest_id).first<number>("count"))
      .resolves.toBe(1);

    // Simulate a non-atomic/interrupted legacy execution where snapshot rows
    // landed but the batch-tail count refresh did not.
    await env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET snapshot_relation_count = 0
       WHERE manifest_id = ?`
    ).bind(descriptor.manifest_id).run();

    const verified = await env.DB.prepare(buildHistoricalRelationVerifySql(
      descriptor,
      "2026-07-30T03:01:00.000Z"
    )).first<string>("manifest_id");
    expect(verified).toBe(descriptor.manifest_id);

    await expect(env.DB.prepare(
      `SELECT json_object(
         'status', status,
         'count', snapshot_relation_count
       ) AS state
       FROM historical_relation_manifests
       WHERE manifest_id = ?`
    ).bind(descriptor.manifest_id).first<string>("state"))
      .resolves.toBe('{"status":"verified","count":1}');

    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, fixture.relationId).first<number>("count"))
      .resolves.toBe(1);
  });

  it("preserves verified manifests and snapshot rows as immutable evidence", async () => {
    const namespace = `historical-snapshot-${crypto.randomUUID()}`;
    const fixture = await buildStaleManifestFixture(namespace);
    const row = fixture.row;
    await insertManifest(namespace, fixture);
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
         ?, ?, 'stale_endpoint', ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`
    ).bind(
      fixture.cohort.manifest_id,
      namespace,
      row.id,
      row.source_memory_id,
      row.target_memory_id,
      row.relation_type,
      row.strength,
      row.reason,
      row.created_at,
      row.identity_sha256,
      row.selection_sha256,
      row.source_eligible ? 1 : 0,
      row.source_status,
      row.source_active_fact,
      row.source_type,
      row.source_updated_at,
      row.source_five_axis_revision,
      row.target_eligible ? 1 : 0,
      row.target_status,
      row.target_active_fact,
      row.target_type,
      row.target_updated_at,
      row.target_five_axis_revision,
      row.provenance_class,
      "2026-07-30T03:00:00.000Z"
    ).run();
    await env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET snapshot_relation_count = 1,
           status = 'verified',
           verified_at = ?,
           verified_relations_sha256 = expected_relations_sha256,
           verified_selection_sha256 = expected_selection_sha256
       WHERE manifest_id = ?`
    ).bind(
      "2026-07-30T03:01:00.000Z",
      fixture.cohort.manifest_id
    ).run();

    await expect(env.DB.prepare(
      `SELECT status
       FROM historical_relation_manifests
       WHERE manifest_id = ?`
    ).bind(fixture.cohort.manifest_id).first("status"))
      .resolves.toBe("verified");
    await expect(env.DB.prepare(
      `UPDATE historical_relation_snapshots
       SET reason = 'changed'
       WHERE manifest_id = ? AND relation_id = ?`
    ).bind(fixture.cohort.manifest_id, fixture.relationId).run())
      .rejects.toThrow("historical_relation_snapshot_update_forbidden");
    await expect(env.DB.prepare(
      `DELETE FROM historical_relation_manifests
       WHERE manifest_id = ?`
    ).bind(fixture.cohort.manifest_id).run())
      .rejects.toThrow("historical_relation_manifest_delete_forbidden");
    await expect(env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET verified_at = '2026-07-30T04:00:00.000Z'
       WHERE manifest_id = ?`
    ).bind(fixture.cohort.manifest_id).run())
      .rejects.toThrow("historical_relation_manifest_identity_immutable");
  });

  it("cannot mark an incomplete snapshot as verified", async () => {
    const namespace = `historical-incomplete-${crypto.randomUUID()}`;
    const fixture = await buildStaleManifestFixture(namespace);
    await insertManifest(namespace, fixture);
    await expect(env.DB.prepare(
      `UPDATE historical_relation_manifests
       SET status = 'verified',
           verified_at = ?,
           verified_relations_sha256 = expected_relations_sha256,
           verified_selection_sha256 = expected_selection_sha256
       WHERE manifest_id = ?`
    ).bind(
      "2026-07-30T03:01:00.000Z",
      fixture.cohort.manifest_id
    ).run()).rejects.toThrow("CHECK constraint failed");
    await expect(env.DB.prepare(
      `SELECT status
       FROM historical_relation_manifests
       WHERE manifest_id = ?`
    ).bind(fixture.cohort.manifest_id).first("status"))
      .resolves.toBe("staging");
  });
});
