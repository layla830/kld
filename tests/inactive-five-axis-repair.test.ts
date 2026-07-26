import { describe, expect, it } from "vitest";
import {
  assertReadOnlyRepairQuery,
  buildRepairApplyQuery,
  buildRepairDryRunQuery,
  parseRepairArgs,
  runInactiveFiveAxisRepair,
  usage
} from "../scripts/repair-inactive-five-axis-d1.mjs";

describe("inactive five-axis repair command", () => {
  it("has one fixed repair target and requires a separate apply confirmation", () => {
    expect(() => parseRepairArgs([])).toThrow("--remote is required");
    expect(() => parseRepairArgs(["--remote", "--cohort", "relations"])).toThrow(
      "Unknown argument: --cohort"
    );
    expect(() => parseRepairArgs(["--remote", "--apply"])).toThrow(
      "--apply requires --confirm inactive-five-axis-d1"
    );
    expect(() => parseRepairArgs([
      "--remote",
      "--confirm",
      "inactive-five-axis-d1"
    ])).toThrow("--confirm is only valid with --apply");
    expect(parseRepairArgs([
      "--remote",
      "--limit",
      "25",
      "--json"
    ])).toMatchObject({
      remote: true,
      limit: 25,
      apply: false,
      json: true
    });
    expect(usage()).not.toContain("--cohort");
    expect(usage()).toContain("does not repair relations");
  });

  it("keeps dry-run SELECT-only and the write narrowly guarded", () => {
    const dryRun = buildRepairDryRunQuery({ namespace: "default", limit: 100 });
    expect(() => assertReadOnlyRepairQuery(dryRun)).not.toThrow();
    expect(dryRun.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
    expect(dryRun.sql).not.toMatch(/\b(?:content|summary|tags|source_message_ids)\b/i);
    expect(dryRun.sql).toContain("expired_running_rows");

    const runWrite = buildRepairApplyQuery({
      namespace: "default",
      limit: 100
    }).sql;
    expect(runWrite).toContain("UPDATE memory_five_axis_runs");
    expect(runWrite).toContain("superseded_by_newer_memory_revision");
    expect(runWrite).toContain("run.status = 'failed'");
    expect(runWrite).toContain("run.status = 'running'");
    expect(runWrite).toContain("run.claim_token IS NULL");
    expect(runWrite).toContain("run.claim_token IS NOT NULL");
    expect(runWrite).toContain("run.lease_expires_at IS NULL");
    expect(runWrite).toContain("run.lease_expires_at IS NOT NULL");
    expect(runWrite).toContain("run.lease_expires_at <=");
    expect(runWrite).not.toContain("DELETE FROM memory_relations");
    expect(runWrite).not.toContain("'repair'");
    expect(runWrite).not.toContain("UPDATE memories");
    expect(runWrite).not.toContain("memory_five_axis_outbox");
  });

  it("never constructs or executes a write in dry-run mode", () => {
    const args = parseRepairArgs([
      "--remote",
      "--limit",
      "10"
    ]);
    const queries: string[] = [];
    const report = runInactiveFiveAxisRepair(args, (_input, query) => {
      queries.push(query.sql);
      return {
        rows: [{
          repairable_rows: 12,
          failed_rows: 10,
          expired_running_rows: 2,
          selected: 10,
          has_more: 1
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
      failed_rows: 10,
      expired_running_rows: 2,
      selected: 10,
      has_more: 1
    });
    expect(report).not.toHaveProperty("cohort");
  });
});
