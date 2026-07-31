import { describe, expect, it } from "vitest";
import {
  DELETE_WRANGLER_FILE_PACKAGE
} from "../scripts/delete-historical-relations.mjs";
import {
  parseHistoricalRelationRollbackArgs,
  usage
} from "../scripts/rollback-historical-relations.mjs";
import {
  buildHistoricalRelationRollbackBatchSql
} from "../src/memory/historicalRelationRollbackSql.js";

describe("historical relation rollback command", () => {
  it("requires exact scope, bounded batches, and the tested file runner", () => {
    expect(() => parseHistoricalRelationRollbackArgs([]))
      .toThrow("--remote is required");
    expect(() => parseHistoricalRelationRollbackArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "eligible_unproven"
    ])).toThrow("--cohort must be stale_endpoint");
    expect(() => parseHistoricalRelationRollbackArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--limit",
      "101"
    ])).toThrow("--limit must be an integer between 1 and 100");
    expect(() => parseHistoricalRelationRollbackArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--apply",
      "--confirm",
      "hrg_test"
    ])).toThrow(
      `HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=${DELETE_WRANGLER_FILE_PACKAGE}`
    );
    expect(usage()).toContain("never");
  });

  it("builds restore-before-attribution and never overwrites a live identity", () => {
    const sql = buildHistoricalRelationRollbackBatchSql({
      descriptor: { manifest_id: "hrg_test" },
      rows: [{ relation_id: "rel_test" }],
      restoredAt: "2026-07-30T02:00:00.000Z"
    });
    expect(sql).toContain("INSERT INTO memory_relations");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("SET restored_at");
    expect(sql).toContain("status = 'rolled_back'");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\s+memories\b/i);
    expect(sql).not.toContain("DELETE FROM memory_relations");
  });
});
