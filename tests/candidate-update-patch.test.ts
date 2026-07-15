import { describe, expect, it } from "vitest";
import { candidateUpdatePatch } from "../src/api/adminBoard/candidateActions";

describe("candidate update patch", () => {
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
    const patch = candidateUpdatePatch({ fact_key: null, tags: [] });

    expect(patch.factKey).toBeNull();
    expect(patch.tags).toEqual([]);
    expect(patch.thread).toBeUndefined();
  });
});
