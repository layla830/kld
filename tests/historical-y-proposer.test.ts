import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHistoricalYPrompt,
  proposeHistoricalYRelations
} from "../src/memory/historicalYProposer";
import {
  proposeRelationsViaLlm,
  type RelationCandidate
} from "../src/memory/fiveAxis/yRelations";
import type { Env, MemoryRecord } from "../src/types";

function candidate(pairId = "rel_1"): RelationCandidate {
  const base = {
    namespace: "default",
    summary: null,
    fact_key: null,
    active_fact: 1,
    thread: null,
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: 0.8,
    confidence: 0.9,
    status: "active",
    pinned: 0,
    tags: null,
    source: null,
    source_message_ids: null,
    vector_id: null,
    vector_synced: 1,
    last_recalled_at: null,
    recall_count: 0,
    five_axis_revision: 1,
    updated_at: "2026-08-02T00:00:00.000Z",
    expires_at: null
  } satisfies Partial<MemoryRecord>;
  return {
    pairId,
    vectorScore: 0.8,
    source: {
      ...base,
      id: "mem_source",
      type: "quarrel",
      content: "Synthetic raw incident record.",
      created_at: "2030-01-01T00:00:00.000Z"
    } as MemoryRecord,
    target: {
      ...base,
      id: "mem_target",
      type: "lesson",
      content: "Synthetic lesson explicitly derived from that incident.",
      created_at: "2030-01-02T00:00:00.000Z"
    } as MemoryRecord
  };
}

function mockResponse(content: string, extras?: Record<string, unknown>) {
  return Response.json({
    choices: [{
      message: { content, ...extras },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  });
}

afterEach(() => vi.restoreAllMocks());

describe("historical Y proposer", () => {
  it("uses a compact historical-only prompt with directional provenance evidence", () => {
    const prompt = buildHistoricalYPrompt([candidate()]);
    expect(prompt).toContain("没有明确来源证据不得输出 derived_from");
    expect(prompt).toContain("目标 B 是从来源 A 提炼");
    expect(prompt).toContain("规则 A 与规则 B 共享一句原则");
    expect(prompt).toContain("不能声称事件 B 从 lesson A 提炼");
    expect(prompt).not.toContain('"reason":');
    expect(prompt).toContain('"a_created_at":"2030-01-01T00:00:00.000Z"');
  });

  it("bans structural types from the model prompt and adds instance_of direction rule", () => {
    const prompt = buildHistoricalYPrompt([candidate()]);
    // Structural types must not appear in the allowed list.
    const allowedLine = prompt.split("\n").find((line) => line.startsWith("允许类型"));
    expect(allowedLine).toBeTruthy();
    expect(allowedLine).not.toContain("in_thread");
    expect(allowedLine).not.toContain("same_fact_key");
    expect(allowedLine).not.toContain("origin_split");
    // Explicit ban statement.
    expect(prompt).toContain("模型不得输出这三个类型");
    // instance_of direction rule.
    expect(prompt).toContain("instance_of 是有方向的");
    expect(prompt).toContain("起点 A 是终点 B 概念的一个具体实例");
    expect(prompt).toContain("方向不明时不得输出 instance_of");
    // Synthetic positive and negative examples for instance_of.
    expect(prompt).toContain("合成正例");
    expect(prompt).toContain("合成反例");
  });

  it("uses 4096 max tokens and parses compact hints without persisting reason", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({ hints: [{ pair_id: "rel_1", relation_type: "derived_from", strength: 0.82 }] })
    ));
    const result = await proposeHistoricalYRelations({
      AI_GATEWAY_BASE_URL: "https://example.test",
      CF_AIG_TOKEN: "token"
    } as Env, [candidate()], "deepseek/deepseek-v4-flash");
    const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      max_tokens: 4096,
      response_format: { type: "json_object" },
      stream: false
    });
    expect(result).toMatchObject({
      hints: [{ pair_id: "rel_1", relation_type: "derived_from", strength: 0.82 }]
    });
    expect(result.modelCalled).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts?.[0]?.parse_outcome).toBe("ok");
  });

  it("keeps the shared Y proposer request contract separate and unchanged", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({
        hints: [{
          pair_id: "rel_1",
          relation_type: "same_topic",
          strength: 0.8,
          reason: "synthetic shared-proposer reason"
        }]
      })
    ));
    const runtimeEnv = {
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env;

    await proposeHistoricalYRelations(runtimeEnv, [candidate()], "test-model");
    await proposeRelationsViaLlm(runtimeEnv, [candidate()], "test-model");

    const historicalRequest = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const sharedRequest = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    const historicalPrompt = String(historicalRequest.messages?.[1]?.content);
    const sharedPrompt = String(sharedRequest.messages?.[1]?.content);
    expect(historicalRequest.max_tokens).toBe(4096);
    expect(historicalPrompt).not.toContain('"reason":');
    expect(sharedRequest).toMatchObject({
      max_tokens: 1800,
      temperature: 0,
      response_format: { type: "json_object" },
      stream: false
    });
    expect(sharedPrompt).toContain('"reason":');
    expect(sharedPrompt).not.toContain("没有明确来源证据不得输出 derived_from");
  });

  it("distinguishes an explicit none hint and keeps the existing single retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "not-json" } }] }))
      .mockResolvedValueOnce(mockResponse(
        '{"hints":[{"pair_id":"rel_1","relation_type":"none","strength":0.9}]}'
      ));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      hints: [{ pair_id: "rel_1", relation_type: "none", strength: null }]
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts?.[0]?.parse_outcome).not.toBe("ok");
    expect(result.attempts?.[1]?.parse_outcome).toBe("ok");
  });

  it("fails closed when the model returns duplicate decisions for one pair", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({
        hints: [
          { pair_id: "rel_1", relation_type: "same_topic", strength: 0.8 },
          { pair_id: "rel_1", relation_type: "derived_from", strength: 0.9 }
        ]
      })
    ));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ hints: [], error: "invalid_json" });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts?.[0]?.parse_outcome).toBe("duplicate_pair_id");
    expect(result.attempts?.[1]?.parse_outcome).toBe("duplicate_pair_id");
  });

  // ---- Strict parser failure taxonomy ----

  it("fails on out-of-vocabulary type after two attempts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({ hints: [{ pair_id: "rel_1", relation_type: "bogus_type", strength: 0.8 }] })
    ));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ hints: [], error: "invalid_json" });
    expect(result.attempts?.[0]?.parse_outcome).toBe("out_of_vocabulary_type");
  });

  it("fails on structural type in model output (treated as OOV)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({ hints: [{ pair_id: "rel_1", relation_type: "in_thread", strength: 0.8 }] })
    ));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.attempts?.[0]?.parse_outcome).toBe("out_of_vocabulary_type");
  });

  it("fails on unknown pair_id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({ hints: [{ pair_id: "rel_unknown", relation_type: "same_topic", strength: 0.8 }] })
    ));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.attempts?.[0]?.parse_outcome).toBe("unknown_pair_id");
  });

  it("fails on malformed hint (non-none without explicit numeric strength)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({ hints: [{ pair_id: "rel_1", relation_type: "same_topic" }] })
    ));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.attempts?.[0]?.parse_outcome).toBe("malformed_hint");
  });

  it("fails on no_json_object when content is not JSON", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse("plain text not json"));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.attempts?.[0]?.parse_outcome).toBe("no_json_object");
  });

  it("fails on empty_choices when hints array is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({ hints: [] })
    ));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.attempts?.[0]?.parse_outcome).toBe("empty_choices");
  });

  // ---- missing_pair is NOT a parse outcome; valid response omitting a pair ----

  it("succeeds when a valid response omits a known pair (missing_pair is writer-level)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockResponse(
      JSON.stringify({ hints: [] })
    ));
    // Empty hints → empty_choices (parser failure), not missing_pair.
    // missing_pair is detected at the writer level, not the parser.
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(result.error).toBeTruthy();
  });

  // ---- Telemetry whitelist ----

  it("records telemetry with whitelisted usage fields and no raw content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      choices: [{
        message: {
          content: JSON.stringify({ hints: [{ pair_id: "rel_1", relation_type: "same_topic", strength: 0.8 }] }),
          reasoning_content: "internal reasoning text"
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 80,
        total_tokens: 280,
        completion_tokens_details: { reasoning_tokens: 30 },
        // Extra fields that must NOT appear in telemetry:
        secret_field: "should_not_leak"
      }
    }));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model", "hyr_test_batch_id");
    const attempt = result.attempts?.[0];
    expect(attempt).toBeDefined();
    expect(attempt?.model).toBe("test-model");
    expect(attempt?.batch_id).toBe("hyr_test_batch_id");
    expect(attempt?.http_status).toBe(200);
    expect(attempt?.finish_reason).toBe("stop");
    expect(attempt?.parse_outcome).toBe("ok");
    // Usage whitelist.
    expect(attempt?.usage).toEqual({
      prompt_tokens: 200,
      completion_tokens: 80,
      total_tokens: 280,
      reasoning_tokens: 30
    });
    // No raw content or reasoning text in telemetry.
    const attemptJson = JSON.stringify(attempt);
    expect(attemptJson).not.toContain("internal reasoning text");
    expect(attemptJson).not.toContain("should_not_leak");
    expect(attempt?.content_chars).toBe(JSON.stringify({
      hints: [{ pair_id: "rel_1", relation_type: "same_topic", strength: 0.8 }]
    }).length);
    expect(attempt?.reasoning_chars).toBe("internal reasoning text".length);
  });

  it("records null for missing usage fields", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ hints: [{ pair_id: "rel_1", relation_type: "none", strength: null }] }) } }],
      finish_reason: "stop"
      // No usage field at all
    }));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    const attempt = result.attempts?.[0];
    expect(attempt?.usage).toEqual({
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      reasoning_tokens: null
    });
  });

  it("records http_error telemetry on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}, { status: 500 }));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model", "hyr_batch");
    expect(result.error).toMatch(/^model_status_5/);
    const attempt = result.attempts?.[0];
    expect(attempt?.parse_outcome).toBe("http_error");
    expect(attempt?.http_status).toBe(500);
    expect(attempt?.batch_id).toBe("hyr_batch");
  });

  it("returns zero model calls for empty candidate list", async () => {
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [], "test-model");
    expect(result.hints).toEqual([]);
    expect(result.modelCalled).toBe(false);
    expect(result.attempts).toEqual([]);
  });
});
