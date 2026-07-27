import { describe, expect, it } from "vitest";
import {
  assertReadOnlyDiaryOriginRepairQuery,
  buildDiaryOriginRepairApplyQueries,
  buildDiaryOriginRepairDryRunQuery,
  parseDiaryOriginRepairArgs,
  runDiaryOriginRepair,
  usage
} from "../scripts/repair-diary-origin-timeline.mjs";

describe("diary origin timeline repair command", () => {
  it("requires explicit remote apply confirmation and has no looping mode", () => {
    expect(() => parseDiaryOriginRepairArgs([])).toThrow("--remote is required");
    expect(() => parseDiaryOriginRepairArgs(["--remote", "--apply"])).toThrow(
      "--apply requires --confirm diary-origin-timeline"
    );
    expect(() => parseDiaryOriginRepairArgs([
      "--remote",
      "--confirm",
      "diary-origin-timeline"
    ])).toThrow("--confirm is only valid with --apply");
    expect(parseDiaryOriginRepairArgs([
      "--remote",
      "--limit",
      "10",
      "--json"
    ])).toMatchObject({
      remote: true,
      limit: 10,
      apply: false,
      json: true
    });
    expect(usage()).toContain("does not loop automatically");
    expect(usage()).not.toContain("--cohort");
  });

  it("keeps dry-run read-only and writes only owned diary projections", () => {
    const dryRun = buildDiaryOriginRepairDryRunQuery({
      namespace: "default",
      limit: 25
    });
    expect(() => assertReadOnlyDiaryOriginRepairQuery(dryRun)).not.toThrow();
    expect(dryRun.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
    expect(dryRun.sql).not.toMatch(/\b(?:content|summary|tags|source_message_ids)\b/i);

    const writes = buildDiaryOriginRepairApplyQueries({
      namespace: "default",
      limit: 25
    });
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain("DELETE FROM memory_relations");
    expect(writes[0].sql).toContain("relation_type = 'in_episode'");
    expect(writes[0].sql).toContain("SUBSTR(");
    expect(writes[0].sql).not.toContain("LIKE");
    expect(writes[0].sql).not.toContain("derived_from");
    expect(writes[1].sql).toContain("DELETE FROM memory_diary_timeline_memberships");
    expect(writes.map((query) => query.sql).join("\n")).not.toContain("temporal_sequence");
  });

  it("never constructs or executes a write in dry-run mode", () => {
    const args = parseDiaryOriginRepairArgs(["--remote", "--limit", "10"]);
    const queries: string[] = [];
    const report = runDiaryOriginRepair(args, (_input, query) => {
      queries.push(query.sql);
      return {
        rows: [{
          repairable_origins: 1,
          membership_rows: 4,
          owned_in_episode_rows: 3,
          selected: 1,
          has_more: 0
        }],
        changes: 0,
        rowsWritten: 0
      };
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^WITH\b/);
    expect(report).toMatchObject({
      mode: "dry_run",
      repairable_origins: 1,
      membership_rows: 4,
      owned_in_episode_rows: 3,
      selected: 1,
      has_more: false
    });
  });
});
