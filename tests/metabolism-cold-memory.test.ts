import { describe, expect, it } from "vitest";
import { scanMetabolismReviewCandidates } from "../src/memory/metabolismReview";
import type { MemoryRecord } from "../src/types";

describe("M cold-memory review policy", () => {
  it("detects only reviewable cold low-signal memories in dry-run mode without writing candidates", async () => {
    const prepared: string[] = [];
    const cold = {
      id: "mem_cold",
      namespace: "default",
      type: "note",
      status: "active",
      pinned: 0,
      recall_count: 0,
      importance: 0.2,
      confidence: 0.4,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      last_recalled_at: null,
      expires_at: null
    } as MemoryRecord;
    const db = {
      prepare(sql: string) {
        prepared.push(sql);
        return {
          bind() {
            return {
              all: async () => ({
                results: sql.includes("SELECT * FROM memories") ? [cold] : []
              })
            };
          }
        };
      }
    } as unknown as D1Database;

    const result = await scanMetabolismReviewCandidates({ DB: db }, "default", { dryRun: true });

    expect(result).toEqual({ archive: 1, relations: 0 });
    expect(prepared.some((sql) => sql.includes("recall_count = 0"))).toBe(true);
    expect(prepared.some((sql) => sql.includes("NOT EXISTS") && sql.includes("memory_relations"))).toBe(true);
    expect(prepared.some((sql) => sql.includes("INSERT") || sql.includes("UPDATE"))).toBe(false);
  });
});
