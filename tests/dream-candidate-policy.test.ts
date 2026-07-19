import { describe, expect, it } from "vitest";
import type { CandidateInput } from "../src/db/memoryCandidates";
import type { MemoryCandidateRecord } from "../src/db/memoryCandidates";
import { applyDreamCandidatePolicy, hasUsableChunkSummary } from "../src/memory/dreamCandidatePolicy";
import { canOverrideCandidateValidation } from "../src/memory/candidateOverride";
import { renderMemoryCandidate } from "../src/api/adminBoard/candidateView";

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    externalKey: "dream-1",
    dreamDate: "2026-07-14",
    action: "add",
    payload: { content: "用户（Layla）正在把长期记忆系统整理成可复用工程。" },
    sourceChunkIds: [101],
    sourceChunks: [{ summary: "用户正在整理记忆工程，希望自动候选来自完整的对话块摘要，而不是把每句关键原话都拆成单独长期记忆。" }],
    status: "pending",
    validationError: null,
    ...overrides
  };
}

describe("Dream candidate ingress policy", () => {
  it("suppresses standalone excerpt cards while retaining their chunk provenance", () => {
    const input = candidate({ action: "excerpt", payload: { quote: "病根拔不掉，但每次冒头，抓得住。" } });
    const result = applyDreamCandidatePolicy(input);
    expect(result).toMatchObject({ outcome: "suppress", reason: "standalone_excerpt" });
    expect(result.candidate.sourceChunkIds).toEqual([101]);
  });

  it("accepts summary-backed durable candidates", () => {
    const input = candidate();
    expect(hasUsableChunkSummary(input)).toBe(true);
    expect(applyDreamCandidatePolicy(input)).toEqual({ outcome: "accept", candidate: input });
  });

  it("routes candidates without a real chunk summary to human review", () => {
    const result = applyDreamCandidatePolicy(candidate({ sourceChunks: [{ summary: "太短" }] }));
    expect(result.outcome).toBe("accept");
    if (result.outcome === "accept") {
      expect(result.candidate.status).toBe("needs_subject_review");
      expect(result.candidate.validationError).toContain("missing_chunk_summary");
    }
  });
});

describe("candidate validation override boundary", () => {
  it("allows an explicit human override only for Dream memory mutations", () => {
    expect(canOverrideCandidateValidation({ status: "needs_subject_review", action: "add" })).toBe(true);
    expect(canOverrideCandidateValidation({ status: "needs_subject_review", action: "update" })).toBe(true);
    expect(canOverrideCandidateValidation({ status: "needs_subject_review", action: "relation" })).toBe(false);
    expect(canOverrideCandidateValidation({ status: "pending", action: "add" })).toBe(false);
  });

  it("renders an explicit override action on a blocked Dream card", () => {
    const record: MemoryCandidateRecord = {
      id: "cand-blocked",
      namespace: "default",
      external_key: "blocked-1",
      dream_date: "2026-07-14",
      action: "add",
      subject: "relationship",
      target_id: null,
      payload_json: JSON.stringify({ content: "用户（Layla）与 KLD 约定继续共同整理长期记忆工程。" }),
      source_chunk_ids_json: "[101]",
      source_chunks_json: JSON.stringify([{ summary: "一段足够完整的关系上下文摘要。", important_quotes: ["继续一起做。"] }]),
      status: "needs_subject_review",
      validation_error: "evidence_not_verbatim_in_source_chunks",
      created_at: "2026-07-14T00:00:00Z",
      updated_at: "2026-07-14T00:00:00Z",
      resolved_at: null,
      result_memory_id: null
    };
    const html = renderMemoryCandidate(record);
    expect(html).toContain("人工确认并通过");
    expect(html).toContain('name="override_validation" value="1"');
  });

  it("does not render a generic approve form for an unknown action", () => {
    const record: MemoryCandidateRecord = {
      id: "cand-unknown",
      namespace: "default",
      external_key: "unknown-1",
      dream_date: "2026-07-19",
      action: "unknown_candidate_action",
      subject: null,
      target_id: null,
      payload_json: "{}",
      source_chunk_ids_json: "[]",
      source_chunks_json: "[]",
      status: "pending",
      validation_error: null,
      created_at: "2026-07-19T00:00:00Z",
      updated_at: "2026-07-19T00:00:00Z",
      resolved_at: null,
      result_memory_id: null
    };

    const html = renderMemoryCandidate(record);
    expect(html).not.toContain('action="/admin/memories/candidates/approve"');
    expect(html).toContain("此类候选需使用专用审核入口");
  });
});
