import { describe, expect, it } from "vitest";
import { analyzeTimelineDateTags, extractExplicitDates, parseTimelineDate } from "../src/memory/timelineDates";

describe("timeline date contract", () => {
  it("rejects calendar-invalid date tags instead of treating their shape as approval", () => {
    expect(parseTimelineDate("2026-02-29")).toBeNull();
    expect(parseTimelineDate("2026-13-40")).toBeNull();
    expect(analyzeTimelineDateTags(["timeline", "date:2026-13-40"])).toMatchObject({
      validDates: [],
      invalidTags: ["date:2026-13-40"],
      isCanonical: false
    });
  });

  it("requires exactly one valid date tag and extracts real dates from both supported formats", () => {
    expect(analyzeTimelineDateTags(["date:2026-07-20", "date:2026-07-21"]).isCanonical).toBe(false);
    expect(analyzeTimelineDateTags(["date:2026-07-20"]).isCanonical).toBe(true);
    expect(extractExplicitDates("2026年7月20日，复查时间线；2026-07-21 发布。")).toEqual([
      "2026-07-20",
      "2026-07-21"
    ]);
  });
});
