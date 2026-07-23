import { describe, expect, it } from "vitest";
import {
  FIVE_AXIS_OUTBOX_STATUSES,
  FIVE_AXIS_OUTBOX_TRANSITIONS,
  FIVE_AXIS_RUN_STATUSES,
  canTransitionFiveAxisOutbox
} from "../src/db/fiveAxisStatuses";

describe("five-axis status contracts", () => {
  it("keeps the durable outbox and run status sets explicit", () => {
    expect(FIVE_AXIS_OUTBOX_STATUSES).toEqual([
      "pending", "queued", "failed", "dead_letter", "completed", "skipped"
    ]);
    expect(FIVE_AXIS_RUN_STATUSES).toEqual([
      "running", "applied", "pending_review", "skipped", "failed"
    ]);
  });

  it("allows retryable work to advance while terminal rows stay terminal", () => {
    expect(canTransitionFiveAxisOutbox("queue", "pending", "queued")).toBe(true);
    expect(canTransitionFiveAxisOutbox("queue", "failed", "queued")).toBe(true);
    expect(canTransitionFiveAxisOutbox("fail", "queued", "dead_letter")).toBe(true);
    expect(canTransitionFiveAxisOutbox("retry_dead_letter", "dead_letter", "pending")).toBe(true);
    for (const active of ["pending", "queued", "failed", "dead_letter"] as const) {
      expect(canTransitionFiveAxisOutbox("deproject", active, "skipped")).toBe(true);
    }

    for (const terminal of ["completed", "skipped"] as const) {
      for (const transition of Object.keys(FIVE_AXIS_OUTBOX_TRANSITIONS) as Array<keyof typeof FIVE_AXIS_OUTBOX_TRANSITIONS>) {
        for (const target of FIVE_AXIS_OUTBOX_STATUSES) {
          expect(canTransitionFiveAxisOutbox(transition, terminal, target)).toBe(false);
        }
      }
    }
  });
});
