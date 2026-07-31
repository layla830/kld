import { describe, expect, it } from "vitest";
import {
  RELATION_PROVENANCE_CLASSES,
  classifyRelationReason,
  relationProvenanceSql
} from "../src/memory/relationProvenanceContract.js";

describe("relation provenance contract", () => {
  it("classifies every owned prefix and keeps unknown reasons unproven", () => {
    expect(RELATION_PROVENANCE_CLASSES).toEqual([
      "deterministic_rebuildable",
      "human_reviewed",
      "builder_backed",
      "api_written",
      "legacy_backfill",
      "unproven_source"
    ]);
    expect(classifyRelationReason("diary_day:origin:2026-07-30"))
      .toBe("deterministic_rebuildable");
    expect(classifyRelationReason("y-review:approved:candidate:key"))
      .toBe("human_reviewed");
    expect(classifyRelationReason("y:auto:mem_1:3"))
      .toBe("builder_backed");
    expect(classifyRelationReason("api:memory-write:chatbox"))
      .toBe("api_written");
    expect(classifyRelationReason("legacy-backfill:thread old"))
      .toBe("legacy_backfill");
    expect(classifyRelationReason("free text")).toBe("unproven_source");
    expect(classifyRelationReason("")).toBe("unproven_source");
    expect(classifyRelationReason(null)).toBe("unproven_source");
  });

  it("owns the SQL predicates and rejects unsafe aliases", () => {
    const sql = relationProvenanceSql("relation");
    expect(sql.classificationCase).toContain("'deterministic_rebuildable'");
    expect(sql.classificationCase).toContain("'unproven_source'");
    expect(sql.unproven).toContain("NOT");
    expect(() => relationProvenanceSql("relation; DELETE FROM memories"))
      .toThrow("invalid_relation_provenance_alias");
  });
});
