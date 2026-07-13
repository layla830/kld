import { describe, expect, it } from "vitest";
import { proposalFromCandidate } from "../src/memory/proposal";
import type { MemoryCandidateRecord } from "../src/db/memoryCandidates";

function candidate(action: string, payload: Record<string, unknown> = {}): MemoryCandidateRecord {
  return {
    id: "cand_1", namespace: "default", external_key: "test", dream_date: "2026-07-12",
    action, subject: null, target_id: null, payload_json: JSON.stringify(payload),
    source_chunk_ids_json: "[1]", source_chunks_json: "[]", status: "pending",
    validation_error: null, created_at: "2026-07-12T00:00:00Z", updated_at: "2026-07-12T00:00:00Z",
    resolved_at: null, result_memory_id: null
  };
}

describe("typed proposal mapper", () => {
  it("maps axis-specific candidates without changing the legacy table", () => {
    expect(proposalFromCandidate(candidate("timeline_date")).axis).toBe("X");
    expect(proposalFromCandidate(candidate("relation")).axis).toBe("Y");
    expect(proposalFromCandidate(candidate("fact_group")).axis).toBe("Z");
    expect(proposalFromCandidate(candidate("z_supersede", { _kind: "fact_transition" })).axis).toBe("Z");
    expect(proposalFromCandidate(candidate("update", { _kind: "coordinate_backfill" })).axis).toBe("E");
    expect(proposalFromCandidate(candidate("m_archive")).axis).toBe("M");
  });
});
