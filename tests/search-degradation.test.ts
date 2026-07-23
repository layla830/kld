import { describe, expect, it } from "vitest";
import { searchMemoriesByText } from "../src/db/memories";
import { persistMemoryWithMerge } from "../src/memory/merge";
import { buildRecallTrace } from "../src/recall/trace";
import type { Env } from "../src/types";

function failingTextSearchDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            all: async () => { throw new Error("simulated D1 text failure"); }
          };
        }
      };
    }
  } as unknown as D1Database;
}

describe("memory search degradation contract", () => {
  it("keeps a successful search with no matches distinct from degradation", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return { all: async () => ({ results: [] }) };
          }
        };
      }
    } as unknown as D1Database;

    await expect(searchMemoriesByText(db, {
      namespace: "default",
      query: "missing memory",
      limit: 5
    })).resolves.toEqual({ status: "ok", records: [] });
  });

  it("distinguishes a D1 text failure from a successful empty search", async () => {
    const result = await searchMemoriesByText(failingTextSearchDb(), {
      namespace: "default",
      query: "missing memory",
      limit: 5
    });

    expect(result).toEqual({
      status: "degraded",
      records: [],
      error: {
        code: "d1_text_search_failed",
        message: "simulated D1 text failure"
      }
    });
  });

  it("carries degraded sources in the recall trace without changing result layers", () => {
    const internalDegradation = {
      source: "keyword",
      code: "d1_text_search_failed",
      message: "simulated D1 text failure"
    } as const;
    const trace = buildRecallTrace([], "hybrid_search", undefined, [internalDegradation]);

    expect(trace.layers.fallback.count).toBe(0);
    expect(trace.degraded_sources).toEqual([{
      source: "keyword",
      code: "d1_text_search_failed"
    }]);
    expect(JSON.stringify(trace)).not.toContain("simulated D1 text failure");
    expect(JSON.stringify(trace)).not.toContain('"message"');
  });

  it("fails closed instead of creating a duplicate when merge search is degraded", async () => {
    const statements: string[] = [];
    const db = {
      prepare(statement: string) {
        statements.push(statement);
        const prepared = {
          bind() { return prepared; },
          async all() {
            if (
              statement.startsWith("SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND active_fact != 0")
              && statement.includes(" LIKE ?")
            ) throw new Error("simulated D1 text failure");
            return { results: [] };
          },
          async first() {
            if (statement.startsWith("SELECT * FROM cache_entries")) {
              return {
                value_json: JSON.stringify({ started_at: "2026-07-19T00:00:00.000Z" }),
                value_text: null
              };
            }
            return null;
          },
          async run() { return { success: true, meta: { changes: 1 } }; }
        };
        return prepared;
      }
    } as unknown as D1Database;

    await expect(persistMemoryWithMerge({
      DB: db,
      ENABLE_QUERY_EXPANSION: "false",
      ENABLE_RERANK: "false"
    } as Env, {
      namespace: "default",
      memory: {
        type: "note",
        content: "do not duplicate this memory",
        importance: 0.7,
        confidence: 0.8,
        tags: [],
        source_message_ids: ["msg_1"]
      },
      source: "test",
      sourceMessageIds: ["msg_1"]
    })).rejects.toThrow("memory_merge_search_degraded");

    expect(statements.some((statement) => statement.includes("INSERT INTO memories ("))).toBe(false);
    expect(statements.some((statement) => statement.includes("INSERT INTO memory_events"))).toBe(true);
  });
});
