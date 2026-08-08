import { describe, expect, it } from "vitest";
import { buildHistoricalRelationManifest } from "../scripts/historical-relation-governance.mjs";
import { DELETE_WRANGLER_FILE_PACKAGE } from "../scripts/delete-historical-relations.mjs";
import {
  loadHistoricalStructuralDeletePlan,
  parseHistoricalStructuralDeleteArgs,
  runHistoricalStructuralDelete
} from "../scripts/delete-historical-structural-mismatch.mjs";
import {
  parseHistoricalStructuralRollbackArgs,
  runHistoricalStructuralRollback
} from "../scripts/rollback-historical-structural-mismatch.mjs";
import {
  buildHistoricalStructuralDeleteBatchSql,
  buildHistoricalStructuralDeleteOverviewQuery
} from "../src/memory/historicalStructuralMismatchDeleteSql.js";

function manifest(includeSemantic = false) {
  const row = {
    id: "rel_structural_1",
    namespace: "default",
    source_memory_id: "source",
    target_memory_id: "target",
    relation_type: "same_fact_key",
    strength: 0.8,
    reason: null,
    created_at: "2026-08-01T00:00:00.000Z",
    source_eligible: 1,
    source_status: "active",
    source_active_fact: 1,
    source_type: "note",
    source_updated_at: "2026-08-01T00:00:00.000Z",
    source_five_axis_revision: 1,
    target_eligible: 1,
    target_status: "active",
    target_active_fact: 1,
    target_type: "note",
    target_updated_at: "2026-08-01T00:00:00.000Z",
    target_five_axis_revision: 1,
    lifecycle_cohort: "eligible_unproven",
    provenance_class: "unproven_source"
  };
  const rows = includeSemantic ? [{
    ...row,
    id: "rel_semantic_1",
    relation_type: "same_topic",
    created_at: "2026-08-01T00:01:00.000Z"
  }, row] : [row];
  const summaryRows = [{
    lifecycle_cohort: "eligible_unproven",
    provenance_class: "unproven_source",
    relation_type: "same_fact_key",
    relation_count: 1,
    first_created_at: row.created_at,
    last_created_at: row.created_at
  }];
  if (includeSemantic) {
    summaryRows.push({
      lifecycle_cohort: "eligible_unproven",
      provenance_class: "unproven_source",
      relation_type: "same_topic",
      relation_count: 1,
      first_created_at: "2026-08-01T00:01:00.000Z",
      last_created_at: "2026-08-01T00:01:00.000Z"
    });
  }
  return buildHistoricalRelationManifest({
    namespace: "default",
    summaryRows,
    rows,
    generatedAt: "2026-08-08T00:00:00.000Z"
  });
}

function plan() {
  const value = manifest();
  const manifestId = value.cohort_manifests.eligible_unproven.manifest_id;
  return loadHistoricalStructuralDeletePlan(value, {
    schema_version: 1,
    manifest_id: manifestId,
    relation_ids: ["rel_structural_1"]
  });
}

function stateFor(input: ReturnType<typeof plan>, status = "verified") {
  return {
    ...input.descriptor,
    status,
    deleted_relation_count: status === "deleted" ? 1 : 0,
    delete_batches_completed: status === "deleted" ? 1 : 0
  };
}

const applyEnvironment = {
  HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE: DELETE_WRANGLER_FILE_PACKAGE
};

describe("historical structural mismatch governance", () => {
  it("keeps the live structural mismatch predicate inside selection and delete SQL", () => {
    const input = plan();
    const overview = buildHistoricalStructuralDeleteOverviewQuery(
      input.descriptor.manifest_id,
      input.relationIds
    ).sql;
    const row = {
      ...input.rows[0],
      relation_id: input.rows[0].id,
      relation_created_at: input.rows[0].created_at
    };
    const batch = buildHistoricalStructuralDeleteBatchSql({
      descriptor: input.descriptor,
      rows: [row],
      batchId: "hrs_test",
      batchOrdinal: 1,
      deletedAt: "2026-08-08T01:00:00.000Z"
    });
    for (const sql of [overview, batch]) {
      expect(sql).toContain("source_memory.fact_key");
      expect(sql).toContain("target_memory.fact_key");
      expect(sql).toContain("source_memory.thread");
      expect(sql).toContain("target_memory.thread");
    }
    expect(overview).toContain("now_confirmable");
    expect(batch).toContain("historical_relation_deletions");

    const args = parseHistoricalStructuralDeleteArgs([
      "--remote", "--manifest", "manifest.json", "--selection", "selection.json"
    ]);
    let queryCalls = 0;
    expect(() => runHistoricalStructuralDelete(args, input, {
      query: () => {
        queryCalls += 1;
        if (queryCalls === 1) return { rows: [stateFor(input)], changes: 0, rowsWritten: 0 };
        return {
          rows: [{
            snapshot_count: 1,
            now_confirmable: 1,
            now_confirmable_relation_ids: "rel_structural_1"
          }],
          changes: 0,
          rowsWritten: 0
        };
      },
      file: () => {
        throw new Error("now-confirmable selection must not write");
      }
    })).toThrow("historical_structural_delete_now_confirmable:rel_structural_1");
  });

  it("fails closed on live drift before constructing a write batch", () => {
    const input = plan();
    const args = parseHistoricalStructuralDeleteArgs([
      "--remote", "--manifest", "manifest.json", "--selection", "selection.json",
      "--apply", "--confirm", input.descriptor.manifest_id,
      "--approve-selection", input.batchSha256
    ], applyEnvironment);
    let queryCalls = 0;
    let fileCalls = 0;
    expect(() => runHistoricalStructuralDelete(args, input, {
      query: () => {
        queryCalls += 1;
        if (queryCalls === 1) return { rows: [stateFor(input)], changes: 0, rowsWritten: 0 };
        return { rows: [{ snapshot_count: 1, drifted: 1 }], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        fileCalls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    })).toThrow("historical_structural_delete_drift_detected");
    expect(queryCalls).toBe(2);
    expect(fileCalls).toBe(0);
  });

  it("requires an explicit bounded selection and its exact apply approval", () => {
    expect(() => parseHistoricalStructuralDeleteArgs([
      "--remote", "--manifest", "manifest.json"
    ])).toThrow("--selection requires a value");
    expect(() => loadHistoricalStructuralDeletePlan(manifest(), {
      schema_version: 1,
      manifest_id: manifest().cohort_manifests.eligible_unproven.manifest_id,
      relation_ids: Array.from({ length: 11 }, (_, index) => `rel_${index}`)
    })).toThrow("historical_structural_delete_selection_count_invalid");
    const broadManifest = manifest(true);
    expect(() => loadHistoricalStructuralDeletePlan(broadManifest, {
      schema_version: 1,
      manifest_id: broadManifest.cohort_manifests.eligible_unproven.manifest_id,
      relation_ids: ["rel_structural_1"]
    })).toThrow("historical_structural_delete_manifest_not_dedicated");
    const input = plan();
    const args = parseHistoricalStructuralDeleteArgs([
      "--remote", "--manifest", "manifest.json", "--selection", "selection.json",
      "--apply", "--confirm", input.descriptor.manifest_id,
      "--approve-selection", "0".repeat(64)
    ], applyEnvironment);
    let calls = 0;
    expect(() => runHistoricalStructuralDelete(args, input, {
      query: () => { calls += 1; return { rows: [], changes: 0, rowsWritten: 0 }; },
      file: () => { calls += 1; return { rows: [], changes: 0, rowsWritten: 0 }; }
    })).toThrow(`--apply requires --approve-selection ${input.batchSha256}`);
    expect(calls).toBe(0);
  });

  it("treats an already attributed selection as a write-free replay", () => {
    const input = plan();
    const args = parseHistoricalStructuralDeleteArgs([
      "--remote", "--manifest", "manifest.json", "--selection", "selection.json",
      "--apply", "--confirm", input.descriptor.manifest_id,
      "--approve-selection", input.batchSha256
    ], applyEnvironment);
    let queryCalls = 0;
    let fileCalls = 0;
    const report = runHistoricalStructuralDelete(args, input, {
      query: () => {
        queryCalls += 1;
        if (queryCalls === 1) return { rows: [stateFor(input, "deleted")], changes: 0, rowsWritten: 0 };
        if (queryCalls === 2) {
          return { rows: [{ snapshot_count: 1, attributed_deleted: 1 }], changes: 0, rowsWritten: 0 };
        }
        return { rows: [], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        fileCalls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    });
    expect(report).toMatchObject({ replay: true, changed: 0 });
    expect(fileCalls).toBe(0);
  });

  it("refuses rollback when any selected ledger row has a live conflict", () => {
    const input = plan();
    const args = parseHistoricalStructuralRollbackArgs([
      "--remote", "--manifest", "manifest.json", "--selection", "selection.json",
      "--apply", "--confirm", input.descriptor.manifest_id,
      "--approve-selection", input.batchSha256
    ], applyEnvironment);
    let queryCalls = 0;
    let fileCalls = 0;
    expect(() => runHistoricalStructuralRollback(args, input, {
      query: () => {
        queryCalls += 1;
        if (queryCalls === 1) return { rows: [stateFor(input, "deleted")], changes: 0, rowsWritten: 0 };
        return { rows: [{ ledger_count: 1, conflict: 1 }], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        fileCalls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    })).toThrow("historical_structural_rollback_conflict_detected");
    expect(fileCalls).toBe(0);
  });
});
