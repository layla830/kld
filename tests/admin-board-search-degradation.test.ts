import { describe, expect, it, vi } from "vitest";
import type { Env, MemoryApiRecord } from "../src/types";
import type { PageInput } from "../src/api/adminBoard/utils";

vi.mock("../src/memory/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/search")>();
  return { ...actual, searchMemories: vi.fn() };
});

import { fetchMemories } from "../src/api/adminBoard/data";
import { searchMemories } from "../src/memory/search";

function semanticInput(): PageInput {
  return {
    q: "partial result",
    type: "",
    status: "active",
    page: 1,
    tab: "browse",
    tag: "",
    date: "",
    category: "",
    mood: "",
    notice: "",
    searchMode: "semantic"
  };
}

function apiRecord(): MemoryApiRecord {
  return {
    id: "mem_partial",
    namespace: "default",
    type: "note",
    content: "vector result remains available",
    summary: null,
    fact_key: null,
    active_fact: true,
    thread: null,
    risk_level: null,
    urgency_level: null,
    tension_score: null,
    response_posture: null,
    audit_state: null,
    valence: null,
    arousal: null,
    importance: 0.7,
    confidence: 0.8,
    status: "active",
    pinned: false,
    tags: [],
    source: "test",
    source_message_ids: [],
    vector_id: "vec_partial",
    last_recalled_at: null,
    recall_count: 0,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    expires_at: null,
    score: 0.9
  };
}

describe("admin semantic search degradation", () => {
  it("propagates degradation when partial vector results remain", async () => {
    vi.mocked(searchMemories).mockResolvedValue({
      status: "degraded",
      records: [apiRecord()],
      degradations: [{ source: "keyword", code: "d1_text_search_failed" }]
    });

    const result = await fetchMemories({} as Env, semanticInput());

    expect(result.records.map((record) => record.id)).toEqual(["mem_partial"]);
    expect(result.searchDegraded).toBe(true);
  });
});
