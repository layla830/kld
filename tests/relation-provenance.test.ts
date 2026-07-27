import { describe, expect, it } from "vitest";
import { relationProvenance } from "../src/db/relationProvenance";

describe("relation provenance contract", () => {
  it("uses one explicit namespace per relation writer", () => {
    expect(relationProvenance.yAuto("mem_a", 7)).toBe("y:auto:mem_a:7");
    expect(relationProvenance.yReviewApproved("candidate:key")).toBe(
      "y-review:approved:candidate:key"
    );
    expect(relationProvenance.factGroupApproved("candidate:key")).toBe(
      "fact-group:approved:candidate:key"
    );
    expect(relationProvenance.dreamAuto("2026-07-27")).toBe("dream:auto:2026-07-27");
    expect(relationProvenance.apiMemoryWrite("chat box")).toBe(
      "api:memory-write:chat%20box"
    );
  });
});
