import { describe, expect, it } from "vitest";
import {
  combineMutationGuards,
  memoryCandidateStatusGuard,
  memoryEventExistsGuard,
  memoryEventsExistGuard,
  memoryExistsGuard,
  memoryStatusGuard
} from "../src/db/mutationGuards";

describe("mutation guards", () => {
  it("combines conditions without changing bind order", () => {
    const guard = combineMutationGuards(
      memoryCandidateStatusGuard("default", "cand_1", "pending"),
      memoryStatusGuard("default", "mem_1", "active"),
      memoryExistsGuard("default", "mem_2"),
      memoryEventExistsGuard("default", "ev_1")
    );

    expect(guard.sql).toContain(") AND (");
    expect(guard.sql).toContain("memory_candidates");
    expect(guard.sql).toContain("memories");
    expect(guard.sql).toContain("memory_events");
    expect(guard.binds).toEqual([
      "default", "cand_1", "pending",
      "default", "mem_1", "active",
      "default", "mem_2",
      "default", "ev_1"
    ]);
  });

  it("requires every distinct event to exist", () => {
    const guard = memoryEventsExistGuard("default", ["ev_1", "ev_2", "ev_1"]);

    expect(guard.sql).toContain("COUNT(*)");
    expect(guard.sql).toContain("id IN (?, ?)");
    expect(guard.sql).toContain("= ?");
    expect(guard.binds).toEqual(["default", "ev_1", "ev_2", 2]);
  });

  it("rejects an empty event list", () => {
    expect(() => memoryEventsExistGuard("default", []))
      .toThrow("memory_event_guard_requires_ids");
  });
});
