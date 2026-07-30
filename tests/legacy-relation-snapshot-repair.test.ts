import { describe, expect, it } from "vitest";
import {
  assertReadOnlyLegacyRelationSnapshotQuery,
  buildLegacyRelationSnapshotApplyQuery,
  buildLegacyRelationSnapshotDryRunQuery,
  parseLegacyRelationSnapshotRepairArgs,
  runLegacyRelationSnapshotRepair,
  usage
} from "../scripts/repair-legacy-relation-snapshots.mjs";

describe("legacy relation snapshot repair command", () => {
  it("requires explicit remote apply confirmation and has no looping mode", () => {
    expect(() => parseLegacyRelationSnapshotRepairArgs([])).toThrow("--remote is required");
    for (const option of ["--all", "--cohort", "--action"]) {
      expect(() => parseLegacyRelationSnapshotRepairArgs(["--remote", option]))
        .toThrow("Unknown argument");
    }
    expect(() => parseLegacyRelationSnapshotRepairArgs(["--remote", "--apply"]))
      .toThrow("--apply requires --confirm legacy-relation-snapshots");
    expect(() => parseLegacyRelationSnapshotRepairArgs([
      "--remote",
      "--confirm",
      "legacy-relation-snapshots"
    ])).toThrow("--confirm is only valid with --apply");
    expect(parseLegacyRelationSnapshotRepairArgs([
      "--remote",
      "--limit",
      "25",
      "--json"
    ])).toMatchObject({ remote: true, limit: 25, apply: false, json: true });
    expect(usage()).toContain("does not loop automatically");
  });

  it("keeps dry-run SELECT-only and apply limited to one JSON field", () => {
    const dryRun = buildLegacyRelationSnapshotDryRunQuery({
      namespace: "default",
      limit: 100
    });
    expect(() => assertReadOnlyLegacyRelationSnapshotQuery(dryRun)).not.toThrow();
    expect(dryRun.sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i
    );
    expect(dryRun.sql).not.toMatch(/\b(?:content|summary|tags|source_message_ids)\b/i);
    expect(dryRun.sql).toContain("identity_or_shape_mismatch_rows");
    expect(dryRun.sql).toContain("unexpected_result_memory_id_rows");
    expect(dryRun.sql).toContain("current_relation_conflict_rows");

    const apply = buildLegacyRelationSnapshotApplyQuery({
      namespace: "default",
      limit: 100
    }).sql;
    expect(apply).toContain("UPDATE memory_events");
    expect(apply).toContain("'$.relation_was_present'");
    expect(apply).toContain("json('true')");
    expect(apply).toContain("LIMIT 100");
    expect(apply).not.toContain("UPDATE memory_candidates");
    expect(apply).not.toContain("UPDATE memory_relations");
    expect(apply).not.toContain("payload_json = json_extract(candidate.payload_json");
  });

  it("does not construct or execute a write in dry-run mode", () => {
    const args = parseLegacyRelationSnapshotRepairArgs(["--remote", "--limit", "10"]);
    const queries: string[] = [];
    const report = runLegacyRelationSnapshotRepair(args, (_input, query) => {
      queries.push(query.sql);
      return {
        rows: [{
          legacy_missing_flag_rows: 12,
          repairable_rows: 12,
          selected: 10,
          has_more: 1,
          non_unique_rows: 0,
          outside_legacy_window_rows: 0,
          identity_or_shape_mismatch_rows: 0,
          unexpected_result_memory_id_rows: 0,
          current_relation_conflict_rows: 0
        }],
        changes: 0,
        rowsWritten: 0
      };
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^WITH\b/);
    expect(report).toMatchObject({
      mode: "dry_run",
      repairable_rows: 12,
      selected: 10,
      has_more: true
    });
  });

  it("reports changed, remaining and has_more after one apply", () => {
    const args = parseLegacyRelationSnapshotRepairArgs([
      "--remote",
      "--limit",
      "100",
      "--apply",
      "--confirm",
      "legacy-relation-snapshots"
    ]);
    let calls = 0;
    const report = runLegacyRelationSnapshotRepair(args, () => {
      calls += 1;
      if (calls === 1) return { rows: [], changes: 100, rowsWritten: 100 };
      return {
        rows: [{ repairable_rows: 11, has_more: 0 }],
        changes: 0,
        rowsWritten: 0
      };
    });
    expect(calls).toBe(2);
    expect(report).toMatchObject({
      mode: "apply",
      changed: 100,
      remaining: 11,
      has_more: false
    });
  });
});
