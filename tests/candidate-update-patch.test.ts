import { describe, expect, it } from "vitest";
import { candidateUpdatePatch } from "../src/api/adminBoard/candidateActions";
import { payloadOf } from "../src/api/adminBoard/utils";

describe("candidate update patch", () => {
  it("parses only JSON objects as candidate payloads", () => {
    expect(payloadOf('{"action":"approve"}')).toEqual({ action: "approve" });
    expect([undefined, null, "", "not-json", "null", "true", "[]"].map(payloadOf)).toEqual(Array(7).fill({}));
  });
  it("preserves fields omitted from a partial coordinate proposal", () => {
    const patch = candidateUpdatePatch({
      _kind: "coordinate_backfill",
      thread: "relationship.boundaries"
    });

    expect(patch).toEqual({
      content: undefined,
      type: undefined,
      factKey: undefined,
      thread: "relationship.boundaries",
      riskLevel: undefined,
      urgencyLevel: undefined,
      responsePosture: undefined,
      importance: undefined,
      confidence: undefined,
      tensionScore: undefined,
      valence: undefined,
      arousal: undefined,
      tags: undefined
    });
  });

  it("keeps explicit clears distinct from omitted fields", () => {
    const patch = candidateUpdatePatch({ fact_key: null, tension_score: null, tags: [] });

    expect(patch.factKey).toBeNull();
    expect(patch.tensionScore).toBeNull();
    expect(patch.tags).toEqual([]);
    expect(patch.thread).toBeUndefined();
  });

  it("ignores malformed present values instead of treating them as clears", () => {
    const patch = candidateUpdatePatch({
      fact_key: "",
      thread: 42,
      importance: "0.9",
      tension_score: "0.4",
      tags: { accidental: true }
    });

    expect(patch.factKey).toBeUndefined();
    expect(patch.thread).toBeUndefined();
    expect(patch.importance).toBeUndefined();
    expect(patch.tensionScore).toBeUndefined();
    expect(patch.tags).toBeUndefined();
  });
});
