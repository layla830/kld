import { describe, expect, it } from "vitest";
import { selectActiveD1RelationNeighbors } from "../src/memory/fiveAxis/yRelations";
import type { MemoryRecord } from "../src/types";

describe("Y relation candidate boundary", () => {
  it("keeps only active memories that still exist in D1", () => {
    const active = { id: "mem_active", status: "active" } as MemoryRecord;
    const inactive = { id: "mem_inactive", status: "superseded" } as MemoryRecord;
    const selected = selectActiveD1RelationNeighbors([
      { id: active.id, score: 0.8 },
      { id: inactive.id, score: 0.9 },
      { id: "mem_missing", score: 0.95 }
    ], [active, inactive]);

    expect(selected).toEqual([{ memory: active, vectorScore: 0.8 }]);
  });
});
