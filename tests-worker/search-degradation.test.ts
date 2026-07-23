import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/api/mcp";
import { handleRecall } from "../src/api/recall";
import type { Env } from "../src/types";

function withFailingTextSearch(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (statement: string) => {
          if (
            statement.startsWith("SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND active_fact != 0")
            && statement.includes(" LIKE ?")
          ) {
            return {
              bind() {
                return {
                  all: async () => { throw new Error("simulated D1 text failure"); }
                };
              }
            } as unknown as D1PreparedStatement;
          }
          return target.prepare(statement);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as D1Database;
}

describe("search degradation behavior", () => {
  it("returns an MCP tool error instead of pretending a failed exact search is empty", async () => {
    const namespace = "search-degraded-mcp";
    const response = await handleMcp(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer search-degradation-debug-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "exact failure", namespace }
        }
      })
    }), {
      DB: withFailingTextSearch(env.DB),
      DEBUG_API_KEY: "search-degradation-debug-key"
    } as Env, createExecutionContext());

    const body = await response.json() as {
      result: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content?.[0]?.text).toBe("Memory text search is temporarily degraded");

    const event = await env.DB.prepare(
      "SELECT event_type, payload_json FROM memory_events WHERE namespace = ? AND event_type = 'memory_search_degraded' ORDER BY created_at DESC LIMIT 1"
    ).bind(namespace).first<{ event_type: string; payload_json: string }>();
    expect(event?.event_type).toBe("memory_search_degraded");
    expect(JSON.parse(event?.payload_json ?? "{}").sources).toEqual([{
      source: "exact_text",
      code: "d1_text_search_failed"
    }]);
    expect(event?.payload_json).not.toContain("simulated D1 text failure");
    expect(event?.payload_json).not.toContain('"message"');
  });

  it("exposes a degraded keyword source in the API recall trace", async () => {
    const namespace = "search-degraded-recall";
    const response = await handleRecall(new Request("https://worker.test/v1/memory/recall", {
      method: "POST",
      headers: {
        authorization: "Bearer search-degradation-debug-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        namespace,
        prompt: "recall degradation contract phrase",
        force: true,
        top_k: 3
      })
    }), {
      DB: withFailingTextSearch(env.DB),
      DEBUG_API_KEY: "search-degradation-debug-key",
      ENABLE_QUERY_EXPANSION: "false",
      ENABLE_RERANK: "false"
    } as Env, createExecutionContext());

    const body = await response.json() as {
      trace: { degraded_sources?: Array<{ source: string; code: string }> };
    };
    expect(response.status).toBe(200);
    expect(body.trace.degraded_sources).toEqual(expect.arrayContaining([{
      source: "keyword",
      code: "d1_text_search_failed"
    }]));
    expect(JSON.stringify(body)).not.toContain("simulated D1 text failure");
    expect(JSON.stringify(body)).not.toContain('"message"');
  });
});
