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
import {
  buildHistoricalRelationDeletableRowsQuery,
  buildHistoricalRelationDeleteBatchStatements,
  buildHistoricalRelationDeleteOverviewQuery
} from "../src/memory/historicalRelationDeleteSql.js";
import {
  buildHistoricalRelationRestorableRowsQuery,
  buildHistoricalRelationRollbackBatchStatements,
  buildHistoricalRelationRollbackOverviewQuery
} from "../src/memory/historicalRelationRollbackSql.js";

async function verifiedDeleteFixture(namespace: string) {
  const source = await createMemory(env.DB, {
    namespace,
    type: "diary",
    content: "ineligible historical endpoint",
    status: "active"
  });
  const target = await createMemory(env.DB, {
    namespace,
    type: "note",
    content: "eligible endpoint",
    status: "active"
  });
  const relationId = `rel_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO memory_relations (
       id, namespace, source_memory_id, target_memory_id,
       relation_type, strength, reason, created_at
     ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, NULL,
       '2026-07-01T00:00:00.000Z')`
  ).bind(relationId, namespace, source.id, target.id).run();
  const summary = await env.DB.prepare(
    buildHistoricalRelationSummaryQuery({ namespace }).sql
  ).all<Record<string, unknown>>();
  const page = await env.DB.prepare(
    buildHistoricalRelationPageQuery({ namespace, pageSize: 100 }).sql
  ).all<Record<string, unknown>>();
  const generatedAt = "2026-07-30T00:00:00.000Z";
  const manifest = buildHistoricalRelationManifest({
    namespace,
    summaryRows: summary.results ?? [],
    rows: page.results ?? [],
    generatedAt
  });
  const cohort = manifest.cohort_manifests.stale_endpoint;
  const descriptor = {
    manifest_id: cohort.manifest_id,
    namespace,
    lifecycle_cohort: "stale_endpoint",
    selection_predicate_version: manifest.selection_predicate_version,
    expected_relation_count: cohort.relation_count,
    expected_relations_sha256: cohort.relations_sha256,
    expected_selection_sha256: cohort.selection_sha256,
    created_at: generatedAt
  };
  const row = manifest.relations.find(
    (candidate) => candidate.id === relationId
  ) as Record<string, unknown>;
  await env.DB.batch(buildHistoricalRelationSnapshotBatchStatements(
    descriptor,
    [row],
    "2026-07-30T00:01:00.000Z"
  ).map((sql) => env.DB.prepare(sql)));
  await env.DB.prepare(buildHistoricalRelationVerifySql(
    descriptor,
    "2026-07-30T00:02:00.000Z"
  )).run();
  return { source, target, relationId, descriptor };
}

describe("historical relation bounded delete", () => {
  it("deletes only through an attributed ledger row and is replay-safe", async () => {
    const namespace = `historical-delete-${crypto.randomUUID()}`;
    const fixture = await verifiedDeleteFixture(namespace);
    const selected = await env.DB.prepare(
      buildHistoricalRelationDeletableRowsQuery(
        String(fixture.descriptor.manifest_id),
        100
      ).sql
    ).all<Record<string, unknown>>();
    expect(selected.results).toHaveLength(1);
    const input = {
      descriptor: fixture.descriptor,
      rows: selected.results ?? [],
      batchId: "hrd_test_batch_1",
      batchOrdinal: 1,
      deletedAt: "2026-07-30T01:00:00.000Z"
    };
    const statements = buildHistoricalRelationDeleteBatchStatements(input);
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));

    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, fixture.relationId).first<number>("count"))
      .resolves.toBe(0);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM historical_relation_deletions
       WHERE manifest_id = ? AND relation_id = ?`
    ).bind(
      fixture.descriptor.manifest_id,
      fixture.relationId
    ).first<number>("count")).resolves.toBe(1);
    await expect(env.DB.prepare(
      `SELECT status
       FROM historical_relation_manifests
       WHERE manifest_id = ?`
    ).bind(fixture.descriptor.manifest_id).first<string>("status"))
      .resolves.toBe("deleted");

    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM historical_relation_deletions
       WHERE manifest_id = ?`
    ).bind(fixture.descriptor.manifest_id).first<number>("count"))
      .resolves.toBe(1);

    await env.DB.prepare(
      `UPDATE memories
       SET five_axis_revision = five_axis_revision + 1
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, fixture.source.id).run();
    const restorable = await env.DB.prepare(
      buildHistoricalRelationRestorableRowsQuery(
        String(fixture.descriptor.manifest_id),
        100
      ).sql
    ).all<Record<string, unknown>>();
    expect(restorable.results).toHaveLength(1);
    const rollbackStatements = buildHistoricalRelationRollbackBatchStatements({
      descriptor: fixture.descriptor,
      rows: restorable.results ?? [],
      restoredAt: "2026-07-30T02:00:00.000Z"
    });
    await env.DB.batch(rollbackStatements.map((sql) => env.DB.prepare(sql)));
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, fixture.relationId).first<number>("count"))
      .resolves.toBe(1);
    await expect(env.DB.prepare(
      `SELECT status
       FROM historical_relation_manifests
       WHERE manifest_id = ?`
    ).bind(fixture.descriptor.manifest_id).first<string>("status"))
      .resolves.toBe("rolled_back");
    const rollbackOverview = await env.DB.prepare(
      buildHistoricalRelationRollbackOverviewQuery(
        String(fixture.descriptor.manifest_id)
      ).sql
    ).first<Record<string, number>>();
    expect(rollbackOverview).toMatchObject({
      ledger_count: 1,
      restored: 1,
      restorable: 0,
      conflict: 0
    });

    await env.DB.batch(rollbackStatements.map((sql) => env.DB.prepare(sql)));
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, fixture.relationId).first<number>("count"))
      .resolves.toBe(1);
  });

  it("classifies endpoint revision drift and selects no delete", async () => {
    const namespace = `historical-drift-${crypto.randomUUID()}`;
    const fixture = await verifiedDeleteFixture(namespace);
    await env.DB.prepare(
      `UPDATE memories
       SET five_axis_revision = five_axis_revision + 1
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, fixture.source.id).run();

    const overview = await env.DB.prepare(
      buildHistoricalRelationDeleteOverviewQuery(
        String(fixture.descriptor.manifest_id)
      ).sql
    ).first<Record<string, number>>();
    expect(overview).toMatchObject({
      snapshot_count: 1,
      attributed_deleted: 0,
      missing_unattributed: 0,
      drifted: 1,
      deletable: 0
    });
    const selected = await env.DB.prepare(
      buildHistoricalRelationDeletableRowsQuery(
        String(fixture.descriptor.manifest_id),
        100
      ).sql
    ).all();
    expect(selected.results).toHaveLength(0);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, fixture.relationId).first<number>("count"))
      .resolves.toBe(1);
  });
});
