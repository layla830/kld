import { describe, expect, it } from "vitest";
import {
  assertReadOnlyVectorRepairQuery,
  buildVectorRepairApplyQuery,
  buildVectorRepairDryRunQuery,
  parseVectorRepairArgs,
  runInactiveVectorRepair,
  usage
} from "../scripts/repair-inactive-vector-state.mjs";

describe("inactive Vector repair command", () => {
  it("has one fixed target and requires explicit apply confirmation", () => {
    expect(() => parseVectorRepairArgs([])).toThrow("--remote is required");
    for (const option of ["--cohort", "--action", "--all", "--upsert-only", "--delete-only"]) {
      expect(() => parseVectorRepairArgs(["--remote", option])).toThrow("Unknown argument");
    }
    expect(() => parseVectorRepairArgs(["--remote", "--apply"])).toThrow(
      "--apply requires --confirm inactive-vector-state"
    );
    expect(() => parseVectorRepairArgs([
      "--remote",
      "--confirm",
      "inactive-vector-state"
    ])).toThrow("--confirm is only valid with --apply");
    expect(parseVectorRepairArgs(["--remote", "--limit", "25", "--json"])).toMatchObject({
      remote: true,
      limit: 25,
      apply: false,
      json: true
    });
    expect(usage()).not.toContain("--cohort");
    expect(usage()).toContain("existing scanner owns reconciliation");
  });

  it("keeps dry-run SELECT-only and apply limited to the requeue fields", () => {
    const dryRun = buildVectorRepairDryRunQuery({ namespace: "default", limit: 100 });
    expect(() => assertReadOnlyVectorRepairQuery(dryRun)).not.toThrow();
    expect(dryRun.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
    expect(dryRun.sql).not.toMatch(/\b(?:content|summary|tags|source_message_ids|embedding)\b/i);
    expect(dryRun.sql).toContain("needs_upsert_rows");
    expect(dryRun.sql).toContain("needs_delete_rows");
    expect(dryRun.sql).toContain("missing_vector_id_rows");
    expect(dryRun.sql).toContain("TRIM(memory.vector_id) != ''");
    expect(dryRun.sql).toContain("TRIM(memory.vector_sync_status) = ''");

    const apply = buildVectorRepairApplyQuery({ namespace: "default", limit: 100 }).sql;
    expect(apply).toContain("UPDATE memories");
    expect(apply).toContain("vector_sync_status = 'pending'");
    expect(apply).toContain("vector_synced = 0");
    expect(apply).toContain("RETURNING id, five_axis_revision");
    expect(apply).not.toContain("five_axis_revision =");
    expect(apply).not.toContain("memory_relations");
    expect(apply).not.toContain("memory_five_axis_runs");
    expect(apply).not.toContain("memory_deprojections");
    expect(apply).not.toContain("reconcileMemoryVector");
    expect(apply).not.toContain("VECTORIZE");
  });

  it("does not construct or execute a write in dry-run mode", () => {
    const args = parseVectorRepairArgs(["--remote", "--limit", "10"]);
    const queries: string[] = [];
    const report = runInactiveVectorRepair(args, (_input, query) => {
      queries.push(query.sql);
      return {
        rows: [{
          repairable_rows: 12,
          needs_upsert_rows: 5,
          needs_delete_rows: 7,
          selected: 10,
          has_more: 1,
          missing_vector_id_rows: 0
        }],
        changes: 0,
        rowsWritten: 0
      };
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT\b/);
    expect(report).toMatchObject({
      mode: "dry_run",
      repairable_rows: 12,
      needs_upsert_rows: 5,
      needs_delete_rows: 7,
      selected: 10,
      has_more: true
    });
  });

  it("reports changed, remaining and has_more after one apply", () => {
    const args = parseVectorRepairArgs([
      "--remote",
      "--limit",
      "10",
      "--apply",
      "--confirm",
      "inactive-vector-state"
    ]);
    let calls = 0;
    const report = runInactiveVectorRepair(args, () => {
      calls += 1;
      if (calls === 1) return { rows: [], changes: 10, rowsWritten: 10 };
      return {
        rows: [{ repairable_rows: 4, has_more: 0 }],
        changes: 0,
        rowsWritten: 0
      };
    });
    expect(report).toMatchObject({
      mode: "apply",
      changed: 10,
      remaining: 4,
      has_more: false
    });
  });
});
