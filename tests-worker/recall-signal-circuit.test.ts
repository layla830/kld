import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/api/mcp";
import { handleRecall } from "../src/api/recall";
import { createMemory } from "../src/db/memories";
import { recordRecallSignals } from "../src/db/recallSignals";
import { deleteOldRecallDailyRows, deleteOldRecallReceipts } from "../src/db/retention";
import { selectMemoriesForInjection } from "../src/memory/inject";
import { observeRecallMetabolismSignals } from "../src/memory/recallMetabolismShadow";
import type { Env, KeyProfile } from "../src/types";

interface RecallRow {
  recall_count: number;
  last_recalled_at: string | null;
}

interface DailyRow {
  source: string;
  recall_count: number;
}

function executionContext(): { ctx: ExecutionContext; flush: () => Promise<void> } {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) { promises.push(promise); },
      passThroughOnException() {}
    } as ExecutionContext,
    flush: async () => { await Promise.all(promises); }
  };
}

async function recallRow(namespace: string, id: string): Promise<RecallRow | null> {
  return env.DB.prepare(
    "SELECT recall_count, last_recalled_at FROM memories WHERE namespace = ? AND id = ?"
  ).bind(namespace, id).first<RecallRow>();
}

describe("recall signal persistence", () => {
  it("deduplicates one operation atomically and keeps source-specific daily rows", async () => {
    const namespace = "recall-signal-atomic";
    const memory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "atomic recall signal target",
      importance: 0.5,
      confidence: 0.8
    });

    await expect(recordRecallSignals(env.DB, {
      namespace,
      operationId: "op-atomic-1",
      source: "api_context",
      memoryIds: [memory.id, memory.id, "missing-memory"],
      recalledAt: "2026-07-18T10:00:00.000Z"
    })).resolves.toEqual({ attempted: 2, recorded: 1 });
    await expect(recordRecallSignals(env.DB, {
      namespace,
      operationId: "op-atomic-1",
      source: "api_context",
      memoryIds: [memory.id],
      recalledAt: "2026-07-18T10:00:00.000Z"
    })).resolves.toEqual({ attempted: 1, recorded: 0 });
    await expect(recordRecallSignals(env.DB, {
      namespace,
      operationId: "op-atomic-1",
      source: "mcp_retrieve",
      memoryIds: [memory.id],
      recalledAt: "2026-07-18T10:05:00.000Z"
    })).resolves.toEqual({ attempted: 1, recorded: 1 });

    await expect(recallRow(namespace, memory.id)).resolves.toEqual({
      recall_count: 2,
      last_recalled_at: "2026-07-18T10:05:00.000Z"
    });
    const daily = await env.DB.prepare(
      `SELECT source, recall_count FROM memory_recall_daily
       WHERE namespace = ? AND memory_id = ? ORDER BY source`
    ).bind(namespace, memory.id).all<DailyRow>();
    expect(daily.results).toEqual([
      { source: "api_context", recall_count: 1 },
      { source: "mcp_retrieve", recall_count: 1 }
    ]);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = ? AND event_type = 'recall_signal_recorded'`
    ).bind(namespace).first<number>("count")).resolves.toBe(2);
  });

  it("expires short-lived receipts and bounded daily rows without changing lifetime counters", async () => {
    const namespace = "recall-signal-retention";
    const memory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "recall retention target",
      importance: 0.5,
      confidence: 0.8
    });
    await recordRecallSignals(env.DB, {
      namespace,
      operationId: "retention-old-op",
      source: "gateway_injection",
      memoryIds: [memory.id],
      recalledAt: "2025-01-01T12:00:00.000Z"
    });

    await expect(deleteOldRecallReceipts(env.DB, namespace, "2026-01-01T00:00:00.000Z")).resolves.toBe(1);
    await expect(deleteOldRecallDailyRows(env.DB, namespace, "2026-01-01T00:00:00.000Z")).resolves.toBe(1);
    await expect(recallRow(namespace, memory.id)).resolves.toMatchObject({ recall_count: 1 });
  });

  it("records API, gateway, and explicit MCP retrieval while leaving MCP retries idempotent", async () => {
    const apiMemory = await createMemory(env.DB, {
      namespace: "recall-entry-api",
      type: "note",
      content: "entry api unique sapphire",
      importance: 0.5,
      confidence: 0.8
    });
    const apiRequest = () => new Request("https://worker.test/v1/memories/recall", {
      method: "POST",
      headers: { authorization: "Bearer debug-recall-key", "content-type": "application/json", "idempotency-key": "api-entry-op" },
      body: JSON.stringify({ namespace: "recall-entry-api", prompt: "entry api unique sapphire", top_k: 1, force: true })
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const apiContext = executionContext();
      const apiResponse = await handleRecall(apiRequest(), {
        DB: env.DB,
        DEBUG_API_KEY: "debug-recall-key"
      } as Env, apiContext.ctx);
      expect(apiResponse.status).toBe(200);
      await apiContext.flush();
    }
    await expect(recallRow("recall-entry-api", apiMemory.id)).resolves.toMatchObject({ recall_count: 1 });

    const gatewayNamespace = "recall-entry-gateway";
    const gatewayMemory = await createMemory(env.DB, {
      namespace: gatewayNamespace,
      type: "note",
      content: "entry gateway unique amber",
      importance: 0.5,
      confidence: 0.8
    });
    const gatewayProfile: KeyProfile = {
      source: "test",
      namespace: gatewayNamespace,
      scopes: ["chat:proxy", "memory:read"],
      injectionMode: "full",
      memoryMode: "external",
      allowModelPassthrough: false,
      debug: false
    };
    const selected = await selectMemoriesForInjection({
      DB: env.DB,
      ENABLE_MEMORY_FILTER: "false",
      INJECTION_MODE: "full"
    } as Env, {
      profile: gatewayProfile,
      query: "entry gateway unique amber",
      operationId: "gateway-entry-op"
    });
    expect(selected.map((item) => item.id)).toContain(gatewayMemory.id);
    await selectMemoriesForInjection({
      DB: env.DB,
      ENABLE_MEMORY_FILTER: "false",
      INJECTION_MODE: "full"
    } as Env, {
      profile: gatewayProfile,
      query: "entry gateway unique amber",
      operationId: "gateway-entry-op"
    });
    await expect(recallRow(gatewayNamespace, gatewayMemory.id)).resolves.toMatchObject({ recall_count: 1 });

    const mcpMemory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: "entry mcp unique topaz 719",
      importance: 0.5,
      confidence: 0.8
    });
    const mcpRequest = () => new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer mcp-recall-key",
        "content-type": "application/json",
        "mcp-session-id": "recall-signal-session"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 719,
        method: "tools/call",
        params: { name: "retrieve_memory", arguments: { query: "entry mcp unique topaz 719", top_k: 1 } }
      })
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const mcpContext = executionContext();
      const response = await handleMcp(mcpRequest(), {
        DB: env.DB,
        MEMORY_MCP_API_KEY: "mcp-recall-key",
        ENABLE_QUERY_EXPANSION: "false",
        ENABLE_RERANK: "false"
      } as Env, mcpContext.ctx);
      expect(response.status).toBe(200);
      await mcpContext.flush();
    }
    await expect(recallRow("default", mcpMemory.id)).resolves.toMatchObject({ recall_count: 1 });

    const searchOnlyMemory = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: "entry search only unique quartz 720",
      importance: 0.5,
      confidence: 0.8
    });
    const searchContext = executionContext();
    const searchResponse = await handleMcp(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer mcp-recall-key",
        "content-type": "application/json",
        "mcp-session-id": "recall-signal-session"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 720,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "entry search only unique quartz 720", top_k: 1 } }
      })
    }), {
      DB: env.DB,
      MEMORY_MCP_API_KEY: "mcp-recall-key"
    } as Env, searchContext.ctx);
    expect(searchResponse.status).toBe(200);
    await searchContext.flush();
    await expect(recallRow("default", searchOnlyMemory.id)).resolves.toMatchObject({ recall_count: 0 });

    const sources = await env.DB.prepare(
      `SELECT namespace, source, SUM(recall_count) AS recall_count
       FROM memory_recall_daily
       WHERE namespace IN (?, ?, ?) AND memory_id IN (?, ?, ?)
       GROUP BY namespace, source ORDER BY namespace, source`
    ).bind(
      "recall-entry-api",
      gatewayNamespace,
      "default",
      apiMemory.id,
      gatewayMemory.id,
      mcpMemory.id
    ).all<{ namespace: string; source: string; recall_count: number }>();
    expect(sources.results).toEqual(expect.arrayContaining([
      { namespace: "recall-entry-api", source: "api_context", recall_count: 1 },
      { namespace: gatewayNamespace, source: "gateway_injection", recall_count: 1 },
      { namespace: "default", source: "mcp_retrieve", recall_count: 1 }
    ]));
  });
});

describe("recall metabolism shadow", () => {
  it("observes promote and cooled bands once without creating candidates", async () => {
    const namespace = "recall-shadow-bands";
    const promoted = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "warming memory",
      importance: 0.5,
      confidence: 0.8
    });
    const cooled = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "previously used but cooled memory",
      importance: 0.3,
      confidence: 0.5
    });
    for (let index = 0; index < 5; index += 1) {
      await recordRecallSignals(env.DB, {
        namespace,
        operationId: `promote-${index}`,
        source: index % 2 === 0 ? "api_context" : "gateway_injection",
        memoryIds: [promoted.id],
        recalledAt: index < 3 ? "2026-07-18T10:00:00.000Z" : "2026-07-19T10:00:00.000Z"
      });
      await recordRecallSignals(env.DB, {
        namespace,
        operationId: `cooled-${index}`,
        source: "api_context",
        memoryIds: [cooled.id],
        recalledAt: "2025-12-01T10:00:00.000Z"
      });
    }

    const runtimeEnv = { DB: env.DB };
    const now = new Date("2026-07-19T12:00:00.000Z");
    await expect(observeRecallMetabolismSignals(runtimeEnv, namespace, { now }))
      .resolves.toMatchObject({ activeBands: 2, transitions: 2, bands: { promote: 1, cooled_after_use: 1 } });
    await expect(observeRecallMetabolismSignals(runtimeEnv, namespace, { now }))
      .resolves.toMatchObject({ activeBands: 2, transitions: 0 });

    const states = await env.DB.prepare(
      `SELECT memory_id, band FROM memory_metabolism_signal_state
       WHERE namespace = ? ORDER BY band, memory_id`
    ).bind(namespace).all<{ memory_id: string; band: string }>();
    expect(states.results).toEqual(expect.arrayContaining([
      { memory_id: cooled.id, band: "cooled_after_use" },
      { memory_id: promoted.id, band: "promote" }
    ]));
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = ? AND event_type = 'metabolism_signal_observed'`
    ).bind(namespace).first<number>("count")).resolves.toBe(2);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_candidates
       WHERE namespace = ? AND action IN ('m_archive', 'm_promote')`
    ).bind(namespace).first<number>("count")).resolves.toBe(0);
  });
});
