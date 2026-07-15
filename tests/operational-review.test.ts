import { describe, expect, it } from "vitest";
import type { MemoryCandidateRecord } from "../src/db/memoryCandidates";
import { renderOperationalReviewCandidate } from "../src/api/adminBoard/metabolismView";

function candidate(status: "pending" | "approved"): MemoryCandidateRecord {
  const snapshot = (id: string, content: string, importance: number) => ({
    id, type: "project_state", content, fact_key: "project:kld", importance,
    confidence: 0.9, pinned: false, status: "active", active_fact: 1,
    updated_at: "2026-07-12T00:00:00.000Z"
  });
  return {
    id: "cand_z", namespace: "default", external_key: "z-review", dream_date: "2026-07-12",
    action: "z_supersede", subject: "system", target_id: "mem_old",
    payload_json: JSON.stringify({
      _kind: "fact_transition", fact_key: "project:kld", reason: "同一事实槽冲突",
      best: snapshot("mem_new", "当前项目状态", 0.9), weaker: snapshot("mem_old", "旧项目状态", 0.6)
    }),
    source_chunk_ids_json: "[]", source_chunks_json: "[]", status,
    validation_error: null, created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z",
    resolved_at: status === "approved" ? "2026-07-12T01:00:00.000Z" : null, result_memory_id: status === "approved" ? "mem_new" : null
  };
}

function relationCandidate(status: "pending" | "approved"): MemoryCandidateRecord {
  return {
    ...candidate(status),
    id: "cand_y",
    external_key: "y-review:supports:mem_a:mem_b",
    action: "y_relation_review",
    target_id: "mem_b",
    payload_json: JSON.stringify({
      _kind: "y_relation_review",
      relation_type: "supports",
      source_id: "mem_a",
      target_id: "mem_b",
      source_updated_at: "2026-07-12T00:00:00.000Z",
      target_updated_at: "2026-07-12T00:00:00.000Z",
      strength: 0.8,
      reason: "A 为 B 提供证据"
    }),
    result_memory_id: status === "approved" ? "rel_y" : null
  };
}

describe("unified operational review card", () => {
  it("uses the existing M-review endpoints without exposing batch supersede", () => {
    const html = renderOperationalReviewCandidate(candidate("pending"));
    expect(html).toContain("Z 事实状态 · 取代候选");
    expect(html).toContain('/admin/memories/m-review/approve');
    expect(html).toContain('/admin/memories/m-review/reject');
    expect(html).not.toContain("m-batch-checkbox");
  });

  it("exposes rollback through the same endpoint after approval", () => {
    const html = renderOperationalReviewCandidate(candidate("approved"));
    expect(html).toContain('/admin/memories/m-review/rollback');
    expect(html).toContain("回滚这次取代");
  });

  it("renders risky Y relations as explicit approve/reject/rollback candidates", () => {
    const pending = renderOperationalReviewCandidate(relationCandidate("pending"));
    const approved = renderOperationalReviewCandidate(relationCandidate("approved"));

    expect(pending).toContain("Y 关系判断 · 人工审核");
    expect(pending).toContain("支持关系");
    expect(pending).toContain('/admin/memories/m-review/approve');
    expect(pending).toContain('/admin/memories/m-review/reject');
    expect(approved).toContain('/admin/memories/m-review/rollback');
  });
});
