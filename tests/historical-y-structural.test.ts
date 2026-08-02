import { describe, expect, it } from "vitest";
import {
  chooseStructuralDecision,
  structuralPromotedReason,
  type HistoricalSnapshotRow
} from "../src/memory/historicalYReconfirmation";
import { classifyRelationReason } from "../src/memory/relationProvenanceContract.js";
import {
  RELATION_TYPE_REGISTRY,
  DIRECTED_RELATION_TYPES,
  STRUCTURAL_RELATION_TYPES,
  isStructuralRelationType,
  isDirectedRelationType
} from "../src/memory/relationTypeRegistry";
import { HISTORICAL_Y_DIRECTED_RELATION_TYPES, HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES, HISTORICAL_Y_STRUCTURAL_RELATION_TYPES } from "../src/memory/historicalYReconfirmationContract.js";
import type { MemoryRecord } from "../src/types";

function baseSnapshot(overrides?: Partial<HistoricalSnapshotRow>): HistoricalSnapshotRow {
  return {
    manifest_id: "hrg_test_manifest_0123456789abcdef",
    namespace: "default",
    lifecycle_cohort: "eligible_unproven",
    relation_id: "rel_test_001",
    source_memory_id: "mem_source_001",
    target_memory_id: "mem_target_001",
    relation_type: "same_fact_key",
    strength: 0.8,
    reason: "legacy reason",
    relation_created_at: "2026-08-01T00:00:00.000Z",
    source_eligible: 1,
    source_status: "active",
    source_active_fact: 1,
    source_type: "note",
    source_updated_at: "2026-07-01T00:00:00.000Z",
    source_five_axis_revision: 1,
    target_eligible: 1,
    target_status: "active",
    target_active_fact: 1,
    target_type: "note",
    target_updated_at: "2026-07-01T00:00:00.000Z",
    target_five_axis_revision: 1,
    provenance_class: "unproven_source",
    ...overrides
  };
}

function baseMemory(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "mem_source_001",
    namespace: "default",
    type: "note",
    content: "test content",
    status: "active",
    active_fact: 1,
    importance: 0.8,
    confidence: 0.9,
    pinned: 0,
    five_axis_revision: 1,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  } as MemoryRecord;
}

describe("structural relation deterministic rules", () => {
  describe("same_fact_key", () => {
    it("confirms when both fact_key non-null and equal", () => {
      const snapshot = baseSnapshot({ relation_type: "same_fact_key" });
      const source = baseMemory({
        id: "mem_source_001",
        fact_key: "fact_abc"
      });
      const target = baseMemory({
        id: "mem_target_001",
        fact_key: "fact_abc"
      });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_confirmed");
      expect(decision.exactMatch).toBe(true);
      expect(decision.matchedFields).toEqual(["fact_key"]);
      expect(decision.fieldEvidence).toEqual({ fact_key_equal: true, thread_equal: null });
    });

    it("does not confirm when fact_key values differ", () => {
      const snapshot = baseSnapshot({ relation_type: "same_fact_key" });
      const source = baseMemory({ fact_key: "fact_abc" });
      const target = baseMemory({ fact_key: "fact_xyz" });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_mismatch");
      expect(decision.exactMatch).toBe(false);
      expect(decision.matchedFields).toEqual([]);
      expect(decision.fieldEvidence).toEqual({ fact_key_equal: false, thread_equal: null });
    });

    it("does not confirm when source fact_key is null", () => {
      const snapshot = baseSnapshot({ relation_type: "same_fact_key" });
      const source = baseMemory({ fact_key: null });
      const target = baseMemory({ fact_key: "fact_abc" });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_mismatch");
    });

    it("does not confirm when both fact_key are null", () => {
      const snapshot = baseSnapshot({ relation_type: "same_fact_key" });
      const source = baseMemory({ fact_key: null });
      const target = baseMemory({ fact_key: null });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_mismatch");
    });
  });

  describe("in_thread", () => {
    it("confirms when both thread non-null and equal", () => {
      const snapshot = baseSnapshot({ relation_type: "in_thread" });
      const source = baseMemory({ thread: "thread_123" });
      const target = baseMemory({
        id: "mem_target_001",
        thread: "thread_123"
      });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_confirmed");
      expect(decision.exactMatch).toBe(true);
      expect(decision.matchedFields).toEqual(["thread"]);
      expect(decision.fieldEvidence).toEqual({ fact_key_equal: null, thread_equal: true });
    });

    it("does not confirm when thread values differ", () => {
      const snapshot = baseSnapshot({ relation_type: "in_thread" });
      const source = baseMemory({ thread: "thread_123" });
      const target = baseMemory({ thread: "thread_456" });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_mismatch");
    });

    it("does not confirm when target thread is null", () => {
      const snapshot = baseSnapshot({ relation_type: "in_thread" });
      const source = baseMemory({ thread: "thread_123" });
      const target = baseMemory({ thread: null });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_mismatch");
    });
  });

  describe("origin_split", () => {
    it("is skipped regardless of field values", () => {
      const snapshot = baseSnapshot({ relation_type: "origin_split" });
      const source = baseMemory({ source: "shared_origin" });
      const target = baseMemory({ source: "shared_origin" });
      const decision = chooseStructuralDecision(snapshot, source, target);
      expect(decision.changeKind).toBe("structural_skipped");
      expect(decision.exactMatch).toBe(false);
      expect(decision.provenanceClaim).toBe(false);
      expect(decision.fieldEvidence).toEqual({ fact_key_equal: null, thread_equal: null });
    });

    it("is excluded from the reconfirmable candidate set but stays structural", () => {
      expect(HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES).not.toContain("origin_split");
      expect(HISTORICAL_Y_STRUCTURAL_RELATION_TYPES).toContain("origin_split");
      expect(isStructuralRelationType("origin_split")).toBe(true);
    });
  });
});

describe("structural promotion proof reason", () => {
  it("produces historical-structural prefix with evidence hash", async () => {
    const snapshot = baseSnapshot({ relation_type: "same_fact_key", reason: null });
    const reason = await structuralPromotedReason(snapshot, ["fact_key"]);
    expect(reason).toMatch(/^historical-structural:same_fact_key:[0-9a-f]{32}$/);
  });

  it("appends previous_reason suffix when reason exists", async () => {
    const snapshot = baseSnapshot({ reason: "old semantic reason" });
    const reason = await structuralPromotedReason(snapshot, ["fact_key"]);
    expect(reason).toContain("|previous_reason:old semantic reason");
  });

  it("does not append previous_reason when reason is null", async () => {
    const snapshot = baseSnapshot({ reason: null });
    const reason = await structuralPromotedReason(snapshot, ["fact_key"]);
    expect(reason).not.toContain("|previous_reason:");
  });

  it("evidence hash contains no raw thread or fact_key values", async () => {
    const snapshot = baseSnapshot({
      relation_type: "in_thread",
      source_memory_id: "mem_src",
      target_memory_id: "mem_tgt",
      source_five_axis_revision: 3,
      target_five_axis_revision: 5
    });
    const reason = await structuralPromotedReason(snapshot, ["thread"]);
    // The hash is SHA-256 of canonical JSON containing field names, IDs,
    // revisions — not raw values. We verify by reconstructing the hash
    // input and checking it does not contain any raw field values.
    const evidence = JSON.stringify({
      schema_version: 2,
      relation_type: "in_thread",
      matched_fields: ["thread"],
      source_memory_id: "mem_src",
      source_five_axis_revision: 3,
      target_memory_id: "mem_tgt",
      target_five_axis_revision: 5
    });
    expect(evidence).not.toContain("thread_123");
    expect(evidence).not.toContain("fact_abc");
    // The reason string itself should not contain raw field values.
    expect(reason).not.toContain("thread_123");
    // Verify the hash in the reason matches the expected input.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(evidence)
    );
    const expectedHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    expect(reason).toContain(expectedHash);
  });

  it("different matched fields produce different hashes", async () => {
    const snapshot = baseSnapshot({ relation_type: "same_fact_key" });
    const reasonFactKey = await structuralPromotedReason(snapshot, ["fact_key"]);
    const reasonThread = await structuralPromotedReason(snapshot, ["thread"]);
    const hashFactKey = reasonFactKey.split(":")[2];
    const hashThread = reasonThread.split(":")[2];
    expect(hashFactKey).not.toBe(hashThread);
  });
});

describe("historical-structural provenance classification", () => {
  it("classifies historical-structural: as deterministic_rebuildable", () => {
    const reason = "historical-structural:same_fact_key:abcdef0123456789abcdef0123456789";
    expect(classifyRelationReason(reason)).toBe("deterministic_rebuildable");
  });

  it("classifies historical-structural with previous_reason suffix as deterministic_rebuildable", () => {
    const reason = "historical-structural:in_thread:abcdef0123456789abcdef0123456789|previous_reason:old";
    expect(classifyRelationReason(reason)).toBe("deterministic_rebuildable");
  });

  it("still classifies y:auto: as builder_backed (unchanged)", () => {
    expect(classifyRelationReason("y:auto:mem_123:1")).toBe("builder_backed");
  });

  it("classifies unproven reasons as unproven_source (unchanged)", () => {
    expect(classifyRelationReason("legacy semantic reason")).toBe("unproven_source");
  });
});

describe("relation type registry as single source of truth", () => {
  it("exports structural relation types matching the contract", () => {
    for (const type of HISTORICAL_Y_STRUCTURAL_RELATION_TYPES) {
      expect(isStructuralRelationType(type)).toBe(true);
    }
  });

  it("exports directed relation types matching the contract", () => {
    for (const type of HISTORICAL_Y_DIRECTED_RELATION_TYPES) {
      expect(isDirectedRelationType(type)).toBe(true);
    }
  });

  it("DIRECTED_RELATION_TYPES includes derived_from and instance_of", () => {
    expect(DIRECTED_RELATION_TYPES.has("derived_from")).toBe(true);
    expect(DIRECTED_RELATION_TYPES.has("instance_of")).toBe(true);
  });

  it("STRUCTURAL_RELATION_TYPES includes exactly the three structural types", () => {
    expect(STRUCTURAL_RELATION_TYPES.size).toBe(3);
    expect(STRUCTURAL_RELATION_TYPES.has("in_thread")).toBe(true);
    expect(STRUCTURAL_RELATION_TYPES.has("same_fact_key")).toBe(true);
    expect(STRUCTURAL_RELATION_TYPES.has("origin_split")).toBe(true);
  });

  it("instance_of direction is directed (source A is instance of target B concept)", () => {
    expect(RELATION_TYPE_REGISTRY.instance_of.direction).toBe("directed");
  });

  it("derived_from direction is directed (target B derived from source A)", () => {
    expect(RELATION_TYPE_REGISTRY.derived_from.direction).toBe("directed");
  });

  it("same_topic direction is symmetric", () => {
    expect(RELATION_TYPE_REGISTRY.same_topic.direction).toBe("symmetric");
  });
});
