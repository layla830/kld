import { describe, expect, it, vi } from "vitest";
import { prepareMemoryRelationInsert } from "../src/db/memoryRelations";

describe("memory relation provenance promotion query", () => {
  it("keeps the mutation guard and its binds ahead of the conflict-only promotion", () => {
    let preparedSql = "";
    let preparedBinds: unknown[] = [];
    const statement = {
      bind(...binds: unknown[]) {
        preparedBinds = binds;
        return statement;
      },
      first: vi.fn(),
      run: vi.fn(),
      all: vi.fn(),
      raw: vi.fn()
    } as D1PreparedStatement;
    const db = {
      prepare(sql: string) {
        preparedSql = sql;
        return statement;
      }
    } as D1Database;

    const result = prepareMemoryRelationInsert(db, {
      namespace: "default",
      sourceMemoryId: "mem_a",
      targetMemoryId: "mem_b",
      relationType: "same_topic",
      strength: 0.8,
      reason: "y:auto:mem_a:3"
    }, {
      sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND five_axis_revision = ?)",
      binds: ["default", "mem_a", 3]
    });

    expect(result).toBe(statement);
    expect(preparedSql).toContain("WHERE EXISTS (SELECT 1 FROM memories");
    expect(preparedSql).toContain(
      "ON CONFLICT(namespace, source_memory_id, target_memory_id, relation_type) DO UPDATE SET"
    );
    expect(preparedSql).toContain("ELSE '|previous_reason:' || memory_relations.reason");
    expect(preparedSql).toContain("SUBSTR(COALESCE(excluded.reason, '')");
    expect(preparedBinds.slice(1, 7)).toEqual([
      "default",
      "mem_a",
      "mem_b",
      "same_topic",
      0.8,
      "y:auto:mem_a:3"
    ]);
    expect(preparedBinds.slice(8)).toEqual(["default", "mem_a", 3]);
  });
});
