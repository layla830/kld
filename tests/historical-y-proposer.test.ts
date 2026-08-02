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

  it("uses 4096 max tokens and parses compact hints without persisting reason", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        hints: [{ pair_id: "rel_1", relation_type: "derived_from", strength: 0.82 }]
      }) } }]
    }));
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
    expect(result).toEqual({
      hints: [{ pair_id: "rel_1", relation_type: "derived_from", strength: 0.82 }]
    });
  });

  it("keeps the shared Y proposer request contract separate and unchanged", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        hints: [{
          pair_id: "rel_1",
          relation_type: "same_topic",
          strength: 0.8,
          reason: "synthetic shared-proposer reason"
        }]
      }) } }]
    }));
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
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: '{"hints":[{"pair_id":"rel_1","relation_type":"none","strength":0.9}]}' } }]
      }));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      hints: [{ pair_id: "rel_1", relation_type: "none", strength: null }]
    });
  });

  it("fails closed when the model returns duplicate decisions for one pair", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        hints: [
          { pair_id: "rel_1", relation_type: "same_topic", strength: 0.8 },
          { pair_id: "rel_1", relation_type: "derived_from", strength: 0.9 }
        ]
      }) } }]
    }));
    const result = await proposeHistoricalYRelations({
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "token"
    } as Env, [candidate()], "test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ hints: [], error: "invalid_json" });
  });
});
