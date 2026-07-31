import { describe, expect, it } from "vitest";
import {
  buildHistoricalRelationManifest
} from "../scripts/historical-relation-governance.mjs";
import {
  loadHistoricalRelationSnapshotPlan
} from "../scripts/snapshot-historical-relations.mjs";
import {
  buildHistoricalRelationDeleteBatchId,
  DELETE_WRANGLER_FILE_PACKAGE,
  parseHistoricalRelationDeleteArgs,
  runHistoricalRelationDelete,
  usage
} from "../scripts/delete-historical-relations.mjs";
import {
  buildHistoricalRelationDeleteBatchSql
} from "../src/memory/historicalRelationDeleteSql.js";

function deletePlan() {
  const row = {
    id: "rel_delete_1",
    namespace: "default",
    source_memory_id: "source",
    target_memory_id: "target",
    relation_type: "same_topic",
    strength: 0.8,
    reason: null,
    created_at: "2026-07-01T00:00:00.000Z",
    source_eligible: 0,
    source_status: "active",
    source_active_fact: 1,
    source_type: "diary",
    source_updated_at: "2026-07-01T00:00:00.000Z",
    source_five_axis_revision: 1,
    target_eligible: 1,
    target_status: "active",
    target_active_fact: 1,
    target_type: "note",
    target_updated_at: "2026-07-01T00:00:00.000Z",
    target_five_axis_revision: 1,
    lifecycle_cohort: "stale_endpoint",
    provenance_class: "unproven_source"
  };
  const manifest = buildHistoricalRelationManifest({
    namespace: "default",
    summaryRows: [{
      lifecycle_cohort: "stale_endpoint",
      provenance_class: "unproven_source",
      relation_type: "same_topic",
      relation_count: 1,
      first_created_at: row.created_at,
      last_created_at: row.created_at
    }],
    rows: [row],
    generatedAt: "2026-07-30T00:00:00.000Z"
  });
  return loadHistoricalRelationSnapshotPlan(
    manifest as unknown as Record<string, unknown>,
    "stale_endpoint"
  );
}

const deleteApplyEnvironment = {
  HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE: DELETE_WRANGLER_FILE_PACKAGE
};

describe("historical relation delete command", () => {
  it("requires the stale cohort and exact confirmation for apply", () => {
    expect(() => parseHistoricalRelationDeleteArgs([]))
      .toThrow("--remote is required");
    expect(() => parseHistoricalRelationDeleteArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "eligible_unproven"
    ])).toThrow("--cohort must be stale_endpoint");
    expect(usage()).toContain("never loops");

    const plan = deletePlan();
    expect(() => parseHistoricalRelationDeleteArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--apply",
      "--confirm",
      "wrong"
    ])).toThrow(
      `HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}`
    );

    const args = parseHistoricalRelationDeleteArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--apply",
      "--confirm",
      "wrong"
    ], deleteApplyEnvironment);
    let calls = 0;
    expect(() => runHistoricalRelationDelete(args, plan, {
      query: () => {
        calls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        calls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    })).toThrow(`--apply requires --confirm ${plan.descriptor.manifest_id}`);
    expect(calls).toBe(0);
  });

  it("builds a bounded ledger-first exact delete batch", () => {
    const plan = deletePlan();
    const row = {
      ...plan.rows[0],
      relation_id: plan.rows[0].id,
      relation_created_at: plan.rows[0].created_at
    };
    const batchId = buildHistoricalRelationDeleteBatchId(
      String(plan.descriptor.manifest_id),
      1,
      [row]
    );
    const sql = buildHistoricalRelationDeleteBatchSql({
      descriptor: plan.descriptor,
      rows: [row],
      batchId,
      batchOrdinal: 1,
      deletedAt: "2026-07-30T01:00:00.000Z"
    });
    expect(sql).toContain("INSERT OR IGNORE INTO historical_relation_deletions");
    expect(sql).toContain("DELETE FROM memory_relations");
    expect(sql).toContain("source_memory.five_axis_revision");
    expect(sql).toContain("target_memory.five_axis_revision");
    expect(sql).toContain("status = 'delete_in_progress'");
    expect(sql).toContain("status = 'deleted'");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\s+memories\b/i);
    expect((sql.match(/DELETE FROM memory_relations/g) ?? [])).toHaveLength(1);
  });

  it("keeps dry-run read-only and reports drift and attribution separately", () => {
    const plan = deletePlan();
    const args = parseHistoricalRelationDeleteArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint"
    ]);
    let call = 0;
    let fileCalls = 0;
    const report = runHistoricalRelationDelete(args, plan, {
      query: () => {
        call += 1;
        if (call === 1) {
          return {
            rows: [{
              ...plan.descriptor,
              status: "verified",
              delete_batches_completed: 0
            }],
            changes: 0,
            rowsWritten: 0
          };
        }
        if (call === 2) {
          return {
            rows: [{
              snapshot_count: 1,
              attributed_deleted: 0,
              missing_unattributed: 0,
              drifted: 1,
              deletable: 0
            }],
            changes: 0,
            rowsWritten: 0
          };
        }
        return { rows: [], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        fileCalls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    });
    expect(fileCalls).toBe(0);
    expect(report).toMatchObject({
      mode: "dry_run",
      remote_status: "verified",
      drifted: 1,
      deletable: 0,
      selected: 0,
      changed: 0
    });
  });

  it("fails closed before apply when any snapshot row drifted", () => {
    const plan = deletePlan();
    const args = parseHistoricalRelationDeleteArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--apply",
      "--confirm",
      String(plan.descriptor.manifest_id)
    ], deleteApplyEnvironment);
    let call = 0;
    let fileCalls = 0;
    expect(() => runHistoricalRelationDelete(args, plan, {
      query: () => {
        call += 1;
        if (call === 1) {
          return {
            rows: [{
              ...plan.descriptor,
              status: "verified",
              deleted_relation_count: 0,
              delete_batches_completed: 0
            }],
            changes: 0,
            rowsWritten: 0
          };
        }
        return {
          rows: [{
            snapshot_count: 1,
            attributed_deleted: 0,
            missing_unattributed: 0,
            drifted: 1,
            deletable: 0
          }],
          changes: 0,
          rowsWritten: 0
        };
      },
      file: () => {
        fileCalls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    })).toThrow("historical_relation_delete_drift_detected");
    expect(call).toBe(2);
    expect(fileCalls).toBe(0);
  });
});
