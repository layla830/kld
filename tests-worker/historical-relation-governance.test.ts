import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertReadOnlyHistoricalRelationQueries,
  buildHistoricalRelationManifest,
  buildHistoricalRelationPageQuery,
  buildHistoricalRelationSummaryQuery
} from "../scripts/historical-relation-governance.mjs";
import { createMemory } from "../src/db/memories";

describe("historical relation governance D1 manifest", () => {
  it("classifies debt cohorts without overlapping eligible proven relations", async () => {
    const namespace = `historical-relations-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const eligibleSource = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "eligible source",
      status: "active"
    });
    const eligibleTarget = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "eligible target",
      status: "active"
    });
    const ineligibleSource = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "ineligible source",
      status: "active"
    });
    const targets = [];
    for (let index = 0; index < 4; index += 1) {
      targets.push(await createMemory(env.DB, {
        namespace,
        type: "note",
        content: `target ${index}`,
        status: "active"
      }));
    }
    const fixtures = [
      [ineligibleSource.id, targets[0].id, "free text"],
      [ineligibleSource.id, targets[1].id, "legacy-backfill:thread old"],
      [eligibleSource.id, targets[2].id, "free text"],
      [eligibleTarget.id, targets[3].id, "y:auto:mem_source:1"]
    ];
    await env.DB.batch(fixtures.map(([sourceId, targetId, reason], index) =>
      env.DB.prepare(
        `INSERT INTO memory_relations (
           id, namespace, source_memory_id, target_memory_id,
           relation_type, strength, reason, created_at
         ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, ?, ?)`
      ).bind(
        `rel_${crypto.randomUUID()}`,
        namespace,
        sourceId,
        targetId,
        reason,
        new Date(Date.now() + index).toISOString()
      )
    ));

    const summaryQuery = buildHistoricalRelationSummaryQuery({ namespace });
    const pageQuery = buildHistoricalRelationPageQuery({
      namespace,
      pageSize: 100
    });
    assertReadOnlyHistoricalRelationQueries([summaryQuery, pageQuery]);
    const summary = await env.DB.prepare(summaryQuery.sql)
      .all<Record<string, unknown>>();
    const page = await env.DB.prepare(pageQuery.sql)
      .all<Record<string, unknown>>();
    const summaryRows = summary.results ?? [];
    const pageRows = page.results ?? [];

    expect(summaryRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lifecycle_cohort: "stale_endpoint",
        provenance_class: "unproven_source",
        relation_count: 1
      }),
      expect.objectContaining({
        lifecycle_cohort: "stale_endpoint",
        provenance_class: "legacy_backfill",
        relation_count: 1
      }),
      expect.objectContaining({
        lifecycle_cohort: "eligible_unproven",
        provenance_class: "unproven_source",
        relation_count: 1
      }),
      expect.objectContaining({
        lifecycle_cohort: "eligible_proven",
        provenance_class: "builder_backed",
        relation_count: 1
      })
    ]));
    expect(pageRows).toHaveLength(3);
    const manifest = buildHistoricalRelationManifest({
      namespace,
      summaryRows,
      rows: pageRows,
      generatedAt: now
    });
    expect(manifest.counts_by_cohort).toEqual({
      stale_endpoint: 2,
      eligible_unproven: 1
    });
  });
});
