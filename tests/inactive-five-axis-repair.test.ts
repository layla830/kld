import { describe, expect, it } from "vitest";
import {
  assertReadOnlyRepairQuery,
  buildRepairApplyQuery,
  buildRepairDryRunQuery,
  parseRepairArgs,
  runInactiveFiveAxisRepair
} from "../scripts/repair-inactive-five-axis-d1.mjs";

describe("inactive five-axis repair command", () => {
  it("requires one explicit cohort and a separate apply confirmation", () => {
    expect(() => parseRepairArgs([])).toThrow("--remote is required");
    expect(() => parseRepairArgs(["--remote", "--cohort", "all"])).toThrow(
      "--cohort must be relations or stale-axis-runs"
    );
    expect(() => parseRepairArgs([
      "--remote",
      "--cohort",
      "relations",
      "--apply"
    ])).toThrow("--apply requires --confirm inactive-five-axis-d1");
    expect(() => parseRepairArgs([
      "--remote",
      "--cohort",
      "relations",
      "--confirm",
      "inactive-five-axis-d1"
    ])).toThrow("--confirm is only valid with --apply");
    expect(parseRepairArgs([
      "--remote",
      "--cohort",
      "stale-axis-runs",
      "--limit",
      "25",
      "--json"
    ])).toMatchObject({
      remote: true,
      cohort: "stale-axis-runs",
      limit: 25,
      apply: false,
      json: true
    });
  });

  it("keeps dry-run SELECT-only and write SQL scoped to the selected cohort", () => {
    for (const cohort of ["relations", "stale-axis-runs"] as const) {
      const dryRun = buildRepairDryRunQuery({ namespace: "default", cohort, limit: 100 });
      expect(() => assertReadOnlyRepairQuery(dryRun)).not.toThrow();
      expect(dryRun.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
      expect(dryRun.sql).not.toMatch(/\b(?:content|summary|tags|source_message_ids)\b/i);
    }

    const relationWrite = buildRepairApplyQuery({
      namespace: "default",
      cohort: "relations",
      limit: 100
    }).sql;
    expect(relationWrite).toContain("DELETE FROM memory_relations");
    expect(relationWrite).toContain("candidate.result_memory_id = relation.id");
    expect(relationWrite).not.toContain("UPDATE memories");
    expect(relationWrite).not.toContain("memory_deprojections");

    const runWrite = buildRepairApplyQuery({
      namespace: "default",
      cohort: "stale-axis-runs",
      limit: 100
    }).sql;
    expect(runWrite).toContain("UPDATE memory_five_axis_runs");
    expect(runWrite).toContain("superseded_by_newer_memory_revision");
    expect(runWrite).toContain("run.lease_expires_at <=");
    expect(runWrite).not.toContain("UPDATE memories");
    expect(runWrite).not.toContain("memory_five_axis_outbox");
  });

  it("never constructs or executes a write in dry-run mode", () => {
    const args = parseRepairArgs([
      "--remote",
      "--cohort",
      "relations",
      "--limit",
      "10"
    ]);
    const queries: string[] = [];
    const report = runInactiveFiveAxisRepair(args, (_input, query) => {
      queries.push(query.sql);
      return {
        rows: [{ relation_rows: 12, repairable_rows: 12, selected: 10, has_more: 1 }],
        changes: 0,
        rowsWritten: 0
      };
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT\b/);
    expect(report).toMatchObject({
      mode: "dry_run",
      cohort: "relations",
      relation_rows: 12,
      repairable_rows: 12,
      selected: 10,
      has_more: 1
    });
  });
});
