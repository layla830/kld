import { describe, expect, it } from "vitest";
import {
  assertReadOnlyHistoricalRelationQueries,
  buildHistoricalRelationManifest,
  buildHistoricalRelationPageQuery,
  buildHistoricalRelationSummaryQuery
} from "../scripts/historical-relation-governance.mjs";
import {
  parseHistoricalRelationAuditArgs
} from "../scripts/audit-historical-relations.mjs";

function relationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rel_1",
    namespace: "default",
    source_memory_id: "mem_source",
    target_memory_id: "mem_target",
    relation_type: "same_topic",
    strength: 0.8,
    reason: "free text",
    created_at: "2026-07-01T00:00:00.000Z",
    source_eligible: 0,
    source_status: "deleted",
    source_active_fact: 0,
    source_type: "note",
    source_updated_at: "2026-07-01T00:00:00.000Z",
    source_five_axis_revision: 2,
    target_eligible: 1,
    target_status: "active",
    target_active_fact: 1,
    target_type: "note",
    target_updated_at: "2026-07-01T00:00:00.000Z",
    target_five_axis_revision: 1,
    lifecycle_cohort: "stale_endpoint",
    provenance_class: "unproven_source",
    ...overrides
  };
}

describe("historical relation governance manifest", () => {
  it("builds SELECT-only mutually exclusive cohort queries", () => {
    const summary = buildHistoricalRelationSummaryQuery({ namespace: "default" });
    const page = buildHistoricalRelationPageQuery({
      namespace: "default",
      pageSize: 100
    });
    expect(() => assertReadOnlyHistoricalRelationQueries([summary, page]))
      .not.toThrow();
    expect(summary.sql).toContain("'stale_endpoint'");
    expect(summary.sql).toContain("'eligible_unproven'");
    expect(summary.sql).toContain("'eligible_proven'");
    expect(page.sql).toContain(
      "lifecycle_cohort IN ('stale_endpoint', 'eligible_unproven')"
    );
    expect(page.sql).not.toMatch(
      /\b(?:content|summary|tags|source_message_ids)\b/i
    );
  });

  it("hashes exact relation identities deterministically", () => {
    const summaryRows = [{
      lifecycle_cohort: "stale_endpoint",
      provenance_class: "unproven_source",
      relation_type: "same_topic",
      relation_count: 2,
      first_created_at: "2026-07-01T00:00:00.000Z",
      last_created_at: "2026-07-02T00:00:00.000Z"
    }];
    const rows = [
      relationRow({ id: "rel_2", created_at: "2026-07-02T00:00:00.000Z" }),
      relationRow({ id: "rel_1", created_at: "2026-07-01T00:00:00.000Z" })
    ];
    const first = buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows,
      rows,
      generatedAt: "2026-07-30T00:00:00.000Z"
    });
    const second = buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows,
      rows: [...rows].reverse(),
      generatedAt: "2026-07-30T00:00:00.000Z"
    });
    expect(first.relation_count).toBe(2);
    expect(first.counts_by_cohort).toEqual({
      stale_endpoint: 2,
      eligible_unproven: 0
    });
    expect(first.relations_sha256).toBe(second.relations_sha256);
    expect(first.selection_sha256).toBe(second.selection_sha256);
    expect(first.relations.map((relation) => relation.id))
      .toEqual(["rel_1", "rel_2"]);

    const changedSelection = buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows,
      rows: [
        rows[0],
        relationRow({
          id: "rel_1",
          created_at: "2026-07-01T00:00:00.000Z",
          source_five_axis_revision: 3
        })
      ],
      generatedAt: "2026-07-30T00:00:00.000Z"
    });
    expect(changedSelection.relations_sha256).toBe(first.relations_sha256);
    expect(changedSelection.selection_sha256).not.toBe(first.selection_sha256);
  });

  it("fails closed on summary mismatch, duplicates and non-debt rows", () => {
    expect(() => buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows: [{
        lifecycle_cohort: "stale_endpoint",
        relation_count: 2
      }],
      rows: [relationRow()]
    })).toThrow("historical_relation_manifest_summary_count_mismatch");
    expect(() => buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows: [{
        lifecycle_cohort: "stale_endpoint",
        relation_count: 2
      }],
      rows: [relationRow(), relationRow()]
    })).toThrow("historical_relation_manifest_duplicate");
    expect(() => buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows: [],
      rows: [relationRow({ lifecycle_cohort: "eligible_proven" })]
    })).toThrow("historical_relation_manifest_non_debt_cohort");
    expect(() => buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows: [{
        lifecycle_cohort: "stale_endpoint",
        relation_count: 1
      }],
      rows: [relationRow({ source_eligible: 2 })]
    })).toThrow("historical_relation_manifest_invalid_source_eligible");
    expect(() => buildHistoricalRelationManifest({
      namespace: "default",
      summaryRows: [{
        lifecycle_cohort: "stale_endpoint",
        relation_count: 1
      }],
      rows: [relationRow({ provenance_class: "guessed" })]
    })).toThrow("historical_relation_manifest_invalid_provenance_class");
  });

  it("keeps the CLI read-only and remote-explicit", () => {
    expect(() => parseHistoricalRelationAuditArgs([]))
      .toThrow("--remote is required");
    expect(parseHistoricalRelationAuditArgs([
      "--remote",
      "--namespace",
      "default",
      "--page-size",
      "100",
      "--output",
      ".audit/manifest.json"
    ])).toMatchObject({
      remote: true,
      namespace: "default",
      pageSize: 100,
      output: ".audit/manifest.json"
    });
  });
});
